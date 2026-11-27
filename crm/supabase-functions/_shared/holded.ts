// Cliente mínimo de la API v2 de Holded: SOLO lectura (GET), base fija.
// No hay en este módulo ninguna forma de hacer POST, PUT, PATCH ni DELETE.
// La clave va solo en la cabecera Authorization y nunca se registra.
// Documentación: https://www.holded.com/es/desarrolladores (autenticación
// Bearer, paginación por cursor, 429 con Retry-After y X-RateLimit-Window).

export const HOLDED_BASE = "https://api.holded.com/api/v2";

export type RespuestaHolded = {
  status: number;                 // 0 = no hubo respuesta (red o tiempo agotado)
  datos: unknown;                 // JSON de la respuesta (null si no lo hay)
  retryAfter: number | null;      // segundos, en los 429
  ventana: string | null;         // X-RateLimit-Window: "minute" | "month" | …
};

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// ruta: "/invoices", con parámetros aparte. Rechaza cualquier otra cosa que
// una ruta relativa simple (sin esquema, host, "..", ni query embebida).
export async function holdedGet(
  clave: string, ruta: string, params: Record<string, string | number | undefined> = {},
  opciones: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<RespuestaHolded> {
  if (!/^\/[a-z0-9\-\/]+$/.test(ruta) || ruta.includes("..") || ruta.includes("//")) {
    throw new Error("Ruta de Holded no permitida");
  }
  const url = new URL(HOLDED_BASE + ruta);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const f = opciones.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${clave}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(opciones.timeoutMs ?? 15_000),
    });
  } catch {
    return { status: 0, datos: null, retryAfter: null, ventana: null };
  }
  let datos: unknown = null;
  try { datos = await res.json(); } catch { /* sin JSON */ }
  const ra = Number(res.headers.get("retry-after"));
  return {
    status: res.status,
    datos,
    retryAfter: Number.isFinite(ra) && ra >= 0 && res.headers.get("retry-after") !== null ? ra : null,
    ventana: res.headers.get("x-ratelimit-window"),
  };
}
