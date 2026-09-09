-- ============================================================
-- GUIMAES — Notas (una sola tabla para notas de contacto y de deal, con
-- contact_id y deal_id opcionales — decisión tomada, no dos tablas separadas)
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run
-- Requiere que supabase-contactos.sql y supabase-deals.sql ya se hayan
-- ejecutado antes (referencia sus tablas).
-- ============================================================
create table if not exists public.notas (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  body        text not null,
  author      text,  -- id de CRM.USERS (ej. "u1"), mismo criterio que tareas.assigned_to — no un uuid de auth.users

  -- on delete cascade: coincide con el comportamiento que ya tiene el CRM en
  -- memoria hoy (borrar un contacto o un deal borra también sus notas).
  contact_id  uuid references public.contactos(id) on delete cascade,
  deal_id     uuid references public.deals(id) on delete cascade
);

create index if not exists notas_contact_idx on public.notas (contact_id);
create index if not exists notas_deal_idx    on public.notas (deal_id);

-- ============================================================
-- Seguridad a nivel de fila (RLS)
-- Mismo criterio que el resto de tablas del CRM: cualquier admin autenticado
-- puede leer/crear/borrar cualquier nota. "Solo puedes borrar las tuyas" se
-- aplica en la UI (crm/app.jsx), no aquí — author guarda un id de CRM.USERS,
-- no el auth.uid() de Supabase, y no hay tabla de perfiles que mapee uno con
-- otro, así que RLS no puede comprobar "es tuya" a nivel de fila hoy. Sin
-- política de UPDATE a propósito: no hay edición (ver crm/app.jsx, punto 7).
-- ============================================================
alter table public.notas enable row level security;

drop policy if exists "admins leen notas" on public.notas;
create policy "admins leen notas"
  on public.notas for select to authenticated using (true);

drop policy if exists "admins crean notas" on public.notas;
create policy "admins crean notas"
  on public.notas for insert to authenticated with check (true);

drop policy if exists "admins borran notas" on public.notas;
create policy "admins borran notas"
  on public.notas for delete to authenticated using (true);
