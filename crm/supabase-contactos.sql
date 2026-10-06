-- ============================================================
-- GUIMAES — Tabla de contactos / empresas (núcleo del CRM)
-- Opción A: una sola tabla para leads, contactos y clientes.
-- El campo lifecycle marca en qué punto del ciclo está cada uno.
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.contactos (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Datos de la empresa / contacto
  company       text,
  full_name     text,
  email         text,
  phone         text,
  dni           text,          -- NIF / CIF
  city          text,
  province      text,
  employees     integer,

  -- Estado en el CRM
  lifecycle     text not null default 'lead',   -- lead → opportunity → active_client → lost
  priority      text,                            -- high / medium / low (catálogo en código)
  owner         text,                            -- asesor responsable (se afina al migrar usuarios)
  source        text default 'Alta manual',      -- de dónde vino (formulario, referido, etc.)

  -- Marcadores
  kyc           boolean not null default false,  -- documentación KYC completada
  registered    boolean not null default false,  -- tiene acceso al área de cliente

  -- Enlace con el login del área de cliente (se usa en la fase 2). El
  -- índice único parcial y la FK a auth.users (on delete set null) los
  -- añade crm/supabase-portal-fase0.sql (bloque 3B).
  auth_user_id  uuid
);

-- Índices para las búsquedas más habituales del CRM
create index if not exists contactos_lifecycle_idx on public.contactos (lifecycle);
create index if not exists contactos_email_idx     on public.contactos (email);

-- ============================================================
-- Seguridad a nivel de fila (RLS)
-- ============================================================
alter table public.contactos enable row level security;

-- Políticas: las crea crm/supabase-rls-solo-admins.sql (solo administradores
-- activos, public.is_admin()), única fuente de las políticas de esta tabla.
-- Antes se definían aquí como "using (true)" — abiertas a cualquier sesión —
-- y volver a ejecutar este fichero las recreaba. Sin aquel fichero la tabla
-- queda con RLS activa y sin políticas: nadie la lee (falla cerrado).

-- Mantener updated_at al día automáticamente en cada edición
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists contactos_set_updated_at on public.contactos;
create trigger contactos_set_updated_at
  before update on public.contactos
  for each row execute function public.set_updated_at();
