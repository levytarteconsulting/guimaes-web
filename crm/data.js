/* GUIMAES CRM — Datos de ejemplo y catálogos (prototipo) */
(function(){
  "use strict";

  var fmtEUR = function(n){ return (n==null?"—":new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(n)); };
  var fmtBytes = function(n){
    if(n==null) return "";
    if(n<1024) return n+" B";
    if(n<1024*1024) return (n/1024).toFixed(0)+" KB";
    return (n/1024/1024).toFixed(1)+" MB";
  };
  var initials = function(name){ return (name||"?").split(" ").filter(Boolean).slice(0,2).map(function(s){return s[0];}).join("").toUpperCase(); };
  var AV_COLORS = ["#1F6FEB","#16B8A6","#C8A24B","#7C5CFC","#E0518A","#2E8B57","#D9822B","#4B637B"];
  var colorFor = function(str){ var h=0; str=str||""; for(var i=0;i<str.length;i++)h=(h*31+str.charCodeAt(i))>>>0; return AV_COLORS[h%AV_COLORS.length]; };

  // ---- Zona horaria fija de Madrid para tareas (due_at) ----
  // El CRM es de uso exclusivo del despacho en España: en vez de que la
  // hora de una tarea dependa de en qué zona esté configurado el navegador
  // de quien la crea o la mira (portátil mal configurado, alguien de
  // viaje...), se fija siempre a Europe/Madrid en los dos sentidos — al
  // guardar (aquí) y al mostrar (fmtDue en app.jsx). Antes, el string crudo
  // del <input type="datetime-local"> (sin zona) se mandaba tal cual a una
  // columna timestamptz, y Postgres lo guardaba como si esos dígitos ya
  // fueran UTC — 18:00 escritas en Madrid se guardaban como 18:00 UTC
  // (20:00 reales), un desfase de 1-2h según la época del año.
  var MADRID_TZ = "Europe/Madrid";
  function pad2(n){ return String(n).padStart(2,"0"); }
  // Desfase en minutos de Europe/Madrid respecto a UTC para el instante
  // dado (+60 en invierno CET, +120 en verano CEST) — se calcula con Intl
  // en vez de codificar a mano las fechas de cambio de hora, para que el
  // horario de verano se resuelva solo, siempre.
  function madridOffsetMinutesAt(utcMs){
    var dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: MADRID_TZ, hourCycle: "h23",
      year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit"
    });
    var parts = {};
    dtf.formatToParts(new Date(utcMs)).forEach(function(p){ if(p.type!=="literal") parts[p.type]=p.value; });
    var asIfUTC = Date.UTC(+parts.year, +parts.month-1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return (asIfUTC - utcMs) / 60000;
  }
  // "YYYY-MM-DDTHH:mm" (de un <input type="datetime-local">, sin zona) →
  // ISO con el offset real de Madrid para esa fecha (+01:00 o +02:00 según
  // DST). Si el valor ya trae zona (Z o ±HH:MM) se deja tal cual, para no
  // convertir dos veces si alguna vez llega ya en ISO.
  function madridDatetimeLocalToISO(value){
    if(!value) return value;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if(!m) return value;
    var y=+m[1], mo=+m[2], d=+m[3], h=+m[4], mi=+m[5], s=+(m[6]||0);
    // Aproximación: tratar los dígitos tal cual como si ya fueran UTC, solo
    // para saber en qué lado del cambio de hora cae esta fecha — el margen
    // de error de esa aproximación es como mucho el propio offset (1-2h),
    // así que solo fallaría en el minuto exacto del cambio de hora.
    var approxUTC = Date.UTC(y, mo-1, d, h, mi, s);
    var offsetMin = madridOffsetMinutesAt(approxUTC);
    var sign = offsetMin>=0 ? "+" : "-";
    var abs = Math.abs(offsetMin);
    return y+"-"+pad2(mo)+"-"+pad2(d)+"T"+pad2(h)+":"+pad2(mi)+":"+pad2(s)+sign+pad2(Math.floor(abs/60))+":"+pad2(abs%60);
  }
  // Inverso: un due_at ya guardado (ISO/timestamptz) → "YYYY-MM-DDTHH:mm"
  // con los dígitos de reloj de Madrid, para precargar el <input
  // datetime-local> al editar una tarea — independiente del navegador de
  // quien la edita (si no, reabrir y guardar sin tocar la fecha podía
  // desplazarla otra vez, con el navegador equivocado).
  function isoToMadridDatetimeLocal(iso){
    if(!iso) return "";
    var d = new Date(iso);
    if(isNaN(d.getTime())) return "";
    var dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: MADRID_TZ, hourCycle: "h23",
      year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit"
    });
    var parts = {};
    dtf.formatToParts(d).forEach(function(p){ if(p.type!=="literal") parts[p.type]=p.value; });
    return parts.year+"-"+parts.month+"-"+parts.day+"T"+parts.hour+":"+parts.minute;
  }

  // ---- Users / Admins (public.admins — ver crm/supabase-admins.sql) ----
  // Rol de administración del propio CRM: 'admin' puede gestionar
  // administradores, 'miembro' tiene acceso normal pero no. No confundir
  // con el "owner" libre de deals/contactos/tareas.
  var ROLES = [
    {id:"admin", label:"Administrador"},
    {id:"miembro", label:"Miembro"}
  ];
  var roleById={}; ROLES.forEach(function(r){roleById[r.id]=r;});
  // Se rellena en caliente con loadAdmins() tras el login — ver
  // crm/app.jsx (arranque de App y onAuthStateChange). Vacío hasta entonces.
  var USERS = [];

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

  // ---- Empresas (datos reales desde Supabase, ver loadEmpresas) ----
  var EMPRESAS = [];
  var empresaById = {};
  // ---- Relación contacto↔empresa (datos reales, ver loadContactoEmpresa) ----
  var CONTACTO_EMPRESA = [];

  // ---- Deals (datos reales desde Supabase, ver loadDeals) ----
  var DEALS = [];

  // ---- Tasks ----
  var TASKS = [];

  // ---- Notes ----
  var NOTES = [];

  // ---- Calls ----
  var CALLS = [];

  // ---- WhatsApp (datos reales desde Supabase, ver loadWhatsapp) ----
  var WHATSAPP = [];

  function fmtWaTime(iso){
    if(!iso) return "";
    var d = new Date(iso);
    if(isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("es-ES", {hour:"2-digit", minute:"2-digit"});
  }
  function rowToWhatsappMessage(row){
    return {
      id: row.id,
      dir: row.direction==="out" ? "out" : "in",
      t: fmtWaTime(row.created_at),
      body: row.body || "",
      type: row.type || "text",
      meta: row.meta || null,
      wa_message_id: row.wa_message_id || null,
      status: row.delivery_status || null
    };
  }
  function rowToWhatsappConversation(row){
    return {
      id: row.id,
      contact: row.contact_id || null,
      phone: row.phone || "",
      wa_id: row.wa_id || "",
      owner: row.owner || "",
      archived: !!row.archived,
      unread: 0, // no persistido en el esquema; solo sube en sesión vía Realtime (ver subscribeWhatsapp)
      last_customer_message_at: row.last_customer_message_at || null, // crudo, para calcular la ventana de 24h en la UI
      updated: fmtWaTime(row.last_customer_message_at || row.updated_at || row.created_at),
      messages: []
    };
  }
  // Carga las conversaciones + mensajes reales de Supabase y los inyecta en WHATSAPP (una sola vez, al arrancar)
  async function loadWhatsapp(client){
    if(!client) return 0;
    try{
      var convRes = await client.from("whatsapp_conversations").select("*").order("last_customer_message_at",{ascending:false, nullsFirst:false});
      if(convRes.error || !convRes.data || convRes.data.length===0) return 0;
      var convRows = convRes.data;

      var ids = convRows.map(function(r){return r.id;});
      var msgRes = await client.from("whatsapp_messages").select("*").in("conversation_id", ids).order("created_at",{ascending:true});
      var msgRows = (msgRes.error || !msgRes.data) ? [] : msgRes.data;

      var messagesByConv = {};
      msgRows.forEach(function(m){
        (messagesByConv[m.conversation_id] = messagesByConv[m.conversation_id] || []).push(rowToWhatsappMessage(m));
      });

      var n = 0;
      convRows.forEach(function(row){
        if(WHATSAPP.some(function(x){return x.id===row.id;})) return; // evitar duplicados
        var conv = rowToWhatsappConversation(row);
        conv.messages = messagesByConv[row.id] || [];
        WHATSAPP.push(conv);
        n++;
      });
      return n;
    }catch(e){ if(window.console) console.error("loadWhatsapp:", e); return 0; }
  }
  // Carga UNA conversación (+ sus mensajes) por id y la añade a WHATSAPP si no
  // estaba ya — para cuando se acaba de crear (iniciar conversación) o se
  // navega directo a ella y todavía no se ha cargado en esta sesión.
  async function loadWhatsappConversationById(client, id){
    if(!client || !id) return null;
    try{
      var convRes = await client.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
      if(convRes.error || !convRes.data) return null;
      var msgRes = await client.from("whatsapp_messages").select("*").eq("conversation_id", id).order("created_at",{ascending:true});
      var msgRows = (msgRes.error || !msgRes.data) ? [] : msgRes.data;
      var conv = rowToWhatsappConversation(convRes.data);
      conv.messages = msgRows.map(rowToWhatsappMessage);
      if(!WHATSAPP.some(function(x){return x.id===conv.id;})) WHATSAPP.unshift(conv);
      return conv;
    }catch(e){ if(window.console) console.error("loadWhatsappConversationById:", e); return null; }
  }
  // Suscripción Realtime a whatsapp_messages (requiere que la tabla esté
  // añadida a la publicación "supabase_realtime" en Supabase — Database →
  // Replication — si no, el canal se conecta pero no llegan eventos).
  // Escucha INSERT (mensaje nuevo) y UPDATE (p. ej. un adjunto que pasa de
  // pending a stored, o un delivery_status) — onChange(row, eventType) para
  // que cada caller decida qué hacer con cada uno; un UPDATE nunca debe
  // tratarse como si fuera un mensaje nuevo (no hay que añadirlo al final
  // de la lista ni sumar al contador de no leídos, solo refrescar el que
  // ya estaba).
  function subscribeWhatsapp(client, onChange){
    if(!client) return null;
    return client
      .channel("whatsapp_messages_changes")
      .on("postgres_changes", {event:"INSERT", schema:"public", table:"whatsapp_messages"}, function(payload){
        onChange(payload.new, "INSERT");
      })
      .on("postgres_changes", {event:"UPDATE", schema:"public", table:"whatsapp_messages"}, function(payload){
        onChange(payload.new, "UPDATE");
      })
      .subscribe();
  }

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

  // ---- WhatsApp templates (datos reales desde Meta, ver loadWaTemplates) ----
  var WA_TEMPLATES = [];
  // Solo para mostrar en la UI: Meta guarda category en inglés/mayúsculas
  // (MARKETING/UTILITY/AUTHENTICATION). El valor en BD se deja tal cual viene.
  var WA_CATEGORY_LABELS = {MARKETING:"Marketing", UTILITY:"Utilidad", AUTHENTICATION:"Autenticación"};
  function waCategoryLabel(category){
    if(!category) return "";
    var known = WA_CATEGORY_LABELS[category.toUpperCase()];
    if(known) return known;
    return category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
  }
  function rowToWaTemplate(row){
    return {
      id: row.id,
      name: row.name || "",
      category: waCategoryLabel(row.category),
      lang: row.language || "",
      body: row.body || "",
      status: row.status || "pending",
      variables: row.variables || [],
      components: row.components || [],
      parameter_format: row.parameter_format || null
    };
  }
  function waExtractBodyText(components){
    var body = (components||[]).find(function(c){ return c.type==="BODY"; });
    return (body && body.text) || "";
  }
  // Fuente de verdad del número de variables: el índice MÁXIMO de {{n}} en el
  // texto del BODY (no un recuento de valores distintos) — mismo criterio que
  // analyzeBodyVariables en whatsapp-send/index.ts.
  function waAnalyzeBodyVariables(bodyText){
    var re = /\{\{\s*(\d+)\s*\}\}/g, numbers = {}, m;
    while((m = re.exec(bodyText||""))){ numbers[Number(m[1])] = true; }
    var keys = Object.keys(numbers).map(Number);
    if(keys.length===0) return {count:0, gapless:true};
    var count = Math.max.apply(null, keys);
    var gapless = true;
    for(var i=1;i<=count;i++){ if(!numbers[i]){ gapless=false; break; } }
    return {count:count, gapless:gapless};
  }
  // Mismo criterio que templateSendIssue() en whatsapp-send/index.ts (Edge
  // Function) — mantener sincronizado si cambia allí. Devuelve null si la
  // plantilla es enviable, o el motivo en castellano si no.
  function waTemplateSendIssue(components, parameterFormat){
    var list = components || [];
    if(parameterFormat!=="POSITIONAL"){
      return "Formato de parámetros no soportado ("+(parameterFormat||"desconocido")+"); solo se soportan plantillas POSITIONAL.";
    }
    if(list.some(function(c){return c.type==="CAROUSEL";})){
      return "Las plantillas con componente CAROUSEL no están soportadas todavía.";
    }
    var header = list.find(function(c){return c.type==="HEADER";});
    if(header){
      if(header.format!=="TEXT"){
        return "El header de esta plantilla es de tipo "+(header.format||"desconocido")+"; solo se soportan headers de texto sin variables.";
      }
      if((header.text||"").indexOf("{{")!==-1){
        return "El header de esta plantilla tiene variables; no están soportadas todavía.";
      }
    }
    var buttons = list.find(function(c){return c.type==="BUTTONS";});
    if(buttons){
      var dynamicButton = (buttons.buttons||[]).some(function(b){ return typeof b.url==="string" && b.url.indexOf("{{")!==-1; });
      if(dynamicButton){
        return "Esta plantilla tiene un botón con URL dinámica; no está soportado todavía.";
      }
    }
    return null;
  }
  // Carga las plantillas reales de Supabase y reemplaza WA_TEMPLATES (la BD es
  // la fuente de verdad tras sincronizar con Meta, ver whatsapp-sync-templates)
  async function loadWaTemplates(client){
    if(!client) return 0;
    try{
      var res = await client.from("whatsapp_templates").select("*").order("name",{ascending:true});
      if(res.error || !res.data) return 0;
      WA_TEMPLATES.length = 0;
      res.data.forEach(function(row){ WA_TEMPLATES.push(rowToWaTemplate(row)); });
      return WA_TEMPLATES.length;
    }catch(e){ if(window.console) console.error("loadWaTemplates:", e); return 0; }
  }

  // Archiva/desarchiva una conversación de WhatsApp (persiste en Supabase)
  async function setArchived(client, id, val){
    var w = WHATSAPP.find(function(x){return x.id===id;});
    if(client){
      var res = await client.from("whatsapp_conversations").update({archived: val}).eq("id", id).select();
      if(res.error) throw res.error;
      if(!res.data || res.data.length===0) throw new Error("El update no afectó a ninguna fila (id: "+id+")");
    }
    if(w) w.archived = val;
    return w;
  }
  // Vincula (contactId = uuid) o desvincula (contactId = null) una
  // conversación de WhatsApp a un contacto — persiste en Supabase.
  async function linkWhatsappConversation(client, id, contactId){
    var w = WHATSAPP.find(function(x){return x.id===id;});
    if(client){
      // Un solo RPC (crm/supabase-carpetas.sql): vincula la conversación y
      // coloca sus adjuntos en la carpeta WhatsApp de la empresa principal
      // del contacto (o los deja sin empresa ni carpeta al desvincular), todo
      // en la misma transacción. Los ficheros no se mueven en Storage, solo
      // cambian empresa_id/folder_id/contact_id (aportado por).
      var res = await client.rpc("vincular_conversacion", {p_conversation_id: id, p_contact_id: contactId || null});
      if(res.error) throw res.error;
    }
    if(w) w.contact = contactId;
    return w;
  }
  // Genera una URL firmada al vuelo para un adjunto de WhatsApp — nunca se
  // guarda en ninguna tabla, caduca sola a los 10 minutos. documentoId es
  // el id de public.documentos (viene en whatsapp_messages.meta.attachment,
  // ver crm/supabase-functions/whatsapp-webhook/index.ts). El propio
  // storage_path no viaja en meta, así que hace falta esta consulta previa
  // — un viaje más a BD, pero evita tener que tocar el webhook solo para
  // exponer una ruta que RLS ya deja leer igualmente desde aquí.
  // opts: {download: nombre} fuerza descarga con ese nombre (Content-
  // Disposition: attachment) en vez de la vista inline que necesitan
  // imagen/vídeo/audio.
  async function getAttachmentSignedUrl(client, documentoId, opts){
    if(!client || !documentoId) return null;
    try{
      var docRes = await client.from("documentos").select("storage_path").eq("id", documentoId).maybeSingle();
      if(docRes.error || !docRes.data) return null;
      var signed = await client.storage.from("documentos").createSignedUrl(docRes.data.storage_path, 600, opts||{});
      if(signed.error) return null;
      return signed.data.signedUrl;
    }catch(e){ if(window.console) console.error("getAttachmentSignedUrl:", e); return null; }
  }
  // ---- Admins (public.admins) ----
  function rowToAdmin(row){
    return {
      id: row.id,
      auth_user_id: row.auth_user_id || null,
      name: row.nombre || "",
      email: row.email || "",
      role: row.rol || "miembro",
      activo: row.activo!==false,
      color: colorFor(row.email||row.nombre||row.id)
    };
  }
  // Inserta o reemplaza en USERS por id — usado tras cualquier escritura
  // confirmada en BD (alta, edición, activar/desactivar), para que el resto
  // de la UI (selects de "owner", avatares, CRM.userById...) vea el cambio
  // sin necesidad de recargar toda la lista.
  function cacheAdmin(u){
    var i = USERS.findIndex(function(x){return x.id===u.id;});
    if(i>-1) USERS[i]=u; else USERS.push(u);
    return u;
  }
  function removeAdminLocal(id){
    var idx = USERS.findIndex(function(u){return u.id===id;});
    if(idx>-1) USERS.splice(idx,1);
  }
  async function loadAdmins(client){
    if(!client) return 0;
    try{
      var res = await client.from("admins").select("*").order("nombre",{ascending:true});
      if(res.error || !res.data) return 0;
      USERS.length = 0;
      res.data.forEach(function(row){ USERS.push(rowToAdmin(row)); });
      return USERS.length;
    }catch(e){ if(window.console) console.error("loadAdmins:", e); return 0; }
  }
  // Edita nombre/rol de un administrador ya existente — activo se cambia
  // aparte con setAdminActivo. No toca auth.users (email/contraseña siguen
  // gestionándose vía la Edge Function admin-users).
  async function updateAdmin(client, id, patch){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var payload = {};
    if(patch.nombre!==undefined) payload.nombre = patch.nombre;
    if(patch.rol!==undefined) payload.rol = patch.rol;
    var res = await client.from("admins").update(payload).eq("id", id).select().single();
    if(res.error) throw res.error;
    return cacheAdmin(rowToAdmin(res.data));
  }
  async function setAdminActivo(client, id, activo){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var res = await client.from("admins").update({activo: activo}).eq("id", id).select().single();
    if(res.error) throw res.error;
    return cacheAdmin(rowToAdmin(res.data));
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

  var DEALS_COLUMNS = ["title","contact_id","empresa_id","service","stage","owner","amount","frequency","priority","loss_reason","signed_at","renewal_at","num_nominas","coste_nomina"];
  async function updateDeal(client, id, patch){
    var d = DEALS.find(function(x){return x.id===id;}); if(!d) return null;
    // Los deals de la maqueta no existen como fila en public.deals: solo se persiste en memoria.
    if(client && isUuidLike(id)){
      var payload = {};
      DEALS_COLUMNS.forEach(function(k){ if(patch[k]!==undefined) payload[k] = patch[k]; });
      delete payload.id;
      delete payload.created_at;
      if(payload.empresa_id==="") payload.empresa_id = null;
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
    // patch usa los nombres de columna; el objeto en memoria, los de
    // rowToDeal (mismo caso que updateTask).
    if(patch.contact_id!==undefined) d.contact = patch.contact_id;
    if(patch.empresa_id!==undefined) d.empresa = patch.empresa_id || null;
    return d;
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
      lifecycle: row.lifecycle || LIFECYCLE[0].id, // "lead" no existe en el catálogo actual (ver LIFECYCLE arriba) — un contacto con ese valor no aparece en ninguna columna del pipeline
      priority: row.priority || "medium",
      owner: row.owner || "",
      source: row.source || "",
      kyc: !!row.kyc,
      registered: !!row.registered,
      lead_id: row.lead_id || null,
      // Cuenta del área cliente vinculada (crm/supabase-portal-fase0.sql). El
      // email de esa cuenta no está aquí: lo da admin_cuenta_de_contacto.
      auth_user_id: row.auth_user_id || null,
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
  // Crea un contacto real en Supabase y lo inyecta en CONTACTS.
  // "company" ya NO se manda en el insert: contactos.company lo mantiene
  // al día un trigger a partir de la empresa enlazada (ver
  // crm/supabase-empresas.sql) — el contacto se crea primero (para tener
  // id) y la empresa se enlaza justo después, aquí mismo.
  // data.empresaId: id de una empresa ya existente elegida en el formulario.
  // data.newEmpresa: {razon_social, cif, address, city, province} para crear una nueva.
  // Exactamente una de las dos debe venir (todo contacto pertenece a una empresa).
  async function addContact(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var fields = ["full_name","email","phone","dni","city","province","employees","lifecycle","priority","owner","source"];
    var payload = {};
    fields.forEach(function(k){ if(data[k]!==undefined && data[k]!=="") payload[k] = data[k]; });
    if(!payload.lifecycle) payload.lifecycle = LIFECYCLE[0].id; // ver nota en rowToContact: "lead" no está en el catálogo
    if(!payload.source) payload.source = "Alta manual";
    var res = await client.from("contactos").insert(payload).select();
    if(res.error) throw res.error;
    var c = rowToContact(res.data[0]);
    // Se registra en CONTACTS ANTES de intentar la empresa: el contacto ya
    // existe de verdad en la BD en este punto, así que si el paso de abajo
    // falla, que también exista aquí evita que quede invisible en la UI
    // hasta un recargado completo (ver loadContactos) — el mismo tipo de
    // estado a medias silencioso que se arregló en convertLeadToContact.
    CONTACTS.unshift(c);
    contactById[c.id] = c;

    try{
      var empresa = null;
      if(data.empresaId){
        empresa = EMPRESAS.filter(function(e){return e.id===data.empresaId;})[0] || null;
        if(!empresa) throw new Error("La empresa seleccionada ya no existe.");
        await linkContactoEmpresa(client, c.id, empresa.id, true);
      }else if(data.newEmpresa){
        empresa = await addEmpresa(client, data.newEmpresa);
        await linkContactoEmpresa(client, c.id, empresa.id, true);
      }else{
        throw new Error("Falta la empresa del contacto.");
      }
      c.company = empresa.razon_social;
    }catch(empresaErr){
      var wrapped = new Error("El contacto se creó, pero no se pudo asociar la empresa (" + empresaErr.message + "). Añádela desde la ficha del contacto.");
      wrapped.contact = c;
      throw wrapped;
    }

    return c;
  }

  // ---- Empresas reales (tabla "empresas" + "contacto_empresa" de Supabase) ----
  function rowToEmpresa(row){
    return {
      id: row.id,
      razon_social: row.razon_social || "",
      cif: row.cif || "",
      address: row.address || "",
      city: row.city || "",
      province: row.province || "",
      created: (row.created_at||"").toString().slice(0,10)
    };
  }
  function normalizeCompanyName(s){ return String(s||"").trim().replace(/\s+/g," ").toLowerCase(); }
  function normalizeCif(s){ return String(s||"").trim().replace(/\s+/g,"").toUpperCase(); }
  // Carga las empresas reales de Supabase (una sola vez, al arrancar)
  async function loadEmpresas(client){
    if(!client) return 0;
    try{
      var res = await client.from("empresas").select("*").order("razon_social",{ascending:true});
      if(res.error || !res.data) return 0;
      EMPRESAS.length = 0;
      res.data.forEach(function(row){
        var e = rowToEmpresa(row);
        EMPRESAS.push(e);
        empresaById[e.id] = e;
      });
      return EMPRESAS.length;
    }catch(e){ if(window.console) console.error("loadEmpresas:", e); return 0; }
  }
  // Coincidencia exacta por CIF normalizado (mayúsculas, sin espacios) — ver empresas_cif_key
  function findEmpresaByCif(cif){
    var norm = normalizeCif(cif);
    if(!norm) return null;
    return EMPRESAS.filter(function(e){ return e.cif && normalizeCif(e.cif)===norm; })[0] || null;
  }
  // Coincidencias por nombre normalizado (substring) — para el desplegable de "¿es esta empresa?"
  function searchEmpresasByName(name){
    var norm = normalizeCompanyName(name);
    if(!norm) return [];
    return EMPRESAS.filter(function(e){ return normalizeCompanyName(e.razon_social).indexOf(norm) > -1; });
  }
  // Crea una empresa real en Supabase y la inyecta en EMPRESAS
  // Sin nombre no se crea: antes caía a "Por definir", y como la conversión
  // de leads buscaba esa empresa por nombre, acababa siendo un cajón común
  // de personas sin relación entre sí — que con los documentos colgando de
  // la empresa compartirían carpetas. Quien llame sin razón social decide
  // el nombre (ver convertLeadToContact).
  async function addEmpresa(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var razonSocial = (data.razon_social||"").trim();
    if(!razonSocial) throw new Error("La empresa necesita una razón social.");
    var payload = {
      razon_social: razonSocial,
      cif: data.cif ? data.cif.trim() : null,
      address: data.address || null,
      city: data.city || null,
      province: data.province || null
    };
    var res = await client.from("empresas").insert(payload).select();
    if(res.error) throw res.error;
    var e = rowToEmpresa(res.data[0]);
    EMPRESAS.push(e);
    empresaById[e.id] = e;
    return e;
  }
  // Edita una empresa existente. Si cambia razon_social, el trigger de
  // empresas.sql ya actualizó contactos.company en la BD para todos sus
  // contactos enlazados — aquí solo se refresca la caché local (CONTACTS)
  // para que se vea sin recargar la página.
  async function updateEmpresa(client, id, patch){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var payload = {};
    if(patch.razon_social!==undefined && patch.razon_social.trim()) payload.razon_social = patch.razon_social.trim();
    ["cif","address","city","province"].forEach(function(k){
      if(patch[k]!==undefined) payload[k] = patch[k]===""? null : patch[k];
    });
    var res = await client.from("empresas").update(payload).eq("id", id).select();
    if(res.error) throw res.error;
    var updated = rowToEmpresa(res.data[0]);
    var e = empresaById[id];
    if(e) Object.assign(e, updated); else e = updated;
    var linkedIds = contactsForEmpresa(id).map(function(c){return c.id;});
    await refreshContactsCompany(client, linkedIds);
    return e;
  }
  function rowToContactoEmpresa(row){
    return { id: row.id, contact_id: row.contact_id, empresa_id: row.empresa_id, principal: !!row.principal, created_at: row.created_at || "" };
  }
  // Carga la relación contacto↔empresa completa (una sola vez, al arrancar)
  async function loadContactoEmpresa(client){
    if(!client) return 0;
    try{
      var res = await client.from("contacto_empresa").select("*");
      if(res.error || !res.data) return 0;
      CONTACTO_EMPRESA.length = 0;
      res.data.forEach(function(row){ CONTACTO_EMPRESA.push(rowToContactoEmpresa(row)); });
      return CONTACTO_EMPRESA.length;
    }catch(e){ if(window.console) console.error("loadContactoEmpresa:", e); return 0; }
  }
  // Empresas de un contacto, principal primero (fallback si ninguna está
  // marcada: la más antigua — mismo criterio que resolve_contacto_company
  // en crm/supabase-empresas.sql).
  function empresasForContact(contactId){
    return CONTACTO_EMPRESA.filter(function(l){ return l.contact_id===contactId; })
      .map(function(l){ return {link:l, empresa: empresaById[l.empresa_id]}; })
      .filter(function(x){ return !!x.empresa; })
      .sort(function(a,b){
        return ((b.link.principal?1:0)-(a.link.principal?1:0)) || (a.link.created_at<b.link.created_at ? -1 : a.link.created_at>b.link.created_at ? 1 : 0);
      });
  }
  // Empresa principal del contacto: la marcada como principal o, si no hay
  // ninguna, la enlazada más antigua. DEBE mantener el mismo criterio que
  // public.empresa_principal_de() en la BD (crm/supabase-carpetas.sql).
  // No es solo informativa: además de decir en la interfaz adónde van los
  // adjuntos de WhatsApp (ahí decide la BD), NewDeal (app.jsx) envía su
  // resultado como empresa_id, y un empresa_id explícito prevalece sobre
  // el trigger deals_rellenar_empresa. Si los dos criterios divergen, un
  // deal creado desde la interfaz iría a otra empresa que uno creado sin
  // ella (leads).
  function empresaPrincipalDe(contactId){
    var list = empresasForContact(contactId);
    return list.length ? list[0].empresa : null;
  }
  function contactsForEmpresa(empresaId){
    return CONTACTO_EMPRESA.filter(function(l){ return l.empresa_id===empresaId; })
      .map(function(l){ return contactById[l.contact_id]; })
      .filter(Boolean);
  }
  // Enlaza un contacto a una empresa (inserción de bajo nivel, sin gestionar
  // la bandera "principal" de otros enlaces — la usan altas nuevas donde el
  // contacto no puede tener ya una empresa marcada como principal, ver
  // addContact/convertLeadToContact). 23505 (ya enlazados) se ignora: mismo
  // criterio de idempotencia que el resto de este archivo — un reintento no
  // debe fallar por algo que ya quedó hecho en un intento anterior.
  async function linkContactoEmpresa(client, contactId, empresaId, principal){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var payload = { contact_id: contactId, empresa_id: empresaId, principal: !!principal };
    var res = await client.from("contacto_empresa").insert(payload).select();
    if(res.error){
      if(res.error.code !== "23505") throw res.error;
      return null;
    }
    var link = rowToContactoEmpresa(res.data[0]);
    CONTACTO_EMPRESA.push(link);
    return link;
  }
  // Quita la marca de principal del enlace actual de un contacto, si tiene
  // uno — paso previo obligatorio antes de insertar/promover otro como
  // principal, porque contacto_empresa_principal_key (índice único parcial)
  // no permite dos principal=true a la vez para el mismo contacto.
  async function demoteCurrentPrincipal(client, contactId){
    var current = CONTACTO_EMPRESA.filter(function(l){ return l.contact_id===contactId && l.principal; })[0];
    if(!current) return;
    var res = await client.from("contacto_empresa").update({principal:false}).eq("id", current.id);
    if(res.error) throw res.error;
    current.principal = false;
  }
  // Enlaza una empresa (nueva o ya existente en CONTACTO_EMPRESA) a un
  // contacto que YA tiene al menos una empresa — a diferencia de
  // linkContactoEmpresa, esta gestiona el "como mucho una principal" y
  // refresca contactos.company en caché. La usa EditContact para "añadir
  // una segunda empresa" o cambiar cuál es la principal.
  async function addContactoEmpresaLink(client, contactId, empresaId, principal){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var existing = CONTACTO_EMPRESA.filter(function(l){ return l.contact_id===contactId && l.empresa_id===empresaId; })[0];
    if(existing){
      if(principal && !existing.principal) await setPrincipalEmpresa(client, contactId, empresaId);
      return existing;
    }
    if(principal) await demoteCurrentPrincipal(client, contactId);
    var link = await linkContactoEmpresa(client, contactId, empresaId, principal);
    await refreshContactsCompany(client, [contactId]);
    return link;
  }
  async function setPrincipalEmpresa(client, contactId, empresaId){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var target = CONTACTO_EMPRESA.filter(function(l){ return l.contact_id===contactId && l.empresa_id===empresaId; })[0];
    if(!target) throw new Error("Ese enlace no existe.");
    if(target.principal) return target;
    await demoteCurrentPrincipal(client, contactId);
    var res = await client.from("contacto_empresa").update({principal:true}).eq("id", target.id);
    if(res.error) throw res.error;
    target.principal = true;
    await refreshContactsCompany(client, [contactId]);
    return target;
  }
  // Quita una empresa de un contacto. Rechaza dejarlo sin ninguna (todo
  // contacto debe pertenecer a una empresa, ver crm/supabase-empresas.sql).
  async function removeContactoEmpresaLink(client, contactId, empresaId){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var links = CONTACTO_EMPRESA.filter(function(l){ return l.contact_id===contactId; });
    if(links.length<=1) throw new Error("Un contacto debe tener al menos una empresa.");
    var target = links.filter(function(l){ return l.empresa_id===empresaId; })[0];
    if(!target) return;
    var res = await client.from("contacto_empresa").delete().eq("id", target.id);
    if(res.error) throw res.error;
    var idx = CONTACTO_EMPRESA.indexOf(target);
    if(idx>-1) CONTACTO_EMPRESA.splice(idx,1);
    await refreshContactsCompany(client, [contactId]);
  }
  // Relee contactos.company desde la BD (lo mantiene al día el trigger de
  // empresas.sql) y actualiza la caché local (CONTACTS/contactById) in
  // place, para que cualquier vista que ya tenga esa referencia lo vea sin
  // recargar.
  async function refreshContactsCompany(client, contactIds){
    if(!client || !contactIds || !contactIds.length) return;
    var res = await client.from("contactos").select("id, company").in("id", contactIds);
    if(res.error || !res.data) return;
    res.data.forEach(function(row){
      var c = contactById[row.id];
      if(c) c.company = row.company || "";
    });
  }
  // Alta de empresa desde la vista de Empresas (NewEmpresa en app.jsx). El
  // contacto es obligatorio — nunca se crea una empresa sin uno — y el deal
  // es opcional. Orden: 1) contacto 2) empresa 3) enlace 4) deal opcional.
  // El contacto va PRIMERO por el mismo motivo que en convertLeadToContact:
  // es la entidad "real" que un asesor puede recuperar a mano desde su
  // ficha (con "Añadir empresa", ver EditContact) si algo falla más abajo
  // — dejar la empresa colgada de un contacto que sí existe y es visible
  // es un estado recuperable, nunca invisible.
  // opts.contactChoice: {mode:"new", fields:{full_name,email,phone}} | {mode:"existing", contactId}
  // opts.empresaChoice: {mode:"new", razon_social,cif,address,city,province} | {mode:"existing", empresaId}
  // opts.dealFields: campos de addDeal (sin contact_id) o null/undefined si no se pide deal.
  async function createEmpresaConContacto(client, opts){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var contactChoice = opts.contactChoice;
    var empresaChoice = opts.empresaChoice;
    var contact, empresa;

    if(contactChoice.mode==="existing"){
      contact = contactById[contactChoice.contactId];
      if(!contact) throw new Error("El contacto elegido ya no existe.");
      if(empresaChoice.mode==="existing"){
        empresa = empresaById[empresaChoice.empresaId];
        if(!empresa) throw new Error("La empresa elegida ya no existe.");
      }else{
        empresa = await addEmpresa(client, empresaChoice);
      }
      try{
        // principal=false: un contacto ya existente siempre tiene ya una
        // empresa (es la condición para existir en el CRM) — "añadir" una
        // nueva aquí es el caso de "varias sociedades del mismo cliente"
        // (ver Fase 4), no un reemplazo de su empresa actual. Cambiarla a
        // principal, si hace falta, se sigue haciendo desde EditContact.
        await addContactoEmpresaLink(client, contact.id, empresa.id, false);
      }catch(linkErr){
        throw new Error("La empresa \"" + empresa.razon_social + "\" se creó, pero no se pudo enlazar a " + (contact.full_name||contact.company||"el contacto") + " (" + linkErr.message + "). Añádela desde la ficha del contacto.");
      }
    }else{
      var payload = Object.assign({}, contactChoice.fields);
      if(empresaChoice.mode==="existing") payload.empresaId = empresaChoice.empresaId;
      else payload.newEmpresa = empresaChoice;
      contact = await addContact(client, payload); // ya crea/enlaza la empresa con su propio manejo de fallos parciales
      var rel = empresasForContact(contact.id)[0];
      empresa = rel ? rel.empresa : null;
    }

    // Deal opcional: si falla, NO se deshace nada de lo de arriba — mismo
    // criterio que loadWebLeads con dealFailures. Se avisa y se deja crear
    // a mano desde la ficha del contacto.
    // empresa_id explícito: con un contacto existente, la empresa de este
    // alta se enlaza como secundaria, y sin él el trigger pondría la
    // principal — el deal es de la empresa que se está dando de alta.
    var deal = null, dealError = null;
    if(opts.dealFields){
      try{ deal = await addDeal(client, Object.assign({}, opts.dealFields, {contact_id: contact.id, empresa_id: empresa ? empresa.id : undefined})); }
      catch(e){ dealError = e.message; }
    }
    return {contact:contact, empresa:empresa, deal:deal, dealError:dealError};
  }
  // ---- Documentos y carpetas (Fase 5 — ver crm/supabase-carpetas.sql) ----
  // No se cachean globalmente como CONTACTS/EMPRESAS: se consultan al vuelo
  // al abrir la vista de Documentos o la pestaña de una ficha, y cada
  // pantalla recarga tras escribir. Las reglas (carpeta WhatsApp protegida,
  // destino obligatorio al mover, "con contacto ⇒ con carpeta") viven en
  // la BD; la UI las refleja para no dejar intentar lo que se va a
  // rechazar, pero el error de la BD sigue siendo la última palabra (ver
  // docErrorMessage).
  var MAX_DOCUMENTO_BYTES = 15 * 1024 * 1024; // mismo tope que el bucket (crm/supabase-documentos.sql)
  // La carpeta se trae embebida por la FK compuesta (folder_id, empresa_id)
  // → carpetas(id, empresa_id); el nombre de la FK desambigua frente a la
  // de empresa_id → empresas.
  var DOCUMENTO_SELECT = "*, carpeta:carpetas!documentos_carpeta_fkey(id, nombre, system_key, parent_id)";

  function rowToDocumento(row){
    var carpeta = row.carpeta || null;
    return {
      id: row.id,
      storage_path: row.storage_path,
      mime_type: row.mime_type || "",
      size_bytes: row.size_bytes,
      original_filename: row.original_filename || "",
      status: row.status,
      // Dueño: la empresa. contact_id en la BD ya no es el dueño sino quién
      // lo aportó (el contacto que lo mandó por WhatsApp; null si lo subió
      // un admin) — se expone con ese nombre para que no se confunda.
      empresa_id: row.empresa_id || null,
      aportado_por: row.contact_id || null,
      folder_id: row.folder_id || null,
      folder_name: carpeta ? carpeta.nombre : "",
      folder_is_whatsapp: !!(carpeta && carpeta.system_key==="whatsapp"),
      folder_is_cliente: !!(carpeta && carpeta.system_key==="cliente"),
      // Subcarpetas: el embed solo trae la carpeta del documento, no su
      // madre. folder_path ("Fiscal / 2026") y folder_root_name ("Fiscal")
      // los completa aplicarRutas() con las carpetas de la empresa o con las
      // madres que haga falta pedir (ver loadAllDocumentos). Mientras tanto,
      // la ruta es el propio nombre.
      folder_parent_id: carpeta ? (carpeta.parent_id || null) : null,
      folder_path: carpeta ? carpeta.nombre : "",
      folder_root_name: carpeta && !carpeta.parent_id ? carpeta.nombre : "",
      source: row.source,
      uploaded_by: row.uploaded_by || null,
      // Compartido con el cliente (área cliente). shared_at/shared_by los
      // rellena un trigger al cambiar visible; shared_by es admins.id
      // (CRM.userById). Lo que aporta el cliente (source 'cliente') lo ve
      // siempre, esté o no compartido.
      visible: !!row.visible,
      shared_at: row.shared_at || null,
      shared_by: row.shared_by || null,
      whatsapp_conversation_id: row.whatsapp_conversation_id || null,
      created_at: row.created_at || "",
      created: (row.created_at||"").toString().slice(0,10)
    };
  }
  function rowToCarpeta(row){
    return {
      id: row.id,
      empresa_id: row.empresa_id,
      parent_id: row.parent_id || null,
      nombre: row.nombre,
      system_key: row.system_key || null,
      is_whatsapp: row.system_key==="whatsapp",
      // "Aportados por el cliente": solo admite lo que sube el cliente desde
      // el área cliente (lo exige la BD), así que nunca es destino en el CRM.
      is_cliente: row.system_key==="cliente",
      // Calculada en la BD: raíz y no de sistema (crm/supabase-carpetas.sql, 1b).
      admite_subcarpetas: row.admite_subcarpetas!==undefined ? !!row.admite_subcarpetas : (!row.parent_id && !row.system_key),
      orden: row.orden || 0
    };
  }
  function sortCarpetas(list){
    return list.sort(function(a,b){ return (a.orden-b.orden) || a.nombre.localeCompare(b.nombre, "es"); });
  }

  // ---- Árbol de dos niveles (crm/supabase-carpetas.sql, punto 1b) ----
  // Raíces y subcarpetas salen de la misma lista plana; nunca hay más de
  // dos niveles (lo garantiza la BD), así que no hace falta recursión.
  function carpetaRaices(list){ return (list||[]).filter(function(k){ return !k.parent_id; }); }
  function carpetaHijas(list, parentId){ return (list||[]).filter(function(k){ return k.parent_id===parentId; }); }
  // Hermanas de una carpeta (o de una carpeta nueva bajo parentId): el
  // ámbito de la unicidad de nombre (carpetas_hermanas_nombre_key).
  function carpetaHermanas(list, parentId){ return (list||[]).filter(function(k){ return (k.parent_id||null)===(parentId||null); }); }
  // "Fiscal / 2026" para una subcarpeta, "Fiscal" para una raíz.
  function carpetaRuta(list, carpeta){
    if(!carpeta) return "";
    if(!carpeta.parent_id) return carpeta.nombre;
    var madre = (list||[]).filter(function(k){ return k.id===carpeta.parent_id; })[0];
    return (madre ? madre.nombre : "…")+" / "+carpeta.nombre;
  }
  // Opciones de un <select> de destino: cada raíz seguida de sus hijas,
  // sangradas con espacios duros (un <option> no admite estilos de sangría
  // fiables, sobre todo en móvil) y con la ruta completa. excludeId: la
  // carpeta de origen, que no tiene sentido como destino.
  function carpetaOpciones(list, excludeId){
    var out = [];
    carpetaRaices(list).forEach(function(r){
      if(r.id!==excludeId) out.push({id:r.id, label:r.nombre, carpeta:r});
      carpetaHijas(list, r.id).forEach(function(h){
        if(h.id!==excludeId) out.push({id:h.id, label:"\u00a0\u00a0\u00a0\u00a0"+r.nombre+" / "+h.nombre, carpeta:h});
      });
    });
    return out;
  }
  // Completa folder_path y folder_root_name de cada documento a partir de
  // las carpetas conocidas (al menos las madres de sus carpetas).
  function aplicarRutas(docs, carpetas){
    var byId = {};
    (carpetas||[]).forEach(function(k){ byId[k.id]=k; });
    (docs||[]).forEach(function(d){
      if(!d.folder_id) return;
      var madre = d.folder_parent_id ? byId[d.folder_parent_id] : null;
      if(d.folder_parent_id){
        d.folder_path = (madre ? madre.nombre : "…")+" / "+d.folder_name;
        d.folder_root_name = madre ? madre.nombre : "";
      }else{
        d.folder_path = d.folder_name;
        d.folder_root_name = d.folder_name;
      }
    });
    return docs;
  }

  // ---- Nombre, extensión y vista previa ----
  // Extensión de un nombre de fichero, sin el punto y tal cual está escrita
  // (al renombrar "Informe.PDF" se conserva ".PDF"). Un punto inicial
  // (".env") no es extensión.
  function extOf(name){
    var n = name || "";
    var dot = n.lastIndexOf(".");
    return dot>0 && dot<n.length-1 ? n.slice(dot+1) : "";
  }
  // Último segmento de storage_path. Para un adjunto de WhatsApp sin nombre
  // el webhook lo construye como "{tipo}-{id_mensaje}.{ext}" (ver
  // buildAttachmentFilename en crm/supabase-functions/whatsapp-webhook).
  function storageFilename(doc){
    var p = doc.storage_path || "";
    return p.slice(p.lastIndexOf("/")+1);
  }
  // Extensión real del fichero: la del nombre original si la tiene; si no
  // (adjunto de WhatsApp sin nombre), la de la ruta en Storage, que el
  // webhook deriva del mime.
  function docExtension(doc){
    return extOf(doc.original_filename) || extOf(storageFilename(doc));
  }
  var WA_KIND_LABELS = {image:"Imagen", video:"Vídeo", audio:"Audio", sticker:"Sticker", document:"Documento"};
  // Nombre a mostrar. original_filename es lo que mandó el cliente o lo que
  // escribió un admin; si no hay (imágenes, audios, vídeos y stickers de
  // WhatsApp, que Meta manda sin nombre) se compone uno descriptivo solo
  // para pintar — no se guarda en la BD, para no inventar un dato que el
  // cliente no envió. Tipo: el prefijo que el webhook pone en la ruta; si no
  // encaja, el mime. Fecha: la de recepción, en hora de Madrid.
  function docDisplayName(doc){
    if(doc.original_filename) return doc.original_filename;
    var kind = (storageFilename(doc).match(/^(image|video|audio|sticker|document)-/)||[])[1];
    if(!kind){
      var m = doc.mime_type || "";
      kind = m.indexOf("image/")===0 ? "image" : m.indexOf("video/")===0 ? "video" : m.indexOf("audio/")===0 ? "audio" : "document";
    }
    var fecha = isoToMadridDatetimeLocal(doc.created_at).slice(0,10);
    return WA_KIND_LABELS[kind] + (doc.source==="whatsapp" ? " de WhatsApp" : "") + (fecha ? " "+fecha : "");
  }
  // Nombre con el que se descarga: el mismo que se ve, con su extensión.
  function docDownloadName(doc){
    if(doc.original_filename) return doc.original_filename;
    var ext = docExtension(doc);
    return docDisplayName(doc) + (ext ? "."+ext : "");
  }
  // Qué visor puede mostrar el documento dentro del CRM: "image", "pdf" o
  // null (solo descarga). Se decide por el mime con el que se guardó, no
  // por la extensión: es el Content-Type con el que Storage sirve el
  // fichero, y un PDF guardado como application/octet-stream se descargaría
  // en vez de pintarse — un visor roto. HEIC/TIFF y similares se quedan
  // fuera: la mayoría de navegadores no los pintan.
  var PREVIEW_IMAGE_MIMES = ["image/jpeg","image/png","image/gif","image/webp","image/avif","image/bmp","image/svg+xml"];
  function docPreviewKind(doc){
    if(doc.status!=="stored") return null;
    var m = (doc.mime_type||"").split(";")[0].trim().toLowerCase();
    if(PREVIEW_IMAGE_MIMES.indexOf(m)>-1) return "image";
    if(m==="application/pdf") return "pdf";
    return null;
  }
  // Renombra solo original_filename: el fichero y su ruta en Storage no se
  // tocan (la ruta es la identidad del objeto). La extensión no se puede
  // cambiar: se conserva la del fichero real (docExtension) y el usuario
  // solo edita el nombre base. Si la vuelve a escribir al final, no se
  // duplica ("contrato.pdf" → "contrato.pdf", no "contrato.pdf.pdf").
  function documentoNombreFinal(doc, base){
    var ext = docExtension(doc);
    var b = (base||"").trim();
    if(ext && b.toLowerCase().endsWith("."+ext.toLowerCase())) b = b.slice(0, -(ext.length+1)).trim();
    return {base:b, full: ext ? b+"."+ext : b};
  }
  function documentoNombreIssue(doc, base){
    var r = documentoNombreFinal(doc, base);
    if(!r.base) return "Escribe un nombre.";
    if(/[\/\\\u0000-\u001f]/.test(r.base)) return "El nombre no puede contener / ni \\.";
    if(r.full.length>200) return "Máximo 200 caracteres.";
    return null;
  }
  async function renombrarDocumento(client, doc, base){
    var issue = documentoNombreIssue(doc, base);
    if(issue) throw new Error(issue);
    var full = documentoNombreFinal(doc, base).full;
    var res = await client.from("documentos").update({original_filename: full}).eq("id", doc.id).select(DOCUMENTO_SELECT);
    if(res.error) throw res.error;
    if(!res.data || res.data.length===0) throw new Error("El documento ya no existe.");
    return rowToDocumento(res.data[0]);
  }

  // Vista Documentos: todos, incluidos los adjuntos sin empresa (conversación
  // sin vincular). Lanza en caso de error para que la vista distinga
  // "vacío" de "no se pudo cargar".
  // Las rutas ("Fiscal / 2026") necesitan el nombre de la madre de cada
  // subcarpeta: se piden solo esas madres, en una segunda consulta pequeña,
  // en vez de embeber la autorreferencia de carpetas.
  async function loadAllDocumentos(client){
    if(!client) return [];
    var res = await client.from("documentos").select(DOCUMENTO_SELECT).order("created_at",{ascending:false});
    if(res.error) throw res.error;
    var docs = (res.data||[]).map(rowToDocumento);
    var madres = Array.from(new Set(docs.map(function(d){ return d.folder_parent_id; }).filter(Boolean)));
    if(madres.length){
      var mres = await client.from("carpetas").select("id, nombre").in("id", madres);
      if(mres.error) throw mres.error;
      aplicarRutas(docs, mres.data||[]);
    }else{
      aplicarRutas(docs, []);
    }
    return docs;
  }
  // Ficha de empresa (y pestaña de la ficha de contacto, por la empresa
  // elegida): sus carpetas y sus documentos, en paralelo.
  async function loadDocumentosEmpresa(client, empresaId){
    if(!client || !empresaId) return {carpetas:[], docs:[]};
    var results = await Promise.all([
      client.from("carpetas").select("*").eq("empresa_id", empresaId),
      client.from("documentos").select(DOCUMENTO_SELECT).eq("empresa_id", empresaId).order("created_at",{ascending:false})
    ]);
    if(results[0].error) throw results[0].error;
    if(results[1].error) throw results[1].error;
    var carpetas = sortCarpetas((results[0].data||[]).map(rowToCarpeta));
    return {
      carpetas: carpetas,
      docs: aplicarRutas((results[1].data||[]).map(rowToDocumento), carpetas)
    };
  }
  // Solo las carpetas de una empresa (destinos de "Mover a otra empresa").
  async function loadCarpetasEmpresa(client, empresaId){
    if(!client || !empresaId) return [];
    var res = await client.from("carpetas").select("*").eq("empresa_id", empresaId);
    if(res.error) throw res.error;
    return sortCarpetas((res.data||[]).map(rowToCarpeta));
  }

  // Traduce los errores de BD que la UI puede provocar a un mensaje legible.
  // Los mensajes propios de los triggers/RPCs ya están en español y se
  // dejan pasar tal cual.
  function docErrorMessage(e){
    if(!e) return "Error desconocido";
    var m = e.message || "";
    if(e.code==="23505" && /hermanas_nombre/.test(m)) return "Ya existe una carpeta con ese nombre aquí.";
    if(e.code==="23505") return "Ya existe una carpeta con ese nombre en esta empresa.";
    if(e.code==="23503" && /carpetas_padre_fkey/.test(m)) return "Ahí no se puede crear una subcarpeta: solo las carpetas raíz admiten subcarpetas, y la de WhatsApp no.";
    if(e.code==="23503" && /documentos_carpeta_fkey/.test(m)) return "Esa carpeta no es de la empresa del documento.";
    if(e.code==="23514" && /sistema_es_raiz/.test(m)) return "La carpeta WhatsApp tiene que estar en la raíz.";
    if(e.code==="23514" && /whatsapp_reservado/.test(m)) return "El nombre \"WhatsApp\" está reservado para la carpeta del sistema.";
    if(e.code==="23514" && /nombre_check/.test(m)) return "El nombre de la carpeta debe tener entre 1 y 60 caracteres.";
    return m || String(e);
  }
  // Validación previa de nombre de carpeta: mismo criterio que los checks
  // de carpetas (longitud, "WhatsApp" reservado) y que el índice único
  // (sin distinguir mayúsculas ni espacios de los extremos). La unicidad
  // es entre hermanas: quien llama pasa en "carpetas" solo las hermanas
  // (carpetaHermanas). Devuelve el mensaje de error o null.
  function carpetaNombreIssue(nombre, carpetas, exceptId){
    var n = (nombre||"").trim();
    if(!n) return "Escribe un nombre.";
    if(n.length>60) return "Máximo 60 caracteres.";
    if(n.toLowerCase()==="whatsapp") return "\"WhatsApp\" está reservado para la carpeta del sistema.";
    var dup = (carpetas||[]).some(function(k){ return k.id!==exceptId && k.nombre.trim().toLowerCase()===n.toLowerCase(); });
    if(dup) return "Ya existe una carpeta con ese nombre.";
    return null;
  }

  // Entre las 4 por defecto (orden 1-4) y WhatsApp (100): las creadas a mano
  // quedan detrás de las de serie y delante de la del sistema.
  // parentId: la raíz donde va una subcarpeta; null/undefined para una raíz.
  async function crearCarpeta(client, empresaId, nombre, parentId){
    var res = await client.from("carpetas").insert({empresa_id: empresaId, parent_id: parentId || null, nombre: nombre.trim(), orden: 50}).select().single();
    if(res.error) throw res.error;
    return rowToCarpeta(res.data);
  }
  async function renombrarCarpeta(client, carpetaId, nombre){
    var res = await client.from("carpetas").update({nombre: nombre.trim()}).eq("id", carpetaId).select();
    if(res.error) throw res.error;
    if(!res.data || res.data.length===0) throw new Error("La carpeta ya no existe.");
    return rowToCarpeta(res.data[0]);
  }
  // destinoId obligatorio si la carpeta tiene documentos (el RPC lo exige).
  async function borrarCarpeta(client, carpetaId, destinoId){
    var res = await client.rpc("borrar_carpeta", {p_carpeta_id: carpetaId, p_destino: destinoId || null});
    if(res.error) throw res.error;
  }
  // Mueve una subcarpeta a otra raíz de la misma empresa (RPC mover_carpeta).
  // Si el nombre choca en el destino, la BD responde con un mensaje claro y
  // no fusiona nada.
  async function moverCarpeta(client, carpetaId, nuevoPadreId){
    if(!nuevoPadreId) throw new Error("Hace falta una carpeta destino.");
    var res = await client.rpc("mover_carpeta", {p_carpeta_id: carpetaId, p_nuevo_padre: nuevoPadreId});
    if(res.error) throw res.error;
  }
  async function moverDocumentos(client, documentoIds, destinoId){
    if(!destinoId) throw new Error("Hace falta una carpeta destino.");
    var res = await client.rpc("mover_documentos", {p_documento_ids: documentoIds, p_carpeta_destino: destinoId});
    if(res.error) throw res.error;
    return res.data;
  }

  // Nombre de fichero apto para una clave de Storage: Supabase rechaza
  // acentos, eñes y varios signos en la ruta ("Invalid key"). El nombre
  // original, tal cual, se guarda en original_filename y es el que se ve y
  // el que se usa al descargar.
  function storageSafeFilename(name){
    var dot = (name||"").lastIndexOf(".");
    var base = dot>0 ? name.slice(0,dot) : (name||"");
    var ext = dot>0 ? name.slice(dot+1) : "";
    var clean = function(s){
      return s.normalize("NFD").replace(/[̀-ͯ]/g,"")
        .replace(/[^A-Za-z0-9._-]+/g,"_").replace(/_+/g,"_").replace(/^[_.]+|[_.]+$/g,"");
    };
    base = clean(base).slice(0,80) || "documento";
    ext = clean(ext).slice(0,10);
    return ext ? base+"."+ext : base;
  }
  // Subida manual: fichero primero, fila después (ver diseño de la Fase 5).
  //   - Si falla la subida, no queda nada.
  //   - Si falla la fila, se intenta retirar el fichero; si eso también
  //     falla queda un huérfano invisible en Storage (lo detecta la consulta
  //     de huérfanos), nunca una fila apuntando a un fichero que no existe.
  // La fila nace 'stored': una subida manual nunca pasa por 'pending'.
  // Ruta: manual/{empresa_id}/{documento_id}/{nombre}. Ni la carpeta ni la
  // empresa cambian la ruta después: mover solo cambia folder_id/empresa_id
  // (los documentos subidos antes del cambio a empresas conservan su ruta
  // manual/{contact_id}/… — la ruta es la identidad del fichero).
  // contact_id ("aportado por") queda NULL: lo sube un admin, no lo aporta
  // ningún contacto; quién lo subió está en uploaded_by.
  async function subirDocumentoManual(client, opts){
    var file = opts.file;
    if(!file) throw new Error("Elige un archivo.");
    if(file.size>MAX_DOCUMENTO_BYTES) throw new Error("El archivo supera el máximo de 15 MB.");
    if(!opts.empresaId || !opts.folderId) throw new Error("Hace falta empresa y carpeta.");
    var id = crypto.randomUUID();
    var path = "manual/"+opts.empresaId+"/"+id+"/"+storageSafeFilename(file.name);
    var up = await client.storage.from("documentos").upload(path, file, {contentType: file.type || "application/octet-stream", upsert: false});
    if(up.error) throw up.error;
    var ins = await client.from("documentos").insert({
      id: id,
      storage_path: path,
      mime_type: file.type || null,
      size_bytes: file.size,
      original_filename: file.name,
      status: "stored",
      empresa_id: opts.empresaId,
      folder_id: opts.folderId,
      source: "manual",
      uploaded_by: opts.uploadedBy || null,
      visible: !!opts.visible
    }).select(DOCUMENTO_SELECT).single();
    if(ins.error){
      var rm = await client.storage.from("documentos").remove([path]);
      if(rm.error && window.console) console.error("subirDocumentoManual: no se pudo retirar el fichero tras fallar la fila", path, rm.error);
      throw ins.error;
    }
    return rowToDocumento(ins.data);
  }
  // Borrado: fila primero, fichero después. Si falla el fichero, el
  // documento ya ha desaparecido para el usuario y queda un huérfano
  // invisible en Storage — nunca al revés (una fila visible con el fichero
  // ya borrado). Un adjunto de WhatsApp borrado queda marcado 'deleted' en
  // el mensaje por trigger (documentos_marcar_mensaje_borrado).
  // Devuelve {fileRemoved} para que la UI pueda avisar si el fichero no se
  // pudo retirar.
  async function borrarDocumento(client, doc){
    if(doc.status==="pending") throw new Error("Este adjunto aún se está descargando de WhatsApp.");
    var del = await client.from("documentos").delete().eq("id", doc.id).select("id");
    if(del.error) throw del.error;
    if(!del.data || del.data.length===0) throw new Error("El documento ya no existe.");
    var rm = await client.storage.from("documentos").remove([doc.storage_path]);
    if(rm.error){
      if(window.console) console.error("borrarDocumento: fila borrada pero el fichero sigue en Storage", doc.storage_path, rm.error);
      return {fileRemoved:false};
    }
    return {fileRemoved:true};
  }

  // Compartir (o dejar de compartir) un documento con el cliente. Solo tiene
  // sentido para documentos guardados y que no haya aportado el cliente; la
  // fecha y el admin que lo comparte los pone el trigger
  // documentos_registrar_compartido.
  async function setDocumentoVisible(client, doc, visible){
    var res = await client.from("documentos").update({visible: !!visible}).eq("id", doc.id).select(DOCUMENTO_SELECT).single();
    if(res.error) throw res.error;
    var d = rowToDocumento(res.data);
    // La ruta completa ("Fiscal / 2026") no viaja en el embed: se conserva la de la fila anterior.
    d.folder_path = doc.folder_path; d.folder_root_name = doc.folder_root_name;
    return d;
  }

  // ---- Cuentas del área cliente (crm/supabase-portal-fase1.sql y -fase2.sql) ----
  // Cuentas de Auth que no son de un admin ni están vinculadas a un contacto.
  // Se cargan al arrancar (contador del menú) y se recargan tras cada acción.
  var CUENTAS_PENDIENTES = [];
  async function loadCuentasPendientes(client){
    if(!client) return 0;
    try{
      var res = await client.rpc("admin_cuentas_pendientes");
      if(res.error || !res.data) return 0;
      CUENTAS_PENDIENTES.length = 0;
      res.data.forEach(function(r){ CUENTAS_PENDIENTES.push(r); });
      return CUENTAS_PENDIENTES.length;
    }catch(e){ if(window.console) console.error("loadCuentasPendientes:", e); return 0; }
  }
  // Llama a la Edge Function portal-cuentas. Ante un error devuelve el
  // mensaje que trae su cuerpo (409 "está vinculada…", 400 "no ha confirmado
  // su email"…), no el genérico de supabase-js para respuestas no 2xx.
  async function invokePortalCuentas(client, body){
    var res = await client.functions.invoke("portal-cuentas", { body: body });
    if(res.error){
      var msg = res.error.message || "Error al llamar a portal-cuentas";
      try{
        var ctx = res.error.context;
        if(ctx && typeof ctx.json==="function"){ var j = await ctx.json(); if(j && j.error) msg = j.error; }
      }catch(e){ /* sin cuerpo JSON: se queda el mensaje genérico */ }
      throw new Error(msg);
    }
    return res.data;
  }
  // Vincula una cuenta pendiente a un contacto y envía el email al cliente.
  // Devuelve {emails_coinciden, email_cuenta, email_contacto, email_enviado}.
  async function vincularCuentaPortal(client, authUserId, contactId){
    var r = await invokePortalCuentas(client, {accion:"vincular", auth_user_id: authUserId, contact_id: contactId});
    var c = contactById[contactId]; if(c) c.auth_user_id = authUserId;
    var i = CUENTAS_PENDIENTES.findIndex(function(x){ return x.auth_user_id===authUserId; });
    if(i>-1) CUENTAS_PENDIENTES.splice(i,1);
    return r;
  }
  // Borra de Auth una cuenta pendiente (nunca un admin ni una vinculada: lo
  // comprueba portal-cuentas).
  async function eliminarCuentaPortal(client, authUserId){
    await invokePortalCuentas(client, {accion:"eliminar", auth_user_id: authUserId});
    var i = CUENTAS_PENDIENTES.findIndex(function(x){ return x.auth_user_id===authUserId; });
    if(i>-1) CUENTAS_PENDIENTES.splice(i,1);
  }
  // Cuenta del área cliente vinculada a un contacto, o null.
  async function cuentaDeContacto(client, contactId){
    var res = await client.rpc("admin_cuenta_de_contacto", {p_contact_id: contactId});
    if(res.error) throw res.error;
    return (res.data && res.data[0]) || null;
  }
  // Quita el acceso al área cliente: el contacto se queda sin cuenta y la
  // cuenta vuelve a la lista de pendientes (no se borra de Auth).
  async function desvincularCuentaPortal(client, contactId){
    var res = await client.rpc("admin_desvincular_cuenta", {p_contact_id: contactId});
    if(res.error) throw res.error;
    var c = contactById[contactId]; if(c) c.auth_user_id = null;
    await loadCuentasPendientes(client);
    return res.data;
  }

  // ---- Alta autónoma (crm/supabase-portal-fase32.sql) ----
  // Borradores y documentos que mandan las cuentas pendientes. Lectura
  // directa (RLS: solo admins); las acciones van por portal-cuentas.
  // Devuelve {auth_user_id: {borrador, docs[]}} (docs aún sin mover).
  async function loadAltas(client){
    var b = await client.from("alta_borradores").select("*");
    if(b.error) throw b.error;
    var d = await client.from("alta_documentos").select("*").is("destino_path", null).order("created_at", {ascending:true});
    if(d.error) throw d.error;
    var r = {};
    (b.data||[]).forEach(function(x){ r[x.auth_user_id] = {borrador:x, docs:[]}; });
    (d.data||[]).forEach(function(x){ (r[x.auth_user_id] = r[x.auth_user_id] || {borrador:null, docs:[]}).docs.push(x); });
    return r;
  }
  // URL firmada de un fichero del alta (pendientes/…): los admins leen todo
  // el bucket. opts {download: nombre} fuerza la descarga.
  async function altaDocSignedUrl(client, doc, opts){
    var s = await client.storage.from("documentos").createSignedUrl(doc.storage_path, 600, opts||{});
    if(s.error) return null;
    return s.data.signedUrl;
  }
  // Coincidencias para revisar un alta: empresas con el mismo CIF y
  // contactos con el mismo email (de la cuenta o, si lo hubiera, otro).
  function normCifAlta(s){ return String(s||"").replace(/[\s.\-]/g,"").toUpperCase(); }
  function coincidenciasAlta(borrador, email){
    var cif = normCifAlta(borrador && borrador.cif);
    var em = String(email||"").trim().toLowerCase();
    return {
      empresas: cif ? EMPRESAS.filter(function(e){ return normCifAlta(e.cif)===cif; }) : [],
      contactos: em ? CONTACTS.filter(function(c){ return c.id.indexOf("lead-")!==0 && String(c.email||"").trim().toLowerCase()===em; }) : [],
    };
  }
  async function recargarTrasAlta(client){
    await Promise.all([loadEmpresas(client), loadContactos(client)]);
    await Promise.all([loadContactoEmpresa(client), loadDeals(client), loadCuentasPendientes(client)]);
  }
  // Dar de alta (sin empresa ni contacto: se crean con lo enviado) o
  // vincular a existentes (empresaId obligatorio; contactId opcional: sin él
  // se crea el contacto en esa empresa). Devuelve lo de portal-cuentas:
  // {empresa_id, contact_id, documentos_movidos, documentos_pendientes, email_enviado}.
  async function resolverAlta(client, authUserId, empresaId, contactId){
    var r = await invokePortalCuentas(client, {accion:"alta", auth_user_id:authUserId, empresa_id:empresaId||null, contact_id:contactId||null});
    await recargarTrasAlta(client);
    return r;
  }
  // Rechazar: borra la cuenta, su borrador y sus ficheros.
  async function rechazarAlta(client, authUserId){
    var r = await invokePortalCuentas(client, {accion:"rechazar", auth_user_id:authUserId});
    var i = CUENTAS_PENDIENTES.findIndex(function(x){ return x.auth_user_id===authUserId; });
    if(i>-1) CUENTAS_PENDIENTES.splice(i,1);
    return r;
  }
  // Documentos de un alta ya resuelta que no se pudieron mover (fallo de
  // Storage): se reintentan desde la ficha del contacto.
  async function altaDocsPorMover(client, authUserId){
    var res = await client.from("alta_documentos").select("id", {count:"exact", head:true})
      .eq("auth_user_id", authUserId).not("destino_path", "is", null);
    if(res.error) throw res.error;
    return res.count||0;
  }
  async function reintentarDocsAlta(client, authUserId){
    return invokePortalCuentas(client, {accion:"reintentar_documentos", auth_user_id:authUserId});
  }

  // ---- Área cliente: lo que el cliente cambia o pide sobre su empresa ----
  // (crm/supabase-portal-fase31.sql). Lectura directa: las dos tablas son de
  // solo lectura para admins (RLS is_admin()).
  async function loadSolicitudesEmpresa(client, empresaId){
    var res = await client.from("empresa_solicitudes").select("*, contacto:contactos(full_name, email)")
      .eq("empresa_id", empresaId).order("created_at", {ascending:false});
    if(res.error) throw res.error;
    return res.data || [];
  }
  async function loadCambiosEmpresa(client, empresaId){
    var res = await client.from("empresa_cambios").select("*, contacto:contactos(full_name, email)")
      .eq("empresa_id", empresaId).order("created_at", {ascending:false}).limit(100);
    if(res.error) throw res.error;
    return res.data || [];
  }
  // Aplica (o rechaza) una solicitud de cambio de razón social o CIF. Al
  // aplicarla se relee la empresa (y contactos.company, que lo sincroniza un
  // trigger al cambiar la razón social) para que el CRM lo vea sin recargar.
  async function resolverSolicitud(client, solicitud, aplicar){
    var res = await client.rpc("admin_resolver_solicitud", {p_solicitud_id: solicitud.id, p_aplicar: !!aplicar});
    if(res.error) throw res.error;
    if(aplicar){
      var er = await client.from("empresas").select("*").eq("id", solicitud.empresa_id).maybeSingle();
      if(!er.error && er.data){
        var e = empresaById[solicitud.empresa_id];
        if(e) Object.assign(e, rowToEmpresa(er.data));
      }
      await refreshContactsCompany(client, contactsForEmpresa(solicitud.empresa_id).map(function(c){ return c.id; }));
    }
    return res.data && res.data[0] ? res.data[0].estado : null;
  }
  // Tras un cambio de dirección hecho por el cliente, el CRM puede tener la
  // empresa en caché con los datos viejos: se relee al abrir su ficha.
  async function refrescarEmpresa(client, empresaId){
    var er = await client.from("empresas").select("*").eq("id", empresaId).maybeSingle();
    if(er.error || !er.data) return null;
    var e = empresaById[empresaId];
    if(e) Object.assign(e, rowToEmpresa(er.data));
    return e;
  }

  // ---- Deals reales (tabla "deals" de Supabase) ----
  function rowToDeal(row){
    return {
      id: row.id,
      title: row.title || "",
      contact: row.contact_id,
      // Empresa del deal (ver crm/supabase-deals-empresa.sql): si el alta no
      // la elige, el trigger deals_rellenar_empresa pone la principal del
      // contacto. contact sigue siendo el interlocutor.
      empresa: row.empresa_id || null,
      // 'portal' si lo pidió el cliente desde el área cliente (crm/supabase-portal-fase31.sql).
      origen: row.origen || "crm",
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
    var fields = ["title","contact_id","empresa_id","service","stage","owner","amount","frequency","priority","num_nominas","coste_nomina"];
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
  // Un lead sin convertir usa un id sintético "lead-<uuid>" (ver isLead en
  // ContactDetail) — no es un uuid válido, y contact_id/deal_id son columnas
  // uuid tanto en tareas como en notas. Sin este filtro, crear una tarea o
  // nota desde la ficha de un lead sin convertir fallaría en Postgres en vez
  // de simplemente guardarse sin el enlace.
  function sanitizeFkPayload(payload){
    if(payload.contact_id!==undefined && payload.contact_id!==null && !isUuidLike(payload.contact_id)) delete payload.contact_id;
    if(payload.deal_id!==undefined && payload.deal_id!==null && !isUuidLike(payload.deal_id)) delete payload.deal_id;
    return payload;
  }
  // Crea una tarea real en Supabase y la inyecta en TASKS
  async function addTask(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    if(!data.title) throw new Error("La tarea necesita un título");
    var fields = ["title","assigned_to","due_at","contact_id","deal_id","status","archived"];
    var payload = {};
    fields.forEach(function(k){ if(data[k]!==undefined && data[k]!=="") payload[k] = data[k]; });
    if(payload.due_at) payload.due_at = madridDatetimeLocalToISO(payload.due_at);
    sanitizeFkPayload(payload);
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
    // Se convierte una sola vez, aquí, antes de repartirse tanto al payload
    // de BD como a la copia en memoria de abajo — si cada uno convirtiera
    // por su lado (o uno lo hiciera y el otro no), t.due podría quedar
    // desincronizado del valor real guardado hasta el próximo recargar.
    if(patch.due_at) patch = Object.assign({}, patch, {due_at: madridDatetimeLocalToISO(patch.due_at)});
    if(client){
      var payload = {};
      TAREAS_COLUMNS.forEach(function(k){ if(patch[k]!==undefined) payload[k] = patch[k]; });
      delete payload.id;
      delete payload.created_at;
      sanitizeFkPayload(payload);
      var res = await client.from("tareas").update(payload).eq("id", id).select();
      if(res.error) throw res.error;
      if(!res.data || res.data.length===0) throw new Error("El update no afectó a ninguna fila (id: "+id+")");
    }
    // patch llega con nombres de columna de BD (due_at, assigned_to,
    // contact_id, deal_id); el objeto en memoria usa los nombres de
    // rowToTask (due, owner, contact, deal). Sin este mapeo, Object.assign
    // añadía propiedades nuevas sin tocar las que de verdad lee la UI —
    // "Editar tarea" guardaba bien en BD pero no se veía en pantalla hasta recargar.
    if(patch.title!==undefined) t.title = patch.title;
    if(patch.due_at!==undefined) t.due = patch.due_at;
    if(patch.assigned_to!==undefined) t.owner = patch.assigned_to;
    if(patch.status!==undefined) t.status = patch.status;
    if(patch.archived!==undefined) t.archived = patch.archived;
    if(patch.contact_id!==undefined) t.contact = patch.contact_id;
    if(patch.deal_id!==undefined) t.deal = patch.deal_id;
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

  // ---- Notas (esquema en crm/supabase-notas.sql) — ligadas a un contacto,
  // a un deal, a ambos o a ninguno; sin edición, solo crear/borrar. ----
  function rowToNote(row){
    return {
      id: row.id,
      body: row.body || "",
      author: row.author || "",
      contact: row.contact_id || null,
      deal: row.deal_id || null,
      created: (row.created_at||"").toString().slice(0,10)
    };
  }
  // Carga las notas reales de Supabase y las inyecta en NOTES (una sola vez, al arrancar)
  async function loadNotes(client){
    if(!client) return 0;
    try{
      var res = await client.from("notas").select("*").order("created_at",{ascending:false});
      if(res.error || !res.data) return 0;
      var n = 0;
      res.data.forEach(function(row){
        var note = rowToNote(row);
        if(NOTES.some(function(x){return x.id===note.id;})) return; // evitar duplicados
        NOTES.push(note);
        n++;
      });
      return n;
    }catch(e){ if(window.console) console.error("loadNotes:", e); return 0; }
  }
  // Crea una nota real en Supabase y la inyecta en NOTES
  async function addNote(client, data){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    if(!data.body || !data.body.trim()) throw new Error("La nota no puede estar vacía");
    var payload = { body: data.body.trim(), author: data.author || null, contact_id: data.contact_id || null, deal_id: data.deal_id || null };
    sanitizeFkPayload(payload);
    var res = await client.from("notas").insert(payload).select();
    if(res.error) throw res.error;
    if(!res.data || res.data.length===0) throw new Error("No se creó la nota");
    var note = rowToNote(res.data[0]);
    NOTES.unshift(note);
    return note;
  }
  async function removeNote(client, id){
    if(client){
      var res = await client.from("notas").delete().eq("id", id);
      if(res.error) throw res.error;
    }
    var idx = NOTES.findIndex(function(x){return x.id===id;});
    if(idx>-1) NOTES.splice(idx,1);
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
  // Recuento de leads con un fallo pendiente (error_message no nulo) — se
  // recalcula en cada loadWebLeads, lo lee CRM.LEAD_ERROR_COUNT desde
  // app.jsx (aviso de sesión) y el banner de la vista de Contactos.
  var LEAD_ERROR_COUNT = 0;

  // Carga los leads de Supabase. Cada lead con status 'new' se intenta
  // convertir en contacto real + deal (reutiliza convertLeadToContact y
  // addDeal). Los que ya están 'converted' se ignoran.
  //
  // contactFailures/dealFailures (en el objeto devuelto) son best-effort,
  // solo para el aviso en pantalla — el registro que de verdad importa es
  // leads.error_message, que persiste aunque nadie tenga la sesión
  // abierta para ver el toast (ver crm/supabase-leads-dedupe.sql y el
  // punto 4/5 de esta conversación).
  async function loadWebLeads(client){
    var empty = {converted:0, contactFailures:[], dealFailures:[]};
    if(!client) return empty;
    try{
      var res = await client.from("leads").select("*").order("created_at",{ascending:false});
      if(res.error || !res.data) return empty;
      var n = 0, contactFailures = [], dealFailures = [];
      for(var i=0;i<res.data.length;i++){
        var row = res.data[i];
        if(row.status!=="new") continue; // solo leads sin convertir
        var label = row.empresa || row.nombre || row.email || row.id;
        var newContact;
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
          newContact = await convertLeadToContact(client, c.id);
          n++;
        }catch(e){
          // Aquí es donde se perdía el lead del 15/09: antes esto solo hacía
          // console.error y no quedaba nada más. Ahora, además de avisar en
          // pantalla (ver contactFailures, usado por app.jsx), se deja
          // constancia en el propio lead — sobrevive a que nadie estuviera
          // mirando la consola en ese momento. Sin quitarle status='new':
          // así el próximo loadWebLeads lo reintenta solo, y gracias al
          // índice único de contactos.lead_id (ver convertLeadToContact)
          // reintentar es seguro aunque el contacto ya se hubiera llegado a
          // crear a medias.
          if(window.console) console.error("loadWebLeads: fallo al convertir lead "+row.id, e);
          contactFailures.push(label);
          try{
            await client.from("leads").update({error_message: String((e && e.message) || e)}).eq("id", row.id);
          }catch(e2){ if(window.console) console.error("loadWebLeads: no se pudo registrar el error del lead "+row.id, e2); }
          continue; // sin contacto no tiene sentido intentar crear el deal
        }
        // 3) crea el deal asociado — aparte, para que un fallo aquí nunca
        // deshaga ni esconda que el contacto sí se creó bien.
        try{
          await addDeal(client, {
            title: row.servicio || "Solicitud web",
            contact_id: newContact.id,
            service: matchServiceId(row.servicio),
            stage: "nueva_solicitud"
          });
        }catch(e){
          if(window.console) console.error("loadWebLeads: contacto creado pero el deal falló para "+row.id, e);
          dealFailures.push(newContact.company || label);
        }
      }
      // Recuento fresco al final, no una suma sobre el "antes" leído arriba:
      // así un lead que justo se arregló en esta misma pasada (o que otra
      // sesión arregló mientras tanto) no se sigue contando de más.
      try{
        var errRes = await client.from("leads").select("id",{count:"exact", head:true}).not("error_message","is",null);
        LEAD_ERROR_COUNT = errRes.error ? 0 : (errRes.count||0);
      }catch(e3){ LEAD_ERROR_COUNT = 0; }
      return {converted:n, contactFailures:contactFailures, dealFailures:dealFailures};
    }catch(e){ if(window.console) console.error("loadWebLeads:", e); return empty; }
  }
  // Convierte un lead (id sintético "lead-<uuid>") en un contacto real de
  // public.contactos.
  //
  // Orden invertido respecto a antes: el contacto se crea PRIMERO, y el
  // lead solo se marca 'converted' si ese insert tuvo éxito. Antes era al
  // revés (para evitar duplicados si el insert fallaba) — pero eso dejaba
  // el fallo contrario, peor: cualquier error entre medias marcaba el lead
  // como convertido sin haber creado nada, y ese lead quedaba invisible
  // para siempre (así se perdió el del 15/09). Un contacto duplicado
  // visible en la lista es mucho más fácil de detectar y arreglar que un
  // lead que desaparece sin dejar rastro.
  //
  // La protección contra duplicados ya no depende del orden de las
  // operaciones ni de status='new' (que dos sesiones pueden leer a la vez
  // sin que ninguna sepa de la otra) — depende de contactos_lead_id_key,
  // el índice único sobre contactos.lead_id (ver
  // crm/supabase-leads-dedupe.sql). Si dos sesiones intentan convertir el
  // mismo lead a la vez, o alguien recarga a mitad de una conversión
  // anterior que sí tuvo éxito, el segundo INSERT choca con ese índice
  // (código de error 23505) — se captura abajo como caso normal, no como
  // fallo: se recupera el contacto que ya existe y se sigue igual.
  async function convertLeadToContact(client, leadId){
    if(!client) throw new Error("El acceso aún no está configurado (Supabase).");
    var leadUuid = leadId.indexOf("lead-")===0 ? leadId.slice(5) : leadId;
    var lead = contactById[leadId];
    if(!lead) throw new Error("No se encontró el lead a convertir");

    var payload = {
      full_name: lead.full_name || "",
      email: lead.email || "",
      phone: lead.phone || "",
      source: "Formulario web",
      lifecycle: LIFECYCLE[0].id, // ver nota en rowToContact: "lead" no está en el catálogo
      lead_id: leadUuid
    };
    var res = await client.from("contactos").insert(payload).select();
    var contactRow;
    if(res.error){
      if(res.error.code !== "23505") throw res.error;
      var existing = await client.from("contactos").select("*").eq("lead_id", leadUuid).maybeSingle();
      if(existing.error || !existing.data) throw res.error; // no debería pasar; si pasa, el error original dice más
      contactRow = existing.data;
    }else{
      contactRow = res.data[0];
    }

    // Empresa: igual que el alta manual, todo contacto debe tener una —
    // pero aquí no hay nadie que desambigüe, así que la resolución es
    // automática y solo por nombre (el formulario web no pide CIF): se
    // reutiliza una empresa existente si su razón social normalizada es
    // idéntica a la del lead (si hubiera varias idénticas, la primera de
    // EMPRESAS); si no, se crea una nueva.
    // Se comprueba primero si el contacto YA tiene empresa enlazada por si
    // esta función se reintenta tras un fallo que llegó hasta aquí en un
    // intento anterior (mismo criterio de idempotencia que el índice único
    // de contactos.lead_id de más arriba).
    var linkCheck = await client.from("contacto_empresa").select("id").eq("contact_id", contactRow.id).limit(1);
    if(!linkCheck.error && (!linkCheck.data || linkCheck.data.length===0)){
      // Sin empresa en el lead: una empresa PROPIA con el nombre de la
      // persona, sin buscar coincidencias — dos leads llamados igual no
      // tienen por qué ser la misma persona, y las empresas comparten
      // carpetas y documentos. Nunca se reutiliza un nombre genérico.
      var companyRaw = (lead.company||"").trim();
      var empresa = null;
      if(companyRaw){
        empresa = searchEmpresasByName(companyRaw).filter(function(e){
          return normalizeCompanyName(e.razon_social) === normalizeCompanyName(companyRaw);
        })[0] || null;
      }
      if(!empresa) empresa = await addEmpresa(client, {razon_social: companyRaw || (lead.full_name||"").trim() || (lead.email||"").trim() || "Lead sin nombre"});
      await linkContactoEmpresa(client, contactRow.id, empresa.id, true);
      contactRow.company = empresa.razon_social;
    }

    // El contacto ya existe de verdad y ya tiene empresa — ahora sí se
    // marca 'converted'. Si esto fallara, el lead se queda en 'new' con su
    // contacto ya creado y ya enlazado: el próximo loadWebLeads lo
    // reintentará, chocará con el índice único de arriba (el contacto ya
    // existe), el chequeo de empresa de arriba verá que ya está enlazada y
    // la saltará, y solo reintentará marcar 'converted' — nunca se pierde
    // ni se duplica nada.
    var statusRes = await client.from("leads")
      .update({status:"converted", error_message:null})
      .eq("id", leadUuid).select();
    if(statusRes.error) throw statusRes.error;

    var idx = CONTACTS.findIndex(function(c){return c.id===leadId;});
    if(idx>-1) CONTACTS.splice(idx,1);
    delete contactById[leadId];

    var c = rowToContact(contactRow);
    CONTACTS.unshift(c);
    contactById[c.id] = c;

    // Relinkar notas/actividad del lead antiguo al nuevo id real, para no perder el historial.
    NOTES.forEach(function(n){ if(n.contact===leadId) n.contact=c.id; });
    ACTIVITY.forEach(function(a){ if(a.contact===leadId) a.contact=c.id; });

    return c;
  }

  // ---- Notificaciones push (Web Push + VAPID, ver crm/supabase-push.sql) ----
  // sub: el objeto que devuelve PushSubscription.toJSON() del navegador
  // ({endpoint, keys:{p256dh, auth}}). onConflict (user_id, endpoint) hace que
  // re-suscribirse desde el mismo dispositivo actualice la fila en vez de
  // duplicarla.
  async function savePushSubscription(client, userId, sub, deviceLabel){
    var payload = {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      device_label: deviceLabel || null,
      last_seen_at: new Date().toISOString()
    };
    var res = await client.from("push_subscriptions").upsert(payload, {onConflict:"user_id,endpoint"}).select().single();
    if(res.error) throw res.error;
    return res.data;
  }
  async function removePushSubscription(client, endpoint){
    var res = await client.from("push_subscriptions").delete().eq("endpoint", endpoint);
    if(res.error) throw res.error;
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
    rowToAdmin:rowToAdmin, cacheAdmin:cacheAdmin, removeAdminLocal:removeAdminLocal,
    loadAdmins:loadAdmins, updateAdmin:updateAdmin, setAdminActivo:setAdminActivo,
    SERVICES:SERVICES, serviceById:function(id){var m={};SERVICES.forEach(function(s){m[s.id]=s;});return m[id];},
    STAGES:STAGES, stageById:stageById,
    LIFECYCLE:LIFECYCLE, lifecycleById:lifecycleById,
    LOSS_REASONS:LOSS_REASONS, PRIORITIES:PRIORITIES,
    priorityById:function(id){var m={};PRIORITIES.forEach(function(p){m[p.id]=p;});return m[id];},
    CONTACTS:CONTACTS, contactById:contactById,
    EMPRESAS:EMPRESAS, empresaById:empresaById, loadEmpresas:loadEmpresas, addEmpresa:addEmpresa, updateEmpresa:updateEmpresa,
    findEmpresaByCif:findEmpresaByCif, searchEmpresasByName:searchEmpresasByName,
    normalizeCompanyName:normalizeCompanyName, normalizeCif:normalizeCif,
    CONTACTO_EMPRESA:CONTACTO_EMPRESA, loadContactoEmpresa:loadContactoEmpresa,
    empresasForContact:empresasForContact, contactsForEmpresa:contactsForEmpresa,
    linkContactoEmpresa:linkContactoEmpresa, addContactoEmpresaLink:addContactoEmpresaLink,
    setPrincipalEmpresa:setPrincipalEmpresa, removeContactoEmpresaLink:removeContactoEmpresaLink,
    empresaPrincipalDe:empresaPrincipalDe, createEmpresaConContacto:createEmpresaConContacto,
    MAX_DOCUMENTO_BYTES:MAX_DOCUMENTO_BYTES, loadAllDocumentos:loadAllDocumentos, loadDocumentosEmpresa:loadDocumentosEmpresa, loadCarpetasEmpresa:loadCarpetasEmpresa,
    docErrorMessage:docErrorMessage, carpetaNombreIssue:carpetaNombreIssue,
    crearCarpeta:crearCarpeta, renombrarCarpeta:renombrarCarpeta, borrarCarpeta:borrarCarpeta, moverDocumentos:moverDocumentos,
    moverCarpeta:moverCarpeta, carpetaRaices:carpetaRaices, carpetaHijas:carpetaHijas, carpetaHermanas:carpetaHermanas,
    carpetaRuta:carpetaRuta, carpetaOpciones:carpetaOpciones,
    subirDocumentoManual:subirDocumentoManual, borrarDocumento:borrarDocumento,
    docExtension:docExtension, docDisplayName:docDisplayName, docDownloadName:docDownloadName, docPreviewKind:docPreviewKind,
    documentoNombreFinal:documentoNombreFinal, documentoNombreIssue:documentoNombreIssue, renombrarDocumento:renombrarDocumento,
    DEALS:DEALS, TASKS:TASKS, NOTES:NOTES, CALLS:CALLS,
    WHATSAPP:WHATSAPP, DOCUMENTS:DOCUMENTS, AUTOMATIONS:AUTOMATIONS, ACTIVITY:ACTIVITY,
    linkWhatsappConversation:linkWhatsappConversation, getAttachmentSignedUrl:getAttachmentSignedUrl,
    fmtEUR:fmtEUR, fmtBytes:fmtBytes, initials:initials, colorFor:colorFor, computeKpis:computeKpis, loadWebLeads:loadWebLeads, loadContactos:loadContactos, addContact:addContact, loadDeals:loadDeals, addDeal:addDeal, convertLeadToContact:convertLeadToContact,
    // Función, no valor estático — LEAD_ERROR_COUNT es un número que
    // loadWebLeads reasigna en cada login; exponerlo como valor lo habría
    // congelado en 0 (el que tenía al construirse este objeto CRM, al
    // cargar el script, antes de que nadie hubiera iniciado sesión nunca).
    leadErrorCount:function(){ return LEAD_ERROR_COUNT; },
    loadTasks:loadTasks, addTask:addTask, updateTask:updateTask, removeTask:removeTask, toggleTaskDone:toggleTaskDone,
    isoToMadridDatetimeLocal:isoToMadridDatetimeLocal,
    loadNotes:loadNotes, addNote:addNote, removeNote:removeNote,
    updateContact:updateContact, removeDeal:removeDeal, removeContact:removeContact, removeContacts:removeContacts,
    updateDeal:updateDeal, WA_TEMPLATES:WA_TEMPLATES, setArchived:setArchived,
    setDocumentoVisible:setDocumentoVisible,
    CUENTAS_PENDIENTES:CUENTAS_PENDIENTES, loadCuentasPendientes:loadCuentasPendientes,
    loadAltas:loadAltas, altaDocSignedUrl:altaDocSignedUrl, coincidenciasAlta:coincidenciasAlta, resolverAlta:resolverAlta,
    rechazarAlta:rechazarAlta, altaDocsPorMover:altaDocsPorMover, reintentarDocsAlta:reintentarDocsAlta,
    vincularCuentaPortal:vincularCuentaPortal, eliminarCuentaPortal:eliminarCuentaPortal,
    cuentaDeContacto:cuentaDeContacto, desvincularCuentaPortal:desvincularCuentaPortal,
    loadSolicitudesEmpresa:loadSolicitudesEmpresa, loadCambiosEmpresa:loadCambiosEmpresa,
    resolverSolicitud:resolverSolicitud, refrescarEmpresa:refrescarEmpresa,
    loadWhatsapp:loadWhatsapp, subscribeWhatsapp:subscribeWhatsapp, rowToWhatsappMessage:rowToWhatsappMessage, loadWaTemplates:loadWaTemplates,
    loadWhatsappConversationById:loadWhatsappConversationById,
    waExtractBodyText:waExtractBodyText, waAnalyzeBodyVariables:waAnalyzeBodyVariables, waTemplateSendIssue:waTemplateSendIssue,
    savePushSubscription:savePushSubscription, removePushSubscription:removePushSubscription,
    MAILBOX:MAILBOX, FOLDERS:FOLDERS, folderById:folderById, EMAILS:EMAILS, unreadOf:unreadOf,
    addFolder:addFolder, removeFolder:removeFolder, moveEmailToFolder:moveEmailToFolder,
    setEmailArchived:setEmailArchived, linkEmail:linkEmail, addEmailReply:addEmailReply, addEmailThread:addEmailThread
  };
})();
