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
