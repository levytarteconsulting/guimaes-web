-- ============================================================
-- GUIMAES — Correo de info@guimaes.es (parte 3: sincronización con pg_cron)
--
-- Llama cada 2 minutos a la Edge Function "correo" (accion sincronizar),
-- con el secreto leído de Vault en cada llamada (mismo patrón que
-- instagram_lanzar). Sin suscripciones de webhook. La propia función reparte
-- el tiempo (corta a los 100 s y reanuda con el nextLink) y reserva cada
-- carpeta, así que dos llamadas seguidas no se pisan.
--
-- Qué crea:
--   * public.correo_cron_sincronizar(): net.http_post a la función con
--     x-hook-secret = 'correo_cron_secret' de Vault; timeout 150 s. Sin
--     EXECUTE para nadie (solo pg_cron, como propietario).
--   * job 'correo-sincronizar' */2.
--   * Registro en supabase_migrations.schema_migrations y notify pgrst.
--
-- Requiere: crm/supabase-correo.sql aplicado; pg_cron, pg_net y
-- supabase_vault; el secreto 'correo_cron_secret' en Vault con el MISMO
-- valor que CORREO_CRON_SECRET en los secrets de la función. El secreto se
-- crea aparte, sin escribirlo en el repo (psql con una variable:
--   select vault.create_secret(:'secreto', 'correo_cron_secret', 'Edge Function correo (pg_cron)');).
--
-- Orden: 3A → copia → secreto en Vault → 3B → 3C.
-- 3A y 3C son solo lectura; 3B es un único DO atómico que se niega a
-- ejecutarse dos veces y no sigue si falta el secreto.
-- ============================================================


-- ============================================================
-- 3A (solo lectura) — Lo esperado:
--   extensiones pg_cron, pg_net, supabase_vault: sí
--   tabla correo_mensajes / correo_sync: sí · migración 20261112120000: sí
--   función correo_cron_sincronizar: 0 · jobs correo-*: 0
--   secreto correo_cron_secret: 0 (se crea entre 3A y 3B)
-- ============================================================
select 'extensión ' || x.n as comprobacion,
       case when exists (select 1 from pg_extension e where e.extname = x.n) then 'sí' else 'NO' end as valor
from (values ('pg_cron'), ('pg_net'), ('supabase_vault')) x(n)
union all
select 'tabla ' || x.n, case when to_regclass('public.' || x.n) is not null then 'sí' else 'NO' end
from (values ('correo_mensajes'), ('correo_sync')) x(n)
union all
select 'migración 20261112120000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261112120000') then 'sí' else 'NO' end
union all
select 'función correo_cron_sincronizar', count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname = 'correo_cron_sincronizar'
union all
select 'jobs correo-*', count(*)::text from cron.job where jobname like 'correo-%'
union all
select 'secreto correo_cron_secret', count(*)::text from vault.secrets where name = 'correo_cron_secret';


-- ============================================================
-- 3B (CAMBIO) — Un único DO; se niega a ejecutarse dos veces.
-- ============================================================
do $b3$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261112150000') then
    raise exception 'La migración 20261112150000 ya está registrada: 3B ya está aplicado. No se ha cambiado nada.';
  end if;
  if to_regprocedure('public.correo_cron_sincronizar()') is not null then
    raise exception 'public.correo_cron_sincronizar() ya existe. No se ha cambiado nada.';
  end if;
  if to_regclass('public.correo_sync') is null then
    raise exception 'Falta crm/supabase-correo.sql (correo_sync). No se ha cambiado nada.';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'correo_cron_secret'
                 and coalesce(decrypted_secret, '') <> '') then
    raise exception 'Falta el secreto correo_cron_secret en Vault. No se ha cambiado nada.';
  end if;

  create function public.correo_cron_sincronizar()
  returns bigint
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_secreto text;
  begin
    select ds.decrypted_secret into v_secreto
    from vault.decrypted_secrets ds
    where ds.name = 'correo_cron_secret';
    if v_secreto is null or v_secreto = '' then
      raise exception 'Falta el secreto correo_cron_secret en Vault';
    end if;
    return net.http_post(
      url                  := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/correo',
      body                 := jsonb_build_object('accion', 'sincronizar'),
      headers              := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_secreto),
      timeout_milliseconds := 150000
    );
  end;
  $f$;
  revoke all on function public.correo_cron_sincronizar() from public, anon, authenticated, service_role;

  perform cron.unschedule(jobid) from cron.job where jobname = 'correo-sincronizar';
  perform cron.schedule('correo-sincronizar', '*/2 * * * *', 'select public.correo_cron_sincronizar();');

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261112150000', null, 'correo cron (crm/supabase-correo-cron.sql)');
end
$b3$;

notify pgrst, 'reload schema';


-- ============================================================
-- 3C (verificación, solo lectura) — Lo esperado en la columna valor:
--   job correo-sincronizar: */2 * * * * · activo=true · select public.correo_cron_sincronizar();
--   correo_cron_sincronizar: lee de Vault, sin secreto escrito · anon/authenticated/service_role = false/false/false
--   secreto correo_cron_secret: 1
--   migración registrada: 20261112150000
-- ============================================================
select 'job ' || j.jobname as comprobacion, j.schedule || ' · activo=' || j.active || ' · ' || j.command as valor
from cron.job j where j.jobname like 'correo-%'
union all
select 'correo_cron_sincronizar',
       case when p.prosrc like '%vault.decrypted_secrets%' and p.prosrc like '%timeout_milliseconds := 150000%'
            then 'lee de Vault, sin secreto escrito' else 'REVISAR' end
       || ' · anon/authenticated/service_role = '
       || has_function_privilege('anon', p.oid, 'EXECUTE') || '/'
       || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/'
       || has_function_privilege('service_role', p.oid, 'EXECUTE')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'correo_cron_sincronizar'
union all
select 'secreto correo_cron_secret', count(*)::text from vault.secrets where name = 'correo_cron_secret'
union all
select 'migración registrada', string_agg(version || ' ' || name, ', ')
from supabase_migrations.schema_migrations where version = '20261112150000';
