// Supabase Edge Function: whatsapp-sync-templates
// Sincroniza las plantillas del WhatsApp Business Manager de Meta (Graph API,
// GET /{waba-id}/message_templates) hacia public.whatsapp_templates (esquema
// en crm/supabase-whatsapp.sql). La llama el CRM cuando el agente pulsa
// "Importar desde Meta" en el modal de plantillas.
//
// Igual que whatsapp-send, requiere autenticación de Supabase — solo agentes
// logueados en el CRM pueden sincronizar. No lleva verify_jwt = false en config.toml.
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   WHATSAPP_TOKEN              — token permanente de la Cloud API de Meta (mismo que whatsapp-send)
//   WHATSAPP_WABA_ID            — ID de la cuenta de WhatsApp Business (WABA, no el Phone Number ID)
//   SUPABASE_URL                 — inyectada automáticamente por Supabase
//   SUPABASE_ANON_KEY            — inyectada automáticamente por Supabase (valida la sesión del agente)
//   SUPABASE_SERVICE_ROLE_KEY    — inyectada automáticamente por Supabase (guarda las plantillas)
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase login
//   supabase link --project-ref zuktsotrcolqdowpbnrx
//   supabase functions deploy whatsapp-sync-templates --project-ref zuktsotrcolqdowpbnrx
//
// Nota: solo trae la primera página (limit=100). Si algún día hay más de 100
// plantillas aprobadas, habría que seguir "paging.cursors.after" en un bucle.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API_VERSION = "v21.0";

// El componente BODY es el único obligatorio en una plantilla de Meta; HEADER,
// FOOTER y BUTTONS son opcionales y no los usamos todavía (solo texto libre al insertar).
function extractBody(components: any[]): string {
  const body = (components || []).find((c: any) => c.type === "BODY");
  return body?.text || "";
}

function extractVariables(components: any[]): any[] {
  const body = (components || []).find((c: any) => c.type === "BODY");
  const examples: string[] = body?.example?.body_text?.[0] || [];
  return examples.map((example: string, i: number) => ({ position: i + 1, example }));
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

    // ---- Pedir las plantillas a Meta ----
    const token = Deno.env.get("WHATSAPP_TOKEN");
    const wabaId = Deno.env.get("WHATSAPP_WABA_ID");

    // fields explícito: al pasarlo, Meta deja de devolver los campos por
    // defecto — cualquier campo que el map de abajo use y no esté aquí
    // llegaría como undefined en silencio. Mantener esta lista sincronizada
    // con lo que realmente se lee de "t" más abajo.
    const templateFields = "id,name,status,category,language,components,parameter_format";
    const metaRes = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates?limit=100&fields=${templateFields}`,
      { headers: { "Authorization": `Bearer ${token}` } },
    );
    const metaBody = await metaRes.json();

    if (!metaRes.ok || metaBody.error) {
      console.error("whatsapp-sync-templates: error de la Cloud API de Meta", metaRes.status, metaBody);
      return new Response(
        JSON.stringify({ error: metaBody.error?.message || "No se pudo consultar las plantillas en Meta." }),
        { status: 502, headers: corsHeaders },
      );
    }

    const metaTemplates: any[] = metaBody.data || [];

    if (metaTemplates.length === 0) {
      return new Response(JSON.stringify({ ok: true, synced: 0 }), { status: 200, headers: corsHeaders });
    }

    // ---- Guardar cada plantilla (upsert por name+language, con permisos de servicio) ----
    const rows = metaTemplates.map((t) => ({
      name: t.name,
      category: t.category || null,
      language: t.language || null,
      status: (t.status || "pending").toLowerCase(),
      body: extractBody(t.components),
      variables: extractVariables(t.components),
      components: Array.isArray(t.components) ? t.components : [],
      parameter_format: t.parameter_format ?? null,
      meta_template_id: t.id ?? null,
      synced_at: new Date().toISOString(),
    }));

    const supabase = createClient(url, serviceKey);
    const { error: upsertErr } = await supabase
      .from("whatsapp_templates")
      .upsert(rows, { onConflict: "name,language" });

    if (upsertErr) {
      console.error("whatsapp-sync-templates: fallo al guardar plantillas", upsertErr);
      return new Response(
        JSON.stringify({ error: "Las plantillas se leyeron de Meta pero no se pudieron guardar." }),
        { status: 500, headers: corsHeaders },
      );
    }

    return new Response(JSON.stringify({ ok: true, synced: rows.length }), { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("whatsapp-sync-templates: fallo inesperado", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
