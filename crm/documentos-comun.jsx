import React from "react";
/* GUIMAES CRM — Piezas de Documentos compartidas entre app.jsx (módulo
   Documentos, fichas) y agente.jsx (enlaces a documentos en las respuestas
   del asistente): breakpoint móvil, descarga y visor con URL firmada.
   Todo con la sesión del usuario (Auth.client) y la RLS de documentos. */
const { useState, useEffect } = React;

// Único punto de verdad para el breakpoint móvil — debe coincidir con
// @media(max-width:820px) en styles.css (un valor CSS no se puede leer desde
// aquí, así que si cambia uno hay que cambiar el otro a mano).
export const MOBILE_BREAKPOINT = 820;
export function useIsMobile(){
  const [isMobile,setIsMobile]=useState(()=>window.innerWidth<=MOBILE_BREAKPOINT);
  useEffect(()=>{
    const onResize=()=>setIsMobile(window.innerWidth<=MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return ()=>window.removeEventListener("resize", onResize);
  },[]);
  return isMobile;
}
// Descarga con URL firmada. Mismo patrón que WaDocumentAttachment: la
// pestaña se abre en blanco SÍNCRONO dentro del click, antes de cualquier
// await — si se abriera después, Safari/iOS la bloquean por haber perdido
// el gesto de usuario. Devuelve [download, idDescargando].
export function useDocDownload(toast){
  const [busyId,setBusyId]=useState(null);
  const download=async(doc)=>{
    if(doc.status!=="stored") return;
    const win = window.open("", "_blank");
    setBusyId(doc.id);
    try{
      const url = await CRM.getAttachmentSignedUrl(Auth.client, doc.id, {download: CRM.docDownloadName(doc)});
      if(!url){ toast("No se pudo generar el enlace de descarga."); if(win) win.close(); return; }
      if(win) win.location.href = url; else window.open(url, "_blank");
    }finally{ setBusyId(null); }
  };
  return [download, busyId];
}
// Visor dentro del CRM con la URL firmada (sin "download", para que Storage
// lo sirva inline). Imagen: <img>. PDF: <iframe> en escritorio; en móvil
// no — Chrome de Android no pinta PDF dentro de un iframe y Safari de iOS
// lo hace a medias, así que se ofrece abrirlo en el visor nativo del móvil
// (enlace normal, sin bloqueo de ventanas emergentes). Solo se abre para
// los tipos que devuelve CRM.docPreviewKind; el resto no llega aquí.
export function DocPreviewModal({doc, onClose, onDownload, downloading}){
  const kind = CRM.docPreviewKind(doc);
  const isMobile = useIsMobile();
  const [url,setUrl]=useState(null); const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let alive=true;
    setUrl(null); setFailed(false);
    CRM.getAttachmentSignedUrl(Auth.client, doc.id).then(u=>{ if(!alive) return; if(u) setUrl(u); else setFailed(true); });
    return ()=>{alive=false;};
  },[doc.id]);
  const name = CRM.docDisplayName(doc);
  const pdfInline = kind==="pdf" && !isMobile;
  let body;
  if(failed) body = <Empty icon="documents" title="No se pudo cargar la vista previa" sub="Prueba a descargarlo."/>;
  else if(!url) body = <div className="doc-preview__loading muted"><Icon name="clock" size={16}/>Cargando vista previa…</div>;
  else if(kind==="image") body = <div className="doc-preview__stage"><img className="doc-preview__img" src={url} alt={name} onError={()=>setFailed(true)}/></div>;
  else if(pdfInline) body = <iframe className="doc-preview__pdf" src={url} title={name}></iframe>;
  else body = <div className="doc-preview__mobile">
    <div className="lrow__ico"><Icon name="documents" size={20}/></div>
    <p className="muted">En el móvil, los PDF se abren con el visor del propio teléfono.</p>
    <a className="btn btn--primary" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={15}/>Abrir PDF</a>
  </div>;
  return <Modal title={name} wide onClose={onClose} footer={<>
    {pdfInline && url && !failed && <a className="btn btn--ghost" href={url} target="_blank" rel="noopener noreferrer" style={{marginRight:"auto"}}><Icon name="external" size={15}/>Abrir en pestaña nueva</a>}
    <button className="btn btn--ghost" onClick={onClose}>Cerrar</button>
    <button className="btn btn--primary" onClick={()=>onDownload(doc)} disabled={downloading}><Icon name="download" size={15}/>Descargar</button>
  </>}>
    <div className="doc-preview">{body}</div>
  </Modal>;
}

