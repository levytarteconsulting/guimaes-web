/* GUIMAES CRM — Datos de ejemplo y catálogos (prototipo) */
(function(){
  "use strict";

  var fmtEUR = function(n){ return (n==null?"—":new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(n)); };
  var initials = function(name){ return (name||"?").split(" ").filter(Boolean).slice(0,2).map(function(s){return s[0];}).join("").toUpperCase(); };
  var AV_COLORS = ["#1F6FEB","#16B8A6","#C8A24B","#7C5CFC","#E0518A","#2E8B57","#D9822B","#4B637B"];
  var colorFor = function(str){ var h=0; str=str||""; for(var i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))>>>0; return AV_COLORS[h%AV_COLORS.length]; };

  // ---- Users (5 admins) ----
  var ROLES = [
    {id:"admin", label:"Administrador"},
    {id:"asesor", label:"Asesor"},
    {id:"viewer", label:"Solo lectura"}
  ];
  var roleById={}; ROLES.forEach(function(r){roleById[r.id]=r;});
  var USERS = [
    {id:"u1", name:"Guillermo Guimaes", email:"guillermo@guimaes.es", role:"admin", title:"Socio director", color:"#1F6FEB"},
    {id:"u2", name:"Juan Manuel", email:"juanmanuel@guimaes.es", role:"admin", title:"Socio · Fiscal", color:"#16B8A6"},
    {id:"u3", name:"Macarena", email:"macarena@guimaes.es", role:"admin", title:"Asesora · Laboral", color:"#E0518A"},
    {id:"u4", name:"J. Chávarri", email:"jchavarrisantiago@gmail.com", role:"admin", title:"Asesor · Contable", color:"#C8A24B"},
    {id:"u5", name:"Levy Tarte", email:"levytarteconsulting@gmail.com", role:"admin", title:"Consultor · Estrategia", color:"#7C5CFC"}
  ];

  // ---- Services catalog (6 + user can add) ----
  var SERVICES = [
    {id:"s1", name:"CFO Externo", short:"CFO", color:"#1F6FEB", recurring:true, frequency:"mensual", defaultFee:1800},
    {id:"s2", name:"Planificación Fiscal", short:"Fiscal", color:"#16B8A6", recurring:true, frequency:"anual", defaultFee:3200},
    {id:"s3", name:"Asesoría Contable", short:"Contable", color:"#C8A24B", recurring:true, frequency:"mensual", defaultFee:650},
    {id:"s4", name:"Asesoría Laboral", short:"Laboral", color:"#E0518A", recurring:true, frequency:"mensual", defaultFee:480},
    {id:"s5", name:"Legal y Cumplimiento", short:"Legal", color:"#7C5CFC", recurring:false, frequency:"puntual", defaultFee:2500},
    {id:"s6", name:"Planificación Estratégica", short:"Estrategia", color:"#D9822B", recurring:false, frequency:"puntual", defaultFee:4500},
    {id:"s7", name:"Expansión LatAm", short:"LatAm", color:"#0C7A6E", recurring:false, frequency:"puntual", defaultFee:3800}
  ];

  // ---- Pipeline stages ----
  var STAGES = [
    {id:"nueva_solicitud", label:"Nueva solicitud", phase:"Captación", color:"#6E8298"},
    {id:"contactado", label:"Contactado", phase:"Captación", color:"#1F6FEB"},
    {id:"reunion", label:"Reunión", phase:"Cualificación", color:"#7C5CFC"},
    {id:"propuesta", label:"Propuesta enviada", phase:"Cualificación", color:"#D9822B"},
    {id:"negociacion", label:"Negociación", phase:"Cierre", color:"#C8A24B"},
    {id:"cliente_activo", label:"Cliente activo", phase:"Cierre", color:"#1F9D6B"},
    {id:"perdido", label:"Perdido", phase:"Cierre", color:"#DC3A47"}
  ];
  var stageById = {}; STAGES.forEach(function(s){stageById[s.id]=s;});

  var LIFECYCLE = [
    {id:"new", label:"Nuevo", color:"#6E8298"},
    {id:"opportunity", label:"Oportunidad", color:"#1F6FEB"},
    {id:"proposal", label:"Propuesta", color:"#D9822B"},
    {id:"active_client", label:"Cliente activo", color:"#1F9D6B"},
    {id:"lost", label:"Perdido", color:"#DC3A47"}
  ];
  var lifecycleById={}; LIFECYCLE.forEach(function(l){lifecycleById[l.id]=l;});

  var LOSS_REASONS = [
    {id:"no_contesta", label:"No contesta"},
    {id:"precio_alto", label:"Precio demasiado alto"},
    {id:"contratado_otro", label:"Contrató con otro despacho"},
    {id:"no_interesado", label:"No interesado"},
    {id:"fuera_perfil", label:"Fuera de perfil"},
    {id:"gestiona_interno", label:"Lo gestiona internamente"}
  ];

  var PRIORITIES = [
    {id:"high", label:"Alta", color:"#DC3A47"},
    {id:"medium", label:"Media", color:"#D9822B"},
    {id:"low", label:"Baja", color:"#6E8298"}
  ];

  // ---- Contacts (datos reales desde Supabase, ver loadContactos/loadWebLeads) ----
  var CONTACTS = [];
  var contactById={}; CONTACTS.forEach(function(c){contactById[c.id]=c;});

  // ---- Deals (datos reales desde Supabase, ver loadDeals) ----
  var DEALS = [];

  // ---- Tasks ----
  var TASKS = [];

  // ---- Notes ----
  var NOTES = [];

  // ---- Calls ----
  var CALLS = [];

  // ---- WhatsApp ----
  var WHATSAPP = [];

  // ---- Documents ----
  var DOCUMENTS = [];

  // ---- Automations ----
  var AUTOMATIONS = [
    {id:"a1", name:"Lead de la web → tarea de contacto", trigger:"Contacto creado (formulario web)", action:"Crear tarea 'Llamar en 24h' + asignar por servicio", enabled:true, runs:142},
    {id:"a2", name:"Propuesta enviada → seguimiento 3 días", trigger:"Deal pasa a 'Propuesta enviada'", action:"Crear tarea de seguimiento a los 3 días", enabled:true, runs:64},
    {id:"a3", name:"Cliente activo → email de bienvenida", trigger:"Deal pasa a 'Cliente activo'", action:"Enviar plantilla 'Bienvenida y onboarding'", enabled:true, runs:38},
    {id:"a4", name:"Renovación en 60 días", trigger:"renewal_date a 60 días", action:"Crear tarea de renovación al owner + aviso", enabled:true, runs:21},
    {id:"a5", name:"Sin actividad 30 días", trigger:"Deal sin actividad 30 días", action:"Notificar al owner para reactivar", enabled:false, runs:9},
    {id:"a6", name:"Deal perdido → encuesta", trigger:"Deal pasa a 'Perdido'", action:"Registrar motivo y enviar encuesta breve", enabled:false, runs:0}
  ];

  // ---- Activity log (per contact) ----
  var ACTIVITY = [];

  // ---- WhatsApp templates (Meta Business Manager) ----
  var WA_TEMPLATES = [
    {id:"tpl1", name:"bienvenida_cliente", category:"Utilidad", lang:"es_ES", body:"¡Hola {{1}}! Bienvenido/a a GUIMAES. Tu asesor {{2}} se pondrá en contacto contigo en breve."},
    {id:"tpl2", name:"recordatorio_reunion", category:"Recordatorio", lang:"es_ES", body:"Hola {{1}}, te recordamos tu reunión con GUIMAES el {{2}} a las {{3}}h."},
    {id:"tpl3", name:"documento_disponible", category:"Utilidad", lang:"es_ES", body:"Hola {{1}}, ya tienes disponible un nuevo documento en tu área de cliente."}
  ];

  // ---- Mutations (prototipo: en memoria) ----
  function setArchived(id, val){
    var w = WHATSAPP.find(function(x){return x.id===id;});
    if(w) w.archived = val;
    return w;
  }
  // ---- Mutations (prototipo: en memoria) ----
  var AV_PALETTE = AV_COLORS;
  function addUser(u){
    var id = "u"+Date.now().toString(36);
    var full = Object.assign({id:id, role:"admin", color:AV_PALETTE[USERS.length%AV_PALETTE.length]}, u);
    USERS.push(full);
    return full;
  }
  function updateUser(id, patch){
    var u = USERS.find(function(x){return x.id===id;}); if(!u) return null;
    Object.assign(u, patch);
    return u;
  }
  function removeUser(id){
    var idx = USERS.findIndex(function(u){return u.id===id;});
    if(idx>-1) USERS.splice(idx,1);
  }
  var CONTACTOS_COLUMNS = ["company","full_name","email","phone","dni","city","province","employees","lifecycle","priority","owner","source","kyc","registered"];
  async function updateContact(client, id, patch){
    var c = contactById[id]; if(!c) return null;
    // Los leads aún no convertidos usan un id sintético "lead-<uuid>" que no
    // existe como fila en public.contactos: solo se persiste en memoria.
    if(client && id.indexOf("lead-")!==0){
      var payload = {};
      CONTACTOS_COLUMNS.forEach(function(k){ if(patch[k]!==undefined) payload[k] = patch[k]; });
      // id (clave de .eq()) y created_at (gestionado por la BD) nunca deben ir en el UPDATE.
      delete payload.id;
      delete payload.created_at;
      if(payload.employees!==undefined){
        var emp = payload.employees;
        if(typeof emp==="string") emp = emp.trim()===""? NaN : parseInt(emp,10);
        payload.employees = (typeof emp!=="number" || isNaN(emp)) ? null : emp;
      }
      if(payload.kyc!==undefined) payload.kyc = !!payload.kyc;
      if(payload.registered!==undefined) payload.registered = !!payload.registered;
      // Los campos de texto en blanco ("") se envían tal cual, no se convierten a null.
      var res = await client.from("contactos").update(payload).eq("id", id).select();
      if(res.error) throw res.error;
      if(!res.data || res.data.length===0) throw new Error("El update no afectó a ninguna fila (id: "+id+")");
    }
    Object.assign(c, patch);
    return c;
  }
  // Los ids de la maqueta (p.ej. "d1", "c1") son cortos y sin guiones; los
  // uuid reales que devuelve Supabase tienen 36 caracteres con guiones.
  function isUuidLike(id){
    return typeof id==="string" && id.length===36 && id.indexOf("-")!==-1;
  }
  async function removeDeal(client, dealId){
    // Los deals de la maqueta no existen como fila en public.deals: solo se borran en memoria.
    if(client && isUuidLike(dealId)){
      var res = await client.from("deals").delete().eq("id", dealId);
      if(res.error) throw res.error;
    }
    var idx = DEALS.findIndex(function(d){return d.id===dealId;});
    if(idx>-1) DEALS.splice(idx,1);
    for(var i=NOTES.length-1;i>=0;i--) if(NOTES[i].deal===dealId) NOTES.splice(i,1);
    for(var j=TASKS.length-1;j>=0;j--) if(TASKS[j].deal===dealId) TASKS.splice(j,1);
    for(var k=DOCUMENTS.length-1;k>=0;k--) if(DOCUMENTS[k].deal===dealId) DOCUMENTS.splice(k,1);
  }
  async function removeContact(client, id){
    // Los leads aún no convertidos usan un id sintético "lead-<uuid>" que no
    // existe como fila en public.contactos: solo se borra en memoria.
    var contact = contactById[id];
    if(client && id.indexOf("lead-")!==0){
      var delDeals = await client.from("deals").delete().eq("contact_id", id);
      if(delDeals.error) throw delDeals.error;
      var res = await client.from("contactos").delete().eq("id", id);
      if(res.error) throw res.error;
      // Si el contacto venía de un lead, márcalo como 'deleted' para que
      // loadWebLeads (que solo procesa status='new') no lo vuelva a convertir.
      if(contact && contact.lead_id){
        try{
          var leadRes = await client.from("leads").update({status:"deleted"}).eq("id", contact.lead_id);
          if(leadRes.error) throw leadRes.error;
        }catch(e){ if(window.console) console.error("removeContact: no se pudo marcar el lead como 'deleted'", e); }
      }
    }
    var idx = CONTACTS.findIndex(function(c){return c.id===id;});
    if(idx>-1) CONTACTS.splice(idx,1);
    delete contactById[id];
    // Los deals asociados ya se borraron en Supabase arriba; aquí solo limpiamos
    // memoria, sin repetir la llamada remota (client=null).
    for(var i=DEALS.length-1;i>=0;i--) if(DEALS[i].contact===id) await removeDeal(null, DEALS[i].id);
    for(var j=NOTES.length-1;j>=0;j--) if(NOTES[j].contact===id) NOTES.splice(j,1);
    for(var k=TASKS.length-1;k>=0;k--) if(TASKS[k].contact===id) TASKS.splice(k,1);
    for(var l=DOCUMENTS.length-1;l>=0;l--) if(DOCUMENTS[l].contact===id) DOCUMENTS.splice(l,1);
    for(var m=WHATSAPP.length-1;m>=0;m--) if(WHATSAPP[m].contact===id) WHATSAPP.splice(m,1);
    for(var n=ACTIVITY.length-1;n>=0;n--) if(ACTIVITY[n].contact===id) ACTIVITY.splice(n,1);
  }
  async function removeContacts(client, ids){
    var n = 0;
    for(var id of ids){
      try{
        await removeContact(client, id);
        n++;
      }catch(e){ if(window.console) console.error("removeContacts: fallo al borrar "+id, e); }
    }
    return n;
  }

  var DEALS_COLUMNS = ["title","contact_id","service","stage","owner","amount","frequency","priority","loss_reason","signed_at","renewal_at","num_nominas","coste_nomina"];
  async function updateDeal(client, id, patch){
    var d = DEALS.find(function(x){return x.id===id;}); if(!d) return null;
    // Los deals de la maqueta no existen como fila en public.deals: solo se persiste en memoria.
    if(client && isUuidLike(id)){
      var payload = {};
      DEALS_COLUMNS.forEach(function(k){ if(patch[k]!==undefined) payload[k] = patch[k]; });
      delete payload.id;
      delete payload.created_at;
      if(payload.amount!==undefined){
        payload.amount = (payload.amount===null || payload.amount==="") ? null : parseFloat(payload.amount);
        if(isNaN(payload.amount)) payload.amount = null;
      }
      if(payload.num_nominas!==undefined){
        payload.num_nominas = (payload.num_nominas===null || payload.num_nominas==="") ? null : parseInt(payload.num_nominas,10);
        if(isNaN(payload.num_nominas)) payload.num_nominas = null;
      }
      if(payload.coste_nomina!==undefined){
        payload.coste_nomina = (payload.coste_nomina===null || payload.coste_nomina==="") ? null : parseFloat(payload.coste_nomina);
        if(isNaN(payload.coste_nomina)) payload.coste_nomina = null;
      }
      var res = await client.from("deals").update(payload).eq("id", id).select();
      if(res.error) throw res.error;
      if(!res.data || res.data.length===0) throw new Error("El update no afectó a ninguna fila (id: "+id+")");
    }
    Object.assign(d, patch);
    return d;
  }
  function addDocument(doc){
    var id = "doc"+Date.now().toString(36);
    var full = Object.assign({id:id, size:"\u2014", visible:false}, doc);
    DOCUMENTS.push(full);
    return full;
  }
  function removeDocument(id){
    var idx = DOCUMENTS.findIndex(function(d){return d.id===id;});
    if(idx>-1) DOCUMENTS.splice(idx,1);
  }

  // ---- Bandeja de entrada (Gmail — info@guimaes.es) ----
  var MAILBOX = "info@guimaes.es";
  var FOLDERS = [
    {id:"inbox", label:"Bandeja de entrada", color:"#1F6FEB", system:true},
    {id:"fiscal", label:"Fiscal", color:"#16B8A6"},
    {id:"legal", label:"Legal", color:"#7C5CFC"},
    {id:"facturas", label:"Facturas", color:"#D9822B"}
  ];
  var folderById={}; FOLDERS.forEach(function(f){folderById[f.id]=f;});

  var EMAILS = [];

  function unreadOf(e){ return e.messages.length && e.messages[e.messages.length-1].dir==="in" ? 1 : 0; }

  function addFolder(label){
    var id = "f"+Date.now().toString(36);
    var colors=["#1F6FEB","#16B8A6","#C8A24B","#7C5CFC","#E0518A","#D9822B","#2E8B57"];
    var f = {id:id, label:label, color:colors[FOLDERS.length%colors.length]};
    FOLDERS.push(f);
    return f;
  }
  function removeFolder(id){
    var f = folderById[id]; if(!f || f.system) return;
    var idx = FOLDERS.findIndex(function(x){return x.id===id;});
    if(idx>-1) FOLDERS.splice(idx,1);
    delete folderById[id];
    EMAILS.forEach(function(e){ if(e.folder===id) e.folder="inbox"; });
  }
  function moveEmailToFolder(id, folder){
    var e = EMAILS.find(function(x){return x.id===id;}); if(e) e.folder=folder;
  }
  function setEmailArchived(id, val){
    var e = EMAILS.find(function(x){return x.id===id;}); if(e) e.archived=val;
  }
  function linkEmail(id, patch){
    var e = EMAILS.find(function(x){return x.id===id;}); if(e) Object.assign(e, patch);
  }
  function addEmailReply(id, body){
    var e = EMAILS.find(function(x){return x.id===id;}); if(!e) return;
    e.messages.push({dir:"out", from:MAILBOX, to:e.messages[e.messages.length-1]?.from || "", date:"Ahora", body:body});
    e.updated = "Ahora";
  }
  function addEmailThread(thread){
    var id = "e"+Date.now().toString(36);
    var full = Object.assign({id:id, folder:"inbox", archived:false, contact:null, deal:null, updated:"Ahora"}, thread);
    EMAILS.unshift(full);
    return full;
  }

  // ---- Contactos reales (tabla "contactos" de Supabase) ----
  function rowToContact(row){
    return {
      id: row.id,
      company: row.company || "",
      full_name: row.full_name || "",
      email: row.email || "",
      phone: row.phone || "",
      dni: row.dni || "",
      city: row.city || "",
      province: row.province || "",
      employees: row.employees,
      lifecycle: row.lifecycle || "lead",
      priority: row.priority || "medium",
      owner: row.owner || "",
      source: row.source || "",
      kyc: !!row.kyc,
      registered: !!row.registered,
      lead_id: row.lead_id || null,
      created: (row.created_at||"").toString().slice(0,10)
    };
  }
  // Carga los contactos reales de Supabase y los inyecta en CONTACTS (una sola vez, al arrancar)
  async function loadContactos(client){
    if(!client) return 0;
    try{
      var res = await client.from("contactos").select("*").order("created_at",{ascending:false});
      if(res.error || !res.data) return 0;
      var n = 0;
      res.data.forEach(function(row){
        var c = rowToContact(row);
        if(contactById[c.id]) return; // evitar duplicados
        CONTACTS.unshift(c);
        contactById[c.id] = c;
        n++;
      });
      return n;
    }catch(e){ if(window.console) console.error("loadContactos:", e); return 0; }
  }
  // Crea un contacto real en Supabase y lo inyecta en CONTACTS
  async function addContact(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var fields = ["company","full_name","email","phone","dni","city","province","employees","lifecycle","priority","owner","source"];
    var payload = {};
    fields.forEach(function(k){ if(data[k]!==undefined && data[k]!=="") payload[k] = data[k]; });
    if(!payload.lifecycle) payload.lifecycle = "lead";
    if(!payload.source) payload.source = "Alta manual";
    var res = await client.from("contactos").insert(payload).select();
    if(res.error) throw res.error;
    var c = rowToContact(res.data[0]);
    CONTACTS.unshift(c);
    contactById[c.id] = c;
    return c;
  }

  // ---- Deals reales (tabla "deals" de Supabase) ----
  function rowToDeal(row){
    return {
      id: row.id,
      title: row.title || "",
      contact: row.contact_id,
      service: row.service || "",
      stage: row.stage || "reunion",
      owner: row.owner || "",
      amount: row.amount,
      frequency: row.frequency || "",
      priority: row.priority || "medium",
      loss_reason: row.loss_reason || null,
      signed: row.signed_at,
      renewal: row.renewal_at,
      num_nominas: row.num_nominas===undefined ? null : row.num_nominas,
      coste_nomina: row.coste_nomina===undefined ? null : row.coste_nomina,
      created: (row.created_at||"").toString().slice(0,10)
    };
  }
  // Carga los deals reales de Supabase y los inyecta en DEALS (una sola vez, al arrancar)
  async function loadDeals(client){
    if(!client) return 0;
    try{
      var res = await client.from("deals").select("*").order("created_at",{ascending:false});
      if(res.error || !res.data) return 0;
      var n = 0;
      res.data.forEach(function(row){
        var d = rowToDeal(row);
        if(DEALS.some(function(x){return x.id===d.id;})) return; // evitar duplicados
        DEALS.unshift(d);
        n++;
      });
      return n;
    }catch(e){ if(window.console) console.error("loadDeals:", e); return 0; }
  }
  // Crea un deal real en Supabase y lo inyecta en DEALS
  async function addDeal(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    if(!data.contact_id) throw new Error("Un deal necesita un contacto asociado");
    var fields = ["title","contact_id","service","stage","owner","amount","frequency","priority","num_nominas","coste_nomina"];
    var payload = {};
    fields.forEach(function(k){ if(data[k]!==undefined && data[k]!=="") payload[k] = data[k]; });
    if(!payload.stage) payload.stage = "reunion";
    payload.amount = (data.amount===undefined || data.amount===null || data.amount==="") ? null : parseFloat(data.amount);
    if(isNaN(payload.amount)) payload.amount = null;
    payload.num_nominas = (data.num_nominas===undefined || data.num_nominas===null || data.num_nominas==="") ? null : parseInt(data.num_nominas,10);
    if(isNaN(payload.num_nominas)) payload.num_nominas = null;
    payload.coste_nomina = (data.coste_nomina===undefined || data.coste_nomina===null || data.coste_nomina==="") ? null : parseFloat(data.coste_nomina);
    if(isNaN(payload.coste_nomina)) payload.coste_nomina = null;
    var res = await client.from("deals").insert(payload).select();
    if(res.error) throw res.error;
    if(!res.data || res.data.length===0) throw new Error("No se creó el deal");
    var d = rowToDeal(res.data[0]);
    DEALS.unshift(d);
    return d;
  }

  // ---- Tareas reales (tabla "tareas" de Supabase) ----
  function rowToTask(row){
    return {
      id: row.id,
      title: row.title || "",
      due: row.due_at || null,
      owner: row.assigned_to || "",
      status: row.status || "pending",
      archived: !!row.archived,
      contact: row.contact_id || null,
      deal: row.deal_id || null,
      created: (row.created_at||"").toString().slice(0,10)
    };
  }
  // Carga las tareas reales de Supabase y las inyecta en TASKS (una sola vez, al arrancar)
  async function loadTasks(client){
    if(!client) return 0;
    try{
      var res = await client.from("tareas").select("*").order("due_at",{ascending:true});
      if(res.error || !res.data) return 0;
      var n = 0;
      res.data.forEach(function(row){
        var t = rowToTask(row);
        if(TASKS.some(function(x){return x.id===t.id;})) return; // evitar duplicados
        TASKS.push(t);
        n++;
      });
      return n;
    }catch(e){ if(window.console) console.error("loadTasks:", e); return 0; }
  }
  // Crea una tarea real en Supabase y la inyecta en TASKS
  async function addTask(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    if(!data.title) throw new Error("La tarea necesita un título");
    var fields = ["title","assigned_to","due_at","contact_id","deal_id","status","archived"];
    var payload = {};
    fields.forEach(function(k){ if(data[k]!==undefined && data[k]!=="") payload[k] = data[k]; });
    if(!payload.status) payload.status = "pending";
    if(payload.archived===undefined) payload.archived = false;
    var res = await client.from("tareas").insert(payload).select();
    if(res.error) throw res.error;
    if(!res.data || res.data.length===0) throw new Error("No se creó la tarea");
    var t = rowToTask(res.data[0]);
    TASKS.unshift(t);
    return t;
  }
  var TAREAS_COLUMNS = ["title","assigned_to","due_at","contact_id","deal_id","status","archived"];
  async function updateTask(client, id, patch){
    var t = TASKS.find(function(x){return x.id===id;}); if(!t) return null;
    if(client){
      var payload = {};
      TAREAS_COLUMNS.forEach(function(k){ if(patch[k]!==undefined) payload[k] = patch[k]; });
      delete payload.id;
      delete payload.created_at;
      var res = await client.from("tareas").update(payload).eq("id", id).select();
      if(res.error) throw res.error;
      if(!res.data || res.data.length===0) throw new Error("El update no afectó a ninguna fila (id: "+id+")");
    }
    Object.assign(t, patch);
    return t;
  }
  async function removeTask(client, id){
    if(client){
      var res = await client.from("tareas").delete().eq("id", id);
      if(res.error) throw res.error;
    }
    var idx = TASKS.findIndex(function(x){return x.id===id;});
    if(idx>-1) TASKS.splice(idx,1);
  }
  // Completar una tarea = marcarla hecha y archivarla de una vez
  async function toggleTaskDone(client, id){
    return updateTask(client, id, {status:"done", archived:true});
  }

  // ---- Leads reales de la web (tabla "leads" de Supabase) ----
  function leadToContact(row){
    var created = (row.created_at||"").toString();
    return {
      id: "lead-"+row.id,
      company: row.empresa || row.nombre || "Solicitud web",
      full_name: row.nombre || "\u2014",
      email: row.email || "",
      phone: row.telefono || "",
      dni: "", city:"", province:"",
      lifecycle: (row.status==="lost"?"lost":row.status==="active_client"?"active_client":"new"),
      owner: "u1",
      source: row.source || "Formulario web",
      priority: "medium",
      service_interest: row.servicio || "",
      utm: "",
      kyc:false, registered:false,
      created: created.slice(0,10),
      employees: null,
      _lead:true, _mensaje: row.mensaje||""
    };
  }
  // Intenta hacer corresponder el texto libre "servicio" del lead con un id del catálogo SERVICES.
  // Si no hay coincidencia exacta, devuelve el propio texto (mejor que perderlo).
  function matchServiceId(label){
    if(!label) return "";
    var found = SERVICES.find(function(s){ return s.name.toLowerCase()===String(label).trim().toLowerCase(); });
    return found ? found.id : label;
  }
  // Carga los leads de Supabase. Cada lead con status 'new' se convierte
  // automáticamente en contacto real + deal (reutiliza convertLeadToContact
  // y addDeal). Los que ya están 'converted' se ignoran — es el blindaje
  // anti-duplicados: si status no es 'new', el lead ni se toca.
  async function loadWebLeads(client){
    if(!client) return 0;
    try{
      var res = await client.from("leads").select("*").order("created_at",{ascending:false});
      if(res.error || !res.data) return 0;
      var n = 0;
      for(var i=0;i<res.data.length;i++){
        var row = res.data[i];
        if(row.status!=="new") continue; // solo leads sin convertir
        try{
          // 1) objeto temporal en memoria (igual que antes) para que convertLeadToContact lo encuentre
          var c = leadToContact(row);
          CONTACTS.unshift(c);
          contactById[c.id] = c;
          var at = (row.created_at||"").toString().replace("T"," ").slice(0,16);
          if(c._mensaje){
            NOTES.push({id:"n-"+row.id, contact:c.id, deal:null, author:null, created:at, body:c._mensaje});
          }
          ACTIVITY.unshift({contact:c.id, type:"contact", at:at, who:null, text:"Contacto creado desde el formulario web"});

          // 2) convierte a contacto real en public.contactos y marca el lead como 'converted'
          //    (convertLeadToContact ya relinca NOTES/ACTIVITY al nuevo id real)
          var newContact = await convertLeadToContact(client, c.id);

          // 3) crea el deal asociado, con el servicio pedido como título
          await addDeal(client, {
            title: row.servicio || "Solicitud web",
            contact_id: newContact.id,
            service: matchServiceId(row.servicio),
            stage: "nueva_solicitud"
          });
          n++;
        }catch(e){ if(window.console) console.error("loadWebLeads: fallo al convertir lead "+row.id, e); }
      }
      return n;
    }catch(e){ if(window.console) console.error("loadWebLeads:", e); return 0; }
  }
  // Convierte un lead (id sintético "lead-<uuid>") en un contacto real de public.contactos
  async function convertLeadToContact(client, leadId){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var leadUuid = leadId.indexOf("lead-")===0 ? leadId.slice(5) : leadId;
    var lead = contactById[leadId];
    if(!lead) throw new Error("No se encontró el lead a convertir");

    // Se marca el lead como convertido ANTES de crear el contacto: así, si el
    // insert de abajo fallara, nunca queda un contacto huérfano con su lead
    // todavía en 'new' (que es lo que provoca duplicados en cada recarga).
    var statusRes = await client.from("leads").update({status:"converted"}).eq("id", leadUuid).select();
    if(statusRes.error) throw statusRes.error;
    if(!statusRes.data || statusRes.data.length===0) throw new Error("No se pudo marcar el lead como convertido (id: "+leadUuid+")");

    var payload = {
      company: lead.company || "",
      full_name: lead.full_name || "",
      email: lead.email || "",
      phone: lead.phone || "",
      source: "Formulario web",
      lifecycle: "lead",
      lead_id: leadUuid
    };
    var res = await client.from("contactos").insert(payload).select();
    if(res.error) throw res.error;

    var idx = CONTACTS.findIndex(function(c){return c.id===leadId;});
    if(idx>-1) CONTACTS.splice(idx,1);
    delete contactById[leadId];

    var c = rowToContact(res.data[0]);
    CONTACTS.unshift(c);
    contactById[c.id] = c;

    // Relinkar notas/actividad del lead antiguo al nuevo id real, para no perder el historial.
    NOTES.forEach(function(n){ if(n.contact===leadId) n.contact=c.id; });
    ACTIVITY.forEach(function(a){ if(a.contact===leadId) a.contact=c.id; });

    return c;
  }

  // ---- KPIs (dashboard) ----
  function computeKpis(deals){
    var active = deals.filter(function(d){return d.stage==="cliente_activo";});
    var mrr = active.filter(function(d){return d.frequency==="mensual";}).reduce(function(a,d){return a+d.amount;},0);
    var annual = active.filter(function(d){return d.frequency==="anual";}).reduce(function(a,d){return a+d.amount;},0);
    var arr = mrr*12 + annual;
    var open = deals.filter(function(d){return d.stage!=="cliente_activo"&&d.stage!=="perdido";});
    var pipeline = open.reduce(function(a,d){return a+(d.frequency==="mensual"?d.amount*12:d.amount);},0);
    return {mrr:mrr, arr:arr, openDeals:open.length, pipeline:pipeline, activeClients:active.length};
  }

  window.CRM = {
    USERS:USERS, userById:function(id){return USERS.filter(function(u){return u.id===id;})[0];},
    ROLES:ROLES, roleById:roleById,
    addUser:addUser, updateUser:updateUser, removeUser:removeUser,
    SERVICES:SERVICES, serviceById:function(id){var m={};SERVICES.forEach(function(s){m[s.id]=s;});return m[id];},
    STAGES:STAGES, stageById:stageById,
    LIFECYCLE:LIFECYCLE, lifecycleById:lifecycleById,
    LOSS_REASONS:LOSS_REASONS, PRIORITIES:PRIORITIES,
    priorityById:function(id){var m={};PRIORITIES.forEach(function(p){m[p.id]=p;});return m[id];},
    CONTACTS:CONTACTS, contactById:contactById,
    DEALS:DEALS, TASKS:TASKS, NOTES:NOTES, CALLS:CALLS,
    WHATSAPP:WHATSAPP, DOCUMENTS:DOCUMENTS, AUTOMATIONS:AUTOMATIONS, ACTIVITY:ACTIVITY,
    fmtEUR:fmtEUR, initials:initials, colorFor:colorFor, computeKpis:computeKpis, loadWebLeads:loadWebLeads, loadContactos:loadContactos, addContact:addContact, loadDeals:loadDeals, addDeal:addDeal, convertLeadToContact:convertLeadToContact,
    loadTasks:loadTasks, addTask:addTask, updateTask:updateTask, removeTask:removeTask, toggleTaskDone:toggleTaskDone,
    updateContact:updateContact, removeDeal:removeDeal, removeContact:removeContact, removeContacts:removeContacts,
    updateDeal:updateDeal, addDocument:addDocument, removeDocument:removeDocument, WA_TEMPLATES:WA_TEMPLATES, setArchived:setArchived,
    MAILBOX:MAILBOX, FOLDERS:FOLDERS, folderById:folderById, EMAILS:EMAILS, unreadOf:unreadOf,
    addFolder:addFolder, removeFolder:removeFolder, moveEmailToFolder:moveEmailToFolder,
    setEmailArchived:setEmailArchived, linkEmail:linkEmail, addEmailReply:addEmailReply, addEmailThread:addEmailThread
  };
})();
