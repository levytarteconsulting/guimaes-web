// Supabase Edge Function: empresas-ficheros
// CRM: borra de Storage los ficheros de las empresas eliminadas. La RPC
// admin_borrar_empresa (crm/supabase-empresas-borrar.sql) borra las filas
// de documentos y deja sus rutas en public.storage_borrados, en la misma
// transacción; el CRM llama aquí justo después con el lote. Lo que falle
// queda pendiente con su error: se ve en el CRM (admin_ficheros_por_borrar)
// y se reintenta desde ahí (sin lote = todos los pendientes) o en la
// limpieza diaria de portal-limpieza.
//
// Solo administradores activos: se comprueba llamando a
// admin_ficheros_por_borrar con el JWT de quien pide (42501 si no es
// admin). El borrado va con la service role por la API de Storage (un
// DELETE sobre storage.objects no borraría el fichero).
//
// Entrada (POST, Authorization: Bearer <JWT del admin>): { lote?: uuid }
//   → 200 { encontrados, borrados, errores, pendientes }
//   Errores: 400 { error } · 403 (no admin) · 401
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy empresas-ficheros --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { borrarPendientes } from "./borrar.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://guimaes.es",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Método no permitido." });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: authErr } = await userClient.rpc("admin_ficheros_por_borrar");
    if (authErr) return authErr.code === "42501" ? json(403, { error: "No autorizado." }) : json(400, { error: authErr.message });

    let body: { lote?: unknown } = {};
    try { body = await req.json(); } catch { /* sin cuerpo: todos los pendientes */ }
    const lote = body.lote == null ? null : String(body.lote);
    if (lote !== null && !UUID_RE.test(lote)) return json(400, { error: "Lote no válido." });

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
    const r = await borrarPendientes(admin, lote);
    const { data: quedan } = await userClient.rpc("admin_ficheros_por_borrar");
    if (r.errores) console.error("empresas-ficheros: quedan ficheros sin borrar", r);
    return json(200, { ...r, pendientes: (quedan || []).length });
  } catch (e) {
    console.error("empresas-ficheros: fallo inesperado", e);
    return json(500, { error: "No se pudieron borrar los ficheros. Quedan pendientes y se pueden reintentar." });
  }
});
