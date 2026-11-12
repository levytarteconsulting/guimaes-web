// Pruebas de la función correo con Microsoft Graph y la base de datos simulados.
// Ejecutar desde crm/ (sin red):
//   node --experimental-strip-types --test supabase-functions/correo/
// (con Deno: deno test supabase-functions/correo/)
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { ALIAS, buscarCid, conCita, createHandler, DIAS_IMPORTACION, esDeInfo, GRAPH, olvidarToken, PRESUPUESTO_MS } from "./correo.ts";
import type { AdjuntoDb, Carpeta, Db, Deps, Estado, Fila } from "./correo.ts";
import { sanearHtml, textoAHtml } from "./sanear.ts";

const BUZON = "091c33e7-0000-0000-0000-000000000000";
const SERVICE = "service-role-key";
const CRON = "secreto-cron";
const U = `${GRAPH}/users/${BUZON}`;
const SECRETO_ASUNTO = "ASUNTO-PRIVADO-DE-ADMINISTRACION";

const env: Record<string, string> = {
  MS_GRAPH_TENANT_ID: "tenant", MS_GRAPH_CLIENT_ID: "cliente", MS_GRAPH_CLIENT_SECRET: "secreto",
  MS_GRAPH_MAILBOX: BUZON, CORREO_CRON_SECRET: CRON, SUPABASE_SERVICE_ROLE_KEY: SERVICE,
};

// ---------------------------------------------------------------- base de datos simulada
class FakeDb implements Db {
  mensajes = new Map<string, Fila & { id: string }>(); // por graph_id
  adjuntos: (Fila & { id: string })[] = [];
  sync: Record<Carpeta, Estado & Record<string, unknown>> = {
    inbox: { delta_link: null, next_link: null, importacion_desde: null, descartados: 0 },
    sentitems: { delta_link: null, next_link: null, importacion_desde: null, descartados: 0 },
  };
  reservadas = new Set<Carpeta>();
  activos = new Set(["u-activo"]);
  n = 0;
  async usuarioActivo(uid: string) { return this.activos.has(uid); }
  async reservar(c: Carpeta) { if (this.reservadas.has(c)) return false; this.reservadas.add(c); return true; }
  async liberar(c: Carpeta) { this.reservadas.delete(c); }
  async estado(c: Carpeta) { const s = this.sync[c]; return { delta_link: s.delta_link, next_link: s.next_link, importacion_desde: s.importacion_desde, descartados: s.descartados }; }
  async guardarEstado(c: Carpeta, cambios: Record<string, unknown>) { Object.assign(this.sync[c], cambios); }
  async guardarMensajes(filas: Fila[]) {
    const r: Record<string, string> = {};
    for (const f of filas) {
      const g = String(f.graph_id);
      const prev = this.mensajes.get(g);
      const id = prev?.id ?? `00000000-0000-0000-0000-${String(++this.n).padStart(12, "0")}`;
      this.mensajes.set(g, { ...(prev ?? {}), ...f, id });
      r[g] = id;
    }
    return r;
  }
  async marcarFuera(ids: string[], en: string) {
    let n = 0;
    for (const g of ids) { const m = this.mensajes.get(g); if (m && !m.fuera_bandeja) { m.fuera_bandeja = true; m.fuera_bandeja_at = en; n++; } }
    return n;
  }
  async leidoSiExiste(g: string, leido: boolean) { const m = this.mensajes.get(g); if (m) m.leido = leido; }
  async guardarAdjuntos(filas: Fila[]) {
    for (const f of filas) {
      const i = this.adjuntos.findIndex((a) => a.mensaje_id === f.mensaje_id && a.graph_id === f.graph_id);
      const fila = { ...f, id: i >= 0 ? this.adjuntos[i].id : `a0000000-0000-0000-0000-${String(++this.n).padStart(12, "0")}` };
      if (i >= 0) this.adjuntos[i] = fila; else this.adjuntos.push(fila);
    }
  }
  porId(id: string) { return [...this.mensajes.values()].find((m) => m.id === id); }
  async mensaje(id: string) { const m = this.porId(id); return m ? { id: m.id, graph_id: String(m.graph_id), carpeta: m.carpeta as Carpeta } : null; }
  aAdj(a: Fila & { id: string }): AdjuntoDb {
    const m = this.porId(String(a.mensaje_id))!;
    return { id: a.id, graph_id: String(a.graph_id), mensaje_graph_id: String(m.graph_id), nombre: String(a.nombre), tipo: (a.tipo as string) ?? null, content_id: (a.content_id as string) ?? null, inline: !!a.inline };
  }
  async adjunto(id: string) { const a = this.adjuntos.find((x) => x.id === id); return a ? this.aAdj(a) : null; }
  async adjuntosDe(mid: string) { return this.adjuntos.filter((a) => a.mensaje_id === mid).map((a) => this.aAdj(a)); }
  async marcarLeido(id: string, leido: boolean) { const m = this.porId(id); if (m) m.leido = leido; }
}

// ---------------------------------------------------------------- Graph simulado
type Llamada = { method: string; url: string; body: any; headers: Record<string, string> };
type Graph = {
  llamadas: Llamada[];
  tokens: number;
  fetch: typeof fetch;
  paginas: Record<string, any>;       // url → respuesta
  adjuntos: Record<string, any[]>;    // graph_id del mensaje → adjuntos
  falla?: (c: Llamada) => Response | null;
  borrador?: any;
};
const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function fakeGraph(): Graph {
  const g: Graph = { llamadas: [], tokens: 0, paginas: {}, adjuntos: {}, fetch: null as any };
  g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith("https://login.microsoftonline.com/")) {
      assert.equal(url, "https://login.microsoftonline.com/tenant/oauth2/v2.0/token");
      const p = new URLSearchParams(String(init?.body));
      assert.equal(p.get("grant_type"), "client_credentials");
      assert.equal(p.get("scope"), "https://graph.microsoft.com/.default");
      g.tokens++;
      return resp(200, { access_token: "tok" + g.tokens, expires_in: 3599 });
    }
    assert.ok(url.startsWith(U + "/"), "siempre /users/{id del buzón}: " + url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.match(headers["Authorization"], /^Bearer tok\d+$/);
    const c: Llamada = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    g.llamadas.push(c);
    const f = g.falla?.(c); if (f) return f;
    const ruta = url.slice(U.length);
    if (method === "GET" && ruta === "/messages?$top=1&$select=id") return resp(200, { value: [{ id: "x" }] });
    if (method === "GET" && g.paginas[url]) return resp(200, g.paginas[url]);
    const adj = ruta.match(/^\/messages\/([^/]+)\/attachments\?\$select=/);
    if (method === "GET" && adj) return resp(200, { value: g.adjuntos[decodeURIComponent(adj[1])] ?? [] });
    const val = ruta.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/);
    if (method === "GET" && val) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (method === "POST" && ruta === "/sendMail") return new Response(null, { status: 202 });
    if (method === "POST" && /\/createReply(All)?$/.test(ruta)) return resp(201, g.borrador ?? { id: "borrador1", body: { contentType: "html", content: "<html><body><div>cita</div></body></html>" }, toRecipients: [], ccRecipients: [] });
    if (method === "PATCH" && /^\/messages\/[^/]+$/.test(ruta)) return resp(200, {});
    if (method === "POST" && /^\/messages\/[^/]+\/send$/.test(ruta)) return new Response(null, { status: 202 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return resp(404, { error: { code: "ErrorItemNotFound", message: "no" } });
  }) as typeof fetch;
  return g;
}

// ---------------------------------------------------------------- utilidades
const dir = (address: string, name = "") => ({ emailAddress: { address, name } });
function msg(id: string, o: Record<string, unknown> = {}) {
  return {
    id, internetMessageId: `<${id}@x>`, conversationId: "conv-" + id, subject: "Asunto " + id, bodyPreview: "hola",
    body: { contentType: "html", content: "<p>hola</p>" },
    from: dir("cliente@ejemplo.invalid", "Cliente"), toRecipients: [dir(ALIAS)], ccRecipients: [], bccRecipients: [],
    receivedDateTime: "2026-11-10T10:00:00Z", sentDateTime: "2026-11-10T09:59:00Z", isRead: false, hasAttachments: false, isDraft: false,
    ...o,
  };
}

let reloj = new Date("2026-11-12T12:00:00Z");
let logs: string[] = [];
function deps(g: Graph, db: FakeDb, extra: Partial<Deps> = {}): Deps {
  return {
    env: (k) => env[k], fetch: g.fetch, db: () => db,
    usuario: async (jwt) => (jwt === "jwt-activo" ? "u-activo" : jwt === "jwt-inactivo" ? "u-inactivo" : null),
    now: () => reloj, log: (...a) => logs.push(a.map(String).join(" ")),
    ...extra,
  };
}
async function llamar(d: Deps, body: unknown, auth: Record<string, string> = { authorization: "Bearer " + SERVICE }) {
  const res = await createHandler(d)(new Request("https://f/correo", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) }));
  return res;
}
async function jsonDe(d: Deps, body: unknown, auth?: Record<string, string>) {
  const res = await llamar(d, body, auth);
  return { status: res.status, body: await res.json() };
}
function inicial(carpeta: Carpeta) {
  const desde = new Date(reloj.getTime() - DIAS_IMPORTACION * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${U}/mailFolders/${carpeta}/messages/delta?$select=id,internetMessageId,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,isDraft&$filter=${encodeURIComponent("receivedDateTime ge " + desde)}`;
}

beforeEach(() => { olvidarToken(); reloj = new Date("2026-11-12T12:00:00Z"); logs = []; });

// ---------------------------------------------------------------- comprobar
test("comprobar: GET /users/{id}/messages?$top=1&$select=id y solo OK; token cacheado", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const r1 = await jsonDe(d, { accion: "comprobar" });
  const r2 = await jsonDe(d, { accion: "comprobar" }, { authorization: "Bearer jwt-activo" });
  assert.deepEqual(r1, { status: 200, body: { ok: true } });
  assert.deepEqual(r2.body, { ok: true });
  assert.equal(g.tokens, 1, "el token se reutiliza mientras es válido");
  assert.equal(g.llamadas[0].url, `${U}/messages?$top=1&$select=id`);
  reloj = new Date(reloj.getTime() + 3600_000);
  await jsonDe(d, { accion: "comprobar" });
  assert.equal(g.tokens, 2, "caducado → token nuevo");
});

test("comprobar: 403 ErrorAccessDenied → ok:false con el código, sin fallo 500", async () => {
  const g = fakeGraph(); g.falla = () => resp(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } });
  const r = await jsonDe(deps(g, new FakeDb()), { accion: "comprobar" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.estado, 403);
  assert.equal(r.body.codigo, "ErrorAccessDenied");
});

test("comprobar: sin secretos → ok:false, sin llamar a Graph", async () => {
  const g = fakeGraph();
  const d = deps(g, new FakeDb(), { env: (k) => (k === "MS_GRAPH_CLIENT_SECRET" ? undefined : env[k]) });
  const r = await jsonDe(d, { accion: "comprobar" });
  assert.equal(r.body.ok, false);
  assert.equal(g.tokens + g.llamadas.length, 0);
});

// ---------------------------------------------------------------- filtro
test("filtro: inbox con info@ en para o cc (sin mayúsculas); sentitems con from info@", () => {
  assert.equal(esDeInfo(msg("a", { toRecipients: [dir("INFO@Guimaes.es ")] }), "inbox"), true);
  assert.equal(esDeInfo(msg("a", { toRecipients: [dir("otro@x.invalid")], ccRecipients: [dir("info@guimaes.es")] }), "inbox"), true);
  assert.equal(esDeInfo(msg("a", { toRecipients: [dir("administracion@guimaes.es")] }), "inbox"), false);
  assert.equal(esDeInfo(msg("a", { toRecipients: [dir("administracion@guimaes.es")], bccRecipients: [dir(ALIAS)] }), "inbox"), false, "cco no cuenta");
  assert.equal(esDeInfo(msg("a", { from: dir("Info@guimaes.es") }), "sentitems"), true);
  assert.equal(esDeInfo(msg("a", { from: dir("administracion@guimaes.es"), toRecipients: [dir(ALIAS)] }), "sentitems"), false);
});

test("sincronizar: lo de administracion@ no se guarda en ninguna tabla ni sale en logs ni respuesta", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  g.paginas[inicial("inbox")] = {
    value: [
      msg("in-info", { toRecipients: [dir("Info@Guimaes.es")] }),
      msg("in-cc", { toRecipients: [dir("otra@ejemplo.invalid")], ccRecipients: [dir(ALIAS)] }),
      msg("in-admin", { subject: SECRETO_ASUNTO, from: dir("banco@ejemplo.invalid"), toRecipients: [dir("administracion@guimaes.es")], hasAttachments: true, body: { contentType: "html", content: `<p>${SECRETO_ASUNTO}</p><img src="cid:x">` } }),
    ],
    "@odata.deltaLink": `${U}/mailFolders/inbox/messages/delta?$deltatoken=i1`,
  };
  g.paginas[inicial("sentitems")] = {
    value: [
      msg("out-info", { from: dir(ALIAS), toRecipients: [dir("cliente@ejemplo.invalid")] }),
      msg("out-admin", { subject: SECRETO_ASUNTO, from: dir("administracion@guimaes.es"), toRecipients: [dir("gestoria@ejemplo.invalid")] }),
    ],
    "@odata.deltaLink": `${U}/mailFolders/sentitems/messages/delta?$deltatoken=s1`,
  };
  g.adjuntos["in-admin"] = [{ id: "adj-secreto", name: SECRETO_ASUNTO + ".pdf", contentType: "application/pdf", size: 1, isInline: false }];
  const r = await llamar(deps(g, db), { accion: "sincronizar" });
  const texto = await r.text();
  assert.equal(r.status, 200);
  assert.deepEqual([...db.mensajes.keys()].sort(), ["in-cc", "in-info", "out-info"]);
  assert.equal(db.adjuntos.length, 0);
  assert.ok(!g.llamadas.some((c) => c.url.includes("in-admin")), "ni siquiera se piden sus adjuntos");
  assert.equal(db.sync.inbox.descartados, 1);
  assert.equal(db.sync.sentitems.descartados, 1);
  const todo = texto + JSON.stringify(db.sync) + logs.join("\n") + JSON.stringify([...db.mensajes.values()]);
  assert.ok(!todo.includes(SECRETO_ASUNTO), "el asunto descartado no aparece en ningún sitio");
  assert.ok(!todo.includes("banco@") && !todo.includes("gestoria@"), "ni sus direcciones");
  const body = JSON.parse(texto);
  assert.deepEqual(body.carpetas.map((c: any) => [c.carpeta, c.guardados, c.descartados, c.completa]), [["inbox", 2, 1, true], ["sentitems", 1, 1, true]]);
});

test("sincronizar: importación inicial de 90 días con $select (to, cc, from) y Prefer de páginas y HTML", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  g.paginas[inicial("inbox")] = { value: [], "@odata.deltaLink": `${U}/d/i` };
  g.paginas[inicial("sentitems")] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  await jsonDe(deps(g, db), { accion: "sincronizar" });
  const c = g.llamadas[0];
  assert.equal(c.url, inicial("inbox"));
  assert.match(c.url, /\$filter=receivedDateTime%20ge%202026-08-14T12%3A00%3A00Z/);
  for (const campo of ["toRecipients", "ccRecipients", "from"]) assert.ok(c.url.includes(campo));
  assert.equal(c.headers["Prefer"], 'odata.maxpagesize=50, outlook.body-content-type="html"');
  assert.equal(db.sync.inbox.importacion_desde, "2026-08-14T12:00:00Z");
  assert.equal(db.sync.inbox.delta_link, `${U}/d/i`);
  assert.equal(db.sync.inbox.next_link, null);
});

test("sincronizar: corta antes del tiempo, guarda nextLink y reanuda; deltaLink solo al final", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const p2 = `${U}/mailFolders/inbox/messages/delta?$skiptoken=p2`;
  g.paginas[inicial("inbox")] = { value: [msg("m1")], "@odata.nextLink": p2 };
  g.paginas[p2] = { value: [msg("m2")], "@odata.deltaLink": `${U}/d/i2` };
  g.paginas[inicial("sentitems")] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  // La primera página "tarda" todo el presupuesto.
  const base = reloj.getTime();
  const g1 = g.fetch;
  g.fetch = (async (i: any, init?: any) => {
    const r = await g1(i, init);
    if (String(i) === inicial("inbox")) reloj = new Date(base + PRESUPUESTO_MS + 1);
    return r;
  }) as typeof fetch;
  const r1 = await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.equal(r1.body.carpetas[0].completa, false);
  assert.equal(db.sync.inbox.next_link, p2);
  assert.equal(db.sync.inbox.delta_link, null, "sin deltaLink a medias");
  assert.equal(db.sync.sentitems.next_link, null, "sentitems ni empezó: no había tiempo");
  assert.deepEqual([...db.mensajes.keys()], ["m1"]);
  assert.equal(db.reservadas.size, 0, "reservas liberadas");

  reloj = new Date(base + 200_000);
  const r2 = await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.ok(g.llamadas.some((c) => c.url === p2), "reanuda desde el nextLink");
  assert.equal(r2.body.carpetas[0].completa, true);
  assert.equal(db.sync.inbox.next_link, null);
  assert.equal(db.sync.inbox.delta_link, `${U}/d/i2`);
  assert.deepEqual([...db.mensajes.keys()].sort(), ["m1", "m2"]);
});

test("sincronizar: @removed marca filas existentes, ignora las que no existen y reaparecer desmarca", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  db.sync.inbox.delta_link = `${U}/d/1`; db.sync.sentitems.delta_link = `${U}/d/s`;
  await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox", leido: false, fuera_bandeja: false, contact_id: "c1" }]);
  g.paginas[`${U}/d/1`] = { value: [{ id: "m1", "@removed": { reason: "deleted" } }, { id: "de-admin", "@removed": { reason: "deleted" } }], "@odata.deltaLink": `${U}/d/2` };
  g.paginas[`${U}/d/s`] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.equal(db.mensajes.get("m1")!.fuera_bandeja, true);
  assert.equal(db.mensajes.get("m1")!.fuera_bandeja_at, reloj.toISOString());
  assert.equal(db.mensajes.get("m1")!.contact_id, "c1", "la fila sigue, con su vínculo");
  assert.equal(db.mensajes.has("de-admin"), false);
  g.paginas[`${U}/d/2`] = { value: [msg("m1")], "@odata.deltaLink": `${U}/d/3` };
  await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.equal(db.mensajes.get("m1")!.fuera_bandeja, false);
  assert.equal(db.mensajes.get("m1")!.fuera_bandeja_at, null);
});

test("sincronizar: adjuntos solo metadatos; inline con cid: aunque hasAttachments sea false", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  db.sync.inbox.delta_link = `${U}/d/1`; db.sync.sentitems.delta_link = `${U}/d/s`;
  g.paginas[`${U}/d/1`] = {
    value: [
      msg("con-pdf", { hasAttachments: true }),
      msg("con-cid", { hasAttachments: false, body: { contentType: "html", content: '<p>logo</p><img src="cid:image001.png@01DB">' } }),
      msg("sin-nada"),
    ],
    "@odata.deltaLink": `${U}/d/2`,
  };
  g.paginas[`${U}/d/s`] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  g.adjuntos["con-pdf"] = [{ id: "a1", name: "factura.pdf", contentType: "application/pdf", size: 1234, isInline: false }];
  g.adjuntos["con-cid"] = [{ id: "a2", name: "image001.png", contentType: "image/png", size: 99, isInline: true, contentId: "<image001.png@01DB>" }];
  await jsonDe(deps(g, db), { accion: "sincronizar" });
  const pedidas = g.llamadas.filter((c) => c.url.includes("/attachments"));
  assert.equal(pedidas.length, 2);
  for (const c of pedidas) assert.match(c.url, /\?\$select=id,name,contentType,size,isInline/, "nunca contentBytes");
  assert.deepEqual(db.adjuntos.map((a) => [a.nombre, a.inline, a.content_id, a.tamano]), [["factura.pdf", false, null, 1234], ["image001.png", true, "image001.png@01DB", 99]]);
  assert.match(String(db.mensajes.get("con-cid")!.cuerpo_html), /data-cid="image001.png@01DB"/);
});

test("sincronizar: deltaLink caducado (410) → reinicia la importación", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  db.sync.inbox.delta_link = `${U}/d/viejo`; db.sync.sentitems.delta_link = `${U}/d/s`;
  g.paginas[`${U}/d/s`] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  g.falla = (c) => (c.url === `${U}/d/viejo` ? resp(410, { error: { code: "SyncStateNotFound", message: "x" } }) : null);
  const r = await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.equal(r.body.carpetas[0].error, "Microsoft Graph 410 SyncStateNotFound");
  assert.equal(db.sync.inbox.delta_link, null);
  assert.equal(db.sync.inbox.next_link, null);
  assert.equal(db.sync.sentitems.delta_link, `${U}/d/s`, "la otra carpeta sigue");
});

test("sincronizar: un enlace que no es de Graph no recibe el token", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  db.sync.inbox.next_link = "https://malo.invalid/robar"; db.sync.sentitems.delta_link = `${U}/d/s`;
  g.paginas[`${U}/d/s`] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  const r = await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.equal(r.body.carpetas[0].error, "Enlace de Graph inesperado");
  assert.ok(!g.llamadas.some((c) => c.url.includes("malo.invalid")));
});

test("sincronizar: si otra ejecución tiene la carpeta reservada, no hace nada", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  db.reservadas.add("inbox"); db.reservadas.add("sentitems");
  const r = await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.deepEqual(r.body.carpetas.map((c: any) => c.reservada), [false, false]);
  assert.equal(g.llamadas.length, 0);
});

// ---------------------------------------------------------------- enviar / responder
test("enviar: sendMail con from = info@, guardando en enviados y el texto escapado", async () => {
  const g = fakeGraph();
  const r = await jsonDe(deps(g, new FakeDb()), { accion: "enviar", para: ["cliente@ejemplo.invalid"], cc: [], asunto: "Hola", texto: "Línea <b>1</b>\nLínea 2" }, { authorization: "Bearer jwt-activo" });
  assert.deepEqual(r, { status: 200, body: { ok: true } });
  const c = g.llamadas[0];
  assert.equal(c.method, "POST"); assert.equal(c.url, `${U}/sendMail`);
  assert.equal(c.body.saveToSentItems, true);
  assert.deepEqual(c.body.message.from, { emailAddress: { address: ALIAS } });
  assert.deepEqual(c.body.message.toRecipients, [{ emailAddress: { address: "cliente@ejemplo.invalid" } }]);
  assert.equal(c.body.message.body.content, "<p>Línea &lt;b&gt;1&lt;/b&gt;<br>Línea 2</p>");
});

test("enviar: valida destinatarios, asunto y texto", async () => {
  const g = fakeGraph(); const d = deps(g, new FakeDb());
  assert.equal((await jsonDe(d, { accion: "enviar", para: [], asunto: "a", texto: "b" })).status, 400);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["no-es-email"], asunto: "a", texto: "b" })).status, 400);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["a@b.es"], asunto: "", texto: "b" })).status, 400);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["a@b.es"], asunto: "a", texto: "  " })).status, 400);
  assert.equal(g.llamadas.length, 0);
});

test("responder: createReply → PATCH from info@ y texto delante de la cita → send", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }]);
  const r = await jsonDe(deps(g, db), { accion: "responder", mensaje_id: ids.m1, texto: "Gracias" }, { authorization: "Bearer jwt-activo" });
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(g.llamadas.map((c) => [c.method, c.url.slice(U.length)]), [
    ["POST", "/messages/m1/createReply"], ["PATCH", "/messages/borrador1"], ["POST", "/messages/borrador1/send"],
  ]);
  assert.deepEqual(g.llamadas[1].body.from, { emailAddress: { address: ALIAS } });
  assert.equal(g.llamadas[1].body.body.content, "<html><body><p>Gracias</p><div>cita</div></body></html>");
  assert.ok(!g.llamadas.some((c) => c.url.endsWith("/reply")), "nunca /reply directo");
});

test("responder a todos: quita info@ y administracion@ de los destinatarios", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  g.borrador = { id: "b2", body: { content: "<body></body>" }, toRecipients: [dir("cliente@ejemplo.invalid"), dir("INFO@guimaes.es")], ccRecipients: [dir("administracion@guimaes.es"), dir("otro@ejemplo.invalid")] };
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }]);
  await jsonDe(deps(g, db), { accion: "responder", mensaje_id: ids.m1, texto: "x", todos: true });
  assert.match(g.llamadas[0].url, /createReplyAll$/);
  assert.deepEqual(g.llamadas[1].body.toRecipients, [dir("cliente@ejemplo.invalid")]);
  assert.deepEqual(g.llamadas[1].body.ccRecipients, [dir("otro@ejemplo.invalid")]);
});

test("responder: si falla el envío borra el borrador; mensajes ajenos o enviados no", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }, { graph_id: "s1", carpeta: "sentitems" }]);
  g.falla = (c) => (c.url.endsWith("/send") ? resp(403, { error: { code: "ErrorSendAsDenied", message: "x" } }) : null);
  const r = await jsonDe(deps(g, db), { accion: "responder", mensaje_id: ids.m1, texto: "x" });
  assert.equal(r.status, 403); assert.equal(r.body.codigo, "ErrorSendAsDenied");
  assert.equal(g.llamadas.at(-1)!.method, "DELETE");
  assert.equal((await jsonDe(deps(g, db), { accion: "responder", mensaje_id: ids.s1, texto: "x" })).status, 400);
  assert.equal((await jsonDe(deps(g, db), { accion: "responder", mensaje_id: "11111111-1111-1111-1111-111111111111", texto: "x" })).status, 404);
});

// ---------------------------------------------------------------- leído y adjuntos
test("marcar_leido: PATCH isRead en Outlook y en la tabla", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox", leido: false }]);
  const r = await jsonDe(deps(g, db), { accion: "marcar_leido", mensaje_id: ids.m1, leido: true });
  assert.deepEqual(r.body, { ok: true, leido: true });
  assert.deepEqual([g.llamadas[0].method, g.llamadas[0].url, g.llamadas[0].body], ["PATCH", `${U}/messages/m1`, { isRead: true }]);
  assert.equal(db.mensajes.get("m1")!.leido, true);
});

test("adjunto: por id y por cid (contentId o nombre); desconocido → 404", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }]);
  await db.guardarAdjuntos([
    { mensaje_id: ids.m1, graph_id: "a1", nombre: "factura.pdf", tipo: "application/pdf", inline: false, content_id: null },
    { mensaje_id: ids.m1, graph_id: "a2", nombre: "image001.png", tipo: "image/png", inline: true, content_id: "image001.png@01DB" },
    { mensaje_id: ids.m1, graph_id: "a3", nombre: "logo.jpg", tipo: "image/jpeg", inline: true, content_id: null },
  ]);
  const d = deps(g, db);
  const r1 = await llamar(d, { accion: "adjunto", adjunto_id: db.adjuntos[0].id });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("content-type"), "application/pdf");
  assert.match(r1.headers.get("content-disposition")!, /filename\*=UTF-8''factura\.pdf/);
  assert.deepEqual([...new Uint8Array(await r1.arrayBuffer())], [1, 2, 3]);
  assert.equal(g.llamadas.at(-1)!.url, `${U}/messages/m1/attachments/a1/$value`);
  const r2 = await llamar(d, { accion: "adjunto", mensaje_id: ids.m1, cid: "image001.png@01DB" });
  assert.equal(r2.headers.get("content-type"), "image/png");
  await llamar(d, { accion: "adjunto", mensaje_id: ids.m1, cid: "logo.jpg@xyz" });
  assert.equal(g.llamadas.at(-1)!.url, `${U}/messages/m1/attachments/a3/$value`);
  assert.equal((await llamar(d, { accion: "adjunto", mensaje_id: ids.m1, cid: "nada@x" })).status, 404);
  assert.equal((await llamar(d, { accion: "adjunto", adjunto_id: "11111111-1111-1111-1111-111111111111" })).status, 404);
});

// ---------------------------------------------------------------- quién
test("autorización: cron solo sincroniza; usuario inactivo 403; sin credenciales 401", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  assert.equal((await jsonDe(d, { accion: "comprobar" }, { "x-hook-secret": CRON })).status, 403);
  assert.equal((await jsonDe(d, { accion: "enviar" }, { "x-hook-secret": CRON })).status, 403);
  assert.equal((await jsonDe(d, { accion: "sincronizar" }, { "x-hook-secret": "otro" })).status, 401);
  assert.equal((await jsonDe(d, { accion: "comprobar" }, { authorization: "Bearer jwt-inactivo" })).status, 403);
  assert.equal((await jsonDe(d, { accion: "comprobar" }, { authorization: "Bearer basura" })).status, 401);
  assert.equal((await jsonDe(d, { accion: "comprobar" }, {})).status, 401);
  assert.equal((await jsonDe(d, { accion: "borrar_todo" })).status, 400);
  db.sync.inbox.delta_link = `${U}/d/i`; db.sync.sentitems.delta_link = `${U}/d/s`;
  g.paginas[`${U}/d/i`] = { value: [], "@odata.deltaLink": `${U}/d/i` };
  g.paginas[`${U}/d/s`] = { value: [], "@odata.deltaLink": `${U}/d/s` };
  assert.equal((await jsonDe(d, { accion: "sincronizar" }, { "x-hook-secret": CRON })).status, 200);
});

// ---------------------------------------------------------------- saneado
test("sanear: fuera scripts, eventos, javascript: (también codificado) y etiquetas peligrosas", () => {
  const h = sanearHtml(`<html><head><title>t</title><script>alert(1)</script></head><body>
    <p onclick="x()" style="color:red">Hola <b>mundo</b></p>
    <a href="javascript:alert(1)">a</a><a href="jav&#x61;script:alert(1)">b</a><a href=" JAVA\nSCRIPT:x">c</a>
    <a href="https://ejemplo.invalid/?a=1&amp;b=2">d</a><a href="mailto:x@y.es">e</a>
    <svg><script>alert(2)</script></svg><iframe src="https://x"></iframe><form><input></form>
    <img src="x" onerror="alert(3)"><div style="width:expression(alert(4))">z</div>
    <!-- comentario --><style>@import url(https://x); .a{color:red}</style>
    <p>1 < 2 &amp; 3 > 2</p><unknown>texto</unknown><table><tr><td>celda</table>
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="ok"><img src="data:text/html,<script>x</script>">
    </body></html>`);
  for (const malo of ["<script", "alert(1)", "alert(2)", "alert(3)", "onclick", "onerror", "javascript", "JAVA", "<svg", "<iframe", "<form", "<input", "expression(", "@import", "comentario", "<title", "<html", "<body", "data:text"]) {
    assert.ok(!h.includes(malo), "no debe contener " + malo + "\n" + h);
  }
  assert.match(h, /<p style="color:red">Hola <b>mundo<\/b><\/p>/);
  assert.match(h, /<a href="https:\/\/ejemplo.invalid\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">d<\/a>/);
  assert.match(h, /<a href="mailto:x@y.es" target="_blank" rel="noopener noreferrer">e<\/a>/);
  assert.match(h, /<p>1 &lt; 2 &amp; 3 &gt; 2<\/p>/);
  assert.match(h, /texto/);
  assert.match(h, /<table><tr><td>celda<\/td><\/tr><\/table>/);
  assert.match(h, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="ok">/);
  assert.match(h, /<style> \.a\{color:red\}<\/style>/);
});

test("sanear: imágenes externas a data-src-externa y cid: a data-cid", () => {
  const h = sanearHtml(`<img src="https://pixel.invalid/t.gif" width="1"><img src="CID:image001.png@01DB">`);
  assert.equal(h, '<img data-src-externa="https://pixel.invalid/t.gif" width="1"><img data-cid="image001.png@01DB">');
  assert.ok(!/\ssrc=/.test(h));
});

test("sanear: </style> dentro de un style no escapa", () => {
  const h = sanearHtml(`<style>a{}</style><script>alert(1)</script>`);
  assert.ok(!h.includes("<script"));
  const h2 = sanearHtml(`<style>a{background:url("</style><img src=x onerror=alert(1)>")}</style>`);
  assert.ok(!h2.includes("onerror"));
});

test("textoAHtml, conCita y buscarCid", () => {
  assert.equal(textoAHtml("a\n\nb <c>"), "<p>a</p>\n<p>b &lt;c&gt;</p>");
  assert.equal(conCita("<html><body class='x'>cita</body></html>", "<p>n</p>"), "<html><body class='x'><p>n</p>cita</body></html>");
  assert.equal(conCita("cita", "<p>n</p>"), "<p>n</p>cita");
  const a = (nombre: string, content_id: string | null) => ({ id: nombre, graph_id: nombre, mensaje_graph_id: "m", nombre, tipo: null, content_id, inline: true });
  assert.equal(buscarCid([a("x.png", "<ABC>"), a("y.png", null)], "abc")?.id, undefined);
  assert.equal(buscarCid([a("x.png", "ABC"), a("y.png", null)], "<abc>")?.id, "x.png");
  assert.equal(buscarCid([a("x.png", "ABC"), a("y.png", null)], "y.png@1")?.id, "y.png");
});
