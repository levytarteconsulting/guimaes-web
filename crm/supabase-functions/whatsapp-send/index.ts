// Supabase Edge Function: whatsapp-send
// Envía un mensaje de texto libre de WhatsApp vía la Cloud API de Meta y lo
// guarda en public.whatsapp_messages (esquema en crm/supabase-whatsapp.sql).
// La llama el CRM (navegador autenticado) cuando un agente escribe un mensaje.
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
    const { conversation_id, to, text } = await req.json();
    if (!conversation_id || !to || !text) {
      return new Response(
        JSON.stringify({ error: "Faltan campos obligatorios: conversation_id, to, text." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const supabase = createClient(url, serviceKey);

    // ---- Ventana de servicio de 24h (solo aplica a texto libre) ----
    // Cuando se añadan plantillas, esta comprobación debe saltarse para los
    // envíos de tipo "template" — Meta permite mandarlas aunque la ventana
    // esté cerrada; es precisamente el caso de uso para el que existen.
    const { data: conversation, error: convErr } = await supabase
      .from("whatsapp_conversations")
      .select("last_customer_message_at")
      .eq("id", conversation_id)
      .maybeSingle();
    if (convErr) throw convErr;
    if (!conversation) {
      return new Response(JSON.stringify({ error: "La conversación no existe." }), { status: 404, headers: corsHeaders });
    }

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

    const token = Deno.env.get("WHATSAPP_TOKEN");
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
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
        conversation_id,
        direction: "out",
        type: "text",
        body: text,
        wa_message_id: waMessageId,
        delivery_status: "sent",
      })
      .select()
      .single();

    if (insertErr) {
      // El mensaje YA se envió en Meta aunque falle el guardado — se informa
      // igualmente al CRM para que el agente sepa que el envío sí ocurrió.
      console.error("whatsapp-send: mensaje enviado pero no se pudo guardar", insertErr);
      return new Response(
        JSON.stringify({ error: "El mensaje se envió pero no se pudo guardar en el CRM.", wa_message_id: waMessageId }),
        { status: 500, headers: corsHeaders },
      );
    }

    return new Response(JSON.stringify({ ok: true, message: saved }), { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("whatsapp-send: fallo inesperado", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
