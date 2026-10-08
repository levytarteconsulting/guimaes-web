-- ============================================================
-- GUIMAES — Área cliente, FASE 0: seguridad previa
--
-- Antes de reactivar el registro público, nada de lo que hoy da por hecho
-- "toda cuenta de auth.users es del equipo" puede seguir así:
--   1. push_subscriptions: solo administradores activos (la Edge Function
--      push-send filtra además por admins; ver su index.ts).
--   2. contactos.auth_user_id: como mucho un contacto por cuenta, y FK a
--      auth.users para que borrar una cuenta no deje el vínculo colgando.
--
-- El cliente del portal NO tendrá políticas RLS sobre tablas ni Storage:
-- todo irá por RPC SECURITY DEFINER y Edge Functions (fases siguientes).
--
-- Cada bloque se ejecuta por separado en Supabase → SQL Editor, en orden:
-- 1A, 1B, 1C, 3A, 3B, 3C. Cada bloque es una sola sentencia (el editor
-- solo enseña la última y el pooler puede repartir sentencias entre
-- conexiones).
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Suscripciones push cuyo user_id NO es un admin
-- activo. Lo esperado: ninguna fila. Si sale alguna, para y avisa: el
-- bloque 1B no borra suscripciones (push-send ya las ignora), pero hay
-- que decidir qué hacer con ellas.
-- ============================================================
select ps.id, ps.user_id, u.email, ps.device_label, ps.created_at, ps.last_seen_at,
       case when a.id is null then 'no es admin' else 'admin inactivo' end as motivo
from public.push_subscriptions ps
left join auth.users u    on u.id = ps.user_id
left join public.admins a on a.auth_user_id = ps.user_id
where a.id is null or not a.activo
order by ps.created_at;


-- ============================================================
-- 1B (CAMBIO) — Políticas de push_subscriptions: cada usuario solo sus
-- filas Y además admin activo. Un único DO: atómico.
-- Borra TODAS las políticas de la tabla (también las creadas a mano desde
-- el dashboard con otro nombre) y crea el juego exacto, mismo criterio que
-- crm/supabase-rls-solo-admins.sql. Mismas cuatro operaciones que hoy:
-- UPDATE hace falta para el upsert de re-suscripción.
-- ============================================================
do $b1$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'push_subscriptions'
  loop
    execute format('drop policy %I on public.push_subscriptions', p.policyname);
  end loop;

  alter table public.push_subscriptions enable row level security;

  create policy "admins leen sus push_subscriptions"
    on public.push_subscriptions for select to authenticated
    using ((select auth.uid()) = user_id and (select public.is_admin()));
  create policy "admins crean sus push_subscriptions"
    on public.push_subscriptions for insert to authenticated
    with check ((select auth.uid()) = user_id and (select public.is_admin()));
  create policy "admins actualizan sus push_subscriptions"
    on public.push_subscriptions for update to authenticated
    using ((select auth.uid()) = user_id and (select public.is_admin()))
    with check ((select auth.uid()) = user_id and (select public.is_admin()));
  create policy "admins borran sus push_subscriptions"
    on public.push_subscriptions for delete to authenticated
    using ((select auth.uid()) = user_id and (select public.is_admin()));
end
$b1$;


-- ============================================================
-- 1C (verificación) — Políticas resultantes. Lo esperado: exactamente
-- estas cuatro, todas "to authenticated" y todas con auth.uid() = user_id
-- e is_admin(). RLS activa.
-- ============================================================
select p.policyname, p.cmd, p.roles, p.qual, p.with_check,
       c.relrowsecurity as rls_activa
from pg_policies p
join pg_class c on c.oid = 'public.push_subscriptions'::regclass
where p.schemaname = 'public' and p.tablename = 'push_subscriptions'
order by p.cmd, p.policyname;


-- ============================================================
-- 3A (solo lectura) — Estado de contactos.auth_user_id y registered.
-- Lo esperado: ninguna fila. Si sale alguna, NO ejecutes 3B y avisa
-- (3B, además, se niega a seguir en cualquiera de los tres casos).
-- ============================================================
select 'auth_user_id duplicado' as problema,
       c.auth_user_id::text as auth_user_id,
       count(*)::text || ' contactos: ' || string_agg(coalesce(c.full_name, c.email, c.id::text), ', ') as detalle
from public.contactos c
where c.auth_user_id is not null
group by c.auth_user_id
having count(*) > 1
union all
select 'auth_user_id que no existe en auth.users',
       c.auth_user_id::text,
       coalesce(c.full_name, c.email, '') || ' [' || c.id || ']'
from public.contactos c
where c.auth_user_id is not null
  and not exists (select 1 from auth.users u where u.id = c.auth_user_id)
union all
select 'registered = true',
       c.auth_user_id::text,
       coalesce(c.full_name, c.email, '') || ' [' || c.id || ']'
from public.contactos c
where c.registered
order by 1, 2;


-- ============================================================
-- 3B (CAMBIO) — Índice único parcial y FK. Un único DO: atómico.
-- ON DELETE SET NULL: borrar la cuenta de Auth (p. ej. "eliminar cuenta"
-- desde el CRM) deja el contacto intacto y sin vínculo, que es justo el
-- estado "sin acceso". El índice parcial también sirve a la FK para el
-- SET NULL (auth_user_id = X implica auth_user_id IS NOT NULL).
-- contactos.registered no se toca (paso B).
-- ============================================================
do $b3$
declare
  n bigint;
begin
  if exists (select 1 from pg_constraint
             where conrelid = 'public.contactos'::regclass and conname = 'contactos_auth_user_id_fkey')
     or to_regclass('public.contactos_auth_user_id_key') is not null then
    raise exception 'contactos_auth_user_id_fkey o contactos_auth_user_id_key ya existen: 3B ya está aplicado. No se ha cambiado nada.';
  end if;

  -- Las mismas comprobaciones que 3A, por si se ejecuta sin haberlo mirado.
  select count(*) into n from (
    select auth_user_id from public.contactos
    where auth_user_id is not null group by auth_user_id having count(*) > 1) x;
  if n > 0 then
    raise exception 'Hay % auth_user_id duplicados en contactos (ver 3A). No se ha cambiado nada.', n;
  end if;
  select count(*) into n from public.contactos c
  where c.auth_user_id is not null
    and not exists (select 1 from auth.users u where u.id = c.auth_user_id);
  if n > 0 then
    raise exception 'Hay % contactos con auth_user_id que no existe en auth.users (ver 3A). No se ha cambiado nada.', n;
  end if;
  -- (registered ya no existe desde crm/supabase-pasoB.sql: en una
  -- instalación nueva no hay nada que comprobar.)
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'contactos' and column_name = 'registered') then
    execute 'select count(*) from public.contactos where registered' into n;
    if n > 0 then
      raise exception 'Hay % contactos con registered = true (ver 3A). No se ha cambiado nada.', n;
    end if;
  end if;

  create unique index contactos_auth_user_id_key
    on public.contactos (auth_user_id)
    where auth_user_id is not null;

  alter table public.contactos
    add constraint contactos_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users(id) on delete set null;
end
$b3$;


-- ============================================================
-- 3C (verificación) — Definición resultante de contactos.auth_user_id.
-- Lo esperado: columna uuid nullable; el índice único parcial y la FK
-- ON DELETE SET NULL a auth.users(id).
-- ============================================================
select 'columna' as tipo, column_name::text as nombre,
       data_type || case when is_nullable = 'YES' then ', nullable' else ', NOT NULL' end as definicion
from information_schema.columns
where table_schema = 'public' and table_name = 'contactos' and column_name = 'auth_user_id'
union all
select 'restriccion', conname::text, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.contactos'::regclass
  and pg_get_constraintdef(oid) ilike '%auth_user_id%'
union all
select 'indice', indexname::text, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'contactos' and indexdef ilike '%auth_user_id%'
order by 1, 2;
