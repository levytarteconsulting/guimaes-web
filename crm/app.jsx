import React from "react";
import ReactDOM from "react-dom/client";
/* GUIMAES CRM — App: login, shell, router y todas las pantallas */
const { useState:uState, useMemo:uMemo, useRef:uRef, useEffect:uEffect } = React;

/* ============ Helpers ============ */
function Toast({msg}){ return msg ? <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:"#0B2238",color:"#fff",padding:"12px 20px",borderRadius:12,boxShadow:"var(--shadow-lg)",zIndex:200,fontWeight:600,fontFamily:"var(--display)"}}>{msg}</div> : null; }
const useToast = () => { const [m,setM]=uState(null); const fire=(t)=>{setM(t);setTimeout(()=>setM(null),2200);}; return [m,fire]; };
// Único punto de verdad para el breakpoint móvil — debe coincidir con
// @media(max-width:820px) en styles.css (un valor CSS no se puede leer desde
// aquí, así que si cambia uno hay que cambiar el otro a mano).
const MOBILE_BREAKPOINT = 820;
function useIsMobile(){
  const [isMobile,setIsMobile]=uState(()=>window.innerWidth<=MOBILE_BREAKPOINT);
  uEffect(()=>{
    const onResize=()=>setIsMobile(window.innerWidth<=MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return ()=>window.removeEventListener("resize", onResize);
  },[]);
  return isMobile;
}
function ownerAvatar(id){ const u=CRM.userById(id); return u? <Avatar name={u.name} size="sm" color={u.color}/> : null; }
// id real del servicio "Asesoría Laboral" en CRM.SERVICES — se busca por nombre en vez de
// hardcodear el id, para no romper en silencio si el catálogo cambia.
const LABORAL_SERVICE_ID = (CRM.SERVICES.find(s=>s.name==="Asesoría Laboral")||{}).id || "";

/* ============ LOGIN ============ */
function userFromSession(session){
  const u = CRM.USERS.find(x=>x.email.toLowerCase()===session.user.email.toLowerCase());
  return u || {id:"u0", name:session.user.email, email:session.user.email, title:"Administrador", color:"#1F6FEB"};
}
// Aviso de sesión tras CRM.loadWebLeads: un toast se lo pierde cualquiera
// que no esté mirando la pantalla en ese instante — por eso no es el único
// registro (ver leads.error_message, persistente, en
// crm/supabase-leads-dedupe.sql), pero sigue mereciendo la pena para quien
// sí está delante en ese momento. Un solo toast combinado, no dos: fireToast
// solo guarda un mensaje a la vez, uno nuevo pisaría al anterior.
function reportLeadIssues(fireToast, result){
  if(!result) return;
  const msgs = [];
  if(result.contactFailures && result.contactFailures.length) msgs.push(result.contactFailures.length+" lead(s) no se pudieron convertir: "+result.contactFailures.join(", "));
  if(result.dealFailures && result.dealFailures.length) msgs.push(result.dealFailures.length+" contacto(s) creado(s) sin deal: "+result.dealFailures.join(", "));
  if(msgs.length) fireToast(msgs.join(" · "));
}
function GoogleG({size=18}){
  return <svg width={size} height={size} viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9C16.66 14.2 17.64 11.9 17.64 9.2Z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18Z"/>
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.35 2.83.94 4.03l3.01-2.33Z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.97l3.01 2.33C4.66 5.17 6.65 3.58 9 3.58Z"/>
  </svg>;
}
function Login({onLogin}){
  const [email,setEmail]=uState(""); const [password,setPassword]=uState("");
  const [err,setErr]=uState(null); const [busy,setBusy]=uState(false); const [resetSent,setResetSent]=uState(false);

  const submit=async(e)=>{
    e.preventDefault();
    setBusy(true); setErr(null);
    const {data,error} = await Auth.signInWithPassword(email, password);
    setBusy(false);
    if(error){ setErr(error.message); return; }
    onLogin(userFromSession(data));
  };
  const google=async()=>{
    setErr(null);
    const {error} = await Auth.signInWithGoogle();
    if(error) setErr(error.message);
  };
  const forgot=async(e)=>{
    e.preventDefault();
    if(!email){ setErr("Escribe tu correo arriba primero."); return; }
    setErr(null);
    const {error} = await Auth.sendPasswordReset(email);
    if(error){ setErr(error.message); return; }
    setResetSent(true);
  };

  return (
    <div className="login">
      <div className="login__aside">
        <div>
          <div className="login__brand">GUIMAES</div>
          <div style={{color:"#8299B0",letterSpacing:".14em",fontSize:12,textTransform:"uppercase",marginTop:6}}>CRM interno</div>
        </div>
        <div>
          <h2 style={{color:"#fff",fontSize:30,lineHeight:1.2,maxWidth:380}}>La herramienta de gestión del día a día de tu despacho.</h2>
          <p style={{color:"#A9BDD2",marginTop:16,maxWidth:400}}>Contactos, pipeline, expedientes de cliente, WhatsApp y automatizaciones — conectado con la web.</p>
        </div>
        <div style={{color:"#63799190",fontSize:12}}>Acceso restringido a administradores</div>
      </div>
      <div className="login__form">
        <div className="login__box">
          <h2 style={{fontSize:24}}>Iniciar sesión</h2>
          <p className="muted" style={{marginTop:6,marginBottom:20}}>Accede con tu cuenta de administrador.</p>
          {err && <div className="login__err">{err}</div>}
          {resetSent ? (
            <div className="login__notice">Te hemos enviado un correo a <b>{email}</b> para restablecer tu contraseña.</div>
          ) : (
            <form onSubmit={submit}>
              <Field label="Correo electrónico"><input className="inp" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required/></Field>
              <Field label="Contraseña"><input className="inp" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></Field>
              <div style={{textAlign:"right",margin:"-10px 0 14px"}}><a style={{fontSize:12.5,color:"var(--accent)",cursor:"pointer",fontWeight:600}} onClick={forgot}>¿Olvidaste tu contraseña?</a></div>
              <button className="btn btn--primary" type="submit" style={{width:"100%"}} disabled={busy}>{busy?"Entrando…":"Entrar"}</button>
            </form>
          )}
          <div className="login__divider"><span>o</span></div>
          <button className="btn btn--ghost" style={{width:"100%"}} onClick={google}><GoogleG size={17}/>Continuar con Google</button>
          {!Auth.configured && <div className="login__notice" style={{marginTop:14}}>⚠ El acceso aún no está configurado (falta conectar Supabase). Ver crm/SETUP-SUPABASE.md.</div>}
        </div>
      </div>
    </div>
  );
}

/* ============ RECUPERAR CONTRASEÑA ============ */
function PasswordRecovery({onDone}){
  const [pw,setPw]=uState(""); const [pw2,setPw2]=uState(""); const [err,setErr]=uState(null); const [busy,setBusy]=uState(false);
  const submit=async(e)=>{
    e.preventDefault();
    if(pw.length<8){ setErr("La contraseña debe tener al menos 8 caracteres."); return; }
    if(pw!==pw2){ setErr("Las contraseñas no coinciden."); return; }
    setBusy(true); setErr(null);
    const {error} = await Auth.updatePassword(pw);
    setBusy(false);
    if(error){ setErr(error.message); return; }
    onDone();
  };
  return (
    <div className="login">
      <div className="login__aside">
        <div><div className="login__brand">GUIMAES</div><div style={{color:"#8299B0",letterSpacing:".14em",fontSize:12,textTransform:"uppercase",marginTop:6}}>CRM interno</div></div>
      </div>
      <div className="login__form">
        <div className="login__box">
          <h2 style={{fontSize:24}}>Nueva contraseña</h2>
          <p className="muted" style={{marginTop:6,marginBottom:20}}>Elige una nueva contraseña para tu cuenta.</p>
          {err && <div className="login__err">{err}</div>}
          <form onSubmit={submit}>
            <Field label="Nueva contraseña"><input className="inp" type="password" autoComplete="new-password" value={pw} onChange={e=>setPw(e.target.value)} required/></Field>
            <Field label="Repite la contraseña"><input className="inp" type="password" autoComplete="new-password" value={pw2} onChange={e=>setPw2(e.target.value)} required/></Field>
            <button className="btn btn--primary" type="submit" style={{width:"100%"}} disabled={busy}>{busy?"Guardando…":"Guardar contraseña"}</button>
          </form>
        </div>
      </div>
    </div>
  );
}

/* ============ SHELL ============ */
const NAV = [
  {id:"home", label:"Inicio", icon:"home"},
  {id:"empresas", label:"Empresas", icon:"building", badge:()=>CRM.EMPRESAS.length},
  {id:"contacts", label:"Contactos", icon:"contacts", badge:()=>CRM.CONTACTS.length},
  {id:"cuentas", label:"Área cliente", icon:"users", badge:()=>CRM.CUENTAS_PENDIENTES.length},
  {id:"pipeline", label:"Pipeline", icon:"pipeline"},
  {id:"tareas", label:"Tareas", icon:"task"},
  {id:"whatsapp", label:"WhatsApp", icon:"whatsapp", badge:()=>CRM.WHATSAPP.reduce((a,w)=>a+w.unread,0)},
  {id:"inbox", label:"Bandeja de entrada", icon:"mail", badge:()=>CRM.EMAILS.filter(e=>!e.archived&&CRM.unreadOf(e)).length},
  {id:"documents", label:"Documentos", icon:"documents"},
  {id:"automations", label:"Automatizaciones", icon:"automations"},
  {id:"config", label:"Configuración", icon:"settings"}
];
function Shell({user, view, nav, onLogout, children, title, crumb}){
  const [drawerOpen,setDrawerOpen]=uState(false);
  // Drawer móvil (<=820px, ver styles.css): se cierra solo, con Escape, al
  // elegir una sección o si la ventana crece por encima del breakpoint
  // (p. ej. al rotar un móvil grande a horizontal) — y bloquea el scroll del
  // body mientras está abierto. Por encima del breakpoint nunca llega a
  // abrirse (el botón que lo abre está oculto por CSS), así que nada de esto
  // toca el comportamiento de escritorio.
  uEffect(()=>{
    if(!drawerOpen) return;
    const onKey = e=>{ if(e.key==="Escape") setDrawerOpen(false); };
    const onResize = ()=>{ if(window.innerWidth>MOBILE_BREAKPOINT) setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    document.body.classList.add("no-scroll");
    return ()=>{
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      document.body.classList.remove("no-scroll");
    };
  },[drawerOpen]);
  const goTo=(id)=>{ nav(id); setDrawerOpen(false); };
  return (
    <div className="app">
      {drawerOpen && <div className="sb-overlay" onClick={()=>setDrawerOpen(false)}></div>}
      <aside className={"sidebar"+(drawerOpen?" open":"")}>
        <div className="sb-brand"><span className="sb-brand__logo">GUIMAES</span><span className="sb-brand__dot"></span></div>
        <div className="sb-tag">CRM interno</div>
        <nav className="sb-nav">
          {NAV.map(n=>{
            const b = n.badge && n.badge();
            return <a key={n.id} className={"sb-item"+(view===n.id?" active":"")} onClick={()=>goTo(n.id)}>
              <Icon name={n.icon} size={18}/>{n.label}{b?<span className="sb-item__badge">{b}</span>:null}
            </a>;
          })}
        </nav>
        <div className="sb-user">
          <Avatar name={user.name} size="md" color={user.color}/>
          <div className="sb-user__meta"><div className="sb-user__name">{user.name}</div><div className="sb-user__role">{user.title}</div></div>
          <button className="sb-user__out" onClick={onLogout} title="Cerrar sesión"><Icon name="logout" size={17}/></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="sb-toggle" onClick={()=>setDrawerOpen(true)} aria-label="Abrir menú"><Icon name="list" size={20}/></button>
          <div><div className="topbar__title">{title}</div>{crumb && <div className="topbar__crumb">{crumb}</div>}</div>
          <div className="topbar__search"><Icon name="search" size={16}/><input placeholder="Buscar contactos, deals…"/></div>
          {/* Provisional: hasta que exista un panel de notificaciones real, el
              icono solo abre Configuración → Notificaciones (donde ya se
              gestiona la suscripción push). */}
          <button className="topbar__icon" title="Notificaciones" onClick={()=>nav("config","notificaciones")}><Icon name="bell" size={18}/></button>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ============ HOME ============ */
function Home({user, nav}){
  const k = CRM.computeKpis(CRM.DEALS);
  const myTasks = CRM.TASKS.filter(t=>t.owner===user.id && t.status!=="done");
  const recent = CRM.CONTACTS.slice().sort((a,b)=>b.created.localeCompare(a.created)).slice(0,5);
  const kpis = [
    {label:"MRR (recurrente/mes)", icon:"euro", val:CRM.fmtEUR(k.mrr), delta:"+8,2%", up:true},
    {label:"ARR estimado", icon:"trend", val:CRM.fmtEUR(k.arr), delta:"+11%", up:true},
    {label:"Deals abiertos", icon:"pipeline", val:k.openDeals, delta:"+3", up:true},
    {label:"Valor pipeline", icon:"target", val:CRM.fmtEUR(k.pipeline), delta:"-2,1%", up:false}
  ];
  const byStage = CRM.STAGES.filter(s=>s.id!=="perdido").map(s=>({s, n:CRM.DEALS.filter(d=>d.stage===s.id).length}));
  const maxN = Math.max(...byStage.map(x=>x.n),1);
  return (
    <div className="content">
      <div className="kpi-grid">
        {kpis.map((x,i)=>(
          <div key={i} className="kpi">
            <div className="kpi__label"><Icon name={x.icon} size={15}/>{x.label}</div>
            <div className="kpi__val mono">{x.val}</div>
            <div className={"kpi__delta "+(x.up?"up":"down")}><Icon name={x.up?"up":"down"} size={13}/>{x.delta} <span className="muted" style={{fontWeight:400}}>vs mes anterior</span></div>
          </div>
        ))}
      </div>
      <div className="grid-2" style={{marginTop:18,alignItems:"start"}}>
        <div className="card">
          <div className="card__head"><Icon name="task" size={17} style={{color:"var(--accent)"}}/><h3>Mis tareas</h3><span className="right badge" style={{background:"var(--accent-soft)",color:"var(--accent-ink)"}}>{myTasks.length}</span></div>
          <div className="card__body" style={{paddingTop:6}}>
            {myTasks.length? myTasks.map(t=>(
              <div key={t.id} className="lrow">
                <div className="tcheck"></div>
                <div className="lrow__main"><div className="lrow__title">{t.title}</div><div className="lrow__sub">Vence {t.due} · {CRM.contactById[t.contact]?.company}</div></div>
                <PriorityDot id={t.priority}/>
              </div>
            )) : <Empty icon="check" title="Sin tareas pendientes" sub="Estás al día."/>}
          </div>
        </div>
        <div className="card">
          <div className="card__head"><Icon name="contacts" size={17} style={{color:"var(--accent)"}}/><h3>Leads recientes</h3><button className="right btn btn--sm btn--subtle" onClick={()=>nav("contacts")}>Ver todos</button></div>
          <div className="card__body" style={{paddingTop:6}}>
            {recent.map(c=>(
              <div key={c.id} className="lrow" style={{cursor:"pointer"}} onClick={()=>nav("contact",c.id)}>
                <Avatar name={c.company} size="md" color={CRM.colorFor(c.company)}/>
                <div className="lrow__main"><div className="lrow__title">{c.company}</div><div className="lrow__sub">{c.full_name} · {c.source}</div></div>
                <LifecycleBadge id={c.lifecycle}/>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{marginTop:18}}>
        <div className="card__head"><Icon name="pipeline" size={17} style={{color:"var(--accent)"}}/><h3>Pipeline por etapa</h3><button className="right btn btn--sm btn--subtle" onClick={()=>nav("pipeline")}>Abrir pipeline</button></div>
        <div className="card__body">
          <div className="stage-chart" style={{display:"flex",gap:10,alignItems:"flex-end",height:120}}>
            {byStage.map(({s,n})=>(
              <div key={s.id} className="stage-col" style={{flex:1,textAlign:"center"}}>
                <div style={{height:80,display:"flex",alignItems:"flex-end"}}><div style={{width:"100%",background:s.color,height:(n/maxN*80||3)+"px",borderRadius:"6px 6px 0 0"}}></div></div>
                <div style={{fontWeight:700,fontFamily:"var(--display)",marginTop:6}}>{n}</div>
                <div className="muted stage-label" style={{fontSize:11.5,lineHeight:1.2}}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ EMPRESAS ============ */
// La relación contacto↔empresa se edita SOLO desde el contacto (ver
// EditContact) — esta vista y la ficha de abajo son de solo lectura sobre
// esa relación, para que haya un único sitio donde cambiarla.
function Empresas({nav, toast}){
  const [q,setQ]=uState("");
  const [showNew,setShowNew]=uState(false);
  const isMobile = useIsMobile();
  const list = CRM.EMPRESAS.filter(e=>q===""||(e.razon_social+" "+e.cif).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="content">
      <div className="toolbar">
        <div className="searchbox"><Icon name="search" size={16}/><input placeholder="Buscar por razón social o CIF…" value={q} onChange={e=>setQ(e.target.value)}/></div>
        <div className="toolbar__spacer"></div>
        <button className="btn btn--primary" onClick={()=>setShowNew(true)}><Icon name="plus" size={16}/>Nueva empresa</button>
      </div>
      {isMobile ? (
        <div className="wrap-gap">
          {list.map(e=>(
            <div key={e.id} className="card" style={{cursor:"pointer"}} onClick={()=>nav("empresa",e.id)}>
              <div className="card__body" style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                <Avatar name={e.razon_social} size="md" color={CRM.colorFor(e.razon_social)}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:14}}>{e.razon_social}</div>
                  <div className="muted" style={{fontSize:12.5,marginTop:2}}>{e.cif || "Sin CIF"}</div>
                  <div className="muted" style={{fontSize:12.5,marginTop:4}}>{CRM.contactsForEmpresa(e.id).length} contacto(s)</div>
                </div>
              </div>
            </div>
          ))}
          {list.length===0 && <Empty icon="building" title="Sin resultados" sub="Prueba con otro filtro o búsqueda."/>}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Razón social</th><th>CIF</th><th>Contactos</th></tr></thead>
            <tbody>
              {list.map(e=>(
                <tr key={e.id} onClick={()=>nav("empresa",e.id)}>
                  <td><div className="row"><Avatar name={e.razon_social} size="md" color={CRM.colorFor(e.razon_social)}/><div className="tbl__name">{e.razon_social}</div></div></td>
                  <td className="tbl__sub">{e.cif || "—"}</td>
                  <td>{CRM.contactsForEmpresa(e.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length===0 && <Empty icon="building" title="Sin resultados" sub="Prueba con otro filtro o búsqueda."/>}
        </div>
      )}
      {showNew && <NewEmpresa nav={nav} onClose={()=>setShowNew(false)} onSave={async(payload)=>{
        try{
          const r = await CRM.createEmpresaConContacto(Auth.client, payload);
          setShowNew(false);
          toast(r.dealError ? "Empresa y contacto creados — el deal no se pudo crear: "+r.dealError : "Empresa creada");
          if(r.empresa) nav("empresa", r.empresa.id);
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
    </div>
  );
}
// Modal guiado: empresa (nueva o reutilizada vía EmpresaPicker) + contacto
// (obligatorio, nuevo o existente) + deal (opcional). La orquestación real
// (orden, fallos parciales) vive en CRM.createEmpresaConContacto — este
// componente solo recoge las elecciones y se las pasa.
function NewEmpresa({nav, onClose, onSave}){
  const [empresaChoice,setEmpresaChoice]=uState(null);
  const [cifConflict,setCifConflict]=uState(null);
  const [extra,setExtra]=uState({address:"",city:"",province:""});
  const [contactMode,setContactMode]=uState("new");
  const [newContact,setNewContact]=uState({full_name:"",email:"",phone:""});
  const [contactQuery,setContactQuery]=uState("");
  const [existingContactId,setExistingContactId]=uState("");
  const [addDealToggle,setAddDealToggle]=uState(false);
  const [deal,setDeal]=uState({title:"",service:"",amount:"",frequency:""});
  const [saving,setSaving]=uState(false);

  const setExtraField=(k)=>(e)=>setExtra({...extra,[k]:e.target.value});
  const setNewContactField=(k)=>(e)=>setNewContact({...newContact,[k]:e.target.value});
  const setDealField=(k)=>(e)=>setDeal({...deal,[k]:e.target.value});
  const contactMatches = (contactMode==="existing" && contactQuery.trim())
    ? CRM.CONTACTS.filter(c=>(c.full_name+" "+c.company+" "+c.email).toLowerCase().includes(contactQuery.trim().toLowerCase())).slice(0,8)
    : [];

  const canSave = !!empresaChoice && !cifConflict
    && (contactMode==="new" ? newContact.full_name.trim() : !!existingContactId)
    && !saving;

  const save=async()=>{
    if(!canSave) return;
    setSaving(true);
    try{
      const empresaChoicePayload = empresaChoice.mode==="new"
        ? {mode:"new", razon_social:empresaChoice.razon_social, cif:empresaChoice.cif, address:extra.address||null, city:extra.city||null, province:extra.province||null}
        : {mode:"existing", empresaId:empresaChoice.empresa.id};
      const contactChoicePayload = contactMode==="new"
        ? {mode:"new", fields:{...newContact}}
        : {mode:"existing", contactId:existingContactId};
      await onSave({empresaChoice:empresaChoicePayload, contactChoice:contactChoicePayload, dealFields: addDealToggle ? deal : null});
    }
    finally{ setSaving(false); }
  };

  return <Modal title="Nueva empresa" wide onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={!canSave}>{saving?"Creando…":"Crear empresa"}</button></>}>
    <div className="fld__l" style={{marginBottom:8}}>Empresa</div>
    {empresaChoice ? <EmpresaChoiceSummary choice={empresaChoice} onChange={c=>{setEmpresaChoice(c); setCifConflict(null);}}/> : <EmpresaPicker onPick={setEmpresaChoice} onCifConflict={setCifConflict}/>}
    {cifConflict && <div className="row" style={{gap:8,background:"var(--warn-soft)",color:"var(--warn)",padding:"10px 14px",borderRadius:9,marginBottom:14,fontSize:13}}>
      <Icon name="bell" size={15}/>
      <span style={{flex:1}}>Ya existe una empresa con ese CIF: <strong>{cifConflict.razon_social}</strong>.</span>
      <button className="btn btn--sm btn--ghost" onClick={()=>{ nav("empresa", cifConflict.id); onClose(); }}>Abrir su ficha</button>
    </div>}
    {empresaChoice && empresaChoice.mode==="new" && <>
      <Field label="Dirección (opcional)"><input className="inp" value={extra.address} onChange={setExtraField("address")}/></Field>
      <div className="fld-row">
        <Field label="Ciudad (opcional)"><input className="inp" value={extra.city} onChange={setExtraField("city")}/></Field>
        <Field label="Provincia (opcional)"><input className="inp" value={extra.province} onChange={setExtraField("province")}/></Field>
      </div>
    </>}

    <div className="fld__l" style={{marginTop:18,marginBottom:8}}>Contacto</div>
    <div className="row" style={{gap:8,marginBottom:12}}>
      <button className={"chip"+(contactMode==="new"?" active":"")} onClick={()=>setContactMode("new")}>Contacto nuevo</button>
      <button className={"chip"+(contactMode==="existing"?" active":"")} onClick={()=>setContactMode("existing")}>Contacto existente</button>
    </div>
    {contactMode==="new" ? (
      <div className="fld-row">
        <Field label="Persona de contacto"><input className="inp" placeholder="Nombre y apellidos" value={newContact.full_name} onChange={setNewContactField("full_name")}/></Field>
        <Field label="Email"><input className="inp" placeholder="email@empresa.es" value={newContact.email} onChange={setNewContactField("email")}/></Field>
      </div>
    ) : existingContactId ? (
      <div className="muted" style={{fontSize:12.5,margin:"0 0 12px",display:"flex",alignItems:"center",gap:8}}>
        <span>Contacto: <strong>{CRM.contactById[existingContactId]?.full_name || CRM.contactById[existingContactId]?.company}</strong></span>
        <button className="btn btn--sm btn--ghost" onClick={()=>setExistingContactId("")}>Cambiar</button>
      </div>
    ) : <>
      <Field label="Buscar contacto"><input className="inp" placeholder="Nombre, empresa o email…" value={contactQuery} onChange={e=>setContactQuery(e.target.value)}/></Field>
      {contactMatches.length>0 && <div style={{margin:"-8px 0 12px",display:"flex",flexDirection:"column",gap:4}}>
        {contactMatches.map(c=>(
          <button key={c.id} className="btn btn--sm btn--ghost" style={{justifyContent:"flex-start"}} onClick={()=>{setExistingContactId(c.id); setContactQuery("");}}>{c.full_name||"—"} · {c.company}</button>
        ))}
      </div>}
    </>}

    <div className="fld__l" style={{marginTop:18,marginBottom:8}}>Deal (opcional)</div>
    {!addDealToggle ? (
      <button className="btn btn--sm btn--ghost" onClick={()=>setAddDealToggle(true)}><Icon name="plus" size={14}/>Añadir un deal</button>
    ) : <>
      <div className="fld-row">
        <Field label="Título"><input className="inp" value={deal.title} onChange={setDealField("title")}/></Field>
        <Field label="Servicio"><select className="inp" value={deal.service} onChange={setDealField("service")}><option value="">— Sin especificar —</option>{CRM.SERVICES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      </div>
      <div className="fld-row">
        <Field label="Importe (€)"><input className="inp" type="number" placeholder="0" value={deal.amount} onChange={setDealField("amount")}/></Field>
        <Field label="Frecuencia"><select className="inp" value={deal.frequency} onChange={setDealField("frequency")}><option value="">— Sin especificar —</option><option value="mensual">Mensual</option><option value="puntual">Puntual</option></select></Field>
      </div>
      <button className="btn btn--sm btn--ghost" onClick={()=>setAddDealToggle(false)}>Quitar deal</button>
    </>}
  </Modal>;
}
/* ============ DOCUMENTOS — piezas compartidas ============ */
// Vista Documentos, pestaña de la ficha de contacto y pestaña de la ficha de
// empresa. Los datos se piden al vuelo (ver "Documentos y carpetas" en
// crm/data.js); las reglas de carpetas viven en la BD
// (crm/supabase-carpetas.sql) y aquí solo se reflejan.

// Descarga con URL firmada. Mismo patrón que WaDocumentAttachment: la
// pestaña se abre en blanco SÍNCRONO dentro del click, antes de cualquier
// await — si se abriera después, Safari/iOS la bloquean por haber perdido
// el gesto de usuario. Devuelve [download, idDescargando].
function useDocDownload(toast){
  const [busyId,setBusyId]=uState(null);
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
// Nombre a mostrar: original_filename o, si no hay (adjuntos de WhatsApp
// sin nombre), uno descriptivo compuesto al vuelo — ver CRM.docDisplayName.
const docName = (doc)=>CRM.docDisplayName(doc);
const docContactLabel = (contactId)=>{ const c=contactId && CRM.contactById[contactId]; return c ? (c.full_name||c.company||"—") : null; };
const docEmpresaLabel = (empresaId)=>{ const e=empresaId && CRM.empresaById[empresaId]; return e ? e.razon_social : null; };
// "Aportado por X": el contacto que lo mandó (adjuntos de WhatsApp). Los
// subidos por un admin no tienen contacto que lo aportara.
const docAportadoLabel = (doc)=>{ const n=docContactLabel(doc.aportado_por); return n ? "Aportado por "+n : null; };
// Estado del fichero cuando no está listo para descargar. Un manual siempre
// es 'stored' (lo impone la BD); los demás estados son de adjuntos de WhatsApp.
function DocStatusBadge({doc}){
  if(doc.status==="pending") return <Badge label="Descargando de WhatsApp…" color="#D9822B"/>;
  if(doc.status==="failed") return <Badge label="No se pudo descargar" color="#D64545"/>;
  if(doc.status==="too_large") return <Badge label="Demasiado grande" color="#6E8298"/>;
  return null;
}
function DocSourceBadge({doc}){
  if(doc.source==="whatsapp") return <Badge label="WhatsApp" color="#1F9D6B"/>;
  if(doc.source==="cliente") return <Badge label="Cliente" color="#7C5CFC"/>;
  return null;
}
// Interruptor accesible (role="switch"): el nombre accesible es "label".
function Switch({checked, onChange, disabled, label}){
  return <button type="button" role="switch" aria-checked={!!checked} aria-label={label} title={label}
    className={"switch-sm"+(checked?" on":"")} disabled={disabled} onClick={()=>onChange(!checked)}>
    <span className="switch-sm__dot"></span>
  </button>;
}
// "Compartido por Ana el 8/10/2026" (shared_by es admins.id). Null si no se comparte.
const docShareLabel = (doc)=>{
  if(!doc.visible || doc.source==="cliente") return null;
  const quien = doc.shared_by && CRM.userById(doc.shared_by);
  const cuando = doc.shared_at ? new Date(doc.shared_at).toLocaleDateString("es-ES") : null;
  return "Compartido"+(quien?" por "+quien.name:"")+(cuando?" el "+cuando:"");
};
function DocShareBadge({doc}){
  const label = docShareLabel(doc);
  return label ? <span className="doc-shared" title={label}><Icon name="eye" size={12}/>{label}</span> : null;
}
// Compartir con el cliente desde una lista. No aplica a lo que aporta el
// propio cliente (lo ve siempre) ni a un adjunto que aún no está guardado
// (el área cliente solo enseña documentos 'stored').
function useDocShare(toast, onUpdated){
  const [sharingId,setSharingId]=uState(null);
  const toggle=async(doc, visible)=>{
    setSharingId(doc.id);
    try{
      const upd = await CRM.setDocumentoVisible(Auth.client, doc, visible);
      toast(visible ? "Compartido con el cliente" : "Ya no se comparte con el cliente");
      onUpdated(upd);
    }catch(e){ toast("No se pudo cambiar: "+CRM.docErrorMessage(e)); }
    finally{ setSharingId(null); }
  };
  return [toggle, sharingId];
}
// Botones de una fila de documento. onPreview/onRename/onMove/onDelete
// opcionales: quien no los pase no los muestra. "Ver" solo aparece si el
// navegador puede pintarlo (CRM.docPreviewKind: imagen o PDF); para el
// resto (docx, xlsx, zip…) queda solo la descarga. Borrar no se ofrece
// mientras el adjunto se está descargando ('pending'): la descarga en
// segundo plano subiría el fichero después y quedaría huérfano.
function DocActions({doc, onDownload, downloading, onPreview, onRename, onMove, onDelete, onToggleShare, sharing}){
  const compartible = onToggleShare && doc.source!=="cliente";
  return <div className="row doc-actions" style={{gap:4}}>
    {compartible && <span className="doc-share">
      <Switch checked={doc.visible} disabled={sharing || doc.status!=="stored"} onChange={(v)=>onToggleShare(doc, v)}
        label={doc.status!=="stored" ? "Solo se pueden compartir documentos ya guardados" : doc.visible ? "Dejar de compartir con el cliente" : "Compartir con el cliente"}/>
    </span>}
    {onPreview && CRM.docPreviewKind(doc) && <button className="btn btn--sm btn--ghost" title="Ver" onClick={()=>onPreview(doc)}><Icon name="eye" size={14}/></button>}
    <button className="btn btn--sm btn--ghost" title={doc.status==="stored"?"Descargar":"No disponible"} onClick={()=>onDownload(doc)} disabled={doc.status!=="stored" || downloading}><Icon name="download" size={14}/></button>
    {onRename && doc.status!=="pending" && <button className="btn btn--sm btn--ghost" title="Renombrar" onClick={()=>onRename(doc)}><Icon name="edit" size={14}/></button>}
    {onMove && <button className="btn btn--sm btn--ghost" title="Mover a otra carpeta" onClick={()=>onMove(doc)}><Icon name="folder" size={14}/></button>}
    {onDelete && doc.status!=="pending" && <button className="btn btn--sm btn--ghost" title="Eliminar" onClick={()=>onDelete(doc)}><Icon name="trash" size={14}/></button>}
  </div>;
}

// Visor dentro del CRM con la URL firmada (sin "download", para que Storage
// lo sirva inline). Imagen: <img>. PDF: <iframe> en escritorio; en móvil
// no — Chrome de Android no pinta PDF dentro de un iframe y Safari de iOS
// lo hace a medias, así que se ofrece abrirlo en el visor nativo del móvil
// (enlace normal, sin bloqueo de ventanas emergentes). Solo se abre para
// los tipos que devuelve CRM.docPreviewKind; el resto no llega aquí.
function DocPreviewModal({doc, onClose, onDownload, downloading}){
  const kind = CRM.docPreviewKind(doc);
  const isMobile = useIsMobile();
  const [url,setUrl]=uState(null); const [failed,setFailed]=uState(false);
  uEffect(()=>{
    let alive=true;
    setUrl(null); setFailed(false);
    CRM.getAttachmentSignedUrl(Auth.client, doc.id).then(u=>{ if(!alive) return; if(u) setUrl(u); else setFailed(true); });
    return ()=>{alive=false;};
  },[doc.id]);
  const name = docName(doc);
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

// Renombrar un documento: solo cambia original_filename (CRM.renombrarDocumento).
// La extensión es la del fichero real y no se edita: se muestra fija junto
// al campo. Un adjunto de WhatsApp sin nombre parte del nombre descriptivo
// que ya se ve en pantalla.
function RenameDocModal({doc, onClose, onRenamed, toast}){
  const ext = CRM.docExtension(doc);
  const initial = CRM.documentoNombreFinal(doc, doc.original_filename || docName(doc)).base;
  const [base,setBase]=uState(initial);
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const issue = CRM.documentoNombreIssue(doc, base);
  const final = CRM.documentoNombreFinal(doc, base).full;
  // Sin cambios también si es el nombre descriptivo tal cual: guardarlo
  // escribiría en la BD un nombre que nadie eligió.
  const unchanged = final===CRM.docDownloadName(doc);
  const go=async()=>{
    if(issue || unchanged) return;
    setBusy(true); setErr(null);
    try{
      const updated = await CRM.renombrarDocumento(Auth.client, doc, base);
      toast("Documento renombrado");
      onRenamed(updated);
    }catch(e){ setErr(CRM.docErrorMessage(e)); setBusy(false); }
  };
  return <Modal title="Renombrar documento" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--primary" onClick={go} disabled={busy||!!issue||unchanged}>{busy?"Guardando…":"Guardar"}</button></>}>
    <Field label="Nombre"><div className="inp-suffix">
      <input className="inp" autoFocus value={base} onChange={e=>{setBase(e.target.value); setErr(null);}} onKeyDown={e=>{ if(e.key==="Enter") go(); }}/>
      {ext && <span className="inp-suffix__ext">.{ext}</span>}
    </div></Field>
    {base.trim() && issue && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:-8}}>{issue}</p>}
    {err && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:-8}}>{err}</p>}
    {ext && <p className="muted" style={{fontSize:12.5}}>La extensión no se puede cambiar: el fichero sigue siendo .{ext}.</p>}
  </Modal>;
}

// Confirmación de borrado de un documento (fila primero, fichero después —
// ver CRM.borrarDocumento).
function DeleteDocModal({doc, onClose, onDeleted, toast}){
  const [busy,setBusy]=uState(false);
  const go=async()=>{
    setBusy(true);
    try{
      const r = await CRM.borrarDocumento(Auth.client, doc);
      toast(r.fileRemoved ? "Documento eliminado" : "Documento eliminado (el fichero no se pudo retirar del almacenamiento)");
      onDeleted(doc);
    }catch(e){
      toast("No se pudo eliminar: "+CRM.docErrorMessage(e));
      setBusy(false);
    }
  };
  return <Modal title="Eliminar documento" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--danger" onClick={go} disabled={busy}>{busy?"Eliminando…":"Eliminar definitivamente"}</button></>}>
    <p className="muted">Se eliminará <b>{docName(doc)}</b> y su fichero. Esta acción no se puede deshacer.</p>
    {doc.source==="whatsapp" && <p className="muted" style={{fontSize:12.5,marginTop:8}}>El mensaje seguirá en la conversación de WhatsApp, pero el adjunto dejará de estar disponible.</p>}
  </Modal>;
}

// Mover un documento: el destino es obligatorio (no existe "Sin carpeta")
// y puede ser una raíz o una subcarpeta. Por defecto, a otra carpeta de la
// misma empresa. "Mover a otra empresa" es para corregir un documento que
// acabó en la sociedad equivocada: la carpeta elegida decide la empresa
// (mover_documentos). Empresas ofrecidas: las del contacto que lo aportó y
// las del contexto (p. ej. las del contacto cuya ficha se está viendo) — no
// todas las del CRM, para que sacar un documento de una sociedad sea
// siempre hacia una relacionada.
function MoveDocModal({doc, carpetas, contextEmpresaIds, onClose, onMoved, toast}){
  const empresaIds = Array.from(new Set([doc.empresa_id,
    ...(doc.aportado_por ? CRM.empresasForContact(doc.aportado_por).map(x=>x.empresa.id) : []),
    ...(contextEmpresaIds||[])].filter(Boolean))).filter(id=>CRM.empresaById[id]);
  const [empresaId,setEmpresaId]=uState(doc.empresa_id);
  const [otras,setOtras]=uState(null); // carpetas de otra empresa elegida; null = cargando
  const [dest,setDest]=uState("");
  const [busy,setBusy]=uState(false);
  const otraEmpresa = empresaId!==doc.empresa_id;
  uEffect(()=>{
    if(!otraEmpresa) return;
    let alive=true; setOtras(null);
    CRM.loadCarpetasEmpresa(Auth.client, empresaId).then(ks=>{ if(alive) setOtras(ks); }).catch(e=>{ if(alive){ setOtras([]); toast("No se pudieron cargar las carpetas: "+CRM.docErrorMessage(e)); } });
    return ()=>{alive=false;};
  },[empresaId]);
  const lista = otraEmpresa ? (otras||[]) : carpetas;
  // "Aportados por el cliente" no es destino (solo admite lo que sube el cliente).
  const opciones = CRM.carpetaOpciones(lista.filter(k=>!k.is_cliente), otraEmpresa ? null : doc.folder_id);
  const go=async()=>{
    if(!dest) return;
    setBusy(true);
    try{
      await CRM.moverDocumentos(Auth.client, [doc.id], dest);
      const k = lista.find(x=>x.id===dest);
      toast("Movido a "+CRM.carpetaRuta(lista, k)+(otraEmpresa ? " de "+CRM.empresaById[empresaId].razon_social : ""));
      onMoved();
    }catch(e){
      toast("No se pudo mover: "+CRM.docErrorMessage(e));
      setBusy(false);
    }
  };
  const empresaActual = CRM.empresaById[doc.empresa_id];
  return <Modal title="Mover documento" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--primary" onClick={go} disabled={busy||!dest}>{busy?"Moviendo…":"Mover"}</button></>}>
    <p className="muted" style={{marginBottom:14}}><b>{docName(doc)}</b> está en <b>{doc.folder_path||doc.folder_name||"—"}</b>{empresaActual ? <> de <b>{empresaActual.razon_social}</b></> : null}.</p>
    {empresaIds.length>1 && <Field label="Empresa"><select className="inp" value={empresaId} onChange={e=>{ setEmpresaId(e.target.value); setDest(""); }} disabled={busy}>
      {empresaIds.map(id=><option key={id} value={id}>{CRM.empresaById[id].razon_social}{id===doc.empresa_id?" (actual)":""}</option>)}
    </select></Field>}
    {otraEmpresa && <p className="muted" style={{fontSize:12.5,marginTop:-8,marginBottom:12}}>El documento dejará de ser de {empresaActual ? empresaActual.razon_social : "su empresa actual"} y pasará a {CRM.empresaById[empresaId].razon_social}.</p>}
    {otraEmpresa && otras===null ? <div className="muted">Cargando carpetas…</div>
    : opciones.length ? <Field label="Carpeta destino"><select className="inp" value={dest} onChange={e=>setDest(e.target.value)} disabled={busy}>
      <option value="" disabled>— Elige carpeta —</option>
      {opciones.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
    </select></Field> : <p className="muted">{otraEmpresa ? "Esa empresa no tiene carpetas." : "Esta empresa no tiene otra carpeta. Crea una primero."}</p>}
  </Modal>;
}

// Crear o renombrar carpeta. Valida antes de enviar con el mismo criterio
// que la BD (CRM.carpetaNombreIssue); "carpetas" son las HERMANAS de la
// carpeta (la unicidad de nombre es entre hermanas). Si aun así la BD
// rechaza (p. ej. otra persona creó el mismo nombre a la vez), se muestra
// su error traducido.
function FolderNameModal({title, initial, carpetas, exceptId, note, onClose, onSave}){
  const [nombre,setNombre]=uState(initial||"");
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const issue = CRM.carpetaNombreIssue(nombre, carpetas, exceptId);
  const unchanged = initial!=null && nombre.trim()===initial.trim();
  const go=async()=>{
    if(issue || unchanged) return;
    setBusy(true); setErr(null);
    try{ await onSave(nombre.trim()); }
    catch(e){ setErr(CRM.docErrorMessage(e)); setBusy(false); }
  };
  return <Modal title={title} onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--primary" onClick={go} disabled={busy||!!issue||unchanged}>{busy?"Guardando…":"Guardar"}</button></>}>
    <Field label="Nombre de la carpeta"><input className="inp" autoFocus maxLength={60} value={nombre} onChange={e=>{setNombre(e.target.value); setErr(null);}} onKeyDown={e=>{ if(e.key==="Enter") go(); }}/></Field>
    {nombre.trim() && issue && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:-8}}>{issue}</p>}
    {err && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:-8}}>{err}</p>}
    {note && <p className="muted" style={{fontSize:12.5,marginTop:8}}>{note}</p>}
  </Modal>;
}

// Mover una subcarpeta a otra carpeta raíz (RPC mover_carpeta). Sus
// documentos van con ella. Destinos: las raíces que admiten subcarpetas
// (no WhatsApp), salvo la actual. Si una ya tiene una subcarpeta con el
// mismo nombre se ofrece deshabilitada y explicando por qué: no se fusiona
// nada. La BD repite la comprobación por si alguien la crea a la vez.
function MoveFolderModal({folder, carpetas, onClose, onMoved, toast}){
  const mismoNombre = (a,b)=>a.trim().toLowerCase()===b.trim().toLowerCase();
  const destinos = CRM.carpetaRaices(carpetas).filter(r=>r.admite_subcarpetas && r.id!==folder.parent_id)
    .map(r=>({r, choca: CRM.carpetaHijas(carpetas, r.id).some(h=>mismoNombre(h.nombre, folder.nombre))}));
  const madre = carpetas.find(k=>k.id===folder.parent_id);
  const [dest,setDest]=uState("");
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const go=async()=>{
    if(!dest) return;
    setBusy(true); setErr(null);
    try{
      await CRM.moverCarpeta(Auth.client, folder.id, dest);
      toast("«"+folder.nombre+"» movida a "+(carpetas.find(k=>k.id===dest)||{}).nombre);
      onMoved();
    }catch(e){ setErr(CRM.docErrorMessage(e)); setBusy(false); }
  };
  return <Modal title="Mover subcarpeta" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--primary" onClick={go} disabled={busy||!dest}>{busy?"Moviendo…":"Mover"}</button></>}>
    <p className="muted" style={{marginBottom:14}}><b>{folder.nombre}</b> está dentro de <b>{madre ? madre.nombre : "—"}</b>. Sus documentos se mueven con ella.</p>
    {destinos.length ? <Field label="Mover dentro de"><select className="inp" value={dest} onChange={e=>{ setDest(e.target.value); setErr(null); }} disabled={busy}>
      <option value="" disabled>— Elige carpeta —</option>
      {destinos.map(({r,choca})=><option key={r.id} value={r.id} disabled={choca}>{r.nombre}{choca ? " — ya tiene «"+folder.nombre+"»" : ""}</option>)}
    </select></Field> : <p className="muted">No hay otra carpeta raíz que admita subcarpetas.</p>}
    {destinos.some(x=>x.choca) && <p className="muted" style={{fontSize:12.5,marginTop:-8}}>Las carpetas que ya tienen una subcarpeta con este nombre no se pueden elegir: renombra una de las dos antes. No se fusionan.</p>}
    {err && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:8}}>{err}</p>}
  </Modal>;
}

// Borrar carpeta. Vacía: confirmación. Con documentos: destino obligatorio
// (borrar_carpeta los mueve y borra en una transacción), cualquier carpeta
// de la empresa en cualquier nivel; si es una subcarpeta, su madre viene
// preseleccionada. No llegan aquí la WhatsApp con documentos ni una carpeta
// con subcarpetas: el botón no se ofrece.
function DeleteFolderModal({folder, count, carpetas, onClose, onDeleted, toast}){
  const opciones = CRM.carpetaOpciones(carpetas.filter(k=>!k.is_cliente), folder.id);
  const [dest,setDest]=uState(folder.parent_id && opciones.some(o=>o.id===folder.parent_id) ? folder.parent_id : "");
  const [busy,setBusy]=uState(false);
  const needsDest = count>0;
  const ruta = CRM.carpetaRuta(carpetas, folder);
  const go=async()=>{
    if(needsDest && !dest) return;
    setBusy(true);
    try{
      await CRM.borrarCarpeta(Auth.client, folder.id, needsDest ? dest : null);
      toast("Carpeta eliminada");
      onDeleted();
    }catch(e){
      toast("No se pudo eliminar la carpeta: "+CRM.docErrorMessage(e));
      setBusy(false);
    }
  };
  return <Modal title="Eliminar carpeta" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--danger" onClick={go} disabled={busy||(needsDest && !dest)}>{busy?"Eliminando…":(needsDest?"Mover y eliminar":"Eliminar carpeta")}</button></>}>
    {!needsDest && <p className="muted">Se eliminará la carpeta <b>{ruta}</b>. Está vacía.</p>}
    {needsDest && <>
      <p className="muted" style={{marginBottom:14}}>La carpeta <b>{ruta}</b> tiene {count} documento{count===1?"":"s"}. Elige a qué carpeta moverlos antes de eliminarla.</p>
      {opciones.length ? <Field label="Mover los documentos a"><select className="inp" value={dest} onChange={e=>setDest(e.target.value)}>
        <option value="" disabled>— Elige carpeta —</option>
        {opciones.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
      </select></Field> : <p className="muted">No hay otra carpeta a la que moverlos. Crea una primero.</p>}
    </>}
  </Modal>;
}

// Subida manual (ver CRM.subirDocumentoManual: fichero primero, fila
// después, 'stored' directo). El límite de 15 MB se avisa al elegir el
// archivo, antes de intentar nada. supabase-js no da progreso de subida,
// así que se muestra un estado "Subiendo…" con barra indeterminada. El
// destino por defecto es la carpeta que se está viendo (raíz o subcarpeta).
function UploadDocModal({empresaId, carpetas, defaultFolderId, user, onClose, onUploaded, toast}){
  // "Aportados por el cliente" no se ofrece: es solo para lo que sube el cliente.
  const opciones = CRM.carpetaOpciones(carpetas.filter(k=>!k.is_cliente));
  const [file,setFile]=uState(null);
  const [folderId,setFolderId]=uState(opciones.some(o=>o.id===defaultFolderId) ? defaultFolderId : ((opciones[0]&&opciones[0].id) || ""));
  const [compartir,setCompartir]=uState(false);
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const tooBig = file && file.size>CRM.MAX_DOCUMENTO_BYTES;
  const go=async()=>{
    if(!file || tooBig || !folderId) return;
    setBusy(true); setErr(null);
    try{
      const uploadedBy = user && CRM.userById(user.id) ? user.id : null;
      const doc = await CRM.subirDocumentoManual(Auth.client, {file, empresaId, folderId, uploadedBy, visible: compartir});
      toast(compartir ? "Documento subido y compartido con el cliente" : "Documento subido");
      onUploaded(doc);
    }catch(e){
      setErr("No se pudo subir: "+CRM.docErrorMessage(e));
      setBusy(false);
    }
  };
  return <Modal title="Subir documento" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--primary" onClick={go} disabled={busy||!file||tooBig||!folderId}>{busy?"Subiendo…":"Subir"}</button></>}>
    <Field label="Archivo"><div className={"upload-drop"+(busy?" upload-drop--busy":"")}>
      <Icon name="upload" size={20}/>
      {file ? <span className="upload-drop__file"><b>{file.name}</b> · {CRM.fmtBytes(file.size)}</span> : <span>Arrastra un archivo o haz clic para elegirlo</span>}
      <span style={{fontSize:12}}>Máximo 15 MB</span>
      <input type="file" disabled={busy} style={{position:"absolute",inset:0,opacity:0,cursor:busy?"default":"pointer"}} onChange={e=>{ setFile(e.target.files && e.target.files[0] || null); setErr(null); }}/>
    </div></Field>
    {tooBig && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:-8}}>Este archivo ocupa {CRM.fmtBytes(file.size)} y el máximo es 15 MB. Comprímelo o divídelo antes de subirlo.</p>}
    <Field label="Carpeta"><select className="inp" value={folderId} onChange={e=>setFolderId(e.target.value)} disabled={busy}>
      {opciones.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
    </select></Field>
    <label className="check-row">
      <input type="checkbox" checked={compartir} onChange={e=>setCompartir(e.target.checked)} disabled={busy}/>
      <span><b>Compartir con el cliente</b><span className="muted" style={{display:"block",fontSize:12.5}}>Lo verán en el área cliente las cuentas vinculadas a esta empresa.</span></span>
    </label>
    {busy && <div className="upload-progress" role="progressbar" aria-label="Subiendo"><div className="upload-progress__bar"></div></div>}
    {err && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:8}}>{err}</p>}
  </Modal>;
}

// Documentos de una EMPRESA, en dos niveles. Las carpetas raíz son chips
// (con el total, incluidas sus subcarpetas); al abrir una raíz se ven sus
// subcarpetas como filas encima de los documentos sueltos; al abrir una
// subcarpeta, la cabecera muestra la ruta ("Fiscal › 2026") con vuelta a la
// raíz. No hay más niveles (lo garantiza la BD), así que no hace falta un
// árbol. La usan la ficha de empresa y la pestaña de la ficha de contacto
// (ContactDocsTab). onCount: total para el contador de la pestaña.
// contextEmpresaIds: otras empresas a las que se puede mover un documento.
function EmpresaDocs({empresaId, user, toast, onCount, contextEmpresaIds}){
  const [data,setData]=uState(null); // {carpetas, docs}; null = cargando
  const [loadErr,setLoadErr]=uState(null);
  const [sel,setSel]=uState(null); // carpeta abierta: raíz o subcarpeta
  const [modal,setModal]=uState(null); // {kind:"upload"|"new"|"newSub"|"rename"|"delFolder"|"moveFolder"|"move"|"delDoc"|"preview"|"renameDoc", doc?}
  const [download,busyId]=useDocDownload(toast);
  const [toggleShare,sharingId]=useDocShare(toast, (upd)=>setData(d=>d && {...d, docs:d.docs.map(x=>x.id===upd.id?{...upd, folder_path:x.folder_path, folder_root_name:x.folder_root_name}:x)}));
  const isMobile = useIsMobile();

  const reload=async()=>{
    try{
      const r = await CRM.loadDocumentosEmpresa(Auth.client, empresaId);
      setData(r); setLoadErr(null);
      if(onCount) onCount(r.docs.length);
      // Si la carpeta abierta ya no existe (borrada), vuelve a la primera raíz.
      const primera = CRM.carpetaRaices(r.carpetas)[0];
      setSel(s=> r.carpetas.some(k=>k.id===s) ? s : (primera ? primera.id : null));
    }catch(e){ setLoadErr(CRM.docErrorMessage(e)); }
  };
  uEffect(()=>{ setData(null); setSel(null); reload(); },[empresaId]);

  if(loadErr) return <div className="card"><div className="card__body"><Empty icon="documents" title="No se pudieron cargar los documentos" sub={loadErr} action={<button className="btn btn--sm btn--primary" onClick={reload}><Icon name="refresh" size={14}/>Reintentar</button>}/></div></div>;
  if(!data) return <div className="muted" style={{padding:16}}>Cargando documentos…</div>;

  const {carpetas, docs} = data;
  const raices = CRM.carpetaRaices(carpetas);
  const directos = (id)=>docs.filter(d=>d.folder_id===id).length;
  const total = (r)=>directos(r.id) + CRM.carpetaHijas(carpetas, r.id).reduce((a,h)=>a+directos(h.id),0);
  const folder = carpetas.find(k=>k.id===sel) || null;
  const esSub = !!(folder && folder.parent_id);
  const raiz = folder ? (esSub ? carpetas.find(k=>k.id===folder.parent_id) : folder) : null;
  const hijas = folder && !esSub ? CRM.carpetaHijas(carpetas, folder.id) : [];
  const folderDocs = folder ? docs.filter(d=>d.folder_id===folder.id) : [];
  const folderCount = folderDocs.length;
  const enHijas = hijas.reduce((a,h)=>a+directos(h.id),0);
  // Lo que la BD no deja hacer no se ofrece (y se explica):
  //   - una carpeta de sistema (WhatsApp, Aportados por el cliente) con
  //     documentos: ni renombrar ni borrar; "Aportados" no se renombra nunca;
  //   - una carpeta con subcarpetas: no se borra (hay que vaciarla antes);
  //   - subcarpetas solo en raíces que no sean WhatsApp;
  //   - mover solo subcarpetas, y solo si hay otra raíz que las admita.
  const lockedSistema = folder && !!folder.system_key && folderCount>0;
  const conHijas = hijas.length>0;
  const puedeRenombrar = folder && !lockedSistema && !folder.is_cliente;
  const puedeBorrar = folder && !lockedSistema && !conHijas;
  const puedeSubcarpeta = folder && !esSub && folder.admite_subcarpetas;
  const puedeMoverCarpeta = esSub && raices.some(r=>r.admite_subcarpetas && r.id!==folder.parent_id);
  const close=()=>setModal(null);
  const closeAndReload=()=>{ setModal(null); reload(); };
  const btnLabel = (txt)=> !isMobile && txt;

  return <div className="wrap-gap">
    <div className="doc-folders">
      {raices.map(k=><button key={k.id} className={"chip"+(raiz && raiz.id===k.id?" active":"")} onClick={()=>setSel(k.id)}>
        <Icon name={k.is_whatsapp?"whatsapp":k.is_cliente?"users":"folder"} size={14}/>{k.nombre}<span className="chip__count">{total(k)}</span>
      </button>)}
      <button className="chip" onClick={()=>setModal({kind:"new"})}><Icon name="plus" size={14}/>Nueva carpeta</button>
    </div>

    {!folder ? <div className="card"><div className="card__body"><Empty icon="folder" title="Sin carpetas" sub="Crea una carpeta para empezar a subir documentos." action={<button className="btn btn--sm btn--primary" onClick={()=>setModal({kind:"new"})}><Icon name="plus" size={14}/>Nueva carpeta</button>}/></div></div> :
    <div className="card">
      <div className="card__head doc-folder-head">
        {esSub ? <div className="doc-crumbs">
          <button className="btn btn--sm btn--ghost doc-crumbs__back" title={"Volver a "+raiz.nombre} aria-label={"Volver a "+raiz.nombre} onClick={()=>setSel(raiz.id)}><Icon name="chevronR" size={15} style={{transform:"rotate(180deg)"}}/></button>
          <a className="doc-link doc-crumbs__root" onClick={()=>setSel(raiz.id)}>{raiz.nombre}</a>
          <span className="doc-crumbs__sep" aria-hidden="true">›</span>
          <h3 className="doc-folder-head__title">{folder.nombre}</h3>
        </div> : <>
          <Icon name={folder.is_whatsapp?"whatsapp":folder.is_cliente?"users":"folder"} size={16} style={{color:"var(--accent)"}}/>
          <h3 className="doc-folder-head__title">{folder.nombre}</h3>
        </>}
        <div className="row doc-folder-head__actions" style={{gap:6}}>
          {puedeSubcarpeta && <button className="btn btn--sm btn--ghost" title="Nueva subcarpeta" onClick={()=>setModal({kind:"newSub"})}><Icon name="plus" size={14}/>{btnLabel("Subcarpeta")}</button>}
          {puedeRenombrar && <button className="btn btn--sm btn--ghost" title="Renombrar carpeta" onClick={()=>setModal({kind:"rename"})}><Icon name="edit" size={14}/>{btnLabel("Renombrar")}</button>}
          {puedeMoverCarpeta && <button className="btn btn--sm btn--ghost" title="Mover a otra carpeta" onClick={()=>setModal({kind:"moveFolder"})}><Icon name="folder" size={14}/>{btnLabel("Mover")}</button>}
          {puedeBorrar && <button className="btn btn--sm btn--ghost" title="Eliminar carpeta" onClick={()=>setModal({kind:"delFolder"})}><Icon name="trash" size={14}/>{btnLabel("Eliminar")}</button>}
          <button className="btn btn--sm btn--primary" onClick={()=>setModal({kind:"upload"})}><Icon name="upload" size={14}/>Subir documento</button>
        </div>
        {folder.is_cliente && <div className="doc-folder-head__note muted">Aquí llegan los documentos que sube el cliente desde el área cliente. No se puede renombrar ni subir aquí desde el CRM; sus documentos sí se pueden mover a otra carpeta.</div>}
        {lockedSistema && !folder.is_cliente && <div className="doc-folder-head__note muted">Carpeta del sistema: no se puede renombrar ni eliminar mientras tenga documentos. Puedes mover sus documentos a otra carpeta.</div>}
        {!lockedSistema && conHijas && <div className="doc-folder-head__note muted">No se puede eliminar mientras tenga subcarpetas: bórralas o muévelas a otra carpeta antes, una a una.</div>}
      </div>
      <div className="card__body" style={{paddingTop:4}}>
        {conHijas && <div className="muted doc-folder-summary">{folderCount} documento{folderCount===1?"":"s"} aquí · {enHijas} en subcarpetas</div>}
        {hijas.map(h=>{ const n=directos(h.id); return <button key={h.id} className="lrow doc-subfolder" onClick={()=>setSel(h.id)}>
          <div className="lrow__ico"><Icon name="folder" size={17}/></div>
          <div className="lrow__main">
            <div className="lrow__title doc-row__name" title={h.nombre}>{h.nombre}</div>
            <div className="lrow__sub">{n} documento{n===1?"":"s"}</div>
          </div>
          <Icon name="chevronR" size={16} style={{color:"var(--muted)",flex:"none"}}/>
        </button>; })}
        {folderDocs.map(d=><div key={d.id} className="lrow doc-row">
          <div className="lrow__ico"><Icon name="documents" size={17}/></div>
          <div className="lrow__main">
            <div className="lrow__title doc-row__name" title={docName(d)}>{docName(d)}</div>
            <div className="lrow__sub doc-row__meta">
              <span>{[CRM.fmtBytes(d.size_bytes), d.created, docAportadoLabel(d)].filter(Boolean).join(" · ")}</span>
              <DocSourceBadge doc={d}/><DocStatusBadge doc={d}/><DocShareBadge doc={d}/>
            </div>
          </div>
          <DocActions doc={d} onDownload={download} downloading={busyId===d.id}
            onToggleShare={toggleShare} sharing={sharingId===d.id}
            onPreview={(doc)=>setModal({kind:"preview", doc})}
            onRename={(doc)=>setModal({kind:"renameDoc", doc})}
            onMove={(doc)=>setModal({kind:"move", doc})}
            onDelete={(doc)=>setModal({kind:"delDoc", doc})}/>
        </div>)}
        {folderDocs.length===0 && !conHijas && <Empty icon="documents" title="Carpeta vacía" sub={folder.is_whatsapp ? "Aquí llegan los adjuntos de WhatsApp de los contactos que tienen esta empresa como principal." : folder.is_cliente ? "Aquí aparecerán los documentos que suba el cliente desde el área cliente." : null}/>}
      </div>
    </div>}

    {modal && modal.kind==="upload" && <UploadDocModal empresaId={empresaId} carpetas={carpetas} defaultFolderId={sel} user={user} toast={toast} onClose={close}
      onUploaded={(doc)=>{ setModal(null); if(doc.folder_id) setSel(doc.folder_id); reload(); }}/>}
    {modal && modal.kind==="new" && <FolderNameModal title="Nueva carpeta" carpetas={CRM.carpetaHermanas(carpetas, null)} onClose={close}
      onSave={async(nombre)=>{ const k = await CRM.crearCarpeta(Auth.client, empresaId, nombre); toast("Carpeta creada"); setModal(null); setSel(k.id); reload(); }}/>}
    {modal && modal.kind==="newSub" && folder && <FolderNameModal title={"Nueva subcarpeta en "+folder.nombre} carpetas={CRM.carpetaHijas(carpetas, folder.id)} onClose={close}
      onSave={async(nombre)=>{ await CRM.crearCarpeta(Auth.client, empresaId, nombre, folder.id); toast("Subcarpeta creada"); closeAndReload(); }}/>}
    {modal && modal.kind==="rename" && folder && <FolderNameModal title="Renombrar carpeta" initial={folder.nombre} carpetas={CRM.carpetaHermanas(carpetas, folder.parent_id)} exceptId={folder.id} onClose={close}
      note={folder.is_whatsapp ? "Al renombrarla dejará de ser la carpeta del sistema: los próximos adjuntos de WhatsApp irán a una carpeta \"WhatsApp\" nueva." : null}
      onSave={async(nombre)=>{ await CRM.renombrarCarpeta(Auth.client, folder.id, nombre); toast("Carpeta renombrada"); closeAndReload(); }}/>}
    {modal && modal.kind==="delFolder" && folder && <DeleteFolderModal folder={folder} count={folderCount} carpetas={carpetas} toast={toast} onClose={close}
      onDeleted={()=>{ setModal(null); setSel(folder.parent_id || null); reload(); }}/>}
    {modal && modal.kind==="moveFolder" && folder && <MoveFolderModal folder={folder} carpetas={carpetas} toast={toast} onClose={close} onMoved={closeAndReload}/>}
    {modal && modal.kind==="move" && <MoveDocModal doc={modal.doc} carpetas={carpetas} contextEmpresaIds={contextEmpresaIds} toast={toast} onClose={close} onMoved={closeAndReload}/>}
    {modal && modal.kind==="delDoc" && <DeleteDocModal doc={modal.doc} toast={toast} onClose={close} onDeleted={closeAndReload}/>}
    {modal && modal.kind==="preview" && <DocPreviewModal doc={modal.doc} onClose={close} onDownload={download} downloading={busyId===modal.doc.id}/>}
    {modal && modal.kind==="renameDoc" && <RenameDocModal doc={modal.doc} toast={toast} onClose={close} onRenamed={closeAndReload}/>}
  </div>;
}
// Pestaña "Documentos" de la ficha de contacto. Los documentos son de la
// empresa, no de la persona: se muestran los de su empresa principal y, si
// tiene varias, un selector para cambiar — el mismo patrón que tendrá el
// área de cliente.
function ContactDocsTab({contact, user, toast, onCount, nav}){
  const empresas = CRM.empresasForContact(contact.id).map(x=>x.empresa);
  const [empresaId,setEmpresaId]=uState(empresas[0] ? empresas[0].id : null);
  const actual = empresas.find(e=>e.id===empresaId) || empresas[0] || null;
  if(!actual) return <div className="card"><div className="card__body"><Empty icon="building" title="Sin empresa" sub="Los documentos se guardan en las carpetas de la empresa. Añade una empresa a este contacto desde «Editar ficha»."/></div></div>;
  return <div className="wrap-gap">
    <div className="row doc-empresa-bar" style={{gap:10,flexWrap:"wrap"}}>
      {empresas.length>1
        ? <select className="inp doc-filter" value={actual.id} onChange={e=>setEmpresaId(e.target.value)} aria-label="Empresa">
            {empresas.map((e,i)=><option key={e.id} value={e.id}>{e.razon_social}{i===0?" (principal)":""}</option>)}
          </select>
        : <span className="muted" style={{fontSize:13}}>Documentos de <b style={{color:"var(--ink)"}}>{actual.razon_social}</b></span>}
      <button className="btn btn--sm btn--ghost" onClick={()=>nav("empresa", actual.id)}><Icon name="building" size={14}/>Ver en la ficha de empresa</button>
    </div>
    <EmpresaDocs key={actual.id} empresaId={actual.id} user={user} toast={toast} onCount={onCount} contextEmpresaIds={empresas.map(e=>e.id)}/>
  </div>;
}
function EmpresaDetail({id, nav, toast, user}){
  const [,setTick]=uState(0); const bump=()=>setTick(t=>t+1);
  const e = CRM.empresaById[id];
  const [tab,setTab]=uState("contactos");
  const [showEdit,setShowEdit]=uState(false);
  // Total para el contador de la pestaña: lo informa EmpresaDocs al cargar
  // (null hasta entonces).
  const [docCount,setDocCount]=uState(null);
  uEffect(()=>{ setDocCount(null); },[id]);
  // Área cliente: solicitudes de cambio (razón social / CIF) y cambios que ha
  // hecho el cliente. Se cargan al abrir la ficha para el contador de la
  // pestaña; de paso se relee la empresa por si el cliente cambió su dirección.
  const [portal,setPortal]=uState(null); // {solicitudes, cambios} | {error}
  const cargarPortal=async()=>{
    try{
      const [solicitudes, cambios] = await Promise.all([CRM.loadSolicitudesEmpresa(Auth.client, id), CRM.loadCambiosEmpresa(Auth.client, id)]);
      setPortal({solicitudes, cambios});
    }catch(err){ setPortal({error: CRM.docErrorMessage(err), solicitudes:[], cambios:[]}); }
  };
  uEffect(()=>{ setPortal(null); cargarPortal(); CRM.refrescarEmpresa(Auth.client, id).then(bump); },[id]);
  const contactos = e ? CRM.contactsForEmpresa(id) : [];
  const deals = CRM.DEALS.filter(d=>d.empresa===id);
  const pendientesPortal = portal ? portal.solicitudes.filter(x=>x.estado==="pendiente").length : null;
  if(!e) return <div className="content"><Empty icon="building" title="Empresa no encontrada" sub="Puede que haya sido eliminada." action={<button className="btn btn--sm btn--primary" onClick={()=>nav("empresas")}>Volver a empresas</button>}/></div>;
  const tabs=[{id:"contactos",label:"Contactos",n:contactos.length},{id:"deals",label:"Deals",n:deals.length},{id:"docs",label:"Documentos",n:docCount},{id:"portal",label:"Área cliente",n:pendientesPortal||null}];
  return (
    <div className="content">
      <div className="row" style={{marginBottom:16}}><button className="btn btn--sm btn--ghost" onClick={()=>nav("empresas")}><Icon name="chevronR" size={15} style={{transform:"rotate(180deg)"}}/>Empresas</button></div>
      <div className="detail">
        <div className="detail__aside">
          <div className="profile">
            <div className="profile__top">
              <Avatar name={e.razon_social} size="lg" color={CRM.colorFor(e.razon_social)}/>
              <div><div className="profile__name">{e.razon_social}</div><div className="profile__sub">{e.cif || "Sin CIF"}</div></div>
            </div>
            <div style={{marginTop:16}}>
              <KV k="CIF/NIF">{e.cif || "—"}</KV>
              <KV k="Dirección">{e.address || "—"}</KV>
              <KV k="Ciudad">{e.city ? (e.city+(e.province?" ("+e.province+")":"")) : "—"}</KV>
              <KV k="Contactos">{contactos.length}</KV>
            </div>
            <button className="btn btn--sm btn--ghost" style={{width:"100%",marginTop:14}} onClick={()=>setShowEdit(true)}><Icon name="edit" size={15}/>Editar empresa</button>
          </div>
        </div>
        <div>
          <Tabs tabs={tabs} active={tab} onChange={setTab}/>
          {tab==="contactos" && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Contacto</th><th>Vínculo</th><th>Email</th><th>Teléfono</th></tr></thead><tbody>
            {contactos.map(c=>{
              const rel = CRM.empresasForContact(c.id).find(x=>x.empresa.id===id);
              return <tr key={c.id} style={{cursor:"pointer"}} onClick={()=>nav("contact",c.id)}>
                <td><div className="row"><Avatar name={c.full_name||c.company} size="md" color={CRM.colorFor(c.full_name||c.company)}/><span className="tbl__name">{c.full_name||c.company||"—"}</span></div></td>
                <td>{rel && rel.link.principal ? <Badge label="Principal" color="#1F6FEB"/> : <span className="muted" style={{fontSize:12.5}}>Secundaria</span>}</td>
                <td className="tbl__sub">{c.email}</td>
                <td className="tbl__sub">{c.phone}</td>
              </tr>;
            })}
          </tbody></table>{contactos.length===0 && <Empty icon="contacts" title="Sin contactos"/>}</div>}
          {tab==="deals" && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Deal</th><th>Contacto</th><th>Servicio</th><th>Etapa</th><th>Importe</th><th>Owner</th></tr></thead><tbody>
            {deals.map(d=>{
              const c = CRM.contactById[d.contact];
              return <tr key={d.id} style={{cursor:"pointer"}} onClick={()=>nav("deal",d.id)}>
                <td className="tbl__name">{d.title}</td>
                <td className="tbl__sub">{c ? (c.full_name||c.company) : "—"}</td>
                <td><ServiceBadge id={d.service}/></td>
                <td><StageBadge id={d.stage}/></td>
                <td className="mono">{CRM.fmtEUR(d.amount)} <span className="muted" style={{fontSize:11}}>/{d.frequency}</span></td>
                <td>{ownerAvatar(d.owner)}</td>
              </tr>;
            })}
          </tbody></table>{deals.length===0 && <Empty icon="briefcase" title="Sin deals"/>}</div>}
          {tab==="docs" && <EmpresaDocs empresaId={id} user={user} toast={toast} onCount={setDocCount}/>}
          {tab==="portal" && <EmpresaPortalTab empresa={e} portal={portal} toast={toast} onCambio={()=>{ cargarPortal(); bump(); }}/>}
        </div>
      </div>
      {showEdit && <EditEmpresa empresa={e} onClose={()=>setShowEdit(false)} onSave={async(patch)=>{
        try{
          await CRM.updateEmpresa(Auth.client, id, patch);
          setShowEdit(false);
          toast("Empresa actualizada");
          bump();
        }catch(err){
          toast("No se pudo actualizar: "+err.message);
        }
      }}/>}
    </div>
  );
}
// Ficha de empresa → "Área cliente": solicitudes de cambio de razón social o
// CIF (aplicar / rechazar) y el historial de lo que el cliente cambia
// directamente (dirección, ciudad, provincia).
const CAMPO_EMPRESA = {razon_social:"Razón social", cif:"CIF", address:"Dirección", city:"Ciudad", province:"Provincia"};
function EmpresaPortalTab({empresa, portal, toast, onCambio}){
  const [busyId,setBusyId]=uState(null);
  const [confirmar,setConfirmar]=uState(null); // {solicitud, aplicar}
  if(!portal) return <div className="muted" style={{padding:16}}>Cargando…</div>;
  if(portal.error) return <div className="card"><div className="card__body"><Empty icon="users" title="No se pudo cargar" sub={portal.error}/></div></div>;
  const pendientes = portal.solicitudes.filter(x=>x.estado==="pendiente");
  const resueltas = portal.solicitudes.filter(x=>x.estado!=="pendiente");
  const quien = (x)=> x.contacto ? (x.contacto.full_name || x.contacto.email) : "—";
  const fechaHora = (iso)=> iso ? new Date(iso).toLocaleString("es-ES", {dateStyle:"short", timeStyle:"short"}) : "—";
  const resolver=async()=>{
    const {solicitud, aplicar} = confirmar;
    setBusyId(solicitud.id);
    try{
      await CRM.resolverSolicitud(Auth.client, solicitud, aplicar);
      toast(aplicar ? CAMPO_EMPRESA[solicitud.campo]+" actualizado" : "Solicitud rechazada");
      setConfirmar(null); onCambio();
    }catch(err){ toast("No se pudo: "+err.message); }
    finally{ setBusyId(null); }
  };
  return <div className="wrap-gap">
    <div className="card"><div className="card__head"><h3>Solicitudes de cambio</h3></div><div className="card__body">
      {pendientes.length===0 ? <span className="muted">No hay solicitudes pendientes.</span>
      : pendientes.map(x=><div key={x.id} className="lrow" style={{alignItems:"flex-start",flexWrap:"wrap",gap:10}}>
          <div className="lrow__main" style={{minWidth:220}}>
            <div className="lrow__title">{CAMPO_EMPRESA[x.campo]}: <span className="muted" style={{textDecoration:"line-through"}}>{x.valor_actual||"—"}</span> → <b>{x.valor_solicitado}</b></div>
            <div className="lrow__sub">Pedido por {quien(x)} · {fechaHora(x.created_at)}{x.comentario ? " · «"+x.comentario+"»" : ""}</div>
          </div>
          <div className="row" style={{gap:6}}>
            <button className="btn btn--sm btn--primary" disabled={busyId===x.id} onClick={()=>setConfirmar({solicitud:x, aplicar:true})}><Icon name="check" size={14}/>Aplicar</button>
            <button className="btn btn--sm btn--ghost" disabled={busyId===x.id} onClick={()=>setConfirmar({solicitud:x, aplicar:false})}><Icon name="x" size={14}/>Rechazar</button>
          </div>
        </div>)}
      {resueltas.length>0 && <div className="muted" style={{fontSize:12.5,marginTop:12}}>
        Resueltas: {resueltas.slice(0,5).map(x=>CAMPO_EMPRESA[x.campo]+" → "+x.valor_solicitado+" ("+x.estado+", "+fechaHora(x.resuelta_at)+")").join(" · ")}
      </div>}
    </div></div>
    <div className="card"><div className="card__head"><h3>Cambios hechos por el cliente</h3></div>
      {portal.cambios.length===0 ? <div className="card__body"><span className="muted">El cliente no ha cambiado ningún dato desde el área cliente.</span></div>
      : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Fecha</th><th>Dato</th><th>Antes</th><th>Ahora</th><th>Quién</th></tr></thead><tbody>
          {portal.cambios.map(x=><tr key={x.id}>
            <td className="tbl__sub">{fechaHora(x.created_at)}</td>
            <td>{CAMPO_EMPRESA[x.campo]}</td>
            <td className="tbl__sub">{x.valor_anterior||"—"}</td>
            <td>{x.valor_nuevo||"—"}</td>
            <td className="tbl__sub">{quien(x)}</td>
          </tr>)}
        </tbody></table></div>}
    </div>
    {confirmar && <Modal title={confirmar.aplicar ? "Aplicar cambio" : "Rechazar solicitud"} onClose={()=>{ if(!busyId) setConfirmar(null); }} footer={<>
      <button className="btn btn--ghost" onClick={()=>setConfirmar(null)} disabled={!!busyId}>Cancelar</button>
      <button className={"btn "+(confirmar.aplicar?"btn--primary":"btn--danger")} onClick={resolver} disabled={!!busyId}>{busyId?"Guardando…":(confirmar.aplicar?"Aplicar":"Rechazar")}</button>
    </>}>
      {confirmar.aplicar
        ? <p className="muted">La {CAMPO_EMPRESA[confirmar.solicitud.campo].toLowerCase()} de <b>{empresa.razon_social}</b> pasará a ser <b>{confirmar.solicitud.valor_solicitado}</b>{confirmar.solicitud.campo==="razon_social" ? ", también en la ficha de sus contactos" : ""}. El cliente lo verá como aplicada.</p>
        : <p className="muted">No se cambiará nada. El cliente verá que su solicitud no se ha aplicado.</p>}
    </Modal>}
  </div>;
}
function EditEmpresa({empresa, onClose, onSave}){
  const [f,setF]=uState({razon_social:empresa.razon_social||"", cif:empresa.cif||"", address:empresa.address||"", city:empresa.city||"", province:empresa.province||""});
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const save=async()=>{ setSaving(true); try{ await onSave(f); } finally{ setSaving(false); } };
  return <Modal title="Editar empresa" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving||!f.razon_social.trim()}>{saving?"Guardando…":"Guardar cambios"}</button></>}>
    <Field label="Razón social"><input className="inp" value={f.razon_social} onChange={set("razon_social")}/></Field>
    <Field label="CIF / NIF"><input className="inp" value={f.cif} onChange={set("cif")}/></Field>
    <Field label="Dirección"><input className="inp" value={f.address} onChange={set("address")}/></Field>
    <div className="fld-row"><Field label="Ciudad"><input className="inp" value={f.city} onChange={set("city")}/></Field><Field label="Provincia"><input className="inp" value={f.province} onChange={set("province")}/></Field></div>
  </Modal>;
}

/* ============ CONTACTS ============ */
function Contacts({nav, toast}){
  const [contacts,setContacts]=uState(()=>CRM.CONTACTS.map(c=>({...c})));
  const [q,setQ]=uState(""); const [lc,setLc]=uState("all"); const [sel,setSel]=uState([]); const [showNew,setNew]=uState(false);
  const [mode,setMode]=uState("list");
  const isMobile = useIsMobile();
  const [drag,setDrag]=uState(null); const [over,setOver]=uState(null);
  const list = contacts.filter(c=>(lc==="all"||c.lifecycle===lc) && (q==="" || (c.company+c.full_name+c.email).toLowerCase().includes(q.toLowerCase())));
  const toggle=(id)=>setSel(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
  const allSel = list.length && list.every(c=>sel.includes(c.id));
  const moveLifecycle=(id,lifecycle)=>{
    const c=contacts.find(x=>x.id===id); if(!c||c.lifecycle===lifecycle) return;
    setContacts(cs=>cs.map(x=>x.id===id?{...x,lifecycle}:x));
    toast(c.company+" → "+CRM.lifecycleById[lifecycle].label);
  };
  const doDeleteSelected=async()=>{
    if(!window.confirm("¿Eliminar "+sel.length+" contacto(s)? Esta acción no se puede deshacer.")) return;
    try{
      const n = await CRM.removeContacts(Auth.client, sel);
      toast(n+" contactos eliminados");
      setSel([]);
      setContacts(CRM.CONTACTS.map(c=>({...c})));
    }catch(e){
      toast("No se pudieron eliminar: "+e.message);
    }
  };
  const leadErrors = CRM.leadErrorCount ? CRM.leadErrorCount() : 0;
  return (
    <div className={mode==="pipeline"?"content--flush":"content"} style={mode==="pipeline"?{flex:1,display:"flex",flexDirection:"column",minHeight:0}:undefined}>
      {mode==="list" && leadErrors>0 && <div className="row" style={{gap:8,background:"var(--warn-soft)",color:"var(--warn)",padding:"10px 14px",borderRadius:9,marginBottom:14,fontSize:13,fontWeight:500}}>
        <Icon name="bell" size={15}/>
        <span>{leadErrors} lead{leadErrors>1?"s":""} de la web no se {leadErrors>1?"pudieron":"pudo"} convertir automáticamente — quedan en la tabla "leads" con status 'new' y error_message puesto; se reintentan solos en el próximo inicio de sesión.</span>
      </div>}
      <div className="toolbar" style={mode==="pipeline"?{padding:"16px 26px 0",marginBottom:0}:undefined}>
        <div className="searchbox"><Icon name="search" size={16}/><input placeholder="Buscar por empresa, persona o email…" value={q} onChange={e=>setQ(e.target.value)}/></div>
        {mode==="list" && (isMobile ? (
          <select className="inp" style={{width:"auto",flex:"none"}} value={lc} onChange={e=>setLc(e.target.value)}>
            <option value="all">Todos ({contacts.length})</option>
            {CRM.LIFECYCLE.map(l=>{ const n=contacts.filter(c=>c.lifecycle===l.id).length; return <option key={l.id} value={l.id}>{l.label} ({n})</option>; })}
          </select>
        ) : <>
          <button className={"chip"+(lc==="all"?" active":"")} onClick={()=>setLc("all")}>Todos <span className="chip__count">{contacts.length}</span></button>
          {CRM.LIFECYCLE.map(l=>{ const n=contacts.filter(c=>c.lifecycle===l.id).length; return <button key={l.id} className={"chip"+(lc===l.id?" active":"")} onClick={()=>setLc(l.id)}><span className="dot" style={{background:l.color}}></span>{l.label} <span className="chip__count">{n}</span></button>; })}
        </>)}
        <div className="toolbar__spacer"></div>
        <div className="viewtoggle">
          <button className={mode==="list"?"active":""} onClick={()=>setMode("list")} title="Vista de lista"><Icon name="list" size={16}/></button>
          <button className={mode==="pipeline"?"active":""} onClick={()=>setMode("pipeline")} title="Vista de pipeline (ciclo de vida)"><Icon name="pipeline" size={16}/></button>
        </div>
        {mode==="list" && !isMobile && <button className="btn btn--ghost"><Icon name="upload" size={16}/>Importar</button>}
        <button className="btn btn--primary" onClick={()=>setNew(true)}><Icon name="plus" size={16}/>Nuevo contacto</button>
      </div>
      {mode==="list" && !isMobile && sel.length>0 && (
        <div className="selbar">
          <span className="selbar__count">{sel.length} seleccionados</span>
          <button className="btn btn--sm btn--ghost"><Icon name="user" size={15}/>Cambiar owner</button>
          <button className="btn btn--sm btn--ghost"><Icon name="tag" size={15}/>Añadir a lista</button>
          <button className="btn btn--sm btn--ghost"><Icon name="download" size={15}/>Exportar CSV</button>
          <div className="toolbar__spacer"></div>
          <button className="btn btn--sm btn--ghost" onClick={doDeleteSelected}><Icon name="trash" size={15}/>Eliminar</button>
          <button className="btn btn--sm btn--ghost" onClick={()=>setSel([])}><Icon name="x" size={15}/></button>
        </div>
      )}
      {mode==="list" ? (
        isMobile ? (
          <div className="wrap-gap">
            {list.map(c=>(
              <div key={c.id} className="card" style={{cursor:"pointer"}} onClick={()=>nav("contact",c.id)}>
                <div className="card__body" style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                  <Avatar name={c.full_name||c.company} size="md" color={CRM.colorFor(c.full_name||c.company)}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="row" style={{justifyContent:"space-between",gap:8}}>
                      <span style={{fontWeight:600,fontSize:14}}>{c.full_name||c.company||"—"}</span>
                      <PriorityDot id={c.priority}/>
                    </div>
                    <div className="muted" style={{fontSize:12.5,marginTop:2}}>{c.company}</div>
                    <div className="row" style={{marginTop:8,justifyContent:"space-between"}}>
                      <LifecycleBadge id={c.lifecycle}/>
                      {ownerAvatar(c.owner)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {list.length===0 && <Empty icon="search" title="Sin resultados" sub="Prueba con otro filtro o búsqueda."/>}
          </div>
        ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr>
              <th style={{width:20}}><div className={"tbl-check"+(allSel?" on":"")} onClick={()=>setSel(allSel?[]:list.map(c=>c.id))}>{allSel&&<Icon name="check" size={12}/>}</div></th>
              <th>Contacto / Empresa</th><th>Ciclo de vida</th><th>Owner</th><th>Ciudad</th><th>Origen</th><th>Prioridad</th><th>Creado</th>
            </tr></thead>
            <tbody>
              {list.map(c=>(
                <tr key={c.id} className={sel.includes(c.id)?"sel":""} onClick={()=>nav("contact",c.id)}>
                  <td onClick={e=>{e.stopPropagation();toggle(c.id);}}><div className={"tbl-check"+(sel.includes(c.id)?" on":"")}>{sel.includes(c.id)&&<Icon name="check" size={12}/>}</div></td>
                  <td><div className="row"><Avatar name={c.full_name||c.company} size="md" color={CRM.colorFor(c.full_name||c.company)}/><div><div className="tbl__name">{c.full_name||c.company||"—"}</div><div className="tbl__sub">{[c.company,c.email].filter(Boolean).join(" · ")}</div></div></div></td>
                  <td><LifecycleBadge id={c.lifecycle}/></td>
                  <td><div className="row">{ownerAvatar(c.owner)}<span style={{fontSize:13}}>{CRM.userById(c.owner)?.name.split(" ")[0]}</span></div></td>
                  <td>{c.city}</td>
                  <td><span className="tbl__sub" style={{color:"var(--slate)"}}>{c.source}</span></td>
                  <td><PriorityDot id={c.priority} showLabel/></td>
                  <td className="tbl__sub">{c.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length===0 && <Empty icon="search" title="Sin resultados" sub="Prueba con otro filtro o búsqueda."/>}
        </div>
        )
      ) : (
        <div className="kanban">
          {CRM.LIFECYCLE.map(l=>{
            const items = list.filter(c=>c.lifecycle===l.id);
            return <div key={l.id} className={"kcol"+(over===l.id?" drop":"")}
              onDragOver={e=>{e.preventDefault();setOver(l.id);}} onDragLeave={()=>setOver(o=>o===l.id?null:o)}
              onDrop={e=>{e.preventDefault();setOver(null);if(drag)moveLifecycle(drag,l.id);}}>
              <div className="kcol__head"><span className="dot" style={{background:l.color,width:9,height:9}}></span><span className="kcol__title">{l.label}</span><span className="kcol__count">{items.length}</span></div>
              <div className="kcol__body">
                {items.map(c=>(
                  <div key={c.id} className={"kcard"+(drag===c.id?" dragging":"")} draggable onDragStart={()=>setDrag(c.id)} onDragEnd={()=>{setDrag(null);setOver(null);}} onClick={()=>nav("contact",c.id)}>
                    <div className="kcard__top"><Avatar name={c.company} size="sm" color={CRM.colorFor(c.company)}/><span className="right">{ownerAvatar(c.owner)}</span></div>
                    <div className="kcard__title">{c.company}</div>
                    <div className="kcard__co">{c.full_name} · {c.city}</div>
                    <div className="kcard__foot"><span className="muted" style={{fontSize:11.5}}>{c.source}</span><span className="right"><PriorityDot id={c.priority}/></span></div>
                  </div>
                ))}
                {items.length===0 && <div className="muted" style={{fontSize:12,textAlign:"center",padding:"14px 0"}}>—</div>}
              </div>
            </div>;
          })}
        </div>
      )}
      {showNew && <NewContact onClose={()=>setNew(false)} onSave={async(f)=>{
        try{
          const c = await CRM.addContact(Auth.client, f);
          setContacts(cs=>[c,...cs]);
          setNew(false);
          toast("Contacto creado");
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
    </div>
  );
}
// Selector de empresa por CIF o nombre, reutilizado por NewContact (alta) y
// EditContact (cambiar/añadir empresa) — un solo sitio con la lógica de "no
// crear una empresa duplicada en silencio": CIF con coincidencia se asocia
// sola; si no, nombre normalizado muestra coincidencias para elegir "es
// esta" o "crear nueva"; sin ninguna coincidencia, solo queda crear nueva.
// onPick(choice) se llama una vez, con {mode:"existing",empresa} o
// {mode:"new",razon_social,cif} — el padre decide qué hacer con la elección
// (este componente no sabe si es un alta o un enlace adicional).
// onCifConflict (opcional): si se da, una coincidencia por CIF NO se
// auto-elige (comportamiento normal, usado por NewContact/EditContact) —
// en vez de eso se lo pasa al padre para que decida cómo avisar. Lo usa
// NewEmpresa: crear una empresa nueva con el CIF de una que ya existe casi
// siempre es un error de escritura, así que ahí conviene un aviso
// explícito con enlace a la ficha en vez de asociarla en silencio.
function EmpresaPicker({onPick, onCifConflict}){
  const [cif,setCif]=uState("");
  const [company,setCompany]=uState("");
  const cifMatch = cif.trim() ? CRM.findEmpresaByCif(cif) : null;
  const nameMatches = (!cifMatch && company.trim()) ? CRM.searchEmpresasByName(company) : [];
  uEffect(()=>{
    if(cifMatch){
      if(onCifConflict) onCifConflict(cifMatch); else onPick({mode:"existing", empresa:cifMatch});
    }else if(onCifConflict){
      onCifConflict(null);
    }
  },[cifMatch && cifMatch.id]);
  return <>
    <div className="fld-row">
      <Field label="CIF / NIF de la empresa (opcional)"><input className="inp" placeholder="B00000000" value={cif} onChange={e=>setCif(e.target.value)}/></Field>
      <Field label="Empresa"><input className="inp" placeholder="Nombre de la empresa" value={company} onChange={e=>setCompany(e.target.value)}/></Field>
    </div>
    {!cifMatch && company.trim() && (
      <div style={{margin:"-8px 0 12px",display:"flex",flexDirection:"column",gap:4}}>
        {nameMatches.length>0 && <div className="muted" style={{fontSize:12}}>¿Es alguna de estas?</div>}
        {nameMatches.map(e=>(
          <button key={e.id} className="btn btn--sm btn--ghost" style={{justifyContent:"flex-start"}} onClick={()=>onPick({mode:"existing",empresa:e})}>Es esta: {e.razon_social}</button>
        ))}
        <button className="btn btn--sm btn--ghost" style={{justifyContent:"flex-start"}} onClick={()=>onPick({mode:"new",razon_social:company.trim(),cif:cif.trim()||null})}>+ Crear empresa nueva: "{company.trim()}"</button>
      </div>
    )}
  </>;
}
// Resumen de la empresa ya elegida (o a crear), con botón para deshacer y
// volver a mostrar el EmpresaPicker — el mismo bloque lo usan NewContact y
// EditContact.
function EmpresaChoiceSummary({choice, onChange}){
  return <div className="muted" style={{fontSize:12.5,margin:"-8px 0 12px",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
    {choice.mode==="existing"
      ? <span>Empresa: <strong>{choice.empresa.razon_social}</strong></span>
      : <span>Se creará la empresa <strong>{choice.razon_social}</strong></span>}
    <button className="btn btn--sm btn--ghost" onClick={()=>onChange(null)}>Cambiar</button>
  </div>;
}
function NewContact({onClose,onSave}){
  const [f,setF]=uState({full_name:"",email:"",phone:"",lifecycle:CRM.LIFECYCLE[0].id,owner:CRM.USERS[0]?.id||""});
  // Empresa a la que se enlazará el contacto: null mientras no se haya
  // elegido una existente o decidido crear una nueva — "nunca crear una
  // empresa duplicada en silencio" se traduce aquí en no dejar guardar
  // hasta que el usuario elija explícitamente una opción.
  const [empresaChoice,setEmpresaChoice]=uState(null); // {mode:"existing",empresa} | {mode:"new",razon_social,cif}
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF(f=>({...f,[k]:e.target.value}));
  const canSave = f.full_name.trim() && empresaChoice && !saving;
  const save=async()=>{
    if(!empresaChoice) return;
    setSaving(true);
    try{
      const payload = {...f};
      if(empresaChoice.mode==="existing") payload.empresaId = empresaChoice.empresa.id;
      else payload.newEmpresa = {razon_social:empresaChoice.razon_social, cif:empresaChoice.cif||null};
      await onSave(payload);
    }
    finally{ setSaving(false); }
  };
  return <Modal title="Nuevo contacto" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={!canSave}>{saving?"Creando…":"Crear contacto"}</button></>}>
    <Field label="Persona de contacto"><input className="inp" placeholder="Nombre y apellidos" value={f.full_name} onChange={set("full_name")}/></Field>
    {empresaChoice ? <EmpresaChoiceSummary choice={empresaChoice} onChange={setEmpresaChoice}/> : <EmpresaPicker onPick={setEmpresaChoice}/>}
    <div className="fld-row"><Field label="Email"><input className="inp" placeholder="email@empresa.es" value={f.email} onChange={set("email")}/></Field><Field label="Teléfono"><input className="inp" placeholder="+34 …" value={f.phone} onChange={set("phone")}/></Field></div>
    <div className="fld-row"><Field label="Ciclo de vida"><select className="inp" value={f.lifecycle} onChange={set("lifecycle")}>{CRM.LIFECYCLE.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select></Field><Field label="Owner"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field></div>
  </Modal>;
}

/* ============ CONTACT DETAIL ============ */
/* ============ ÁREA CLIENTE: CUENTAS ============ */
const fmtFecha = (iso)=> iso ? new Date(iso).toLocaleDateString("es-ES") : "—";
// Por qué un contacto no se puede elegir al vincular una cuenta.
function motivoNoVinculable(c){
  if(c.id.indexOf("lead-")===0) return "Lead sin convertir";
  if(c.auth_user_id) return "Ya tiene cuenta";
  if(CRM.empresasForContact(c.id).length===0) return "Sin empresa";
  return null;
}
// Vincular una cuenta pendiente: 1) elegir contacto (el del mismo email, si
// lo hay, sale primero); 2) confirmar viendo qué empresas verá. Si los emails
// no coinciden se avisa con los dos a la vista, pero no se bloquea.
function VincularCuentaModal({cuenta, onClose, onDone, toast}){
  const [contacto,setContacto]=uState(null);
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const coinciden = contacto && (contacto.email||"").trim().toLowerCase()===(cuenta.email||"").trim().toLowerCase();
  const empresas = contacto ? CRM.empresasForContact(contacto.id).map(x=>x.empresa.razon_social) : [];
  const go=async()=>{
    setBusy(true); setErr(null);
    try{
      const r = await CRM.vincularCuentaPortal(Auth.client, cuenta.auth_user_id, contacto.id);
      toast(r.email_enviado ? "Cuenta vinculada · se ha avisado a "+cuenta.email : "Cuenta vinculada (no se pudo enviar el email de aviso)");
      onDone();
    }catch(e){ setErr(e.message); setBusy(false); }
  };
  if(!contacto) return <Modal title="Vincular cuenta" wide onClose={onClose} footer={<button className="btn btn--ghost" onClick={onClose}>Cancelar</button>}>
    <p className="muted" style={{marginBottom:12}}>Elige el contacto al que pertenece <b>{cuenta.email}</b>. Verá los datos, servicios y documentos compartidos de las empresas de ese contacto.</p>
    <ContactSearchList onPick={setContacto} suggestEmail={cuenta.email} disabledReason={motivoNoVinculable} placeholder="Buscar contacto por nombre, empresa o email…"/>
  </Modal>;
  return <Modal title="Confirmar vinculación" onClose={()=>{ if(!busy) onClose(); }} footer={<>
    <button className="btn btn--ghost" onClick={()=>{ setContacto(null); setErr(null); }} disabled={busy}>Elegir otro</button>
    <button className="btn btn--primary" onClick={go} disabled={busy}>{busy?"Vinculando…":(coinciden?"Vincular":"Vincular igualmente")}</button>
  </>}>
    <p style={{marginBottom:10}}>Cuenta <b>{cuenta.email}</b> → contacto <b>{contacto.full_name||contacto.company}</b>.</p>
    <p className="muted" style={{marginBottom:10,fontSize:13}}>Tendrá acceso a: <b style={{color:"var(--ink)"}}>{empresas.join(", ")}</b>.</p>
    {!coinciden && <div className="warn-box" role="alert">
      <b>Los emails no coinciden.</b> Comprueba que es la misma persona antes de darle acceso.
      <div style={{marginTop:6,fontSize:13}}>Cuenta: <b>{cuenta.email}</b><br/>Contacto: <b>{contacto.email||"(sin email)"}</b></div>
    </div>}
    <p className="muted" style={{fontSize:12.5,marginTop:10}}>Se le enviará un email avisando de que su acceso está activo.</p>
    {err && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:8}}>{err}</p>}
  </Modal>;
}
function EliminarCuentaModal({cuenta, onClose, onDone, toast}){
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const go=async()=>{
    setBusy(true); setErr(null);
    try{ await CRM.eliminarCuentaPortal(Auth.client, cuenta.auth_user_id); toast("Cuenta eliminada"); onDone(); }
    catch(e){ setErr(e.message); setBusy(false); }
  };
  return <Modal title="Eliminar cuenta" onClose={()=>{ if(!busy) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn btn--danger" onClick={go} disabled={busy}>{busy?"Eliminando…":"Eliminar cuenta"}</button></>}>
    <p className="muted">Se eliminará la cuenta <b>{cuenta.email}</b> del área cliente. Si es un cliente, tendrá que registrarse de nuevo. Esta acción no se puede deshacer.</p>
    {err && <p style={{color:"var(--danger)",fontSize:12.5,marginTop:8}}>{err}</p>}
  </Modal>;
}
// Cuentas registradas en el área cliente que aún no ven nada.
function CuentasPortal({nav, toast}){
  const [cuentas,setCuentas]=uState(null); // null = cargando
  const [modal,setModal]=uState(null); // {kind:"vincular"|"eliminar", cuenta}
  const isMobile = useIsMobile();
  const reload=async()=>{ await CRM.loadCuentasPendientes(Auth.client); setCuentas(CRM.CUENTAS_PENDIENTES.slice()); };
  uEffect(()=>{ reload(); },[]);
  const done=()=>{ setModal(null); reload(); };
  const confirmada = (c)=> c.email_confirmado ? <Badge label="Confirmada" color="#1F9D6B"/> : <Badge label="Sin confirmar" color="#D9822B"/>;
  const acciones = (c)=> <div className="row" style={{gap:6,flexWrap:"wrap"}}>
    <button className="btn btn--sm btn--primary" disabled={!c.email_confirmado} title={c.email_confirmado ? "Vincular a un contacto" : "No se puede vincular: la cuenta todavía no ha confirmado su email"}
      onClick={()=>setModal({kind:"vincular", cuenta:c})}><Icon name="user" size={14}/>Vincular</button>
    <button className="btn btn--sm btn--ghost" title="Eliminar cuenta" onClick={()=>setModal({kind:"eliminar", cuenta:c})}><Icon name="trash" size={14}/>{isMobile?null:"Eliminar"}</button>
  </div>;
  return <div className="content">
    <p className="muted" style={{marginBottom:16,maxWidth:720}}>Cuentas registradas en el área cliente que todavía no ven nada. Vincula cada una a su contacto para que vea los datos, servicios y documentos compartidos de sus empresas, o elimínala si no corresponde a un cliente.</p>
    {!cuentas ? <div className="muted" style={{padding:16}}>Cargando…</div>
    : cuentas.length===0 ? <div className="card"><div className="card__body"><Empty icon="users" title="No hay solicitudes pendientes" sub="Cuando alguien se registre en el área cliente, aparecerá aquí."/></div></div>
    : isMobile ? <div className="wrap-gap">{cuentas.map(c=><div key={c.auth_user_id} className="card"><div className="card__body">
        <div style={{fontWeight:600,overflowWrap:"anywhere"}}>{c.email}</div>
        <div className="muted" style={{fontSize:12.5,margin:"2px 0 8px"}}>{[c.nombre, "alta "+fmtFecha(c.alta)].filter(Boolean).join(" · ")}</div>
        <div className="row" style={{justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>{confirmada(c)}{acciones(c)}</div>
        {!c.email_confirmado && <div className="muted" style={{fontSize:12,marginTop:6}}>Hasta que confirme su email no se puede vincular.</div>}
      </div></div>)}</div>
    : <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Email</th><th>Nombre</th><th>Alta</th><th>Email</th><th></th></tr></thead><tbody>
        {cuentas.map(c=><tr key={c.auth_user_id}>
          <td className="tbl__name">{c.email}</td>
          <td className="tbl__sub">{c.nombre||"—"}</td>
          <td className="tbl__sub">{fmtFecha(c.alta)}</td>
          <td>{confirmada(c)}</td>
          <td>{acciones(c)}</td>
        </tr>)}
      </tbody></table></div>}
    {modal && modal.kind==="vincular" && <VincularCuentaModal cuenta={modal.cuenta} toast={toast} onClose={()=>setModal(null)} onDone={done}/>}
    {modal && modal.kind==="eliminar" && <EliminarCuentaModal cuenta={modal.cuenta} toast={toast} onClose={()=>setModal(null)} onDone={done}/>}
  </div>;
}
// Ficha de contacto: cuenta del área cliente vinculada y quitar el acceso.
function ContactPortalAccess({contact, toast, nav}){
  const [cuenta,setCuenta]=uState(undefined); // undefined = cargando; null = sin cuenta
  const [confirmar,setConfirmar]=uState(false); const [busy,setBusy]=uState(false);
  const [vinculado,setVinculado]=uState(!!contact.auth_user_id);
  uEffect(()=>{
    let alive=true;
    setVinculado(!!contact.auth_user_id);
    if(!contact.auth_user_id){ setCuenta(null); return; }
    setCuenta(undefined);
    CRM.cuentaDeContacto(Auth.client, contact.id).then(r=>{ if(alive) setCuenta(r); }).catch(()=>{ if(alive) setCuenta(null); });
    return ()=>{alive=false;};
  },[contact.id, contact.auth_user_id]);
  const desvincular=async()=>{
    setBusy(true);
    try{ await CRM.desvincularCuentaPortal(Auth.client, contact.id); setVinculado(false); setCuenta(null); setConfirmar(false); toast("Acceso al área cliente retirado"); }
    catch(e){ toast("No se pudo desvincular: "+e.message); }
    finally{ setBusy(false); }
  };
  return <div className="card"><div className="card__head"><h3>Acceso al área cliente</h3></div><div className="card__body">
    {!vinculado ? <div className="row" style={{gap:10,flexWrap:"wrap",justifyContent:"space-between"}}>
        <span className="muted">Sin acceso. Cuando se registre, la solicitud aparecerá en Área cliente.</span>
        {CRM.CUENTAS_PENDIENTES.length>0 && <button className="btn btn--sm btn--ghost" onClick={()=>nav("cuentas")}><Icon name="users" size={14}/>Ver solicitudes ({CRM.CUENTAS_PENDIENTES.length})</button>}
      </div>
    : cuenta===undefined ? <span className="muted">Cargando…</span>
    : <div className="row" style={{gap:10,flexWrap:"wrap",justifyContent:"space-between"}}>
        <div style={{minWidth:0}}>
          <div style={{fontWeight:600,overflowWrap:"anywhere"}}>{cuenta ? cuenta.email : "Cuenta vinculada"}</div>
          {cuenta && <div className="muted" style={{fontSize:12.5}}>{cuenta.email_confirmado ? "Email confirmado" : "Email sin confirmar"} · último acceso {cuenta.ultimo_acceso ? fmtFecha(cuenta.ultimo_acceso) : "nunca"}</div>}
        </div>
        <button className="btn btn--sm btn--ghost" onClick={()=>setConfirmar(true)}><Icon name="x" size={14}/>Desvincular</button>
      </div>}
    {confirmar && <Modal title="Quitar acceso al área cliente" onClose={()=>{ if(!busy) setConfirmar(false); }} footer={<><button className="btn btn--ghost" onClick={()=>setConfirmar(false)} disabled={busy}>Cancelar</button><button className="btn btn--danger" onClick={desvincular} disabled={busy}>{busy?"Quitando…":"Desvincular"}</button></>}>
      <p className="muted">La cuenta <b>{cuenta ? cuenta.email : ""}</b> dejará de ver los datos de {contact.full_name||contact.company} en el área cliente desde ya. La cuenta no se borra: volverá a la lista de solicitudes pendientes.</p>
    </Modal>}
  </div></div>;
}

function ContactDetail({id, nav, toast, user}){
  const [,setTick]=uState(0); const bump=()=>setTick(t=>t+1);
  const c = CRM.contactById[id];
  const [tab,setTab]=uState("resumen");
  const [showEdit,setShowEdit]=uState(false);
  const [confirmDel,setConfirmDel]=uState(false);
  const [deleting,setDeleting]=uState(false);
  const [showNewDeal,setShowNewDeal]=uState(false);
  const [converting,setConverting]=uState(false);
  const [showNewTask,setShowNewTask]=uState(false);
  const [showStartWa,setShowStartWa]=uState(false);
  const [editingTask,setEditingTask]=uState(null);
  const [noteText,setNoteText]=uState(""); const [savingNote,setSavingNote]=uState(false);
  // Total de documentos para el contador de la pestaña: lo informa
  // ContactDocsTab al cargar (null hasta entonces, igual que en EmpresaDetail).
  const [docCount,setDocCount]=uState(null);
  uEffect(()=>{ setDocCount(null); },[id]);
  if(!c) return <div className="content"><Empty icon="contacts" title="Contacto no encontrado" sub="Puede que haya sido eliminado." action={<button className="btn btn--sm btn--primary" onClick={()=>nav("contacts")}>Volver a contactos</button>}/></div>;
  const addNoteHandler=async()=>{
    if(!noteText.trim()) return;
    setSavingNote(true);
    try{ await CRM.addNote(Auth.client, {body:noteText, author:user?.id, contact_id:id}); setNoteText(""); toast("Nota añadida"); bump(); }
    catch(e){ toast("No se pudo añadir la nota: "+e.message); }
    finally{ setSavingNote(false); }
  };
  const deleteNoteHandler=async(n)=>{
    if(!window.confirm("¿Eliminar esta nota? Esta acción no se puede deshacer.")) return;
    try{ await CRM.removeNote(Auth.client, n.id); toast("Nota eliminada"); bump(); }
    catch(e){ toast("No se pudo eliminar: "+e.message); }
  };
  const toggleTask=async(t)=>{
    try{ await CRM.toggleTaskDone(Auth.client, t.id); toast("Tarea completada"); bump(); }
    catch(e){ toast("No se pudo completar: "+e.message); }
  };
  const deleteTask=async(t)=>{
    if(!window.confirm("¿Eliminar la tarea \""+t.title+"\"? Esta acción no se puede deshacer.")) return;
    try{ await CRM.removeTask(Auth.client, t.id); toast("Tarea eliminada"); bump(); }
    catch(e){ toast("No se pudo eliminar: "+e.message); }
  };
  const isLead = id.indexOf("lead-")===0;
  const empresas = CRM.empresasForContact(id); // principal primero — ver crm/supabase-empresas.sql
  const doConvert=async()=>{
    setConverting(true);
    try{
      const newContact = await CRM.convertLeadToContact(Auth.client, id);
      toast("Lead convertido en contacto");
      nav("contact", newContact.id);
    }catch(e){
      toast("No se pudo convertir: "+e.message);
      setConverting(false);
    }
  };
  const doDelete=async()=>{
    setDeleting(true);
    try{
      await CRM.removeContact(Auth.client, id);
      setConfirmDel(false);
      toast("Contacto eliminado");
      nav("contacts");
    }catch(e){
      toast("No se pudo eliminar: "+e.message);
      setDeleting(false);
    }
  };
  const deleteDeal=async(dealId,title)=>{
    if(!window.confirm("¿Eliminar el deal \""+title+"\"? Esta acción no se puede deshacer.")) return;
    try{
      await CRM.removeDeal(Auth.client, dealId);
      toast("Deal eliminado");
      bump();
    }catch(e){
      toast("No se pudo eliminar el deal: "+e.message);
    }
  };
  const deals = CRM.DEALS.filter(d=>d.contact===id);
  const notes = CRM.NOTES.filter(n=>n.contact===id);
  const tasks = CRM.TASKS.filter(t=>t.contact===id && !t.archived);
  const acts = CRM.ACTIVITY.filter(a=>a.contact===id);
  const wa = CRM.WHATSAPP.filter(w=>w.contact===id);
  const emails = CRM.EMAILS.filter(e=>e.contact===id);
  const tabs=[{id:"resumen",label:"Resumen"},{id:"deals",label:"Deals",n:deals.length},{id:"notas",label:"Notas",n:notes.length},{id:"tareas",label:"Tareas",n:tasks.length},{id:"whatsapp",label:"WhatsApp",n:wa.reduce((a,w)=>a+w.messages.length,0)||null},{id:"correos",label:"Correos",n:emails.length||null},{id:"docs",label:"Documentos",n:docCount},{id:"actividad",label:"Actividad",n:acts.length}];
  return (
    <div className="content">
      <div className="row" style={{marginBottom:16}}><button className="btn btn--sm btn--ghost" onClick={()=>nav("contacts")}><Icon name="chevronR" size={15} style={{transform:"rotate(180deg)"}}/>Contactos</button></div>
      <div className="detail">
        <div className="detail__aside">
          <div className="profile">
            <div className="profile__top">
              <Avatar name={c.company} size="lg" color={CRM.colorFor(c.company)}/>
              <div><div className="profile__name">{c.company}</div><div className="profile__sub">{c.full_name}</div></div>
              <div className="row" style={{gap:6,flexWrap:"wrap",justifyContent:"center"}}><LifecycleBadge id={c.lifecycle}/><PriorityDot id={c.priority} showLabel/>{isLead && <Badge label="Lead del formulario web — sin convertir" color="#D9822B"/>}</div>
            </div>
            {empresas.length>0 && <div style={{marginTop:14}}>
              <div className="fld__l" style={{marginBottom:6}}>Empresas</div>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {empresas.map(({link,empresa})=>(
                  <div key={empresa.id} className="row" style={{justifyContent:"space-between",gap:8,cursor:"pointer"}} onClick={()=>nav("empresa",empresa.id)}>
                    <span style={{fontSize:13}}>{empresa.razon_social}</span>
                    {link.principal && <Badge label="Principal" color="#1F6FEB"/>}
                  </div>
                ))}
              </div>
            </div>}
            <div style={{marginTop:16}}>
              <KV k="Email">{c.email}</KV><KV k="Teléfono">{c.phone}</KV><KV k="CIF/NIF">{c.dni}</KV>
              <KV k="Ciudad">{c.city} ({c.province})</KV><KV k="Empleados">{c.employees}</KV>
              <KV k="Owner"><span className="row" style={{gap:6}}>{ownerAvatar(c.owner)}{CRM.userById(c.owner)?.name}</span></KV>
              <KV k="Origen">{c.source}</KV>
              {c.service_interest && <KV k="Servicio de interés">{c.service_interest}</KV>}
              {c.utm && <KV k="UTM">{c.utm}</KV>}
              <KV k="KYC">{c.kyc? <Badge label="Verificado" color="#1F9D6B"/> : <Badge label="Pendiente" color="#D9822B"/>}</KV>
            </div>
            <div className="row" style={{gap:8,marginTop:14}}>
              <button className="btn btn--sm btn--primary" style={{flex:1}} onClick={()=>toast("Abriendo llamada…")}><Icon name="phone" size={15}/>Llamar</button>
              <button className="btn btn--sm btn--ghost" style={{flex:1}} onClick={()=>setShowStartWa(true)}><Icon name="whatsapp" size={15}/>WhatsApp</button>
            </div>
            {isLead && <button className="btn btn--sm btn--primary" style={{width:"100%",marginTop:8}} onClick={doConvert} disabled={converting}><Icon name="refresh" size={15}/>{converting?"Convirtiendo…":"Convertir en contacto"}</button>}
            <div className="row" style={{gap:8,marginTop:8}}>
              <button className="btn btn--sm btn--ghost" style={{flex:1}} onClick={()=>setShowEdit(true)}><Icon name="edit" size={15}/>Editar ficha</button>
              <button className="btn btn--sm btn--danger" style={{flex:1}} onClick={()=>setConfirmDel(true)}><Icon name="trash" size={15}/>Eliminar</button>
            </div>
          </div>
        </div>
        <div>
          <Tabs tabs={tabs} active={tab} onChange={setTab}/>
          {tab==="resumen" && <div className="wrap-gap">
            {!isLead && <ContactPortalAccess contact={c} toast={toast} nav={nav}/>}
            <div className="card"><div className="card__head"><h3>Deals activos</h3>{isLead ? <span className="right muted" style={{fontSize:12}}>Convierte el lead en contacto para poder crear deals</span> : <button className="right btn btn--sm btn--subtle" onClick={()=>setShowNewDeal(true)}><Icon name="plus" size={14}/>Nuevo deal</button>}</div><div className="card__body" style={{paddingTop:4}}>
              {deals.map(d=><div key={d.id} className="lrow" style={{cursor:"pointer"}} onClick={()=>nav("deal",d.id)}><div className="lrow__ico" style={{background:(CRM.serviceById(d.service)?.color || "#888")+"1A",color:CRM.serviceById(d.service)?.color || "#888"}}><Icon name="briefcase" size={17}/></div><div className="lrow__main"><div className="lrow__title">{d.title}</div><div className="lrow__sub">{CRM.serviceById(d.service)?.name || "—"}</div></div><div style={{textAlign:"right"}}><div style={{fontWeight:700,fontFamily:"var(--display)"}}>{CRM.fmtEUR(d.amount)}</div><div className="muted" style={{fontSize:11}}>{d.frequency}</div></div><StageBadge id={d.stage}/><button className="btn btn--sm btn--ghost" title="Eliminar deal" onClick={e=>{e.stopPropagation();deleteDeal(d.id,d.title);}}><Icon name="trash" size={14}/></button></div>)}
              {deals.length===0 && <span className="muted">Sin deals.</span>}
            </div></div>
            <div className="card"><div className="card__head"><h3>Últimas notas</h3></div><div className="card__body">
              {notes.length? notes.map(n=><div key={n.id} style={{marginBottom:12}}><div className="row" style={{gap:8,marginBottom:4}}>{ownerAvatar(n.author)}<span style={{fontWeight:600,fontSize:13}}>{CRM.userById(n.author)?.name}</span><span className="muted" style={{fontSize:12}}>{n.created}</span></div><div className="tl-item__body">{n.body}</div></div>) : <span className="muted">Sin notas.</span>}
            </div></div>
          </div>}
          {tab==="deals" && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Deal</th><th>Servicio</th><th>Etapa</th><th>Importe</th><th>Owner</th><th></th></tr></thead><tbody>{deals.map(d=><tr key={d.id} onClick={()=>nav("deal",d.id)}><td className="tbl__name">{d.title}</td><td><ServiceBadge id={d.service}/></td><td><StageBadge id={d.stage}/></td><td className="mono">{CRM.fmtEUR(d.amount)} <span className="muted" style={{fontSize:11}}>/{d.frequency}</span></td><td>{ownerAvatar(d.owner)}</td><td onClick={e=>e.stopPropagation()}><button className="btn btn--sm btn--ghost" title="Eliminar deal" onClick={()=>deleteDeal(d.id,d.title)}><Icon name="trash" size={14}/></button></td></tr>)}</tbody></table>{deals.length===0&&<Empty icon="briefcase" title="Sin deals"/>}</div>}
          {tab==="notas" && <div className="card"><div className="card__body">
            <textarea className="inp" placeholder="Escribe una nota…" style={{marginBottom:10}} value={noteText} onChange={e=>setNoteText(e.target.value)}></textarea>
            <button className="btn btn--sm btn--primary" onClick={addNoteHandler} disabled={savingNote||!noteText.trim()}>{savingNote?"Añadiendo…":"Añadir nota"}</button>
            <div style={{marginTop:18}}>{notes.map(n=><div key={n.id} style={{marginBottom:14}}>
              <div className="row" style={{gap:8,marginBottom:4}}>{ownerAvatar(n.author)}<b style={{fontSize:13}}>{CRM.userById(n.author)?.name}</b><span className="muted" style={{fontSize:12}}>{n.created}</span>
                {user && n.author===user.id && <button className="btn btn--sm btn--ghost right" title="Eliminar nota" onClick={()=>deleteNoteHandler(n)}><Icon name="trash" size={13}/></button>}
              </div>
              <div className="tl-item__body">{n.body}</div>
            </div>)}
            {notes.length===0 && <span className="muted">Sin notas.</span>}</div>
          </div></div>}
          {tab==="tareas" && <div className="card"><div className="card__head"><h3>Tareas</h3><button className="right btn btn--sm btn--subtle" onClick={()=>setShowNewTask(true)}><Icon name="plus" size={14}/>Nueva tarea</button></div><div className="card__body" style={{paddingTop:6}}>{tasks.length? tasks.map(t=><TaskRow key={t.id} t={t} toast={toast} onToggle={()=>toggleTask(t)} onEdit={()=>setEditingTask(t)} onDelete={()=>deleteTask(t)}/>) : <Empty icon="task" title="Sin tareas"/>}</div></div>}
          {tab==="whatsapp" && (
            !c.phone ? <div className="card"><div className="card__body"><Empty icon="whatsapp" title="Hace falta un teléfono" sub="Añade un número de teléfono a la ficha de este contacto para poder usar WhatsApp."/></div></div>
            : wa.length ? <div className="card wa-thread-panel"><WaThread conv={wa[0]} toast={toast} onConvChange={updated=>{ Object.assign(wa[0], updated); bump(); }}/></div>
            : <div className="card"><div className="card__body"><Empty icon="whatsapp" title="Sin conversación de WhatsApp" sub="Todavía no le has escrito a este contacto por WhatsApp." action={<button className="btn btn--sm btn--primary" onClick={()=>setShowStartWa(true)}><Icon name="whatsapp" size={15}/>Iniciar conversación</button>}/></div></div>
          )}
          {tab==="correos" && <div className="wrap-gap">{emails.length? emails.map(e=><EmailThreadCard key={e.id} email={e} toast={toast} bump={bump}/>) : <Empty icon="mail" title="Sin correos vinculados"/>}</div>}
          {tab==="docs" && (isLead
            ? <div className="card"><div className="card__body"><Empty icon="documents" title="Convierte el lead en contacto" sub="Los documentos se guardan en las carpetas del contacto, que se crean al convertirlo."/></div></div>
            : <ContactDocsTab contact={c} user={user} toast={toast} onCount={setDocCount} nav={nav}/>)}
          {tab==="actividad" && <div className="card"><div className="card__body"><div className="tl">{acts.map((a,i)=><div key={i} className="tl-item"><div className="tl-item__ico"><Icon name={a.type==="call"?"phone":a.type==="note"?"note":a.type==="email"?"mail":a.type==="doc"?"documents":a.type==="stage"?"pipeline":"contacts"} size={11}/></div><div className="tl-item__head">{a.text}</div><div className="tl-item__meta">{a.who?CRM.userById(a.who)?.name+" · ":""}{a.at}</div></div>)}</div></div></div>}
        </div>
      </div>
      {showEdit && <EditContact contact={c} toast={toast} onEmpresaChange={bump} onClose={()=>setShowEdit(false)} onSave={async(patch)=>{
        try{
          await CRM.updateContact(Auth.client, id, patch);
          setShowEdit(false);
          toast("Ficha actualizada");
          bump();
        }catch(e){
          toast("No se pudo actualizar: "+e.message);
          throw e;
        }
      }}/>}
      {confirmDel && <Modal title="Eliminar contacto" onClose={()=>setConfirmDel(false)} footer={<><button className="btn btn--ghost" onClick={()=>setConfirmDel(false)} disabled={deleting}>Cancelar</button><button className="btn btn--danger" onClick={doDelete} disabled={deleting}>{deleting?"Eliminando…":"Eliminar definitivamente"}</button></>}>
        <p className="muted">Se eliminará <b>{c.company}</b> junto con sus {deals.length} deal(s) y notas asociadas. Esta acción no se puede deshacer.</p>
        <p className="muted" style={{fontSize:12.5,marginTop:8}}>Los documentos no se borran: son de la empresa y siguen en sus carpetas. Las conversaciones de WhatsApp quedan sin vincular a ningún contacto.</p>
      </Modal>}
      {showNewDeal && <NewDeal contactId={id} onClose={()=>setShowNewDeal(false)} onSave={async(f)=>{
        try{
          await CRM.addDeal(Auth.client, {...f, contact_id:id});
          setShowNewDeal(false);
          toast("Deal creado");
          bump();
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
      {showNewTask && <NewTask contactId={id} onClose={()=>setShowNewTask(false)} onSave={async(f)=>{
        try{
          await CRM.addTask(Auth.client, {title:f.title, due_at:f.due, assigned_to:f.owner, contact_id:id, deal_id:f.deal});
          setShowNewTask(false);
          toast("Tarea creada");
          bump();
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
      {showStartWa && <StartWhatsappModal onClose={()=>setShowStartWa(false)} initialContact={c} nav={nav} toast={toast}/>}
      {editingTask && <EditTask task={editingTask} onClose={()=>setEditingTask(null)} onSave={async(f)=>{
        try{
          await CRM.updateTask(Auth.client, editingTask.id, {title:f.title, due_at:f.due||null, assigned_to:f.owner, contact_id:f.contact||null, deal_id:f.deal||null});
          setEditingTask(null);
          toast("Tarea actualizada");
          bump();
        }catch(e){
          toast("No se pudo actualizar: "+e.message);
          throw e;
        }
      }}/>}
    </div>
  );
}
// La empresa YA NO se edita como texto libre aquí (contactos.company lo
// mantiene al día un trigger a partir de la relación, ver
// crm/supabase-empresas.sql) — en su lugar, cambiar de empresa/añadir una
// segunda usa el mismo EmpresaPicker que el alta. A diferencia del resto
// del formulario (que se guarda todo junto al pulsar "Guardar cambios"),
// las acciones de empresa son instantáneas: cada clic llama a Supabase
// directamente, porque el usuario necesita ver el resultado (la lista de
// empresas actualizada, o el error) antes de decidir el siguiente paso.
function EditContactEmpresas({contact, toast, onChange}){
  const [,setTick]=uState(0); const bump=()=>{ setTick(t=>t+1); onChange && onChange(); };
  const [adding,setAdding]=uState(false);
  const [busy,setBusy]=uState(false);
  const links = CRM.empresasForContact(contact.id);
  const pick=async(choice)=>{
    setBusy(true);
    try{
      var empresaId;
      if(choice.mode==="existing") empresaId = choice.empresa.id;
      else{
        var created = await CRM.addEmpresa(Auth.client, {razon_social:choice.razon_social, cif:choice.cif});
        empresaId = created.id;
      }
      await CRM.addContactoEmpresaLink(Auth.client, contact.id, empresaId, links.length===0);
      setAdding(false);
      bump();
    }catch(e){ toast("No se pudo enlazar la empresa: "+e.message); }
    finally{ setBusy(false); }
  };
  const makePrincipal=async(empresaId)=>{
    setBusy(true);
    try{ await CRM.setPrincipalEmpresa(Auth.client, contact.id, empresaId); bump(); }
    catch(e){ toast("No se pudo actualizar: "+e.message); }
    finally{ setBusy(false); }
  };
  const remove=async(empresaId, razonSocial)=>{
    if(links.length<=1){ toast("Un contacto debe tener al menos una empresa."); return; }
    if(!window.confirm("¿Quitar \""+razonSocial+"\" de este contacto?")) return;
    setBusy(true);
    try{ await CRM.removeContactoEmpresaLink(Auth.client, contact.id, empresaId); bump(); }
    catch(e){ toast("No se pudo quitar: "+e.message); }
    finally{ setBusy(false); }
  };
  return <Field label="Empresas">
    <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:8}}>
      {links.map(({link,empresa})=>(
        <div key={empresa.id} className="row" style={{justifyContent:"space-between",gap:8,padding:"6px 0"}}>
          <span className="row" style={{gap:8,fontSize:13.5}}>{empresa.razon_social}{link.principal && <Badge label="Principal" color="#1F6FEB"/>}</span>
          <div className="row" style={{gap:4}}>
            {!link.principal && <button className="btn btn--sm btn--ghost" disabled={busy} onClick={()=>makePrincipal(empresa.id)}>Marcar principal</button>}
            {links.length>1 && <button className="btn btn--sm btn--ghost" disabled={busy} title="Quitar" onClick={()=>remove(empresa.id, empresa.razon_social)}><Icon name="trash" size={14}/></button>}
          </div>
        </div>
      ))}
    </div>
    {adding ? <EmpresaPicker onPick={pick}/> : <button className="btn btn--sm btn--ghost" disabled={busy} onClick={()=>setAdding(true)}><Icon name="plus" size={14}/>Añadir empresa</button>}
    {links.length>1 && <p className="muted" style={{fontSize:12,marginTop:8}}>Los adjuntos de WhatsApp de este contacto van a la carpeta WhatsApp de su empresa principal. Cambiarla no mueve los documentos ya archivados, solo los que lleguen a partir de ahora.</p>}
  </Field>;
}
function EditContact({contact, toast, onEmpresaChange, onClose, onSave}){
  const [f,setF]=uState(()=>{
    var init={...contact};
    delete init.company; // se gestiona aparte, ver EditContactEmpresas arriba
    Object.keys(init).forEach(function(k){ if(init[k]===null||init[k]===undefined) init[k]=""; });
    return init;
  });
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const save=async()=>{
    setSaving(true);
    try{ await onSave(f); }
    finally{ setSaving(false); }
  };
  return <Modal title="Editar ficha de contacto" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Guardando…":"Guardar cambios"}</button></>}>
    <Field label="Persona de contacto"><input className="inp" value={f.full_name} onChange={set("full_name")}/></Field>
    <EditContactEmpresas contact={contact} toast={toast} onChange={onEmpresaChange}/>
    <div className="fld-row"><Field label="Email"><input className="inp" value={f.email} onChange={set("email")}/></Field><Field label="Teléfono"><input className="inp" value={f.phone} onChange={set("phone")}/></Field></div>
    <div className="fld-row"><Field label="Ciudad"><input className="inp" value={f.city} onChange={set("city")}/></Field><Field label="Provincia"><input className="inp" value={f.province} onChange={set("province")}/></Field></div>
    <div className="fld-row"><Field label="Empleados"><input className="inp" type="number" value={f.employees} onChange={e=>setF({...f,employees:+e.target.value})}/></Field><Field label="Origen"><input className="inp" value={f.source} onChange={set("source")}/></Field></div>
    <div className="fld-row">
      <Field label="Owner"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Ciclo de vida"><select className="inp" value={f.lifecycle} onChange={set("lifecycle")}>{CRM.LIFECYCLE.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select></Field>
    </div>
    <Field label="Prioridad"><select className="inp" value={f.priority} onChange={set("priority")}>{CRM.PRIORITIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
  </Modal>;
}
// timeZone fijo a Madrid (no la del navegador): el CRM es de uso exclusivo
// del despacho en España, así que una tarea se escribe en hora de Madrid
// (ver madridDatetimeLocalToISO en data.js) y tiene que mostrarse igual,
// sin importar desde dónde ni con qué reloj la esté mirando cada persona.
function fmtDue(iso){
  if(!iso) return "sin fecha";
  var d = new Date(iso);
  if(isNaN(d.getTime())) return "sin fecha";
  return d.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"numeric",timeZone:"Europe/Madrid"})+" "+d.toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Madrid"});
}
function isOverdue(t){
  if(!t.due || t.status==="done") return false;
  var d = new Date(t.due);
  return !isNaN(d.getTime()) && d.getTime()<Date.now();
}
function TaskRow({t, toast, onToggle, onEdit, onDelete}){
  const done = t.status==="done";
  const overdue = isOverdue(t);
  return <div className="lrow">
    <div className={"tcheck"+(done?" done":"")} onClick={onToggle} title={done?"Completada":"Marcar como completada"}>{done&&<Icon name="check" size={13}/>}</div>
    <div className="lrow__main">
      <div className="lrow__title" style={{textDecoration:done?"line-through":"none",opacity:done?.6:1}}>{t.title}</div>
      <div className="lrow__sub" style={overdue?{color:"var(--danger)",fontWeight:600}:undefined}>{overdue?"Vencida":"Vence"} {fmtDue(t.due)} · {CRM.userById(t.owner)?.name?.split(" ")[0] || "Sin asignar"}</div>
    </div>
    {onEdit && <button className="btn btn--sm btn--ghost task-row-action" title="Editar tarea" onClick={onEdit}><Icon name="edit" size={14}/></button>}
    {onDelete && <button className="btn btn--sm btn--ghost task-row-action" title="Eliminar tarea" onClick={onDelete}><Icon name="trash" size={14}/></button>}
  </div>;
}
function NewTask({contactId, dealId, defaultOwner, onClose, onSave}){
  const [f,setF]=uState({title:"", due:"", owner:defaultOwner||CRM.USERS[0]?.id||"", contact:contactId||"", deal:dealId||""});
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const dealsForContact = f.contact ? CRM.DEALS.filter(d=>d.contact===f.contact) : [];
  const save=async()=>{
    setSaving(true);
    try{ await onSave(f); }
    finally{ setSaving(false); }
  };
  return <Modal title="Nueva tarea" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Creando…":"Crear tarea"}</button></>}>
    <Field label="Título"><input className="inp" placeholder="Ej. Llamar para agendar reunión" value={f.title} onChange={set("title")}/></Field>
    <div className="fld-row">
      <Field label="Fecha y hora"><input className="inp" type="datetime-local" value={f.due} onChange={set("due")}/></Field>
      <Field label="Asignar a"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
    </div>
    {!contactId && <div className="fld-row">
      <Field label="Contacto"><select className="inp" value={f.contact} onChange={e=>setF({...f,contact:e.target.value,deal:""})}><option value="">— Ninguno —</option>{CRM.CONTACTS.map(c=><option key={c.id} value={c.id}>{c.company}</option>)}</select></Field>
      <Field label="Deal"><select className="inp" value={f.deal} onChange={set("deal")} disabled={!f.contact}><option value="">— Ninguno —</option>{dealsForContact.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
    </div>}
    {contactId && !dealId && <Field label="Deal (opcional)"><select className="inp" value={f.deal} onChange={set("deal")}><option value="">— Ninguno —</option>{dealsForContact.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>}
  </Modal>;
}
function EditTask({task, onClose, onSave}){
  const [f,setF]=uState(()=>({
    title: task.title||"",
    due: CRM.isoToMadridDatetimeLocal(task.due),
    owner: task.owner||"",
    contact: task.contact||"",
    deal: task.deal||""
  }));
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const dealsForContact = f.contact ? CRM.DEALS.filter(d=>d.contact===f.contact) : [];
  const save=async()=>{
    setSaving(true);
    try{ await onSave(f); }
    finally{ setSaving(false); }
  };
  return <Modal title="Editar tarea" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Guardando…":"Guardar cambios"}</button></>}>
    <Field label="Título"><input className="inp" value={f.title} onChange={set("title")}/></Field>
    <div className="fld-row">
      <Field label="Fecha y hora"><input className="inp" type="datetime-local" value={f.due} onChange={set("due")}/></Field>
      <Field label="Asignar a"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
    </div>
    <div className="fld-row">
      <Field label="Contacto"><select className="inp" value={f.contact} onChange={e=>setF({...f,contact:e.target.value,deal:""})}><option value="">— Ninguno —</option>{CRM.CONTACTS.map(c=><option key={c.id} value={c.id}>{c.company}</option>)}</select></Field>
      <Field label="Deal"><select className="inp" value={f.deal} onChange={set("deal")} disabled={!f.contact}><option value="">— Ninguno —</option>{dealsForContact.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
    </div>
  </Modal>;
}

/* ============ TASKS ============ */
// `view` hace de único selector de filtro: "mine"/"all"/"archived", o
// directamente el id de un administrador (public.admins) cuando se elige
// "Por miembro" — así el filtrado vive en una sola expresión en vez de
// tener un estado de "miembro seleccionado" aparte que duplicara la lógica
// de list de abajo.
function Tasks({nav, toast, user, focusId}){
  const [,setTick]=uState(0); const bump=()=>setTick(t=>t+1);
  const knownUser = !!CRM.userById(user?.id);
  const [view,setView]=uState(knownUser?"mine":"all");
  const [showNew,setNew]=uState(false);
  const [editing,setEditing]=uState(null);
  const memberFilter = CRM.USERS.find(u=>u.id===view);
  const list = (view==="archived" ? CRM.TASKS.filter(t=>t.archived) : CRM.TASKS.filter(t=>!t.archived && (
      view==="all" ? true : view==="mine" ? t.owner===user?.id : t.owner===view
    )))
    .slice()
    .sort((a,b)=>{
      if(!a.due && !b.due) return 0;
      if(!a.due) return 1;
      if(!b.due) return -1;
      return new Date(a.due)-new Date(b.due);
    });
  // Deep-link desde un push/email de "tarea asignada" (?view=tareas&id=...)
  // — abre directamente el modal de edición de esa tarea, igual que
  // WhatsApp hace con focusId para una conversación.
  uEffect(()=>{
    if(!focusId) return;
    const t = CRM.TASKS.find(x=>x.id===focusId);
    if(t) setEditing(t);
  },[focusId]);
  const doToggle=async(t)=>{
    try{ await CRM.toggleTaskDone(Auth.client, t.id); toast("Tarea completada"); bump(); }
    catch(e){ toast("No se pudo completar: "+e.message); }
  };
  const doDelete=async(t)=>{
    if(!window.confirm("¿Eliminar la tarea \""+t.title+"\"? Esta acción no se puede deshacer.")) return;
    try{ await CRM.removeTask(Auth.client, t.id); toast("Tarea eliminada"); bump(); }
    catch(e){ toast("No se pudo eliminar: "+e.message); }
  };
  return (
    <div className="content">
      <div className="toolbar">
        <button className={"chip"+(view==="mine"?" active":"")} onClick={()=>setView("mine")}>Mis tareas</button>
        <button className={"chip"+(view==="all"?" active":"")} onClick={()=>setView("all")}>Todas</button>
        <button className={"chip"+(view==="archived"?" active":"")} onClick={()=>setView("archived")}>Archivadas</button>
        <select className="inp" style={{width:"auto",padding:"7px 10px",fontSize:13}} value={memberFilter?view:""} onChange={e=>setView(e.target.value||"all")}>
          <option value="">Por miembro…</option>
          {CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <div className="toolbar__spacer"></div>
        <button className="btn btn--primary" onClick={()=>setNew(true)}><Icon name="plus" size={16}/>Nueva tarea</button>
      </div>
      <div className="card"><div className="card__body" style={{paddingTop:6}}>
        {list.length? list.map(t=><TaskRow key={t.id} t={t} toast={toast}
          onToggle={t.archived?undefined:()=>doToggle(t)}
          onEdit={()=>setEditing(t)}
          onDelete={()=>doDelete(t)}
        />) : <Empty icon="task" title={view==="archived"?"Sin tareas archivadas":memberFilter?("Sin tareas de "+memberFilter.name.split(" ")[0]):"Sin tareas"} sub={view==="mine"?"Estás al día.":undefined}/>}
      </div></div>
      {showNew && <NewTask defaultOwner={knownUser?user.id:undefined} onClose={()=>setNew(false)} onSave={async(f)=>{
        try{
          await CRM.addTask(Auth.client, {title:f.title, due_at:f.due, assigned_to:f.owner, contact_id:f.contact, deal_id:f.deal});
          setNew(false);
          toast("Tarea creada");
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
      {editing && <EditTask task={editing} onClose={()=>setEditing(null)} onSave={async(f)=>{
        try{
          await CRM.updateTask(Auth.client, editing.id, {title:f.title, due_at:f.due||null, assigned_to:f.owner, contact_id:f.contact||null, deal_id:f.deal||null});
          setEditing(null);
          toast("Tarea actualizada");
          bump();
        }catch(e){
          toast("No se pudo actualizar: "+e.message);
          throw e;
        }
      }}/>}
    </div>
  );
}

// Empresa por defecto de un deal nuevo: la principal del contacto (mismo
// criterio que public.empresa_principal_de y el trigger de deals).
function principalEmpresaId(contactId){ return (contactId && CRM.empresaPrincipalDe(contactId)?.id) || ""; }

function NewDeal({contactId, onClose, onSave}){
  const [f,setF]=uState({title:"", contact:contactId||"", empresa:principalEmpresaId(contactId), service:"", stage:"reunion", amount:"", frequency:"", priority:"", num_nominas:"", coste_nomina:20});
  const [saving,setSaving]=uState(false);
  const isLaboral = f.service===LABORAL_SERVICE_ID;
  const computedAmount = (parseFloat(f.num_nominas)||0) * (parseFloat(f.coste_nomina)||0);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  // Selector de empresa solo si el contacto tiene varias; con una (o
  // ninguna) no hay nada que elegir.
  const empresasDelContacto = f.contact ? CRM.empresasForContact(f.contact) : [];
  const setContact=(e)=>setF({...f, contact:e.target.value, empresa:principalEmpresaId(e.target.value)});
  const setService=(e)=>{
    const newId = e.target.value;
    const newName = CRM.serviceById(newId)?.name || "";
    const prevName = CRM.serviceById(f.service)?.name || "";
    setF(prev=>{
      const next = {...prev, service:newId, title:(prev.title===""||prev.title===prevName) ? newName : prev.title};
      if(newId===LABORAL_SERVICE_ID){
        next.frequency = "mensual";
        if(next.coste_nomina==="") next.coste_nomina = 20;
      }
      return next;
    });
  };
  const save=async()=>{
    setSaving(true);
    try{
      const payload = isLaboral
        ? {...f, amount:computedAmount, frequency:"mensual"}
        : {...f, num_nominas:"", coste_nomina:""};
      await onSave({...payload, empresa_id:f.empresa});
    }
    finally{ setSaving(false); }
  };
  return <Modal title="Nuevo deal" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Creando…":"Crear deal"}</button></>}>
    <Field label="Título"><input className="inp" placeholder="Ej. CFO externo para escalado" value={f.title} onChange={set("title")}/></Field>
    {!contactId && <Field label="Contacto"><select className="inp" value={f.contact} onChange={setContact}><option value="">— Selecciona un contacto —</option>{CRM.CONTACTS.map(c=><option key={c.id} value={c.id}>{c.company}</option>)}</select></Field>}
    {empresasDelContacto.length>1 && <Field label="Empresa"><select className="inp" value={f.empresa} onChange={set("empresa")}>{empresasDelContacto.map(x=><option key={x.empresa.id} value={x.empresa.id}>{x.empresa.razon_social}{x.link.principal?" (principal)":""}</option>)}</select></Field>}
    <div className="fld-row">
      <Field label="Servicio"><select className="inp" value={f.service} onChange={setService}><option value="">— Sin especificar —</option>{CRM.SERVICES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Etapa"><select className="inp" value={f.stage} onChange={set("stage")}>{CRM.STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
    </div>
    {isLaboral ? (
      <>
        <div className="fld-row">
          <Field label="Nº de nóminas activas"><input className="inp" type="number" min="0" placeholder="0" value={f.num_nominas} onChange={set("num_nominas")}/></Field>
          <Field label="Coste por nómina (€)"><input className="inp" type="number" min="0" value={f.coste_nomina} onChange={set("coste_nomina")}/></Field>
        </div>
        <Field label="Frecuencia"><select className="inp" value="mensual" disabled><option value="mensual">Mensual</option></select></Field>
        <p className="muted" style={{fontSize:13,margin:"-6px 0 14px"}}>Importe: <b>{CRM.fmtEUR(computedAmount)}</b>/mes</p>
      </>
    ) : (
      <div className="fld-row">
        <Field label="Importe (€)"><input className="inp" type="number" placeholder="0" value={f.amount} onChange={set("amount")}/></Field>
        <Field label="Frecuencia"><select className="inp" value={f.frequency} onChange={set("frequency")}><option value="">— Sin especificar —</option><option value="mensual">Mensual</option><option value="puntual">Puntual</option></select></Field>
      </div>
    )}
    <Field label="Prioridad"><select className="inp" value={f.priority} onChange={set("priority")}><option value="">— Sin especificar —</option>{CRM.PRIORITIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
  </Modal>;
}

/* ============ PIPELINE ============ */
function Pipeline({nav, toast}){
  const [deals,setDeals]=uState(CRM.DEALS.map(d=>({...d})));
  const [drag,setDrag]=uState(null); const [over,setOver]=uState(null); const [loss,setLoss]=uState(null);
  const [showNewDeal,setShowNewDeal]=uState(false);
  const cols = CRM.STAGES;
  const move=async(dealId,stage)=>{
    const d=deals.find(x=>x.id===dealId); if(!d||d.stage===stage)return;
    if(stage==="perdido"){ setLoss({dealId}); return; }
    const prev={...d};
    setDeals(ds=>ds.map(x=>x.id===dealId?{...x,stage}:x));
    try{
      await CRM.updateDeal(Auth.client, dealId, {stage});
      if(stage==="cliente_activo") toast("🎉 "+d.title+" → Cliente activo. Expediente creado.");
    }catch(e){
      setDeals(ds=>ds.map(x=>x.id===dealId?prev:x));
      toast("No se pudo mover el deal: "+e.message);
    }
  };
  const confirmLoss=async(reason)=>{
    const dealId=loss.dealId;
    const prev=deals.find(x=>x.id===dealId);
    setDeals(ds=>ds.map(x=>x.id===dealId?{...x,stage:"perdido",loss_reason:reason}:x));
    setLoss(null);
    try{
      await CRM.updateDeal(Auth.client, dealId, {stage:"perdido", loss_reason:reason});
      toast("Deal marcado como perdido");
    }catch(e){
      if(prev) setDeals(ds=>ds.map(x=>x.id===dealId?prev:x));
      toast("No se pudo marcar como perdido: "+e.message);
    }
  };
  return (
    <div className="content--flush" style={{flex:1,display:"flex",flexDirection:"column"}}>
      <div style={{padding:"16px 26px 0",display:"flex",alignItems:"center",gap:12}}>
        <div className="muted" style={{fontSize:13}}>{deals.filter(d=>d.stage!=="perdido"&&d.stage!=="cliente_activo").length} deals abiertos · arrastra las tarjetas entre etapas</div>
        <button className="btn btn--sm btn--primary right" onClick={()=>setShowNewDeal(true)}><Icon name="plus" size={15}/>Nuevo deal</button>
      </div>
      <div className="kanban">
        {cols.map(col=>{
          const items=deals.filter(d=>d.stage===col.id);
          const sum=items.filter(d=>d.frequency!=="anual").reduce((a,d)=>a+d.amount,0);
          return <div key={col.id} className={"kcol"+(over===col.id?" drop":"")}
            onDragOver={e=>{e.preventDefault();setOver(col.id);}} onDragLeave={()=>setOver(o=>o===col.id?null:o)}
            onDrop={e=>{e.preventDefault();setOver(null);if(drag)move(drag,col.id);}}>
            <div className="kcol__head"><span className="dot" style={{background:col.color,width:9,height:9}}></span><span className="kcol__title">{col.label}</span><span className="kcol__count">{items.length}</span><span className="kcol__sum">{sum?CRM.fmtEUR(sum):""}</span></div>
            <div className="kcol__body">
              {items.map(d=>{ const emp=CRM.empresaById[d.empresa]; const s=CRM.serviceById(d.service);
                return <div key={d.id} className={"kcard"+(drag===d.id?" dragging":"")} draggable onDragStart={()=>setDrag(d.id)} onDragEnd={()=>{setDrag(null);setOver(null);}} onClick={()=>nav("deal",d.id)}>
                  <div className="kcard__top"><span className="dot" style={{background:s?.color || "#888"}}></span><span className="muted" style={{fontSize:11,fontWeight:600}}>{s?.short || "—"}</span><span className="right">{ownerAvatar(d.owner)}</span></div>
                  <div className="kcard__title">{d.title}</div>
                  {d.origen==="portal" && <div style={{margin:"2px 0 4px"}}><Badge label="Área cliente" color="#7C5CFC"/></div>}
                  <div className="kcard__co">{emp?.razon_social}</div>
                  <div className="kcard__foot"><span className="kcard__amt">{CRM.fmtEUR(d.amount)}</span><span className="kcard__freq">/{d.frequency}</span><span className="right"><PriorityDot id={d.priority}/></span></div>
                </div>;
              })}
              {items.length===0 && <div className="muted" style={{fontSize:12,textAlign:"center",padding:"14px 0"}}>—</div>}
            </div>
          </div>;
        })}
      </div>
      {loss && <Modal title="¿Por qué se pierde este deal?" onClose={()=>setLoss(null)} footer={<button className="btn btn--ghost" onClick={()=>setLoss(null)}>Cancelar</button>}>
        <p className="muted" style={{marginBottom:14}}>Registrar el motivo alimenta las métricas de pérdidas.</p>
        <div className="wrap-gap" style={{gap:8}}>{CRM.LOSS_REASONS.map(r=><button key={r.id} className="chip" style={{justifyContent:"flex-start"}} onClick={()=>confirmLoss(r.id)}>{r.label}</button>)}</div>
      </Modal>}
      {showNewDeal && <NewDeal onClose={()=>setShowNewDeal(false)} onSave={async(f)=>{
        try{
          const d = await CRM.addDeal(Auth.client, {...f, contact_id:f.contact});
          setDeals(ds=>[d,...ds]);
          setShowNewDeal(false);
          toast("Deal creado");
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
    </div>
  );
}

/* ============ DEAL DETAIL ============ */
function DealDetail({id, nav, toast, user}){
  const [,setTick]=uState(0); const bump=()=>setTick(t=>t+1);
  const [showEdit,setShowEdit]=uState(false);
  const [confirmDel,setConfirmDel]=uState(false); const [deleting,setDeleting]=uState(false);
  const [showNewTask,setShowNewTask]=uState(false); const [editingTask,setEditingTask]=uState(null);
  const [noteText,setNoteText]=uState(""); const [savingNote,setSavingNote]=uState(false);
  const d = CRM.DEALS.find(x=>x.id===id);
  const [tab,setTab]=uState("resumen");
  if(!d) return <div className="content"><Empty title="Deal no encontrado"/></div>;
  const addNoteHandler=async()=>{
    if(!noteText.trim()) return;
    setSavingNote(true);
    try{ await CRM.addNote(Auth.client, {body:noteText, author:user?.id, deal_id:id}); setNoteText(""); toast("Nota añadida"); bump(); }
    catch(e){ toast("No se pudo añadir la nota: "+e.message); }
    finally{ setSavingNote(false); }
  };
  const deleteNoteHandler=async(n)=>{
    if(!window.confirm("¿Eliminar esta nota? Esta acción no se puede deshacer.")) return;
    try{ await CRM.removeNote(Auth.client, n.id); toast("Nota eliminada"); bump(); }
    catch(e){ toast("No se pudo eliminar: "+e.message); }
  };
  const toggleTask=async(t)=>{
    try{ await CRM.toggleTaskDone(Auth.client, t.id); toast("Tarea completada"); bump(); }
    catch(e){ toast("No se pudo completar: "+e.message); }
  };
  const deleteTask=async(t)=>{
    if(!window.confirm("¿Eliminar la tarea \""+t.title+"\"? Esta acción no se puede deshacer.")) return;
    try{ await CRM.removeTask(Auth.client, t.id); toast("Tarea eliminada"); bump(); }
    catch(e){ toast("No se pudo eliminar: "+e.message); }
  };
  const doDelete=async()=>{
    setDeleting(true);
    try{
      await CRM.removeDeal(Auth.client, d.id);
      setConfirmDel(false);
      toast("Deal eliminado");
      nav("pipeline");
    }catch(e){
      toast("No se pudo eliminar: "+e.message);
      setDeleting(false);
    }
  };
  const moveStage=async(stageId)=>{
    if(stageId===d.stage) return;
    try{
      await CRM.updateDeal(Auth.client, d.id, {stage:stageId});
      toast("Movido a "+CRM.stageById[stageId].label);
      bump();
    }catch(e){
      toast("No se pudo mover el deal: "+e.message);
    }
  };
  const c=CRM.contactById[d.contact]; const s=CRM.serviceById(d.service); const emp=CRM.empresaById[d.empresa];
  const notes=CRM.NOTES.filter(n=>n.deal===id); const tasks=CRM.TASKS.filter(t=>t.deal===id && !t.archived);
  const wa=CRM.WHATSAPP.filter(w=>w.contact===d.contact);
  const dealEmails=CRM.EMAILS.filter(e=>e.deal===id);
  const tabs=[{id:"resumen",label:"Resumen"},{id:"notas",label:"Notas",n:notes.length},{id:"tareas",label:"Tareas",n:tasks.length},{id:"whatsapp",label:"WhatsApp",n:wa.reduce((a,w)=>a+w.messages.length,0)||null},{id:"correos",label:"Correos",n:dealEmails.length||null}];
  const stageIdx=CRM.STAGES.findIndex(x=>x.id===d.stage);
  return (
    <div className="content">
      <div className="row" style={{marginBottom:16}}><button className="btn btn--sm btn--ghost" onClick={()=>nav("pipeline")}><Icon name="chevronR" size={15} style={{transform:"rotate(180deg)"}}/>Pipeline</button></div>
      <div className="detail">
        <div className="detail__aside">
          <div className="profile">
            <div style={{textAlign:"center"}}><div className="lrow__ico" style={{width:52,height:52,margin:"0 auto 10px",background:(s?.color || "#888")+"1A",color:s?.color || "#888",borderRadius:14}}><Icon name="briefcase" size={24}/></div><div className="profile__name" style={{fontSize:17}}>{d.title}</div>{emp ? <div className="profile__sub" style={{cursor:"pointer",color:"var(--accent)"}} onClick={()=>nav("empresa",emp.id)}>{emp.razon_social}</div> : <div className="profile__sub">Sin empresa</div>}{c && <div className="profile__sub" style={{cursor:"pointer"}} onClick={()=>nav("contact",c.id)}>{c.full_name||c.company}</div>}</div>
            <div style={{margin:"14px 0"}}><StageBadge id={d.stage}/>{d.origen==="portal" && <> <Badge label="Pedido desde el área cliente" color="#7C5CFC"/></>}</div>
            <div><KV k="Servicio"><ServiceBadge id={d.service}/></KV><KV k="Importe">{(d.service===LABORAL_SERVICE_ID && d.num_nominas && d.coste_nomina) ? <>{d.num_nominas} nóminas × {CRM.fmtEUR(d.coste_nomina)} = {CRM.fmtEUR(d.amount)}/mes</> : <>{CRM.fmtEUR(d.amount)} / {d.frequency}</>}</KV><KV k="Owner"><span className="row" style={{gap:6}}>{ownerAvatar(d.owner)}{CRM.userById(d.owner)?.name}</span></KV><KV k="Prioridad"><PriorityDot id={d.priority} showLabel/></KV><KV k="Creado">{d.created}</KV>{d.signed&&<KV k="Firmado">{d.signed}</KV>}{d.renewal&&<KV k="Renovación">{d.renewal}</KV>}</div>
            <button className="btn btn--sm btn--primary" style={{width:"100%",marginTop:14}} onClick={()=>setShowEdit(true)}><Icon name="edit" size={15}/>Editar deal</button>
            <button className="btn btn--sm btn--danger" style={{width:"100%",marginTop:8}} onClick={()=>setConfirmDel(true)}><Icon name="trash" size={15}/>Eliminar deal</button>
          </div>
        </div>
        <div>
          <div className="card" style={{marginBottom:16}}><div className="card__body"><div className="section-title" style={{marginBottom:10}}>Progreso en el pipeline</div><div className="row stage-chart" style={{gap:0}}>{CRM.STAGES.filter(x=>x.id!=="perdido").map((x,i)=><div key={x.id} className="stage-col" style={{flex:1,textAlign:"center",cursor:"pointer"}} title={"Mover a "+x.label} onClick={()=>moveStage(x.id)}><div style={{height:6,background:i<=stageIdx?x.color:"var(--line)",borderRadius:20,margin:"0 2px"}}></div><div className="stage-label" style={{fontSize:10.5,marginTop:6,color:i<=stageIdx?"var(--ink)":"var(--muted)",fontWeight:i===stageIdx?700:400}}>{x.label}</div></div>)}</div></div></div>
          <Tabs tabs={tabs} active={tab} onChange={setTab}/>
          {tab==="resumen" && <div className="card"><div className="card__body"><div className="grid-2"><KV k="Proveedor actual">Gestoría local</KV><KV k="Cuota actual">{CRM.fmtEUR(Math.round(d.amount*1.2))}</KV><KV k="Ahorro estimado">{CRM.fmtEUR(Math.round(d.amount*0.2))}/{d.frequency}</KV><KV k="Frecuencia pago">{d.frequency}</KV></div></div></div>}
          {tab==="notas" && <div className="card"><div className="card__body">
            <textarea className="inp" placeholder="Nota interna del deal…" style={{marginBottom:10}} value={noteText} onChange={e=>setNoteText(e.target.value)}></textarea>
            <button className="btn btn--sm btn--primary" onClick={addNoteHandler} disabled={savingNote||!noteText.trim()}>{savingNote?"Añadiendo…":"Añadir"}</button>
            <div style={{marginTop:16}}>{notes.map(n=><div key={n.id} style={{marginBottom:12}}>
              <div className="row" style={{gap:8,marginBottom:4}}>{ownerAvatar(n.author)}<b style={{fontSize:13}}>{CRM.userById(n.author)?.name}</b><span className="muted" style={{fontSize:12}}>{n.created}</span>
                {user && n.author===user.id && <button className="btn btn--sm btn--ghost right" title="Eliminar nota" onClick={()=>deleteNoteHandler(n)}><Icon name="trash" size={13}/></button>}
              </div>
              <div className="tl-item__body">{n.body}</div>
            </div>)}{notes.length===0&&<span className="muted">Sin notas.</span>}</div>
          </div></div>}
          {tab==="tareas" && <div className="card"><div className="card__head"><h3>Tareas</h3><button className="right btn btn--sm btn--subtle" onClick={()=>setShowNewTask(true)}><Icon name="plus" size={14}/>Nueva tarea</button></div><div className="card__body" style={{paddingTop:6}}>{tasks.length?tasks.map(t=><TaskRow key={t.id} t={t} toast={toast} onToggle={()=>toggleTask(t)} onEdit={()=>setEditingTask(t)} onDelete={()=>deleteTask(t)}/>):<Empty icon="task" title="Sin tareas"/>}</div></div>}
          {tab==="whatsapp" && <div className="card"><div className="card__body">{wa.length? wa[0].messages.map((m,i)=><div key={i} className={"bubble "+(m.dir)} style={{marginBottom:8,maxWidth:"70%"}}>{m.body}<div className="bubble__t">{m.t}</div></div>) : <Empty icon="whatsapp" title="Sin conversación de WhatsApp"/>}</div></div>}
          {tab==="correos" && <div className="wrap-gap">{dealEmails.length? dealEmails.map(e=><EmailThreadCard key={e.id} email={e} toast={toast} bump={bump}/>) : <Empty icon="mail" title="Sin correos vinculados"/>}</div>}
        </div>
      </div>
      {showEdit && <EditDeal deal={d} onClose={()=>setShowEdit(false)} onSave={async(patch)=>{
        try{
          await CRM.updateDeal(Auth.client, id, {...patch, amount:+patch.amount});
          setShowEdit(false);
          toast("Deal actualizado");
          bump();
        }catch(e){
          toast("No se pudo actualizar el deal: "+e.message);
          throw e;
        }
      }}/>}
      {confirmDel && <Modal title="Eliminar deal" onClose={()=>setConfirmDel(false)} footer={<><button className="btn btn--ghost" onClick={()=>setConfirmDel(false)} disabled={deleting}>Cancelar</button><button className="btn btn--danger" onClick={doDelete} disabled={deleting}>{deleting?"Eliminando…":"Eliminar definitivamente"}</button></>}>
        <p className="muted">Se eliminará el deal <b>{d.title}</b>. Esta acción no se puede deshacer.</p>
      </Modal>}
      {showNewTask && <NewTask contactId={d.contact} dealId={id} onClose={()=>setShowNewTask(false)} onSave={async(f)=>{
        try{
          await CRM.addTask(Auth.client, {title:f.title, due_at:f.due, assigned_to:f.owner, contact_id:d.contact, deal_id:id});
          setShowNewTask(false);
          toast("Tarea creada");
          bump();
        }catch(e){
          toast("No se pudo crear: "+e.message);
          throw e;
        }
      }}/>}
      {editingTask && <EditTask task={editingTask} onClose={()=>setEditingTask(null)} onSave={async(f)=>{
        try{
          await CRM.updateTask(Auth.client, editingTask.id, {title:f.title, due_at:f.due||null, assigned_to:f.owner, contact_id:f.contact||null, deal_id:f.deal||null});
          setEditingTask(null);
          toast("Tarea actualizada");
          bump();
        }catch(e){
          toast("No se pudo actualizar: "+e.message);
          throw e;
        }
      }}/>}
    </div>
  );
}
function EditDeal({deal, onClose, onSave}){
  const [f,setF]=uState(()=>{
    var init={...deal};
    Object.keys(init).forEach(function(k){ if(init[k]===null||init[k]===undefined) init[k]=""; });
    if(init.coste_nomina==="") init.coste_nomina = 20;
    return init;
  });
  const [saving,setSaving]=uState(false);
  const isLaboral = f.service===LABORAL_SERVICE_ID;
  const computedAmount = (parseFloat(f.num_nominas)||0) * (parseFloat(f.coste_nomina)||0);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const setService=(e)=>{
    const newId = e.target.value;
    setF(prev=>{
      const next = {...prev, service:newId};
      if(newId===LABORAL_SERVICE_ID){
        next.frequency = "mensual";
        if(next.coste_nomina==="") next.coste_nomina = 20;
      }
      return next;
    });
  };
  const save=async()=>{
    setSaving(true);
    try{
      const payload = isLaboral
        ? {...f, amount:computedAmount, frequency:"mensual"}
        : {...f, num_nominas:"", coste_nomina:""};
      await onSave(payload);
    }
    finally{ setSaving(false); }
  };
  return <Modal title="Editar deal" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Guardando…":"Guardar cambios"}</button></>}>
    <Field label="Título"><input className="inp" value={f.title} onChange={set("title")}/></Field>
    <div className="fld-row">
      <Field label="Servicio"><select className="inp" value={f.service} onChange={setService}>{CRM.SERVICES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Etapa"><select className="inp" value={f.stage} onChange={set("stage")}>{CRM.STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
    </div>
    {isLaboral ? (
      <>
        <div className="fld-row">
          <Field label="Nº de nóminas activas"><input className="inp" type="number" min="0" placeholder="0" value={f.num_nominas} onChange={set("num_nominas")}/></Field>
          <Field label="Coste por nómina (€)"><input className="inp" type="number" min="0" value={f.coste_nomina} onChange={set("coste_nomina")}/></Field>
        </div>
        <Field label="Frecuencia"><select className="inp" value="mensual" disabled><option value="mensual">Mensual</option></select></Field>
        <p className="muted" style={{fontSize:13,margin:"-6px 0 14px"}}>Importe: <b>{CRM.fmtEUR(computedAmount)}</b>/mes</p>
      </>
    ) : (
      <div className="fld-row">
        <Field label="Importe (€)"><input className="inp" type="number" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})}/></Field>
        <Field label="Frecuencia"><select className="inp" value={f.frequency} onChange={set("frequency")}><option value="mensual">mensual</option><option value="trimestral">trimestral</option><option value="anual">anual</option><option value="puntual">puntual</option></select></Field>
      </div>
    )}
    <div className="fld-row">
      <Field label="Owner"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Prioridad"><select className="inp" value={f.priority} onChange={set("priority")}>{CRM.PRIORITIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
    </div>
  </Modal>;
}

/* ============ WHATSAPP ============ */
// Nombre de persona de un contacto como dato principal y su empresa como
// secundario (dos contactos pueden compartir empresa). Las fichas antiguas
// sin full_name — de cuando company era el título — caen a company, y
// entonces la empresa no se repite como secundario.
function contactPersonLabel(c){
  return { name: c.full_name || c.company || "Contacto sin nombre", company: c.full_name ? (c.company||"") : "" };
}
// Teléfono legible de una conversación: phone ya viene con "+"; si faltara,
// se compone desde wa_id (dígitos puros de Meta).
function waPhoneOf(w){ return w.phone || (w.wa_id ? "+"+w.wa_id : ""); }
// Qué pintar como identidad de una conversación (lista, cabecera del hilo y
// pestaña WhatsApp de la ficha). Sin contacto vinculado no hay nombre que
// mostrar — WhatsApp manda un nombre de perfil, pero no se guarda — así que
// el título es el número, sin hacerlo pasar por empresa ni por persona.
//   {linked, name, company, phone}
function waIdentity(w){
  const c = w.contact ? CRM.contactById[w.contact] : null;
  if(c){
    const l = contactPersonLabel(c);
    return { linked:true, name:l.name, company:l.company, phone: c.phone || waPhoneOf(w) };
  }
  return { linked:false, name: waPhoneOf(w) || "Número desconocido", company:"", phone:"" };
}
// Avatar de la conversación: iniciales del contacto si está vinculada; si
// no, el icono de WhatsApp en gris — unas "iniciales" de un teléfono serían
// "+3" y no dicen nada.
function WaAvatar({ident, size="md"}){
  if(ident.linked) return <Avatar name={ident.name} size={size} color={CRM.colorFor(ident.name)}/>;
  return <div className={"av av--"+size} style={{background:"#8299B0"}} title="Sin vincular a un contacto"><Icon name="whatsapp" size={size==="sm"?14:18}/></div>;
}
// Últimos 9 dígitos, mismo criterio que public.phone_last9 en la BD
// (crm/supabase-whatsapp-match.sql). Solo para sugerir, nunca para vincular
// solo.
const phoneLast9 = (raw)=>{ const d=(raw||"").replace(/\D/g,""); return d.length>=9 ? d.slice(-9) : null; };
// Lista de contactos con buscador (nombre, empresa, email, teléfono),
// ordenada por nombre de persona. La usan "Vincular a contacto" y "Nueva
// conversación". suggestPhone: los contactos con ese teléfono (últimos 9
// dígitos) van primero, marcados. disabledReason(c): texto si no se puede
// elegir ese contacto (p. ej. sin teléfono), o null.
function ContactSearchList({onPick, suggestPhone, suggestEmail, disabledReason, placeholder}){
  const [q,setQ]=uState("");
  const query = q.trim().toLowerCase();
  const target = phoneLast9(suggestPhone);
  const targetEmail = (suggestEmail||"").trim().toLowerCase();
  const list = CRM.CONTACTS
    .filter(c=>!query || [c.full_name, c.company, c.email, c.phone].some(v=>(v||"").toLowerCase().includes(query)))
    .map(c=>({c, l:contactPersonLabel(c),
      match: !!target && phoneLast9(c.phone)===target,
      matchEmail: !!targetEmail && (c.email||"").trim().toLowerCase()===targetEmail}))
    .sort((a,b)=>(b.matchEmail-a.matchEmail) || (b.match-a.match) || a.l.name.localeCompare(b.l.name,"es"));
  return <>
    <div className="searchbox" style={{marginBottom:14,minWidth:0}}><Icon name="search" size={16}/><input placeholder={placeholder||"Buscar por nombre, empresa, email o teléfono…"} value={q} onChange={e=>setQ(e.target.value)} autoFocus/></div>
    <div className="wrap-gap" style={{gap:8,maxHeight:360,overflowY:"auto"}}>
      {list.map(({c,l,match,matchEmail})=>{
        const reason = disabledReason ? disabledReason(c) : null;
        return <div key={c.id} className="card" style={reason?{opacity:0.5}:{cursor:"pointer"}} onClick={()=>{ if(!reason) onPick(c); }}>
          <div className="card__body" style={{padding:12,display:"flex",alignItems:"center",gap:10}}>
            <Avatar name={l.name} size="sm" color={CRM.colorFor(l.name)}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:13.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.name}</div>
              <div className="muted" style={{fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{[l.company, c.phone].filter(Boolean).join(" · ") || "—"}</div>
            </div>
            {reason ? <span style={{fontSize:12,color:"var(--danger)",flex:"none"}}>{reason}</span>
              : matchEmail ? <Badge label="Mismo email" color="#1F9D6B"/>
              : match ? <Badge label="Mismo teléfono" color="#1F9D6B"/> : null}
          </div>
        </div>;
      })}
      {list.length===0 && <div className="muted" style={{padding:"20px 0",textAlign:"center",fontSize:13}}>Sin resultados.</div>}
    </div>
  </>;
}
// Ventana de servicio de 24h de Meta: solo se puede escribir texto libre si el
// cliente escribió en las últimas 24h. Misma regla que valida whatsapp-send en
// el backend (crítico); esto es solo para la experiencia — el backend manda.
const WA_WINDOW_MS = 24*60*60*1000;
function isWaWindowOpen(conv){
  if(!conv || !conv.last_customer_message_at) return false;
  const t = new Date(conv.last_customer_message_at).getTime();
  if(isNaN(t)) return false;
  return (Date.now()-t) < WA_WINDOW_MS;
}
// Tipos de whatsapp_messages.type que traen un fichero real (Storage) —
// location/contacts no están: esos ya vienen completos en meta, sin
// adjunto que descargar (ver crm/supabase-functions/whatsapp-webhook).
const WA_MEDIA_TYPES = ["document","image","video","audio","sticker"];

// image/sticker/video/audio comparten el mismo patrón: pedir la URL
// firmada en cuanto se monta la burbuja (hace falta ya para el propio
// src, no se puede esperar a un clic) y mostrar un estado de carga hasta
// tenerla. document es distinto (se pide solo al pulsar, ver
// WaDocumentAttachment) así que no comparte este componente.
function WaAttachmentMedia({att, kind}){
  const [url,setUrl]=uState(null);
  const [showFull,setShowFull]=uState(false);
  uEffect(()=>{
    let alive=true;
    CRM.getAttachmentSignedUrl(Auth.client, att.documento_id).then(u=>{ if(alive) setUrl(u); });
    return ()=>{alive=false;};
  },[att.documento_id]);
  if(!url) return <div className="wa-attach wa-attach--loading"><Icon name="clock" size={14}/>Cargando…</div>;
  if(kind==="video") return <video src={url} controls className="wa-attach__video"/>;
  if(kind==="audio") return <audio src={url} controls className="wa-attach__audio"/>;
  return <>
    <img src={url} className={"wa-attach__thumb"+(kind==="sticker"?" wa-attach__thumb--sticker":"")} onClick={()=>setShowFull(true)} alt={att.filename||"Imagen"}/>
    {showFull && <Modal title={att.filename||"Imagen"} onClose={()=>setShowFull(false)} wide><img src={url} style={{width:"100%",borderRadius:8,display:"block"}}/></Modal>}
  </>;
}
function WaDocumentAttachment({att, toast}){
  const [busy,setBusy]=uState(false);
  const download=async()=>{
    // La pestaña se abre en blanco AQUÍ, síncrono dentro del propio click —
    // si se abriera después del await de abajo, Safari/iOS (y Chrome, algo
    // menos estricto) la bloquean por haber perdido el "gesto de usuario"
    // que autoriza abrir una ventana nueva. Se redirige en cuanto llega la
    // URL firmada.
    const win = window.open("", "_blank");
    setBusy(true);
    try{
      const url = await CRM.getAttachmentSignedUrl(Auth.client, att.documento_id, {download: att.filename||true});
      if(!url){ toast("No se pudo generar el enlace de descarga."); if(win) win.close(); return; }
      if(win) win.location.href = url; else window.open(url, "_blank");
    }finally{ setBusy(false); }
  };
  return <button className="wa-attach wa-attach--doc" onClick={download} disabled={busy}>
    <Icon name="documents" size={20}/>
    <div className="wa-attach__meta">
      <div className="wa-attach__name">{att.filename || "Documento"}</div>
      <div className="wa-attach__size">{busy?"Generando enlace…":CRM.fmtBytes(att.size_bytes)}</div>
    </div>
    <Icon name="download" size={16}/>
  </button>;
}
function WaLocationCard({loc}){
  if(!loc) return null;
  const mapsUrl = "https://www.google.com/maps?q="+loc.lat+","+loc.lng;
  return <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="wa-attach wa-attach--location">
    <Icon name="globe" size={20}/>
    <div className="wa-attach__meta">
      <div className="wa-attach__name">{loc.name || loc.address || "Ubicación compartida"}</div>
      {loc.address && loc.name && <div className="wa-attach__size">{loc.address}</div>}
    </div>
  </a>;
}
function WaContactCard({contacts}){
  const c = contacts && contacts[0];
  if(!c) return null;
  const name = c.name?.formatted_name || "Contacto compartido";
  const phone = c.phones?.[0]?.phone || c.phones?.[0]?.wa_id || "";
  return <div className="wa-attach wa-attach--contact">
    <Icon name="user" size={20}/>
    <div className="wa-attach__meta">
      <div className="wa-attach__name">{name}</div>
      {phone && <div className="wa-attach__size">{phone}</div>}
    </div>
  </div>;
}
// Único punto que decide qué pintar dentro de una burbuja según m.type —
// texto normal si no hay nada especial, o si es un tipo con fichero pero
// sin meta.attachment (mensaje de antes de tener adjuntos: ver comentario
// dentro).
// extractBody (webhook) rellena body con un valor sintético cuando el
// mensaje no trae un caption real escrito por el cliente — nunca hay que
// pintar eso como si lo hubiera escrito. Por tipo:
//   image/document/video: "[imagen]"/"[documento]"/"[vídeo]" cuando no hay
//     caption — y document, además, usa el nombre del fichero como body
//     cuando tampoco hay caption (ya se repite en la propia tarjeta).
//   audio/sticker: SIEMPRE sintético ("[audio]"/"[sticker]") — la API de
//     Meta no tiene concepto de caption para estos dos tipos.
//   location/contacts: body ya es el nombre del sitio/contacto o un
//     "[ubicación]"/"[contacto]" de relleno — en ambos casos es lo mismo
//     que ya se ve en su tarjeta, nunca hay un caption aparte.
const WA_SYNTHETIC_BODY = { image:"[imagen]", document:"[documento]", video:"[vídeo]", audio:"[audio]", sticker:"[sticker]" };
function waRealCaption(m){
  if(!m.body) return null;
  if(m.type==="audio" || m.type==="sticker" || m.type==="location" || m.type==="contacts") return null;
  if(m.body === WA_SYNTHETIC_BODY[m.type]) return null;
  if(m.type==="document" && m.body === m.meta?.attachment?.filename) return null;
  return m.body;
}

function WaMessageContent({m, toast}){
  if(m.type==="location") return <WaLocationCard loc={m.meta?.location}/>;
  if(m.type==="contacts") return <WaContactCard contacts={m.meta?.contacts}/>;

  if(WA_MEDIA_TYPES.includes(m.type)){
    const att = m.meta?.attachment;
    const caption = waRealCaption(m);
    let attachmentEl;
    if(!att){
      // type ya venía como 'document'/'image'/... en BD, pero no hay fila en
      // documentos: es un mensaje recibido antes de activar la descarga de
      // adjuntos. El media de Meta ya ha caducado — no hay nada que
      // recuperar (ver el informe de reconocimiento de esta misma
      // conversación), así que no se intenta, solo se avisa con honestidad.
      attachmentEl = <div className="wa-attach wa-attach--unavailable"><Icon name="documents" size={16}/>Archivo no disponible (recibido antes de activar los adjuntos)</div>;
    } else if(att.status==="pending"){
      attachmentEl = <div className="wa-attach wa-attach--loading"><Icon name="clock" size={14}/>Descargando…</div>;
    } else if(att.status==="failed"){
      attachmentEl = <div className="wa-attach wa-attach--unavailable"><Icon name="x" size={14}/>No se pudo descargar</div>;
    } else if(att.status==="too_large"){
      attachmentEl = <div className="wa-attach wa-attach--unavailable"><Icon name="documents" size={16}/>{(att.filename||"Archivo")+" ("+CRM.fmtBytes(att.size_bytes)+") — demasiado grande, pídelo directamente por WhatsApp"}</div>;
    } else if(m.type==="document"){
      attachmentEl = <WaDocumentAttachment att={att} toast={toast}/>;
    } else {
      attachmentEl = <WaAttachmentMedia att={att} kind={m.type}/>;
    }
    // El caption (si es real) se pinta SIEMPRE debajo del adjunto, sea cual
    // sea su estado — que la descarga fallara no debe hacer desaparecer
    // algo que el cliente sí escribió.
    return <>{attachmentEl}{caption && <div className="wa-caption">{caption}</div>}</>;
  }

  return m.body;
}
// Hilo de WhatsApp reutilizable (mensajes + composer + ventana de 24h +
// plantillas). Lo usan tanto la vista general de WhatsApp, con la conversación
// activa de la lista, como la pestaña "WhatsApp" de la ficha de contacto, de
// forma standalone. La lista de conversaciones (filtro, selección, no
// leídos) es responsabilidad de cada caller — este componente solo conoce la
// conversación concreta que le pasan (nunca null).
// `live`: si es true (por defecto), se suscribe él mismo a los mensajes
// entrantes por Realtime. Pásalo a false cuando el caller ya tiene su propia
// suscripción para toda la lista (la vista general de WhatsApp), para no
// procesar el mismo mensaje dos veces.
// `onBack`: opcional — si se pasa, muestra un botón de volver en la cabecera
// (solo lo usa la vista general en móvil, para volver a la lista).
function WaThread({conv, toast, onConvChange, onViewContact, onBack, live=true}){
  const ident = waIdentity(conv);
  const windowOpen = isWaWindowOpen(conv);
  const [txt,setTxt]=uState(""); const [showTpl,setShowTpl]=uState(false); const [sending,setSending]=uState(false);
  const [showLink,setShowLink]=uState(false);
  const convRef = uRef(conv);
  uEffect(()=>{ convRef.current = conv; },[conv]);
  const onConvChangeRef = uRef(onConvChange);
  uEffect(()=>{ onConvChangeRef.current = onConvChange; });

  const linkTo=async(contactId)=>{
    try{
      await CRM.linkWhatsappConversation(Auth.client, conv.id, contactId);
      onConvChangeRef.current({...convRef.current, contact: contactId});
      setShowLink(false);
      toast(contactId?"Conversación vinculada al contacto":"Conversación desvinculada");
    }catch(e){
      toast("No se pudo actualizar el vínculo: "+(e && e.message ? e.message : String(e)));
    }
  };

  const send=async ()=>{
    if(!txt.trim()||sending||!windowOpen) return;
    const to = conv.wa_id || conv.phone;
    if(!to){ toast("Esta conversación no tiene un número de WhatsApp asociado."); return; }
    const body = txt.trim();
    setSending(true);
    try{
      const res = await Auth.client.functions.invoke("whatsapp-send", { body: { conversation_id: conv.id, to, text: body } });
      if(res.error){ toast(res.error.message || "No se pudo enviar el mensaje."); return; }
      if(res.data && res.data.error){ toast(res.data.message || res.data.error); return; }
      const saved = res.data && res.data.message;
      const msg = saved ? CRM.rowToWhatsappMessage(saved) : {dir:"out", t:"Ahora", body};
      onConvChangeRef.current({...convRef.current, messages:[...convRef.current.messages,msg], updated:msg.t});
      setTxt("");
    }catch(e){
      toast("No se pudo enviar el mensaje: "+(e && e.message ? e.message : String(e)));
    }finally{
      setSending(false);
    }
  };

  // Realtime: mensajes entrantes nuevos de ESTA conversación se añaden al hilo
  // en caliente y reabren la ventana de 24h (last_customer_message_at).
  // UPDATE (p. ej. un adjunto que pasa de pending a stored) refresca el
  // mensaje que ya estaba en el hilo en vez de añadirlo de nuevo — sin
  // esto, ver un PDF pasar a disponible exigía recargar la página entera.
  uEffect(()=>{
    if(!live || !Auth.client || !CRM.subscribeWhatsapp) return;
    const channel = CRM.subscribeWhatsapp(Auth.client, (row, eventType)=>{
      if(row.conversation_id!==convRef.current.id) return;
      const prev = convRef.current;
      if(eventType==="UPDATE"){
        const msg = CRM.rowToWhatsappMessage(row);
        onConvChangeRef.current({...prev, messages: prev.messages.map(m=>m.id===msg.id?msg:m)});
        return;
      }
      if(row.direction!=="in") return;
      const msg = CRM.rowToWhatsappMessage(row);
      onConvChangeRef.current({...prev, messages:[...prev.messages,msg], updated:msg.t, last_customer_message_at: row.created_at});
    });
    return ()=>{ if(channel) Auth.client.removeChannel(channel); };
  },[live, conv.id]);

  return (
    <div className="wa__thread">
      <div className="wa__thread__head">
        {onBack && <button className="wa__back" onClick={onBack} aria-label="Volver a la lista"><Icon name="chevronR" size={20} style={{transform:"rotate(180deg)"}}/></button>}
        <div className="wa__thread__id">
          <WaAvatar ident={ident}/>
          <div className="wa__thread__idtext"><div style={{fontWeight:600}}>{ident.name}</div><div className="muted" style={{fontSize:12}}>{ident.linked ? [ident.company, ident.phone].filter(Boolean).join(" · ") : "Sin vincular a un contacto"}</div></div>
        </div>
        <div className="wa__thread__actions">
          <button className="wa__tpl-btn" onClick={()=>setShowTpl(true)} title="Plantillas de WhatsApp"><Icon name="documents" size={15}/>Plantillas</button>
          {onViewContact && <button className="btn btn--sm btn--ghost" onClick={onViewContact}>Ver ficha</button>}
          {conv.contact
            ? <button className="btn btn--sm btn--ghost" onClick={()=>linkTo(null)}><Icon name="tag" size={13}/>Desvincular</button>
            : <button className="btn btn--sm btn--ghost" onClick={()=>setShowLink(true)}><Icon name="tag" size={13}/>Vincular a contacto</button>}
        </div>
      </div>
      <div className="wa__msgs">{conv.messages.map((m,i)=><div key={i} className={"bubble "+m.dir}><WaMessageContent m={m} toast={toast}/><div className="bubble__t">{m.t}</div></div>)}</div>
      {windowOpen ? (
        <div className="wa__compose"><button className="btn btn--ghost btn--icon" title="Enviar plantilla" onClick={()=>setShowTpl(true)}><Icon name="documents" size={17}/></button><input placeholder="Escribe un mensaje…" value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")send();}} disabled={sending}/><button className="btn btn--primary btn--icon" onClick={send} disabled={sending}><Icon name="send" size={18}/></button></div>
      ) : (
        <div className="wa__compose wa__compose--notice">
          <span className="muted wa__compose__notice" style={{fontSize:13}}>La ventana de 24h ha expirado. Necesitas que el cliente responda para volver a escribir texto libre — mientras tanto puedes enviarle una plantilla aprobada.</span>
          <button className="btn btn--sm btn--primary" style={{flex:"none"}} onClick={()=>setShowTpl(true)}>Enviar plantilla</button>
        </div>
      )}
      {showTpl && <TemplatesModal onClose={()=>setShowTpl(false)} conversationId={conv.id} onSent={({message})=>{ if(message) onConvChangeRef.current({...convRef.current, messages:[...convRef.current.messages,message], updated:message.t}); }} toast={toast}/>}
      {showLink && <LinkWhatsapp conv={conv} onClose={()=>setShowLink(false)} onSave={linkTo}/>}
    </div>
  );
}
// Buscador de contactos (ContactSearchList) en vez de un select: con muchos
// contactos un select es inmanejable, y por persona + empresa se distingue
// a dos contactos de la misma empresa. Los que tienen el mismo teléfono que
// la conversación salen primero como sugerencia; vincular sigue siendo
// decisión de quien pulsa Guardar.
// Dónde acabarán los adjuntos al vincular: en la carpeta WhatsApp de la
// empresa principal del contacto (public.empresa_principal_de decide en la
// BD; esto solo lo anticipa).
function linkEmpresaNote(contact){
  if(!contact) return "Sus adjuntos pasarán a la carpeta WhatsApp de la empresa principal del contacto que elijas.";
  const e = CRM.empresaPrincipalDe(contact.id);
  return e ? <>Sus adjuntos pasarán a la carpeta WhatsApp de <b>{e.razon_social}</b>.</>
    : "Este contacto no tiene empresa: sus adjuntos se quedarán sin carpeta hasta que tenga una.";
}
function LinkWhatsapp({conv, onClose, onSave}){
  const [contact,setContact]=uState(conv.contact ? CRM.contactById[conv.contact] || null : null);
  const [saving,setSaving]=uState(false);
  const save=async()=>{ if(!contact) return; setSaving(true); try{ await onSave(contact.id); }finally{ setSaving(false); } };
  const l = contact ? contactPersonLabel(contact) : null;
  return <Modal title="Vincular a contacto" onClose={()=>{ if(!saving) onClose(); }} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={!contact||saving}>{saving?"Guardando…":"Guardar"}</button></>}>
    <p className="muted" style={{fontSize:12.5,marginBottom:12}}>Conversación con <b>{waPhoneOf(conv) || "número desconocido"}</b>. {linkEmpresaNote(contact)}</p>
    {contact ? <div className="row" style={{gap:10,justifyContent:"space-between"}}>
      <div className="row" style={{gap:10,minWidth:0}}>
        <Avatar name={l.name} size="sm" color={CRM.colorFor(l.name)}/>
        <div style={{minWidth:0}}><div style={{fontWeight:600,fontSize:13.5}}>{l.name}</div><div className="muted" style={{fontSize:12}}>{[l.company, contact.phone].filter(Boolean).join(" · ") || "—"}</div></div>
      </div>
      <button className="btn btn--sm btn--ghost" onClick={()=>setContact(null)} disabled={saving}>Cambiar</button>
    </div> : <ContactSearchList onPick={setContact} suggestPhone={waPhoneOf(conv)}/>}
  </Modal>;
}
function WhatsApp({nav, toast, focusId}){
  const [convs,setConvs]=uState(()=>CRM.WHATSAPP.map(w=>({...w,messages:[...w.messages]})));
  const [filter,setFilter]=uState("active");
  const [active,setActive]=uState(convs.find(w=>!w.archived)?.id || null);
  const [showStart,setShowStart]=uState(false);
  const isMobile = useIsMobile();
  const visible = convs.filter(w=>filter==="active" ? !w.archived : w.archived);
  const conv = convs.find(w=>w.id===active);
  // Maestro-detalle en móvil: en desktop se pintan siempre los dos paneles
  // (como hoy); en móvil solo uno, según haya o no conversación activa. No es
  // un estado nuevo — se deriva de `active` en cada render, así que no puede
  // desincronizarse al cruzar el breakpoint (resize/rotación): si `active`
  // sigue siendo válido, desktop simplemente vuelve a mostrar los dos paneles.
  const showList = !isMobile || !conv;
  const showThread = !isMobile || !!conv;
  const activeRef = uRef(active);
  uEffect(()=>{ activeRef.current = active; },[active]);
  const toggleArchive=async(id,e)=>{
    e.stopPropagation();
    const w=convs.find(x=>x.id===id); if(!w) return;
    const newVal=!w.archived;
    try{
      await CRM.setArchived(Auth.client, id, newVal);
      setConvs(cs=>cs.map(x=>x.id===id?{...x,archived:newVal}:x));
      toast(newVal?"Conversación archivada":"Conversación restaurada");
      if(active===id) setActive(null);
    }catch(e){
      toast("No se pudo "+(newVal?"archivar":"restaurar")+" la conversación: "+(e && e.message ? e.message : String(e)));
    }
  };
  uEffect(()=>{
    if(!visible.find(w=>w.id===active)) setActive(visible[0]?.id || null);
  },[filter]);
  // Enfocar una conversación por id al llegar desde fuera (p. ej. "Nueva
  // conversación" o el botón de WhatsApp en la ficha de contacto). Si aún no
  // está cargada en esta sesión (se acaba de crear), se trae de Supabase.
  uEffect(()=>{
    if(!focusId) return;
    const existing = convs.find(w=>w.id===focusId);
    if(existing){ setFilter(existing.archived?"archived":"active"); setActive(focusId); return; }
    if(!Auth.client || !CRM.loadWhatsappConversationById) return;
    (async ()=>{
      const conv = await CRM.loadWhatsappConversationById(Auth.client, focusId);
      if(!conv) return;
      setConvs(cs=>[{...conv, messages:[...conv.messages]}, ...cs]);
      setFilter(conv.archived?"archived":"active");
      setActive(conv.id);
    })();
  },[focusId]);
  // Realtime: mensajes entrantes nuevos se añaden a la conversación que les
  // corresponde (para la vista previa en la lista). Si es la conversación
  // abierta, <WaThread> ya se encarga de sí mismo (ver prop live=false más
  // abajo), pero igualmente actualizamos aquí su vista previa/hora en la
  // lista; solo el contador de no leídos distingue abierta vs. no abierta.
  // UPDATE (adjunto pending→stored, delivery_status...) solo refresca el
  // mensaje ya presente — nunca cuenta como no leído ni toca "updated".
  uEffect(()=>{
    if(!Auth.client || !CRM.subscribeWhatsapp) return;
    const channel = CRM.subscribeWhatsapp(Auth.client, (row, eventType)=>{
      const msg = CRM.rowToWhatsappMessage(row);
      setConvs(cs=>{
        const idx = cs.findIndex(w=>w.id===row.conversation_id);
        if(idx===-1) return cs; // conversación nueva no cargada aún: aparecerá al recargar
        if(eventType==="UPDATE"){
          return cs.map((w,i)=> i!==idx ? w : {...w, messages: w.messages.map(m=>m.id===msg.id?msg:m)});
        }
        if(row.direction!=="in") return cs; // los salientes ya se añaden al enviar
        const isOpen = activeRef.current===row.conversation_id;
        return cs.map((w,i)=> i!==idx ? w : {...w, messages:[...w.messages,msg], updated:msg.t, last_customer_message_at: row.created_at, unread: isOpen ? w.unread : w.unread+1});
      });
    });
    return ()=>{ if(channel) Auth.client.removeChannel(channel); };
  },[]);
  return (
    <div className="wa">
      {showList && <div className="wa__list">
        <div className="wa__list__head">
          <button className="btn btn--sm btn--primary" onClick={()=>setShowStart(true)}><Icon name="plus" size={15}/>Nueva conversación</button>
        </div>
        <div className="wa__tabs">
          <button className={filter==="active"?"active":""} onClick={()=>setFilter("active")}>Activas</button>
          <button className={filter==="archived"?"active":""} onClick={()=>setFilter("archived")}>Archivadas</button>
        </div>
        {visible.map(w=>{ const ident=waIdentity(w); const last=w.messages[w.messages.length-1];
          return <div key={w.id} className={"wa__conv"+(active===w.id?" active":"")} onClick={()=>{setActive(w.id);nav("whatsapp",w.id);setConvs(cs=>cs.map(x=>x.id===w.id?{...x,unread:0}:x));}}>
            <WaAvatar ident={ident}/>
            <div className="wa__conv__main"><div className="wa__conv__name"><span style={{minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ident.name}{ident.company && <span className="muted" style={{fontWeight:400,fontSize:12}}> · {ident.company}</span>}</span><span className="wa__conv__time">{w.updated}</span></div><div className="wa__conv__last">{last?(last.dir==="out"?"Tú: ":"")+last.body:"—"}</div></div>
            {w.unread>0 && <span className="wa__unread">{w.unread}</span>}
            <button className="wa__archive" title={w.archived?"Restaurar":"Archivar"} onClick={e=>toggleArchive(w.id,e)}><Icon name={w.archived?"refresh":"archive"} size={15}/></button>
          </div>;
        })}
        {visible.length===0 && <div className="muted" style={{padding:"24px 16px",fontSize:13,textAlign:"center"}}>{filter==="active"?"Sin conversaciones activas.":"No hay conversaciones archivadas."}</div>}
      </div>}
      {showThread && (conv ? <WaThread conv={conv} toast={toast} live={false}
        onConvChange={updated=>setConvs(cs=>cs.map(w=>w.id===updated.id?updated:w))}
        onViewContact={conv.contact?()=>nav("contact",conv.contact):undefined}
        onBack={isMobile?()=>{setActive(null);nav("whatsapp",null);}:undefined}/>
      : <div className="wa__thread"><div className="muted" style={{margin:"auto",fontSize:13}}>{filter==="archived"?"Selecciona una conversación archivada.":"Sin conversaciones."}</div></div>)}
      {showStart && <StartWhatsappModal onClose={()=>setShowStart(false)} nav={nav} toast={toast}/>}
    </div>
  );
}
function TemplatesModal({onClose, conversationId, contactId, onSent, toast}){
  const [templates,setTemplates]=uState(()=>[...CRM.WA_TEMPLATES]);
  const [importing,setImporting]=uState(false);
  const [selected,setSelected]=uState(null); // plantilla elegida en el paso 2, con bodyText/count precalculados
  const [values,setValues]=uState([]); // valores de las variables, values[0] -> {{1}}
  const [sending,setSending]=uState(false);

  const importFromMeta=async ()=>{
    setImporting(true);
    try{
      const res = await Auth.client.functions.invoke("whatsapp-sync-templates", { body: {} });
      if(res.error){ toast(res.error.message || "No se pudo sincronizar con Meta."); return; }
      if(res.data && res.data.error){ toast(res.data.error); return; }
      if(CRM.loadWaTemplates) await CRM.loadWaTemplates(Auth.client);
      setTemplates([...CRM.WA_TEMPLATES]);
      toast((res.data && res.data.synced!=null ? res.data.synced : CRM.WA_TEMPLATES.length)+" plantillas sincronizadas desde Meta Business Manager");
    }catch(e){
      toast("No se pudo sincronizar con Meta: "+(e && e.message ? e.message : String(e)));
    }finally{
      setImporting(false);
    }
  };

  const openTemplate = (t)=>{
    const bodyText = CRM.waExtractBodyText(t.components);
    const {count} = CRM.waAnalyzeBodyVariables(bodyText);
    setSelected({...t, bodyText, count});
    setValues(Array(count).fill(""));
  };
  const back = ()=>{ setSelected(null); setValues([]); };

  // Huecos sin rellenar (vacíos o solo espacios) se ven como {{n}} en la vista previa.
  const preview = selected ? selected.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m,n)=>{
    const v = values[Number(n)-1];
    return (v && v.trim()) ? v : "{{"+n+"}}";
  }) : "";
  const canSend = !!selected && !sending && (selected.count===0 || values.every(v=>v && v.trim()));

  const sendTemplate = async ()=>{
    if(!canSend || (!conversationId && !contactId)) return;
    setSending(true);
    try{
      const body = { type: "template", template: { name: selected.name, language: selected.lang, variables: values } };
      if(conversationId) body.conversation_id = conversationId; else body.contact_id = contactId;
      const res = await Auth.client.functions.invoke("whatsapp-send", { body });
      if(res.error){ toast(res.error.message || "No se pudo enviar la plantilla."); return; }
      if(res.data && res.data.error){ toast(res.data.message || res.data.error); return; }
      const saved = res.data && res.data.message;
      if(onSent) onSent({ message: saved ? CRM.rowToWhatsappMessage(saved) : null, conversationId: res.data && res.data.conversation_id });
      onClose();
    }catch(e){
      toast("No se pudo enviar la plantilla: "+(e && e.message ? e.message : String(e)));
    }finally{
      setSending(false);
    }
  };

  if(selected){
    return <Modal title={"Enviar plantilla · "+selected.name} wide onClose={onClose} footer={<>
      <button className="btn btn--ghost" onClick={back} disabled={sending}>Volver</button>
      <button className="btn btn--primary" onClick={sendTemplate} disabled={!canSend}>{sending?"Enviando…":"Enviar"}</button>
    </>}>
      <div className="card" style={{marginBottom:16}}><div className="card__body" style={{padding:14}}>
        <div className="muted" style={{fontSize:11.5,marginBottom:6}}>Vista previa</div>
        <div className="tl-item__body">{preview}</div>
      </div></div>
      {selected.count>0 && Array.from({length:selected.count}).map((_,i)=>(
        <Field key={i} label={"Variable "+(i+1)}>
          <input className="inp" value={values[i]||""} placeholder={"Valor para {{"+(i+1)+"}}"}
            onChange={e=>{ const next=[...values]; next[i]=e.target.value; setValues(next); }}/>
        </Field>
      ))}
    </Modal>;
  }

  return <Modal title="Plantillas de WhatsApp" wide onClose={onClose} footer={<button className="btn btn--ghost" onClick={onClose}>Cerrar</button>}>
    <div className="row" style={{justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,gap:16}}>
      <p className="muted" style={{maxWidth:420,margin:0}}>Plantillas aprobadas en el WhatsApp Business Manager de Meta. Impórtalas para reutilizarlas al escribir a un cliente.</p>
      <button className="btn btn--sm btn--primary" style={{flex:"none"}} onClick={importFromMeta} disabled={importing}>{importing? "Importando…" : <><Icon name="download" size={14}/>Importar desde Meta</>}</button>
    </div>
    <div className="wrap-gap" style={{gap:10}}>
      {templates.map(t=>{
        const issue = CRM.waTemplateSendIssue(t.components, t.parameter_format);
        return <div key={t.id} className="card" style={issue?{opacity:0.55}:undefined}><div className="card__body" style={{padding:14}}>
          <div className="row" style={{justifyContent:"space-between"}}>
            <div className="row" style={{gap:8}}><span style={{fontWeight:700,fontFamily:"var(--display)",fontSize:13.5}}>{t.name}</span><Badge label={t.category} color="#6E8298"/><span className="muted" style={{fontSize:11.5}}>{t.lang}</span></div>
            <button className="btn btn--sm btn--subtle" onClick={()=>openTemplate(t)} disabled={!!issue}>Usar</button>
          </div>
          <div className="tl-item__body" style={{marginTop:8}}>{t.body}</div>
          {issue && <div className="muted" style={{marginTop:8,fontSize:12,color:"var(--danger)"}}>{issue}</div>}
        </div></div>;
      })}
    </div>
  </Modal>;
}
// Iniciar una conversación de WhatsApp con un contacto que todavía no ha
// escrito nunca. Sin conversación previa la ventana de 24h está cerrada por
// definición, así que este flujo va siempre a plantilla (reutiliza
// TemplatesModal en vez de duplicar el paso de elegir plantilla/variables).
function StartWhatsappModal({onClose, initialContact, nav, toast}){
  const [contact,setContact]=uState(initialContact||null);

  if(!contact){
    return <Modal title="Nueva conversación de WhatsApp" onClose={onClose} footer={<button className="btn btn--ghost" onClick={onClose}>Cancelar</button>}>
      <ContactSearchList onPick={setContact} disabledReason={c=>c.phone ? null : "Sin teléfono"}/>
    </Modal>;
  }

  return <TemplatesModal
    onClose={onClose}
    contactId={contact.id}
    onSent={({conversationId})=>{ if(conversationId) nav("whatsapp", conversationId); }}
    toast={toast}
  />;
}

/* ============ BANDEJA DE ENTRADA (Gmail) ============ */
function Inbox({nav, toast}){
  const [,setTick]=uState(0); const bump=()=>setTick(t=>t+1);
  const [folder,setFolder]=uState("inbox"); const [showArchived,setShowArchived]=uState(false);
  const [active,setActive]=uState(null); const [reply,setReply]=uState("");
  const [showCompose,setShowCompose]=uState(false); const [showFolder,setShowFolder]=uState(false); const [showLink,setShowLink]=uState(null);

  const list = CRM.EMAILS.filter(e=> showArchived ? e.archived : (!e.archived && e.folder===folder));
  const conv = CRM.EMAILS.find(e=>e.id===active);
  const contact = conv?.contact ? CRM.contactById[conv.contact] : null;
  const deal = conv?.deal ? CRM.DEALS.find(d=>d.id===conv.deal) : null;

  const openConv=(e)=>{ setActive(e.id); };
  const send=()=>{ if(!reply.trim()||!conv) return; CRM.addEmailReply(conv.id, reply.trim()); setReply(""); bump(); toast("Respuesta enviada (simulada — se enviará de verdad al conectar Gmail)"); };
  const archive=(e,ev)=>{ ev.stopPropagation(); CRM.setEmailArchived(e.id, !e.archived); toast(e.archived?"Restaurado":"Archivado"); if(active===e.id) setActive(null); bump(); };
  const moveTo=(e,folderId,ev)=>{ ev.stopPropagation(); CRM.moveEmailToFolder(e.id, folderId); toast("Movido a "+CRM.folderById[folderId].label); bump(); };

  return (
    <div className="inbox">
      <div className="inbox__folders">
        <button className="btn btn--primary inbox__compose" onClick={()=>setShowCompose(true)}><Icon name="mail" size={16}/>Redactar</button>
        {CRM.FOLDERS.map(f=>{
          const n = CRM.EMAILS.filter(e=>!e.archived && e.folder===f.id && CRM.unreadOf(e)).length;
          return <div key={f.id} className={"folder-item"+(!showArchived && folder===f.id?" active":"")} onClick={()=>{setShowArchived(false);setFolder(f.id);setActive(null);}}>
            <span className="dot" style={{background:f.color}}></span>{f.label}{n>0 && <span className="folder-item__count">{n}</span>}
          </div>;
        })}
        <div className={"folder-item"+(showArchived?" active":"")} onClick={()=>{setShowArchived(true);setActive(null);}}><Icon name="archive" size={15}/>Archivados</div>
        <div className="inbox__addfolder" onClick={()=>setShowFolder(true)}><Icon name="plus" size={14}/>Nueva carpeta</div>
      </div>
      <div className="inbox__list">
        {list.map(e=>{
          const unread = CRM.unreadOf(e);
          const cc = e.contact ? CRM.contactById[e.contact] : null;
          const last = e.messages[e.messages.length-1];
          return <div key={e.id} className={"inbox__row"+(active===e.id?" active":"")+(unread?" unread":"")} onClick={()=>openConv(e)}>
            <Avatar name={cc? cc.company : (last.from||"?")} size="md" color={cc? CRM.colorFor(cc.company) : "#6E8298"}/>
            <div className="inbox__row__main">
              <div className="inbox__row__top"><span>{cc? cc.company : last.from}</span><span>{e.updated}</span></div>
              <div className="inbox__subject">{e.subject}</div>
              <div className="inbox__snippet">{last.body}</div>
            </div>
            <div className="inbox__row__actions">
              <button className="btn btn--sm btn--ghost" title={e.archived?"Restaurar":"Archivar"} onClick={ev=>archive(e,ev)}><Icon name={e.archived?"refresh":"archive"} size={13}/></button>
            </div>
          </div>;
        })}
        {list.length===0 && <div className="muted" style={{padding:"24px 16px",fontSize:13,textAlign:"center"}}>Sin correos aquí.</div>}
      </div>
      <div className="inbox__thread">
        {conv ? <>
          <div className="inbox__thread__head">
            <div style={{fontWeight:700,fontFamily:"var(--display)",fontSize:16}}>{conv.subject}</div>
            <div className="row" style={{marginTop:8,flexWrap:"wrap",gap:8}}>
              {contact ? <Badge label={contact.company} color="#1F6FEB"/> : <Badge label="Sin vincular" color="#6E8298"/>}
              {deal && <Badge label={deal.title} color="#7C5CFC"/>}
              <button className="btn btn--sm btn--ghost" onClick={()=>setShowLink(conv)}><Icon name="tag" size={13}/>Vincular</button>
              {contact && <button className="btn btn--sm btn--ghost" onClick={()=>nav("contact",contact.id)}><Icon name="external" size={13}/>Ver ficha</button>}
              <select className="inp" style={{width:"auto",padding:"5px 10px",fontSize:12.5}} value={conv.folder} onChange={ev=>moveTo(conv,ev.target.value,ev)}>{CRM.FOLDERS.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select>
              <button className="btn btn--sm btn--ghost" onClick={ev=>archive(conv,ev)}><Icon name={conv.archived?"refresh":"archive"} size={13}/>{conv.archived?"Restaurar":"Archivar"}</button>
            </div>
          </div>
          <div className="inbox__thread__body">
            {conv.messages.map((m,i)=><div key={i} className={"email-card "+m.dir}>
              <div className="email-card__head"><span><b style={{color:"var(--ink)"}}>{m.from}</b> → {m.to}</span><span>{m.date}</span></div>
              <div className="email-card__body">{m.body}</div>
            </div>)}
          </div>
          <div className="inbox__reply">
            <textarea placeholder="Escribe una respuesta…" value={reply} onChange={e=>setReply(e.target.value)}></textarea>
            <div className="row" style={{marginTop:8,justifyContent:"flex-end"}}><button className="btn btn--primary btn--sm" onClick={send}><Icon name="send" size={14}/>Responder</button></div>
          </div>
        </> : <div className="muted" style={{margin:"auto",fontSize:13}}>Selecciona un correo</div>}
      </div>
      {showCompose && <ComposeEmail onClose={()=>setShowCompose(false)} onSend={(f)=>{
        const thread=CRM.addEmailThread({subject:f.subject, messages:[{dir:"out",from:CRM.MAILBOX,to:f.to,date:"Ahora",body:f.body}]});
        setShowCompose(false); setFolder("inbox"); setShowArchived(false); setActive(thread.id);
        toast("Correo enviado (simulado — se enviará de verdad al conectar Gmail)"); bump();
      }}/>}
      {showFolder && <NewFolder onClose={()=>setShowFolder(false)} onSave={(name)=>{CRM.addFolder(name);setShowFolder(false);toast("Carpeta creada");bump();}}/>}
      {showLink && <LinkEmail email={showLink} onClose={()=>setShowLink(null)} onSave={(patch)=>{CRM.linkEmail(showLink.id,patch);setShowLink(null);toast("Correo vinculado");bump();}}/>}
    </div>
  );
}
function ComposeEmail({onClose,onSend}){
  const [to,setTo]=uState(""); const [subject,setSubject]=uState(""); const [body,setBody]=uState("");
  return <Modal title="Redactar correo" wide onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={()=>to.trim()&&subject.trim()&&onSend({to:to.trim(),subject:subject.trim(),body})}><Icon name="send" size={15}/>Enviar</button></>}>
    <Field label="Para"><input className="inp" placeholder="destinatario@empresa.es" value={to} onChange={e=>setTo(e.target.value)}/></Field>
    <Field label="Asunto"><input className="inp" value={subject} onChange={e=>setSubject(e.target.value)}/></Field>
    <Field label="Mensaje"><textarea className="inp" style={{minHeight:160}} value={body} onChange={e=>setBody(e.target.value)}></textarea></Field>
    <p className="muted" style={{fontSize:12}}>Se enviará desde {CRM.MAILBOX}. Hasta que conectemos Gmail de verdad, el envío queda simulado dentro del CRM.</p>
  </Modal>;
}
function NewFolder({onClose,onSave}){
  const [name,setName]=uState("");
  return <Modal title="Nueva carpeta" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={()=>name.trim()&&onSave(name.trim())}>Crear</button></>}>
    <Field label="Nombre de la carpeta"><input className="inp" placeholder="Ej. Renovaciones" value={name} onChange={e=>setName(e.target.value)}/></Field>
  </Modal>;
}
function LinkEmail({email, onClose, onSave}){
  const [contact,setContact]=uState(email.contact||""); const [deal,setDeal]=uState(email.deal||"");
  const deals = contact? CRM.DEALS.filter(d=>d.contact===contact) : [];
  return <Modal title="Vincular correo" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={()=>onSave({contact:contact||null, deal:deal||null})}>Guardar</button></>}>
    <Field label="Contacto"><select className="inp" value={contact} onChange={e=>{setContact(e.target.value);setDeal("");}}><option value="">— Sin vincular —</option>{CRM.CONTACTS.map(c=><option key={c.id} value={c.id}>{c.company}</option>)}</select></Field>
    <Field label="Deal (opcional)"><select className="inp" value={deal} onChange={e=>setDeal(e.target.value)} disabled={!contact}><option value="">— Ninguno —</option>{deals.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
  </Modal>;
}

function EmailThreadCard({email, toast, bump}){
  const [reply,setReply]=uState(""); const [open,setOpen]=uState(false);
  const send=()=>{ if(!reply.trim())return; CRM.addEmailReply(email.id, reply.trim()); setReply(""); bump(); toast("Respuesta enviada (simulada — se enviará de verdad al conectar Gmail)"); };
  const last = email.messages[email.messages.length-1];
  return <div className="card">
    <div className="card__head" style={{cursor:"pointer"}} onClick={()=>setOpen(o=>!o)}>
      <Icon name="mail" size={16} style={{color:"var(--accent)"}}/>
      <h3 style={{fontSize:14}}>{email.subject}</h3>
      {email.archived && <Badge label="Archivado" color="#6E8298"/>}
      <span className="right muted" style={{fontSize:12}}>{email.updated}</span>
    </div>
    <div className="card__body" style={{paddingTop:12}}>
      {open ? <>
        <div className="wrap-gap" style={{gap:10}}>
          {email.messages.map((m,i)=><div key={i} className={"email-card "+m.dir}>
            <div className="email-card__head"><span><b style={{color:"var(--ink)"}}>{m.from}</b> → {m.to}</span><span>{m.date}</span></div>
            <div className="email-card__body">{m.body}</div>
          </div>)}
        </div>
        <div style={{marginTop:12}}>
          <textarea className="inp" placeholder="Responder…" value={reply} onChange={e=>setReply(e.target.value)} style={{minHeight:70}}></textarea>
          <div className="row" style={{marginTop:8,justifyContent:"flex-end"}}><button className="btn btn--sm btn--primary" onClick={send}><Icon name="send" size={14}/>Responder</button></div>
        </div>
      </> : <div className="muted" style={{fontSize:12.5}}>{last.body}</div>}
    </div>
  </div>;
}

/* ============ DOCUMENTS ============ */
// Vista global sobre public.documentos: buscador, filtro por contacto y por
// carpeta, descarga con URL firmada y borrado. Incluye los adjuntos sin
// contacto (conversación de WhatsApp sin vincular o contacto borrado).
// Subir, mover y gestionar carpetas se hace desde la ficha del contacto,
// que es donde viven las carpetas.
const DOC_FILTER_NONE = "__none__";
function Documents({nav, toast}){
  const [docs,setDocs]=uState(null); // null = cargando
  const [loadErr,setLoadErr]=uState(null);
  const [q,setQ]=uState("");
  const [empresaF,setEmpresaF]=uState("");
  const [folderF,setFolderF]=uState("");
  const [delDoc,setDelDoc]=uState(null);
  const [previewDoc,setPreviewDoc]=uState(null);
  const [renameDoc,setRenameDoc]=uState(null);
  const [download,busyId]=useDocDownload(toast);
  const [toggleShare,sharingId]=useDocShare(toast, (upd)=>setDocs(ds=>(ds||[]).map(x=>x.id===upd.id?{...upd, folder_path:x.folder_path, folder_root_name:x.folder_root_name}:x)));
  const isMobile = useIsMobile();

  const reload=async()=>{
    try{ setDocs(await CRM.loadAllDocumentos(Auth.client)); setLoadErr(null); }
    catch(e){ setLoadErr(CRM.docErrorMessage(e)); }
  };
  uEffect(()=>{ reload(); },[]);

  const all = docs || [];
  // Opciones de filtro a partir de lo que hay, no del catálogo completo:
  // solo empresas con documentos, y carpetas por nombre (agrupa "Fiscal"
  // de todas las empresas). "Sin empresa": adjuntos de conversaciones sin
  // vincular.
  const empresaOpts = uMemo(()=>{
    const ids = Array.from(new Set(all.map(d=>d.empresa_id).filter(Boolean)));
    return ids.map(id=>({id, label:docEmpresaLabel(id)||"Empresa sin cargar"})).sort((a,b)=>a.label.localeCompare(b.label,"es"));
  },[docs]);
  // Filtro por carpeta RAÍZ: "Fiscal" incluye lo que hay en "Fiscal / 2026".
  const folderOpts = uMemo(()=>Array.from(new Set(all.map(d=>d.folder_root_name).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"es")),[docs]);
  const hasOrphans = all.some(d=>!d.empresa_id);

  const needle = q.trim().toLowerCase();
  const shown = all.filter(d=>{
    if(empresaF===DOC_FILTER_NONE ? !!d.empresa_id : (empresaF && d.empresa_id!==empresaF)) return false;
    if(folderF===DOC_FILTER_NONE ? !!d.folder_id : (folderF && d.folder_root_name!==folderF)) return false;
    if(!needle) return true;
    return [docName(d), docEmpresaLabel(d.empresa_id)||"", docContactLabel(d.aportado_por)||"", d.folder_path].some(s=>s.toLowerCase().includes(needle));
  });
  const filtering = !!(needle || empresaF || folderF);

  const empresaCell = (d)=>{
    const label = docEmpresaLabel(d.empresa_id);
    if(!d.empresa_id) return <span className="muted">Sin empresa</span>;
    if(!label) return <span className="muted">—</span>;
    return <a className="doc-link" onClick={e=>{ e.stopPropagation(); nav("empresa", d.empresa_id); }}>{label}</a>;
  };
  // Origen: WhatsApp o área cliente (con quién lo aportó, si se sabe) o el admin que lo subió.
  const origin = (d)=>{
    if(d.source==="whatsapp" || d.source==="cliente"){
      const who = docContactLabel(d.aportado_por);
      return <div className="row" style={{gap:6,flexWrap:"wrap"}}><DocSourceBadge doc={d}/>{who && <a className="doc-link" style={{fontSize:12.5}} onClick={e=>{ e.stopPropagation(); nav("contact", d.aportado_por); }}>{who}</a>}</div>;
    }
    return ownerAvatar(d.uploaded_by) || <span className="muted" style={{fontSize:12.5}}>Manual</span>;
  };

  return <div className="content">
    <div className="toolbar doc-toolbar">
      <div className="searchbox"><Icon name="search" size={16}/><input placeholder="Buscar documento, empresa, contacto o carpeta…" value={q} onChange={e=>setQ(e.target.value)}/></div>
      <select className="inp doc-filter" value={empresaF} onChange={e=>setEmpresaF(e.target.value)} aria-label="Filtrar por empresa">
        <option value="">Todas las empresas</option>
        {hasOrphans && <option value={DOC_FILTER_NONE}>Sin empresa</option>}
        {empresaOpts.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <select className="inp doc-filter" value={folderF} onChange={e=>setFolderF(e.target.value)} aria-label="Filtrar por carpeta">
        <option value="">Todas las carpetas</option>
        {hasOrphans && <option value={DOC_FILTER_NONE}>Sin carpeta</option>}
        {folderOpts.map(n=><option key={n} value={n}>{n}</option>)}
      </select>
      {filtering && <button className="btn btn--sm btn--ghost" onClick={()=>{setQ("");setEmpresaF("");setFolderF("");}}>Limpiar</button>}
    </div>

    {loadErr ? <Empty icon="documents" title="No se pudieron cargar los documentos" sub={loadErr} action={<button className="btn btn--sm btn--primary" onClick={reload}><Icon name="refresh" size={14}/>Reintentar</button>}/>
    : !docs ? <div className="muted" style={{padding:16}}>Cargando documentos…</div>
    : isMobile ? (
      <div className="wrap-gap">
        {shown.map(d=>(
          <div key={d.id} className="card">
            <div className="card__body">
              <div className="row" style={{gap:10,alignItems:"flex-start"}}>
                <div className="lrow__ico"><Icon name="documents" size={17}/></div>
                <div style={{flex:1,minWidth:0}}>
                  <div className="tbl__name doc-row__name">{docName(d)}</div>
                  <div className="muted" style={{fontSize:12.5,marginTop:2}}>{empresaCell(d)}{d.folder_path ? " · "+d.folder_path : ""}</div>
                  <div className="muted" style={{fontSize:12,marginTop:2}}>{[CRM.fmtBytes(d.size_bytes), d.created, docAportadoLabel(d)].filter(Boolean).join(" · ")}</div>
                </div>
              </div>
              <div className="row" style={{marginTop:10,justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                <div className="row" style={{gap:6,flexWrap:"wrap"}}><DocSourceBadge doc={d}/><DocStatusBadge doc={d}/><DocShareBadge doc={d}/></div>
                <DocActions doc={d} onDownload={download} downloading={busyId===d.id} onPreview={setPreviewDoc} onRename={setRenameDoc} onDelete={setDelDoc}
                  onToggleShare={d.empresa_id ? toggleShare : null} sharing={sharingId===d.id}/>
              </div>
            </div>
          </div>
        ))}
        {shown.length===0 && <Empty icon="documents" title={filtering?"Ningún documento coincide":"Sin documentos"}/>}
      </div>
    ) : (
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Documento</th><th>Empresa</th><th>Carpeta</th><th>Tamaño</th><th>Origen</th><th>Fecha</th><th></th></tr></thead><tbody>
      {shown.map(d=><tr key={d.id}>
        <td><div className="row" style={{gap:10}}><div className="lrow__ico"><Icon name="documents" size={17}/></div><span className="tbl__name">{docName(d)}</span><DocStatusBadge doc={d}/><DocShareBadge doc={d}/></div></td>
        <td className="tbl__sub">{empresaCell(d)}</td>
        <td className="tbl__sub">{d.folder_path || "—"}</td>
        <td className="tbl__sub">{CRM.fmtBytes(d.size_bytes)}</td>
        <td>{origin(d)}</td>
        <td className="tbl__sub">{d.created}</td>
        <td onClick={e=>e.stopPropagation()}><DocActions doc={d} onDownload={download} downloading={busyId===d.id} onPreview={setPreviewDoc} onRename={setRenameDoc} onDelete={setDelDoc}
          onToggleShare={d.empresa_id ? toggleShare : null} sharing={sharingId===d.id}/></td>
      </tr>)}
    </tbody></table>{shown.length===0 && <Empty icon="documents" title={filtering?"Ningún documento coincide":"Sin documentos"}/>}</div>
    )}
    {previewDoc && <DocPreviewModal doc={previewDoc} onClose={()=>setPreviewDoc(null)} onDownload={download} downloading={busyId===previewDoc.id}/>}
    {renameDoc && <RenameDocModal doc={renameDoc} toast={toast} onClose={()=>setRenameDoc(null)} onRenamed={(upd)=>{ setRenameDoc(null); setDocs(ds=>(ds||[]).map(x=>x.id===upd.id?{...upd, folder_path:x.folder_path, folder_root_name:x.folder_root_name}:x)); }}/>}
    {delDoc && <DeleteDocModal doc={delDoc} toast={toast} onClose={()=>setDelDoc(null)} onDeleted={(doc)=>{ setDelDoc(null); setDocs(ds=>(ds||[]).filter(x=>x.id!==doc.id)); }}/>}
  </div>;
}

/* ============ AUTOMATIONS ============ */
function Automations({toast}){
  const [rules,setRules]=uState(CRM.AUTOMATIONS.map(a=>({...a}))); const [showNew,setNew]=uState(false);
  const [editing,setEditing]=uState(null);
  const toggle=(id)=>{ setRules(rs=>rs.map(r=>r.id===id?{...r,enabled:!r.enabled}:r)); };
  const saveEdit=(patch)=>{ setRules(rs=>rs.map(r=>r.id===patch.id?{...patch}:r)); setEditing(null); toast("Automatización actualizada"); };
  const duplicateRule=(r)=>{
    const copy={...r, id:"a"+Date.now().toString(36), name:r.name+" (copia)", runs:0, enabled:false};
    setRules(rs=>[...rs, copy]);
    toast("Automatización duplicada");
  };
  const deleteRule=(r)=>{
    if(!window.confirm("¿Eliminar la automatización \""+r.name+"\"? Esta acción no se puede deshacer.")) return;
    setRules(rs=>rs.filter(x=>x.id!==r.id));
    toast("Automatización eliminada");
  };
  return <div className="content">
    <div className="toolbar"><div><div className="muted" style={{fontSize:13}}>Reglas que se ejecutan solas cuando ocurre un evento en el CRM.</div></div><div className="toolbar__spacer"></div><button className="btn btn--primary" onClick={()=>setNew(true)}><Icon name="plus" size={16}/>Nueva automatización</button></div>
    <div className="wrap-gap">
      {rules.map(r=>(
        <div key={r.id} className="card"><div className="card__body"><div className="row" style={{gap:14,alignItems:"flex-start"}}>
          <div className="lrow__ico" style={{background:r.enabled?"var(--accent-soft)":"var(--mist-2)",color:r.enabled?"var(--accent)":"var(--muted)"}}><Icon name="automations" size={18}/></div>
          <div style={{flex:1}}>
            <div className="row" style={{gap:8}}><span style={{fontWeight:700,fontFamily:"var(--display)",fontSize:15}}>{r.name}</span>{r.enabled?<Badge label="Activa" color="#1F9D6B"/>:<Badge label="Pausada" color="#6E8298"/>}</div>
            <div style={{display:"flex",gap:8,alignItems:"center",marginTop:8,flexWrap:"wrap"}}>
              <span className="badge" style={{background:"var(--warn-soft)",color:"var(--warn)"}}><Icon name="clock" size={13}/>Cuando: {r.trigger}</span>
              <Icon name="arrowR" size={14} style={{color:"var(--muted)"}}/>
              <span className="badge" style={{background:"var(--accent-soft)",color:"var(--accent-ink)"}}><Icon name="check" size={13}/>Hacer: {r.action}</span>
            </div>
            <div className="muted" style={{fontSize:12,marginTop:8}}>Ejecutada {r.runs} veces</div>
          </div>
          <button className="btn btn--sm btn--ghost" title="Ver / editar" onClick={()=>setEditing(r)}><Icon name="edit" size={15}/></button>
          <button className="btn btn--sm btn--ghost" title="Duplicar" onClick={()=>duplicateRule(r)}><Icon name="copy" size={15}/></button>
          <button className="btn btn--sm btn--ghost" title="Eliminar" onClick={()=>deleteRule(r)}><Icon name="trash" size={15}/></button>
          <button className="switch" onClick={()=>toggle(r.id)} style={{width:44,height:26,borderRadius:20,background:r.enabled?"var(--accent)":"var(--line-strong)",position:"relative",transition:"background .15s",flex:"none"}}><span style={{position:"absolute",top:3,left:r.enabled?21:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .15s",boxShadow:"var(--shadow-sm)"}}></span></button>
        </div></div></div>
      ))}
    </div>
    {showNew && <Modal title="Nueva automatización" onClose={()=>setNew(false)} footer={<><button className="btn btn--ghost" onClick={()=>setNew(false)}>Cancelar</button><button className="btn btn--primary" onClick={()=>{setNew(false);toast("Automatización creada");}}>Crear regla</button></>}>
      <Field label="Nombre"><input className="inp" placeholder="Ej. Lead nuevo → asignar y avisar"/></Field>
      <Field label="Cuando ocurra (trigger)"><select className="inp"><option>Contacto creado (formulario web)</option><option>Deal cambia de etapa</option><option>Renovación en X días</option><option>Sin actividad X días</option><option>Deal marcado como perdido</option></select></Field>
      <Field label="Entonces (acción)"><select className="inp"><option>Crear tarea</option><option>Enviar email/plantilla</option><option>Cambiar owner</option><option>Cambiar ciclo de vida</option><option>Notificar al equipo</option></select></Field>
    </Modal>}
    {editing && <EditAutomation rule={editing} onClose={()=>setEditing(null)} onSave={saveEdit}/>}
  </div>;
}
function EditAutomation({rule, onClose, onSave}){
  const [f,setF]=uState({...rule});
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  return <Modal title="Ver / editar automatización" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={()=>onSave(f)}>Guardar cambios</button></>}>
    <Field label="Nombre"><input className="inp" value={f.name} onChange={set("name")}/></Field>
    <Field label="Cuando ocurra (trigger)"><input className="inp" value={f.trigger} onChange={set("trigger")}/></Field>
    <Field label="Entonces (acción)"><input className="inp" value={f.action} onChange={set("action")}/></Field>
    <Field label="Estado"><label className="row" style={{gap:8}}><input type="checkbox" checked={f.enabled} onChange={e=>setF({...f,enabled:e.target.checked})}/> Regla activa</label></Field>
    <p className="muted" style={{fontSize:12}}>Ejecutada {rule.runs} veces hasta ahora.</p>
  </Modal>;
}

/* ============ NOTIFICACIONES PUSH (Config) ============ */
// applicationServerKey debe ser un Uint8Array, no el string base64url que
// da web-push generate-vapid-keys — conversión estándar del ecosistema.
function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) out[i] = raw.charCodeAt(i);
  return out;
}
function describeDevice(){
  const ua = navigator.userAgent;
  if(/iPhone/.test(ua)) return "iPhone";
  if(/iPad/.test(ua)) return "iPad";
  if(/Android/.test(ua)) return "Android";
  if(/Macintosh/.test(ua)) return "Mac";
  if(/Windows/.test(ua)) return "Windows";
  return "Este dispositivo";
}
function NotificationsSettings({toast}){
  const supported = typeof Notification!=="undefined" && "serviceWorker" in navigator && "PushManager" in window;
  const iosNotInstalled = isIosSafari() && !isStandaloneNow();
  const [permission,setPermission]=uState(()=>supported?Notification.permission:"unsupported");
  const [subscribed,setSubscribed]=uState(false);
  const [checked,setChecked]=uState(false);
  const [busy,setBusy]=uState(false);

  uEffect(()=>{
    if(!supported){ setChecked(true); return; }
    (async()=>{
      try{
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(!!sub);
      }catch(e){}
      setChecked(true);
    })();
  },[]);

  const activate=async()=>{
    if(!supported || iosNotInstalled || busy) return;
    setBusy(true);
    try{
      let perm = Notification.permission;
      if(perm==="default") perm = await Notification.requestPermission(); // gesto del usuario: dentro del onClick, nunca al cargar
      setPermission(perm);
      if(perm!=="granted") return;

      const vapidKey = window.PUSH_CONFIG && window.PUSH_CONFIG.vapidPublicKey;
      if(!vapidKey || vapidKey.indexOf("REPLACE")===0){
        toast("Falta configurar la clave pública VAPID en crm/config.js.");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if(!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });

      const { data } = await Auth.client.auth.getSession();
      const userId = data.session && data.session.user.id;
      if(!userId) throw new Error("No se pudo identificar la sesión.");

      await CRM.savePushSubscription(Auth.client, userId, sub.toJSON(), describeDevice());
      setSubscribed(true);
      toast("Notificaciones activadas en este dispositivo");
    }catch(e){
      toast("No se pudieron activar las notificaciones: "+(e && e.message ? e.message : String(e)));
    }finally{
      setBusy(false);
    }
  };

  const deactivate=async()=>{
    setBusy(true);
    try{
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if(sub){
        await CRM.removePushSubscription(Auth.client, sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast("Notificaciones desactivadas en este dispositivo");
    }catch(e){
      toast("No se pudieron desactivar: "+(e && e.message ? e.message : String(e)));
    }finally{
      setBusy(false);
    }
  };

  return <div className="card"><div className="card__body">
    <div style={{fontWeight:700,fontFamily:"var(--display)",marginBottom:6}}>Notificaciones en este dispositivo</div>
    <p className="muted" style={{fontSize:13,marginBottom:14,maxWidth:480}}>Avisos de leads nuevos y mensajes de WhatsApp entrantes, directamente en este móvil u ordenador.</p>
    {!checked ? <p className="muted" style={{fontSize:13}}>Comprobando…</p>
    : !supported ? <p className="muted" style={{fontSize:13}}>Este navegador no soporta notificaciones push.</p>
    : iosNotInstalled ? <p className="muted" style={{fontSize:13}}>En iPhone/iPad, Safari no permite notificaciones push sin instalar la app: toca <b>Compartir</b> y luego <b>Añadir a pantalla de inicio</b>, y ábrela desde ahí antes de activarlas.</p>
    : permission==="denied" ? <p className="muted" style={{fontSize:13}}>Bloqueaste las notificaciones para este sitio — no se puede volver a pedir el permiso desde aquí. Actívalas desde los ajustes del navegador (icono del candado o "Ajustes del sitio" junto a la barra de direcciones).</p>
    : subscribed ? <div className="row" style={{gap:10}}><Badge label="Activadas" color="#1F9D6B"/><button className="btn btn--sm btn--ghost" onClick={deactivate} disabled={busy}>{busy?"Desactivando…":"Desactivar"}</button></div>
    : <button className="btn btn--sm btn--primary" onClick={activate} disabled={busy}><Icon name="bell" size={15}/>{busy?"Activando…":"Activar notificaciones"}</button>}
  </div></div>;
}

/* ============ MI CUENTA ============ */
function MyAccount({toast}){
  const [pw,setPw]=uState(""); const [pw2,setPw2]=uState("");
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const submit=async(e)=>{
    e.preventDefault();
    if(pw.length<8){ setErr("La contraseña debe tener al menos 8 caracteres."); return; }
    if(pw!==pw2){ setErr("Las contraseñas no coinciden."); return; }
    setBusy(true); setErr(null);
    const {error} = await Auth.updatePassword(pw);
    setBusy(false);
    if(error){ setErr(error.message); return; }
    setPw(""); setPw2("");
    toast("Contraseña actualizada");
  };
  return <div className="card" style={{maxWidth:420}}><div className="card__body">
    <h3 style={{fontSize:15,marginBottom:4}}>Cambiar contraseña</h3>
    <p className="muted" style={{fontSize:13,marginBottom:16}}>Se aplica a la cuenta con la que has iniciado sesión ahora mismo.</p>
    {err && <div className="login__err">{err}</div>}
    <form onSubmit={submit}>
      <Field label="Nueva contraseña"><input className="inp" type="password" autoComplete="new-password" value={pw} onChange={e=>setPw(e.target.value)} required/></Field>
      <Field label="Repite la contraseña"><input className="inp" type="password" autoComplete="new-password" value={pw2} onChange={e=>setPw2(e.target.value)} required/></Field>
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy?"Guardando…":"Guardar contraseña"}</button>
    </form>
  </div></div>;
}

/* ============ CONFIG ============ */
function Config({toast, initialTab}){
  const [tab,setTab]=uState(initialTab||"servicios");
  const [services,setServices]=uState(CRM.SERVICES.map(s=>({...s}))); const [showNewSvc,setNewSvc]=uState(false);
  const [users,setUsers]=uState(CRM.USERS.map(u=>({...u}))); const [showNewUser,setNewUser]=uState(false); const [delUser,setDelUser]=uState(null);
  const activeCount = users.filter(u=>u.activo).length;
  const addService=(svc)=>{ setServices(ss=>[...ss,{...svc,id:"s"+(ss.length+1)}]); setNewSvc(false); toast("Servicio creado"); };
  const changeRole=async(id,rol)=>{
    try{ const u=await CRM.updateAdmin(Auth.client,id,{rol}); setUsers(us=>us.map(x=>x.id===id?u:x)); toast("Rol actualizado"); }
    catch(e){ toast("No se pudo actualizar el rol: "+e.message); }
  };
  const toggleActivo=async(u)=>{
    if(u.activo && activeCount<=1){ toast("No puedes desactivar al último administrador activo."); return; }
    try{ const updated=await CRM.setAdminActivo(Auth.client,u.id,!u.activo); setUsers(us=>us.map(x=>x.id===u.id?updated:x)); toast(updated.activo?"Administrador reactivado":"Administrador desactivado — ya no puede iniciar sesión"); }
    catch(e){ toast("No se pudo cambiar el estado: "+e.message); }
  };
  const addUser=(admin)=>{ CRM.cacheAdmin(admin); setUsers(us=>[...us,admin]); setNewUser(false); toast("Administrador creado — ya puede iniciar sesión con la contraseña temporal"); };
  const confirmRemoveUser=async()=>{
    if(activeCount<=1 && delUser.activo){ toast("No puedes eliminar al último administrador activo."); setDelUser(null); return; }
    const {error} = await Auth.deleteAdminUser(delUser.email);
    if(error){ toast("No se pudo eliminar: "+error.message); setDelUser(null); return; }
    CRM.removeAdminLocal(delUser.id); setUsers(us=>us.filter(u=>u.id!==delUser.id)); setDelUser(null);
    toast("Administrador eliminado y acceso revocado en Supabase");
  };
  return <div className="content">
    <Tabs tabs={[{id:"servicios",label:"Servicios"},{id:"usuarios",label:"Usuarios y roles"},{id:"notificaciones",label:"Notificaciones"},{id:"cuenta",label:"Mi cuenta"}]} active={tab} onChange={setTab}/>
    {tab==="servicios" && <>
      <div className="toolbar"><div className="muted" style={{fontSize:13}}>Catálogo de servicios que ofrece el despacho. Puedes crear nuevos.</div><div className="toolbar__spacer"></div><button className="btn btn--primary" onClick={()=>setNewSvc(true)}><Icon name="plus" size={16}/>Nuevo servicio</button></div>
      <div className="svc-grid">{services.map(s=><div key={s.id} className="card"><div className="card__body"><div className="row" style={{gap:10}}><div className="lrow__ico" style={{background:s.color+"1A",color:s.color}}><Icon name="briefcase" size={18}/></div><div style={{flex:1}}><div style={{fontWeight:700,fontFamily:"var(--display)"}}>{s.name}</div><div className="muted" style={{fontSize:12}}>{s.recurring?"Recurrente":"Puntual"} · {s.frequency}</div></div></div></div></div>)}</div>
    </>}
    {tab==="usuarios" && <>
      <div className="toolbar"><div className="muted" style={{fontSize:13}}>Administradores con acceso al CRM. Solo estos emails pueden iniciar sesión.</div><div className="toolbar__spacer"></div><button className="btn btn--primary" onClick={()=>setNewUser(true)}><Icon name="plus" size={16}/>Nuevo administrador</button></div>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Usuario</th><th>Email</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>
        {users.map(u=><tr key={u.id}>
          <td className="row" style={{gap:10}}><Avatar name={u.name} size="md" color={u.color}/><span className="tbl__name">{u.name}</span></td>
          <td className="tbl__sub">{u.email}</td>
          <td onClick={e=>e.stopPropagation()}><select className="inp" style={{padding:"6px 10px",fontSize:13,width:"auto"}} value={u.role||"miembro"} onChange={e=>changeRole(u.id,e.target.value)}>{CRM.ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></td>
          <td>{u.activo? <Badge label="Activo" color="#1F9D6B"/> : <Badge label="Inactivo" color="#6E8298"/>}</td>
          <td onClick={e=>e.stopPropagation()} className="row" style={{gap:4,justifyContent:"flex-end"}}>
            <button className="btn btn--sm btn--ghost" title={u.activo?"Desactivar":"Reactivar"} onClick={()=>toggleActivo(u)} disabled={u.activo && activeCount<=1}><Icon name={u.activo?"archive":"refresh"} size={14}/></button>
            <button className="btn btn--sm btn--ghost" title="Eliminar" onClick={()=>setDelUser(u)} disabled={u.activo && activeCount<=1}><Icon name="trash" size={14}/></button>
          </td>
        </tr>)}
      </tbody></table></div>
      <p className="muted" style={{fontSize:12,marginTop:10}}>Al crear un administrador aquí se genera directamente su acceso real (email + contraseña temporal) en Supabase. Desactivar le quita el acceso sin borrar su cuenta; eliminar revoca su cuenta de Supabase por completo.</p>
    </>}
    {tab==="notificaciones" && <NotificationsSettings toast={toast}/>}
    {tab==="cuenta" && <MyAccount toast={toast}/>}
    {showNewSvc && <NewService onClose={()=>setNewSvc(false)} onSave={addService}/>}
    {showNewUser && <NewUser onClose={()=>setNewUser(false)} onSave={addUser}/>}
    {delUser && <Modal title="Eliminar administrador" onClose={()=>setDelUser(null)} footer={<><button className="btn btn--ghost" onClick={()=>setDelUser(null)}>Cancelar</button><button className="btn btn--danger" onClick={confirmRemoveUser}>Eliminar</button></>}>
      <p className="muted">Se eliminará a <b>{delUser.name}</b> ({delUser.email}) del CRM y se revocará su acceso en Supabase. No podrá volver a iniciar sesión.</p>
    </Modal>}
  </div>;
}
function NewUser({onClose,onSave}){
  const genPassword=()=>{ const chars="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; let p=""; for(let i=0;i<10;i++) p+=chars[Math.floor(Math.random()*chars.length)]; return p; };
  const [f,setF]=uState({name:"",email:"",role:"miembro",password:genPassword()});
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const submit=async()=>{
    if(!f.name||!f.email||!f.password){ setErr("Completa nombre, email y contraseña."); return; }
    setBusy(true); setErr(null);
    const {data,error} = await Auth.createAdminUser(f.email, f.password, f.name, f.role);
    setBusy(false);
    if(error){ setErr(error.message); return; }
    onSave(CRM.rowToAdmin(data.admin));
  };
  return <Modal title="Nuevo administrador" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={submit} disabled={busy}>{busy?"Creando…":"Crear acceso"}</button></>}>
    {err && <div className="login__err">{err}</div>}
    <Field label="Nombre completo"><input className="inp" placeholder="Nombre y apellidos" value={f.name} onChange={set("name")}/></Field>
    <Field label="Correo electrónico"><input className="inp" type="email" placeholder="nombre@guimaes.es" value={f.email} onChange={set("email")}/></Field>
    <Field label="Rol"><select className="inp" value={f.role} onChange={set("role")}>{CRM.ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
    <Field label="Contraseña temporal"><div className="row" style={{gap:8}}><input className="inp" value={f.password} onChange={set("password")}/><button type="button" className="btn btn--sm btn--ghost" onClick={()=>setF({...f,password:genPassword()})}>Generar</button></div></Field>
    <p className="muted" style={{fontSize:12}}>Se crea directamente su acceso en Supabase. Compártele el email y esta contraseña — podrá cambiarla luego con ¿Olvidaste tu contraseña?.</p>
  </Modal>;
}
function NewService({onClose,onSave}){
  const [f,setF]=uState({name:"",color:"#1F6FEB",recurring:true,frequency:"mensual",defaultFee:1000});
  const colors=["#1F6FEB","#16B8A6","#C8A24B","#7C5CFC","#E0518A","#D9822B","#2E8B57"];
  return <Modal title="Nuevo servicio" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={()=>f.name&&onSave(f)}>Crear servicio</button></>}>
    <Field label="Nombre del servicio"><input className="inp" placeholder="Ej. Due diligence" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></Field>
    <div className="fld-row"><Field label="Tipo"><select className="inp" value={f.recurring?"r":"p"} onChange={e=>setF({...f,recurring:e.target.value==="r"})}><option value="r">Recurrente</option><option value="p">Puntual</option></select></Field><Field label="Frecuencia"><select className="inp" value={f.frequency} onChange={e=>setF({...f,frequency:e.target.value})}><option>mensual</option><option>trimestral</option><option>anual</option><option>puntual</option></select></Field></div>
    <Field label="Color"><div className="row" style={{gap:8}}>{colors.map(c=><div key={c} onClick={()=>setF({...f,color:c})} style={{width:28,height:28,borderRadius:8,background:c,cursor:"pointer",boxShadow:f.color===c?"0 0 0 3px "+c+"55":"none"}}></div>)}</div></Field>
  </Modal>;
}

/* ============ WEB LEAD (demo integración) — botón flotante ============ */
function WebLeadDemo({onLead}){
  const [open,setOpen]=uState(false);
  return <>
    <button onClick={()=>setOpen(true)} title="Simular lead de la web" style={{position:"fixed",right:20,bottom:20,zIndex:90,width:52,height:52,borderRadius:"50%",background:"var(--ink)",color:"#fff",display:"grid",placeItems:"center",boxShadow:"var(--shadow-lg)"}}><Icon name="globe" size={22}/></button>
    {open && <Modal title="Formulario de la web guimaes.es" onClose={()=>setOpen(false)} footer={<><button className="btn btn--ghost" onClick={()=>setOpen(false)}>Cancelar</button><button className="btn btn--primary" onClick={()=>{setOpen(false);onLead();}}><Icon name="arrowR" size={15}/>Enviar (crea lead en CRM)</button></>}>
      <p className="muted" style={{marginBottom:14}}>Demo de la integración <b>web → CRM</b>: al enviar el formulario de contacto, se crea automáticamente un contacto + deal en "Nueva solicitud" con las UTM de la visita.</p>
      <div className="fld-row"><Field label="Empresa"><input className="inp" defaultValue="Óptica Visión Clara"/></Field><Field label="Nombre"><input className="inp" defaultValue="Laura Gil"/></Field></div>
      <div className="fld-row"><Field label="Email"><input className="inp" defaultValue="laura@visionclara.es"/></Field><Field label="¿En qué podemos ayudarte?"><select className="inp">{CRM.SERVICES.map(s=><option key={s.id}>{s.name}</option>)}</select></Field></div>
    </Modal>}
  </>;
}

/* ============ INSTALL PROMPT (PWA) ============ */
const INSTALL_DISMISS_KEY = "guimaes_crm_install_dismissed";
function isStandaloneNow(){
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone===true;
}
function isIosSafari(){
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isIos && isSafari;
}
// Aviso discreto de instalación — nunca a pantalla completa. En iOS Safari
// (sin beforeinstallprompt) solo puede explicar el gesto manual; en
// Android/Chrome ofrece el botón real vía beforeinstallprompt. No es un
// estado nuevo del shell: se renderiza como un hijo más dentro de <Shell>
// (ver App más abajo), así que empuja el contenido hacia abajo en vez de
// superponerse — evita cualquier choque con el <Toast/>, que sí es fixed.
function InstallPrompt(){
  const [standalone,setStandalone]=uState(isStandaloneNow);
  const [dismissed,setDismissed]=uState(()=>{
    try{ return localStorage.getItem(INSTALL_DISMISS_KEY)==="1"; }catch(e){ return false; }
  });
  const [deferredPrompt,setDeferredPrompt]=uState(null);

  uEffect(()=>{
    const onBeforeInstall=(e)=>{ e.preventDefault(); setDeferredPrompt(e); };
    const onInstalled=()=>{ setStandalone(true); setDeferredPrompt(null); };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return ()=>{
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  },[]);

  const dismiss=()=>{
    setDismissed(true);
    try{ localStorage.setItem(INSTALL_DISMISS_KEY,"1"); }catch(e){}
  };
  const install=async()=>{
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    try{ await deferredPrompt.userChoice; }catch(e){}
    setDeferredPrompt(null);
  };

  if(standalone || dismissed) return null;

  if(deferredPrompt){
    return (
      <div className="install-banner">
        <Icon name="download" size={16}/>
        <span>Instala el CRM en este dispositivo para acceso rápido y notificaciones.</span>
        <button className="btn btn--sm btn--primary" onClick={install}>Instalar</button>
        <button className="install-banner__x" onClick={dismiss} aria-label="Cerrar aviso"><Icon name="x" size={14}/></button>
      </div>
    );
  }

  if(isIosSafari()){
    return (
      <div className="install-banner">
        <Icon name="download" size={16}/>
        <span>Instala el CRM: toca <b>Compartir</b> y luego <b>Añadir a pantalla de inicio</b>.</span>
        <button className="install-banner__x" onClick={dismiss} aria-label="Cerrar aviso"><Icon name="x" size={14}/></button>
      </div>
    );
  }

  return null;
}

/* ============ ROUTING (History API, sin librerías) ============ */
// El estado de navegación vive en la query string del mismo crm.html
// (?view=whatsapp&id=123), nunca en el path ni en el hash:
// - El sitio se sirve estático sin reescrituras en Vercel — un path nuevo
//   tipo /crm/whatsapp/123 daría 404 al recargar, porque ese archivo no
//   existe. La query string no tiene ese problema: Vercel sigue sirviendo
//   crm.html tal cual, la query la lee solo el JS del cliente.
// - El hash (#/whatsapp/123) choca con Supabase Auth, que YA usa el hash de
//   la URL para el login con Google y para los enlaces de recuperación de
//   contraseña (#access_token=...). Dos usos del hash a la vez es fuente
//   garantizada de bugs.
const ROUTABLE_VIEWS = ["home","contacts","contact","cuentas","pipeline","deal","tareas","whatsapp","inbox","documents","automations","config"];
function viewToSearch(name, id){
  const params = new URLSearchParams();
  params.set("view", name);
  if(id) params.set("id", id);
  return "?"+params.toString();
}
// Lee la vista {name, id} a partir de un search string ("?view=...&id=...").
// Se reutiliza tanto al arrancar (window.location.search) como al recibir el
// postMessage del service worker (con la URL del push, ver App más abajo).
function parseViewFromSearch(search){
  const params = new URLSearchParams(search);
  const name = params.get("view");
  const id = params.get("id");
  if(name && ROUTABLE_VIEWS.includes(name)) return {name, id:id||null};
  return {name:"home", id:null};
}

/* ============ ROOT ============ */
function App(){
  // Estado inicial leído de la URL una sola vez, al montar — cubre tanto una
  // recarga como un deep-link abierto directamente (p. ej. desde una
  // notificación push cuando no había ninguna pestaña abierta ya).
  const initialView = uMemo(()=>parseViewFromSearch(window.location.search), []);
  const [user,setUser]=uState(null);
  const [view,setView]=uState(initialView); const [toast,fireToast]=useToast();
  const [booting,setBooting]=uState(true); const [recovery,setRecovery]=uState(false);

  uEffect(()=>{
    let mounted=true;
    (async()=>{
      if(Auth.configured){
        const session = await Auth.getSession();
        if(session && await Auth.isAllowed(session.user)){
          if(CRM.loadAdmins) await CRM.loadAdmins(Auth.client);
          if(CRM.loadEmpresas) await CRM.loadEmpresas(Auth.client);
          if(CRM.loadContactos) await CRM.loadContactos(Auth.client);
          if(CRM.loadContactoEmpresa) await CRM.loadContactoEmpresa(Auth.client);
          if(CRM.loadCuentasPendientes) await CRM.loadCuentasPendientes(Auth.client);
          if(CRM.loadDeals) await CRM.loadDeals(Auth.client);
          if(CRM.loadTasks) await CRM.loadTasks(Auth.client);
          if(CRM.loadNotes) await CRM.loadNotes(Auth.client);
          if(CRM.loadWebLeads){ const r = await CRM.loadWebLeads(Auth.client); reportLeadIssues(fireToast, r); }
          if(CRM.loadWhatsapp) await CRM.loadWhatsapp(Auth.client);
          if(CRM.loadWaTemplates) await CRM.loadWaTemplates(Auth.client);
          if(mounted) setUser(userFromSession(session));
        }
        Auth.onAuthStateChange((event, session)=>{
          if(event==="PASSWORD_RECOVERY"){ setRecovery(true); return; }
          if(event==="SIGNED_IN" && session){
            (async()=>{
              if(!(await Auth.isAllowed(session.user))){ await Auth.signOut(); fireToast("Esta cuenta no tiene acceso al CRM."); return; }
              if(CRM.loadAdmins) await CRM.loadAdmins(Auth.client);
              if(CRM.loadEmpresas) await CRM.loadEmpresas(Auth.client);
              if(CRM.loadContactos) await CRM.loadContactos(Auth.client); if(CRM.loadContactoEmpresa) await CRM.loadContactoEmpresa(Auth.client); if(CRM.loadCuentasPendientes) await CRM.loadCuentasPendientes(Auth.client); if(CRM.loadDeals) await CRM.loadDeals(Auth.client); if(CRM.loadTasks) await CRM.loadTasks(Auth.client); if(CRM.loadNotes) await CRM.loadNotes(Auth.client);
              if(CRM.loadWebLeads){ const r = await CRM.loadWebLeads(Auth.client); reportLeadIssues(fireToast, r); }
              if(CRM.loadWhatsapp) await CRM.loadWhatsapp(Auth.client); if(CRM.loadWaTemplates) await CRM.loadWaTemplates(Auth.client); setUser(userFromSession(session));
            })();
          }
          if(event==="SIGNED_OUT"){ setUser(null); }
        });
      }
      if(mounted) setBooting(false);
    })();
    return ()=>{mounted=false;};
  },[]);

  // pushUrl no toca el estado de React, solo la URL visible/el historial —
  // nav() (abajo) es quien decide ADEMÁS qué se pinta. Evita empujar una
  // entrada idéntica a la actual (p. ej. al re-pulsar la sección ya activa).
  const pushUrl=(name,id)=>{
    const search = viewToSearch(name,id);
    if(window.location.search!==search) window.history.pushState({name,id}, "", search);
  };
  const nav=(name,id=null)=>{
    setView({name,id});
    pushUrl(name,id);
  };
  const logout=async()=>{ await Auth.signOut(); setUser(null); nav("home"); };

  // Atrás/adelante del navegador: la URL ya la actualiza el propio navegador
  // antes de disparar popstate, así que basta con releer window.location.
  uEffect(()=>{
    const onPopState=()=>{
      setView(parseViewFromSearch(window.location.search));
    };
    window.addEventListener("popstate", onPopState);
    return ()=>window.removeEventListener("popstate", onPopState);
  },[]);

  // El service worker manda esto al pulsar una notificación con una pestaña
  // del CRM ya abierta (ver notificationclick en sw.js) — reutiliza el mismo
  // nav() de siempre, así que también actualiza la URL/el historial.
  uEffect(()=>{
    if(!("serviceWorker" in navigator)) return;
    const onMessage=(event)=>{
      if(!event.data || event.data.type!=="push-navigate" || !event.data.url) return;
      const targetUrl = new URL(event.data.url, window.location.origin);
      const r = parseViewFromSearch(targetUrl.search);
      nav(r.name, r.id);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return ()=>navigator.serviceWorker.removeEventListener("message", onMessage);
  },[]);

  if(booting) return <div className="login" style={{minHeight:"100vh"}}></div>;
  if(recovery) return <><PasswordRecovery onDone={()=>{setRecovery(false); fireToast("Contraseña actualizada");}}/><Toast msg={toast}/></>;
  if(!user) return <><Login onLogin={u=>setUser(u)}/><Toast msg={toast}/></>;
  const titles={home:["Inicio","Resumen del despacho"],empresas:["Empresas","Sociedades de tus contactos"],empresa:["Ficha de empresa",""],contacts:["Contactos","Base de datos de clientes y leads"],contact:["Ficha de contacto",""],cuentas:["Área cliente","Solicitudes de acceso"],pipeline:["Pipeline","Oportunidades por etapa"],deal:["Ficha de oportunidad",""],tareas:["Tareas","Seguimiento del equipo"],whatsapp:["WhatsApp","Conversaciones"],inbox:["Bandeja de entrada",CRM.MAILBOX],documents:["Documentos",""],automations:["Automatizaciones","Reglas del CRM"],config:["Configuración",""]};
  const [title,crumb]=titles[view.name]||["",""];
  let screen;
  if(view.name==="home") screen=<Home user={user} nav={nav}/>;
  else if(view.name==="empresas") screen=<Empresas nav={nav} toast={fireToast}/>;
  else if(view.name==="empresa") screen=<EmpresaDetail id={view.id} nav={nav} toast={fireToast} user={user}/>;
  else if(view.name==="contacts") screen=<Contacts nav={nav} toast={fireToast}/>;
  else if(view.name==="contact") screen=<ContactDetail id={view.id} nav={nav} toast={fireToast} user={user}/>;
  else if(view.name==="cuentas") screen=<CuentasPortal nav={nav} toast={fireToast}/>;
  else if(view.name==="pipeline") screen=<Pipeline nav={nav} toast={fireToast}/>;
  else if(view.name==="tareas") screen=<Tasks nav={nav} toast={fireToast} user={user} focusId={view.id}/>;
  else if(view.name==="deal") screen=<DealDetail id={view.id} nav={nav} toast={fireToast} user={user}/>;
  else if(view.name==="whatsapp") screen=<WhatsApp nav={nav} toast={fireToast} focusId={view.id}/>;
  else if(view.name==="inbox") screen=<Inbox nav={nav} toast={fireToast}/>;
  else if(view.name==="documents") screen=<Documents nav={nav} toast={fireToast}/>;
  else if(view.name==="automations") screen=<Automations toast={fireToast}/>;
  else if(view.name==="config") screen=<Config key={view.id||"config"} toast={fireToast} initialTab={view.id}/>;
  const flush = view.name==="pipeline"||view.name==="whatsapp";
  const activeNav = {contact:"contacts", deal:"pipeline", empresa:"empresas"}[view.name] || view.name;
  return <>
    <Shell user={user} view={activeNav} nav={nav} onLogout={logout} title={title} crumb={crumb}>
      <InstallPrompt/>
      {flush ? screen : screen}
    </Shell>
    <Toast msg={toast}/>
  </>;
}
export function mountApp(){
  ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
}
