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
  -- (registered se quitó en crm/supabase-pasoB.sql: el acceso al área
  -- cliente es auth_user_id)

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

-- ============================================================
-- Borrar un contacto desde el CRM (crm/supabase-pasoB.sql), en una
-- transacción: los deals de su empresa se quedan sin interlocutor
-- (deals.contact_id es ON DELETE SET NULL), los que no tienen empresa se
-- borran, y las notas y tareas de los deals que quedan siguen con su deal.
-- Usa is_admin() (supabase-admins.sql), deals, notas y tareas: se resuelven
-- al llamarla, no al crearla.
-- ============================================================
create or replace function public.admin_borrar_contacto(p_contact_id uuid)
returns table(deals_conservados integer, deals_borrados integer)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $f$
declare
  v_borrados integer;
  v_quedan   integer;
begin
  if not public.is_admin() then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  perform 1 from public.contactos c where c.id = p_contact_id for update;
  if not found then
    raise exception 'El contacto no existe' using errcode = 'GU010';
  end if;
  delete from public.deals d where d.contact_id = p_contact_id and d.empresa_id is null;
  get diagnostics v_borrados = row_count;
  select count(*) into v_quedan from public.deals d where d.contact_id = p_contact_id;
  update public.notas n set contact_id = null where n.contact_id = p_contact_id and n.deal_id is not null;
  update public.tareas t set contact_id = null where t.contact_id = p_contact_id and t.deal_id is not null;
  delete from public.contactos c where c.id = p_contact_id;
  return query select v_quedan, v_borrados;
end;
$f$;
revoke all on function public.admin_borrar_contacto(uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_borrar_contacto(uuid) to authenticated;
