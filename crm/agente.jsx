import React from "react";
import {
  crearLectorSSE, mensajeDeError, MENSAJE_RED, MENSAJE_CORTE, avisoDeFin, etiquetaHerramienta,
  contextoDeVista, markdown, burbujasDeHistorial, anadirTexto, anotarHerramienta,
} from "./agente-logica.js";
/* GUIMAES CRM — Asistente (fase 1, solo lectura).
   Botón en la topbar + cajón lateral (420 px en escritorio, pantalla completa
   en móvil). Habla con la Edge Function "agente" por SSE (fetch + getReader).
   El texto del modelo se pinta con elementos de React a partir del árbol de
   agente-logica.js: nunca con innerHTML. */
const { useState, useRef, useEffect, useCallback } = React;

const MAX_PREGUNTA = 4000;
const MOVIL = 820; // = MOBILE_BREAKPOINT de app.jsx y @media(max-width:820px)

async function sesion() {
  const { data } = await Auth.client.auth.getSession();
  return data?.session || null;
}

/* ---------------- Markdown → React ---------------- */
function Linea({ nodos, onNav }) {
  return nodos.map((n, i) => {
    switch (n.t) {
      case "texto": return <React.Fragment key={i}>{n.v}</React.Fragment>;
      case "br": return <br key={i} />;
      case "negrita": return <strong key={i}><Linea nodos={n.h} onNav={onNav} /></strong>;
      case "cursiva": return <em key={i}><Linea nodos={n.h} onNav={onNav} /></em>;
      case "codigo": return <code key={i}>{n.v}</code>;
      case "crm": return <a key={i} className="ag-link" href="#" onClick={(e) => { e.preventDefault(); onNav(n.destino); }}>{n.v}</a>;
      case "url": return <a key={i} className="ag-link" href={n.href} target="_blank" rel="noopener noreferrer">{n.v}</a>;
      default: return null;
    }
  });
}
function Markdown({ texto, onNav }) {
  return markdown(texto).map((b, i) => {
    switch (b.t) {
      case "p": return <p key={i}><Linea nodos={b.h} onNav={onNav} /></p>;
      case "h": return React.createElement("h" + (b.nivel + 2), { key: i, className: "ag-h" }, <Linea nodos={b.h} onNav={onNav} />);
      case "ul": return <ul key={i}>{b.items.map((it, k) => <li key={k}><Linea nodos={it} onNav={onNav} /></li>)}</ul>;
      case "ol": return <ol key={i} start={b.inicio}>{b.items.map((it, k) => <li key={k}><Linea nodos={it} onNav={onNav} /></li>)}</ol>;
      case "pre": return <pre key={i}>{b.v}</pre>;
      case "hr": return <hr key={i} />;
      case "tabla": return (
        <div key={i} className="ag-tabla"><table>
          <thead><tr>{b.cabecera.map((c, k) => <th key={k}><Linea nodos={c} onNav={onNav} /></th>)}</tr></thead>
          <tbody>{b.filas.map((f, k) => <tr key={k}>{f.map((c, j) => <td key={j}><Linea nodos={c} onNav={onNav} /></td>)}</tr>)}</tbody>
        </table></div>
      );
      default: return null;
    }
  });
}

/* ---------------- Burbujas ---------------- */
function Herramienta({ p }) {
  const enCurso = p.estado === "inicio";
  return (
    <div className={"ag-tool" + (enCurso ? " ag-tool--run" : "") + (p.error ? " ag-tool--err" : "")}>
      {enCurso ? <span className="ag-spin" aria-hidden="true"></span> : <Icon name={p.error ? "x" : "check"} size={13} />}
      <span>{etiquetaHerramienta(p.nombre)}{enCurso ? "…" : ""}</span>
      {!enCurso && !p.error && typeof p.filas === "number" ? <span className="ag-tool__n">{p.filas}</span> : null}
      {!enCurso && p.error ? <span className="ag-tool__n">sin resultado</span> : null}
    </div>
  );
}
function Burbuja({ b, onNav }) {
  if (b.rol === "user") return <div className="ag-msg ag-msg--user">{b.texto}</div>;
  const vacia = !b.partes.some((p) => p.tipo === "texto" && p.texto.trim());
  return (
    <div className="ag-msg ag-msg--bot">
      {b.partes.map((p, i) => p.tipo === "herramienta"
        ? <Herramienta key={p.id || i} p={p} />
        : <div key={i} className="ag-md"><Markdown texto={p.texto} onNav={onNav} /></div>)}
      {b.pendiente && vacia && !b.partes.some((p) => p.estado === "inicio") && <div className="ag-pensando"><span></span><span></span><span></span></div>}
      {b.error && <div className="ag-aviso ag-aviso--err" role="alert">{b.error}</div>}
      {b.aviso && <div className="ag-aviso">{b.aviso}</div>}
    </div>
  );
}

/* ---------------- Estado y streaming (común al cajón y a la vista) ---------------- */
// Un chat: conversación abierta, burbujas, envío por SSE y cancelación.
// Lo usan el cajón (Asistente) y la vista "Agente IA" (AgenteVista).
export function useChatAgente({ view } = {}) {
  const [convs, setConvs] = useState(null); // null = sin cargar
  const [archivadas, setArchivadas] = useState(false); // la lista muestra las archivadas
  const [convArchivada, setConvArchivada] = useState(false); // la conversación abierta lo está
  const [convId, setConvId] = useState(null);
  const [burbujas, setBurbujas] = useState([]);
  const [entrada, setEntrada] = useState("");
  const [enCurso, setEnCurso] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [aviso, setAviso] = useState(null); // errores del chat (no de una respuesta)
  const abortRef = useRef(null);
  const finRef = useRef(null);
  const textoRef = useRef(null);
  const cargaRef = useRef(0);
  const listaPedida = useRef(false);

  // Si se desmonta (cerrar sesión, cambiar de vista), se corta la petición en curso.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  useEffect(() => { if (finRef.current) finRef.current.scrollIntoView({ block: "end" }); }, [burbujas]);

  const enfocar = () => setTimeout(() => textoRef.current && textoRef.current.focus(), 0);

  const cargarConvs = useCallback(async (verArchivadas = archivadas) => {
    listaPedida.current = true;
    try {
      const s = await sesion();
      if (!s) return;
      // Filtro por el propio usuario: el rol admin puede leer las de todos (RLS).
      const { data, error } = await Auth.client.from("agente_conversaciones")
        .select("id,titulo,updated_at").eq("auth_user_id", s.user.id).eq("archivada", verArchivadas)
        .order("updated_at", { ascending: false }).limit(50);
      if (error) throw error;
      setConvs(data || []);
    } catch (e) {
      setConvs((c) => c || []); setAviso("No se han podido cargar tus conversaciones.");
    }
  }, [archivadas]);
  const verArchivadas = (v) => { setArchivadas(v); setConvs(null); cargarConvs(v); };

  // Archivar solo la oculta de la lista: se sigue guardando y se borra a los
  // 90 días de su último mensaje, como las demás (supabase-agente-archivar.sql).
  const archivar = async (id, valor) => {
    if (enCurso) return;
    setAviso(null);
    const { error } = await Auth.client.from("agente_conversaciones").update({ archivada: valor }).eq("id", id);
    if (error) { setAviso(valor ? "No se ha podido archivar la conversación." : "No se ha podido desarchivar la conversación."); return; }
    setConvs((cs) => (cs || []).filter((c) => c.id !== id));
    if (id === convId) setConvArchivada(valor);
  };

  const abrirConv = async (id) => {
    if (enCurso) return false;
    const n = ++cargaRef.current;
    setConvId(id); setConvArchivada(archivadas); setBurbujas([]); setAviso(null); setCargando(true);
    try {
      const { data, error } = await Auth.client.from("agente_mensajes")
        .select("orden,rol,tipo,texto,stop_reason").eq("conversacion_id", id)
        .in("tipo", ["pregunta", "modelo"]).order("orden", { ascending: true });
      if (error) throw error;
      if (n === cargaRef.current) setBurbujas(burbujasDeHistorial(data));
    } catch (e) {
      if (n === cargaRef.current) setAviso("No se ha podido abrir la conversación.");
    } finally {
      if (n === cargaRef.current) setCargando(false);
    }
    return true;
  };
  const nueva = () => {
    if (enCurso) return false;
    cargaRef.current++;
    setConvId(null); setConvArchivada(false); setBurbujas([]); setAviso(null); setCargando(false); setEntrada("");
    enfocar();
    return true;
  };

  // Actualiza la última burbuja (la respuesta en curso).
  const tocarUltima = (f) => setBurbujas((bs) => {
    if (!bs.length || bs[bs.length - 1].rol !== "assistant") return bs;
    return [...bs.slice(0, -1), f(bs[bs.length - 1])];
  });

  const enviar = async () => {
    const pregunta = entrada.trim();
    if (!pregunta || enCurso) return;
    setAviso(null); setEntrada(""); setEnCurso(true);
    setBurbujas((bs) => [...bs, { rol: "user", texto: pregunta }, { rol: "assistant", partes: [], pendiente: true }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let terminado = false;
    try {
      const s = await sesion();
      if (!s) { tocarUltima((b) => ({ ...b, error: mensajeDeError(401) })); return; }
      const cuerpo = { pregunta };
      if (convId) cuerpo.conversacion_id = convId;
      // Seguir una conversación archivada la vuelve a sacar a la lista.
      if (convId && convArchivada) {
        const { error } = await Auth.client.from("agente_conversaciones").update({ archivada: false }).eq("id", convId);
        if (!error) { setConvArchivada(false); if (archivadas) setConvs((cs) => (cs || []).filter((c) => c.id !== convId)); }
      }
      const ctx = contextoDeVista(view);
      if (ctx) cuerpo.contexto = ctx;
      const res = await fetch(`${window.SUPABASE_CONFIG.url}/functions/v1/agente`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${s.access_token}`, "apikey": window.SUPABASE_CONFIG.anonKey,
          "Content-Type": "application/json", "Accept": "text/event-stream",
        },
        body: JSON.stringify(cuerpo),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let j = null;
        try { j = await res.json(); } catch (e) { /* sin cuerpo JSON */ }
        tocarUltima((b) => ({ ...b, error: mensajeDeError(res.status, j) }));
        return;
      }
      const lector = res.body.getReader();
      // Al cancelar, el fetch ya corta el cuerpo; cancelar el lector lo asegura.
      ctrl.signal.addEventListener("abort", () => { lector.cancel().catch(() => {}); });
      const dec = new TextDecoder();
      const leer = crearLectorSSE();
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        for (const { evento, data } of leer(dec.decode(value, { stream: true }))) {
          if (evento === "conversacion" && data.id) setConvId(data.id);
          else if (evento === "texto" && typeof data.delta === "string") tocarUltima((b) => ({ ...b, partes: anadirTexto(b.partes, data.delta) }));
          else if (evento === "herramienta") tocarUltima((b) => ({ ...b, partes: anotarHerramienta(b.partes, data) }));
          else if (evento === "error") tocarUltima((b) => ({ ...b, error: data.mensaje || mensajeDeError(500) }));
          else if (evento === "fin") {
            terminado = true;
            if (data.conversacion_id) setConvId(data.conversacion_id);
            tocarUltima((b) => ({ ...b, aviso: avisoDeFin(data.motivo) }));
          }
        }
      }
      if (ctrl.signal.aborted) tocarUltima((b) => ({ ...b, aviso: avisoDeFin("cancelado") }));
      else if (!terminado) tocarUltima((b) => ({ ...b, error: b.error || MENSAJE_CORTE }));
    } catch (e) {
      if (e && e.name === "AbortError") tocarUltima((b) => ({ ...b, aviso: avisoDeFin("cancelado") }));
      else tocarUltima((b) => ({ ...b, error: MENSAJE_RED }));
    } finally {
      // Herramientas que se quedaron "en curso" (corte/cancelación): se cierran.
      tocarUltima((b) => ({ ...b, pendiente: false, partes: b.partes.map((p) => p.tipo === "herramienta" && p.estado === "inicio" ? { ...p, estado: "fin", error: true } : p) }));
      abortRef.current = null;
      setEnCurso(false);
      // Si la lista está a la vista, se refresca (conversación nueva o reordenada).
      if (listaPedida.current) cargarConvs();
    }
  };
  const cancelar = () => { if (abortRef.current) abortRef.current.abort(); };

  return { convs, cargarConvs, archivadas, verArchivadas, archivar, convArchivada, convId, burbujas, entrada, setEntrada, enCurso, cargando, aviso,
           abrirConv, nueva, enviar, cancelar, finRef, textoRef, enfocar };
}

/* ---------------- Piezas comunes ---------------- */
function SelectorArchivadas({ chat }) {
  return (
    <div className="ag-filtro" role="tablist" aria-label="Qué conversaciones ver">
      <button role="tab" aria-selected={!chat.archivadas} className={!chat.archivadas ? "on" : ""}
        onClick={() => chat.archivadas && chat.verArchivadas(false)}>Activas</button>
      <button role="tab" aria-selected={chat.archivadas} className={chat.archivadas ? "on" : ""}
        onClick={() => !chat.archivadas && chat.verArchivadas(true)}>Archivadas</button>
    </div>
  );
}
function ListaConversaciones({ chat, onAbrir }) {
  const { convs, convId, aviso, archivadas, enCurso } = chat;
  const vacia = archivadas ? "No tienes conversaciones archivadas." : "Todavía no has hecho ninguna pregunta.";
  return <>
    {convs === null ? <div className="ag-vacio">Cargando…</div>
      : convs.length === 0 ? <div className="ag-vacio">{vacia}</div>
      : convs.map((c) => (
        <div key={c.id} className={"ag-conv" + (c.id === convId ? " active" : "") + (enCurso ? " ag-conv--off" : "")}>
          <button className="ag-conv__abrir" disabled={enCurso} onClick={() => onAbrir(c.id)}>
            <span className="ag-conv__t">{c.titulo || "Sin título"}</span>
            <span className="ag-conv__f">{new Date(c.updated_at).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</span>
          </button>
          <button className="ag-conv__arch" disabled={enCurso} onClick={() => chat.archivar(c.id, !archivadas)}
            title={archivadas ? "Desarchivar" : "Archivar"} aria-label={(archivadas ? "Desarchivar: " : "Archivar: ") + (c.titulo || "Sin título")}>
            <Icon name={archivadas ? "upload" : "archive"} size={15} />
          </button>
        </div>
      ))}
    {archivadas && convs && convs.length > 0 && <div className="ag-nota">Las conversaciones se borran a los 90 días de su último mensaje, estén archivadas o no.</div>}
    {aviso && <div className="ag-aviso ag-aviso--err">{aviso}</div>}
  </>;
}
function Hilo({ chat, onNav }) {
  const { cargando, burbujas, aviso, finRef } = chat;
  return <>
    {cargando && <div className="ag-vacio">Cargando la conversación…</div>}
    {!cargando && burbujas.length === 0 && (
      <div className="ag-intro">
        <p>Pregunta lo que necesites sobre clientes, empresas, el pipeline, tareas, documentos, WhatsApp o el correo.</p>
        <p className="ag-intro__nota">Solo consulta: no cambia ni envía nada. Puede equivocarse; comprueba los datos importantes en la ficha.</p>
      </div>
    )}
    {burbujas.map((b, i) => <Burbuja key={i} b={b} onNav={onNav} />)}
    {aviso && <div className="ag-aviso ag-aviso--err">{aviso}</div>}
    <div ref={finRef}></div>
  </>;
}
function Entrada({ chat, nota }) {
  const { textoRef, entrada, setEntrada, enviar, enCurso, cancelar } = chat;
  return (
    <footer className="ag-foot">
      {nota ? <div className="ag-ctx">{nota}</div> : null}
      <div className="ag-input">
        <textarea ref={textoRef} rows={2} maxLength={MAX_PREGUNTA} value={entrada} placeholder="Escribe tu pregunta…"
          onChange={(e) => setEntrada(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); } }} />
        {enCurso
          ? <button className="btn ag-send ag-send--stop" onClick={cancelar} title="Cancelar" aria-label="Cancelar"><Icon name="x" size={16} /></button>
          : <button className="btn btn--primary ag-send" onClick={enviar} disabled={!entrada.trim()} title="Enviar" aria-label="Enviar"><Icon name="send" size={16} /></button>}
      </div>
    </footer>
  );
}

/* ---------------- Cajón (botón de la topbar) ---------------- */
export function AsistenteBoton({ abierto, onClick, deshabilitado }) {
  return (
    <button className={"topbar__icon topbar__icon--ag" + (abierto ? " topbar__icon--on" : "")}
      title={deshabilitado ? "Ya estás en Agente IA" : "Asistente"} aria-label="Asistente"
      aria-expanded={abierto} aria-disabled={deshabilitado || undefined} onClick={deshabilitado ? undefined : onClick}>
      <Icon name="sparkles" size={18} />
    </button>
  );
}

export function Asistente({ abierto, onCerrar, view, titulo, nav }) {
  const [lista, setLista] = useState(false); // vista de "mis conversaciones"
  const chat = useChatAgente({ view });

  // Móvil: pantalla completa, sin scroll del body detrás. Escape cierra.
  useEffect(() => {
    if (!abierto) return;
    const onKey = (e) => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", onKey);
    const movil = window.innerWidth <= MOVIL;
    if (movil) document.body.classList.add("no-scroll");
    setTimeout(() => chat.textoRef.current && chat.textoRef.current.focus(), 50);
    return () => { window.removeEventListener("keydown", onKey); if (movil) document.body.classList.remove("no-scroll"); };
  }, [abierto]);
  useEffect(() => { if (abierto && lista) chat.cargarConvs(); }, [abierto, lista]);

  const irA = (d) => {
    nav(d.name, d.id);
    if (window.innerWidth <= MOVIL) onCerrar();
  };

  if (!abierto) return null;
  const ctx = contextoDeVista(view);
  return (
    <aside className="ag-panel" role="dialog" aria-label="Asistente">
      <header className="ag-head">
        <div className="ag-head__t"><Icon name="sparkles" size={16} /> Asistente</div>
        <button className="ag-hbtn" title="Mis conversaciones" aria-label="Mis conversaciones" disabled={chat.enCurso}
          onClick={() => setLista((v) => !v)}><Icon name="clock" size={17} /></button>
        <button className="ag-hbtn" title="Nueva conversación" aria-label="Nueva conversación" disabled={chat.enCurso}
          onClick={() => { if (chat.nueva()) setLista(false); }}><Icon name="plus" size={17} /></button>
        <button className="ag-hbtn" title="Cerrar" aria-label="Cerrar" onClick={onCerrar}><Icon name="x" size={17} /></button>
      </header>
      <div className="ag-body">
        {lista
          ? <><div className="ag-lista__t">Mis conversaciones</div>
              <SelectorArchivadas chat={chat} />
              <ListaConversaciones chat={chat} onAbrir={(id) => { setLista(false); chat.abrirConv(id); }} /></>
          : <Hilo chat={chat} onNav={irA} />}
      </div>
      <Entrada chat={chat} nota={ctx && titulo ? `Desde: ${titulo}` : null} />
    </aside>
  );
}

/* ---------------- Vista "Agente IA" (menú lateral) ---------------- */
// Escritorio: lista a la izquierda y chat a la derecha. Móvil: primero la
// lista; al abrir o empezar una conversación, el chat con botón de volver.
function useMovil() {
  const [m, setM] = useState(() => window.innerWidth <= MOVIL);
  useEffect(() => {
    const f = () => setM(window.innerWidth <= MOVIL);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return m;
}
export function AgenteVista({ nav }) {
  const chat = useChatAgente({}); // sin contexto de vista: aquí no hay ficha
  const movil = useMovil();
  const [verChat, setVerChat] = useState(false); // solo cuenta en móvil
  useEffect(() => { chat.cargarConvs(); }, []);
  useEffect(() => { if (!movil) chat.enfocar(); }, [movil]);

  const abrir = (id) => { chat.abrirConv(id).then((ok) => { if (ok) setVerChat(true); }); };
  const nueva = () => { if (chat.nueva()) setVerChat(true); };
  const volver = () => { if (!chat.enCurso) setVerChat(false); };
  const conv = chat.convId && chat.convs && chat.convs.find((c) => c.id === chat.convId);
  const tituloChat = chat.convId ? (conv && conv.titulo) || "Conversación" : "Nueva conversación";

  const lista = (
    <section className="agv__lista">
      <div className="agv__lista-head">
        <div className="ag-lista__t">Mis conversaciones</div>
        <button className="btn btn--primary agv__nueva" onClick={nueva} disabled={chat.enCurso}>
          <Icon name="plus" size={16} />Nueva conversación
        </button>
        <SelectorArchivadas chat={chat} />
      </div>
      <div className="agv__lista-body"><ListaConversaciones chat={chat} onAbrir={abrir} /></div>
    </section>
  );
  const hilo = (
    <section className="agv__chat">
      <header className="agv__chat-head">
        {movil && <button className="ag-hbtn" onClick={volver} disabled={chat.enCurso} title="Volver" aria-label="Volver a mis conversaciones">
          <Icon name="chevronR" size={18} style={{ transform: "rotate(180deg)" }} /></button>}
        <div className="agv__chat-t">{tituloChat}</div>
        {chat.convId && chat.convArchivada && <span className="ag-etiqueta">Archivada</span>}
      </header>
      <div className="ag-body"><Hilo chat={chat} onNav={(d) => nav(d.name, d.id)} /></div>
      <Entrada chat={chat} />
    </section>
  );
  if (movil) return <div className="agv agv--movil">{verChat ? hilo : lista}</div>;
  return <div className="agv">{lista}{hilo}</div>;
}
