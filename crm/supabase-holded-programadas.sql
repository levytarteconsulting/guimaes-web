-- ============================================================
-- GUIMAES — Holded: acciones programadas (aprobar tickets cada noche)
--
-- Para una empresa con la programación activa, cada día a partir de la hora
-- fijada (23:00 de Madrid por defecto) el sistema propone «aprobar tickets
-- de venta» de TODOS los tickets pendientes con fecha de ese día o anterior,
-- en tandas de hasta 1000, una detrás de otra, hasta que no quede ninguno.
-- Cada tanda es una propuesta normal (holded_acciones, origen «operador»):
-- solo se aprueba sola si la política de la empresa es automática y está
-- dentro de sus topes (holded_acciones_politicas); si no, se queda en
-- «propuesta» en Acciones y la noche se para. Los tickets dudosos que la
-- propuesta aparta nunca se aprueban solos.
--
-- La noche se para (y lo deja escrito en ultimo_resultado) si una tanda:
-- no se aprueba sola, queda pausada (cupo o Holded), se cancela o rechaza,
-- termina sin aprobar ningún ticket, o se llega a 20 tandas en una noche.
--
-- Qué crea:
--   · holded_acciones_programadas (RLS: solo el rol admin la ve).
--   · holded_cambiar_programacion(...)  rol admin: activar/desactivar y
--     «ejecutar ahora» (una pasada fuera de hora que no cuenta como la del día).
--   · holded_programadas_turno()        service_role: qué tanda toca pedir.
--   · holded_programada_registrar(...)  service_role: resultado de una tanda.
--   · holded_programadas_cron() + tarea pg_cron «holded-acciones-programadas»
--     cada 10 minutos (solo llama a la función si hay algo que hacer).
-- Requiere: supabase-holded-acciones.sql y supabase-holded-operaciones.sql.
-- Patrón: 14A → 14B (un DO que se niega a repetirse) → 14C.
-- Probado en PGlite: crm/tests/holded/holded-programadas.test.mjs.
-- ============================================================


-- ============================================================
-- 14A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127230000: sí     migración 20261128220000: no
--   tabla holded_acciones_programadas: 0     tarea holded-acciones-programadas: 0
--   secreto holded_acciones_cron_secret: 1
-- ============================================================
select 'migración 20261127230000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127230000') then 'sí' else 'no' end as valor
union all select 'migración 20261128220000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128220000') then 'sí' else 'no' end
union all select 'tabla holded_acciones_programadas',
       (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = 'holded_acciones_programadas')
union all select 'tarea holded-acciones-programadas',
       (select count(*)::text from cron.job where jobname = 'holded-acciones-programadas')
union all select 'secreto holded_acciones_cron_secret',
       (select count(*)::text from vault.decrypted_secrets where name = 'holded_acciones_cron_secret');


-- ============================================================
-- 14B (cambio, atómico, se niega a repetirse)
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261128220000')
     or to_regclass('public.holded_acciones_programadas') is not null then
    raise exception 'La migración 20261128220000 ya está aplicada. No se ha cambiado nada.';
  end if;
  if to_regclass('public.holded_acciones_politicas') is null or to_regprocedure('public.holded_acciones_purgar()') is null then
    raise exception 'Faltan supabase-holded-acciones.sql o supabase-holded-operaciones.sql. No se ha cambiado nada.';
  end if;

  create table public.holded_acciones_programadas (
    empresa_id            uuid not null references public.empresas(id) on delete cascade,
    tipo                  text not null check (tipo in ('aprobar_tickets_venta')),
    activa                boolean not null default false,
    hora                  smallint not null default 23 check (hora between 0 and 23),   -- hora de Madrid
    dia_en_curso          date,               -- pasada en marcha: tickets con fecha hasta este día
    en_curso_manual       boolean not null default false,   -- «ejecutar ahora»: no cuenta como la del día
    tandas                integer not null default 0,
    pedida_at             timestamptz,        -- tanda pedida a la función y aún sin registrar
    ultima_accion_id      uuid references public.holded_acciones(id) on delete set null,
    ultimo_dia_completado date,
    ultima_ejecucion_at   timestamptz,
    ultimo_resultado      text check (ultimo_resultado is null or length(ultimo_resultado) <= 300),
    updated_by            uuid,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    primary key (empresa_id, tipo)
  );
  comment on table public.holded_acciones_programadas is
    'Acciones de Holded que se proponen solas cada día (crm/supabase-holded-programadas.sql).';
  create trigger holded_acciones_programadas_set_updated_at before update on public.holded_acciones_programadas
    for each row execute function public.set_updated_at();
  alter table public.holded_acciones_programadas enable row level security;
  create policy "rol admin ve las programaciones" on public.holded_acciones_programadas
    for select to authenticated using ((select public.is_admin_role()));
  revoke all on public.holded_acciones_programadas from anon, authenticated;
  grant select on public.holded_acciones_programadas to authenticated;
  grant all on public.holded_acciones_programadas to service_role;

  -- ===================== activar / desactivar (rol admin) =====================
  create function public.holded_cambiar_programacion(p_empresa_id uuid, p_tipo text, p_activa boolean, p_ejecutar_ahora boolean default false)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v public.holded_acciones_programadas%rowtype;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede cambiar las acciones programadas' using errcode = '42501';
    end if;
    if p_tipo is null or p_tipo not in ('aprobar_tickets_venta') then
      raise exception 'Tipo de acción no permitido' using errcode = '22023';
    end if;
    if p_activa is null then raise exception 'Falta activa' using errcode = '22023'; end if;
    if not exists (select 1 from public.holded_conexiones where empresa_id = p_empresa_id) then
      raise exception 'Esa empresa no tiene Holded conectado' using errcode = 'GU010';
    end if;
    insert into public.holded_acciones_programadas (empresa_id, tipo, activa, updated_by)
    values (p_empresa_id, p_tipo, p_activa, auth.uid())
    on conflict (empresa_id, tipo) do update set activa = excluded.activa, updated_by = excluded.updated_by
    returning * into v;
    if not p_activa then
      -- Deja de pedir tandas. Una tanda ya aprobada sigue (se pausa o cancela desde Acciones).
      update public.holded_acciones_programadas
         set dia_en_curso = null, en_curso_manual = false, pedida_at = null,
             ultimo_resultado = 'Desactivada' || case when v.dia_en_curso is not null then ' con una pasada en marcha' else '' end || '.'
       where empresa_id = p_empresa_id and tipo = p_tipo returning * into v;
    elsif coalesce(p_ejecutar_ahora, false) and v.dia_en_curso is null then
      update public.holded_acciones_programadas
         set dia_en_curso = (now() at time zone 'Europe/Madrid')::date, en_curso_manual = true, tandas = 0,
             pedida_at = null, ultima_accion_id = null, ultimo_resultado = 'Pasada manual pedida.'
       where empresa_id = p_empresa_id and tipo = p_tipo returning * into v;
    end if;
    return jsonb_build_object('empresa_id', v.empresa_id, 'tipo', v.tipo, 'activa', v.activa, 'dia_en_curso', v.dia_en_curso);
  end;
  $f$;

  -- ===================== cerrar la pasada de una noche (interna) =====================
  create function public.holded_programada_cerrar(p_empresa uuid, p_tipo text, p_mensaje text)
  returns void
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
    update public.holded_acciones_programadas
       set ultimo_dia_completado = case when en_curso_manual then ultimo_dia_completado else dia_en_curso end,
           dia_en_curso = null, en_curso_manual = false, pedida_at = null,
           ultimo_resultado = left(p_mensaje, 300)
     where empresa_id = p_empresa and tipo = p_tipo;
  $f$;

  -- ===================== qué tanda toca (service_role) =====================
  -- Devuelve [{empresa_id, tipo, hasta, tanda}] con las tandas que hay que pedir
  -- ahora. Marca pedida_at para no pedir dos veces la misma (15 min de margen).
  create function public.holded_programadas_turno()
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v public.holded_acciones_programadas%rowtype;
    v_hoy date := (now() at time zone 'Europe/Madrid')::date;
    v_hora int := extract(hour from (now() at time zone 'Europe/Madrid'))::int;
    v_estado text;
    v_ok int;
    v_out jsonb := '[]'::jsonb;
  begin
    for v in select * from public.holded_acciones_programadas where activa order by empresa_id, tipo for update skip locked loop
      if v.dia_en_curso is null then
        continue when v_hora < v.hora or (v.ultimo_dia_completado is not null and v.ultimo_dia_completado >= v_hoy);
        update public.holded_acciones_programadas
           set dia_en_curso = v_hoy, en_curso_manual = false, tandas = 0, pedida_at = null, ultima_accion_id = null
         where empresa_id = v.empresa_id and tipo = v.tipo returning * into v;
      end if;
      -- Una tanda pedida hace poco y aún sin registrar: esperar.
      continue when v.pedida_at is not null and v.pedida_at > now() - interval '15 minutes';
      if v.ultima_accion_id is not null then
        select estado into v_estado from public.holded_acciones where id = v.ultima_accion_id;
        continue when v_estado in ('aprobada', 'en_curso');   -- la anterior aún se está ejecutando
        if v_estado = 'propuesta' then
          perform public.holded_programada_cerrar(v.empresa_id, v.tipo,
            format('Parada en la tanda %s: no se aprobó sola (revisa la política automática). Queda en Acciones.', v.tandas));
          continue;
        elsif v_estado = 'pausada' then
          perform public.holded_programada_cerrar(v.empresa_id, v.tipo,
            format('Parada en la tanda %s: está pausada (cupo de acciones o Holded). Se reanuda desde Acciones.', v.tandas));
          continue;
        elsif v_estado in ('cancelada', 'rechazada') then
          perform public.holded_programada_cerrar(v.empresa_id, v.tipo, format('Parada: la tanda %s fue %s.', v.tandas, v_estado));
          continue;
        elsif v_estado = 'completada' then
          select count(*) into v_ok from public.holded_acciones_items where accion_id = v.ultima_accion_id and estado = 'ok';
          if v_ok = 0 then
            perform public.holded_programada_cerrar(v.empresa_id, v.tipo, format('Parada: la tanda %s no aprobó ningún ticket.', v.tandas));
            continue;
          end if;
        end if;
      end if;
      if v.tandas >= 20 then
        perform public.holded_programada_cerrar(v.empresa_id, v.tipo, 'Parada: 20 tandas en una pasada. Lo que quede, mañana.');
        continue;
      end if;
      update public.holded_acciones_programadas
         set tandas = tandas + 1, pedida_at = now(), ultima_ejecucion_at = now()
       where empresa_id = v.empresa_id and tipo = v.tipo returning * into v;
      v_out := v_out || jsonb_build_array(jsonb_build_object('empresa_id', v.empresa_id, 'tipo', v.tipo,
                                                             'hasta', to_char(v.dia_en_curso, 'YYYY-MM-DD'), 'tanda', v.tandas));
    end loop;
    return v_out;
  end;
  $f$;

  -- ===================== resultado de una tanda (service_role) =====================
  -- p_accion: la propuesta creada (o null si no se creó). p_cerrar: termina la pasada.
  create function public.holded_programada_registrar(p_empresa uuid, p_tipo text, p_accion uuid, p_mensaje text, p_cerrar boolean)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if p_accion is not null and not exists (select 1 from public.holded_acciones where id = p_accion and empresa_id = p_empresa) then
      raise exception 'Esa acción no es de esta empresa' using errcode = '22023';
    end if;
    update public.holded_acciones_programadas
       set ultima_accion_id = coalesce(p_accion, ultima_accion_id), pedida_at = null, ultimo_resultado = left(p_mensaje, 300)
     where empresa_id = p_empresa and tipo = p_tipo and dia_en_curso is not null;
    if coalesce(p_cerrar, false) then perform public.holded_programada_cerrar(p_empresa, p_tipo, p_mensaje); end if;
  end;
  $f$;

  -- ===================== pg_cron: cada 10 minutos, solo si hay algo que hacer =====================
  create function public.holded_programadas_cron()
  returns bigint
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_secreto text;
  begin
    if not exists (
      select 1 from public.holded_acciones_programadas p
       where p.activa and (p.dia_en_curso is not null
              or (extract(hour from (now() at time zone 'Europe/Madrid'))::int >= p.hora
                  and (p.ultimo_dia_completado is null or p.ultimo_dia_completado < (now() at time zone 'Europe/Madrid')::date)))) then
      return null;
    end if;
    select ds.decrypted_secret into v_secreto from vault.decrypted_secrets ds where ds.name = 'holded_acciones_cron_secret';
    if v_secreto is null or v_secreto = '' then
      raise exception 'Falta el secreto holded_acciones_cron_secret en Vault';
    end if;
    return net.http_post(
      url                  := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/holded-acciones',
      body                 := jsonb_build_object('accion', 'programadas'),
      headers              := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_secreto),
      timeout_milliseconds := 150000
    );
  end;
  $f$;

  revoke all on function public.holded_cambiar_programacion(uuid, text, boolean, boolean), public.holded_programada_cerrar(uuid, text, text),
                         public.holded_programadas_turno(), public.holded_programada_registrar(uuid, text, uuid, text, boolean),
                         public.holded_programadas_cron()
    from public, anon, authenticated;
  grant execute on function public.holded_cambiar_programacion(uuid, text, boolean, boolean) to authenticated;
  grant execute on function public.holded_programadas_turno(), public.holded_programada_registrar(uuid, text, uuid, text, boolean)
    to service_role;

  perform cron.schedule('holded-acciones-programadas', '*/10 * * * *', 'select public.holded_programadas_cron();');

  insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261128220000', 'Holded: acciones programadas (crm/supabase-holded-programadas.sql)', array[]::text[]);
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 14C (verificación, solo lectura) — Lo esperado:
--   RLS: true     programaciones: 0     tarea holded-acciones-programadas: */10 * * * *
--   EXECUTE authenticated cambiar/turno/registrar/cron: sí/no/no/no
--   migración registrada: 20261128220000 …
-- ============================================================
select 'RLS' as comprobacion,
       (select relrowsecurity::text from pg_class where oid = 'public.holded_acciones_programadas'::regclass) as valor
union all select 'programaciones', (select count(*)::text from public.holded_acciones_programadas)
union all select 'tarea holded-acciones-programadas', (select schedule from cron.job where jobname = 'holded-acciones-programadas')
union all select 'EXECUTE authenticated cambiar/turno/registrar/cron',
       case when has_function_privilege('authenticated', 'public.holded_cambiar_programacion(uuid, text, boolean, boolean)', 'execute') then 'sí' else 'no' end || '/' ||
       case when has_function_privilege('authenticated', 'public.holded_programadas_turno()', 'execute') then 'sí' else 'no' end || '/' ||
       case when has_function_privilege('authenticated', 'public.holded_programada_registrar(uuid, text, uuid, text, boolean)', 'execute') then 'sí' else 'no' end || '/' ||
       case when has_function_privilege('authenticated', 'public.holded_programadas_cron()', 'execute') then 'sí' else 'no' end
union all select 'migración registrada',
       (select version || ' ' || name from supabase_migrations.schema_migrations where version = '20261128220000');
