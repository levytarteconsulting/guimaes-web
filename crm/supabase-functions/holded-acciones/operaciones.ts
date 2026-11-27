// Operaciones de ESCRITURA permitidas en Holded (lista cerrada) y lecturas
// que necesitan las propuestas. Todo lo demás está prohibido.
//
//   Escritura: POST /sales-receipts/{id}/approve   (aprobar ticket de venta)
//   Lectura:   GET  /sales-receipts                (tickets pendientes)
//              GET  /usage                         (cupo de la API de la cuenta)
//
// fetchAcciones() envuelve el fetch real y rechaza cualquier otra
// combinación de método y ruta antes de que salga la petición. Las pruebas
// (holded-acciones_test.ts) fallan si se intenta otra.

import { HOLDED_BASE, holdedGet, type Fetch, type RespuestaHolded } from "../_shared/holded.ts";

export const OPERACIONES = ["aprobar_tickets_venta"] as const;
export type Operacion = typeof OPERACIONES[number];

const RE_ID = /^[0-9a-f]{24}$/;
const LECTURAS = ["/sales-receipts", "/usage"];
const ESCRITURAS: { metodo: string; re: RegExp }[] = [
  { metodo: "POST", re: /^\/sales-receipts\/[0-9a-f]{24}\/approve$/ },
];

/** fetch que solo deja salir las lecturas y escrituras de la lista. */
export function fetchAcciones(base: Fetch): Fetch {
  return (url, init) => {
    const metodo = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const b = new URL(HOLDED_BASE);
    const ruta = u.origin === b.origin && u.pathname.startsWith(b.pathname + "/") ? u.pathname.slice(b.pathname.length) : null;
    const permitida = ruta !== null && (
      (metodo === "GET" && LECTURAS.includes(ruta)) ||
      ESCRITURAS.some((e) => e.metodo === metodo && e.re.test(ruta) && u.search === "")
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

/** Lectura (solo las de LECTURAS). */
export function leer(clave: string, ruta: "/sales-receipts" | "/usage", params: Record<string, string | number | undefined>, f: Fetch) {
  return holdedGet(clave, ruta, params, { fetch: f, timeoutMs: 15_000 });
}

/** Mensaje corto de un error de Holded, sin nada con forma de clave. */
export function detalleError(datos: unknown): string | null {
  if (!datos || typeof datos !== "object") return null;
  const d = datos as Record<string, unknown>;
  const t = [d.title, d.detail, d.message, d.error].filter((x) => typeof x === "string" && x.trim()).join(": ");
  return t ? t.replace(/pat_[A-Za-z0-9_\-]*/g, "pat_…").slice(0, 200) : null;
}
