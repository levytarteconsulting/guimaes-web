import React from "react";
import { CAMPOS, construirFilas, incidencias, leerCsv, leerXlsx, mapeoInicial } from "./importador-util.js";
/* GUIMAES CRM — Configuración → Importar (solo rol admin).
   1) Subir .xlsx o .csv (primera fila = cabeceras).
   2) Correspondencia de columnas, ya rellenada con el orden habitual.
   3) Vista previa: la calcula la base (admin_importar_clientes con
      simular = true), que resuelve duplicados contra el CRM. Nada se escribe.
   4) Importar: misma RPC con simular = false, en una sola transacción.
   Historial de lotes con "Deshacer este lote" (admin_deshacer_importacion).
   Ver crm/supabase-importador.sql. */
const { useState: iState, useEffect: iEffect, useMemo: iMemo } = React;

const fmtFecha = (s) => { try { return new Date(s).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }); } catch (e) { return s || ""; } };
const nombreUsuario = (authId) => (CRM.USERS.find((u) => u.auth_user_id === authId) || {}).name || "—";
const letra = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const errorTexto = (e) => (e && (e.message || e.error_description)) || String(e);

async function recargarCaches() {
  const c = Auth.client;
  if (CRM.loadEmpresas) await CRM.loadEmpresas(c);
  if (CRM.loadContactos) await CRM.loadContactos(c);
  if (CRM.loadContactoEmpresa) await CRM.loadContactoEmpresa(c);
  if (CRM.loadDeals) await CRM.loadDeals(c);
}

function Cifras({ r, titulo }) {
  const items = [
    ["building", "Empresas nuevas", r.empresas_nuevas], ["building", "Empresas ya existentes", r.empresas_existentes],
    ["user", "Contactos nuevos", r.contactos_nuevos], ["user", "Contactos ya existentes", r.contactos_existentes],
    ["briefcase", titulo === "resultado" ? "Negocios creados" : "Negocios a crear", r.negocios_nuevos],
    ["briefcase", "Negocios omitidos (repetidos o ya en el CRM)", r.negocios_omitidos],
    ["copy", "Vínculos contacto–empresa", r.vinculos_nuevos], ["edit", "Campos vacíos rellenados", r.campos_rellenados],
  ];
  return <div className="kpi-grid" style={{ marginBottom: 16 }}>
    {items.map(([ic, l, v]) => <div key={l} className="kpi"><div className="kpi__label"><Icon name={ic} size={15} />{l}</div><div className="kpi__val mono">{v ?? 0}</div></div>)}
  </div>;
}

function TablaIncidencias({ lista }) {
  if (!lista.length) return <p className="muted" style={{ fontSize: 13 }}>Ninguna fila tiene errores ni avisos.</p>;
  return <div className="tbl-wrap"><table className="tbl"><thead><tr><th style={{ width: 70 }}>Fila</th><th>Errores (bloquean)</th><th>Avisos</th></tr></thead><tbody>
    {lista.map((x) => <tr key={x.fila}>
      <td className="mono">{x.fila}</td>
      <td>{x.errores.map((e, i) => <div key={i} style={{ color: "var(--danger)", fontSize: 13 }}>{e}</div>)}</td>
      <td>{x.avisos.map((a, i) => <div key={i} className="muted" style={{ fontSize: 13 }}>{a}</div>)}</td>
    </tr>)}
  </tbody></table></div>;
}

function Historial({ refresco, toast }) {
  const [lotes, setLotes] = iState(null);
  const [err, setErr] = iState("");
  const [confirmar, setConfirmar] = iState(null);
  const [busy, setBusy] = iState(false);
  const [msg, setMsg] = iState("");
  const cargar = async () => {
    const res = await Auth.client.from("importaciones").select("id, created_at, created_by, archivo, filas, resumen, deshecha_at, deshecha_by, deshecha_resumen").order("created_at", { ascending: false }).limit(50);
    if (res.error) { setErr(errorTexto(res.error)); return; }
    setErr(""); setLotes(res.data || []);
  };
  iEffect(() => { cargar(); }, [refresco]);
  const deshacer = async () => {
    setBusy(true); setMsg("");
    const res = await Auth.client.rpc("admin_deshacer_importacion", { p_importacion_id: confirmar.id });
    setBusy(false);
    if (res.error) { setMsg(errorTexto(res.error)); return; }
    const d = res.data || {};
    setConfirmar(null);
    toast("Lote deshecho");
    setMsg(`Lote deshecho: ${d.empresas_borradas} empresas, ${d.contactos_borrados} contactos y ${d.negocios_borrados} negocios borrados; ${d.campos_revertidos} campos vueltos a vacío.`);
    await recargarCaches();
    cargar();
  };
  return <div className="card" style={{ marginTop: 20 }}><div className="card__body">
    <div style={{ fontWeight: 700, fontFamily: "var(--display)", marginBottom: 10 }}>Historial de importaciones</div>
    {msg && !confirmar && <p style={{ fontSize: 13 }}>{msg}</p>}
    {err && <p style={{ color: "var(--danger)", fontSize: 13 }}>No se pudo cargar el historial: {err}</p>}
    {lotes && !lotes.length && <p className="muted" style={{ fontSize: 13 }}>Todavía no hay importaciones.</p>}
    {lotes && lotes.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Fecha</th><th>Archivo</th><th>Por</th><th>Creado</th><th>Estado</th><th></th></tr></thead><tbody>
      {lotes.map((l) => { const r = l.resumen || {}; return <tr key={l.id}>
        <td className="mono" style={{ fontSize: 12.5 }}>{fmtFecha(l.created_at)}</td>
        <td className="tbl__sub">{l.archivo || "—"} · {l.filas} filas</td>
        <td>{nombreUsuario(l.created_by)}</td>
        <td style={{ fontSize: 13 }}>{r.empresas_nuevas ?? 0} empresas · {r.contactos_nuevos ?? 0} contactos · {r.negocios_nuevos ?? 0} negocios</td>
        <td>{l.deshecha_at ? <Badge label={"Deshecho " + fmtFecha(l.deshecha_at)} color="#6E8298" /> : <Badge label="Importado" color="#1F9D6B" />}</td>
        <td>{!l.deshecha_at && <button className="btn btn--sm btn--ghost" onClick={() => { setMsg(""); setConfirmar(l); }}><Icon name="refresh" size={14} />Deshacer este lote</button>}</td>
      </tr>; })}
    </tbody></table></div>}
    {confirmar && <Modal title="Deshacer este lote" onClose={() => !busy && setConfirmar(null)} footer={<>
      <button className="btn btn--ghost" onClick={() => setConfirmar(null)} disabled={busy}>Cancelar</button>
      <button className="btn btn--danger" onClick={deshacer} disabled={busy}>{busy ? "Deshaciendo…" : "Deshacer"}</button></>}>
      <p className="muted">Se borrará lo que creó la importación del {fmtFecha(confirmar.created_at)} ({confirmar.archivo || "sin nombre"}): empresas, contactos, negocios y vínculos nuevos. Los campos que rellenó en registros que ya existían vuelven a quedar vacíos.</p>
      {confirmar.resumen && confirmar.resumen.origen === "holded" && <p className="muted">Este lote viene de Holded: al borrar esas empresas también se revocan sus conexiones con Holded (y sus claves).</p>}
      <p className="muted">Si algo de lo importado se ha cambiado después (ediciones, notas, tareas, documentos, negocios nuevos…), no se deshace nada y verás el motivo.</p>
      {msg && <p style={{ color: "var(--danger)", fontSize: 13 }}>{msg}</p>}
    </Modal>}
  </div></div>;
}

export function Importador({ toast }) {
  const [paso, setPaso] = iState("subir");          // subir | columnas | previa | hecho
  const [archivo, setArchivo] = iState(null);
  const [filas, setFilas] = iState([]);
  const [mapa, setMapa] = iState({});
  const [busy, setBusy] = iState(false);
  const [err, setErr] = iState("");
  const [previa, setPrevia] = iState(null);          // {locales, rpc}
  const [resultado, setResultado] = iState(null);
  const [refresco, setRefresco] = iState(0);

  const cabeceras = filas[0] || [];
  const catalogos = () => ({ servicios: CRM.SERVICES, etapas: CRM.STAGES, lifecycle: CRM.LIFECYCLE, prioridades: CRM.PRIORITIES, admins: CRM.USERS });

  const reiniciar = () => { setPaso("subir"); setArchivo(null); setFilas([]); setMapa({}); setPrevia(null); setResultado(null); setErr(""); };

  const elegir = async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    setErr(""); setBusy(true);
    try {
      let rows;
      if (/\.xlsx$/i.test(f.name)) rows = await leerXlsx(await f.arrayBuffer());
      else if (/\.csv$/i.test(f.name)) rows = leerCsv(await f.text());
      else throw new Error("Solo se aceptan archivos .xlsx o .csv");
      if (rows.length < 2) throw new Error("El archivo no tiene filas de datos (la primera fila son las cabeceras)");
      setArchivo(f.name); setFilas(rows); setMapa(mapeoInicial(rows[0])); setPaso("columnas");
    } catch (e) { setErr(errorTexto(e)); }
    setBusy(false);
  };

  const revisar = async () => {
    setErr(""); setBusy(true);
    try {
      if (mapa.empresa < 0) throw new Error("Falta indicar la columna de Empresa");
      const locales = construirFilas(filas, mapa, catalogos());
      if (!locales.length) throw new Error("No hay filas con datos");
      const datos = locales.filter((x) => x.datos).map((x) => x.datos);
      let rpc = null;
      if (datos.length) {
        const res = await Auth.client.rpc("admin_importar_clientes", { p_archivo: archivo, p_filas: datos, p_simular: true });
        if (res.error) throw res.error;
        rpc = res.data;
      }
      setPrevia({ locales, rpc, datos }); setPaso("previa");
    } catch (e) { setErr(errorTexto(e)); }
    setBusy(false);
  };

  const lista = iMemo(() => (previa ? incidencias(previa.locales, previa.rpc && previa.rpc.filas) : []), [previa]);
  const nErrores = lista.filter((x) => x.errores.length).length;
  const bloqueado = !previa || !previa.rpc || nErrores > 0 || previa.rpc.bloqueado;

  const importar = async () => {
    setErr(""); setBusy(true);
    try {
      const res = await Auth.client.rpc("admin_importar_clientes", { p_archivo: archivo, p_filas: previa.datos, p_simular: false });
      if (res.error) throw res.error;
      if (res.data.bloqueado) { setPrevia({ ...previa, rpc: res.data }); throw new Error("La base de datos encontró errores: revisa la lista"); }
      setResultado(res.data); setPaso("hecho"); setRefresco((n) => n + 1);
      toast("Importación terminada");
      await recargarCaches();
    } catch (e) { setErr(errorTexto(e)); }
    setBusy(false);
  };

  const ejemplo = (idx) => {
    if (idx < 0) return "";
    const v = (filas.slice(1).find((f) => String(f[idx] || "").trim()) || [])[idx];
    return v ? String(v).slice(0, 40) : "";
  };

  return <div>
    <div className="toolbar"><div className="muted" style={{ fontSize: 13 }}>Carga empresas, contactos y negocios desde un Excel (.xlsx) o un .csv. Primera fila = cabeceras. Nada se escribe hasta pulsar «Importar», y cada lote se puede deshacer.</div><div className="toolbar__spacer"></div>
      {paso !== "subir" && <button className="btn btn--ghost" onClick={reiniciar} disabled={busy}>Empezar de nuevo</button>}</div>
    {err && <div className="card" style={{ marginBottom: 14, borderColor: "var(--danger)" }}><div className="card__body" style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div></div>}

    {paso === "subir" && <div className="card"><div className="card__body">
      <label className="btn btn--primary" style={{ cursor: busy ? "wait" : "pointer" }}>
        <Icon name="upload" size={16} />{busy ? "Leyendo…" : "Elegir archivo .xlsx o .csv"}
        <input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={elegir} disabled={busy} style={{ display: "none" }} />
      </label>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Columnas habituales: {CAMPOS.map((c) => c.label).join(" | ")}. Se lee la primera hoja del libro.</p>
    </div></div>}

    {paso === "columnas" && <div className="card"><div className="card__body">
      <div style={{ fontWeight: 700, fontFamily: "var(--display)", marginBottom: 4 }}>Correspondencia de columnas</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{archivo} · {filas.slice(1).filter((f) => f.some((c) => String(c || "").trim())).length} filas con datos. Revisa qué columna del archivo va a cada campo del CRM.</p>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Campo del CRM</th><th>Columna del archivo</th><th>Primer valor</th></tr></thead><tbody>
        {CAMPOS.map((c) => <tr key={c.id}>
          <td className="tbl__name">{c.label}{c.id === "empresa" && " *"}</td>
          <td><select className="inp" style={{ padding: "6px 10px", fontSize: 13 }} value={mapa[c.id]} onChange={(e) => setMapa({ ...mapa, [c.id]: parseInt(e.target.value, 10) })}>
            <option value={-1}>— No importar —</option>
            {cabeceras.map((h, i) => <option key={i} value={i}>{letra(i)}: {h || "(sin cabecera)"}</option>)}
          </select></td>
          <td className="tbl__sub">{ejemplo(mapa[c.id])}</td>
        </tr>)}
      </tbody></table></div>
      <div className="row" style={{ marginTop: 14, gap: 8 }}><button className="btn btn--primary" onClick={revisar} disabled={busy}>{busy ? "Revisando…" : "Ver vista previa"}</button></div>
    </div></div>}

    {paso === "previa" && previa && <div>
      {previa.rpc ? <Cifras r={previa.rpc.resumen} /> : null}
      <div className="card"><div className="card__body">
        <div style={{ fontWeight: 700, fontFamily: "var(--display)", marginBottom: 6 }}>Filas con errores o avisos</div>
        {nErrores > 0 && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 0 }}>{nErrores} fila(s) con errores. Corrígelas en el archivo y vuelve a subirlo: hasta entonces no se importa nada. Las filas con errores no cuentan en las cifras de arriba.</p>}
        <TablaIncidencias lista={lista} />
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="btn btn--ghost" onClick={() => setPaso("columnas")} disabled={busy}>Cambiar columnas</button>
          <button className="btn btn--primary" onClick={importar} disabled={busy || bloqueado}>{busy ? "Importando…" : "Importar"}</button>
        </div>
      </div></div>
    </div>}

    {paso === "hecho" && resultado && <div>
      <div className="card" style={{ marginBottom: 14 }}><div className="card__body">
        <div style={{ fontWeight: 700, fontFamily: "var(--display)" }}>Importación terminada</div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>{archivo}: {resultado.resumen.filas} filas. Creado: {resultado.resumen.empresas_nuevas} empresas, {resultado.resumen.contactos_nuevos} contactos, {resultado.resumen.negocios_nuevos} negocios y {resultado.resumen.vinculos_nuevos} vínculos. Omitido: {resultado.resumen.negocios_omitidos} negocios repetidos en el archivo o que la empresa ya tenía; {resultado.resumen.empresas_existentes} empresas y {resultado.resumen.contactos_existentes} contactos ya estaban en el CRM (solo se rellenaron {resultado.resumen.campos_rellenados} campos vacíos).</p>
      </div></div>
      <Cifras r={resultado.resumen} titulo="resultado" />
      <TablaIncidencias lista={incidencias([], resultado.filas)} />
    </div>}

    <Historial refresco={refresco} toast={toast} />
  </div>;
}
