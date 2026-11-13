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

/* ---------------- Panel ---------------- */
export function AsistenteBoton({ abierto, onClick }) {
  return (
    <button className={"topbar__icon topbar__icon--ag" + (abierto ? " topbar__icon--on" : "")} title="Asistente" aria-label="Asistente"
      aria-expanded={abierto} onClick={onClick}>
      <Icon name="star" size={18} />
    </button>
  );
}

export function Asistente({ abierto, onCerrar, view, titulo, nav }) {
  const [lista, setLista] = useState(false); // vista de "mis conversaciones"
  const [convs, setConvs] = useState(null);
  const [convId, setConvId] = useState(null);
  const [burbujas, setBurbujas] = useState([]);
  const [entrada, setEntrada] = useState("");
  const [enCurso, setEnCurso] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [aviso, setAviso] = useState(null); // errores del panel (no de una respuesta)
  const abortRef = useRef(null);
  const finRef = useRef(null);
  const textoRef = useRef(null);
  const cargaRef = useRef(0);

  // Móvil: pantalla completa, sin scroll del body detrás. Escape cierra.
  useEffect(() => {
    if (!abierto) return;
    const onKey = (e) => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", onKey);
    const movil = window.innerWidth <= MOVIL;
    if (movil) document.body.classList.add("no-scroll");
    setTimeout(() => textoRef.current && textoRef.current.focus(), 50);
    return () => { window.removeEventListener("keydown", onKey); if (movil) document.body.classList.remove("no-scroll"); };
  }, [abierto]);
  // Si se desmonta (cerrar sesión), se corta la petición en curso.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  useEffect(() => { if (finRef.current) finRef.current.scrollIntoView({ block: "end" }); }, [burbujas]);

  const cargarConvs = useCallback(async () => {
    try {
      const s = await sesion();
      if (!s) return;
      // Filtro por el propio usuario: el rol admin puede leer las de todos (RLS).
      const { data, error } = await Auth.client.from("agente_conversaciones")
        .select("id,titulo,updated_at").eq("auth_user_id", s.user.id).eq("archivada", false)
        .order("updated_at", { ascending: false }).limit(50);
      if (error) throw error;
      setConvs(data || []);
    } catch (e) {
      setConvs([]); setAviso("No se han podido cargar tus conversaciones.");
    }
  }, []);
  useEffect(() => { if (abierto && lista) cargarConvs(); }, [abierto, lista]);

  const abrirConv = async (id) => {
    if (enCurso) return;
    const n = ++cargaRef.current;
    setLista(false); setConvId(id); setBurbujas([]); setAviso(null); setCargando(true);
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
  };
  const nueva = () => {
    if (enCurso) return;
    cargaRef.current++;
    setConvId(null); setBurbujas([]); setLista(false); setAviso(null); setCargando(false); setEntrada("");
    setTimeout(() => textoRef.current && textoRef.current.focus(), 0);
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
    }
  };
  const cancelar = () => { if (abortRef.current) abortRef.current.abort(); };

  const irA = (d) => {
    nav(d.name, d.id);
    if (window.innerWidth <= MOVIL) onCerrar();
  };

  if (!abierto) return null;
  const ctx = contextoDeVista(view);
  return (
    <aside className="ag-panel" role="dialog" aria-label="Asistente">
      <header className="ag-head">
        <div className="ag-head__t"><Icon name="star" size={16} /> Asistente</div>
        <button className="ag-hbtn" title="Mis conversaciones" aria-label="Mis conversaciones" disabled={enCurso}
          onClick={() => setLista((v) => !v)}><Icon name="clock" size={17} /></button>
        <button className="ag-hbtn" title="Nueva conversación" aria-label="Nueva conversación" disabled={enCurso}
          onClick={nueva}><Icon name="plus" size={17} /></button>
        <button className="ag-hbtn" title="Cerrar" aria-label="Cerrar" onClick={onCerrar}><Icon name="x" size={17} /></button>
      </header>

      {lista ? (
        <div className="ag-body">
          <div className="ag-lista__t">Mis conversaciones</div>
          {convs === null ? <div className="ag-vacio">Cargando…</div>
            : convs.length === 0 ? <div className="ag-vacio">Todavía no has hecho ninguna pregunta.</div>
            : convs.map((c) => (
              <button key={c.id} className={"ag-conv" + (c.id === convId ? " active" : "")} onClick={() => abrirConv(c.id)}>
                <span className="ag-conv__t">{c.titulo || "Sin título"}</span>
                <span className="ag-conv__f">{new Date(c.updated_at).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}</span>
              </button>
            ))}
          {aviso && <div className="ag-aviso ag-aviso--err">{aviso}</div>}
        </div>
      ) : (
        <div className="ag-body">
          {cargando && <div className="ag-vacio">Cargando la conversación…</div>}
          {!cargando && burbujas.length === 0 && (
            <div className="ag-intro">
              <p>Pregunta lo que necesites sobre clientes, empresas, el pipeline, tareas, documentos, WhatsApp o el correo.</p>
              <p className="ag-intro__nota">Solo consulta: no cambia ni envía nada. Puede equivocarse; comprueba los datos importantes en la ficha.</p>
            </div>
          )}
          {burbujas.map((b, i) => <Burbuja key={i} b={b} onNav={irA} />)}
          {aviso && <div className="ag-aviso ag-aviso--err">{aviso}</div>}
          <div ref={finRef}></div>
        </div>
      )}

      <footer className="ag-foot">
        {ctx && titulo ? <div className="ag-ctx">Desde: {titulo}</div> : null}
        <div className="ag-input">
          <textarea ref={textoRef} rows={2} maxLength={MAX_PREGUNTA} value={entrada} placeholder="Escribe tu pregunta…"
            onChange={(e) => setEntrada(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); } }} />
          {enCurso
            ? <button className="btn ag-send ag-send--stop" onClick={cancelar} title="Cancelar" aria-label="Cancelar"><Icon name="x" size={16} /></button>
            : <button className="btn btn--primary ag-send" onClick={enviar} disabled={!entrada.trim()} title="Enviar" aria-label="Enviar"><Icon name="send" size={16} /></button>}
        </div>
      </footer>
    </aside>
  );
}
