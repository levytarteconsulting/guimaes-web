import React from "react";
import { TarjetaCorreo } from "./agente.jsx";
/* GUIMAES CRM — Acciones en Holded (solo rol admin).
   Propuestas de escritura en Holded que prepara el asistente o el operador:
   aprobar tickets de venta, o cualquier operación de la lista cerrada de la
   API v2 (crear, modificar, borrar…), con la petición exacta y el estado
   actual de cada documento para comparar. Aquí se revisan (resumen, muestra,
   excluidos y avisos), se aprueban o rechazan y, una vez aprobadas, se sigue
   su ejecución, que hace la Edge Function holded-acciones en segundo plano
   (pg_cron, cada minuto): pausar, reanudar y cancelar. Aprobar más de 100
   documentos exige escribir el número; aprobar una de riesgo alto, escribir
   CONFIRMAR. También el cupo mensual de acciones por empresa y las políticas
   (aprobación o automática con límites). Ver crm/supabase-holded-acciones.sql
   y crm/supabase-holded-operaciones.sql.
   Arriba, los correos que ha redactado el asistente (agente_correos) y
   esperan a que un administrador los revise y los envíe. TarjetaAccion es
   la misma propuesta en pequeño, para el chat del asistente. */
const { useState: aState, useEffect: aEffect, useMemo: aMemo } = React;

const TIPOS = { aprobar_tickets_venta: "Aprobar tickets de venta", operacion: "Operación en Holded" };
const esOp = (a) => a.tipo === "operacion";
const titulo = (a) => esOp(a) ? (a.descripcion || (a.resumen || {}).descripcion || "Operación en Holded") : (TIPOS[a.tipo] || a.tipo);
const ESTADOS = {
  propuesta: ["Propuesta", "var(--warn)"], aprobada: ["Aprobada · en cola", "var(--accent, #2563eb)"],
  en_curso: ["En curso", "var(--accent, #2563eb)"], pausada: ["Pausada", "var(--warn)"],
  completada: ["Completada", "var(--ok, #16a34a)"], cancelada: ["Cancelada", "var(--muted, #6b7280)"],
  rechazada: ["Rechazada", "var(--muted, #6b7280)"],
};
const COLUMNAS = "id, created_at, updated_at, empresa_id, tipo, parametros, resumen, avisos, estado, motivo_estado, origen, propuesta_por, aprobada_por, aprobada_at, rechazada_por, cerrada_por, iniciada_at, terminada_at, expira_at, llamadas_lectura, llamadas_escritura, operacion, riesgo, descripcion, purgada_at";
const fmtFecha = (s) => { try { return new Date(s).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Madrid" }); } catch (e) { return s || ""; } };
const fmtDia = (s) => { if (!s) return "—"; const [y, m, d] = String(s).split("-"); return d ? `${d}/${m}/${y}` : s; };
const eur = (n, moneda) => { try { return Number(n).toLocaleString("es-ES", { style: "currency", currency: (moneda && moneda.length === 3) ? moneda : "EUR" }); } catch (e) { return String(n); } };
const errorTexto = (e) => (e && (e.message || e.error_description)) || String(e);
const nombreEmpresa = (id) => (CRM.empresaById[id] || {}).razon_social || "(empresa borrada)";
const nombreUsuario = (authId) => { const u = (CRM.USERS || []).find((x) => x.auth_user_id === authId); return u ? u.name : authId ? "usuario" : "—"; };
const quienPropuso = (a) => a.origen === "operador" ? "Operador (Claude Code)" : `${nombreUsuario(a.propuesta_por)}${a.origen === "agente" ? " · asistente" : ""}`;
const viva = (a) => ["aprobada", "en_curso"].includes(a.estado);
const caducada = (a) => a.estado === "propuesta" && new Date(a.expira_at) < new Date();

async function rpc(fn, args) {
  const r = await Auth.client.rpc(fn, args);
  if (r.error) throw r.error;
  return r.data;
}

function Estado({ a }) {
  const [txt, color] = caducada(a) ? ["Caducada", "var(--muted, #6b7280)"] : (ESTADOS[a.estado] || [a.estado, undefined]);
  return <span style={{ fontSize: 12, fontWeight: 600, color, whiteSpace: "nowrap" }}>{txt}</span>;
}

function Riesgo({ r }) {
  if (!r) return null;
  const alto = r === "alto";
  return <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 4, whiteSpace: "nowrap",
    color: alto ? "#fff" : "var(--muted, #6b7280)", background: alto ? "var(--danger, #dc2626)" : "var(--line, #e5e7eb)" }}>{alto ? "RIESGO ALTO" : "riesgo normal"}</span>;
}

function Barra({ p }) {
  if (!p || !p.total) return null;
  const pct = (n) => `${(100 * n / p.total).toFixed(2)}%`;
  return <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--line, #e5e7eb)", margin: "6px 0" }}>
    <div style={{ width: pct(p.ok), background: "var(--ok, #16a34a)" }} />
    <div style={{ width: pct(p.error), background: "var(--danger, #dc2626)" }} />
    <div style={{ width: pct(p.omitido), background: "var(--muted, #9ca3af)" }} />
  </div>;
}

// ---------------------------------------------------------------- tarjeta en el chat del asistente
// La misma propuesta que en Detalle, en pequeño: resumen, muestra, avisos y
// Aprobar / Rechazar con los mismos diálogos (y reglas: las aplica
// holded_acciones_aprobar en la base de datos). Sin rol admin, la RLS no deja
// leer la propuesta y la tarjeta solo dice que la revisa un administrador.
export function TarjetaAccion({ id, onNav }) {
  const [a, setA] = aState(undefined);
  const [muestra, setMuestra] = aState([]);
  const [prog, setProg] = aState(null);
  const [modal, setModal] = aState("");
  const [busy, setBusy] = aState(false);
  const [msg, setMsg] = aState("");
  const cargar = async () => {
    const r = await Auth.client.from("holded_acciones").select(COLUMNAS + ", muestra").eq("id", id).maybeSingle();
    if (r.error || !r.data) { setA(null); return; }
    const { muestra: m, ...resto } = r.data;
    setA(resto); setMuestra(m || []);
    if (!["propuesta", "rechazada"].includes(resto.estado)) { try { setProg(await rpc("holded_acciones_progreso", { p_accion: id })); } catch (e) { /* sin permiso */ } }
  };
  aEffect(() => { cargar(); }, [id]);
  aEffect(() => { if (!a || !viva(a)) return; const t = setInterval(cargar, 5000); return () => clearInterval(t); }, [a && a.estado]);
  const hacer = async (fn, args, ok) => {
    setBusy(true); setMsg("");
    try { await rpc(fn, { p_accion: id, ...args }); setMsg(ok); setModal(""); await cargar(); }
    catch (e) { setMsg("No se pudo: " + errorTexto(e)); }
    setBusy(false);
  };
  if (a === undefined) return <div className="ag-card ag-card--carga">Cargando la propuesta de Holded…</div>;
  if (a === null) return <div className="ag-card"><div className="ag-card__cab"><b>Propuesta de Holded</b><span className="ag-card__estado">Pendiente</span></div>
    <div className="ag-card__nota">La revisa y la aprueba un administrador, aquí en el chat o en Acciones.</div></div>;
  const r = a.resumen || {};
  const clase = caducada(a) || ["rechazada", "cancelada"].includes(a.estado) ? "cancelada" : a.estado === "completada" ? "confirmada" : "pendiente";
  const datos = esOp(a)
    ? [["Petición", `${r.metodo || ""} ${r.ruta || ""}`], ["Elementos", r.documentos ?? "—"]]
    : [["Documentos", r.documentos ?? "—"], ["Fechas", `${fmtDia(r.desde)} – ${fmtDia(r.hasta)}`], ["Total", r.total != null ? eur(r.total, r.moneda) : "—"], ["Excluidos", r.excluidos ?? 0]];
  return <div className={"ag-card ag-card--" + clase + (esOp(a) && a.riesgo === "alto" ? " ag-card--borrar" : "")}>
    <div className="ag-card__cab"><b>{titulo(a)} · {nombreEmpresa(a.empresa_id)}</b><span><Estado a={a} /> {esOp(a) && <Riesgo r={a.riesgo} />}</span></div>
    <table className="ag-card__tabla"><tbody>{datos.map(([k, v]) => <tr key={k}><th>{k}</th><td className="mono">{v}</td></tr>)}</tbody></table>
    {(a.avisos || []).length > 0 && <div className="ag-card__dup"><b>Avisos:</b><ul>{a.avisos.map((x, i) => <li key={i} style={{ color: /^⚠/.test(x) ? "var(--danger)" : undefined }}>{x}</li>)}</ul></div>}
    {!esOp(a) && muestra.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Muestra ({muestra.length})</summary>
      <table className="ag-card__tabla"><tbody>{muestra.slice(0, 8).map((d) => <tr key={d.id}><td className="mono">{fmtDia(d.fecha)}</td><td>{d.contacto || "—"}</td><td className="mono" style={{ textAlign: "right" }}>{eur(d.total, r.moneda)}</td></tr>)}</tbody></table></details>}
    {esOp(a) && <div style={{ marginTop: 8 }}><Peticiones a={{ ...a, estado: "cerrada" }} /></div>}
    {prog && prog.total > 0 && <div style={{ marginTop: 8 }}><Barra p={prog} /><div className="mono" style={{ fontSize: 12 }}>{prog.ok} hechos · {prog.error} con error{prog.desconocido ? ` · ${prog.desconocido} sin respuesta` : ""} · {prog.pendiente + prog.en_proceso} pendientes de {prog.total}</div></div>}
    {a.motivo_estado && <div className="ag-card__nota">Motivo: {a.motivo_estado}</div>}
    {msg && <div className={"ag-aviso" + (/^No se pudo/.test(msg) ? " ag-aviso--err" : "")} role="status">{msg}</div>}
    <div className="ag-card__acc">
      {a.estado === "propuesta" && !caducada(a) && <>
        <button className={"btn btn--sm " + (esOp(a) && a.riesgo === "alto" ? "btn--danger" : "btn--primary")} disabled={busy} onClick={() => setModal("aprobar")}>Aprobar…</button>
        <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setModal("rechazar")}>Rechazar</button></>}
      <button className="btn btn--sm btn--ghost" onClick={() => onNav({ name: "acciones", id })}>Ver en Acciones</button>
    </div>
    {caducada(a) && <div className="ag-card__nota">Ha caducado sin aprobarse: pídesela otra vez al asistente.</div>}
    {modal === "aprobar" && <ModalAprobar a={a} busy={busy} onCancel={() => setModal("")} onOk={(n, t) => hacer("holded_acciones_aprobar", { p_confirmacion: n, p_texto: t }, "Aprobada: empieza en menos de un minuto.")} />}
    {modal === "rechazar" && <ModalRechazar busy={busy} onCancel={() => setModal("")} onOk={(m) => hacer("holded_acciones_rechazar", { p_motivo: m }, "Propuesta rechazada.")} />}
  </div>;
}

// Correos redactados por el asistente sin enviar (de cualquier usuario: el rol admin los ve todos).
function CorreosAsistente({ nav }) {
  const [lista, setLista] = aState(null);
  const [abierto, setAbierto] = aState(null);
  const cargar = async () => {
    const r = await Auth.client.from("agente_correos").select("id, created_at, auth_user_id, resumen, expira_at")
      .eq("estado", "pendiente").gt("expira_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(50);
    setLista(r.error ? [] : r.data || []);
  };
  aEffect(() => { cargar(); }, []);
  if (!lista || !lista.length) return null;
  const quien = (uid) => ((CRM.USERS || []).find((u) => u.auth_user_id === uid) || {}).name || "—";
  const ir = (d) => nav(d.name, d.id);
  return <div className="card" style={{ marginBottom: 16 }}>
    <div className="card__body">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <b>Correos del asistente sin enviar</b><span className="muted" style={{ fontSize: 12.5 }}>({lista.length})</span>
        <div className="toolbar__spacer"></div>
        <button className="btn btn--sm btn--ghost" onClick={cargar} title="Actualizar"><Icon name="refresh" size={14} /></button>
      </div>
      {lista.map((c) => <div key={c.id} style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
        <a href="#" className="ag-link" onClick={(e) => { e.preventDefault(); setAbierto(abierto === c.id ? null : c.id); }}>{c.resumen}</a>
        <span className="muted" style={{ fontSize: 12.5 }}> · {quien(c.auth_user_id)} · {fmtFecha(c.created_at)}</span>
        {abierto === c.id && <TarjetaCorreo id={c.id} onNav={ir} onCambio={cargar} />}
      </div>)}
    </div>
  </div>;
}

export function Acciones({ toast, nav, focusId }) {
  const [lista, setLista] = aState(null);
  const [err, setErr] = aState("");
  const [sel, setSel] = aState(focusId || null);
  const [filtro, setFiltro] = aState("abiertas");
  const [version, setVersion] = aState(0);         // cada recarga de la lista refresca también los cupos
  const cargar = async () => {
    const r = await Auth.client.from("holded_acciones").select(COLUMNAS).order("created_at", { ascending: false }).limit(200);
    if (r.error) { setErr("No se pudieron cargar las acciones: " + errorTexto(r.error)); return; }
    setErr(""); setLista(r.data || []); setVersion((v) => v + 1);
  };
  aEffect(() => { cargar(); }, []);
  // Mientras haya algo en marcha, refresca la lista cada 15 s.
  const enMarcha = (lista || []).some(viva);
  aEffect(() => { if (!enMarcha) return; const t = setInterval(cargar, 15000); return () => clearInterval(t); }, [enMarcha]);

  const visibles = (lista || []).filter((a) => filtro === "todas" || ["propuesta", "aprobada", "en_curso", "pausada"].includes(a.estado) && !caducada(a));
  const actual = (lista || []).find((a) => a.id === sel);

  return <div>
    <CorreosAsistente nav={nav} />
    <div className="toolbar">
      <div className="muted" style={{ fontSize: 13, maxWidth: 760 }}>Cambios en Holded que ha propuesto el asistente o el operador. Nada se ejecuta sin que un administrador lo apruebe aquí; después se hace en segundo plano, poco a poco, y se puede pausar o cancelar.</div>
      <div className="toolbar__spacer"></div>
      <button className={"chip" + (filtro === "abiertas" ? " active" : "")} onClick={() => setFiltro("abiertas")}>Abiertas</button>
      <button className={"chip" + (filtro === "todas" ? " active" : "")} onClick={() => setFiltro("todas")}>Todas</button>
      <button className="btn btn--sm btn--ghost" onClick={cargar} title="Actualizar"><Icon name="refresh" size={14} /></button>
    </div>
    {err && <div className="card" style={{ marginBottom: 14, borderColor: "var(--danger)" }}><div className="card__body" style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div></div>}
    {!lista && !err && <p className="muted" style={{ fontSize: 13 }}>Cargando…</p>}
    {lista && !visibles.length && <p className="muted" style={{ fontSize: 13 }}>{filtro === "abiertas" ? "No hay acciones abiertas." : "Todavía no hay acciones."}</p>}
    {visibles.length > 0 && <div className="card"><div className="tbl-wrap"><table className="tbl"><thead><tr>
      <th>Creada</th><th>Empresa</th><th>Acción</th><th style={{ textAlign: "right" }}>Documentos</th><th>Fechas / petición</th><th style={{ textAlign: "right" }}>Total</th><th>Estado</th><th>Propuesta por</th></tr></thead><tbody>
      {visibles.map((a) => <tr key={a.id} style={{ cursor: "pointer", background: a.id === sel ? "var(--hover, rgba(0,0,0,.04))" : undefined }} onClick={() => setSel(a.id)}>
        <td className="mono" style={{ fontSize: 12.5 }}>{fmtFecha(a.created_at)}</td>
        <td><b>{nombreEmpresa(a.empresa_id)}</b></td>
        <td style={{ maxWidth: 360 }}>{titulo(a)} {esOp(a) && <Riesgo r={a.riesgo} />}</td>
        <td className="mono" style={{ textAlign: "right" }}>{(a.resumen || {}).documentos ?? "—"}</td>
        <td className="mono" style={{ fontSize: 12.5 }}>{esOp(a) ? <span className="muted">{(a.resumen || {}).metodo} {(a.resumen || {}).ruta}</span> : <>{fmtDia((a.resumen || {}).desde)} – {fmtDia((a.resumen || {}).hasta)}</>}</td>
        <td className="mono" style={{ textAlign: "right" }}>{(a.resumen || {}).total != null ? eur(a.resumen.total, a.resumen.moneda) : "—"}</td>
        <td><Estado a={a} /></td>
        <td style={{ fontSize: 12.5 }}>{quienPropuso(a)}</td>
      </tr>)}
    </tbody></table></div></div>}

    {actual && <Detalle key={actual.id} a={actual} toast={toast} nav={nav} onCambio={cargar} onCerrar={() => setSel(null)} />}
    <Cupos toast={toast} version={version} />
    <Politicas toast={toast} />
    <Programadas toast={toast} />
  </div>;
}

function Detalle({ a, toast, nav, onCambio, onCerrar }) {
  const [extra, setExtra] = aState(null);          // { muestra, excluidos }
  const [prog, setProg] = aState(null);
  const [modal, setModal] = aState("");            // aprobar | rechazar | cancelar | cupo
  const [busy, setBusy] = aState(false);
  const r = a.resumen || {};

  aEffect(() => {
    (async () => {
      const x = await Auth.client.from("holded_acciones").select("muestra, excluidos").eq("id", a.id).maybeSingle();
      setExtra(x.data || { muestra: [], excluidos: [] });
    })();
  }, [a.id]);
  const cargarProg = async () => {
    try {
      const p = await rpc("holded_acciones_progreso", { p_accion: a.id });
      setProg(p);
      // Ha terminado mientras se miraba: refresca la lista (estado y cupos).
      if (viva(a) && p && p.total > 0 && p.pendiente + p.en_proceso === 0) onCambio();
    } catch (e) { /* sin permiso o borrada */ }
  };
  aEffect(() => {
    if (a.estado === "propuesta" || a.estado === "rechazada") return;
    cargarProg();
    if (!viva(a)) return;
    const t = setInterval(cargarProg, 5000);
    return () => clearInterval(t);
  }, [a.id, a.estado]);

  const hacer = async (fn, args, ok) => {
    setBusy(true);
    try { await rpc(fn, { p_accion: a.id, ...args }); toast(ok); setModal(""); await onCambio(); }
    catch (e) { toast("No se pudo: " + errorTexto(e)); }
    setBusy(false);
  };

  const duracion = a.iniciada_at ? Math.round(((a.terminada_at ? new Date(a.terminada_at) : new Date()) - new Date(a.iniciada_at)) / 60000) : null;

  return <div className="card" style={{ marginTop: 16 }}><div className="card__body">
    <div className="row" style={{ alignItems: "center", gap: 10, marginBottom: 6 }}>
      <div style={{ fontWeight: 700, fontFamily: "var(--display)", fontSize: 16 }}>{titulo(a)} · <a style={{ cursor: "pointer" }} onClick={() => nav && nav("empresa", a.empresa_id)}>{nombreEmpresa(a.empresa_id)}</a></div>
      <Estado a={a} />{esOp(a) && <Riesgo r={a.riesgo} />}
      <div style={{ flex: 1 }}></div>
      {a.estado === "propuesta" && !caducada(a) && <>
        {(a.avisos || []).some((x) => /CUPO/.test(x)) && <button className="btn btn--ghost" disabled={busy} onClick={() => setModal("cupo")}>Ampliar cupo…</button>}
        <button className="btn btn--ghost" disabled={busy} onClick={() => setModal("rechazar")}>Rechazar</button>
        <button className="btn btn--primary" disabled={busy} onClick={() => setModal("aprobar")}><Icon name="check" size={15} />Aprobar…</button></>}
      {viva(a) && <button className="btn btn--ghost" disabled={busy} onClick={() => hacer("holded_acciones_pausar", {}, "Acción pausada")}>Pausar</button>}
      {a.estado === "pausada" && <button className="btn btn--primary" disabled={busy} onClick={() => hacer("holded_acciones_reanudar", {}, "Acción reanudada")}>Reanudar</button>}
      {(viva(a) || a.estado === "pausada") && <button className="btn btn--danger" disabled={busy} onClick={() => setModal("cancelar")}>Cancelar</button>}
      <button className="btn btn--sm btn--ghost" onClick={onCerrar} title="Cerrar"><Icon name="x" size={14} /></button>
    </div>
    <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
      Propuesta por {quienPropuso(a)} el {fmtFecha(a.created_at)}
      {a.estado === "propuesta" && <> · {caducada(a) ? "caducó" : "caduca"} el {fmtFecha(a.expira_at)}</>}
      {a.aprobada_at && <> · aprobada por {nombreUsuario(a.aprobada_por)} el {fmtFecha(a.aprobada_at)}</>}
      {a.rechazada_por && <> · rechazada por {nombreUsuario(a.rechazada_por)}</>}
      {a.cerrada_por && a.estado === "cancelada" && <> · cancelada por {nombreUsuario(a.cerrada_por)}</>}
    </p>
    {a.motivo_estado && <p style={{ fontSize: 13, color: a.estado === "pausada" ? "var(--warn)" : undefined }}><b>Motivo:</b> {a.motivo_estado}</p>}

    {esOp(a) && <div className="row" style={{ gap: 28, flexWrap: "wrap", margin: "10px 0 14px" }}>
      {[["Petición", `${r.metodo || ""} ${r.ruta || ""}`], ["Operación", r.resumen_operacion || a.operacion], ["Tema", r.tema || "—"], ["Elementos", r.documentos]].map(([k, v]) =>
        <div key={k}><div className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div><div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{v}</div></div>)}
    </div>}
    {!esOp(a) && <div className="row" style={{ gap: 28, flexWrap: "wrap", margin: "10px 0 14px" }}>
      {[["Documentos", r.documentos], ["Desde", fmtDia(r.desde)], ["Hasta", fmtDia(r.hasta)], ["Base", eur(r.base, r.moneda)], ["IVA", eur(r.iva, r.moneda)], ["Total", eur(r.total, r.moneda)], ["Excluidos", r.excluidos ?? 0]].map(([k, v]) =>
        <div key={k}><div className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div><div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{v}</div></div>)}
    </div>}

    {prog && prog.total > 0 && <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Progreso</div>
      <Barra p={prog} />
      <div className="mono" style={{ fontSize: 12.5 }}>{prog.ok} {esOp(a) ? "hechos" : "aprobados"} · {prog.error} con error{prog.desconocido ? ` · ${prog.desconocido} sin respuesta (revisar en Holded)` : ""} · {prog.pendiente + prog.en_proceso} pendientes{prog.omitido ? ` · ${prog.omitido} omitidos` : ""} de {prog.total}
        {" · "}{a.llamadas_escritura} llamadas de escritura y {a.llamadas_lectura} de lectura{duracion != null ? ` · ${duracion} min` : ""}{prog.ultimo_at ? ` · último: ${fmtFecha(prog.ultimo_at)}` : ""}</div>
      {prog.errores && prog.errores.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontSize: 13, color: "var(--danger)" }}>{prog.error + (prog.desconocido || 0)} con error o sin respuesta{prog.errores.length < prog.error ? ` (se muestran ${prog.errores.length})` : ""}</summary>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>{esOp(a) ? "Petición" : "Id en Holded"}</th><th>Código</th><th>Motivo</th></tr></thead><tbody>
          {prog.errores.map((e, i) => <tr key={e.orden || e.holded_id || i}><td className="mono" style={{ fontSize: 12 }}>{esOp(a) ? `#${e.orden} ${e.ruta || ""}` : e.holded_id}</td><td className="mono">{e.codigo ?? "—"}</td><td style={{ fontSize: 12.5 }}>{e.error}</td></tr>)}
        </tbody></table></div></details>}
    </div>}

    {(a.avisos || []).length > 0 && <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Avisos</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{a.avisos.map((x, i) => <li key={i} style={{ color: /^⚠/.test(x) ? "var(--danger)" : undefined, marginBottom: 3 }}>{x}</li>)}</ul>
    </div>}

    {esOp(a) && <Peticiones a={a} />}
    {!esOp(a) && extra && extra.muestra && extra.muestra.length > 0 && <details open={a.estado === "propuesta"} style={{ marginBottom: 10 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Muestra ({extra.muestra.length} documentos repartidos por el rango)</summary>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Fecha</th><th>Cliente</th><th>Descripción</th><th style={{ textAlign: "right" }}>Base</th><th style={{ textAlign: "right" }}>IVA</th><th style={{ textAlign: "right" }}>Total</th><th>Id en Holded</th></tr></thead><tbody>
        {extra.muestra.map((d) => <tr key={d.id}><td className="mono" style={{ fontSize: 12.5 }}>{fmtDia(d.fecha)}</td><td>{d.contacto || "—"}</td><td style={{ fontSize: 12.5 }}>{d.descripcion || "—"}</td>
          <td className="mono" style={{ textAlign: "right" }}>{eur(d.base, r.moneda)}</td><td className="mono" style={{ textAlign: "right" }}>{eur(d.iva, r.moneda)}</td><td className="mono" style={{ textAlign: "right" }}>{eur(d.total, r.moneda)}</td>
          <td className="mono muted" style={{ fontSize: 11.5 }}>{d.id}</td></tr>)}
      </tbody></table></div>
    </details>}

    {extra && extra.excluidos && extra.excluidos.length > 0 && <details>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Excluidos ({r.excluidos ?? extra.excluidos.length}): no se aprueban</summary>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Fecha</th><th style={{ textAlign: "right" }}>Total</th><th>Motivo</th><th>Id en Holded</th></tr></thead><tbody>
        {extra.excluidos.map((d) => <tr key={d.id}><td className="mono" style={{ fontSize: 12.5 }}>{fmtDia(d.fecha)}</td><td className="mono" style={{ textAlign: "right" }}>{d.total != null ? eur(d.total, r.moneda) : "—"}</td><td style={{ fontSize: 12.5 }}>{d.motivo}</td><td className="mono muted" style={{ fontSize: 11.5 }}>{d.id}</td></tr>)}
      </tbody></table></div>
    </details>}

    {modal === "aprobar" && <ModalAprobar a={a} busy={busy} onCancel={() => setModal("")} onOk={(n, t) => hacer("holded_acciones_aprobar", { p_confirmacion: n, p_texto: t }, "Aprobada: empieza en menos de un minuto")} />}
    {modal === "cupo" && <ModalCupo a={a} toast={toast} onCancel={() => setModal("")} onOk={() => { setModal(""); onCambio(); }} />}
    {modal === "rechazar" && <ModalRechazar busy={busy} onCancel={() => setModal("")} onOk={(m) => hacer("holded_acciones_rechazar", { p_motivo: m }, "Propuesta rechazada")} />}
    {modal === "cancelar" && <Modal title="Cancelar la acción" onClose={() => !busy && setModal("")} footer={<>
      <button className="btn btn--ghost" onClick={() => setModal("")} disabled={busy}>Volver</button>
      <button className="btn btn--danger" onClick={() => hacer("holded_acciones_cancelar", {}, "Acción cancelada")} disabled={busy}>{busy ? "Cancelando…" : "Cancelar la acción"}</button></>}>
      <p className="muted">Los documentos que faltan no se tocarán. Los que ya se han aprobado en Holded siguen aprobados: cancelar no los deshace.</p>
    </Modal>}
  </div></div>;
}

function ModalAprobar({ a, busy, onCancel, onOk }) {
  const r = a.resumen || {};
  const n = r.documentos || 0;
  const [valor, setValor] = aState("");
  const [texto, setTexto] = aState("");
  const alto = esOp(a) && a.riesgo === "alto";
  const exige = n > 100;
  const valido = (!exige || Number(valor.trim()) === n) && (!alto || texto.trim().toUpperCase() === "CONFIRMAR");
  return <Modal title={`Aprobar: ${titulo(a)}`} onClose={() => !busy && onCancel()} footer={<>
    <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>Volver</button>
    <button className={"btn " + (alto ? "btn--danger" : "btn--primary")} onClick={() => onOk(exige ? n : null, alto ? texto.trim() : null)} disabled={busy || !valido}>{busy ? "Aprobando…" : esOp(a) ? `Aprobar ${n === 1 ? "la operación" : `${n} operaciones`}` : `Aprobar ${n} documentos`}</button></>}>
    {esOp(a) ? <>
      <p>{a.descripcion} — en <b>{nombreEmpresa(a.empresa_id)}</b>.</p>
      <p className="mono" style={{ fontSize: 13 }}>{r.metodo} {r.ruta}{n > 1 ? ` × ${n}` : ""} <Riesgo r={a.riesgo} /></p>
      <ul style={{ fontSize: 13, paddingLeft: 18 }}>
        {r.metodo === "DELETE" && <li>Borrar en Holded no se puede deshacer.</li>}
        {r.metodo === "PUT" && <li>PUT reemplaza el documento entero: revisa que el cuerpo incluya todo lo que deba quedarse.</li>}
        <li>Se hace en segundo plano, una petición tras otra. Puedes pausar o cancelar lo que falte, pero no deshacer lo ya hecho.</li>
        <li>Si Holded no responde a una creación, no se repite sola (podría duplicarla): queda «sin respuesta» para revisarla.</li>
      </ul>
      {alto && <label style={{ display: "block", fontSize: 13, marginTop: 10, color: "var(--danger)" }}>Es una operación de riesgo alto. Para aprobarla, escribe <b>CONFIRMAR</b>:
        <input className="inp mono" style={{ display: "block", width: 180, marginTop: 6 }} value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus /></label>}
    </> : <>
      <p>Se aprobarán en Holded <b>{n}</b> tickets de venta de <b>{nombreEmpresa(a.empresa_id)}</b>, del {fmtDia(r.desde)} al {fmtDia(r.hasta)}, por un total de <b>{eur(r.total, r.moneda)}</b>.</p>
      <ul style={{ fontSize: 13, paddingLeft: 18 }}>
        <li>Cada ticket recibe su número de serie y deja de poder modificarse o borrarse en Holded.</li>
        <li>Si la cuenta tiene VeriFactu, cada uno se registra y se envía a la AEAT: no se puede deshacer.</li>
        <li>Se hace en segundo plano, unos 40 por minuto. Puedes pausar o cancelar lo que falte, pero no deshacer lo ya aprobado.</li>
      </ul>
    </>}
    {exige && <label style={{ display: "block", fontSize: 13, marginTop: 10 }}>Para confirmar, escribe el número de documentos (<b>{n}</b>):
      <input className="inp mono" style={{ display: "block", width: 140, marginTop: 6 }} inputMode="numeric" value={valor} onChange={(e) => setValor(e.target.value)} autoFocus={!alto} /></label>}
  </Modal>;
}

// Ampliar el cupo de acciones de la empresa desde la propia propuesta.
function ModalCupo({ a, toast, onCancel, onOk }) {
  const [u, setU] = aState(null);
  const [valor, setValor] = aState("");
  const [busy, setBusy] = aState(false);
  const n = (a.resumen || {}).documentos || 0;
  aEffect(() => { (async () => {
    try {
      const f = ((await rpc("holded_acciones_uso_mes", {})) || []).find((x) => x.empresa_id === a.empresa_id) || { usadas: 0, cupo: 0 };
      setU(f); setValor(String(Math.max(f.cupo, f.usadas + n)));
    } catch (e) { setU({ usadas: 0, cupo: 0 }); }
  })(); }, [a.id]);
  const v = Number(valor);
  const ok = Number.isInteger(v) && v >= 0 && v <= 100000;
  const guardar = async () => {
    setBusy(true);
    try { await rpc("holded_cambiar_cupo_acciones", { p_empresa_id: a.empresa_id, p_cupo: v }); toast("Cupo de acciones ampliado"); onOk(); }
    catch (e) { toast("No se pudo cambiar el cupo: " + errorTexto(e)); }
    setBusy(false);
  };
  return <Modal title={`Cupo de acciones de ${nombreEmpresa(a.empresa_id)}`} onClose={() => !busy && onCancel()} footer={<>
    <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>Volver</button>
    <button className="btn btn--primary" onClick={guardar} disabled={busy || !ok || !u}>{busy ? "Guardando…" : "Guardar cupo"}</button></>}>
    {!u ? <p className="muted">Cargando…</p> : <>
      <p style={{ fontSize: 13 }}>Este mes lleva <b>{u.usadas}</b> de <b>{u.cupo}</b>. Esta propuesta necesita <b>{n}</b>: con un cupo de <b>{u.usadas + n}</b> o más cabe entera.</p>
      <label style={{ fontSize: 13 }}>Nuevo cupo mensual
        <input className="inp mono" style={{ display: "block", width: 140, marginTop: 6 }} type="number" min="0" max="100000" value={valor} onChange={(e) => setValor(e.target.value)} autoFocus /></label>
      <p className="muted" style={{ fontSize: 12.5 }}>El aviso de la propuesta no cambia, pero al ejecutarse ya no se pausará por cupo.</p>
    </>}
  </Modal>;
}

// Peticiones exactas de una operación, con el estado actual leído al proponer.
const json = (x) => { try { return JSON.stringify(x, null, 2); } catch (e) { return String(x); } };
const POR_PAGINA = 10;
function Peticiones({ a }) {
  const n = (a.resumen || {}).documentos || 0;
  const [desde, setDesde] = aState(1);
  const [filas, setFilas] = aState(null);
  const [err, setErr] = aState("");
  aEffect(() => { (async () => {
    try { setFilas(await rpc("holded_acciones_peticiones", { p_accion: a.id, p_desde: desde, p_n: POR_PAGINA })); setErr(""); }
    catch (e) { setErr(errorTexto(e)); }
  })(); }, [a.id, desde, a.estado]);
  const crea = !/\{/.test(String((a.resumen || {}).ruta || "")) && (a.resumen || {}).metodo === "POST";
  const caja = { margin: 0, padding: 8, fontSize: 11.5, maxHeight: 320, overflow: "auto", background: "var(--hover, rgba(0,0,0,.04))", borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" };
  return <details open={a.estado === "propuesta"} style={{ marginBottom: 10 }}>
    <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Peticiones exactas ({n}){n > POR_PAGINA ? ` · ${desde}–${Math.min(n, desde + POR_PAGINA - 1)}` : ""}</summary>
    {err && <p style={{ color: "var(--danger)", fontSize: 13 }}>{err}</p>}
    {a.purgada_at && <p className="muted" style={{ fontSize: 12.5 }}>Cuerpos y estado anterior borrados el {fmtFecha(a.purgada_at)} (se guardan 90 días). Quedan método, ruta, resultado e id.</p>}
    {!filas && !err && <p className="muted" style={{ fontSize: 13 }}>Cargando…</p>}
    {(filas || []).map((p) => <div key={p.orden} style={{ borderTop: "1px solid var(--line, #e5e7eb)", padding: "8px 0" }}>
      <div className="mono" style={{ fontSize: 12.5, marginBottom: 6 }}>#{p.orden} <b>{p.metodo} {p.ruta}</b>
        {" · "}<span style={{ color: p.estado === "ok" ? "var(--ok, #16a34a)" : ["error", "desconocido"].includes(p.estado) ? "var(--danger)" : undefined }}>{p.estado === "desconocido" ? "sin respuesta" : p.estado}</span>
        {p.codigo ? ` · ${p.codigo}` : ""}{p.resultado_id ? ` · id ${p.resultado_id}` : ""}</div>
      {p.error && <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 6 }}>{p.error}</div>}
      {!p.purgado && <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}><div className="muted" style={{ fontSize: 11.5 }}>Estado actual en Holded (al proponer)</div>
          <pre style={caja}>{p.estado_anterior == null ? (crea ? "— (se crea nuevo)" : "No se ha leído") : p.estado_anterior.no_encontrado ? "No existe en Holded (404)" : json(p.estado_anterior)}</pre></div>
        <div style={{ flex: 1, minWidth: 0 }}><div className="muted" style={{ fontSize: 11.5 }}>Cuerpo que se envía</div>
          <pre style={caja}>{p.cuerpo == null ? "— (sin cuerpo)" : json(p.cuerpo)}</pre></div>
      </div>}
    </div>)}
    {n > POR_PAGINA && <div className="row" style={{ gap: 6, marginTop: 6 }}>
      <button className="btn btn--sm btn--ghost" disabled={desde <= 1} onClick={() => setDesde(Math.max(1, desde - POR_PAGINA))}>Anteriores</button>
      <button className="btn btn--sm btn--ghost" disabled={desde + POR_PAGINA > n} onClick={() => setDesde(desde + POR_PAGINA)}>Siguientes</button></div>}
  </details>;
}

function ModalRechazar({ busy, onCancel, onOk }) {
  const [m, setM] = aState("");
  return <Modal title="Rechazar la propuesta" onClose={() => !busy && onCancel()} footer={<>
    <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>Volver</button>
    <button className="btn btn--danger" onClick={() => onOk(m.trim() || null)} disabled={busy}>{busy ? "Rechazando…" : "Rechazar"}</button></>}>
    <p className="muted">No se toca nada en Holded. Los documentos quedan libres para otra propuesta.</p>
    <input className="inp" style={{ width: "100%" }} maxLength={300} placeholder="Motivo (opcional)" value={m} onChange={(e) => setM(e.target.value)} autoFocus />
  </Modal>;
}

// ---------------------------------------------------------------- cupo de acciones por empresa
function Cupos({ toast, version }) {
  const [uso, setUso] = aState(null);
  const [edit, setEdit] = aState(null);   // { id, valor }
  const [busy, setBusy] = aState(false);
  const cargar = async () => { try { setUso(await rpc("holded_acciones_uso_mes", {})); } catch (e) { setUso([]); } };
  aEffect(() => { cargar(); }, [version]);
  const filas = aMemo(() => (uso || []).slice().sort((x, y) => (y.cupo - x.cupo) || nombreEmpresa(x.empresa_id).localeCompare(nombreEmpresa(y.empresa_id), "es")), [uso]);
  const [verTodas, setVerTodas] = aState(false);
  const visibles = verTodas ? filas : filas.filter((f) => f.cupo > 0 || f.usadas > 0);
  const guardar = async () => {
    const n = Number(edit.valor);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return;
    setBusy(true);
    try { await rpc("holded_cambiar_cupo_acciones", { p_empresa_id: edit.id, p_cupo: n }); toast("Cupo de acciones actualizado"); setEdit(null); await cargar(); }
    catch (e) { toast("No se pudo cambiar el cupo: " + errorTexto(e)); }
    setBusy(false);
  };
  return <div className="card" style={{ marginTop: 20 }}><div className="card__body">
    <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
      <div style={{ fontWeight: 700, fontFamily: "var(--display)" }}>Cupo de acciones por empresa (este mes)</div>
      <div style={{ flex: 1 }}></div>
      {filas.length > visibles.length && <button className="btn btn--sm btn--ghost" onClick={() => setVerTodas(true)}>Ver todas ({filas.length})</button>}
    </div>
    <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Documentos que se pueden tocar en Holded cada mes, aparte del tope de consultas del asistente. Por defecto, 50 al mes. Con 0 no se ejecuta nada; al llegar al cupo, la acción se pausa hasta que lo subas o empiece el mes siguiente.</p>
    {!uso && <p className="muted" style={{ fontSize: 13 }}>Cargando…</p>}
    {uso && !visibles.length && <p className="muted" style={{ fontSize: 13 }}>Ninguna empresa tiene cupo de acciones. {filas.length > 0 && <a style={{ cursor: "pointer" }} onClick={() => setVerTodas(true)}>Asignar uno</a>}</p>}
    {visibles.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Empresa</th><th style={{ textAlign: "right" }}>Usadas / cupo</th><th></th></tr></thead><tbody>
      {visibles.map((f) => <tr key={f.empresa_id}>
        <td>{nombreEmpresa(f.empresa_id)}</td>
        <td className="mono" style={{ textAlign: "right", color: f.cupo && f.usadas >= f.cupo ? "var(--danger)" : undefined }}>{f.usadas} / {f.cupo}</td>
        <td style={{ whiteSpace: "nowrap", width: 1 }}>{edit && edit.id === f.empresa_id
          ? <span className="row" style={{ gap: 4, display: "inline-flex" }}>
              <input className="inp mono" style={{ width: 90, padding: "4px 6px", fontSize: 12.5 }} type="number" min="0" max="100000" value={edit.valor} autoFocus
                onChange={(e) => setEdit({ ...edit, valor: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") guardar(); if (e.key === "Escape") setEdit(null); }} />
              <button className="btn btn--sm btn--primary" disabled={busy} onClick={guardar}>Guardar</button>
              <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setEdit(null)}>Cancelar</button></span>
          : <button className="btn btn--sm btn--ghost" title="Cambiar el cupo" onClick={() => setEdit({ id: f.empresa_id, valor: String(f.cupo) })}><Icon name="edit" size={13} /></button>}</td>
      </tr>)}
    </tbody></table></div>}
  </div></div>;
}

// ---------------------------------------------------------------- políticas por empresa y operación
// Por defecto todo necesita aprobación. «Automática» solo para operaciones de
// riesgo normal y con un máximo de elementos por propuesta (y de importe en
// los tickets); la base de datos rechaza las automáticas de riesgo alto.
function Politicas({ toast }) {
  const [empresas, setEmpresas] = aState(null);
  const [ops, setOps] = aState([]);
  const [pols, setPols] = aState([]);
  const [nuevo, setNuevo] = aState(null);   // { empresa_id, tipo, max_documentos, max_importe }
  const [busy, setBusy] = aState(false);
  const cargar = async () => {
    try { setEmpresas(await rpc("holded_acciones_uso_mes", {})); } catch (e) { setEmpresas([]); }
    const o = await Auth.client.from("holded_operaciones").select("id, metodo, ruta, tema, resumen, riesgo").order("tema").order("id");
    setOps(o.data || []);
    const p = await Auth.client.from("holded_acciones_politicas").select("empresa_id, tipo, modo, max_documentos, max_importe, updated_at");
    setPols(p.data || []);
  };
  aEffect(() => { cargar(); }, []);
  const normales = ops.filter((o) => o.riesgo === "normal");
  const nombreOp = (t) => {
    if (t === "aprobar_tickets_venta") return TIPOS[t];
    const o = ops.find((x) => x.id === t);
    return o ? `${o.resumen} (${o.metodo} ${o.ruta})` : t;
  };
  const cambiar = async (args, ok) => {
    setBusy(true);
    try { await rpc("holded_cambiar_politica", args); toast(ok); setNuevo(null); await cargar(); }
    catch (e) { toast("No se pudo cambiar la política: " + errorTexto(e)); }
    setBusy(false);
  };
  const tickets = nuevo && nuevo.tipo === "aprobar_tickets_venta";
  const maxDoc = nuevo ? Number(nuevo.max_documentos) : 0;
  const validoNuevo = nuevo && nuevo.empresa_id && nuevo.tipo && Number.isInteger(maxDoc) && maxDoc >= 1 && maxDoc <= 1000
    && (!tickets || Number(nuevo.max_importe) > 0);
  return <div className="card" style={{ marginTop: 20 }}><div className="card__body">
    <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
      <div style={{ fontWeight: 700, fontFamily: "var(--display)" }}>Políticas por empresa y operación</div>
      <div style={{ flex: 1 }}></div>
      {!nuevo && <button className="btn btn--sm btn--ghost" onClick={() => setNuevo({ empresa_id: "", tipo: "", max_documentos: "10", max_importe: "" })}><Icon name="plus" size={13} />Añadir automática</button>}
    </div>
    <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Por defecto, todas las propuestas necesitan la aprobación de un administrador. Una operación «automática» se aprueba sola si no pasa de los límites. Las de riesgo alto (borrar, aprobar o emitir, enviar, pagos, bancos, contabilidad…) nunca pueden ser automáticas.</p>
    {!pols.length && <p className="muted" style={{ fontSize: 13 }}>No hay ninguna automática: todo necesita aprobación.</p>}
    {pols.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Empresa</th><th>Operación</th><th style={{ textAlign: "right" }}>Máx. elementos</th><th style={{ textAlign: "right" }}>Máx. importe</th><th></th></tr></thead><tbody>
      {pols.map((p) => <tr key={p.empresa_id + p.tipo}>
        <td>{nombreEmpresa(p.empresa_id)}</td><td style={{ fontSize: 12.5 }}>{nombreOp(p.tipo)}</td>
        <td className="mono" style={{ textAlign: "right" }}>{p.max_documentos}</td><td className="mono" style={{ textAlign: "right" }}>{p.max_importe == null ? "—" : Number(p.max_importe) >= 1e11 ? "Sin límite" : eur(p.max_importe)}</td>
        <td style={{ width: 1, whiteSpace: "nowrap" }}><button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => cambiar({ p_empresa_id: p.empresa_id, p_tipo: p.tipo, p_modo: "aprobacion", p_max_documentos: null, p_max_importe: null }, "Vuelve a necesitar aprobación")}>Volver a aprobación</button></td>
      </tr>)}
    </tbody></table></div>}
    {nuevo && <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
      <label style={{ fontSize: 12.5 }}>Empresa<select className="inp" style={{ display: "block", marginTop: 4 }} value={nuevo.empresa_id} onChange={(e) => setNuevo({ ...nuevo, empresa_id: e.target.value })}>
        <option value="">—</option>{(empresas || []).map((f) => <option key={f.empresa_id} value={f.empresa_id}>{nombreEmpresa(f.empresa_id)}</option>)}</select></label>
      <label style={{ fontSize: 12.5, flex: 1, minWidth: 260 }}>Operación (solo riesgo normal)<select className="inp" style={{ display: "block", marginTop: 4, width: "100%" }} value={nuevo.tipo} onChange={(e) => setNuevo({ ...nuevo, tipo: e.target.value })}>
        <option value="">—</option><option value="aprobar_tickets_venta">{TIPOS.aprobar_tickets_venta}</option>
        {normales.map((o) => <option key={o.id} value={o.id}>{o.tema} · {o.resumen} ({o.metodo} {o.ruta})</option>)}</select></label>
      <label style={{ fontSize: 12.5 }}>Máx. elementos<input className="inp mono" style={{ display: "block", marginTop: 4, width: 90 }} type="number" min="1" max="1000" value={nuevo.max_documentos} onChange={(e) => setNuevo({ ...nuevo, max_documentos: e.target.value })} /></label>
      {tickets && <label style={{ fontSize: 12.5 }}>Máx. importe (€)<input className="inp mono" style={{ display: "block", marginTop: 4, width: 110 }} type="number" min="1" value={nuevo.max_importe} onChange={(e) => setNuevo({ ...nuevo, max_importe: e.target.value })} /></label>}
      <button className="btn btn--sm btn--primary" disabled={busy || !validoNuevo} onClick={() => cambiar({ p_empresa_id: nuevo.empresa_id, p_tipo: nuevo.tipo, p_modo: "automatica", p_max_documentos: maxDoc, p_max_importe: tickets ? Number(nuevo.max_importe) : null }, "Política guardada")}>Guardar</button>
      <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setNuevo(null)}>Cancelar</button>
    </div>}
  </div></div>;
}

// ---------------------------------------------------------------- acciones programadas (solo rol admin)
// Cada día a la hora fijada (23:00 de Madrid) el sistema propone aprobar todos
// los tickets pendientes con fecha de ese día o anterior, en tandas de hasta
// 1000 (crm/supabase-holded-programadas.sql). Cada tanda es una propuesta
// normal: solo se aprueba sola si la empresa tiene la política automática.
function Programadas({ toast }) {
  const [filas, setFilas] = aState(null);
  const [empresas, setEmpresas] = aState([]);
  const [pols, setPols] = aState([]);
  const [nueva, setNueva] = aState("");
  const [busy, setBusy] = aState(false);
  const cargar = async () => {
    const r = await Auth.client.from("holded_acciones_programadas")
      .select("empresa_id, tipo, activa, hora, dia_en_curso, en_curso_manual, tandas, ultima_accion_id, ultimo_dia_completado, ultima_ejecucion_at, ultimo_resultado");
    setFilas(r.error ? [] : r.data || []);
    const p = await Auth.client.from("holded_acciones_politicas").select("empresa_id, tipo, modo");
    setPols(p.data || []);
  };
  aEffect(() => { cargar(); rpc("holded_acciones_uso_mes", {}).then((x) => setEmpresas(x || [])).catch(() => setEmpresas([])); }, []);
  const enMarcha = (filas || []).some((f) => f.dia_en_curso);
  aEffect(() => { if (!enMarcha) return; const t = setInterval(cargar, 30000); return () => clearInterval(t); }, [enMarcha]);
  const cambiar = async (empresa, activa, ahora, ok) => {
    setBusy(true);
    try { await rpc("holded_cambiar_programacion", { p_empresa_id: empresa, p_tipo: "aprobar_tickets_venta", p_activa: activa, p_ejecutar_ahora: ahora }); toast(ok); setNueva(""); await cargar(); }
    catch (e) { toast("No se pudo cambiar: " + errorTexto(e)); }
    setBusy(false);
  };
  const automatica = (e) => pols.some((p) => p.empresa_id === e && p.tipo === "aprobar_tickets_venta" && p.modo === "automatica");
  const libres = empresas.filter((e) => !(filas || []).some((f) => f.empresa_id === e.empresa_id));
  if (filas === null) return null;
  return <div className="card" style={{ marginTop: 20 }}><div className="card__body">
    <div style={{ fontWeight: 700, fontFamily: "var(--display)", marginBottom: 8 }}>Acciones programadas</div>
    <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Cada día a las 23:00 propone aprobar <b>todos</b> los tickets de venta pendientes con fecha de ese día o anterior, en tandas de hasta 1000, hasta que no quede ninguno. Cada tanda se aprueba sola solo si la empresa tiene la política automática; si no, se queda en Propuestas y la pasada se para. Los tickets dudosos nunca se aprueban solos.</p>
    {filas.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Empresa</th><th>Estado</th><th>Último resultado</th><th></th></tr></thead><tbody>
      {filas.map((f) => <tr key={f.empresa_id + f.tipo}>
        <td>{nombreEmpresa(f.empresa_id)}<div className="muted" style={{ fontSize: 12 }}>Aprobar tickets · {String(f.hora).padStart(2, "0")}:00{!automatica(f.empresa_id) && <span style={{ color: "var(--danger)" }}> · sin política automática</span>}</div></td>
        <td style={{ fontSize: 12.5 }}>{!f.activa ? "Desactivada" : f.dia_en_curso ? `En marcha${f.en_curso_manual ? " (manual)" : ""}: tanda ${f.tandas}, hasta ${f.dia_en_curso}` : "Activa"}
          {f.ultimo_dia_completado && <div className="muted" style={{ fontSize: 12 }}>Última noche: {f.ultimo_dia_completado}</div>}</td>
        <td style={{ fontSize: 12.5 }}>{f.ultimo_resultado || "—"}{f.ultima_ejecucion_at && <div className="muted" style={{ fontSize: 12 }}>{fmtFecha(f.ultima_ejecucion_at)}</div>}</td>
        <td style={{ width: 1, whiteSpace: "nowrap" }}>
          {f.activa && !f.dia_en_curso && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => cambiar(f.empresa_id, true, true, "Pasada pedida: empieza en unos minutos")}>Ejecutar ahora</button>}
          <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => cambiar(f.empresa_id, !f.activa, false, f.activa ? "Programación desactivada" : "Programación activada")}>{f.activa ? "Desactivar" : "Activar"}</button>
        </td>
      </tr>)}
    </tbody></table></div>}
    {libres.length > 0 && <div className="row" style={{ gap: 8, alignItems: "flex-end", marginTop: 10 }}>
      <label style={{ fontSize: 12.5 }}>Programar para<select className="inp" style={{ display: "block", marginTop: 4 }} value={nueva} onChange={(e) => setNueva(e.target.value)}>
        <option value="">—</option>{libres.map((e) => <option key={e.empresa_id} value={e.empresa_id}>{nombreEmpresa(e.empresa_id)}</option>)}</select></label>
      <button className="btn btn--sm btn--primary" disabled={busy || !nueva} onClick={() => cambiar(nueva, true, false, "Programación activada")}>Activar cada noche</button>
    </div>}
  </div></div>;
}

