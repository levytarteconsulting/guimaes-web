// Supabase Edge Function: meta-leads
// Webhook de Meta Lead Ads (objeto Page, campo leadgen): verifica la
// suscripción (GET) y, por cada leadgen_id que llega (POST firmado), pide el
// lead a la Graph API y lo inserta en public.leads con source "Meta Lead
// Ads". Desde ahí sigue el mismo camino que un lead de la web: el trigger
// on_new_lead avisa (email + push vía notify-new-lead) y el CRM lo convierte
// en contacto + deal (crm/data.js, loadWebLeads). Si el email o el teléfono
// ya son de un contacto, el lead entra vinculado a él (status 'linked') con
// una nota, sin crear otro. Esquema: crm/supabase-meta-leads.sql.
//
// Idempotente: leads.meta_leadgen_id es único; un reenvío de Meta no
// duplica nada. Si la Graph API falla, responde 500 para que Meta reintente.
//
// Acciones de operación (POST con cabecera x-ops-key = META_LEADS_OPS_KEY,
// sin firma de Meta), cuerpo JSON {action, page_id?, dry_run?}:
//   check      — solo lectura: token, permisos, páginas, formularios y apps suscritas
//   subscribe  — suscribe la app al campo leadgen de la página (conserva los demás)
//   import     — trae los leads ya recibidos de todos los formularios de la
//                página, sin duplicar y sin aviso por lead (un push de resumen)
//
// Variables de entorno (Project Settings → Edge Functions → Secrets):
//   META_LEADS_VERIFY_TOKEN   — el verify token que se pone en el webhook de la app
//   APP_SECRET                — App Secret de la app de Meta (el mismo que whatsapp-webhook)
//   META_LEADS_TOKEN          — token del usuario del sistema con leads_retrieval y pages_*
//   META_LEADS_OPS_KEY        — clave de las acciones de operación
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — inyectadas por Supabase
//
// Desplegar (Meta no manda JWT de Supabase: sin verificación de JWT):
//   supabase functions deploy meta-leads --project-ref zuktsotrcolqdowpbnrx --no-verify-jwt
// Webhook en la app de Meta → Webhooks → Page → campo leadgen:
//   https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/meta-leads

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createHandler, Db, LeadRow } from "./leads.ts";

function supabaseDb(): Db {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return {
    async leadExists(leadgenId) {
      const { data, error } = await sb.from("leads").select("id").eq("meta_leadgen_id", leadgenId).maybeSingle();
      if (error) throw error;
      return !!data;
    },
    async findContact(email, telefono) {
      const pick = async (id: string | null, matchedBy: "email" | "teléfono") => {
        if (!id) return null;
        const { data, error } = await sb.from("contactos").select("id, full_name, company").eq("id", id).maybeSingle();
        if (error) throw error;
        return data ? { id: data.id, nombre: data.full_name || data.company || "", matchedBy } : null;
      };
      if (email) {
        const { data, error } = await sb.rpc("find_contact_by_email", { raw_email: email });
        if (error) throw error;
        const c = await pick(data, "email");
        if (c) return c;
      }
      if (telefono) {
        const { data, error } = await sb.rpc("find_contact_by_phone_last9", { raw_phone: telefono });
        if (error) throw error;
        return await pick(data, "teléfono");
      }
      return null;
    },
    async insertLead(row: LeadRow) {
      const { data, error } = await sb.from("leads")
        .upsert(row, { onConflict: "meta_leadgen_id", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      return data && data.length ? data[0].id : null;
    },
    async insertNote(contactId, body) {
      const { error } = await sb.from("notas").insert({ contact_id: contactId, body, author: null });
      if (error) throw error;
    },
  };
}

// Igual que notify-new-lead: push-send servidor a servidor con la service role.
async function notifyTeamPush(title: string, body: string): Promise<void> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ all: true, title, body, url: "/crm?view=contacts" }),
  });
  if (!res.ok) throw new Error(`push-send respondió ${res.status}: ${await res.text().catch(() => "")}`);
}

Deno.serve(createHandler({
  env: (k) => Deno.env.get(k),
  fetch,
  db: supabaseDb,
  push: notifyTeamPush,
}));
