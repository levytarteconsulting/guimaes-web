// Supabase Edge Function: instagram
// Publicación automática en el feed de Instagram (imagen suelta y carrusel)
// de las piezas aprobadas en el CRM, comprobación de la conexión y métricas.
// Esquema y reglas: crm/supabase-instagram.sql. Lógica: ./instagram.ts.
//
// La llaman:
//   - pg_cron (instagram_lanzar, con x-hook-secret leído de Vault):
//       publicar_pendientes cada 5 min (solo si hay aprobadas con la hora
//       cumplida) y metricas una vez al día;
//   - el CRM, con el JWT del usuario: comprobar (cualquier usuario),
//     publicar_ahora y metricas (rol admin);
//   - la service role (pruebas desde el SQL Editor o la CLI).
// verify_jwt = false (crm/supabase/config.toml): pg_cron no manda JWT; la
// autorización la hace la propia función.
//
// Publicar: reserva la fila (aprobada → publicando, attempts + 1; si otra
// ejecución ya la ha reservado, no hace nada), crea los contenedores (hijos
// con is_carousel_item + contenedor CAROUSEL, o uno solo), espera a
// status_code FINISHED y llama a media_publish. Si algo falla, la pieza pasa
// a error con el motivo y no se reintenta sola. Una publicación atascada más
// de 15 minutos la pasa a error pg_cron (instagram_cron_atascadas).
//
// Secrets (Project Settings → Edge Functions → Secrets):
//   INSTAGRAM_ACCESS_TOKEN — token del usuario del sistema (no caduca)
//   INSTAGRAM_USER_ID      — opcional; si falta, se deduce de /me/accounts
//   INSTAGRAM_CRON_SECRET  — el mismo valor que 'instagram_cron_secret' en Vault
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY — inyectadas por Supabase
//
// Desplegar (desde crm/):
//   supabase functions deploy instagram --use-api --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { createHandler } from "./instagram.ts";
import type { Db } from "./instagram.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const service = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const db: Db = {
  async rolDe(authUserId) {
    const { data, error } = await service.from("admins").select("rol, activo").eq("auth_user_id", authUserId).maybeSingle();
    if (error) throw error;
    return data;
  },
  async pendientes(limite) {
    const { data, error } = await service.from("instagram_posts").select("id")
      .eq("status", "aprobada").lte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true }).limit(limite);
    if (error) throw error;
    return (data ?? []).map((r) => r.id);
  },
  async reservar(id, soloCumplidas) {
    const { data: actual, error: e1 } = await service.from("instagram_posts").select("attempts").eq("id", id).maybeSingle();
    if (e1) throw e1;
    if (!actual) return null;
    // La condición status = 'aprobada' hace que solo una ejecución gane.
    let q = service.from("instagram_posts")
      .update({ status: "publicando", attempts: (actual.attempts ?? 0) + 1, error: null })
      .eq("id", id).eq("status", "aprobada");
    if (soloCumplidas) q = q.lte("scheduled_for", new Date().toISOString());
    const { data, error } = await q.select("id, caption, attempts");
    if (error) throw error;
    return data && data.length ? data[0] : null;
  },
  async laminas(id) {
    const { data, error } = await service.from("instagram_post_slides").select("position, storage_path").eq("post_id", id);
    if (error) throw error;
    return data ?? [];
  },
  async publicada(id, d) {
    const { error } = await service.from("instagram_posts")
      .update({ status: "publicada", error: null, ...d }).eq("id", id);
    if (error) throw error;
  },
  async fallo(id, mensaje) {
    const { error } = await service.from("instagram_posts").update({ status: "error", error: mensaje }).eq("id", id);
    if (error) throw error;
  },
  async paraMetricas(desdeIso) {
    const { data, error } = await service.from("instagram_posts").select("id, ig_media_id")
      .eq("status", "publicada").not("ig_media_id", "is", null).gte("published_at", desdeIso)
      .order("published_at", { ascending: false }).limit(200);
    if (error) throw error;
    return (data ?? []) as { id: string; ig_media_id: string }[];
  },
  async guardarMetricas(id, metrics, enIso) {
    const { error } = await service.from("instagram_posts").update({ metrics, metrics_at: enIso }).eq("id", id);
    if (error) throw error;
  },
};

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
}));
