// Saneado del HTML de los correos antes de guardarlo (correo_mensajes.cuerpo_html).
// Lista blanca de etiquetas y atributos; sin dependencias (se prueba con Node).
//
// Es la primera barrera. La segunda es el visor del CRM: iframe con sandbox
// (sin allow-scripts ni allow-same-origin) y CSP sin red salvo las imágenes
// que el usuario decida mostrar.
//
// Qué hace:
//   - quita comentarios, <!DOCTYPE>, <?xml?> y las etiquetas peligrosas con
//     todo su contenido (script, iframe, object, form, svg, math…);
//   - quita html/head/body/meta/link/base (deja su contenido; title y su
//     texto, fuera);
//   - las etiquetas desconocidas desaparecen, pero su texto se queda;
//   - atributos: solo los de la lista; sin on*; href solo http(s), mailto,
//     tel y anclas (#); los enlaces se abren aparte (target=_blank,
//     rel=noopener noreferrer);
//   - imágenes: cid: → data-cid (el visor las resuelve con la acción
//     adjunto); http(s) → data-src-externa (el visor solo las pone al pulsar
//     "Mostrar imágenes"); data:image/(png|jpeg|gif|webp) se quedan; el resto,
//     sin src;
//   - style (atributo y <style>): sin expression(), javascript:, behavior,
//     -moz-binding ni @import;
//   - vuelve a escribir todas las etiquetas y escapa el texto suelto, así que
//     lo que sale es HTML bien formado a nivel de etiqueta.

const ELIMINAR_CON_CONTENIDO = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript",
  "template", "form", "svg", "math", "title", "textarea", "select", "button", "noembed", "noframes", "xmp",
]);
const QUITAR_ETIQUETA = new Set(["html", "head", "body", "meta", "link", "base"]);
const PERMITIDAS = new Set([
  "a", "abbr", "address", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike",
  "strong", "style", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "wbr",
]);
const VACIAS = new Set(["br", "hr", "img", "col", "wbr"]);
const ATRIBUTOS = new Set([
  "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing",
  "colspan", "rowspan", "dir", "lang", "title", "alt", "face", "size", "span", "start", "type",
  "summary", "headers", "scope", "class", "style", "nowrap",
]);
export const MAX_HTML = 1_000_000; // caracteres; más grande → aviso en vez de cuerpo

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", colon: ":", tab: "\t", newline: "\n" };

export function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTIDADES[e.toLowerCase()] ?? m;
  });
}
export function escapar(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Texto suelto: escapa < y > pero conserva las entidades que ya traiga.
function escaparTexto(s: string): string {
  return s.replace(/&(?!(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Para comparar esquemas: sin espacios ni caracteres de control.
function compacto(s: string): string {
  return decodificar(s).replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200f\u2028\u2029\ufeff]/g, "").toLowerCase();
}

export function sanearCss(css: string): string {
  const c = compacto(css);
  if (/expression\(|javascript:|vbscript:|behavior:|-moz-binding|@import/.test(c)) {
    return decodificar(css)
      .replace(/expression\s*\(/gi, "x(")
      .replace(/(java|vb)script\s*:/gi, "")
      .replace(/behavior\s*:/gi, "x:")
      .replace(/-moz-binding/gi, "x")
      .replace(/@import[^;]*;?/gi, "");
  }
  return css;
}

function href(v: string): string | null {
  const c = compacto(v);
  if (/^(https?:|mailto:|tel:|#)/.test(c)) return decodificar(v).trim();
  return null;
}

function atributosDe(etiqueta: string, crudo: string): string {
  const salida: string[] = [];
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  const vistos = new Set<string>();
  while ((m = re.exec(crudo))) {
    const nombre = m[1].toLowerCase();
    const valor = m[2] ?? m[3] ?? m[4] ?? "";
    if (vistos.has(nombre)) continue;
    vistos.add(nombre);
    if (etiqueta === "a" && nombre === "href") {
      const h = href(valor);
      if (h !== null) salida.push(`href="${escapar(h)}"`);
      continue;
    }
    if (etiqueta === "img" && nombre === "src") {
      const c = compacto(valor);
      const d = decodificar(valor).trim();
      if (c.startsWith("cid:")) salida.push(`data-cid="${escapar(d.slice(d.indexOf(":") + 1))}"`);
      else if (/^https?:/.test(c)) salida.push(`data-src-externa="${escapar(d)}"`);
      else if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+\/=\s]*$/i.test(d)) salida.push(`src="${escapar(d)}"`);
      continue;
    }
    if (!ATRIBUTOS.has(nombre)) continue;
    const v = nombre === "style" ? sanearCss(decodificar(valor)) : decodificar(valor);
    salida.push(`${nombre}="${escapar(v)}"`);
  }
  if (etiqueta === "a") salida.push('target="_blank"', 'rel="noopener noreferrer"');
  return salida.length ? " " + salida.join(" ") : "";
}

export function sanearHtml(html: string): string {
  if (!html) return "";
  if (html.length > MAX_HTML) {
    return "<p><em>El cuerpo de este correo es demasiado grande para mostrarlo en el CRM. Ábrelo en Outlook.</em></p>";
  }
  const s = html.replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/g, "")
    .replace(/<![^>]*>/g, "").replace(/<\?[\s\S]*?(\?>|$)/g, "");
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let out = "";
  let ultimo = 0;
  let m: RegExpExecArray | null;
  const abiertas: string[] = [];
  while ((m = re.exec(s))) {
    out += escaparTexto(s.slice(ultimo, m.index));
    ultimo = re.lastIndex;
    const cierre = m[1] === "/";
    const nombre = m[2].toLowerCase();
    if (!cierre && ELIMINAR_CON_CONTENIDO.has(nombre)) {
      // Salta hasta su cierre (o hasta el final).
      const fin = new RegExp(`</${nombre}\\s*>`, "ig");
      fin.lastIndex = ultimo;
      const f = fin.exec(s);
      ultimo = f ? fin.lastIndex : s.length;
      re.lastIndex = ultimo;
      continue;
    }
    if (QUITAR_ETIQUETA.has(nombre) || !PERMITIDAS.has(nombre)) continue;
    if (nombre === "style") {
      if (cierre) continue;
      const fin = /<\/style\s*>/ig;
      fin.lastIndex = ultimo;
      const f = fin.exec(s);
      const css = s.slice(ultimo, f ? f.index : s.length);
      ultimo = f ? fin.lastIndex : s.length;
      re.lastIndex = ultimo;
      out += `<style>${sanearCss(css).replace(/</g, "\\3c ")}</style>`;
      continue;
    }
    if (cierre) {
      if (VACIAS.has(nombre)) continue;
      const i = abiertas.lastIndexOf(nombre);
      if (i === -1) continue;
      // Cierra también las que quedaran abiertas dentro.
      while (abiertas.length > i) out += `</${abiertas.pop()}>`;
      continue;
    }
    out += `<${nombre}${atributosDe(nombre, m[3])}>`;
    if (!VACIAS.has(nombre)) abiertas.push(nombre);
  }
  out += escaparTexto(s.slice(ultimo));
  while (abiertas.length) out += `</${abiertas.pop()}>`;
  return out;
}

// Texto plano escrito en el CRM → HTML del correo que se envía.
export function textoAHtml(texto: string): string {
  const parrafos = String(texto ?? "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  return parrafos.map((p) => `<p>${escapar(p).replace(/\n/g, "<br>")}</p>`).join("\n");
}
