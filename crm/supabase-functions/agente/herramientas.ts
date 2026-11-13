// Herramientas del agente (fase 1: solo lectura). Cada una es una RPC de
// crm/supabase-agente.sql: herramienta "x" → public.agente_x, parámetro "y" →
// argumento "p_y". agente_test.ts comprueba que nombres y parámetros
// coinciden con las firmas del SQL.
//
// La base de datos ya valida y recorta (límites de filas, textos); aquí se
// valida otra vez la entrada del modelo contra el esquema antes de llamar a
// nada: lo que no pase no llega a la base de datos.

import type Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { ETAPAS, SERVICIOS } from "../_shared/catalogos.ts";

type Propiedad =
  | { type: "string"; description: string; format?: "uuid" | "fecha"; enum?: string[]; maxLength?: number }
  | { type: "integer"; description: string; minimum: number; maximum: number }
  | { type: "boolean"; description: string }
  | { type: "array"; description: string; items: { type: "string"; enum: string[] }; maxItems: number };

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
];

/** Definiciones para la API de Claude (orden estable: no romper la caché).
 *  "fecha" es un formato propio (lo valida validarEntrada): a la API solo
 *  le llega la descripción, que ya explica el formato. */
export const HERRAMIENTAS_API: Anthropic.Beta.BetaTool[] = HERRAMIENTAS.map((h) => ({
  name: h.name,
  description: h.description,
  input_schema: {
    ...h.input_schema,
    properties: Object.fromEntries(Object.entries(h.input_schema.properties).map(([k, p]) => {
      if ("format" in p && p.format === "fecha") {
        const { format: _f, ...resto } = p;
        return [k, resto];
      }
      return [k, p];
    })),
  } as unknown as Anthropic.Beta.BetaTool.InputSchema,
}));

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export type Validacion = { ok: true; rpc: string; args: Record<string, unknown> } | { ok: false; error: string };

/** Valida la entrada del modelo y la traduce a la llamada RPC. */
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
        if (p.format === "uuid" && !RE_UUID.test(v)) return mal("tiene que ser un id (uuid)");
        if (p.format === "fecha" && (!RE_FECHA.test(v) || Number.isNaN(Date.parse(v.replace(" ", "T"))))) {
          return mal("fecha no válida (AAAA-MM-DD)");
        }
        if (p.enum && !p.enum.includes(v)) return mal(`valores válidos: ${p.enum.join(", ")}`);
        break;
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v)) return mal("tiene que ser un número entero");
        if (v < p.minimum || v > p.maximum) return mal(`entre ${p.minimum} y ${p.maximum}`);
        break;
      case "boolean":
        if (typeof v !== "boolean") return mal("tiene que ser true o false");
        break;
      case "array":
        if (!Array.isArray(v) || v.length > p.maxItems) return mal(`tiene que ser una lista de como mucho ${p.maxItems}`);
        if (v.some((x) => typeof x !== "string" || !p.items.enum.includes(x))) return mal(`valores válidos: ${p.items.enum.join(", ")}`);
        break;
    }
    args[`p_${k}`] = v;
  }
  return { ok: true, rpc: `agente_${h.name}`, args };
}
