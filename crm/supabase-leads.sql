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

-- 1) La web pública (rol anon) SOLO puede INSERTAR nuevos leads. También
-- authenticated: la web comparte proyecto y dominio con el CRM, y quien
-- tenga sesión abierta del CRM y rellene el formulario inserta como
-- authenticated. Insertar no da acceso a leer ningún lead.
drop policy if exists "web puede insertar leads" on public.leads;
create policy "web puede insertar leads"
  on public.leads
  for insert
  to anon, authenticated
  with check (true);

-- 2) Leer y actualizar leads (el CRM): solo administradores activos. Esas
-- políticas las crea crm/supabase-rls-solo-admins.sql, única fuente de
-- ellas — antes se definían aquí como "using (true)", abiertas a cualquier
-- sesión, y volver a ejecutar este fichero las recreaba.
