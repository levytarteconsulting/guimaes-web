// holded_documentacion: referencia resumida de la API v2 de Holded para el
// asistente (holded-referencia.json, generada desde la especificación
// oficial por crm/tests/holded/generar-catalogo.py). Se responde aquí mismo,
// sin llamar a Holded: rutas, campos obligatorios, campos y ejemplos de cada
// operación de escritura, y las lecturas de cada tema (de dónde salen ids).

import REF from "./holded-referencia.json" with { type: "json" };

type Op = { operacion: string; metodo: string; ruta: string; resumen: string; riesgo: string; descripcion?: string;
            requeridos: string[]; campos: Record<string, string>; ejemplo?: unknown; query?: string[]; reemplaza_todo?: boolean };
const R = REF as unknown as { fuente: string; generado: string; temas: Record<string, Op[]>; lecturas: Record<string, string[]>; excluidas: string[] };
export const MAX_RESPUESTA = 14_000;
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

const tamaño = (x: unknown) => JSON.stringify(x).length;
/** Recorta una lista de operaciones para que quepa: primero ejemplos, luego descripciones de campos. */
function caber(ops: Op[]): { operaciones: unknown[]; recortado: boolean } {
  let out: Op[] = ops;
  if (tamaño(out) <= MAX_RESPUESTA) return { operaciones: out, recortado: false };
  out = ops.map(({ ejemplo: _e, ...o }) => o as Op);
  if (tamaño(out) <= MAX_RESPUESTA) return { operaciones: out, recortado: true };
  out = out.map((o) => ({ ...o, descripcion: undefined, campos: Object.fromEntries(Object.entries(o.campos).map(([k, v]) => [k, v.slice(0, 70)])) }));
  if (tamaño(out) <= MAX_RESPUESTA) return { operaciones: out, recortado: true };
  return { operaciones: out.map((o) => ({ operacion: o.operacion, metodo: o.metodo, ruta: o.ruta, resumen: o.resumen, riesgo: o.riesgo, requeridos: o.requeridos })), recortado: true };
}

export function consultarDocumentacion(args: { tema?: string; operacion?: string }): Record<string, unknown> {
  const base = { fuente: R.fuente, generado: R.generado };
  if (args.operacion) {
    const q = norm(args.operacion).replace(/\s+/g, " ");
    for (const [tema, ops] of Object.entries(R.temas)) {
      const o = ops.find((x) => norm(x.operacion) === q || norm(`${x.metodo} ${x.ruta}`) === q);
      if (o) return { ...base, tema, operacion: o, lecturas: R.lecturas[tema] ?? [] };
    }
    return { ...base, error: `No hay ninguna operación "${args.operacion}". Pide un tema para ver sus operaciones.`, temas: Object.keys(R.temas) };
  }
  if (!args.tema) {
    return { ...base, temas: Object.entries(R.temas).map(([t, ops]) => ({ tema: t, operaciones: ops.length })),
             nota: "Pide un tema (por ejemplo \"Facturas\" o \"Contactos\") para ver sus operaciones, campos obligatorios y ejemplos.",
             excluidas: R.excluidas };
  }
  const q = norm(args.tema);
  const tema = Object.keys(R.temas).find((t) => norm(t) === q) ?? Object.keys(R.temas).find((t) => norm(t).includes(q) || q.includes(norm(t)));
  if (tema) {
    const { operaciones, recortado } = caber(R.temas[tema]);
    return { ...base, tema, operaciones, lecturas: R.lecturas[tema] ?? [],
             ...(recortado ? { nota: "Resumen recortado: pide una operación concreta (operacion) para ver todos sus campos y el ejemplo." } : {}) };
  }
  // Búsqueda libre por palabras en ruta y resumen.
  const palabras = q.split(/\s+/).filter((p) => p.length > 2);
  const hallados = Object.entries(R.temas).flatMap(([t, ops]) => ops.map((o) => ({ t, o })))
    .filter(({ o }) => palabras.some((p) => norm(`${o.ruta} ${o.resumen}`).includes(p))).slice(0, 8);
  if (!hallados.length) return { ...base, error: `No hay ningún tema "${args.tema}".`, temas: Object.keys(R.temas) };
  const { operaciones, recortado } = caber(hallados.map((h) => h.o));
  return { ...base, busqueda: args.tema, temas_encontrados: [...new Set(hallados.map((h) => h.t))], operaciones,
           ...(recortado ? { nota: "Resumen recortado: pide una operación concreta para ver todos sus campos." } : {}) };
}
