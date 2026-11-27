-- ============================================================
-- GUIMAES — Holded, bloque 2: consultas del asistente y cupo mensual
--
--   * holded_consultas: auditoría de cada consulta del asistente a Holded
--     (usuario, empresa, tipo, fecha, si salió de la caché, llamadas a la
--     API y código de resultado). Sin el contenido. Sin acceso para
--     authenticated: la escribe solo la Edge Function holded-proxy.
--   * holded_conexiones.cupo_mensual (150 por defecto): tope propio de
--     llamadas a Holded al mes por empresa (mes natural, hora de Madrid).
--     Cuenta la suma de holded_consultas.llamadas del mes; lo que sale de
--     la caché no cuenta. Lo cambia el rol admin con holded_cambiar_cupo.
--   * Para holded-proxy (solo service_role; comprueban que p_usuario es
--     usuario activo del CRM):
--       holded_iniciar  — conexión, caché y cupo; reserva llamadas de forma
--                         atómica (bloquea la fila de la conexión), así dos
--                         consultas a la vez no pasan del cupo.
--       holded_terminar — llamadas hechas de verdad (≤ las reservadas) y
--                         código de resultado.
--   * Para el CRM: holded_uso_mes (is_admin) y holded_cambiar_cupo (rol admin).
--
-- Migración 20261127160000. Ejecutar en orden 7A → 7B → 7C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/holded).
-- ============================================================


-- ============================================================
-- 7A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127140000 (bloque 1): sí
--   migración 20261127160000: no
--   tabla holded_consultas: 0        columna cupo_mensual: 0
--   funciones nuevas: 0              holded_clave_de: 1
--   is_admin(uuid) / is_admin_role(uuid): 1/1
--   conexiones: (anotar, para compararlo con 7C)
-- ============================================================
select 'migración 20261127140000 (bloque 1)' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127140000')
            then 'sí' else 'no' end as valor
union all
select 'migración 20261127160000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127160000')
            then 'sí' else 'no' end
union all
select 'tabla holded_consultas', count(*)::text from pg_class
 where relnamespace = 'public'::regnamespace and relname = 'holded_consultas'
union all
select 'columna cupo_mensual', count(*)::text from information_schema.columns
 where table_schema = 'public' and table_name = 'holded_conexiones' and column_name = 'cupo_mensual'
union all
select 'funciones nuevas', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('holded_iniciar', 'holded_terminar', 'holded_uso_mes', 'holded_cambiar_cupo', 'holded_inicio_mes')
union all
select 'holded_clave_de', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace and proname = 'holded_clave_de'
union all
select 'is_admin(uuid) / is_admin_role(uuid)',
       (to_regprocedure('public.is_admin(uuid)') is not null)::int || '/' || (to_regprocedure('public.is_admin_role(uuid)') is not null)::int
union all
select 'conexiones', count(*)::text from public.holded_conexiones;


-- ============================================================
-- 7B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261127160000')
     or to_regclass('public.holded_consultas') is not null then
    raise exception 'La migración 20261127160000 (Holded, consultas) ya está aplicada: 7B no se repite. No se ha cambiado nada.';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261127140000') then
    raise exception 'Falta la migración 20261127140000 (Holded, conexiones): no se toca nada.';
  end if;

  -- ===================== cupo =====================
  alter table public.holded_conexiones
    add column cupo_mensual integer not null default 150 check (cupo_mensual between 0 and 100000);
  grant select (cupo_mensual) on public.holded_conexiones to authenticated;

  -- ===================== auditoría =====================
  create table public.holded_consultas (
    id            uuid primary key default gen_random_uuid(),
    created_at    timestamptz not null default now(),
    auth_user_id  uuid not null,
    empresa_id    uuid references public.empresas(id) on delete set null,
    tipo          text not null check (tipo in ('facturas', 'resumen', 'contactos', 'tesoreria')),
    desde_cache   boolean not null default false,
    -- Mientras está en curso, las llamadas reservadas; al terminar, las
    -- hechas de verdad. Una consulta que no termina deja su reserva contada.
    llamadas      integer not null default 0 check (llamadas between 0 and 1000),
    codigo        text not null default 'en_curso' check (length(codigo) between 1 and 30),
    terminada_at  timestamptz
  );
  comment on table public.holded_consultas is
    'Consultas del asistente a Holded (crm/supabase-holded-consultas.sql): quién, empresa, tipo, fecha y resultado; sin contenido.';
  create index holded_consultas_empresa_fecha on public.holded_consultas (empresa_id, created_at);
  alter table public.holded_consultas enable row level security;
  revoke all on public.holded_consultas from anon, authenticated;

  -- Inicio del mes natural en Madrid.
  create function public.holded_inicio_mes()
  returns timestamptz
  language sql
  stable
  set search_path = public, pg_temp
  as $f$
    select date_trunc('month', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid'
  $f$;
  revoke all on function public.holded_inicio_mes() from public, anon;
  grant execute on function public.holded_inicio_mes() to authenticated, service_role;

  -- ===================== holded-proxy (service_role) =====================
  -- p_version_cache: la versión de la conexión con la que holded-proxy tiene
  -- ese resultado en caché (null si no lo tiene). Si coincide, la consulta
  -- sale de la caché: no se reserva nada ni se mira el cupo.
  create function public.holded_iniciar(p_usuario uuid, p_empresa uuid, p_tipo text, p_max integer, p_version_cache text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_con public.holded_conexiones%rowtype;
    v_version text;
    v_usadas int;
    v_res int;
    v_id uuid;
  begin
    if not public.is_admin(p_usuario) then
      raise exception 'Solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_tipo is null or p_tipo not in ('facturas', 'resumen', 'contactos', 'tesoreria') then
      raise exception 'Tipo de consulta no válido' using errcode = '22023';
    end if;
    if p_max is null or p_max < 1 or p_max > 50 then
      raise exception 'Máximo de llamadas no válido' using errcode = '22023';
    end if;

    select * into v_con from public.holded_conexiones where empresa_id = p_empresa for update;
    if not found then
      insert into public.holded_consultas (auth_user_id, empresa_id, tipo, codigo, terminada_at)
      values (p_usuario, (select id from public.empresas where id = p_empresa), p_tipo, 'sin_conexion', now());
      return jsonb_build_object('ok', false, 'motivo', 'sin_conexion');
    end if;
    if v_con.estado = 'error' then
      insert into public.holded_consultas (auth_user_id, empresa_id, tipo, codigo, terminada_at)
      values (p_usuario, p_empresa, p_tipo, 'conexion_error', now());
      return jsonb_build_object('ok', false, 'motivo', 'conexion_error', 'error', v_con.ultimo_error);
    end if;

    v_version := md5(v_con.secreto_id::text);
    if p_version_cache is not null and p_version_cache = v_version then
      insert into public.holded_consultas (auth_user_id, empresa_id, tipo, desde_cache, codigo, terminada_at)
      values (p_usuario, p_empresa, p_tipo, true, '200', now());
      return jsonb_build_object('ok', true, 'desde_cache', true);
    end if;

    select coalesce(sum(q.llamadas), 0) into v_usadas from public.holded_consultas q
     where q.empresa_id = p_empresa and not q.desde_cache and q.created_at >= public.holded_inicio_mes();
    if v_usadas >= v_con.cupo_mensual then
      insert into public.holded_consultas (auth_user_id, empresa_id, tipo, codigo, terminada_at)
      values (p_usuario, p_empresa, p_tipo, 'cupo', now());
      return jsonb_build_object('ok', false, 'motivo', 'cupo', 'usadas', v_usadas, 'cupo', v_con.cupo_mensual);
    end if;

    v_res := least(p_max, v_con.cupo_mensual - v_usadas);
    insert into public.holded_consultas (auth_user_id, empresa_id, tipo, llamadas)
    values (p_usuario, p_empresa, p_tipo, v_res)
    returning id into v_id;
    return jsonb_build_object('ok', true, 'desde_cache', false, 'consulta_id', v_id, 'reservadas', v_res,
                              'version', v_version, 'usadas', v_usadas, 'cupo', v_con.cupo_mensual);
  end;
  $f$;
  revoke all on function public.holded_iniciar(uuid, uuid, text, integer, text) from public, anon, authenticated, service_role;
  grant execute on function public.holded_iniciar(uuid, uuid, text, integer, text) to service_role;

  -- Cierra una consulta: libera lo reservado y no usado.
  create function public.holded_terminar(p_consulta uuid, p_llamadas integer, p_codigo text)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    update public.holded_consultas
       set llamadas = least(llamadas, greatest(coalesce(p_llamadas, llamadas), 0)),
           codigo = left(coalesce(nullif(p_codigo, ''), 'error'), 30),
           terminada_at = now()
     where id = p_consulta and codigo = 'en_curso';
  end;
  $f$;
  revoke all on function public.holded_terminar(uuid, integer, text) from public, anon, authenticated, service_role;
  grant execute on function public.holded_terminar(uuid, integer, text) to service_role;

  -- ===================== CRM (authenticated) =====================
  -- Llamadas usadas este mes y cupo, por empresa conectada (o solo una).
  create function public.holded_uso_mes(p_empresa_id uuid default null)
  returns table (empresa_id uuid, usadas integer, cupo integer)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin() then
      raise exception 'Solo usuarios activos del CRM' using errcode = '42501';
    end if;
    return query
      select c.empresa_id,
             coalesce((select sum(q.llamadas) from public.holded_consultas q
                        where q.empresa_id = c.empresa_id and not q.desde_cache
                          and q.created_at >= public.holded_inicio_mes()), 0)::int,
             c.cupo_mensual
        from public.holded_conexiones c
       where p_empresa_id is null or c.empresa_id = p_empresa_id;
  end;
  $f$;
  revoke all on function public.holded_uso_mes(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.holded_uso_mes(uuid) to authenticated;

  create function public.holded_cambiar_cupo(p_empresa_id uuid, p_cupo integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_n int;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede cambiar el cupo de Holded' using errcode = '42501';
    end if;
    if p_cupo is null or p_cupo < 0 or p_cupo > 100000 then
      raise exception 'El cupo tiene que estar entre 0 y 100.000 llamadas al mes' using errcode = '22023';
    end if;
    update public.holded_conexiones set cupo_mensual = p_cupo where empresa_id = p_empresa_id;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      raise exception 'Esa empresa no tiene Holded conectado' using errcode = 'GU010';
    end if;
    return jsonb_build_object('empresa_id', p_empresa_id, 'cupo', p_cupo);
  end;
  $f$;
  revoke all on function public.holded_cambiar_cupo(uuid, integer) from public, anon, authenticated, service_role;
  grant execute on function public.holded_cambiar_cupo(uuid, integer) to authenticated;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261127160000', array['holded_consultas, holded_conexiones.cupo_mensual, holded_iniciar/terminar/uso_mes/cambiar_cupo'],
          'Holded: consultas del asistente y cupo (crm/supabase-holded-consultas.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 7C (verificación, solo lectura) — Lo esperado:
--   holded_consultas con RLS / políticas: 1/0
--   authenticated SELECT/INSERT holded_consultas: no/no
--   authenticated SELECT cupo_mensual / UPDATE holded_conexiones: sí/no
--   cupo_mensual por defecto en las conexiones: todas 150
--   EXECUTE authenticated holded_iniciar/terminar: no/no
--   EXECUTE service_role holded_iniciar/terminar: sí/sí
--   EXECUTE anon/authenticated holded_uso_mes: no/sí
--   EXECUTE anon/authenticated holded_cambiar_cupo: no/sí
--   conexiones: las mismas que en 7A
--   migración registrada: 20261127160000 ...
-- ============================================================
select 'holded_consultas con RLS / políticas' as comprobacion,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname = 'holded_consultas' and relrowsecurity)::text
       || '/' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'holded_consultas')::text as valor
union all
select 'authenticated SELECT/INSERT holded_consultas',
       (case when has_any_column_privilege('authenticated', 'public.holded_consultas', 'select') then 'sí' else 'no' end) || '/' ||
       (case when has_table_privilege('authenticated', 'public.holded_consultas', 'insert') then 'sí' else 'no' end)
union all
select 'authenticated SELECT cupo_mensual / UPDATE holded_conexiones',
       (case when has_column_privilege('authenticated', 'public.holded_conexiones', 'cupo_mensual', 'select') then 'sí' else 'no' end) || '/' ||
       (case when has_any_column_privilege('authenticated', 'public.holded_conexiones', 'update') then 'sí' else 'no' end)
union all
select 'cupo_mensual por defecto en las conexiones',
       case when not exists (select 1 from public.holded_conexiones where cupo_mensual <> 150) then 'todas 150' else 'NO' end
union all
select 'EXECUTE authenticated holded_iniciar/terminar',
       (case when has_function_privilege('authenticated', 'public.holded_iniciar(uuid, uuid, text, integer, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_terminar(uuid, integer, text)', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE service_role holded_iniciar/terminar',
       (case when has_function_privilege('service_role', 'public.holded_iniciar(uuid, uuid, text, integer, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('service_role', 'public.holded_terminar(uuid, integer, text)', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE anon/authenticated holded_uso_mes',
       (case when has_function_privilege('anon', 'public.holded_uso_mes(uuid)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_uso_mes(uuid)', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE anon/authenticated holded_cambiar_cupo',
       (case when has_function_privilege('anon', 'public.holded_cambiar_cupo(uuid, integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_cambiar_cupo(uuid, integer)', 'execute') then 'sí' else 'no' end)
union all
select 'conexiones', count(*)::text from public.holded_conexiones
union all
select 'migración registrada', version || ' ' || name
  from supabase_migrations.schema_migrations where version = '20261127160000';
