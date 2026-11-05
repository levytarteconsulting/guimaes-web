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
