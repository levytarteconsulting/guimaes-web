// Pruebas de la función correo con Microsoft Graph y la base de datos simulados.
// Ejecutar desde crm/ (sin red):
//   node --experimental-strip-types --test supabase-functions/correo/
// (con Deno: deno test supabase-functions/correo/)
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  ALIAS, buscarCid, infoEnCabeceras, conCita, createHandler, DIAS_IMPORTACION, esDeInfo, GRAPH, limpiarBorradores, MAX_DIRECTO, nombreFichero,
  olvidarToken, PRESUPUESTO_MS, TROZO, urlSubidaValida,
} from "./correo.ts";
import type { AdjuntoDb, Carpeta, Db, Deps, Estado, Fila } from "./correo.ts";
import { sanearHtml, textoAHtml } from "./sanear.ts";

const BUZON = "091c33e7-0000-0000-0000-000000000000";
const CRON = "secreto-cron";
const U = `${GRAPH}/users/${BUZON}`;
const SECRETO_ASUNTO = "ASUNTO-PRIVADO-DE-ADMINISTRACION";

const env: Record<string, string> = {
  MS_GRAPH_TENANT_ID: "tenant", MS_GRAPH_CLIENT_ID: "cliente", MS_GRAPH_CLIENT_SECRET: "secreto",
  MS_GRAPH_MAILBOX: BUZON, CORREO_CRON_SECRET: CRON,
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
  async adminActivo(uid: string) { return this.activos.has(uid) ? "admin-" + uid : null; }
  async registrarEnviado(f: Fila) { await this.guardarMensajes([f]); }
  async reasignarEnviado(imid: string, gid: string) {
    if (this.mensajes.has(gid)) return;
    for (const [g, m] of this.mensajes) {
      if (m.internet_message_id === imid && m.carpeta === "sentitems" && m.enviado_por && g !== gid) {
        this.mensajes.delete(g); this.mensajes.set(gid, { ...m, graph_id: gid });
      }
    }
  }
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
  async existentes(gs: string[]) { return gs.filter((g) => this.mensajes.has(g)); }
  async leidoSiExiste(g: string, leido: boolean) { const m = this.mensajes.get(g); if (m) m.leido = leido; }
  async guardarAdjuntos(filas: Fila[]) {
    for (const f of filas) {
      const i = this.adjuntos.findIndex((a) => a.mensaje_id === f.mensaje_id && a.graph_id === f.graph_id);
      const fila = { ...f, id: i >= 0 ? this.adjuntos[i].id : `a0000000-0000-0000-0000-${String(++this.n).padStart(12, "0")}` };
      if (i >= 0) this.adjuntos[i] = fila; else this.adjuntos.push(fila);
    }
  }
  porId(id: string) { return [...this.mensajes.values()].find((m) => m.id === id); }
  async mensaje(id: string) { const m = this.porId(id); return m ? { id: m.id, graph_id: String(m.graph_id), carpeta: m.carpeta as Carpeta, empresa_id: (m.empresa_id as string) ?? null } : null; }
  aAdj(a: Fila & { id: string }): AdjuntoDb {
    const m = this.porId(String(a.mensaje_id))!;
    return { id: a.id, graph_id: String(a.graph_id), mensaje_graph_id: String(m.graph_id), nombre: String(a.nombre), tipo: (a.tipo as string) ?? null, content_id: (a.content_id as string) ?? null, inline: !!a.inline };
  }
  async adjunto(id: string) { const a = this.adjuntos.find((x) => x.id === id); return a ? this.aAdj(a) : null; }
  async adjuntosDe(mid: string) { return this.adjuntos.filter((a) => a.mensaje_id === mid).map((a) => this.aAdj(a)); }
  async marcarLeido(id: string, leido: boolean) { const m = this.porId(id); if (m) m.leido = leido; }
  borradores = new Map<string, any>();
  documentos = new Map<string, any>();
  ficheros = new Map<string, Uint8Array>();
  async crearBorrador(b: any) { this.borradores.set(b.graph_id, { ...b, sesiones: [], created_at: reloj.toISOString() }); }
  async borrador(g: string) { const b = this.borradores.get(g); return b ? JSON.parse(JSON.stringify(b)) : null; }
  async guardarSesiones(g: string, s: any[]) { const b = this.borradores.get(g); if (b) b.sesiones = s; }
  async borrarBorrador(g: string) { this.borradores.delete(g); }
  async borradoresViejos(antes: string, limite: number) {
    return [...this.borradores.values()].filter((b) => b.created_at < antes).slice(0, limite).map((b) => b.graph_id);
  }
  async documento(id: string) { return this.documentos.get(id) ?? null; }
  async descargarDocumento(p: string) { const f = this.ficheros.get(p); if (!f) throw new Error("no está"); return f; }
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
  borradores: Record<string, any>;
  sesiones: Record<string, { draft: string; name: string; size: number; recibido: number }>;
  subidas: { url: string; headers: Record<string, string>; largo: number }[];
  borrados: string[];
  uploadUrl?: (draft: string, n: number) => string;
  cabeceras: Record<string, { name: string; value: string }[]>; // graph_id → internetMessageHeaders
  completos: Record<string, any>;                                // graph_id → mensaje con SELECT
};
const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function fakeGraph(): Graph {
  const g: Graph = { llamadas: [], tokens: 0, paginas: {}, adjuntos: {}, borradores: {}, sesiones: {}, subidas: [], borrados: [], cabeceras: {}, completos: {}, fetch: null as any };
  let n = 0;
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
    if (url.startsWith("https://outlook.office.com/upload/")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      assert.equal(headers["Authorization"], undefined, "la URL de subida no lleva el token");
      const largo = (init?.body as Uint8Array).length;
      g.subidas.push({ url, headers, largo });
      const s = g.sesiones[url];
      const [, a, b, total] = headers["Content-Range"].match(/^bytes (\d+)-(\d+)\/(\d+)$/)!;
      assert.equal(Number(a), s.recibido); assert.equal(Number(b) - Number(a) + 1, largo); assert.equal(Number(total), s.size);
      s.recibido += largo;
      if (s.recibido < s.size) return resp(200, { nextExpectedRanges: [`${s.recibido}-`] });
      (g.adjuntos[s.draft] ??= []).push({ id: "att" + (++n), name: s.name, size: s.size, isInline: false });
      return new Response(null, { status: 201 });
    }
    assert.ok(url.startsWith(U + "/"), "siempre /users/{id del buzón}: " + url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.match(headers["Authorization"], /^Bearer tok\d+$/);
    assert.ok(headers["Prefer"]?.startsWith('IdType="ImmutableId"'), "ids inmutables en todas las llamadas: " + url);
    const c: Llamada = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    g.llamadas.push(c);
    const f = g.falla?.(c); if (f) return f;
    const ruta = url.slice(U.length);
    if (method === "GET" && ruta === "/messages?$top=1&$select=id") return resp(200, { value: [{ id: "x" }] });
    if (method === "GET" && g.paginas[url]) return resp(200, g.paginas[url]);
    const adj = ruta.match(/^\/messages\/([^/]+)\/attachments\?\$select=/);
    if (method === "GET" && adj) return resp(200, { value: g.adjuntos[decodeURIComponent(adj[1])] ?? [] });
    const sub = ruta.match(/^\/messages\/([^/]+)\/attachments\/createUploadSession$/);
    if (method === "POST" && sub) {
      const draft = decodeURIComponent(sub[1]);
      const url = g.uploadUrl ? g.uploadUrl(draft, ++n) : `https://outlook.office.com/upload/${draft}/${++n}`;
      g.sesiones[url] = { draft, name: c.body.AttachmentItem.name, size: c.body.AttachmentItem.size, recibido: 0 };
      return resp(201, { uploadUrl: url });
    }
    const pa = ruta.match(/^\/messages\/([^/]+)\/attachments$/);
    if (method === "POST" && pa) {
      const draft = decodeURIComponent(pa[1]);
      const size = Buffer.from(c.body.contentBytes, "base64").length;
      (g.adjuntos[draft] ??= []).push({ id: "att" + (++n), name: c.body.name, size, isInline: false, contentType: c.body.contentType, contentBytes: c.body.contentBytes });
      return resp(201, { id: "att" + n });
    }
    if (method === "POST" && /\/createForward$/.test(ruta)) {
      const origen = decodeURIComponent(ruta.split("/")[2]);
      g.borradores["fw1"] = { id: "fw1", conversationId: "conv-" + origen, internetMessageId: "<fw1@x>", subject: "RV: hola", body: { contentType: "html", content: "<html><body><div>original reenviado</div></body></html>" }, toRecipients: [], ccRecipients: [], isDraft: true };
      g.adjuntos["fw1"] = (g.adjuntos[origen] ?? []).map((a) => ({ ...a }));
      return resp(201, g.borradores["fw1"]);
    }
    const ch = ruta.match(/^\/messages\/([^/?]+)\?\$select=internetMessageHeaders$/);
    if (method === "GET" && ch) {
      const h = g.cabeceras[decodeURIComponent(ch[1])];
      return h ? resp(200, { id: decodeURIComponent(ch[1]), internetMessageHeaders: h }) : resp(404, { error: { code: "ErrorItemNotFound" } });
    }
    const cm = ruta.match(/^\/messages\/([^/?]+)\?\$select=id,/);
    if (method === "GET" && cm) {
      const m = g.completos[decodeURIComponent(cm[1])];
      return m ? resp(200, m) : resp(404, { error: { code: "ErrorItemNotFound" } });
    }
    const gb = ruta.match(/^\/messages\/([^/?]+)\?\$select=body$/);
    if (method === "GET" && gb) return resp(200, { body: g.borradores[decodeURIComponent(gb[1])]?.body ?? { content: "" } });
    const val = ruta.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/);
    if (method === "GET" && val) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (method === "POST" && ruta === "/sendMail") throw new Error("sendMail no se usa: todo va por borrador");
    if (method === "POST" && ruta === "/messages") {
      g.borradores["nuevo1"] = { ...c.body, id: "nuevo1", conversationId: "conv-nuevo1", internetMessageId: "<nuevo1@x>", isDraft: true };
      return resp(201, g.borradores["nuevo1"]);
    }
    if (method === "POST" && /\/createReply(All)?$/.test(ruta)) {
      const b = g.borrador ?? { id: "borrador1", conversationId: "conv-m1", internetMessageId: "<b1@x>", subject: "RE: hola", body: { contentType: "html", content: "<html><body><div>cita</div></body></html>" }, toRecipients: [dir("cliente@ejemplo.invalid", "Cliente")], ccRecipients: [] };
      g.borradores[b.id] = { ...b, isDraft: true };
      return resp(201, g.borradores[b.id]);
    }
    const pm = ruta.match(/^\/messages\/([^/]+)$/);
    if (method === "PATCH" && pm) {
      const id = decodeURIComponent(pm[1]);
      if (g.borradores[id]) { Object.assign(g.borradores[id], c.body); return resp(200, g.borradores[id]); }
      return resp(200, { id, ...c.body });
    }
    if (method === "POST" && /^\/messages\/[^/]+\/send$/.test(ruta)) return new Response(null, { status: 202 });
    if (method === "DELETE") {
      const id = decodeURIComponent(ruta.split("/")[2]);
      g.borrados.push(id); delete g.borradores[id];
      return new Response(null, { status: 204 });
    }
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
async function llamar(d: Deps, body: unknown, auth: Record<string, string> = { authorization: "Bearer jwt-activo" }) {
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
  assert.deepEqual(g.llamadas.filter((c) => c.url.includes("in-admin")).map((c) => c.url), [`${U}/messages/in-admin?$select=internetMessageHeaders`],
    "de lo descartado solo se piden las cabeceras (respaldo), ni adjuntos ni cuerpo");
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
  assert.equal(c.headers["Prefer"], 'IdType="ImmutableId", odata.maxpagesize=50, outlook.body-content-type="html"');
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
test("enviar: borrador (POST /messages) → PATCH from info@ → send; registra la fila con enviado_por", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const r = await jsonDe(deps(g, db), { accion: "enviar", para: ["cliente@ejemplo.invalid"], cc: [], asunto: "Hola", texto: "Línea <b>1</b>\nLínea 2" });
  assert.deepEqual(r, { status: 200, body: { ok: true, graph_id: "nuevo1" } });
  assert.deepEqual(g.llamadas.map((c) => [c.method, c.url.slice(U.length)]), [
    ["POST", "/messages"], ["PATCH", "/messages/nuevo1"], ["POST", "/messages/nuevo1/send"],
  ]);
  const c = g.llamadas[0];
  assert.equal(c.body.from, undefined, "el from va en el PATCH");
  assert.deepEqual(c.body.toRecipients, [{ emailAddress: { address: "cliente@ejemplo.invalid" } }]);
  assert.equal(c.body.body.content, "<p>Línea &lt;b&gt;1&lt;/b&gt;<br>Línea 2</p>");
  assert.deepEqual(g.llamadas[1].body, { from: { emailAddress: { address: ALIAS } } });
  const f = db.mensajes.get("nuevo1")!;
  assert.equal(f.enviado_por, "admin-u-activo");
  assert.equal(f.carpeta, "sentitems");
  assert.equal(f.remitente_email, ALIAS);
  assert.equal(f.conversation_id, "conv-nuevo1");
  assert.equal(f.internet_message_id, "<nuevo1@x>");
  assert.equal(f.asunto, "Hola");
  assert.equal(f.leido, true);
  assert.equal(f.fecha, reloj.toISOString());
});

test("enviar y luego sincronizar: la misma fila (id inmutable), sin duplicar y conservando enviado_por", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  await jsonDe(deps(g, db), { accion: "enviar", para: ["cliente@ejemplo.invalid"], asunto: "Hola", texto: "x" });
  db.sync.inbox.delta_link = `${U}/d/i`; db.sync.sentitems.delta_link = `${U}/d/s`;
  g.paginas[`${U}/d/i`] = { value: [], "@odata.deltaLink": `${U}/d/i` };
  g.paginas[`${U}/d/s`] = { value: [msg("nuevo1", { internetMessageId: "<nuevo1@x>", from: dir(ALIAS), toRecipients: [dir("cliente@ejemplo.invalid")], subject: "Hola", isRead: true, sentDateTime: "2026-11-12T12:00:01Z" })], "@odata.deltaLink": `${U}/d/s2` };
  await jsonDe(deps(g, db), { accion: "sincronizar" }, { "x-hook-secret": CRON });
  assert.equal(db.mensajes.size, 1);
  const f = db.mensajes.get("nuevo1")!;
  assert.equal(f.enviado_por, "admin-u-activo");
  assert.equal(f.fecha, "2026-11-12T12:00:01Z", "la sincronización completa los datos de Graph");
});

test("red de seguridad: si el enviado llega con otro id, la fila registrada lo toma (misma internet_message_id)", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  await jsonDe(deps(g, db), { accion: "enviar", para: ["cliente@ejemplo.invalid"], asunto: "Hola", texto: "x" });
  db.sync.inbox.delta_link = `${U}/d/i`; db.sync.sentitems.delta_link = `${U}/d/s`;
  g.paginas[`${U}/d/i`] = { value: [], "@odata.deltaLink": `${U}/d/i` };
  g.paginas[`${U}/d/s`] = { value: [msg("otro-id", { internetMessageId: "<nuevo1@x>", from: dir(ALIAS) })], "@odata.deltaLink": `${U}/d/s2` };
  await jsonDe(deps(g, db), { accion: "sincronizar" }, { "x-hook-secret": CRON });
  assert.deepEqual([...db.mensajes.keys()], ["otro-id"]);
  assert.equal(db.mensajes.get("otro-id")!.enviado_por, "admin-u-activo");
});

test("enviar: valida destinatarios, asunto y texto", async () => {
  const g = fakeGraph(); const d = deps(g, new FakeDb());
  assert.equal((await jsonDe(d, { accion: "enviar", para: [], asunto: "a", texto: "b" })).status, 400);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["no-es-email"], asunto: "a", texto: "b" })).status, 400);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["a@b.es"], asunto: "", texto: "b" })).status, 400);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["a@b.es"], asunto: "a", texto: "  " })).status, 400);
  assert.equal(g.llamadas.length, 0);
});

test("responder: createReply → PATCH from info@ y texto delante de la cita → send; registra la fila", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }]);
  const r = await jsonDe(deps(g, db), { accion: "responder", mensaje_id: ids.m1, texto: "Gracias" });
  assert.deepEqual(r.body, { ok: true, graph_id: "borrador1" });
  assert.deepEqual(g.llamadas.map((c) => [c.method, c.url.slice(U.length)]), [
    ["POST", "/messages/m1/createReply"], ["PATCH", "/messages/borrador1"], ["POST", "/messages/borrador1/send"],
  ]);
  assert.deepEqual(g.llamadas[1].body.from, { emailAddress: { address: ALIAS } });
  assert.equal(g.llamadas[1].body.body.content, "<html><body><p>Gracias</p><div>cita</div></body></html>");
  assert.ok(!g.llamadas.some((c) => /\/reply(All)?$/.test(c.url)), "nunca /reply directo");
  const f = db.mensajes.get("borrador1")!;
  assert.equal(f.enviado_por, "admin-u-activo");
  assert.equal(f.conversation_id, "conv-m1");
  assert.equal(f.asunto, "RE: hola");
  assert.deepEqual(f.para, [{ email: "cliente@ejemplo.invalid", nombre: "Cliente" }]);
  assert.match(String(f.cuerpo_html), /<p>Gracias<\/p><div>cita<\/div>/);
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

test("responder: si falla el envío borra el borrador y no registra nada; mensajes ajenos o enviados no", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }, { graph_id: "s1", carpeta: "sentitems" }]);
  g.falla = (c) => (c.url.endsWith("/send") ? resp(403, { error: { code: "ErrorSendAsDenied", message: "x" } }) : null);
  const r = await jsonDe(deps(g, db), { accion: "responder", mensaje_id: ids.m1, texto: "x" });
  assert.equal(r.status, 403); assert.equal(r.body.codigo, "ErrorSendAsDenied");
  assert.equal(g.llamadas.at(-1)!.method, "DELETE");
  assert.equal(db.mensajes.has("borrador1"), false);
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
test("autorización: cron solo sincroniza y comprueba; usuario inactivo 403; sin credenciales 401", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  assert.deepEqual(await jsonDe(d, { accion: "comprobar" }, { "x-hook-secret": CRON }), { status: 200, body: { ok: true } });
  assert.equal((await jsonDe(d, { accion: "marcar_leido" }, { "x-hook-secret": CRON })).status, 403);
  assert.equal((await jsonDe(d, { accion: "enviar" }, { "x-hook-secret": CRON })).status, 403);
  assert.equal((await jsonDe(d, { accion: "sincronizar" }, { "x-hook-secret": "otro" })).status, 401);
  assert.equal((await jsonDe(d, { accion: "comprobar" }, { authorization: "Bearer jwt-inactivo" })).status, 403);
  assert.equal((await jsonDe(d, { accion: "comprobar" }, { authorization: "Bearer basura" })).status, 401);
  assert.equal((await jsonDe(d, { accion: "enviar", para: ["a@b.es"], asunto: "a", texto: "b" }, { "x-hook-secret": CRON })).status, 403, "el cron no envía");
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

// ---------------------------------------------------------------- redactor (borradores)
const EMPRESA = "eeeeeeee-0000-0000-0000-000000000001";
const OTRA = "eeeeeeee-0000-0000-0000-000000000002";
async function binario(d: Deps, params: Record<string, string>, bytes: Uint8Array, auth: Record<string, string> = { authorization: "Bearer jwt-activo" }) {
  const res = await createHandler(d)(new Request("https://f/correo?" + new URLSearchParams(params), {
    method: "POST", headers: { "content-type": "application/octet-stream", ...auth }, body: bytes,
  }));
  return { status: res.status, body: await res.json() };
}
const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);
async function nuevoBorrador(d: Deps, extra: Record<string, unknown> = {}) {
  const r = await jsonDe(d, { accion: "borrador_crear", tipo: "nuevo", ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.borrador as string;
}

test("borrador_crear: nuevo, respuesta y reenvío quedan registrados con su usuario; no se responde a un enviado", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox", empresa_id: EMPRESA }, { graph_id: "s1", carpeta: "sentitems" }]);
  g.adjuntos["m1"] = [{ id: "o1", name: "factura.pdf", size: 1000, isInline: false }, { id: "o2", name: "logo.png", size: 50, isInline: true }];

  const n = await jsonDe(d, { accion: "borrador_crear", tipo: "nuevo", empresa_id: OTRA });
  assert.equal(n.body.borrador, "nuevo1");
  assert.deepEqual(db.borradores.get("nuevo1"), { graph_id: "nuevo1", creado_por: "admin-u-activo", tipo: "nuevo", origen_id: null, empresa_id: OTRA, sesiones: [], created_at: reloj.toISOString() });

  const r = await jsonDe(d, { accion: "borrador_crear", tipo: "respuesta", mensaje_id: ids.m1 });
  assert.equal(r.body.borrador, "borrador1");
  assert.deepEqual(r.body.para, [{ email: "cliente@ejemplo.invalid", nombre: "Cliente" }]);
  assert.equal(r.body.empresa_id, EMPRESA, "la empresa sale del mensaje original");
  assert.equal(db.borradores.get("borrador1").origen_id, ids.m1);

  const f = await jsonDe(d, { accion: "borrador_crear", tipo: "reenvio", mensaje_id: ids.m1 });
  assert.equal(f.body.borrador, "fw1");
  assert.deepEqual(f.body.para, []);
  assert.deepEqual(f.body.adjuntos_originales, [{ nombre: "factura.pdf", tamano: 1000 }], "conserva los adjuntos del original");
  assert.ok(g.llamadas.some((c) => c.method === "POST" && c.url === `${U}/messages/m1/createForward`));

  assert.equal((await jsonDe(d, { accion: "borrador_crear", tipo: "respuesta", mensaje_id: ids.s1 })).status, 400);
  assert.equal((await jsonDe(d, { accion: "borrador_crear", tipo: "otro" })).status, 400);
  assert.equal(db.borradores.size, 3);
});

test("borrador_adjuntar: binario ≤ 3 MB como fileAttachment en base64; más de 3 MB o en JSON se rechaza", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const b = await nuevoBorrador(d);
  const r = await binario(d, { accion: "borrador_adjuntar", borrador: b, nombre: "presu/puesto.pdf", tipo: "application/pdf" }, bytes(1000));
  assert.deepEqual(r, { status: 200, body: { ok: true, nombre: "presupuesto.pdf", tamano: 1000 } });
  const post = g.llamadas.find((c) => c.method === "POST" && c.url === `${U}/messages/${b}/attachments`)!;
  assert.equal(post.body["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(post.body.contentType, "application/pdf");
  assert.deepEqual(Buffer.from(post.body.contentBytes, "base64"), Buffer.from(bytes(1000)));

  const antes = g.llamadas.length;
  assert.equal((await binario(d, { accion: "borrador_adjuntar", borrador: b, nombre: "x" }, bytes(MAX_DIRECTO + 1))).status, 413);
  assert.equal((await jsonDe(d, { accion: "borrador_adjuntar", borrador: b })).status, 400);
  assert.equal((await binario(d, { accion: "borrador_enviar", borrador: b }, bytes(1))).status, 400, "binario solo para adjuntar y trozos");
  assert.equal(g.llamadas.length, antes, "sin llamar a Graph");
});

test("sesión de subida: trozos en orden de TROZO bytes, PUT sin token y con Content-Range", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const b = await nuevoBorrador(d);
  const total = 2 * TROZO + 1234;
  const s = await jsonDe(d, { accion: "borrador_sesion", borrador: b, nombre: "planos.zip", tipo: "application/zip", tamano: total });
  assert.equal(s.status, 200); assert.equal(s.body.trozo, TROZO);
  assert.equal(TROZO % 327_680, 0, "múltiplo de 320 KiB");
  assert.ok(TROZO <= MAX_DIRECTO);
  const cus = g.llamadas.find((c) => c.url.endsWith("/attachments/createUploadSession"))!;
  assert.deepEqual(cus.body, { AttachmentItem: { attachmentType: "file", name: "planos.zip", size: total, contentType: "application/zip" } });
  assert.equal(JSON.stringify(s.body).includes("outlook.office.com"), false, "la URL de subida no sale al navegador");

  const trozo = (desde: number, n: number) => binario(d, { accion: "borrador_trozo", borrador: b, sesion: s.body.sesion, desde: String(desde) }, bytes(n));
  assert.equal((await trozo(TROZO, TROZO)).status, 409, "fuera de orden");
  assert.equal((await trozo(0, 100)).status, 400, "tamaño de trozo incorrecto");
  assert.deepEqual((await trozo(0, TROZO)).body, { siguiente: TROZO, completo: false });
  assert.deepEqual((await trozo(TROZO, TROZO)).body, { siguiente: 2 * TROZO, completo: false });
  assert.deepEqual((await trozo(2 * TROZO, 1234)).body, { siguiente: total, completo: true });
  assert.deepEqual(g.subidas.map((x) => [x.headers["Content-Range"], x.largo]), [
    [`bytes 0-${TROZO - 1}/${total}`, TROZO], [`bytes ${TROZO}-${2 * TROZO - 1}/${total}`, TROZO], [`bytes ${2 * TROZO}-${total - 1}/${total}`, 1234],
  ]);
  assert.deepEqual(db.borradores.get(b).sesiones, [], "sesión cerrada");
  assert.deepEqual(g.adjuntos[b].map((a) => [a.name, a.size]), [["planos.zip", total]]);
});

test("sesión de subida: una URL de subida que no es de Office → 502 sin guardarla", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  g.uploadUrl = () => "https://malo.invalid/upload";
  const b = await nuevoBorrador(d);
  const r = await jsonDe(d, { accion: "borrador_sesion", borrador: b, nombre: "x", tamano: 5_000_000 });
  assert.equal(r.status, 502);
  assert.deepEqual(db.borradores.get(b).sesiones, []);
  assert.equal(urlSubidaValida("https://outlook.office.com/api/v2.0/x"), true);
  assert.equal(urlSubidaValida("https://attachments.office365.com/x"), true);
  assert.equal(urlSubidaValida("http://outlook.office.com/x"), false);
  assert.equal(urlSubidaValida("https://outlook.office.com.malo.invalid/x"), false);
  assert.equal(urlSubidaValida("https://notoffice.com/x"), false);
});

test("límite de 25 MB por correo, contando lo ya adjunto (también los originales de un reenvío)", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const b = await nuevoBorrador(d);
  g.adjuntos[b] = [{ id: "x", name: "grande", size: 24 * 1048576, isInline: false }];
  const r = await binario(d, { accion: "borrador_adjuntar", borrador: b, nombre: "y" }, bytes(1048577));
  assert.equal(r.status, 413);
  assert.match(r.body.error, /25 MB por correo \(25,0 MB\)/);
  assert.equal((await jsonDe(d, { accion: "borrador_sesion", borrador: b, nombre: "z", tamano: 2 * 1048576 })).status, 413);
  assert.equal((await jsonDe(d, { accion: "borrador_sesion", borrador: b, nombre: "z", tamano: 26 * 1048576 })).status, 413);
  assert.equal(g.adjuntos[b].length, 1);
  assert.equal(g.llamadas.filter((c) => c.url.endsWith("/createUploadSession")).length, 0);
});

test("borradores ajenos: de otro usuario o que no están en la tabla → 404 sin tocar Graph", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const b = await nuevoBorrador(d);
  db.borradores.get(b).creado_por = "admin-otro";
  g.borradores["deOutlook"] = { id: "deOutlook", isDraft: true };
  const antes = g.llamadas.length;
  for (const id of [b, "deOutlook"]) {
    assert.equal((await binario(d, { accion: "borrador_adjuntar", borrador: id, nombre: "x" }, bytes(10))).status, 404);
    assert.equal((await jsonDe(d, { accion: "borrador_sesion", borrador: id, nombre: "x", tamano: 10 })).status, 404);
    assert.equal((await jsonDe(d, { accion: "borrador_enviar", borrador: id, para: ["a@ejemplo.invalid"], asunto: "x", html: "<p>x</p>" })).status, 404);
    assert.equal((await jsonDe(d, { accion: "borrador_descartar", borrador: id })).status, 404);
  }
  assert.equal(g.llamadas.length, antes);
  assert.ok(g.borradores["deOutlook"], "el borrador de Outlook sigue ahí");
  assert.equal((await jsonDe(d, { accion: "borrador_crear", tipo: "nuevo" }, { "x-hook-secret": CRON })).status, 403, "el cron no redacta");
});

test("borrador_documento: solo de la empresa del borrador y guardado; ≤ 3 MB directo, más por trozos", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const doc = (id: string, o: Record<string, unknown>) => db.documentos.set(id, { id, empresa_id: EMPRESA, status: "stored", nombre: "doc.pdf", tipo: "application/pdf", storage_path: "p/" + id, ...o });
  const D1 = "dddddddd-0000-0000-0000-000000000001", D2 = "dddddddd-0000-0000-0000-000000000002";
  const D3 = "dddddddd-0000-0000-0000-000000000003", D4 = "dddddddd-0000-0000-0000-000000000004";
  doc(D1, { nombre: "pequeño.pdf", tamano: 500 }); db.ficheros.set("p/" + D1, bytes(500));
  doc(D2, { nombre: "grande.pdf", tamano: MAX_DIRECTO + 10 }); db.ficheros.set("p/" + D2, bytes(MAX_DIRECTO + 10));
  doc(D3, { empresa_id: OTRA }); db.ficheros.set("p/" + D3, bytes(5));
  doc(D4, { status: "pending" }); db.ficheros.set("p/" + D4, bytes(5));

  const sin = await nuevoBorrador(d);
  assert.equal((await jsonDe(d, { accion: "borrador_documento", borrador: sin, documento_id: D1 })).status, 400, "sin empresa");
  await jsonDe(d, { accion: "borrador_descartar", borrador: sin });

  const b = await nuevoBorrador(d, { empresa_id: EMPRESA });
  assert.equal((await jsonDe(d, { accion: "borrador_documento", borrador: b, documento_id: D3 })).status, 404, "de otra empresa");
  assert.equal((await jsonDe(d, { accion: "borrador_documento", borrador: b, documento_id: D4 })).status, 404, "no guardado");
  assert.deepEqual((await jsonDe(d, { accion: "borrador_documento", borrador: b, documento_id: D1 })).body, { ok: true, nombre: "pequeño.pdf", tamano: 500 });
  assert.equal(g.subidas.length, 0);
  assert.deepEqual((await jsonDe(d, { accion: "borrador_documento", borrador: b, documento_id: D2 })).body, { ok: true, nombre: "grande.pdf", tamano: MAX_DIRECTO + 10 });
  assert.deepEqual(g.subidas.map((x) => x.largo), [TROZO, MAX_DIRECTO + 10 - TROZO]);
  assert.deepEqual(g.adjuntos[b].map((a) => [a.name, a.size]), [["pequeño.pdf", 500], ["grande.pdf", MAX_DIRECTO + 10]]);
  assert.deepEqual(db.borradores.get(b).sesiones, []);
});

test("borrador_enviar: HTML saneado encima de la cita, from info@, fila con enviado_por y borrador fuera de la tabla", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const ids = await db.guardarMensajes([{ graph_id: "m1", carpeta: "inbox" }]);
  const b = (await jsonDe(d, { accion: "borrador_crear", tipo: "respuesta", mensaje_id: ids.m1 })).body.borrador;
  const r = await jsonDe(d, {
    accion: "borrador_enviar", borrador: b, para: ["cliente@ejemplo.invalid"], cc: ["otro@ejemplo.invalid"], cco: ["oculto@ejemplo.invalid"],
    asunto: "RE: hola", html: '<p onclick="x()">Hola <b>ya</b><script>alert(1)</script></p><ul><li>uno</li></ul>',
  });
  assert.deepEqual(r, { status: 200, body: { ok: true, graph_id: "borrador1" } });
  const patch = g.llamadas.find((c) => c.method === "PATCH" && c.url === `${U}/messages/borrador1`)!;
  assert.deepEqual(patch.body.from, { emailAddress: { address: ALIAS } });
  assert.equal(patch.body.body.contentType, "HTML");
  assert.equal(patch.body.body.content, "<html><body><p>Hola <b>ya</b></p><ul><li>uno</li></ul><div>cita</div></body></html>");
  assert.deepEqual(patch.body.bccRecipients, [{ emailAddress: { address: "oculto@ejemplo.invalid" } }]);
  assert.equal(g.llamadas.at(-1)!.url, `${U}/messages/borrador1/send`);
  assert.equal(db.mensajes.get("borrador1")!.enviado_por, "admin-u-activo");
  assert.equal(db.borradores.has("borrador1"), false);
});

test("borrador_enviar: valida; con trozos pendientes 409; si falla el envío borra el borrador y no registra", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const b = await nuevoBorrador(d);
  const ok = { accion: "borrador_enviar", borrador: b, para: ["a@ejemplo.invalid"], asunto: "Hola", html: "<p>x</p>" };
  assert.equal((await jsonDe(d, { ...ok, para: [] })).status, 400);
  assert.equal((await jsonDe(d, { ...ok, asunto: " " })).status, 400);
  assert.equal((await jsonDe(d, { ...ok, html: "<p> </p>" })).status, 400);
  await jsonDe(d, { accion: "borrador_sesion", borrador: b, nombre: "x", tamano: 5_000_000 });
  assert.equal((await jsonDe(d, ok)).status, 409);
  db.borradores.get(b).sesiones = [];
  g.falla = (c) => (c.url.endsWith("/send") ? resp(403, { error: { code: "ErrorSendAsDenied", message: "x" } }) : null);
  const r = await jsonDe(d, ok);
  assert.equal(r.status, 403);
  assert.ok(g.borrados.includes(b), "borrador borrado en Outlook");
  assert.equal(db.borradores.has(b), false);
  assert.equal(db.mensajes.has(b), false);
});

test("borrador_enviar: un reenvío puede ir sin texto y conserva los adjuntos originales", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const ids = await db.guardarMensajes([{ graph_id: "s1", carpeta: "sentitems" }]);
  g.adjuntos["s1"] = [{ id: "o1", name: "factura.pdf", size: 1000, isInline: false }];
  const b = (await jsonDe(d, { accion: "borrador_crear", tipo: "reenvio", mensaje_id: ids.s1 })).body.borrador;
  const r = await jsonDe(d, { accion: "borrador_enviar", borrador: b, para: ["nuevo@ejemplo.invalid"], html: "" });
  assert.equal(r.status, 200);
  const patch = g.llamadas.find((c) => c.method === "PATCH" && c.url === `${U}/messages/fw1`)!;
  assert.equal(patch.body.subject, undefined, "conserva el asunto RV:");
  assert.match(patch.body.body.content, /original reenviado/);
  assert.equal(g.llamadas.some((c) => c.method === "DELETE" && /attachments/.test(c.url)), false);
  assert.equal(g.adjuntos["fw1"].length, 1);
});

test("borrador_descartar: lo borra en Outlook (aunque ya no esté) y de la tabla", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const b = await nuevoBorrador(d);
  assert.deepEqual((await jsonDe(d, { accion: "borrador_descartar", borrador: b })).body, { ok: true });
  assert.deepEqual(g.borrados, [b]);
  assert.equal(db.borradores.size, 0);
  const b2 = await nuevoBorrador(d);
  g.falla = (c) => (c.method === "DELETE" ? resp(404, { error: { code: "ErrorItemNotFound" } }) : null);
  assert.equal((await jsonDe(d, { accion: "borrador_descartar", borrador: b2 })).status, 200);
  assert.equal(db.borradores.size, 0);
});

test("limpieza: solo borra los borradores del CRM de más de 2 h; nunca uno ajeno de Outlook aunque sea viejo", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  reloj = new Date("2026-11-12T08:00:00Z");
  const viejo = await nuevoBorrador(d);           // nuevo1, del CRM, 4 h
  // Borrador que una persona tiene en Outlook desde hace días: no está en correo_borradores.
  g.borradores["ajeno-viejo"] = { id: "ajeno-viejo", isDraft: true, createdDateTime: "2026-11-01T08:00:00Z" };
  reloj = new Date("2026-11-12T11:30:00Z");
  db.borradores.set("reciente", { graph_id: "reciente", creado_por: "admin-u-activo", tipo: "nuevo", sesiones: [], created_at: reloj.toISOString() });
  reloj = new Date("2026-11-12T12:00:00Z");
  assert.equal(await limpiarBorradores(d, db), 1);
  assert.deepEqual(g.borrados, [viejo]);
  assert.ok(g.borradores["ajeno-viejo"], "el borrador ajeno sigue en Outlook");
  assert.ok(!g.llamadas.some((c) => c.url.includes("ajeno-viejo")), "ni se consulta");
  assert.deepEqual([...db.borradores.keys()], ["reciente"]);
  assert.ok(!g.llamadas.some((c) => c.method === "GET" && /\/messages\?|mailFolders\/drafts/.test(c.url)), "no lista borradores del buzón");
});

test("nombreFichero: sin rutas ni caracteres de control", () => {
  assert.equal(nombreFichero("../../etc/passwd"), "....etcpasswd");
  assert.equal(nombreFichero("a\u0000b\nc.pdf"), "abc.pdf");
  assert.equal(nombreFichero(""), "adjunto");
  assert.equal(nombreFichero("x".repeat(300)).length, 200);
});

test("diagnostico: carpetas con su madre y recuento por carpeta y mes; sin ids, asuntos ni remitentes", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const d = deps(g, db);
  const sel = "$select=id,displayName,parentFolderId,totalItemCount,childFolderCount&$top=100&includeHiddenFolders=true";
  g.paginas[`${U}/mailFolders?${sel}`] = { value: [
    { id: "f-in", displayName: "Bandeja de entrada", parentFolderId: "raiz", totalItemCount: 40, childFolderCount: 1 },
    { id: "f-arch", displayName: "Archivo", parentFolderId: "raiz", totalItemCount: 7, childFolderCount: 0 },
  ], "@odata.nextLink": `${U}/mailFolders?pag2` };
  g.paginas[`${U}/mailFolders?pag2`] = { value: [{ id: "f-env", displayName: "Elementos enviados", parentFolderId: "raiz", totalItemCount: 3, childFolderCount: 0 }] };
  g.paginas[`${U}/mailFolders/f-in/childFolders?${sel}`] = { value: [{ id: "f-sub", displayName: "Clientes", parentFolderId: "f-in", totalItemCount: 5, childFolderCount: 0 }] };
  const busq = `${U}/messages?$search=${encodeURIComponent('"to:info@guimaes.es OR cc:info@guimaes.es"')}&$select=id,parentFolderId,receivedDateTime&$top=250`;
  g.paginas[busq] = { value: [
    { id: "m1", parentFolderId: "f-in", receivedDateTime: "2026-10-03T10:00:00Z", subject: SECRETO_ASUNTO },
    { id: "m2", parentFolderId: "f-sub", receivedDateTime: "2025-01-03T10:00:00Z" },
  ], "@odata.nextLink": `${U}/messages?skip=2` };
  g.paginas[`${U}/messages?skip=2`] = { value: [{ id: "m3", parentFolderId: "f-in", receivedDateTime: "2026-10-20T10:00:00Z" }] };
  const r = await jsonDe(d, { accion: "diagnostico" }, { "x-hook-secret": CRON });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    carpetas: [
      { nombre: "Bandeja de entrada", madre: "(raíz)", total: 40 }, { nombre: "Archivo", madre: "(raíz)", total: 7 },
      { nombre: "Elementos enviados", madre: "(raíz)", total: 3 }, { nombre: "Clientes", madre: "Bandeja de entrada", total: 5 },
    ],
    busqueda: { total: 3, paginas: 2, cortado: false },
    recuentos: [{ carpeta: "Bandeja de entrada", mes: "2026-10", n: 2 }, { carpeta: "Clientes", mes: "2025-01", n: 1 }],
  });
  assert.ok(!JSON.stringify(r.body).includes(SECRETO_ASUNTO));
  assert.ok(!/m1|f-in/.test(JSON.stringify(r.body)), "sin ids");
  assert.equal(db.mensajes.size, 0); assert.equal(logs.length, 0);
  assert.ok(g.llamadas.every((c) => c.method === "GET"));
});

// ---------------------------------------------------------------- cabeceras originales (destinatario reescrito)
const H = (to: string, cc = "") => [
  { name: "Received", value: "from x by y for <info@guimaes.es>" },
  { name: "From", value: "Cliente <cliente@ejemplo.invalid>" },
  { name: "To", value: to }, ...(cc ? [{ name: "Cc", value: cc }] : []),
  { name: "Subject", value: SECRETO_ASUNTO },
];

test("infoEnCabeceras: solo To/Cc originales con la dirección exacta", () => {
  assert.equal(infoEnCabeceras(H('"Guimaes" <INFO@guimaes.es>')), true);
  assert.equal(infoEnCabeceras(H("otra@ejemplo.invalid", "a@b.es, info@guimaes.es")), true);
  assert.equal(infoEnCabeceras(H("info@guimaes.es")), true);
  assert.equal(infoEnCabeceras(H("administracion@guimaes.es")), false, "Received con info@ no cuenta");
  assert.equal(infoEnCabeceras(H("noinfo@guimaes.es")), false);
  assert.equal(infoEnCabeceras(H("info@guimaes.es.otro.invalid")), false);
  assert.equal(infoEnCabeceras(undefined), false);
});

test("sincronizar: To reescrito a administracion@ con cabecera To original info@ → entra; solo administracion@ → se descarta", async () => {
  const g = fakeGraph(); const db = new FakeDb();
  g.paginas[inicial("inbox")] = {
    value: [
      msg("in-directo", { toRecipients: [dir(ALIAS)] }),
      msg("in-reescrito", { toRecipients: [dir("administracion@guimaes.es")] }),
      msg("in-admin", { subject: SECRETO_ASUNTO, toRecipients: [dir("administracion@guimaes.es")] }),
    ],
    "@odata.deltaLink": `${U}/mailFolders/inbox/messages/delta?$deltatoken=i1`,
  };
  g.paginas[inicial("sentitems")] = { value: [], "@odata.deltaLink": `${U}/mailFolders/sentitems/messages/delta?$deltatoken=s1` };
  g.cabeceras["in-reescrito"] = H("Guimaes <info@guimaes.es>");
  g.cabeceras["in-admin"] = H("administracion@guimaes.es");
  const r = await jsonDe(deps(g, db), { accion: "sincronizar" });
  assert.equal(r.status, 200);
  assert.deepEqual([...db.mensajes.keys()].sort(), ["in-directo", "in-reescrito"]);
  assert.equal(db.sync.inbox.descartados, 1);
  const pedidas = g.llamadas.filter((c) => c.url.endsWith("?$select=internetMessageHeaders")).map((c) => c.url.slice(U.length));
  assert.deepEqual(pedidas, ["/messages/in-reescrito?$select=internetMessageHeaders", "/messages/in-admin?$select=internetMessageHeaders"],
    "cabeceras solo de lo que el filtro descarta");
  const todo = JSON.stringify(r.body) + JSON.stringify(db.sync) + logs.join("\n") + JSON.stringify([...db.mensajes.values()]);
  assert.ok(!todo.includes(SECRETO_ASUNTO));
});

function historico(g: Graph, db: FakeDb) {
  const desde = "2026-08-14T12:00:00Z";
  db.sync.inbox.importacion_desde = desde;
  const p1 = `${U}/mailFolders/inbox/messages?$select=id,receivedDateTime,isDraft&$filter=${encodeURIComponent("receivedDateTime ge " + desde)}&$top=25`;
  const p2 = `${U}/mailFolders/inbox/messages?$skiptoken=2`;
  g.paginas[p1] = { value: [
    { id: "h-ya", receivedDateTime: "2026-11-12T10:00:00Z" },
    { id: "h-info-oct", receivedDateTime: "2026-10-02T10:00:00Z" },
    { id: "h-admin", receivedDateTime: "2026-10-03T10:00:00Z" },
  ], "@odata.nextLink": p2 };
  g.paginas[p2] = { value: [
    { id: "h-info-sep", receivedDateTime: "2026-09-05T10:00:00Z" },
    { id: "h-borrador", receivedDateTime: "2026-09-06T10:00:00Z", isDraft: true },
  ] };
  g.cabeceras["h-info-oct"] = H("administracion@guimaes.es", "Info <info@guimaes.es>");
  g.cabeceras["h-admin"] = H("administracion@guimaes.es");
  g.cabeceras["h-info-sep"] = H("info@guimaes.es");
  g.completos["h-info-oct"] = msg("h-info-oct", { toRecipients: [dir("administracion@guimaes.es")], receivedDateTime: "2026-10-02T10:00:00Z", hasAttachments: true });
  g.completos["h-info-sep"] = msg("h-info-sep", { toRecipients: [dir("administracion@guimaes.es")], receivedDateTime: "2026-09-05T10:00:00Z" });
  g.adjuntos["h-info-oct"] = [{ id: "a1", name: "f.pdf", contentType: "application/pdf", size: 10, isInline: false }];
  return { p1, p2 };
}

test("importar_historico: simular solo cuenta por mes, sin guardar nada ni pedir cuerpos", async () => {
  const g = fakeGraph(); const db = new FakeDb(); historico(g, db);
  await db.guardarMensajes([{ graph_id: "h-ya", carpeta: "inbox" }]);
  const r = await jsonDe(deps(g, db), { accion: "importar_historico", simular: true }, { "x-hook-secret": CRON });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { simular: true, revisados: 5, ya_estaban: 1, pasan: 2, descartados: 2, importados: 0, adjuntos: 0, por_mes: { "2026-10": 1, "2026-09": 1 }, cursor: null });
  assert.equal(db.mensajes.size, 1);
  assert.ok(!g.llamadas.some((c) => /\$select=id,internetMessageId|attachments/.test(c.url)), "sin cuerpos ni adjuntos");
  assert.ok(!g.llamadas.some((c) => c.url.includes("h-ya?") || c.url.includes("h-borrador?")), "ni cabeceras de lo que ya está o es borrador");
  assert.ok(g.llamadas.every((c) => c.method === "GET"));
  assert.ok(!JSON.stringify(r.body).includes(SECRETO_ASUNTO));
  assert.equal(logs.length, 0);
  // Por defecto simula.
  assert.equal((await jsonDe(deps(g, db), { accion: "importar_historico" }, { "x-hook-secret": CRON })).body.simular, true);
});

test("importar_historico: importa como mensaje normal (con adjuntos) solo lo que pasa; descarta el resto sin guardar", async () => {
  const g = fakeGraph(); const db = new FakeDb(); historico(g, db);
  const r = await jsonDe(deps(g, db), { accion: "importar_historico", simular: false }, { "x-hook-secret": CRON });
  assert.equal(r.status, 200);
  assert.equal(r.body.importados, 2); assert.equal(r.body.adjuntos, 1); assert.equal(r.body.cursor, null);
  assert.deepEqual([...db.mensajes.keys()].sort(), ["h-info-oct", "h-info-sep"]);
  const f = db.mensajes.get("h-info-oct")!;
  assert.equal(f.carpeta, "inbox"); assert.equal(f.fecha, "2026-10-02T10:00:00Z"); assert.equal(f.asunto, "Asunto h-info-oct");
  assert.deepEqual(db.adjuntos.map((a) => a.graph_id), ["a1"]);
  assert.ok(!JSON.stringify([...db.mensajes.values()]).includes(SECRETO_ASUNTO));
  const full = g.llamadas.find((c) => c.url.includes("/messages/h-info-oct?$select=id,"))!;
  assert.match(full.headers["Prefer"], /outlook\.body-content-type="html"/);
  // Repetir no duplica ni vuelve a pedir cabeceras de lo importado.
  const antes = g.llamadas.length;
  const r2 = await jsonDe(deps(g, db), { accion: "importar_historico", simular: false }, { "x-hook-secret": CRON });
  assert.equal(r2.body.importados, 0); assert.equal(r2.body.ya_estaban, 2);
  assert.ok(!g.llamadas.slice(antes).some((c) => c.url.includes("h-info-oct?")));
});

test("importar_historico: corta por tiempo con un cursor y reanuda; cursor ajeno → 400; usuario inactivo no", async () => {
  const g = fakeGraph(); const db = new FakeDb(); const { p2 } = historico(g, db);
  let t = reloj.getTime();
  const orig = g.fetch;
  g.fetch = (async (u: any, i: any) => { if (String(u).includes("/mailFolders/inbox/messages?")) t += 80_000; return orig(u, i); }) as typeof fetch;
  const d = deps(g, db, { now: () => new Date(t) });
  const r = await jsonDe(d, { accion: "importar_historico", simular: false }, { "x-hook-secret": CRON });
  assert.equal(r.body.cursor, p2);
  assert.equal(r.body.importados, 1);
  const r2 = await jsonDe(d, { accion: "importar_historico", simular: false, cursor: r.body.cursor }, { "x-hook-secret": CRON });
  assert.equal(r2.body.cursor, null); assert.equal(r2.body.importados, 1);
  assert.equal(db.mensajes.size, 2);
  assert.equal((await jsonDe(d, { accion: "importar_historico", cursor: "https://graph.microsoft.com/v1.0/users/otro/messages?x" }, { "x-hook-secret": CRON })).status, 400);
  assert.equal((await jsonDe(d, { accion: "importar_historico" }, { authorization: "Bearer jwt-inactivo" })).status, 403);
});
