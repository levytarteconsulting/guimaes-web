import React from "react";
/* GUIMAES CRM — Informes del asistente (herramienta mostrar_informe).
   La tarjeta pinta el informe que ha preparado el asistente (texto, tablas y
   gráficos SVG de barras, líneas o tarta) con tres botones:
     · Descargar PDF: logos, fecha, título, fuente y gráficos (informe-pdf.js,
       jsPDF cargado solo al pulsar).
     · Guardar en documentos: el mismo PDF en una carpeta de la empresa
       (CRM.subirDocumentoManual; nunca compartido con el cliente).
     · Guardar informe: guarda SOLO la petición (agente_informes) para
       regenerarlo después con datos nuevos, en una conversación nueva.
   Todo el texto viene del modelo: se pinta como texto de React, nunca como HTML. */
import { PALETA, TINTA, fmtNum, geometria, porcionesTarta, arco, recortar, columnaNumerica, celda } from "./informe-logica.js";

const { useState, useEffect, useRef } = React;
const FUENTE = "Helvetica, Arial, sans-serif";
const errorTexto = (e) => (e && (e.message || e.error_description)) || String(e);

/* ---------------- Gráficos ---------------- */
function Leyenda({ items }) {
  if (items.length < 2) return null;
  return <div className="inf-leyenda">{items.map((it, i) => <span key={i}><i style={{ background: it.color }} />{it.nombre}</span>)}</div>;
}

export function Grafico({ g, svgRef }) {
  const [hover, setHover] = useState(null);   // { x, y, texto }
  const W = 560, H = g.tipo === "tarta" ? 240 : 260;
  const unidad = g.unidad || "";
  let cuerpo, leyenda;
  if (g.tipo === "tarta") {
    const ps = porcionesTarta(g.etiquetas, g.series[0].valores);
    const cx = 130, cy = H / 2, r = 100;
    cuerpo = <>
      {ps.map((p, i) => <path key={i} d={arco(cx, cy, r, p.a0, p.a1)} fill={p.color} stroke={TINTA.fondo} strokeWidth={2}
        onMouseMove={() => setHover({ x: cx + 110, y: 16, texto: `${p.etiqueta}: ${fmtNum(p.valor, unidad)} (${(p.pct * 100).toFixed(1).replace(".", ",")} %)` })}
        onMouseLeave={() => setHover(null)}><title>{`${p.etiqueta}: ${fmtNum(p.valor, unidad)}`}</title></path>)}
      {ps.map((p, i) => <g key={"l" + i} transform={`translate(260, ${24 + i * 24})`}>
        <rect width={10} height={10} rx={2} fill={p.color} />
        <text x={16} y={9} fontSize={12} fill={TINTA.texto} fontFamily={FUENTE}>{recortar(p.etiqueta, 26)}</text>
        <text x={290} y={9} fontSize={12} fill={TINTA.suave} fontFamily={FUENTE} textAnchor="end">{fmtNum(p.valor, unidad)} · {(p.pct * 100).toFixed(0)} %</text>
      </g>)}
    </>;
  } else {
    const r = geometria(g, W, H);
    const col = (k) => PALETA[k % PALETA.length];
    leyenda = g.series.map((s, k) => ({ nombre: s.nombre, color: col(k) }));
    cuerpo = <>
      {r.marcas.map((v, i) => <g key={"m" + i}>
        <line x1={r.m.izq} x2={W - r.m.der} y1={r.y(v)} y2={r.y(v)} stroke={v === 0 ? TINTA.eje : TINTA.rejilla} strokeWidth={1} />
        <text x={r.m.izq - 6} y={r.y(v) + 4} fontSize={11} fill={TINTA.suave} textAnchor="end" fontFamily={FUENTE}>{fmtNum(v, unidad, true)}</text>
      </g>)}
      {g.etiquetas.map((e, i) => i % r.salto === 0 && <text key={"e" + i} x={r.xCentro(i)} y={H - r.m.aba + 16} fontSize={11} fill={TINTA.suave}
        textAnchor="middle" fontFamily={FUENTE}>{recortar(e, 12)}</text>)}
      {r.barras.map((b, j) => <path key={"b" + j} fill={col(b.serie)}
        d={b.positivo
          ? `M${b.x},${b.y + b.h} V${b.y + Math.min(4, b.h)} Q${b.x},${b.y} ${b.x + Math.min(4, b.w / 2)},${b.y} H${b.x + b.w - Math.min(4, b.w / 2)} Q${b.x + b.w},${b.y} ${b.x + b.w},${b.y + Math.min(4, b.h)} V${b.y + b.h} Z`
          : `M${b.x},${b.y} V${b.y + b.h - Math.min(4, b.h)} Q${b.x},${b.y + b.h} ${b.x + Math.min(4, b.w / 2)},${b.y + b.h} H${b.x + b.w - Math.min(4, b.w / 2)} Q${b.x + b.w},${b.y + b.h} ${b.x + b.w},${b.y + b.h - Math.min(4, b.h)} V${b.y} Z`}
        onMouseMove={() => setHover({ x: Math.min(W - 180, b.x), y: Math.max(4, b.y - 26), texto: `${g.etiquetas[b.i]} · ${g.series[b.serie].nombre}: ${fmtNum(b.valor, unidad)}` })}
        onMouseLeave={() => setHover(null)}><title>{`${g.etiquetas[b.i]} · ${g.series[b.serie].nombre}: ${fmtNum(b.valor, unidad)}`}</title></path>)}
      {r.lineas.map((l) => <g key={"l" + l.serie}>
        <polyline fill="none" stroke={col(l.serie)} strokeWidth={2} strokeLinejoin="round" points={l.puntos.map((p) => `${p.x},${p.y}`).join(" ")} />
        {l.puntos.length <= 40 && l.puntos.map((p) => <circle key={p.i} cx={p.x} cy={p.y} r={4} fill={col(l.serie)} stroke={TINTA.fondo} strokeWidth={2} />)}
      </g>)}
      {g.tipo === "lineas" && g.etiquetas.map((e, i) => <rect key={"h" + i} x={r.xCentro(i) - r.banda / 2} y={r.m.arr} width={r.banda} height={r.h} fill="transparent"
        onMouseMove={() => setHover({ x: Math.min(W - 200, r.xCentro(i) + 8), y: r.m.arr, i, texto: `${e}: ` + g.series.map((s) => `${s.nombre} ${fmtNum(s.valores[i], unidad)}`).join(" · ") })}
        onMouseLeave={() => setHover(null)}><title>{`${e}: ` + g.series.map((s) => `${s.nombre} ${fmtNum(s.valores[i], unidad)}`).join(" · ")}</title></rect>)}
      {g.tipo === "lineas" && hover && hover.i !== undefined && <line x1={r.xCentro(hover.i)} x2={r.xCentro(hover.i)} y1={r.m.arr} y2={r.m.arr + r.h} stroke={TINTA.eje} strokeWidth={1} pointerEvents="none" />}
    </>;
  }
  return <figure className="inf-grafico">
    {g.titulo && <figcaption>{g.titulo}{g.unidad ? <span className="muted"> ({g.unidad})</span> : null}</figcaption>}
    <div className="inf-grafico__lienzo">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={g.titulo || "Gráfico"} style={{ maxWidth: "100%", height: "auto" }}>
        <rect width={W} height={H} fill={TINTA.fondo} />
        {cuerpo}
      </svg>
      {hover && <div className="inf-tip" style={{ left: `${(hover.x / W) * 100}%`, top: hover.y }}>{hover.texto}</div>}
    </div>
    {leyenda && <Leyenda items={leyenda} />}
  </figure>;
}

function Tabla({ s }) {
  return <div className="inf-tabla">
    {s.titulo && <div className="inf-tabla__t">{s.titulo}</div>}
    <div className="tbl-wrap"><table className="tbl"><thead><tr>{s.columnas.map((c, j) => <th key={j} style={columnaNumerica(s.filas, j) ? { textAlign: "right" } : null}>{c}</th>)}</tr></thead>
      <tbody>{s.filas.map((f, i) => <tr key={i}>{f.map((c, j) => <td key={j} className={typeof c === "number" ? "mono" : ""} style={columnaNumerica(s.filas, j) ? { textAlign: "right" } : null}>{celda(c)}</td>)}</tr>)}</tbody></table></div>
  </div>;
}

/* ---------------- Guardar en documentos ---------------- */
async function yoAdmin() {
  const { data } = await Auth.client.auth.getSession();
  const uid = data && data.session && data.session.user && data.session.user.id;
  return (CRM.USERS || []).find((u) => u.auth_user_id === uid) || null;
}
function ModalGuardarDoc({ informe, pdf, onClose, onNav }) {
  const [empresaId, setEmpresaId] = useState(informe.empresa_id && CRM.empresaById[informe.empresa_id] ? informe.empresa_id : "");
  const [filtro, setFiltro] = useState("");
  const [carpetas, setCarpetas] = useState(null);
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hecho, setHecho] = useState(false);
  useEffect(() => {
    if (!empresaId) { setCarpetas(null); return; }
    let vivo = true;
    CRM.loadCarpetasEmpresa(Auth.client, empresaId).then((cs) => {
      if (!vivo) return;
      const ops = CRM.carpetaOpciones(cs.filter((k) => !k.is_cliente));
      setCarpetas(ops); setFolderId(ops[0] ? ops[0].id : "");
    }).catch((e) => vivo && setErr(errorTexto(e)));
    return () => { vivo = false; };
  }, [empresaId]);
  const empresas = (CRM.EMPRESAS || []).filter((e) => !filtro || (e.razon_social || "").toLowerCase().includes(filtro.toLowerCase())).slice(0, 50);
  const guardar = async () => {
    setBusy(true); setErr("");
    try {
      const { blob, nombre } = await pdf();
      const file = new File([blob], nombre, { type: "application/pdf" });
      const yo = await yoAdmin();
      await CRM.subirDocumentoManual(Auth.client, { file, empresaId, folderId, uploadedBy: yo ? yo.id : null, visible: false });
      setHecho(true);
    } catch (e) { setErr("No se pudo guardar: " + (CRM.docErrorMessage ? CRM.docErrorMessage(e) : errorTexto(e))); }
    setBusy(false);
  };
  return <Modal title="Guardar el PDF en documentos" onClose={() => !busy && onClose()} footer={hecho
    ? <><button className="btn btn--ghost" onClick={onClose}>Cerrar</button><button className="btn btn--primary" onClick={() => { onClose(); onNav({ name: "empresa", id: empresaId }); }}>Abrir la empresa</button></>
    : <><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--primary" onClick={guardar} disabled={busy || !empresaId || !folderId}>{busy ? "Guardando…" : "Guardar"}</button></>}>
    {hecho ? <p>Guardado en los documentos de <b>{(CRM.empresaById[empresaId] || {}).razon_social}</b>. No se comparte con el cliente.</p> : <>
      <Field label="Empresa">
        {informe.empresa_id && empresaId === informe.empresa_id
          ? <div><b>{(CRM.empresaById[empresaId] || {}).razon_social}</b> <button className="btn btn--sm btn--ghost" onClick={() => setEmpresaId("")}>Otra</button></div>
          : <><input className="inp" placeholder="Buscar empresa…" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
            <select className="inp" style={{ marginTop: 6 }} value={empresaId} onChange={(e) => setEmpresaId(e.target.value)}>
              <option value="">Elige una empresa</option>{empresas.map((e) => <option key={e.id} value={e.id}>{e.razon_social}</option>)}</select></>}
      </Field>
      {empresaId && <Field label="Carpeta">
        {carpetas === null ? <span className="muted">Cargando…</span>
          : <select className="inp" value={folderId} onChange={(e) => setFolderId(e.target.value)}>{carpetas.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>}
      </Field>}
      <p className="muted" style={{ fontSize: 12.5 }}>Se guarda el PDF tal como se descarga, con las cifras de hoy. No se comparte con el cliente.</p>
      {err && <p style={{ color: "var(--danger)", fontSize: 12.5 }}>{err}</p>}
    </>}
  </Modal>;
}

/* ---------------- Tarjeta ---------------- */
export function TarjetaInforme({ informe, peticion, onNav }) {
  const refs = useRef([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [modalDoc, setModalDoc] = useState(false);
  const [guardar, setGuardar] = useState(null);   // título mientras se guarda el informe
  const pdf = async () => {
    const { generarPdf } = await import("./informe-pdf.js");
    return generarPdf(informe, refs.current.filter(Boolean));
  };
  const descargar = async () => {
    setBusy("pdf"); setMsg("");
    try {
      const { blob, nombre } = await pdf();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { setMsg("No se pudo generar el PDF: " + errorTexto(e)); }
    setBusy("");
  };
  const guardarInforme = async () => {
    setBusy("guardar"); setMsg("");
    const { error } = await Auth.client.from("agente_informes").insert({ titulo: guardar.trim() || informe.titulo, peticion, empresa_id: informe.empresa_id || null });
    if (error) setMsg("No se pudo guardar: " + errorTexto(error));
    else { setMsg("Guardado en «Informes guardados»: desde ahí se vuelve a hacer con los datos del momento."); setGuardar(null); window.dispatchEvent(new Event("agente:informes")); }
    setBusy("");
  };
  let g = 0;
  return <div className="ag-card ag-card--informe">
    <div className="ag-card__cab"><b>{informe.titulo}</b><span className="ag-card__estado">Informe</span></div>
    <div className="inf-fuente">Fuente: {informe.fuente}</div>
    {informe.secciones.map((s, i) => {
      if (s.tipo === "texto") return <div key={i} className="inf-texto">{s.texto.split(/\n{2,}/).map((p, k) => <p key={k}>{p}</p>)}</div>;
      if (s.tipo === "tabla") return <Tabla key={i} s={s} />;
      const n = g++;
      return <Grafico key={i} g={s.grafico} svgRef={(el) => { refs.current[n] = el; }} />;
    })}
    {msg && <div className={"ag-aviso" + (/^No se pudo/.test(msg) ? " ag-aviso--err" : "")} role="status">{msg}</div>}
    {guardar !== null && <div className="ag-card__acc">
      <input className="inp" style={{ flex: 1, minWidth: 180 }} maxLength={200} value={guardar} onChange={(e) => setGuardar(e.target.value)} aria-label="Título del informe guardado" />
      <button className="btn btn--sm btn--primary" disabled={busy !== ""} onClick={guardarInforme}>Guardar</button>
      <button className="btn btn--sm btn--ghost" onClick={() => setGuardar(null)}>Cancelar</button>
    </div>}
    <div className="ag-card__acc">
      <button className="btn btn--sm btn--primary" disabled={busy !== ""} onClick={descargar}>{busy === "pdf" ? "Generando…" : "Descargar PDF"}</button>
      <button className="btn btn--sm btn--ghost" disabled={busy !== ""} onClick={() => setModalDoc(true)}>Guardar en documentos</button>
      {guardar === null && <button className="btn btn--sm btn--ghost" disabled={busy !== "" || !peticion} title={peticion ? "Guarda la petición para volver a hacerlo con datos nuevos" : "No se encuentra la petición"}
        onClick={() => setGuardar(informe.titulo)}>Guardar informe</button>}
    </div>
    {modalDoc && <ModalGuardarDoc informe={informe} pdf={pdf} onClose={() => setModalDoc(false)} onNav={onNav} />}
  </div>;
}

/* ---------------- Informes guardados (lista de conversaciones) ---------------- */
export function InformesGuardados({ deshabilitado, onRegenerar }) {
  const [lista, setLista] = useState(null);
  const [abierto, setAbierto] = useState(false);
  const cargar = async () => {
    const { data: s } = await Auth.client.auth.getSession();
    const uid = s && s.session && s.session.user && s.session.user.id;
    const r = await Auth.client.from("agente_informes").select("id, titulo, peticion, empresa_id, created_at, ultimo_uso_at")
      .eq("auth_user_id", uid).order("created_at", { ascending: false }).limit(50);
    setLista(r.error ? [] : r.data || []);
  };
  useEffect(() => { cargar(); const f = () => cargar(); window.addEventListener("agente:informes", f); return () => window.removeEventListener("agente:informes", f); }, []);
  if (!lista || !lista.length) return null;
  const regenerar = async (x) => {
    await Auth.client.from("agente_informes").update({ ultimo_uso_at: new Date().toISOString() }).eq("id", x.id);
    onRegenerar(x.peticion);
  };
  const borrar = async (x) => {
    const { error } = await Auth.client.from("agente_informes").delete().eq("id", x.id);
    if (!error) setLista((l) => l.filter((y) => y.id !== x.id));
  };
  return <div className="inf-guardados">
    <button className="inf-guardados__t" onClick={() => setAbierto(!abierto)} aria-expanded={abierto}>
      Informes guardados ({lista.length}) <Icon name="chevronR" size={14} style={{ transform: abierto ? "rotate(90deg)" : "none" }} />
    </button>
    {abierto && lista.map((x) => <div key={x.id} className="inf-guardado">
      <div className="inf-guardado__t" title={x.peticion}>{x.titulo}</div>
      <div className="inf-guardado__acc">
        <button className="btn btn--sm btn--ghost" disabled={deshabilitado} onClick={() => regenerar(x)} title="Lo vuelve a hacer con los datos de ahora, en una conversación nueva">Regenerar</button>
        <button className="btn btn--sm btn--ghost" onClick={() => borrar(x)} title="Quitar de la lista" aria-label={"Quitar " + x.titulo}><Icon name="x" size={13} /></button>
      </div>
    </div>)}
  </div>;
}
