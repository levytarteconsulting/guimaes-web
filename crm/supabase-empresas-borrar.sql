-- ============================================================
-- GUIMAES — Eliminar y archivar empresas
--
-- Hoy una empresa no se puede borrar: documentos.empresa_id y
-- deals.empresa_id son ON DELETE RESTRICT (a propósito: nada se va en
-- cascada sin decidirlo). Este fichero añade el camino explícito:
--
-- ELIMINAR (admin_borrar_empresa, una transacción):
--   * Antes, admin_empresa_borrado_resumen enseña exactamente qué se va a
--     borrar y devuelve una "huella". Si entre el resumen y el borrado
--     cambia algo (un documento nuevo, un deal, un contacto...), la huella
--     ya no coincide y no se borra nada: hay que volver a mirarlo.
--   * Contactos que solo están en esta empresa: el admin decide, uno a uno,
--     borrarlo (admin_borrar_contacto, el mismo camino que la ficha) o
--     moverlo a otra empresa (pasa a ser su principal). Los que están en
--     otras empresas solo pierden el vínculo; si esta era su principal,
--     pasa a serlo la más antigua de las que le quedan.
--   * Cuentas del área de cliente de los contactos que se borran: quedan
--     sin vincular (pendientes) y se apuntan en portal_cuentas_conservar,
--     para que la limpieza diaria (portal_altas_caducadas, que borra las
--     cuentas sin vincular de más de 30 días) no las elimine.
--   * Con documentos o con deals en cliente_activo, hay que escribir la
--     razón social para confirmar (se comprueba aquí, no solo en el CRM).
--   * Deals de la empresa: se borran (y sus notas, en cascada). Las tareas
--     no tienen FK: no se borran, pierden el deal o el contacto.
--   * Documentos: se borran las filas y sus rutas quedan en storage_borrados.
--     La Edge Function empresas-ficheros borra los ficheros con la API de
--     Storage justo después; lo que falle se queda pendiente, se ve en el
--     CRM, se puede reintentar y portal-limpieza lo reintenta cada día.
--   * Queda constancia en empresas_borradas (quién, cuándo y el resumen).
--   * Empresas provisionales del área de cliente: el mismo camino.
--
-- ARCHIVAR (admin_archivar_empresa): empresas.archived_at. No borra nada.
-- El CRM la oculta de listados, pipeline y KPIs; mis_empresas() deja de
-- devolverla, así que sus contactos con cuenta dejan de verla en el área de
-- cliente mientras esté archivada (todas las RPC del portal pasan por ahí).
--
-- Además, admin_desvincular_cuenta también apunta la cuenta en
-- portal_cuentas_conservar (antes, una cuenta de más de 30 días que se
-- desvinculaba a mano la borraba la limpieza esa misma noche), y
-- admin_vincular_cuenta la quita de ahí al volver a vincularla.
--
-- Requiere: empresas, contactos (admin_borrar_contacto), deals-empresa,
-- carpetas, documentos y las fases 1, 3.1, 3.2 y 3.3 del área de cliente.
--
-- Orden: 1A → 1B → 2B → desplegar empresas-ficheros y portal-limpieza →
-- push del CRM → 1C/2C. Los A son solo lectura; los B cambian (un único
-- DO, atómico); los C verifican.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado: ninguna fila (nada de esto existe aún).
-- ============================================================
select 'columna' as que, column_name as nombre from information_schema.columns
where table_schema = 'public' and table_name = 'empresas' and column_name in ('archived_at', 'archived_by')
union all
select 'tabla', table_name from information_schema.tables
where table_schema = 'public' and table_name in ('storage_borrados', 'empresas_borradas', 'portal_cuentas_conservar');


-- ============================================================
-- 1B (CAMBIO) — Esquema. Un único DO; se niega a ejecutarse dos veces.
-- ============================================================
do $b1$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'empresas' and column_name = 'archived_at') then
    raise exception 'empresas.archived_at ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;

  -- Archivado
  alter table public.empresas add column archived_at timestamptz;
  alter table public.empresas add column archived_by uuid references public.admins(id) on delete set null;
  create index empresas_archived_idx on public.empresas (archived_at) where archived_at is not null;

  -- Ficheros de Storage pendientes de borrar (y los ya borrados, como registro).
  create table public.storage_borrados (
    id               uuid primary key default gen_random_uuid(),
    created_at       timestamptz not null default now(),
    lote             uuid not null,
    ruta             text not null,
    empresa_id       uuid,          -- sin FK: la empresa ya no existe
    razon_social     text,
    intentos         integer not null default 0,
    ultimo_intento   timestamptz,
    ultimo_error     text,
    borrado_at       timestamptz
  );
  create unique index storage_borrados_ruta_pendiente_key on public.storage_borrados (ruta) where borrado_at is null;
  create index storage_borrados_lote_idx on public.storage_borrados (lote);
  create index storage_borrados_pendientes_idx on public.storage_borrados (created_at) where borrado_at is null;
  alter table public.storage_borrados enable row level security;
  create policy "admins leen storage_borrados" on public.storage_borrados
    for select to authenticated using ((select public.is_admin()));

  -- Registro de empresas eliminadas.
  create table public.empresas_borradas (
    id            uuid primary key default gen_random_uuid(),
    borrada_at    timestamptz not null default now(),
    empresa_id    uuid not null,
    razon_social  text not null,
    cif           text,
    provisional   boolean not null default false,
    borrada_por   uuid references public.admins(id) on delete set null,
    lote          uuid not null,
    resumen       jsonb not null
  );
  alter table public.empresas_borradas enable row level security;
  create policy "admins leen empresas_borradas" on public.empresas_borradas
    for select to authenticated using ((select public.is_admin()));

  -- Cuentas del área de cliente desvinculadas por el equipo: no caducan.
  create table public.portal_cuentas_conservar (
    auth_user_id  uuid primary key references auth.users(id) on delete cascade,
    desde         timestamptz not null default now(),
    motivo        text not null
  );
  alter table public.portal_cuentas_conservar enable row level security;
  create policy "admins leen portal_cuentas_conservar" on public.portal_cuentas_conservar
    for select to authenticated using ((select public.is_admin()));

  -- Ninguna de las tres se escribe desde el navegador: solo las RPC.
  revoke insert, update, delete, truncate on public.storage_borrados, public.empresas_borradas,
    public.portal_cuentas_conservar from anon, authenticated;
end
$b1$;


-- ============================================================
-- 1C (verificación) — Lo esperado: 2 columnas y 3 tablas con RLS = true.
-- ============================================================
select 'columna' as que, column_name as nombre, null::boolean as rls from information_schema.columns
where table_schema = 'public' and table_name = 'empresas' and column_name in ('archived_at', 'archived_by')
union all
select 'tabla', c.relname::text, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('storage_borrados', 'empresas_borradas', 'portal_cuentas_conservar');


-- ============================================================
-- 2B (CAMBIO) — Funciones. Un único DO. Re-ejecutable.
-- Mismas reglas que el área de cliente: SECURITY DEFINER, search_path
-- fijo, sin parámetro de uid, REVOKE ALL y después solo lo que toca.
-- Errores: 42501 no admin; GU010 mensaje para enseñar en el CRM.
-- ============================================================
do $b2$
begin
  -- ===================== internas (sin EXECUTE para nadie) =====================

  -- Empresas del usuario actual (fase 3.3) sin las archivadas.
  create or replace function public.mis_empresas()
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select ce.empresa_id
    from public.contactos c
    join public.contacto_empresa ce on ce.contact_id = c.id
    join public.empresas e on e.id = ce.empresa_id and e.archived_at is null
    where auth.uid() is not null
      and c.auth_user_id = auth.uid()
      and not exists (select 1 from public.admins a where a.auth_user_id = auth.uid())
      and exists (select 1 from auth.users u
                  where u.id = auth.uid() and u.email_confirmed_at is not null and u.deleted_at is null)
  $f$;
  revoke all on function public.mis_empresas() from public, anon, authenticated, service_role;

  -- Contactos enlazados a la empresa, con cuántas empresas tienen.
  create or replace function public.empresa_contactos_enlazados(p_empresa_id uuid)
  returns table(contact_id uuid, nombre text, email text, auth_user_id uuid, principal_aqui boolean, n_empresas bigint)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select c.id, coalesce(nullif(btrim(c.full_name), ''), c.email, '(sin nombre)'), c.email, c.auth_user_id, ce.principal,
           (select count(*) from public.contacto_empresa x where x.contact_id = c.id)
    from public.contacto_empresa ce
    join public.contactos c on c.id = ce.contact_id
    where ce.empresa_id = p_empresa_id
    order by 2
  $f$;
  revoke all on function public.empresa_contactos_enlazados(uuid) from public, anon, authenticated, service_role;

  -- Huella de todo lo que el borrado mira. Si cambia entre el resumen y el
  -- borrado, no se borra nada.
  create or replace function public.empresa_borrado_huella(p_empresa_id uuid)
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select md5(concat_ws('|',
      (select razon_social from public.empresas where id = p_empresa_id),
      (select string_agg(concat_ws(':', x.contact_id, x.principal_aqui, x.n_empresas, x.auth_user_id), ',' order by x.contact_id)
         from public.empresa_contactos_enlazados(p_empresa_id) x),
      (select string_agg(d.id || ':' || d.stage, ',' order by d.id) from public.deals d where d.empresa_id = p_empresa_id),
      (select string_agg(d.id::text, ',' order by d.id) from public.documentos d where d.empresa_id = p_empresa_id),
      (select string_agg(k.id::text, ',' order by k.id) from public.carpetas k where k.empresa_id = p_empresa_id),
      (select string_agg(s.id::text, ',' order by s.id) from public.empresa_solicitudes s where s.empresa_id = p_empresa_id),
      (select string_agg(s.id::text, ',' order by s.id) from public.empresa_cambios s where s.empresa_id = p_empresa_id)))
  $f$;
  revoke all on function public.empresa_borrado_huella(uuid) from public, anon, authenticated, service_role;

  -- ===================== admin (EXECUTE authenticated; exigen is_admin()) =====================

  -- Qué se borraría. Todo lo que enseña el diálogo sale de aquí.
  create or replace function public.admin_empresa_borrado_resumen(p_empresa_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_e        public.empresas%rowtype;
    v_docs     bigint;
    v_activos  bigint;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select * into v_e from public.empresas where id = p_empresa_id;
    if not found then
      raise exception 'La empresa no existe' using errcode = 'GU010';
    end if;
    select count(*) into v_docs from public.documentos where empresa_id = p_empresa_id;
    select count(*) into v_activos from public.deals where empresa_id = p_empresa_id and stage = 'cliente_activo';

    return jsonb_build_object(
      'empresa', jsonb_build_object('id', v_e.id, 'razon_social', v_e.razon_social, 'cif', v_e.cif,
                                    'provisional', v_e.provisional_at is not null, 'archivada', v_e.archived_at is not null),
      'contactos_solo', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.contact_id, 'nombre', x.nombre, 'email', x.email,
                                            'cuenta', x.auth_user_id is not null,
                                            'cuenta_email', (select u.email from auth.users u where u.id = x.auth_user_id),
                                            'notas', (select count(*) from public.notas n where n.contact_id = x.contact_id),
                                            'deals_sin_empresa', (select count(*) from public.deals d where d.contact_id = x.contact_id and d.empresa_id is null))
                         order by x.nombre)
        from public.empresa_contactos_enlazados(p_empresa_id) x where x.n_empresas = 1), '[]'),
      'contactos_otras', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.contact_id, 'nombre', x.nombre, 'cuenta', x.auth_user_id is not null,
                                            'principal_aqui', x.principal_aqui,
                                            'nueva_principal', case when x.principal_aqui then (
                                               select e.razon_social from public.contacto_empresa ce join public.empresas e on e.id = ce.empresa_id
                                               where ce.contact_id = x.contact_id and ce.empresa_id <> p_empresa_id
                                               order by ce.created_at, ce.id limit 1) end,
                                            'otras', (select jsonb_agg(e.razon_social order by e.razon_social)
                                                      from public.contacto_empresa ce join public.empresas e on e.id = ce.empresa_id
                                                      where ce.contact_id = x.contact_id and ce.empresa_id <> p_empresa_id))
                         order by x.nombre)
        from public.empresa_contactos_enlazados(p_empresa_id) x where x.n_empresas > 1), '[]'),
      'deals', jsonb_build_object(
        'total', (select count(*) from public.deals where empresa_id = p_empresa_id),
        'cliente_activo', v_activos,
        'notas', (select count(*) from public.notas n join public.deals d on d.id = n.deal_id where d.empresa_id = p_empresa_id),
        'lista', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'titulo', d.title, 'etapa', d.stage) order by d.created_at)
                           from public.deals d where d.empresa_id = p_empresa_id), '[]')),
      'documentos', jsonb_build_object(
        'total', v_docs,
        'bytes', (select coalesce(sum(size_bytes), 0) from public.documentos where empresa_id = p_empresa_id),
        'compartidos', (select count(*) from public.documentos where empresa_id = p_empresa_id and visible),
        'del_cliente', (select count(*) from public.documentos where empresa_id = p_empresa_id and source = 'cliente')),
      'carpetas', (select count(*) from public.carpetas where empresa_id = p_empresa_id),
      'solicitudes', jsonb_build_object(
        'total', (select count(*) from public.empresa_solicitudes where empresa_id = p_empresa_id),
        'pendientes', (select count(*) from public.empresa_solicitudes where empresa_id = p_empresa_id and estado = 'pendiente'),
        'cambios', (select count(*) from public.empresa_cambios where empresa_id = p_empresa_id)),
      'requiere_nombre', v_docs > 0 or v_activos > 0,
      'sugerir_archivar', (v_docs > 0 or v_activos > 0) and v_e.provisional_at is null,
      'huella', public.empresa_borrado_huella(p_empresa_id));
  end;
  $f$;

  -- Elimina la empresa. p_decisiones: {"<contact_id>": "borrar" | "<empresa_id destino>"}
  -- para CADA contacto que solo está en esta empresa (ni uno más ni uno menos).
  create or replace function public.admin_borrar_empresa(p_empresa_id uuid, p_huella text, p_decisiones jsonb, p_confirmacion text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_e          public.empresas%rowtype;
    v_resumen    jsonb;
    v_solo       uuid[];
    v_borrar     uuid[] := '{}';
    v_mover      jsonb := '{}';
    v_clave      text;
    v_valor      text;
    v_destino    uuid;
    v_lote       uuid := gen_random_uuid();
    v_rutas      bigint;
    v_cuentas    bigint := 0;
    v_otros      uuid[];
    v_c          uuid;
    v_admin      uuid;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select * into v_e from public.empresas where id = p_empresa_id for update;
    if not found then
      raise exception 'La empresa no existe' using errcode = 'GU010';
    end if;
    -- Los contactos y sus enlaces tampoco pueden cambiar mientras tanto.
    perform 1 from public.contacto_empresa ce
      where ce.contact_id in (select contact_id from public.contacto_empresa where empresa_id = p_empresa_id)
      for update;

    v_resumen := public.admin_empresa_borrado_resumen(p_empresa_id);
    if p_huella is null or p_huella <> v_resumen ->> 'huella' then
      raise exception 'La empresa ha cambiado desde que abriste el resumen. Vuelve a abrirlo antes de eliminarla.' using errcode = 'GU010';
    end if;
    if (v_resumen ->> 'requiere_nombre')::boolean
       and lower(regexp_replace(btrim(coalesce(p_confirmacion, '')), '\s+', ' ', 'g'))
           <> lower(regexp_replace(btrim(v_e.razon_social), '\s+', ' ', 'g')) then
      raise exception 'Escribe la razón social exacta de la empresa para confirmar' using errcode = 'GU010';
    end if;

    -- Decisiones: una por cada contacto que solo está aquí.
    select coalesce(array_agg((x ->> 'id')::uuid), '{}') into v_solo
    from jsonb_array_elements(v_resumen -> 'contactos_solo') x;
    if p_decisiones is null or jsonb_typeof(p_decisiones) <> 'object' then
      p_decisiones := '{}';
    end if;
    for v_clave, v_valor in select key, value #>> '{}' from jsonb_each(p_decisiones) loop
      if v_clave !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not (v_clave::uuid = any (v_solo)) then
        raise exception 'Hay una decisión para un contacto que no es solo de esta empresa' using errcode = 'GU010';
      end if;
      if v_valor = 'borrar' then
        v_borrar := v_borrar || v_clave::uuid;
      else
        if coalesce(v_valor, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'Decisión no válida para un contacto' using errcode = 'GU010';
        end if;
        v_destino := v_valor::uuid;
        perform 1 from public.empresas e
          where e.id = v_destino and e.id <> p_empresa_id and e.provisional_at is null and e.archived_at is null
          for share;
        if not found then
          raise exception 'La empresa de destino no existe, está archivada o pendiente de validar' using errcode = 'GU010';
        end if;
        v_mover := v_mover || jsonb_build_object(v_clave, v_destino);
      end if;
    end loop;
    if cardinality(v_borrar) + (select count(*) from jsonb_object_keys(v_mover)) <> cardinality(v_solo) then
      raise exception 'Falta decidir qué pasa con algún contacto' using errcode = 'GU010';
    end if;

    -- Contactos que están también en otras empresas (para la principal).
    select coalesce(array_agg(x.contact_id), '{}') into v_otros
    from public.empresa_contactos_enlazados(p_empresa_id) x where x.n_empresas > 1 and x.principal_aqui;

    -- 1) Ficheros: las rutas quedan registradas en esta misma transacción.
    insert into public.storage_borrados (lote, ruta, empresa_id, razon_social)
    select distinct v_lote, r, p_empresa_id, v_e.razon_social
    from (select d.storage_path as r from public.documentos d where d.empresa_id = p_empresa_id
          union
          select d.mover_a from public.documentos d where d.empresa_id = p_empresa_id) x
    where r is not null
    on conflict (ruta) where borrado_at is null do nothing;
    get diagnostics v_rutas = row_count;
    delete from public.documentos d where d.empresa_id = p_empresa_id;

    -- 2) Deals de la empresa (sus notas caen en cascada; las tareas se quedan sin deal).
    update public.tareas t set deal_id = null
    where t.deal_id in (select d.id from public.deals d where d.empresa_id = p_empresa_id);
    delete from public.deals d where d.empresa_id = p_empresa_id;

    -- 3) Contactos que se mueven: el destino pasa a ser su principal.
    for v_clave in select jsonb_object_keys(v_mover) loop
      v_c := v_clave::uuid;
      delete from public.contacto_empresa ce where ce.contact_id = v_c and ce.empresa_id = p_empresa_id;
      insert into public.contacto_empresa (contact_id, empresa_id, principal)
      values (v_c, (v_mover ->> v_clave)::uuid, true);
    end loop;

    -- 4) Contactos que se borran: su cuenta queda pendiente (y se conserva).
    insert into public.portal_cuentas_conservar (auth_user_id, motivo)
    select c.auth_user_id, 'Su contacto se borró al eliminar la empresa ' || v_e.razon_social
    from public.contactos c where c.id = any (v_borrar) and c.auth_user_id is not null
    on conflict (auth_user_id) do update set desde = now(), motivo = excluded.motivo;
    get diagnostics v_cuentas = row_count;
    update public.leads l set status = 'deleted'
    where l.id in (select c.lead_id from public.contactos c where c.id = any (v_borrar) and c.lead_id is not null);
    update public.tareas t set contact_id = null where t.contact_id = any (v_borrar);
    foreach v_c in array v_borrar loop
      perform public.admin_borrar_contacto(v_c);
    end loop;

    -- 5) La empresa (carpetas, enlaces, solicitudes y cambios en cascada).
    delete from public.empresas e where e.id = p_empresa_id;

    -- 6) Quien tenía aquí su principal: pasa a serlo la más antigua de las otras.
    update public.contacto_empresa ce set principal = true
    where ce.id in (
      select distinct on (x.contact_id) x.id from public.contacto_empresa x
      where x.contact_id = any (v_otros)
        and not exists (select 1 from public.contacto_empresa y where y.contact_id = x.contact_id and y.principal)
      order by x.contact_id, x.created_at, x.id);

    select a.id into v_admin from public.admins a where a.auth_user_id = auth.uid();
    insert into public.empresas_borradas (empresa_id, razon_social, cif, provisional, borrada_por, lote, resumen)
    values (p_empresa_id, v_e.razon_social, v_e.cif, v_e.provisional_at is not null, v_admin, v_lote,
            v_resumen - 'huella' || jsonb_build_object('decisiones', p_decisiones));

    return jsonb_build_object('lote', v_lote, 'ficheros', v_rutas,
                              'contactos_borrados', cardinality(v_borrar),
                              'contactos_movidos', (select count(*) from jsonb_object_keys(v_mover)),
                              'cuentas_pendientes', v_cuentas);
  end;
  $f$;

  -- Archivar (true) o restaurar (false). No borra nada.
  create or replace function public.admin_archivar_empresa(p_empresa_id uuid, p_archivar boolean)
  returns timestamptz
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_e public.empresas%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select * into v_e from public.empresas where id = p_empresa_id for update;
    if not found then
      raise exception 'La empresa no existe' using errcode = 'GU010';
    end if;
    if p_archivar and v_e.provisional_at is not null then
      raise exception 'Es un alta pendiente de validar: confírmala o recházala en lugar de archivarla' using errcode = 'GU010';
    end if;
    update public.empresas
    set archived_at = case when p_archivar then coalesce(v_e.archived_at, now()) end,
        archived_by = case when p_archivar then coalesce(v_e.archived_by, (select a.id from public.admins a where a.auth_user_id = auth.uid())) end
    where id = p_empresa_id;
    return case when p_archivar then coalesce(v_e.archived_at, now()) end;
  end;
  $f$;

  -- Ficheros pendientes de borrar de Storage (para el aviso del CRM).
  create or replace function public.admin_ficheros_por_borrar()
  returns table(id uuid, ruta text, razon_social text, intentos integer, ultimo_error text, created_at timestamptz)
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
    select s.id, s.ruta, s.razon_social, s.intentos, s.ultimo_error, s.created_at
    from public.storage_borrados s where s.borrado_at is null order by s.created_at;
  end;
  $f$;

  -- Desvincular a mano (fase 1) + la cuenta se conserva.
  create or replace function public.admin_desvincular_cuenta(p_contact_id uuid)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select c.auth_user_id into v_uid from public.contactos c where c.id = p_contact_id for update;
    if not found then
      raise exception 'El contacto no existe' using errcode = 'GU010';
    end if;
    if v_uid is null then
      return false;
    end if;
    update public.contactos set auth_user_id = null where id = p_contact_id;
    insert into public.portal_cuentas_conservar (auth_user_id, motivo)
    values (v_uid, 'Desvinculada por el equipo')
    on conflict (auth_user_id) do update set desde = now(), motivo = excluded.motivo;
    return true;
  end;
  $f$;

  -- Vincular (fase 1) + deja de estar en portal_cuentas_conservar.
  create or replace function public.admin_vincular_cuenta(p_auth_user_id uuid, p_contact_id uuid)
  returns table(emails_coinciden boolean, email_cuenta text, email_contacto text, nombre_contacto text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_email_cuenta  text;
    v_confirmado    timestamptz;
    v_contacto      public.contactos%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;

    select u.email::text, u.email_confirmed_at into v_email_cuenta, v_confirmado
    from auth.users u
    where u.id = p_auth_user_id and u.deleted_at is null and not coalesce(u.is_anonymous, false);
    if not found then
      raise exception 'La cuenta no existe' using errcode = 'GU010';
    end if;
    if v_confirmado is null then
      raise exception 'La cuenta todavía no ha confirmado su email' using errcode = 'GU010';
    end if;
    if exists (select 1 from public.admins a where a.auth_user_id = p_auth_user_id) then
      raise exception 'La cuenta es de un administrador' using errcode = 'GU010';
    end if;
    if exists (select 1 from public.contactos c where c.auth_user_id = p_auth_user_id) then
      raise exception 'La cuenta ya está vinculada a otro contacto' using errcode = 'GU010';
    end if;

    select * into v_contacto from public.contactos c where c.id = p_contact_id for update;
    if not found then
      raise exception 'El contacto no existe' using errcode = 'GU010';
    end if;
    if v_contacto.auth_user_id is not null then
      raise exception 'El contacto ya tiene una cuenta vinculada' using errcode = 'GU010';
    end if;

    begin
      update public.contactos set auth_user_id = p_auth_user_id where id = p_contact_id;
    exception when unique_violation then
      raise exception 'La cuenta ya está vinculada a otro contacto' using errcode = 'GU010';
    end;
    delete from public.portal_cuentas_conservar k where k.auth_user_id = p_auth_user_id;

    return query
    select lower(btrim(coalesce(v_email_cuenta, ''))) = lower(btrim(coalesce(v_contacto.email, ''))),
           v_email_cuenta, v_contacto.email, v_contacto.full_name;
  end;
  $f$;

  -- ===================== limpieza (EXECUTE solo service_role) =====================

  -- Altas caducadas (fase 3.2) sin las cuentas que el equipo desvinculó.
  create or replace function public.portal_altas_caducadas(p_dias integer default 30, p_limite integer default 100)
  returns table(auth_user_id uuid, rutas text[])
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select u.id,
           coalesce((select array_agg(o.name) from storage.objects o
                     where o.bucket_id = 'documentos' and left(o.name, length('pendientes/' || u.id || '/')) = 'pendientes/' || u.id || '/'), '{}')
    from auth.users u
    where u.deleted_at is null
      and u.created_at < now() - make_interval(days => greatest(coalesce(p_dias, 30), 1))
      and not exists (select 1 from public.admins a where a.auth_user_id = u.id)
      and not exists (select 1 from public.contactos c where c.auth_user_id = u.id)
      and not exists (select 1 from public.portal_cuentas_conservar k where k.auth_user_id = u.id)
    order by u.created_at
    limit greatest(coalesce(p_limite, 100), 0)
  $f$;

  -- Rutas pendientes de borrar (de un lote o de todos). Nunca una que
  -- vuelva a usar un documento.
  create or replace function public.storage_borrados_pendientes(p_lote uuid, p_limite integer default 1000)
  returns table(ruta text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select s.ruta from public.storage_borrados s
    where s.borrado_at is null and (p_lote is null or s.lote = p_lote)
      and not exists (select 1 from public.documentos d where d.storage_path = s.ruta or d.mover_a = s.ruta)
    order by s.created_at
    limit greatest(coalesce(p_limite, 1000), 0)
  $f$;

  -- Resultado de un intento: borradas (ok) o con error.
  create or replace function public.storage_borrados_resultado(p_rutas text[], p_error text)
  returns integer
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    n integer;
  begin
    update public.storage_borrados s
    set intentos = s.intentos + 1, ultimo_intento = now(),
        ultimo_error = left(p_error, 500),
        borrado_at = case when p_error is null then now() end
    where s.borrado_at is null and s.ruta = any (p_rutas);
    get diagnostics n = row_count;
    return n;
  end;
  $f$;

  -- ===================== permisos =====================
  revoke all on function public.admin_empresa_borrado_resumen(uuid)              from public, anon, authenticated, service_role;
  revoke all on function public.admin_borrar_empresa(uuid, text, jsonb, text)    from public, anon, authenticated, service_role;
  revoke all on function public.admin_archivar_empresa(uuid, boolean)            from public, anon, authenticated, service_role;
  revoke all on function public.admin_ficheros_por_borrar()                      from public, anon, authenticated, service_role;
  revoke all on function public.admin_desvincular_cuenta(uuid)                   from public, anon, authenticated, service_role;
  revoke all on function public.admin_vincular_cuenta(uuid, uuid)                from public, anon, authenticated, service_role;
  revoke all on function public.portal_altas_caducadas(integer, integer)         from public, anon, authenticated, service_role;
  revoke all on function public.storage_borrados_pendientes(uuid, integer)       from public, anon, authenticated, service_role;
  revoke all on function public.storage_borrados_resultado(text[], text)         from public, anon, authenticated, service_role;

  grant execute on function public.admin_empresa_borrado_resumen(uuid)           to authenticated;
  grant execute on function public.admin_borrar_empresa(uuid, text, jsonb, text) to authenticated;
  grant execute on function public.admin_archivar_empresa(uuid, boolean)         to authenticated;
  grant execute on function public.admin_ficheros_por_borrar()                   to authenticated;
  grant execute on function public.admin_desvincular_cuenta(uuid)                to authenticated;
  grant execute on function public.admin_vincular_cuenta(uuid, uuid)             to authenticated;
  grant execute on function public.portal_altas_caducadas(integer, integer)      to service_role;
  grant execute on function public.storage_borrados_pendientes(uuid, integer)    to service_role;
  grant execute on function public.storage_borrados_resultado(text[], text)      to service_role;
end
$b2$;


-- ============================================================
-- 2C (verificación) — Lo esperado: cada función con security_definer =
-- true y anon/authenticated/service_role como en la columna "esperado".
-- ============================================================
select p.proname, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role,
       case when p.proname in ('portal_altas_caducadas', 'storage_borrados_pendientes', 'storage_borrados_resultado') then 'f/f/t'
            when p.proname in ('mis_empresas', 'empresa_contactos_enlazados', 'empresa_borrado_huella') then 'f/f/f'
            else 'f/t/f' end as esperado
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mis_empresas', 'empresa_contactos_enlazados', 'empresa_borrado_huella', 'admin_empresa_borrado_resumen',
                    'admin_borrar_empresa', 'admin_archivar_empresa', 'admin_ficheros_por_borrar', 'admin_desvincular_cuenta',
                    'admin_vincular_cuenta', 'portal_altas_caducadas', 'storage_borrados_pendientes', 'storage_borrados_resultado')
order by 1;
