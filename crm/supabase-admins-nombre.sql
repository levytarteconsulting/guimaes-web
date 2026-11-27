-- ============================================================
-- GUIMAES — Cambiar el nombre de un usuario del CRM (tabla admins)
--
--   * RPC admin_renombrar_usuario(p_admin_id, p_nombre), security definer:
--     el rol admin renombra a cualquiera; cada usuario activo, a sí mismo.
--     Solo cambia admins.nombre (email, rol y estado no se tocan).
--   * Trigger admins_nombre_valido (BEFORE INSERT / UPDATE OF nombre):
--     quita espacios al principio y al final, exige nombre y rechaza un
--     nombre que ya tenga otro usuario (sin tildes ni mayúsculas). Vale
--     para todos los caminos: la RPC, el alta (Edge Function admin-users)
--     y los UPDATE directos. Los duplicados que ya existan no se tocan:
--     solo se comprueba la fila que cambia de nombre.
--   * Privilegios: authenticated ya no puede hacer UPDATE de email ni de
--     auth_user_id (el email va ligado al inicio de sesión); sigue
--     pudiendo nombre, rol y activo, con la RLS de siempre (rol admin).
--
-- Migración 20261127120000. Ejecutar en orden 5A → 5B → 5C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/importador).
-- ============================================================


-- ============================================================
-- 5A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127120000: no
--   función admin_renombrar_usuario: 0     trigger admins_nombre_valido: 0
--   authenticated puede UPDATE email: sí
--   funciones base (is_admin, is_admin_role, agente_norm): 3
--   filas admins: (anotar, para compararlo con 5C)
-- ============================================================
select 'migración 20261127120000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127120000')
            then 'sí' else 'no' end as valor
union all
select 'función admin_renombrar_usuario', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace and proname = 'admin_renombrar_usuario'
union all
select 'trigger admins_nombre_valido', count(*)::text from pg_trigger
 where tgrelid = 'public.admins'::regclass and tgname = 'admins_nombre_valido'
union all
select 'authenticated puede UPDATE email',
       case when has_column_privilege('authenticated', 'public.admins', 'email', 'update') then 'sí' else 'no' end
union all
select 'funciones base (is_admin, is_admin_role, agente_norm)', count(distinct proname)::text from pg_proc
 where pronamespace = 'public'::regnamespace and proname in ('is_admin', 'is_admin_role', 'agente_norm')
union all
select 'filas admins', count(*)::text from public.admins;


-- ============================================================
-- 5B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261127120000')
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_renombrar_usuario') then
    raise exception 'La migración 20261127120000 (renombrar usuarios) ya está aplicada: 5B no se repite. No se ha cambiado nada.';
  end if;

  create function public.admins_nombre_valido()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    new.nombre := btrim(regexp_replace(coalesce(new.nombre, ''), '\s+', ' ', 'g'));
    if new.nombre = '' then
      raise exception 'El nombre es obligatorio' using errcode = '23514';
    end if;
    if length(new.nombre) > 80 then
      raise exception 'El nombre no puede pasar de 80 caracteres' using errcode = '23514';
    end if;
    -- Sin cambio real de nombre (solo espacios, mayúsculas o tildes): no se
    -- comprueba duplicado, para no bloquear a los repetidos que ya existen.
    if tg_op = 'UPDATE' and public.agente_norm(btrim(old.nombre)) = public.agente_norm(new.nombre) then
      return new;
    end if;
    if exists (select 1 from public.admins a
                where a.id <> new.id
                  and public.agente_norm(btrim(a.nombre)) = public.agente_norm(new.nombre)) then
      raise exception 'Ya hay otro usuario que se llama «%»', new.nombre using errcode = '23505';
    end if;
    return new;
  end;
  $f$;
  revoke all on function public.admins_nombre_valido() from public, anon, authenticated, service_role;

  create trigger admins_nombre_valido
    before insert or update of nombre on public.admins
    for each row execute function public.admins_nombre_valido();

  create function public.admin_renombrar_usuario(p_admin_id uuid, p_nombre text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_fila public.admins%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'Solo usuarios activos del CRM' using errcode = '42501';
    end if;
    select * into v_fila from public.admins where id = p_admin_id for update;
    if not found then
      raise exception 'Ese usuario no existe' using errcode = 'GU010';
    end if;
    if not public.is_admin_role() and v_fila.auth_user_id is distinct from auth.uid() then
      raise exception 'Solo el rol admin puede cambiar el nombre de otros usuarios' using errcode = '42501';
    end if;
    update public.admins set nombre = p_nombre where id = p_admin_id
    returning * into v_fila;
    return jsonb_build_object('id', v_fila.id, 'nombre', v_fila.nombre);
  end;
  $f$;
  revoke all on function public.admin_renombrar_usuario(uuid, text) from public, anon, authenticated, service_role;
  grant execute on function public.admin_renombrar_usuario(uuid, text) to authenticated;

  -- Email y auth_user_id: fuera del alcance de authenticated.
  revoke update on public.admins from authenticated;
  grant update (nombre, rol, activo) on public.admins to authenticated;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261127120000', array['admins_nombre_valido, admin_renombrar_usuario, update (nombre, rol, activo) on admins'],
          'renombrar usuarios (crm/supabase-admins-nombre.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 5C (verificación, solo lectura) — Lo esperado:
--   función admin_renombrar_usuario (definer): 1   EXECUTE anon/authenticated: no/sí
--   trigger admins_nombre_valido: 1
--   authenticated UPDATE email/auth_user_id: no/no
--   authenticated UPDATE nombre/rol/activo: sí/sí/sí
--   filas admins: las mismas que en 5A
--   migración registrada: 20261127120000 ...
-- ============================================================
select 'función admin_renombrar_usuario (definer)' as comprobacion, count(*)::text as valor from pg_proc
 where pronamespace = 'public'::regnamespace and proname = 'admin_renombrar_usuario' and prosecdef
union all
select 'EXECUTE anon/authenticated',
       (case when has_function_privilege('anon', 'public.admin_renombrar_usuario(uuid, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.admin_renombrar_usuario(uuid, text)', 'execute') then 'sí' else 'no' end)
union all
select 'trigger admins_nombre_valido', count(*)::text from pg_trigger
 where tgrelid = 'public.admins'::regclass and tgname = 'admins_nombre_valido'
union all
select 'authenticated UPDATE email/auth_user_id',
       (case when has_column_privilege('authenticated', 'public.admins', 'email', 'update') then 'sí' else 'no' end) || '/' ||
       (case when has_column_privilege('authenticated', 'public.admins', 'auth_user_id', 'update') then 'sí' else 'no' end)
union all
select 'authenticated UPDATE nombre/rol/activo',
       (case when has_column_privilege('authenticated', 'public.admins', 'nombre', 'update') then 'sí' else 'no' end) || '/' ||
       (case when has_column_privilege('authenticated', 'public.admins', 'rol', 'update') then 'sí' else 'no' end) || '/' ||
       (case when has_column_privilege('authenticated', 'public.admins', 'activo', 'update') then 'sí' else 'no' end)
union all
select 'filas admins', count(*)::text from public.admins
union all
select 'migración registrada', version || ' ' || name
  from supabase_migrations.schema_migrations where version = '20261127120000';
