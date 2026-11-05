// Pruebas de la función instagram con la Graph API y la base de datos simuladas.
// Ejecutar desde crm/ (sin red):
//   node --experimental-strip-types --test supabase-functions/instagram/instagram_test.ts
// (con Deno: deno test supabase-functions/instagram/instagram_test.ts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { comprobar, createHandler, GraphError, makeGraph, metricasDe, urlPublica } from "./instagram.ts";
import type { Db, Deps, Post } from "./instagram.ts";

const SB = "https://proyecto.supabase.co";
const CRON = "secreto-cron";
const SERVICE = "service-role-key";
const IG = "1784";
const TODOS = ["instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list", "pages_read_engagement", "business_management"];

type Llamada = { method: string; path: string; params: Record<string, string> };
type Opciones = {
  permisos?: string[];
  paginas?: any[];
  estadoContenedor?: (id: string, n: number) => string;
  fallaPublicar?: "400" | "red";
  insights?: (mediaId: string, metric: string) => any;
  tokenInvalido?: boolean;
  cupo?: { usado: number; total: number };
};

function fakeGraph(o: Opciones = {}) {
  const llamadas: Llamada[] = [];
  let n = 0;
  const vistas: Record<string, number> = {};
  const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    assert.equal(u.hostname, "graph.facebook.com");
    assert.match(u.pathname, /^\/v21\.0\//);
    const path = u.pathname.replace(/^\/v21\.0\//, "");
    const method = init?.method ?? "GET";
    const params = Object.fromEntries(method === "GET" ? u.searchParams : new URLSearchParams(String(init?.body ?? "")));
    assert.equal((init?.headers as Record<string, string>)["Authorization"], "Bearer tok");
    llamadas.push({ method, path, params });

    if (o.tokenInvalido) return resp(400, { error: { code: 190, message: "Invalid OAuth access token." } });
    if (path === "me" ) return resp(200, { id: "su1", name: "Employee" });
    if (path === "me/permissions") return resp(200, { data: (o.permisos ?? TODOS).map((p) => ({ permission: p, status: "granted" })) });
    if (path === "me/accounts") return resp(200, { data: o.paginas ?? [{ id: "pg1", name: "Guimaes", tasks: ["CREATE_CONTENT", "ANALYZE"], instagram_business_account: { id: IG, username: "guimaes_asesoria" } }] });
    if (path === IG && method === "GET") return resp(200, { id: IG, username: "guimaes_asesoria", name: "Guimaes", followers_count: 321, media_count: 12 });
    if (path === `${IG}/content_publishing_limit`) return resp(200, { data: [{ quota_usage: o.cupo?.usado ?? 1, config: { quota_total: o.cupo?.total ?? 50, quota_duration: 86400 } }] });
    if (path === `${IG}/media` && method === "POST") return resp(200, { id: "c" + (++n) });
    if (path === `${IG}/media_publish`) {
      if (o.fallaPublicar === "400") return resp(400, { error: { code: 9, message: "Application request limit reached" } });
      if (o.fallaPublicar === "red") throw new TypeError("network error");
      return resp(200, { id: "m-" + params.creation_id });
    }
    if (/^c\d+$/.test(path)) {
      vistas[path] = (vistas[path] ?? 0) + 1;
      return resp(200, { status_code: o.estadoContenedor ? o.estadoContenedor(path, vistas[path]) : "FINISHED" });
    }
    if (/^m-/.test(path) && params.fields === "permalink") return resp(200, { permalink: "https://www.instagram.com/p/" + path + "/" });
    if (/^m-/.test(path) && params.fields === "like_count,comments_count") return resp(200, { like_count: 7, comments_count: 2 });
    const mi = path.match(/^(m-[^/]+)\/insights$/);
    if (mi) {
      const r = o.insights ? o.insights(mi[1], params.metric) : null;
      if (r === "error") return resp(400, { error: { code: 100, message: "metric not supported" } });
      return resp(200, { data: params.metric.split(",").map((name) => ({ name, values: [{ value: name.length }] })) });
    }
    return resp(404, { error: { message: "ruta simulada desconocida: " + method + " " + path } });
  }) as typeof fetch;
  return { fetchFn, llamadas };
}

type Fila = { id: string; status: string; caption: string; attempts: number; scheduled_for: string; error?: string | null; ig_media_id?: string; permalink?: string | null; metrics?: any };
function fakeDb(filas: Fila[], slides: Record<string, { position: number; storage_path: string }[]>, roles: Record<string, { rol: string; activo: boolean }> = {}) {
  const db: Db = {
    async rolDe(uid) { return roles[uid] ?? null; },
    async pendientes(lim) {
      return filas.filter((f) => f.status === "aprobada" && f.scheduled_for <= new Date().toISOString())
        .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for)).slice(0, lim).map((f) => f.id);
    },
    async reservar(id, solo) {
      const f = filas.find((x) => x.id === id);
      if (!f || f.status !== "aprobada" || (solo && f.scheduled_for > new Date().toISOString())) return null;
      f.status = "publicando"; f.attempts++;
      return { id: f.id, caption: f.caption, attempts: f.attempts } as Post;
    },
    async laminas(id) { return slides[id] ?? []; },
    async publicada(id, d) { Object.assign(filas.find((x) => x.id === id)!, { status: "publicada", error: null, ...d }); },
    async fallo(id, m) { Object.assign(filas.find((x) => x.id === id)!, { status: "error", error: m }); },
    async paraMetricas() { return filas.filter((f) => f.status === "publicada" && f.ig_media_id).map((f) => ({ id: f.id, ig_media_id: f.ig_media_id! })); },
    async guardarMetricas(id, m) { filas.find((x) => x.id === id)!.metrics = m; },
  };
  return db;
}

const ID1 = "00000000-0000-0000-0000-000000000001";
const ID2 = "00000000-0000-0000-0000-000000000002";
const pasado = "2026-01-01T09:00:00Z";
const futuro = "2099-01-01T09:00:00Z";

function handler(g: ReturnType<typeof fakeGraph>, db: Db, extraEnv: Record<string, string> = {}, usuarios: Record<string, string> = {}) {
  const env: Record<string, string> = { SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SERVICE, INSTAGRAM_CRON_SECRET: CRON, INSTAGRAM_ACCESS_TOKEN: "tok", ...extraEnv };
  const deps: Deps = {
    env: (k) => env[k],
    fetch: g.fetchFn,
    db: () => db,
    usuario: async (jwt) => usuarios[jwt] ?? null,
    sleep: async () => {},
    now: () => new Date("2026-11-05T10:00:00Z"),
  };
  return createHandler(deps);
}
const post = (h: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string>) =>
  h(new Request("https://x/functions/v1/instagram", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));

// ------------------------------------------------------------------ autorización
test("autorización: cron, service role, admin, miembro y desconocidos", async () => {
  const g = fakeGraph();
  const db = fakeDb([], {});
  const h = handler(g, db, {}, { "jwt-admin": "u-admin", "jwt-miembro": "u-miembro", "jwt-inactivo": "u-inactivo", "jwt-externo": "u-externo" });
  (db as any).rolDe = async (uid: string) => ({ "u-admin": { rol: "admin", activo: true }, "u-miembro": { rol: "miembro", activo: true }, "u-inactivo": { rol: "admin", activo: false } } as any)[uid] ?? null;

  assert.equal((await post(h, { accion: "comprobar" }, {})).status, 401);
  assert.equal((await post(h, { accion: "comprobar" }, { "x-hook-secret": "otro" })).status, 401);
  assert.equal((await post(h, { accion: "comprobar" }, { "x-hook-secret": CRON })).status, 200);
  assert.equal((await post(h, { accion: "publicar_ahora", post_id: ID1 }, { "x-hook-secret": CRON })).status, 403);
  assert.equal((await post(h, { accion: "comprobar" }, { Authorization: "Bearer " + SERVICE })).status, 200);
  assert.equal((await post(h, { accion: "comprobar" }, { Authorization: "Bearer jwt-miembro" })).status, 200);
  const m = await post(h, { accion: "metricas" }, { Authorization: "Bearer jwt-miembro" });
  assert.equal(m.status, 403);
  assert.match((await m.json()).error, /rol admin/);
  assert.equal((await post(h, { accion: "publicar_ahora", post_id: ID1 }, { Authorization: "Bearer jwt-miembro" })).status, 403);
  assert.equal((await post(h, { accion: "metricas" }, { Authorization: "Bearer jwt-admin" })).status, 200);
  assert.equal((await post(h, { accion: "comprobar" }, { Authorization: "Bearer jwt-inactivo" })).status, 403);
  assert.equal((await post(h, { accion: "comprobar" }, { Authorization: "Bearer jwt-externo" })).status, 403);
  assert.equal((await post(h, { accion: "comprobar" }, { Authorization: "Bearer basura" })).status, 401);
  assert.equal((await post(h, { accion: "otra" }, { "x-hook-secret": CRON })).status, 400);
  const opt = await h(new Request("https://x", { method: "OPTIONS", headers: { origin: "https://guimaes.es" } }));
  assert.equal(opt.headers.get("access-control-allow-origin"), "https://guimaes.es");
});

// ------------------------------------------------------------------ comprobar
test("comprobar: todo bien", async () => {
  const g = fakeGraph();
  const r = await comprobar(makeGraph(g.fetchFn, "tok"), () => undefined);
  assert.equal(r.ok, true, JSON.stringify(r.problemas));
  assert.equal(r.cuenta.usuario, "guimaes_asesoria");
  assert.equal(r.cuenta.seguidores, 321);
  assert.deepEqual(r.cupo, { usado: 1, total: 50, horas: 24 });
});

test("comprobar: sin token, token inválido, permiso que falta", async () => {
  assert.match((await comprobar(null, () => undefined)).problemas[0], /INSTAGRAM_ACCESS_TOKEN/);
  const inv = await comprobar(makeGraph(fakeGraph({ tokenInvalido: true }).fetchFn, "tok"), () => undefined);
  assert.match(inv.problemas[0], /no es válido o ha caducado/);
  const r = await comprobar(makeGraph(fakeGraph({ permisos: TODOS.filter((p) => p !== "instagram_content_publish") }).fetchFn, "tok"), () => undefined);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problemas, ["Falta el permiso instagram_content_publish en el token."]);
});

test("comprobar: página no visible, Instagram no vinculado, acceso parcial", async () => {
  let r = await comprobar(makeGraph(fakeGraph({ paginas: [] }).fetchFn, "tok"), () => undefined);
  assert.match(r.problemas[0], /^Página no visible/);
  r = await comprobar(makeGraph(fakeGraph({ paginas: [{ id: "pg1", name: "Guimaes", tasks: ["ANALYZE"] }] }).fetchFn, "tok"), () => undefined);
  assert.match(r.problemas[0], /^Instagram no vinculado: la página «Guimaes»/);
  r = await comprobar(makeGraph(fakeGraph({ paginas: [{ id: "pg1", name: "Guimaes", tasks: ["ANALYZE", "ADVERTISE"], instagram_business_account: { id: IG, username: "guimaes_asesoria" } }] }).fetchFn, "tok"), () => undefined);
  assert.equal(r.ok, false);
  assert.match(r.problemas[0], /acceso parcial \(tareas: ANALYZE, ADVERTISE\): falta el permiso de contenido/);
  r = await comprobar(makeGraph(fakeGraph().fetchFn, "tok"), (k) => (k === "INSTAGRAM_USER_ID" ? "999" : undefined));
  assert.match(r.avisos.join(), /no coincide/);
});

// ------------------------------------------------------------------ publicar
test("publicar_pendientes: imagen suelta y carrusel, solo las cumplidas", async () => {
  const filas: Fila[] = [
    { id: ID1, status: "aprobada", caption: "Texto 1; con «comillas» y\nsalto", attempts: 0, scheduled_for: pasado },
    { id: ID2, status: "aprobada", caption: "Carrusel", attempts: 0, scheduled_for: pasado },
    { id: "00000000-0000-0000-0000-000000000003", status: "aprobada", caption: "Futuro", attempts: 0, scheduled_for: futuro },
  ];
  const slides = {
    [ID1]: [{ position: 1, storage_path: "lote/a b/01.jpg" }],
    [ID2]: [{ position: 2, storage_path: "lote/x/02-2.jpg" }, { position: 1, storage_path: "lote/x/02-1.jpg" }],
  };
  const g = fakeGraph({ estadoContenedor: (_id, n) => (n < 2 ? "IN_PROGRESS" : "FINISHED") });
  const h = handler(g, fakeDb(filas, slides));
  const res = await post(h, { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.publicadas, 2);
  assert.equal(filas[0].status, "publicada");
  assert.equal(filas[0].attempts, 1);
  assert.match(filas[0].permalink!, /instagram\.com\/p\//);
  assert.equal(filas[1].status, "publicada");
  assert.equal(filas[2].status, "aprobada");

  const medias = g.llamadas.filter((l) => l.path === `${IG}/media`);
  // Imagen suelta: un contenedor con texto y URL pública codificada.
  assert.equal(medias[0].params.image_url, urlPublica(SB, "lote/a b/01.jpg"));
  assert.equal(medias[0].params.image_url, SB + "/storage/v1/object/public/instagram-media/lote/a%20b/01.jpg");
  assert.equal(medias[0].params.caption, filas[0].caption);
  // Carrusel: hijos en orden de posición, sin texto, y contenedor CAROUSEL.
  assert.equal(medias[1].params.image_url, urlPublica(SB, "lote/x/02-1.jpg"));
  assert.equal(medias[1].params.is_carousel_item, "true");
  assert.equal(medias[1].params.caption, undefined);
  assert.equal(medias[2].params.image_url, urlPublica(SB, "lote/x/02-2.jpg"));
  assert.equal(medias[3].params.media_type, "CAROUSEL");
  assert.equal(medias[3].params.children, "c2,c3");
  assert.equal(medias[3].params.caption, "Carrusel");
  // Espera a FINISHED antes de publicar.
  const pub = g.llamadas.findIndex((l) => l.path === `${IG}/media_publish` && l.params.creation_id === "c4");
  const ultimaEspera = g.llamadas.map((l) => l.path).lastIndexOf("c4");
  assert.ok(ultimaEspera >= 0 && ultimaEspera < pub);
});

test("publicar_pendientes: nada pendiente no llama a Meta", async () => {
  const g = fakeGraph();
  const res = await post(handler(g, fakeDb([], {})), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  assert.equal((await res.json()).publicadas, 0);
  assert.equal(g.llamadas.length, 0);
});

test("publicar_pendientes: sin cupo no reserva", async () => {
  const filas: Fila[] = [{ id: ID1, status: "aprobada", caption: "x", attempts: 0, scheduled_for: pasado }];
  const g = fakeGraph({ cupo: { usado: 50, total: 50 } });
  const body = await (await post(handler(g, fakeDb(filas, { [ID1]: [{ position: 1, storage_path: "a.jpg" }] })), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON })).json();
  assert.equal(body.sin_cupo, true);
  assert.equal(filas[0].status, "aprobada");
});

test("errores: contenedor con ERROR, media_publish 400 y fallo de red", async () => {
  const mk = () => [{ id: ID1, status: "aprobada", caption: "x", attempts: 0, scheduled_for: pasado }] as Fila[];
  const sl = { [ID1]: [{ position: 1, storage_path: "a.jpg" }] };

  let filas = mk();
  await post(handler(fakeGraph({ estadoContenedor: () => "ERROR" }), fakeDb(filas, sl)), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  assert.equal(filas[0].status, "error");
  assert.match(filas[0].error!, /^No se ha publicado\. Instagram no ha podido procesar/);

  filas = mk();
  await post(handler(fakeGraph({ fallaPublicar: "400" }), fakeDb(filas, sl)), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  assert.equal(filas[0].status, "error");
  assert.match(filas[0].error!, /^No se ha publicado\. Meta: Application request limit/);

  filas = mk();
  await post(handler(fakeGraph({ fallaPublicar: "red" }), fakeDb(filas, sl)), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  assert.equal(filas[0].status, "error");
  assert.match(filas[0].error!, /^Puede que se haya publicado/);

  filas = mk();
  await post(handler(fakeGraph({ estadoContenedor: () => "IN_PROGRESS" }), fakeDb(filas, sl)), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  assert.match(filas[0].error!, /más de 60 s/);

  filas = mk();
  await post(handler(fakeGraph(), fakeDb(filas, {})), { accion: "publicar_pendientes" }, { "x-hook-secret": CRON });
  assert.match(filas[0].error!, /no tiene imágenes/);
});

test("publicar_ahora: solo aprobadas, aunque la fecha sea futura; sin duplicar", async () => {
  const filas: Fila[] = [{ id: ID1, status: "aprobada", caption: "x", attempts: 0, scheduled_for: futuro }];
  const g = fakeGraph();
  const h = handler(g, fakeDb(filas, { [ID1]: [{ position: 1, storage_path: "a.jpg" }] }), { INSTAGRAM_USER_ID: IG });
  let res = await post(h, { accion: "publicar_ahora", post_id: ID1 }, { Authorization: "Bearer " + SERVICE });
  assert.equal(res.status, 200);
  assert.equal(filas[0].status, "publicada");
  assert.equal(g.llamadas.some((l) => l.path === "me/accounts"), false, "con INSTAGRAM_USER_ID no hace falta /me/accounts");
  res = await post(h, { accion: "publicar_ahora", post_id: ID1 }, { Authorization: "Bearer " + SERVICE });
  assert.equal(res.status, 409);
  assert.equal(g.llamadas.filter((l) => l.path === `${IG}/media_publish`).length, 1);
  assert.equal((await post(h, { accion: "publicar_ahora" }, { Authorization: "Bearer " + SERVICE })).status, 400);
});

// ------------------------------------------------------------------ métricas
test("métricas: todas de una vez", async () => {
  const g = fakeGraph();
  const m = await metricasDe(makeGraph(g.fetchFn, "tok"), "m-1");
  assert.deepEqual(Object.keys(m).sort(), ["comments", "likes", "reach", "saved", "shares", "total_interactions", "views"]);
  assert.equal(g.llamadas.length, 1);
});

test("métricas: alternativa si alguna falla", async () => {
  const g = fakeGraph({ insights: (_m, metric) => (metric.includes(",") || metric === "views" || metric === "likes" ? "error" : null) });
  const m = await metricasDe(makeGraph(g.fetchFn, "tok"), "m-1");
  assert.equal(m.reach, 5);
  assert.equal(m.likes, 7, "likes desde like_count");
  assert.deepEqual(m.no_disponibles, ["views"]);
  assert.equal(m.error, undefined);
});

test("métricas: acción completa guarda en cada publicada", async () => {
  const filas: Fila[] = [
    { id: ID1, status: "publicada", caption: "", attempts: 1, scheduled_for: pasado, ig_media_id: "m-1" },
    { id: ID2, status: "borrador", caption: "", attempts: 0, scheduled_for: pasado },
  ];
  const body = await (await post(handler(fakeGraph(), fakeDb(filas, {})), { accion: "metricas" }, { "x-hook-secret": CRON })).json();
  assert.deepEqual(body, { piezas: 1, completas: 1, parciales: 0 });
  assert.equal(filas[0].metrics.reach, 5);
  assert.equal(filas[1].metrics, undefined);
});

test("GraphError lleva el mensaje de Meta", () => {
  const e = new GraphError(400, { error: { code: 190, message: "x" } });
  assert.equal(e.code, 190);
  assert.equal(e.meta, "x");
});
