-- ============================================================
-- GUIMAES — Holded, acciones (escritura con aprobación humana)
--
--   * holded_acciones: propuestas de acción sobre el Holded de una empresa
--     (tipo, parámetros, resumen, muestra, excluidos, avisos, estado, quién
--     la propuso y quién la aprobó). Estados:
--       propuesta → aprobada → en_curso → completada
--       propuesta → rechazada;  aprobada/en_curso ⇄ pausada;
--       propuesta/aprobada/en_curso/pausada → cancelada
--     Las propuestas caducan a las 72 h sin aprobar (los datos cambian).
--   * holded_acciones_items: un documento de Holded por fila (id, estado,
--     código y error); sin el contenido del documento. Es la cola.
--   * holded_acciones_politicas: por empresa y tipo, «aprobacion» (por
--     defecto, también si no hay fila) o «automatica» con tope de documentos
--     e importe. Todo queda en «aprobacion».
--   * holded_conexiones.cupo_acciones_mensual (0 por defecto: sin cupo no
--     se ejecuta nada): documentos procesados al mes por empresa, aparte del
--     cupo de consultas del asistente. Un documento cuenta una vez aunque
--     se reintente.
--   * Tipos permitidos (lista cerrada): aprobar_tickets_venta.
--   * Quién hace qué:
--       proponer     → Edge Function holded-acciones (service_role):
--                      holded_acciones_crear. Lo pide el asistente o un
--                      usuario del CRM (con su JWT) o el operador (secreto
--                      de cron). Nunca nace aprobada salvo política automática.
--       aprobar, rechazar, pausar, reanudar, cancelar, cupo
--                    → CRM, solo rol admin (RPC con auth.uid()).
--       ejecutar     → pg_cron cada minuto (holded_acciones_cron, solo si hay
--                      algo aprobado o en curso) → holded-acciones, que
--                      reclama lotes (holded_acciones_reclamar) y devuelve
--                      resultados (holded_acciones_resultado).
--
-- Antes de 8B: el secreto holded_acciones_cron_secret en Vault (el mismo
-- valor que el secreto HOLDED_ACCIONES_CRON_SECRET de la Edge Function).
--
-- Migración 20261127180000. Ejecutar en orden 8A → 8B → 8C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/holded).
-- ============================================================


-- ============================================================
-- 8A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127160000 (bloque 2): sí     migración 20261127180000: no
--   tablas holded_acciones*: 0                  columna cupo_acciones_mensual: 0
--   secreto holded_acciones_cron_secret: 1      pg_net: 1     pg_cron: 1
--   tarea holded-acciones-ejecutar: 0
--   conexiones: (anotar)
-- ============================================================
select 'migración 20261127160000 (bloque 2)' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127160000')
            then 'sí' else 'no' end as valor
union all
select 'migración 20261127180000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127180000')
            then 'sí' else 'no' end
union all
select 'tablas holded_acciones*', count(*)::text from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('holded_acciones', 'holded_acciones_items', 'holded_acciones_politicas')
union all
select 'columna cupo_acciones_mensual', count(*)::text from information_schema.columns
 where table_schema = 'public' and table_name = 'holded_conexiones' and column_name = 'cupo_acciones_mensual'
union all
select 'secreto holded_acciones_cron_secret', count(*)::text from vault.decrypted_secrets
 where name = 'holded_acciones_cron_secret' and coalesce(decrypted_secret, '') <> ''
union all
select 'pg_net', count(*)::text from pg_namespace where nspname = 'net'
union all
select 'pg_cron', count(*)::text from pg_namespace where nspname = 'cron'
union all
select 'tarea holded-acciones-ejecutar', (select count(*)::text from cron.job where jobname = 'holded-acciones-ejecutar')
union all
select 'conexiones', count(*)::text from public.holded_conexiones;


-- ============================================================
-- 8B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261127180000')
     or to_regclass('public.holded_acciones') is not null then
    raise exception 'La migración 20261127180000 (Holded, acciones) ya está aplicada: 8B no se repite. No se ha cambiado nada.';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261127160000') then
    raise exception 'Falta la migración 20261127160000 (Holded, consultas): no se toca nada.';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'holded_acciones_cron_secret'
                 and coalesce(decrypted_secret, '') <> '') then
    raise exception 'Falta el secreto holded_acciones_cron_secret en Vault. No se ha cambiado nada.';
  end if;

  -- ===================== cupo de acciones =====================
  alter table public.holded_conexiones
    add column cupo_acciones_mensual integer not null default 0 check (cupo_acciones_mensual between 0 and 100000);
  grant select (cupo_acciones_mensual) on public.holded_conexiones to authenticated;

  -- ===================== tablas =====================
  create table public.holded_acciones_politicas (
    empresa_id      uuid not null references public.empresas(id) on delete cascade,
    tipo            text not null check (tipo in ('aprobar_tickets_venta')),
    modo            text not null default 'aprobacion' check (modo in ('aprobacion', 'automatica')),
    max_documentos  integer check (max_documentos is null or max_documentos between 1 and 1000),
    max_importe     numeric(14,2) check (max_importe is null or max_importe > 0),
    updated_by      uuid,
    updated_at      timestamptz not null default now(),
    primary key (empresa_id, tipo),
    check (modo = 'aprobacion' or (max_documentos is not null and max_importe is not null))
  );
  alter table public.holded_acciones_politicas enable row level security;
  create policy "rol admin ve las políticas" on public.holded_acciones_politicas
    for select to authenticated using ((select public.is_admin_role()));
  revoke all on public.holded_acciones_politicas from anon, authenticated;
  grant select on public.holded_acciones_politicas to authenticated;

  create table public.holded_acciones (
    id                 uuid primary key default gen_random_uuid(),
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    empresa_id         uuid not null references public.empresas(id) on delete cascade,
    tipo               text not null check (tipo in ('aprobar_tickets_venta')),
    parametros         jsonb not null default '{}'::jsonb,
    resumen            jsonb not null default '{}'::jsonb,
    muestra            jsonb not null default '[]'::jsonb,
    excluidos          jsonb not null default '[]'::jsonb,
    avisos             text[] not null default '{}',
    estado             text not null default 'propuesta'
                       check (estado in ('propuesta', 'aprobada', 'en_curso', 'pausada', 'completada', 'cancelada', 'rechazada')),
    motivo_estado      text check (motivo_estado is null or length(motivo_estado) <= 300),
    origen             text not null check (origen in ('agente', 'crm', 'operador')),
    propuesta_por      uuid,
    aprobada_por       uuid,
    aprobada_at        timestamptz,
    rechazada_por      uuid,
    cerrada_por        uuid,                       -- quien la canceló o pausó por última vez
    iniciada_at        timestamptz,
    terminada_at       timestamptz,
    expira_at          timestamptz not null default now() + interval '72 hours',
    llamadas_lectura   integer not null default 0,
    llamadas_escritura integer not null default 0
  );
  comment on table public.holded_acciones is
    'Propuestas de acción sobre Holded con aprobación humana (crm/supabase-holded-acciones.sql).';
  create trigger holded_acciones_set_updated_at before update on public.holded_acciones
    for each row execute function public.set_updated_at();
  create index holded_acciones_activas on public.holded_acciones (estado, aprobada_at)
    where estado in ('aprobada', 'en_curso');
  alter table public.holded_acciones enable row level security;
  create policy "rol admin ve las acciones" on public.holded_acciones
    for select to authenticated using ((select public.is_admin_role()));
  revoke all on public.holded_acciones from anon, authenticated;
  grant select on public.holded_acciones to authenticated;

  create table public.holded_acciones_items (
    accion_id         uuid not null references public.holded_acciones(id) on delete cascade,
    holded_id         text not null check (holded_id ~ '^[0-9a-f]{24}$'),
    orden             integer not null,
    estado            text not null default 'pendiente' check (estado in ('pendiente', 'en_proceso', 'ok', 'error', 'omitido')),
    intentos          integer not null default 0,
    codigo            integer,
    error             text check (error is null or length(error) <= 300),
    primer_intento_at timestamptz,
    reclamado_at      timestamptz,
    procesado_at      timestamptz,
    primary key (accion_id, holded_id)
  );
  create index holded_acciones_items_cola on public.holded_acciones_items (accion_id, orden)
    where estado in ('pendiente', 'en_proceso');
  create index holded_acciones_items_mes on public.holded_acciones_items (primer_intento_at);
  alter table public.holded_acciones_items enable row level security;
  revoke all on public.holded_acciones_items from anon, authenticated;

  -- ===================== proponer (service_role) =====================
  create function public.holded_acciones_crear(
    p_usuario uuid, p_origen text, p_empresa uuid, p_tipo text, p_parametros jsonb, p_resumen jsonb,
    p_muestra jsonb, p_excluidos jsonb, p_avisos text[], p_ids text[], p_llamadas integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_id uuid;
    v_n int;
    v_pol public.holded_acciones_politicas%rowtype;
    v_estado text := 'propuesta';
    v_total numeric;
    v_ocupados int;
    v_restante int;
  begin
    if p_origen not in ('agente', 'crm', 'operador') then
      raise exception 'Origen no válido' using errcode = '22023';
    end if;
    if p_origen <> 'operador' and not public.is_admin(p_usuario) then
      raise exception 'Solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_tipo is null or p_tipo not in ('aprobar_tickets_venta') then
      raise exception 'Tipo de acción no permitido' using errcode = '22023';
    end if;
    if not exists (select 1 from public.holded_conexiones where empresa_id = p_empresa) then
      raise exception 'La empresa no tiene Holded conectado' using errcode = 'GU010';
    end if;
    v_n := coalesce(array_length(p_ids, 1), 0);
    if v_n < 1 or v_n > 1000 then
      raise exception 'Una propuesta tiene entre 1 y 1.000 documentos' using errcode = '22023';
    end if;
    if (select count(distinct x) from unnest(p_ids) x) <> v_n
       or exists (select 1 from unnest(p_ids) x where x is null or x !~ '^[0-9a-f]{24}$') then
      raise exception 'Ids de Holded repetidos o no válidos' using errcode = '22023';
    end if;
    -- Un documento no puede estar pendiente en dos propuestas vivas.
    select count(*) into v_ocupados
      from public.holded_acciones_items i join public.holded_acciones a on a.id = i.accion_id
     where a.empresa_id = p_empresa
       and ((a.estado = 'propuesta' and a.expira_at > now()) or a.estado in ('aprobada', 'en_curso', 'pausada'))
       and i.estado in ('pendiente', 'en_proceso') and i.holded_id = any (p_ids);
    if v_ocupados > 0 then
      raise exception '% documento(s) ya están en otra propuesta sin terminar de esta empresa', v_ocupados using errcode = 'GU011';
    end if;

    -- Política: automática solo dentro de sus topes.
    select * into v_pol from public.holded_acciones_politicas where empresa_id = p_empresa and tipo = p_tipo;
    v_total := coalesce((p_resumen->>'total')::numeric, 0);
    if found and v_pol.modo = 'automatica' and v_n <= v_pol.max_documentos and v_total <= v_pol.max_importe then
      v_estado := 'aprobada';
    end if;

    -- Aviso si el cupo de acciones del mes no llega.
    select greatest(c.cupo_acciones_mensual - (select count(*) from public.holded_acciones_items i
                      join public.holded_acciones a on a.id = i.accion_id
                     where a.empresa_id = p_empresa and i.primer_intento_at >= public.holded_inicio_mes()), 0)
      into v_restante from public.holded_conexiones c where c.empresa_id = p_empresa;
    if v_n > v_restante then
      p_avisos := coalesce(p_avisos, '{}') || format('⚠ El cupo de acciones de esta empresa para este mes cubre %s documento(s) de %s: la ejecución se pausará al llegar. Se cambia en Acciones.', v_restante, v_n);
    end if;

    insert into public.holded_acciones (empresa_id, tipo, parametros, resumen, muestra, excluidos, avisos, estado,
                                        motivo_estado, origen, propuesta_por, aprobada_at, llamadas_lectura)
    values (p_empresa, p_tipo, coalesce(p_parametros, '{}'::jsonb), coalesce(p_resumen, '{}'::jsonb),
            coalesce(p_muestra, '[]'::jsonb), coalesce(p_excluidos, '[]'::jsonb), coalesce(p_avisos, '{}'),
            v_estado, case when v_estado = 'aprobada' then 'Aprobada por la política automática de la empresa' end,
            p_origen, p_usuario, case when v_estado = 'aprobada' then now() end, greatest(coalesce(p_llamadas, 0), 0))
    returning id into v_id;
    insert into public.holded_acciones_items (accion_id, holded_id, orden)
    select v_id, x, o::int from unnest(p_ids) with ordinality as t(x, o);
    return jsonb_build_object('id', v_id, 'estado', v_estado, 'documentos', v_n);
  end;
  $f$;
  revoke all on function public.holded_acciones_crear(uuid, text, uuid, text, jsonb, jsonb, jsonb, jsonb, text[], text[], integer)
    from public, anon, authenticated, service_role;
  grant execute on function public.holded_acciones_crear(uuid, text, uuid, text, jsonb, jsonb, jsonb, jsonb, text[], text[], integer)
    to service_role;

  -- ===================== decisiones (CRM, rol admin) =====================
  -- Aprobar: solo una propuesta sin caducar. Con más de 100 documentos hay
  -- que escribir el número exacto (p_confirmacion).
  create function public.holded_acciones_aprobar(p_accion uuid, p_confirmacion integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_a public.holded_acciones%rowtype; v_n int;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede aprobar acciones en Holded' using errcode = '42501';
    end if;
    select * into v_a from public.holded_acciones where id = p_accion for update;
    if not found then raise exception 'Esa acción no existe' using errcode = 'GU010'; end if;
    if v_a.estado <> 'propuesta' then
      raise exception 'Solo se puede aprobar una propuesta (esta está «%»)', v_a.estado using errcode = '22023';
    end if;
    if v_a.expira_at <= now() then
      raise exception 'La propuesta ha caducado (72 h): pide una nueva, los datos de Holded pueden haber cambiado' using errcode = '22023';
    end if;
    select count(*) into v_n from public.holded_acciones_items where accion_id = p_accion;
    if v_n > 100 and p_confirmacion is distinct from v_n then
      raise exception 'Para aprobar % documentos escribe el número % como confirmación', v_n, v_n using errcode = '22023';
    end if;
    update public.holded_acciones
       set estado = 'aprobada', aprobada_por = auth.uid(), aprobada_at = now(), motivo_estado = null
     where id = p_accion;
    return jsonb_build_object('id', p_accion, 'estado', 'aprobada', 'documentos', v_n);
  end;
  $f$;

  create function public.holded_acciones_rechazar(p_accion uuid, p_motivo text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede rechazar acciones' using errcode = '42501';
    end if;
    update public.holded_acciones
       set estado = 'rechazada', rechazada_por = auth.uid(), terminada_at = now(),
           motivo_estado = left(nullif(btrim(coalesce(p_motivo, '')), ''), 300)
     where id = p_accion and estado = 'propuesta';
    if not found then raise exception 'Solo se puede rechazar una propuesta' using errcode = '22023'; end if;
    update public.holded_acciones_items set estado = 'omitido' where accion_id = p_accion and estado = 'pendiente';
    return jsonb_build_object('id', p_accion, 'estado', 'rechazada');
  end;
  $f$;

  create function public.holded_acciones_pausar(p_accion uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede pausar acciones' using errcode = '42501';
    end if;
    update public.holded_acciones
       set estado = 'pausada', cerrada_por = auth.uid(), motivo_estado = 'Pausada a mano'
     where id = p_accion and estado in ('aprobada', 'en_curso');
    if not found then raise exception 'Solo se puede pausar una acción aprobada o en curso' using errcode = '22023'; end if;
    return jsonb_build_object('id', p_accion, 'estado', 'pausada');
  end;
  $f$;

  create function public.holded_acciones_reanudar(p_accion uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede reanudar acciones' using errcode = '42501';
    end if;
    update public.holded_acciones
       set estado = 'aprobada', motivo_estado = null
     where id = p_accion and estado = 'pausada' and aprobada_at is not null;
    if not found then raise exception 'Solo se puede reanudar una acción pausada' using errcode = '22023'; end if;
    return jsonb_build_object('id', p_accion, 'estado', 'aprobada');
  end;
  $f$;

  -- Cancelar: lo pendiente queda omitido. Lo que se esté procesando en ese
  -- momento (como mucho un lote) termina y se registra.
  create function public.holded_acciones_cancelar(p_accion uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_n int;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede cancelar acciones' using errcode = '42501';
    end if;
    update public.holded_acciones
       set estado = 'cancelada', cerrada_por = auth.uid(), terminada_at = now(), motivo_estado = 'Cancelada a mano'
     where id = p_accion and estado in ('propuesta', 'aprobada', 'en_curso', 'pausada');
    if not found then raise exception 'Esta acción ya está terminada' using errcode = '22023'; end if;
    update public.holded_acciones_items set estado = 'omitido' where accion_id = p_accion and estado = 'pendiente';
    get diagnostics v_n = row_count;
    return jsonb_build_object('id', p_accion, 'estado', 'cancelada', 'omitidos', v_n);
  end;
  $f$;

  -- Progreso y errores (sin contenido: solo ids de Holded, códigos y mensajes).
  create function public.holded_acciones_progreso(p_accion uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin' using errcode = '42501';
    end if;
    return (
      select jsonb_build_object(
        'total', count(*),
        'pendiente', count(*) filter (where estado = 'pendiente'),
        'en_proceso', count(*) filter (where estado = 'en_proceso'),
        'ok', count(*) filter (where estado = 'ok'),
        'error', count(*) filter (where estado = 'error'),
        'omitido', count(*) filter (where estado = 'omitido'),
        'ultimo_at', max(procesado_at),
        'errores', coalesce((select jsonb_agg(jsonb_build_object('holded_id', e.holded_id, 'codigo', e.codigo, 'error', e.error) order by e.orden)
                               from (select * from public.holded_acciones_items
                                      where accion_id = p_accion and estado = 'error' order by orden limit 200) e), '[]'::jsonb))
        from public.holded_acciones_items where accion_id = p_accion);
  end;
  $f$;

  -- Cupo de acciones: documentos con algún intento este mes / tope.
  create function public.holded_acciones_uso_mes(p_empresa_id uuid default null)
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
             (select count(*) from public.holded_acciones_items i join public.holded_acciones a on a.id = i.accion_id
               where a.empresa_id = c.empresa_id and i.primer_intento_at >= public.holded_inicio_mes())::int,
             c.cupo_acciones_mensual
        from public.holded_conexiones c
       where p_empresa_id is null or c.empresa_id = p_empresa_id;
  end;
  $f$;

  create function public.holded_cambiar_cupo_acciones(p_empresa_id uuid, p_cupo integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede cambiar el cupo de acciones' using errcode = '42501';
    end if;
    if p_cupo is null or p_cupo < 0 or p_cupo > 100000 then
      raise exception 'El cupo tiene que estar entre 0 y 100.000 documentos al mes' using errcode = '22023';
    end if;
    update public.holded_conexiones set cupo_acciones_mensual = p_cupo where empresa_id = p_empresa_id;
    if not found then raise exception 'Esa empresa no tiene Holded conectado' using errcode = 'GU010'; end if;
    return jsonb_build_object('empresa_id', p_empresa_id, 'cupo', p_cupo);
  end;
  $f$;

  -- ===================== ejecución (service_role) =====================
  -- Reclama hasta p_max documentos de UNA acción aprobada o en curso (la
  -- más antigua), dentro del cupo de acciones del mes. Pausa la acción si
  -- no queda cupo o si la empresa ya no tiene Holded conectado; la da por
  -- completada si no queda nada. Los documentos «en_proceso» de hace más de
  -- 5 minutos (una ejecución que murió) vuelven a la cola.
  create function public.holded_acciones_reclamar(p_max integer)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_a public.holded_acciones%rowtype;
    v_cupo int;
    v_usadas int;
    v_k int;
    v_ids text[];
  begin
    if p_max is null or p_max < 1 or p_max > 50 then
      raise exception 'Lote no válido' using errcode = '22023';
    end if;
    for v_a in select * from public.holded_acciones where estado in ('aprobada', 'en_curso')
                order by aprobada_at, id for update skip locked loop
      update public.holded_acciones_items set estado = 'pendiente'
       where accion_id = v_a.id and estado = 'en_proceso' and reclamado_at < now() - interval '5 minutes';

      if not exists (select 1 from public.holded_acciones_items where accion_id = v_a.id and estado in ('pendiente', 'en_proceso')) then
        update public.holded_acciones set estado = 'completada', terminada_at = now() where id = v_a.id;
        continue;
      end if;
      if not exists (select 1 from public.holded_acciones_items where accion_id = v_a.id and estado = 'pendiente') then
        continue;   -- solo queda lo que otra ejecución tiene entre manos
      end if;
      select cupo_acciones_mensual into v_cupo from public.holded_conexiones where empresa_id = v_a.empresa_id;
      if not found then
        update public.holded_acciones set estado = 'pausada', motivo_estado = 'La empresa ya no tiene Holded conectado' where id = v_a.id;
        continue;
      end if;
      select count(*) into v_usadas from public.holded_acciones_items i join public.holded_acciones a on a.id = i.accion_id
       where a.empresa_id = v_a.empresa_id and i.primer_intento_at >= public.holded_inicio_mes();
      -- Los reintentos no gastan cupo: primero lo ya empezado.
      v_k := least(p_max, greatest(v_cupo - v_usadas, 0)
                          + (select count(*) from public.holded_acciones_items
                              where accion_id = v_a.id and estado = 'pendiente' and primer_intento_at >= public.holded_inicio_mes())::int);
      if v_k <= 0 then
        update public.holded_acciones
           set estado = 'pausada', motivo_estado = format('Cupo de acciones del mes agotado (%s de %s documentos)', v_usadas, v_cupo)
         where id = v_a.id;
        continue;
      end if;
      with c as (
        select holded_id from public.holded_acciones_items
         where accion_id = v_a.id and estado = 'pendiente'
         order by (primer_intento_at is null), orden
         limit v_k
         for update skip locked)
      update public.holded_acciones_items i
         set estado = 'en_proceso', intentos = i.intentos + 1, reclamado_at = now(),
             primer_intento_at = coalesce(i.primer_intento_at, now())
        from c where i.accion_id = v_a.id and i.holded_id = c.holded_id;
      select array_agg(holded_id order by orden) into v_ids from public.holded_acciones_items
       where accion_id = v_a.id and estado = 'en_proceso' and reclamado_at = now();
      update public.holded_acciones
         set estado = 'en_curso', iniciada_at = coalesce(iniciada_at, now())
       where id = v_a.id and estado = 'aprobada';
      return jsonb_build_object('accion_id', v_a.id, 'empresa_id', v_a.empresa_id, 'tipo', v_a.tipo, 'ids', to_jsonb(coalesce(v_ids, '{}')));
    end loop;
    return null;
  end;
  $f$;

  -- Resultados de un lote: [{id, estado: ok|error|pendiente, codigo, error}].
  -- «pendiente» = vuelve a la cola (red, 5xx, límite por minuto); con 3
  -- intentos pasa a error. p_pausar: motivo para pausar la acción.
  create function public.holded_acciones_resultado(p_accion uuid, p_resultados jsonb, p_llamadas integer, p_pausar text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare r jsonb; v_estado text;
  begin
    for r in select value from jsonb_array_elements(coalesce(p_resultados, '[]'::jsonb)) loop
      v_estado := r->>'estado';
      if v_estado not in ('ok', 'error', 'pendiente') then
        raise exception 'Resultado no válido' using errcode = '22023';
      end if;
      update public.holded_acciones_items i
         set estado = case when v_estado = 'pendiente' and i.intentos >= 3 then 'error' else v_estado end,
             codigo = nullif(r->>'codigo', '')::int,
             error = case when v_estado = 'ok' then null
                          when v_estado = 'pendiente' and i.intentos >= 3 then left(coalesce(r->>'error', 'Sin respuesta de Holded') || ' (3 intentos)', 300)
                          else left(r->>'error', 300) end,
             procesado_at = case when v_estado = 'pendiente' and i.intentos < 3 then i.procesado_at else now() end
       where i.accion_id = p_accion and i.holded_id = r->>'id' and i.estado = 'en_proceso';
    end loop;
    update public.holded_acciones
       set llamadas_escritura = llamadas_escritura + greatest(coalesce(p_llamadas, 0), 0)
     where id = p_accion;
    if nullif(btrim(coalesce(p_pausar, '')), '') is not null then
      update public.holded_acciones set estado = 'pausada', motivo_estado = left(p_pausar, 300)
       where id = p_accion and estado in ('aprobada', 'en_curso');
    end if;
    -- Lo que estuviera en proceso al cancelar ya está registrado: nada más que hacer.
    if not exists (select 1 from public.holded_acciones_items where accion_id = p_accion and estado in ('pendiente', 'en_proceso')) then
      update public.holded_acciones set estado = 'completada', terminada_at = now()
       where id = p_accion and estado in ('aprobada', 'en_curso');
    end if;
    return (select jsonb_build_object('estado', estado) from public.holded_acciones where id = p_accion);
  end;
  $f$;

  -- pg_cron: solo llama a la Edge Function si hay algo que ejecutar.
  create function public.holded_acciones_cron()
  returns bigint
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_secreto text;
  begin
    if not exists (select 1 from public.holded_acciones where estado in ('aprobada', 'en_curso')) then
      return null;
    end if;
    select ds.decrypted_secret into v_secreto from vault.decrypted_secrets ds where ds.name = 'holded_acciones_cron_secret';
    if v_secreto is null or v_secreto = '' then
      raise exception 'Falta el secreto holded_acciones_cron_secret en Vault';
    end if;
    return net.http_post(
      url                  := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/holded-acciones',
      body                 := jsonb_build_object('accion', 'ejecutar'),
      headers              := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_secreto),
      timeout_milliseconds := 150000
    );
  end;
  $f$;

  -- ===================== privilegios =====================
  revoke all on function public.holded_acciones_aprobar(uuid, integer), public.holded_acciones_rechazar(uuid, text),
                         public.holded_acciones_pausar(uuid), public.holded_acciones_reanudar(uuid),
                         public.holded_acciones_cancelar(uuid), public.holded_acciones_progreso(uuid),
                         public.holded_acciones_uso_mes(uuid), public.holded_cambiar_cupo_acciones(uuid, integer),
                         public.holded_acciones_reclamar(integer), public.holded_acciones_resultado(uuid, jsonb, integer, text),
                         public.holded_acciones_cron()
    from public, anon, authenticated, service_role;
  grant execute on function public.holded_acciones_aprobar(uuid, integer), public.holded_acciones_rechazar(uuid, text),
                            public.holded_acciones_pausar(uuid), public.holded_acciones_reanudar(uuid),
                            public.holded_acciones_cancelar(uuid), public.holded_acciones_progreso(uuid),
                            public.holded_acciones_uso_mes(uuid), public.holded_cambiar_cupo_acciones(uuid, integer)
    to authenticated;
  grant execute on function public.holded_acciones_reclamar(integer), public.holded_acciones_resultado(uuid, jsonb, integer, text)
    to service_role;

  perform cron.unschedule(jobid) from cron.job where jobname = 'holded-acciones-ejecutar';
  perform cron.schedule('holded-acciones-ejecutar', '* * * * *', 'select public.holded_acciones_cron();');

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261127180000', array['holded_acciones, holded_acciones_items, holded_acciones_politicas, cupo_acciones_mensual, holded-acciones-ejecutar'],
          'Holded: acciones con aprobación (crm/supabase-holded-acciones.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 8C (verificación, solo lectura) — Lo esperado:
--   tablas con RLS: 3          políticas: 2 (acciones, políticas; items ninguna)
--   authenticated SELECT acciones/items/políticas: sí/no/sí
--   authenticated INSERT/UPDATE/DELETE holded_acciones: no/no/no
--   EXECUTE authenticated crear/reclamar/resultado/cron: no/no/no/no
--   EXECUTE service_role crear/reclamar/resultado: sí/sí/sí
--   EXECUTE anon/authenticated aprobar: no/sí
--   cupo_acciones_mensual: todas 0      tarea holded-acciones-ejecutar: 1
--   conexiones: las mismas que en 8A
--   migración registrada: 20261127180000 ...
-- ============================================================
select 'tablas con RLS' as comprobacion, count(*)::text as valor from pg_class
 where relnamespace = 'public'::regnamespace and relrowsecurity
   and relname in ('holded_acciones', 'holded_acciones_items', 'holded_acciones_politicas')
union all
select 'políticas', count(*)::text from pg_policies
 where schemaname = 'public' and tablename in ('holded_acciones', 'holded_acciones_items', 'holded_acciones_politicas')
union all
select 'authenticated SELECT acciones/items/políticas',
       (case when has_table_privilege('authenticated', 'public.holded_acciones', 'select') then 'sí' else 'no' end) || '/' ||
       (case when has_any_column_privilege('authenticated', 'public.holded_acciones_items', 'select') then 'sí' else 'no' end) || '/' ||
       (case when has_table_privilege('authenticated', 'public.holded_acciones_politicas', 'select') then 'sí' else 'no' end)
union all
select 'authenticated INSERT/UPDATE/DELETE holded_acciones',
       (case when has_table_privilege('authenticated', 'public.holded_acciones', 'insert') then 'sí' else 'no' end) || '/' ||
       (case when has_any_column_privilege('authenticated', 'public.holded_acciones', 'update') then 'sí' else 'no' end) || '/' ||
       (case when has_table_privilege('authenticated', 'public.holded_acciones', 'delete') then 'sí' else 'no' end)
union all
select 'EXECUTE authenticated crear/reclamar/resultado/cron',
       (case when has_function_privilege('authenticated', 'public.holded_acciones_crear(uuid, text, uuid, text, jsonb, jsonb, jsonb, jsonb, text[], text[], integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_acciones_reclamar(integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_acciones_resultado(uuid, jsonb, integer, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_acciones_cron()', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE service_role crear/reclamar/resultado',
       (case when has_function_privilege('service_role', 'public.holded_acciones_crear(uuid, text, uuid, text, jsonb, jsonb, jsonb, jsonb, text[], text[], integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('service_role', 'public.holded_acciones_reclamar(integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('service_role', 'public.holded_acciones_resultado(uuid, jsonb, integer, text)', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE anon/authenticated aprobar',
       (case when has_function_privilege('anon', 'public.holded_acciones_aprobar(uuid, integer)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_acciones_aprobar(uuid, integer)', 'execute') then 'sí' else 'no' end)
union all
select 'cupo_acciones_mensual',
       case when not exists (select 1 from public.holded_conexiones where cupo_acciones_mensual <> 0) then 'todas 0' else 'NO' end
union all
select 'tarea holded-acciones-ejecutar', (select count(*)::text from cron.job where jobname = 'holded-acciones-ejecutar')
union all
select 'conexiones', count(*)::text from public.holded_conexiones
union all
select 'migración registrada', version || ' ' || name
  from supabase_migrations.schema_migrations where version = '20261127180000';
