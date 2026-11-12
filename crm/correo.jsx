import React from "react";
import {
  agruparConversaciones, ALIAS, cidsDe, contraparte, destinatariosTexto, documentoVisor, emailsInvalidos,
  filtrarConversaciones, fmtFechaCorreo, fmtFechaLarga, fmtTamano, listaEmails, mensajeParaResponder, tieneExternas,
} from "./correo-util.js";
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
  const [texto, setTexto] = cState("");
  const [todos, setTodos] = cState(false);
  const [enviando, setEnviando] = cState(false);
  const [crear, setCrear] = cState(false);

  const cargar = cCallback(async () => {
    try { setMs(await CORREO.conversacion(convId, incluirFuera)); setErr(null); }
    catch (e) { setErr(errTexto(e)); }
  }, [convId, incluirFuera]);
  cEffect(() => { setMs(null); setTexto(""); setTodos(false); cargar(); }, [cargar]);

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
  const responder = async () => {
    if (!texto.trim() || !destino) return;
    setEnviando(true);
    try {
      await CORREO.funcion("responder", { mensaje_id: destino.id, texto, todos });
      setTexto(""); toast("Respuesta enviada desde " + ALIAS);
      await cargar(); onCambio && onCambio();
    } catch (e) { toast("No se pudo enviar: " + errTexto(e)); }
    finally { setEnviando(false); }
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
    {destino ? <div className="inbox__reply">
      <textarea placeholder={`Responder a ${otro.nombre || otro.email}…`} value={texto} onChange={(e) => setTexto(e.target.value)} disabled={enviando}></textarea>
      <div className="row" style={{ marginTop: 8, justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <label className="muted" style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} disabled={enviando} />Responder a todos
        </label>
        <span className="muted" style={{ fontSize: 12 }}>Sale desde {ALIAS}</span>
        <button className="btn btn--primary btn--sm" onClick={responder} disabled={enviando || !texto.trim()}><Icon name="send" size={14} />{enviando ? "Enviando…" : "Responder"}</button>
      </div>
    </div> : null}
    {crear && <NewContact initial={{ full_name: otro.nombre || "", email: otro.email }} onClose={() => setCrear(false)} onSave={async (f) => {
      try {
        await CRM.addContact(Auth.client, f);
        setCrear(false); toast("Contacto creado: sus correos se vinculan solos");
        await cargar(); onCambio && onCambio();
      } catch (e) { toast("No se pudo crear: " + errTexto(e)); throw e; }
    }} />}
  </>;
}

// ---------------------------------------------------------------- redactar
export function Redactar({ onClose, toast, para: paraInicial = "", onEnviado }) {
  const [para, setPara] = cState(paraInicial);
  const [cc, setCc] = cState("");
  const [asunto, setAsunto] = cState("");
  const [texto, setTexto] = cState("");
  const [enviando, setEnviando] = cState(false);
  const lp = listaEmails(para), lc = listaEmails(cc);
  const malos = emailsInvalidos([...lp, ...lc]);
  const puede = lp.length && !malos.length && asunto.trim() && texto.trim() && !enviando;
  const enviar = async () => {
    if (!puede) return;
    setEnviando(true);
    try {
      await CORREO.funcion("enviar", { para: lp, cc: lc, asunto: asunto.trim(), texto });
      toast("Correo enviado desde " + ALIAS);
      onEnviado && onEnviado(); onClose();
    } catch (e) { toast("No se pudo enviar: " + errTexto(e)); }
    finally { setEnviando(false); }
  };
  return <Modal title="Redactar correo" wide onClose={onClose} footer={<>
    <button className="btn btn--ghost" onClick={onClose} disabled={enviando}>Cancelar</button>
    <button className="btn btn--primary" onClick={enviar} disabled={!puede}><Icon name="send" size={15} />{enviando ? "Enviando…" : "Enviar"}</button>
  </>}>
    <Field label="Para"><input className="inp" placeholder="destinatario@empresa.es (varios separados por comas)" value={para} onChange={(e) => setPara(e.target.value)} /></Field>
    <Field label="CC"><input className="inp" value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
    <Field label="Asunto"><input className="inp" value={asunto} onChange={(e) => setAsunto(e.target.value)} /></Field>
    <Field label="Mensaje"><textarea className="inp" style={{ minHeight: 180 }} value={texto} onChange={(e) => setTexto(e.target.value)}></textarea></Field>
    {malos.length > 0 && <p style={{ fontSize: 12, color: "#DC3A47" }}>Email no válido: {malos.join(", ")}</p>}
    <p className="muted" style={{ fontSize: 12 }}>Se envía desde {ALIAS} y queda en Elementos enviados de Outlook.</p>
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
      {redactar && <Redactar onClose={() => setRedactar(false)} toast={toast} onEnviado={() => { setFiltro("sentitems"); cargar(); }} />}
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
    {redactar && <Redactar onClose={() => setRedactar(false)} toast={toast} para={paraInicial} onEnviado={cargar} />}
  </div>;
}
