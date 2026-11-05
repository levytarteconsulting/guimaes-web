import React from "react";
import {
  anadirAviso, bytesTexto, contarHashtags, contarMenciones, erroresLaminas, fmtMadrid, leerCaption, leerTextosCsv,
  madridDia, madridPartes, MAX_CAPTION, MAX_HASHTAGS, MAX_MENCIONES, medidasFinales, organizarLote, proporcion,
  repartirFechas, tieneAviso,
} from "./instagram-util.js";
/* GUIMAES CRM — Subir un lote de piezas de Instagram.
   Formas de traer un lote (la lógica está en organizarLote):
   - Una carpeta con subcarpetas: cada subcarpeta es una pieza (1 imagen =
     imagen suelta; 2 a 10 = carrusel). El texto, de su caption.txt (o de su
     único .txt). Láminas y piezas en orden natural de nombre.
   - Imágenes con la convención 01.jpg / 02-1.jpg, 02-2.jpg… (como antes).
   - Imágenes sueltas (o una carpeta sin subcarpetas): se elige si son un
     carrusel o una publicación por imagen.
   textos.csv (opcional, pieza;caption;fecha) manda sobre los caption.txt.
   PNG y WebP se convierten a JPG; todo se reduce a 1440 px de ancho como
   máximo, con calidad 0,85 (bajando hasta 0,6 si pasa de 1,5 MB).
   Las piezas sin fecha se reparten por los días y la hora elegidos.
   En el resumen se pueden reordenar o quitar láminas. Nada se crea hasta
   confirmar. Todo entra como borrador. */
const { useState: lState, useEffect: lEffect, useMemo: lMemo, useRef: lRef } = React;

const BUCKET = "instagram-media";
const OBJETIVO = 1.5 * 1048576;
const LIMITE_BUCKET = 8 * 1048576;
const DIAS = [["L", 0], ["M", 1], ["X", 2], ["J", 3], ["V", 4], ["S", 5], ["D", 6]];
const EXT_IMAGEN = /\.(jpe?g|png|webp)$/i;

async function procesarImagen(file, ruta) {
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
  return { ruta, nombre: file.name, blob, w, h, q, original, tamOriginal: file.size, url: URL.createObjectURL(blob) };
}

// Recorre lo soltado (carpetas incluidas). Las entradas hay que pedirlas antes
// del primer await: el navegador vacía dataTransfer al acabar el evento.
async function leerEntrada(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((ok, ko) => entry.file(ok, ko));
    out.push({ ruta: entry.fullPath.replace(/^\/+/, ""), file });
  } else if (entry.isDirectory) {
    const lector = entry.createReader();
    for (;;) { // readEntries devuelve por tandas (100 en Chrome) hasta una vacía
      const tanda = await new Promise((ok, ko) => lector.readEntries(ok, ko));
      if (!tanda.length) break;
      for (const e of tanda) await leerEntrada(e, out);
    }
  }
}
async function ficherosSoltados(dt) {
  const entradas = Array.from(dt.items || []).filter((i) => i.kind === "file")
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  const sueltos = Array.from(dt.files || []);
  if (!entradas.length) return sueltos.map((f) => ({ ruta: f.name, file: f }));
  const out = [];
  for (const e of entradas) await leerEntrada(e, out);
  return out;
}
const ficherosDeInput = (files) => Array.from(files || []).map((f) => ({ ruta: f.webkitRelativePath || f.name, file: f }));

export function SubirLote({ posts, toast, onClose, onDone }) {
  const hoy = madridPartes(new Date());
  const manana = madridDia(new Date(Date.UTC(hoy.y, hoy.m - 1, hoy.d + 1, 12)));
  const [fase, setFase] = lState("elegir"); // elegir | analizando | resumen | subiendo | hecho
  const [progreso, setProgreso] = lState({ hechos: 0, total: 0, texto: "" });
  const [analisis, setAnalisis] = lState(null); // {rutas, procesadas: Map ruta→imagen, textos: Map ruta→{texto,utf8}, csv, csvNombre}
  const [modo, setModo] = lState(null);       // null = el de por defecto; "carrusel" | "sueltas"
  const [orden, setOrden] = lState({});       // clave de pieza → rutas de sus láminas (tras reordenar/quitar)
  const [lote, setLote] = lState(`Lote ${madridDia(new Date())}`);
  const [desde, setDesde] = lState(manana);
  const [dias, setDias] = lState([0, 2, 4]);
  const [hora, setHora] = lState("10:00");
  const [resultado, setResultado] = lState(null);
  const [arrastrando, setArrastrando] = lState(false);
  const inputFicheros = lRef(null);
  const inputCarpeta = lRef(null);
  const arrastreLamina = lRef(null);
  const urls = lRef([]);
  lEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const analizar = async (entradas) => {
    const lista = entradas.filter((e) => e.file);
    const previo = organizarLote(lista.map((e) => e.ruta));
    const visibles = lista.filter((e) => !e.ruta.split("/").some((s) => s.startsWith(".") || s === "__MACOSX"));
    const imagenes = visibles.filter((e) => EXT_IMAGEN.test(e.ruta));
    if (!imagenes.length) { toast("No hay imágenes JPG, PNG o WebP en lo que has elegido."); return; }
    setFase("analizando");
    const textos = new Map();
    for (const e of visibles) if (/\.txt$/i.test(e.ruta)) {
      try { textos.set(e.ruta, leerCaption(new Uint8Array(await e.file.arrayBuffer()))); } catch { /* se trata como sin texto */ }
    }
    let csv = null, csvNombre = null;
    if (previo.csv) {
      const f = lista.find((e) => e.ruta === previo.csv);
      csvNombre = f.file.name;
      csv = leerTextosCsv(await f.file.text());
    }
    const procesadas = new Map();
    setProgreso({ hechos: 0, total: imagenes.length, texto: "Preparando imágenes…" });
    for (let i = 0; i < imagenes.length; i++) {
      const { ruta, file } = imagenes[i];
      setProgreso({ hechos: i, total: imagenes.length, texto: `Preparando ${ruta}` });
      try {
        const r = await procesarImagen(file, ruta);
        urls.current.push(r.url);
        procesadas.set(ruta, r);
      } catch (e) { procesadas.set(ruta, { ruta, nombre: file.name, error: e.message }); }
    }
    setModo(null);
    setOrden({});
    setLote(previo.raiz || `Lote ${madridDia(new Date())}`);
    setAnalisis({ rutas: lista.map((e) => e.ruta), procesadas, textos, csv, csvNombre });
    setFase("resumen");
  };

  const org = lMemo(() => (analisis ? organizarLote(analisis.rutas, { modo }) : null), [analisis, modo]);

  // Piezas con texto, fecha, láminas y avisos. Se recalcula al cambiar el reparto o el orden.
  const piezas = lMemo(() => {
    if (!org) return [];
    const { csv, procesadas, textos } = analisis;
    const base = org.piezas.map((g) => {
      const errores = [...g.errores], avisos = [...g.avisos];
      const ficheros = orden[g.clave] || g.ficheros;
      const clCsv = csv ? g.clavesCsv.find((c) => csv.porPieza.has(c)) : null;
      const fila = clCsv ? csv.porPieza.get(clCsv) : null;
      if (fila && fila.errorFila) errores.push(fila.errorFila);
      const laminas = ficheros.map((r) => procesadas.get(r)).filter(Boolean);
      for (const l of laminas) {
        if (l.error) { errores.push(l.error); continue; }
        if (l.blob.size > LIMITE_BUCKET) errores.push(`«${l.nombre}» ocupa ${bytesTexto(l.blob.size)} después de comprimir (máximo 8 MB).`);
        else if (l.blob.size > OBJETIVO) avisos.push(`«${l.nombre}» ocupa ${bytesTexto(l.blob.size)} (objetivo: menos de 1,5 MB).`);
        const p = proporcion(l.w, l.h);
        if (!p.ok) avisos.push(`«${l.nombre}» es ${p.nombre} (${l.w}×${l.h}): fuera de 4:5–1,91:1. Instagram la rechazaría; no se podrá aprobar.`);
      }
      const ok = laminas.filter((l) => !l.error);
      if (laminas.length || !errores.length) errores.push(...erroresLaminas(laminas.length));
      if (ok.length > 1 && new Set(ok.map((l) => (l.w / l.h).toFixed(3))).size > 1) {
        avisos.push("Las láminas no tienen la misma proporción: Instagram recorta todas a la de la primera.");
      }
      // Texto: textos.csv manda; si no, el caption.txt de la pieza; si no, solo el aviso legal.
      let caption = "", origenTexto = "sin texto", traeTexto = false;
      const txt = g.texto ? textos.get(g.texto) : null;
      const nombreTxt = g.texto ? g.texto.split("/").pop() : null;
      if (fila) { caption = fila.caption; origenTexto = analisis.csvNombre; traeTexto = true; }
      else if (txt) {
        caption = txt.texto; origenTexto = nombreTxt; traeTexto = !!txt.texto;
        if (!txt.utf8) avisos.push(`«${nombreTxt}» no está en UTF-8: revisa las tildes y las eñes.`);
        if (!txt.texto) avisos.push(`«${nombreTxt}» está vacío: entra solo con el aviso legal.`);
      } else if (g.texto) avisos.push(`No se pudo leer «${nombreTxt}»: entra solo con el aviso legal.`);
      else if (org.tipo === "convencion") { if (csv) avisos.push("No está en textos.csv: entra solo con el aviso legal."); }
      else avisos.push(csv ? "Sin caption.txt y no está en textos.csv: entra solo con el aviso legal." : "Sin caption.txt: entra solo con el aviso legal.");
      if (!tieneAviso(caption)) { caption = anadirAviso(caption); if (traeTexto) avisos.push("El texto no traía el aviso legal: se añade al final."); }
      if (caption.length > MAX_CAPTION) errores.push(`El texto tiene ${caption.length} caracteres con el aviso legal (máximo ${MAX_CAPTION}).`);
      if (contarHashtags(caption) > MAX_HASHTAGS) avisos.push(`Tiene ${contarHashtags(caption)} hashtags (máximo ${MAX_HASHTAGS}): no se podrá aprobar así.`);
      if (contarMenciones(caption) > MAX_MENCIONES) avisos.push(`Tiene ${contarMenciones(caption)} menciones (máximo ${MAX_MENCIONES}): no se podrá aprobar así.`);
      return { ...g, ficheros, cambiado: !!orden[g.clave], laminas: ok, caption, origenTexto,
        fecha: fila && fila.fecha ? fila.fecha : null, origenFecha: fila && fila.fecha ? analisis.csvNombre : "reparto", errores, avisos };
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
  }, [org, orden, desde, dias, hora, posts]);

  // Avisos del lote entero (los de organizarLote y las filas de textos.csv sin pieza).
  const avisosLote = lMemo(() => {
    if (!org) return [];
    const a = [...org.avisos];
    const csv = analisis.csv;
    if (csv) {
      a.push(...csv.avisos);
      const claves = new Set(org.piezas.flatMap((p) => p.clavesCsv));
      for (const [clave, fila] of csv.porPieza) if (!claves.has(clave)) a.push(`${analisis.csvNombre}, fila ${fila.linea}: la pieza ${fila.pieza} no tiene imágenes; se ignora.`);
    }
    return a;
  }, [org]);

  // Reordenar y quitar láminas de una pieza.
  const fijar = (p, ficheros) => setOrden((o) => ({ ...o, [p.clave]: ficheros }));
  const mover = (p, ruta, destino) => {
    const arr = p.ficheros.filter((r) => r !== ruta);
    arr.splice(Math.max(0, Math.min(destino, arr.length)), 0, ruta);
    fijar(p, arr);
  };
  const quitar = (p, ruta) => fijar(p, p.ficheros.filter((r) => r !== ruta));
  const restablecer = (p) => setOrden((o) => { const n = { ...o }; delete n[p.clave]; return n; });

  const validas = piezas.filter((p) => !p.errores.length);
  const csvRoto = analisis && analisis.csv && analisis.csv.errores.length > 0;
  const titulo = (p) => (org && org.tipo === "convencion" ? `Pieza ${p.nombre}` : p.nombre);

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
          setProgreso({ hechos: subidas, total, texto: `Subiendo ${titulo(p)} (${i + 1}/${p.laminas.length})` });
          const ruta = `${loteId}/${p.slug}-${i + 1}.jpg`;
          const { error } = await Auth.client.storage.from(BUCKET).upload(ruta, p.laminas[i].blob, { contentType: "image/jpeg", upsert: false });
          if (error) throw new Error(`Subida de «${p.laminas[i].nombre}»: ${error.message}`);
          rutas.push(ruta);
          subidas++;
        }
        const { data, error } = await Auth.client.from("instagram_posts")
          .insert({ titulo: `${lote.trim() || "Lote"} · ${p.nombre}`, lote: lote.trim() || null, caption: p.caption, scheduled_for: p.fecha })
          .select("id").single();
        if (error) throw error;
        postId = data.id;
        const { error: e2 } = await Auth.client.from("instagram_post_slides").insert(
          p.laminas.map((l, i) => ({ post_id: postId, position: i + 1, storage_path: rutas[i], width: l.w, height: l.h })));
        if (e2) throw e2;
        hechos.push(titulo(p));
      } catch (e) {
        fallos.push({ pieza: titulo(p), error: (e && e.message) || String(e) });
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
  const cambiarModo = (m) => { setModo(m); setOrden({}); };

  let pie = null;
  if (fase === "resumen") pie = <>
    <button className="btn btn--sm btn--ghost" onClick={() => { setAnalisis(null); setFase("elegir"); }}>Elegir otros ficheros</button>
    <button className="btn btn--sm btn--primary" onClick={crear} disabled={!validas.length || csvRoto || !lote.trim()}>
      <Icon name="upload" size={14} />Crear {validas.length} borrador{validas.length === 1 ? "" : "es"}</button>
  </>;
  if (fase === "hecho") pie = <button className="btn btn--sm btn--primary" onClick={onClose}>Cerrar</button>;

  return <Modal wide title="Subir lote" onClose={cerrar} footer={pie}>
    {fase === "elegir" && <>
      <div className={"upload-drop" + (arrastrando ? " upload-drop--busy" : "")} style={{ padding: 28 }}
        onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }}
        onDragLeave={() => setArrastrando(false)}
        onDrop={(e) => { e.preventDefault(); setArrastrando(false); ficherosSoltados(e.dataTransfer).then(analizar, () => toast("No se pudo leer lo que has soltado.")); }}>
        <Icon name="folder" size={26} />
        <div style={{ fontWeight: 600, color: "var(--ink)" }}>Arrastra aquí la carpeta del lote (o sus imágenes)</div>
        <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => inputCarpeta.current && inputCarpeta.current.click()}><Icon name="folder" size={14} />Elegir carpeta</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => inputFicheros.current && inputFicheros.current.click()}><Icon name="upload" size={14} />Elegir imágenes</button>
        </div>
        <input ref={(el) => { inputCarpeta.current = el; if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); } }}
          type="file" multiple style={{ display: "none" }} data-carpeta=""
          onChange={(e) => { analizar(ficherosDeInput(e.target.files)); e.target.value = ""; }} />
        <input ref={inputFicheros} type="file" multiple accept=".jpg,.jpeg,.png,.webp,.csv,.txt,image/jpeg,image/png,image/webp,text/csv,text/plain" style={{ display: "none" }}
          onChange={(e) => { analizar(ficherosDeInput(e.target.files)); e.target.value = ""; }} />
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 12, lineHeight: 1.6 }}>
        <b>Carpeta del lote:</b> una subcarpeta por publicación, con sus imágenes (1 = imagen suelta; 2 a 10 = carrusel, en orden de nombre) y un <code>caption.txt</code> con el texto.<br />
        <b>También vale:</b> <code>01.jpg</code> (imagen suelta) y <code>02-1.jpg</code>, <code>02-2.jpg</code>… (carrusel), o imágenes sueltas: te preguntaremos si son un carrusel o una publicación cada una.<br />
        <b>textos.csv</b> (opcional): <code>pieza;caption;fecha</code>, en UTF-8; manda sobre los caption.txt. Fecha <code>AAAA-MM-DD HH:MM</code> en hora de Madrid; si no la trae, se reparte por los días y la hora que elijas.<br />
        PNG y WebP se convierten a JPG y todo se reduce a 1440 px de ancho. No se crea nada hasta que confirmes el resumen.
      </div>
    </>}

    {(fase === "analizando" || fase === "subiendo") && <div style={{ padding: "16px 0" }}>
      <div style={{ marginBottom: 8 }}>{progreso.texto || "Un momento…"}</div>
      <div className="bar"><div className="bar__fill" style={{ width: pct + "%" }} /></div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{progreso.hechos} de {progreso.total} imágenes · no cierres esta ventana</div>
    </div>}

    {fase === "resumen" && org && <>
      {org.pideModo && <div className="ig-modo">
        <b>Estas imágenes son:</b>
        <div className="ig-modo__opciones" role="radiogroup">
          <button type="button" role="radio" aria-checked={org.modo === "carrusel"} className={"chip" + (org.modo === "carrusel" ? " active" : "")} onClick={() => cambiarModo("carrusel")}>Un carrusel</button>
          <button type="button" role="radio" aria-checked={org.modo === "sueltas"} className={"chip" + (org.modo === "sueltas" ? " active" : "")} onClick={() => cambiarModo("sueltas")}>Una publicación por imagen</button>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>{org.modo === "carrusel" ? "Todas en una sola publicación, con el texto del caption.txt." : "Cada imagen, una publicación (con el .txt de su mismo nombre, si lo hay)."}</span>
      </div>}
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
      <div className="muted" style={{ fontSize: 12.5, margin: "-4px 0 12px" }}>Una pieza por día, en el orden de abajo; se saltan los días que ya tienen algo programado. {analisis.csvNombre && <>Texto y fecha de <b>{analisis.csvNombre}</b> para las piezas que incluye.</>}</div>

      {csvRoto && <div className="warn-box ig-err-box"><b>{analisis.csvNombre}:</b> {analisis.csv.errores.join(" ")} Corrígelo y vuelve a elegir los ficheros.</div>}
      {avisosLote.length > 0 && <div className="warn-box" style={{ marginBottom: 12 }}>
        <ul className="ig-lista-aviso" style={{ margin: 0 }}>{avisosLote.map((a, i) => <li key={i}>{a}</li>)}</ul>
      </div>}

      <div className="ig-resumen">{piezas.map((p) => <div key={p.clave} className={"ig-resumen__fila" + (p.errores.length ? " ig-resumen__fila--error" : "")}>
        <div className="ig-resumen__main">
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
            <b>{titulo(p)}</b>
            <span className="muted" style={{ fontSize: 12.5 }}>{p.laminas.length === 0 ? "sin imágenes válidas" : p.laminas.length === 1 ? "imagen suelta" : `carrusel de ${p.laminas.length}`}
              {p.laminas.length > 0 && ` · ${[...new Set(p.laminas.map((l) => proporcion(l.w, l.h).nombre))].join(", ")}`}
              {p.laminas.length > 0 && ` · ${bytesTexto(p.laminas.reduce((a, l) => a + l.blob.size, 0))}`}</span>
            {p.cambiado && <button type="button" className="btn btn--sm btn--ghost" style={{ marginLeft: "auto" }} onClick={() => restablecer(p)}>Deshacer cambios de láminas</button>}
          </div>
          {p.laminas.length > 0 && <div className="ig-lams">{p.laminas.map((l, i) => {
            const n = p.laminas.length;
            return <div key={l.ruta} className="ig-lam" draggable={n > 1}
              onDragStart={(e) => { arrastreLamina.current = { clave: p.clave, ruta: l.ruta }; e.dataTransfer.effectAllowed = "move"; }}
              onDragOver={(e) => { const a = arrastreLamina.current; if (a && a.clave === p.clave) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const a = arrastreLamina.current; arrastreLamina.current = null;
                if (a && a.clave === p.clave && a.ruta !== l.ruta) mover(p, a.ruta, p.ficheros.indexOf(l.ruta)); }}
              onDragEnd={() => { arrastreLamina.current = null; }}>
              <img src={l.url} alt={l.nombre} title={l.nombre} draggable={false} />
              <span className="ig-lam__n">{i + 1}</span>
              {n > 1 && <div className="ig-lam__bot">
                <button type="button" aria-label={`Mover ${l.nombre} a la izquierda`} disabled={i === 0} onClick={() => mover(p, l.ruta, p.ficheros.indexOf(l.ruta) - 1)}>‹</button>
                <button type="button" aria-label={`Quitar ${l.nombre}`} className="ig-lam__x" onClick={() => quitar(p, l.ruta)}>×</button>
                <button type="button" aria-label={`Mover ${l.nombre} a la derecha`} disabled={i === n - 1} onClick={() => mover(p, l.ruta, p.ficheros.indexOf(l.ruta) + 1)}>›</button>
              </div>}
            </div>;
          })}</div>}
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
      {resultado.hechos.length > 0 && <div className="ig-conexion ig-conexion--ok">Creados {resultado.hechos.length} borrador{resultado.hechos.length === 1 ? "" : "es"} ({resultado.hechos.join(", ")}). Revísalos y apruébalos desde el calendario.</div>}
      {resultado.fallos.length > 0 && <div className="warn-box ig-err-box"><b>No se pudieron crear:</b><ul className="ig-lista-err">{resultado.fallos.map((f) => <li key={f.pieza}>{f.pieza}: {f.error}</li>)}</ul></div>}
    </div>}
  </Modal>;
}
