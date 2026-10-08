-- ============================================================
-- GUIMAES — Área cliente, FASE 2: lo que necesita el CRM
--
-- admin_cuenta_de_contacto(p_contact_id): la cuenta del área cliente
-- vinculada a un contacto (email, si está confirmada y último acceso), para
-- la sección "Acceso al área cliente" de la ficha de contacto. auth.users no
-- se puede leer desde el navegador; esta RPC lo hace como su dueño y solo
-- para administradores activos. Mismas reglas que admin_cuentas_pendientes
-- (crm/supabase-portal-fase1.sql): SECURITY DEFINER, search_path fijo, sin
-- parámetro de uid, columnas explícitas, EXECUTE solo para authenticated,
-- 42501 si no es admin.
--
-- Bloques, cada uno por separado en Supabase → SQL Editor: 1A, 1B, 1C.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado: ninguna fila (la función aún no existe).
-- ============================================================
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_cuenta_de_contacto';


-- ============================================================
-- 1B (CAMBIO) — Un único DO. Re-ejecutable (create or replace + grants).
-- Sin cuenta vinculada (o contacto inexistente): ninguna fila.
-- ============================================================
do $b1$
begin
  create or replace function public.admin_cuenta_de_contacto(p_contact_id uuid)
  returns table(auth_user_id uuid, email text, email_confirmado boolean, ultimo_acceso timestamptz)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    return query
    select u.id, u.email::text, u.email_confirmed_at is not null, u.last_sign_in_at
    from public.contactos c
    join auth.users u on u.id = c.auth_user_id
    where c.id = p_contact_id;
  end;
  $f$;

  revoke all on function public.admin_cuenta_de_contacto(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.admin_cuenta_de_contacto(uuid) to authenticated;
end
$b1$;


-- ============================================================
-- 1C (verificación) — Lo esperado: una fila con security_definer = true,
-- search_path=public, pg_temp y anon/authenticated/service_role =
-- false/true/false.
-- ============================================================
select p.proname as funcion,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, '; ') as config,
       has_function_privilege('anon', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_authenticated_service
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_cuenta_de_contacto';
