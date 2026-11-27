// Supabase Edge Function: holded-conexiones
// Carga y verificación de las claves de Holded de cada empresa (Configuración
// → Integraciones → Holded, solo rol admin). Ver servicio.ts y
// crm/supabase-holded-conexiones.sql.
//
// Las claves se guardan en Supabase Vault con funciones SQL que solo puede
// ejecutar service_role; la service role key solo existe aquí, en el
// servidor. Nunca se devuelve ni se registra una clave.
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy holded-conexiones --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { atender } from "./servicio.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://guimaes.es",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Método no permitido." });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opts);
    let body: unknown = null;
    try { body = await req.json(); } catch { return json(400, { error: "Cuerpo no válido." }); }
    const r = await atender({
      usuario: async (authorization) => {
        const c = createClient(url, anon, { ...opts, global: { headers: { Authorization: authorization } } });
        const { data, error } = await c.auth.getUser();
        return error || !data.user ? null : data.user.id;
      },
      rpc: async (fn, args) => {
        const { data, error } = await admin.rpc(fn, args);
        return { data, error: error ? { code: error.code, message: error.message } : null };
      },
    }, req.headers.get("Authorization") || "", body);
    return json(r.status, r.body);
  } catch {
    // Sin detalles: el error podría arrastrar datos de la petición.
    console.error("holded-conexiones: fallo inesperado");
    return json(500, { error: "Error inesperado." });
  }
});
