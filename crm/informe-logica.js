// Lógica pura de los informes del asistente (gráficos SVG y PDF). Sin React ni
// DOM: se prueba con Node (tests/agente-panel/informe-logica.test.mjs).
// El informe llega ya validado por la función agente (supabase-functions/agente/informe.ts).

// Paleta categórica validada (orden fijo, nunca se recicla; ver la guía de visualización).
export const PALETA = ["#257de0", "#f47230", "#00b894", "#f2a600", "#ee7fac", "#008a17", "#6a4ce2", "#ec4647"];
export const TINTA = { texto: "#191919", suave: "#666666", rejilla: "#e6e6e6", eje: "#bdbdbd", fondo: "#ffffff" };
export const MAX_PORCIONES = 8;

const esEuro = (u) => /€|eur/i.test(String(u || ""));
const esPct = (u) => /%/.test(String(u || ""));
/** Número en español; € como moneda, % con el signo. */
export function fmtNum(n, unidad, compacto = false) {
  if (n === null || n === undefined || n === "") return "—";
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n);
  const opc = compacto && Math.abs(n) >= 10000
    ? { notation: "compact", maximumFractionDigits: 1 }
    : { maximumFractionDigits: Number.isInteger(n) ? 0 : 2, minimumFractionDigits: esEuro(unidad) && !Number.isInteger(n) ? 2 : 0 };
  if (esEuro(unidad)) return n.toLocaleString("es-ES", { style: "currency", currency: "EUR", ...opc });
  const s = n.toLocaleString("es-ES", opc);
  if (esPct(unidad)) return s + " %";
  return unidad ? `${s} ${unidad}` : s;
}

/** Marcas «bonitas» del eje: incluye el 0 y cubre [min, max]. */
export function marcasEje(min, max, n = 5) {
  let lo = Math.min(0, min), hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const bruto = (hi - lo) / n;
  const pot = Math.pow(10, Math.floor(Math.log10(bruto)));
  const paso = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= bruto) || 10 * pot;
  const desde = Math.floor(lo / paso) * paso, hasta = Math.ceil(hi / paso) * paso;
  const out = [];
  for (let v = desde; v <= hasta + paso / 2; v += paso) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Tarta: como mucho 8 porciones; el resto se agrupa en «Otros». Ordenadas de mayor a menor. */
export function porcionesTarta(etiquetas, valores) {
  const xs = etiquetas.map((e, i) => ({ etiqueta: e, valor: Math.max(0, Number(valores[i]) || 0) })).filter((x) => x.valor > 0)
    .sort((a, b) => b.valor - a.valor);
  const top = xs.length > MAX_PORCIONES ? xs.slice(0, MAX_PORCIONES - 1) : xs;
  if (xs.length > MAX_PORCIONES) top.push({ etiqueta: "Otros", valor: xs.slice(MAX_PORCIONES - 1).reduce((a, x) => a + x.valor, 0) });
  const total = top.reduce((a, x) => a + x.valor, 0) || 1;
  let a0 = -Math.PI / 2;
  return top.map((x, i) => {
    const ang = (x.valor / total) * 2 * Math.PI;
    const p = { ...x, color: PALETA[i], pct: x.valor / total, a0, a1: a0 + ang };
    a0 += ang;
    return p;
  });
}
/** Trazado SVG de una porción (sector) de la tarta. */
export function arco(cx, cy, r, a0, a1) {
  if (a1 - a0 >= 2 * Math.PI - 1e-9) return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`;
  const p = (a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M ${cx} ${cy} L ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z`;
}

/** Geometría de barras agrupadas o líneas en un área de ancho × alto. */
export function geometria(g, ancho, alto) {
  const m = { izq: 64, der: 12, arr: 12, aba: 44 };
  const todos = g.series.flatMap((s) => s.valores);
  const marcas = marcasEje(Math.min(...todos), Math.max(...todos));
  const lo = marcas[0], hi = marcas[marcas.length - 1];
  const w = ancho - m.izq - m.der, h = alto - m.arr - m.aba;
  const y = (v) => m.arr + h - ((v - lo) / (hi - lo)) * h;
  const n = g.etiquetas.length;
  const banda = w / n;
  const xCentro = (i) => m.izq + banda * (i + 0.5);
  const barras = [];
  if (g.tipo === "barras") {
    const ns = g.series.length;
    const grupo = Math.min(banda * 0.75, 48 * ns);
    const ancho1 = Math.max(2, (grupo - 2 * (ns - 1)) / ns);   // 2 px de separación entre barras
    g.series.forEach((s, k) => s.valores.forEach((v, i) => {
      const x = xCentro(i) - grupo / 2 + k * (ancho1 + 2);
      const y0 = y(0), y1 = y(v);
      barras.push({ serie: k, i, x, y: Math.min(y0, y1), w: ancho1, h: Math.max(1, Math.abs(y1 - y0)), positivo: v >= 0, valor: v });
    }));
  }
  const lineas = g.tipo === "lineas" ? g.series.map((s, k) => ({ serie: k, puntos: s.valores.map((v, i) => ({ x: xCentro(i), y: y(v), valor: v, i })) })) : [];
  // Etiquetas del eje X: si no caben, se muestra una de cada «salto».
  const salto = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(w / 56))));
  return { m, w, h, marcas, y, xCentro, banda, barras, lineas, salto };
}

/** Recorta un texto a n caracteres con «…». */
export const recortar = (t, n) => { const s = String(t ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** Nombre del PDF: «Informe - <título> - AAAA-MM-DD.pdf», sin caracteres raros. */
export function nombrePdf(titulo, fecha = new Date()) {
  const limpio = String(titulo || "informe").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "informe";
  const d = new Date(fecha);
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `Informe - ${limpio} - ${dia}.pdf`;
}

/** Anchos de columna (mm) proporcionales al contenido, con mínimo, que suman «total». */
export function anchosColumnas(columnas, filas, total) {
  const largo = columnas.map((c, j) => Math.min(40, Math.max(String(c).length, ...filas.map((f) => String(f[j] ?? "").length), 4)));
  const suma = largo.reduce((a, x) => a + x, 0);
  return largo.map((l) => (l / suma) * total);
}
/** ¿La columna es numérica? (para alinear a la derecha) */
export const columnaNumerica = (filas, j) => filas.length > 0 && filas.every((f) => f[j] === null || typeof f[j] === "number");

/** Celda para mostrar: números en formato español, sin añadir unidades (las pone el título de la columna). */
export function celda(v) {
  if (typeof v === "number") return fmtNum(v, "");
  return v === null || v === undefined ? "—" : String(v);
}

/** Petición para guardar: la última pregunta del usuario antes de la burbuja i. */
export function peticionDe(burbujas, i) {
  for (let k = i - 1; k >= 0; k--) if (burbujas[k] && burbujas[k].rol === "user") return burbujas[k].texto || "";
  return "";
}

// Las fuentes estándar de jsPDF (WinAnsi) dibujan Latin-1 y unos pocos signos más
// (€, comillas tipográficas, guiones, puntos suspensivos, viñeta). El resto
// (emojis, otros alfabetos) se quita o se aproxima para no salir como basura.
const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function textoPdf(s) {
  return String(s ?? "").normalize("NFC").replace(/ | /g, " ")
    .replace(/[≥]/g, ">=").replace(/[≤]/g, "<=").replace(/[→]/g, "->").replace(/[✓✔]/g, "OK")
    .split("").filter((c) => c.charCodeAt(0) <= 0xff || WINANSI_EXTRA.has(c)).join("")
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
}
