-- ============================================================
-- GUIMAES — Tabla de leads del formulario web
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run
-- ============================================================

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  nombre      text,
  empresa     text,
  email       text,
  telefono    text,
  servicio    text,
  mensaje     text,
  lang        text default 'es',
  source      text default 'Formulario web',
  page        text,
  status      text default 'new'
);

-- Seguridad a nivel de fila (RLS)
alter table public.leads enable row level security;

-- 1) La web pública (rol anon) SOLO puede INSERTAR nuevos leads.
drop policy if exists "web puede insertar leads" on public.leads;
create policy "web puede insertar leads"
  on public.leads
  for insert
  to anon, authenticated
  with check (true);

-- 2) Solo los administradores autenticados del CRM pueden LEER los leads.
drop policy if exists "admins autenticados pueden leer leads" on public.leads;
create policy "admins autenticados pueden leer leads"
  on public.leads
  for select
  to authenticated
  using (true);

-- (Opcional) permitir a los admins actualizar el estado del lead desde el CRM
drop policy if exists "admins autenticados pueden actualizar leads" on public.leads;
create policy "admins autenticados pueden actualizar leads"
  on public.leads
  for update
  to authenticated
  using (true)
  with check (true);
