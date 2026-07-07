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

  // ---- Contacts ----
  var CONTACTS = [
    {id:"c1", company:"Nordia Logística S.L.", full_name:"Elena Ruiz", email:"elena@nordialogistica.es", phone:"+34 916 22 10 44", dni:"B87654321", city:"Pozuelo de Alarcón", province:"Madrid", lifecycle:"active_client", owner:"u2", source:"Referido", priority:"high", utm:"referido/socio", kyc:true, registered:true, created:"2024-11-12", employees:38},
    {id:"c2", company:"Grupo Ventia", full_name:"Marcos Belmonte", email:"m.belmonte@grupoventia.com", phone:"+34 915 88 20 31", dni:"B12398745", city:"Madrid", province:"Madrid", lifecycle:"opportunity", owner:"u1", source:"Formulario web", priority:"high", utm:"google/cpc · verifactu", kyc:false, registered:false, created:"2026-06-28", employees:74},
    {id:"c3", company:"Talleres Aravaca", full_name:"José Luis Prieto", email:"jlprieto@talleresaravaca.es", phone:"+34 917 40 55 12", dni:"B45612378", city:"Aravaca", province:"Madrid", lifecycle:"active_client", owner:"u4", source:"Referido", priority:"medium", utm:"referido/cliente", kyc:true, registered:true, created:"2023-03-20", employees:12},
    {id:"c4", company:"Marea Estudio Creativo", full_name:"Paula Sanz", email:"hola@mareaestudio.com", phone:"+34 640 12 88 90", dni:"B78945612", city:"Madrid", province:"Madrid", lifecycle:"proposal", owner:"u1", source:"Formulario web", priority:"medium", utm:"google/organic · cfo externo", kyc:false, registered:false, created:"2026-06-19", employees:9},
    {id:"c5", company:"Delicatessen Ibéricos Vega", full_name:"Antonio Vega", email:"antonio@ibericosvega.es", phone:"+34 924 33 21 09", dni:"B32165498", city:"Badajoz", province:"Badajoz", lifecycle:"active_client", owner:"u2", source:"LinkedIn", priority:"medium", utm:"linkedin/social", kyc:true, registered:true, created:"2024-01-15", employees:22},
    {id:"c6", company:"Clínica Dental Sonrisa", full_name:"Dra. Carmen Losada", email:"direccion@clinicasonrisa.es", phone:"+34 918 20 44 77", dni:"B65498732", city:"Boadilla del Monte", province:"Madrid", lifecycle:"opportunity", owner:"u3", source:"Formulario web", priority:"high", utm:"google/cpc · asesoría laboral", kyc:false, registered:false, created:"2026-06-30", employees:15},
    {id:"c7", company:"TechFlow Solutions", full_name:"Iván Cortés", email:"ivan@techflow.io", phone:"+34 645 90 12 33", dni:"B98765432", city:"Madrid", province:"Madrid", lifecycle:"opportunity", owner:"u5", source:"Referido", priority:"high", utm:"referido/inversor", kyc:false, registered:false, created:"2026-06-24", employees:28},
    {id:"c8", company:"Panadería La Espiga", full_name:"Rosa Giménez", email:"rosa@laespiga.es", phone:"+34 913 55 66 21", dni:"B11223344", city:"Getafe", province:"Madrid", lifecycle:"lost", owner:"u4", source:"Formulario web", priority:"low", utm:"google/organic", kyc:false, registered:false, created:"2026-05-10", employees:6},
    {id:"c9", company:"Inmobiliaria Castellana Prime", full_name:"Fernando Aguirre", email:"faguirre@castellanaprime.es", phone:"+34 914 21 78 65", dni:"B55667788", city:"Madrid", province:"Madrid", lifecycle:"active_client", owner:"u1", source:"Referido", priority:"high", utm:"referido/socio", kyc:true, registered:true, created:"2022-09-05", employees:19},
    {id:"c10", company:"BioNatura Cosmética", full_name:"Lucía Herrero", email:"lucia@bionatura.es", phone:"+34 963 22 11 09", dni:"B99887766", city:"Valencia", province:"Valencia", lifecycle:"proposal", owner:"u2", source:"Formulario web", priority:"medium", utm:"google/cpc · planificación fiscal", kyc:false, registered:false, created:"2026-06-15", employees:31},
    {id:"c11", company:"Construcciones Halcón", full_name:"Pedro Halcón", email:"pedro@construccioneshalcon.es", phone:"+34 925 44 33 22", dni:"B22334455", city:"Toledo", province:"Toledo", lifecycle:"opportunity", owner:"u5", source:"Llamada entrante", priority:"medium", utm:"directo", kyc:false, registered:false, created:"2026-06-26", employees:53},
    {id:"c12", company:"EduSmart Academias", full_name:"Nuria Peña", email:"nuria@edusmart.es", phone:"+34 918 77 65 43", dni:"B66778899", city:"Las Rozas", province:"Madrid", lifecycle:"active_client", owner:"u3", source:"Referido", priority:"medium", utm:"referido/cliente", kyc:true, registered:true, created:"2024-07-22", employees:17},
    {id:"c13", company:"Restaurante El Fogón", full_name:"Diego Márquez", email:"diego@elfogon.es", phone:"+34 915 33 88 12", dni:"B33445566", city:"Madrid", province:"Madrid", lifecycle:"new", owner:"u4", source:"Formulario web", priority:"low", utm:"google/organic · blog", kyc:false, registered:false, created:"2026-07-01", employees:11},
    {id:"c14", company:"AgroValle Cooperativa", full_name:"Isabel Moreno", email:"imoreno@agrovalle.coop", phone:"+34 947 12 09 88", dni:"F44556677", city:"Burgos", province:"Burgos", lifecycle:"opportunity", owner:"u2", source:"LinkedIn", priority:"high", utm:"linkedin/social", kyc:false, registered:false, created:"2026-06-21", employees:44}
  ];
  var contactById={}; CONTACTS.forEach(function(c){contactById[c.id]=c;});

  // ---- Deals ----
  var DEALS = [
    {id:"d1", title:"Dirección financiera externa", contact:"c1", service:"s1", stage:"cliente_activo", owner:"u2", amount:1800, frequency:"mensual", priority:"high", created:"2024-11-20", signed:"2024-12-02", renewal:"2026-12-02"},
    {id:"d2", title:"Cuota contable mensual", contact:"c1", service:"s3", stage:"cliente_activo", owner:"u4", amount:650, frequency:"mensual", priority:"medium", created:"2024-11-20", signed:"2024-12-02", renewal:"2026-12-02"},
    {id:"d3", title:"CFO externo para escalado", contact:"c2", service:"s1", stage:"negociacion", owner:"u1", amount:2200, frequency:"mensual", priority:"high", created:"2026-06-28", renewal:null},
    {id:"d4", title:"Gestión contable y fiscal", contact:"c3", service:"s3", stage:"cliente_activo", owner:"u4", amount:520, frequency:"mensual", priority:"medium", created:"2023-03-25", signed:"2023-04-01", renewal:"2027-04-01"},
    {id:"d5", title:"CFO externo a tiempo parcial", contact:"c4", service:"s1", stage:"propuesta", owner:"u1", amount:1500, frequency:"mensual", priority:"medium", created:"2026-06-19", renewal:null},
    {id:"d6", title:"Planificación fiscal anual", contact:"c5", service:"s2", stage:"cliente_activo", owner:"u2", amount:3200, frequency:"anual", priority:"medium", created:"2024-01-20", signed:"2024-02-01", renewal:"2027-02-01"},
    {id:"d7", title:"Nóminas y laboral (15 empleados)", contact:"c6", service:"s4", stage:"contactado", owner:"u3", amount:560, frequency:"mensual", priority:"high", created:"2026-06-30", renewal:null},
    {id:"d8", title:"Preparación ronda + CFO", contact:"c7", service:"s1", stage:"reunion", owner:"u5", amount:2600, frequency:"mensual", priority:"high", created:"2026-06-24", renewal:null},
    {id:"d9", title:"Alta y contabilidad", contact:"c8", service:"s3", stage:"perdido", owner:"u4", amount:390, frequency:"mensual", priority:"low", created:"2026-05-10", loss_reason:"precio_alto"},
    {id:"d10", title:"Legal societario y contratos", contact:"c9", service:"s5", stage:"cliente_activo", owner:"u1", amount:2500, frequency:"puntual", priority:"high", created:"2022-09-10", signed:"2022-10-01", renewal:null},
    {id:"d11", title:"Planificación fiscal internacional", contact:"c10", service:"s2", stage:"propuesta", owner:"u2", amount:3800, frequency:"anual", priority:"medium", created:"2026-06-15", renewal:null},
    {id:"d12", title:"Reestructuración y estrategia", contact:"c11", service:"s6", stage:"reunion", owner:"u5", amount:5200, frequency:"puntual", priority:"medium", created:"2026-06-26", renewal:null},
    {id:"d13", title:"Laboral + contable pack", contact:"c12", service:"s4", stage:"cliente_activo", owner:"u3", amount:720, frequency:"mensual", priority:"medium", created:"2024-07-28", signed:"2024-08-01", renewal:"2026-08-01"},
    {id:"d14", title:"Consulta fiscal alta autónomo", contact:"c13", service:"s2", stage:"nueva_solicitud", owner:"u4", amount:1200, frequency:"anual", priority:"low", created:"2026-07-01", renewal:null},
    {id:"d15", title:"Compliance y protección de datos", contact:"c14", service:"s5", stage:"propuesta", owner:"u2", amount:2900, frequency:"puntual", priority:"high", created:"2026-06-21", renewal:null},
    {id:"d16", title:"Cuota contable mensual", contact:"c9", service:"s3", stage:"cliente_activo", owner:"u4", amount:700, frequency:"mensual", priority:"medium", created:"2022-09-10", signed:"2022-10-01", renewal:"2026-10-01"}
  ];

  // ---- Tasks ----
  var TASKS = [
    {id:"t1", title:"Enviar propuesta CFO a Grupo Ventia", deal:"d3", contact:"c2", owner:"u1", status:"pending", priority:"high", due:"2026-07-03"},
    {id:"t2", title:"Llamar a Clínica Sonrisa para agendar reunión", deal:"d7", contact:"c6", owner:"u3", status:"pending", priority:"high", due:"2026-07-02"},
    {id:"t3", title:"Revisar documentación KYC de TechFlow", deal:"d8", contact:"c7", owner:"u5", status:"in_progress", priority:"medium", due:"2026-07-04"},
    {id:"t4", title:"Preparar cierre trimestral Nordia", deal:"d1", contact:"c1", owner:"u4", status:"pending", priority:"medium", due:"2026-07-10"},
    {id:"t5", title:"Renovación anual Delicatessen Vega", deal:"d6", contact:"c5", owner:"u2", status:"pending", priority:"medium", due:"2026-07-15"},
    {id:"t6", title:"Firmar contrato BioNatura", deal:"d11", contact:"c10", owner:"u2", status:"done", priority:"high", due:"2026-06-30"},
    {id:"t7", title:"Enviar borrador de compliance a AgroValle", deal:"d15", contact:"c14", owner:"u2", status:"in_progress", priority:"high", due:"2026-07-05"}
  ];

  // ---- Notes ----
  var NOTES = [
    {id:"n1", contact:"c2", deal:"d3", author:"u1", created:"2026-06-29 10:12", body:"Vienen de un despacho tradicional. Facturan ~4M€, quieren reporting mensual y control de caja. Muy receptivos, decisión en 2 semanas."},
    {id:"n2", contact:"c7", deal:"d8", author:"u5", created:"2026-06-25 16:40", body:"Preparan ronda seed de 800K. Necesitan modelo financiero y data room. Introducción vía inversor conocido."},
    {id:"n3", contact:"c6", deal:"d7", author:"u3", created:"2026-07-01 09:05", body:"Clínica con 15 empleados, actualmente con una gestoría que no les atiende bien. Prioridad: nóminas y un despido complicado."},
    {id:"n4", contact:"c1", deal:"d1", author:"u2", created:"2026-06-20 12:00", body:"Cliente estrella. Ampliar a planificación fiscal en la renovación de diciembre."}
  ];

  // ---- Calls ----
  var CALLS = [
    {id:"cl1", contact:"c2", deal:"d3", user:"u1", direction:"outbound", outcome:"Interesado", duration:640, notes:"Repaso de necesidades, acuerda recibir propuesta.", at:"2026-06-29 10:00"},
    {id:"cl2", contact:"c6", deal:"d7", user:"u3", direction:"inbound", outcome:"Agendar reunión", duration:320, notes:"Llama pidiendo cambio de gestoría.", at:"2026-06-30 11:20"},
    {id:"cl3", contact:"c11", deal:"d12", user:"u5", direction:"outbound", outcome:"No contesta", duration:0, notes:"Buzón. Reintentar mañana.", at:"2026-07-01 17:30"}
  ];

  // ---- WhatsApp ----
  var WHATSAPP = [
    {id:"w1", contact:"c2", unread:2, updated:"10:24", messages:[
      {dir:"in", t:"09:58", body:"Buenos días, ¿recibisteis la documentación que envié?"},
      {dir:"out", t:"10:05", body:"¡Buenos días Marcos! Sí, todo recibido. Estamos preparando la propuesta de CFO externo."},
      {dir:"in", t:"10:20", body:"Perfecto. ¿Para cuándo la tendríais?"},
      {dir:"in", t:"10:24", body:"Es que tenemos consejo el jueves y me gustaría presentarla."}
    ]},
    {id:"w2", contact:"c6", unread:0, updated:"Ayer", messages:[
      {dir:"in", t:"Ayer 11:15", body:"Hola, nos gustaría cambiar de asesoría laboral."},
      {dir:"out", t:"Ayer 11:40", body:"Encantada de ayudaros. ¿Cuántos empleados tenéis actualmente?"},
      {dir:"in", t:"Ayer 11:42", body:"Somos 15, con un caso de despido en marcha."},
      {dir:"out", t:"Ayer 12:00", body:"Lo vemos. ¿Os viene bien una llamada mañana a las 10:00?"}
    ]},
    {id:"w3", contact:"c1", unread:0, updated:"Lun", messages:[
      {dir:"out", t:"Lun 09:00", body:"Elena, os paso el reporting de junio esta tarde."},
      {dir:"in", t:"Lun 09:12", body:"Genial, gracias Juan Manuel 👍"}
    ]},
    {id:"w4", contact:"c14", unread:1, updated:"08:30", messages:[
      {dir:"in", t:"08:30", body:"¿Habéis podido revisar el tema de protección de datos de la cooperativa?"}
    ]}
  ];

  // ---- Documents ----
  var DOCUMENTS = [
    {id:"doc1", name:"Propuesta_CFO_GrupoVentia.pdf", type:"Propuesta", deal:"d3", contact:"c2", size:"248 KB", by:"u1", at:"2026-06-29", visible:false},
    {id:"doc2", name:"Contrato_servicios_Nordia.pdf", type:"Contrato", deal:"d1", contact:"c1", size:"512 KB", by:"u2", at:"2024-12-02", visible:true},
    {id:"doc3", name:"Modelo_financiero_TechFlow.xlsx", type:"Modelo", deal:"d8", contact:"c7", size:"1.2 MB", by:"u5", at:"2026-06-25", visible:false},
    {id:"doc4", name:"Cierre_trimestral_Q1_Nordia.pdf", type:"Informe", deal:"d1", contact:"c1", size:"690 KB", by:"u4", at:"2026-04-05", visible:true},
    {id:"doc5", name:"Escritura_constitucion_Castellana.pdf", type:"Legal", deal:"d10", contact:"c9", size:"3.1 MB", by:"u1", at:"2022-10-01", visible:true},
    {id:"doc6", name:"Borrador_compliance_AgroValle.docx", type:"Borrador", deal:"d15", contact:"c14", size:"88 KB", by:"u2", at:"2026-07-01", visible:false}
  ];

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
  var ACTIVITY = [
    {contact:"c2", type:"stage", at:"2026-06-29 10:30", who:"u1", text:"Deal movido a Negociación"},
    {contact:"c2", type:"call", at:"2026-06-29 10:00", who:"u1", text:"Llamada saliente · 10m 40s · Interesado"},
    {contact:"c2", type:"note", at:"2026-06-29 10:12", who:"u1", text:"Añadió una nota"},
    {contact:"c2", type:"contact", at:"2026-06-28 18:02", who:null, text:"Contacto creado desde el formulario web"},
    {contact:"c7", type:"note", at:"2026-06-25 16:40", who:"u5", text:"Añadió una nota"},
    {contact:"c7", type:"email", at:"2026-06-25 15:10", who:"u5", text:"Email enviado · Introducción y siguientes pasos"},
    {contact:"c7", type:"contact", at:"2026-06-24 09:30", who:null, text:"Contacto creado · referido por inversor"},
    {contact:"c1", type:"doc", at:"2026-04-05 12:00", who:"u4", text:"Subió Cierre trimestral Q1"},
    {contact:"c1", type:"stage", at:"2024-12-02 12:00", who:"u2", text:"Deal firmado → Cliente activo"}
  ];

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
  function updateContact(id, patch){
    var c = contactById[id]; if(!c) return null;
    Object.assign(c, patch);
    return c;
  }
  function removeDeal(dealId){
    var idx = DEALS.findIndex(function(d){return d.id===dealId;});
    if(idx>-1) DEALS.splice(idx,1);
    for(var i=NOTES.length-1;i>=0;i--) if(NOTES[i].deal===dealId) NOTES.splice(i,1);
    for(var j=TASKS.length-1;j>=0;j--) if(TASKS[j].deal===dealId) TASKS.splice(j,1);
    for(var k=DOCUMENTS.length-1;k>=0;k--) if(DOCUMENTS[k].deal===dealId) DOCUMENTS.splice(k,1);
  }
  function removeContact(id){
    var idx = CONTACTS.findIndex(function(c){return c.id===id;});
    if(idx>-1) CONTACTS.splice(idx,1);
    delete contactById[id];
    for(var i=DEALS.length-1;i>=0;i--) if(DEALS[i].contact===id) removeDeal(DEALS[i].id);
    for(var j=NOTES.length-1;j>=0;j--) if(NOTES[j].contact===id) NOTES.splice(j,1);
    for(var k=TASKS.length-1;k>=0;k--) if(TASKS[k].contact===id) TASKS.splice(k,1);
    for(var l=DOCUMENTS.length-1;l>=0;l--) if(DOCUMENTS[l].contact===id) DOCUMENTS.splice(l,1);
    for(var m=WHATSAPP.length-1;m>=0;m--) if(WHATSAPP[m].contact===id) WHATSAPP.splice(m,1);
    for(var n=ACTIVITY.length-1;n>=0;n--) if(ACTIVITY[n].contact===id) ACTIVITY.splice(n,1);
  }

  function updateDeal(id, patch){
    var d = DEALS.find(function(x){return x.id===id;}); if(!d) return null;
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

  var EMAILS = [
    {id:"e1", contact:"c2", deal:"d3", folder:"inbox", archived:false, subject:"Documentación para la propuesta de CFO", updated:"10:20 hoy",
      messages:[
        {dir:"in", from:"m.belmonte@grupoventia.com", to:MAILBOX, date:"2026-06-29 09:40", body:"Buenos días,\n\nOs adjunto la documentación solicitada para preparar la propuesta de CFO externo. Quedo a la espera."},
        {dir:"out", from:MAILBOX, to:"m.belmonte@grupoventia.com", date:"2026-06-29 11:02", body:"Gracias Marcos, la revisamos y te contamos esta semana con la propuesta cerrada."},
        {dir:"in", from:"m.belmonte@grupoventia.com", to:MAILBOX, date:"2026-06-30 10:20", body:"Perfecto, ¿para cuándo la tendríais? Tenemos consejo el jueves."}
      ]},
    {id:"e2", contact:"c6", deal:"d7", folder:"inbox", archived:false, subject:"Cambio de asesoría laboral", updated:"Ayer",
      messages:[
        {dir:"in", from:"direccion@clinicasonrisa.es", to:MAILBOX, date:"2026-06-30 08:15", body:"Hola, nos gustaría cambiar de asesoría laboral. Somos 15 empleados y tenemos un despido en marcha."},
        {dir:"out", from:MAILBOX, to:"direccion@clinicasonrisa.es", date:"2026-06-30 09:30", body:"Encantados de ayudaros. Os llamamos hoy mismo para agendar una reunión."}
      ]},
    {id:"e3", contact:"c1", deal:"d1", folder:"facturas", archived:false, subject:"Factura junio — Dirección financiera externa", updated:"05/07",
      messages:[
        {dir:"out", from:MAILBOX, to:"elena@nordialogistica.es", date:"2026-07-05 09:00", body:"Hola Elena, adjuntamos la factura del mes de junio. Cualquier duda nos avisas."},
        {dir:"in", from:"elena@nordialogistica.es", to:MAILBOX, date:"2026-07-05 12:40", body:"Recibido, gracias Juan Manuel."}
      ]},
    {id:"e4", contact:"c7", deal:"d8", folder:"legal", archived:false, subject:"Data room — ronda de financiación", updated:"Lun",
      messages:[
        {dir:"in", from:"ivan@techflow.io", to:MAILBOX, date:"2026-06-28 17:20", body:"Os comparto acceso al data room para que preparéis el modelo financiero de cara a la ronda."}
      ]},
    {id:"e5", contact:null, deal:null, folder:"inbox", archived:false, subject:"Consulta sobre servicios de asesoría", updated:"08:10",
      messages:[
        {dir:"in", from:"contacto@nuevaempresa.es", to:MAILBOX, date:"2026-07-06 08:10", body:"Buenos días, nos gustaría información sobre vuestros servicios de asesoría fiscal y contable para una empresa de nueva creación."}
      ]},
    {id:"e6", contact:"c10", deal:"d11", folder:"fiscal", archived:true, subject:"Planificación fiscal internacional — borrador", updated:"22/06",
      messages:[
        {dir:"out", from:MAILBOX, to:"lucia@bionatura.es", date:"2026-06-22 16:00", body:"Lucía, adjuntamos el primer borrador de la planificación fiscal internacional para vuestra revisión."},
        {dir:"in", from:"lucia@bionatura.es", to:MAILBOX, date:"2026-06-23 09:15", body:"Gracias, lo revisamos y os comentamos."}
      ]},
    {id:"e7", contact:"c14", deal:"d15", folder:"inbox", archived:false, subject:"Compliance y protección de datos — cooperativa", updated:"01/07",
      messages:[
        {dir:"in", from:"imoreno@agrovalle.coop", to:MAILBOX, date:"2026-07-01 11:00", body:"¿Habéis podido revisar el tema de protección de datos de la cooperativa?"}
      ]}
  ];

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
      utm: (row.servicio||"") + (row.lang==="en"?" \u00b7 EN":""),
      kyc:false, registered:false,
      created: created.slice(0,10),
      employees: null,
      _lead:true, _mensaje: row.mensaje||""
    };
  }
  // Carga los leads de Supabase y los inyecta como contactos (una sola vez, al arrancar)
  async function loadWebLeads(client){
    if(!client) return 0;
    try{
      var res = await client.from("leads").select("*").order("created_at",{ascending:false});
      if(res.error || !res.data) return 0;
      var n = 0;
      res.data.forEach(function(row){
        var c = leadToContact(row);
        if(contactById[c.id]) return; // evitar duplicados
        CONTACTS.unshift(c);
        contactById[c.id] = c;
        var at = (row.created_at||"").toString().replace("T"," ").slice(0,16);
        if(c._mensaje){
          NOTES.push({id:"n-"+row.id, contact:c.id, deal:null, author:null, created:at, body:c._mensaje});
        }
        ACTIVITY.unshift({contact:c.id, type:"contact", at:at, who:null, text:"Contacto creado desde el formulario web"});
        n++;
      });
      return n;
    }catch(e){ if(window.console) console.error("loadWebLeads:", e); return 0; }
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
    fmtEUR:fmtEUR, initials:initials, colorFor:colorFor, computeKpis:computeKpis, loadWebLeads:loadWebLeads, loadContactos:loadContactos,
    updateContact:updateContact, removeDeal:removeDeal, removeContact:removeContact,
    updateDeal:updateDeal, addDocument:addDocument, removeDocument:removeDocument, WA_TEMPLATES:WA_TEMPLATES, setArchived:setArchived,
    MAILBOX:MAILBOX, FOLDERS:FOLDERS, folderById:folderById, EMAILS:EMAILS, unreadOf:unreadOf,
    addFolder:addFolder, removeFolder:removeFolder, moveEmailToFolder:moveEmailToFolder,
    setEmailArchived:setEmailArchived, linkEmail:linkEmail, addEmailReply:addEmailReply, addEmailThread:addEmailThread
  };
})();
