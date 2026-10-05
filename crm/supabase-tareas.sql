-- ============================================================
-- GUIMAES — Tareas (la tabla ya existe en producción, creada a mano, nunca
-- versionada hasta ahora — este fichero documenta ese esquema real y añade
-- lo que faltaba: RLS). Ejecutar UNA vez en Supabase → SQL Editor → New
-- query → Run. Requiere que supabase-contactos.sql ya se haya ejecutado
-- antes (usa la función public.set_updated_at() definida allí).
-- ============================================================
create table if not exists public.tareas (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  title        text not null,
  due_at       timestamptz,
  assigned_to  text,               -- id de CRM.USERS (ej. "u1"), no un uuid de auth.users — ver crm/data.js:rowToTask
  status       text not null default 'pending', -- 'pending' / 'done' (catálogo en código)
  archived     boolean not null default false,

  -- Sin FK explícita: el esquema verificado en producción no la tenía: si se
  -- quiere añadir cascade on delete más adelante, revisar antes que no haya
  -- filas huérfanas.
  contact_id   uuid,
  deal_id      uuid
);

create index if not exists tareas_contact_idx  on public.tareas (contact_id);
create index if not exists tareas_deal_idx     on public.tareas (deal_id);
create index if not exists tareas_assigned_idx on public.tareas (assigned_to);

-- ============================================================
-- Seguridad a nivel de fila (RLS) — esto es lo que faltaba y explica por qué
-- la tabla seguía en 0 filas pese a que el código ya escribía en ella: sin
-- RLS habilitado (o sin políticas), PostgREST bloquea el acceso.
-- Mismo criterio que contactos/deals: cualquier administrador activo ve y
-- edita todas las tareas — la vista "Todas" de Tareas depende de que
-- cualquier admin vea las de los demás, no solo las suyas.
-- ============================================================
alter table public.tareas enable row level security;

-- Políticas: las crea crm/supabase-rls-solo-admins.sql (solo administradores
-- activos, public.is_admin()), única fuente de las políticas de esta tabla.
-- Antes se definían aquí como "using (true)" — abiertas a cualquier sesión —
-- y volver a ejecutar este fichero las recreaba. Sin aquel fichero la tabla
-- queda con RLS activa y sin políticas: nadie la lee (falla cerrado).

drop trigger if exists tareas_set_updated_at on public.tareas;
create trigger tareas_set_updated_at
  before update on public.tareas
  for each row execute function public.set_updated_at();
