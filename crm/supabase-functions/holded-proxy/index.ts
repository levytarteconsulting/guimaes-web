// Supabase Edge Function: holded-proxy
// Consultas de SOLO LECTURA a Holded para el asistente del CRM (bloque 2).
// La llama la función agente con el JWT del usuario. Lógica: servicio.ts;
// rutas, límites y cálculos: consultas.ts; base de datos:
// crm/supabase-holded-consultas.sql.
//
// Solo lectura: el fetch hacia Holded va envuelto en fetchSoloLectura (solo
// GET y solo las rutas de la lista cerrada). La service role key solo se usa
// aquí, en el servidor, para holded_iniciar/holded_terminar/holded_clave_de.
// Nunca se devuelve ni se registra una clave.
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy holded-proxy --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { fetchSoloLectura } from "./consultas.ts";
import { atender, nuevaCache } from "./servicio.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://guimaes.es",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Caché en memoria (5 minutos) de esta instancia.
const cache = nuevaCache();
const fetchHolded = fetchSoloLectura((u, init) => fetch(u, init));

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
      fetchHolded,
      log: (...a) => console.error(...a),
    }, cache, req.headers.get("Authorization") || "", body);
    return json(r.status, r.body);
  } catch {
    console.error("holded-proxy: fallo inesperado");
    return json(500, { error: "Error inesperado." });
  }
});
