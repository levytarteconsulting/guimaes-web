// GUIMAES CRM — Utilidades puras de la sección Correo (sin React ni red).
// Pruebas: node --test correo-util.test.js (desde crm/).

export const ALIAS = "info@guimaes.es";

const norm = (s) => String(s ?? "").trim().toLowerCase();

// Mensajes (filas de correo_mensajes) → conversaciones ordenadas por el
// último mensaje. Los mensajes de cada conversación van de más antiguo a más
// reciente. Sin conversation_id, cada mensaje es su propia conversación.
export function agruparConversaciones(mensajes) {
  const porId = new Map();
  for (const m of mensajes ?? []) {
    const id = m.conversation_id || "m:" + m.id;
    if (!porId.has(id)) porId.set(id, []);
    porId.get(id).push(m);
  }
  const convs = [];
  for (const [id, ms] of porId) {
    ms.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.id).localeCompare(String(b.id)));
    const ultimo = ms[ms.length - 1];
    const contacto = [...ms].reverse().find((m) => m.contact_id)?.contact_id ?? null;
    const empresa = [...ms].reverse().find((m) => m.empresa_id)?.empresa_id ?? null;
    convs.push({
      id,
      mensajes: ms,
      ultimo,
      asunto: (ms.find((m) => m.carpeta === "inbox") ?? ms[0]).asunto || "(sin asunto)",
      noLeidos: ms.filter((m) => m.carpeta === "inbox" && !m.leido).length,
      contact_id: contacto,
      empresa_id: empresa,
      enInbox: ms.some((m) => m.carpeta === "inbox"),
      enEnviados: ms.some((m) => m.carpeta === "sentitems"),
      adjuntos: ms.some((m) => m.tiene_adjuntos),
    });
  }
  convs.sort((a, b) => String(b.ultimo.fecha).localeCompare(String(a.ultimo.fecha)));
  return convs;
}

// Filtro de la bandeja: "inbox" | "sentitems" | "sin_vincular".
export function filtrarConversaciones(convs, filtro) {
  if (filtro === "sentitems") return convs.filter((c) => c.enEnviados);
  if (filtro === "sin_vincular") return convs.filter((c) => c.enInbox && !c.contact_id);
  return convs.filter((c) => c.enInbox);
}

// Con quién es la conversación: el remitente si es recibido; si es enviado,
// el primer destinatario que no sea el propio buzón.
export function contraparte(m) {
  if (!m) return { email: "", nombre: "" };
  if (m.carpeta === "inbox") return { email: m.remitente_email || "", nombre: m.remitente_nombre || "" };
  const d = [...(m.para ?? []), ...(m.cc ?? [])].find((r) => norm(r.email) !== ALIAS);
  return { email: d?.email || "", nombre: d?.nombre || "" };
}

// Mensaje al que se responde: el último recibido que siga en la bandeja; si
// no hay, el último recibido. Solo se responde a recibidos.
export function mensajeParaResponder(conv) {
  const recibidos = (conv?.mensajes ?? []).filter((m) => m.carpeta === "inbox");
  return [...recibidos].reverse().find((m) => !m.fuera_bandeja) ?? recibidos[recibidos.length - 1] ?? null;
}

export function listaEmails(texto) {
  return String(texto ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export function emailsInvalidos(lista) {
  return lista.filter((e) => !EMAIL_RE.test(e));
}

export function destinatariosTexto(lista) {
  return (lista ?? []).map((r) => (r.nombre ? `${r.nombre} <${r.email}>` : r.email)).join(", ");
}

const desescapar = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escaparAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// cid de las imágenes incrustadas (el servidor ya las dejó en data-cid).
export function cidsDe(html) {
  const out = new Set();
  for (const m of String(html ?? "").matchAll(/\sdata-cid="([^"]*)"/g)) out.add(desescapar(m[1]));
  return [...out];
}
export function tieneExternas(html) {
  return /\sdata-src-externa="/.test(String(html ?? ""));
}

// Documento para el iframe del visor (sandbox sin scripts). La CSP no deja
// cargar nada de la red salvo, si se pide, las imágenes externas.
//   cidUrls: { cid → blob: URL } de las imágenes incrustadas ya descargadas.
export function documentoVisor(html, { mostrarExternas = false, cidUrls = {} } = {}) {
  let cuerpo = String(html ?? "")
    .replace(/\sdata-cid="([^"]*)"/g, (m, v) => {
      const url = cidUrls[desescapar(v)];
      return url && /^blob:/.test(url) ? ` src="${escaparAttr(url)}"` : m;
    });
  if (mostrarExternas) {
    cuerpo = cuerpo.replace(/\sdata-src-externa="([^"]*)"/g, (m, v) => {
      const url = desescapar(v);
      return /^https?:\/\//i.test(url) ? ` src="${escaparAttr(url)}"` : m;
    });
  }
  const img = ["data:", "blob:"].concat(mostrarExternas ? ["https:", "http:"] : []).join(" ");
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<base target="_blank">`
    + `<style>html,body{margin:0;padding:0;background:#fff;color:#1b2430;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;word-wrap:break-word;}`
    + `body{padding:2px 2px 8px;}img{max-width:100%;height:auto;}table{max-width:100%;}pre{white-space:pre-wrap;}</style>`
    + `</head><body>${cuerpo}</body></html>`;
}

export function fmtFechaCorreo(iso, ahora = new Date()) {
  if (!iso) return "";
  const d = new Date(iso);
  const mismoDia = d.toDateString() === ahora.toDateString();
  if (mismoDia) return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  const mismoAno = d.getFullYear() === ahora.getFullYear();
  return d.toLocaleDateString("es-ES", mismoAno ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
export function fmtFechaLarga(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function fmtTamano(b) {
  if (b == null) return "";
  if (b < 1024) return b + " B";
  if (b < 1048576) return Math.round(b / 1024) + " KB";
  return (b / 1048576).toFixed(1).replace(".", ",") + " MB";
}

// ---------------------------------------------------------------- redactor
export const MAX_DIRECTO = 3 * 1024 * 1024;  // hasta aquí, un adjunto va en una sola petición
export const MAX_TOTAL = 25 * 1024 * 1024;   // límite de adjuntos por correo
const PROPIOS = new Set([ALIAS, "administracion@guimaes.es"]);
const sinTildes = (s) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "");

// Lo que se está escribiendo en un campo de destinatarios: lo que va tras la última coma o punto y coma.
export function tokenActual(texto) {
  const s = String(texto ?? "");
  return s.slice(Math.max(s.lastIndexOf(","), s.lastIndexOf(";")) + 1).trim();
}
// Cambia lo que se está escribiendo por el email elegido y deja ", " para el siguiente.
export function completarToken(texto, email) {
  const s = String(texto ?? "");
  const corte = Math.max(s.lastIndexOf(","), s.lastIndexOf(";")) + 1;
  const antes = s.slice(0, corte).trim();
  return (antes ? antes + " " : "") + email + ", ";
}
// Contactos del CRM (con email) cuyo nombre, empresa o email contienen la consulta,
// sin los que ya están en el campo. Primero los que empiezan por la consulta.
export function sugerirContactos(contactos, consulta, yaPuestos = [], max = 8) {
  const q = sinTildes(consulta);
  if (q.length < 2) return [];
  const ya = new Set(yaPuestos.map(norm));
  const vistos = new Set();
  const out = [];
  for (const c of contactos ?? []) {
    const email = norm(c.email);
    if (!email || ya.has(email) || vistos.has(email)) continue;
    const campos = [c.full_name, c.company, c.email].map(sinTildes);
    const pos = Math.min(...campos.map((x) => { const i = x.indexOf(q); return i < 0 ? Infinity : (i === 0 || x[i - 1] === " " ? 0 : 1); }));
    if (pos === Infinity) continue;
    vistos.add(email);
    out.push({ pos, nombre: c.full_name || c.company || "", email: c.email.trim() });
  }
  out.sort((a, b) => a.pos - b.pos || a.nombre.localeCompare(b.nombre, "es"));
  return out.slice(0, max).map(({ nombre, email }) => ({ nombre, email }));
}

// Destinatarios por defecto al responder (como Outlook): al remitente; a todos,
// además el resto de Para en Para y los CC en CC, sin el propio buzón ni repetidos.
export function destinatariosRespuesta(m, todos) {
  if (!m) return { para: [], cc: [] };
  const vistos = new Set(PROPIOS);
  const tomar = (xs) => {
    const out = [];
    for (const e of xs) { const k = norm(e); if (k && !vistos.has(k)) { vistos.add(k); out.push(String(e).trim()); } }
    return out;
  };
  const para = tomar([m.remitente_email, ...(todos ? (m.para ?? []).map((r) => r.email) : [])]);
  const cc = todos ? tomar((m.cc ?? []).map((r) => r.email)) : [];
  return { para, cc };
}
export function asuntoDe(asunto, tipo) {
  const a = String(asunto ?? "").trim();
  if (tipo === "reenvio") return /^(rv|fw|fwd)\s*:/i.test(a) ? a : "RV: " + a;
  if (tipo === "respuesta" || tipo === "respuesta_todos") return /^re\s*:/i.test(a) ? a : "RE: " + a;
  return a;
}

const escHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export function firmaPorDefecto(nombre) {
  const n = String(nombre ?? "").trim();
  return (n ? `<p><b>${escHtml(n)}</b><br>` : "<p>")
    + `Guimaes · <a href="mailto:${ALIAS}">${ALIAS}</a> · 637 420 068 · <a href="https://guimaes.es">guimaes.es</a></p>`;
}

// Trozos [desde, largo] de una subida por sesión.
export function trozos(tamano, trozo) {
  const out = [];
  for (let d = 0; d < tamano; d += trozo) out.push([d, Math.min(trozo, tamano - d)]);
  return out;
}
export function totalBytes(...listas) {
  return listas.flat().reduce((a, x) => a + (Number(x?.tamano) || 0), 0);
}

// Enlace del editor: http(s) o mailto; un dominio suelto se completa con https://.
export function urlEnlace(texto) {
  let s = String(texto ?? "").trim();
  if (!s) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) s = "mailto:" + s;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!["http:", "https:", "mailto:"].includes(u.protocol)) return null;
    if (u.protocol !== "mailto:" && !/\./.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}

// ¿Hay texto escrito (sin contar la firma)? html: el del editor.
export function textoPlano(html) {
  return String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
