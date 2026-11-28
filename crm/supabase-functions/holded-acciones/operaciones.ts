// Peticiones permitidas hacia Holded. Todo lo demás está prohibido.
//
//   Escritura: las operaciones de la LISTA CERRADA (catalogo.json, generada
//              desde la especificación oficial de la API v2): método exacto,
//              ruta con parámetros validados. Entre ellas, POST
//              /sales-receipts/{id}/approve (aprobar ticket de venta).
//   Lectura:   GET /sales-receipts y GET /usage (propuestas de tickets) y el
//              GET por id del documento que cambia una operación (estado
//              anterior, para comparar).
//
// fetchAcciones() envuelve el fetch real y rechaza cualquier otra
// combinación de método y ruta antes de que salga la petición. Las pruebas
// (holded-acciones_test.ts) fallan si se intenta otra.

import { HOLDED_BASE, holdedGet, type Fetch, type RespuestaHolded } from "../_shared/holded.ts";
import { encontrarOperacion, esLecturaDeEstado } from "./catalogo.ts";

export const OPERACIONES = ["aprobar_tickets_venta"] as const;
export type Operacion = typeof OPERACIONES[number];

const RE_ID = /^[0-9a-f]{24}$/;
const LECTURAS = ["/sales-receipts", "/usage"];

/** fetch que solo deja salir las lecturas y escrituras de la lista. */
export function fetchAcciones(base: Fetch): Fetch {
  return (url, init) => {
    const metodo = (init?.method ?? "GET").toUpperCase();
    // Sin segmentos «.» o «..» ni barras dobles: se comprueba la URL tal cual, antes de normalizarla.
    const crudo = url.replace(/^https?:\/\//, "");
    if (/\/\.{1,2}(\/|\?|#|$)|%2e|%2f|\/\/|\\/i.test(crudo)) {
      throw new Error(`Holded: operación no permitida (${metodo})`);
    }
    const u = new URL(url);
    const b = new URL(HOLDED_BASE);
    const ruta = u.origin === b.origin && u.pathname.startsWith(b.pathname + "/") ? u.pathname.slice(b.pathname.length) : null;
    const permitida = ruta !== null && (
      (metodo === "GET" && (LECTURAS.includes(ruta) || (esLecturaDeEstado(ruta) && u.search === ""))) ||
      (metodo !== "GET" && encontrarOperacion(metodo, ruta + (u.search ? u.search : "")) !== null)
    );
    if (!permitida) throw new Error(`Holded: operación no permitida (${metodo})`);
    return base(url, init);
  };
}

/** Aprueba un ticket de venta. Sin cuerpo. */
export async function aprobarTicket(clave: string, id: string, f: Fetch, timeoutMs = 20_000): Promise<RespuestaHolded> {
  if (!RE_ID.test(id)) throw new Error("Id de Holded no válido");
  let res: Response;
  try {
    res = await f(`${HOLDED_BASE}/sales-receipts/${id}/approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clave}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && /no permitida/.test(e.message)) throw e;
    return { status: 0, datos: null, retryAfter: null, ventana: null };
  }
  let datos: unknown = null;
  try { datos = await res.json(); } catch { /* 200/204 sin cuerpo */ }
  const ra = res.headers.get("retry-after");
  const n = Number(ra);
  return { status: res.status, datos, retryAfter: ra !== null && Number.isFinite(n) && n >= 0 ? n : null,
           ventana: res.headers.get("x-ratelimit-window") };
}

/** Petición de una operación del catálogo (método, ruta y cuerpo JSON exactos). */
export async function peticion(clave: string, metodo: string, ruta: string, cuerpo: unknown, f: Fetch, timeoutMs = 25_000): Promise<RespuestaHolded> {
  let res: Response;
  try {
    res = await f(`${HOLDED_BASE}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${clave}`, Accept: "application/json",
                 ...(cuerpo !== undefined && cuerpo !== null ? { "Content-Type": "application/json" } : {}) },
      ...(cuerpo !== undefined && cuerpo !== null ? { body: JSON.stringify(cuerpo) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && /no permitida/.test(e.message)) throw e;
    return { status: 0, datos: null, retryAfter: null, ventana: null };
  }
  let datos: unknown = null;
  try { datos = await res.json(); } catch { /* sin cuerpo */ }
  const ra = res.headers.get("retry-after");
  const n = Number(ra);
  return { status: res.status, datos, retryAfter: ra !== null && Number.isFinite(n) && n >= 0 ? n : null,
           ventana: res.headers.get("x-ratelimit-window") };
}

/** GET del documento afectado por una operación (estado anterior). */
export function leerDocumento(clave: string, ruta: string, f: Fetch) {
  return holdedGet(clave, ruta, {}, { fetch: f, timeoutMs: 15_000 });
}

/** Lectura (solo las de LECTURAS). */
export function leer(clave: string, ruta: "/sales-receipts" | "/usage", params: Record<string, string | number | undefined>, f: Fetch, timeoutMs = 15_000) {
  return holdedGet(clave, ruta, params, { fetch: f, timeoutMs });
}

/** Mensaje corto de un error de Holded, sin nada con forma de clave. */
export function detalleError(datos: unknown): string | null {
  if (!datos || typeof datos !== "object") return null;
  const d = datos as Record<string, unknown>;
  const t = [d.title, d.detail, d.message, d.error].filter((x) => typeof x === "string" && x.trim()).join(": ");
  return t ? t.replace(/pat_[A-Za-z0-9_\-]*/g, "pat_…").slice(0, 200) : null;
}
