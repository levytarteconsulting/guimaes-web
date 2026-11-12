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
//   enviar        — {para[], cc[]?, cco[]?, asunto, texto}: POST /messages → PATCH from = info@ → send
//   responder     — {mensaje_id, texto, todos?}: createReply(All) → PATCH from → send
//   (los dos registran la fila con enviado_por; ver enviarBorrador)
//   marcar_leido  — {mensaje_id, leido}: PATCH isRead en Outlook y en la tabla
//   adjunto       — {adjunto_id} o {mensaje_id, cid}: descarga bajo demanda (no se guarda)
//   borrador_*    — redactor con adjuntos, por pasos (ver "borradores" más abajo):
//                   crear {tipo, mensaje_id?, empresa_id?} · adjuntar (binario ≤ 3 MB) ·
//                   sesion {borrador, nombre, tipo, tamano} + trozo (binario) ·
//                   documento {borrador, documento_id} · enviar {borrador, para, cc, cco, asunto, html} ·
//                   descartar {borrador}
//
// Quién puede llamar:
//   x-hook-secret = CORREO_CRON_SECRET (pg_cron)      → sincronizar, comprobar
//   Authorization: Bearer <JWT de usuario activo CRM> → todas (enviado_por = ese usuario)

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
export type MensajeDb = { id: string; graph_id: string; carpeta: Carpeta; empresa_id?: string | null };
export type Sesion = { id: string; url: string; nombre: string; tamano: number; siguiente: number };
export type BorradorDb = { graph_id: string; creado_por: string | null; tipo: string; origen_id: string | null; empresa_id: string | null; sesiones: Sesion[] };
export type DocumentoDb = { id: string; empresa_id: string | null; storage_path: string; nombre: string; tipo: string | null; tamano: number | null; status: string };
export type AdjuntoDb = { id: string; graph_id: string; mensaje_graph_id: string; nombre: string; tipo: string | null; content_id: string | null; inline: boolean };
export interface Db {
  adminActivo(authUserId: string): Promise<string | null>; // admins.id si está activo
  reservar(carpeta: Carpeta, segundos: number): Promise<boolean>;
  liberar(carpeta: Carpeta): Promise<void>;
  estado(carpeta: Carpeta): Promise<Estado>;
  guardarEstado(carpeta: Carpeta, cambios: Partial<Estado> & { ultimo_ok?: string; ultimo_error?: string | null }): Promise<void>;
  guardarMensajes(filas: Fila[]): Promise<Record<string, string>>; // graph_id → id
  registrarEnviado(fila: Fila): Promise<void>;                       // upsert por graph_id
  // Red de seguridad por si un enviado llegara con otro id: la fila
  // registrada al enviar (misma internet_message_id) toma el id nuevo.
  reasignarEnviado(internetMessageId: string, graphId: string): Promise<void>;
  marcarFuera(graphIds: string[], enIso: string): Promise<number>;  // solo filas existentes
  leidoSiExiste(graphId: string, leido: boolean): Promise<void>;
  guardarAdjuntos(filas: Fila[]): Promise<void>;
  mensaje(id: string): Promise<MensajeDb | null>;
  adjunto(id: string): Promise<AdjuntoDb | null>;
  adjuntosDe(mensajeId: string): Promise<AdjuntoDb[]>;
  marcarLeido(id: string, leido: boolean): Promise<void>;
  crearBorrador(b: Omit<BorradorDb, "sesiones">): Promise<void>;
  borrador(graphId: string): Promise<BorradorDb | null>;
  guardarSesiones(graphId: string, sesiones: Sesion[]): Promise<void>;
  borrarBorrador(graphId: string): Promise<void>;
  borradoresViejos(antesIso: string, limite: number): Promise<string[]>;
  documento(id: string): Promise<DocumentoDb | null>;
  descargarDocumento(storagePath: string): Promise<Uint8Array>;
}
export type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  db: () => Db;
  usuario: (jwt: string) => Promise<string | null>;
  now?: () => Date;
  log?: (...a: unknown[]) => void;
  uuid?: () => string;
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

// Ids inmutables en TODAS las llamadas: no cambian al mover un mensaje y el
// borrador conserva su id al enviarse (llega a Enviados con el mismo).
export const PREFER_ID = 'IdType="ImmutableId"';
type Opc = { method?: string; body?: unknown; prefer?: string; crudo?: boolean };
async function graph(deps: Deps, ruta: string, o: Opc = {}): Promise<any> {
  const url = ruta.startsWith("https://") ? ruta : GRAPH + ruta;
  // nextLink/deltaLink vienen de Graph; aun así, el token no sale de Graph.
  if (!url.startsWith(GRAPH + "/")) throw new Peticion(502, "Enlace de Graph inesperado");
  const headers: Record<string, string> = { "Authorization": `Bearer ${await token(deps)}` };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  headers["Prefer"] = o.prefer ? `${PREFER_ID}, ${o.prefer}` : PREFER_ID;
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
        if (carpeta === "sentitems") {
          for (const m of guardar) if (m.internetMessageId) await db.reasignarEnviado(m.internetMessageId, m.id);
        }
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
  let borradores_limpiados = 0;
  try { borradores_limpiados = await limpiarBorradores(deps, db); }
  catch (e) { deps.log?.("correo: limpieza", errorSeguro(e)); }
  return { carpetas, borradores_limpiados };
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

// Todo envío va por borrador: crear (POST /messages o createReply[All]) →
// PATCH from = info@ → send. Con ids inmutables, el id del borrador es el
// que tendrá en Enviados: se inserta la fila con ese graph_id y enviado_por,
// y la sincronización la completa sin duplicarla.
async function enviarBorrador(deps: Deps, db: Db, borrador: any, cambios: Record<string, unknown>, enviadoPor: string | null) {
  const b = buzon(deps);
  const id = String(borrador?.id ?? "");
  if (!id) throw new Peticion(502, "Graph no devolvió el borrador");
  const ruta = `${b}/messages/${encodeURIComponent(id)}`;
  let final: any;
  try {
    final = await graph(deps, ruta, { method: "PATCH", body: { ...cambios, from: FROM } });
    await graph(deps, `${ruta}/send`, { method: "POST" });
  } catch (e) {
    // No dejar el borrador a medias en el buzón.
    try { await graph(deps, ruta, { method: "DELETE" }); } catch { /* ya no está */ }
    throw e;
  }
  // Ya está enviado: si falla el registro, lo trae la sincronización (sin enviado_por).
  try {
    const m = { ...borrador, ...(final && typeof final === "object" ? final : {}), id, from: FROM };
    await db.registrarEnviado({
      ...filaDe(m, "sentitems"),
      fecha: (deps.now?.() ?? new Date()).toISOString(),
      leido: true,
      enviado_por: enviadoPor,
    });
  } catch (e) {
    (deps.log ?? console.error)("correo: enviado sin registrar", errorSeguro(e));
  }
  return { ok: true, graph_id: id };
}

export async function enviar(deps: Deps, db: Db, body: any, enviadoPor: string | null) {
  const asunto = String(body?.asunto ?? "").trim();
  if (!asunto) throw new Peticion(400, "Falta el asunto");
  if (asunto.length > 255) throw new Peticion(400, "El asunto es demasiado largo");
  const message = {
    subject: asunto,
    body: { contentType: "HTML", content: textoAHtml(texto(body?.texto)) },
    toRecipients: destinatarios(body?.para, "para", true),
    ccRecipients: destinatarios(body?.cc, "cc"),
    bccRecipients: destinatarios(body?.cco, "cco"),
  };
  const borrador = await graph(deps, `${buzon(deps)}/messages`, { method: "POST", body: message });
  return enviarBorrador(deps, db, borrador, {}, enviadoPor);
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

export async function responder(deps: Deps, db: Db, body: any, enviadoPor: string | null) {
  const m = await mensajeDe(db, body?.mensaje_id);
  if (m.carpeta !== "inbox") throw new Peticion(400, "Solo se puede responder a un mensaje recibido");
  const t = texto(body?.texto);
  const borrador = await graph(deps, `${buzon(deps)}/messages/${encodeURIComponent(m.graph_id)}/${body?.todos ? "createReplyAll" : "createReply"}`, { method: "POST", body: {} });
  const cambios: Record<string, unknown> = {
    body: { contentType: "HTML", content: conCita(String(borrador?.body?.content ?? ""), textoAHtml(t)) },
  };
  if (body?.todos) {
    cambios.toRecipients = noSoyYo(borrador?.toRecipients);
    cambios.ccRecipients = noSoyYo(borrador?.ccRecipients);
  }
  return enviarBorrador(deps, db, borrador, cambios, enviadoPor);
}

// ---------------------------------------------------------------- borradores (redactor con adjuntos)
// El redactor del CRM envía por pasos sobre un borrador que registra en
// correo_borradores: crear → adjuntar (≤ 3 MB directo; más, por sesión de
// subida en trozos) → enviar. Si falla algo, el CRM llama a descartar. Solo
// se actúa sobre borradores de esa tabla y del mismo usuario; la limpieza de
// los de más de 2 h (en sincronizar) también solo toca los de esa tabla.
export const MAX_DIRECTO = 3 * 1024 * 1024;
export const MAX_TOTAL = 25 * 1024 * 1024;
export const TROZO = 6 * 327_680; // 1,875 MiB: múltiplo de 320 KiB, como pide Graph
export const HORAS_BORRADOR = 2;
const MAX_LIMPIEZA = 20;
const MAX_HTML_REDACTOR = 500_000;
const CREAR: Record<string, string | null> = { nuevo: null, respuesta: "createReply", respuesta_todos: "createReplyAll", reenvio: "createForward" };

const mb = (n: number) => (n / 1048576).toFixed(1).replace(".", ",") + " MB";
const rutaMsg = (deps: Deps, id: string) => `${buzon(deps)}/messages/${encodeURIComponent(id)}`;

export function aBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function nombreFichero(x: unknown): string {
  const n = String(x ?? "").replace(/[\u0000-\u001f\u007f\/\\]/g, "").trim().slice(0, 200);
  return n || "adjunto";
}
const mime = (x: unknown) => (/^[\w.+-]+\/[\w.+-]+$/.test(String(x ?? "")) ? String(x) : "application/octet-stream");
export function urlSubidaValida(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)office(365)?\.com$/i.test(x.hostname);
  } catch { return false; }
}
function textoDe(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function miBorrador(db: Db, id: unknown, adminId: string | null): Promise<BorradorDb> {
  const s = String(id ?? "");
  if (!s || s.length > 512) throw new Peticion(400, "Falta el borrador");
  const b = await db.borrador(s);
  if (!b || b.creado_por !== adminId) throw new Peticion(404, "Borrador no encontrado");
  return b;
}

async function adjuntosDelBorrador(deps: Deps, id: string): Promise<any[]> {
  let pag = await graph(deps, `${rutaMsg(deps, id)}/attachments?$select=id,name,size,isInline`);
  const todos = [...(pag.value ?? [])];
  for (let i = 0; pag["@odata.nextLink"] && i < 10; i++) {
    pag = await graph(deps, pag["@odata.nextLink"]);
    todos.push(...(pag.value ?? []));
  }
  return todos;
}
async function comprobarTotal(deps: Deps, id: string, nuevo: number) {
  const ya = (await adjuntosDelBorrador(deps, id)).reduce((a, x) => a + (Number(x.size) || 0), 0);
  if (ya + nuevo > MAX_TOTAL) throw new Peticion(413, `Los adjuntos superan el límite de 25 MB por correo (${mb(ya + nuevo)})`);
}

export async function borradorCrear(deps: Deps, db: Db, body: any, adminId: string | null) {
  const tipo = String(body?.tipo ?? "");
  if (!(tipo in CREAR)) throw new Peticion(400, "Tipo de borrador no válido");
  let origen: MensajeDb | null = null;
  if (tipo !== "nuevo") {
    origen = await mensajeDe(db, body?.mensaje_id);
    if (tipo !== "reenvio" && origen.carpeta !== "inbox") throw new Peticion(400, "Solo se puede responder a un mensaje recibido");
  }
  const empresa = /^[0-9a-f-]{36}$/i.test(String(body?.empresa_id ?? "")) ? String(body.empresa_id) : (origen?.empresa_id ?? null);
  const b = buzon(deps);
  const borrador = tipo === "nuevo"
    ? await graph(deps, `${b}/messages`, { method: "POST", body: { subject: "", body: { contentType: "HTML", content: "" } } })
    : await graph(deps, `${b}/messages/${encodeURIComponent(origen!.graph_id)}/${CREAR[tipo]}`, { method: "POST", body: {} });
  const id = String(borrador?.id ?? "");
  if (!id) throw new Peticion(502, "Graph no devolvió el borrador");
  try {
    await db.crearBorrador({ graph_id: id, creado_por: adminId, tipo, origen_id: origen?.id ?? null, empresa_id: empresa });
  } catch (e) {
    try { await graph(deps, rutaMsg(deps, id), { method: "DELETE" }); } catch { /* ya no está */ }
    throw e;
  }
  const quien = (xs: any[] | undefined) => lista(noSoyYo(xs));
  const originales = tipo === "reenvio"
    ? (await adjuntosDelBorrador(deps, id)).filter((a) => !a.isInline).map((a) => ({ nombre: String(a.name ?? ""), tamano: Number(a.size) || 0 }))
    : [];
  return {
    borrador: id,
    asunto: String(borrador?.subject ?? ""),
    para: tipo === "reenvio" ? [] : quien(borrador?.toRecipients),
    cc: tipo === "reenvio" ? [] : quien(borrador?.ccRecipients),
    empresa_id: empresa,
    adjuntos_originales: originales,
  };
}

export async function borradorAdjuntar(deps: Deps, db: Db, q: URLSearchParams, bytes: Uint8Array, adminId: string | null) {
  const b = await miBorrador(db, q.get("borrador"), adminId);
  if (!bytes.length) throw new Peticion(400, "Fichero vacío");
  if (bytes.length > MAX_DIRECTO) throw new Peticion(413, "Más de 3 MB: usa la subida por trozos");
  await comprobarTotal(deps, b.graph_id, bytes.length);
  const nombre = nombreFichero(q.get("nombre"));
  await graph(deps, `${rutaMsg(deps, b.graph_id)}/attachments`, {
    method: "POST",
    body: { "@odata.type": "#microsoft.graph.fileAttachment", name: nombre, contentType: mime(q.get("tipo")), contentBytes: aBase64(bytes) },
  });
  return { ok: true, nombre, tamano: bytes.length };
}

async function abrirSesion(deps: Deps, db: Db, graphId: string, nombre: string, tipo: string, tamano: number): Promise<Sesion> {
  const r = await graph(deps, `${rutaMsg(deps, graphId)}/attachments/createUploadSession`, {
    method: "POST", body: { AttachmentItem: { attachmentType: "file", name: nombre, size: tamano, contentType: tipo } },
  });
  const url = String(r?.uploadUrl ?? "");
  if (!urlSubidaValida(url)) throw new Peticion(502, "Graph devolvió una URL de subida inesperada");
  const s: Sesion = { id: deps.uuid?.() ?? crypto.randomUUID(), url, nombre, tamano, siguiente: 0 };
  const actual = await db.borrador(graphId);
  await db.guardarSesiones(graphId, [...(actual?.sesiones ?? []), s]);
  return s;
}

async function subirTrozo(deps: Deps, db: Db, graphId: string, s: Sesion, desde: number, bytes: Uint8Array) {
  if (desde !== s.siguiente) throw new Peticion(409, "Trozo fuera de orden");
  const esperado = Math.min(TROZO, s.tamano - desde);
  if (esperado <= 0 || bytes.length !== esperado) throw new Peticion(400, "Tamaño de trozo no válido");
  const fin = desde + bytes.length - 1;
  // La URL de la sesión ya va autenticada: sin Authorization (Graph lo rechaza).
  const res = await deps.fetch(s.url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), "Content-Range": `bytes ${desde}-${fin}/${s.tamano}` },
    body: bytes,
  });
  let cuerpo: any = {};
  try { cuerpo = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) throw new GraphError(res.status, String(cuerpo?.error?.code ?? "subida"));
  const siguiente = fin + 1;
  const completo = siguiente >= s.tamano;
  const actual = await db.borrador(graphId);
  const otras = (actual?.sesiones ?? []).filter((x) => x.id !== s.id);
  await db.guardarSesiones(graphId, completo ? otras : [...otras, { ...s, siguiente }]);
  return { siguiente, completo };
}

export async function borradorSesion(deps: Deps, db: Db, body: any, adminId: string | null) {
  const b = await miBorrador(db, body?.borrador, adminId);
  const tamano = Number(body?.tamano);
  if (!Number.isInteger(tamano) || tamano <= 0) throw new Peticion(400, "Tamaño no válido");
  if (tamano > MAX_TOTAL) throw new Peticion(413, `El fichero supera el límite de 25 MB por correo (${mb(tamano)})`);
  await comprobarTotal(deps, b.graph_id, tamano);
  const s = await abrirSesion(deps, db, b.graph_id, nombreFichero(body?.nombre), mime(body?.tipo), tamano);
  return { sesion: s.id, trozo: TROZO };
}

export async function borradorTrozo(deps: Deps, db: Db, q: URLSearchParams, bytes: Uint8Array, adminId: string | null) {
  const b = await miBorrador(db, q.get("borrador"), adminId);
  const s = b.sesiones.find((x) => x.id === q.get("sesion"));
  if (!s) throw new Peticion(404, "Sesión de subida no encontrada");
  return subirTrozo(deps, db, b.graph_id, s, Number(q.get("desde")), bytes);
}

export async function borradorDocumento(deps: Deps, db: Db, body: any, adminId: string | null) {
  const b = await miBorrador(db, body?.borrador, adminId);
  if (!b.empresa_id) throw new Peticion(400, "Este correo no está vinculado a una empresa");
  const id = String(body?.documento_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Peticion(400, "Falta documento_id");
  const doc = await db.documento(id);
  if (!doc || doc.empresa_id !== b.empresa_id || doc.status !== "stored") throw new Peticion(404, "Documento no encontrado en la empresa");
  if ((doc.tamano ?? 0) > MAX_TOTAL) throw new Peticion(413, `El documento supera el límite de 25 MB por correo (${mb(doc.tamano!)})`);
  const bytes = await db.descargarDocumento(doc.storage_path);
  await comprobarTotal(deps, b.graph_id, bytes.length);
  const nombre = nombreFichero(doc.nombre);
  const tipo = mime(doc.tipo);
  if (bytes.length <= MAX_DIRECTO) {
    await graph(deps, `${rutaMsg(deps, b.graph_id)}/attachments`, {
      method: "POST", body: { "@odata.type": "#microsoft.graph.fileAttachment", name: nombre, contentType: tipo, contentBytes: aBase64(bytes) },
    });
  } else {
    let s = await abrirSesion(deps, db, b.graph_id, nombre, tipo, bytes.length);
    for (let desde = 0; desde < bytes.length; desde += TROZO) {
      const r = await subirTrozo(deps, db, b.graph_id, s, desde, bytes.subarray(desde, desde + TROZO));
      s = { ...s, siguiente: r.siguiente };
    }
  }
  return { ok: true, nombre, tamano: bytes.length };
}

export async function borradorEnviar(deps: Deps, db: Db, body: any, adminId: string | null) {
  const b = await miBorrador(db, body?.borrador, adminId);
  const para = destinatarios(body?.para, "para", true);
  const cc = destinatarios(body?.cc, "cc");
  const cco = destinatarios(body?.cco, "cco");
  const asunto = String(body?.asunto ?? "").trim();
  if (b.tipo === "nuevo" && !asunto) throw new Peticion(400, "Falta el asunto");
  if (asunto.length > 255) throw new Peticion(400, "El asunto es demasiado largo");
  const html = String(body?.html ?? "");
  if (html.length > MAX_HTML_REDACTOR) throw new Peticion(400, "El mensaje es demasiado largo");
  if (b.tipo !== "reenvio" && !textoDe(html)) throw new Peticion(400, "El mensaje está vacío");
  if (b.sesiones.length) throw new Peticion(409, "Hay adjuntos a medio subir");
  const limpio = sanearHtml(html);
  const ruta = rutaMsg(deps, b.graph_id);
  try {
    let contenido = limpio;
    if (b.tipo !== "nuevo") {
      // La cita del original (la prepara Graph como Outlook) va debajo de lo escrito.
      const actual = await graph(deps, `${ruta}?$select=body`);
      contenido = conCita(String(actual?.body?.content ?? ""), limpio);
    }
    await comprobarTotal(deps, b.graph_id, 0);
    const cambios: Record<string, unknown> = {
      body: { contentType: "HTML", content: contenido },
      toRecipients: para, ccRecipients: cc, bccRecipients: cco,
    };
    if (asunto) cambios.subject = asunto;
    const r = await enviarBorrador(deps, db, { id: b.graph_id }, cambios, adminId);
    await db.borrarBorrador(b.graph_id).catch(() => { /* lo quita la limpieza */ });
    return r;
  } catch (e) {
    // enviarBorrador ya borra el borrador en Outlook si falla el PATCH o el envío;
    // si el fallo es anterior (cita, límite), se borra aquí.
    try { await graph(deps, ruta, { method: "DELETE" }); } catch { /* ya no está */ }
    await db.borrarBorrador(b.graph_id).catch(() => {});
    throw e;
  }
}

export async function borradorDescartar(deps: Deps, db: Db, body: any, adminId: string | null) {
  const b = await miBorrador(db, body?.borrador, adminId);
  try { await graph(deps, rutaMsg(deps, b.graph_id), { method: "DELETE" }); }
  catch (e) { if (!(e instanceof GraphError && e.estado === 404)) throw e; }
  await db.borrarBorrador(b.graph_id);
  return { ok: true };
}

// Solo borradores registrados por el CRM: nunca los que alguien tenga en Outlook.
export async function limpiarBorradores(deps: Deps, db: Db): Promise<number> {
  const antes = new Date((deps.now?.() ?? new Date()).getTime() - HORAS_BORRADOR * 3_600_000).toISOString();
  const ids = await db.borradoresViejos(antes, MAX_LIMPIEZA);
  let n = 0;
  for (const id of ids) {
    try {
      try { await graph(deps, rutaMsg(deps, id), { method: "DELETE" }); }
      catch (e) { if (!(e instanceof GraphError && e.estado === 404)) throw e; }
      await db.borrarBorrador(id);
      n++;
    } catch (e) {
      deps.log?.("correo: limpieza de borrador", errorSeguro(e));
    }
  }
  return n;
}

// ---------------------------------------------------------------- diagnóstico (solo lectura)
// Carpetas del buzón (nombre, carpeta madre, totalItemCount) y recuento por
// carpeta y año-mes de los mensajes con info@ en Para o CC ($search). No
// guarda nada ni escribe en logs; no devuelve ids, asuntos, remitentes ni cuerpos.
export const DIAG_BUSQUEDA = `"to:${"info@guimaes.es"} OR cc:${"info@guimaes.es"}"`;
const SEL_CARPETA = "$select=id,displayName,parentFolderId,totalItemCount,childFolderCount&$top=100&includeHiddenFolders=true";
export async function diagnostico(deps: Deps) {
  const b = buzon(deps);
  const limite = (deps.now?.() ?? new Date()).getTime() + PRESUPUESTO_MS;
  const fuera = () => (deps.now?.() ?? new Date()).getTime() > limite;
  const carpetas: { id: string; nombre: string; padre: string; total: number }[] = [];
  const cola = [`${b}/mailFolders?${SEL_CARPETA}`];
  let cortado = false;
  while (cola.length && carpetas.length < 1000) {
    if (fuera()) { cortado = true; break; }
    let pag = await graph(deps, cola.shift()!);
    for (let i = 0; i < 50; i++) {
      for (const f of pag.value ?? []) {
        carpetas.push({ id: String(f.id), nombre: String(f.displayName ?? ""), padre: String(f.parentFolderId ?? ""), total: Number(f.totalItemCount) || 0 });
        if (Number(f.childFolderCount) > 0) cola.push(`${b}/mailFolders/${encodeURIComponent(f.id)}/childFolders?${SEL_CARPETA}`);
      }
      if (!pag["@odata.nextLink"]) break;
      pag = await graph(deps, pag["@odata.nextLink"]);
    }
  }
  const nombre = new Map(carpetas.map((c) => [c.id, c.nombre]));
  const cuenta = new Map<string, number>();
  let total = 0, paginas = 0;
  let url = `${b}/messages?$search=${encodeURIComponent(DIAG_BUSQUEDA)}&$select=id,parentFolderId,receivedDateTime&$top=250`;
  while (url) {
    if (fuera()) { cortado = true; break; }
    const pag = await graph(deps, url);
    paginas++;
    for (const m of pag.value ?? []) {
      const k = `${nombre.get(String(m.parentFolderId)) ?? "(carpeta desconocida)"}\u0000${String(m.receivedDateTime ?? "").slice(0, 7) || "(sin fecha)"}`;
      cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
      total++;
    }
    url = String(pag["@odata.nextLink"] ?? "");
  }
  return {
    carpetas: carpetas.map((c) => ({ nombre: c.nombre, madre: nombre.get(c.padre) ?? "(raíz)", total: c.total })),
    busqueda: { total, paginas, cortado },
    recuentos: [...cuenta].map(([k, n]) => { const [carpeta, mes] = k.split("\u0000"); return { carpeta, mes, n }; })
      .sort((a, b) => a.carpeta.localeCompare(b.carpeta) || a.mes.localeCompare(b.mes)),
  };
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

type Quien = "cron" | "usuario";
const PERMITIDO: Record<string, Quien[]> = {
  comprobar: ["cron", "usuario"],
  diagnostico: ["cron", "usuario"],
  sincronizar: ["cron", "usuario"],
  enviar: ["usuario"],
  responder: ["usuario"],
  marcar_leido: ["usuario"],
  adjunto: ["usuario"],
  borrador_crear: ["usuario"],
  borrador_adjuntar: ["usuario"],
  borrador_sesion: ["usuario"],
  borrador_trozo: ["usuario"],
  borrador_documento: ["usuario"],
  borrador_enviar: ["usuario"],
  borrador_descartar: ["usuario"],
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
      let adminId: string | null = null;
      const hook = req.headers.get("x-hook-secret");
      if (hook !== null) {
        const secreto = deps.env("CORREO_CRON_SECRET") ?? "";
        if (!secreto || !timingSafeEqual(hook, secreto)) return json({ error: "No autorizado." }, 401);
        quien = "cron";
      } else {
        const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
        if (!bearer) return json({ error: "No autorizado." }, 401);
        const uid = await deps.usuario(bearer);
        if (!uid) return json({ error: "No autorizado." }, 401);
        adminId = await deps.db().adminActivo(uid);
        if (!adminId) return json({ error: "No autorizado." }, 403);
        quien = "usuario";
      }

      // Ficheros (adjuntar y trozos): binario con los datos en la URL; el resto, JSON.
      let body: any;
      let bytes: Uint8Array | null = null;
      const q = new URL(req.url).searchParams;
      if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/octet-stream")) {
        body = { accion: q.get("accion") };
        if (!["borrador_adjuntar", "borrador_trozo"].includes(String(body.accion))) return json({ error: "Acción desconocida." }, 400);
        const largo = Number(req.headers.get("content-length") ?? "0");
        if (largo > MAX_DIRECTO) return json({ error: "Fichero demasiado grande para una sola petición." }, 413);
        bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > MAX_DIRECTO) return json({ error: "Fichero demasiado grande para una sola petición." }, 413);
      } else {
        try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
        if (["borrador_adjuntar", "borrador_trozo"].includes(String(body?.accion))) return json({ error: "Envía el fichero como binario." }, 400);
      }
      const accion = String(body?.accion ?? "");
      if (!PERMITIDO[accion]) return json({ error: "Acción desconocida." }, 400);
      if (!PERMITIDO[accion].includes(quien)) return json({ error: "No autorizado." }, 403);

      if (accion === "comprobar") return json(await comprobar(deps));
      if (accion === "diagnostico") return json(await diagnostico(deps));
      const db = deps.db();
      if (accion === "sincronizar") return json(await sincronizar(deps, db));
      if (accion === "enviar") return json(await enviar(deps, db, body, adminId));
      if (accion === "responder") return json(await responder(deps, db, body, adminId));
      if (accion === "marcar_leido") return json(await marcarLeido(deps, db, body));
      if (accion === "borrador_crear") return json(await borradorCrear(deps, db, body, adminId));
      if (accion === "borrador_adjuntar") return json(await borradorAdjuntar(deps, db, q, bytes!, adminId));
      if (accion === "borrador_sesion") return json(await borradorSesion(deps, db, body, adminId));
      if (accion === "borrador_trozo") return json(await borradorTrozo(deps, db, q, bytes!, adminId));
      if (accion === "borrador_documento") return json(await borradorDocumento(deps, db, body, adminId));
      if (accion === "borrador_enviar") return json(await borradorEnviar(deps, db, body, adminId));
      if (accion === "borrador_descartar") return json(await borradorDescartar(deps, db, body, adminId));
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
