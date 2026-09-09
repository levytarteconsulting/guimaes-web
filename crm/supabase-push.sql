-- ============================================================
-- GUIMAES — Notificaciones push (Web Push + VAPID)
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run
--
-- No existe una tabla de perfiles propia: la identidad del CRM se resuelve
-- cruzando el email de la sesión de Supabase Auth contra CRM.USERS
-- (hardcodeado en crm/data.js — ver crm/auth.js:isAllowed y
-- app.jsx:userFromSession). Por eso user_id aquí referencia auth.users
-- directamente: es el único id de usuario que de verdad persiste en algún
-- sitio, aunque no tengamos una tabla de perfiles que lo acompañe.
-- ============================================================
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(), -- se actualiza en cada re-suscripción (permiso ya concedido, mismo endpoint)

  user_id       uuid not null references auth.users(id) on delete cascade,

  -- Credenciales que devuelve pushManager.subscribe() en el navegador
  endpoint      text not null,  -- URL única del push service (FCM/APNs web push/Mozilla) para ESTE dispositivo+origen
  p256dh        text not null,  -- clave pública del suscriptor, para cifrar el payload (RFC 8291)
  auth          text not null,  -- secreto de autenticación del suscriptor (RFC 8291)

  device_label  text  -- etiqueta legible para que el usuario distinga sus dispositivos (ej. "iPhone", "Chrome en Windows"); la calcula el cliente, no es crítica
);

-- Un mismo dispositivo/navegador da el MISMO endpoint al re-suscribirse
-- (permiso ya concedido, p. ej. al recargar la página) — sin este único, cada
-- comprobación/renovación de la suscripción duplicaría la fila. Un usuario sí
-- puede tener varias filas legítimas (móvil + escritorio), cada una con
-- endpoint distinto.
create unique index if not exists push_subscriptions_user_endpoint_key
  on public.push_subscriptions (user_id, endpoint);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ============================================================
-- Seguridad a nivel de fila (RLS)
-- A diferencia del resto de tablas del CRM (cualquier admin autenticado ve
-- todo), aquí cada usuario SOLO puede ver/crear/borrar SUS PROPIAS
-- suscripciones — son credenciales de su dispositivo, no datos de negocio
-- compartidos. push-send (Edge Function) usa la service_role key y por tanto
-- no pasa por estas políticas.
-- ============================================================
alter table public.push_subscriptions enable row level security;

drop policy if exists "usuarios leen sus push_subscriptions" on public.push_subscriptions;
create policy "usuarios leen sus push_subscriptions"
  on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);

drop policy if exists "usuarios crean sus push_subscriptions" on public.push_subscriptions;
create policy "usuarios crean sus push_subscriptions"
  on public.push_subscriptions for insert to authenticated with check (auth.uid() = user_id);

-- No la pediste explícitamente (pediste "ve y borra"), pero hace falta para
-- que el upsert de re-suscripción (mismo endpoint → refresca claves/fecha en
-- vez de duplicar) funcione bajo RLS — sin UPDATE, ese upsert fallaría.
drop policy if exists "usuarios actualizan sus push_subscriptions" on public.push_subscriptions;
create policy "usuarios actualizan sus push_subscriptions"
  on public.push_subscriptions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "usuarios borran sus push_subscriptions" on public.push_subscriptions;
create policy "usuarios borran sus push_subscriptions"
  on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);
