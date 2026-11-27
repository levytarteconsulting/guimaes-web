// Genera ejemplo-clientes.xlsx y ejemplo-clientes.csv con datos INVENTADOS
// (dominios .invalid, CIF y teléfonos ficticios), con los casos que el
// importador tiene que resolver. Uso: node generar-ejemplo.mjs
// El .xlsx se escribe a mano (zip + XML) para no depender de ninguna librería;
// mezcla textos compartidos, textos en línea y números, como hace Excel.
import fs from "node:fs";
import zlib from "node:zlib";

export const CABECERAS = ["Empresa", "CIF", "Dirección", "Contacto", "Empleados", "Email", "Teléfono",
  "Etapa", "Servicio", "Etapa", "Importe", "Frecuencia", "RESPONSABLE", "Prioridad"];

// [valor, "n"] = celda numérica. Todo inventado.
export const FILAS = [
  ["Talleres Ficticios SL", "B-111 111 11", "Av. Falsa 2, Madrid", "Laura Prueba", ["5", "n"], "LAURA@ejemplo.invalid", ["600222333", "n"], "Nuevo", "CFO Externo", "Cliente activo", ["1800", "n"], "Mensual", "Ana Inventada", "Alta"],
  ["Talleres Ficticios S.L.", "B11111111", "", "Óscar Demo", "", "", "611 444 555", "Oportunidad", "Planificación Fiscal", "Propuesta enviada", "3.200,50", "anual", "ana", "media"],
  ["Talleres Ficticios SL", "B11111111", "", "Laura Prueba", "", "laura@ejemplo.invalid", "", "", "CFO Externo", "Reunión", "", "", "", ""],
  ["Consultora Imaginaria SA", "A22222222", "C/ Inventada 9", "Laura Prueba", ["40", "n"], "laura@ejemplo.invalid", "", "", "Contable", "negociacion", ["0", "n"], "", "Mario", "baja"],
  ["Sin Cif Inventada SL", "", "", "Pedro Ejemplo", "3.0", "", "", "Cliente activo", "Legal y Cumplimiento", "Contactado", "650 €", "Puntual", "", ""],
  ["sin cif inventada sl", "", "", "pedro ejemplo", "", "", "", "", "", "", "", "", "", ""],
  ["Gestoría de Mentira SL", "b33333333", "Plaza Ficticia 1", "Marta Ensayo", ["12", "n"], "marta@ensayo.invalid", "600333444.0", "propuesta", "Asesoría Laboral", "Nueva solicitud", ["480", "n"], "MENSUAL", "Mario Prueba Apellido", ""],
  ["Gestoría de Mentira SL", "B33333333", "", "Marta Ensayo", "", "marta@ensayo.invalid", "", "", "Asesoría Laboral", "Reunión", ["500", "n"], "Mensual", "", ""],
  ["Exportaciones Simuladas SL", "B44444444", "", "", "", "", "", "", "Expansión LatAm", "Perdido", "", "Trimestral", "Ana", "Alta"],
  ["Datos Erróneos SL", "B55555555", "", "Error Uno", "muchos", "no-es-un-email", "", "Lead", "Servicio Inventado", "Ganado", "12,5", "Semanal", "Nadie", "Urgente"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
  ["Estudio Supuesto SL", "B66666666", "", "Rich Texto", "", "rich@texto.invalid", ["6.00555666E+8", "n"], "Perdido", "s6", "perdido", "", "puntual", "", "low"],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function hojaXml(filas) {
  const compartidos = []; const idx = new Map();
  const sst = (t) => { if (!idx.has(t)) { idx.set(t, compartidos.length); compartidos.push(t); } return idx.get(t); };
  let rows = "";
  filas.forEach((f, r) => {
    let cs = "";
    f.forEach((v, c) => {
      const ref = col(c) + (r + 1);
      if (Array.isArray(v)) { cs += `<c r="${ref}"><v>${esc(v[0])}</v></c>`; return; }
      if (v === "") return;                                   // hueco: sin celda
      if ((r + c) % 3 === 0) cs += `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
      else if (v === "Rich Texto") cs += `<c r="${ref}" t="s"><v>${sst("\u0000rich")}</v></c>`;
      else cs += `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
    });
    rows += `<row r="${r + 1}">${cs}</row>`;
  });
  const sis = compartidos.map((t) => t === "\u0000rich"
    ? `<si><r><rPr><b/></rPr><t>Rich</t></r><r><t xml:space="preserve"> Texto</t></r><rPh sb="0" eb="1"><t>リッチ</t></rPh></si>`
    : `<si><t xml:space="preserve">${esc(t)}</t></si>`).join("");
  return {
    hoja: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
    ss: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${compartidos.length}" uniqueCount="${compartidos.length}">${sis}</sst>`,
  };
}

function zip(entradas) {
  const locales = []; const centrales = []; let offset = 0;
  for (const [nombre, texto] of entradas) {
    const datos = Buffer.from(texto, "utf8");
    const comp = zlib.deflateRawSync(datos);
    const crc = zlib.crc32(datos);
    const n = Buffer.from(nombre, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(datos.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(datos.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locales.push(lh, n, comp); centrales.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrales);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entradas.length, 8); eocd.writeUInt16LE(entradas.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, cd, eocd]);
}

export function xlsx(filas) {
  const { hoja, ss } = hojaXml(filas);
  return zip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/hoja-clientes.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clientes" sheetId="1" r:id="rId7"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hoja-clientes.xml"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ["xl/worksheets/hoja-clientes.xml", hoja],
    ["xl/sharedStrings.xml", ss],
  ]);
}

export function csv(filas) {
  const q = (v) => { const s = Array.isArray(v) ? v[0] : v; return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + filas.map((f) => f.map(q).join(";")).join("\r\n") + "\r\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL(".", import.meta.url).pathname;
  fs.writeFileSync(dir + "ejemplo-clientes.xlsx", xlsx([CABECERAS, ...FILAS]));
  fs.writeFileSync(dir + "ejemplo-clientes.csv", csv([CABECERAS, ...FILAS.map((f) => f.map((v) => Array.isArray(v) ? v[0] : v))]));
  console.log("ok: ejemplo-clientes.xlsx y ejemplo-clientes.csv");
}
