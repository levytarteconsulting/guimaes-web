// Supabase Edge Function: portal-alta
// Área cliente: alta inmediata (crm/supabase-portal-fase33.sql). Una cuenta
// PENDIENTE (email confirmado, sin contacto vinculado) envía los datos de su
// empresa y de contacto; la RPC portal_alta_crear, llamada con el JWT del
// usuario, hace todas las comprobaciones y crea al momento la empresa y el
// contacto provisionales, con la cuenta vinculada. Aquí solo se avisa al
// equipo por push (la service role se usa únicamente para eso).
//
// Entrada (POST, Authorization: Bearer <JWT del usuario>):
//   { accion: "crear", razon_social, cif, direccion, ciudad, provincia, nombre_contacto, telefono }
//     → 200 { empresa_id, razon_social }
// Errores: 400 { error } (texto para el cliente) · 403 (email sin confirmar) ·
//          404 { error: "No disponible" } · 401
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy portal-alta --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

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
const texto = (x: unknown) => (typeof x === "string" ? x : null);

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
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json(401, { error: "No autorizado." });

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.accion !== "crear") return json(400, { error: "Acción no reconocida." });

    const { data, error } = await userClient.rpc("portal_alta_crear", {
      p_razon_social: texto(body.razon_social), p_cif: texto(body.cif), p_direccion: texto(body.direccion),
      p_ciudad: texto(body.ciudad), p_provincia: texto(body.provincia),
      p_nombre_contacto: texto(body.nombre_contacto), p_telefono: texto(body.telefono),
    });
    if (error) {
      return error.code === "GU005" ? json(400, { error: error.message })
        : error.code === "GU006" ? json(403, { error: error.message })
        : error.code === "GU001" ? json(404, { error: "No disponible" })
        : json(500, { error: "No se ha podido completar. Vuelve a intentarlo." });
    }
    const r = (data as { empresa_id: string; razon_social: string }[])[0];

    try {
      const res = await fetch(`${url}/functions/v1/push-send`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ all: true, title: "Nueva alta en el área cliente (pendiente de validar)", body: r.razon_social, url: "/crm?view=cuentas", tag: `alta-${r.empresa_id}` }),
      });
      if (!res.ok) console.error("portal-alta: push-send respondió", res.status, await res.text());
    } catch (e) { console.error("portal-alta: no se pudo avisar al equipo", e); }

    return json(200, r);
  } catch (e) {
    console.error("portal-alta: fallo inesperado", e);
    return json(500, { error: "No se ha podido completar. Vuelve a intentarlo." });
  }
});
