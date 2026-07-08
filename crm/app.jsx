/* GUIMAES CRM — App: login, shell, router y todas las pantallas */
const { useState:uState, useMemo:uMemo, useRef:uRef, useEffect:uEffect } = React;

/* ============ Helpers ============ */
function Toast({msg}){ return msg ? <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:"#0B2238",color:"#fff",padding:"12px 20px",borderRadius:12,boxShadow:"var(--shadow-lg)",zIndex:200,fontWeight:600,fontFamily:"var(--display)"}}>{msg}</div> : null; }
const useToast = () => { const [m,setM]=uState(null); const fire=(t)=>{setM(t);setTimeout(()=>setM(null),2200);}; return [m,fire]; };
function ownerAvatar(id){ const u=CRM.userById(id); return u? <Avatar name={u.name} size="sm" color={u.color}/> : null; }

/* ============ LOGIN ============ */
function userFromSession(session){
  const u = CRM.USERS.find(x=>x.email.toLowerCase()===session.user.email.toLowerCase());
  return u || {id:"u0", name:session.user.email, email:session.user.email, title:"Administrador", color:"#1F6FEB"};
}
function GoogleG({size=18}){
  return <svg width={size} height={size} viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9C16.66 14.2 17.64 11.9 17.64 9.2Z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18Z"/>
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.35 2.83.94 4.03l3.01-2.33Z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.97l3.01 2.33C4.66 5.17 6.65 3.58 9 3.58Z"/>
  </svg>;
}
function Login({onLogin, onPortal}){
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
          <button className="btn btn--ghost" style={{width:"100%",marginTop:16}} onClick={onPortal}><Icon name="external" size={16}/>Ver portal del cliente</button>
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
  {id:"contacts", label:"Contactos", icon:"contacts", badge:()=>CRM.CONTACTS.length},
  {id:"pipeline", label:"Pipeline", icon:"pipeline"},
  {id:"whatsapp", label:"WhatsApp", icon:"whatsapp", badge:()=>CRM.WHATSAPP.reduce((a,w)=>a+w.unread,0)},
  {id:"inbox", label:"Bandeja de entrada", icon:"mail", badge:()=>CRM.EMAILS.filter(e=>!e.archived&&CRM.unreadOf(e)).length},
  {id:"documents", label:"Documentos", icon:"documents"},
  {id:"automations", label:"Automatizaciones", icon:"automations"},
  {id:"config", label:"Configuración", icon:"settings"}
];
function Shell({user, view, nav, onLogout, children, title, crumb}){
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sb-brand"><span className="sb-brand__logo">GUIMAES</span><span className="sb-brand__dot"></span></div>
        <div className="sb-tag">CRM interno</div>
        <nav className="sb-nav">
          {NAV.map(n=>{
            const b = n.badge && n.badge();
            return <a key={n.id} className={"sb-item"+(view===n.id?" active":"")} onClick={()=>nav(n.id)}>
              <Icon name={n.icon} size={18}/>{n.label}{b?<span className="sb-item__badge">{b}</span>:null}
            </a>;
          })}
          <div className="sb-nav__label">Cliente</div>
          <a className="sb-item" onClick={()=>nav("portal")}><Icon name="external" size={18}/>Portal del cliente</a>
        </nav>
        <div className="sb-user">
          <Avatar name={user.name} size="md" color={user.color}/>
          <div className="sb-user__meta"><div className="sb-user__name">{user.name}</div><div className="sb-user__role">{user.title}</div></div>
          <button className="sb-user__out" onClick={onLogout} title="Cerrar sesión"><Icon name="logout" size={17}/></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div><div className="topbar__title">{title}</div>{crumb && <div className="topbar__crumb">{crumb}</div>}</div>
          <div className="topbar__search"><Icon name="search" size={16}/><input placeholder="Buscar contactos, deals…"/></div>
          <button className="topbar__icon"><Icon name="bell" size={18}/><span className="dot"></span></button>
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
          <div style={{display:"flex",gap:10,alignItems:"flex-end",height:120}}>
            {byStage.map(({s,n})=>(
              <div key={s.id} style={{flex:1,textAlign:"center"}}>
                <div style={{height:80,display:"flex",alignItems:"flex-end"}}><div style={{width:"100%",background:s.color,height:(n/maxN*80||3)+"px",borderRadius:"6px 6px 0 0"}}></div></div>
                <div style={{fontWeight:700,fontFamily:"var(--display)",marginTop:6}}>{n}</div>
                <div className="muted" style={{fontSize:11.5,lineHeight:1.2}}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ CONTACTS ============ */
function Contacts({nav, toast}){
  const [contacts,setContacts]=uState(()=>CRM.CONTACTS.map(c=>({...c})));
  const [q,setQ]=uState(""); const [lc,setLc]=uState("all"); const [sel,setSel]=uState([]); const [showNew,setNew]=uState(false);
  const [mode,setMode]=uState("list");
  const [drag,setDrag]=uState(null); const [over,setOver]=uState(null);
  const list = contacts.filter(c=>(lc==="all"||c.lifecycle===lc) && (q==="" || (c.company+c.full_name+c.email).toLowerCase().includes(q.toLowerCase())));
  const toggle=(id)=>setSel(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id]);
  const allSel = list.length && list.every(c=>sel.includes(c.id));
  const moveLifecycle=(id,lifecycle)=>{
    const c=contacts.find(x=>x.id===id); if(!c||c.lifecycle===lifecycle) return;
    setContacts(cs=>cs.map(x=>x.id===id?{...x,lifecycle}:x));
    toast(c.company+" → "+CRM.lifecycleById[lifecycle].label);
  };
  return (
    <div className={mode==="pipeline"?"content--flush":"content"} style={mode==="pipeline"?{flex:1,display:"flex",flexDirection:"column",minHeight:0}:undefined}>
      <div className="toolbar" style={mode==="pipeline"?{padding:"16px 26px 0",marginBottom:0}:undefined}>
        <div className="searchbox"><Icon name="search" size={16}/><input placeholder="Buscar por empresa, persona o email…" value={q} onChange={e=>setQ(e.target.value)}/></div>
        {mode==="list" && <>
          <button className={"chip"+(lc==="all"?" active":"")} onClick={()=>setLc("all")}>Todos <span className="chip__count">{contacts.length}</span></button>
          {CRM.LIFECYCLE.map(l=>{ const n=contacts.filter(c=>c.lifecycle===l.id).length; return <button key={l.id} className={"chip"+(lc===l.id?" active":"")} onClick={()=>setLc(l.id)}><span className="dot" style={{background:l.color}}></span>{l.label} <span className="chip__count">{n}</span></button>; })}
        </>}
        <div className="toolbar__spacer"></div>
        <div className="viewtoggle">
          <button className={mode==="list"?"active":""} onClick={()=>setMode("list")} title="Vista de lista"><Icon name="list" size={16}/></button>
          <button className={mode==="pipeline"?"active":""} onClick={()=>setMode("pipeline")} title="Vista de pipeline (ciclo de vida)"><Icon name="pipeline" size={16}/></button>
        </div>
        {mode==="list" && <button className="btn btn--ghost"><Icon name="upload" size={16}/>Importar</button>}
        <button className="btn btn--primary" onClick={()=>setNew(true)}><Icon name="plus" size={16}/>Nuevo contacto</button>
      </div>
      {mode==="list" && sel.length>0 && (
        <div className="selbar">
          <span className="selbar__count">{sel.length} seleccionados</span>
          <button className="btn btn--sm btn--ghost"><Icon name="user" size={15}/>Cambiar owner</button>
          <button className="btn btn--sm btn--ghost"><Icon name="tag" size={15}/>Añadir a lista</button>
          <button className="btn btn--sm btn--ghost"><Icon name="download" size={15}/>Exportar CSV</button>
          <div className="toolbar__spacer"></div>
          <button className="btn btn--sm btn--ghost" onClick={()=>{toast(sel.length+" enviados a la papelera");setSel([]);}}><Icon name="trash" size={15}/>Papelera</button>
          <button className="btn btn--sm btn--ghost" onClick={()=>setSel([])}><Icon name="x" size={15}/></button>
        </div>
      )}
      {mode==="list" ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr>
              <th style={{width:20}}><div className={"tbl-check"+(allSel?" on":"")} onClick={()=>setSel(allSel?[]:list.map(c=>c.id))}>{allSel&&<Icon name="check" size={12}/>}</div></th>
              <th>Empresa / Contacto</th><th>Ciclo de vida</th><th>Owner</th><th>Ciudad</th><th>Origen</th><th>Prioridad</th><th>Creado</th>
            </tr></thead>
            <tbody>
              {list.map(c=>(
                <tr key={c.id} className={sel.includes(c.id)?"sel":""} onClick={()=>nav("contact",c.id)}>
                  <td onClick={e=>{e.stopPropagation();toggle(c.id);}}><div className={"tbl-check"+(sel.includes(c.id)?" on":"")}>{sel.includes(c.id)&&<Icon name="check" size={12}/>}</div></td>
                  <td><div className="row"><Avatar name={c.company} size="md" color={CRM.colorFor(c.company)}/><div><div className="tbl__name">{c.company}</div><div className="tbl__sub">{c.full_name} · {c.email}</div></div></div></td>
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
function NewContact({onClose,onSave}){
  const [f,setF]=uState({company:"",full_name:"",email:"",phone:"",lifecycle:"lead",owner:CRM.USERS[0]?.id||""});
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const save=async()=>{
    setSaving(true);
    try{ await onSave(f); }
    finally{ setSaving(false); }
  };
  return <Modal title="Nuevo contacto" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Creando…":"Crear contacto"}</button></>}>
    <div className="fld-row"><Field label="Empresa"><input className="inp" placeholder="Nombre de la empresa" value={f.company} onChange={set("company")}/></Field><Field label="Persona de contacto"><input className="inp" placeholder="Nombre y apellidos" value={f.full_name} onChange={set("full_name")}/></Field></div>
    <div className="fld-row"><Field label="Email"><input className="inp" placeholder="email@empresa.es" value={f.email} onChange={set("email")}/></Field><Field label="Teléfono"><input className="inp" placeholder="+34 …" value={f.phone} onChange={set("phone")}/></Field></div>
    <div className="fld-row"><Field label="Ciclo de vida"><select className="inp" value={f.lifecycle} onChange={set("lifecycle")}>{CRM.LIFECYCLE.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select></Field><Field label="Owner"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field></div>
  </Modal>;
}

/* ============ CONTACT DETAIL ============ */
function ContactDetail({id, nav, toast}){
  const [,setTick]=uState(0); const bump=()=>setTick(t=>t+1);
  const c = CRM.contactById[id];
  const [tab,setTab]=uState("resumen");
  const [showEdit,setShowEdit]=uState(false);
  const [confirmDel,setConfirmDel]=uState(false);
  const [deleting,setDeleting]=uState(false);
  const [showNewDeal,setShowNewDeal]=uState(false);
  if(!c) return <div className="content"><Empty icon="contacts" title="Contacto no encontrado" sub="Puede que haya sido eliminado." action={<button className="btn btn--sm btn--primary" onClick={()=>nav("contacts")}>Volver a contactos</button>}/></div>;
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
  const tasks = CRM.TASKS.filter(t=>t.contact===id);
  const docs = CRM.DOCUMENTS.filter(d=>d.contact===id);
  const acts = CRM.ACTIVITY.filter(a=>a.contact===id);
  const wa = CRM.WHATSAPP.filter(w=>w.contact===id);
  const emails = CRM.EMAILS.filter(e=>e.contact===id);
  const tabs=[{id:"resumen",label:"Resumen"},{id:"deals",label:"Deals",n:deals.length},{id:"notas",label:"Notas",n:notes.length},{id:"tareas",label:"Tareas",n:tasks.length},{id:"whatsapp",label:"WhatsApp",n:wa.reduce((a,w)=>a+w.messages.length,0)||null},{id:"correos",label:"Correos",n:emails.length||null},{id:"docs",label:"Documentos",n:docs.length},{id:"actividad",label:"Actividad",n:acts.length}];
  return (
    <div className="content">
      <div className="row" style={{marginBottom:16}}><button className="btn btn--sm btn--ghost" onClick={()=>nav("contacts")}><Icon name="chevronR" size={15} style={{transform:"rotate(180deg)"}}/>Contactos</button></div>
      <div className="detail">
        <div className="detail__aside">
          <div className="profile">
            <div className="profile__top">
              <Avatar name={c.company} size="lg" color={CRM.colorFor(c.company)}/>
              <div><div className="profile__name">{c.company}</div><div className="profile__sub">{c.full_name}</div></div>
              <div className="row" style={{gap:6}}><LifecycleBadge id={c.lifecycle}/><PriorityDot id={c.priority} showLabel/></div>
            </div>
            <div style={{marginTop:16}}>
              <KV k="Email">{c.email}</KV><KV k="Teléfono">{c.phone}</KV><KV k="CIF/NIF">{c.dni}</KV>
              <KV k="Ciudad">{c.city} ({c.province})</KV><KV k="Empleados">{c.employees}</KV>
              <KV k="Owner"><span className="row" style={{gap:6}}>{ownerAvatar(c.owner)}{CRM.userById(c.owner)?.name}</span></KV>
              <KV k="Origen">{c.source}</KV><KV k="UTM">{c.utm}</KV>
              <KV k="KYC">{c.kyc? <Badge label="Verificado" color="#1F9D6B"/> : <Badge label="Pendiente" color="#D9822B"/>}</KV>
            </div>
            <div className="row" style={{gap:8,marginTop:14}}>
              <button className="btn btn--sm btn--primary" style={{flex:1}} onClick={()=>toast("Abriendo llamada…")}><Icon name="phone" size={15}/>Llamar</button>
              <button className="btn btn--sm btn--ghost" style={{flex:1}} onClick={()=>nav("whatsapp")}><Icon name="whatsapp" size={15}/>WhatsApp</button>
            </div>
            <div className="row" style={{gap:8,marginTop:8}}>
              <button className="btn btn--sm btn--ghost" style={{flex:1}} onClick={()=>setShowEdit(true)}><Icon name="edit" size={15}/>Editar ficha</button>
              <button className="btn btn--sm btn--danger" style={{flex:1}} onClick={()=>setConfirmDel(true)}><Icon name="trash" size={15}/>Eliminar</button>
            </div>
          </div>
        </div>
        <div>
          <Tabs tabs={tabs} active={tab} onChange={setTab}/>
          {tab==="resumen" && <div className="wrap-gap">
            <div className="card"><div className="card__head"><h3>Deals activos</h3><button className="right btn btn--sm btn--subtle" onClick={()=>setShowNewDeal(true)}><Icon name="plus" size={14}/>Nuevo deal</button></div><div className="card__body" style={{paddingTop:4}}>
              {deals.map(d=><div key={d.id} className="lrow" style={{cursor:"pointer"}} onClick={()=>nav("deal",d.id)}><div className="lrow__ico" style={{background:(CRM.serviceById(d.service)?.color || "#888")+"1A",color:CRM.serviceById(d.service)?.color || "#888"}}><Icon name="briefcase" size={17}/></div><div className="lrow__main"><div className="lrow__title">{d.title}</div><div className="lrow__sub">{CRM.serviceById(d.service)?.name || "—"}</div></div><div style={{textAlign:"right"}}><div style={{fontWeight:700,fontFamily:"var(--display)"}}>{CRM.fmtEUR(d.amount)}</div><div className="muted" style={{fontSize:11}}>{d.frequency}</div></div><StageBadge id={d.stage}/><button className="btn btn--sm btn--ghost" title="Eliminar deal" onClick={e=>{e.stopPropagation();deleteDeal(d.id,d.title);}}><Icon name="trash" size={14}/></button></div>)}
              {deals.length===0 && <span className="muted">Sin deals.</span>}
            </div></div>
            <div className="card"><div className="card__head"><h3>Últimas notas</h3></div><div className="card__body">
              {notes.length? notes.map(n=><div key={n.id} style={{marginBottom:12}}><div className="row" style={{gap:8,marginBottom:4}}>{ownerAvatar(n.author)}<span style={{fontWeight:600,fontSize:13}}>{CRM.userById(n.author)?.name}</span><span className="muted" style={{fontSize:12}}>{n.created}</span></div><div className="tl-item__body">{n.body}</div></div>) : <span className="muted">Sin notas.</span>}
            </div></div>
          </div>}
          {tab==="deals" && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Deal</th><th>Servicio</th><th>Etapa</th><th>Importe</th><th>Owner</th><th></th></tr></thead><tbody>{deals.map(d=><tr key={d.id} onClick={()=>nav("deal",d.id)}><td className="tbl__name">{d.title}</td><td><ServiceBadge id={d.service}/></td><td><StageBadge id={d.stage}/></td><td className="mono">{CRM.fmtEUR(d.amount)} <span className="muted" style={{fontSize:11}}>/{d.frequency}</span></td><td>{ownerAvatar(d.owner)}</td><td onClick={e=>e.stopPropagation()}><button className="btn btn--sm btn--ghost" title="Eliminar deal" onClick={()=>deleteDeal(d.id,d.title)}><Icon name="trash" size={14}/></button></td></tr>)}</tbody></table>{deals.length===0&&<Empty icon="briefcase" title="Sin deals"/>}</div>}
          {tab==="notas" && <div className="card"><div className="card__body"><textarea className="inp" placeholder="Escribe una nota…" style={{marginBottom:10}}></textarea><button className="btn btn--sm btn--primary" onClick={()=>toast("Nota añadida")}>Añadir nota</button><div style={{marginTop:18}}>{notes.map(n=><div key={n.id} style={{marginBottom:14}}><div className="row" style={{gap:8,marginBottom:4}}>{ownerAvatar(n.author)}<b style={{fontSize:13}}>{CRM.userById(n.author)?.name}</b><span className="muted" style={{fontSize:12}}>{n.created}</span></div><div className="tl-item__body">{n.body}</div></div>)}</div></div></div>}
          {tab==="tareas" && <div className="card"><div className="card__body" style={{paddingTop:6}}>{tasks.length? tasks.map(t=><TaskRow key={t.id} t={t} toast={toast}/>) : <Empty icon="task" title="Sin tareas"/>}</div></div>}
          {tab==="whatsapp" && <div className="card"><div className="card__body">{wa.length? wa[0].messages.map((m,i)=><div key={i} className={"bubble "+(m.dir)} style={{marginBottom:8,maxWidth:"70%"}}>{m.body}<div className="bubble__t">{m.t}</div></div>) : <Empty icon="whatsapp" title="Sin conversación de WhatsApp"/>}</div></div>}
          {tab==="correos" && <div className="wrap-gap">{emails.length? emails.map(e=><EmailThreadCard key={e.id} email={e} toast={toast} bump={bump}/>) : <Empty icon="mail" title="Sin correos vinculados"/>}</div>}
          {tab==="docs" && <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Documento</th><th>Tipo</th><th>Tamaño</th><th>Visible cliente</th><th>Fecha</th></tr></thead><tbody>{docs.map(d=><tr key={d.id}><td className="row" style={{gap:8}}><Icon name="documents" size={17} style={{color:"var(--muted)"}}/><span className="tbl__name">{d.name}</span></td><td><Badge label={d.type} color="#6E8298"/></td><td className="tbl__sub">{d.size}</td><td>{d.visible? <Badge label="Compartido" color="#1F9D6B"/> : <span className="muted">No</span>}</td><td className="tbl__sub">{d.at}</td></tr>)}</tbody></table>{docs.length===0&&<Empty icon="documents" title="Sin documentos"/>}</div>}
          {tab==="actividad" && <div className="card"><div className="card__body"><div className="tl">{acts.map((a,i)=><div key={i} className="tl-item"><div className="tl-item__ico"><Icon name={a.type==="call"?"phone":a.type==="note"?"note":a.type==="email"?"mail":a.type==="doc"?"documents":a.type==="stage"?"pipeline":"contacts"} size={11}/></div><div className="tl-item__head">{a.text}</div><div className="tl-item__meta">{a.who?CRM.userById(a.who)?.name+" · ":""}{a.at}</div></div>)}</div></div></div>}
        </div>
      </div>
      {showEdit && <EditContact contact={c} onClose={()=>setShowEdit(false)} onSave={async(patch)=>{
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
        <p className="muted">Se eliminará <b>{c.company}</b> junto con sus {deals.length} deal(s), notas, tareas y documentos asociados. Esta acción no se puede deshacer.</p>
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
    </div>
  );
}
function EditContact({contact, onClose, onSave}){
  const [f,setF]=uState(()=>{
    var init={...contact};
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
    <div className="fld-row"><Field label="Empresa"><input className="inp" value={f.company} onChange={set("company")}/></Field><Field label="Persona de contacto"><input className="inp" value={f.full_name} onChange={set("full_name")}/></Field></div>
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
function TaskRow({t, toast}){
  const [done,setDone]=uState(t.status==="done");
  return <div className="lrow"><div className={"tcheck"+(done?" done":"")} onClick={()=>{setDone(!done);toast(done?"Tarea reabierta":"Tarea completada");}}>{done&&<Icon name="check" size={13}/>}</div><div className="lrow__main"><div className="lrow__title" style={{textDecoration:done?"line-through":"none",opacity:done?.6:1}}>{t.title}</div><div className="lrow__sub">Vence {t.due} · {CRM.userById(t.owner)?.name.split(" ")[0]}</div></div><PriorityDot id={t.priority}/></div>;
}

function NewDeal({contactId, onClose, onSave}){
  const [f,setF]=uState({title:"", contact:contactId||"", service:"", stage:"reunion", amount:"", frequency:"", priority:""});
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const save=async()=>{
    setSaving(true);
    try{ await onSave(f); }
    finally{ setSaving(false); }
  };
  return <Modal title="Nuevo deal" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Creando…":"Crear deal"}</button></>}>
    <Field label="Título"><input className="inp" placeholder="Ej. CFO externo para escalado" value={f.title} onChange={set("title")}/></Field>
    {!contactId && <Field label="Contacto"><select className="inp" value={f.contact} onChange={set("contact")}><option value="">— Selecciona un contacto —</option>{CRM.CONTACTS.map(c=><option key={c.id} value={c.id}>{c.company}</option>)}</select></Field>}
    <div className="fld-row">
      <Field label="Servicio"><select className="inp" value={f.service} onChange={set("service")}><option value="">— Sin especificar —</option>{CRM.SERVICES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Etapa"><select className="inp" value={f.stage} onChange={set("stage")}>{CRM.STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
    </div>
    <div className="fld-row">
      <Field label="Importe (€)"><input className="inp" type="number" placeholder="0" value={f.amount} onChange={set("amount")}/></Field>
      <Field label="Frecuencia"><select className="inp" value={f.frequency} onChange={set("frequency")}><option value="">— Sin especificar —</option><option value="mensual">Mensual</option><option value="puntual">Puntual</option></select></Field>
    </div>
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
              {items.map(d=>{ const c=CRM.contactById[d.contact]; const s=CRM.serviceById(d.service);
                return <div key={d.id} className={"kcard"+(drag===d.id?" dragging":"")} draggable onDragStart={()=>setDrag(d.id)} onDragEnd={()=>{setDrag(null);setOver(null);}} onClick={()=>nav("deal",d.id)}>
                  <div className="kcard__top"><span className="dot" style={{background:s?.color || "#888"}}></span><span className="muted" style={{fontSize:11,fontWeight:600}}>{s?.short || "—"}</span><span className="right">{ownerAvatar(d.owner)}</span></div>
                  <div className="kcard__title">{d.title}</div>
                  <div className="kcard__co">{c?.company}</div>
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
  const [showEdit,setShowEdit]=uState(false); const [showUpload,setShowUpload]=uState(false);
  const [confirmDel,setConfirmDel]=uState(false); const [deleting,setDeleting]=uState(false);
  const d = CRM.DEALS.find(x=>x.id===id);
  const [tab,setTab]=uState("resumen");
  if(!d) return <div className="content"><Empty title="Deal no encontrado"/></div>;
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
  const c=CRM.contactById[d.contact]; const s=CRM.serviceById(d.service);
  const notes=CRM.NOTES.filter(n=>n.deal===id); const docs=CRM.DOCUMENTS.filter(x=>x.deal===id); const tasks=CRM.TASKS.filter(t=>t.deal===id);
  const wa=CRM.WHATSAPP.filter(w=>w.contact===d.contact);
  const dealEmails=CRM.EMAILS.filter(e=>e.deal===id);
  const tabs=[{id:"resumen",label:"Resumen"},{id:"notas",label:"Notas",n:notes.length},{id:"tareas",label:"Tareas",n:tasks.length},{id:"whatsapp",label:"WhatsApp",n:wa.reduce((a,w)=>a+w.messages.length,0)||null},{id:"correos",label:"Correos",n:dealEmails.length||null},{id:"docs",label:"Documentos",n:docs.length}];
  const stageIdx=CRM.STAGES.findIndex(x=>x.id===d.stage);
  return (
    <div className="content">
      <div className="row" style={{marginBottom:16}}><button className="btn btn--sm btn--ghost" onClick={()=>nav("pipeline")}><Icon name="chevronR" size={15} style={{transform:"rotate(180deg)"}}/>Pipeline</button></div>
      <div className="detail">
        <div className="detail__aside">
          <div className="profile">
            <div style={{textAlign:"center"}}><div className="lrow__ico" style={{width:52,height:52,margin:"0 auto 10px",background:(s?.color || "#888")+"1A",color:s?.color || "#888",borderRadius:14}}><Icon name="briefcase" size={24}/></div><div className="profile__name" style={{fontSize:17}}>{d.title}</div><div className="profile__sub" style={{cursor:"pointer",color:"var(--accent)"}} onClick={()=>nav("contact",c.id)}>{c.company}</div></div>
            <div style={{margin:"14px 0"}}><StageBadge id={d.stage}/></div>
            <div><KV k="Servicio"><ServiceBadge id={d.service}/></KV><KV k="Importe">{CRM.fmtEUR(d.amount)} / {d.frequency}</KV><KV k="Owner"><span className="row" style={{gap:6}}>{ownerAvatar(d.owner)}{CRM.userById(d.owner)?.name}</span></KV><KV k="Prioridad"><PriorityDot id={d.priority} showLabel/></KV><KV k="Creado">{d.created}</KV>{d.signed&&<KV k="Firmado">{d.signed}</KV>}{d.renewal&&<KV k="Renovación">{d.renewal}</KV>}</div>
            <button className="btn btn--sm btn--primary" style={{width:"100%",marginTop:14}} onClick={()=>setShowEdit(true)}><Icon name="edit" size={15}/>Editar deal</button>
            <button className="btn btn--sm btn--danger" style={{width:"100%",marginTop:8}} onClick={()=>setConfirmDel(true)}><Icon name="trash" size={15}/>Eliminar deal</button>
          </div>
        </div>
        <div>
          <div className="card" style={{marginBottom:16}}><div className="card__body"><div className="section-title" style={{marginBottom:10}}>Progreso en el pipeline</div><div className="row" style={{gap:0}}>{CRM.STAGES.filter(x=>x.id!=="perdido").map((x,i)=><div key={x.id} style={{flex:1,textAlign:"center"}}><div style={{height:6,background:i<=stageIdx?x.color:"var(--line)",borderRadius:20,margin:"0 2px"}}></div><div style={{fontSize:10.5,marginTop:6,color:i<=stageIdx?"var(--ink)":"var(--muted)",fontWeight:i===stageIdx?700:400}}>{x.label}</div></div>)}</div></div></div>
          <Tabs tabs={tabs} active={tab} onChange={setTab}/>
          {tab==="resumen" && <div className="card"><div className="card__body"><div className="grid-2"><KV k="Proveedor actual">Gestoría local</KV><KV k="Cuota actual">{CRM.fmtEUR(Math.round(d.amount*1.2))}</KV><KV k="Ahorro estimado">{CRM.fmtEUR(Math.round(d.amount*0.2))}/{d.frequency}</KV><KV k="Frecuencia pago">{d.frequency}</KV></div></div></div>}
          {tab==="notas" && <div className="card"><div className="card__body"><textarea className="inp" placeholder="Nota interna del deal…" style={{marginBottom:10}}></textarea><button className="btn btn--sm btn--primary" onClick={()=>toast("Nota añadida")}>Añadir</button><div style={{marginTop:16}}>{notes.map(n=><div key={n.id} style={{marginBottom:12}}><div className="row" style={{gap:8,marginBottom:4}}>{ownerAvatar(n.author)}<b style={{fontSize:13}}>{CRM.userById(n.author)?.name}</b><span className="muted" style={{fontSize:12}}>{n.created}</span></div><div className="tl-item__body">{n.body}</div></div>)}{notes.length===0&&<span className="muted">Sin notas.</span>}</div></div></div>}
          {tab==="tareas" && <div className="card"><div className="card__body" style={{paddingTop:6}}>{tasks.length?tasks.map(t=><TaskRow key={t.id} t={t} toast={toast}/>):<Empty icon="task" title="Sin tareas"/>}</div></div>}
          {tab==="docs" && <>
            <div className="row" style={{justifyContent:"flex-end",marginBottom:12}}><button className="btn btn--sm btn--primary" onClick={()=>setShowUpload(true)}><Icon name="upload" size={14}/>Subir documento</button></div>
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Documento</th><th>Tipo</th><th>Visible cliente</th></tr></thead><tbody>{docs.map(x=><tr key={x.id}><td className="row" style={{gap:8}}><Icon name="documents" size={17} style={{color:"var(--muted)"}}/><span className="tbl__name">{x.name}</span></td><td><Badge label={x.type} color="#6E8298"/></td><td>{x.visible?<Badge label="Compartido" color="#1F9D6B"/>:<span className="muted">No</span>}</td></tr>)}</tbody></table>{docs.length===0&&<Empty icon="documents" title="Sin documentos"/>}</div>
          </>}
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
      {showUpload && <UploadDocument onClose={()=>setShowUpload(false)} onSave={(doc)=>{CRM.addDocument({...doc, deal:d.id, contact:d.contact, by:user?.id, at:new Date().toISOString().slice(0,10)});setShowUpload(false);toast("Documento subido");bump();}}/>}
      {confirmDel && <Modal title="Eliminar deal" onClose={()=>setConfirmDel(false)} footer={<><button className="btn btn--ghost" onClick={()=>setConfirmDel(false)} disabled={deleting}>Cancelar</button><button className="btn btn--danger" onClick={doDelete} disabled={deleting}>{deleting?"Eliminando…":"Eliminar definitivamente"}</button></>}>
        <p className="muted">Se eliminará el deal <b>{d.title}</b>. Esta acción no se puede deshacer.</p>
      </Modal>}
    </div>
  );
}
function EditDeal({deal, onClose, onSave}){
  const [f,setF]=uState({...deal});
  const [saving,setSaving]=uState(false);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const save=async()=>{
    setSaving(true);
    try{ await onSave(f); }
    finally{ setSaving(false); }
  };
  return <Modal title="Editar deal" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button><button className="btn btn--primary" onClick={save} disabled={saving}>{saving?"Guardando…":"Guardar cambios"}</button></>}>
    <Field label="Título"><input className="inp" value={f.title} onChange={set("title")}/></Field>
    <div className="fld-row">
      <Field label="Servicio"><select className="inp" value={f.service} onChange={set("service")}>{CRM.SERVICES.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Etapa"><select className="inp" value={f.stage} onChange={set("stage")}>{CRM.STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
    </div>
    <div className="fld-row">
      <Field label="Importe (€)"><input className="inp" type="number" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})}/></Field>
      <Field label="Frecuencia"><select className="inp" value={f.frequency} onChange={set("frequency")}><option value="mensual">mensual</option><option value="trimestral">trimestral</option><option value="anual">anual</option><option value="puntual">puntual</option></select></Field>
    </div>
    <div className="fld-row">
      <Field label="Owner"><select className="inp" value={f.owner} onChange={set("owner")}>{CRM.USERS.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Prioridad"><select className="inp" value={f.priority} onChange={set("priority")}>{CRM.PRIORITIES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
    </div>
  </Modal>;
}
function UploadDocument({onClose, onSave}){
  const [name,setName]=uState(""); const [type,setType]=uState("Informe"); const [visible,setVisible]=uState(false);
  const TYPES=["Contrato","Propuesta","Informe","Modelo","Legal","Borrador","Factura","Otro"];
  return <Modal title="Subir documento" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={()=>name.trim() && onSave({name:name.trim(), type, visible})}>Subir</button></>}>
    <Field label="Título del documento"><input className="inp" placeholder="Ej. Contrato firmado 2026" value={name} onChange={e=>setName(e.target.value)}/></Field>
    <Field label="Tipo"><select className="inp" value={type} onChange={e=>setType(e.target.value)}>{TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
    <Field label="Archivo"><div className="upload-drop"><Icon name="upload" size={20}/><span>Arrastra un archivo o haz clic para elegirlo</span><input type="file" style={{position:"absolute",inset:0,opacity:0,cursor:"pointer"}} onChange={()=>{}}/></div></Field>
    <Field label="Visible en el portal del cliente"><label className="row" style={{gap:8}}><input type="checkbox" checked={visible} onChange={e=>setVisible(e.target.checked)}/> El cliente podrá verlo y descargarlo</label></Field>
  </Modal>;
}

/* ============ WHATSAPP ============ */
function WhatsApp({nav, toast}){
  const [convs,setConvs]=uState(()=>CRM.WHATSAPP.map(w=>({...w,messages:[...w.messages]})));
  const [filter,setFilter]=uState("active");
  const [active,setActive]=uState(convs.find(w=>!w.archived)?.id || null);
  const [txt,setTxt]=uState(""); const [showTpl,setShowTpl]=uState(false);
  const visible = convs.filter(w=>filter==="active" ? !w.archived : w.archived);
  const conv = convs.find(w=>w.id===active);
  const c = conv && CRM.contactById[conv.contact];
  const send=()=>{ if(!txt.trim()||!conv)return; setConvs(cs=>cs.map(w=>w.id===conv.id?{...w,messages:[...w.messages,{dir:"out",t:"Ahora",body:txt}]}:w)); setTxt(""); };
  const toggleArchive=(id,e)=>{
    e.stopPropagation();
    const w=convs.find(x=>x.id===id); const newVal=!w.archived;
    CRM.setArchived(id,newVal);
    setConvs(cs=>cs.map(x=>x.id===id?{...x,archived:newVal}:x));
    toast(newVal?"Conversación archivada":"Conversación restaurada");
    if(active===id) setActive(null);
  };
  uEffect(()=>{
    if(!visible.find(w=>w.id===active)) setActive(visible[0]?.id || null);
  },[filter]);
  return (
    <div className="wa">
      <div className="wa__list">
        <div className="wa__tabs">
          <button className={filter==="active"?"active":""} onClick={()=>setFilter("active")}>Activas</button>
          <button className={filter==="archived"?"active":""} onClick={()=>setFilter("archived")}>Archivadas</button>
          <button className="wa__tpl-btn" onClick={()=>setShowTpl(true)} title="Plantillas de WhatsApp"><Icon name="documents" size={15}/>Plantillas</button>
        </div>
        {visible.map(w=>{ const cc=CRM.contactById[w.contact]; const last=w.messages[w.messages.length-1];
          return <div key={w.id} className={"wa__conv"+(active===w.id?" active":"")} onClick={()=>{setActive(w.id);setConvs(cs=>cs.map(x=>x.id===w.id?{...x,unread:0}:x));}}>
            <Avatar name={cc.company} size="md" color={CRM.colorFor(cc.company)}/>
            <div className="wa__conv__main"><div className="wa__conv__name"><span>{cc.company}</span><span className="wa__conv__time">{w.updated}</span></div><div className="wa__conv__last">{last.dir==="out"?"Tú: ":""}{last.body}</div></div>
            {w.unread>0 && <span className="wa__unread">{w.unread}</span>}
            <button className="wa__archive" title={w.archived?"Restaurar":"Archivar"} onClick={e=>toggleArchive(w.id,e)}><Icon name={w.archived?"refresh":"archive"} size={15}/></button>
          </div>;
        })}
        {visible.length===0 && <div className="muted" style={{padding:"24px 16px",fontSize:13,textAlign:"center"}}>{filter==="active"?"Sin conversaciones activas.":"No hay conversaciones archivadas."}</div>}
      </div>
      <div className="wa__thread">
        {conv ? <>
          <div className="wa__thread__head"><Avatar name={c.company} size="md" color={CRM.colorFor(c.company)}/><div><div style={{fontWeight:600}}>{c.company}</div><div className="muted" style={{fontSize:12}}>{c.full_name} · {c.phone}</div></div><button className="btn btn--sm btn--ghost right" onClick={()=>nav("contact",c.id)}>Ver ficha</button></div>
          <div className="wa__msgs">{conv.messages.map((m,i)=><div key={i} className={"bubble "+m.dir}>{m.body}<div className="bubble__t">{m.t}</div></div>)}</div>
          <div className="wa__compose"><button className="btn btn--ghost btn--icon" title="Insertar plantilla" onClick={()=>setShowTpl(true)}><Icon name="documents" size={17}/></button><input placeholder="Escribe un mensaje…" value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")send();}}/><button className="btn btn--primary btn--icon" onClick={send}><Icon name="send" size={18}/></button></div>
        </> : <div className="muted" style={{margin:"auto",fontSize:13}}>{filter==="archived"?"Selecciona una conversación archivada.":"Sin conversaciones."}</div>}
      </div>
      {showTpl && <TemplatesModal onClose={()=>setShowTpl(false)} onUse={conv?(body)=>{setTxt(body);setShowTpl(false);}:null} toast={toast}/>}
    </div>
  );
}
function TemplatesModal({onClose, onUse, toast}){
  const [templates,setTemplates]=uState(()=>[...CRM.WA_TEMPLATES]);
  const [importing,setImporting]=uState(false);
  const importFromMeta=()=>{
    setImporting(true);
    setTimeout(()=>{
      const extra=[{id:"tpl"+Date.now(), name:"seguimiento_propuesta", category:"Marketing", lang:"es_ES", body:"Hola {{1}}, ¿pudiste revisar la propuesta que te enviamos? Quedamos a tu disposición para cualquier duda."}];
      setTemplates(t=>[...t,...extra]);
      setImporting(false);
      toast(extra.length+" plantilla nueva importada desde Meta Business Manager");
    }, 1100);
  };
  return <Modal title="Plantillas de WhatsApp" wide onClose={onClose} footer={<button className="btn btn--ghost" onClick={onClose}>Cerrar</button>}>
    <div className="row" style={{justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,gap:16}}>
      <p className="muted" style={{maxWidth:420,margin:0}}>Plantillas aprobadas en el WhatsApp Business Manager de Meta. Impórtalas para reutilizarlas al escribir a un cliente.</p>
      <button className="btn btn--sm btn--primary" style={{flex:"none"}} onClick={importFromMeta} disabled={importing}>{importing? "Importando…" : <><Icon name="download" size={14}/>Importar desde Meta</>}</button>
    </div>
    <div className="wrap-gap" style={{gap:10}}>
      {templates.map(t=>(
        <div key={t.id} className="card"><div className="card__body" style={{padding:14}}>
          <div className="row" style={{justifyContent:"space-between"}}>
            <div className="row" style={{gap:8}}><span style={{fontWeight:700,fontFamily:"var(--display)",fontSize:13.5}}>{t.name}</span><Badge label={t.category} color="#6E8298"/><span className="muted" style={{fontSize:11.5}}>{t.lang}</span></div>
            {onUse && <button className="btn btn--sm btn--subtle" onClick={()=>onUse(t.body)}>Usar</button>}
          </div>
          <div className="tl-item__body" style={{marginTop:8}}>{t.body}</div>
        </div></div>
      ))}
    </div>
  </Modal>;
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
function Documents({toast}){
  const [docs,setDocs]=uState(CRM.DOCUMENTS.map(d=>({...d})));
  const [preview,setPreview]=uState(null);
  const toggle=(id)=>{ setDocs(ds=>ds.map(d=>d.id===id?{...d,visible:!d.visible}:d)); toast("Visibilidad actualizada"); };
  const download=(doc)=>{
    toast("Descargando "+doc.name+"…");
    const blob=new Blob(["GUIMAES — "+doc.name+"\n\nTipo: "+doc.type+"\nCliente: "+(CRM.contactById[doc.contact]?.company||"—")+"\nFecha: "+doc.at+"\n\n(Documento de ejemplo — prototipo)"],{type:"text/plain"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=doc.name.replace(/\.[^.]+$/,"")+".txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),2000);
  };
  const remove=(doc)=>{
    if(!window.confirm("¿Eliminar \""+doc.name+"\"? Esta acción no se puede deshacer.")) return;
    CRM.removeDocument(doc.id);
    setDocs(ds=>ds.filter(d=>d.id!==doc.id));
    toast("Documento eliminado");
  };
  return <div className="content">
    <div className="toolbar"><div className="searchbox"><Icon name="search" size={16}/><input placeholder="Buscar documento…"/></div><div className="toolbar__spacer"></div><button className="btn btn--primary"><Icon name="upload" size={16}/>Subir documento</button></div>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Documento</th><th>Tipo</th><th>Cliente</th><th>Tamaño</th><th>Subido por</th><th>Fecha</th><th>Visible en portal</th><th></th></tr></thead><tbody>
      {docs.map(d=><tr key={d.id}><td className="row" style={{gap:10}}><div className="lrow__ico"><Icon name="documents" size={17}/></div><span className="tbl__name">{d.name}</span></td><td><Badge label={d.type} color="#6E8298"/></td><td className="tbl__sub">{CRM.contactById[d.contact]?.company}</td><td className="tbl__sub">{d.size}</td><td>{ownerAvatar(d.by)}</td><td className="tbl__sub">{d.at}</td><td onClick={e=>e.stopPropagation()}><label className="row" style={{gap:8,cursor:"pointer"}}><div className={"tbl-check"+(d.visible?" on":"")} onClick={()=>toggle(d.id)}>{d.visible&&<Icon name="check" size={12}/>}</div>{d.visible?<span style={{color:"var(--ok)",fontSize:13,fontWeight:600}}>Compartido</span>:<span className="muted" style={{fontSize:13}}>Privado</span>}</label></td>
        <td onClick={e=>e.stopPropagation()}><div className="row" style={{gap:4}}>
          <button className="btn btn--sm btn--ghost" title="Ver" onClick={()=>setPreview(d)}><Icon name="eye" size={14}/></button>
          <button className="btn btn--sm btn--ghost" title="Descargar" onClick={()=>download(d)}><Icon name="download" size={14}/></button>
          <button className="btn btn--sm btn--ghost" title="Eliminar" onClick={()=>remove(d)}><Icon name="trash" size={14}/></button>
        </div></td>
      </tr>)}
    </tbody></table>{docs.length===0 && <Empty icon="documents" title="Sin documentos"/>}</div>
    {preview && <Modal title={preview.name} onClose={()=>setPreview(null)} footer={<><button className="btn btn--ghost" onClick={()=>setPreview(null)}>Cerrar</button><button className="btn btn--primary" onClick={()=>{download(preview);}}><Icon name="download" size={15}/>Descargar</button></>}>
      <KV k="Tipo"><Badge label={preview.type} color="#6E8298"/></KV>
      <KV k="Cliente">{CRM.contactById[preview.contact]?.company || "—"}</KV>
      <KV k="Tamaño">{preview.size}</KV>
      <KV k="Subido por">{CRM.userById(preview.by)?.name || "—"}</KV>
      <KV k="Fecha">{preview.at}</KV>
      <KV k="Visible en portal">{preview.visible? "Sí" : "No"}</KV>
    </Modal>}
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

/* ============ CONFIG ============ */
function Config({toast}){
  const [tab,setTab]=uState("servicios");
  const [services,setServices]=uState(CRM.SERVICES.map(s=>({...s}))); const [showNewSvc,setNewSvc]=uState(false);
  const [users,setUsers]=uState(CRM.USERS.map(u=>({...u}))); const [showNewUser,setNewUser]=uState(false); const [delUser,setDelUser]=uState(null);
  const addService=(svc)=>{ setServices(ss=>[...ss,{...svc,id:"s"+(ss.length+1)}]); setNewSvc(false); toast("Servicio creado"); };
  const changeRole=(id,role)=>{ CRM.updateUser(id,{role}); setUsers(us=>us.map(u=>u.id===id?{...u,role}:u)); toast("Rol actualizado"); };
  const addUser=(u)=>{ const full=CRM.addUser(u); setUsers(us=>[...us,full]); setNewUser(false); toast("Administrador creado — ya puede iniciar sesión con la contraseña temporal"); };
  const confirmRemoveUser=async()=>{
    const {error} = await Auth.deleteAdminUser(delUser.email);
    CRM.removeUser(delUser.id); setUsers(us=>us.filter(u=>u.id!==delUser.id)); setDelUser(null);
    toast(error? ("Eliminado del CRM, pero aviso: "+error.message) : "Administrador eliminado y acceso revocado en Supabase");
  };
  return <div className="content">
    <Tabs tabs={[{id:"servicios",label:"Servicios"},{id:"usuarios",label:"Usuarios y roles"}]} active={tab} onChange={setTab}/>
    {tab==="servicios" && <>
      <div className="toolbar"><div className="muted" style={{fontSize:13}}>Catálogo de servicios que ofrece el despacho. Puedes crear nuevos.</div><div className="toolbar__spacer"></div><button className="btn btn--primary" onClick={()=>setNewSvc(true)}><Icon name="plus" size={16}/>Nuevo servicio</button></div>
      <div className="svc-grid">{services.map(s=><div key={s.id} className="card"><div className="card__body"><div className="row" style={{gap:10}}><div className="lrow__ico" style={{background:s.color+"1A",color:s.color}}><Icon name="briefcase" size={18}/></div><div style={{flex:1}}><div style={{fontWeight:700,fontFamily:"var(--display)"}}>{s.name}</div><div className="muted" style={{fontSize:12}}>{s.recurring?"Recurrente":"Puntual"} · {s.frequency}</div></div></div><div className="row" style={{marginTop:12,justifyContent:"space-between"}}><span className="muted" style={{fontSize:12}}>Cuota de referencia</span><span style={{fontWeight:700,fontFamily:"var(--display)"}}>{CRM.fmtEUR(s.defaultFee)}</span></div></div></div>)}</div>
    </>}
    {tab==="usuarios" && <>
      <div className="toolbar"><div className="muted" style={{fontSize:13}}>Administradores con acceso al CRM. Solo estos emails pueden iniciar sesión.</div><div className="toolbar__spacer"></div><button className="btn btn--primary" onClick={()=>setNewUser(true)}><Icon name="plus" size={16}/>Nuevo administrador</button></div>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Usuario</th><th>Email</th><th>Rol</th><th>Puesto</th><th>Estado</th><th></th></tr></thead><tbody>
        {users.map(u=><tr key={u.id}>
          <td className="row" style={{gap:10}}><Avatar name={u.name} size="md" color={u.color}/><span className="tbl__name">{u.name}</span></td>
          <td className="tbl__sub">{u.email}</td>
          <td onClick={e=>e.stopPropagation()}><select className="inp" style={{padding:"6px 10px",fontSize:13,width:"auto"}} value={u.role||"admin"} onChange={e=>changeRole(u.id,e.target.value)}>{CRM.ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></td>
          <td className="tbl__sub">{u.title}</td>
          <td><Badge label="Activo" color="#1F9D6B"/></td>
          <td onClick={e=>e.stopPropagation()}><button className="btn btn--sm btn--ghost" title="Eliminar" onClick={()=>setDelUser(u)} disabled={users.length<=1}><Icon name="trash" size={14}/></button></td>
        </tr>)}
      </tbody></table></div>
      <p className="muted" style={{fontSize:12,marginTop:10}}>Al crear un administrador aquí se genera directamente su acceso real (email + contraseña temporal) en Supabase. Al eliminarlo, se revoca ese acceso.</p>
    </>}
    {showNewSvc && <NewService onClose={()=>setNewSvc(false)} onSave={addService}/>}
    {showNewUser && <NewUser onClose={()=>setNewUser(false)} onSave={addUser}/>}
    {delUser && <Modal title="Eliminar administrador" onClose={()=>setDelUser(null)} footer={<><button className="btn btn--ghost" onClick={()=>setDelUser(null)}>Cancelar</button><button className="btn btn--danger" onClick={confirmRemoveUser}>Eliminar</button></>}>
      <p className="muted">Se eliminará a <b>{delUser.name}</b> ({delUser.email}) del CRM y se revocará su acceso en Supabase. No podrá volver a iniciar sesión.</p>
    </Modal>}
  </div>;
}
function NewUser({onClose,onSave}){
  const genPassword=()=>{ const chars="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; let p=""; for(let i=0;i<10;i++) p+=chars[Math.floor(Math.random()*chars.length)]; return p; };
  const [f,setF]=uState({name:"",email:"",title:"",role:"admin",password:genPassword()});
  const [busy,setBusy]=uState(false); const [err,setErr]=uState(null);
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  const submit=async()=>{
    if(!f.name||!f.email||!f.password){ setErr("Completa nombre, email y contraseña."); return; }
    setBusy(true); setErr(null);
    const {error} = await Auth.createAdminUser(f.email, f.password, f.name);
    setBusy(false);
    if(error){ setErr(error.message); return; }
    onSave(f);
  };
  return <Modal title="Nuevo administrador" onClose={onClose} footer={<><button className="btn btn--ghost" onClick={onClose}>Cancelar</button><button className="btn btn--primary" onClick={submit} disabled={busy}>{busy?"Creando…":"Crear acceso"}</button></>}>
    {err && <div className="login__err">{err}</div>}
    <Field label="Nombre completo"><input className="inp" placeholder="Nombre y apellidos" value={f.name} onChange={set("name")}/></Field>
    <Field label="Correo electrónico"><input className="inp" type="email" placeholder="nombre@guimaes.es" value={f.email} onChange={set("email")}/></Field>
    <div className="fld-row">
      <Field label="Puesto"><input className="inp" placeholder="Ej. Asesora · Fiscal" value={f.title} onChange={set("title")}/></Field>
      <Field label="Rol"><select className="inp" value={f.role} onChange={set("role")}>{CRM.ROLES.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
    </div>
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
    <Field label="Cuota de referencia (€)"><input className="inp" type="number" value={f.defaultFee} onChange={e=>setF({...f,defaultFee:+e.target.value})}/></Field>
    <Field label="Color"><div className="row" style={{gap:8}}>{colors.map(c=><div key={c} onClick={()=>setF({...f,color:c})} style={{width:28,height:28,borderRadius:8,background:c,cursor:"pointer",boxShadow:f.color===c?"0 0 0 3px "+c+"55":"none"}}></div>)}</div></Field>
  </Modal>;
}

/* ============ PORTAL CLIENTE ============ */
function Portal({onExit, toast}){
  const client = CRM.contactById["c1"]; // demo: Nordia Logística
  const myDeals = CRM.DEALS.filter(d=>d.contact===client.id && d.stage==="cliente_activo");
  const myDocs = CRM.DOCUMENTS.filter(d=>d.contact===client.id && d.visible);
  const [req,setReq]=uState(false);
  return <div className="portal">
    <div className="portal__nav"><span className="sb-brand__logo" style={{color:"var(--ink)"}}>GUIMAES</span><span className="badge" style={{background:"var(--accent-soft)",color:"var(--accent-ink)"}}>Área cliente</span><div className="right row" style={{gap:12}}><Avatar name={client.company} size="sm" color={CRM.colorFor(client.company)}/><span style={{fontWeight:600,fontSize:14}}>{client.company}</span><button className="btn btn--sm btn--ghost" onClick={onExit}><Icon name="logout" size={15}/>Salir</button></div></div>
    <div className="portal__wrap">
      <h1 style={{fontSize:28}}>Hola, {client.full_name.split(" ")[0]} 👋</h1>
      <p className="muted" style={{marginBottom:24}}>Tus servicios activos con GUIMAES y tus documentos, en un solo sitio.</p>
      <div className="row" style={{justifyContent:"space-between",marginBottom:12}}><h3 style={{fontSize:17}}>Tus servicios activos</h3><button className="btn btn--sm btn--primary" onClick={()=>setReq(true)}><Icon name="plus" size={15}/>Solicitar nuevo servicio</button></div>
      <div className="svc-grid">
        {myDeals.map(d=>{ const s=CRM.serviceById(d.service);
          return <div key={d.id} className="svc-card"><div className="row" style={{gap:10}}><div className="lrow__ico" style={{background:s.color+"1A",color:s.color}}><Icon name="briefcase" size={18}/></div><div><div style={{fontWeight:700,fontFamily:"var(--display)"}}>{s.name}</div><div className="muted" style={{fontSize:12}}>{d.title}</div></div></div><div className="row" style={{justifyContent:"space-between",marginTop:14}}><span className="muted" style={{fontSize:12}}>Cuota {d.frequency}</span><span style={{fontWeight:700,fontFamily:"var(--display)"}}>{CRM.fmtEUR(d.amount)}</span></div>{d.renewal&&<div className="muted" style={{fontSize:12,marginTop:6}}>Renueva el {d.renewal}</div>}</div>;
        })}
      </div>
      <h3 style={{fontSize:17,margin:"28px 0 12px"}}>Documentos compartidos</h3>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Documento</th><th>Tipo</th><th>Fecha</th><th></th></tr></thead><tbody>{myDocs.map(d=><tr key={d.id}><td className="row" style={{gap:10}}><div className="lrow__ico"><Icon name="documents" size={17}/></div><span className="tbl__name">{d.name}</span></td><td><Badge label={d.type} color="#6E8298"/></td><td className="tbl__sub">{d.at}</td><td><button className="btn btn--sm btn--ghost" onClick={()=>toast("Descargando…")}><Icon name="download" size={14}/>Descargar</button></td></tr>)}</tbody></table></div>
    </div>
    {req && <Modal title="Solicitar un nuevo servicio" onClose={()=>setReq(false)} footer={<><button className="btn btn--ghost" onClick={()=>setReq(false)}>Cancelar</button><button className="btn btn--primary" onClick={()=>{setReq(false);toast("Solicitud enviada — se ha creado un lead en el CRM");}}>Enviar solicitud</button></>}>
      <p className="muted" style={{marginBottom:14}}>Elige el servicio que te interesa. Tu asesor recibirá la solicitud como una nueva oportunidad.</p>
      <Field label="Servicio"><select className="inp">{CRM.SERVICES.map(s=><option key={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Comentario"><textarea className="inp" placeholder="Cuéntanos brevemente qué necesitas…"></textarea></Field>
    </Modal>}
  </div>;
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

/* ============ ROOT ============ */
function App(){
  const [user,setUser]=uState(null); const [portal,setPortal]=uState(false);
  const [view,setView]=uState({name:"home",id:null}); const [toast,fireToast]=useToast();
  const [booting,setBooting]=uState(true); const [recovery,setRecovery]=uState(false);

  uEffect(()=>{
    let mounted=true;
    (async()=>{
      if(Auth.configured){
        const session = await Auth.getSession();
        if(session && Auth.isAllowed(session.user.email)){
          if(CRM.loadContactos) await CRM.loadContactos(Auth.client);
          if(CRM.loadDeals) await CRM.loadDeals(Auth.client);
          if(CRM.loadWebLeads) await CRM.loadWebLeads(Auth.client);
          if(mounted) setUser(userFromSession(session));
        }
        Auth.onAuthStateChange((event, session)=>{
          if(event==="PASSWORD_RECOVERY"){ setRecovery(true); return; }
          if(event==="SIGNED_IN" && session){
            if(!Auth.isAllowed(session.user.email)){ Auth.signOut(); fireToast("Esta cuenta no tiene acceso al CRM."); return; }
            (async()=>{ if(CRM.loadContactos) await CRM.loadContactos(Auth.client); if(CRM.loadDeals) await CRM.loadDeals(Auth.client); if(CRM.loadWebLeads) await CRM.loadWebLeads(Auth.client); setUser(userFromSession(session)); })();
          }
          if(event==="SIGNED_OUT"){ setUser(null); }
        });
      }
      if(mounted) setBooting(false);
    })();
    return ()=>{mounted=false;};
  },[]);

  const nav=(name,id=null)=>{ if(name==="portal"){ setPortal(true); return; } setView({name,id}); };
  const logout=async()=>{ await Auth.signOut(); setUser(null); nav("home"); };
  if(booting) return <div className="login" style={{minHeight:"100vh"}}></div>;
  if(recovery) return <><PasswordRecovery onDone={()=>{setRecovery(false); fireToast("Contraseña actualizada");}}/><Toast msg={toast}/></>;
  if(!user && !portal) return <><Login onLogin={u=>{setUser(u);nav("home");}} onPortal={()=>setPortal(true)}/><Toast msg={toast}/></>;
  if(portal) return <><Portal onExit={()=>setPortal(false)} toast={fireToast}/><Toast msg={toast}/></>;
  const titles={home:["Inicio","Resumen del despacho"],contacts:["Contactos","Base de datos de clientes y leads"],contact:["Ficha de contacto",""],pipeline:["Pipeline","Oportunidades por etapa"],deal:["Ficha de oportunidad",""],whatsapp:["WhatsApp","Conversaciones"],inbox:["Bandeja de entrada",CRM.MAILBOX],documents:["Documentos",""],automations:["Automatizaciones","Reglas del CRM"],config:["Configuración",""]};
  const [title,crumb]=titles[view.name]||["",""];
  let screen;
  if(view.name==="home") screen=<Home user={user} nav={nav}/>;
  else if(view.name==="contacts") screen=<Contacts nav={nav} toast={fireToast}/>;
  else if(view.name==="contact") screen=<ContactDetail id={view.id} nav={nav} toast={fireToast}/>;
  else if(view.name==="pipeline") screen=<Pipeline nav={nav} toast={fireToast}/>;
  else if(view.name==="deal") screen=<DealDetail id={view.id} nav={nav} toast={fireToast} user={user}/>;
  else if(view.name==="whatsapp") screen=<WhatsApp nav={nav} toast={fireToast}/>;
  else if(view.name==="inbox") screen=<Inbox nav={nav} toast={fireToast}/>;
  else if(view.name==="documents") screen=<Documents toast={fireToast}/>;
  else if(view.name==="automations") screen=<Automations toast={fireToast}/>;
  else if(view.name==="config") screen=<Config toast={fireToast}/>;
  const flush = view.name==="pipeline"||view.name==="whatsapp";
  const activeNav = {contact:"contacts", deal:"pipeline"}[view.name] || view.name;
  return <>
    <Shell user={user} view={activeNav} nav={nav} onLogout={logout} title={title} crumb={crumb}>
      {flush ? screen : screen}
    </Shell>
    <Toast msg={toast}/>
  </>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
