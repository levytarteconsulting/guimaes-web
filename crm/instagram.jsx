import React from "react";
import {
  anadirAviso, bytesTexto, contarHashtags, contarMenciones, csvMetricas, fmtMadrid, madridDia,
  madridInput, madridPartes, MAX_CAPTION, MAX_HASHTAGS, MAX_MENCIONES, mesCalendario, mesSiguiente,
  METRICAS, proporcion, textoAUtc, tieneAviso,
} from "./instagram-util.js";
/* GUIMAES CRM — Sección Instagram: calendario, listas, edición, aprobación,
   publicación, conexión, métricas y espacio ocupado.
   Esquema y reglas: crm/supabase-instagram.sql (las reglas de verdad las
   aplica la base de datos; aquí solo se ocultan los botones que no tocan).
   Función: crm/supabase-functions/instagram/. Fechas en hora de Madrid. */
const { useState: iState, useEffect: iEffect, useMemo: iMemo, useRef: iRef } = React;

const BUCKET = "instagram-media";
const CUOTA_STORAGE = 1073741824; // plan free: 1 GB compartido con los documentos
const ESTADOS = {
  borrador:   { label: "Borrador",    color: "#6E8298" },
  aprobada:   { label: "Aprobada",    color: "#1F6FEB" },
  publicando: { label: "Publicando",  color: "#D98A1E" },
  publicada:  { label: "Publicada",   color: "#1F9D6B" },
  error:      { label: "Error",       color: "#DC3A47" },
  cancelada:  { label: "Cancelada",   color: "#9AA9B8" },
};
const DIAS = ["L", "M", "X", "J", "V", "S", "D"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// ---------------------------------------------------------------- datos
export const IG = {
  async cargar() {
    const { data, error } = await Auth.client.from("instagram_posts")
      .select("*, slides:instagram_post_slides(id, position, storage_path, width, height)")
      .order("scheduled_for", { ascending: true, nullsFirst: false });
    if (error) throw error;
    for (const p of data) p.slides.sort((a, b) => a.position - b.position);
    return data;
  },
  url(path) { return Auth.client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl; },
  async actualizar(id, cambios) {
    const { data, error } = await Auth.client.from("instagram_posts").update(cambios).eq("id", id).select("*").single();
    if (error) throw error;
    return data;
  },
  async eliminar(post) {
    const { error } = await Auth.client.from("instagram_posts").delete().eq("id", post.id);
    if (error) throw error;
    const rutas = (post.slides || []).map((s) => s.storage_path);
    if (rutas.length) {
      const { error: e2 } = await Auth.client.storage.from(BUCKET).remove(rutas);
      if (e2) return { ficherosError: e2.message };
    }
    return {};
  },
  async revisar(caption, fecha, postId) {
    const { data, error } = await Auth.client.rpc("instagram_revisar", { p_caption: caption, p_scheduled_for: fecha, p_post_id: postId });
    if (error) throw error;
    return data || [];
  },
  async espacio() {
    const { data, error } = await Auth.client.rpc("instagram_espacio");
    if (error) throw error;
    return (data && data[0]) || null;
  },
  async funcion(body) {
    const res = await Auth.client.functions.invoke("instagram", { body });
    if (res.error) {
      let msg = res.error.message || "Error al llamar a la función instagram";
      try {
        const ctx = res.error.context;
        if (ctx && typeof ctx.json === "function") { const j = await ctx.json(); if (j && j.error) msg = j.error; }
      } catch (e) { /* sin cuerpo JSON */ }
      throw new Error(msg);
    }
    return res.data;
  },
};

const errTexto = (e) => (e && (e.message || e.details)) || String(e);
const fechaDe = (p) => (p.status === "publicada" ? p.published_at || p.scheduled_for : p.scheduled_for);
const esAdmin = (user) => user && user.role === "admin";

function EstadoBadge({ status }) {
  const e = ESTADOS[status] || { label: status, color: "#6E8298" };
  return <Badge label={e.label} color={e.color} />;
}

function Miniatura({ post, size = 44 }) {
  const s = post.slides && post.slides[0];
  const st = { width: size, height: size, borderRadius: 8, objectFit: "cover", background: "var(--mist-2)", flex: "none" };
  if (!s) return <div style={{ ...st, display: "grid", placeItems: "center", color: "var(--muted)" }}><Icon name="instagram" size={Math.round(size / 2.4)} /></div>;
  return <div style={{ position: "relative", flex: "none" }}>
    <img src={IG.url(s.storage_path)} alt="" loading="lazy" style={st} />
    {post.slides.length > 1 && <span className="ig-thumb__n">{post.slides.length}</span>}
  </div>;
}

// ---------------------------------------------------------------- sección
export function Instagram({ user, toast }) {
  const [posts, setPosts] = iState(null);
  const [loadErr, setLoadErr] = iState(null);
  const [tab, setTab] = iState("calendario");
  const ahora = madridPartes(new Date());
  const [mes, setMes] = iState({ y: ahora.y, m: ahora.m });
  const [editId, setEditId] = iState(null);
  const [conexion, setConexion] = iState(null);
  const [ocupado, setOcupado] = iState("");
  const [espacio, setEspacio] = iState(null);
  const admin = esAdmin(user);

  const reload = async () => {
    try { setPosts(await IG.cargar()); setLoadErr(null); }
    catch (e) { setLoadErr(errTexto(e)); }
    try { setEspacio(await IG.espacio()); } catch (e) { /* no imprescindible */ }
  };
  iEffect(() => { reload(); }, []);
  // Mientras algo se está publicando, se refresca solo.
  const publicando = (posts || []).some((p) => p.status === "publicando");
  iEffect(() => {
    if (!publicando) return;
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [publicando]);

  const comprobar = async () => {
    setOcupado("comprobar");
    try { setConexion(await IG.funcion({ accion: "comprobar" })); }
    catch (e) { setConexion({ ok: false, problemas: [errTexto(e)], avisos: [] }); }
    finally { setOcupado(""); }
  };
  const metricas = async () => {
    setOcupado("metricas");
    try {
      const r = await IG.funcion({ accion: "metricas" });
      toast(r.piezas ? `Métricas actualizadas: ${r.piezas} pieza${r.piezas === 1 ? "" : "s"}${r.parciales ? ` (${r.parciales} con métricas incompletas)` : ""}` : "No hay publicaciones de los últimos 90 días");
      await reload();
    } catch (e) { toast("No se pudieron actualizar las métricas: " + errTexto(e)); }
    finally { setOcupado(""); }
  };
  const publicadas = (posts || []).filter((p) => p.status === "publicada")
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
  const exportar = () => {
    const blob = new Blob([csvMetricas(publicadas)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `instagram-metricas-${madridDia(new Date())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const proximas = (posts || []).filter((p) => ["borrador", "aprobada", "publicando", "error"].includes(p.status));
  const canceladas = (posts || []).filter((p) => p.status === "cancelada");
  const editando = editId && (posts || []).find((p) => p.id === editId);

  return <div className="content">
    <div className="toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
      <button className="btn btn--sm btn--ghost" onClick={comprobar} disabled={!!ocupado}><Icon name="shield" size={14} />{ocupado === "comprobar" ? "Comprobando…" : "Comprobar conexión"}</button>
      {admin && <button className="btn btn--sm btn--ghost" onClick={metricas} disabled={!!ocupado}><Icon name="trend" size={14} />{ocupado === "metricas" ? "Actualizando…" : "Actualizar métricas"}</button>}
      <button className="btn btn--sm btn--ghost" onClick={exportar} disabled={!publicadas.length}><Icon name="download" size={14} />Exportar métricas (CSV)</button>
      <button className="btn btn--sm btn--ghost" onClick={reload} title="Recargar"><Icon name="refresh" size={14} /></button>
      <div className="toolbar__spacer" />
      <EspacioOcupado espacio={espacio} />
    </div>

    {conexion && <ConexionCard r={conexion} onClose={() => setConexion(null)} />}

    <Tabs active={tab} onChange={setTab} tabs={[
      { id: "calendario", label: "Calendario" },
      { id: "proximas", label: "Próximas", n: proximas.length },
      { id: "publicadas", label: "Publicadas", n: publicadas.length },
      { id: "canceladas", label: "Canceladas", n: canceladas.length },
    ]} />

    {loadErr ? <div className="card"><div className="card__body"><Empty icon="instagram" title="No se pudieron cargar las publicaciones" sub={loadErr} action={<button className="btn btn--sm btn--primary" onClick={reload}><Icon name="refresh" size={14} />Reintentar</button>} /></div></div>
      : !posts ? <div className="muted" style={{ padding: 16 }}>Cargando…</div>
      : tab === "calendario" ? <Calendario posts={posts.filter((p) => p.status !== "cancelada")} mes={mes} setMes={setMes} onOpen={setEditId} />
      : tab === "proximas" ? <Lista posts={proximas} vacio="No hay publicaciones pendientes" sub="Las piezas que subas aparecerán aquí como borradores." onOpen={setEditId} />
      : tab === "publicadas" ? <ListaPublicadas posts={publicadas} onOpen={setEditId} />
      : <Lista posts={canceladas} vacio="No hay publicaciones canceladas" onOpen={setEditId} />}

    {editando && <PiezaEditor key={editando.id + editando.updated_at} post={editando} user={user} toast={toast}
      onClose={() => setEditId(null)} onChanged={reload} onDeleted={() => { setEditId(null); reload(); }} />}
  </div>;
}

function EspacioOcupado({ espacio }) {
  if (!espacio) return null;
  const total = Number(espacio.total_bytes) || 0;
  const ig = Number(espacio.instagram_bytes) || 0;
  const pct = Math.min(100, (total / CUOTA_STORAGE) * 100);
  const color = pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--warn)" : "var(--accent)";
  return <div className="ig-espacio" title={`Instagram: ${bytesTexto(ig)} en ${espacio.instagram_objetos} ficheros. Storage total (documentos de clientes incluidos): ${bytesTexto(total)} de 1 GB.`}>
    <div className="ig-espacio__txt">Instagram <b>{bytesTexto(ig)}</b> · Storage <b>{bytesTexto(total)}</b> de 1 GB</div>
    <div className="bar"><div className="bar__fill" style={{ width: pct + "%", background: color }} /></div>
  </div>;
}

function ConexionCard({ r, onClose }) {
  return <div className={r.ok ? "ig-conexion ig-conexion--ok" : "warn-box ig-conexion"}>
    <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
      <div>
        {r.ok ? <div><b>Conectado a @{r.cuenta?.usuario}</b>{r.cuenta?.seguidores != null && <> · {r.cuenta.seguidores} seguidores</>}{r.cupo?.total != null && <> · cupo de publicación: {r.cupo.usado} de {r.cupo.total} en {r.cupo.horas || 24} h</>}</div>
          : <div><b>La conexión con Instagram no está lista</b></div>}
        {(r.problemas || []).length > 0 && <ul className="ig-lista-err">{r.problemas.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        {(r.avisos || []).length > 0 && <ul className="ig-lista-aviso">{r.avisos.map((p, i) => <li key={i}>{p}</li>)}</ul>}
        {r.pagina && !Array.isArray(r.pagina) && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Página «{r.pagina.nombre}»{r.token?.nombre ? ` · usuario del sistema «${r.token.nombre}»` : ""}</div>}
      </div>
      <button className="modal__x" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={16} /></button>
    </div>
  </div>;
}

// ---------------------------------------------------------------- calendario
function Calendario({ posts, mes, setMes, onOpen }) {
  const porDia = iMemo(() => {
    const m = {};
    for (const p of posts) {
      const f = fechaDe(p);
      if (!f) continue;
      (m[madridDia(f)] = m[madridDia(f)] || []).push(p);
    }
    for (const k in m) m[k].sort((a, b) => String(fechaDe(a)).localeCompare(String(fechaDe(b))));
    return m;
  }, [posts]);
  const hoy = madridDia(new Date());
  const sinFecha = posts.filter((p) => !fechaDe(p));
  return <div className="card">
    <div className="card__head" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button className="btn btn--sm btn--ghost btn--icon" onClick={() => setMes(mesSiguiente(mes, -1))} aria-label="Mes anterior"><Icon name="up" size={14} style={{ transform: "rotate(-90deg)" }} /></button>
      <h3 style={{ minWidth: 150, textAlign: "center", textTransform: "capitalize" }}>{MESES[mes.m - 1]} {mes.y}</h3>
      <button className="btn btn--sm btn--ghost btn--icon" onClick={() => setMes(mesSiguiente(mes, 1))} aria-label="Mes siguiente"><Icon name="up" size={14} style={{ transform: "rotate(90deg)" }} /></button>
      <button className="btn btn--sm btn--subtle" onClick={() => { const a = madridPartes(new Date()); setMes({ y: a.y, m: a.m }); }}>Hoy</button>
      <span className="muted" style={{ fontSize: 12.5, marginLeft: "auto" }}>Hora de Madrid</span>
    </div>
    <div className="ig-cal">
      {DIAS.map((d) => <div key={d} className="ig-cal__dow">{d}</div>)}
      {mesCalendario(mes.y, mes.m).flat().map((dia) => <div key={dia.key} className={"ig-cal__day" + (dia.enMes ? "" : " ig-cal__day--fuera") + (dia.key === hoy ? " ig-cal__day--hoy" : "")}>
        <div className="ig-cal__num">{dia.d}</div>
        {(porDia[dia.key] || []).map((p) => <button key={p.id} className="ig-cal__item" onClick={() => onOpen(p.id)} title={`${p.titulo || "Sin título"} · ${ESTADOS[p.status]?.label || p.status}`} style={{ borderLeftColor: ESTADOS[p.status]?.color }}>
          <Miniatura post={p} size={30} />
          <span className="ig-cal__hora">{fmtMadrid(fechaDe(p), { timeStyle: "short" })}</span>
        </button>)}
      </div>)}
    </div>
    {sinFecha.length > 0 && <div className="card__body muted" style={{ fontSize: 13 }}>{sinFecha.length} pieza{sinFecha.length === 1 ? "" : "s"} sin fecha: están en «Próximas».</div>}
  </div>;
}

// ---------------------------------------------------------------- listas
function Lista({ posts, vacio, sub, onOpen }) {
  if (!posts.length) return <div className="card"><div className="card__body"><Empty icon="instagram" title={vacio} sub={sub} /></div></div>;
  return <div className="card">{posts.map((p) => <div key={p.id} className="lrow" style={{ cursor: "pointer" }} onClick={() => onOpen(p.id)}>
    <Miniatura post={p} />
    <div className="lrow__main">
      <div className="lrow__title" style={{ overflowWrap: "anywhere" }}>{p.titulo || "Sin título"}</div>
      <div className="lrow__sub">{[p.scheduled_for ? fmtMadrid(p.scheduled_for) : "Sin fecha", p.slides.length === 1 ? "imagen" : `carrusel de ${p.slides.length}`, p.lote].filter(Boolean).join(" · ")}</div>
      {p.status === "error" && p.error && <div style={{ color: "var(--danger)", fontSize: 12.5, marginTop: 2 }}>{p.error}</div>}
    </div>
    <EstadoBadge status={p.status} />
  </div>)}</div>;
}

function ListaPublicadas({ posts, onOpen }) {
  if (!posts.length) return <div className="card"><div className="card__body"><Empty icon="instagram" title="Todavía no hay publicaciones" sub="Las piezas aprobadas se publican solas a su hora." /></div></div>;
  const v = (p, k) => (typeof p.metrics?.[k] === "number" ? p.metrics[k].toLocaleString("es-ES") : "—");
  return <div className="tbl-wrap"><table className="tbl"><thead><tr><th></th><th>Pieza</th><th>Publicada</th>{METRICAS.map(([k, n]) => <th key={k} className="right">{n}</th>)}<th></th></tr></thead><tbody>
    {posts.map((p) => <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => onOpen(p.id)}>
      <td><Miniatura post={p} size={36} /></td>
      <td className="tbl__name" style={{ overflowWrap: "anywhere" }}>{p.titulo || "Sin título"}</td>
      <td className="tbl__sub">{fmtMadrid(p.published_at)}</td>
      {METRICAS.map(([k]) => <td key={k} className="right mono">{v(p, k)}</td>)}
      <td onClick={(e) => e.stopPropagation()}>{p.permalink && <a className="btn btn--sm btn--ghost btn--icon" href={p.permalink} target="_blank" rel="noopener noreferrer" title="Ver en Instagram"><Icon name="external" size={14} /></a>}</td>
    </tr>)}
  </tbody></table>
    {posts.some((p) => p.metrics_at) && <div className="muted" style={{ fontSize: 12.5, padding: "8px 12px" }}>Métricas actualizadas a diario (05:15 UTC) para las publicaciones de los últimos 90 días.</div>}
  </div>;
}

// ---------------------------------------------------------------- edición
function PiezaEditor({ post, user, toast, onClose, onChanged, onDeleted }) {
  const admin = esAdmin(user);
  const [titulo, setTitulo] = iState(post.titulo || "");
  const [caption, setCaption] = iState(post.caption || "");
  const [fecha, setFecha] = iState(madridInput(post.scheduled_for));
  const [revision, setRevision] = iState(null);
  const [busy, setBusy] = iState(false);
  const [err, setErr] = iState(null);
  const [dialogo, setDialogo] = iState(null); // "aprobar" | "publicar" | "cancelar" | "eliminar"
  const editable = ["borrador", "aprobada", "cancelada"].includes(post.status);
  const fechaIso = fecha ? textoAUtc(fecha) : null;
  const dirty = titulo !== (post.titulo || "") || caption !== (post.caption || "") || (fechaIso || null) !== (post.scheduled_for ? new Date(post.scheduled_for).toISOString() : null);
  const desaprueba = post.status === "aprobada" && (caption !== (post.caption || "") || (fechaIso || null) !== (post.scheduled_for ? new Date(post.scheduled_for).toISOString() : null));

  // Revisión en directo (la misma función que aplica la base de datos al aprobar).
  const seq = iRef(0);
  iEffect(() => {
    if (!editable && post.status !== "error") { setRevision(null); return; }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try { const r = await IG.revisar(caption, fechaIso, post.id); if (n === seq.current) setRevision(r); }
      catch (e) { if (n === seq.current) setRevision([{ nivel: "error", codigo: "revision", mensaje: "No se pudo revisar el texto: " + errTexto(e) }]); }
    }, 400);
    return () => clearTimeout(t);
  }, [caption, fechaIso]);
  const errores = (revision || []).filter((r) => r.nivel === "error");
  const avisos = (revision || []).filter((r) => r.nivel === "aviso");

  const hacer = async (fn, ok) => {
    setBusy(true); setErr(null);
    try { await fn(); if (ok) toast(ok); setDialogo(null); await onChanged(); }
    catch (e) { setErr(errTexto(e)); setDialogo(null); }
    finally { setBusy(false); }
  };
  const cambios = () => ({ titulo, caption, scheduled_for: fechaIso });
  const guardar = () => hacer(() => IG.actualizar(post.id, cambios()), desaprueba ? "Guardado: ha vuelto a borrador" : "Guardado");
  const aprobar = () => hacer(() => IG.actualizar(post.id, { ...cambios(), status: "aprobada" }), "Aprobada");
  const aBorrador = () => hacer(() => IG.actualizar(post.id, { status: "borrador" }), "Ha vuelto a borrador");
  const cancelar = () => hacer(() => IG.actualizar(post.id, { status: "cancelada" }), "Cancelada");
  const publicarAhora = () => hacer(async () => {
    const r = await IG.funcion({ accion: "publicar_ahora", post_id: post.id });
    if (!r.ok) throw new Error(r.error || "No se ha publicado");
  }, "Publicada en Instagram");
  const eliminar = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await IG.eliminar(post);
      toast(r.ficherosError ? "Eliminada (no se pudieron borrar las imágenes: " + r.ficherosError + ")" : "Eliminada");
      onDeleted();
    } catch (e) { setErr(errTexto(e)); setDialogo(null); }
    finally { setBusy(false); }
  };

  const n = caption.length, nh = contarHashtags(caption), nm = contarMenciones(caption);
  const btns = [];
  if (editable) btns.push(<button key="g" className="btn btn--sm btn--ghost" onClick={guardar} disabled={busy || !dirty || (fecha && !fechaIso)}>Guardar</button>);
  if (post.status === "borrador" && admin) btns.push(<button key="a" className="btn btn--sm btn--primary" onClick={() => setDialogo("aprobar")} disabled={busy}><Icon name="check" size={14} />Aprobar</button>);
  if (["aprobada", "error", "cancelada"].includes(post.status)) btns.push(<button key="b" className="btn btn--sm btn--ghost" onClick={aBorrador} disabled={busy}>Volver a borrador</button>);
  if (post.status === "aprobada" && admin) btns.push(<button key="p" className="btn btn--sm btn--primary" onClick={() => setDialogo("publicar")} disabled={busy || dirty} title={dirty ? "Guarda los cambios antes" : ""}><Icon name="send" size={14} />Publicar ahora</button>);
  if (["borrador", "error"].includes(post.status) || (post.status === "aprobada" && admin)) btns.push(<button key="c" className="btn btn--sm btn--ghost" onClick={() => setDialogo("cancelar")} disabled={busy}>Cancelar publicación</button>);
  if (["borrador", "cancelada"].includes(post.status)) btns.push(<button key="e" className="btn btn--sm btn--danger" onClick={() => setDialogo("eliminar")} disabled={busy}><Icon name="trash" size={14} />Eliminar</button>);

  return <Modal wide title={<span className="row" style={{ gap: 10, alignItems: "center" }}>{post.titulo || "Sin título"} <EstadoBadge status={post.status} /></span>} onClose={onClose}
    footer={btns.length ? <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end", width: "100%" }}>{btns}</div> : null}>
    <Laminas post={post} />

    {post.status === "error" && post.error && <div className="warn-box ig-err-box"><b>Error al publicar.</b> {post.error}<div style={{ marginTop: 4 }}>Para corregirla, vuelve a borrador.</div></div>}
    {post.status === "publicando" && <div className="warn-box">Se está publicando ahora mismo. Esta ventana se actualiza sola.</div>}
    {post.status === "publicada" && <div className="ig-conexion ig-conexion--ok">
      Publicada el {fmtMadrid(post.published_at)}{post.permalink && <> · <a href={post.permalink} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>ver en Instagram</a></>}
      {post.metrics && <div className="ig-metricas">{METRICAS.map(([k, nombre]) => <div key={k}><div className="muted">{nombre}</div><b className="mono">{typeof post.metrics[k] === "number" ? post.metrics[k].toLocaleString("es-ES") : "—"}</b></div>)}</div>}
      {post.metrics_at && <div className="muted" style={{ fontSize: 12 }}>Métricas del {fmtMadrid(post.metrics_at)}</div>}
    </div>}

    <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
      <Field label="Título (interno, no se publica)"><input className="inp" value={titulo} onChange={(e) => setTitulo(e.target.value)} disabled={!editable || busy} /></Field>
      <Field label="Fecha y hora de publicación (Madrid)">
        <input className="inp" type="datetime-local" value={fecha} onChange={(e) => setFecha(e.target.value)} disabled={!editable || busy} />
      </Field>
    </div>
    <Field label="Texto">
      <textarea className="inp" rows={9} value={caption} onChange={(e) => setCaption(e.target.value)} disabled={!editable || busy} style={{ resize: "vertical", minHeight: 160 }} />
    </Field>
    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: -4 }}>
      <div className="muted mono" style={{ fontSize: 12.5 }}>
        <span style={{ color: n > MAX_CAPTION ? "var(--danger)" : undefined }}>{n.toLocaleString("es-ES")} / {MAX_CAPTION.toLocaleString("es-ES")} caracteres</span>
        {" · "}<span style={{ color: nh > MAX_HASHTAGS ? "var(--danger)" : undefined }}>{nh} / {MAX_HASHTAGS} hashtags</span>
        {" · "}<span style={{ color: nm > MAX_MENCIONES ? "var(--danger)" : undefined }}>{nm} / {MAX_MENCIONES} menciones</span>
      </div>
      {editable && <button className="btn btn--sm btn--subtle" onClick={() => setCaption(anadirAviso(caption))} disabled={busy || tieneAviso(caption)}>{tieneAviso(caption) ? "Aviso legal incluido" : "Añadir aviso"}</button>}
    </div>

    {revision && (errores.length > 0 || avisos.length > 0) && <div className="ig-rev">
      {errores.length > 0 && <><div className="ig-rev__t">Impide aprobar</div><ul className="ig-lista-err">{errores.map((r, i) => <li key={i}>{r.mensaje}</li>)}</ul></>}
      {avisos.length > 0 && <><div className="ig-rev__t">Avisos</div><ul className="ig-lista-aviso">{avisos.map((r, i) => <li key={i}>{r.mensaje}</li>)}</ul></>}
    </div>}
    {revision && !errores.length && !avisos.length && editable && <div className="ig-rev ig-rev--ok"><Icon name="check" size={14} /> Cumple las reglas de contenido.</div>}
    {desaprueba && <div className="warn-box" style={{ marginTop: 10 }}>Al guardar, la pieza volverá a borrador y habrá que aprobarla de nuevo.</div>}
    {err && <div className="warn-box ig-err-box" style={{ marginTop: 10 }}>{err}</div>}
    {!admin && post.status === "borrador" && <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Aprobar, publicar ahora y cancelar una aprobada lo hace el rol admin.</div>}

    {dialogo === "aprobar" && <AprobarDialogo errores={errores} avisos={avisos} revisando={!revision} busy={busy} onClose={() => setDialogo(null)} onOk={aprobar} />}
    {dialogo === "publicar" && <Confirmar titulo="Publicar ahora" texto="Se publicará ahora mismo en Instagram, sin esperar a su fecha. Una vez publicada no se puede retirar desde el CRM." boton="Publicar ahora" busy={busy} onClose={() => setDialogo(null)} onOk={publicarAhora} />}
    {dialogo === "cancelar" && <Confirmar titulo="Cancelar publicación" texto="No se publicará. Podrás volver a ponerla en borrador más adelante." boton="Cancelar publicación" busy={busy} onClose={() => setDialogo(null)} onOk={cancelar} />}
    {dialogo === "eliminar" && <Confirmar titulo="Eliminar pieza" texto={`Se borran la pieza y sus ${post.slides.length} imagen${post.slides.length === 1 ? "" : "es"}. No se puede deshacer.`} boton="Eliminar" peligro busy={busy} onClose={() => setDialogo(null)} onOk={eliminar} />}
  </Modal>;
}

function Laminas({ post }) {
  const s = post.slides || [];
  if (!s.length) return <div className="warn-box ig-err-box">Esta pieza no tiene imágenes.</div>;
  return <div className="ig-slides">{s.map((l) => {
    const p = proporcion(l.width, l.height);
    return <a key={l.id} className="ig-slide" href={IG.url(l.storage_path)} target="_blank" rel="noopener noreferrer" title="Abrir la imagen">
      <img src={IG.url(l.storage_path)} alt={`Lámina ${l.position}`} loading="lazy" />
      <div className="ig-slide__meta"><span>{l.position}</span><span style={{ color: p.ok ? undefined : "var(--danger)" }}>{l.width}×{l.height} · {p.nombre}</span></div>
    </a>;
  })}</div>;
}

function AprobarDialogo({ errores, avisos, revisando, busy, onClose, onOk }) {
  const [fuentes, setFuentes] = iState(false);
  return <Modal title="Aprobar publicación" onClose={onClose} footer={<>
    <button className="btn btn--sm btn--ghost" onClick={onClose} disabled={busy}>Volver</button>
    <button className="btn btn--sm btn--primary" onClick={onOk} disabled={busy || revisando || errores.length > 0 || !fuentes}>{busy ? "Aprobando…" : "Aprobar"}</button>
  </>}>
    {revisando ? <p className="muted">Revisando el texto…</p>
      : errores.length > 0 ? <><p>No se puede aprobar todavía:</p><ul className="ig-lista-err">{errores.map((r, i) => <li key={i}>{r.mensaje}</li>)}</ul></>
      : <p>Se publicará sola en la fecha indicada. Si después cambias el texto, la fecha o las imágenes, volverá a borrador.</p>}
    {avisos.length > 0 && <ul className="ig-lista-aviso">{avisos.map((r, i) => <li key={i}>{r.mensaje}</li>)}</ul>}
    <label className="check-row" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
      <input type="checkbox" checked={fuentes} onChange={(e) => setFuentes(e.target.checked)} style={{ marginTop: 3 }} />
      <span>Las cifras de las láminas llevan su fuente</span>
    </label>
  </Modal>;
}

function Confirmar({ titulo, texto, boton, peligro, busy, onClose, onOk }) {
  return <Modal title={titulo} onClose={onClose} footer={<>
    <button className="btn btn--sm btn--ghost" onClick={onClose} disabled={busy}>Volver</button>
    <button className={"btn btn--sm " + (peligro ? "btn--danger" : "btn--primary")} onClick={onOk} disabled={busy}>{busy ? "Un momento…" : boton}</button>
  </>}><p>{texto}</p></Modal>;
}
