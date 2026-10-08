-- ============================================================
-- GUIMAES — Área cliente, fase 3.3: alta inmediata con validación interna
--
-- Sustituye el borrador de alta de la fase 3.2. Al completar sus datos, el
-- cliente crea al momento una empresa y un contacto REALES marcados como
-- pendientes de validar (provisional_at) y su cuenta queda vinculada: entra
-- ya en el panel completo. El equipo después confirma, fusiona con una
-- empresa existente o rechaza.
--
--   * empresas.provisional_at / contactos.provisional_at: NULL = validado;
--     con fecha = pendiente de validar desde entonces (caducidad: 30 días).
--   * El CIF de una provisional no choca con nadie (el índice único de CIF
--     pasa a ser solo de las validadas): el alta nunca revela si el CIF ya
--     existe.
--   * Mientras es provisional el cliente solo ve lo que él ha aportado:
--     sus documentos y los servicios que él pidió. Límite: 10 documentos y
--     50 MB en total.
--   * documentos.mover_a: ruta a la que hay que mover el fichero (fusión, o
--     documentos que venían de pendientes/). Lo mueve portal-cuentas con la
--     API de Storage y lo confirma admin_documento_movido; si falla, se
--     reintenta.
--   * mis_empresas() exige además email confirmado.
--
-- Requiere: fases 1, 2, 3.1 y 3.2 aplicadas (usa alta_cuenta_pendiente y
-- portal_texto de la 3.2; los bloques 3 y 4 migran y borran sus tablas).
--
-- Orden: 1B → 2B → desplegar portal-alta, portal-cuentas y portal-limpieza
-- → push del portal y el CRM → 3B (migrar) → 4B (borrar lo de la 3.2).
-- Cada bloque A es solo lectura; los B cambian (un único DO, atómico); los
-- C verifican.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado: ninguna fila (las columnas no existen).
-- ============================================================
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and ((table_name in ('empresas', 'contactos') and column_name = 'provisional_at')
       or (table_name = 'documentos' and column_name = 'mover_a'))
order by 1, 2;


-- ============================================================
-- 1B (CAMBIO) — Columnas e índices. Un único DO: atómico.
-- ============================================================
do $b1$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'empresas' and column_name = 'provisional_at') then
    raise exception 'empresas.provisional_at ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;

  alter table public.empresas  add column provisional_at timestamptz;
  alter table public.contactos add column provisional_at timestamptz;
  alter table public.documentos add column mover_a text;

  -- CIF único solo entre las empresas validadas.
  drop index public.empresas_cif_key;
  create unique index empresas_cif_key
    on public.empresas (upper(trim(cif)))
    where cif is not null and trim(cif) <> '' and provisional_at is null;

  create index empresas_provisional_idx on public.empresas (provisional_at) where provisional_at is not null;
  create index contactos_provisional_idx on public.contactos (provisional_at) where provisional_at is not null;
  create unique index documentos_mover_a_key on public.documentos (mover_a) where mover_a is not null;
end
$b1$;


-- ============================================================
-- 1C (verificación) — Lo esperado: 3 columnas y 4 índices; el de CIF con
-- "provisional_at IS NULL".
-- ============================================================
select 'columna' as tipo, table_name || '.' || column_name as valor
from information_schema.columns
where table_schema = 'public'
  and ((table_name in ('empresas', 'contactos') and column_name = 'provisional_at')
       or (table_name = 'documentos' and column_name = 'mover_a'))
union all
select 'índice', indexname || ': ' || indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in ('empresas_cif_key', 'empresas_provisional_idx', 'contactos_provisional_idx', 'documentos_mover_a_key')
order by 1, 2;


-- ============================================================
-- 2A (solo lectura) — Lo esperado: solo las que ya existen y se sustituyen:
-- mis_empresas, portal_carpetas, portal_confirmar_subida, portal_deals,
-- portal_documentos, portal_empresas, portal_huerfanos_cliente,
-- portal_preparar_descarga, portal_preparar_subida.
-- ============================================================
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mis_empresas', 'empresa_provisional', 'alta_contacto_provisional', 'alta_carpeta_destino',
                    'alta_borrar_provisional', 'portal_empresas', 'portal_deals', 'portal_documentos', 'portal_carpetas',
                    'portal_preparar_descarga', 'portal_preparar_subida', 'portal_confirmar_subida', 'portal_alta_crear',
                    'admin_altas_provisionales', 'admin_provisional_confirmar', 'admin_provisional_fusionar',
                    'admin_provisional_rechazar', 'admin_documentos_por_mover', 'admin_documento_movido',
                    'portal_provisionales_caducadas', 'portal_eliminar_provisional', 'portal_huerfanos_cliente')
order by 1;


-- ============================================================
-- 2B (CAMBIO) — Funciones. Un único DO. Re-ejecutable.
-- Mismas reglas que las fases anteriores: SECURITY DEFINER, search_path
-- fijo, sin parámetro de uid, REVOKE ALL y después solo lo que toca.
-- ============================================================
do $b2$
begin
  -- ===================== internas (sin EXECUTE para nadie) =====================

  -- Empresas del usuario actual: vinculado a un contacto, no admin y con
  -- el email confirmado.
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
    where auth.uid() is not null
      and c.auth_user_id = auth.uid()
      and not exists (select 1 from public.admins a where a.auth_user_id = auth.uid())
      and exists (select 1 from auth.users u
                  where u.id = auth.uid() and u.email_confirmed_at is not null and u.deleted_at is null)
  $f$;
  revoke all on function public.mis_empresas() from public, anon, authenticated, service_role;

  create or replace function public.empresa_provisional(p_empresa_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select exists (select 1 from public.empresas e where e.id = p_empresa_id and e.provisional_at is not null)
  $f$;
  revoke all on function public.empresa_provisional(uuid) from public, anon, authenticated, service_role;

  -- El contacto provisional de un alta (el que tiene la cuenta).
  create or replace function public.alta_contacto_provisional(p_empresa_id uuid)
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select c.id
    from public.contactos c
    join public.contacto_empresa ce on ce.contact_id = c.id
    where ce.empresa_id = p_empresa_id and c.provisional_at is not null
    order by (c.auth_user_id is not null) desc, c.created_at
    limit 1
  $f$;
  revoke all on function public.alta_contacto_provisional(uuid) from public, anon, authenticated, service_role;

  -- Carpeta de destino (en la empresa p_destino) para un documento del
  -- equipo que estaba en la carpeta p_carpeta de otra empresa: la carpeta
  -- raíz con el mismo nombre que su raíz; si no hay, se crea.
  create or replace function public.alta_carpeta_destino(p_carpeta uuid, p_destino uuid)
  returns uuid
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_nombre text;
    v_id     uuid;
  begin
    select coalesce(p.nombre, k.nombre) into v_nombre
    from public.carpetas k left join public.carpetas p on p.id = k.parent_id
    where k.id = p_carpeta;
    v_nombre := coalesce(nullif(btrim(v_nombre), ''), 'Documentos');
    if lower(v_nombre) = lower('Aportados por el cliente') then
      v_nombre := 'Documentos';
    end if;
    select k.id into v_id from public.carpetas k
    where k.empresa_id = p_destino and k.parent_id is null and lower(btrim(k.nombre)) = lower(v_nombre)
      and k.system_key is distinct from 'cliente';
    if v_id is null then
      insert into public.carpetas (empresa_id, nombre, orden) values (p_destino, v_nombre, 50)
      returning id into v_id;
    end if;
    return v_id;
  end;
  $f$;
  revoke all on function public.alta_carpeta_destino(uuid, uuid) from public, anon, authenticated, service_role;

  -- Borra un alta provisional entera (documentos, deals, contacto y
  -- empresa) en la transacción de quien llama. Devuelve la cuenta y las
  -- rutas de los ficheros, que borra después la Edge Function. Con p_dias,
  -- solo si lleva más de esos días sin validar (caducidad).
  create or replace function public.alta_borrar_provisional(p_empresa_id uuid, p_dias integer)
  returns table(auth_user_id uuid, rutas text[])
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_contactos uuid[];
    v_uid       uuid;
    v_rutas     text[];
  begin
    perform 1 from public.empresas e
    where e.id = p_empresa_id and e.provisional_at is not null
      and (p_dias is null or e.provisional_at < now() - make_interval(days => greatest(p_dias, 1)))
    for update;
    if not found then
      raise exception 'Esta alta ya no está pendiente de validar' using errcode = 'GU010';
    end if;

    select array_agg(c.id), (array_agg(c.auth_user_id) filter (where c.auth_user_id is not null))[1]
    into v_contactos, v_uid
    from public.contactos c
    join public.contacto_empresa ce on ce.contact_id = c.id
    where ce.empresa_id = p_empresa_id and c.provisional_at is not null;

    select coalesce(array_agg(x) filter (where x is not null), '{}') into v_rutas
    from (select d.storage_path as x from public.documentos d where d.empresa_id = p_empresa_id
          union all
          select d.mover_a from public.documentos d where d.empresa_id = p_empresa_id) r;

    delete from public.documentos d where d.empresa_id = p_empresa_id;
    delete from public.deals d where d.empresa_id = p_empresa_id;
    if v_contactos is not null then
      delete from public.contactos c where c.id = any (v_contactos);
    end if;
    delete from public.empresas e where e.id = p_empresa_id;

    return query select v_uid, v_rutas;
  end;
  $f$;
  revoke all on function public.alta_borrar_provisional(uuid, integer) from public, anon, authenticated, service_role;

  -- ===================== cliente (EXECUTE authenticated) =====================

  -- Alta: crea la empresa y el contacto provisionales y vincula la cuenta.
  -- Solo una cuenta pendiente con email confirmado (alta_cuenta_pendiente:
  -- GU001 / GU006). Nunca mira si el CIF o el email ya existen.
  create or replace function public.portal_alta_crear(
    p_razon_social text, p_cif text, p_direccion text, p_ciudad text, p_provincia text,
    p_nombre_contacto text, p_telefono text)
  returns table(empresa_id uuid, razon_social text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid     uuid := public.alta_cuenta_pendiente();
    v_rs      text := public.portal_texto(p_razon_social, 200, 'La razón social');
    v_cif     text := nullif(upper(regexp_replace(coalesce(p_cif, ''), '[\s.\-]', '', 'g')), '');
    v_dir     text := public.portal_texto(p_direccion, 200, 'La dirección');
    v_ci      text := public.portal_texto(p_ciudad, 100, 'La ciudad');
    v_pr      text := public.portal_texto(p_provincia, 100, 'La provincia');
    v_nom     text := public.portal_texto(p_nombre_contacto, 120, 'El nombre');
    v_tel     text := public.portal_texto(p_telefono, 20, 'El teléfono');
    v_email   text;
    v_empresa uuid;
    v_contact uuid;
  begin
    if v_rs is null or length(v_rs) < 2 then
      raise exception 'Escribe la razón social de tu empresa.' using errcode = 'GU005';
    end if;
    if v_cif is null or v_cif !~ '^[A-Z0-9]{9}$' then
      raise exception 'El CIF o NIF tiene que tener 9 letras o números (por ejemplo, B12345678).' using errcode = 'GU005';
    end if;
    if v_nom is null then
      raise exception 'Escribe el nombre de la persona de contacto.' using errcode = 'GU005';
    end if;
    if v_tel is not null and v_tel !~ '^[0-9+() .-]{6,20}$' then
      raise exception 'Escribe un teléfono válido (solo números, espacios y +).' using errcode = 'GU005';
    end if;

    select u.email::text into v_email from auth.users u where u.id = v_uid;

    insert into public.empresas (razon_social, cif, address, city, province, provisional_at)
    values (v_rs, v_cif, v_dir, v_ci, v_pr, now())
    returning id into v_empresa;
    begin
      insert into public.contactos (full_name, email, phone, lifecycle, source, auth_user_id, provisional_at)
      values (v_nom, v_email, v_tel, 'new', 'Área cliente', v_uid, now())
      returning id into v_contact;
    exception when unique_violation then
      -- Dos altas a la vez desde la misma cuenta: la otra ya la vinculó.
      raise exception 'No disponible' using errcode = 'GU001';
    end;
    insert into public.contacto_empresa (contact_id, empresa_id, principal) values (v_contact, v_empresa, true);

    return query select v_empresa, v_rs;
  end;
  $f$;

  -- Ahora con pendiente_validar (cambia la firma: se borra y se crea).
  drop function if exists public.portal_empresas();
  create function public.portal_empresas()
  returns table(empresa_id uuid, razon_social text, cif text, direccion text, ciudad text,
                provincia text, principal boolean, pendiente_validar boolean)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select e.id, e.razon_social, e.cif, e.address, e.city, e.province,
           e.id = public.empresa_principal_de(c.id), e.provisional_at is not null
    from public.contactos c
    join public.contacto_empresa ce on ce.contact_id = c.id
    join public.empresas e on e.id = ce.empresa_id
    where c.auth_user_id = auth.uid()
      and e.id in (select public.mis_empresas())
    order by (e.id = public.empresa_principal_de(c.id)) desc, e.razon_social
  $f$;

  -- Provisional: solo lo que pidió el cliente (origen 'portal').
  create or replace function public.portal_deals(p_empresa_id uuid)
  returns table(estado text, servicio text, importe numeric, frecuencia text,
                num_nominas integer, coste_nomina numeric)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    return query
    select case when d.stage = 'cliente_activo' then 'Contratado'
                when d.stage in ('propuesta', 'negociacion') then 'En estudio'
                else 'Solicitado' end,
           public.servicio_nombre(d.service),
           d.amount,
           d.frequency,
           case when d.service = 's4' then d.num_nominas end,
           case when d.service = 's4' then d.coste_nomina end
    from public.deals d
    where d.empresa_id = p_empresa_id
      and (d.stage in ('propuesta', 'negociacion', 'cliente_activo')
           or (d.origen = 'portal' and d.stage in ('nueva_solicitud', 'contactado', 'reunion')))
      and (d.origen = 'portal' or not public.empresa_provisional(p_empresa_id))
    order by case when d.stage = 'cliente_activo' then 0 when d.stage in ('propuesta', 'negociacion') then 1 else 2 end,
             d.created_at desc;
  end;
  $f$;

  -- Provisional: solo los documentos que aportó el cliente.
  create or replace function public.portal_documentos(p_empresa_id uuid)
  returns table(documento_id uuid, nombre text, carpeta_id uuid, tipo_mime text,
                tamano_bytes bigint, fecha timestamptz, aportado_por_cliente boolean)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    return query
    select d.id,
           coalesce(nullif(d.original_filename, ''), regexp_replace(d.storage_path, '^.*/', '')),
           d.folder_id,
           d.mime_type,
           d.size_bytes,
           d.created_at,
           d.source = 'cliente'
    from public.documentos d
    where d.empresa_id = p_empresa_id
      and public.portal_documento_visible(d.visible, d.status, d.source)
      and (d.source = 'cliente' or not public.empresa_provisional(p_empresa_id))
    order by d.created_at desc;
  end;
  $f$;

  create or replace function public.portal_carpetas(p_empresa_id uuid)
  returns table(carpeta_id uuid, nombre text, carpeta_padre_id uuid, aportados boolean, orden integer)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    return query
    with con_docs as (
      select distinct d.folder_id as id
      from public.documentos d
      where d.empresa_id = p_empresa_id
        and d.folder_id is not null
        and public.portal_documento_visible(d.visible, d.status, d.source)
        and (d.source = 'cliente' or not public.empresa_provisional(p_empresa_id))
    ), ids as (
      select id from con_docs
      union
      select c.parent_id from public.carpetas c join con_docs on con_docs.id = c.id where c.parent_id is not null
      union
      select c.id from public.carpetas c where c.empresa_id = p_empresa_id and c.system_key = 'cliente'
    )
    select c.id, c.nombre, c.parent_id, c.system_key is not distinct from 'cliente', c.orden
    from public.carpetas c
    join ids on ids.id = c.id
    where c.empresa_id = p_empresa_id
    order by c.orden, c.nombre;
  end;
  $f$;

  create or replace function public.portal_preparar_descarga(p_documento_id uuid)
  returns table(storage_path text, nombre text)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    return query
    select d.storage_path,
           coalesce(nullif(d.original_filename, ''), regexp_replace(d.storage_path, '^.*/', ''))
    from public.documentos d
    where d.id = p_documento_id
      and d.empresa_id in (select public.mis_empresas())
      and public.portal_documento_visible(d.visible, d.status, d.source)
      and (d.source = 'cliente' or not public.empresa_provisional(d.empresa_id));
    if not found then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
  end;
  $f$;

  -- Límites de siempre (30 al día, 15 MB) y, mientras la empresa es
  -- provisional, 10 documentos y 50 MB en total.
  create or replace function public.portal_preparar_subida(p_empresa_id uuid)
  returns table(subidas_restantes integer)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_hoy   integer;
    v_total integer;
    v_bytes bigint;
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    select count(*) into v_hoy
    from storage.objects o
    where o.bucket_id = 'documentos'
      and left(o.name, length('cliente/' || p_empresa_id || '/')) = 'cliente/' || p_empresa_id || '/'
      and o.created_at >= (date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid');
    if v_hoy >= 30 then
      raise exception 'Has alcanzado el máximo de 30 documentos por día para esta empresa. Inténtalo mañana.'
        using errcode = 'GU003';
    end if;
    if public.empresa_provisional(p_empresa_id) then
      select count(*), coalesce(sum(d.size_bytes), 0) into v_total, v_bytes
      from public.documentos d where d.empresa_id = p_empresa_id and d.source = 'cliente';
      if v_total >= 10 or v_bytes >= 52428800 then
        raise exception 'Mientras validamos tu cuenta puedes enviarnos hasta 10 documentos (50 MB en total). Cuando la validemos podrás enviar más.'
          using errcode = 'GU003';
      end if;
      return query select least(30 - v_hoy, 10 - v_total);
      return;
    end if;
    return query select 30 - v_hoy;
  end;
  $f$;

  create or replace function public.portal_confirmar_subida(p_empresa_id uuid, p_documento_id uuid, p_nombre text)
  returns table(documento_id uuid, nombre text, razon_social text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_prefijo   text;
    v_n         integer;
    v_objeto    storage.objects%rowtype;
    v_nombre    text;
    v_ext       text;
    v_ext_obj   text;
    v_tamano    bigint;
    v_mime      text;
    v_contacto  uuid;
    v_razon     text;
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    if p_documento_id is null then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    v_prefijo := 'cliente/' || p_empresa_id || '/' || p_documento_id || '/';

    if exists (select 1 from public.documentos d
               where d.id = p_documento_id or left(d.storage_path, length(v_prefijo)) = v_prefijo) then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;

    select count(*) into v_n
    from storage.objects o
    where o.bucket_id = 'documentos' and left(o.name, length(v_prefijo)) = v_prefijo;
    if v_n = 0 then
      raise exception 'Fichero no válido: no se ha recibido el fichero' using errcode = 'GU002';
    end if;
    if v_n > 1 then
      raise exception 'Fichero no válido: hay más de un fichero para este documento' using errcode = 'GU002';
    end if;
    select * into v_objeto
    from storage.objects o
    where o.bucket_id = 'documentos' and left(o.name, length(v_prefijo)) = v_prefijo;

    if (select count(*) from public.documentos d
        where d.empresa_id = p_empresa_id and d.source = 'cliente'
          and d.created_at >= (date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid')) >= 30 then
      raise exception 'Fichero no válido: se ha alcanzado el máximo de 30 documentos por día' using errcode = 'GU002';
    end if;

    v_tamano := nullif(v_objeto.metadata ->> 'size', '')::bigint;
    if v_tamano is null or v_tamano < 1 or v_tamano > 15728640 then
      raise exception 'Fichero no válido: el tamaño tiene que estar entre 1 byte y 15 MB' using errcode = 'GU002';
    end if;

    -- Provisional: 10 documentos y 50 MB en total (sobre los reales).
    if public.empresa_provisional(p_empresa_id)
       and (select count(*) >= 10 or coalesce(sum(d.size_bytes), 0) + v_tamano > 52428800
            from public.documentos d where d.empresa_id = p_empresa_id and d.source = 'cliente') then
      raise exception 'Fichero no válido: mientras validamos tu cuenta puedes enviarnos hasta 10 documentos (50 MB en total)'
        using errcode = 'GU002';
    end if;

    v_nombre := btrim(regexp_replace(normalize(coalesce(p_nombre, ''), NFC), '[\x01-\x1f\x7f/\\]', '', 'g'));
    v_ext := lower(substring(v_nombre from '\.([A-Za-z0-9]+)$'));
    if v_nombre = '' or length(v_nombre) > 150 or v_ext is null
       or btrim(left(v_nombre, length(v_nombre) - length(v_ext) - 1)) = '' then
      raise exception 'Fichero no válido: nombre no admitido' using errcode = 'GU002';
    end if;
    v_ext_obj := lower(substring(regexp_replace(v_objeto.name, '^.*/', '') from '\.([A-Za-z0-9]+)$'));
    if v_ext_obj is distinct from v_ext then
      raise exception 'Fichero no válido: la extensión no coincide con la del fichero subido' using errcode = 'GU002';
    end if;
    v_mime := public.portal_tipo_permitido(v_ext, v_objeto.metadata ->> 'mimetype');
    if v_mime is null then
      raise exception 'Fichero no válido: tipo de fichero no admitido' using errcode = 'GU002';
    end if;

    select c.id into v_contacto from public.contactos c where c.auth_user_id = auth.uid();
    select e.razon_social into v_razon from public.empresas e where e.id = p_empresa_id;

    begin
      insert into public.documentos
        (id, storage_path, mime_type, size_bytes, original_filename, status,
         empresa_id, folder_id, source, aportado_por_contact_id, uploaded_by, visible)
      values
        (p_documento_id, v_objeto.name, v_mime, v_tamano, v_nombre, 'stored',
         p_empresa_id, public.carpeta_cliente(p_empresa_id), 'cliente', v_contacto, null, false);
    exception when unique_violation then
      raise exception 'No disponible' using errcode = 'GU001';
    end;

    return query select p_documento_id, v_nombre, v_razon;
  end;
  $f$;

  -- ===================== admin (EXECUTE authenticated; exigen is_admin()) =====================

  -- Altas pendientes de validar, con la cuenta (email de Auth, que el CRM
  -- no puede leer por sí mismo).
  create or replace function public.admin_altas_provisionales()
  returns table(empresa_id uuid, contact_id uuid, auth_user_id uuid, email_cuenta text,
                email_confirmado boolean, ultimo_acceso timestamptz, creada timestamptz)
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
    select e.id, c.id, c.auth_user_id, u.email::text, u.email_confirmed_at is not null, u.last_sign_in_at, e.provisional_at
    from public.empresas e
    left join public.contactos c on c.id = public.alta_contacto_provisional(e.id)
    left join auth.users u on u.id = c.auth_user_id
    where e.provisional_at is not null
    order by e.provisional_at desc;
  end;
  $f$;

  -- Confirmar como cliente nuevo: se quita la marca a la empresa y a su
  -- contacto. Los ficheros que no estén en cliente/{empresa}/ (venían de
  -- pendientes/) quedan para mover.
  create or replace function public.admin_provisional_confirmar(p_empresa_id uuid)
  returns table(auth_user_id uuid, email text, nombre text, documentos_por_mover integer)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_cif     text;
    v_contact uuid;
    v_n       integer;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select e.cif into v_cif from public.empresas e where e.id = p_empresa_id and e.provisional_at is not null for update;
    if not found then
      raise exception 'Esta alta ya no está pendiente de validar' using errcode = 'GU010';
    end if;
    v_contact := public.alta_contacto_provisional(p_empresa_id);
    begin
      update public.empresas set provisional_at = null where id = p_empresa_id;
    exception when unique_violation then
      raise exception 'Ya hay una empresa con el CIF %: usa «Fusionar con existente»', v_cif using errcode = 'GU010';
    end;
    update public.contactos c set provisional_at = null
    where c.provisional_at is not null
      and c.id in (select ce.contact_id from public.contacto_empresa ce where ce.empresa_id = p_empresa_id);

    update public.documentos d
    set mover_a = 'cliente/' || p_empresa_id || '/' || d.id || '/' || regexp_replace(d.storage_path, '^.*/', '')
    where d.empresa_id = p_empresa_id and d.source = 'cliente' and d.mover_a is null
      and left(d.storage_path, length('cliente/' || p_empresa_id || '/')) <> 'cliente/' || p_empresa_id || '/';
    select count(*) into v_n from public.documentos d where d.empresa_id = p_empresa_id and d.mover_a is not null;

    return query
    select c.auth_user_id, u.email::text, c.full_name, v_n
    from public.contactos c left join auth.users u on u.id = c.auth_user_id
    where c.id = v_contact;
  end;
  $f$;

  -- Fusionar con una empresa existente: documentos, deals, solicitudes e
  -- historial pasan a p_destino_id; la cuenta se vincula a p_contact_id (o a
  -- un contacto nuevo en esa empresa con los datos del provisional); la
  -- empresa y el contacto provisionales se borran. Los ficheros se mueven
  -- después (documentos.mover_a).
  create or replace function public.admin_provisional_fusionar(p_empresa_id uuid, p_destino_id uuid, p_contact_id uuid)
  returns table(empresa_id uuid, contact_id uuid, auth_user_id uuid, email text, nombre text, documentos_por_mover integer)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_admin  uuid;
    v_prov   public.contactos%rowtype;
    v_dest_c uuid := p_contact_id;
    v_c      public.contactos%rowtype;
    v_uid    uuid;
    v_n      integer;
    v_pref_c text := 'cliente/' || p_empresa_id || '/';
    v_pref_m text := 'manual/' || p_empresa_id || '/';
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select a.id into v_admin from public.admins a where a.auth_user_id = auth.uid();
    perform 1 from public.empresas e where e.id = p_empresa_id and e.provisional_at is not null for update;
    if not found then
      raise exception 'Esta alta ya no está pendiente de validar' using errcode = 'GU010';
    end if;
    perform 1 from public.empresas e where e.id = p_destino_id and e.provisional_at is null for update;
    if not found or p_destino_id = p_empresa_id then
      raise exception 'Elige una empresa ya validada como destino' using errcode = 'GU010';
    end if;

    select * into v_prov from public.contactos c where c.id = public.alta_contacto_provisional(p_empresa_id) for update;
    v_uid := v_prov.auth_user_id;

    -- Contacto de destino
    if v_dest_c is not null then
      select * into v_c from public.contactos c where c.id = v_dest_c for update;
      if not found then raise exception 'El contacto no existe' using errcode = 'GU010'; end if;
      if v_c.provisional_at is not null then raise exception 'Elige un contacto ya validado' using errcode = 'GU010'; end if;
      if v_c.auth_user_id is not null then raise exception 'El contacto ya tiene una cuenta vinculada' using errcode = 'GU010'; end if;
      if not exists (select 1 from public.contacto_empresa ce where ce.contact_id = v_dest_c and ce.empresa_id = p_destino_id) then
        insert into public.contacto_empresa (contact_id, empresa_id, principal)
        values (v_dest_c, p_destino_id, not exists (select 1 from public.contacto_empresa ce where ce.contact_id = v_dest_c and ce.principal));
      end if;
    else
      insert into public.contactos (full_name, email, phone, lifecycle, source)
      values (coalesce(v_prov.full_name, v_prov.email), v_prov.email, v_prov.phone, 'new', 'Área cliente')
      returning id into v_dest_c;
      insert into public.contacto_empresa (contact_id, empresa_id, principal) values (v_dest_c, p_destino_id, true);
    end if;

    -- Documentos: empresa, carpeta, quién y ruta a la que mover el fichero.
    update public.documentos d
    set empresa_id = p_destino_id,
        aportado_por_contact_id = case when d.aportado_por_contact_id = v_prov.id then v_dest_c else d.aportado_por_contact_id end,
        folder_id = case when d.source = 'cliente' then public.carpeta_cliente(p_destino_id)
                         when d.source = 'whatsapp' then null
                         else public.alta_carpeta_destino(d.folder_id, p_destino_id) end,
        mover_a = case
          when left(coalesce(d.mover_a, d.storage_path), length(v_pref_c)) = v_pref_c
            then 'cliente/' || p_destino_id || '/' || substr(coalesce(d.mover_a, d.storage_path), length(v_pref_c) + 1)
          when left(coalesce(d.mover_a, d.storage_path), length(v_pref_m)) = v_pref_m
            then 'manual/' || p_destino_id || '/' || substr(coalesce(d.mover_a, d.storage_path), length(v_pref_m) + 1)
          when d.storage_path like 'pendientes/%'
            then 'cliente/' || p_destino_id || '/' || d.id || '/' || regexp_replace(d.storage_path, '^.*/', '')
          else d.mover_a end
    where d.empresa_id = p_empresa_id;

    update public.deals d
    set empresa_id = p_destino_id,
        contact_id = case when d.contact_id = v_prov.id then v_dest_c else d.contact_id end
    where d.empresa_id = p_empresa_id or (v_prov.id is not null and d.contact_id = v_prov.id);

    if v_prov.id is not null then
      update public.notas n set contact_id = v_dest_c where n.contact_id = v_prov.id;
      update public.tareas t set contact_id = v_dest_c where t.contact_id = v_prov.id;
      update public.whatsapp_conversations w set contact_id = v_dest_c where w.contact_id = v_prov.id;
    end if;

    -- Solicitudes: si el destino ya tiene una pendiente del mismo dato, la
    -- del alta se cierra como no aplicada (solo puede haber una pendiente).
    update public.empresa_solicitudes s
    set estado = 'rechazada', resuelta_at = now(), resuelta_por = v_admin
    where s.empresa_id = p_empresa_id and s.estado = 'pendiente'
      and exists (select 1 from public.empresa_solicitudes o
                  where o.empresa_id = p_destino_id and o.campo = s.campo and o.estado = 'pendiente');
    update public.empresa_solicitudes s
    set empresa_id = p_destino_id,
        contact_id = case when s.contact_id = v_prov.id then v_dest_c else s.contact_id end
    where s.empresa_id = p_empresa_id;
    update public.empresa_cambios s
    set empresa_id = p_destino_id,
        contact_id = case when s.contact_id = v_prov.id then v_dest_c else s.contact_id end
    where s.empresa_id = p_empresa_id;

    -- Cuenta: del provisional al de destino; después se borran los provisionales.
    if v_prov.id is not null then
      update public.contactos set auth_user_id = null where id = v_prov.id;
      delete from public.contactos where id = v_prov.id;
    end if;
    if v_uid is not null then
      update public.contactos set auth_user_id = v_uid where id = v_dest_c;
    end if;
    delete from public.empresas e where e.id = p_empresa_id;

    select count(*) into v_n from public.documentos d where d.empresa_id = p_destino_id and d.mover_a is not null;
    return query
    select p_destino_id, v_dest_c, v_uid, u.email::text, c.full_name, v_n
    from public.contactos c left join auth.users u on u.id = v_uid
    where c.id = v_dest_c;
  end;
  $f$;

  -- Rechazar: borra empresa, contacto, documentos y deals del alta. La
  -- Edge Function borra después los ficheros y la cuenta.
  create or replace function public.admin_provisional_rechazar(p_empresa_id uuid)
  returns table(auth_user_id uuid, rutas text[])
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    return query select * from public.alta_borrar_provisional(p_empresa_id, null);
  end;
  $f$;

  -- Ficheros pendientes de mover (de una empresa o de todas).
  create or replace function public.admin_documentos_por_mover(p_empresa_id uuid)
  returns table(documento_id uuid, empresa_id uuid, origen text, destino text)
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
    select d.id, d.empresa_id, d.storage_path, d.mover_a
    from public.documentos d
    where d.mover_a is not null and (p_empresa_id is null or d.empresa_id = p_empresa_id)
    order by d.created_at;
  end;
  $f$;

  -- El fichero ya está en su destino: se apunta la ruta nueva.
  create or replace function public.admin_documento_movido(p_documento_id uuid)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_destino text;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select d.mover_a into v_destino from public.documentos d where d.id = p_documento_id and d.mover_a is not null for update;
    if not found then
      raise exception 'Ese documento no tiene nada pendiente de mover' using errcode = 'GU010';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'documentos' and o.name = v_destino) then
      raise exception 'El fichero todavía no está en su destino' using errcode = 'GU010';
    end if;
    update public.documentos set storage_path = v_destino, mover_a = null where id = p_documento_id;
    return true;
  end;
  $f$;

  -- ===================== limpieza (EXECUTE solo service_role) =====================

  create or replace function public.portal_provisionales_caducadas(p_dias integer default 30, p_limite integer default 100)
  returns table(empresa_id uuid)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select e.id from public.empresas e
    where e.provisional_at is not null
      and e.provisional_at < now() - make_interval(days => greatest(coalesce(p_dias, 30), 1))
    order by e.provisional_at
    limit greatest(coalesce(p_limite, 100), 0)
  $f$;

  create or replace function public.portal_eliminar_provisional(p_empresa_id uuid, p_dias integer default 30)
  returns table(auth_user_id uuid, rutas text[])
  language sql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
    select * from public.alta_borrar_provisional(p_empresa_id, greatest(coalesce(p_dias, 30), 1))
  $f$;

  -- Objetos de cliente/ y pendientes/ con más de 24 h sin ninguna fila que
  -- los use (ni como ruta actual ni como destino de un movimiento). Mientras
  -- existan las tablas de la fase 3.2, también cuentan las suyas (4B
  -- vuelve a crear esta función sin ellas).
  create or replace function public.portal_huerfanos_cliente(p_limite integer default 500)
  returns table(nombre text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select o.name
    from storage.objects o
    where o.bucket_id = 'documentos'
      and (o.name like 'cliente/%' or o.name like 'pendientes/%')
      and o.created_at < now() - interval '24 hours'
      and not exists (select 1 from public.documentos d where d.storage_path = o.name or d.mover_a = o.name)
      and not exists (select 1 from public.alta_documentos a where a.storage_path = o.name or a.destino_path = o.name)
    order by o.created_at
    limit greatest(coalesce(p_limite, 500), 0)
  $f$;

  -- ===================== permisos =====================
  revoke all on function public.portal_alta_crear(text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
  revoke all on function public.portal_empresas()                    from public, anon, authenticated, service_role;
  revoke all on function public.portal_deals(uuid)                   from public, anon, authenticated, service_role;
  revoke all on function public.portal_documentos(uuid)              from public, anon, authenticated, service_role;
  revoke all on function public.portal_carpetas(uuid)                from public, anon, authenticated, service_role;
  revoke all on function public.portal_preparar_descarga(uuid)       from public, anon, authenticated, service_role;
  revoke all on function public.portal_preparar_subida(uuid)         from public, anon, authenticated, service_role;
  revoke all on function public.portal_confirmar_subida(uuid, uuid, text) from public, anon, authenticated, service_role;
  revoke all on function public.admin_altas_provisionales()          from public, anon, authenticated, service_role;
  revoke all on function public.admin_provisional_confirmar(uuid)    from public, anon, authenticated, service_role;
  revoke all on function public.admin_provisional_fusionar(uuid, uuid, uuid) from public, anon, authenticated, service_role;
  revoke all on function public.admin_provisional_rechazar(uuid)     from public, anon, authenticated, service_role;
  revoke all on function public.admin_documentos_por_mover(uuid)     from public, anon, authenticated, service_role;
  revoke all on function public.admin_documento_movido(uuid)         from public, anon, authenticated, service_role;
  revoke all on function public.portal_provisionales_caducadas(integer, integer) from public, anon, authenticated, service_role;
  revoke all on function public.portal_eliminar_provisional(uuid, integer) from public, anon, authenticated, service_role;
  revoke all on function public.portal_huerfanos_cliente(integer)    from public, anon, authenticated, service_role;

  grant execute on function public.portal_alta_crear(text, text, text, text, text, text, text) to authenticated;
  grant execute on function public.portal_empresas()                    to authenticated;
  grant execute on function public.portal_deals(uuid)                   to authenticated;
  grant execute on function public.portal_documentos(uuid)              to authenticated;
  grant execute on function public.portal_carpetas(uuid)                to authenticated;
  grant execute on function public.portal_preparar_descarga(uuid)       to authenticated;
  grant execute on function public.portal_preparar_subida(uuid)         to authenticated;
  grant execute on function public.portal_confirmar_subida(uuid, uuid, text) to authenticated;
  grant execute on function public.admin_altas_provisionales()          to authenticated;
  grant execute on function public.admin_provisional_confirmar(uuid)    to authenticated;
  grant execute on function public.admin_provisional_fusionar(uuid, uuid, uuid) to authenticated;
  grant execute on function public.admin_provisional_rechazar(uuid)     to authenticated;
  grant execute on function public.admin_documentos_por_mover(uuid)     to authenticated;
  grant execute on function public.admin_documento_movido(uuid)         to authenticated;
  grant execute on function public.portal_provisionales_caducadas(integer, integer) to service_role;
  grant execute on function public.portal_eliminar_provisional(uuid, integer) to service_role;
  grant execute on function public.portal_huerfanos_cliente(integer)    to service_role;
end
$b2$;


-- ============================================================
-- 2C (verificación) — Una fila por función. Lo esperado: todas con
-- search_path fijo y security definer; internas false/false/false;
-- portal_provisionales_caducadas, portal_eliminar_provisional y
-- portal_huerfanos_cliente false/false/true; el resto false/true/false.
-- ============================================================
select p.proname as funcion,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ',') as config,
       has_function_privilege('anon', p.oid, 'execute') || '/' ||
       has_function_privilege('authenticated', p.oid, 'execute') || '/' ||
       has_function_privilege('service_role', p.oid, 'execute') as anon_authenticated_service
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mis_empresas', 'empresa_provisional', 'alta_contacto_provisional', 'alta_carpeta_destino',
                    'alta_borrar_provisional', 'portal_empresas', 'portal_deals', 'portal_documentos', 'portal_carpetas',
                    'portal_preparar_descarga', 'portal_preparar_subida', 'portal_confirmar_subida', 'portal_alta_crear',
                    'admin_altas_provisionales', 'admin_provisional_confirmar', 'admin_provisional_fusionar',
                    'admin_provisional_rechazar', 'admin_documentos_por_mover', 'admin_documento_movido',
                    'portal_provisionales_caducadas', 'portal_eliminar_provisional', 'portal_huerfanos_cliente')
order by 1;


-- ============================================================
-- 3A (solo lectura) — Lo que hay en las tablas de la fase 3.2. Las que
-- tengan razón social, CIF y nombre de contacto (y cuya cuenta siga
-- pendiente y confirmada) se migran en 3B; el resto se pierde en 4B.
-- ============================================================
select u.email,
       b.razon_social, b.cif, b.nombre_contacto, b.servicio, b.estado,
       (select count(*) from public.alta_documentos a where a.auth_user_id = b.auth_user_id) as documentos,
       (b.razon_social is not null and b.cif is not null and b.nombre_contacto is not null
        and u.email_confirmed_at is not null
        and not exists (select 1 from public.contactos c where c.auth_user_id = b.auth_user_id)
        and not exists (select 1 from public.admins a where a.auth_user_id = b.auth_user_id)) as se_migra
from public.alta_borradores b
left join auth.users u on u.id = b.auth_user_id
union all
select u.email, '(documento sin borrador)', null, null, null, null, count(*), false
from public.alta_documentos a left join auth.users u on u.id = a.auth_user_id
where not exists (select 1 from public.alta_borradores b where b.auth_user_id = a.auth_user_id)
group by u.email;


-- ============================================================
-- 3B (CAMBIO) — Migración de los borradores de la 3.2 a altas
-- provisionales. Un único DO: atómico. Re-ejecutable (lo migrado sale de
-- las tablas de la 3.2). Los ficheros se quedan donde están (pendientes/…)
-- con mover_a hacia cliente/{empresa}/…: se mueven al confirmar o fusionar.
-- ============================================================
do $b3$
declare
  b         record;
  v_email   text;
  v_empresa uuid;
  v_contact uuid;
  v_deal    uuid;
  v_n       integer := 0;
begin
  for b in
    select x.* from public.alta_borradores x
    join auth.users u on u.id = x.auth_user_id and u.deleted_at is null and u.email_confirmed_at is not null
    where x.razon_social is not null and x.cif is not null and x.nombre_contacto is not null
      and not exists (select 1 from public.contactos c where c.auth_user_id = x.auth_user_id)
      and not exists (select 1 from public.admins a where a.auth_user_id = x.auth_user_id)
    for update of x
  loop
    select u.email::text into v_email from auth.users u where u.id = b.auth_user_id;
    insert into public.empresas (razon_social, cif, address, city, province, provisional_at)
    values (b.razon_social, b.cif, b.direccion, b.ciudad, b.provincia, coalesce(b.enviada_at, b.updated_at, now()))
    returning id into v_empresa;
    insert into public.contactos (full_name, email, phone, lifecycle, source, auth_user_id, provisional_at)
    values (b.nombre_contacto, v_email, b.telefono, 'new', 'Área cliente', b.auth_user_id, coalesce(b.enviada_at, b.updated_at, now()))
    returning id into v_contact;
    insert into public.contacto_empresa (contact_id, empresa_id, principal) values (v_contact, v_empresa, true);

    insert into public.documentos
      (id, storage_path, mime_type, size_bytes, original_filename, status, empresa_id, folder_id,
       source, aportado_por_contact_id, uploaded_by, visible, created_at, mover_a)
    select a.id, a.storage_path, a.mime_type, a.size_bytes, a.original_filename, 'stored', v_empresa,
           public.carpeta_cliente(v_empresa), 'cliente', v_contact, null, false, a.created_at,
           'cliente/' || v_empresa || '/' || a.id || '/' || regexp_replace(a.storage_path, '^.*/', '')
    from public.alta_documentos a
    where a.auth_user_id = b.auth_user_id and a.destino_path is null;

    if b.servicio is not null and public.servicio_nombre(b.servicio) is not null then
      insert into public.deals (title, contact_id, empresa_id, service, stage, origen)
      values (public.servicio_nombre(b.servicio) || ' — solicitud del área cliente', v_contact, v_empresa, b.servicio, 'nueva_solicitud', 'portal')
      returning id into v_deal;
      if b.mensaje is not null then
        insert into public.notas (body, contact_id, deal_id)
        values ('Mensaje del cliente (alta en el área cliente): ' || b.mensaje, v_contact, v_deal);
      end if;
    end if;

    delete from public.alta_documentos a where a.auth_user_id = b.auth_user_id and a.destino_path is null;
    delete from public.alta_borradores x where x.auth_user_id = b.auth_user_id;
    v_n := v_n + 1;
  end loop;

  -- Documentos de altas ya resueltas en la 3.2 que no se llegaron a mover:
  -- pasan a documentos de su empresa con el mismo destino.
  insert into public.documentos
    (id, storage_path, mime_type, size_bytes, original_filename, status, empresa_id, folder_id,
     source, aportado_por_contact_id, uploaded_by, visible, created_at, mover_a)
  select a.id, a.storage_path, a.mime_type, a.size_bytes, a.original_filename, 'stored', a.empresa_destino,
         public.carpeta_cliente(a.empresa_destino), 'cliente', a.contacto_destino, null, false, a.created_at, a.destino_path
  from public.alta_documentos a
  where a.destino_path is not null and a.empresa_destino is not null;
  delete from public.alta_documentos a where a.destino_path is not null and a.empresa_destino is not null;

  raise notice 'Altas migradas: %', v_n;
end
$b3$;


-- ============================================================
-- 3C (verificación) — Lo esperado: las altas migradas como provisionales
-- (con su cuenta y sus documentos) y, en las tablas de la 3.2, solo lo que
-- 3A marcó como "no se migra".
-- ============================================================
select 'provisional' as tipo, e.razon_social || ' · ' || coalesce(u.email::text, '(sin cuenta)') || ' · ' ||
       (select count(*) from public.documentos d where d.empresa_id = e.id) || ' documentos, ' ||
       (select count(*) from public.documentos d where d.empresa_id = e.id and d.mover_a is not null) || ' por mover' as valor
from public.empresas e
left join public.contactos c on c.id = public.alta_contacto_provisional(e.id)
left join auth.users u on u.id = c.auth_user_id
where e.provisional_at is not null
union all
select 'queda en 3.2', 'borradores: ' || (select count(*) from public.alta_borradores) ||
       ' · documentos: ' || (select count(*) from public.alta_documentos);


-- ============================================================
-- 4A (solo lectura) — Lo que se borrará con las tablas de la 3.2. Lo
-- esperado: 0 y 0 (o solo borradores incompletos que ya viste en 3A).
-- ============================================================
select (select count(*) from public.alta_borradores) as borradores,
       (select count(*) from public.alta_documentos) as documentos;


-- ============================================================
-- 4B (CAMBIO) — Borra lo de la fase 3.2 que ya no se usa: sus funciones y
-- sus dos tablas. portal_huerfanos_cliente se vuelve a crear sin ellas
-- (así los ficheros de borradores incompletos se limpian a las 24 h).
-- Se mantienen alta_cuenta_pendiente, portal_texto, portal_servicios y
-- portal_altas_caducadas, que sigue usando la 3.3. Un único DO: atómico.
-- ============================================================
do $b4$
begin
  if to_regclass('public.alta_borradores') is null then
    raise exception 'Las tablas de la fase 3.2 ya no existen: 4B ya está aplicado. No se ha cambiado nada.';
  end if;
  if exists (select 1 from public.alta_documentos a where a.destino_path is not null) then
    raise exception 'Quedan documentos de altas resueltas sin migrar: ejecuta 3B antes. No se ha cambiado nada.';
  end if;

  create or replace function public.portal_huerfanos_cliente(p_limite integer default 500)
  returns table(nombre text)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select o.name
    from storage.objects o
    where o.bucket_id = 'documentos'
      and (o.name like 'cliente/%' or o.name like 'pendientes/%')
      and o.created_at < now() - interval '24 hours'
      and not exists (select 1 from public.documentos d where d.storage_path = o.name or d.mover_a = o.name)
    order by o.created_at
    limit greatest(coalesce(p_limite, 500), 0)
  $f$;
  revoke all on function public.portal_huerfanos_cliente(integer) from public, anon, authenticated, service_role;
  grant execute on function public.portal_huerfanos_cliente(integer) to service_role;

  drop function public.portal_alta();
  drop function public.portal_alta_guardar(text, text, text, text, text, text, text, text, text);
  drop function public.portal_alta_documentos();
  drop function public.portal_alta_preparar_subida(bigint);
  drop function public.portal_alta_confirmar_subida(uuid, text);
  drop function public.portal_alta_borrar_documento(uuid);
  drop function public.portal_alta_enviar();
  drop function public.admin_alta_resolver(uuid, uuid, uuid);
  drop function public.admin_alta_movimientos(uuid);
  drop function public.admin_alta_registrar_documento(uuid);
  drop function public.admin_alta_rechazar(uuid);

  drop table public.alta_documentos;
  drop table public.alta_borradores;
end
$b4$;


-- ============================================================
-- 4C (verificación) — Lo esperado: una sola fila "tablas 3.2: 0 ·
-- funciones 3.2: 0".
-- ============================================================
select 'tablas 3.2: ' ||
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('alta_borradores', 'alta_documentos')) ||
       ' · funciones 3.2: ' ||
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('portal_alta', 'portal_alta_guardar', 'portal_alta_documentos', 'portal_alta_preparar_subida',
                            'portal_alta_confirmar_subida', 'portal_alta_borrar_documento', 'portal_alta_enviar',
                            'admin_alta_resolver', 'admin_alta_movimientos', 'admin_alta_registrar_documento',
                            'admin_alta_rechazar')) as resultado;
