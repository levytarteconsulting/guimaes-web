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
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — inyectadas por Supabase
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
  async usuarioActivo(authUserId) {
    const d = ok(await service.from("admins").select("activo").eq("auth_user_id", authUserId).maybeSingle());
    return !!d?.activo;
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
  async marcarFuera(graphIds, enIso) {
    const d = ok(await service.from("correo_mensajes").update({ fuera_bandeja: true, fuera_bandeja_at: enIso })
      .in("graph_id", graphIds).eq("fuera_bandeja", false).select("id"));
    return (d ?? []).length;
  },
  async leidoSiExiste(graphId, leido) {
    ok(await service.from("correo_mensajes").update({ leido }).eq("graph_id", graphId));
  },
  async guardarAdjuntos(filas) {
    ok(await service.from("correo_adjuntos").upsert(filas, { onConflict: "mensaje_id,graph_id" }));
  },
  async mensaje(id) {
    return ok(await service.from("correo_mensajes").select("id, graph_id, carpeta").eq("id", id).maybeSingle());
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
