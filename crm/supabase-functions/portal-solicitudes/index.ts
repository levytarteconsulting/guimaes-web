// Supabase Edge Function: portal-solicitudes
// Área cliente: las tres escrituras del cliente que avisan al equipo.
//
//   "servicio":        RPC portal_solicitar_servicio (deal 'nueva_solicitud',
//                      origen 'portal'; máx. 5 por empresa y día).
//   "editar_empresa":  RPC portal_actualizar_empresa (dirección, ciudad,
//                      provincia; queda en empresa_cambios).
//   "cambio_empresa":  RPC portal_solicitar_cambio_empresa (razón social o
//                      CIF; lo aplica el equipo desde el CRM).
//
// Todas las comprobaciones están en las RPC (crm/supabase-portal-fase31.sql),
// llamadas con el JWT del usuario. Esta función solo añade el aviso push al
// equipo (push-send, que filtra por admins activos): llamar a las RPC
// directamente funciona igual, pero sin aviso.
//
// Entrada (POST, Authorization: Bearer <JWT del usuario>):
//   { accion: "servicio", empresa_id, servicio, mensaje? }
//   { accion: "editar_empresa", empresa_id, direccion, ciudad, provincia }
//   { accion: "cambio_empresa", empresa_id, campo: "razon_social"|"cif", valor, comentario? }
// Salida: 200 con lo que devuelve la RPC · 400 { error } (dato no válido, texto
// para el cliente) · 404 { error: "No disponible" } · 429 (límite) · 401
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy portal-solicitudes --project-ref zuktsotrcolqdowpbnrx

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
const esUuid = (x: unknown): x is string => typeof x === "string" && UUID_RE.test(x);
const texto = (x: unknown) => (typeof x === "string" ? x : null);
const CAMPOS: Record<string, string> = { razon_social: "razón social", cif: "CIF" };

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
    const { accion, empresa_id } = body;
    if (!esUuid(empresa_id)) return json(404, { error: "No disponible" });

    // Errores de las RPC: GU005 (dato no válido) y GU004 (límite) traen un
    // texto para el cliente; GU001 y cualquier otro, genérico.
    const errorRpc = (e: { code?: string; message: string }) =>
      e.code === "GU005" ? json(400, { error: e.message })
      : e.code === "GU004" ? json(429, { error: e.message })
      : e.code === "GU001" ? json(404, { error: "No disponible" })
      : json(500, { error: "No se ha podido completar. Vuelve a intentarlo." });

    const avisar = async (title: string, cuerpo: string, ruta: string) => {
      try {
        const res = await fetch(`${url}/functions/v1/push-send`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ all: true, title, body: cuerpo, url: ruta, tag: `portal-${accion}-${empresa_id}` }),
        });
        if (!res.ok) console.error("portal-solicitudes: push-send respondió", res.status, await res.text());
      } catch (e) {
        console.error("portal-solicitudes: no se pudo avisar al equipo", e);
      }
    };

    if (accion === "servicio") {
      const { data, error } = await userClient.rpc("portal_solicitar_servicio", {
        p_empresa_id: empresa_id, p_servicio: texto(body.servicio), p_mensaje: texto(body.mensaje),
      });
      if (error) return errorRpc(error);
      const r = (data as { servicio: string; razon_social: string }[])[0];
      await avisar("Solicitud de servicio desde el área cliente", `${r.razon_social}: ${r.servicio}`, "/crm?view=pipeline");
      return json(200, { servicio: r.servicio });
    }

    if (accion === "editar_empresa") {
      const { data, error } = await userClient.rpc("portal_actualizar_empresa", {
        p_empresa_id: empresa_id, p_direccion: texto(body.direccion), p_ciudad: texto(body.ciudad), p_provincia: texto(body.provincia),
      });
      if (error) return errorRpc(error);
      const r = (data as { direccion: string | null; ciudad: string | null; provincia: string | null; cambios: number }[])[0];
      if (r.cambios > 0) {
        const { data: emps } = await userClient.rpc("portal_empresas");
        const e = ((emps || []) as { empresa_id: string; razon_social: string }[]).find((x) => x.empresa_id === empresa_id);
        await avisar("Un cliente ha actualizado sus datos", `${e ? e.razon_social : "Empresa"}: dirección, ciudad o provincia`, "/crm?view=empresas");
      }
      return json(200, r);
    }

    if (accion === "cambio_empresa") {
      const { data, error } = await userClient.rpc("portal_solicitar_cambio_empresa", {
        p_empresa_id: empresa_id, p_campo: texto(body.campo), p_valor: texto(body.valor), p_comentario: texto(body.comentario),
      });
      if (error) return errorRpc(error);
      const r = (data as { campo: string; valor_solicitado: string; razon_social: string }[])[0];
      await avisar(`Solicitud de cambio de ${CAMPOS[r.campo] || r.campo}`, `${r.razon_social}: ${r.valor_solicitado}`, "/crm?view=empresas");
      return json(200, { campo: r.campo, valor_solicitado: r.valor_solicitado });
    }

    return json(400, { error: "Acción no reconocida." });
  } catch (e) {
    console.error("portal-solicitudes: fallo inesperado", e);
    return json(500, { error: "No se ha podido completar. Vuelve a intentarlo." });
  }
});
