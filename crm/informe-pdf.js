// PDF de un informe del asistente, en el navegador, con jsPDF (se carga solo
// al pulsar «Descargar PDF» o «Guardar en documentos»: va en su propio
// trozo de dist/assets). A4 vertical: logo de Guimaes, fecha y hora de
// generación, título y fuente; después texto, tablas (con cabecera repetida
// en cada página) y los gráficos tal como se ven en el chat (el SVG se pasa a
// imagen). Pie en cada página con la fuente y el número de página.
import { PALETA, anchosColumnas, celda, columnaNumerica, nombrePdf, textoPdf } from "./informe-logica.js";

const MARGEN = 15;
let logoCache = null;

async function logo() {
  if (logoCache) return logoCache;
  const r = await fetch("/assets/guimaes-logo.png", { cache: "force-cache" });
  if (!r.ok) throw new Error("No se ha podido cargar el logo");
  const blob = await r.blob();
  logoCache = await new Promise((ok, no) => { const f = new FileReader(); f.onload = () => ok(f.result); f.onerror = no; f.readAsDataURL(blob); });
  return logoCache;
}

/** SVG del chat → PNG (dataURL) a doble resolución, con fondo blanco. */
async function svgAPng(svg) {
  const w = Number(svg.getAttribute("width")) || svg.clientWidth || 560;
  const h = Number(svg.getAttribute("height")) || svg.clientHeight || 260;
  const copia = svg.cloneNode(true);
  copia.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copia.setAttribute("width", String(w)); copia.setAttribute("height", String(h));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copia)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("No se ha podido convertir el gráfico")); i.src = url; });
    const c = document.createElement("canvas");
    c.width = w * 2; c.height = h * 2;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { png: c.toDataURL("image/png"), w, h };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * informe: { titulo, fuente, secciones } (validado por la función agente).
 * graficos: los <svg> de la tarjeta, en el orden de las secciones de tipo gráfico.
 * Devuelve { blob, nombre }.
 */
export async function generarPdf(informe, graficos = [], ahora = new Date()) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const ancho = W - 2 * MARGEN;
  const fecha = ahora.toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Madrid" });
  const T = (s) => textoPdf(s);
  const img = await logo();

  const cabecera = () => {
    doc.addImage(img, "PNG", MARGEN, 10, 45, 45 * 509 / 2860);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(102);
    doc.text(T(`Generado el ${fecha}`), W - MARGEN, 14, { align: "right" });
    doc.setDrawColor(220); doc.line(MARGEN, 21, W - MARGEN, 21);
    return 28;
  };
  let y = cabecera();
  const salto = (alto) => { if (y + alto > H - 18) { doc.addPage(); y = cabecera(); return true; } return false; };

  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(25);
  for (const l of doc.splitTextToSize(T(informe.titulo), ancho)) { salto(7); doc.text(l, MARGEN, y); y += 7; }
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(102);
  for (const l of doc.splitTextToSize(T(`Fuente: ${informe.fuente}`), ancho)) { salto(4.5); doc.text(l, MARGEN, y); y += 4.5; }
  y += 4;

  let g = 0;
  for (const s of informe.secciones) {
    if (s.tipo === "texto") {
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(25);
      for (const parrafo of String(s.texto).split(/\n{2,}/)) {
        for (const l of doc.splitTextToSize(T(parrafo.replace(/\n/g, " ").replace(/\*\*|__/g, "")), ancho)) { salto(5); doc.text(l, MARGEN, y); y += 5; }
        y += 2;
      }
      y += 2;
    } else if (s.tipo === "tabla") {
      const anchos = anchosColumnas(s.columnas, s.filas, ancho);
      const num = s.columnas.map((_, j) => columnaNumerica(s.filas, j));
      const fila = (celdas, negrita) => {
        doc.setFont("helvetica", negrita ? "bold" : "normal"); doc.setFontSize(8.5);
        const lineas = celdas.map((c, j) => doc.splitTextToSize(T(c), anchos[j] - 2));
        return { lineas, alto: Math.max(...lineas.map((l) => l.length)) * 3.8 + 2.4 };
      };
      const pintar = (f, negrita) => {
        doc.setFont("helvetica", negrita ? "bold" : "normal"); doc.setFontSize(8.5);
        if (negrita) { doc.setFillColor(242, 242, 242); doc.rect(MARGEN, y, ancho, f.alto, "F"); }
        let x = MARGEN;
        f.lineas.forEach((ls, j) => {
          ls.forEach((l, k) => doc.text(l, num[j] ? x + anchos[j] - 1 : x + 1, y + 3.6 + k * 3.8, { align: num[j] ? "right" : "left" }));
          x += anchos[j];
        });
        y += f.alto;
        doc.setDrawColor(230); doc.line(MARGEN, y, MARGEN + ancho, y);
      };
      if (s.titulo) { doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(25); salto(12); doc.text(T(s.titulo), MARGEN, y + 4); y += 7; }
      doc.setTextColor(25);
      const cab = fila(s.columnas, true);
      salto(cab.alto + 6); pintar(cab, true);
      for (const f of s.filas) {
        const r = fila(f.map((c) => celda(c)), false);
        if (salto(r.alto)) pintar(cab, true);
        pintar(r, false);
      }
      y += 6;
    } else if (s.tipo === "grafico") {
      const svg = graficos[g++];
      if (!svg) continue;
      const gr = s.grafico;
      const { png, w, h } = await svgAPng(svg);
      const alto = ancho * h / w;
      const conLeyenda = gr.tipo !== "tarta" && gr.series.length > 1;
      salto(alto + (gr.titulo ? 7 : 0) + (conLeyenda ? 7 : 0) + 4);
      if (gr.titulo) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor(25);
        doc.text(T(gr.titulo + (gr.unidad ? ` (${gr.unidad})` : "")), MARGEN, y + 4); y += 7;
      }
      doc.addImage(png, "PNG", MARGEN, y, ancho, alto);
      y += alto + 1;
      if (conLeyenda) {   // misma leyenda que en el chat (allí es HTML, fuera del SVG)
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(80);
        let x = MARGEN;
        gr.series.forEach((se, k) => {
          const nombre = T(se.nombre), anchoT = doc.getTextWidth(nombre);
          if (x + 5 + anchoT > MARGEN + ancho) { x = MARGEN; y += 4.5; }
          const [r, g2, b2] = PALETA[k].match(/\w\w/g).map((c) => parseInt(c, 16));
          doc.setFillColor(r, g2, b2); doc.roundedRect(x, y + 0.6, 2.8, 2.8, 0.5, 0.5, "F");
          doc.text(nombre, x + 4, y + 3.2);
          x += 4 + anchoT + 6;
        });
        y += 6;
      }
      y += 5;
    }
  }

  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(140);
    doc.line(MARGEN, H - 13, W - MARGEN, H - 13);
    doc.text(doc.splitTextToSize(T(`GUIMAES · Fuente: ${informe.fuente}`), ancho - 30)[0], MARGEN, H - 9);
    doc.text(`Página ${i} de ${n}`, W - MARGEN, H - 9, { align: "right" });
  }
  return { blob: doc.output("blob"), nombre: nombrePdf(informe.titulo, ahora) };
}
