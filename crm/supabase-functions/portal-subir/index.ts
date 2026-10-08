// Supabase Edge Function: portal-subir
// Área cliente: subida de documentos en dos pasos.
//
//   1. "solicitar": valida empresa (RPC portal_preparar_subida con el JWT
//      del usuario, que también aplica el límite de 30 al día), nombre,
//      tipo y tamaño, y devuelve un token de subida firmado para
//      cliente/{empresa_id}/{documento_id}/{nombre_seguro}. El navegador
//      sube con storage.uploadToSignedUrl(ruta, token, fichero).
//   2. "confirmar": la RPC portal_confirmar_subida (con el JWT del usuario)
//      comprueba en storage.objects que el fichero está, con su tamaño y
//      tipo REALES, y solo entonces inserta la fila. Si lo rechaza por el
//      fichero (GU002), aquí se borra el objeto con la service role. Si lo
//      registra, se avisa al equipo por push.
//
// La regla de verdad está en las RPC (crm/supabase-portal-fase1.sql): son
// ejecutables por authenticated, así que llamarlas sin pasar por aquí no
// permite registrar nada que no cumpla; lo único que se pierde es el aviso
// push. La service role solo se usa en Storage (firmar, borrar) y para
// llamar a push-send.
//
// Entrada (POST, Authorization: Bearer <JWT del usuario>):
//   { accion: "solicitar", empresa_id, nombre, tamano, tipo }
//     → 200 { documento_id, ruta, token, subidas_restantes }
//   { accion: "confirmar", empresa_id, documento_id, nombre }
//     → 200 { documento_id, nombre }
//   Errores: 400 { error } (validación, con texto para el usuario) ·
//            404 { error: "No disponible" } · 429 (límite diario) · 401
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy portal-subir --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { esUuid, validarSolicitud } from "./validacion.ts";

// TEMPORAL (fase 3): localhost:4174 para probar el área cliente en local.
// Se quita en la fase 4, antes de abrir el registro.
const ORIGENES = ["https://guimaes.es", "http://localhost:4174"];
const cabecerasCors = (req: Request) => {
  const origen = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGENES.includes(origen) ? origen : "https://guimaes.es",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};
const NO_DISPONIBLE = { error: "No disponible" };

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

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const body = await req.json().catch(() => ({}));
    const { accion, empresa_id } = body as Record<string, unknown>;
    if (!esUuid(empresa_id)) return json(404, NO_DISPONIBLE);

    // ---------------- 1. solicitar ----------------
    if (accion === "solicitar") {
      const v = validarSolicitud(body.nombre, body.tamano, body.tipo);
      if (!v.ok) return json(400, { error: v.error });

      const { data: prep, error: prepErr } = await userClient.rpc("portal_preparar_subida", { p_empresa_id: empresa_id });
      if (prepErr) {
        if (prepErr.code === "GU003") return json(429, { error: prepErr.message });
        return json(404, NO_DISPONIBLE);
      }

      const documento_id = crypto.randomUUID();
      const ruta = `cliente/${empresa_id}/${documento_id}/${v.nombreSeguro}`;
      const { data: firmada, error: firmaErr } = await admin.storage.from("documentos").createSignedUploadUrl(ruta);
      if (firmaErr || !firmada?.token) {
        console.error("portal-subir: no se pudo firmar la subida", ruta, firmaErr);
        return json(500, { error: "No se pudo preparar la subida." });
      }
      const restantes = Array.isArray(prep) && prep[0] ? (prep[0] as { subidas_restantes: number }).subidas_restantes : null;
      return json(200, { documento_id, ruta, token: firmada.token, subidas_restantes: restantes });
    }

    // ---------------- 2. confirmar ----------------
    if (accion === "confirmar") {
      const { documento_id, nombre } = body as Record<string, unknown>;
      if (!esUuid(documento_id) || typeof nombre !== "string") return json(404, NO_DISPONIBLE);

      const { data, error } = await userClient.rpc("portal_confirmar_subida", {
        p_empresa_id: empresa_id,
        p_documento_id: documento_id,
        p_nombre: nombre,
      });

      if (error) {
        if (error.code === "GU002") {
          // Rechazado por el fichero: la RPC ya validó que la empresa es del
          // usuario y que NO hay ninguna fila apuntando a este prefijo, así
          // que se puede borrar lo que haya debajo.
          const prefijo = `cliente/${empresa_id}/${documento_id}`;
          const { data: lista } = await admin.storage.from("documentos").list(prefijo, { limit: 100 });
          const rutas = (lista || []).map((o) => `${prefijo}/${o.name}`);
          if (rutas.length) {
            const { error: rmErr } = await admin.storage.from("documentos").remove(rutas);
            if (rmErr) console.error("portal-subir: no se pudo borrar el fichero rechazado (lo hará portal-limpieza)", rutas, rmErr);
          }
          return json(400, { error: error.message });
        }
        return json(404, NO_DISPONIBLE);
      }

      const fila = Array.isArray(data) ? data[0] as { documento_id: string; nombre: string; razon_social: string } : null;
      if (!fila) return json(404, NO_DISPONIBLE);

      // Aviso al equipo (push-send ya filtra por admins activos). Un fallo
      // aquí no deshace la subida: el documento ya está registrado.
      try {
        const res = await fetch(`${url}/functions/v1/push-send`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            all: true,
            title: "Documento aportado por un cliente",
            body: `${fila.razon_social}: ${fila.nombre}`,
            url: "/crm?view=documents",
            tag: `cliente-${empresa_id}`,
          }),
        });
        if (!res.ok) console.error("portal-subir: push-send respondió", res.status, await res.text());
      } catch (e) {
        console.error("portal-subir: no se pudo avisar al equipo", e);
      }

      return json(200, { documento_id: fila.documento_id, nombre: fila.nombre });
    }

    return json(400, { error: "Acción no reconocida." });
  } catch (e) {
    console.error("portal-subir: fallo inesperado", e);
    return json(500, { error: "Error interno." });
  }
});
