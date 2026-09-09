// Supabase Edge Function: whatsapp-webhook
// Webhook de la WhatsApp Cloud API (Meta): verifica la suscripción (GET) y
// recibe mensajes entrantes + actualizaciones de estado (POST), guardándolos
// en public.whatsapp_conversations / public.whatsapp_messages
// (esquema en crm/supabase-whatsapp.sql — debe haberse ejecutado ya).
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   WHATSAPP_VERIFY_TOKEN      — token que tú eliges; debe coincidir con el que
//                                pongas al configurar el webhook en Meta App Dashboard
//   APP_SECRET                 — App Secret de la app de Meta, para validar X-Hub-Signature-256
//   SUPABASE_URL                — inyectada automáticamente por Supabase (también para llamar a push-send)
//   SUPABASE_SERVICE_ROLE_KEY   — inyectada automáticamente por Supabase (también credencial de push-send)
//
// IMPORTANTE al desplegar: Meta no manda ninguna cabecera de autenticación de
// Supabase en sus peticiones, así que esta función necesita --no-verify-jwt o
// la plataforma la rechazará con 401 antes de que nuestro código se ejecute.
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase login
//   supabase link --project-ref zuktsotrcolqdowpbnrx
//   supabase functions deploy whatsapp-webhook --project-ref zuktsotrcolqdowpbnrx --no-verify-jwt
//
// Después de desplegar, en Meta App Dashboard → WhatsApp → Configuration → Webhook:
//   Callback URL:  https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/whatsapp-webhook
//   Verify token:  el mismo valor que pongas en WHATSAPP_VERIFY_TOKEN

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---- Firma X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con el App Secret) ----
async function verifySignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=") || !appSecret) return false;
  const expectedHex = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(computedHex, expectedHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Tipos de mensaje de Meta → catálogo de whatsapp_messages.type ----
function toInternalType(waType: string): string {
  if (waType === "image" || waType === "document") return waType;
  return "text"; // audio, vídeo, ubicación, stickers, botones... se guardan como texto hasta que se soporten
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// Llama a push-send servidor a servidor con la service_role key — igual que
// notify-new-lead, no la comparto entre funciones (cada Edge Function de este
// proyecto es autocontenida, sin imports cruzados entre carpetas). tag agrupa
// varios mensajes seguidos de la misma conversación en una sola notificación
// que se reemplaza en vez de acumularse (ver comentario en handleIncomingMessage).
async function notifyTeamPush(title: string, body: string, tag: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.");

  const res = await fetch(`${supabaseUrl}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ all: true, title, body, url: "/crm.html", tag }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`push-send respondió ${res.status}: ${errText}`);
  }
}

function extractBody(message: any): string {
  switch (message.type) {
    case "text": return message.text?.body ?? "";
    case "image": return message.image?.caption ?? "[imagen]";
    case "document": return message.document?.caption ?? message.document?.filename ?? "[documento]";
    default: return `[mensaje de tipo "${message.type}" aún no soportado]`;
  }
}

// ---- Conversación: la busca por wa_id o la crea ----
// Nota: no intenta enlazar automáticamente con public.contactos por teléfono;
// contact_id queda null y se puede asociar manualmente desde el CRM.
async function findOrCreateConversationId(supabase: any, waId: string): Promise<string> {
  const { data: existing, error: selectErr } = await supabase
    .from("whatsapp_conversations")
    .select("id")
    .eq("wa_id", waId)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing) return existing.id;

  const { data: created, error: insertErr } = await supabase
    .from("whatsapp_conversations")
    .insert({ wa_id: waId, phone: `+${waId}` })
    .select("id")
    .single();
  if (insertErr) throw insertErr;
  return created.id;
}

async function handleIncomingMessage(supabase: any, message: any, senderProfile: { name?: string } | undefined) {
  const waId = message.from;
  if (!waId) return;

  const conversationId = await findOrCreateConversationId(supabase, waId);

  const timestampMs = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();
  const { error: updErr } = await supabase
    .from("whatsapp_conversations")
    .update({ last_customer_message_at: new Date(timestampMs).toISOString() })
    .eq("id", conversationId);
  if (updErr) throw updErr;

  const body = extractBody(message);
  const { error: msgErr } = await supabase.from("whatsapp_messages").insert({
    conversation_id: conversationId,
    direction: "in",
    type: toInternalType(message.type),
    body,
    wa_message_id: message.id,
  });
  if (msgErr) {
    // 23505 = violación del índice único de wa_message_id: Meta reintentó un
    // mensaje que ya habíamos guardado. No es un error real, se ignora — y
    // tampoco se reenvía el push, porque ya se avisó la primera vez.
    if (msgErr.code !== "23505") throw msgErr;
    return;
  }

  // Push best-effort: en su propio try/catch para que un fallo aquí nunca
  // impida guardar el RESTO de mensajes del lote (el for de processPayload
  // seguiría abortando si esto lanzara sin capturarlo) ni la respuesta 200 a
  // Meta. tag agrupa mensajes seguidos de la misma conversación: el navegador
  // reemplaza la notificación anterior con el mismo tag en vez de apilarla
  // (y por defecto no vuelve a sonar/vibrar al reemplazar) — con 5 mensajes
  // seguidos solo se ve el último, pero solo suena una vez.
  try {
    await notifyTeamPush(senderProfile?.name || `+${waId}`, truncate(body, 140), `wa-${conversationId}`);
  } catch (e) {
    console.error("whatsapp-webhook: push falló (no bloquea el mensaje)", e);
  }
}

// ---- Actualizaciones de estado: sent / delivered / read / failed ----
// (mismos valores que delivery_status, se guardan tal cual — sin traducción)
async function handleStatusUpdate(supabase: any, status: any) {
  if (!status.id || !status.status) return;

  if (status.status === "failed") {
    console.error("whatsapp-webhook: envío fallido", { wa_message_id: status.id, errors: status.errors ?? null });
  }

  const update: Record<string, unknown> = { delivery_status: status.status };

  // statuses[].errors[]: { code, title, message, href, error_data: { details } }
  const firstError = Array.isArray(status.errors) ? status.errors[0] : undefined;
  if (firstError) {
    const { data: existing, error: selectErr } = await supabase
      .from("whatsapp_messages")
      .select("meta")
      .eq("wa_message_id", status.id)
      .maybeSingle();
    if (selectErr) throw selectErr;

    update.meta = {
      ...(existing?.meta ?? {}),
      delivery_error: {
        code: firstError.code ?? null,
        title: firstError.title ?? null,
        message: firstError.message ?? null,
        details: firstError.error_data?.details ?? null,
        at: new Date().toISOString(),
      },
    };
  }

  const { error } = await supabase
    .from("whatsapp_messages")
    .update(update)
    .eq("wa_message_id", status.id);
  if (error) throw error;
}

async function processPayload(supabase: any, payload: any) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      // value.contacts[].profile.name trae el nombre de perfil de WhatsApp del
      // remitente; no se persiste en whatsapp_conversations (no tiene columna
      // de nombre) pero sí se usa para el título del push (ver notifyTeamPush
      // en handleIncomingMessage) — disponible aquí también por si se quiere
      // usar más adelante para crear un contacto automáticamente.
      const senderProfile = value.contacts?.[0]?.profile;
      for (const message of value.messages ?? []) {
        await handleIncomingMessage(supabase, message, senderProfile);
      }
      for (const status of value.statuses ?? []) {
        await handleStatusUpdate(supabase, status);
      }
    }
  }
}

Deno.serve(async (req) => {
  try {
    // ---- GET: verificación del webhook (challenge de Meta) ----
    if (req.method === "GET") {
      const params = new URL(req.url).searchParams;
      const mode = params.get("hub.mode");
      const token = params.get("hub.verify_token");
      const challenge = params.get("hub.challenge");
      const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");

      if (mode === "subscribe" && verifyToken && token === verifyToken) {
        return new Response(challenge ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // ---- POST: mensajes entrantes / actualizaciones de estado ----
    if (req.method === "POST") {
      const rawBody = await req.text();
      const appSecret = Deno.env.get("APP_SECRET") ?? "";
      const signatureHeader = req.headers.get("x-hub-signature-256");

      const validSignature = await verifySignature(rawBody, signatureHeader, appSecret);
      if (!validSignature) {
        console.error("whatsapp-webhook: firma X-Hub-Signature-256 inválida o ausente");
        return new Response(JSON.stringify({ error: "Firma inválida." }), { status: 401 });
      }

      let payload: any;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return new Response(JSON.stringify({ error: "JSON inválido." }), { status: 400 });
      }

      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

      // Se procesa inline (el volumen esperado es bajo) y SIEMPRE se responde 200:
      // si devolviéramos un error, Meta reintentaría indefinidamente el mismo
      // payload. Los reintentos legítimos (timeouts) son seguros gracias al
      // dedupe por wa_message_id.
      try {
        await processPayload(supabase, payload);
      } catch (e) {
        console.error("whatsapp-webhook: fallo procesando payload", e);
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    console.error("whatsapp-webhook: fallo inesperado", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
