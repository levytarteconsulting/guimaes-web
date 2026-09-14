-- ============================================================
-- GUIMAES — Administradores del CRM (public.admins)
-- Sustituye a CRM.USERS, el array hardcodeado en crm/data.js que solo vivía
-- en memoria del navegador: cualquier alta se perdía al refrescar y nunca
-- llegaba a comprobarse contra nada real en el login (ver isAllowed en
-- crm/auth.js). A partir de esta tabla, el acceso al CRM depende de tener
-- aquí una fila con auth_user_id apuntando a una cuenta real de
-- Supabase Auth y activo = true.
--
-- Requiere que supabase-contactos.sql ya se haya ejecutado antes (usa la
-- función public.set_updated_at() definida allí) y que supabase-tareas.sql
-- también (la migración de abajo actualiza public.tareas).
--
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run, de arriba
-- abajo, en un único query. Es idempotente: se puede volver a ejecutar
-- entero sin duplicar filas ni romper nada ya migrado.
-- ============================================================

-- ============================================================
-- Tabla
-- ============================================================
create table if not exists public.admins (
  id            uuid primary key default gen_random_uuid(),

  -- Identidad real (Supabase Auth). Nullable: permite dar de alta la fila
  -- de una persona que todavía no tiene cuenta creada, y "on delete set
  -- null" para que borrar la cuenta de Auth a mano desde el dashboard no
  -- rompa la fila (se queda inactiva de facto: auth_user_id null no puede
  -- coincidir con ningún auth.uid() real).
  auth_user_id  uuid unique references auth.users(id) on delete set null,

  nombre        text not null,
  email         text not null unique,

  -- Catálogo de rol: 'admin' puede gestionar administradores (alta, editar
  -- rol, desactivar, baja); 'miembro' tiene acceso normal al CRM pero no
  -- puede tocar esta tabla. No confundir con CRM.ROLES para "owner" de
  -- deals/contactos/tareas — eso sigue siendo libre (asesor asignado a un
  -- caso), esto es permiso de administración del propio CRM.
  rol           text not null default 'miembro',

  activo        boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.admins drop constraint if exists admins_rol_check;
alter table public.admins add constraint admins_rol_check check (rol in ('admin', 'miembro'));

-- Único case-insensitivo: isAllowed() y el resto del CRM comparan emails en
-- minúsculas (ver crm/auth.js), así que "Ana@guimaes.es" y "ana@guimaes.es"
-- como dos filas distintas romperían esa lógica en silencio. El unique de
-- la columna (arriba) es case-sensitive y no basta por sí solo.
create unique index if not exists admins_email_lower_idx on public.admins (lower(email));
create index if not exists admins_auth_user_idx on public.admins (auth_user_id);

drop trigger if exists admins_set_updated_at on public.admins;
create trigger admins_set_updated_at
  before update on public.admins
  for each row execute function public.set_updated_at();

-- ============================================================
-- Funciones de apoyo para RLS
-- SECURITY DEFINER: una policy sobre admins que tuviera que hacer
-- "select ... from admins" para decidir si el usuario puede leer/escribir
-- admins provocaría recursión infinita bajo RLS normal. Al declarar la
-- función SECURITY DEFINER (ejecuta con los permisos del dueño de la
-- función, normalmente el rol que corre este script) se evita: la función
-- consulta la tabla sin pasar otra vez por sus propias policies.
-- ============================================================
create or replace function public.is_admin(uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins where auth_user_id = uid and activo = true
  );
$$;

create or replace function public.is_admin_role(uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins where auth_user_id = uid and activo = true and rol = 'admin'
  );
$$;

-- ============================================================
-- RLS — solo administradores autenticados (activos) pueden leer; solo los
-- de rol 'admin' pueden escribir (alta/edición/baja de otros administradores).
-- ============================================================
alter table public.admins enable row level security;

drop policy if exists "admins leen admins" on public.admins;
create policy "admins leen admins"
  on public.admins for select to authenticated using (public.is_admin());

drop policy if exists "rol admin crea admins" on public.admins;
create policy "rol admin crea admins"
  on public.admins for insert to authenticated with check (public.is_admin_role());

drop policy if exists "rol admin actualiza admins" on public.admins;
create policy "rol admin actualiza admins"
  on public.admins for update to authenticated using (public.is_admin_role()) with check (public.is_admin_role());

drop policy if exists "rol admin borra admins" on public.admins;
create policy "rol admin borra admins"
  on public.admins for delete to authenticated using (public.is_admin_role());

-- ============================================================
-- Migración de datos: los 6 administradores que hoy viven hardcodeados en
-- CRM.USERS (crm/data.js). auth_user_id se resuelve emparejando por email
-- contra auth.users — queda NULL (y por tanto sin acceso hasta
-- corregirlo) si esa persona todavía no tiene cuenta creada en Supabase
-- Auth con ese email exacto. Todos migran con rol 'admin' (así es como
-- estaban en el array original: los 6 tenían role:"admin").
-- on conflict (email) do nothing: seguro de volver a ejecutar sin duplicar.
-- ============================================================
insert into public.admins (auth_user_id, nombre, email, rol, activo)
select u.id, m.nombre, m.email, 'admin', true
from (values
  ('Guillermo Guimaes', 'guillermo@guimaes.es'),
  ('Juan Manuel',        'juanmanuel@guimaes.es'),
  ('Macarena',           'macarena@guimaes.es'),
  ('J. Chávarri',        'jchavarrisantiago@gmail.com'),
  ('Levy Tarte',         'levytarteconsulting@gmail.com'),
  ('Guillermo Guimaes',  'guillermogteran@gmail.com')
) as m(nombre, email)
left join auth.users u on lower(u.email) = lower(m.email)
on conflict (email) do nothing;

-- ============================================================
-- Migración de public.tareas.assigned_to: los ids sintéticos "u1".."u6" de
-- CRM.USERS (texto libre, sin FK — ver supabase-tareas.sql) se reemplazan
-- por el uuid real (en texto) de la fila equivalente en admins, resuelta
-- por el email que tenía asignado esa persona en crm/data.js. No toca
-- ninguna otra columna ni fila de tareas.
-- ============================================================
update public.tareas set assigned_to = (select id::text from public.admins where email = 'guillermo@guimaes.es')         where assigned_to = 'u1';
update public.tareas set assigned_to = (select id::text from public.admins where email = 'juanmanuel@guimaes.es')         where assigned_to = 'u2';
update public.tareas set assigned_to = (select id::text from public.admins where email = 'macarena@guimaes.es')           where assigned_to = 'u3';
update public.tareas set assigned_to = (select id::text from public.admins where email = 'jchavarrisantiago@gmail.com')   where assigned_to = 'u4';
update public.tareas set assigned_to = (select id::text from public.admins where email = 'levytarteconsulting@gmail.com') where assigned_to = 'u5';
update public.tareas set assigned_to = (select id::text from public.admins where email = 'guillermogteran@gmail.com')     where assigned_to = 'u6';
