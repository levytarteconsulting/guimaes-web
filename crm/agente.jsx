import React from "react";
import {
  crearLectorSSE, mensajeDeError, MENSAJE_RED, MENSAJE_CORTE, avisoDeFin, etiquetaHerramienta,
  contextoDeVista, markdown, burbujasDeHistorial, anadirTexto, anotarHerramienta,
  idsDocumentos, estadoDocumento, filasPropuesta, filasBorrado, datosEditados, destinoDeCambio, estadoPropuesta,
  esBorrado, LISTAS_CAMPO, CAMPOS_SI_NO, tablaDeTipo, estadoCorreo, datosCorreo,
} from "./agente-logica.js";
import { useDocDownload, DocPreviewModal } from "./documentos-comun.jsx";
import { CORREO } from "./correo.jsx";
import { TarjetaAccion } from "./acciones.jsx";
import { TarjetaInforme, InformesGuardados } from "./informes.jsx";
import { peticionDe } from "./informe-logica.js";
/* GUIMAES CRM — Asistente.
   Botón en la topbar + cajón lateral (420 px en escritorio, pantalla completa
   en móvil). Habla con la Edge Function "agente" por SSE (fetch + getReader).
   El texto del modelo se pinta con elementos de React a partir del árbol de
   agente-logica.js: nunca con innerHTML.
   Las herramientas proponer_* del asistente no escriben: crean una propuesta
   (agente_propuestas) que aquí se pinta como tarjeta. Solo al pulsar
   Confirmar se llama a agente_confirmar, con la sesión de quien pulsa.
   proponer_correo tampoco envía: deja un correo en agente_correos que aquí
   se pinta como tarjeta; solo el rol admin ve el botón Enviar, que llama a la
   función correo (accion agente_enviar), y la función vuelve a comprobarlo.
   Las propuestas de Holded salen como TarjetaAccion (acciones.jsx): se
   aprueban o rechazan con las mismas reglas que en la pantalla Acciones. */
const { useState, useRef, useEffect, useCallback, useMemo, useContext } = React;

const MAX_PREGUNTA = 4000;
const MOVIL = 820; // = MOBILE_BREAKPOINT de app.jsx y @media(max-width:820px)

async function sesion() {
  const { data } = await Auth.client.auth.getSession();
  return data?.session || null;
}

/* ---------------- Documentos enlazados ([nombre](doc:ID)) ---------------- */
// El modelo solo ve id y metadatos (agente_listar_documentos); aquí, con la
// sesión del usuario y la RLS de documentos, se piden sus datos para ofrecer
// Ver / Descargar / Ir al documento con las mismas piezas que el módulo
// Documentos (documentos-comun.jsx). La URL firmada nunca va al modelo.
const DocsCtx = React.createContext(null);

function useDocsAgente(burbujas, nav, onIr) {
  const [docs, setDocs] = useState({}); // id → fila | null (no existe / sin acceso)
  const pedidos = useRef(new Set());
  const [mensaje, setMensaje] = useState(null);
  const avisar = (m) => { setMensaje(m); setTimeout(() => setMensaje((x) => (x === m ? null : x)), 4000); };
  const [descargar, bajando] = useDocDownload(avisar);
  const [vista, setVista] = useState(null);
  const ids = useMemo(() => {
    const t = [];
    for (const b of burbujas) if (b.rol === "assistant") for (const p of b.partes) if (p.tipo === "texto") t.push(p.texto);
    return idsDocumentos(t.join("\n"));
  }, [burbujas]);
  const clave = ids.join(",");
  useEffect(() => {
    const faltan = ids.filter((id) => !pedidos.current.has(id));
    if (!faltan.length) return;
    faltan.forEach((id) => pedidos.current.add(id));
    CRM.loadDocumentosPorIds(Auth.client, faltan)
      .then((filas) => setDocs((d) => {
        const n = { ...d };
        faltan.forEach((id) => { n[id] = null; });
        filas.forEach((f) => { n[String(f.id).toLowerCase()] = f; });
        return n;
      }))
      .catch(() => {
        faltan.forEach((id) => pedidos.current.delete(id)); // se reintentará
        avisar("No se han podido comprobar los documentos enlazados.");
      });
  }, [clave]);
  const ctx = {
    docs, bajando,
    // Ver: visor del módulo Documentos (PDF e imágenes); el resto, descarga.
    ver: (doc) => (CRM.docPreviewKind(doc) ? setVista(doc) : descargar(doc)),
    descargar,
    ir: (doc) => { nav("empresa", doc.empresa_id, { doc: doc.id }); if (onIr) onIr(); },
  };
  const modal = vista
    ? <DocPreviewModal doc={vista} onClose={() => setVista(null)} onDownload={descargar} downloading={bajando === vista.id} />
    : null;
  return { ctx, modal, mensaje, visorAbierto: !!vista };
}

function DocEnlace({ id, nombre }) {
  const ctx = useContext(DocsCtx);
  const doc = ctx ? ctx.docs[id] : null;
  const st = estadoDocumento(doc);
  return (
    <span className={"ag-doc" + (st.acciones ? "" : " ag-doc--off")}>
      <Icon name="documents" size={13} />
      <span className="ag-doc__n">{nombre}</span>
      {st.acciones && (
        <span className="ag-doc__acc">
          <button type="button" title="Ver" aria-label={"Ver " + nombre} onClick={() => ctx.ver(doc)}><Icon name="eye" size={13} /></button>
          <button type="button" title="Descargar" aria-label={"Descargar " + nombre} disabled={ctx.bajando === doc.id}
            onClick={() => ctx.descargar(doc)}><Icon name="download" size={13} /></button>
          {doc.empresa_id && <button type="button" title="Ir al documento" aria-label={"Ir al documento " + nombre}
            onClick={() => ctx.ir(doc)}><Icon name="arrowR" size={13} /></button>}
        </span>
      )}
      {st.aviso && <span className="ag-doc__aviso">{st.aviso}</span>}
    </span>
  );
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
      case "doc": return <DocEnlace key={i} id={n.id} nombre={n.v} />;
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

/* ---------------- Tarjetas de propuesta ---------------- */
const ESTADOS_TARJETA = { pendiente: "Pendiente de confirmar", confirmada: "Hecho", cancelada: "Cancelada", caducada: "Caducada" };
function opcionesDe(k) {
  const l = LISTAS_CAMPO[k];
  if (!l) return null;
  if (Array.isArray(l)) return l;
  if (l === "USERS") return (CRM.USERS || []).map((u) => [u.id, u.name]);
  return (CRM[l] || []).map((o) => [o.id, o.name || o.label || o.id]);
}
function valorLegible(k, v) {
  if (v === null || v === undefined || v === "") return "—";
  const base = k.split(".").pop();
  if (CAMPOS_SI_NO.has(base)) return v ? "Sí" : "No";
  const ops = opcionesDe(base);
  if (ops) { const o = ops.find(([id]) => String(id) === String(v)); if (o) return o[1]; }
  if (base === "empresa_id") return (CRM.empresaById[v] || {}).razon_social || v;
  if (base === "contact_id") return (CRM.contactById[v] || {}).full_name || v;
  if (base === "deal_id") { const d = (CRM.DEALS || []).find((x) => x.id === v); return d ? d.title : v; }
  if (base === "due_at") { try { return new Date(v).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Madrid" }); } catch (e) { return v; } }
  if (base === "amount" || base === "coste_nomina") { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("es-ES", { style: "currency", currency: "EUR" }) : v; }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function aEditable(k, v) {
  if (v === null || v === undefined) return "";
  if (k.split(".").pop() === "due_at") {
    try { return new Date(v).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).slice(0, 16).replace(" ", "T"); } catch (e) { return String(v); }
  }
  return typeof v === "boolean" ? v : String(v);
}

function Tarjeta({ id, onNav }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState("");
  const [editando, setEditando] = useState(null);   // { clave: valor } mientras se edita
  const [texto, setTexto] = useState("");
  const [busy, setBusy] = useState(false);
  const [hecho, setHecho] = useState(null);          // respuesta de agente_confirmar
  const cargar = useCallback(async () => {
    const { data, error } = await Auth.client.from("agente_propuestas")
      .select("id, tipo, registro_id, datos, antes, coincidencias, resumen, estado, resultado_id, expira_at").eq("id", id).maybeSingle();
    if (error || !data) { setErr("No se ha podido cargar la propuesta."); return; }
    setP(data);
  }, [id]);
  useEffect(() => { cargar(); }, [cargar]);
  const estado = estadoPropuesta(p);
  const filas = filasPropuesta(p);
  const borrar = p && esBorrado(p.tipo);
  const editar = () => setEditando(Object.fromEntries(filas.map((f) => [f.k, aEditable(f.k, f.nuevo)])));
  const confirmar = async () => {
    setBusy(true); setErr("");
    try {
      let datos = null;
      if (editando) {
        datos = datosEditados(p.datos, editando);
      }
      const { data, error } = await Auth.client.rpc("agente_confirmar", { p_propuesta: id, p_datos: datos, p_texto: borrar ? texto : null });
      if (error) throw error;
      setHecho(data); setEditando(null);
      await CRM.refrescarTrasAgente(Auth.client, data);
      await cargar();
    } catch (e) {
      setErr((e && e.message) || "No se ha podido hacer el cambio.");
    }
    setBusy(false);
  };
  const cancelar = async () => {
    setBusy(true); setErr("");
    const { error } = await Auth.client.rpc("agente_cancelar", { p_propuesta: id });
    if (error) setErr(error.message || "No se ha podido cancelar.");
    await cargar(); setBusy(false);
  };
  if (!p) return <div className="ag-card ag-card--carga">{err || "Cargando la propuesta…"}</div>;
  const destino = destinoDeCambio(hecho || (p.estado === "confirmada"
    ? { tipo: p.tipo, registro_id: p.resultado_id, tabla: tablaDeTipo(p.tipo), contact_id: p.registro_id } : null));
  return (
    <div className={"ag-card ag-card--" + estado + (borrar ? " ag-card--borrar" : "")}>
      <div className="ag-card__cab">
        <b>{p.resumen}</b>
        <span className="ag-card__estado">{ESTADOS_TARJETA[estado] || estado}</span>
      </div>
      {borrar ? (
        <table className="ag-card__tabla"><tbody>
          {filasBorrado(p).map(([k, v]) => <tr key={k}><th>{k}</th><td>{typeof v === "boolean" ? (v ? "Sí" : "No") : String(v)}</td></tr>)}
        </tbody></table>
      ) : (
        <table className="ag-card__tabla">
          {filas.some((f) => f.hay_antes) && <thead><tr><th></th><th>Ahora</th><th>Quedará</th></tr></thead>}
          <tbody>{filas.map((f) => <tr key={f.k}>
            <th>{f.etiqueta}</th>
            {f.hay_antes && <td className="ag-card__antes">{valorLegible(f.k, f.antes)}</td>}
            <td>{editando ? <CampoEditable k={f.k} valor={editando[f.k]} onCambio={(v) => setEditando({ ...editando, [f.k]: v })} />
                          : valorLegible(f.k, f.nuevo)}</td>
          </tr>)}</tbody>
        </table>
      )}
      {estado === "pendiente" && (p.coincidencias || []).length > 0 && <div className="ag-card__dup">
        <b>Ya existe algo parecido:</b>
        <ul>{p.coincidencias.map((c) => <li key={c.id}>
          <a className="ag-link" href="#" onClick={(e) => { e.preventDefault(); onNav({ name: c.tipo === "empresa" ? "empresa" : "contact", id: c.id }); }}>{c.nombre || "(sin nombre)"}</a>
          {" "}({c.tipo}, {c.motivo}{c.archivada ? ", archivada" : ""})</li>)}</ul>
        <span>Si es la misma, cancela y dile al asistente que use la existente.</span>
      </div>}
      {err && <div className="ag-aviso ag-aviso--err" role="alert">{err}</div>}
      {estado === "pendiente" && <div className="ag-card__acc">
        {borrar && <input className="inp" placeholder="Escribe BORRAR" value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Escribe BORRAR para confirmar" />}
        <button className={"btn btn--sm " + (borrar ? "btn--danger" : "btn--primary")} disabled={busy || (borrar && texto.trim().toUpperCase() !== "BORRAR")}
          onClick={confirmar}>{busy ? "…" : borrar ? "Borrar" : "Confirmar"}</button>
        {!borrar && !editando && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={editar}>Editar</button>}
        {editando && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setEditando(null)}>Descartar cambios</button>}
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={cancelar}>Cancelar</button>
      </div>}
      {estado === "confirmada" && destino && <div className="ag-card__acc">
        <button className="btn btn--sm btn--ghost" onClick={() => onNav(destino)}>Abrir</button></div>}
      {estado === "caducada" && <div className="ag-card__nota">Ha pasado más de un día: pídesela otra vez al asistente.</div>}
    </div>
  );
}
/* ---------------- Tarjeta de correo ---------------- */
const ESTADOS_CORREO = { pendiente: "Sin enviar", enviando: "Enviando…", enviada: "Enviado", cancelada: "Cancelado", caducado: "Caducado" };
// ¿Quien usa el CRM es rol admin? (el servidor lo vuelve a comprobar al enviar)
function useSoyRolAdmin() {
  const [si, setSi] = useState(false);
  useEffect(() => {
    let vivo = true;
    Auth.client.auth.getSession().then(({ data }) => {
      const uid = data && data.session && data.session.user && data.session.user.id;
      const u = (CRM.USERS || []).find((x) => x.auth_user_id === uid);
      if (vivo) setSi(!!u && u.role === "admin" && u.activo !== false);
    }).catch(() => {});
    return () => { vivo = false; };
  }, []);
  return si;
}
const COLS_CORREO = "id, created_at, auth_user_id, para, cc, cco, asunto, texto, documentos, adjuntos, avisos, contact_id, empresa_id, resumen, estado, expira_at, enviado_por, enviado_at, ultimo_error";
export function TarjetaCorreo({ id, onNav, onCambio }) {
  const [c, setC] = useState(null);
  const [err, setErr] = useState("");
  const [ed, setEd] = useState(null);       // { para, cc, cco, asunto, texto, documentos } mientras se edita
  const [busy, setBusy] = useState(false);
  const soyAdmin = useSoyRolAdmin();
  const cargar = useCallback(async () => {
    const { data, error } = await Auth.client.from("agente_correos").select(COLS_CORREO).eq("id", id).maybeSingle();
    if (error || !data) { setErr("No se ha podido cargar el correo."); return; }
    setC(data);
  }, [id]);
  useEffect(() => { cargar(); }, [cargar]);
  // Mientras se envía, se vuelve a mirar cada pocos segundos.
  useEffect(() => { if (!c || c.estado !== "enviando") return; const t = setTimeout(cargar, 4000); return () => clearTimeout(t); }, [c, cargar]);
  const estado = estadoCorreo(c);
  const fallo = (e, def) => setErr((e && e.message) || def);
  const guardar = async () => {
    setBusy(true); setErr("");
    const { error } = await Auth.client.rpc("agente_correo_editar", { p_correo: id, p_datos: datosCorreo(c, ed) });
    if (error) fallo(error, "No se ha podido guardar."); else { setEd(null); await cargar(); }
    setBusy(false);
  };
  const enviar = async () => {
    setBusy(true); setErr("");
    try { await CORREO.funcion("agente_enviar", { correo: id }); }
    catch (e) { fallo(e, "No se ha podido enviar."); }
    await cargar(); setBusy(false); if (onCambio) onCambio();
  };
  const cancelar = async () => {
    setBusy(true); setErr("");
    const { error } = await Auth.client.rpc("agente_correo_cancelar", { p_correo: id });
    if (error) fallo(error, "No se ha podido cancelar.");
    await cargar(); setBusy(false); if (onCambio) onCambio();
  };
  if (!c) return <div className="ag-card ag-card--carga">{err || "Cargando el correo…"}</div>;
  const nombre = (cid) => (CRM.contactById[cid] || {}).full_name;
  const empresa = c.empresa_id ? ((CRM.empresaById[c.empresa_id] || {}).razon_social || "empresa") : null;
  const adjuntos = (c.adjuntos || []).filter((a) => !ed || (ed.documentos || []).includes(a.id));
  const linea = (k, etiqueta) => (ed ? true : (c[k] || []).length > 0) && <tr><th>{etiqueta}</th><td>
    {ed ? <input className="inp" value={ed[k]} onChange={(e) => setEd({ ...ed, [k]: e.target.value })} placeholder="email, email…" />
        : (c[k] || []).join(", ")}</td></tr>;
  const claseEstado = { enviada: "confirmada", cancelada: "cancelada", caducado: "caducada" }[estado] || "pendiente";
  return (
    <div className={"ag-card ag-card--correo ag-card--" + claseEstado}>
      <div className="ag-card__cab"><b>{c.resumen}</b><span className="ag-card__estado">{ESTADOS_CORREO[estado] || estado}</span></div>
      <table className="ag-card__tabla"><tbody>
        <tr><th>De</th><td>info@guimaes.es</td></tr>
        {linea("para", "Para")}{linea("cc", "CC")}{linea("cco", "CCO")}
        <tr><th>Asunto</th><td>{ed ? <input className="inp" value={ed.asunto} onChange={(e) => setEd({ ...ed, asunto: e.target.value })} /> : c.asunto}</td></tr>
        {(c.contact_id || empresa) && <tr><th>Ficha</th><td>
          {c.contact_id && <a className="ag-link" href="#" onClick={(e) => { e.preventDefault(); onNav({ name: "contact", id: c.contact_id }); }}>{nombre(c.contact_id) || "contacto"}</a>}
          {c.contact_id && empresa && " · "}
          {empresa && <a className="ag-link" href="#" onClick={(e) => { e.preventDefault(); onNav({ name: "empresa", id: c.empresa_id }); }}>{empresa}</a>}
        </td></tr>}
        {adjuntos.length > 0 && <tr><th>Adjuntos</th><td>{adjuntos.map((a) => <div key={a.id}>
          📎 {a.nombre}{a.tamano ? ` (${Math.max(1, Math.round(a.tamano / 1024))} KB)` : ""}
          {ed && <button className="btn btn--sm btn--ghost" onClick={() => setEd({ ...ed, documentos: ed.documentos.filter((x) => x !== a.id) })}>Quitar</button>}
        </div>)}</td></tr>}
      </tbody></table>
      {ed ? <textarea className="inp ag-card__texto" rows={8} value={ed.texto} onChange={(e) => setEd({ ...ed, texto: e.target.value })} />
          : <div className="ag-card__texto">{c.texto}</div>}
      {estado === "pendiente" && (c.avisos || []).length > 0 && <div className="ag-card__dup"><b>Avisos:</b><ul>{c.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      {c.ultimo_error && estado === "pendiente" && <div className="ag-aviso ag-aviso--err" role="alert">No se envió: {c.ultimo_error}</div>}
      {err && <div className="ag-aviso ag-aviso--err" role="alert">{err}</div>}
      {estado === "pendiente" && <div className="ag-card__acc">
        {!ed && soyAdmin && <button className="btn btn--sm btn--primary" disabled={busy} onClick={enviar}>{busy ? "Enviando…" : "Enviar"}</button>}
        {!ed && <button className="btn btn--sm btn--ghost" disabled={busy}
          onClick={() => setEd({ para: (c.para || []).join(", "), cc: (c.cc || []).join(", "), cco: (c.cco || []).join(", "), asunto: c.asunto, texto: c.texto, documentos: c.documentos || [] })}>Editar</button>}
        {ed && <button className="btn btn--sm btn--primary" disabled={busy} onClick={guardar}>Guardar cambios</button>}
        {ed && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setEd(null)}>Descartar cambios</button>}
        {!ed && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={cancelar}>Cancelar</button>}
      </div>}
      {estado === "pendiente" && !soyAdmin && <div className="ag-card__nota">Lo envía un administrador: lo verá en Acciones → Correos del asistente.</div>}
      {estado === "enviada" && <div className="ag-card__nota">Enviado desde info@ el {c.enviado_at ? new Date(c.enviado_at).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Madrid" }) : ""}; está en Enviados{c.contact_id || empresa ? " y en la ficha" : ""}.</div>}
      {estado === "caducado" && <div className="ag-card__nota">Han pasado más de 7 días: pídeselo otra vez al asistente.</div>}
    </div>
  );
}

function CampoEditable({ k, valor, onCambio }) {
  const base = k.split(".").pop();
  if (CAMPOS_SI_NO.has(base)) return <input type="checkbox" checked={!!valor} onChange={(e) => onCambio(e.target.checked)} />;
  const ops = opcionesDe(base);
  if (ops) return <select className="inp" value={valor ?? ""} onChange={(e) => onCambio(e.target.value)}>
    <option value="">—</option>{ops.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>;
  if (base === "body") return <textarea className="inp" rows={4} value={valor ?? ""} onChange={(e) => onCambio(e.target.value)} />;
  const tipo = base === "due_at" ? "datetime-local" : /_at$/.test(base) ? "date" : "text";
  return <input className="inp" type={tipo} value={valor ?? ""} onChange={(e) => onCambio(e.target.value)} />;
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
function Burbuja({ b, onNav, peticion }) {
  if (b.rol === "user") return <div className="ag-msg ag-msg--user">{b.texto}</div>;
  const vacia = !b.partes.some((p) => p.tipo === "texto" && p.texto.trim());
  return (
    <div className="ag-msg ag-msg--bot">
      {b.partes.map((p, i) => p.tipo === "herramienta" && p.informe
        ? <TarjetaInforme key={p.id || i} informe={p.informe} peticion={peticion} onNav={onNav} />
        : p.tipo === "herramienta" && p.accion
        ? <TarjetaAccion key={p.accion} id={p.accion} onNav={onNav} />
        : p.tipo === "herramienta" && p.correo
        ? <TarjetaCorreo key={p.correo} id={p.correo} onNav={onNav} />
        : p.tipo === "herramienta" && p.propuesta
        ? <Tarjeta key={p.propuesta} id={p.propuesta} onNav={onNav} />
        : p.tipo === "herramienta"
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
      const [{ data, error }, props, correos, acciones, informes] = await Promise.all([
        Auth.client.from("agente_mensajes")
          .select("orden,rol,tipo,texto,stop_reason,created_at").eq("conversacion_id", id)
          .in("tipo", ["pregunta", "modelo"]).order("orden", { ascending: true }),
        Auth.client.from("agente_propuestas").select("id, created_at").eq("conversacion_id", id).order("created_at"),
        Auth.client.from("agente_correos").select("id, created_at").eq("conversacion_id", id).order("created_at"),
        Auth.client.from("agente_tool_calls").select("tarjeta_id, created_at").eq("conversacion_id", id)
          .in("herramienta", ["holded_proponer_accion", "holded_proponer_operacion"]).not("tarjeta_id", "is", null).order("created_at"),
        Auth.client.from("agente_tool_calls").select("id, parametros, created_at").eq("conversacion_id", id)
          .eq("herramienta", "mostrar_informe").eq("es_error", false).order("created_at"),
      ]);
      if (error) throw error;
      const tarjetas = [...(props.error ? [] : props.data), ...(correos.error ? [] : correos.data.map((x) => ({ ...x, clase: "correo" }))),
                        ...(acciones.error ? [] : acciones.data.map((x) => ({ id: x.tarjeta_id, created_at: x.created_at, clase: "accion" }))),
                        ...(informes.error ? [] : informes.data.filter((x) => x.parametros && Array.isArray(x.parametros.secciones))
                          .map((x) => ({ id: x.id, created_at: x.created_at, clase: "informe", informe: x.parametros })))];
      if (n === cargaRef.current) setBurbujas(burbujasDeHistorial(data, tarjetas));
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

  // forzado = { texto, nueva }: regenerar un informe guardado (su petición, en una conversación nueva).
  const enviar = async (forzado) => {
    const esForzado = !!(forzado && typeof forzado.texto === "string");   // onClick pasa el evento: no cuenta
    const nuevaConv = esForzado && !!forzado.nueva;
    const pregunta = (esForzado ? forzado.texto : entrada).trim();
    if (!pregunta || enCurso) return;
    const conv = nuevaConv ? null : convId;
    if (nuevaConv) { cargaRef.current++; setConvId(null); setConvArchivada(false); setCargando(false); }
    setAviso(null); if (!esForzado) setEntrada(""); setEnCurso(true);
    const nuevas = [{ rol: "user", texto: pregunta }, { rol: "assistant", partes: [], pendiente: true }];
    setBurbujas((bs) => nuevaConv ? nuevas : [...bs, ...nuevas]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let terminado = false;
    try {
      const s = await sesion();
      if (!s) { tocarUltima((b) => ({ ...b, error: mensajeDeError(401) })); return; }
      const cuerpo = { pregunta };
      if (conv) cuerpo.conversacion_id = conv;
      // Seguir una conversación archivada la vuelve a sacar a la lista.
      if (conv && convArchivada) {
        const { error } = await Auth.client.from("agente_conversaciones").update({ archivada: false }).eq("id", conv);
        if (!error) { setConvArchivada(false); if (archivadas) setConvs((cs) => (cs || []).filter((c) => c.id !== conv)); }
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
        <p className="ag-intro__nota">Consulta, propone cambios, redacta correos y prepara informes. No cambia ni envía nada sin que lo confirmes en su tarjeta. Puede equivocarse; comprueba los datos importantes en la ficha.</p>
      </div>
    )}
    {burbujas.map((b, i) => <Burbuja key={i} b={b} onNav={onNav} peticion={b.rol === "assistant" ? peticionDe(burbujas, i) : ""} />)}
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
  const cerrarSiMovil = () => { if (window.innerWidth <= MOVIL) onCerrar(); };
  const docs = useDocsAgente(chat.burbujas, nav, cerrarSiMovil);
  const visorRef = useRef(false);
  visorRef.current = docs.visorAbierto;

  // Móvil: pantalla completa, sin scroll del body detrás. Escape cierra.
  useEffect(() => {
    if (!abierto) return;
    // Con el visor de un documento abierto, Escape solo cierra el visor.
    const onKey = (e) => { if (e.key === "Escape" && !visorRef.current) onCerrar(); };
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
    <DocsCtx.Provider value={docs.ctx}>
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
              <InformesGuardados deshabilitado={chat.enCurso} onRegenerar={(texto) => { setLista(false); chat.enviar({ texto, nueva: true }); }} />
              <ListaConversaciones chat={chat} onAbrir={(id) => { setLista(false); chat.abrirConv(id); }} /></>
          : <Hilo chat={chat} onNav={irA} />}
      </div>
      {docs.mensaje && <div className="ag-aviso ag-aviso--err ag-aviso--flota" role="alert">{docs.mensaje}</div>}
      <Entrada chat={chat} nota={ctx && titulo ? `Desde: ${titulo}` : null} />
      {/* Dentro del cajón: así el visor queda por encima de él (z-index). */}
      {docs.modal}
    </aside>
    </DocsCtx.Provider>
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
  const docs = useDocsAgente(chat.burbujas, nav);
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
      <div className="agv__lista-body">
        <InformesGuardados deshabilitado={chat.enCurso} onRegenerar={(texto) => { chat.enviar({ texto, nueva: true }); setVerChat(true); }} />
        <ListaConversaciones chat={chat} onAbrir={abrir} />
      </div>
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
      {docs.mensaje && <div className="ag-aviso ag-aviso--err ag-aviso--flota" role="alert">{docs.mensaje}</div>}
      <Entrada chat={chat} />
    </section>
  );
  return (
    <DocsCtx.Provider value={docs.ctx}>
      {movil ? <div className="agv agv--movil">{verChat ? hilo : lista}</div> : <div className="agv">{lista}{hilo}</div>}
      {docs.modal}
    </DocsCtx.Provider>
  );
}
