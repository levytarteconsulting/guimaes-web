import React from "react";
/* GUIMAES CRM — Acciones en Holded (solo rol admin).
   Propuestas de escritura en Holded (por ahora: aprobar tickets de venta)
   que prepara el asistente o el operador. Aquí se revisan (resumen, muestra,
   excluidos y avisos), se aprueban o rechazan y, una vez aprobadas, se sigue
   su ejecución, que hace la Edge Function holded-acciones en segundo plano
   (pg_cron, cada minuto): pausar, reanudar y cancelar. Aprobar más de 100
   documentos exige escribir el número. También el cupo mensual de acciones
   por empresa. Ver crm/supabase-holded-acciones.sql. */
const { useState: aState, useEffect: aEffect, useMemo: aMemo } = React;

const TIPOS = { aprobar_tickets_venta: "Aprobar tickets de venta" };
const ESTADOS = {
  propuesta: ["Propuesta", "var(--warn)"], aprobada: ["Aprobada · en cola", "var(--accent, #2563eb)"],
  en_curso: ["En curso", "var(--accent, #2563eb)"], pausada: ["Pausada", "var(--warn)"],
  completada: ["Completada", "var(--ok, #16a34a)"], cancelada: ["Cancelada", "var(--muted, #6b7280)"],
  rechazada: ["Rechazada", "var(--muted, #6b7280)"],
};
const COLUMNAS = "id, created_at, updated_at, empresa_id, tipo, parametros, resumen, avisos, estado, motivo_estado, origen, propuesta_por, aprobada_por, aprobada_at, rechazada_por, cerrada_por, iniciada_at, terminada_at, expira_at, llamadas_lectura, llamadas_escritura";
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

function Barra({ p }) {
  if (!p || !p.total) return null;
  const pct = (n) => `${(100 * n / p.total).toFixed(2)}%`;
  return <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--line, #e5e7eb)", margin: "6px 0" }}>
    <div style={{ width: pct(p.ok), background: "var(--ok, #16a34a)" }} />
    <div style={{ width: pct(p.error), background: "var(--danger, #dc2626)" }} />
    <div style={{ width: pct(p.omitido), background: "var(--muted, #9ca3af)" }} />
  </div>;
}

export function Acciones({ toast, nav, focusId }) {
  const [lista, setLista] = aState(null);
  const [err, setErr] = aState("");
  const [sel, setSel] = aState(focusId || null);
  const [filtro, setFiltro] = aState("abiertas");
  const cargar = async () => {
    const r = await Auth.client.from("holded_acciones").select(COLUMNAS).order("created_at", { ascending: false }).limit(200);
    if (r.error) { setErr("No se pudieron cargar las acciones: " + errorTexto(r.error)); return; }
    setErr(""); setLista(r.data || []);
  };
  aEffect(() => { cargar(); }, []);
  // Mientras haya algo en marcha, refresca la lista cada 15 s.
  const enMarcha = (lista || []).some(viva);
  aEffect(() => { if (!enMarcha) return; const t = setInterval(cargar, 15000); return () => clearInterval(t); }, [enMarcha]);

  const visibles = (lista || []).filter((a) => filtro === "todas" || ["propuesta", "aprobada", "en_curso", "pausada"].includes(a.estado) && !caducada(a));
  const actual = (lista || []).find((a) => a.id === sel);

  return <div>
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
      <th>Creada</th><th>Empresa</th><th>Acción</th><th style={{ textAlign: "right" }}>Documentos</th><th>Fechas</th><th style={{ textAlign: "right" }}>Total</th><th>Estado</th><th>Propuesta por</th></tr></thead><tbody>
      {visibles.map((a) => <tr key={a.id} style={{ cursor: "pointer", background: a.id === sel ? "var(--hover, rgba(0,0,0,.04))" : undefined }} onClick={() => setSel(a.id)}>
        <td className="mono" style={{ fontSize: 12.5 }}>{fmtFecha(a.created_at)}</td>
        <td><b>{nombreEmpresa(a.empresa_id)}</b></td>
        <td>{TIPOS[a.tipo] || a.tipo}</td>
        <td className="mono" style={{ textAlign: "right" }}>{(a.resumen || {}).documentos ?? "—"}</td>
        <td className="mono" style={{ fontSize: 12.5 }}>{fmtDia((a.resumen || {}).desde)} – {fmtDia((a.resumen || {}).hasta)}</td>
        <td className="mono" style={{ textAlign: "right" }}>{(a.resumen || {}).total != null ? eur(a.resumen.total, a.resumen.moneda) : "—"}</td>
        <td><Estado a={a} /></td>
        <td style={{ fontSize: 12.5 }}>{quienPropuso(a)}</td>
      </tr>)}
    </tbody></table></div></div>}

    {actual && <Detalle key={actual.id} a={actual} toast={toast} nav={nav} onCambio={cargar} onCerrar={() => setSel(null)} />}
    <Cupos toast={toast} />
  </div>;
}

function Detalle({ a, toast, nav, onCambio, onCerrar }) {
  const [extra, setExtra] = aState(null);          // { muestra, excluidos }
  const [prog, setProg] = aState(null);
  const [modal, setModal] = aState("");            // aprobar | rechazar | cancelar
  const [busy, setBusy] = aState(false);
  const r = a.resumen || {};

  aEffect(() => {
    (async () => {
      const x = await Auth.client.from("holded_acciones").select("muestra, excluidos").eq("id", a.id).maybeSingle();
      setExtra(x.data || { muestra: [], excluidos: [] });
    })();
  }, [a.id]);
  const cargarProg = async () => { try { setProg(await rpc("holded_acciones_progreso", { p_accion: a.id })); } catch (e) { /* sin permiso o borrada */ } };
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
      <div style={{ fontWeight: 700, fontFamily: "var(--display)", fontSize: 16 }}>{TIPOS[a.tipo] || a.tipo} · <a style={{ cursor: "pointer" }} onClick={() => nav && nav("empresa", a.empresa_id)}>{nombreEmpresa(a.empresa_id)}</a></div>
      <Estado a={a} />
      <div style={{ flex: 1 }}></div>
      {a.estado === "propuesta" && !caducada(a) && <>
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

    <div className="row" style={{ gap: 28, flexWrap: "wrap", margin: "10px 0 14px" }}>
      {[["Documentos", r.documentos], ["Desde", fmtDia(r.desde)], ["Hasta", fmtDia(r.hasta)], ["Base", eur(r.base, r.moneda)], ["IVA", eur(r.iva, r.moneda)], ["Total", eur(r.total, r.moneda)], ["Excluidos", r.excluidos ?? 0]].map(([k, v]) =>
        <div key={k}><div className="muted" style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".04em" }}>{k}</div><div className="mono" style={{ fontSize: 16, fontWeight: 600 }}>{v}</div></div>)}
    </div>

    {prog && prog.total > 0 && <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Progreso</div>
      <Barra p={prog} />
      <div className="mono" style={{ fontSize: 12.5 }}>{prog.ok} aprobados · {prog.error} con error · {prog.pendiente + prog.en_proceso} pendientes{prog.omitido ? ` · ${prog.omitido} omitidos` : ""} de {prog.total}
        {" · "}{a.llamadas_escritura} llamadas de escritura y {a.llamadas_lectura} de lectura{duracion != null ? ` · ${duracion} min` : ""}{prog.ultimo_at ? ` · último: ${fmtFecha(prog.ultimo_at)}` : ""}</div>
      {prog.errores && prog.errores.length > 0 && <details style={{ marginTop: 8 }}><summary style={{ cursor: "pointer", fontSize: 13, color: "var(--danger)" }}>{prog.error} con error{prog.errores.length < prog.error ? ` (se muestran ${prog.errores.length})` : ""}</summary>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Id en Holded</th><th>Código</th><th>Motivo</th></tr></thead><tbody>
          {prog.errores.map((e) => <tr key={e.holded_id}><td className="mono" style={{ fontSize: 12 }}>{e.holded_id}</td><td className="mono">{e.codigo ?? "—"}</td><td style={{ fontSize: 12.5 }}>{e.error}</td></tr>)}
        </tbody></table></div></details>}
    </div>}

    {(a.avisos || []).length > 0 && <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Avisos</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{a.avisos.map((x, i) => <li key={i} style={{ color: /^⚠/.test(x) ? "var(--danger)" : undefined, marginBottom: 3 }}>{x}</li>)}</ul>
    </div>}

    {extra && extra.muestra && extra.muestra.length > 0 && <details open={a.estado === "propuesta"} style={{ marginBottom: 10 }}>
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

    {modal === "aprobar" && <ModalAprobar a={a} busy={busy} onCancel={() => setModal("")} onOk={(n) => hacer("holded_acciones_aprobar", { p_confirmacion: n }, "Aprobada: empieza en menos de un minuto")} />}
    {modal === "rechazar" && <ModalRechazar busy={busy} onCancel={() => setModal("")} onOk={(m) => hacer("holded_acciones_rechazar", { p_motivo: m }, "Propuesta rechazada")} />}
    {modal === "cancelar" && <Modal title="Cancelar la acción" onClose={() => !busy && setModal("")} footer={<>
      <button className="btn btn--ghost" onClick={() => setModal("")} disabled={busy}>Volver</button>
      <button className="btn btn--danger" onClick={() => hacer("holded_acciones_cancelar", {}, "Acción cancelada")} disabled={busy}>{busy ? "Cancelando…" : "Cancelar la acción"}</button></>}>
      <p className="muted">Los documentos que faltan no se tocarán. Los que ya se han aprobado en Holded siguen aprobados: cancelar no los deshace.</p>
    </Modal>}
  </div></div>;
}

function ModalAprobar({ a, busy, onCancel, onOk }) {
  const n = (a.resumen || {}).documentos || 0;
  const [valor, setValor] = aState("");
  const exige = n > 100;
  const valido = !exige || Number(valor.trim()) === n;
  return <Modal title={`Aprobar: ${TIPOS[a.tipo] || a.tipo}`} onClose={() => !busy && onCancel()} footer={<>
    <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>Volver</button>
    <button className="btn btn--primary" onClick={() => onOk(exige ? n : null)} disabled={busy || !valido}>{busy ? "Aprobando…" : `Aprobar ${n} documentos`}</button></>}>
    <p>Se aprobarán en Holded <b>{n}</b> tickets de venta de <b>{nombreEmpresa(a.empresa_id)}</b>, del {fmtDia((a.resumen || {}).desde)} al {fmtDia((a.resumen || {}).hasta)}, por un total de <b>{eur((a.resumen || {}).total, (a.resumen || {}).moneda)}</b>.</p>
    <ul style={{ fontSize: 13, paddingLeft: 18 }}>
      <li>Cada ticket recibe su número de serie y deja de poder modificarse o borrarse en Holded.</li>
      <li>Si la cuenta tiene VeriFactu, cada uno se registra y se envía a la AEAT: no se puede deshacer.</li>
      <li>Se hace en segundo plano, unos 40 por minuto. Puedes pausar o cancelar lo que falte, pero no deshacer lo ya aprobado.</li>
    </ul>
    {exige && <label style={{ display: "block", fontSize: 13, marginTop: 10 }}>Para confirmar, escribe el número de documentos (<b>{n}</b>):
      <input className="inp mono" style={{ display: "block", width: 140, marginTop: 6 }} inputMode="numeric" value={valor} onChange={(e) => setValor(e.target.value)} autoFocus /></label>}
  </Modal>;
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
function Cupos({ toast }) {
  const [uso, setUso] = aState(null);
  const [edit, setEdit] = aState(null);   // { id, valor }
  const [busy, setBusy] = aState(false);
  const cargar = async () => { try { setUso(await rpc("holded_acciones_uso_mes", {})); } catch (e) { setUso([]); } };
  aEffect(() => { cargar(); }, []);
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
    <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>Documentos que se pueden tocar en Holded cada mes, aparte del tope de consultas del asistente. Con 0 no se ejecuta nada; al llegar al cupo, la acción se pausa hasta que lo subas o empiece el mes siguiente.</p>
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
