-- ============================================================
-- GUIMAES — Fase 4: Empresas
-- Un contacto puede pertenecer a varias empresas (Guimaes lleva varias
-- sociedades del mismo cliente) → tabla intermedia contacto_empresa,
-- no una FK directa en contactos.
--
-- Requiere que supabase-contactos.sql (usa public.set_updated_at()) y
-- supabase-admins.sql (usa public.is_admin()) ya se hayan ejecutado.
--
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run. Idempotente.
-- ============================================================

-- ============================================================
-- 1) Tabla empresas
--
-- CIF: NO obligatorio. Muchas empresas del CRM hoy no tienen CIF
-- registrado (viven solo como texto libre en contactos.company) y no hay
-- forma de rellenarlo retroactivamente sin datos reales — un NOT NULL
-- rompería la migración del punto 2. El índice único de abajo es parcial
-- (where cif is not null) para que:
--   - varias empresas sin CIF puedan coexistir sin chocar entre sí
--   - dos empresas CON CIF no puedan duplicarse, comparando en mayúsculas
--     y sin espacios (mismo criterio que admins_email_lower_idx /
--     phone_last9 en el resto del proyecto)
-- ============================================================
create table if not exists public.empresas (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  razon_social  text not null,
  cif           text,
  address       text,
  city          text,
  province      text
);

create unique index if not exists empresas_cif_key
  on public.empresas (upper(trim(cif)))
  where cif is not null and trim(cif) <> '';

create index if not exists empresas_razon_social_idx
  on public.empresas (lower(razon_social));

drop trigger if exists empresas_set_updated_at on public.empresas;
create trigger empresas_set_updated_at
  before update on public.empresas
  for each row execute function public.set_updated_at();

alter table public.empresas enable row level security;

drop policy if exists "admins leen empresas" on public.empresas;
create policy "admins leen empresas"
  on public.empresas for select to authenticated using (public.is_admin());

drop policy if exists "admins crean empresas" on public.empresas;
create policy "admins crean empresas"
  on public.empresas for insert to authenticated with check (public.is_admin());

drop policy if exists "admins actualizan empresas" on public.empresas;
create policy "admins actualizan empresas"
  on public.empresas for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins borran empresas" on public.empresas;
create policy "admins borran empresas"
  on public.empresas for delete to authenticated using (public.is_admin());

-- ============================================================
-- 2) Tabla intermedia contacto_empresa (relación muchos-a-muchos)
--
-- "Todo contacto debe pertenecer a una empresa" es una regla de negocio
-- que se aplica en la aplicación (crm/data.js), no aquí: el contacto se
-- crea primero y se enlaza después (dos sentencias separadas, igual que
-- ya se hace con contactos.lead_id), así que un constraint NOT NULL o un
-- trigger "bloquea si te quedas sin ninguna" es inviable sin constraints
-- diferidos — más riesgo del que aporta valor en esta fase.
--
-- principal: cuál de las empresas de un contacto es la "principal" a
-- efectos de mostrar contactos.company (ver sección 3). Como mucho una
-- por contacto (índice parcial); ninguna marcada es válido (se usa un
-- fallback, ver resolve_contacto_company).
-- ============================================================
create table if not exists public.contacto_empresa (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  contact_id    uuid not null references public.contactos(id) on delete cascade,
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  principal     boolean not null default false
);

create unique index if not exists contacto_empresa_pair_key
  on public.contacto_empresa (contact_id, empresa_id);

create unique index if not exists contacto_empresa_principal_key
  on public.contacto_empresa (contact_id) where principal;

create index if not exists contacto_empresa_empresa_idx
  on public.contacto_empresa (empresa_id);

alter table public.contacto_empresa enable row level security;

drop policy if exists "admins leen contacto_empresa" on public.contacto_empresa;
create policy "admins leen contacto_empresa"
  on public.contacto_empresa for select to authenticated using (public.is_admin());

drop policy if exists "admins crean contacto_empresa" on public.contacto_empresa;
create policy "admins crean contacto_empresa"
  on public.contacto_empresa for insert to authenticated with check (public.is_admin());

drop policy if exists "admins actualizan contacto_empresa" on public.contacto_empresa;
create policy "admins actualizan contacto_empresa"
  on public.contacto_empresa for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins borran contacto_empresa" on public.contacto_empresa;
create policy "admins borran contacto_empresa"
  on public.contacto_empresa for delete to authenticated using (public.is_admin());

-- ============================================================
-- 3) Sincronización de contactos.company
--
-- Decisión (ver informe): contactos.company se CONSERVA tal cual —
-- lo consume media aplicación (lista, buscador, selects, WhatsApp) y
-- tocar todos esos sitios para leer la relación no aporta nada. En vez de
-- eso, se mantiene sincronizado automáticamente por trigger, igual que
-- set_updated_at(): la aplicación nunca escribe contactos.company a
-- mano, solo escribe/borra contacto_empresa y este trigger recalcula.
--
-- resolve_contacto_company(): empresa marcada principal si existe;
-- si no, la más antigua enlazada; NULL si no tiene ninguna (no debería
-- pasar en uso normal, pero un contacto recién insertado pasa por ese
-- estado durante el instante entre el insert y el link).
-- ============================================================
create or replace function public.resolve_contacto_company(p_contact_id uuid)
returns text
language sql
stable
as $$
  select e.razon_social
  from public.contacto_empresa ce
  join public.empresas e on e.id = ce.empresa_id
  where ce.contact_id = p_contact_id
  order by ce.principal desc, ce.created_at asc
  limit 1;
$$;

create or replace function public.sync_contacto_company()
returns trigger
language plpgsql
security definer
as $$
declare
  target_contact_id uuid := coalesce(new.contact_id, old.contact_id);
begin
  update public.contactos
  set company = public.resolve_contacto_company(target_contact_id)
  where id = target_contact_id;
  return coalesce(new, old);
end;
$$;

drop trigger if exists contacto_empresa_sync_company on public.contacto_empresa;
create trigger contacto_empresa_sync_company
  after insert or update or delete on public.contacto_empresa
  for each row execute function public.sync_contacto_company();

-- Si se renombra una empresa (razon_social), propagar a todos los
-- contactos que la tengan enlazada (no solo al principal: si alguien ve
-- "Empresa SL" como su company y esa empresa se renombra, debe verlo
-- actualizado sea o no la principal — resolve_contacto_company decide
-- igualmente cuál usar si el contacto tiene más de una).
create or replace function public.sync_empresa_rename()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.razon_social is distinct from old.razon_social then
    update public.contactos c
    set company = public.resolve_contacto_company(c.id)
    from public.contacto_empresa ce
    where ce.empresa_id = new.id and ce.contact_id = c.id;
  end if;
  return new;
end;
$$;

drop trigger if exists empresas_sync_rename on public.empresas;
create trigger empresas_sync_rename
  after update on public.empresas
  for each row execute function public.sync_empresa_rename();

-- ============================================================
-- Comprobar tras ejecutar:
--   select * from public.empresas limit 5;
--   select * from public.contacto_empresa limit 5;
-- ============================================================
