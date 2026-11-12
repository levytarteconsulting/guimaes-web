// Lógica de la Edge Function "correo" (index.ts le pasa el entorno real;
// correo_test.ts, uno simulado). Sin dependencias de Deno ni de npm: se
// prueba con Node (node --experimental-strip-types --test) o con Deno.
//
// Buzón: info@guimaes.es es un ALIAS del buzón administracion@guimaes.es.
// MS_GRAPH_MAILBOX es el id de ese buzón (/users/{id}/...). La app de Entra
// solo tiene acceso por RBAC de Exchange limitado a ese buzón.
//
// Filtro obligatorio (el buzón tiene también correo de administracion@ que
// NO entra en el CRM):
//   inbox     — solo mensajes con info@ en toRecipients o ccRecipients;
//   sentitems — solo mensajes cuyo from es info@.
// Lo que no pasa el filtro no se guarda en ninguna tabla ni se escribe en los
// logs; solo suma en correo_sync.descartados. Todas las acciones sobre un
// mensaje concreto (responder, marcar leído, adjunto) exigen que el mensaje
// esté en correo_mensajes, así que el correo de administracion@ queda fuera
// de alcance también por ahí.
//
// Acciones (POST, cuerpo JSON {accion, ...}):
//   comprobar     — GET /users/{id}/messages?$top=1&$select=id → {ok} o {ok:false, estado, codigo}
//   sincronizar   — delta de inbox y sentitems (90 días la primera vez)
//   enviar        — {para[], cc[]?, cco[]?, asunto, texto}: sendMail con from = info@
//   responder     — {mensaje_id, texto, todos?}: createReply(All) → PATCH from → send
//   marcar_leido  — {mensaje_id, leido}: PATCH isRead en Outlook y en la tabla
//   adjunto       — {adjunto_id} o {mensaje_id, cid}: descarga bajo demanda (no se guarda)
//
// Quién puede llamar:
//   x-hook-secret = CORREO_CRON_SECRET (pg_cron)      → sincronizar, comprobar
//   Authorization: Bearer <service role>              → todas
//   Authorization: Bearer <JWT de usuario activo CRM> → todas

import { sanearHtml, textoAHtml } from "./sanear.ts";

export const GRAPH = "https://graph.microsoft.com/v1.0";
export const LOGIN = "https://login.microsoftonline.com";
export const ALIAS = "info@guimaes.es";
export const BUZON_PRINCIPAL = "administracion@guimaes.es"; // solo para no responderse a sí mismo
export const CARPETAS = ["inbox", "sentitems"] as const;
export type Carpeta = typeof CARPETAS[number];
export const DIAS_IMPORTACION = 90;
export const POR_PAGINA = 50;
export const PRESUPUESTO_MS = 100_000; // pg_net espera 150 s y la función tiene 150 s: margen
export const RESERVA_S = 170;
export const SELECT = [
  "id", "internetMessageId", "conversationId", "subject", "bodyPreview", "body", "from",
  "toRecipients", "ccRecipients", "bccRecipients", "receivedDateTime", "sentDateTime",
  "isRead", "hasAttachments", "isDraft",
].join(",");
const SELECT_ADJ = "id,name,contentType,size,isInline";
const SELECT_ADJ_CID = SELECT_ADJ + ",microsoft.graph.fileAttachment/contentId";
const MAX_TEXTO = 100_000;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

// ---------------------------------------------------------------- errores
export class GraphError extends Error {
  estado: number;
  codigo: string;
  constructor(estado: number, codigo: string) {
    super(`Microsoft Graph ${estado}${codigo ? " " + codigo : ""}`);
    this.estado = estado;
    this.codigo = codigo;
  }
}
class Peticion extends Error {
  estado: number;
  constructor(estado: number, mensaje: string) { super(mensaje); this.estado = estado; }
}
// Texto de error que se puede guardar y mostrar: nunca contenido de correos.
export function errorSeguro(e: unknown): string {
  if (e instanceof GraphError || e instanceof Peticion) return e.message;
  if (e instanceof Error && e.name === "TypeError") return "Error de red al llamar a Microsoft";
  return "Error interno (ver logs de la función)";
}

// ---------------------------------------------------------------- dependencias
export type Fila = Record<string, unknown>;
export type Estado = { delta_link: string | null; next_link: string | null; importacion_desde: string | null; descartados: number };
export type MensajeDb = { id: string; graph_id: string; carpeta: Carpeta };
export type AdjuntoDb = { id: string; graph_id: string; mensaje_graph_id: string; nombre: string; tipo: string | null; content_id: string | null; inline: boolean };
export interface Db {
  usuarioActivo(authUserId: string): Promise<boolean>;
  reservar(carpeta: Carpeta, segundos: number): Promise<boolean>;
  liberar(carpeta: Carpeta): Promise<void>;
  estado(carpeta: Carpeta): Promise<Estado>;
  guardarEstado(carpeta: Carpeta, cambios: Partial<Estado> & { ultimo_ok?: string; ultimo_error?: string | null }): Promise<void>;
  guardarMensajes(filas: Fila[]): Promise<Record<string, string>>; // graph_id → id
  marcarFuera(graphIds: string[], enIso: string): Promise<number>;  // solo filas existentes
  leidoSiExiste(graphId: string, leido: boolean): Promise<void>;
  guardarAdjuntos(filas: Fila[]): Promise<void>;
  mensaje(id: string): Promise<MensajeDb | null>;
  adjunto(id: string): Promise<AdjuntoDb | null>;
  adjuntosDe(mensajeId: string): Promise<AdjuntoDb[]>;
  marcarLeido(id: string, leido: boolean): Promise<void>;
}
export type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  db: () => Db;
  usuario: (jwt: string) => Promise<string | null>;
  now?: () => Date;
  log?: (...a: unknown[]) => void;
};

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------------------------------------------------------------- token y Graph
let cacheToken: { clave: string; token: string; caduca: number } | null = null;
export function olvidarToken() { cacheToken = null; }

async function token(deps: Deps): Promise<string> {
  const tenant = deps.env("MS_GRAPH_TENANT_ID") ?? "";
  const id = deps.env("MS_GRAPH_CLIENT_ID") ?? "";
  const secreto = deps.env("MS_GRAPH_CLIENT_SECRET") ?? "";
  if (!tenant || !id || !secreto) throw new Peticion(500, "Faltan secretos MS_GRAPH_* en la función");
  const ahora = (deps.now?.() ?? new Date()).getTime();
  const clave = tenant + "|" + id;
  if (cacheToken && cacheToken.clave === clave && cacheToken.caduca - 120_000 > ahora) return cacheToken.token;
  const res = await deps.fetch(`${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id, client_secret: secreto, grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }).toString(),
  });
  let body: any = {};
  try { body = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok || !body?.access_token) throw new GraphError(res.status, String(body?.error ?? "token"));
  cacheToken = { clave, token: body.access_token, caduca: ahora + Number(body.expires_in ?? 3599) * 1000 };
  return cacheToken.token;
}

type Opc = { method?: string; body?: unknown; prefer?: string; crudo?: boolean };
async function graph(deps: Deps, ruta: string, o: Opc = {}): Promise<any> {
  const url = ruta.startsWith("https://") ? ruta : GRAPH + ruta;
  // nextLink/deltaLink vienen de Graph; aun así, el token no sale de Graph.
  if (!url.startsWith(GRAPH + "/")) throw new Peticion(502, "Enlace de Graph inesperado");
  const headers: Record<string, string> = { "Authorization": `Bearer ${await token(deps)}` };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.prefer) headers["Prefer"] = o.prefer;
  const res = await deps.fetch(url, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  if (res.ok && o.crudo) return res;
  const texto = await res.text();
  let body: any = {};
  try { body = texto ? JSON.parse(texto) : {}; } catch { body = {}; }
  if (!res.ok) {
    if (res.status === 401) olvidarToken();
    throw new GraphError(res.status, String(body?.error?.code ?? ""));
  }
  return body;
}

function buzon(deps: Deps): string {
  const b = deps.env("MS_GRAPH_MAILBOX") ?? "";
  if (!b) throw new Peticion(500, "Falta el secreto MS_GRAPH_MAILBOX en la función");
  return `/users/${encodeURIComponent(b)}`;
}

// ---------------------------------------------------------------- filtro y filas
const dir = (r: any): string => String(r?.emailAddress?.address ?? "").trim().toLowerCase();

export function esDeInfo(m: any, carpeta: Carpeta): boolean {
  if (carpeta === "inbox") return [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].some((r: any) => dir(r) === ALIAS);
  return dir(m.from) === ALIAS;
}
// Un elemento del delta sin los campos del filtro no se puede clasificar.
function completo(m: any, carpeta: Carpeta): boolean {
  return carpeta === "inbox" ? Array.isArray(m.toRecipients) : m.from !== undefined;
}

function lista(xs: any[] | undefined) {
  return (xs ?? []).map((r) => ({ email: String(r?.emailAddress?.address ?? "").trim(), nombre: String(r?.emailAddress?.name ?? "") }))
    .filter((r) => r.email);
}
export function filaDe(m: any, carpeta: Carpeta): Fila {
  const cuerpo = m.body ?? {};
  return {
    graph_id: m.id,
    internet_message_id: m.internetMessageId ?? null,
    conversation_id: m.conversationId ?? null,
    carpeta,
    remitente_email: m.from?.emailAddress?.address ?? null,
    remitente_nombre: m.from?.emailAddress?.name ?? null,
    para: lista(m.toRecipients),
    cc: lista(m.ccRecipients),
    cco: lista(m.bccRecipients),
    asunto: String(m.subject ?? ""),
    extracto: String(m.bodyPreview ?? "").slice(0, 500),
    cuerpo_html: String(cuerpo.contentType ?? "").toLowerCase() === "text" ? textoAHtml(cuerpo.content ?? "") : sanearHtml(String(cuerpo.content ?? "")),
    fecha: (carpeta === "sentitems" ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime ?? m.sentDateTime,
    leido: !!m.isRead,
    tiene_adjuntos: !!m.hasAttachments,
    fuera_bandeja: false,
    fuera_bandeja_at: null,
  };
}

// ---------------------------------------------------------------- sincronizar
export function urlInicial(b: string, carpeta: Carpeta, desdeIso: string): string {
  return `${b}/mailFolders/${carpeta}/messages/delta?$select=${SELECT}`
    + `&$filter=${encodeURIComponent(`receivedDateTime ge ${desdeIso}`)}`;
}

async function listarAdjuntos(deps: Deps, b: string, graphId: string): Promise<any[]> {
  const base = `${b}/messages/${encodeURIComponent(graphId)}/attachments`;
  let pag: any;
  try {
    pag = await graph(deps, `${base}?$select=${SELECT_ADJ_CID}`);
  } catch (e) {
    // Si Graph no acepta el contentId tipado, sin él (los cid: se resuelven por nombre).
    if (!(e instanceof GraphError) || e.estado !== 400) throw e;
    pag = await graph(deps, `${base}?$select=${SELECT_ADJ}`);
  }
  const todos = [...(pag.value ?? [])];
  for (let i = 0; pag["@odata.nextLink"] && i < 10; i++) {
    pag = await graph(deps, pag["@odata.nextLink"]);
    todos.push(...(pag.value ?? []));
  }
  return todos;
}

export type Resumen = {
  carpeta: Carpeta; reservada: boolean; completa: boolean;
  guardados: number; descartados: number; fuera_bandeja: number; adjuntos: number; error?: string;
};

async function sincronizarCarpeta(deps: Deps, db: Db, carpeta: Carpeta, limite: number): Promise<Resumen> {
  const ahora = () => (deps.now?.() ?? new Date());
  const r: Resumen = { carpeta, reservada: true, completa: false, guardados: 0, descartados: 0, fuera_bandeja: 0, adjuntos: 0 };
  if (!(await db.reservar(carpeta, RESERVA_S))) { r.reservada = false; return r; }
  try {
    const b = buzon(deps);
    const est = await db.estado(carpeta);
    const descartadosAntes = Number(est.descartados ?? 0);
    let url = est.next_link || est.delta_link || "";
    if (!url) {
      const desde = new Date(ahora().getTime() - DIAS_IMPORTACION * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      url = urlInicial(b, carpeta, desde);
      await db.guardarEstado(carpeta, { importacion_desde: desde });
    }
    while (ahora().getTime() < limite) {
      const pag = await graph(deps, url, { prefer: `odata.maxpagesize=${POR_PAGINA}, outlook.body-content-type="html"` });
      const guardar: any[] = [];
      const quitar: string[] = [];
      for (const m of pag.value ?? []) {
        if (!m?.id) continue;
        if (m["@removed"]) { quitar.push(m.id); continue; }
        if (!completo(m, carpeta)) {
          if (typeof m.isRead === "boolean") await db.leidoSiExiste(m.id, m.isRead);
          continue;
        }
        if (m.isDraft || !esDeInfo(m, carpeta)) { r.descartados++; continue; }
        guardar.push(m);
      }
      if (quitar.length) r.fuera_bandeja += await db.marcarFuera(quitar, ahora().toISOString());
      if (guardar.length) {
        const ids = await db.guardarMensajes(guardar.map((m) => filaDe(m, carpeta)));
        r.guardados += guardar.length;
        for (const m of guardar) {
          // Las imágenes incrustadas no cuentan en hasAttachments: mirar también cid:.
          const conCid = /\bcid:/i.test(String(m.body?.content ?? ""));
          if (!m.hasAttachments && !conCid) continue;
          if (!ids[m.id]) continue;
          const adj = await listarAdjuntos(deps, b, m.id);
          if (!adj.length) continue;
          await db.guardarAdjuntos(adj.map((a) => ({
            mensaje_id: ids[m.id],
            graph_id: a.id,
            nombre: String(a.name ?? ""),
            tipo: a.contentType ?? null,
            tamano: typeof a.size === "number" ? a.size : null,
            inline: !!a.isInline,
            content_id: a.contentId ? String(a.contentId).replace(/^<|>$/g, "") : null,
          })));
          r.adjuntos += adj.length;
        }
      }
      const descartados = descartadosAntes + r.descartados;
      if (pag["@odata.nextLink"]) {
        url = pag["@odata.nextLink"];
        await db.guardarEstado(carpeta, { next_link: url, descartados });
        continue;
      }
      if (pag["@odata.deltaLink"]) {
        // El deltaLink solo se guarda al terminar todas las páginas.
        await db.guardarEstado(carpeta, {
          delta_link: pag["@odata.deltaLink"], next_link: null, descartados,
          ultimo_ok: ahora().toISOString(), ultimo_error: null,
        });
        r.completa = true;
        break;
      }
      throw new Peticion(502, "Respuesta de delta sin nextLink ni deltaLink");
    }
    if (!r.completa) await db.guardarEstado(carpeta, { descartados: descartadosAntes + r.descartados });
  } catch (e) {
    r.error = errorSeguro(e);
    const caducado = e instanceof GraphError && (e.estado === 410 || /syncstate/i.test(e.codigo));
    deps.log?.("correo: sincronizar", carpeta, r.error);
    await db.guardarEstado(carpeta, caducado
      ? { next_link: null, delta_link: null, importacion_desde: null, ultimo_error: "Estado de delta caducado: se reinicia la importación" }
      : { ultimo_error: r.error });
  } finally {
    await db.liberar(carpeta);
  }
  return r;
}

export async function sincronizar(deps: Deps, db: Db) {
  const limite = (deps.now?.() ?? new Date()).getTime() + PRESUPUESTO_MS;
  const carpetas: Resumen[] = [];
  for (const c of CARPETAS) carpetas.push(await sincronizarCarpeta(deps, db, c, limite));
  return { carpetas };
}

// ---------------------------------------------------------------- comprobar
export async function comprobar(deps: Deps) {
  try {
    await graph(deps, `${buzon(deps)}/messages?$top=1&$select=id`);
    return { ok: true };
  } catch (e) {
    if (e instanceof GraphError) {
      return {
        ok: false, estado: e.estado, codigo: e.codigo,
        aviso: e.estado === 403 ? "Exchange todavía no da acceso a la app (rol o scope sin propagar)." : undefined,
      };
    }
    return { ok: false, error: errorSeguro(e) };
  }
}

// ---------------------------------------------------------------- enviar y responder
function destinatarios(xs: unknown, campo: string, obligatorio = false) {
  const arr = xs === undefined || xs === null ? [] : xs;
  if (!Array.isArray(arr)) throw new Peticion(400, `${campo} debe ser una lista de emails`);
  const limpios = arr.map((x) => String(x ?? "").trim()).filter(Boolean);
  for (const e of limpios) if (!EMAIL_RE.test(e)) throw new Peticion(400, `Email no válido en ${campo}`);
  if (obligatorio && !limpios.length) throw new Peticion(400, "Falta al menos un destinatario");
  if (limpios.length > 50) throw new Peticion(400, `Demasiados destinatarios en ${campo}`);
  return limpios.map((address) => ({ emailAddress: { address } }));
}
function texto(x: unknown): string {
  const t = String(x ?? "");
  if (!t.trim()) throw new Peticion(400, "El mensaje está vacío");
  if (t.length > MAX_TEXTO) throw new Peticion(400, "El mensaje es demasiado largo");
  return t;
}
const FROM = { emailAddress: { address: ALIAS } };

export async function enviar(deps: Deps, body: any) {
  const asunto = String(body?.asunto ?? "").trim();
  if (!asunto) throw new Peticion(400, "Falta el asunto");
  if (asunto.length > 255) throw new Peticion(400, "El asunto es demasiado largo");
  const message = {
    subject: asunto,
    body: { contentType: "HTML", content: textoAHtml(texto(body?.texto)) },
    toRecipients: destinatarios(body?.para, "para", true),
    ccRecipients: destinatarios(body?.cc, "cc"),
    bccRecipients: destinatarios(body?.cco, "cco"),
    from: FROM,
  };
  await graph(deps, `${buzon(deps)}/sendMail`, { method: "POST", body: { message, saveToSentItems: true } });
  return { ok: true };
}

// Mete el texto nuevo delante de la cita que prepara createReply.
export function conCita(html: string, nuevo: string): string {
  const m = /<body[^>]*>/i.exec(html);
  if (!m) return nuevo + html;
  const i = m.index + m[0].length;
  return html.slice(0, i) + nuevo + html.slice(i);
}
const noSoyYo = (xs: any[] | undefined) =>
  (xs ?? []).filter((r) => ![ALIAS, BUZON_PRINCIPAL].includes(dir(r)));

async function mensajeDe(db: Db, id: unknown): Promise<MensajeDb> {
  const s = String(id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(s)) throw new Peticion(400, "Falta mensaje_id");
  const m = await db.mensaje(s);
  if (!m) throw new Peticion(404, "Mensaje no encontrado");
  return m;
}

export async function responder(deps: Deps, db: Db, body: any) {
  const m = await mensajeDe(db, body?.mensaje_id);
  if (m.carpeta !== "inbox") throw new Peticion(400, "Solo se puede responder a un mensaje recibido");
  const t = texto(body?.texto);
  const b = buzon(deps);
  const borrador = await graph(deps, `${b}/messages/${encodeURIComponent(m.graph_id)}/${body?.todos ? "createReplyAll" : "createReply"}`, { method: "POST", body: {} });
  const bid = encodeURIComponent(String(borrador?.id ?? ""));
  try {
    const cambios: Record<string, unknown> = {
      from: FROM,
      body: { contentType: "HTML", content: conCita(String(borrador?.body?.content ?? ""), textoAHtml(t)) },
    };
    if (body?.todos) {
      cambios.toRecipients = noSoyYo(borrador?.toRecipients);
      cambios.ccRecipients = noSoyYo(borrador?.ccRecipients);
    }
    await graph(deps, `${b}/messages/${bid}`, { method: "PATCH", body: cambios });
    await graph(deps, `${b}/messages/${bid}/send`, { method: "POST" });
  } catch (e) {
    // No dejar el borrador a medias en el buzón.
    try { await graph(deps, `${b}/messages/${bid}`, { method: "DELETE" }); } catch { /* ya está */ }
    throw e;
  }
  return { ok: true };
}

export async function marcarLeido(deps: Deps, db: Db, body: any) {
  const m = await mensajeDe(db, body?.mensaje_id);
  const leido = body?.leido !== false;
  await graph(deps, `${buzon(deps)}/messages/${encodeURIComponent(m.graph_id)}`, { method: "PATCH", body: { isRead: leido } });
  await db.marcarLeido(m.id, leido);
  return { ok: true, leido };
}

// ---------------------------------------------------------------- adjunto
export function buscarCid(adjuntos: AdjuntoDb[], cid: string): AdjuntoDb | null {
  const c = cid.replace(/^<|>$/g, "").toLowerCase();
  return adjuntos.find((a) => (a.content_id ?? "").toLowerCase() === c)
    // Sin contentId: Outlook suele usar "nombre@id".
    ?? adjuntos.find((a) => a.nombre && a.nombre.toLowerCase() === c.split("@")[0])
    ?? null;
}

async function adjunto(deps: Deps, db: Db, body: any, h: Record<string, string>): Promise<Response> {
  let a: AdjuntoDb | null = null;
  if (body?.adjunto_id) {
    const s = String(body.adjunto_id);
    if (!/^[0-9a-f-]{36}$/i.test(s)) throw new Peticion(400, "adjunto_id no válido");
    a = await db.adjunto(s);
  } else if (body?.cid) {
    const m = await mensajeDe(db, body?.mensaje_id);
    a = buscarCid(await db.adjuntosDe(m.id), String(body.cid));
  } else {
    throw new Peticion(400, "Falta adjunto_id o cid");
  }
  if (!a) throw new Peticion(404, "Adjunto no encontrado");
  const res: Response = await graph(deps,
    `${buzon(deps)}/messages/${encodeURIComponent(a.mensaje_graph_id)}/attachments/${encodeURIComponent(a.graph_id)}/$value`,
    { crudo: true });
  const tipo = /^[\w.+-]+\/[\w.+-]+$/.test(a.tipo ?? "") ? a.tipo! : "application/octet-stream";
  return new Response(res.body, {
    status: 200,
    headers: {
      ...h,
      "Content-Type": tipo,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.nombre || "adjunto")}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

// ---------------------------------------------------------------- handler
const ORIGENES = ["https://guimaes.es", "https://www.guimaes.es"];
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(o) ? o : ORIGENES[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "content-disposition",
    "Vary": "Origin",
  };
}

type Quien = "cron" | "servicio" | "usuario";
const PERMITIDO: Record<string, Quien[]> = {
  comprobar: ["cron", "servicio", "usuario"],
  sincronizar: ["cron", "servicio", "usuario"],
  enviar: ["servicio", "usuario"],
  responder: ["servicio", "usuario"],
  marcar_leido: ["servicio", "usuario"],
  adjunto: ["servicio", "usuario"],
};

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    const h = cors(req);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response("ok", { headers: h });
    if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

    try {
      let quien: Quien;
      const hook = req.headers.get("x-hook-secret");
      if (hook !== null) {
        const secreto = deps.env("CORREO_CRON_SECRET") ?? "";
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
          if (!(await deps.db().usuarioActivo(uid))) return json({ error: "No autorizado." }, 403);
          quien = "usuario";
        }
      }

      let body: any;
      try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
      const accion = String(body?.accion ?? "");
      if (!PERMITIDO[accion]) return json({ error: "Acción desconocida." }, 400);
      if (!PERMITIDO[accion].includes(quien)) return json({ error: "No autorizado." }, 403);

      if (accion === "comprobar") return json(await comprobar(deps));
      const db = deps.db();
      if (accion === "sincronizar") return json(await sincronizar(deps, db));
      if (accion === "enviar") return json(await enviar(deps, body));
      if (accion === "responder") return json(await responder(deps, db, body));
      if (accion === "marcar_leido") return json(await marcarLeido(deps, db, body));
      return await adjunto(deps, db, body, h);
    } catch (e) {
      if (e instanceof Peticion) return json({ error: e.message }, e.estado);
      if (e instanceof GraphError) {
        (deps.log ?? console.error)("correo:", e.message);
        const estado = e.estado === 404 ? 404 : e.estado === 403 ? 403 : 502;
        return json({ error: e.estado === 404 ? "Ya no está en el buzón de Outlook." : e.message, codigo: e.codigo }, estado);
      }
      (deps.log ?? console.error)("correo: error interno", e instanceof Error ? e.name : "");
      return json({ error: errorSeguro(e) }, 500);
    }
  };
}
