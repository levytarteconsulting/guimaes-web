// Supabase Edge Function: correo
// Buzón info@guimaes.es (alias de administracion@guimaes.es) en el CRM vía
// Microsoft Graph v1.0 con credenciales de aplicación. Esquema:
// crm/supabase-correo.sql. Lógica y reglas (filtro de info@, acciones,
// quién puede llamar): ./correo.ts.
//
// verify_jwt = false (crm/supabase/config.toml): pg_cron no manda JWT; la
// autorización la hace la propia función.
//
// Secrets (Project Settings → Edge Functions → Secrets):
//   MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET — app de Entra
//   MS_GRAPH_MAILBOX   — id del buzón administracion@ (/users/{id})
//   CORREO_CRON_SECRET — el mismo valor que 'correo_cron_secret' en Vault
//   SUPABASE_URL y la clave de servicio — inyectadas por Supabase (las usa el cliente
//   de base de datos de la función; nunca se comparan con lo que llega)
//
// Desplegar (desde crm/):
//   supabase functions deploy correo --use-api --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createHandler } from "./correo.ts";
import type { AdjuntoDb, Db } from "./correo.ts";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function ok<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data;
}

const db: Db = {
  async adminActivo(authUserId) {
    const d = ok(await service.from("admins").select("id, activo").eq("auth_user_id", authUserId).maybeSingle());
    return d?.activo ? d.id : null;
  },
  async reservar(carpeta, segundos) {
    return !!ok(await service.rpc("correo_sync_reservar", { p_carpeta: carpeta, p_segundos: segundos }));
  },
  async liberar(carpeta) {
    ok(await service.from("correo_sync").update({ reservado_hasta: null }).eq("carpeta", carpeta));
  },
  async estado(carpeta) {
    const d = ok(await service.from("correo_sync")
      .select("delta_link, next_link, importacion_desde, descartados").eq("carpeta", carpeta).single());
    return { ...d, descartados: Number(d.descartados ?? 0) };
  },
  async guardarEstado(carpeta, cambios) {
    ok(await service.from("correo_sync").update(cambios).eq("carpeta", carpeta));
  },
  async guardarMensajes(filas) {
    const d = ok(await service.from("correo_mensajes").upsert(filas, { onConflict: "graph_id" }).select("id, graph_id"));
    return Object.fromEntries((d ?? []).map((r: { id: string; graph_id: string }) => [r.graph_id, r.id]));
  },
  async registrarEnviado(fila) {
    ok(await service.from("correo_mensajes").upsert(fila, { onConflict: "graph_id" }));
  },
  async reasignarEnviado(internetMessageId, graphId) {
    // Solo filas registradas al enviar y solo si el id nuevo no existe ya.
    const ya = ok(await service.from("correo_mensajes").select("id").eq("graph_id", graphId).maybeSingle());
    if (ya) return;
    ok(await service.from("correo_mensajes").update({ graph_id: graphId })
      .eq("internet_message_id", internetMessageId).eq("carpeta", "sentitems")
      .not("enviado_por", "is", null).neq("graph_id", graphId));
  },
  async marcarFuera(graphIds, enIso) {
    const d = ok(await service.from("correo_mensajes").update({ fuera_bandeja: true, fuera_bandeja_at: enIso })
      .in("graph_id", graphIds).eq("fuera_bandeja", false).select("id"));
    return (d ?? []).length;
  },
  async existentes(graphIds) {
    const d = ok(await service.from("correo_mensajes").select("graph_id").in("graph_id", graphIds));
    return (d ?? []).map((x: { graph_id: string }) => x.graph_id);
  },
  async leidoSiExiste(graphId, leido) {
    ok(await service.from("correo_mensajes").update({ leido }).eq("graph_id", graphId));
  },
  async guardarAdjuntos(filas) {
    ok(await service.from("correo_adjuntos").upsert(filas, { onConflict: "mensaje_id,graph_id" }));
  },
  async mensaje(id) {
    return ok(await service.from("correo_mensajes").select("id, graph_id, carpeta, empresa_id").eq("id", id).maybeSingle());
  },
  async adjunto(id) {
    const d = ok(await service.from("correo_adjuntos")
      .select("id, graph_id, nombre, tipo, content_id, inline, mensaje:correo_mensajes!inner(graph_id)").eq("id", id).maybeSingle());
    return d ? aAdjunto(d) : null;
  },
  async adjuntosDe(mensajeId) {
    const d = ok(await service.from("correo_adjuntos")
      .select("id, graph_id, nombre, tipo, content_id, inline, mensaje:correo_mensajes!inner(graph_id)").eq("mensaje_id", mensajeId));
    return (d ?? []).map(aAdjunto);
  },
  async marcarLeido(id, leido) {
    ok(await service.from("correo_mensajes").update({ leido }).eq("id", id));
  },
  async crearBorrador(b) {
    ok(await service.from("correo_borradores").insert(b));
  },
  async borrador(graphId) {
    const d = ok(await service.from("correo_borradores")
      .select("graph_id, creado_por, tipo, origen_id, empresa_id, sesiones").eq("graph_id", graphId).maybeSingle());
    return d ? { ...d, sesiones: Array.isArray(d.sesiones) ? d.sesiones : [] } : null;
  },
  async guardarSesiones(graphId, sesiones) {
    ok(await service.from("correo_borradores").update({ sesiones }).eq("graph_id", graphId));
  },
  async borrarBorrador(graphId) {
    ok(await service.from("correo_borradores").delete().eq("graph_id", graphId));
  },
  async borradoresViejos(antesIso, limite) {
    const d = ok(await service.from("correo_borradores").select("graph_id")
      .lt("created_at", antesIso).order("created_at", { ascending: true }).limit(limite));
    return (d ?? []).map((r: { graph_id: string }) => r.graph_id);
  },
  async documento(id) {
    const d = ok(await service.from("documentos")
      .select("id, empresa_id, storage_path, original_filename, mime_type, size_bytes, status").eq("id", id).maybeSingle());
    return d ? { id: d.id, empresa_id: d.empresa_id, storage_path: d.storage_path, nombre: d.original_filename ?? "",
                 tipo: d.mime_type ?? null, tamano: d.size_bytes ?? null, status: d.status } : null;
  },
  async descargarDocumento(storagePath) {
    const blob = ok(await service.storage.from("documentos").download(storagePath));
    return new Uint8Array(await blob.arrayBuffer());
  },
};

// deno-lint-ignore no-explicit-any
function aAdjunto(d: any): AdjuntoDb {
  return {
    id: d.id, graph_id: d.graph_id, nombre: d.nombre ?? "", tipo: d.tipo ?? null,
    content_id: d.content_id ?? null, inline: !!d.inline, mensaje_graph_id: d.mensaje?.graph_id,
  };
}

async function usuario(jwt: string): Promise<string | null> {
  const { data, error } = await service.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user.id;
}

Deno.serve(createHandler({
  env: (k) => Deno.env.get(k),
  fetch,
  db: () => db,
  usuario,
  log: (...a) => console.error(...a),
}));
