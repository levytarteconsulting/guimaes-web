// Herramientas del agente. Las de consulta del CRM son RPC de
// crm/supabase-agente.sql: herramienta "x" → public.agente_x, parámetro "y" →
// argumento "p_y". agente_test.ts comprueba que nombres y parámetros
// coinciden con las firmas del SQL.
// Las holded_* van a la Edge Function holded-proxy (consulta "x" de
// holded_x, con empresa_id y el resto como params); holded-proxy vuelve a
// validar todo y solo hace GET a una lista cerrada de rutas de Holded.
//
// Las proponer_* (escrituras en el CRM) NO escriben: van todas a
// agente_proponer (crm/supabase-agente-escritura.sql), que valida y guarda una
// propuesta; el CRM la enseña como tarjeta y solo escribe agente_confirmar,
// cuando el usuario pulsa Confirmar.
//
// La base de datos ya valida y recorta (límites de filas, textos); aquí se
// valida otra vez la entrada del modelo contra el esquema antes de llamar a
// nada: lo que no pase no llega a la base de datos.

import type Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { CICLO_VIDA, ETAPAS, MOTIVOS_PERDIDA, PRIORIDADES, SERVICIOS } from "../_shared/catalogos.ts";

type Propiedad =
  | { type: "string"; description: string; format?: "uuid" | "fecha" | "dia"; enum?: string[]; maxLength?: number; minLength?: number }
  | { type: "integer"; description: string; minimum: number; maximum: number }
  | { type: "number"; description: string; minimum: number; maximum: number }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items: { type: "string"; enum?: string[]; format?: "uuid"; maxLength?: number }; maxItems: number }
  | { type: "object"; description: string; maxBytes: number };

export type Herramienta = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, Propiedad>; required: string[]; additionalProperties: false };
};

const uuid = (description: string): Propiedad => ({ type: "string", format: "uuid", description });
const fecha = (description: string): Propiedad => ({
  type: "string", format: "fecha",
  description: `${description} Formato AAAA-MM-DD, o AAAA-MM-DDTHH:MM con zona (+01:00) si importa la hora.`,
});
const dia = (description: string): Propiedad => ({
  type: "string", format: "dia", description: `${description} Formato AAAA-MM-DD.`,
});
const empresaHolded = uuid("Id de la empresa en el CRM (de buscar). Tiene que tener Holded conectado.");
const limite = (porDefecto: number, max: number): Propiedad => ({
  type: "integer", minimum: 1, maximum: max, description: `Máximo de filas (por defecto ${porDefecto}, como mucho ${max}).`,
});
const herramienta = (name: string, description: string, properties: Record<string, Propiedad>, required: string[] = []): Herramienta =>
  ({ name, description, input_schema: { type: "object", properties, required, additionalProperties: false } });

export const HERRAMIENTAS: readonly Herramienta[] = [
  herramienta("buscar",
    "Busca por texto en empresas (razón social, CIF), contactos (nombre, email, empresa, DNI, teléfono) y negocios (título). " +
    "No distingue acentos ni mayúsculas. Úsala primero para conseguir los id que piden las demás herramientas.",
    {
      q: { type: "string", maxLength: 200, description: "Texto a buscar (al menos 2 caracteres)." },
      tipos: { type: "array", maxItems: 3, items: { type: "string", enum: ["empresa", "contacto", "deal"] },
               description: "Limitar a estos tipos. Por defecto, los tres." },
      limite: limite(10, 25),
    }, ["q"]),
  herramienta("ficha_empresa",
    "Ficha de una empresa: datos, contactos (con el principal), negocios, tareas abiertas, solicitudes del área de cliente " +
    "pendientes y recuentos de documentos, correos y conversaciones de WhatsApp.",
    { empresa_id: uuid("Id de la empresa.") }, ["empresa_id"]),
  herramienta("ficha_contacto",
    "Ficha de un contacto: datos, empresas, negocios, tareas abiertas, últimas notas, formularios de origen y si tiene cuenta " +
    "en el área de cliente.",
    { contact_id: uuid("Id del contacto.") }, ["contact_id"]),
  herramienta("listar_deals",
    "Lista negocios del pipeline con filtros. Devuelve también el total y un resumen por etapa con los importes separados " +
    "por frecuencia (no sumes importes mensuales con anuales).",
    {
      etapa: { type: "string", enum: ETAPAS.map((e) => e.id), description: "Etapa del pipeline." },
      servicio: { type: "string", enum: SERVICIOS.map((s) => s.id), description: "Servicio (código s1…s7)." },
      owner: { type: "string", maxLength: 100, description: "Id del responsable (id de la lista de usuarios del CRM)." },
      empresa_id: uuid("Solo los de esta empresa."),
      contact_id: uuid("Solo los de este contacto."),
      renovacion_antes: fecha("Renovación en esta fecha o antes (ordena por renovación)."),
      firmado_desde: fecha("Firmados en esta fecha o después."),
      limite: limite(25, 50),
    }),
  herramienta("listar_tareas",
    "Lista tareas por estado, responsable, vencimiento, contacto o negocio. Por defecto excluye las archivadas.",
    {
      estado: { type: "string", enum: ["pending", "done"], description: "pending = pendiente, done = hecha." },
      asignada_a: { type: "string", maxLength: 100, description: "Id del responsable (id de la lista de usuarios del CRM)." },
      vencidas: { type: "boolean", description: "Solo las vencidas y no hechas." },
      vencen_antes: fecha("Vencen en esta fecha o antes."),
      contact_id: uuid("Solo las de este contacto."),
      deal_id: uuid("Solo las de este negocio."),
      incluir_archivadas: { type: "boolean", description: "Incluir también las archivadas." },
      limite: limite(25, 50),
    }),
  herramienta("listar_documentos",
    "Lista documentos de una empresa (solo nombre, carpeta, tipo, tamaño, fecha y origen; no lee su contenido).",
    {
      empresa_id: uuid("Id de la empresa."),
      carpeta_id: uuid("Solo esta carpeta y sus subcarpetas."),
      q: { type: "string", maxLength: 200, description: "Texto en el nombre del fichero." },
      origen: { type: "string", enum: ["manual", "whatsapp", "cliente"],
                description: "manual = subido por el despacho; whatsapp = recibido por WhatsApp; cliente = subido desde el área de cliente." },
      desde: fecha("Subidos en esta fecha o después."),
      limite: limite(30, 100),
    }, ["empresa_id"]),
  herramienta("listar_conversaciones_whatsapp",
    "Lista conversaciones de WhatsApp con su último mensaje. Sirve para ver qué está sin responder (el último mensaje es del cliente).",
    {
      contact_id: uuid("Solo las de este contacto."),
      sin_responder: { type: "boolean", description: "Solo aquellas cuyo último mensaje es del cliente." },
      incluir_archivadas: { type: "boolean", description: "Incluir también las archivadas." },
      limite: limite(20, 50),
    }),
  herramienta("leer_whatsapp",
    "Lee los mensajes más recientes de una conversación de WhatsApp, en orden cronológico.",
    {
      conversation_id: uuid("Id de la conversación."),
      desde: fecha("Solo mensajes desde esta fecha."),
      limite: limite(30, 80),
    }, ["conversation_id"]),
  herramienta("buscar_correos",
    "Busca en el buzón info@ (recibidos y enviados) por texto (asunto, extracto, remitente, direcciones), contacto, empresa o fechas. " +
    "Devuelve extractos; para el cuerpo completo usa leer_correo.",
    {
      q: { type: "string", maxLength: 200, description: "Texto a buscar." },
      contact_id: uuid("Solo los vinculados a este contacto."),
      empresa_id: uuid("Solo los vinculados a esta empresa."),
      carpeta: { type: "string", enum: ["inbox", "sentitems"], description: "inbox = recibidos; sentitems = enviados." },
      desde: fecha("Desde esta fecha (incluida)."),
      hasta: fecha("Hasta esta fecha (no incluida)."),
      no_leidos: { type: "boolean", description: "Solo recibidos sin leer." },
      limite: limite(15, 40),
    }),
  herramienta("leer_correo",
    "Lee un correo: remitente, destinatarios, asunto, cuerpo en texto plano (hasta 8.000 caracteres) y adjuntos.",
    { mensaje_id: uuid("Id del correo (de buscar_correos).") }, ["mensaje_id"]),
  herramienta("listar_leads",
    "Lista solicitudes recibidas por los formularios de la web y de Meta (leads), con su origen y campaña.",
    {
      desde: fecha("Recibidos en esta fecha o después."),
      estado: { type: "string", maxLength: 50, description: "Estado del lead (p. ej. new, converted). Los borrados solo salen si se piden con deleted." },
      servicio: { type: "string", maxLength: 100, description: "Servicio pedido, tal como llega del formulario." },
      origen: { type: "string", maxLength: 100, description: "Origen (source) del lead." },
      limite: limite(25, 50),
    }),
  herramienta("resumen_actividad",
    "Resumen de un periodo (máximo un año): leads, contactos y negocios nuevos, firmas, pipeline actual, tareas vencidas, " +
    "correos y WhatsApp sin atender y pendientes del área de cliente. Solo recuentos.",
    {
      desde: fecha("Inicio del periodo."),
      hasta: fecha("Fin del periodo (por defecto, ahora)."),
    }, ["desde"]),
  // ---------------------------------------------------------------- escrituras en el CRM (solo proponen)
  herramienta("buscar_duplicados",
    "Antes de proponer una empresa o un contacto nuevos: busca si ya existen por CIF/NIF, email, teléfono, DNI o nombre " +
    "normalizado (sin acentos ni forma jurídica). Si hay coincidencias, enséñalas y propón usar la existente.",
    {
      razon_social: { type: "string", maxLength: 200, description: "Razón social de la empresa." },
      cif: { type: "string", maxLength: 20, description: "CIF/NIF de la empresa." },
      full_name: { type: "string", maxLength: 200, description: "Nombre y apellidos del contacto." },
      email: { type: "string", maxLength: 254, description: "Email del contacto." },
      phone: { type: "string", maxLength: 40, description: "Teléfono del contacto." },
      dni: { type: "string", maxLength: 20, description: "DNI/NIE del contacto." },
    }),
  herramienta("proponer_empresa",
    "PROPONE crear una empresa (sin empresa_id) o modificar una existente (con empresa_id: pasa solo los campos que cambian; " +
    "\"\" vacía un campo). NO escribe: el usuario ve una tarjeta con los datos y la confirma. Antes de crear, usa buscar_duplicados.",
    {
      empresa_id: uuid("Solo para modificar: id de la empresa."),
      razon_social: { type: "string", maxLength: 200, description: "Razón social (obligatoria al crear)." },
      cif: { type: "string", maxLength: 20, description: "CIF/NIF." },
      address: { type: "string", maxLength: 300, description: "Dirección." },
      city: { type: "string", maxLength: 100, description: "Población." },
      province: { type: "string", maxLength: 100, description: "Provincia." },
      empleados: { type: "integer", minimum: 0, maximum: 1000000, description: "Número de empleados." },
    }),
  herramienta("proponer_contacto",
    "PROPONE crear un contacto (sin contact_id: con empresa_id de una empresa existente o nueva_empresa) o modificar uno " +
    "(con contact_id: solo los campos que cambian; \"\" vacía un campo). Para cambiar sus empresas usa " +
    "proponer_empresa_de_contacto. NO escribe: el usuario confirma en una tarjeta. Antes de crear, usa buscar_duplicados.",
    {
      contact_id: uuid("Solo para modificar: id del contacto."),
      full_name: { type: "string", maxLength: 200, description: "Nombre y apellidos (obligatorio al crear)." },
      email: { type: "string", maxLength: 254, description: "Email." },
      phone: { type: "string", maxLength: 40, description: "Teléfono." },
      dni: { type: "string", maxLength: 20, description: "DNI/NIE." },
      city: { type: "string", maxLength: 100, description: "Población." },
      province: { type: "string", maxLength: 100, description: "Provincia." },
      employees: { type: "integer", minimum: 0, maximum: 1000000, description: "Empleados (dato del contacto)." },
      lifecycle: { type: "string", enum: CICLO_VIDA.map((o) => o.id), description: "Ciclo de vida (por defecto new)." },
      priority: { type: "string", enum: PRIORIDADES.map((o) => o.id), description: "Prioridad." },
      owner: { type: "string", maxLength: 100, description: "Responsable: id de la lista de usuarios del CRM." },
      source: { type: "string", maxLength: 100, description: "Origen (por defecto «Alta manual»)." },
      kyc: { type: "boolean", description: "KYC hecho." },
      empresa_id: uuid("Solo al crear: id de la empresa existente a la que pertenece."),
      nueva_empresa: { type: "object", maxBytes: 4000,
                       description: "Solo al crear y si la empresa no existe: { razon_social, cif, address, city, province, empleados }." },
    }),
  herramienta("proponer_empresa_de_contacto",
    "PROPONE cambiar las empresas de un contacto: añadir una empresa, ponerla como principal o quitarla (un contacto siempre " +
    "tiene al menos una). NO escribe: el usuario confirma en una tarjeta.",
    {
      contact_id: uuid("Id del contacto."),
      empresa_id: uuid("Id de la empresa."),
      accion: { type: "string", enum: ["anadir", "principal", "quitar"],
                description: "anadir = añadirla; principal = añadirla si hace falta y ponerla como principal; quitar = quitarla." },
    }, ["contact_id", "empresa_id", "accion"]),
  herramienta("proponer_negocio",
    "PROPONE crear un negocio del pipeline (sin deal_id: title y contact_id obligatorios) o modificar uno (con deal_id: solo " +
    "lo que cambia; \"\" vacía un campo). NO escribe: el usuario confirma en una tarjeta.",
    {
      deal_id: uuid("Solo para modificar: id del negocio."),
      title: { type: "string", maxLength: 200, description: "Título." },
      contact_id: uuid("Contacto del negocio."),
      empresa_id: uuid("Empresa del negocio (si falta, el CRM pone la principal del contacto)."),
      service: { type: "string", enum: SERVICIOS.map((x) => x.id), description: "Servicio (s1…s7)." },
      stage: { type: "string", enum: ETAPAS.map((e) => e.id), description: "Etapa (por defecto reunion)." },
      owner: { type: "string", maxLength: 100, description: "Responsable: id de la lista de usuarios del CRM." },
      amount: { type: "number", minimum: 0, maximum: 100000000, description: "Importe en euros, sin IVA." },
      frequency: { type: "string", enum: ["mensual", "anual", "puntual"], description: "Frecuencia del importe." },
      priority: { type: "string", enum: PRIORIDADES.map((o) => o.id), description: "Prioridad." },
      loss_reason: { type: "string", enum: MOTIVOS_PERDIDA.map((o) => o.id), description: "Motivo de pérdida (etapa perdido)." },
      signed_at: dia("Fecha de firma."),
      renewal_at: dia("Fecha de renovación."),
      num_nominas: { type: "integer", minimum: 0, maximum: 100000, description: "Número de nóminas (servicio laboral)." },
      coste_nomina: { type: "number", minimum: 0, maximum: 1000000, description: "Coste por nómina en euros." },
    }),
  herramienta("proponer_tarea",
    "PROPONE crear una tarea (sin tarea_id: title obligatorio) o modificarla (con tarea_id: solo lo que cambia), incluida la " +
    "asignación a un usuario. NO escribe: el usuario confirma en una tarjeta. Asignarla avisa a esa persona.",
    {
      tarea_id: uuid("Solo para modificar: id de la tarea."),
      title: { type: "string", maxLength: 300, description: "Título." },
      assigned_to: { type: "string", maxLength: 100, description: "Responsable: id de la lista de usuarios del CRM." },
      due_at: fecha("Vencimiento (solo la fecha = 09:00 en Madrid)."),
      contact_id: uuid("Contacto de la tarea."),
      deal_id: uuid("Negocio de la tarea."),
      status: { type: "string", enum: ["pending", "done"], description: "pending = pendiente; done = hecha (también la archiva)." },
      archived: { type: "boolean", description: "Archivada." },
    }),
  herramienta("proponer_nota",
    "PROPONE añadir una nota a un contacto o a un negocio. NO escribe: el usuario confirma en una tarjeta.",
    {
      body: { type: "string", minLength: 1, maxLength: 5000, description: "Texto de la nota." },
      contact_id: uuid("Contacto de la nota."),
      deal_id: uuid("Negocio de la nota."),
    }, ["body"]),
  herramienta("proponer_borrado",
    "PROPONE borrar un contacto, un negocio, una tarea o una nota. NO borra: el usuario tiene que escribir BORRAR en la " +
    "tarjeta. Las empresas no se borran desde aquí: enlaza la empresa y di que se borra desde su ficha.",
    {
      tipo: { type: "string", enum: ["contacto", "negocio", "tarea", "nota"], description: "Qué se borra." },
      id: uuid("Id del registro."),
    }, ["tipo", "id"]),
  herramienta("proponer_correo",
    "Redacta un correo desde info@guimaes.es. NO lo envía: crea una tarjeta en el chat con destinatarios, asunto, texto y adjuntos; " +
    "solo un usuario con rol admin puede enviarlo pulsando Enviar. Cualquier usuario puede pedir que lo redactes. " +
    "Usa los emails que da el CRM (ficha_contacto, buscar); no te inventes direcciones. Vincúlalo al contacto o la empresa (contact_id, " +
    "empresa_id) para que el enviado quede en su ficha. Adjuntos: solo documentos de la empresa del correo (ids de listar_documentos).",
    {
      para: { type: "array", maxItems: 50, items: { type: "string", maxLength: 254 }, description: "Destinatarios (emails)." },
      cc: { type: "array", maxItems: 50, items: { type: "string", maxLength: 254 }, description: "En copia." },
      cco: { type: "array", maxItems: 50, items: { type: "string", maxLength: 254 }, description: "En copia oculta." },
      asunto: { type: "string", maxLength: 255, description: "Asunto." },
      texto: { type: "string", maxLength: 20000, description: "Cuerpo en texto plano; los saltos de línea se respetan. Sin firma inventada." },
      contact_id: uuid("Contacto al que va (para guardarlo en su ficha)."),
      empresa_id: uuid("Empresa del correo. Obligatoria si hay adjuntos; si no se da, la principal del contacto."),
      documentos: { type: "array", maxItems: 10, items: { type: "string", format: "uuid" }, description: "Ids de documentos de la empresa para adjuntar (como mucho 10, 25 MB en total)." },
    }, ["para", "asunto", "texto"]),
  // ---------------------------------------------------------------- Holded (holded-proxy)
  herramienta("holded_facturas",
    "Holded de una empresa cliente: facturas emitidas (ventas) o recibidas (compras y gastos) de un periodo, con totales " +
    "(base, impuestos, total y pendiente de cobro o pago) y la lista de documentos. Borradores y anuladas no cuentan en los totales.",
    {
      empresa_id: empresaHolded,
      tipo: { type: "string", enum: ["emitidas", "recibidas"], description: "emitidas = ventas del cliente; recibidas = sus compras y gastos." },
      desde: dia("Fecha de factura desde (incluida)."),
      hasta: dia("Fecha de factura hasta (incluida). Como mucho 400 días después de desde."),
      estado: { type: "string", enum: ["pending", "completed", "partial", "cancelled", "failed", "overdue", "outstanding"],
                description: "pending = pendiente; completed = cobrada/pagada; partial = cobro parcial; overdue = vencida; outstanding = sin cobrar (pendientes y vencidas); cancelled = anulada." },
      contacto_id: { type: "string", maxLength: 64, description: "Solo las de este contacto de Holded (id de holded_contactos, no del CRM)." },
      rectificativas: { type: "boolean", description: "Incluir también las facturas rectificativas, con sus totales aparte." },
      limite: limite(50, 100),
    }, ["empresa_id", "tipo", "desde", "hasta"]),
  herramienta("holded_resumen",
    "Holded de una empresa cliente: resumen de un periodo calculado con sus facturas: ingresos y gastos (base imponible, netos de " +
    "rectificativas), resultado e impuestos repercutidos y soportados (aproximación al IVA, no la liquidación).",
    { empresa_id: empresaHolded, desde: dia("Inicio del periodo."), hasta: dia("Fin del periodo (incluido). Como mucho 400 días.") },
    ["empresa_id", "desde", "hasta"]),
  herramienta("holded_contactos",
    "Holded de una empresa cliente: sus contactos (clientes, proveedores…), buscando por nombre o listando por tipo. " +
    "Devuelve el id de Holded que usa holded_facturas en contacto_id.",
    {
      empresa_id: empresaHolded,
      nombre: { type: "string", minLength: 2, maxLength: 100, description: "Texto a buscar en el nombre." },
      tipo: { type: "string", enum: ["client", "supplier", "lead", "debtor", "creditor"],
              description: "client = cliente; supplier = proveedor; lead = potencial; debtor = deudor; creditor = acreedor." },
      limite: limite(25, 100),
    }, ["empresa_id"]),
  herramienta("holded_tesoreria",
    "Holded de una empresa cliente: cuentas de tesorería (bancos, caja) con su saldo según Holded.",
    { empresa_id: empresaHolded }, ["empresa_id"]),  // ---------------------------------------------------------------- Holded: acciones (holded-acciones)
  herramienta("holded_proponer_operacion",
    "PROPONE cualquier otra operación de escritura en Holded de una empresa cliente (crear, modificar o borrar contactos, " +
    "productos, presupuestos, facturas en borrador, gastos…), para que un administrador la revise y la apruebe en Acciones. " +
    "NO ejecuta nada. Solo operaciones de la lista cerrada de la API v2: antes, consulta holded_documentacion y usa " +
    "exactamente sus rutas y nombres de campos. Para aprobar tickets de venta usa holded_proponer_accion.",
    {
      empresa_id: empresaHolded,
      metodo: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"], description: "Método HTTP de la operación (de holded_documentacion)." },
      ruta: { type: "string", minLength: 2, maxLength: 300,
              description: "Ruta de la API v2 sin /api/v2, con los ids reales de Holded: /contacts, /invoices/6b09… " +
                           "Con lote.ids, pon {id} donde va cada id: /contacts/{id}." },
      cuerpo: { type: "object", maxBytes: 60_000,
                description: "Cuerpo JSON exacto de la petición, con los campos de holded_documentacion. Sin cuerpo en DELETE y en las que no lo llevan. " +
                             "Ojo: PUT reemplaza el documento entero (incluye todos los campos que deban quedarse)." },
      lote: { type: "object", maxBytes: 60_000,
              description: "Opcional, para la misma operación sobre varios documentos (como mucho 100): { \"ids\": [ids de Holded] } " +
                           "(con {id} en la ruta y el mismo cuerpo) o { \"cuerpos\": [un cuerpo por documento] }." },
      descripcion: { type: "string", minLength: 3, maxLength: 300,
                     description: "Qué hace, en castellano y con los datos clave, para quien la aprueba: \"Emitir factura en borrador a Cliente X por 500 € + 21 % IVA\"." },
    }, ["empresa_id", "metodo", "ruta", "descripcion"]),
  herramienta("holded_documentacion",
    "Referencia de la API v2 de Holded (de su documentación oficial): temas, operaciones de escritura con su ruta, campos " +
    "obligatorios, todos los campos y ejemplos, y las lecturas de cada tema. Úsala antes de proponer una operación: no adivines " +
    "rutas ni nombres de campos. No llama a Holded ni gasta cupo.",
    {
      tema: { type: "string", maxLength: 80, description: "Tema (\"Facturas\", \"Contactos\", \"Productos\"…) o palabras a buscar. Sin tema ni operación, lista los temas." },
      operacion: { type: "string", maxLength: 120, description: "Una operación concreta, por su id (create_invoice) o \"MÉTODO /ruta\" (POST /invoices)." },
    }),
  herramienta("holded_proponer_accion",
    "PROPONE una acción de escritura en Holded de una empresa cliente para que un administrador la revise y la apruebe en la " +
    "pantalla Acciones del CRM. NO ejecuta nada: solo prepara la propuesta (resumen, muestra, excluidos y avisos). " +
    "Por ahora solo aprobar_tickets_venta: aprobar los tickets de venta pendientes, del más antiguo al más reciente, en un " +
    "rango de fechas cerrado (días completos).",
    {
      empresa_id: empresaHolded,
      tipo: { type: "string", enum: ["aprobar_tickets_venta"], description: "aprobar_tickets_venta = aprobar tickets de venta pendientes (borradores)." },
      max_documentos: { type: "integer", minimum: 1, maximum: 1000, description: "Máximo de documentos de la propuesta (1 a 1.000)." },
      desde: dia("Solo tickets con fecha desde este día (incluido)."),
      hasta: dia("Solo tickets con fecha hasta este día (incluido)."),
    }, ["empresa_id", "tipo", "max_documentos"]),
];

/** Herramientas que van a holded-proxy o, la de proponer, a holded-acciones
 *  (sus resultados no se guardan). */
export const esHolded = (nombre: string) => nombre.startsWith("holded_");

/** Definiciones para la API de Claude (orden estable: no romper la caché).
 *  "fecha" es un formato propio (lo valida validarEntrada): a la API solo
 *  le llega la descripción, que ya explica el formato. */
export const HERRAMIENTAS_API: Anthropic.Beta.BetaTool[] = HERRAMIENTAS.map((h) => ({
  name: h.name,
  description: h.description,
  input_schema: {
    ...h.input_schema,
    properties: Object.fromEntries(Object.entries(h.input_schema.properties).map(([k, p]) => {
      if (p.type === "object") return [k, { type: "object", description: p.description }];
      if ("format" in p && (p.format === "fecha" || p.format === "dia")) {
        const { format: _f, ...resto } = p;
        return [k, resto];
      }
      return [k, p];
    })),
  } as unknown as Anthropic.Beta.BetaTool.InputSchema,
}));

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export type LlamadaHolded = { consulta: string; empresa_id: string; params: Record<string, unknown> };
export type Validacion =
  | { ok: true; rpc: string; args: Record<string, unknown> }
  | { ok: true; holded: LlamadaHolded }
  | { ok: true; local: "documentacion"; args: { tema?: string; operacion?: string } }
  | { ok: true; propuesta: { tipo: string; registro: string | null; datos: Record<string, unknown> } }
  | { ok: true; correo: Record<string, unknown> }
  | { ok: false; error: string };

/** Valida la entrada del modelo y la traduce a la llamada RPC (o a holded-proxy). */
export function validarEntrada(nombre: string, entrada: unknown): Validacion {
  const h = HERRAMIENTAS.find((x) => x.name === nombre);
  if (!h) return { ok: false, error: `No existe la herramienta "${nombre}".` };
  if (typeof entrada !== "object" || entrada === null || Array.isArray(entrada)) {
    return { ok: false, error: "La entrada tiene que ser un objeto JSON." };
  }
  const props = h.input_schema.properties;
  const args: Record<string, unknown> = {};
  for (const k of h.input_schema.required) {
    if ((entrada as Record<string, unknown>)[k] === undefined || (entrada as Record<string, unknown>)[k] === null) {
      return { ok: false, error: `Falta el parámetro obligatorio "${k}".` };
    }
  }
  for (const [k, v] of Object.entries(entrada as Record<string, unknown>)) {
    const p = props[k];
    if (!p) return { ok: false, error: `Parámetro desconocido "${k}".` };
    if (v === null || v === undefined) continue;
    const mal = (que: string) => ({ ok: false as const, error: `"${k}": ${que}.` });
    switch (p.type) {
      case "string":
        if (typeof v !== "string") return mal("tiene que ser texto");
        if (p.maxLength && v.length > p.maxLength) return mal(`como mucho ${p.maxLength} caracteres`);
        if (p.minLength && v.trim().length < p.minLength) return mal(`al menos ${p.minLength} caracteres`);
        if (p.format === "uuid" && !RE_UUID.test(v)) return mal("tiene que ser un id (uuid)");
        if (p.format === "fecha" && (!RE_FECHA.test(v) || Number.isNaN(Date.parse(v.replace(" ", "T"))))) {
          return mal("fecha no válida (AAAA-MM-DD)");
        }
        if (p.format === "dia" && (!RE_DIA.test(v) || Number.isNaN(Date.parse(v)) || new Date(Date.parse(v)).toISOString().slice(0, 10) !== v)) {
          return mal("fecha no válida (AAAA-MM-DD, sin hora)");
        }
        if (p.enum && !p.enum.includes(v)) return mal(`valores válidos: ${p.enum.join(", ")}`);
        break;
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v)) return mal("tiene que ser un número entero");
        if (v < p.minimum || v > p.maximum) return mal(`entre ${p.minimum} y ${p.maximum}`);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) return mal("tiene que ser un número");
        if (v < p.minimum || v > p.maximum) return mal(`entre ${p.minimum} y ${p.maximum}`);
        break;
      case "boolean":
        if (typeof v !== "boolean") return mal("tiene que ser true o false");
        break;
      case "object":
        if (typeof v !== "object" || Array.isArray(v)) return mal("tiene que ser un objeto JSON");
        if (new TextEncoder().encode(JSON.stringify(v)).length > p.maxBytes) return mal(`como mucho ${Math.round(p.maxBytes / 1000)} KB`);
        break;
      case "array":
        if (!Array.isArray(v) || v.length > p.maxItems) return mal(`tiene que ser una lista de como mucho ${p.maxItems}`);
        if (v.some((x) => typeof x !== "string")) return mal("tiene que ser una lista de textos");
        if (p.items.enum && v.some((x) => !p.items.enum!.includes(x))) return mal(`valores válidos: ${p.items.enum.join(", ")}`);
        if (p.items.format === "uuid" && v.some((x) => !RE_UUID.test(x))) return mal("tiene que ser una lista de id (uuid)");
        if (p.items.maxLength && v.some((x) => x.length > p.items.maxLength!)) return mal(`cada uno, como mucho ${p.items.maxLength} caracteres`);
        break;
    }
    args[k] = v;
  }
  if (h.name === "holded_documentacion") return { ok: true, local: "documentacion", args: args as { tema?: string; operacion?: string } };
  if (h.name === "proponer_correo") {
    const datos = { ...args } as Record<string, unknown>;
    for (const k of ["contact_id", "empresa_id"]) if (typeof datos[k] === "string") datos[k] = (datos[k] as string).toLowerCase();
    if (Array.isArray(datos.documentos)) datos.documentos = (datos.documentos as string[]).map((x) => x.toLowerCase());
    return { ok: true, correo: datos };
  }
  if (h.name.startsWith("proponer_")) return propuestaDe(h.name, args);
  if (esHolded(h.name)) {
    const { empresa_id, ...params } = args;
    return { ok: true, holded: { consulta: h.name.slice("holded_".length), empresa_id: String(empresa_id).toLowerCase(), params } };
  }
  return { ok: true, rpc: `agente_${h.name}`, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [`p_${k}`, v])) };
}

// ---------------------------------------------------------------- proponer_* → agente_proponer(tipo, registro, datos)
const ID_DE: Record<string, [string, string, string]> = {   // herramienta → [campo id, tipo al crear, tipo al modificar]
  proponer_empresa: ["empresa_id", "crear_empresa", "modificar_empresa"],
  proponer_contacto: ["contact_id", "crear_contacto", "modificar_contacto"],
  proponer_negocio: ["deal_id", "crear_deal", "modificar_deal"],
  proponer_tarea: ["tarea_id", "crear_tarea", "modificar_tarea"],
};
const BORRAR: Record<string, string> = { contacto: "borrar_contacto", negocio: "borrar_deal", tarea: "borrar_tarea", nota: "borrar_nota" };

function propuestaDe(nombre: string, args: Record<string, unknown>): Validacion {
  const ok = (tipo: string, registro: unknown, datos: Record<string, unknown>): Validacion =>
    ({ ok: true, propuesta: { tipo, registro: typeof registro === "string" ? registro.toLowerCase() : null, datos } });
  if (nombre === "proponer_nota") return ok("crear_nota", null, args);
  if (nombre === "proponer_borrado") return ok(BORRAR[String(args.tipo)], args.id, {});
  if (nombre === "proponer_empresa_de_contacto") {
    const datos = { empresa_id: args.empresa_id, ...(args.accion === "quitar" ? {} : { principal: args.accion === "principal" }) };
    return ok(args.accion === "quitar" ? "desvincular_empresa" : "vincular_empresa", args.contact_id, datos);
  }
  const [campo, crear, modificar] = ID_DE[nombre];
  const { [campo]: id, ...datos } = args;
  if (id && nombre === "proponer_contacto" && ("empresa_id" in datos || "nueva_empresa" in datos)) {
    return { ok: false, error: "Para cambiar las empresas de un contacto existente usa proponer_empresa_de_contacto." };
  }
  if (id && !Object.keys(datos).length) return { ok: false, error: "No hay ningún campo que cambiar." };
  return ok(id ? modificar : crear, id, datos);
}
