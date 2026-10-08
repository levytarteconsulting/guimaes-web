// Supabase Edge Function: portal-alta
// Área cliente: alta autónoma de una cuenta PENDIENTE (email confirmado, sin
// contacto vinculado). Envuelve las RPC del borrador de alta
// (crm/supabase-portal-fase32.sql), llamadas con el JWT del usuario, que son
// las que hacen todas las comprobaciones. La service role se usa solo en
// Storage (firmar la subida, borrar ficheros) y para avisar al equipo.
//
//   "solicitar_subida": límites (10 documentos, 50 MB en total) y URL de
//       subida firmada para pendientes/{auth_uid}/{documento_id}/{nombre}.
//   "confirmar_subida": la RPC comprueba el fichero REAL en Storage y lo
//       registra; si lo rechaza por el fichero (GU002), aquí se borra.
//   "borrar_documento": quita un documento del borrador y su fichero.
//   "enviar": marca la solicitud como enviada; solo el PRIMER envío avisa al
//       equipo por push (editar y reenviar no vuelve a avisar).
// Guardar los datos del borrador no pasa por aquí: el portal llama a la RPC
// portal_alta_guardar directamente (no avisa a nadie).
//
// Entrada (POST, Authorization: Bearer <JWT del usuario>):
//   { accion: "solicitar_subida", nombre, tamano, tipo } → { documento_id, ruta, token }
//   { accion: "confirmar_subida", documento_id, nombre } → { documento_id, nombre }
//   { accion: "borrar_documento", documento_id }           → { ok: true }
//   { accion: "enviar" }                                    → { ok: true }
// Errores: 400 { error } (texto para el cliente) · 403 (email sin confirmar) ·
//          404 { error: "No disponible" } · 429 (límites) · 401
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy portal-alta --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { esUuid, validarSolicitud } from "../portal-subir/validacion.ts";

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
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const errorRpc = (e: { code?: string; message: string }) =>
      e.code === "GU005" || e.code === "GU002" ? json(400, { error: e.message.replace(/^Fichero no válido: /, "") })
      : e.code === "GU003" ? json(429, { error: e.message })
      : e.code === "GU006" ? json(403, { error: e.message })
      : e.code === "GU001" ? json(404, { error: "No disponible" })
      : json(500, { error: "No se ha podido completar. Vuelve a intentarlo." });

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const { accion } = body;

    if (accion === "solicitar_subida") {
      const v = validarSolicitud(body.nombre, body.tamano, body.tipo);
      if (!v.ok) return json(400, { error: v.error });
      const { error } = await userClient.rpc("portal_alta_preparar_subida", { p_tamano: body.tamano });
      if (error) return errorRpc(error);
      const documento_id = crypto.randomUUID();
      const ruta = `pendientes/${user.id}/${documento_id}/${v.nombreSeguro}`;
      const { data: firmada, error: firmaErr } = await admin.storage.from("documentos").createSignedUploadUrl(ruta);
      if (firmaErr || !firmada?.token) {
        console.error("portal-alta: no se pudo firmar la subida", ruta, firmaErr);
        return json(500, { error: "No se pudo preparar la subida." });
      }
      return json(200, { documento_id, ruta, token: firmada.token });
    }

    if (accion === "confirmar_subida") {
      const { documento_id, nombre } = body;
      if (!esUuid(documento_id) || typeof nombre !== "string") return json(404, { error: "No disponible" });
      const { data, error } = await userClient.rpc("portal_alta_confirmar_subida", { p_documento_id: documento_id, p_nombre: nombre });
      if (error) {
        if (error.code === "GU002") {
          // Rechazado por el fichero: es de su propia carpeta (pendientes/{uid}/)
          // y no hay ninguna fila que apunte a él.
          const prefijo = `pendientes/${user.id}/${documento_id}`;
          const { data: lista } = await admin.storage.from("documentos").list(prefijo, { limit: 100 });
          const rutas = (lista || []).map((o) => `${prefijo}/${o.name}`);
          if (rutas.length) await admin.storage.from("documentos").remove(rutas);
        }
        return errorRpc(error);
      }
      const fila = (data as { documento_id: string; nombre: string }[])[0];
      return json(200, fila);
    }

    if (accion === "borrar_documento") {
      const { documento_id } = body;
      if (!esUuid(documento_id)) return json(404, { error: "No disponible" });
      const { data, error } = await userClient.rpc("portal_alta_borrar_documento", { p_documento_id: documento_id });
      if (error) return errorRpc(error);
      const ruta = (data as { storage_path: string }[])[0]?.storage_path;
      // Solo dentro de su propia carpeta; si falla, lo recoge portal-limpieza.
      if (ruta && ruta.startsWith(`pendientes/${user.id}/`)) {
        const { error: rmErr } = await admin.storage.from("documentos").remove([ruta]);
        if (rmErr) console.error("portal-alta: no se pudo borrar el fichero (lo hará portal-limpieza)", ruta, rmErr);
      }
      return json(200, { ok: true });
    }

    if (accion === "enviar") {
      const { data, error } = await userClient.rpc("portal_alta_enviar");
      if (error) return errorRpc(error);
      const r = (data as { primera: boolean; razon_social: string }[])[0];
      if (r.primera) {
        try {
          const res = await fetch(`${url}/functions/v1/push-send`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ all: true, title: "Nueva solicitud de alta en el área cliente", body: r.razon_social, url: "/crm?view=cuentas", tag: `alta-${user.id}` }),
          });
          if (!res.ok) console.error("portal-alta: push-send respondió", res.status, await res.text());
        } catch (e) { console.error("portal-alta: no se pudo avisar al equipo", e); }
      }
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida." });
  } catch (e) {
    console.error("portal-alta: fallo inesperado", e);
    return json(500, { error: "No se ha podido completar. Vuelve a intentarlo." });
  }
});
