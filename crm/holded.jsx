import React from "react";
/* GUIMAES CRM — Holded (Configuración → Integraciones → Holded, solo rol admin).
   1) Subir un .json, .csv o .xlsx con cliente, nif, subdominio y api_token.
      El archivo va tal cual a la Edge Function holded-conexiones, que guarda
      cada clave en Supabase Vault (provisional, 1 hora). El navegador no lo
      lee ni lo guarda: la vista previa solo trae los 4 últimos caracteres.
   2) Vista previa: empresa propuesta (por NIF o nombre), elegir otra, crear
      la empresa en el CRM o no conectar; reemplazar la clave si ya había.
   3) Guardar y verificar (llamadas de solo lectura a Holded, de 10 en 10).
   Lista de conexiones con estado, permisos, uso de la API, verificar de
   nuevo y revocar. Ver crm/supabase-holded-conexiones.sql. */
const { useState: hState, useEffect: hEffect, useMemo: hMemo } = React;

export const PERMISOS_HOLDED = [
  ["facturas", "Facturas y abonos"], ["compras", "Compras"], ["contactos", "Contactos"],
  ["bancos", "Bancos"], ["cuenta", "Cuenta"], ["uso", "Uso de la API"],
];
const COLUMNAS = "empresa_id, subdominio, ultimos4, estado, ultimo_error, permisos, nif_coincide, uso_holded, verificada_at, creada_por, created_at, updated_at";
const fmtFecha = (s) => { try { return new Date(s).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Madrid" }); } catch (e) { return s || ""; } };
const fmtDia = (s) => { try { return new Date(s).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" }); } catch (e) { return s || ""; } };
const errorTexto = (e) => (e && (e.message || e.error_description)) || String(e);
const nombreEmpresa = (id) => (CRM.empresaById[id] || {}).razon_social || "(empresa borrada)";

async function invocar(body) {
  const res = await Auth.client.functions.invoke("holded-conexiones", { body });
  if (res.error) {
    let msg = res.error.message || "Error al llamar a holded-conexiones";
    try { const ctx = res.error.context; if (ctx && typeof ctx.json === "function") { const j = await ctx.json(); if (j && j.error) msg = j.error; } } catch (e) { /* sin JSON */ }
    throw new Error(msg);
  }
  return res.data;
}

export async function cargarConexionesHolded(empresaId) {
  let q = Auth.client.from("holded_conexiones").select(COLUMNAS);
  if (empresaId) q = q.eq("empresa_id", empresaId);
  const res = await q;
  if (res.error) throw res.error;
  return res.data || [];
}

export async function revocarHolded(empresaId) {
  const res = await Auth.client.rpc("holded_revocar", { p_empresa_id: empresaId });
  if (res.error) throw res.error;
  return res.data;
}

// Verifica de 10 en 10 (límite de la Edge Function); avisa del progreso.
async function verificarEnLotes(ids, progreso) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    progreso && progreso(i, ids.length);
    const r = await invocar({ accion: "verificar", empresas: ids.slice(i, i + 10) });
    out.push(...(r.resultados || []));
  }
  progreso && progreso(ids.length, ids.length);
  return out;
}

// Lee el archivo como base64 sin interpretarlo (lo interpreta el servidor).
function aBase64(file) {
  return new Promise((ok, ko) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, ""));
    fr.onerror = () => ko(new Error("No se pudo leer el archivo"));
    fr.readAsDataURL(file);
  });
}

export function EstadoHolded({ c }) {
  if (!c) return <Badge label="Sin conectar" color="#6E8298" />;
  if (c.estado === "ok") return <Badge label="Conectado" color="#1F9D6B" />;
  if (c.estado === "error") return <Badge label="Error" color="#D64545" />;
  return <Badge label="Sin verificar" color="#D9822B" />;
}

function Permisos({ p }) {
  const v = p || {};
  if (!Object.keys(v).length) return <span className="muted" style={{ fontSize: 12.5 }}>—</span>;
  return <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
    {PERMISOS_HOLDED.filter(([k]) => k in v).map(([k, l]) =>
      <span key={k} title={v[k] ? "Con permiso de lectura" : "Sin permiso (Holded responde 403)"} style={{
        fontSize: 11.5, padding: "2px 7px", borderRadius: 999,
        background: v[k] ? "var(--ok-soft, #E3F5EC)" : "var(--danger-soft, #FBE7E7)",
        color: v[k] ? "#1F7A55" : "var(--danger)",
      }}>{v[k] ? "✓" : "✕"} {l}</span>)}
  </div>;
}

function Uso({ u }) {
  if (!u || u.limite == null) return <span className="muted">—</span>;
  return <span className="mono" style={{ fontSize: 12.5 }} title={"Llamadas a la API de toda la cuenta de Holded en " + (u.periodo || "el mes")}>{u.usadas ?? "?"} / {u.limite}</span>;
}

// ---------------------------------------------------------------- vista previa
function accionInicial(f) {
  if (f.errores.length) return { accion: "omitir" };
  if (f.empresa_id) return { accion: "conectar", empresa_id: f.empresa_id, reemplazar: false };
  if (f.se_puede_crear) return { accion: "crear" };
  return { accion: "elegir" };
}

function FilaPrevia({ f, d, onChange, conexiones, opciones }) {
  const existente = d.accion === "conectar" && d.empresa_id ? conexiones[d.empresa_id] : null;
  const valor = d.accion === "conectar" ? d.empresa_id : d.accion;
  const cambiar = (v) => {
    if (v === "crear" || v === "omitir" || v === "elegir") onChange({ accion: v });
    else onChange({ accion: "conectar", empresa_id: v, reemplazar: false });
  };
  return <tr>
    <td className="mono">{f.fila}</td>
    <td><div className="tbl__name">{f.cliente || "—"}</div><div className="tbl__sub">{f.nif || "Sin NIF"}{f.subdominio ? " · " + f.subdominio : ""}</div></td>
    <td className="mono">{f.ultimos4 ? "••••" + f.ultimos4 : "—"}</td>
    <td style={{ minWidth: 260 }}>
      {f.errores.length ? <span className="muted" style={{ fontSize: 13 }}>No se puede conectar</span> :
        <select className="inp" style={{ padding: "6px 10px", fontSize: 13, width: "100%" }} value={valor || ""} onChange={(e) => cambiar(e.target.value)}>
          {d.accion === "elegir" && <option value="elegir">— Elige qué hacer —</option>}
          {f.se_puede_crear && <option value="crear">Crear empresa en el CRM</option>}
          <option value="omitir">No conectar</option>
          <optgroup label="Conectar con la empresa…">
            {opciones.map((e) => <option key={e.id} value={e.id}>{e.razon_social}{e.cif ? " · " + e.cif : ""}{e.archived_at ? " (archivada)" : ""}</option>)}
          </optgroup>
        </select>}
      {d.accion === "conectar" && f.empresa_id === d.empresa_id && f.via && <div className="tbl__sub">Propuesta por {f.via === "nif" ? "NIF" : "nombre"}</div>}
      {existente && <label className="row" style={{ gap: 6, marginTop: 6, fontSize: 12.5, color: "var(--warn)" }}>
        <input type="checkbox" checked={!!d.reemplazar} onChange={(e) => onChange({ ...d, reemplazar: e.target.checked })} />
        Ya tiene Holded (••••{existente.ultimos4}). Reemplazar la clave
      </label>}
    </td>
    <td>
      {f.errores.map((e, i) => <div key={i} style={{ color: "var(--danger)", fontSize: 12.5 }}>{e}</div>)}
      {f.avisos.map((a, i) => <div key={i} className="muted" style={{ fontSize: 12.5 }}>{a}</div>)}
    </td>
  </tr>;
}

// ---------------------------------------------------------------- pantalla
export function HoldedIntegracion({ toast, nav }) {
  const [paso, setPaso] = hState("subir");          // subir | previa | hecho
  const [archivo, setArchivo] = hState("");
  const [previa, setPrevia] = hState(null);         // {carga, expira_at, filas}
  const [dec, setDec] = hState({});                 // fila → decisión
  const [resultado, setResultado] = hState(null);
  const [busy, setBusy] = hState("");
  const [err, setErr] = hState("");
  const [conexiones, setConexiones] = hState(null);
  const [revocar, setRevocar] = hState(null);

  const cargar = async () => {
    try { setConexiones(await cargarConexionesHolded()); }
    catch (e) { setErr("No se pudieron cargar las conexiones: " + errorTexto(e)); }
  };
  hEffect(() => { cargar(); }, []);
  const porEmpresa = hMemo(() => Object.fromEntries((conexiones || []).map((c) => [c.empresa_id, c])), [conexiones]);
  const opciones = hMemo(() => CRM.EMPRESAS.slice().sort((a, b) => a.razon_social.localeCompare(b.razon_social, "es")), [paso]);

  const reiniciar = () => { setPaso("subir"); setArchivo(""); setPrevia(null); setDec({}); setResultado(null); setErr(""); };

  const elegir = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (!/\.(json|csv|xlsx)$/i.test(file.name)) { setErr("Sube un .json, .csv o .xlsx."); return; }
    if (file.size > 2 * 1024 * 1024) { setErr("El archivo pasa de 2 MB."); return; }
    setErr(""); setBusy("Subiendo y revisando…");
    try {
      const p = await invocar({ accion: "previsualizar", archivo: { nombre: file.name, base64: await aBase64(file) } });
      setArchivo(file.name); setPrevia(p);
      setDec(Object.fromEntries(p.filas.map((f) => [f.fila, accionInicial(f)])));
      setPaso("previa");
    } catch (e) { setErr(errorTexto(e)); }
    setBusy("");
  };

  const filasValidas = previa ? previa.filas.filter((f) => !f.errores.length) : [];
  const pendientes = filasValidas.filter((f) => (dec[f.fila] || {}).accion === "elegir").length;
  const sinReemplazar = filasValidas.filter((f) => { const d = dec[f.fila] || {}; return d.accion === "conectar" && porEmpresa[d.empresa_id] && !d.reemplazar; }).length;
  const repetidas = (() => { const vistos = new Set(); let n = 0; for (const f of filasValidas) { const d = dec[f.fila] || {}; if (d.accion === "conectar") { if (vistos.has(d.empresa_id)) n++; vistos.add(d.empresa_id); } } return n; })();
  const nConectar = filasValidas.filter((f) => ["conectar", "crear"].includes((dec[f.fila] || {}).accion)).length;
  const nCrear = filasValidas.filter((f) => (dec[f.fila] || {}).accion === "crear").length;

  const guardar = async () => {
    setErr(""); setBusy("Guardando…");
    try {
      const decisiones = previa.filas.filter((f) => !f.errores.length).map((f) => {
        const d = dec[f.fila] || { accion: "omitir" };
        return { fila: f.fila, accion: d.accion === "elegir" ? "omitir" : d.accion, empresa_id: d.empresa_id || null, reemplazar: !!d.reemplazar };
      });
      const r = await invocar({ accion: "confirmar", carga: previa.carga, archivo_nombre: archivo, decisiones });
      if (r.lote && CRM.loadEmpresas) await CRM.loadEmpresas(Auth.client);
      let verif = [];
      if (r.verificar && r.verificar.length) {
        verif = await verificarEnLotes(r.verificar, (i, n) => setBusy(`Verificando con Holded… ${i} de ${n}`));
      }
      setResultado({ ...r, verif }); setPaso("hecho");
      toast("Conexiones con Holded guardadas");
      await cargar();
    } catch (e) { setErr(errorTexto(e)); }
    setBusy("");
  };

  const verificarDeNuevo = async (ids) => {
    setErr(""); setBusy("Verificando con Holded…");
    try {
      const r = await verificarEnLotes(ids, (i, n) => setBusy(`Verificando con Holded… ${i} de ${n}`));
      const malas = r.filter((x) => x.estado !== "ok").length;
      toast(malas ? `${malas} con error` : "Verificadas");
      await cargar();
    } catch (e) { setErr(errorTexto(e)); }
    setBusy("");
  };

  const confirmarRevocar = async () => {
    const id = revocar; setBusy("Revocando…");
    try { await revocarHolded(id); toast("Conexión con Holded revocada y clave borrada"); setRevocar(null); await cargar(); }
    catch (e) { setErr(errorTexto(e)); setRevocar(null); }
    setBusy("");
  };

  const resumenRes = resultado ? resultado.filas.reduce((a, f) => { a[f.resultado] = (a[f.resultado] || 0) + 1; return a; }, {}) : {};

  return <div>
    <div className="toolbar"><div className="muted" style={{ fontSize: 13 }}>Conecta cada empresa con su cuenta de Holded para que el asistente consulte (solo lectura) facturas, contactos y tesorería. Las claves se guardan cifradas en Supabase Vault y no se vuelven a mostrar: solo sus 4 últimos caracteres.</div><div className="toolbar__spacer"></div>
      {paso !== "subir" && <button className="btn btn--ghost" onClick={reiniciar} disabled={!!busy}>Empezar de nuevo</button>}</div>
    {err && <div className="card" style={{ marginBottom: 14, borderColor: "var(--danger)" }}><div className="card__body" style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div></div>}
    {busy && <p className="muted" style={{ fontSize: 13 }}>{busy}</p>}

    {paso === "subir" && <div className="card"><div className="card__body">
      <label className="btn btn--primary" style={{ cursor: busy ? "wait" : "pointer" }}>
        <Icon name="upload" size={16} />{busy ? "Revisando…" : "Subir archivo de claves (.json, .csv o .xlsx)"}
        <input type="file" accept=".json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={elegir} disabled={!!busy} style={{ display: "none" }} />
      </label>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Columnas: <span className="mono">cliente</span>, <span className="mono">nif</span>, <span className="mono">subdominio</span>, <span className="mono">api_token</span> (en JSON, una lista de objetos con esas claves). Las claves de la API actual de Holded empiezan por <span className="mono">pat_</span>. Se recomienda generarlas solo con permisos de lectura. Nada se guarda hasta pulsar «Guardar y verificar»; la vista previa caduca en una hora.</p>
    </div></div>}

    {paso === "previa" && previa && <div className="card"><div className="card__body">
      <div style={{ fontWeight: 700, fontFamily: "var(--display)", marginBottom: 4 }}>Vista previa · {archivo}</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{previa.filas.length} cuentas · {previa.filas.length - filasValidas.length} con errores (no se conectan). Caduca a las {new Date(previa.expira_at).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" })}.</p>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th style={{ width: 50 }}>Fila</th><th>Cliente</th><th>Clave</th><th>Empresa del CRM</th><th>Errores y avisos</th></tr></thead><tbody>
        {previa.filas.map((f) => <FilaPrevia key={f.fila} f={f} d={dec[f.fila] || {}} conexiones={porEmpresa} opciones={opciones}
          onChange={(d) => setDec((x) => ({ ...x, [f.fila]: d }))} />)}
      </tbody></table></div>
      {pendientes > 0 && <p style={{ color: "var(--warn)", fontSize: 13 }}>{pendientes} cuenta(s) sin decidir: elige una empresa o «No conectar».</p>}
      {sinReemplazar > 0 && <p style={{ color: "var(--warn)", fontSize: 13 }}>{sinReemplazar} empresa(s) ya tienen Holded: marca «Reemplazar la clave» o elige «No conectar».</p>}
      {repetidas > 0 && <p style={{ color: "var(--danger)", fontSize: 13 }}>Hay dos cuentas apuntando a la misma empresa.</p>}
      <div className="row" style={{ marginTop: 14, gap: 8, alignItems: "center" }}>
        <button className="btn btn--primary" onClick={guardar} disabled={!!busy || pendientes > 0 || sinReemplazar > 0 || repetidas > 0 || nConectar === 0}>{busy ? busy : `Guardar y verificar (${nConectar})`}</button>
        {nCrear > 0 && <span className="muted" style={{ fontSize: 12.5 }}>Se crearán {nCrear} empresa(s) nuevas en un lote que se puede deshacer desde Importar.</span>}
      </div>
    </div></div>}

    {paso === "hecho" && resultado && <div className="card" style={{ marginBottom: 14 }}><div className="card__body">
      <div style={{ fontWeight: 700, fontFamily: "var(--display)" }}>Guardado</div>
      <p className="muted" style={{ fontSize: 13 }}>{resumenRes.conectada || 0} conectadas · {resumenRes.reemplazada || 0} con la clave reemplazada · {resumenRes.creada || 0} empresas creadas · {resumenRes.omitida || 0} sin conectar. Verificación: {resultado.verif.filter((x) => x.estado === "ok").length} correctas, {resultado.verif.filter((x) => x.estado !== "ok").length} con error.</p>
      {resultado.filas.some((f) => f.nif_pendiente) && <p style={{ fontSize: 13, color: "var(--warn)" }}>Empresas creadas con NIF pendiente: {resultado.filas.filter((f) => f.nif_pendiente).map((f) => nombreEmpresa(f.empresa_id)).join(", ")}.</p>}
    </div></div>}

    <div className="card" style={{ marginTop: 20 }}><div className="card__body">
      <div className="row" style={{ marginBottom: 10, alignItems: "center" }}>
        <div style={{ fontWeight: 700, fontFamily: "var(--display)" }}>Empresas conectadas</div>
        <div style={{ flex: 1 }}></div>
        {conexiones && conexiones.length > 0 && <button className="btn btn--sm btn--ghost" disabled={!!busy} onClick={() => verificarDeNuevo(conexiones.map((c) => c.empresa_id))}><Icon name="refresh" size={14} />Verificar todas</button>}
      </div>
      {!conexiones && <p className="muted" style={{ fontSize: 13 }}>Cargando…</p>}
      {conexiones && !conexiones.length && <p className="muted" style={{ fontSize: 13 }}>Ninguna empresa tiene Holded conectado todavía.</p>}
      {conexiones && conexiones.length > 0 && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Empresa</th><th>Estado</th><th>Clave</th><th>Permisos de la clave</th><th>Uso API (mes)</th><th>Verificada</th><th></th></tr></thead><tbody>
        {conexiones.slice().sort((a, b) => nombreEmpresa(a.empresa_id).localeCompare(nombreEmpresa(b.empresa_id), "es")).map((c) => <tr key={c.empresa_id}>
          <td><a className="tbl__name" style={{ cursor: "pointer" }} onClick={() => nav && nav("empresa", c.empresa_id)}>{nombreEmpresa(c.empresa_id)}</a>
            {c.nif_coincide === false && <div style={{ fontSize: 12, color: "var(--warn)" }}>El NIF de la cuenta de Holded no coincide con el CIF de la empresa</div>}
            {c.estado === "error" && c.ultimo_error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{c.ultimo_error}</div>}</td>
          <td><EstadoHolded c={c} /></td>
          <td className="mono">••••{c.ultimos4}</td>
          <td><Permisos p={c.permisos} /></td>
          <td><Uso u={c.uso_holded} /></td>
          <td className="mono" style={{ fontSize: 12.5 }}>{c.verificada_at ? fmtFecha(c.verificada_at) : "—"}</td>
          <td style={{ whiteSpace: "nowrap" }}>
            <button className="btn btn--sm btn--ghost" disabled={!!busy} title="Verificar de nuevo" onClick={() => verificarDeNuevo([c.empresa_id])}><Icon name="refresh" size={14} /></button>
            <button className="btn btn--sm btn--ghost" disabled={!!busy} title="Revocar" onClick={() => setRevocar(c.empresa_id)}><Icon name="trash" size={14} /></button>
          </td>
        </tr>)}
      </tbody></table></div>}
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Cada verificación hace 6 llamadas de lectura a Holded, que cuentan en el cupo mensual de la cuenta del cliente.</p>
    </div></div>

    {revocar && <ModalRevocar empresaId={revocar} busy={!!busy} onCancel={() => setRevocar(null)} onOk={confirmarRevocar} />}
  </div>;
}

function ModalRevocar({ empresaId, busy, onCancel, onOk }) {
  return <Modal title="Revocar la conexión con Holded" onClose={() => !busy && onCancel()} footer={<>
    <button className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
    <button className="btn btn--danger" onClick={onOk} disabled={busy}>{busy ? "Revocando…" : "Revocar"}</button></>}>
    <p className="muted">Se borrará la clave de Holded de <b>{nombreEmpresa(empresaId)}</b> (de Supabase Vault, sin vuelta atrás) y el asistente dejará de consultar su Holded. Para volver a conectarla habrá que subir la clave otra vez.</p>
    <p className="muted">La clave sigue activa en Holded: si quieres anularla del todo, bórrala también en Holded → Ajustes → API.</p>
  </Modal>;
}

// ---------------------------------------------------------------- ficha de empresa
export function HoldedFicha({ empresaId, esRolAdmin, toast }) {
  const [c, setC] = hState(undefined);   // undefined = cargando; null = sin conexión
  const [revocar, setRevocar] = hState(false);
  const [busy, setBusy] = hState(false);
  const cargar = async () => {
    try { const l = await cargarConexionesHolded(empresaId); setC(l[0] || null); }
    catch (e) { setC(null); }
  };
  hEffect(() => { setC(undefined); cargar(); }, [empresaId]);
  if (c === undefined || c === null) return null;
  const ok = async () => {
    setBusy(true);
    try { await revocarHolded(empresaId); toast("Conexión con Holded revocada"); setRevocar(false); await cargar(); }
    catch (e) { toast("No se pudo revocar: " + errorTexto(e)); }
    setBusy(false);
  };
  const faltan = PERMISOS_HOLDED.filter(([k]) => ["facturas", "compras", "contactos", "bancos"].includes(k) && c.permisos && c.permisos[k] === false).map(([, l]) => l.toLowerCase());
  return <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 9, background: "var(--surface-2, #F4F6F8)", fontSize: 13 }}>
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <b>{c.estado === "ok" ? "Holded conectado" : c.estado === "error" ? "Holded: error" : "Holded sin verificar"}</b>
      <div style={{ flex: 1 }}></div>
      <EstadoHolded c={c} />
    </div>
    <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
      {c.verificada_at ? "Verificado el " + fmtDia(c.verificada_at) : "Aún no se ha verificado"} · clave ••••{c.ultimos4}
    </div>
    {c.estado === "error" && c.ultimo_error && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 4 }}>{c.ultimo_error}</div>}
    {c.estado === "ok" && faltan.length > 0 && <div style={{ fontSize: 12.5, color: "var(--warn)", marginTop: 4 }}>Sin permiso de {faltan.join(", ")}.</div>}
    {esRolAdmin && <button className="btn btn--sm btn--ghost" style={{ marginTop: 8, width: "100%" }} onClick={() => setRevocar(true)}><Icon name="trash" size={14} />Revocar Holded</button>}
    {revocar && <ModalRevocar empresaId={empresaId} busy={busy} onCancel={() => setRevocar(false)} onOk={ok} />}
  </div>;
}
