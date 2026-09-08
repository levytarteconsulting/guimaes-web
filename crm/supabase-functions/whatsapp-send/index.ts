// Supabase Edge Function: whatsapp-send
// Envía un mensaje de WhatsApp (texto libre o plantilla aprobada) vía la Cloud
// API de Meta y lo guarda en public.whatsapp_messages (esquema en
// crm/supabase-whatsapp.sql). La llama el CRM (navegador autenticado) cuando
// un agente escribe un mensaje o usa una plantilla.
//
// A diferencia de whatsapp-webhook (pública, la llama Meta server-to-server),
// esta función SÍ requiere autenticación de Supabase — solo agentes logueados
// en el CRM pueden enviar mensajes. No lleva verify_jwt = false en config.toml.
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   WHATSAPP_TOKEN              — token permanente de la Cloud API de Meta (System User)
//   WHATSAPP_PHONE_NUMBER_ID    — Phone Number ID de WhatsApp Business (App Dashboard)
//   SUPABASE_URL                 — inyectada automáticamente por Supabase
//   SUPABASE_ANON_KEY            — inyectada automáticamente por Supabase (valida la sesión del agente)
//   SUPABASE_SERVICE_ROLE_KEY    — inyectada automáticamente por Supabase (guarda el mensaje)
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase login
//   supabase link --project-ref zuktsotrcolqdowpbnrx
//   supabase functions deploy whatsapp-send --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v21.0";

// ---- Helpers de inspección de plantillas ----

function extractBodyText(components: any[]): string {
  const body = (components || []).find((c: any) => c.type === "BODY");
  return body?.text || "";
}

// Fuente de verdad del número de variables: el índice MÁXIMO de {{n}} en el
// texto del BODY (no un recuento de valores distintos). Las plantillas reales
// de esta cuenta no traen "example", así que no se puede derivar de ahí (ver
// whatsapp-sync-templates). "gapless" indica si los índices presentes son
// exactamente 1..count sin huecos (p. ej. {{1}} y {{3}} sin {{2}} es un hueco).
function analyzeBodyVariables(bodyText: string): { count: number; gapless: boolean } {
  const matches = (bodyText || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g);
  const numbers = new Set<number>();
  for (const m of matches) numbers.add(Number(m[1]));
  if (numbers.size === 0) return { count: 0, gapless: true };
  const count = Math.max(...numbers);
  let gapless = true;
  for (let i = 1; i <= count; i++) {
    if (!numbers.has(i)) { gapless = false; break; }
  }
  return { count, gapless };
}

function fillBodyText(bodyText: string, variables: string[]): string {
  return (bodyText || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_match, n) => {
    const value = variables[Number(n) - 1];
    return value !== undefined ? value : `{{${n}}}`;
  });
}

// Normaliza un teléfono para WhatsApp: quita espacios/guiones/puntos/paréntesis
// y reconoce '+', '00' (prefijo internacional), código de país español pegado
// sin '+'/'00' (34 + móvil de 9 dígitos) y móviles españoles de 9 dígitos sin
// prefijo (6/7/8 inicial). Devuelve null si no reconoce el formato — en ese
// caso hay que corregir el teléfono a mano en la ficha del contacto.
function normalizePhone(raw: string | null | undefined): { phone: string; waId: string } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s\-.()]/g, "");

  if (cleaned.startsWith("+")) {
    const waId = cleaned.slice(1);
    return /^\d+$/.test(waId) ? { phone: `+${waId}`, waId } : null;
  }
  if (cleaned.startsWith("00")) {
    const waId = cleaned.slice(2);
    return /^\d+$/.test(waId) ? { phone: `+${waId}`, waId } : null;
  }
  // 11 dígitos exactos, "34" + móvil de 9 dígitos (6/7/8 inicial) — sin el
  // dígito 6/7/8 aquí, cualquier número de 11 dígitos de otro país que
  // empezara por "34" (p. ej. un fijo francés) se colaría como español.
  if (/^34[678]\d{8}$/.test(cleaned)) {
    return { phone: `+${cleaned}`, waId: cleaned };
  }
  if (/^[678]\d{8}$/.test(cleaned)) {
    return { phone: `+34${cleaned}`, waId: `34${cleaned}` };
  }
  return null;
}

// Devuelve null si la plantilla es enviable, o un motivo en castellano si no.
// Solo se soportan plantillas POSITIONAL, sin CAROUSEL, con HEADER de texto
// estático (si lo hay) y sin botones de URL dinámica — todo lo demás se
// rechaza explícitamente en vez de construir un payload incorrecto a ciegas.
function templateSendIssue(components: any[], parameterFormat: string | null): string | null {
  const list = components || [];

  if (parameterFormat !== "POSITIONAL") {
    return `Formato de parámetros no soportado (${parameterFormat || "desconocido"}); solo se soportan plantillas POSITIONAL.`;
  }
  if (list.some((c: any) => c.type === "CAROUSEL")) {
    return "Las plantillas con componente CAROUSEL no están soportadas todavía.";
  }

  const header = list.find((c: any) => c.type === "HEADER");
  if (header) {
    if (header.format !== "TEXT") {
      return `El header de esta plantilla es de tipo ${header.format || "desconocido"}; solo se soportan headers de texto sin variables.`;
    }
    if ((header.text || "").includes("{{")) {
      return "El header de esta plantilla tiene variables; no están soportadas todavía.";
    }
  }

  const buttons = list.find((c: any) => c.type === "BUTTONS");
  if (buttons) {
    const dynamicButton = (buttons.buttons || []).some((b: any) => typeof b.url === "string" && b.url.includes("{{"));
    if (dynamicButton) {
      return "Esta plantilla tiene un botón con URL dinámica; no está soportado todavía.";
    }
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método no permitido." }), { status: 405, headers: corsHeaders });
    }

    // ---- Autenticación: solo agentes logueados en el CRM ----
    const authHeader = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "No autorizado." }), { status: 401, headers: corsHeaders });
    }

    // ---- Datos del mensaje a enviar ----
    // type ausente o 'text' => comportamiento idéntico al de antes de plantillas.
    // El "to" del body, si llega, se ignora — el destino real se lee de la
    // conversación en BD (ver más abajo), nunca de lo que mande el cliente.
    // contact_id es la alternativa a conversation_id para INICIAR una
    // conversación con un contacto que aún no ha escrito nunca.
    const requestBody = await req.json();
    const { conversation_id, contact_id, text, template } = requestBody;
    const type: "text" | "template" = requestBody.type === "template" ? "template" : "text";

    if (!conversation_id && !contact_id) {
      return new Response(
        JSON.stringify({ error: "Faltan campos obligatorios: conversation_id o contact_id." }),
        { status: 400, headers: corsHeaders },
      );
    }
    if (type === "text") {
      if (!text) {
        return new Response(
          JSON.stringify({ error: "Falta el campo obligatorio: text." }),
          { status: 400, headers: corsHeaders },
        );
      }
    } else {
      if (!template?.name || !template?.language) {
        return new Response(
          JSON.stringify({ error: "Faltan campos obligatorios: template.name, template.language." }),
          { status: 400, headers: corsHeaders },
        );
      }
    }

    const supabase = createClient(url, serviceKey);

    // ---- Resolver la conversación: por conversation_id (caso normal) o por
    // contact_id (iniciar una conversación nueva con ese contacto) ----
    let conversation: { id: string; phone: string | null; last_customer_message_at: string | null };

    if (conversation_id) {
      const { data, error: convErr } = await supabase
        .from("whatsapp_conversations")
        .select("id, phone, last_customer_message_at")
        .eq("id", conversation_id)
        .maybeSingle();
      if (convErr) throw convErr;
      if (!data) {
        return new Response(
          JSON.stringify({ error: "conversacion_no_encontrada", message: "La conversación no existe." }),
          { status: 404, headers: corsHeaders },
        );
      }
      conversation = data;
    } else {
      const { data: contact, error: contactErr } = await supabase
        .from("contactos")
        .select("id, phone")
        .eq("id", contact_id)
        .maybeSingle();
      if (contactErr) throw contactErr;
      if (!contact) {
        return new Response(
          JSON.stringify({ error: "contacto_no_encontrado", message: "El contacto no existe." }),
          { status: 404, headers: corsHeaders },
        );
      }

      const normalized = normalizePhone(contact.phone);
      if (!normalized) {
        return new Response(
          JSON.stringify({
            error: "telefono_no_valido",
            message: `El teléfono del contacto (${contact.phone ? `"${contact.phone}"` : "no tiene teléfono guardado"}) no es válido para WhatsApp. Corrígelo en la ficha del contacto.`,
          }),
          { status: 422, headers: corsHeaders },
        );
      }

      const { data: existing, error: existingErr } = await supabase
        .from("whatsapp_conversations")
        .select("id, phone, last_customer_message_at")
        .eq("wa_id", normalized.waId)
        .maybeSingle();
      if (existingErr) throw existingErr;

      if (existing) {
        conversation = existing;
      } else {
        // Sin conversación previa: iniciar solo puede hacerse con una
        // plantilla — no hay ventana de 24h que abrir con texto libre.
        if (type !== "template") {
          return new Response(
            JSON.stringify({
              error: "ventana_cerrada",
              message: "Para iniciar una conversación con este contacto necesitas enviar una plantilla aprobada.",
            }),
            { status: 409, headers: corsHeaders },
          );
        }
        // NO se rellena last_customer_message_at: el cliente aún no ha
        // escrito, la ventana sigue cerrada aunque acabemos de crear la fila.
        const { data: created, error: createErr } = await supabase
          .from("whatsapp_conversations")
          .insert({ contact_id: contact.id, phone: normalized.phone, wa_id: normalized.waId })
          .select("id, phone, last_customer_message_at")
          .single();
        if (createErr) throw createErr;
        conversation = created;
      }
    }

    const to = conversation.phone;
    if (!to) {
      return new Response(
        JSON.stringify({ error: "conversacion_sin_telefono", message: "Esta conversación no tiene un número de teléfono asociado." }),
        { status: 422, headers: corsHeaders },
      );
    }

    // ---- Ventana de servicio de 24h — solo aplica a texto libre ----
    // Para type='template' se salta a propósito: Meta permite mandar
    // plantillas aprobadas aunque la ventana esté cerrada; es precisamente
    // el caso de uso para el que existen.
    if (type === "text") {
      const lastCustomerMessageAt = conversation.last_customer_message_at ? new Date(conversation.last_customer_message_at) : null;
      const windowOpenMs = 24 * 60 * 60 * 1000;
      const windowOpen = !!lastCustomerMessageAt && (Date.now() - lastCustomerMessageAt.getTime()) < windowOpenMs;

      if (!windowOpen) {
        return new Response(
          JSON.stringify({
            error: "ventana_cerrada",
            message: "La ventana de 24h ha expirado. Para escribir a este contacto necesitas enviar una plantilla aprobada.",
          }),
          { status: 409, headers: corsHeaders },
        );
      }
    }

    const token = Deno.env.get("WHATSAPP_TOKEN");
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

    // ---- Construir el payload de Meta según el tipo ----
    let metaPayload: Record<string, unknown>;
    let messageType: string;
    let messageBody: string;
    let messageMeta: Record<string, unknown> | null;

    if (type === "template") {
      // No confiar en lo que manda el cliente: se revalida todo contra la
      // plantilla real guardada en BD (sincronizada desde Meta).
      const { data: tpl, error: tplErr } = await supabase
        .from("whatsapp_templates")
        .select("name, language, status, components, parameter_format")
        .eq("name", template.name)
        .eq("language", template.language)
        .maybeSingle();
      if (tplErr) throw tplErr;

      if (!tpl) {
        return new Response(
          JSON.stringify({ error: "plantilla_no_encontrada", message: "No se encontró esa plantilla para ese idioma." }),
          { status: 404, headers: corsHeaders },
        );
      }
      if (tpl.status !== "approved") {
        return new Response(
          JSON.stringify({ error: "plantilla_no_aprobada", message: "Esta plantilla no está aprobada en Meta." }),
          { status: 409, headers: corsHeaders },
        );
      }

      const issue = templateSendIssue(tpl.components, tpl.parameter_format);
      if (issue) {
        return new Response(
          JSON.stringify({ error: "plantilla_no_soportada", message: issue }),
          { status: 422, headers: corsHeaders },
        );
      }

      const bodyText = extractBodyText(tpl.components);
      const { count: expectedCount, gapless } = analyzeBodyVariables(bodyText);

      if (!gapless) {
        return new Response(
          JSON.stringify({
            error: "plantilla_no_soportada",
            message: "La numeración de variables de esta plantilla tiene huecos (p. ej. usa {{1}} y {{3}} pero no {{2}}); no está soportado.",
          }),
          { status: 422, headers: corsHeaders },
        );
      }

      const receivedVariables: string[] = Array.isArray(template.variables) ? template.variables : [];

      if (receivedVariables.length !== expectedCount) {
        return new Response(
          JSON.stringify({
            error: "variables_incompletas",
            message: `Esta plantilla espera ${expectedCount} variable(s) y se han recibido ${receivedVariables.length}.`,
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      const hasBlank = receivedVariables.some((v) => typeof v !== "string" || v.trim() === "");
      if (hasBlank) {
        return new Response(
          JSON.stringify({
            error: "variables_vacias",
            message: "Ninguna variable puede estar vacía o contener solo espacios.",
          }),
          { status: 400, headers: corsHeaders },
        );
      }

      // Solo se incluye el componente "body" si hay variables — una plantilla
      // sin variables (p. ej. hello_world) debe mandarse sin "components".
      const templateComponents = expectedCount > 0
        ? [{ type: "body", parameters: receivedVariables.map((v) => ({ type: "text", text: v })) }]
        : undefined;

      metaPayload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: tpl.name,
          language: { code: tpl.language }, // tal cual está en BD, sin normalizar
          ...(templateComponents ? { components: templateComponents } : {}),
        },
      };

      messageType = "template";
      messageBody = fillBodyText(bodyText, receivedVariables);
      messageMeta = { template: { name: tpl.name, language: tpl.language, variables: receivedVariables } };
    } else {
      metaPayload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      };
      messageType = "text";
      messageBody = text;
      messageMeta = null;
    }

    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metaPayload),
    });

    const metaBody = await metaRes.json();

    if (!metaRes.ok || metaBody.error) {
      console.error("whatsapp-send: error de la Cloud API de Meta", metaRes.status, metaBody);
      return new Response(
        JSON.stringify({ error: metaBody.error?.message || "Error al enviar el mensaje a WhatsApp." }),
        { status: 502, headers: corsHeaders },
      );
    }

    const waMessageId = metaBody.messages?.[0]?.id;

    // ---- Guardar el mensaje enviado (con permisos de servicio) ----
    const { data: saved, error: insertErr } = await supabase
      .from("whatsapp_messages")
      .insert({
        conversation_id: conversation.id,
        direction: "out",
        type: messageType,
        body: messageBody,
        wa_message_id: waMessageId,
        delivery_status: "sent",
        meta: messageMeta,
      })
      .select()
      .single();

    if (insertErr) {
      // El mensaje YA se envió en Meta aunque falle el guardado — se informa
      // igualmente al CRM para que el agente sepa que el envío sí ocurrió.
      console.error("whatsapp-send: mensaje enviado pero no se pudo guardar", insertErr);
      return new Response(
        JSON.stringify({ error: "El mensaje se envió pero no se pudo guardar en el CRM.", wa_message_id: waMessageId, conversation_id: conversation.id }),
        { status: 500, headers: corsHeaders },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, message: saved, conversation_id: conversation.id }),
      { status: 200, headers: corsHeaders },
    );
  } catch (e) {
    console.error("whatsapp-send: fallo inesperado", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
