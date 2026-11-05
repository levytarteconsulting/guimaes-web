// Lógica de la Edge Function "instagram" (index.ts le pasa el entorno real;
// instagram_test.ts, uno simulado). Sin dependencias de Deno ni de npm: se
// puede probar con Node (node --experimental-strip-types).
//
// Acciones (POST, cuerpo JSON {accion, post_id?}):
//   comprobar            — cuenta, seguidores, cupo de publicación y qué falta
//                          (token, permisos, página, Instagram vinculado)
//   publicar_pendientes  — publica las aprobadas con la hora cumplida
//   publicar_ahora       — publica una aprobada ya ({post_id})
//   metricas             — métricas de las publicadas de los últimos 90 días
//
// Quién puede llamar:
//   x-hook-secret = INSTAGRAM_CRON_SECRET (pg_cron) → comprobar, publicar_pendientes, metricas
//   Authorization: Bearer <service role>            → todas
//   Authorization: Bearer <JWT de usuario del CRM>  → comprobar (cualquiera);
//                                                     el resto, solo rol 'admin'

export const GRAPH_API_VERSION = "v21.0"; // la misma que meta-leads y whatsapp
export const BUCKET = "instagram-media";
export const CUENTA_PREFERIDA = "guimaes_asesoria";
export const PERMISOS_NECESARIOS = [
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];
export const METRICAS = ["reach", "saved", "shares", "likes", "comments", "total_interactions", "views"];
export const MAX_POR_EJECUCION = 3;   // piezas por llamada de pg_cron (cada 5 min)
export const DIAS_METRICAS = 90;
const ESPERA_MS = 2000;
const ESPERA_INTENTOS = 30;           // hasta ~60 s por contenedor

// ---------------------------------------------------------------- Graph API
export class GraphError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(`Graph API ${status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
  get code(): number | null { return this.body?.error?.code ?? null; }
  get meta(): string { return this.body?.error?.message ?? this.message; }
}

export type Graph = (path: string, opts?: { params?: Record<string, string>; method?: "GET" | "POST" }) => Promise<any>;

export function makeGraph(fetchFn: typeof fetch, token: string): Graph {
  return async (path, opts = {}) => {
    const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\//, "")}`);
    const method = opts.method ?? "GET";
    const init: RequestInit = { method, headers: { "Authorization": `Bearer ${token}` } };
    if (method === "GET") {
      for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    } else {
      // POST en el cuerpo: el texto puede tener 2200 caracteres.
      init.body = new URLSearchParams(opts.params ?? {}).toString();
      (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetchFn(url.toString(), init);
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
    if (!res.ok || body?.error) throw new GraphError(res.status, body);
    return body;
  };
}

// ---------------------------------------------------------------- base de datos
export type Post = { id: string; caption: string; attempts: number };
export type Slide = { position: number; storage_path: string };
export interface Db {
  rolDe(authUserId: string): Promise<{ rol: string; activo: boolean } | null>;
  pendientes(limite: number): Promise<string[]>;
  reservar(id: string, soloCumplidas: boolean): Promise<Post | null>;
  laminas(id: string): Promise<Slide[]>;
  publicada(id: string, d: { ig_media_id: string; permalink: string | null; published_at: string }): Promise<void>;
  fallo(id: string, mensaje: string): Promise<void>;
  paraMetricas(desdeIso: string): Promise<{ id: string; ig_media_id: string }[]>;
  guardarMetricas(id: string, metrics: Record<string, unknown>, enIso: string): Promise<void>;
}

export type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  db: () => Db;
  usuario: (jwt: string) => Promise<string | null>; // auth_user_id del JWT o null
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function urlPublica(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------------------------------------------------------------- cuenta
type Pagina = { id: string; name: string; tasks?: string[]; instagram_business_account?: { id: string; username?: string } };

async function paginas(g: Graph): Promise<Pagina[]> {
  const r = await g("me/accounts", { params: { fields: "id,name,tasks,instagram_business_account{id,username}", limit: "100" } });
  return (r?.data ?? []) as Pagina[];
}

function elegirPagina(ps: Pagina[]): Pagina | undefined {
  const conIg = ps.filter((p) => p.instagram_business_account?.id);
  return conIg.find((p) => p.instagram_business_account?.username === CUENTA_PREFERIDA) ?? conIg[0];
}

// Id de la cuenta de Instagram: INSTAGRAM_USER_ID o, si no está, el de la
// página que la tiene vinculada (/me/accounts).
export async function igUserId(g: Graph, env: Deps["env"]): Promise<string> {
  const fijo = env("INSTAGRAM_USER_ID");
  if (fijo) return fijo;
  const p = elegirPagina(await paginas(g));
  if (!p) throw new Error("El token no ve ninguna página con una cuenta de Instagram vinculada (usa la acción comprobar).");
  return p.instagram_business_account!.id;
}

export async function comprobar(g: Graph | null, env: Deps["env"]): Promise<any> {
  const problemas: string[] = [];
  const avisos: string[] = [];
  const out: any = { ok: false, problemas, avisos, token: null, permisos: null, pagina: null, cuenta: null, cupo: null };
  if (!g) {
    problemas.push("Falta el secreto INSTAGRAM_ACCESS_TOKEN en la función.");
    return out;
  }

  try {
    const me = await g("me", { params: { fields: "id,name" } });
    out.token = { id: me.id, nombre: me.name ?? null };
  } catch (e) {
    problemas.push(e instanceof GraphError && e.code === 190
      ? "El token no es válido o ha caducado (Meta: " + e.meta + ")."
      : "No se puede usar el token: " + (e instanceof GraphError ? e.meta : String(e)));
    return out;
  }

  try {
    const r = await g("me/permissions");
    const concedidos = ((r?.data ?? []) as { permission: string; status: string }[])
      .filter((p) => p.status === "granted").map((p) => p.permission);
    const faltan = PERMISOS_NECESARIOS.filter((p) => !concedidos.includes(p));
    out.permisos = { concedidos, faltan };
    for (const p of faltan) problemas.push(`Falta el permiso ${p} en el token.`);
  } catch (e) {
    avisos.push("No se han podido leer los permisos del token: " + (e instanceof GraphError ? e.meta : String(e)));
  }

  let ps: Pagina[] = [];
  try {
    ps = await paginas(g);
  } catch (e) {
    problemas.push("No se pueden leer las páginas del token: " + (e instanceof GraphError ? e.meta : String(e)));
    return out;
  }
  if (ps.length === 0) {
    problemas.push("Página no visible: el token no ve ninguna página de Facebook. Asigna la página de Guimaes al usuario del sistema (y, si es de otro portfolio, compártela con el de la app).");
    return out;
  }
  const p = elegirPagina(ps);
  if (!p) {
    problemas.push(`Instagram no vinculado: ${ps.length === 1 ? "la página «" + ps[0].name + "»" : "ninguna de las páginas visibles (" + ps.map((x) => x.name).join(", ") + ")"} tiene una cuenta de Instagram que este token pueda ver. Vincula @${CUENTA_PREFERIDA} a la página y comparte la cuenta de Instagram con el portfolio de la app.`);
    out.pagina = ps.map((x) => ({ id: x.id, nombre: x.name, tareas: x.tasks ?? [] }));
    return out;
  }
  out.pagina = { id: p.id, nombre: p.name, tareas: p.tasks ?? [] };
  if (p.tasks && !p.tasks.includes("CREATE_CONTENT") && !p.tasks.includes("MANAGE")) {
    problemas.push(`La página «${p.name}» se ve con acceso parcial (tareas: ${p.tasks.join(", ") || "ninguna"}): falta el permiso de contenido (CREATE_CONTENT).`);
  }
  const ig = p.instagram_business_account!;
  if (ig.username && ig.username !== CUENTA_PREFERIDA) {
    avisos.push(`La cuenta vinculada es @${ig.username}, no @${CUENTA_PREFERIDA}.`);
  }
  const fijo = env("INSTAGRAM_USER_ID");
  if (fijo && fijo !== ig.id) avisos.push(`INSTAGRAM_USER_ID (${fijo}) no coincide con la cuenta vinculada a la página (${ig.id}).`);
  const igId = fijo || ig.id;

  try {
    const c = await g(igId, { params: { fields: "id,username,name,followers_count,media_count" } });
    out.cuenta = { id: c.id, usuario: c.username ?? null, nombre: c.name ?? null, seguidores: c.followers_count ?? null, publicaciones: c.media_count ?? null };
  } catch (e) {
    problemas.push("No se puede leer la cuenta de Instagram: " + (e instanceof GraphError ? e.meta : String(e)));
  }
  try {
    const r = await g(`${igId}/content_publishing_limit`, { params: { fields: "config,quota_usage" } });
    const d = r?.data?.[0] ?? {};
    out.cupo = { usado: d.quota_usage ?? null, total: d.config?.quota_total ?? null, horas: d.config?.quota_duration ? d.config.quota_duration / 3600 : null };
  } catch (e) {
    problemas.push("No se puede leer el cupo de publicación (¿falta instagram_content_publish?): " + (e instanceof GraphError ? e.meta : String(e)));
  }

  out.ok = problemas.length === 0;
  return out;
}

// ---------------------------------------------------------------- publicar
async function esperarContenedor(g: Graph, id: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < ESPERA_INTENTOS; i++) {
    const r = await g(id, { params: { fields: "status_code,status" } });
    if (r.status_code === "FINISHED" || r.status_code === "PUBLISHED") return;
    if (r.status_code === "ERROR" || r.status_code === "EXPIRED") {
      throw new Error(`Instagram no ha podido procesar la imagen (${r.status_code}${r.status ? ": " + r.status : ""}).`);
    }
    await sleep(ESPERA_MS);
  }
  throw new Error("Instagram tarda demasiado en procesar la imagen (más de 60 s).");
}

export type Resultado =
  | { id: string; ok: true; ig_media_id: string; permalink: string | null }
  | { id: string; ok: false; error: string };

// Publica una pieza ya reservada (status publicando). Nunca lanza: devuelve
// el resultado y lo deja guardado en la base.
export async function publicarPieza(g: Graph, igId: string, post: Post, db: Db, deps: Deps): Promise<Resultado> {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const supabaseUrl = deps.env("SUPABASE_URL") ?? "";
  let enPublicar = false;
  try {
    const slides = (await db.laminas(post.id)).sort((a, b) => a.position - b.position);
    if (slides.length === 0) throw new Error("La pieza no tiene imágenes.");
    if (slides.length > 10) throw new Error("Un carrusel admite 10 imágenes como máximo.");
    const urls = slides.map((s) => urlPublica(supabaseUrl, s.storage_path));

    let contenedor: string;
    if (urls.length === 1) {
      contenedor = (await g(`${igId}/media`, { method: "POST", params: { image_url: urls[0], caption: post.caption } })).id;
    } else {
      const hijos: string[] = [];
      for (const u of urls) {
        hijos.push((await g(`${igId}/media`, { method: "POST", params: { image_url: u, is_carousel_item: "true" } })).id);
      }
      for (const h of hijos) await esperarContenedor(g, h, sleep);
      contenedor = (await g(`${igId}/media`, {
        method: "POST",
        params: { media_type: "CAROUSEL", children: hijos.join(","), caption: post.caption },
      })).id;
    }
    await esperarContenedor(g, contenedor, sleep);

    enPublicar = true;
    const mediaId: string = (await g(`${igId}/media_publish`, { method: "POST", params: { creation_id: contenedor } })).id;
    enPublicar = false;

    let permalink: string | null = null;
    try {
      permalink = (await g(mediaId, { params: { fields: "permalink" } })).permalink ?? null;
    } catch (e) {
      console.error("instagram: permalink", post.id, e);
    }
    await db.publicada(post.id, { ig_media_id: mediaId, permalink, published_at: now().toISOString() });
    return { id: post.id, ok: true, ig_media_id: mediaId, permalink };
  } catch (e) {
    let msg = e instanceof GraphError ? `Meta: ${e.meta}` : (e instanceof Error ? e.message : String(e));
    // Si media_publish falla sin una respuesta clara de Meta (red, tiempo
    // de espera, 5xx), puede haberse publicado igualmente.
    if (enPublicar && !(e instanceof GraphError && e.status >= 400 && e.status < 500)) {
      msg = "Puede que se haya publicado: comprueba en Instagram antes de volver a aprobarla. " + msg;
    } else {
      msg = "No se ha publicado. " + msg;
    }
    try { await db.fallo(post.id, msg.slice(0, 1000)); } catch (e2) { console.error("instagram: guardar error", post.id, e2); }
    return { id: post.id, ok: false, error: msg };
  }
}

export async function publicarPendientes(g: Graph, db: Db, deps: Deps): Promise<any> {
  const ids = await db.pendientes(MAX_POR_EJECUCION);
  if (ids.length === 0) return { publicadas: 0, errores: 0, resultados: [] };
  const igId = await igUserId(g, deps.env);

  let libres = Infinity;
  try {
    const d = (await g(`${igId}/content_publishing_limit`, { params: { fields: "config,quota_usage" } }))?.data?.[0];
    if (d?.config?.quota_total != null && d?.quota_usage != null) libres = d.config.quota_total - d.quota_usage;
  } catch (e) {
    console.error("instagram: cupo", e);
  }

  const resultados: Resultado[] = [];
  for (const id of ids) {
    if (libres <= 0) break; // se quedan aprobadas: la siguiente ejecución lo vuelve a intentar
    const post = await db.reservar(id, true);
    if (!post) continue; // otra ejecución se la ha llevado
    const r = await publicarPieza(g, igId, post, db, deps);
    resultados.push(r);
    libres--;
  }
  return {
    publicadas: resultados.filter((r) => r.ok).length,
    errores: resultados.filter((r) => !r.ok).length,
    sin_cupo: libres <= 0 && resultados.length < ids.length,
    resultados,
  };
}

export async function publicarAhora(g: Graph, db: Db, deps: Deps, postId: string): Promise<{ status: number; body: any }> {
  const igId = await igUserId(g, deps.env);
  const post = await db.reservar(postId, false);
  if (!post) return { status: 409, body: { error: "La pieza no está aprobada (o ya se está publicando)." } };
  const r = await publicarPieza(g, igId, post, db, deps);
  return { status: r.ok ? 200 : 502, body: r };
}

// ---------------------------------------------------------------- métricas
function valorMetrica(item: any): number | null {
  const v = item?.total_value?.value ?? item?.values?.[0]?.value;
  return typeof v === "number" ? v : null;
}

export async function metricasDe(g: Graph, mediaId: string): Promise<Record<string, unknown>> {
  const m: Record<string, unknown> = {};
  try {
    const r = await g(`${mediaId}/insights`, { params: { metric: METRICAS.join(",") } });
    for (const it of r?.data ?? []) m[it.name] = valorMetrica(it);
    return m;
  } catch (e) {
    // Alternativa: una a una, y likes/comentarios desde los campos del medio.
    const noDisponibles: string[] = [];
    for (const met of METRICAS) {
      try {
        const r = await g(`${mediaId}/insights`, { params: { metric: met } });
        m[met] = valorMetrica(r?.data?.[0]);
      } catch {
        noDisponibles.push(met);
      }
    }
    if (noDisponibles.includes("likes") || noDisponibles.includes("comments")) {
      try {
        const r = await g(mediaId, { params: { fields: "like_count,comments_count" } });
        if (noDisponibles.includes("likes") && typeof r.like_count === "number") {
          m.likes = r.like_count; noDisponibles.splice(noDisponibles.indexOf("likes"), 1);
        }
        if (noDisponibles.includes("comments") && typeof r.comments_count === "number") {
          m.comments = r.comments_count; noDisponibles.splice(noDisponibles.indexOf("comments"), 1);
        }
      } catch { /* sin más alternativa */ }
    }
    if (noDisponibles.length) m.no_disponibles = noDisponibles;
    if (noDisponibles.length === METRICAS.length) {
      m.error = e instanceof GraphError ? e.meta : String(e);
    }
    return m;
  }
}

export async function actualizarMetricas(g: Graph, db: Db, deps: Deps): Promise<any> {
  const now = deps.now ?? (() => new Date());
  const desde = new Date(now().getTime() - DIAS_METRICAS * 86400000).toISOString();
  const lista = await db.paraMetricas(desde);
  let ok = 0, parciales = 0;
  for (const p of lista) {
    const m = await metricasDe(g, p.ig_media_id);
    if (m.no_disponibles) parciales++; else ok++;
    await db.guardarMetricas(p.id, m, now().toISOString());
  }
  return { piezas: lista.length, completas: ok, parciales };
}

// ---------------------------------------------------------------- HTTP
const ORIGENES = ["https://guimaes.es", "https://www.guimaes.es"];

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(o) ? o : ORIGENES[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

type Quien = "cron" | "servicio" | "admin" | "miembro";
const PERMITIDO: Record<string, Quien[]> = {
  comprobar: ["cron", "servicio", "admin", "miembro"],
  publicar_pendientes: ["cron", "servicio", "admin"],
  publicar_ahora: ["servicio", "admin"],
  metricas: ["cron", "servicio", "admin"],
};

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const h = cors(req);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response("ok", { headers: h });
    if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

    try {
      // ---- quién llama ----
      let quien: Quien;
      const hook = req.headers.get("x-hook-secret");
      if (hook !== null) {
        const secreto = deps.env("INSTAGRAM_CRON_SECRET") ?? "";
        if (!secreto || !timingSafeEqual(hook, secreto)) return json({ error: "No autorizado." }, 401);
        quien = "cron";
      } else {
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!bearer) return json({ error: "No autorizado." }, 401);
        const service = deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        if (service && timingSafeEqual(bearer, service)) {
          quien = "servicio";
        } else {
          const uid = await deps.usuario(bearer);
          if (!uid) return json({ error: "No autorizado." }, 401);
          const r = await deps.db().rolDe(uid);
          if (!r || !r.activo) return json({ error: "No autorizado." }, 403);
          quien = r.rol === "admin" ? "admin" : "miembro";
        }
      }

      let body: any;
      try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
      const accion = String(body?.accion ?? "");
      if (!PERMITIDO[accion]) return json({ error: "Acción desconocida (comprobar | publicar_pendientes | publicar_ahora | metricas)." }, 400);
      if (!PERMITIDO[accion].includes(quien)) {
        return json({ error: quien === "miembro" ? "Solo el rol admin puede hacer esto." : "No autorizado." }, 403);
      }

      const token = deps.env("INSTAGRAM_ACCESS_TOKEN");
      const g = token ? makeGraph(deps.fetch, token) : null;
      if (accion === "comprobar") return json(await comprobar(g, deps.env));
      if (!g) return json({ error: "Falta el secreto INSTAGRAM_ACCESS_TOKEN en la función." }, 500);

      const db = deps.db();
      if (accion === "publicar_pendientes") return json(await publicarPendientes(g, db, deps));
      if (accion === "metricas") return json(await actualizarMetricas(g, db, deps));
      const postId = String(body?.post_id ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(postId)) return json({ error: "Falta post_id." }, 400);
      const r = await publicarAhora(g, db, deps, postId);
      return json(r.body, r.status);
    } catch (e) {
      console.error("instagram:", e);
      return json({ error: e instanceof GraphError ? `Meta: ${e.meta}` : (e instanceof Error ? e.message : String(e)) }, 500);
    }
  };
}
