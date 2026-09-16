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
//   WHATSAPP_TOKEN             — token permanente de la Cloud API de Meta (System User) —
//                                el mismo que ya usan whatsapp-send/whatsapp-sync-templates;
//                                aquí hace falta para poder descargar los adjuntos
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

const GRAPH_API_VERSION = "v21.0";
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB — ver crm/supabase-documentos.sql, mismo tope que el bucket
// Tipos que traen un fichero real de Meta y necesitan Storage. location y
// contacts se guardan aparte (ver toInternalType/extractExtraMeta): sus
// datos ya vienen completos en el propio payload del webhook, sin fichero
// que descargar.
const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

// ---- Tipos de mensaje de Meta → catálogo de whatsapp_messages.type ----
function toInternalType(waType: string): string {
  if (MEDIA_TYPES.has(waType) || waType === "location" || waType === "contacts") return waType;
  return "text"; // botones, respuestas interactivas, reacciones... se guardan como texto hasta que se soporten
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// Solo los tipos de imagen/documento/audio/vídeo/sticker que de verdad
// manda WhatsApp — no es un mapa exhaustivo de mime types, solo lo
// necesario para que el nombre de fichero sintético (ver
// buildAttachmentFilename) tenga una extensión reconocible cuando Meta no
// manda filename (el caso normal para audio/vídeo/sticker/imagen — solo
// "document" trae nombre real).
function extFromMime(mime: string | undefined): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "video/mp4": "mp4", "video/3gpp": "3gp",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr", "audio/aac": "aac",
  };
  return map[mime.split(";")[0].trim()] || "";
}

function sanitizeFilename(name: string): string {
  return (name || "archivo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

// { id, filename?, mimeType? } del objeto de media que trae Meta — cada
// tipo lo guarda bajo su propia clave (message.document, message.image...)
// pero con la misma forma.
function extractMediaRef(message: any): { id: string; filename?: string; mimeType?: string } | null {
  const obj = message[message.type];
  if (!obj?.id) return null;
  return { id: obj.id, filename: obj.filename, mimeType: obj.mime_type };
}

function buildAttachmentFilename(message: any, mediaRef: { filename?: string; mimeType?: string }): string {
  if (mediaRef.filename) return sanitizeFilename(mediaRef.filename);
  const ext = extFromMime(mediaRef.mimeType);
  return sanitizeFilename(`${message.type}-${message.id}${ext ? "." + ext : ""}`);
}

// location y contacts no tienen fichero que descargar: Meta ya manda todo
// el dato estructurado dentro del propio payload del webhook. Se guarda en
// whatsapp_messages.meta (la misma columna que ya usa handleStatusUpdate
// para delivery_error) para que la UI, cuando se construya, no tenga que
// volver a llamar a Meta por nada.
function extractExtraMeta(message: any): Record<string, unknown> | null {
  if (message.type === "location" && message.location) {
    return {
      location: {
        lat: message.location.latitude,
        lng: message.location.longitude,
        name: message.location.name ?? null,
        address: message.location.address ?? null,
      },
    };
  }
  if (message.type === "contacts" && Array.isArray(message.contacts)) {
    return { contacts: message.contacts };
  }
  return null;
}

// Llama a push-send servidor a servidor con la service_role key — igual que
// notify-new-lead, no la comparto entre funciones (cada Edge Function de este
// proyecto es autocontenida, sin imports cruzados entre carpetas). tag agrupa
// varios mensajes seguidos de la misma conversación en una sola notificación
// que se reemplaza en vez de acumularse (ver comentario en handleIncomingMessage).
async function notifyTeamPush(title: string, body: string, tag: string, url: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.");

  const res = await fetch(`${supabaseUrl}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ all: true, title, body, url, tag }),
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
    case "video": return message.video?.caption ?? "[vídeo]";
    case "audio": return "[audio]"; // las notas de voz no llevan caption en la API de Meta
    case "sticker": return "[sticker]";
    case "location": return message.location?.name || message.location?.address || "[ubicación]";
    case "contacts": return message.contacts?.[0]?.name?.formatted_name || "[contacto]";
    default: return `[mensaje de tipo "${message.type}" aún no soportado]`;
  }
}

// ---- Conversación: la busca por wa_id o la crea ----
// Al crearla, intenta enlazarla con public.contactos comparando los últimos
// 9 dígitos del teléfono (public.find_contact_by_phone_last9, definida en
// crm/supabase-whatsapp-match.sql — debe haberse ejecutado ya). Solo enlaza
// si hay EXACTAMENTE un contacto que coincide; con 0 o varias coincidencias
// contact_id queda null y se puede asociar a mano desde el CRM.
// Devuelve también contact_id (no solo el id): un adjunto que llega en una
// conversación ya vinculada tiene que nacer con ese contact_id puesto en
// public.documentos, no esperar a que alguien vincule/desvincule después.
async function findOrCreateConversation(supabase: any, waId: string): Promise<{ id: string; contact_id: string | null }> {
  const { data: existing, error: selectErr } = await supabase
    .from("whatsapp_conversations")
    .select("id, contact_id")
    .eq("wa_id", waId)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing) return existing;

  const { data: matchedContactId, error: matchErr } = await supabase.rpc("find_contact_by_phone_last9", { raw_phone: waId });
  if (matchErr) throw matchErr;

  const { data: created, error: insertErr } = await supabase
    .from("whatsapp_conversations")
    .insert({ wa_id: waId, phone: `+${waId}`, contact_id: matchedContactId ?? null })
    .select("id, contact_id")
    .single();
  if (insertErr) throw insertErr;
  return created;
}

// ---- Descarga de adjuntos ----
// La API de Meta se pide en dos pasos: primero los metadatos (incluido
// file_size, que hay que comprobar ANTES de gastar ancho de banda bajando
// el fichero — ver handleMediaAttachment) y, solo si procede, los bytes.
async function getMediaInfo(mediaId: string, token: string): Promise<{ url: string; mimeType: string; fileSize: number }> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Meta media info respondió ${res.status}`);
  const data = await res.json();
  return { url: data.url, mimeType: data.mime_type, fileSize: Number(data.file_size) || 0 };
}

async function downloadMediaBytes(url: string, token: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Meta media download respondió ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Refleja el estado del adjunto en whatsapp_messages.meta (jsonb_set-style,
// vía objeto en JS) para que la UI del hilo, cuando se construya, no tenga
// que hacer join contra documentos solo para saber si un mensaje trae
// fichero y en qué estado está.
async function updateMessageAttachmentMeta(
  supabase: any,
  messageDbId: string,
  doc: { id: string; mime_type: string | null; original_filename: string | null; size_bytes: number | null; status: string },
): Promise<void> {
  const { data: existing } = await supabase.from("whatsapp_messages").select("meta").eq("id", messageDbId).maybeSingle();
  const meta = {
    ...(existing?.meta ?? {}),
    attachment: {
      documento_id: doc.id,
      mime_type: doc.mime_type,
      filename: doc.original_filename,
      size_bytes: doc.size_bytes,
      status: doc.status,
    },
  };
  await supabase.from("whatsapp_messages").update({ meta }).eq("id", messageDbId);
}

// Crea la fila de documentos y, si el tamaño lo permite, dispara la
// descarga real en segundo plano (EdgeRuntime.waitUntil) — todo lo que
// pasa DESPUÉS de crear la fila "pending" ocurre sin que Meta tenga que
// esperar a que termine: el GET de metadatos (rápido, un solo objeto JSON)
// sí se espera aquí porque hace falta el tamaño antes de decidir nada, pero
// bajar los bytes y subirlos a Storage no.
async function handleMediaAttachment(
  supabase: any,
  conversation: { id: string; contact_id: string | null },
  messageDbId: string,
  message: any,
): Promise<void> {
  const mediaRef = extractMediaRef(message);
  if (!mediaRef) return;

  const token = Deno.env.get("WHATSAPP_TOKEN");
  if (!token) {
    console.error("whatsapp-webhook: falta WHATSAPP_TOKEN, no se puede descargar el adjunto");
    return;
  }

  let info: { url: string; mimeType: string; fileSize: number };
  try {
    info = await getMediaInfo(mediaRef.id, token);
  } catch (e) {
    console.error("whatsapp-webhook: fallo consultando el media a Meta", e);
    return;
  }

  const filename = buildAttachmentFilename(message, mediaRef);
  const storagePath = `whatsapp/${conversation.id}/${messageDbId}/${filename}`;
  const mimeType = info.mimeType || mediaRef.mimeType || null;

  const basePayload = {
    storage_path: storagePath,
    mime_type: mimeType,
    size_bytes: info.fileSize || null,
    original_filename: mediaRef.filename || null,
    contact_id: conversation.contact_id,
    folder: "WhatsApp",
    source: "whatsapp",
    whatsapp_conversation_id: conversation.id,
    whatsapp_message_id: messageDbId,
  };

  if (info.fileSize > MAX_ATTACHMENT_BYTES) {
    const { data: doc, error } = await supabase.from("documentos").insert({ ...basePayload, status: "too_large" }).select().single();
    if (error) { console.error("whatsapp-webhook: no se pudo registrar adjunto demasiado grande", error); return; }
    await updateMessageAttachmentMeta(supabase, messageDbId, doc);
    return;
  }

  const { data: doc, error: insErr } = await supabase.from("documentos").insert({ ...basePayload, status: "pending" }).select().single();
  if (insErr) { console.error("whatsapp-webhook: no se pudo crear la fila pendiente de documentos", insErr); return; }
  await updateMessageAttachmentMeta(supabase, messageDbId, doc);

  const downloadAndStore = (async () => {
    try {
      const bytes = await downloadMediaBytes(info.url, token);
      const { error: upErr } = await supabase.storage
        .from("documentos")
        .upload(storagePath, bytes, { contentType: mimeType || "application/octet-stream", upsert: false });
      if (upErr) throw upErr;
      await supabase.from("documentos").update({ status: "stored" }).eq("id", doc.id);
      await updateMessageAttachmentMeta(supabase, messageDbId, { ...doc, status: "stored" });
    } catch (e) {
      console.error("whatsapp-webhook: fallo descargando/subiendo el adjunto", e);
      await supabase.from("documentos").update({ status: "failed" }).eq("id", doc.id);
      await updateMessageAttachmentMeta(supabase, messageDbId, { ...doc, status: "failed" });
    }
  })();

  // @ts-ignore — EdgeRuntime es global en el runtime de Edge Functions de
  // Supabase (producción y `supabase functions serve` local), no forma
  // parte del tipado estándar de Deno. Deja que la respuesta 200 a Meta
  // salga ya (ver handleIncomingMessage/Deno.serve) mientras esto sigue en
  // segundo plano.
  EdgeRuntime.waitUntil(downloadAndStore);
}

async function handleIncomingMessage(supabase: any, message: any, senderProfile: { name?: string } | undefined) {
  const waId = message.from;
  if (!waId) return;

  const conversation = await findOrCreateConversation(supabase, waId);
  const conversationId = conversation.id;

  const timestampMs = message.timestamp ? Number(message.timestamp) * 1000 : Date.now();
  const { error: updErr } = await supabase
    .from("whatsapp_conversations")
    .update({ last_customer_message_at: new Date(timestampMs).toISOString() })
    .eq("id", conversationId);
  if (updErr) throw updErr;

  const body = extractBody(message);
  // location/contacts van con su meta ya puesta desde el insert — no hace
  // falta un segundo viaje a BD como sí necesitan los adjuntos con fichero
  // (esos no pueden saber su documento_id hasta después de crear la fila
  // en documentos, que a su vez necesita el id de este mensaje).
  const extraMeta = extractExtraMeta(message);
  const insertPayload: Record<string, unknown> = {
    conversation_id: conversationId,
    direction: "in",
    type: toInternalType(message.type),
    body,
    wa_message_id: message.id,
  };
  if (extraMeta) insertPayload.meta = extraMeta;

  const { data: savedMessage, error: msgErr } = await supabase
    .from("whatsapp_messages")
    .insert(insertPayload)
    .select("id")
    .single();
  if (msgErr) {
    // 23505 = violación del índice único de wa_message_id: Meta reintentó un
    // mensaje que ya habíamos guardado. No es un error real, se ignora — y
    // tampoco se reenvía el push, porque ya se avisó la primera vez.
    if (msgErr.code !== "23505") throw msgErr;
    return;
  }

  // El adjunto (si lo hay) se procesa aparte para no alargar la respuesta a
  // Meta con las llamadas de red que hace falta dar — ver
  // handleMediaAttachment, que a su vez deja la descarga real en segundo
  // plano. Un fallo aquí no debe tirar abajo el mensaje ya guardado ni el
  // push de abajo.
  if (MEDIA_TYPES.has(message.type)) {
    try {
      await handleMediaAttachment(supabase, conversation, savedMessage.id, message);
    } catch (e) {
      console.error("whatsapp-webhook: fallo iniciando el adjunto (no bloquea el mensaje)", e);
    }
  }

  // Push best-effort: en su propio try/catch para que un fallo aquí nunca
  // impida guardar el RESTO de mensajes del lote (el for de processPayload
  // seguiría abortando si esto lanzara sin capturarlo) ni la respuesta 200 a
  // Meta. tag agrupa mensajes seguidos de la misma conversación: el navegador
  // reemplaza la notificación anterior con el mismo tag en vez de apilarla
  // (y por defecto no vuelve a sonar/vibrar al reemplazar) — con 5 mensajes
  // seguidos solo se ve el último, pero solo suena una vez.
  try {
    await notifyTeamPush(senderProfile?.name || `+${waId}`, truncate(body, 140), `wa-${conversationId}`, "/crm?view=whatsapp&id=" + conversationId);
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
