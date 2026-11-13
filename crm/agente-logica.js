/* GUIMAES CRM — Asistente: lógica sin React (SSE, markdown, enlaces, errores).
   La usa crm/agente.jsx; tests en crm/tests/agente-panel/ (node --test).
   Nada de aquí produce HTML: el markdown se convierte en un árbol de nodos que
   agente.jsx pinta con elementos de React, así que el texto del modelo nunca
   se interpreta como HTML. */

/* ---------------- SSE ---------------- */
// Lector incremental de text/event-stream: se le pasan trozos de texto tal
// como llegan y devuelve los eventos completos. Ignora comentarios (": ping").
export function crearLectorSSE() {
  let resto = "";
  return function leer(trozo) {
    resto += trozo.replace(/\r\n?/g, "\n");
    const eventos = [];
    let corte;
    while ((corte = resto.indexOf("\n\n")) !== -1) {
      const bloque = resto.slice(0, corte);
      resto = resto.slice(corte + 2);
      let evento = "message";
      const datos = [];
      for (const linea of bloque.split("\n")) {
        if (!linea || linea.startsWith(":")) continue;
        const i = linea.indexOf(":");
        const campo = i === -1 ? linea : linea.slice(0, i);
        let valor = i === -1 ? "" : linea.slice(i + 1);
        if (valor.startsWith(" ")) valor = valor.slice(1);
        if (campo === "event") evento = valor;
        else if (campo === "data") datos.push(valor);
      }
      if (!datos.length) continue;
      let data;
      try { data = JSON.parse(datos.join("\n")); } catch { continue; }
      eventos.push({ evento, data });
    }
    return eventos;
  };
}

/* ---------------- Errores ---------------- */
// Mensaje para el usuario a partir de la respuesta HTTP (antes del stream).
export function mensajeDeError(status, cuerpo) {
  const delServidor = cuerpo && typeof cuerpo.error === "string" ? cuerpo.error : "";
  switch (status) {
    case 429: return delServidor || "Has llegado al máximo de preguntas por hoy. Mañana se renueva.";
    case 409: return delServidor || "Esta conversación ya es muy larga: empieza una nueva.";
    case 401: return "Tu sesión ha caducado. Vuelve a entrar en el CRM.";
    case 403: return "Tu usuario no tiene acceso al asistente.";
    case 404: return "No se encuentra esa conversación. Empieza una nueva.";
    case 400: return delServidor || "La pregunta no es válida.";
    case 503: return delServidor || "El asistente todavía no está disponible.";
    default: return "El asistente no responde ahora mismo. Inténtalo de nuevo en un momento.";
  }
}
export const MENSAJE_RED = "No hay conexión con el asistente. Revisa tu conexión a internet e inténtalo de nuevo.";
export const MENSAJE_CORTE = "Se ha cortado la conexión antes de terminar la respuesta. Inténtalo de nuevo.";

// Aviso según el motivo del evento "fin" (null si terminó bien).
export function avisoDeFin(motivo) {
  switch (motivo) {
    case "fin": return null;
    case "cancelado": return "Has cancelado la respuesta.";
    case "plazo": return "Se ha agotado el tiempo de esta respuesta. Prueba con una pregunta más concreta.";
    case "vueltas": return "La consulta necesitaba demasiados pasos. Prueba con una pregunta más concreta.";
    case "max_tokens": return "La respuesta era demasiado larga y se ha cortado. Pide algo más concreto.";
    case "rechazo": return "El asistente no puede responder a esta pregunta.";
    case "error": return null; // ya llega un evento "error" con su mensaje
    default: return null;
  }
}

/* ---------------- Herramientas ---------------- */
const NOMBRES_HERRAMIENTAS = {
  buscar: "Buscando en el CRM",
  ficha_empresa: "Consultando la ficha de la empresa",
  ficha_contacto: "Consultando la ficha del contacto",
  listar_deals: "Consultando el pipeline",
  listar_tareas: "Consultando las tareas",
  listar_documentos: "Consultando los documentos",
  listar_conversaciones_whatsapp: "Consultando WhatsApp",
  leer_whatsapp: "Leyendo la conversación de WhatsApp",
  buscar_correos: "Buscando en el correo",
  leer_correo: "Leyendo el correo",
  listar_leads: "Consultando las solicitudes",
  resumen_actividad: "Preparando el resumen de actividad",
};
export function etiquetaHerramienta(nombre) {
  return NOMBRES_HERRAMIENTAS[nombre] || "Consultando";
}

/* ---------------- Enlaces ---------------- */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (s) => typeof s === "string" && RE_UUID.test(s);

// "crm:empresa/ID" → destino de nav(); null si no es un enlace del CRM válido.
const VISTA_DE = { empresa: "empresa", contacto: "contact", deal: "deal", whatsapp: "whatsapp" };
export function destinoCrm(href) {
  const m = /^crm:([a-z]+)\/([^/?#\s]+)$/.exec(href || "");
  if (!m || !esUuid(m[2])) return null;
  if (m[1] === "correo") return { name: "inbox", id: null }; // la bandeja no abre un correo por id
  const name = VISTA_DE[m[1]];
  return name ? { name, id: m[2] } : null;
}
// "doc:ID" → id del documento; null si no es un enlace doc: con uuid válido.
export function idDocumento(href) {
  const m = /^doc:([^/?#\s]+)$/.exec(href || "");
  return m && esUuid(m[1]) ? m[1].toLowerCase() : null;
}
// Ids de documento enlazados en un texto (para pedir sus datos de una vez).
export function idsDocumentos(texto) {
  const out = new Set();
  const re = /\]\((doc:[^)\s]{1,100})\)/g;
  let m;
  while ((m = re.exec(texto || ""))) { const id = idDocumento(m[1]); if (id) out.add(id); }
  return [...out];
}
// Qué se puede hacer con un documento enlazado. doc: fila de documentos
// (CRM.loadDocumentosPorIds), null si no existe o no se puede leer,
// undefined si aún se está cargando.
export function estadoDocumento(doc) {
  if (doc === undefined) return { acciones: false, aviso: null, cargando: true };
  if (doc === null) return { acciones: false, aviso: "No encontrado" };
  switch (doc.status) {
    case "stored": return { acciones: true, aviso: null };
    case "pending": return { acciones: false, aviso: "Aún descargándose" };
    case "failed": return { acciones: false, aviso: "No se pudo descargar" };
    case "too_large": return { acciones: false, aviso: "Demasiado grande" };
    default: return { acciones: false, aviso: "No disponible" };
  }
}
// Solo http(s): nada de javascript:, data:, etc.
export function urlExterna(href) {
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
}

/* ---------------- Contexto de la vista ---------------- */
export function contextoDeVista(view) {
  if (!view || typeof view.name !== "string" || !/^[a-z_]{1,40}$/.test(view.name)) return null;
  const c = { vista: view.name };
  if (esUuid(view.id)) c.id = view.id;
  return c;
}

/* ---------------- Markdown mínimo ---------------- */
// Nodos en línea: {t:"texto",v} {t:"negrita",h:[…]} {t:"cursiva",h:[…]}
// {t:"codigo",v} {t:"crm",v,destino} {t:"url",v,href}
export function enLinea(texto) {
  const out = [];
  let buf = "";
  const vaciar = () => { if (buf) { out.push({ t: "texto", v: buf }); buf = ""; } };
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    if (c === "`") {
      const fin = texto.indexOf("`", i + 1);
      if (fin > i + 1) { vaciar(); out.push({ t: "codigo", v: texto.slice(i + 1, fin) }); i = fin + 1; continue; }
    }
    if (c === "*" && texto[i + 1] === "*") {
      const fin = texto.indexOf("**", i + 2);
      if (fin > i + 2) { vaciar(); out.push({ t: "negrita", h: enLinea(texto.slice(i + 2, fin)) }); i = fin + 2; continue; }
    }
    if ((c === "*" || c === "_") && texto[i + 1] !== c && texto[i + 1] !== " ") {
      const fin = texto.indexOf(c, i + 1);
      const antes = i === 0 ? " " : texto[i - 1];
      if (fin > i + 1 && texto[fin - 1] !== " " && (c === "*" || /[\s(¿¡"]/.test(antes))) {
        vaciar(); out.push({ t: "cursiva", h: enLinea(texto.slice(i + 1, fin)) }); i = fin + 1; continue;
      }
    }
    if (c === "[") {
      const m = /^\[([^\]\n]{1,300})\]\(([^)\s]{1,500})\)/.exec(texto.slice(i));
      if (m) {
        const destino = destinoCrm(m[2]);
        const doc = destino ? null : idDocumento(m[2]);
        const href = destino || doc ? null : urlExterna(m[2]);
        vaciar();
        if (destino) out.push({ t: "crm", v: m[1], destino });
        else if (doc) out.push({ t: "doc", v: m[1], id: doc });
        else if (href) out.push({ t: "url", v: m[1], href });
        else out.push({ t: "texto", v: m[1] }); // enlace no válido: solo el texto
        i += m[0].length; continue;
      }
    }
    buf += c; i++;
  }
  vaciar();
  return out;
}

const RE_FILA = /^\s*\|.*\|\s*$/;
const RE_SEPARADOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const celdas = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => enLinea(x.trim()));

// Bloques: {t:"p",h} {t:"h",nivel,h} {t:"ul",items:[h]} {t:"ol",items:[h],inicio}
// {t:"tabla",cabecera:[h],filas:[[h]]} {t:"pre",v} {t:"hr"}
export function markdown(texto) {
  const lineas = String(texto || "").replace(/\r\n?/g, "\n").split("\n");
  const bloques = [];
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) {
      const cuerpo = [];
      i++;
      while (i < lineas.length && !/^\s*```/.test(lineas[i])) cuerpo.push(lineas[i++]);
      i++;
      bloques.push({ t: "pre", v: cuerpo.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { bloques.push({ t: "h", nivel: Math.min(h[1].length, 3), h: enLinea(h[2].trim()) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { bloques.push({ t: "hr" }); i++; continue; }
    if (RE_FILA.test(l) && i + 1 < lineas.length && RE_SEPARADOR.test(lineas[i + 1])) {
      const cabecera = celdas(l);
      i += 2;
      const filas = [];
      while (i < lineas.length && RE_FILA.test(lineas[i])) filas.push(celdas(lineas[i++]));
      bloques.push({ t: "tabla", cabecera, filas });
      continue;
    }
    if (/^\s*[-*•]\s+/.test(l)) {
      const items = [];
      while (i < lineas.length && /^\s*[-*•]\s+/.test(lineas[i])) items.push(enLinea(lineas[i++].replace(/^\s*[-*•]\s+/, "")));
      bloques.push({ t: "ul", items });
      continue;
    }
    const n = /^\s*(\d{1,3})[.)]\s+/.exec(l);
    if (n) {
      const items = [];
      while (i < lineas.length && /^\s*\d{1,3}[.)]\s+/.test(lineas[i])) items.push(enLinea(lineas[i++].replace(/^\s*\d{1,3}[.)]\s+/, "")));
      bloques.push({ t: "ol", items, inicio: Number(n[1]) });
      continue;
    }
    const parrafo = [];
    while (i < lineas.length && lineas[i].trim() && !/^\s*```/.test(lineas[i]) && !/^#{1,6}\s/.test(lineas[i])
           && !/^\s*[-*•]\s+/.test(lineas[i]) && !/^\s*\d{1,3}[.)]\s+/.test(lineas[i])
           && !(RE_FILA.test(lineas[i]) && RE_SEPARADOR.test(lineas[i + 1] || ""))) {
      parrafo.push(lineas[i++].trim());
    }
    if (!parrafo.length) { bloques.push({ t: "p", h: enLinea(l.trim()) }); i++; continue; }
    // Saltos de línea dentro del párrafo: nodo "br".
    const h2 = [];
    parrafo.forEach((p, k) => { if (k) h2.push({ t: "br" }); h2.push(...enLinea(p)); });
    bloques.push({ t: "p", h: h2 });
  }
  return bloques;
}

/* ---------------- Historial guardado ---------------- */
// Filas de agente_mensajes (orden, rol, tipo, texto, stop_reason) → burbujas
// del panel: una por pregunta y una por respuesta (juntando las vueltas).
// Una pregunta que se quedó sin respuesta (fallo, plazo o cancelación: las
// respuestas a medias no se guardan) y se repitió igual justo después se
// muestra una sola vez; si la siguiente es distinta, se marca sin respuesta.
export const AVISO_SIN_RESPUESTA = "Esta pregunta se quedó sin respuesta.";
export function burbujasDeHistorial(filas) {
  const out = [];
  for (const f of [...(filas || [])].sort((a, b) => a.orden - b.orden)) {
    if (f.rol === "user" && f.tipo === "pregunta") {
      const texto = f.texto || "";
      const previa = out[out.length - 1];
      if (previa && previa.rol === "user") {
        if (previa.texto.trim() === texto.trim()) out.pop();
        else out.push({ rol: "assistant", partes: [], aviso: AVISO_SIN_RESPUESTA });
      }
      out.push({ rol: "user", texto });
    } else if (f.rol === "assistant" && f.tipo === "modelo") {
      let ultima = out[out.length - 1];
      if (!ultima || ultima.rol !== "assistant") { ultima = { rol: "assistant", partes: [] }; out.push(ultima); }
      if (f.stop_reason === "refusal") ultima.aviso = avisoDeFin("rechazo");
      else if (f.texto) ultima.partes.push({ tipo: "texto", texto: f.texto });
    }
  }
  if (out.length && out[out.length - 1].rol === "user") out.push({ rol: "assistant", partes: [], aviso: AVISO_SIN_RESPUESTA });
  return out;
}

// Añade un trozo de texto a las partes de una respuesta en curso.
export function anadirTexto(partes, delta) {
  const ultima = partes[partes.length - 1];
  if (ultima && ultima.tipo === "texto") return [...partes.slice(0, -1), { ...ultima, texto: ultima.texto + delta }];
  return [...partes, { tipo: "texto", texto: delta }];
}
// Inicio/fin de una herramienta (por id).
export function anotarHerramienta(partes, ev) {
  const i = partes.findIndex((p) => p.tipo === "herramienta" && p.id === ev.id);
  if (i === -1) {
    return [...partes, { tipo: "herramienta", id: ev.id, nombre: ev.nombre, estado: ev.estado, filas: ev.filas, error: !!ev.error }];
  }
  const copia = [...partes];
  copia[i] = { ...copia[i], estado: ev.estado, filas: ev.filas, error: !!ev.error };
  return copia;
}
