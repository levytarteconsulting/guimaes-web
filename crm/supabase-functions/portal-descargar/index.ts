// Supabase Edge Function: portal-descargar
// Área cliente: URL firmada (60 s) para descargar un documento que el
// cliente puede ver.
//
// El cliente no tiene ninguna política sobre tablas ni Storage. Quién puede
// ver qué lo decide la RPC public.portal_preparar_descarga
// (crm/supabase-portal-fase1.sql), llamada con el JWT del propio usuario:
// solo devuelve la ruta si el documento es de una de sus empresas y está
// compartido (visible + stored) o lo aportó el cliente. La service role se
// usa únicamente para firmar la URL en Storage.
//
// Entrada (POST, Authorization: Bearer <JWT del usuario>):
//   { documento_id }
// Salida: 200 { url, expira_en } · 404 { error: "No disponible" } · 401
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy portal-descargar --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Solo la web (www.guimaes.es redirige a guimaes.es y no sirve contenido).
const ORIGENES = ["https://guimaes.es"];
const cabecerasCors = (req: Request) => {
  const origen = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origen) ? origen : "https://guimaes.es",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPIRA = 60;

Deno.serve(async (req) => {
  const corsHeaders = cabecerasCors(req);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Método no permitido." });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json(401, { error: "No autorizado." });

    const { documento_id } = await req.json().catch(() => ({}));
    if (typeof documento_id !== "string" || !UUID_RE.test(documento_id)) return json(404, { error: "No disponible" });

    const { data, error } = await userClient.rpc("portal_preparar_descarga", { p_documento_id: documento_id });
    if (error || !Array.isArray(data) || data.length !== 1) return json(404, { error: "No disponible" });
    const { storage_path, nombre } = data[0] as { storage_path: string; nombre: string };

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: firmada, error: firmaErr } = await admin.storage
      .from("documentos")
      .createSignedUrl(storage_path, EXPIRA, { download: nombre });
    if (firmaErr || !firmada?.signedUrl) {
      console.error("portal-descargar: no se pudo firmar", documento_id, firmaErr);
      return json(404, { error: "No disponible" });
    }
    return json(200, { url: firmada.signedUrl, expira_en: EXPIRA });
  } catch (e) {
    console.error("portal-descargar: fallo inesperado", e);
    return json(500, { error: "Error interno." });
  }
});
