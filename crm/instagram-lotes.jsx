import React from "react";
import {
  agruparFicheros, anadirAviso, bytesTexto, contarHashtags, contarMenciones, fmtMadrid, leerTextosCsv,
  madridDia, madridPartes, MAX_CAPTION, MAX_HASHTAGS, MAX_MENCIONES, medidasFinales, proporcion,
  repartirFechas, tieneAviso,
} from "./instagram-util.js";
/* GUIMAES CRM — Subir un lote de piezas de Instagram.
   Se arrastran todas las imágenes (y, si se quiere, textos.csv):
     01.jpg            → imagen suelta
     02-1.jpg, 02-2.jpg… → carrusel (en el orden del número de lámina)
   PNG y WebP se convierten a JPG; todo se reduce a 1440 px de ancho como
   máximo, con calidad 0,85 (bajando hasta 0,6 si pasa de 1,5 MB).
   textos.csv (opcional): pieza;caption;fecha — UTF-8, «;», comillas dobles
   si el texto lleva saltos de línea o «;», fecha AAAA-MM-DD HH:MM (Madrid).
   Las piezas sin fecha se reparten por los días y la hora elegidos.
   Nada se crea hasta confirmar el resumen. Todo entra como borrador. */
const { useState: lState, useEffect: lEffect, useMemo: lMemo, useRef: lRef } = React;

const BUCKET = "instagram-media";
const OBJETIVO = 1.5 * 1048576;
const LIMITE_BUCKET = 8 * 1048576;
const DIAS = [["L", 0], ["M", 1], ["X", 2], ["J", 3], ["V", 4], ["S", 5], ["D", 6]];

async function procesarImagen(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new Error(`No se puede leer «${file.name}» como imagen.`); }
  const original = { w: bmp.width, h: bmp.height };
  const { w, h } = medidasFinales(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // fondo blanco para PNG con transparencia
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  let q = 0.85, blob;
  for (;;) {
    blob = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", q));
    if (!blob) throw new Error(`No se pudo convertir «${file.name}» a JPG.`);
    if (blob.size <= OBJETIVO || q <= 0.6) break;
    q = Math.round((q - 0.05) * 100) / 100;
  }
  return { nombre: file.name, blob, w, h, q, original, tamOriginal: file.size, url: URL.createObjectURL(blob) };
}

export function SubirLote({ posts, toast, onClose, onDone }) {
  const hoy = madridPartes(new Date());
  const manana = madridDia(new Date(Date.UTC(hoy.y, hoy.m - 1, hoy.d + 1, 12)));
  const [fase, setFase] = lState("elegir"); // elegir | analizando | resumen | subiendo | hecho
  const [progreso, setProgreso] = lState({ hechos: 0, total: 0, texto: "" });
  const [analisis, setAnalisis] = lState(null); // {piezas, ignorados, csv, csvNombre, imagenes: Map nombre→procesada}
  const [lote, setLote] = lState(`Lote ${madridDia(new Date())}`);
  const [desde, setDesde] = lState(manana);
  const [dias, setDias] = lState([0, 2, 4]);
  const [hora, setHora] = lState("10:00");
  const [resultado, setResultado] = lState(null);
  const [arrastrando, setArrastrando] = lState(false);
  const input = lRef(null);
  const urls = lRef([]);
  lEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const analizar = async (files) => {
    const lista = Array.from(files || []);
    const csvs = lista.filter((f) => /\.csv$/i.test(f.name));
    const imagenes = lista.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name));
    const otros = lista.filter((f) => !csvs.includes(f) && !imagenes.includes(f)).map((f) => f.name);
    if (!imagenes.length) { toast("No hay imágenes JPG, PNG o WebP en lo que has soltado."); return; }
    setFase("analizando");
    const grupos = agruparFicheros(imagenes.map((f) => f.name));
    let csv = null, csvNombre = null;
    const avisosGlobales = [];
    if (csvs.length > 1) avisosGlobales.push(`Hay ${csvs.length} ficheros CSV; se usa «${csvs[0].name}».`);
    if (csvs.length) {
      csvNombre = csvs[0].name;
      if (!/^textos\.csv$/i.test(csvNombre)) avisosGlobales.push(`El CSV se llama «${csvNombre}» (lo esperado es textos.csv); se usa igualmente.`);
      csv = leerTextosCsv(await csvs[0].text());
    }
    const porNombre = new Map(imagenes.map((f) => [f.name, f]));
    const necesarias = grupos.piezas.flatMap((p) => p.ficheros);
    const procesadas = new Map();
    setProgreso({ hechos: 0, total: necesarias.length, texto: "Preparando imágenes…" });
    for (let i = 0; i < necesarias.length; i++) {
      const nombre = necesarias[i];
      setProgreso({ hechos: i, total: necesarias.length, texto: `Preparando ${nombre}` });
      try {
        const r = await procesarImagen(porNombre.get(nombre));
        urls.current.push(r.url);
        procesadas.set(nombre, r);
      } catch (e) { procesadas.set(nombre, { nombre, error: e.message }); }
    }
    if (csv) {
      const claves = new Set(grupos.piezas.map((p) => p.clave));
      for (const [clave, fila] of csv.porPieza) if (!claves.has(clave)) avisosGlobales.push(`textos.csv, fila ${fila.linea}: la pieza ${fila.pieza} no tiene imágenes; se ignora.`);
    }
    setAnalisis({ grupos, csv, csvNombre, procesadas, avisosGlobales, ignorados: [...grupos.ignorados, ...otros] });
    setFase("resumen");
  };

  // Piezas con texto, fecha, láminas y avisos. Se recalcula al cambiar el reparto.
  const piezas = lMemo(() => {
    if (!analisis) return [];
    const { grupos, csv, procesadas } = analisis;
    const base = grupos.piezas.map((g) => {
      const errores = [...g.errores], avisos = [...g.avisos];
      const fila = csv ? csv.porPieza.get(g.clave) : null;
      if (fila && fila.errorFila) errores.push(fila.errorFila);
      const laminas = g.ficheros.map((n) => procesadas.get(n)).filter(Boolean);
      for (const l of laminas) {
        if (l.error) { errores.push(l.error); continue; }
        if (l.blob.size > LIMITE_BUCKET) errores.push(`«${l.nombre}» ocupa ${bytesTexto(l.blob.size)} después de comprimir (máximo 8 MB).`);
        else if (l.blob.size > OBJETIVO) avisos.push(`«${l.nombre}» ocupa ${bytesTexto(l.blob.size)} (objetivo: menos de 1,5 MB).`);
        const p = proporcion(l.w, l.h);
        if (!p.ok) avisos.push(`«${l.nombre}» es ${p.nombre} (${l.w}×${l.h}): fuera de 4:5–1,91:1. Instagram la rechazaría; no se podrá aprobar.`);
      }
      const ok = laminas.filter((l) => !l.error);
      if (ok.length > 1 && new Set(ok.map((l) => (l.w / l.h).toFixed(3))).size > 1) {
        avisos.push("Las láminas no tienen la misma proporción: Instagram recorta todas a la de la primera.");
      }
      let caption = fila ? fila.caption : "";
      let origenTexto = fila ? "textos.csv" : "sin texto";
      if (!fila && csv) avisos.push("No está en textos.csv: entra solo con el aviso legal.");
      if (!tieneAviso(caption)) { caption = anadirAviso(caption); if (fila) avisos.push("El texto no traía el aviso legal: se añade al final."); }
      if (caption.length > MAX_CAPTION) errores.push(`El texto tiene ${caption.length} caracteres con el aviso legal (máximo ${MAX_CAPTION}).`);
      if (contarHashtags(caption) > MAX_HASHTAGS) avisos.push(`Tiene ${contarHashtags(caption)} hashtags (máximo ${MAX_HASHTAGS}): no se podrá aprobar así.`);
      if (contarMenciones(caption) > MAX_MENCIONES) avisos.push(`Tiene ${contarMenciones(caption)} menciones (máximo ${MAX_MENCIONES}): no se podrá aprobar así.`);
      return { ...g, laminas: ok, caption, origenTexto, fecha: fila && fila.fecha ? fila.fecha : null, origenFecha: fila && fila.fecha ? "textos.csv" : "reparto", errores, avisos };
    });
    // Reparto de fechas: días ocupados por lo ya programado y por las fechas del CSV.
    const ocupados = new Set();
    for (const p of posts || []) if (p.status !== "cancelada" && p.scheduled_for) ocupados.add(madridDia(p.scheduled_for));
    for (const p of base) if (p.fecha) ocupados.add(madridDia(p.fecha));
    const sinFecha = base.filter((p) => !p.fecha && !p.errores.length);
    let fechas = [], errReparto = null;
    try { fechas = repartirFechas(sinFecha.length, { desde, dias, hora, ocupados }); } catch (e) { errReparto = e.message; }
    sinFecha.forEach((p, i) => { p.fecha = fechas[i] || null; });
    const ahora = new Date().toISOString();
    for (const p of base) {
      if (!p.errores.length && !p.fecha) p.errores.push(errReparto || "Sin fecha.");
      else if (p.fecha && p.fecha < ahora) p.avisos.push("La fecha ya ha pasado.");
    }
    return base;
  }, [analisis, desde, dias, hora, posts]);

  const validas = piezas.filter((p) => !p.errores.length);
  const csvRoto = analisis && analisis.csv && analisis.csv.errores.length > 0;

  const crear = async () => {
    setFase("subiendo");
    const loteId = crypto.randomUUID();
    const hechos = [], fallos = [];
    const total = validas.reduce((a, p) => a + p.laminas.length, 0);
    let subidas = 0;
    for (const p of validas) {
      const rutas = [];
      let postId = null;
      try {
        for (let i = 0; i < p.laminas.length; i++) {
          setProgreso({ hechos: subidas, total, texto: `Subiendo pieza ${p.prefijo} (${i + 1}/${p.laminas.length})` });
          const ruta = `${loteId}/${p.prefijo}-${i + 1}.jpg`;
          const { error } = await Auth.client.storage.from(BUCKET).upload(ruta, p.laminas[i].blob, { contentType: "image/jpeg", upsert: false });
          if (error) throw new Error(`Subida de «${p.laminas[i].nombre}»: ${error.message}`);
          rutas.push(ruta);
          subidas++;
        }
        const { data, error } = await Auth.client.from("instagram_posts")
          .insert({ titulo: `${lote.trim() || "Lote"} · ${p.prefijo}`, lote: lote.trim() || null, caption: p.caption, scheduled_for: p.fecha })
          .select("id").single();
        if (error) throw error;
        postId = data.id;
        const { error: e2 } = await Auth.client.from("instagram_post_slides").insert(
          p.laminas.map((l, i) => ({ post_id: postId, position: i + 1, storage_path: rutas[i], width: l.w, height: l.h })));
        if (e2) throw e2;
        hechos.push(p.prefijo);
      } catch (e) {
        fallos.push({ pieza: p.prefijo, error: (e && e.message) || String(e) });
        if (postId) await Auth.client.from("instagram_posts").delete().eq("id", postId);
        if (rutas.length) await Auth.client.storage.from(BUCKET).remove(rutas);
      }
    }
    setProgreso({ hechos: total, total, texto: "" });
    setResultado({ hechos, fallos });
    setFase("hecho");
    if (hechos.length) onDone();
  };

  const cerrar = () => { if (fase !== "subiendo" && fase !== "analizando") onClose(); };
  const pct = progreso.total ? Math.round((progreso.hechos / progreso.total) * 100) : 0;

  let pie = null;
  if (fase === "resumen") pie = <>
    <button className="btn btn--sm btn--ghost" onClick={() => { setAnalisis(null); setFase("elegir"); }}>Elegir otros ficheros</button>
    <button className="btn btn--sm btn--primary" onClick={crear} disabled={!validas.length || csvRoto || !lote.trim()}>
      <Icon name="upload" size={14} />Crear {validas.length} borrador{validas.length === 1 ? "" : "es"}</button>
  </>;
  if (fase === "hecho") pie = <button className="btn btn--sm btn--primary" onClick={onClose}>Cerrar</button>;

  return <Modal wide title="Subir lote" onClose={cerrar} footer={pie}>
    {fase === "elegir" && <>
      <div className={"upload-drop" + (arrastrando ? " upload-drop--busy" : "")} style={{ cursor: "pointer", textAlign: "center", padding: 28 }}
        onClick={() => input.current && input.current.click()}
        onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
        onDragLeave={() => setArrastrando(false)}
        onDrop={(e) => { e.preventDefault(); setArrastrando(false); analizar(e.dataTransfer.files); }}>
        <Icon name="upload" size={26} style={{ margin: "0 auto 8px" }} />
        <div style={{ fontWeight: 600 }}>Arrastra aquí todas las imágenes del lote (y textos.csv si lo tienes)</div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>o pulsa para elegirlas</div>
        <input ref={input} type="file" multiple accept=".jpg,.jpeg,.png,.webp,.csv,image/jpeg,image/png,image/webp,text/csv" style={{ display: "none" }}
          onChange={(e) => { analizar(e.target.files); e.target.value = ""; }} />
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 12, lineHeight: 1.6 }}>
        <b>Nombres:</b> <code>01.jpg</code> es una imagen suelta; <code>02-1.jpg</code>, <code>02-2.jpg</code>… forman un carrusel (hasta 10).<br />
        <b>textos.csv</b> (opcional): columnas <code>pieza;caption;fecha</code>, separadas por «;», en UTF-8. La fecha, <code>AAAA-MM-DD HH:MM</code> en hora de Madrid; si una pieza no la trae, se reparte por los días y la hora que elijas en el siguiente paso.<br />
        PNG y WebP se convierten a JPG y todo se reduce a 1440 px de ancho. No se crea nada hasta que confirmes el resumen.
      </div>
    </>}

    {(fase === "analizando" || fase === "subiendo") && <div style={{ padding: "16px 0" }}>
      <div style={{ marginBottom: 8 }}>{progreso.texto || "Un momento…"}</div>
      <div className="bar"><div className="bar__fill" style={{ width: pct + "%" }} /></div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{progreso.hechos} de {progreso.total} imágenes · no cierres esta ventana</div>
    </div>}

    {fase === "resumen" && analisis && <>
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="Nombre del lote"><input className="inp" value={lote} onChange={(e) => setLote(e.target.value)} /></Field>
        <Field label="Reparto: desde (día)"><input className="inp" type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Field>
      </div>
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="Días de la semana">
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>{DIAS.map(([l, n]) => <button key={n} type="button"
            className={"chip" + (dias.includes(n) ? " active" : "")}
            onClick={() => setDias(dias.includes(n) ? dias.filter((x) => x !== n) : [...dias, n].sort())}>{l}</button>)}</div>
        </Field>
        <Field label="Hora (Madrid)"><input className="inp" type="time" value={hora} onChange={(e) => setHora(e.target.value)} /></Field>
      </div>
      <div className="muted" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>Una pieza por día; se saltan los días que ya tienen algo programado. {analisis.csvNombre ? <>Texto y fecha de <b>{analisis.csvNombre}</b> cuando los trae.</> : "Sin textos.csv: cada pieza entra solo con el aviso legal."}</div>

      {csvRoto && <div className="warn-box ig-err-box"><b>{analisis.csvNombre}:</b> {analisis.csv.errores.join(" ")} Corrígelo y vuelve a elegir los ficheros.</div>}
      {(analisis.avisosGlobales.length > 0 || (analisis.csv && analisis.csv.avisos.length > 0) || analisis.ignorados.length > 0) && <div className="warn-box" style={{ marginBottom: 12 }}>
        <ul className="ig-lista-aviso" style={{ margin: 0 }}>
          {analisis.avisosGlobales.map((a, i) => <li key={"g" + i}>{a}</li>)}
          {analisis.csv && analisis.csv.avisos.map((a, i) => <li key={"c" + i}>{a}</li>)}
          {analisis.ignorados.length > 0 && <li>Se ignoran (el nombre no sigue el formato): {analisis.ignorados.join(", ")}</li>}
        </ul>
      </div>}

      <div className="ig-resumen">{piezas.map((p) => <div key={p.clave} className={"ig-resumen__fila" + (p.errores.length ? " ig-resumen__fila--error" : "")}>
        <div className="ig-resumen__thumbs">{p.laminas.slice(0, 4).map((l) => <img key={l.nombre} src={l.url} alt="" />)}{p.laminas.length > 4 && <span className="muted">+{p.laminas.length - 4}</span>}</div>
        <div className="ig-resumen__main">
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
            <b>Pieza {p.prefijo}</b>
            <span className="muted" style={{ fontSize: 12.5 }}>{p.ficheros.length === 0 ? "sin imágenes válidas" : p.ficheros.length === 1 ? "imagen suelta" : `carrusel de ${p.ficheros.length}`}
              {p.laminas.length > 0 && ` · ${[...new Set(p.laminas.map((l) => proporcion(l.w, l.h).nombre))].join(", ")}`}
              {p.laminas.length > 0 && ` · ${bytesTexto(p.laminas.reduce((a, l) => a + l.blob.size, 0))}`}</span>
          </div>
          <div style={{ fontSize: 13 }}>{p.fecha ? <><b>{fmtMadrid(p.fecha, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</b> <span className="muted">({p.origenFecha})</span></> : <span className="muted">Sin fecha</span>}</div>
          <div className="ig-resumen__texto" title={p.caption}>{p.caption}</div>
          <div className="muted" style={{ fontSize: 12 }}>{p.caption.length} caracteres · texto: {p.origenTexto}</div>
          {p.errores.length > 0 && <ul className="ig-lista-err">{p.errores.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          {p.avisos.length > 0 && <ul className="ig-lista-aviso">{p.avisos.map((e, i) => <li key={i}>{e}</li>)}</ul>}
        </div>
      </div>)}</div>
      {validas.length < piezas.length && <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>{piezas.length - validas.length} pieza{piezas.length - validas.length === 1 ? "" : "s"} con errores no se crearán.</div>}
    </>}

    {fase === "hecho" && resultado && <div>
      {resultado.hechos.length > 0 && <div className="ig-conexion ig-conexion--ok">Creados {resultado.hechos.length} borrador{resultado.hechos.length === 1 ? "" : "es"} (piezas {resultado.hechos.join(", ")}). Revísalos y apruébalos desde el calendario.</div>}
      {resultado.fallos.length > 0 && <div className="warn-box ig-err-box"><b>No se pudieron crear:</b><ul className="ig-lista-err">{resultado.fallos.map((f) => <li key={f.pieza}>Pieza {f.pieza}: {f.error}</li>)}</ul></div>}
    </div>}
  </Modal>;
}
