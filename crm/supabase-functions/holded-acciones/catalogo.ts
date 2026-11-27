// Lista cerrada de operaciones de escritura de la API v2 de Holded, generada
// desde la especificación oficial (catalogo.json, ver
// crm/tests/holded/generar-catalogo.py). Una petición solo puede salir si
// casa con una de ellas: método exacto, ruta con sus parámetros validados
// (ids de 24 hexadecimales, valores de enumeración) y, si la operación los
// declara, parámetros de consulta conocidos.

import CATALOGO from "./catalogo.json" with { type: "json" };

export type Param = { tipo: "id" | "enum" | "texto"; valores?: string[]; obligatorio?: boolean };
export type Operacion = {
  id: string; metodo: "POST" | "PUT" | "PATCH" | "DELETE"; ruta: string; tema: string; resumen: string;
  riesgo: "normal" | "alto"; motivo_riesgo?: string; cuerpo: "json" | "ninguno"; cuerpo_obligatorio?: boolean;
  requeridos: string[]; params: Record<string, Param>; query?: Record<string, Param>; lectura: string | null; reemplaza_todo: boolean;
};
export const OPERACIONES_HOLDED = (CATALOGO as unknown as { operaciones: Operacion[] }).operaciones;
export const FUENTE_CATALOGO = (CATALOGO as unknown as { fuente: string; generado: string });

const HEX = "[0-9a-f]{24}";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const valorParam = (p: Param | undefined) =>
  !p || p.tipo === "id" ? HEX : p.tipo === "enum" ? `(?:${(p.valores ?? []).map(esc).join("|")})` : "[A-Za-z0-9_.%-]{1,64}";

/** Regex de una plantilla de ruta, con un grupo por parámetro. */
function patron(plantilla: string, params: Record<string, Param>) {
  const nombres: string[] = [];
  const re = plantilla.split(/(\{[^}]+\})/).map((t) => {
    const m = /^\{([^}]+)\}$/.exec(t);
    if (!m) return esc(t);
    nombres.push(m[1]);
    return `(${valorParam(params[m[1]])})`;
  }).join("");
  return { re: new RegExp(`^${re}$`), nombres };
}
const PATRONES = OPERACIONES_HOLDED.map((op) => ({ op, ...patron(op.ruta, op.params) }));
// Lecturas del estado anterior: GET de la plantilla «lectura» de cada operación.
const LECTURAS = [...new Set(OPERACIONES_HOLDED.map((o) => o.lectura).filter((x): x is string => !!x))].map((l) => {
  const op = OPERACIONES_HOLDED.find((o) => o.lectura === l)!;
  return patron(l, op.params).re;
});

export type Casada = { op: Operacion; params: Record<string, string> };

/** La operación del catálogo con la que casa (método, ruta y consulta), o null. */
export function encontrarOperacion(metodo: string, ruta: string): Casada | null {
  if (typeof metodo !== "string" || typeof ruta !== "string" || ruta.length > 400) return null;
  const [camino, consulta, ...resto] = ruta.split("?");
  if (resto.length) return null;
  const m = metodo.toUpperCase();
  for (const p of PATRONES) {
    if (p.op.metodo !== m) continue;
    const r = p.re.exec(camino);
    if (!r) continue;
    if (consulta !== undefined && consulta !== "") {
      const q = new URLSearchParams(consulta);
      const decl = p.op.query ?? {};
      for (const [k, v] of q) {
        const d = decl[k];
        if (!d || !new RegExp(`^${d.tipo === "texto" ? "[A-Za-z0-9_.:+-]{1,64}" : valorParam(d)}$`).test(v)) return null;
      }
    }
    return { op: p.op, params: Object.fromEntries(p.nombres.map((n, i) => [n, r[i + 1]])) };
  }
  return null;
}

/** Ruta GET para leer el documento afectado (estado anterior), o null. */
export function lecturaDe(c: Casada): string | null {
  if (!c.op.lectura) return null;
  const nombres = [...c.op.lectura.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (!nombres.length || nombres.some((n) => !c.params[n])) return null;
  return c.op.lectura.replace(/\{([^}]+)\}/g, (_, n) => c.params[n]);
}

/** Id del documento afectado: el último id de la ruta que lee «lectura» (o de la ruta). */
export function documentoDe(c: Casada): string | null {
  const desde = c.op.lectura ?? c.op.ruta;
  const ids = [...desde.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((n) => (c.op.params[n]?.tipo ?? "id") === "id" && c.params[n]);
  return ids.length ? c.params[ids.at(-1)!] : null;
}

export const esLecturaDeEstado = (camino: string) => LECTURAS.some((re) => re.test(camino));
