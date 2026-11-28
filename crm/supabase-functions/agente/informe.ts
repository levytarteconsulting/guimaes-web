// Herramienta mostrar_informe: el asistente enseña en el chat un informe con
// texto, tablas y gráficos (barras, líneas o tarta). No consulta nada: los
// datos tienen que salir de lo que han devuelto las demás herramientas en la
// conversación. Aquí solo se valida y se normaliza la forma; el CRM lo pinta
// (SVG), lo descarga en PDF con los logos, la fecha y la fuente, lo guarda en
// los documentos de una empresa o guarda la petición para regenerarlo.

export const TIPOS_GRAFICO = ["barras", "lineas", "tarta"] as const;
export const MAX_INFORME_BYTES = 60_000;

export type Celda = string | number | null;
export type Grafico = {
  tipo: typeof TIPOS_GRAFICO[number]; titulo?: string; unidad?: string;
  etiquetas: string[]; series: { nombre: string; valores: number[] }[];
};
export type Seccion =
  | { tipo: "texto"; texto: string }
  | { tipo: "tabla"; titulo?: string; columnas: string[]; filas: Celda[][] }
  | { tipo: "grafico"; grafico: Grafico };
export type Informe = { titulo: string; fuente: string; empresa_id?: string; secciones: Seccion[] };

/** Esquema JSON de "secciones" para la API (el modelo lo ve; aquí se vuelve a validar todo). */
export const ESQUEMA_SECCIONES = {
  type: "array",
  maxItems: 12,
  description: "Partes del informe, en orden. Cada una es texto, una tabla o un gráfico.",
  items: {
    type: "object",
    properties: {
      tipo: { type: "string", enum: ["texto", "tabla", "grafico"] },
      texto: { type: "string", description: "Solo tipo texto: párrafos breves (sin Markdown complejo)." },
      titulo: { type: "string", description: "Título de la tabla (opcional)." },
      columnas: { type: "array", items: { type: "string" }, description: "Solo tipo tabla: cabeceras." },
      filas: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } },
               description: "Solo tipo tabla: filas, con tantas celdas como columnas. Números como número." },
      grafico: {
        type: "object", description: "Solo tipo grafico.",
        properties: {
          tipo: { type: "string", enum: [...TIPOS_GRAFICO] },
          titulo: { type: "string" },
          unidad: { type: "string", description: "Unidad de los valores (€, nº, %…)." },
          etiquetas: { type: "array", items: { type: "string" }, description: "Categorías o periodos (eje X o porciones)." },
          series: { type: "array", items: { type: "object", properties: { nombre: { type: "string" }, valores: { type: "array", items: { type: "number" } } },
                                             required: ["nombre", "valores"] },
                    description: "Una o varias series con un valor por etiqueta. La tarta lleva una sola serie, sin negativos." },
        },
        required: ["tipo", "etiquetas", "series"],
      },
    },
    required: ["tipo"],
  },
} as const;

type R<T> = { ok: true; valor: T } | { ok: false; error: string };
const mal = (error: string): R<never> => ({ ok: false, error });
const txt = (v: unknown, max: number, campo: string, obligatorio = false): R<string | undefined> => {
  if (v === undefined || v === null || v === "") return obligatorio ? mal(`Falta "${campo}".`) : { ok: true, valor: undefined };
  if (typeof v !== "string") return mal(`"${campo}" tiene que ser texto.`);
  const t = v.replace(/\r\n/g, "\n").trim();
  if (!t) return obligatorio ? mal(`Falta "${campo}".`) : { ok: true, valor: undefined };
  if (t.length > max) return mal(`"${campo}": como mucho ${max} caracteres.`);
  return { ok: true, valor: t };
};

export function validarInforme(entrada: Record<string, unknown>): R<Informe> {
  if (new TextEncoder().encode(JSON.stringify(entrada)).length > MAX_INFORME_BYTES) return mal("El informe es demasiado grande: resume o agrupa los datos.");
  const titulo = txt(entrada.titulo, 200, "titulo", true); if (!titulo.ok) return titulo;
  const fuente = txt(entrada.fuente, 300, "fuente", true); if (!fuente.ok) return fuente;
  const secs = entrada.secciones;
  if (!Array.isArray(secs) || secs.length === 0) return mal('Falta "secciones" (al menos una).');
  if (secs.length > 12) return mal("Como mucho 12 secciones.");
  const secciones: Seccion[] = [];
  for (const [i, s] of secs.entries()) {
    const donde = `sección ${i + 1}`;
    if (!s || typeof s !== "object" || Array.isArray(s)) return mal(`${donde}: tiene que ser un objeto.`);
    const x = s as Record<string, unknown>;
    if (x.tipo === "texto") {
      const t = txt(x.texto, 4000, `${donde}: texto`, true); if (!t.ok) return t;
      secciones.push({ tipo: "texto", texto: t.valor! });
    } else if (x.tipo === "tabla") {
      const tt = txt(x.titulo, 120, `${donde}: titulo`); if (!tt.ok) return tt;
      if (!Array.isArray(x.columnas) || !x.columnas.length || x.columnas.length > 12) return mal(`${donde}: entre 1 y 12 columnas.`);
      const columnas: string[] = [];
      for (const c of x.columnas) { const r = txt(c, 60, `${donde}: columna`, true); if (!r.ok) return r; columnas.push(r.valor!); }
      if (!Array.isArray(x.filas) || x.filas.length > 200) return mal(`${donde}: "filas" tiene que ser una lista de como mucho 200.`);
      const filas: Celda[][] = [];
      for (const f of x.filas) {
        if (!Array.isArray(f) || f.length !== columnas.length) return mal(`${donde}: cada fila tiene que tener ${columnas.length} celdas.`);
        const fila: Celda[] = [];
        for (const c of f) {
          if (c === null || c === undefined || c === "") fila.push(null);
          else if (typeof c === "number") { if (!Number.isFinite(c)) return mal(`${donde}: número no válido.`); fila.push(c); }
          else if (typeof c === "string") { if (c.length > 200) return mal(`${donde}: celda de más de 200 caracteres.`); fila.push(c.trim()); }
          else return mal(`${donde}: las celdas son texto o número.`);
        }
        filas.push(fila);
      }
      secciones.push({ tipo: "tabla", ...(tt.valor ? { titulo: tt.valor } : {}), columnas, filas });
    } else if (x.tipo === "grafico") {
      const g = x.grafico as Record<string, unknown> | undefined;
      if (!g || typeof g !== "object" || Array.isArray(g)) return mal(`${donde}: falta "grafico".`);
      if (!TIPOS_GRAFICO.includes(g.tipo as never)) return mal(`${donde}: el tipo de gráfico es barras, lineas o tarta.`);
      const gt = txt(g.titulo, 120, `${donde}: titulo`); if (!gt.ok) return gt;
      const un = txt(g.unidad, 20, `${donde}: unidad`); if (!un.ok) return un;
      if (!Array.isArray(g.etiquetas) || !g.etiquetas.length || g.etiquetas.length > 60) return mal(`${donde}: entre 1 y 60 etiquetas.`);
      const etiquetas: string[] = [];
      for (const e of g.etiquetas) { const r = txt(typeof e === "number" ? String(e) : e, 60, `${donde}: etiqueta`, true); if (!r.ok) return r; etiquetas.push(r.valor!); }
      const tipo = g.tipo as Grafico["tipo"];
      if (!Array.isArray(g.series) || !g.series.length || g.series.length > 8) return mal(`${donde}: entre 1 y 8 series.`);
      if (tipo === "tarta" && g.series.length !== 1) return mal(`${donde}: la tarta lleva una sola serie.`);
      const series: Grafico["series"] = [];
      for (const se of g.series as Record<string, unknown>[]) {
        const n = txt(se?.nombre, 60, `${donde}: nombre de la serie`, true); if (!n.ok) return n;
        const vs = se?.valores;
        if (!Array.isArray(vs) || vs.length !== etiquetas.length) return mal(`${donde}: cada serie lleva un valor por etiqueta (${etiquetas.length}).`);
        if (vs.some((v) => typeof v !== "number" || !Number.isFinite(v))) return mal(`${donde}: los valores tienen que ser números.`);
        if (tipo === "tarta" && (vs as number[]).some((v) => v < 0)) return mal(`${donde}: la tarta no admite valores negativos.`);
        if (tipo === "tarta" && !(vs as number[]).some((v) => v > 0)) return mal(`${donde}: la tarta necesita algún valor mayor que 0.`);
        series.push({ nombre: n.valor!, valores: vs as number[] });
      }
      secciones.push({ tipo: "grafico", grafico: { tipo, ...(gt.valor ? { titulo: gt.valor } : {}), ...(un.valor ? { unidad: un.valor } : {}), etiquetas, series } });
    } else {
      return mal(`${donde}: el tipo es texto, tabla o grafico.`);
    }
  }
  const informe: Informe = { titulo: titulo.valor!, fuente: fuente.valor!, secciones };
  if (typeof entrada.empresa_id === "string") informe.empresa_id = entrada.empresa_id.toLowerCase();
  return { ok: true, valor: informe };
}
