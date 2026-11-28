// Lógica de la Edge Function "agente": chat del CRM con Claude, herramientas
// de consulta y herramientas que PROPONEN escrituras. index.ts solo conecta las dependencias reales;
// agente_test.ts prueba todo esto con Claude y la base de datos simulados.
//
// Reglas:
//   * Todo con el JWT de quien pregunta: las herramientas son RPC
//     security invoker (crm/supabase-agente.sql) y la auditoría se escribe
//     con ese mismo JWT. Nunca la service role.
//   * Quien llama tiene que ser usuario activo del CRM (is_admin()).
//   * Tope diario de preguntas por usuario (AGENTE_TOPE_DIARIO, 50).
//   * Plazo interno de 120 s (la Edge Function muere a los 150 s en el plan
//     Free) y como mucho 8 llamadas al modelo por pregunta.
//   * El historial solo crece: cada respuesta del modelo se guarda y se
//     reenvía tal cual (bloques de thinking incluidos), y todo tool_use
//     guardado va seguido de su tool_result (real o de error), pase lo que
//     pase. Una respuesta cortada a medias (plazo, cancelación, error) no se
//     guarda.
//   * Sin fallbacks: un rechazo del modelo (stop_reason "refusal") queda como
//     rechazo. Se guarda en la auditoría (con stop_details en "uso"), no se
//     ejecutan sus herramientas y no se reenvía al modelo en las preguntas
//     siguientes (historialDe lo omite).
//   * Respuesta en streaming (Server-Sent Events): conversacion, texto,
//     herramienta, fin, error.
//   * Holded (herramientas holded_*): van a la Edge Function holded-proxy
//     con el mismo JWT (db.holded). Sus resultados se usan en la respuesta
//     en curso pero NO se guardan: en agente_mensajes queda
//     SIN_GUARDAR_HOLDED en su lugar (la auditoría de la llamada sí).
//   * Escrituras en el CRM (proponer_*): solo crean una propuesta con
//     agente_proponer (conversación y tool_use_id los pone esta función, no
//     el modelo). El evento "herramienta" de fin lleva su id y el CRM la
//     pinta como tarjeta; escribe agente_confirmar cuando el usuario pulsa
//     Confirmar. En cada pregunta, el modelo recibe en el contexto cómo han
//     quedado las propuestas de la conversación.

import type Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { esHolded, HERRAMIENTAS_API, type LlamadaHolded, validarEntrada } from "./herramientas.ts";
import { consultarDocumentacion } from "./documentacion.ts";
import { type AdminResumen, construirSistema } from "./sistema.ts";

export const MODELO_POR_DEFECTO = "claude-sonnet-5-5";
export const ESFUERZO_POR_DEFECTO = "medium";
export const TOPE_DIARIO_POR_DEFECTO = 50;
export const MAX_VUELTAS = 8;
export const PLAZO_MS = 120_000;
export const MIN_PARA_VUELTA_MS = 15_000;      // no se empieza una llamada al modelo con menos margen
export const HERRAMIENTA_MS = 15_000;
export const HOLDED_MS = 45_000;               // holded-proxy corta a los 40 s
export const SIN_GUARDAR_HOLDED = "[datos de Holded no guardados]";
export const PING_MS = 15_000;
export const MAX_PREGUNTA = 4_000;
export const MAX_PREGUNTAS_CONVERSACION = 40;
export const MAX_RESULTADO = 12_000;           // caracteres de cada tool_result
export const MAX_TOKENS = 16_000;
// Solo la web (www.guimaes.es redirige a guimaes.es y no sirve contenido).
export const ORIGENES = ["https://guimaes.es"];
const ESFUERZOS = ["low", "medium", "high", "xhigh", "max"] as const;
const VISTAS = /^[a-z_]{1,40}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Contenido = Anthropic.Beta.BetaContentBlock[];
type Param = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
export type ParamsModelo = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

// ---------------------------------------------------------------- dependencias
export type MensajeGuardado = {
  orden: number; rol: "user" | "assistant"; tipo: "pregunta" | "herramientas" | "modelo"; contenido: unknown;
  stop_reason?: string | null;
};
export type NuevoMensaje = MensajeGuardado & {
  conversacion_id: string; texto: string | null; modelo?: string | null; stop_reason?: string | null;
  uso?: unknown; request_id?: string | null; latencia_ms?: number | null;
};
export type NuevaLlamada = {
  conversacion_id: string; mensaje_id: string; tool_use_id: string; herramienta: string; parametros: Record<string, unknown>;
  filas: number | null; bytes: number | null; es_error: boolean; error: string | null; duracion_ms: number | null;
};
export type ErrorDb = { code?: string; message?: string };
export type RespuestaHolded =
  | { ok: true; datos: unknown; desde_cache?: boolean; truncado?: boolean; motivo_truncado?: string }
  | { ok: false; codigo?: string; mensaje: string };

/** Base de datos con el JWT del usuario (RLS). */
export interface Db {
  esUsuarioCrm(): Promise<boolean>;
  preguntasDesde(authUserId: string, desdeIso: string): Promise<number>;
  admins(): Promise<AdminResumen[]>;
  /** Quién pregunta (admins.id, nombre y rol), o null. */
  yo(authUserId: string): Promise<{ id: string; nombre: string; rol: string } | null>;
  /** Propuestas de la conversación (las 20 últimas): id, tipo, resumen, estado y resultado. */
  propuestas(conversacionId: string): Promise<{ id: string; tipo: string; resumen: string; estado: string; resultado_id: string | null; expira_at: string }[]>;
  /** Correos redactados en la conversación (agente_correos), los más recientes primero. */
  correos(conversacionId: string): Promise<{ id: string; resumen: string; estado: string; expira_at: string }[]>;
  conversacionPropia(id: string, authUserId: string): Promise<boolean>;
  mensajes(conversacionId: string): Promise<MensajeGuardado[]>;
  crearConversacion(titulo: string, modelo: string): Promise<string>;
  guardarMensaje(m: NuevoMensaje): Promise<string>;
  guardarLlamadas(l: NuevaLlamada[]): Promise<void>;
  /** Llama a una RPC agente_*. Lanza ErrorDb si falla. */
  rpc(nombre: string, args: Record<string, unknown>): Promise<unknown>;
  /** Llama a holded-proxy con el JWT del usuario. Devuelve su respuesta
   *  ({ ok, datos… } o { ok: false, mensaje }); lanza ErrorDb si falla. */
  holded(llamada: LlamadaHolded): Promise<RespuestaHolded>;
}

export type StreamModelo = AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
  readonly request_id?: string | null;
};
export interface Modelo {
  stream(params: ParamsModelo, signal: AbortSignal): StreamModelo;
}

export type Deps = {
  env: (k: string) => string | undefined;
  /** Valida el JWT y devuelve el id del usuario (auth.users) o null. */
  usuario: (jwt: string) => Promise<string | null>;
  db: (jwt: string) => Db;
  modelo: () => Modelo;
  ahora?: () => number;
  log?: (...a: unknown[]) => void;
};
export type Opciones = { plazoMs?: number; minParaVueltaMs?: number; herramientaMs?: number; holdedMs?: number; pingMs?: number };

// ---------------------------------------------------------------- utilidades
function cors(req: Request): Record<string, string> {
  const origen = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origen) ? origen : ORIGENES[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

/** Medianoche de hoy en Madrid, como instante ISO (para el tope diario). */
export function inicioDiaMadrid(ahoraMs: number): string {
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ahoraMs)).map((p) => [p.type, p.value]));
  const comoUtc = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second);
  const desfase = comoUtc - Math.floor(ahoraMs / 1000) * 1000;           // Madrid - UTC
  return new Date(Date.UTC(+partes.year, +partes.month - 1, +partes.day) - desfase).toISOString();
}
function fechaMadrid(ahoraMs: number): string {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(ahoraMs));
}
function entero(v: string | undefined, porDefecto: number, min: number, max: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max ? n : porDefecto;
}

/** Texto plano de una respuesta (para la columna texto y el panel). */
function textoDe(c: Contenido): string {
  return c.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
}
function toolUses(c: Contenido): ToolUse[] {
  return c.filter((b): b is ToolUse => b.type === "tool_use");
}
function resultadoError(id: string, mensaje: string): ToolResult {
  return { type: "tool_result", tool_use_id: id, is_error: true, content: mensaje };
}
/** Filas de un resultado: la longitud de la primera lista de primer nivel. */
function filasDe(v: unknown): number | null {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) if (Array.isArray(x)) return x.length;
  }
  return null;
}
/** JSON del resultado sin "<" (no se puede cerrar ni abrir etiquetas desde un
 *  dato) y recortado. */
export function serializarResultado(v: unknown): string {
  const s = JSON.stringify(v ?? null).replace(/</g, "\\u003c");
  return s.length <= MAX_RESULTADO
    ? s
    : s.slice(0, MAX_RESULTADO) + `\n[Resultado recortado a ${MAX_RESULTADO} caracteres: pide menos filas o filtra más.]`;
}

/** Historial que se reenvía al modelo: lo guardado, en orden, sin los
 *  rechazos ni respuestas vacías (que solo quedan en la auditoría). */
export function historialDe(previos: MensajeGuardado[]): Param[] {
  return [...previos].sort((a, b) => a.orden - b.orden)
    .filter((m) => !(m.rol === "assistant" && (m.stop_reason === "refusal" || (Array.isArray(m.contenido) && m.contenido.length === 0))))
    .map((m) => ({ role: m.rol, content: m.contenido }) as Param);
}

class Cortado extends Error {
  readonly motivo: "plazo" | "cancelado";
  constructor(motivo: "plazo" | "cancelado") { super(motivo); this.motivo = motivo; }
}

// ---------------------------------------------------------------- handler
export function createHandler(deps: Deps, opciones: Opciones = {}) {
  const ahora = deps.ahora ?? Date.now;
  const log = deps.log ?? (() => {});
  const plazoMs = opciones.plazoMs ?? PLAZO_MS;
  const minParaVuelta = opciones.minParaVueltaMs ?? MIN_PARA_VUELTA_MS;
  const herramientaMs = opciones.herramientaMs ?? HERRAMIENTA_MS;
  const holdedMs = opciones.holdedMs ?? HOLDED_MS;
  const pingMs = opciones.pingMs ?? PING_MS;
  // AGENTE_CORREO_SOLO (secreto compartido con la función correo): en pruebas,
  // los correos del asistente solo pueden ir a esas direcciones. La función
  // correo lo vuelve a comprobar al enviar.
  const comprobarPruebas = async (c: Record<string, unknown>) => {
    const solo = String(deps.env("AGENTE_CORREO_SOLO") ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!solo.length) return;
    const todos = ["para", "cc", "cco"].flatMap((k) => Array.isArray(c[k]) ? c[k] as string[] : [])
      .map((x) => String(x).trim().toLowerCase()).map((x) => /<([^<>]*)>\s*$/.exec(x)?.[1]?.trim() ?? x).filter(Boolean);
    if (todos.some((x) => !solo.includes(x))) {
      throw { code: "pruebas", message: "Modo de pruebas: los correos del asistente solo pueden ir a las direcciones de prueba. " +
                                        "Dile al usuario que no se puede redactar a esos destinatarios ahora." };
    }
  };

  return async function handler(req: Request): Promise<Response> {
    const inicio = ahora();
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
    if (req.method !== "POST") return json(req, 405, { error: "Método no permitido." });

    // ---- autenticación y autorización (todo falla cerrado)
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    let uid: string | null = null;
    try { uid = jwt ? await deps.usuario(jwt) : null; } catch (e) { log("agente: usuario", e); }
    if (!uid) return json(req, 401, { error: "No autorizado." });
    const db = deps.db(jwt);
    let esCrm = false;
    try { esCrm = await db.esUsuarioCrm(); } catch (e) { log("agente: is_admin", e); }
    if (!esCrm) return json(req, 403, { error: "Solo para usuarios activos del CRM." });

    // ---- entrada
    let cuerpo: Record<string, unknown>;
    try { cuerpo = await req.json(); } catch { return json(req, 400, { error: "JSON no válido." }); }
    if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) return json(req, 400, { error: "JSON no válido." });
    const pregunta = typeof cuerpo.pregunta === "string" ? cuerpo.pregunta.trim() : "";
    if (!pregunta || pregunta.length > MAX_PREGUNTA) {
      return json(req, 400, { error: `Escribe una pregunta (como mucho ${MAX_PREGUNTA} caracteres).` });
    }
    const convPedida = cuerpo.conversacion_id;
    if (convPedida !== undefined && convPedida !== null && (typeof convPedida !== "string" || !RE_UUID.test(convPedida))) {
      return json(req, 400, { error: "conversacion_id no válido." });
    }
    const ctx = cuerpo.contexto;
    let vista: string | null = null, vistaId: string | null = null;
    if (ctx !== undefined && ctx !== null) {
      const c = ctx as Record<string, unknown>;
      if (typeof ctx !== "object" || typeof c.vista !== "string" || !VISTAS.test(c.vista)
          || (c.id !== undefined && c.id !== null && (typeof c.id !== "string" || !RE_UUID.test(c.id)))) {
        return json(req, 400, { error: "contexto no válido." });
      }
      vista = c.vista; vistaId = (c.id as string | undefined) ?? null;
    }

    // ---- configuración (sin clave de la API no se llama a nada)
    if (!deps.env("ANTHROPIC_API_KEY")) return json(req, 503, { error: "El asistente todavía no está configurado." });
    const modeloId = (deps.env("AGENTE_MODELO") ?? "").trim() || MODELO_POR_DEFECTO;
    const esfuerzoEnv = (deps.env("AGENTE_ESFUERZO") ?? "").trim();
    const esfuerzo = (ESFUERZOS as readonly string[]).includes(esfuerzoEnv) ? esfuerzoEnv : ESFUERZO_POR_DEFECTO;
    const tope = entero(deps.env("AGENTE_TOPE_DIARIO"), TOPE_DIARIO_POR_DEFECTO, 0, 10_000);

    // ---- tope diario, conversación e historial
    let historial: Param[] = [];
    let conversacionId: string;
    let orden = 0;
    let admins: AdminResumen[];
    let yo: { id: string; nombre: string; rol: string } | null = null;
    let propuestas: Awaited<ReturnType<Db["propuestas"]>> = [];
    let correos: Awaited<ReturnType<Db["correos"]>> = [];
    try {
      const hechas = await db.preguntasDesde(uid, inicioDiaMadrid(inicio));
      if (hechas >= tope) {
        return json(req, 429, { error: `Has llegado al máximo de ${tope} preguntas por hoy. Mañana se renueva.` });
      }
      if (typeof convPedida === "string") {
        if (!(await db.conversacionPropia(convPedida, uid))) return json(req, 404, { error: "Conversación no encontrada." });
        const previos = await db.mensajes(convPedida);
        if (previos.filter((m) => m.tipo === "pregunta").length >= MAX_PREGUNTAS_CONVERSACION) {
          return json(req, 409, { error: "Esta conversación ya es muy larga: empieza una nueva." });
        }
        historial = historialDe(previos);
        orden = previos.length ? Math.max(...previos.map((m) => m.orden)) + 1 : 0;
        conversacionId = convPedida;
      } else {
        conversacionId = await db.crearConversacion(pregunta.slice(0, 80), modeloId);
      }
      admins = await db.admins();
      yo = await db.yo(uid);
      if (typeof convPedida === "string") [propuestas, correos] = await Promise.all([db.propuestas(conversacionId), db.correos(conversacionId)]);
    } catch (e) {
      log("agente: preparación", e);
      return json(req, 500, { error: "No se ha podido preparar la conversación." });
    }

    const params = (mensajes: Param[]): ParamsModelo => {
      return {
        model: modeloId,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: construirSistema(admins) }],
        tools: HERRAMIENTAS_API,
        messages: mensajes,
        output_config: { effort: esfuerzo as "medium" },
        cache_control: { type: "ephemeral" },
      };
    };

    // ---- streaming
    const enc = new TextEncoder();
    let controlador!: ReadableStreamDefaultController<Uint8Array>;
    let cerrado = false;
    const enviar = (evento: string, datos: unknown) => {
      if (cerrado) return;
      try { controlador.enqueue(enc.encode(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`)); }
      catch { cerrado = true; }
    };
    const cuerpoSse = new ReadableStream<Uint8Array>({
      start(c) { controlador = c; },
      cancel() { cerrado = true; },
    });

    const trabajo = (async () => {
      const ping = setInterval(() => {
        if (!cerrado) { try { controlador.enqueue(enc.encode(": ping\n\n")); } catch { cerrado = true; } }
      }, pingMs);
      const uso = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      let motivo = "fin";
      let vueltas = 0;
      try {
        enviar("conversacion", { id: conversacionId });

        const guardar = async (m: Omit<NuevoMensaje, "conversacion_id" | "orden">) => {
          const id = await db.guardarMensaje({ ...m, conversacion_id: conversacionId, orden });
          orden++;
          return id;
        };

        // Pregunta: el contexto (fecha, vista) va en un bloque aparte, en el
        // mensaje y no en el sistema, para no romper la caché.
        const contexto = `Contexto (no es parte de la pregunta): ahora es ${fechaMadrid(inicio)} en Madrid.` +
          (vista ? ` El usuario está en la vista "${vista}"${vistaId ? ` del registro ${vistaId}` : ""} del CRM.` : "") +
          (yo ? ` Te habla ${yo.nombre} (id ${yo.id}, rol ${yo.rol}).` : "") +
          (propuestas.length ? ` Propuestas de esta conversación: ${propuestas.map((x) =>
            `${x.id} «${x.resumen}»: ${x.estado === "pendiente" && Date.parse(x.expira_at) < inicio ? "caducada" : x.estado}` +
            (x.resultado_id ? ` (registro ${x.resultado_id})` : "")).join("; ")}.` : "") +
          (correos.length ? ` Correos redactados en esta conversación: ${correos.map((x) =>
            `${x.id} «${x.resumen}»: ${x.estado === "pendiente" && Date.parse(x.expira_at) < inicio ? "caducado" : x.estado}`).join("; ")}.` : "");
        const contenidoPregunta = [{ type: "text" as const, text: contexto }, { type: "text" as const, text: pregunta }];
        await guardar({ rol: "user", tipo: "pregunta", contenido: contenidoPregunta, texto: pregunta });
        historial.push({ role: "user", content: contenidoPregunta });

        const guardarResultados = async (resultados: ToolResult[], llamadas: Omit<NuevaLlamada, "mensaje_id" | "conversacion_id">[], mensajeModeloId: string) => {
          // Los datos de Holded solo viven en esta respuesta: al historial
          // guardado va un marcador (los errores, que no traen datos, sí).
          const deHolded = new Set(llamadas.filter((l) => esHolded(l.herramienta)).map((l) => l.tool_use_id));
          const guardables = resultados.map((r) => deHolded.has(r.tool_use_id) && !r.is_error
            ? { ...r, content: SIN_GUARDAR_HOLDED } : r);
          await guardar({ rol: "user", tipo: "herramientas", contenido: guardables, texto: null });
          historial.push({ role: "user", content: resultados });
          if (llamadas.length) {
            await db.guardarLlamadas(llamadas.map((l) => ({ ...l, mensaje_id: mensajeModeloId, conversacion_id: conversacionId })));
          }
        };
        const sinEjecutar = (usos: ToolUse[], porque: string) => ({
          resultados: usos.map((u) => resultadoError(u.id, `No ejecutada: ${porque}.`)),
          llamadas: usos.map((u) => ({ tool_use_id: u.id, herramienta: u.name, parametros: (u.input ?? {}) as Record<string, unknown>,
                                       filas: null, bytes: null, es_error: true, error: `No ejecutada: ${porque}`, duracion_ms: null })),
        });

        while (true) {
          if (vueltas >= MAX_VUELTAS) { motivo = "vueltas"; break; }
          const restante = inicio + plazoMs - ahora();
          if (restante < minParaVuelta) { motivo = "plazo"; break; }
          if (cerrado || req.signal.aborted) { motivo = "cancelado"; break; }
          vueltas++;

          // Una llamada al modelo, cortada por plazo o por cancelación.
          const corte = new AbortController();
          const temporizador = setTimeout(() => corte.abort(new Cortado("plazo")), restante);
          const alCancelar = () => corte.abort(new Cortado("cancelado"));
          req.signal.addEventListener("abort", alCancelar);
          const t0 = ahora();
          let respuesta: Anthropic.Beta.BetaMessage;
          let requestId: string | null = null;
          try {
            const stream = deps.modelo().stream(params(historial), corte.signal);
            for await (const ev of stream) {
              if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") enviar("texto", { delta: ev.delta.text });
            }
            respuesta = await stream.finalMessage();
            requestId = stream.request_id ?? null;
          } catch (e) {
            const razon = corte.signal.reason;
            if (razon instanceof Cortado) { motivo = razon.motivo; break; }
            throw e;
          } finally {
            clearTimeout(temporizador);
            req.signal.removeEventListener("abort", alCancelar);
          }

          for (const k of Object.keys(uso) as (keyof typeof uso)[]) uso[k] += Number(respuesta.usage?.[k] ?? 0);
          const contenido = respuesta.content;
          const usos = toolUses(contenido);

          // Rechazo: queda en la auditoría tal cual, sin ejecutar nada y sin
          // pasar al historial que se reenvía (una respuesta rechazada, a
          // veces parcial, no se le devuelve al modelo).
          if (respuesta.stop_reason === "refusal") {
            await guardar({
              rol: "assistant", tipo: "modelo", contenido, texto: textoDe(contenido) || null, modelo: respuesta.model,
              stop_reason: "refusal", uso: { ...respuesta.usage, stop_details: respuesta.stop_details ?? null },
              request_id: requestId, latencia_ms: ahora() - t0,
            });
            motivo = "rechazo";
            break;
          }
          if (contenido.length === 0) { motivo = "fin"; break; }

          const mensajeModeloId = await guardar({
            rol: "assistant", tipo: "modelo", contenido, texto: textoDe(contenido) || null, modelo: respuesta.model,
            stop_reason: respuesta.stop_reason, uso: respuesta.usage, request_id: requestId, latencia_ms: ahora() - t0,
          });
          historial.push({ role: "assistant", content: contenido });

          if (respuesta.stop_reason !== "tool_use" || usos.length === 0) {
            // Respuesta final o cortada por max_tokens: si dejó algún
            // tool_use, no se ejecuta, pero se cierra con un error para que
            // el historial siga siendo válido.
            if (usos.length) {
              const s = sinEjecutar(usos, "la respuesta se cortó antes de terminar");
              await guardarResultados(s.resultados, s.llamadas, mensajeModeloId);
            }
            motivo = respuesta.stop_reason === "max_tokens" ? "max_tokens" : "fin";
            break;
          }

          // Herramientas: sin margen para otra vuelta no se ejecutan.
          const sinMargen = vueltas >= MAX_VUELTAS ? "se alcanzó el máximo de pasos de esta respuesta"
            : inicio + plazoMs - ahora() < minParaVuelta ? "se acabó el tiempo de esta respuesta" : null;
          if (sinMargen) {
            const s = sinEjecutar(usos, sinMargen);
            await guardarResultados(s.resultados, s.llamadas, mensajeModeloId);
            motivo = vueltas >= MAX_VUELTAS ? "vueltas" : "plazo";
            break;
          }
          const hechos = await Promise.all(usos.map((u) => ejecutar(u)));
          await guardarResultados(hechos.map((h) => h.resultado), hechos.map((h) => h.llamada), mensajeModeloId);
        }
      } catch (e) {
        motivo = "error";
        log("agente: error", e);
        enviar("error", { mensaje: "Ha fallado la respuesta. Inténtalo de nuevo en un momento." });
      } finally {
        clearInterval(ping);
        enviar("fin", { motivo, vueltas, conversacion_id: conversacionId, uso });
        if (!cerrado) { cerrado = true; try { controlador.close(); } catch { /* ya cerrado */ } }
      }
    })();
    void trabajo;

    async function ejecutar(u: ToolUse): Promise<{ resultado: ToolResult; llamada: Omit<NuevaLlamada, "mensaje_id" | "conversacion_id"> }> {
      const parametros = (u.input && typeof u.input === "object" ? u.input : {}) as Record<string, unknown>;
      const base = { tool_use_id: u.id, herramienta: u.name.slice(0, 64), parametros };
      enviar("herramienta", { id: u.id, nombre: u.name, estado: "inicio" });
      const t0 = ahora();
      const v = validarEntrada(u.name, u.input);
      if (!v.ok) {
        enviar("herramienta", { id: u.id, nombre: u.name, estado: "fin", error: true });
        return { resultado: resultadoError(u.id, v.error),
                 llamada: { ...base, filas: null, bytes: null, es_error: true, error: v.error, duracion_ms: 0 } };
      }
      try {
        let espera: ReturnType<typeof setTimeout> | undefined;
        const limiteMs = "holded" in v ? holdedMs : herramientaMs;
        let datos = await Promise.race([
          "holded" in v ? db.holded(v.holded)
            : "local" in v ? Promise.resolve(consultarDocumentacion(v.args))
            : "propuesta" in v ? db.rpc("agente_proponer", { p_conversacion: conversacionId, p_tool_use_id: u.id, p_tipo: v.propuesta.tipo,
                                                             p_registro: v.propuesta.registro, p_datos: v.propuesta.datos })
            : "correo" in v ? comprobarPruebas(v.correo).then(() =>
                db.rpc("agente_proponer_correo", { p_conversacion: conversacionId, p_tool_use_id: u.id, p_datos: v.correo }))
            : db.rpc(v.rpc, v.args),
          new Promise((_, no) => { espera = setTimeout(() => no({ code: "timeout", message: "tiempo agotado" }), limiteMs); }),
        ]).finally(() => clearTimeout(espera));
        if ("holded" in v) {
          const h = datos as RespuestaHolded;
          if (!h || h.ok !== true) {
            const mensaje = `${(h && "mensaje" in h && h.mensaje) || "No se ha podido consultar Holded."} ` +
              "No hay datos de Holded para responder: no los supongas ni los estimes.";
            enviar("herramienta", { id: u.id, nombre: u.name, estado: "fin", error: true });
            return { resultado: resultadoError(u.id, mensaje),
                     llamada: { ...base, filas: null, bytes: null, es_error: true, error: mensaje.slice(0, 2000), duracion_ms: ahora() - t0 } };
          }
          datos = { ...(h.datos as Record<string, unknown>), truncado: h.truncado === true,
                    ...(h.motivo_truncado ? { motivo_truncado: h.motivo_truncado } : {}), fuente: "Holded" };
        }
        let propuesta: string | undefined;
        let correo: string | undefined;
        if ("correo" in v) {
          const c = datos as { id: string; resumen: string; datos: unknown; adjuntos: unknown[]; avisos: unknown[]; puede_enviar: boolean };
          correo = c.id;
          datos = { correo_id: c.id, estado: "pendiente", resumen: c.resumen, datos: c.datos, adjuntos: c.adjuntos, avisos: c.avisos,
                    nota: "NO está enviado: sale como tarjeta en el chat y solo un usuario con rol admin puede enviarlo pulsando Enviar. " +
                          "No digas que se ha enviado." +
                          (c.puede_enviar ? "" : " Quien te habla no es admin: dile que un administrador tiene que revisarlo y enviarlo.") +
                          (c.avisos?.length ? " Cuéntale los avisos." : "") };
        }
        if ("propuesta" in v) {
          const p = datos as { id: string; resumen: string; datos: unknown; antes: unknown; coincidencias: unknown[]; confirmacion: string | null };
          propuesta = p.id;
          datos = { propuesta_id: p.id, estado: "pendiente", resumen: p.resumen, datos: p.datos, antes: p.antes, coincidencias: p.coincidencias,
                    nota: "NO está hecho: el usuario tiene que pulsar Confirmar en la tarjeta" +
                          (p.confirmacion ? ` y escribir ${p.confirmacion}` : "") + ". No digas que se ha hecho." +
                          (p.coincidencias?.length ? " Hay posibles duplicados: díselos y pregunta si usar el existente." : "") };
        }
        const texto = serializarResultado(datos);
        const filas = filasDe(datos);
        enviar("herramienta", { id: u.id, nombre: u.name, estado: "fin", filas, ...(propuesta ? { propuesta } : {}), ...(correo ? { correo } : {}) });
        return { resultado: { type: "tool_result", tool_use_id: u.id, content: texto },
                 llamada: { ...base, filas, bytes: texto.length, es_error: false, error: null, duracion_ms: ahora() - t0 } };
      } catch (e) {
        const err = (e ?? {}) as ErrorDb;
        const mensaje = (err.code === "22023" || err.code === "GU010" || err.code === "pruebas") && err.message ? err.message
          : err.code === "42501" ? ("propuesta" in v ? "No tienes permiso para hacer este cambio en el CRM."
                                   : "correo" in v ? "No tienes permiso para redactar correos." : "Sin permiso para esta consulta.")
          : err.code === "timeout" ? "La consulta ha tardado demasiado; prueba a filtrar más."
          : "No se ha podido hacer la consulta.";
        if (err.code !== "22023" && err.code !== "GU010" && err.code !== "pruebas") log("agente: herramienta", u.name, e);
        enviar("herramienta", { id: u.id, nombre: u.name, estado: "fin", error: true });
        return { resultado: resultadoError(u.id, mensaje),
                 llamada: { ...base, filas: null, bytes: null, es_error: true, error: mensaje.slice(0, 2000), duracion_ms: ahora() - t0 } };
      }
    }

    return new Response(cuerpoSse, {
      status: 200,
      headers: { ...cors(req), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
    });
  };
}
