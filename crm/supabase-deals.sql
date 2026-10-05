-- ============================================================
-- GUIMAES — Tabla de deals / oportunidades (el pipeline)
-- Cada deal pertenece a un contacto de public.contactos.
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.deals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Contenido del deal
  title         text,
  contact_id    uuid references public.contactos(id) on delete cascade,
  service       text,        -- id del catálogo de servicios (en código)
  stage         text not null default 'reunion',  -- id del catálogo de etapas
  owner         text,        -- asesor responsable
  amount        numeric,     -- importe
  frequency     text,        -- 'mensual', 'puntual', etc.
  priority      text,        -- high / medium / low
  loss_reason   text,        -- motivo de pérdida (si stage = perdido)

  -- Fechas del ciclo de vida del deal
  signed_at     date,        -- fecha de firma
  renewal_at    date         -- fecha de renovación
);

create index if not exists deals_contact_idx on public.deals (contact_id);
create index if not exists deals_stage_idx   on public.deals (stage);

-- ============================================================
-- Seguridad a nivel de fila (RLS) — solo administradores activos
-- ============================================================
alter table public.deals enable row level security;

-- Políticas: las crea crm/supabase-rls-solo-admins.sql (solo administradores
-- activos, public.is_admin()), única fuente de las políticas de esta tabla.
-- Antes se definían aquí como "using (true)" — abiertas a cualquier sesión —
-- y volver a ejecutar este fichero las recreaba. Sin aquel fichero la tabla
-- queda con RLS activa y sin políticas: nadie la lee (falla cerrado).

drop trigger if exists deals_set_updated_at on public.deals;
create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();
