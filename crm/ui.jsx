/* GUIMAES CRM — Primitivas de UI + iconos */
const { useState, useMemo, useRef, useEffect } = React;

/* ---------------- Icons (stroke, currentColor) ---------------- */
const ICONS = {
  home:'M3 11.5 12 4l9 7.5M5 10v10h14V10',
  contacts:'M16 20v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 20v-1a3 3 0 0 0-2.5-2.9M15 5.1a3 3 0 0 1 0 5.8',
  pipeline:'M4 5h16M4 5v14M9 5v14M9 9h5M9 14h8M9 5h6',
  whatsapp:'M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3ZM8.5 8.2c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .6.5l.7 1.6c.1.2 0 .4-.1.5l-.4.5c-.1.2-.2.3-.1.5.3.6.9 1.4 1.9 1.9.2.1.4.1.5-.1l.5-.6c.1-.2.3-.2.5-.1l1.5.7c.2.1.3.3.3.5 0 .8-.6 1.5-1.3 1.6-.6.1-1.3.2-3-.9-2-1.3-3-3.3-3.1-3.5-.1-.2-.7-1-.7-1.9 0-.9.5-1.3.6-1.3Z',
  documents:'M6 2h8l4 4v16H6zM14 2v4h4M9 13h6M9 17h6M9 9h2',
  automations:'M13 2 4 14h7l-1 8 9-12h-7z',
  settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13a7.9 7.9 0 0 0 0-2l1.6-1.3-1.5-2.6-2 .6a7.9 7.9 0 0 0-1.7-1l-.3-2H10.5l-.3 2a7.9 7.9 0 0 0-1.7 1l-2-.6-1.5 2.6L6.6 11a7.9 7.9 0 0 0 0 2l-1.6 1.3 1.5 2.6 2-.6c.5.4 1.1.7 1.7 1l.3 2h3l.3-2c.6-.3 1.2-.6 1.7-1l2 .6 1.5-2.6z',
  search:'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3',
  plus:'M12 5v14M5 12h14',
  filter:'M3 5h18l-7 8v6l-4-2v-4z',
  phone:'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  mail:'M3 6h18v12H3zM3 7l9 6 9-6',
  note:'M4 4h16v12l-4 4H4zM16 20v-4h4',
  task:'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  dots:'M12 6h.01M12 12h.01M12 18h.01',
  chevronR:'M9 6l6 6-6 6',
  chevronD:'M6 9l6 6 6-6',
  check:'M20 6 9 17l-5-5',
  x:'M6 6l12 12M18 6 6 18',
  building:'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M8 7h2M8 11h2M8 15h2M14 21v-6h4a2 2 0 0 1 2 2v4M18 11h.01',
  user:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
  logout:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  calendar:'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  euro:'M17 6a6 6 0 1 0 0 12M5 10h9M5 14h9',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  trash:'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  edit:'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  star:'M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 18.3 6.2 21l1.1-6.4L2.6 9.8l6.5-.9z',
  download:'M12 3v12M7 10l5 5 5-5M4 21h16',
  upload:'M12 21V9M7 14l5-5 5 5M4 3h16',
  eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  arrowR:'M5 12h14M13 6l6 6-6 6',
  up:'M12 19V5M6 11l6-6 6 6',
  down:'M12 5v14M6 13l6 6 6-6',
  drag:'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  clock:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  tag:'M20.6 13.4 12 22l-9-9V4h9zM7 8h.01',
  users:'M17 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 20v-1a3 3 0 0 0-2.3-2.9M16 4.1a3 3 0 0 1 0 5.8',
  send:'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  external:'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  briefcase:'M4 7h16v13H4zM9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 12h16',
  target:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  trend:'M3 17l6-6 4 4 8-8M15 7h6v6',
  globe:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18',
  shield:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  refresh:'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  archive:'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  copy:'M9 9h11v11H9zM5 15V4h11',
  folder:'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
};
function Icon({name, size=18, style, className, strokeWidth=2}){
  const d = ICONS[name] || '';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} style={style}
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {d.split('M').filter(Boolean).map((seg,i)=><path key={i} d={'M'+seg} />)}
    </svg>
  );
}

/* ---------------- Avatar ---------------- */
function Avatar({name, size="md", color}){
  const c = color || CRM.colorFor(name);
  return <div className={"av av--"+size} style={{background:c}}>{CRM.initials(name)}</div>;
}

/* ---------------- Badge ---------------- */
function tint(hex, a){ return hex+a; }
function Badge({label, color="#6E8298", dot=true, solid=false}){
  const style = solid
    ? {background:color, color:"#fff"}
    : {background:color+"1A", color:color};
  return <span className="badge" style={style}>{dot && <span className="dot" style={{background:color}}></span>}{label}</span>;
}
function StageBadge({id}){ const s=CRM.stageById[id]; return s? <Badge label={s.label} color={s.color} /> : null; }
function LifecycleBadge({id}){ const l=CRM.lifecycleById[id]; return l? <Badge label={l.label} color={l.color} /> : null; }
function PriorityDot({id, showLabel}){ const p=CRM.priorityById(id); if(!p)return null;
  return <span className="badge" style={{background:p.color+"14",color:p.color}}><span className="dot" style={{background:p.color}}></span>{showLabel?p.label:null}</span>; }
function ServiceBadge({id}){ const s=CRM.serviceById(id); return s? <Badge label={s.name} color={s.color} /> : null; }

/* ---------------- Modal ---------------- */
function Modal({title, onClose, children, footer, wide}){
  useEffect(()=>{
    const h = e=>{ if(e.key==='Escape') onClose(); };
    window.addEventListener('keydown', h); return ()=>window.removeEventListener('keydown', h);
  },[]);
  return (
    <div className="overlay" onMouseDown={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div className={"modal"+(wide?" modal--wide":"")}>
        <div className="modal__head">
          <h3>{title}</h3>
          <button className="modal__x" onClick={onClose} aria-label="Cerrar"><Icon name="x" size={20}/></button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------- Empty state ---------------- */
function Empty({icon="note", title, sub, action}){
  return (
    <div className="empty">
      <div className="empty__ico"><Icon name={icon} size={26}/></div>
      <h4>{title}</h4>
      {sub && <p style={{maxWidth:360,margin:"0 auto"}}>{sub}</p>}
      {action && <div style={{marginTop:16}}>{action}</div>}
    </div>
  );
}

/* ---------------- Tabs ---------------- */
function Tabs({tabs, active, onChange}){
  return (
    <div className="tabs">
      {tabs.map(t=>(
        <button key={t.id} className={"tab"+(active===t.id?" active":"")} onClick={()=>onChange(t.id)}>
          {t.label}{t.n!=null && <span className="tab__n">{t.n}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Field (form) ---------------- */
function Field({label, children}){ return <div className="fld"><label className="fld__l">{label}</label>{children}</div>; }

/* ---------------- KV field (read) ---------------- */
function KV({k, children}){ return <div className="field"><span className="field__k">{k}</span><span className="field__v">{children}</span></div>; }

Object.assign(window, { Icon, Avatar, Badge, StageBadge, LifecycleBadge, PriorityDot, ServiceBadge, Modal, Empty, Tabs, Field, KV });
