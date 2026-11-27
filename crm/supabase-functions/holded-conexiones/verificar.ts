// Verificación de una clave de Holded con llamadas ligeras de solo lectura
// (limit=1). Cada sonda dice si la clave tiene ese permiso (200) o no (403).
// Gasta 6 llamadas de la cuota mensual de la cuenta de Holded.
import { type Fetch, holdedGet } from "../_shared/holded.ts";

// Permiso → ruta de prueba. "facturas" cubre también los abonos
// (/credit-notes usa el mismo permiso sales:invoices.read).
export const SONDAS: { permiso: string; ruta: string; params?: Record<string, number> }[] = [
  { permiso: "cuenta", ruta: "/account" },
  { permiso: "facturas", ruta: "/invoices", params: { limit: 1 } },
  { permiso: "compras", ruta: "/purchases", params: { limit: 1 } },
  { permiso: "contactos", ruta: "/contacts", params: { limit: 1 } },
  { permiso: "bancos", ruta: "/treasury/accounts", params: { limit: 1 } },
  { permiso: "uso", ruta: "/usage" },
];

export type Verificacion = {
  estado: "ok" | "error";
  error: string | null;
  permisos: Record<string, boolean>;
  nif_holded: string | null;
  uso: { periodo: string | null; usadas: number | null; limite: number | null } | null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function verificarClave(clave: string, opciones: { fetch?: Fetch } = {}): Promise<Verificacion> {
  const permisos: Record<string, boolean> = {};
  let nif: string | null = null;
  let uso: Verificacion["uso"] = null;
  const fallo = (error: string): Verificacion => ({ estado: "error", error, permisos, nif_holded: nif, uso });

  for (const s of SONDAS) {
    const r = await holdedGet(clave, s.ruta, s.params, { fetch: opciones.fetch, timeoutMs: 10_000 });
    if (r.status === 200) {
      permisos[s.permiso] = true;
      const d = (r.datos ?? {}) as Record<string, unknown>;
      if (s.permiso === "cuenta" && typeof d.vat_number === "string") nif = d.vat_number;
      if (s.permiso === "uso") {
        uso = { periodo: typeof d.period === "string" ? d.period : null, usadas: num(d.usage), limite: num(d.limit) };
      }
    } else if (r.status === 403) {
      permisos[s.permiso] = false;
    } else if (r.status === 401) {
      return fallo("Holded rechaza la clave (401): no es válida o se ha revocado.");
    } else if (r.status === 429) {
      return fallo(r.ventana === "month"
        ? "La cuenta de Holded ha agotado su cupo mensual de llamadas a la API."
        : "Holded está limitando las llamadas (429): vuelve a verificar en un minuto.");
    } else if (r.status === 0) {
      return fallo("Holded no respondió a tiempo.");
    } else {
      return fallo(`Holded respondió con un error (${r.status}).`);
    }
  }
  const usados = ["facturas", "compras", "contactos", "bancos"];
  if (!usados.some((p) => permisos[p])) {
    return fallo("La clave no tiene permiso de lectura de facturas, compras, contactos ni bancos.");
  }
  return { estado: "ok", error: null, permisos, nif_holded: nif, uso };
}
