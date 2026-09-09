// Supabase Edge Function: push-send
// Envía notificaciones Web Push (VAPID) a uno o varios usuarios, buscando sus
// suscripciones en public.push_subscriptions (esquema en crm/supabase-push.sql).
// Esta pieza es SOLO infraestructura: nadie la llama todavía en automático —
// se prueba a mano (curl) hasta que la siguiente fase la enganche a los
// disparadores (lead nuevo, WhatsApp entrante).
//
// Función INTERNA, no pensada para invocarse desde el navegador del agente:
// a diferencia de whatsapp-send (que valida "¿eres un agente logueado?"),
// aquí lo que hay que validar es "¿eres el propio backend?" — cualquier
// usuario autenticado normal podría, si esto aceptara su JWT, mandar
// notificaciones a los dispositivos de otros. Por eso exige la
// service_role key exacta como Bearer, no cualquier JWT válido.
//
// Librería de Web Push: usamos el paquete npm "web-push" (el estándar de
// facto del ecosistema) vía el import npm: que soportan las Edge Functions
// de Supabase — implementa VAPID (RFC 8292) y el cifrado del payload
// (RFC 8291) ya probado en producción por miles de proyectos. Reimplementar
// ECDH+HKDF+AES-128-GCM a mano aquí sería mucho más arriesgado que importar
// una librería madura.
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY             — la misma pública que en crm/config.js
//   VAPID_PRIVATE_KEY            — la privada, generada con `npx web-push generate-vapid-keys`
//   VAPID_SUBJECT                — ej. mailto:soporte@guimaes.es (lo exige el protocolo)
//   SUPABASE_URL                  — inyectada automáticamente por Supabase
//   SUPABASE_SERVICE_ROLE_KEY     — inyectada automáticamente; también es el valor
//                                   que hay que mandar como Authorization: Bearer
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase functions deploy push-send --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método no permitido." }), { status: 405, headers: corsHeaders });
    }

    // ---- Autenticación: solo el propio backend (service_role), nunca un agente ----
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!authHeader || authHeader !== serviceKey) {
      return new Response(JSON.stringify({ error: "No autorizado." }), { status: 401, headers: corsHeaders });
    }

    const { user_ids, title, body, url } = await req.json();
    const userIds: string[] = Array.isArray(user_ids) ? user_ids : (user_ids ? [user_ids] : []);

    if (userIds.length === 0 || !title || !body) {
      return new Response(
        JSON.stringify({ error: "Faltan campos obligatorios: user_ids (string o array), title, body." }),
        { status: 400, headers: corsHeaders },
      );
    }

    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT");
    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      return new Response(
        JSON.stringify({ error: "Faltan las claves VAPID en los secrets de la función." }),
        { status: 500, headers: corsHeaders },
      );
    }
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    const { data: subs, error: subsErr } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("user_id", userIds);
    if (subsErr) throw subsErr;

    // url: reservado para cuando el CRM tenga rutas de verdad y el service
    // worker pueda navegar a una vista concreta al pulsar la notificación
    // (ver sw.js) — hoy solo abre/enfoca la app.
    const payload = JSON.stringify({ title, body, url: url || "/crm.html" });

    let sent = 0, failed = 0, removed = 0;
    await Promise.all((subs || []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (e) {
        failed++;
        const status = e && (e.statusCode || e.status);
        if (status === 404 || status === 410) {
          // Suscripción caducada/revocada del lado del push service: ya no sirve de nada.
          const { error: delErr } = await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          if (!delErr) removed++;
        } else {
          console.error("push-send: fallo enviando a", sub.id, status, e);
        }
      }
    }));

    return new Response(
      JSON.stringify({ ok: true, targeted: (subs || []).length, sent, failed, removed }),
      { status: 200, headers: corsHeaders },
    );
  } catch (e) {
    console.error("push-send: fallo inesperado", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
