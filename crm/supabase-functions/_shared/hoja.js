// Lector de .csv y .xlsx sin dependencias para las Edge Functions.
// COPIA LITERAL de la parte "CSV" + "XLSX" de crm/importador-util.js (el
// importador del CRM): hoja_test.ts falla si dejan de coincidir.
// deno-lint-ignore-file
// ---------------------------------------------------------------- CSV
export function leerCsv(texto) {
  let t = String(texto || "");
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const primera = t.split(/\r?\n/, 1)[0] || "";
  const cuenta = (c) => primera.split(c).length - 1;
  const sep = [";", ",", "\t"].sort((a, b) => cuenta(b) - cuenta(a))[0];
  const filas = []; let fila = []; let campo = ""; let comillas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (comillas) {
      if (ch === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else comillas = false; }
      else campo += ch;
    } else if (ch === '"' && campo === "") comillas = true;
    else if (ch === sep) { fila.push(campo); campo = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else campo += ch;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return quitarVacias(filas);
}

function quitarVacias(filas) {
  const out = filas.map((f) => f.map((c) => String(c == null ? "" : c)));
  while (out.length && out[out.length - 1].every((c) => !c.trim())) out.pop();
  return out;
}

// ---------------------------------------------------------------- XLSX
async function inflar(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Índice de un zip: nombre → {metodo, tam, offset}. Lee el directorio central.
function indiceZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("El archivo no es un .xlsx válido");
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const idx = {};
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("El archivo no es un .xlsx válido");
    const metodo = dv.getUint16(p + 10, true);
    const tam = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const nombre = dec.decode(buf.subarray(p + 46, p + 46 + ln));
    idx[nombre] = { metodo, tam, offset };
    p += 46 + ln + le + lc;
  }
  return { idx, dv };
}

async function leerEntrada(buf, zip, nombre) {
  const e = zip.idx[nombre];
  if (!e) return null;
  const dv = zip.dv;
  if (dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error("El archivo no es un .xlsx válido");
  const ini = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const datos = buf.subarray(ini, ini + e.tam);
  let bytes;
  if (e.metodo === 0) bytes = datos;
  else if (e.metodo === 8) bytes = await inflar(datos);
  else throw new Error("Compresión del .xlsx no soportada");
  return new TextDecoder().decode(bytes);
}

export function entidades(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&"; if (l === "lt") return "<"; if (l === "gt") return ">";
    if (l === "quot") return '"'; if (l === "apos") return "'";
    const cp = l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
  }).replace(/_x([0-9a-f]{4})_/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}
const atributo = (tag, nombre) => {
  const m = tag.match(new RegExp(`\\s${nombre}="([^"]*)"`));
  return m ? entidades(m[1]) : null;
};
// Texto de un <si> o <is>: todos los <t> salvo los de pronunciación (<rPh>).
function textoRico(xml) {
  const sin = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of sin.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += entidades(m[1]);
  return out;
}
function columnaDeRef(ref) {
  const m = /^([A-Z]+)/.exec(ref || ""); if (!m) return -1;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
// Excel guarda los números como texto en <v>; los muy grandes pueden venir
// en notación científica (6.00111222E+8): se pasan a dígitos.
function numeroATexto(v) {
  if (!/e/i.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : v;
}

export async function leerXlsx(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const zip = indiceZip(buf);
  // Primera hoja según el libro (y sus relaciones); si no, sheet1.xml.
  let ruta = "xl/worksheets/sheet1.xml";
  const libro = await leerEntrada(buf, zip, "xl/workbook.xml");
  const rels = await leerEntrada(buf, zip, "xl/_rels/workbook.xml.rels");
  if (libro && rels) {
    const hoja = libro.match(/<sheet\b[^>]*>/);
    const rid = hoja && (atributo(hoja[0], "r:id") || atributo(hoja[0], "id"));
    if (rid) {
      for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (atributo(m[0], "Id") === rid) {
          let t = atributo(m[0], "Target") || "";
          t = t.startsWith("/") ? t.slice(1) : "xl/" + t;
          if (zip.idx[t]) ruta = t;
        }
      }
    }
  }
  const compartidos = [];
  const ss = await leerEntrada(buf, zip, "xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g)) compartidos.push(m[1] ? textoRico(m[1]) : "");
  const hojaXml = await leerEntrada(buf, zip, ruta);
  if (!hojaXml) throw new Error("El .xlsx no tiene ninguna hoja");
  const filas = [];
  for (const mf of hojaXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const r = atributo(" " + (mf[1] || mf[3] || ""), "r");
    const nf = r ? parseInt(r, 10) - 1 : filas.length;
    const fila = [];
    let col = 0;
    for (const mc of (mf[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = " " + mc[1];
      const ref = atributo(at, "r");
      if (ref) col = columnaDeRef(ref);
      const tipo = atributo(at, "t");
      const cuerpo = mc[2] || "";
      const v = (cuerpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = "";
      if (tipo === "s") val = compartidos[parseInt(v, 10)] ?? "";
      else if (tipo === "inlineStr") val = textoRico((cuerpo.match(/<is>([\s\S]*?)<\/is>/) || [, ""])[1]);
      else if (tipo === "b") val = v === "1" ? "VERDADERO" : v === "0" ? "FALSO" : "";
      else if (v != null) val = tipo === "str" || tipo === "e" ? entidades(v) : numeroATexto(entidades(v));
      while (fila.length < col) fila.push("");
      fila[col] = val;
      col++;
    }
    while (filas.length < nf) filas.push([]);
    filas[nf] = fila;
  }
  return quitarVacias(filas);
}

