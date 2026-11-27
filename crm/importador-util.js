/* GUIMAES CRM — Importador de clientes: lógica sin React (probada en
   crm/tests/importador/importador-util.test.mjs).
   - leerXlsx / leerCsv: archivo → filas (arrays de textos). Sin dependencias:
     un .xlsx es un zip con XML; se descomprime con DecompressionStream.
   - CAMPOS / mapeoInicial: correspondencia columna → campo del CRM.
   - construirFilas: normaliza cada fila y casa los valores con los catálogos
     del CRM (sin tildes ni mayúsculas). Lo que no casa es un error de la fila.
   La base de datos vuelve a validar todo y resuelve los duplicados
   (admin_importar_clientes en crm/supabase-importador.sql). */

// ---------------------------------------------------------------- texto
export function norm(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}
const limpio = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

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

// ---------------------------------------------------------------- columnas
export const CAMPOS = [
  { id: "empresa", label: "Empresa", alias: ["empresa", "razon social", "nombre empresa", "sociedad"] },
  { id: "cif", label: "CIF", alias: ["cif", "nif", "cif/nif", "cif / nif"] },
  { id: "direccion", label: "Dirección", alias: ["direccion", "domicilio"] },
  { id: "contacto", label: "Contacto", alias: ["contacto", "nombre contacto", "persona de contacto", "nombre"] },
  { id: "empleados", label: "Empleados", alias: ["empleados", "n empleados", "nº empleados", "numero de empleados", "trabajadores"] },
  { id: "email", label: "Email", alias: ["email", "e-mail", "correo", "correo electronico", "mail"] },
  { id: "telefono", label: "Teléfono", alias: ["telefono", "tel", "tlf", "movil", "telefono movil"] },
  { id: "etapa_contacto", label: "Etapa (del contacto)", alias: ["etapa del contacto", "etapa contacto", "ciclo de vida", "etapa"] },
  { id: "servicio", label: "Servicio", alias: ["servicio"] },
  { id: "etapa_negocio", label: "Etapa (del negocio)", alias: ["etapa del negocio", "etapa negocio", "etapa deal", "etapa"] },
  { id: "importe", label: "Importe", alias: ["importe", "precio", "honorarios", "cuota"] },
  { id: "frecuencia", label: "Frecuencia", alias: ["frecuencia", "periodicidad"] },
  { id: "responsable", label: "Responsable", alias: ["responsable", "owner", "asesor"] },
  { id: "prioridad", label: "Prioridad", alias: ["prioridad"] },
];

// Correspondencia inicial: por nombre de cabecera (la primera "Etapa" es la
// del contacto y la segunda la del negocio); lo que no se encuentre por
// nombre, por la posición del orden habitual.
export function mapeoInicial(cabeceras) {
  const h = (cabeceras || []).map(norm);
  const usadas = new Set();
  const mapa = {};
  for (const c of CAMPOS) {
    let idx = -1;
    for (const a of c.alias) {
      idx = h.findIndex((x, i) => !usadas.has(i) && x === norm(a));
      if (idx >= 0) break;
    }
    if (idx >= 0) { mapa[c.id] = idx; usadas.add(idx); }
  }
  CAMPOS.forEach((c, pos) => {
    if (mapa[c.id] === undefined && pos < h.length && !usadas.has(pos) && !h[pos]) { mapa[c.id] = pos; usadas.add(pos); }
  });
  for (const c of CAMPOS) if (mapa[c.id] === undefined) mapa[c.id] = -1;
  return mapa;
}

// ---------------------------------------------------------------- normalizar
export const normCif = (s) => String(s || "").toUpperCase().replace(/[\s.\-]/g, "");
export const normEmail = (s) => String(s || "").trim().toLowerCase();
export function normTelefono(s) {
  let t = String(s || "").trim();
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(t)) t = numeroATexto(t);   // 6.00111222E+8 (número de Excel)
  return t.replace(/\.0+$/, "").replace(/\D/g, "");
}
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;

// Entero (admite "12", "12.0", "12,0"); null si vacío; NaN si no es entero.
export function leerEntero(s) {
  const t = String(s == null ? "" : s).trim();
  if (!t) return null;
  const m = /^(\d{1,7})(?:[.,]0+)?$/.exec(t);
  return m ? parseInt(m[1], 10) : NaN;
}
// Importe: "1800", "1.800,50", "1800.5", "1,800.50", "650 €". Vacío o 0 → null.
// Devuelve {valor, dudoso}: dudoso si "1.800" se lee como 1800.
export function leerImporte(s) {
  let t = String(s == null ? "" : s).replace(/[€\s]/g, "").replace(/eur$/i, "");
  if (!t) return { valor: null };
  let dudoso = false;
  const ultPunto = t.lastIndexOf("."), ultComa = t.lastIndexOf(",");
  if (ultPunto >= 0 && ultComa >= 0) {
    const dec = ultPunto > ultComa ? "." : ",";
    const mil = dec === "." ? "," : ".";
    t = t.split(mil).join("").replace(dec, ".");
  } else if (ultComa >= 0) {
    t = (t.match(/,/g).length > 1) ? t.split(",").join("") : t.replace(",", ".");
  } else if (ultPunto >= 0) {
    if ((t.match(/\./g).length > 1)) t = t.split(".").join("");
    else if (/^\d{1,3}\.\d{3}$/.test(t)) { t = t.replace(".", ""); dudoso = true; }
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return { valor: NaN };
  const n = Number(t);
  return { valor: n === 0 ? null : n, dudoso };
}

// ---------------------------------------------------------------- catálogos
// cat: [{id, label|name, short?}] → id o null. Sin tildes ni mayúsculas.
export function casar(valor, cat, extra) {
  const v = norm(valor);
  if (!v) return null;
  for (const x of cat) {
    const nombres = [x.id, x.label, x.name, x.short, ...((extra && extra[x.id]) || [])].filter(Boolean).map(norm);
    if (nombres.includes(v)) return x.id;
  }
  return null;
}
export const FRECUENCIAS = [
  { id: "mensual", label: "Mensual" }, { id: "trimestral", label: "Trimestral" },
  { id: "anual", label: "Anual" }, { id: "puntual", label: "Puntual" },
];

// Responsable → id de admin activo. "Guillermo Guimaes" casa con "Guillermo":
// 1) nombre completo igual; 2) todas las palabras del nombre del admin están
// en el texto; 3) mismo nombre de pila. Solo si el resultado es único.
export function casarAdmin(texto, admins) {
  const t = norm(texto);
  if (!t) return { id: null };
  const activos = (admins || []).filter((a) => a.activo !== false);
  const unico = (lista) => (lista.length === 1 ? lista[0].id : null);
  const exacto = activos.filter((a) => norm(a.name) === t);
  if (exacto.length) return { id: unico(exacto), ambiguo: exacto.length > 1 };
  const palabras = new Set(t.split(" "));
  const contenidos = activos.filter((a) => norm(a.name) && norm(a.name).split(" ").every((w) => palabras.has(w)));
  if (contenidos.length) return { id: unico(contenidos), ambiguo: contenidos.length > 1 };
  const pila = activos.filter((a) => norm(a.name).split(" ")[0] === t.split(" ")[0]);
  return { id: unico(pila), ambiguo: pila.length > 1 };
}

// ---------------------------------------------------------------- filas
// filas: todas las del archivo (la 0 son las cabeceras). Devuelve
// [{fila, datos (para la RPC) | null, errores:[], avisos:[]}] — fila es el
// número de fila del Excel. Las filas vacías se saltan.
export function construirFilas(filas, mapa, cat) {
  const out = [];
  const get = (f, id) => (mapa[id] >= 0 ? limpio(f[mapa[id]]) : "");
  for (let i = 1; i < filas.length; i++) {
    const f = filas[i] || [];
    if (f.every((c) => !String(c || "").trim())) continue;
    const errores = [], avisos = [];
    const val = (id) => get(f, id);

    const empresa = { nombre: val("empresa"), cif: normCif(val("cif")), direccion: val("direccion"), empleados: "" };
    if (!empresa.nombre) errores.push("Falta el nombre de la empresa");
    const emp = leerEntero(val("empleados"));
    if (Number.isNaN(emp)) errores.push(`Empleados «${val("empleados")}» no es un número entero`);
    else if (emp != null) empresa.empleados = String(emp);

    const email = normEmail(val("email"));
    if (email && !EMAIL_RE.test(email)) errores.push(`Email «${val("email")}» con formato inválido`);
    const contacto = { nombre: val("contacto"), email, telefono: normTelefono(val("telefono")), etapa: "", owner: "" };
    const etC = val("etapa_contacto");
    if (etC) {
      const id = casar(etC, cat.lifecycle);
      if (id) contacto.etapa = id; else errores.push(`Etapa del contacto «${etC}» no casa con el CRM`);
    }

    const responsable = val("responsable");
    let owner = "";
    if (responsable) {
      const r = casarAdmin(responsable, cat.admins);
      if (r.id) owner = r.id;
      else errores.push(r.ambiguo ? `Responsable «${responsable}» casa con varios usuarios` : `Responsable «${responsable}» no casa con ningún usuario activo`);
    }

    const negocio = { servicio: "", etapa: "", importe: "", frecuencia: "", owner, prioridad: "" };
    const sv = val("servicio"), etN = val("etapa_negocio"), imp = val("importe"), fr = val("frecuencia"), pr = val("prioridad");
    if (sv) { const id = casar(sv, cat.servicios); if (id) negocio.servicio = id; else errores.push(`Servicio «${sv}» no casa con el catálogo`); }
    if (etN) { const id = casar(etN, cat.etapas); if (id) negocio.etapa = id; else errores.push(`Etapa del negocio «${etN}» no casa con el CRM`); }
    if (fr) { const id = casar(fr, FRECUENCIAS); if (id) negocio.frecuencia = id; else errores.push(`Frecuencia «${fr}» no casa con el CRM`); }
    if (pr) { const id = casar(pr, cat.prioridades); if (id) negocio.prioridad = id; else errores.push(`Prioridad «${pr}» no casa con el CRM`); }
    if (imp) {
      const r = leerImporte(imp);
      if (Number.isNaN(r.valor)) errores.push(`Importe «${imp}» no es un número`);
      else {
        negocio.importe = r.valor == null ? "" : String(r.valor);
        if (r.dudoso) avisos.push(`Importe «${imp}» leído como ${r.valor}`);
      }
    }
    const hayNegocio = !!(sv || etN || imp || fr || pr);
    if (hayNegocio && !sv) errores.push("Falta el servicio del negocio");
    if (hayNegocio && !etN) errores.push("Falta la etapa del negocio");
    const hayContacto = !!(contacto.nombre || contacto.email || contacto.telefono);
    if (hayContacto) contacto.owner = owner;
    if (!hayContacto && etC) avisos.push("Etapa del contacto sin nombre, email ni teléfono: no se crea contacto");
    if (responsable && !hayNegocio && !hayContacto) avisos.push("Responsable sin contacto ni negocio: no se usa");

    out.push({
      fila: i + 1, errores, avisos,
      datos: errores.length ? null : { fila: i + 1, empresa, contacto: hayContacto ? contacto : null, negocio: hayNegocio ? negocio : null },
    });
  }
  return out;
}

// Junta lo de construirFilas con la respuesta de la RPC: lista por fila de
// errores y avisos (solo las filas que tienen alguno), ordenada por fila.
export function incidencias(locales, rpcFilas) {
  const m = new Map();
  for (const l of locales) if (l.errores.length || l.avisos.length) m.set(l.fila, { fila: l.fila, errores: [...l.errores], avisos: [...l.avisos] });
  for (const r of rpcFilas || []) {
    const x = m.get(r.fila) || { fila: r.fila, errores: [], avisos: [] };
    for (const e of r.errores || []) if (!x.errores.includes(e)) x.errores.push(e);
    for (const a of r.avisos || []) if (!x.avisos.includes(a)) x.avisos.push(a);
    if (x.errores.length || x.avisos.length) m.set(r.fila, x);
  }
  return [...m.values()].sort((a, b) => a.fila - b.fila);
}
