// Supabase Edge Function: holded-acciones
// ACCIONES (escritura) en Holded con aprobación humana. Lógica: servicio.ts;
// operaciones permitidas (lista cerrada): operaciones.ts; propuestas:
// propuesta.ts; base de datos: crm/supabase-holded-acciones.sql.
//
// Todo fetch hacia Holded pasa por fetchAcciones: solo GET /sales-receipts,
// GET /usage y POST /sales-receipts/{id}/approve. holded-proxy sigue siendo
// solo de lectura.
//
// Secrets: HOLDED_ACCIONES_CRON_SECRET (el mismo valor que
// holded_acciones_cron_secret en Vault), HOLDED_ACCIONES_POR_MINUTO
// (opcional, 40). La service role key solo se usa aquí, en el servidor.
//
// Desplegar (desde crm/, verify_jwt = false: pg_cron llama sin JWT y la
// autorización la hace el código):
//   supabase functions deploy holded-acciones --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { fetchAcciones } from "./operaciones.ts";
import { atender } from "./servicio.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://guimaes.es",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const fetchHolded = fetchAcciones((u, init) => fetch(u, init));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Método no permitido." });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opts);
    const comoUsuario = (authorization: string) =>
      createClient(url, anon, { ...opts, global: { headers: { Authorization: authorization } } });
    let body: unknown = null;
    try { body = await req.json(); } catch { return json(400, { error: "Cuerpo no válido." }); }
    const r = await atender({
      env: (k) => Deno.env.get(k),
      usuario: async (authorization) => {
        const { data, error } = await comoUsuario(authorization).auth.getUser();
        return error || !data.user ? null : data.user.id;
      },
      esUsuarioCrm: async (authorization) => {
        const { data, error } = await comoUsuario(authorization).rpc("is_admin");
        return !error && data === true;
      },
      rpc: async (fn, args) => {
        const { data, error } = await admin.rpc(fn, args);
        return { data, error: error ? { code: error.code, message: error.message } : null };
      },
      fetchHolded,
      log: (...a) => console.error(...a),
    }, { authorization: req.headers.get("Authorization") || "", hook: req.headers.get("x-hook-secret") }, body);
    return json(r.status, r.body);
  } catch {
    console.error("holded-acciones: fallo inesperado");
    return json(500, { error: "Error inesperado." });
  }
});
