// Utilidades puras de la sección Instagram del CRM (sin React ni Supabase):
// fechas en hora de Madrid, contadores del texto, aviso legal, proporciones,
// calendario y CSV. Las usan crm/instagram.jsx y la subida de lotes.
// Pruebas: node --test crm/instagram-util.test.js

export const AVISO_LEGAL = "Información general: no sustituye el asesoramiento profesional.";
export const TZ = "Europe/Madrid";
export const MAX_CAPTION = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_MENCIONES = 20;
export const PROP_MIN = 0.799; // 4:5, con margen de redondeo (igual que instagram_revisar)
export const PROP_MAX = 1.912; // 1,91:1

// ---------------------------------------------------------------- fechas
const fmtPartes = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

// Fecha y hora de pared en Madrid de un instante.
export function madridPartes(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const o = {};
  for (const p of fmtPartes.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

const dos = (n) => String(n).padStart(2, "0");

// "AAAA-MM-DD" del día en Madrid.
export function madridDia(fecha) {
  if (!fecha) return "";
  const p = madridPartes(fecha);
  return `${p.y}-${dos(p.m)}-${dos(p.d)}`;
}

// Valor para <input type="datetime-local"> en hora de Madrid.
export function madridInput(fecha) {
  if (!fecha) return "";
  const p = madridPartes(fecha);
  return `${p.y}-${dos(p.m)}-${dos(p.d)}T${dos(p.h)}:${dos(p.mi)}`;
}

// Instante (ISO UTC) de una hora de pared en Madrid. Dos pasadas para los
// días de cambio de hora. Una hora que no existe (02:30 del último domingo
// de marzo) cae en la hora siguiente.
export function madridAUtc(y, m, d, h = 0, mi = 0) {
  const pared = Date.UTC(y, m - 1, d, h, mi);
  const desfase = (t) => {
    const p = madridPartes(new Date(t));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t;
  };
  let t = pared - desfase(pared);
  t = pared - desfase(t);
  return new Date(t).toISOString();
}

// "AAAA-MM-DD HH:MM" o "AAAA-MM-DDTHH:MM" (hora de Madrid) → ISO UTC, o null.
export function textoAUtc(s) {
  const m = String(s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null; // 31 de abril, etc.
  return madridAUtc(y, mo, d, h, mi);
}

export function fmtMadrid(fecha, opciones = { dateStyle: "medium", timeStyle: "short" }) {
  if (!fecha) return "—";
  return new Intl.DateTimeFormat("es-ES", { timeZone: TZ, ...opciones }).format(new Date(fecha));
}

// ---------------------------------------------------------------- texto
// Mismas reglas que instagram_normalizar / instagram_revisar (SQL).
export function normalizar(t) {
  return String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[\s  ]+/g, " ").trim();
}

export function contarHashtags(t) {
  return (String(t ?? "").match(/(^|[^\p{L}\p{N}_&])#[^\s#@]+/gu) || []).length;
}

export function contarMenciones(t) {
  return (String(t ?? "").match(/(^|[^\p{L}\p{N}_.@])@[\p{L}\p{N}._]+/gu) || []).length;
}

export function tieneAviso(t) {
  return normalizar(t).includes(normalizar(AVISO_LEGAL).replace(/\.$/, ""));
}

export function anadirAviso(t) {
  const s = String(t ?? "");
  if (tieneAviso(s)) return s;
  const base = s.replace(/\s+$/, "");
  return base ? `${base}\n\n${AVISO_LEGAL}` : AVISO_LEGAL;
}

// ---------------------------------------------------------------- láminas
export function proporcion(w, h) {
  const r = w / h;
  const ok = r >= PROP_MIN && r <= PROP_MAX;
  let nombre = r.toFixed(2).replace(".", ",") + ":1";
  if (Math.abs(r - 0.8) < 0.006) nombre = "4:5";
  else if (Math.abs(r - 1) < 0.006) nombre = "1:1";
  else if (Math.abs(r - 1.91) < 0.006) nombre = "1,91:1";
  return { r, ok, nombre };
}

// ---------------------------------------------------------------- calendario
// Semanas (lunes a domingo) que cubren el mes; cada día {key, d, enMes}.
export function mesCalendario(y, m) {
  const primero = new Date(Date.UTC(y, m - 1, 1));
  const desplaz = (primero.getUTCDay() + 6) % 7; // lunes = 0
  const inicio = Date.UTC(y, m - 1, 1 - desplaz);
  const semanas = [];
  for (let s = 0; s < 6; s++) {
    const semana = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(inicio + (s * 7 + i) * 86400000);
      semana.push({
        key: `${dt.getUTCFullYear()}-${dos(dt.getUTCMonth() + 1)}-${dos(dt.getUTCDate())}`,
        d: dt.getUTCDate(),
        enMes: dt.getUTCMonth() === m - 1,
      });
    }
    if (s >= 4 && !semana.some((x) => x.enMes)) break;
    semanas.push(semana);
  }
  return semanas;
}

export function mesSiguiente({ y, m }, delta) {
  const t = (y * 12 + (m - 1)) + delta;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

// ---------------------------------------------------------------- CSV
// Separador «;», BOM para Excel, CRLF. Comillas dobles cuando hace falta, y
// un apóstrofo delante de lo que Excel tomaría por fórmula.
export function csvCampo(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const METRICAS = [
  ["reach", "Alcance"], ["views", "Visualizaciones"], ["likes", "Me gusta"], ["comments", "Comentarios"],
  ["saved", "Guardados"], ["shares", "Compartidos"], ["total_interactions", "Interacciones"],
];

export function csvMetricas(posts) {
  const cab = ["Título", "Lote", "Publicada (Madrid)", "Enlace", "Láminas",
    ...METRICAS.map(([, n]) => n), "Métricas actualizadas (Madrid)", "Texto"];
  const filas = posts.map((p) => [
    p.titulo || "", p.lote || "",
    p.published_at ? fmtMadrid(p.published_at, { dateStyle: "short", timeStyle: "short" }) : "",
    p.permalink || "", (p.slides || []).length,
    ...METRICAS.map(([k]) => (typeof p.metrics?.[k] === "number" ? p.metrics[k] : null)),
    p.metrics_at ? fmtMadrid(p.metrics_at, { dateStyle: "short", timeStyle: "short" }) : "",
    p.caption || "",
  ]);
  return "﻿" + [cab, ...filas].map((f) => f.map(csvCampo).join(";")).join("\r\n") + "\r\n";
}

export function bytesTexto(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1).replace(".", ",") + " MB";
  return (n / 1073741824).toFixed(2).replace(".", ",") + " GB";
}

// ---------------------------------------------------------------- lotes
// Nombres de fichero: «01.jpg» es una imagen suelta; «01-1.jpg», «01-2.jpg»…
// forman un carrusel. La clave de la pieza es el número sin ceros a la
// izquierda (así «01» del CSV y «1» del fichero son la misma pieza).
export const EXT_IMAGEN = /\.(jpe?g|png|webp)$/i;
export const MAX_LAMINAS = 10;

export function clavePieza(s) {
  const t = String(s ?? "").trim();
  return /^\d+$/.test(t) ? String(Number(t)) : t.toLowerCase();
}

export function agruparFicheros(nombres) {
  const piezas = new Map();
  const ignorados = [];
  for (const nombre of nombres) {
    const base = String(nombre).split(/[\\/]/).pop();
    const m = base.match(/^(\d+)(?:-(\d+))?\.(jpe?g|png|webp)$/i);
    if (!m) { ignorados.push(base); continue; }
    const clave = clavePieza(m[1]);
    if (!piezas.has(clave)) piezas.set(clave, { clave, prefijo: m[1], sueltas: [], laminas: [] });
    const p = piezas.get(clave);
    if (m[2] === undefined) p.sueltas.push(base);
    else p.laminas.push({ nombre: base, n: Number(m[2]) });
  }
  const out = [];
  for (const p of piezas.values()) {
    const errores = [], avisos = [];
    let ficheros = [];
    if (p.sueltas.length && p.laminas.length) {
      errores.push(`Hay a la vez «${p.sueltas[0]}» y láminas de carrusel (${p.laminas.map((l) => l.nombre).join(", ")}): deja solo una de las dos formas.`);
    } else if (p.sueltas.length > 1) {
      errores.push(`Hay varios ficheros para la misma imagen suelta: ${p.sueltas.join(", ")}.`);
    } else if (p.sueltas.length === 1) {
      ficheros = [p.sueltas[0]];
    } else {
      const orden = [...p.laminas].sort((a, b) => a.n - b.n);
      const repetidas = orden.filter((l, i) => i > 0 && l.n === orden[i - 1].n);
      if (repetidas.length) errores.push(`Lámina repetida: ${repetidas.map((l) => l.nombre).join(", ")}.`);
      if (!repetidas.length && orden.some((l, i) => l.n !== i + 1)) avisos.push(`Las láminas no van seguidas (${orden.map((l) => l.n).join(", ")}): se publican en ese orden.`);
      if (orden.length === 1) avisos.push(`Solo hay una lámina (${orden[0].nombre}): se publicará como imagen suelta.`);
      ficheros = orden.map((l) => l.nombre);
    }
    out.push({ clave: p.clave, prefijo: p.prefijo, ficheros, errores, avisos });
  }
  out.sort((a, b) => (/^\d+$/.test(a.clave) && /^\d+$/.test(b.clave) ? Number(a.clave) - Number(b.clave) : a.clave.localeCompare(b.clave)));
  return { piezas: out, ignorados };
}

// CSV con separador «;» y comillas dobles (que pueden llevar «;», saltos de
// línea y "" para una comilla). Quita el BOM. Devuelve filas de campos.
export function parseCsv(texto) {
  const s = String(texto ?? "").replace(/^﻿/, "");
  const filas = [];
  let fila = [], campo = "", comillas = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (comillas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i += 2; continue; }
        comillas = false; i++; continue;
      }
      campo += c; i++; continue;
    }
    if (c === '"' && campo === "") { comillas = true; i++; continue; }
    if (c === ";") { fila.push(campo); campo = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      fila.push(campo); filas.push(fila); fila = []; campo = "";
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    campo += c; i++;
  }
  if (comillas) throw new Error("textos.csv: hay unas comillas sin cerrar.");
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((x) => x.trim() !== ""));
}

// textos.csv → {porPieza: Map(clave → {caption, fecha, fechaTexto, linea}), errores, avisos}
// Errores globales (cabecera) impiden usar el fichero; los de una fila se
// guardan en esa pieza (errorFila).
export function leerTextosCsv(texto) {
  const errores = [], avisos = [];
  const porPieza = new Map();
  let filas;
  try { filas = parseCsv(texto); } catch (e) { return { porPieza, errores: [e.message], avisos }; }
  if (!filas.length) return { porPieza, errores: ["textos.csv está vacío."], avisos };
  const cab = filas[0].map((h) => normalizar(h));
  const col = { pieza: cab.indexOf("pieza"), caption: cab.indexOf("caption"), fecha: cab.indexOf("fecha") };
  if (col.pieza < 0 || col.caption < 0) {
    return { porPieza, errores: ["La primera fila de textos.csv debe ser la cabecera pieza;caption;fecha (separada por «;»)."], avisos };
  }
  filas.slice(1).forEach((f, idx) => {
    const linea = idx + 2;
    const pieza = (f[col.pieza] ?? "").trim();
    if (!pieza) { avisos.push(`textos.csv, fila ${linea}: sin pieza, se ignora.`); return; }
    const clave = clavePieza(pieza);
    if (porPieza.has(clave)) { porPieza.get(clave).errorFila = `La pieza ${pieza} aparece más de una vez en textos.csv (filas ${porPieza.get(clave).linea} y ${linea}).`; return; }
    const caption = (f[col.caption] ?? "").replace(/\r\n/g, "\n");
    const fechaTexto = col.fecha >= 0 ? (f[col.fecha] ?? "").trim() : "";
    const fecha = fechaTexto ? textoAUtc(fechaTexto) : null;
    const r = { pieza, caption, fecha, fechaTexto, linea };
    if (fechaTexto && !fecha) r.errorFila = `Fecha no válida en textos.csv (fila ${linea}): «${fechaTexto}». Formato: AAAA-MM-DD HH:MM.`;
    porPieza.set(clave, r);
  });
  return { porPieza, errores, avisos };
}

// Fechas para las piezas sin fecha: una por día, en los días de la semana
// elegidos (0 = lunes … 6 = domingo) a la hora elegida, desde «desde»
// (AAAA-MM-DD), saltando los días ya ocupados (Set de AAAA-MM-DD en Madrid).
export function repartirFechas(n, { desde, dias, hora, ocupados = new Set() }) {
  if (!n) return [];
  if (!dias || !dias.length) throw new Error("Elige al menos un día de la semana.");
  const mh = String(hora).match(/^(\d{1,2}):(\d{2})$/);
  if (!mh) throw new Error("Hora no válida.");
  const md = String(desde).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!md) throw new Error("Fecha de inicio no válida.");
  const out = [];
  const usados = new Set(ocupados);
  let t = Date.UTC(+md[1], +md[2] - 1, +md[3]);
  for (let guard = 0; out.length < n && guard < 3660; guard++, t += 86400000) {
    const d = new Date(t);
    const dow = (d.getUTCDay() + 6) % 7;
    const key = `${d.getUTCFullYear()}-${dos(d.getUTCMonth() + 1)}-${dos(d.getUTCDate())}`;
    if (!dias.includes(dow) || usados.has(key)) continue;
    usados.add(key);
    out.push(madridAUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), +mh[1], +mh[2]));
  }
  return out;
}

// Medidas finales: como mucho 1440 px de ancho, sin agrandar.
export const ANCHO_MAX = 1440;
export function medidasFinales(w, h) {
  if (w <= ANCHO_MAX) return { w, h };
  return { w: ANCHO_MAX, h: Math.round((h * ANCHO_MAX) / w) };
}

// Número de láminas de una pieza (después de quitar o reordenar en el resumen).
export function erroresLaminas(n) {
  if (n === 0) return ["No quedan láminas."];
  if (n > MAX_LAMINAS) return [`Tiene ${n} láminas: un carrusel admite ${MAX_LAMINAS} como máximo.`];
  return [];
}

// ---------------------------------------------------------------- lotes por carpetas
// Orden natural: «2» antes que «10», sin distinguir mayúsculas ni tildes.
const colador = new Intl.Collator("es", { numeric: true, sensitivity: "base" });
export const ordenNatural = (a, b) => colador.compare(a, b);

const baseRuta = (r) => r.split("/").pop();
const dirRuta = (r) => r.split("/").slice(0, -1).join("/");
const dosCifras = (n) => String(n).padStart(2, "0");
const EXT_TXT = /\.txt$/i;
const EXT_CSV = /\.csv$/i;
const ES_CAPTION = /^caption\.txt$/i;
const CONVENCION = /^(\d+)(?:-(\d+))?\.(jpe?g|png|webp)$/i;

// Ficheros que el sistema crea solo (.DS_Store, ._foto.jpg, __MACOSX, Thumbs.db…).
export function esOculto(ruta) {
  const partes = String(ruta).split("/");
  return partes.some((s) => s.startsWith(".") || s === "__MACOSX") || /^(thumbs\.db|desktop\.ini)$/i.test(partes.at(-1));
}

// Texto de un caption.txt: UTF-8 con o sin BOM; saltos de línea normalizados.
// Acepta bytes (Uint8Array/ArrayBuffer) o texto ya leído.
export function leerCaption(contenido) {
  let texto, utf8 = true;
  if (typeof contenido === "string") texto = contenido;
  else {
    try { texto = new TextDecoder("utf-8", { fatal: true }).decode(contenido); }
    catch { utf8 = false; texto = new TextDecoder("utf-8").decode(contenido); }
  }
  return { texto: texto.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim(), utf8 };
}

// Qué .txt de una carpeta es el texto: caption.txt; si no hay, el único .txt.
function textoDeCarpeta(txts) {
  const cap = txts.find((t) => ES_CAPTION.test(baseRuta(t.rel)));
  if (cap) return { ruta: cap.ruta };
  if (txts.length === 1) return { ruta: txts[0].ruta };
  if (txts.length > 1) return { ruta: null, aviso: `Hay ${txts.length} ficheros .txt y ninguno se llama caption.txt: no se usa ninguno.` };
  return { ruta: null };
}

// Organiza lo soltado en piezas. «rutas» son rutas relativas con «/»
// (p. ej. «Lote nov/01 renta/1.png») o solo nombres si se eligieron ficheros.
//  - Con subcarpetas: cada carpeta con imágenes es una pieza (tipo «carpetas»).
//  - Sin subcarpetas y con la convención NN-M.jpg (o NN.jpg con textos.csv):
//    tipo «convencion», como antes.
//  - Si no: tipo «sueltas»; «modo» decide si son un carrusel o una
//    publicación por imagen (por defecto, carrusel si hay un caption.txt).
// Devuelve {tipo, raiz, piezas, csv, avisos, pideModo, modo}; cada pieza:
// {clave, nombre, slug, ficheros (rutas), texto (ruta del .txt o null),
//  errores, avisos, clavesCsv}.
export function organizarLote(entrada, { modo = null } = {}) {
  let items = entrada.map((r) => String(r).replace(/\\/g, "/").replace(/^\/+/, ""))
    .filter((r) => r && !esOculto(r)).map((ruta) => ({ ruta, rel: ruta }));
  // Carpeta principal: si todo cuelga de la misma, es el nombre del lote.
  let raiz = null;
  const primeros = new Set(items.map((f) => f.rel.split("/")[0]));
  if (items.length && primeros.size === 1 && items.every((f) => f.rel.includes("/"))) {
    raiz = [...primeros][0];
    items = items.map((f) => ({ ...f, rel: f.rel.slice(raiz.length + 1) }));
  }
  const imagenes = [], txts = [], csvs = [], otros = [];
  for (const f of items) {
    if (EXT_IMAGEN.test(f.rel)) imagenes.push(f);
    else if (EXT_TXT.test(f.rel)) txts.push(f);
    else if (EXT_CSV.test(f.rel) && !f.rel.includes("/")) csvs.push(f);
    else otros.push(f);
  }
  const avisos = [];
  if (otros.length) avisos.push(`Se ignoran (no son imagen ni .txt): ${otros.map((f) => f.rel).join(", ")}.`);
  csvs.sort((a, b) => Number(/^textos\.csv$/i.test(b.rel)) - Number(/^textos\.csv$/i.test(a.rel)) || ordenNatural(a.rel, b.rel));
  const csv = csvs.length ? csvs[0].ruta : null;
  if (csvs.length > 1) avisos.push(`Hay ${csvs.length} ficheros CSV; se usa «${csvs[0].rel}».`);
  if (csvs.length && !/^textos\.csv$/i.test(csvs[0].rel)) avisos.push(`El CSV se llama «${csvs[0].rel}» (lo esperado es textos.csv); se usa igualmente.`);
  const porRuta = (a, b) => ordenNatural(a.rel, b.rel);
  const res = (tipo, piezas, extra = {}) => ({ tipo, raiz, piezas, csv, avisos, pideModo: false, modo: null, ...extra });

  // 1) Subcarpetas: una pieza por carpeta con imágenes.
  if (imagenes.some((f) => f.rel.includes("/"))) {
    const porDir = new Map();
    for (const f of imagenes) {
      const d = dirRuta(f.rel);
      if (!d) continue;
      if (!porDir.has(d)) porDir.set(d, []);
      porDir.get(d).push(f);
    }
    const fuera = imagenes.filter((f) => !f.rel.includes("/"));
    if (fuera.length) avisos.push(`Se ignoran las imágenes que no están dentro de una subcarpeta: ${fuera.map((f) => f.rel).join(", ")}.`);
    const txtSobrantes = txts.filter((t) => !porDir.has(dirRuta(t.rel)));
    if (txtSobrantes.length) avisos.push(`Se ignoran (no están en una carpeta con imágenes): ${txtSobrantes.map((t) => t.rel).join(", ")}.`);
    const dirs = [...porDir.keys()].sort(ordenNatural);
    // Para textos.csv: la pieza es el nombre de la carpeta o, si empieza por un
    // número que no se repite («01 renta»), ese número.
    const numeros = new Map();
    const numDe = (d) => { const m = baseRuta(d).match(/^(\d+)(?=\D|$)/); return m ? clavePieza(m[1]) : null; };
    for (const d of dirs) { const n = numDe(d); if (n) numeros.set(n, (numeros.get(n) || 0) + 1); }
    const piezas = dirs.map((d, i) => {
      const t = textoDeCarpeta(txts.filter((x) => dirRuta(x.rel) === d));
      const clavesCsv = [clavePieza(baseRuta(d))];
      const n = numDe(d);
      if (n && numeros.get(n) === 1 && !clavesCsv.includes(n)) clavesCsv.push(n);
      return { clave: d, nombre: d, slug: dosCifras(i + 1), ficheros: porDir.get(d).sort(porRuta).map((f) => f.ruta),
        texto: t.ruta, errores: [], avisos: t.aviso ? [t.aviso] : [], clavesCsv };
    });
    return res("carpetas", piezas);
  }

  // 2) Convención NN-M.jpg / NN.jpg.
  const nombres = imagenes.map((f) => f.rel);
  const conv = nombres.length > 0 && nombres.every((n) => CONVENCION.test(n));
  const conGuion = nombres.some((n) => /^\d+-\d+\./.test(n));
  if (conv && (conGuion || (csv && !txts.length))) {
    if (txts.length) avisos.push(`Con nombres NN-M.jpg los textos van en textos.csv; se ignoran: ${txts.map((t) => t.rel).join(", ")}.`);
    const mapa = new Map(imagenes.map((f) => [f.rel, f.ruta]));
    const g = agruparFicheros(nombres);
    const piezas = g.piezas.map((p) => ({ clave: p.clave, nombre: p.prefijo, slug: p.prefijo, ficheros: p.ficheros.map((n) => mapa.get(n)),
      texto: null, errores: p.errores, avisos: p.avisos, clavesCsv: [p.clave] }));
    return res("convencion", piezas);
  }

  // 3) Imágenes sueltas: un carrusel o una publicación por imagen.
  const imgs = [...imagenes].sort(porRuta);
  const t = textoDeCarpeta(txts);
  const modoPorDefecto = txts.some((x) => ES_CAPTION.test(baseRuta(x.rel))) ? "carrusel" : "sueltas";
  const m = imgs.length <= 1 ? "carrusel" : (modo === "carrusel" || modo === "sueltas" ? modo : modoPorDefecto);
  let piezas;
  if (m === "carrusel") {
    piezas = imgs.length ? [{ clave: "carrusel", nombre: raiz || "Carrusel", slug: "01", ficheros: imgs.map((f) => f.ruta),
      texto: t.ruta, errores: [], avisos: t.aviso ? [t.aviso] : [], clavesCsv: [raiz ? clavePieza(raiz) : "1"] }] : [];
  } else {
    const usados = new Set();
    piezas = imgs.map((f, i) => {
      const sin = f.rel.replace(EXT_IMAGEN, "").toLowerCase();
      const propio = txts.find((x) => x.rel.toLowerCase() === sin + ".txt");
      if (propio) usados.add(propio.ruta);
      return { clave: f.rel, nombre: f.rel.replace(EXT_IMAGEN, ""), slug: dosCifras(i + 1), ficheros: [f.ruta],
        texto: propio ? propio.ruta : null, errores: [], avisos: [], clavesCsv: [clavePieza(sin)] };
    });
    const sinUsar = txts.filter((x) => !usados.has(x.ruta));
    if (sinUsar.length) avisos.push(`Con «Una publicación por imagen», cada imagen toma el texto del .txt con su mismo nombre (foto.jpg → foto.txt). No se usan: ${sinUsar.map((x) => x.rel).join(", ")}.`);
  }
  return res("sueltas", piezas, { pideModo: imgs.length > 1, modo: m });
}
