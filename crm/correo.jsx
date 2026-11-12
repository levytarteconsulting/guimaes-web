import React from "react";
import {
  agruparConversaciones, ALIAS, asuntoDe, cidsDe, completarToken, contraparte, destinatariosRespuesta, destinatariosTexto,
  documentoVisor, emailsInvalidos, filtrarConversaciones, firmaPorDefecto, fmtFechaCorreo, fmtFechaLarga, fmtTamano,
  listaEmails, MAX_DIRECTO, MAX_TOTAL, mensajeParaResponder, sugerirContactos, textoPlano, tieneExternas, tokenActual,
  totalBytes, trozos, urlEnlace,
} from "./correo-util.js";
import { sanearHtml } from "./supabase-functions/correo/sanear.ts";
/* GUIMAES CRM — Correo de info@guimaes.es (Microsoft 365).
   Bandeja agrupada por conversación, lectura, responder, redactar, marcar
   leído (también en Outlook), filtro "sin vincular", crear contacto desde el
   correo, pestaña Correos en las fichas de contacto y empresa, y
   "Comprobar conexión".
   Esquema: crm/supabase-correo.sql (solo lectura desde el cliente). Todo lo
   que escribe va por la Edge Function correo (crm/supabase-functions/correo/).
   El HTML ya viene saneado del servidor y además se muestra en un iframe con
   sandbox sin scripts y CSP sin red (las imágenes externas, solo si se pide). */
const { useState: cState, useEffect: cEffect, useRef: cRef, useCallback: cCallback } = React;

const LISTA = "id, graph_id, conversation_id, carpeta, remitente_email, remitente_nombre, para, cc, asunto, extracto, fecha, leido, tiene_adjuntos, fuera_bandeja, contact_id, empresa_id, enviado_por";
const COMPLETO = LISTA + ", cco, cuerpo_html, adjuntos:correo_adjuntos(id, nombre, tipo, tamano, inline, content_id)";
const errTexto = (e) => (e && (e.message || e.details)) || String(e);

// ---------------------------------------------------------------- datos
export const CORREO = {
  async lista() {
    const { data, error } = await Auth.client.from("correo_mensajes").select(LISTA)
      .eq("fuera_bandeja", false).order("fecha", { ascending: false }).limit(1000);
    if (error) throw error;
    return data ?? [];
  },
  async conversacion(convId, incluirFuera) {
    let q = Auth.client.from("correo_mensajes").select(COMPLETO);
    q = convId.startsWith("m:") ? q.eq("id", convId.slice(2)) : q.eq("conversation_id", convId);
    if (!incluirFuera) q = q.eq("fuera_bandeja", false);
    const { data, error } = await q.order("fecha", { ascending: true });
    if (error) throw error;
    return data ?? [];
  },
  async de(campo, id) {
    const { data, error } = await Auth.client.from("correo_mensajes").select(LISTA)
      .eq(campo, id).order("fecha", { ascending: false }).limit(500);
    if (error) throw error;
    return data ?? [];
  },
  async contar(campo, id) {
    const { count, error } = await Auth.client.from("correo_mensajes").select("id", { count: "exact", head: true }).eq(campo, id);
    if (error) throw error;
    return count ?? 0;
  },
  async noLeidos() {
    const { count, error } = await Auth.client.from("correo_mensajes").select("id", { count: "exact", head: true })
      .eq("carpeta", "inbox").eq("leido", false).eq("fuera_bandeja", false);
    if (error) throw error;
    return count ?? 0;
  },
  async estado() {
    const { data, error } = await Auth.client.from("correo_sync").select("carpeta, ultimo_ok, ultimo_error");
    if (error) throw error;
    return data ?? [];
  },
  async funcion(accion, cuerpo = {}) {
    const res = await Auth.client.functions.invoke("correo", { body: { accion, ...cuerpo } });
    if (res.error) {
      let msg = res.error.message || "Error al llamar a la función correo";
      try {
        const ctx = res.error.context;
        if (ctx && typeof ctx.json === "function") { const j = await ctx.json(); if (j && j.error) msg = j.error + (j.codigo ? ` (${j.codigo})` : ""); }
      } catch (e) { /* sin cuerpo JSON */ }
      throw new Error(msg);
    }
    return res.data;
  },
  // Adjuntos: binarios, así que fetch directo (functions.invoke los leería como texto).
  async descargar(cuerpo) {
    const { data } = await Auth.client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Sesión caducada");
    const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/correo`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "apikey": window.SUPABASE_CONFIG.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ accion: "adjunto", ...cuerpo }),
    });
    if (!res.ok) {
      let msg = "No se pudo descargar el adjunto";
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch (e) { /* binario o vacío */ }
      throw new Error(msg);
    }
    return res.blob();
  },
  // Ficheros del redactor: binario, con los datos de la petición en la URL.
  async binario(params, blob) {
    const { data } = await Auth.client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Sesión caducada");
    const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/correo?` + new URLSearchParams(params), {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "apikey": window.SUPABASE_CONFIG.anonKey, "Content-Type": "application/octet-stream" },
      body: blob,
    });
    let j = null;
    try { j = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) throw new Error((j && j.error) || `Error ${res.status} al subir el fichero`);
    return j;
  },
  // Usuario del CRM (admins) de la sesión.
  async yo() {
    const { data } = await Auth.client.auth.getSession();
    const uid = data?.session?.user?.id;
    return (uid && CRM.USERS.find((u) => u.auth_user_id === uid)) || null;
  },
  // Firma del usuario (RLS: cada uno solo ve la suya). null si no ha guardado ninguna.
  async firma() {
    const { data, error } = await Auth.client.from("correo_firmas").select("html").maybeSingle();
    if (error) throw error;
    return data ? data.html : null;
  },
  async guardarFirma(adminId, html) {
    const { error } = await Auth.client.from("correo_firmas").upsert({ admin_id: adminId, html }, { onConflict: "admin_id" });
    if (error) throw error;
  },
};

// Contador de no leídos para el menú (se refresca al usar la bandeja y cada 2 min).
let NO_LEIDOS = 0;
export const noLeidosCache = () => NO_LEIDOS;
export async function refrescarNoLeidos() {
  try { NO_LEIDOS = await CORREO.noLeidos(); } catch (e) { /* sin permiso o sin red: se queda el último */ }
  return NO_LEIDOS;
}

export function useConteoCorreos(campo, id) {
  const [n, setN] = cState(null);
  cEffect(() => {
    let vivo = true;
    if (!id) return;
    CORREO.contar(campo, id).then((x) => vivo && setN(x)).catch(() => vivo && setN(null));
    return () => { vivo = false; };
  }, [campo, id]);
  return n;
}

const nombreContacto = (id) => { const c = id && CRM.contactById[id]; return c ? (c.full_name || c.company || c.email) : null; };
const nombreEmpresa = (id) => { const e = id && CRM.empresaById[id]; return e ? e.razon_social : null; };

// ---------------------------------------------------------------- visor
function VisorHtml({ mensaje }) {
  const [externas, setExternas] = cState(false);
  const [cidUrls, setCidUrls] = cState({});
  const [alto, setAlto] = cState(120);
  const ref = cRef(null);
  const html = mensaje.cuerpo_html || "";

  // Imágenes incrustadas: siempre, con la acción adjunto (no dependen del botón).
  cEffect(() => {
    let vivo = true;
    const urls = {};
    const cids = cidsDe(html);
    Promise.all(cids.map(async (cid) => {
      try { urls[cid] = URL.createObjectURL(await CORREO.descargar({ mensaje_id: mensaje.id, cid })); } catch (e) { /* sin esa imagen */ }
    })).then(() => { if (vivo) setCidUrls({ ...urls }); else Object.values(urls).forEach((u) => URL.revokeObjectURL(u)); });
    return () => { vivo = false; Object.values(urls).forEach((u) => URL.revokeObjectURL(u)); };
  }, [mensaje.id, html]);

  const medir = () => {
    try {
      const doc = ref.current?.contentDocument;
      if (doc?.body) setAlto(Math.min(Math.max(doc.documentElement.scrollHeight, 60), 4000));
    } catch (e) { /* otro origen */ }
  };

  if (!html) return <div className="email-card__body muted">{mensaje.extracto || "(sin contenido)"}</div>;
  return <div>
    {tieneExternas(html) && !externas && <div className="correo-aviso">
      <Icon name="eye" size={13} />Imágenes externas bloqueadas.
      <button className="btn btn--sm btn--ghost" onClick={() => setExternas(true)}>Mostrar imágenes</button>
    </div>}
    {/* allow-same-origin sin allow-scripts: no se ejecuta nada dentro y el CRM puede medir la altura. */}
    <iframe ref={ref} className="correo-visor" title="Contenido del correo"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={documentoVisor(html, { mostrarExternas: externas, cidUrls })}
      style={{ height: alto }} onLoad={medir} />
  </div>;
}

function Adjuntos({ mensaje, toast }) {
  const [bajando, setBajando] = cState(null);
  const lista = (mensaje.adjuntos ?? []).filter((a) => !a.inline);
  if (!lista.length) return null;
  const bajar = async (a) => {
    setBajando(a.id);
    try {
      const blob = await CORREO.descargar({ adjunto_id: a.id });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = a.nombre || "adjunto";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { toast("No se pudo descargar: " + errTexto(e)); }
    finally { setBajando(null); }
  };
  return <div className="correo-adjuntos">
    {lista.map((a) => <button key={a.id} className="correo-adjunto" onClick={() => bajar(a)} disabled={bajando === a.id} title="Descargar">
      <Icon name="download" size={13} /><span>{a.nombre || "adjunto"}</span><span className="muted">{bajando === a.id ? "…" : fmtTamano(a.tamano)}</span>
    </button>)}
  </div>;
}

function MensajeCard({ m, toast }) {
  const enviado = m.carpeta === "sentitems";
  const autor = enviado && m.enviado_por ? CRM.USERS.find((u) => u.id === m.enviado_por)?.name : null;
  return <div className={"email-card " + (enviado ? "out" : "in")}>
    <div className="email-card__head">
      <span style={{ minWidth: 0 }}>
        <b style={{ color: "var(--ink)" }}>{m.remitente_nombre || m.remitente_email}</b>
        {m.remitente_nombre && <span> &lt;{m.remitente_email}&gt;</span>}
        <span> → {destinatariosTexto(m.para)}</span>
        {m.cc?.length ? <span> · cc: {destinatariosTexto(m.cc)}</span> : null}
        {autor && <span> · enviado por {autor}</span>}
        {m.fuera_bandeja && <> · <Badge label="Ya no está en la bandeja" color="#9AA9B8" /></>}
      </span>
      <span style={{ whiteSpace: "nowrap" }}>{fmtFechaLarga(m.fecha)}</span>
    </div>
    <VisorHtml mensaje={m} />
    <Adjuntos mensaje={m} toast={toast} />
  </div>;
}

// ---------------------------------------------------------------- conversación
function Conversacion({ convId, incluirFuera, nav, toast, onCambio, NewContact }) {
  const [ms, setMs] = cState(null);
  const [err, setErr] = cState(null);
  const [redactor, setRedactor] = cState(null);
  const [crear, setCrear] = cState(false);

  const cargar = cCallback(async () => {
    try { setMs(await CORREO.conversacion(convId, incluirFuera)); setErr(null); }
    catch (e) { setErr(errTexto(e)); }
  }, [convId, incluirFuera]);
  cEffect(() => { setMs(null); setRedactor(null); cargar(); }, [cargar]);

  // Al abrir: marcar como leídos los recibidos (también en Outlook).
  cEffect(() => {
    if (!ms) return;
    const pendientes = ms.filter((m) => m.carpeta === "inbox" && !m.leido && !m.fuera_bandeja);
    if (!pendientes.length) return;
    Promise.all(pendientes.map((m) => CORREO.funcion("marcar_leido", { mensaje_id: m.id, leido: true }).catch(() => null)))
      .then(() => { setMs((xs) => xs && xs.map((m) => (pendientes.some((p) => p.id === m.id) ? { ...m, leido: true } : m))); refrescarNoLeidos(); onCambio && onCambio(); });
  }, [ms && ms.map((m) => m.id).join(",")]);

  if (err) return <div className="muted" style={{ padding: 20 }}>No se pudo cargar: {err}</div>;
  if (!ms) return <div className="muted" style={{ padding: 20 }}>Cargando…</div>;
  if (!ms.length) return <div className="muted" style={{ padding: 20 }}>Esta conversación ya no está en la bandeja.</div>;

  const conv = agruparConversaciones(ms)[0];
  const destino = mensajeParaResponder(conv);
  const otro = contraparte(destino || conv.ultimo);
  const contacto = nombreContacto(conv.contact_id);
  const empresa = nombreEmpresa(conv.empresa_id);

  const noLeido = async () => {
    if (!destino) return;
    try { await CORREO.funcion("marcar_leido", { mensaje_id: destino.id, leido: false }); toast("Marcado como no leído"); refrescarNoLeidos(); onCambio && onCambio(); }
    catch (e) { toast("No se pudo marcar: " + errTexto(e)); }
  };
  return <>
    <div className="inbox__thread__head">
      <div style={{ fontWeight: 700, fontFamily: "var(--display)", fontSize: 16 }}>{conv.asunto}</div>
      <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}>
        {contacto ? <Badge label={contacto} color="#1F6FEB" /> : <Badge label="Sin vincular" color="#6E8298" />}
        {empresa && <Badge label={empresa} color="#16B8A6" />}
        {conv.contact_id && <button className="btn btn--sm btn--ghost" onClick={() => nav("contact", conv.contact_id)}><Icon name="external" size={13} />Ver contacto</button>}
        {conv.empresa_id && <button className="btn btn--sm btn--ghost" onClick={() => nav("empresa", conv.empresa_id)}><Icon name="building" size={13} />Ver empresa</button>}
        {!conv.contact_id && otro.email && NewContact && <button className="btn btn--sm btn--ghost" onClick={() => setCrear(true)}><Icon name="plus" size={13} />Crear contacto</button>}
        {destino && <button className="btn btn--sm btn--ghost" onClick={noLeido}><Icon name="mail" size={13} />Marcar no leído</button>}
      </div>
    </div>
    <div className="inbox__thread__body">
      {conv.mensajes.map((m) => <MensajeCard key={m.id} m={m} toast={toast} />)}
    </div>
    <div className="inbox__reply correo-acciones">
      {destino && <button className="btn btn--primary btn--sm" onClick={() => setRedactor({ tipo: "respuesta", mensaje: destino })}><Icon name="reply" size={14} />Responder</button>}
      {destino && <button className="btn btn--sm" onClick={() => setRedactor({ tipo: "respuesta_todos", mensaje: destino })}><Icon name="reply" size={14} />Responder a todos</button>}
      <button className="btn btn--sm" onClick={() => setRedactor({ tipo: "reenvio", mensaje: conv.ultimo })}><Icon name="arrowR" size={14} />Reenviar</button>
      <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>Sale desde {ALIAS}</span>
    </div>
    {redactor && <Redactor tipo={redactor.tipo} mensaje={redactor.mensaje} empresaId={redactor.mensaje.empresa_id || conv.empresa_id || null}
      toast={toast} onClose={() => setRedactor(null)} onEnviado={async () => { await cargar(); onCambio && onCambio(); }} />}
    {crear && <NewContact initial={{ full_name: otro.nombre || "", email: otro.email }} onClose={() => setCrear(false)} onSave={async (f) => {
      try {
        await CRM.addContact(Auth.client, f);
        setCrear(false); toast("Contacto creado: sus correos se vinculan solos");
        await cargar(); onCambio && onCambio();
      } catch (e) { toast("No se pudo crear: " + errTexto(e)); throw e; }
    }} />}
  </>;
}

// ---------------------------------------------------------------- redactor
// Todo envío va por un borrador de la función: crear → adjuntar (≤ 3 MB en una
// petición; más, por trozos) → documentos → enviar. Si algo falla, se
// descarta el borrador y no se envía nada. Los ficheros no se guardan en el CRM.
async function enviarCorreo(op, progreso) {
  const { borrador } = await CORREO.funcion("borrador_crear", { tipo: op.tipo, mensaje_id: op.mensaje_id, empresa_id: op.empresa_id });
  try {
    const n = op.ficheros.length + op.documentos.length;
    let i = 0;
    for (const f of op.ficheros) {
      i++;
      progreso(`Subiendo ${f.name} (${i}/${n})…`);
      if (f.size <= MAX_DIRECTO) {
        await CORREO.binario({ accion: "borrador_adjuntar", borrador, nombre: f.name, tipo: f.type || "" }, f);
      } else {
        const s = await CORREO.funcion("borrador_sesion", { borrador, nombre: f.name, tipo: f.type || "", tamano: f.size });
        for (const [desde, largo] of trozos(f.size, s.trozo)) {
          progreso(`Subiendo ${f.name} (${i}/${n}) · ${Math.floor((desde * 100) / f.size)} %`);
          await CORREO.binario({ accion: "borrador_trozo", borrador, sesion: s.sesion, desde: String(desde) }, f.slice(desde, desde + largo));
        }
      }
    }
    for (const d of op.documentos) {
      i++;
      progreso(`Adjuntando ${d.nombre} (${i}/${n})…`);
      await CORREO.funcion("borrador_documento", { borrador, documento_id: d.id });
    }
    progreso("Enviando…");
    return await CORREO.funcion("borrador_enviar", { borrador, para: op.para, cc: op.cc, cco: op.cco, asunto: op.asunto, html: op.html });
  } catch (e) {
    try { await CORREO.funcion("borrador_descartar", { borrador }); } catch (x) { /* ya no está */ }
    throw e;
  }
}

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Editor ligero: contentEditable + execCommand. Lo pegado se sanea; al enviar,
// el servidor vuelve a sanear todo.
function EditorRico({ editorRef, inicial, onInput, minHeight = 200 }) {
  const [enlace, setEnlace] = cState(null);
  const [malEnlace, setMalEnlace] = cState(false);
  const rango = cRef(null);
  cEffect(() => { if (editorRef.current) editorRef.current.innerHTML = inicial || "<p><br></p>"; }, []);
  const avisar = () => onInput && onInput();
  const cmd = (c, v) => { editorRef.current.focus(); document.execCommand(c, false, v); avisar(); };
  const abrirEnlace = () => {
    const sel = window.getSelection();
    rango.current = sel && sel.rangeCount && editorRef.current.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setMalEnlace(false);
    setEnlace("");
  };
  const ponerEnlace = () => {
    const url = urlEnlace(enlace);
    if (!url) { setMalEnlace(true); return; }
    editorRef.current.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (rango.current) sel.addRange(rango.current);
    if (rango.current && !rango.current.collapsed) document.execCommand("createLink", false, url);
    else document.execCommand("insertHTML", false, `<a href="${escAttr(url)}">${escAttr(enlace.trim())}</a>&nbsp;`);
    setEnlace(null); avisar();
  };
  const pegar = (e) => {
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (!html) return; // texto plano: lo pega el navegador
    e.preventDefault();
    document.execCommand("insertHTML", false, sanearHtml(html));
    avisar();
  };
  const B = (titulo, accion, contenido) => <button type="button" className="correo-ed__btn" title={titulo} aria-label={titulo}
    onMouseDown={(e) => { e.preventDefault(); accion(); }}>{contenido}</button>;
  return <div className="correo-ed">
    <div className="correo-ed__barra">
      {B("Negrita (Ctrl+B)", () => cmd("bold"), <b>B</b>)}
      {B("Cursiva (Ctrl+I)", () => cmd("italic"), <i>I</i>)}
      {B("Subrayado (Ctrl+U)", () => cmd("underline"), <u>U</u>)}
      <span className="correo-ed__sep" />
      {B("Lista con viñetas", () => cmd("insertUnorderedList"), "• Lista")}
      {B("Lista numerada", () => cmd("insertOrderedList"), "1. Lista")}
      <span className="correo-ed__sep" />
      {B("Enlace", abrirEnlace, "Enlace")}
      {B("Quitar formato", () => { cmd("removeFormat"); cmd("unlink"); }, "Quitar formato")}
    </div>
    {enlace !== null && <div className="correo-ed__enlace">
      <input className="inp" autoFocus placeholder="https://… o un email" value={enlace}
        onChange={(e) => { setEnlace(e.target.value); setMalEnlace(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); ponerEnlace(); }
          if (e.key === "Escape") { e.stopPropagation(); setEnlace(null); }
        }} />
      <button type="button" className="btn btn--sm btn--primary" onClick={ponerEnlace}>Poner enlace</button>
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEnlace(null)}>Cancelar</button>
      {malEnlace && <span style={{ fontSize: 12, color: "#DC3A47" }}>Enlace no válido (http, https o email)</span>}
    </div>}
    <div ref={editorRef} className="correo-ed__area" contentEditable suppressContentEditableWarning
      style={{ minHeight }} onInput={avisar} onPaste={pegar} />
  </div>;
}

// Para / CC / CCO con autocompletado de los contactos del CRM.
function CampoEmails({ value, onChange, placeholder, autoFocus }) {
  const [abierto, setAbierto] = cState(false);
  const [sel, setSel] = cState(0);
  const sugs = abierto ? sugerirContactos(CRM.CONTACTS, tokenActual(value), listaEmails(value)) : [];
  const elegir = (s) => { onChange(completarToken(value, s.email)); setSel(0); };
  return <div className="correo-dest">
    <input className="inp" value={value} placeholder={placeholder} autoFocus={autoFocus} autoComplete="off" spellCheck={false}
      onChange={(e) => { onChange(e.target.value); setAbierto(true); setSel(0); }}
      onFocus={() => setAbierto(true)} onBlur={() => setTimeout(() => setAbierto(false), 150)}
      onKeyDown={(e) => {
        if (!sugs.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setSel((sel + 1) % sugs.length); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setSel((sel - 1 + sugs.length) % sugs.length); }
        else if (e.key === "Enter") { e.preventDefault(); elegir(sugs[sel] || sugs[0]); }
        else if (e.key === "Escape") { e.stopPropagation(); setAbierto(false); }
      }} />
    {sugs.length > 0 && <div className="correo-dest__lista" role="listbox">
      {sugs.map((s, k) => <div key={s.email} role="option" aria-selected={k === sel} className={"correo-dest__op" + (k === sel ? " on" : "")}
        onMouseDown={(e) => { e.preventDefault(); elegir(s); }} onMouseEnter={() => setSel(k)}>
        <b>{s.nombre || s.email}</b>{s.nombre && <span className="muted"> {s.email}</span>}
      </div>)}
    </div>}
  </div>;
}

// Selector de documentos de la empresa (todas sus carpetas), agrupados por carpeta / subcarpeta.
function ElegirDocumentos({ empresaId, elegidos, onClose, onElegir }) {
  const [docs, setDocs] = cState(null);
  const [err, setErr] = cState(null);
  const [q, setQ] = cState("");
  const [sel, setSel] = cState(() => new Set(elegidos));
  cEffect(() => {
    let vivo = true;
    CRM.loadDocumentosEmpresa(Auth.client, empresaId)
      .then((r) => vivo && setDocs(r.docs.filter((d) => d.status === "stored")))
      .catch((e) => vivo && setErr(errTexto(e)));
    return () => { vivo = false; };
  }, [empresaId]);
  const nombre = (d) => CRM.docDisplayName(d);
  const ruta = (d) => d.folder_path || "Sin carpeta";
  const qn = q.trim().toLowerCase();
  const lista = (docs || [])
    .filter((d) => !qn || nombre(d).toLowerCase().includes(qn) || ruta(d).toLowerCase().includes(qn))
    .sort((a, b) => ruta(a).localeCompare(ruta(b), "es") || nombre(a).localeCompare(nombre(b), "es"));
  const grupos = [];
  for (const d of lista) {
    if (!grupos.length || grupos[grupos.length - 1].ruta !== ruta(d)) grupos.push({ ruta: ruta(d), docs: [] });
    grupos[grupos.length - 1].docs.push(d);
  }
  const cambiar = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const aceptar = () => onElegir((docs || []).filter((d) => sel.has(d.id)).map((d) => ({ id: d.id, nombre: nombre(d), tamano: d.size_bytes || 0, ruta: ruta(d) })));
  const total = (docs || []).filter((d) => sel.has(d.id)).reduce((a, d) => a + (d.size_bytes || 0), 0);
  return <Modal title="Documentos de la empresa" wide onClose={onClose} footer={<>
    <span className="muted" style={{ fontSize: 12, marginRight: "auto" }}>{sel.size ? `${sel.size} elegidos · ${fmtTamano(total)}` : ""}</span>
    <button className="btn btn--ghost" onClick={onClose}>Cancelar</button>
    <button className="btn btn--primary" onClick={aceptar} disabled={!docs}>Adjuntar{sel.size ? ` (${sel.size})` : ""}</button>
  </>}>
    <input className="inp" placeholder="Buscar por nombre o carpeta" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
    {err && <p className="muted">No se pudieron cargar: {err}</p>}
    {!docs && !err && <p className="muted">Cargando…</p>}
    {docs && !lista.length && <p className="muted">{docs.length ? "Ningún documento coincide." : "Esta empresa no tiene documentos."}</p>}
    <div className="correo-docs">
      {grupos.map((g) => <div key={g.ruta}>
        <div className="correo-docs__carpeta"><Icon name="folder" size={13} />{g.ruta}</div>
        {g.docs.map((d) => <label key={d.id} className="correo-docs__doc">
          <input type="checkbox" checked={sel.has(d.id)} onChange={() => cambiar(d.id)} />
          <span className="correo-docs__nombre">{nombre(d)}</span>
          <span className="muted">{fmtTamano(d.size_bytes)}</span>
        </label>)}
      </div>)}
    </div>
  </Modal>;
}

function EditarFirma({ html, yo, toast, onClose, onGuardada }) {
  const ref = cRef(null);
  const [guardando, setGuardando] = cState(false);
  const guardar = async () => {
    const limpio = sanearHtml(ref.current.innerHTML);
    if (limpio.length > 20000) { toast("La firma es demasiado larga"); return; }
    if (!yo) { toast("No se encontró tu usuario del CRM"); return; }
    setGuardando(true);
    try { await CORREO.guardarFirma(yo.id, limpio); toast("Firma guardada"); onGuardada(limpio); onClose(); }
    catch (e) { toast("No se pudo guardar la firma: " + errTexto(e)); setGuardando(false); }
  };
  return <Modal title="Mi firma" onClose={onClose} footer={<>
    <button className="btn btn--ghost" style={{ marginRight: "auto" }} onClick={() => { ref.current.innerHTML = sanearHtml(firmaPorDefecto(yo?.name)); }} disabled={guardando}>Restaurar la de por defecto</button>
    <button className="btn btn--ghost" onClick={onClose} disabled={guardando}>Cancelar</button>
    <button className="btn btn--primary" onClick={guardar} disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button>
  </>}>
    <EditorRico editorRef={ref} inicial={html} minHeight={90} />
    <p className="muted" style={{ fontSize: 12 }}>Se guarda para tu usuario y se añade a los correos que redactes.</p>
  </Modal>;
}

const TITULOS = { nuevo: "Redactar correo", respuesta: "Responder", respuesta_todos: "Responder a todos", reenvio: "Reenviar" };

// tipo: nuevo | respuesta | respuesta_todos | reenvio; mensaje: fila completa
// (con cuerpo_html y adjuntos) a la que se responde o que se reenvía.
export function Redactor({ tipo = "nuevo", mensaje = null, empresaId = null, para: paraInicial = "", onClose, toast, onEnviado }) {
  const ini = cRef(null);
  if (!ini.current) {
    const d = tipo === "respuesta" || tipo === "respuesta_todos"
      ? destinatariosRespuesta(mensaje, tipo === "respuesta_todos")
      : { para: tipo === "nuevo" && paraInicial ? [paraInicial] : [], cc: [] };
    ini.current = { para: d.para.join(", "), cc: d.cc.join(", "), asunto: mensaje ? asuntoDe(mensaje.asunto, tipo) : "" };
  }
  const [para, setPara] = cState(ini.current.para);
  const [cc, setCc] = cState(ini.current.cc);
  const [cco, setCco] = cState("");
  const [verCco, setVerCco] = cState(false);
  const [asunto, setAsunto] = cState(ini.current.asunto);
  const [yo, setYo] = cState(null);
  const [firma, setFirma] = cState(null);
  const [ficheros, setFicheros] = cState([]);
  const [docs, setDocs] = cState([]);
  const [elegirDocs, setElegirDocs] = cState(false);
  const [editarFirma, setEditarFirma] = cState(false);
  const [verCita, setVerCita] = cState(false);
  const [arrastrando, setArrastrando] = cState(false);
  const [enviando, setEnviando] = cState(null);
  const [hayTexto, setHayTexto] = cState(false);
  const editor = cRef(null);
  const elegirFichero = cRef(null);

  cEffect(() => {
    let vivo = true;
    (async () => {
      const u = await CORREO.yo().catch(() => null);
      let h = null;
      try { h = await CORREO.firma(); } catch (e) { /* sin firma guardada: la de por defecto */ }
      if (vivo) { setYo(u); setFirma(sanearHtml(h != null ? h : firmaPorDefecto(u?.name))); }
    })();
    return () => { vivo = false; };
  }, []);

  const medirTexto = () => {
    const c = editor.current && editor.current.cloneNode(true);
    if (!c) return;
    c.querySelectorAll("[data-firma]").forEach((x) => x.remove());
    setHayTexto(!!textoPlano(c.innerHTML));
  };
  const ponerFirma = (html) => {
    setFirma(html);
    const ed = editor.current;
    if (!ed) return;
    let f = ed.querySelector("[data-firma]");
    if (!f) { f = document.createElement("div"); f.setAttribute("data-firma", "1"); ed.appendChild(f); }
    f.innerHTML = html;
  };

  const originales = tipo === "reenvio"
    ? (mensaje?.adjuntos ?? []).filter((a) => !a.inline).map((a) => ({ nombre: a.nombre, tamano: a.tamano || 0 }))
    : [];
  const total = totalBytes(ficheros.map((f) => ({ tamano: f.size })), docs, originales);
  const excede = total > MAX_TOTAL;
  const anadir = (lista) => {
    const nuevos = [];
    for (const f of lista || []) {
      if (!f.size) { toast(`${f.name} está vacío y no se adjunta`); continue; }
      nuevos.push(f);
    }
    if (nuevos.length) setFicheros((xs) => [...xs, ...nuevos]);
  };
  const conFicheros = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

  const lp = listaEmails(para), lc = listaEmails(cc), lb = listaEmails(cco);
  const malos = emailsInvalidos([...lp, ...lc, ...lb]);
  const falta = !lp.length ? "Falta el destinatario"
    : malos.length ? null
    : tipo === "nuevo" && !asunto.trim() ? "Falta el asunto"
    : tipo !== "reenvio" && !hayTexto ? "Escribe el mensaje"
    : null;
  const puede = !enviando && firma !== null && !falta && !malos.length && !excede;

  const enviar = async () => {
    if (!puede) return;
    setEnviando("Preparando…");
    try {
      await enviarCorreo({
        tipo, mensaje_id: mensaje?.id, empresa_id: empresaId, ficheros, documentos: docs,
        para: lp, cc: lc, cco: lb, asunto: asunto.trim(), html: editor.current.innerHTML,
      }, setEnviando);
      toast("Correo enviado desde " + ALIAS);
      onEnviado && onEnviado();
      onClose();
    } catch (e) {
      toast("No se ha enviado: " + errTexto(e));
      setEnviando(null);
    }
  };
  const cerrar = () => { if (!enviando) onClose(); };

  return <Modal title={TITULOS[tipo] || TITULOS.nuevo} wide onClose={cerrar} footer={<>
    <span className="muted" style={{ fontSize: 12, marginRight: "auto" }}>{enviando || `Sale desde ${ALIAS}`}</span>
    <button className="btn btn--ghost" onClick={cerrar} disabled={!!enviando}>Cancelar</button>
    <button className="btn btn--primary" onClick={enviar} disabled={!puede} title={falta || ""}><Icon name="send" size={15} />{enviando ? "Enviando…" : "Enviar"}</button>
  </>}>
    <div className={"correo-red" + (arrastrando ? " correo-red--soltar" : "")}
      onDragOver={(e) => { if (conFicheros(e) && !enviando) { e.preventDefault(); setArrastrando(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setArrastrando(false); }}
      onDrop={(e) => { if (!conFicheros(e)) return; e.preventDefault(); setArrastrando(false); if (!enviando) anadir(e.dataTransfer.files); }}>
      <fieldset disabled={!!enviando} className="correo-red__campos">
        <Field label={<span className="correo-red__etq">Para{!verCco && <button type="button" className="correo-red__cco" onClick={() => setVerCco(true)}>CCO</button>}</span>}>
          <CampoEmails value={para} onChange={setPara} placeholder="Nombre o email (varios separados por comas)" autoFocus={tipo !== "respuesta" && tipo !== "respuesta_todos"} />
        </Field>
        <Field label="CC"><CampoEmails value={cc} onChange={setCc} /></Field>
        {verCco && <Field label="CCO"><CampoEmails value={cco} onChange={setCco} placeholder="Copia oculta" /></Field>}
        <Field label="Asunto"><input className="inp" value={asunto} onChange={(e) => setAsunto(e.target.value)} /></Field>
      </fieldset>
      {firma === null
        ? <div className="muted" style={{ padding: 12 }}>Cargando…</div>
        : <EditorRico editorRef={editor} onInput={medirTexto}
            inicial={`<p><br></p><p><br></p><div data-firma="1">${firma}</div>`} />}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditarFirma(true)} disabled={firma === null || !!enviando}><Icon name="edit" size={13} />Editar mi firma</button>
        {mensaje && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setVerCita((v) => !v)}>
          <Icon name={verCita ? "chevronD" : "chevronR"} size={13} />{tipo === "reenvio" ? "Mensaje reenviado" : "Mensaje original"} (va debajo de tu texto)
        </button>}
      </div>
      {mensaje && verCita && <div className="correo-cita">
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          De {mensaje.remitente_nombre ? `${mensaje.remitente_nombre} <${mensaje.remitente_email}>` : mensaje.remitente_email} · {fmtFechaLarga(mensaje.fecha)}
        </div>
        <VisorHtml mensaje={mensaje} />
      </div>}

      <div className="correo-adj">
        {(originales.length > 0 || ficheros.length > 0 || docs.length > 0) && <div className="correo-adj__lista">
          {originales.map((a, k) => <div key={"o" + k} className="correo-adj__fila">
            <Icon name="paperclip" size={13} /><span className="correo-adj__nombre">{a.nombre}</span>
            <span className="muted">{fmtTamano(a.tamano)} · del mensaje original</span>
          </div>)}
          {ficheros.map((f, k) => <div key={"f" + k} className="correo-adj__fila">
            <Icon name="paperclip" size={13} /><span className="correo-adj__nombre">{f.name}</span>
            <span className="muted">{fmtTamano(f.size)}</span>
            <button type="button" className="correo-adj__quitar" title="Quitar" aria-label={"Quitar " + f.name} disabled={!!enviando}
              onClick={() => setFicheros((xs) => xs.filter((_, j) => j !== k))}><Icon name="x" size={13} /></button>
          </div>)}
          {docs.map((d) => <div key={d.id} className="correo-adj__fila">
            <Icon name="folder" size={13} /><span className="correo-adj__nombre">{d.nombre}</span>
            <span className="muted">{d.ruta} · {fmtTamano(d.tamano)}</span>
            <button type="button" className="correo-adj__quitar" title="Quitar" aria-label={"Quitar " + d.nombre} disabled={!!enviando}
              onClick={() => setDocs((xs) => xs.filter((x) => x.id !== d.id))}><Icon name="x" size={13} /></button>
          </div>)}
        </div>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn btn--sm" onClick={() => elegirFichero.current.click()} disabled={!!enviando}><Icon name="paperclip" size={14} />Adjuntar</button>
          <input ref={elegirFichero} type="file" multiple hidden onChange={(e) => { anadir(e.target.files); e.target.value = ""; }} />
          {empresaId && <button type="button" className="btn btn--sm" onClick={() => setElegirDocs(true)} disabled={!!enviando}><Icon name="folder" size={14} />Desde documentos de la empresa</button>}
          <span className="muted" style={{ fontSize: 12 }}>{total ? `${fmtTamano(total)} de 25 MB` : "Hasta 25 MB por correo"} · también puedes arrastrar ficheros aquí</span>
        </div>
        {excede && <p className="correo-red__error">Los adjuntos suman {fmtTamano(total)} y el límite es 25 MB por correo. Quita alguno para poder enviar.</p>}
      </div>
      {malos.length > 0 && <p className="correo-red__error">Email no válido: {malos.join(", ")}</p>}
    </div>
    {elegirDocs && <ElegirDocumentos empresaId={empresaId} elegidos={docs.map((d) => d.id)} onClose={() => setElegirDocs(false)}
      onElegir={(xs) => { setDocs(xs); setElegirDocs(false); }} />}
    {editarFirma && <EditarFirma html={firma} yo={yo} toast={toast} onClose={() => setEditarFirma(false)} onGuardada={ponerFirma} />}
  </Modal>;
}

// ---------------------------------------------------------------- bandeja
const FILTROS = [
  { id: "inbox", label: "Recibidos", icon: "mail" },
  { id: "sentitems", label: "Enviados", icon: "send" },
  { id: "sin_vincular", label: "Sin vincular", icon: "tag" },
];

function FilaConversacion({ c, activa, onClick }) {
  const otro = contraparte([...c.mensajes].reverse().find((m) => m.carpeta === "inbox") || c.ultimo);
  const nombre = nombreContacto(c.contact_id) || otro.nombre || otro.email || "(desconocido)";
  return <div className={"inbox__row" + (activa ? " active" : "") + (c.noLeidos ? " unread" : "")} onClick={onClick}>
    <Avatar name={nombre} size="md" color={c.contact_id ? CRM.colorFor(nombre) : "#6E8298"} />
    <div className="inbox__row__main">
      <div className="inbox__row__top"><span>{nombre}{c.mensajes.length > 1 ? ` (${c.mensajes.length})` : ""}</span><span>{fmtFechaCorreo(c.ultimo.fecha)}</span></div>
      <div className="inbox__subject">{c.adjuntos && <Icon name="documents" size={12} style={{ marginRight: 4, verticalAlign: -1 }} />}{c.asunto}</div>
      <div className="inbox__snippet">{c.ultimo.extracto}</div>
    </div>
  </div>;
}

export function Inbox({ nav, toast, NewContact }) {
  const [filtro, setFiltro] = cState("inbox");
  const [msgs, setMsgs] = cState(null);
  const [err, setErr] = cState(null);
  const [activa, setActiva] = cState(null);
  const [redactar, setRedactar] = cState(false);
  const [estado, setEstado] = cState([]);
  const [ocupado, setOcupado] = cState(null);
  const [q, setQ] = cState("");

  const cargar = cCallback(async () => {
    try {
      const [l, e] = await Promise.all([CORREO.lista(), CORREO.estado().catch(() => [])]);
      setMsgs(l); setEstado(e); setErr(null); refrescarNoLeidos();
    } catch (e) { setErr(errTexto(e)); }
  }, []);
  cEffect(() => { cargar(); const t = setInterval(cargar, 60000); return () => clearInterval(t); }, [cargar]);

  const convs = msgs ? agruparConversaciones(msgs) : [];
  const qn = q.trim().toLowerCase();
  const lista = filtrarConversaciones(convs, filtro).filter((c) => !qn || c.mensajes.some((m) =>
    [m.asunto, m.remitente_email, m.remitente_nombre, nombreContacto(m.contact_id)].some((x) => String(x || "").toLowerCase().includes(qn))));
  const cuenta = (f) => filtrarConversaciones(convs, f).filter((c) => c.noLeidos).length;

  const comprobar = async () => {
    setOcupado("comprobar");
    try {
      const r = await CORREO.funcion("comprobar");
      toast(r.ok ? "Conexión con Microsoft 365: correcta" : `Sin acceso al buzón: ${r.estado || ""} ${r.codigo || r.error || ""}${r.aviso ? " — " + r.aviso : ""}`);
    } catch (e) { toast("No se pudo comprobar: " + errTexto(e)); }
    finally { setOcupado(null); }
  };
  const sincronizar = async () => {
    setOcupado("sincronizar");
    try {
      const r = await CORREO.funcion("sincronizar");
      const n = (r.carpetas || []).reduce((a, c) => a + (c.guardados || 0), 0);
      const ocupadas = (r.carpetas || []).some((c) => !c.reservada);
      toast(ocupadas ? "Ya había una sincronización en marcha" : `Sincronizado (${n} mensaje${n === 1 ? "" : "s"} nuevo${n === 1 ? "" : "s"} o actualizado${n === 1 ? "" : "s"})`);
      await cargar();
    } catch (e) { toast("No se pudo sincronizar: " + errTexto(e)); }
    finally { setOcupado(null); }
  };

  const ultimoOk = estado.map((e) => e.ultimo_ok).filter(Boolean).sort()[0];
  const errores = estado.filter((e) => e.ultimo_error);

  return (
    <div className="inbox">
      <div className="inbox__folders">
        <button className="btn btn--primary inbox__compose" onClick={() => setRedactar(true)}><Icon name="mail" size={16} />Redactar</button>
        {FILTROS.map((f) => {
          const n = f.id === "sentitems" ? 0 : cuenta(f.id);
          return <div key={f.id} className={"folder-item" + (filtro === f.id ? " active" : "")} onClick={() => { setFiltro(f.id); setActiva(null); }}>
            <Icon name={f.icon} size={15} />{f.label}{n > 0 && <span className="folder-item__count">{n}</span>}
          </div>;
        })}
        <div className="correo-estado">
          <button className="btn btn--sm btn--ghost" onClick={comprobar} disabled={!!ocupado}><Icon name="shield" size={13} />{ocupado === "comprobar" ? "Comprobando…" : "Comprobar conexión"}</button>
          <button className="btn btn--sm btn--ghost" onClick={sincronizar} disabled={!!ocupado}><Icon name="refresh" size={13} />{ocupado === "sincronizar" ? "Sincronizando…" : "Sincronizar ahora"}</button>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            {ultimoOk ? "Última sincronización: " + fmtFechaLarga(ultimoOk) : "Aún sin sincronizar"}
            {errores.map((e) => <div key={e.carpeta} style={{ color: "#DC3A47" }}>{e.carpeta === "inbox" ? "Recibidos" : "Enviados"}: {e.ultimo_error}</div>)}
          </div>
        </div>
      </div>
      <div className="inbox__list">
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
          <input className="inp" placeholder="Buscar por asunto, remitente o contacto" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {err && <div className="muted" style={{ padding: 16, fontSize: 13 }}>No se pudo cargar: {err}</div>}
        {!msgs && !err && <div className="muted" style={{ padding: 16, fontSize: 13 }}>Cargando…</div>}
        {lista.map((c) => <FilaConversacion key={c.id} c={c} activa={activa === c.id} onClick={() => setActiva(c.id)} />)}
        {msgs && lista.length === 0 && <div className="muted" style={{ padding: "24px 16px", fontSize: 13, textAlign: "center" }}>Sin correos aquí.</div>}
      </div>
      <div className="inbox__thread">
        {activa ? <Conversacion key={activa} convId={activa} incluirFuera={false} nav={nav} toast={toast} onCambio={cargar} NewContact={NewContact} />
          : <div className="muted" style={{ margin: "auto", fontSize: 13 }}>Selecciona un correo</div>}
      </div>
      {redactar && <Redactor tipo="nuevo" onClose={() => setRedactar(false)} toast={toast} onEnviado={() => { setFiltro("sentitems"); cargar(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- pestaña de las fichas
// campo: "contact_id" | "empresa_id". Incluye los que ya no están en la bandeja.
export function CorreosFicha({ campo, id, nav, toast, NewContact, paraInicial = "" }) {
  const [msgs, setMsgs] = cState(null);
  const [err, setErr] = cState(null);
  const [abierta, setAbierta] = cState(null);
  const [redactar, setRedactar] = cState(false);
  const cargar = cCallback(async () => {
    try { setMsgs(await CORREO.de(campo, id)); setErr(null); } catch (e) { setErr(errTexto(e)); }
  }, [campo, id]);
  cEffect(() => { cargar(); }, [cargar]);

  if (err) return <div className="muted">No se pudo cargar: {err}</div>;
  if (!msgs) return <div className="muted">Cargando…</div>;
  const convs = agruparConversaciones(msgs);
  return <div className="wrap-gap">
    <div className="row" style={{ justifyContent: "flex-end" }}>
      <button className="btn btn--sm btn--primary" onClick={() => setRedactar(true)}><Icon name="mail" size={14} />Redactar</button>
    </div>
    {convs.length === 0 && <Empty icon="mail" title="Sin correos vinculados" />}
    {convs.map((c) => <div key={c.id} className="card">
      <div className="card__head" style={{ cursor: "pointer" }} onClick={() => setAbierta(abierta === c.id ? null : c.id)}>
        <Icon name="mail" size={16} style={{ color: "var(--accent)" }} />
        <h3 style={{ fontSize: 14 }}>{c.asunto}{c.mensajes.length > 1 ? ` (${c.mensajes.length})` : ""}</h3>
        {c.noLeidos > 0 && <Badge label="No leído" color="#1F6FEB" />}
        {c.mensajes.every((m) => m.fuera_bandeja) && <Badge label="Fuera de la bandeja" color="#9AA9B8" />}
        <span className="right muted" style={{ fontSize: 12 }}>{fmtFechaCorreo(c.ultimo.fecha)}</span>
      </div>
      {abierta === c.id
        ? <div className="correo-ficha"><Conversacion convId={c.id} incluirFuera nav={nav} toast={toast} onCambio={cargar} NewContact={NewContact} /></div>
        : <div className="card__body muted" style={{ paddingTop: 12, fontSize: 12.5 }}>{c.ultimo.extracto}</div>}
    </div>)}
    {redactar && <Redactor tipo="nuevo" onClose={() => setRedactar(false)} toast={toast} para={paraInicial} onEnviado={cargar}
      empresaId={campo === "empresa_id" ? id : (CRM.empresaPrincipalDe(id)?.id || null)} />}
  </div>;
}
