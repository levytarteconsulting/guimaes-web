-- ============================================================
-- GUIMAES — Área cliente, FASE 3.2: alta autónoma del cliente
--
-- Una cuenta PENDIENTE (registrada, email confirmado, no admin y sin
-- contacto vinculado) rellena un borrador de alta: datos de su empresa y de
-- contacto, documentos (pendientes/{auth_uid}/…, máx. 10 y 50 MB en total)
-- y el servicio que pide. Al enviarlo se avisa al equipo. Desde el CRM se
-- da de alta (crea empresa y contacto), se vincula a lo existente o se
-- rechaza (borra cuenta, borrador y ficheros).
--
-- Mismo principio que las fases anteriores: el cliente NO tiene políticas
-- RLS; todo por RPC SECURITY DEFINER (search_path fijo, sin parámetro de
-- uid, columnas explícitas, EXECUTE solo para quien toca) y Edge Functions
-- (portal-alta para el cliente; portal-cuentas para el CRM; portal-limpieza
-- para huérfanos y caducidad). Nada revela si un CIF o un email ya existen.
--
-- Errores (además de los de fases anteriores):
--   GU006 'Confirma tu email antes de continuar.'
--   GU003 límites de documentos (10 / 50 MB)
--
-- Bloques, cada uno por separado en el editor: 1A, 1B, 1C, 2A, 2B, 2C.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado: ninguna fila.
-- ============================================================
select c.relname as ya_existe
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('alta_borradores', 'alta_documentos');


-- ============================================================
-- 1B (CAMBIO) — Tablas del borrador de alta. Un único DO: atómico.
-- Solo lectura para admins (RLS is_admin()); nadie escribe por la API.
-- on delete cascade desde auth.users: borrar la cuenta borra su borrador.
-- ============================================================
do $b1$
begin
  if to_regclass('public.alta_borradores') is not null then
    raise exception 'alta_borradores ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;

  create table public.alta_borradores (
    auth_user_id     uuid primary key references auth.users(id) on delete cascade,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    razon_social     text,
    cif              text,
    direccion        text,
    ciudad           text,
    provincia        text,
    nombre_contacto  text,
    telefono         text,
    servicio         text,
    mensaje          text,
    estado           text not null default 'borrador' check (estado in ('borrador', 'enviada')),
    enviada_at       timestamptz
  );
  alter table public.alta_borradores enable row level security;
  create policy "admins leen alta_borradores" on public.alta_borradores
    for select to authenticated using ((select public.is_admin()));
  create trigger alta_borradores_set_updated_at before update on public.alta_borradores
    for each row execute function public.set_updated_at();

  -- Documentos del alta. Al dar de alta, destino_path / empresa_destino /
  -- contacto_destino se rellenan en la misma transacción; el fichero se
  -- mueve después (portal-cuentas) y solo entonces se crea la fila en
  -- documentos y se borra esta. Si el movimiento falla, queda aquí para
  -- reintentarlo.
  create table public.alta_documentos (
    id                uuid primary key,
    created_at        timestamptz not null default now(),
    auth_user_id      uuid not null references auth.users(id) on delete cascade,
    storage_path      text not null unique,
    original_filename text not null,
    mime_type         text not null,
    size_bytes        bigint not null,
    empresa_destino   uuid references public.empresas(id) on delete set null,
    contacto_destino  uuid references public.contactos(id) on delete set null,
    destino_path      text unique
  );
  create index alta_documentos_cuenta_idx on public.alta_documentos (auth_user_id);
  alter table public.alta_documentos enable row level security;
  create policy "admins leen alta_documentos" on public.alta_documentos
    for select to authenticated using ((select public.is_admin()));
end
$b1$;


-- ============================================================
-- 1C (verificación) — Lo esperado: 2 filas, rls=true y una sola política
-- SELECT con is_admin().
-- ============================================================
select c.relname as tabla,
       'rls=' || c.relrowsecurity || ' · políticas: ' ||
       coalesce((select string_agg(p.cmd || ' ' || p.qual, '; ') from pg_policies p
                 where p.schemaname = 'public' and p.tablename = c.relname), 'ninguna') as valor
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('alta_borradores', 'alta_documentos')
order by 1;


-- ============================================================
-- 2A (solo lectura) — Lo esperado: portal_servicios y
-- portal_huerfanos_cliente (existen y se sustituyen); ninguna más.
-- ============================================================
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('alta_cuenta_pendiente', 'portal_texto', 'portal_servicios', 'portal_alta', 'portal_alta_guardar',
                    'portal_alta_documentos', 'portal_alta_preparar_subida', 'portal_alta_confirmar_subida',
                    'portal_alta_borrar_documento', 'portal_alta_enviar', 'admin_alta_resolver', 'admin_alta_movimientos',
                    'admin_alta_registrar_documento', 'admin_alta_rechazar', 'portal_altas_caducadas', 'portal_huerfanos_cliente')
order by 1;


-- ============================================================
-- 2B (CAMBIO) — Funciones. Un único DO. Re-ejecutable.
-- ============================================================
do $b2$
begin
  -- ===================== internas (sin EXECUTE para nadie) =====================

  -- La cuenta de quien llama, si es una cuenta PENDIENTE válida para el
  -- alta: sesión, email confirmado, no admin, sin contacto vinculado.
  create or replace function public.alta_cuenta_pendiente()
  returns uuid
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null
       or exists (select 1 from public.admins a where a.auth_user_id = v_uid)
       or exists (select 1 from public.contactos c where c.auth_user_id = v_uid)
       or not exists (select 1 from auth.users u where u.id = v_uid and u.deleted_at is null) then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    if not exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null) then
      raise exception 'Confirma tu email antes de continuar.' using errcode = 'GU006';
    end if;
    return v_uid;
  end;
  $f$;
  revoke all on function public.alta_cuenta_pendiente() from public, anon, authenticated, service_role;

  -- Texto de un campo: NFC, sin caracteres de control ni saltos de línea,
  -- espacios colapsados; vacío = NULL; error GU005 si pasa de p_max.
  create or replace function public.portal_texto(p text, p_max integer, p_campo text)
  returns text
  language plpgsql
  immutable
  set search_path = public, pg_temp
  as $f$
  declare
    v text;
  begin
    v := nullif(btrim(regexp_replace(regexp_replace(normalize(coalesce(p, ''), NFC), '[\x01-\x1f\x7f]', ' ', 'g'), '\s+', ' ', 'g')), '');
    if length(v) > p_max then
      raise exception '% no puede tener más de % caracteres.', p_campo, p_max using errcode = 'GU005';
    end if;
    return v;
  end;
  $f$;
  revoke all on function public.portal_texto(text, integer, text) from public, anon, authenticated, service_role;

  -- ===================== cuenta pendiente (EXECUTE authenticated) =====================

  -- Catálogo: ahora también para cuentas pendientes (lo necesita el alta).
  create or replace function public.portal_servicios()
  returns table(codigo text, nombre text)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not exists (select 1 from public.mis_empresas()) then
      perform public.alta_cuenta_pendiente();
    end if;
    return query
    select c.codigo, public.servicio_nombre(c.codigo)
    from unnest(array['s1', 's2', 's3', 's4', 's5', 's6', 's7']) with ordinality as c(codigo, n)
    where public.servicio_nombre(c.codigo) is not null
    order by c.n;
  end;
  $f$;

  create or replace function public.portal_alta()
  returns table(razon_social text, cif text, direccion text, ciudad text, provincia text,
                nombre_contacto text, telefono text, servicio text, mensaje text, estado text, enviada_at timestamptz)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid := public.alta_cuenta_pendiente();
  begin
    return query
    select b.razon_social, b.cif, b.direccion, b.ciudad, b.provincia, b.nombre_contacto, b.telefono, b.servicio, b.mensaje, b.estado, b.enviada_at
    from public.alta_borradores b where b.auth_user_id = v_uid;
  end;
  $f$;

  -- Guarda el borrador (todos los campos a la vez; se puede guardar a
  -- medias). Se puede editar después de enviarlo mientras siga pendiente.
  create or replace function public.portal_alta_guardar(
    p_razon_social text, p_cif text, p_direccion text, p_ciudad text, p_provincia text,
    p_nombre_contacto text, p_telefono text, p_servicio text, p_mensaje text)
  returns table(razon_social text, cif text, direccion text, ciudad text, provincia text,
                nombre_contacto text, telefono text, servicio text, mensaje text, estado text, enviada_at timestamptz)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid  uuid := public.alta_cuenta_pendiente();
    v_rs   text := public.portal_texto(p_razon_social, 200, 'La razón social');
    v_cif  text := nullif(upper(regexp_replace(coalesce(p_cif, ''), '[\s.\-]', '', 'g')), '');
    v_dir  text := public.portal_texto(p_direccion, 200, 'La dirección');
    v_ci   text := public.portal_texto(p_ciudad, 100, 'La ciudad');
    v_pr   text := public.portal_texto(p_provincia, 100, 'La provincia');
    v_nom  text := public.portal_texto(p_nombre_contacto, 120, 'El nombre');
    v_tel  text := public.portal_texto(p_telefono, 20, 'El teléfono');
    v_ser  text := nullif(btrim(coalesce(p_servicio, '')), '');
    v_msg  text := nullif(btrim(regexp_replace(normalize(coalesce(p_mensaje, ''), NFC), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g')), '');
  begin
    if v_rs is not null and length(v_rs) < 2 then
      raise exception 'La razón social tiene que tener al menos 2 caracteres.' using errcode = 'GU005';
    end if;
    if v_cif is not null and v_cif !~ '^[A-Z0-9]{9}$' then
      raise exception 'El CIF o NIF tiene que tener 9 letras o números (por ejemplo, B12345678).' using errcode = 'GU005';
    end if;
    if v_tel is not null and v_tel !~ '^[0-9+() .-]{6,20}$' then
      raise exception 'Escribe un teléfono válido (solo números, espacios y +).' using errcode = 'GU005';
    end if;
    if v_ser is not null and public.servicio_nombre(v_ser) is null then
      raise exception 'Elige un servicio de la lista.' using errcode = 'GU005';
    end if;
    if length(v_msg) > 1000 then
      raise exception 'El mensaje no puede tener más de 1000 caracteres.' using errcode = 'GU005';
    end if;

    insert into public.alta_borradores as b (auth_user_id, razon_social, cif, direccion, ciudad, provincia, nombre_contacto, telefono, servicio, mensaje)
    values (v_uid, v_rs, v_cif, v_dir, v_ci, v_pr, v_nom, v_tel, v_ser, v_msg)
    on conflict (auth_user_id) do update
      set razon_social = excluded.razon_social, cif = excluded.cif, direccion = excluded.direccion, ciudad = excluded.ciudad,
          provincia = excluded.provincia, nombre_contacto = excluded.nombre_contacto, telefono = excluded.telefono,
          servicio = excluded.servicio, mensaje = excluded.mensaje;

    return query select * from public.portal_alta();
  end;
  $f$;

  create or replace function public.portal_alta_documentos()
  returns table(documento_id uuid, nombre text, tipo_mime text, tamano_bytes bigint, fecha timestamptz)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid := public.alta_cuenta_pendiente();
  begin
    return query
    select d.id, d.original_filename, d.mime_type, d.size_bytes, d.created_at
    from public.alta_documentos d
    where d.auth_user_id = v_uid and d.destino_path is null
    order by d.created_at;
  end;
  $f$;

  -- Límites (10 ficheros, 50 MB) contando lo que ya está en Storage bajo
  -- pendientes/{uid}/, confirmado o no: pedir muchas URLs a la vez no los
  -- salta, porque la confirmación vuelve a contar.
  create or replace function public.portal_alta_preparar_subida(p_tamano bigint)
  returns table(documentos_restantes integer, bytes_restantes bigint)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid := public.alta_cuenta_pendiente();
    v_n integer; v_bytes bigint;
  begin
    select count(*), coalesce(sum(nullif(o.metadata ->> 'size', '')::bigint), 0) into v_n, v_bytes
    from storage.objects o
    where o.bucket_id = 'documentos' and left(o.name, length('pendientes/' || v_uid || '/')) = 'pendientes/' || v_uid || '/';
    if v_n >= 10 then
      raise exception 'Has alcanzado el máximo de 10 documentos. Quita alguno para subir otro.' using errcode = 'GU003';
    end if;
    if v_bytes + greatest(coalesce(p_tamano, 0), 0) > 52428800 then
      raise exception 'Superarías el máximo de 50 MB en total. Quita algún documento o sube uno más pequeño.' using errcode = 'GU003';
    end if;
    return query select 10 - v_n, 52428800 - v_bytes;
  end;
  $f$;

  -- Igual que portal_confirmar_subida, en pendientes/{uid}/{documento}/…
  create or replace function public.portal_alta_confirmar_subida(p_documento_id uuid, p_nombre text)
  returns table(documento_id uuid, nombre text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid     uuid := public.alta_cuenta_pendiente();
    v_prefijo text;
    v_n       integer;
    v_objeto  storage.objects%rowtype;
    v_nombre  text;
    v_ext     text;
    v_ext_obj text;
    v_tamano  bigint;
    v_mime    text;
  begin
    if p_documento_id is null then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    v_prefijo := 'pendientes/' || v_uid || '/' || p_documento_id || '/';
    if exists (select 1 from public.alta_documentos d where d.id = p_documento_id or left(d.storage_path, length(v_prefijo)) = v_prefijo)
       or exists (select 1 from public.documentos d where d.id = p_documento_id) then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    select count(*) into v_n from storage.objects o
    where o.bucket_id = 'documentos' and left(o.name, length(v_prefijo)) = v_prefijo;
    if v_n = 0 then raise exception 'Fichero no válido: no se ha recibido el fichero' using errcode = 'GU002'; end if;
    if v_n > 1 then raise exception 'Fichero no válido: hay más de un fichero para este documento' using errcode = 'GU002'; end if;
    select * into v_objeto from storage.objects o
    where o.bucket_id = 'documentos' and left(o.name, length(v_prefijo)) = v_prefijo;

    v_tamano := nullif(v_objeto.metadata ->> 'size', '')::bigint;
    if v_tamano is null or v_tamano < 1 or v_tamano > 15728640 then
      raise exception 'Fichero no válido: el tamaño tiene que estar entre 1 byte y 15 MB' using errcode = 'GU002';
    end if;
    if (select count(*) from public.alta_documentos d where d.auth_user_id = v_uid) >= 10 then
      raise exception 'Fichero no válido: has alcanzado el máximo de 10 documentos' using errcode = 'GU002';
    end if;
    if (select coalesce(sum(d.size_bytes), 0) from public.alta_documentos d where d.auth_user_id = v_uid) + v_tamano > 52428800 then
      raise exception 'Fichero no válido: superarías el máximo de 50 MB en total' using errcode = 'GU002';
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

    begin
      insert into public.alta_documentos (id, auth_user_id, storage_path, original_filename, mime_type, size_bytes)
      values (p_documento_id, v_uid, v_objeto.name, v_nombre, v_mime, v_tamano);
    exception when unique_violation then
      raise exception 'No disponible' using errcode = 'GU001';
    end;
    return query select p_documento_id, v_nombre;
  end;
  $f$;

  -- Quita un documento del borrador. Devuelve su ruta para que portal-alta
  -- borre el fichero (si no pudiera, lo recoge portal-limpieza).
  create or replace function public.portal_alta_borrar_documento(p_documento_id uuid)
  returns table(storage_path text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid := public.alta_cuenta_pendiente();
    v_ruta text;
  begin
    delete from public.alta_documentos d
    where d.id = p_documento_id and d.auth_user_id = v_uid and d.destino_path is null
    returning d.storage_path into v_ruta;
    if v_ruta is null then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    return query select v_ruta;
  end;
  $f$;

  -- Enviar la solicitud: exige razón social, CIF, nombre y servicio.
  -- 'primera' = es el primer envío (portal-alta solo avisa al equipo
  -- entonces; reenviar tras editar no vuelve a avisar).
  create or replace function public.portal_alta_enviar()
  returns table(primera boolean, razon_social text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid  uuid := public.alta_cuenta_pendiente();
    v_b    public.alta_borradores%rowtype;
    v_falta text[] := '{}';
  begin
    select * into v_b from public.alta_borradores b where b.auth_user_id = v_uid for update;
    if not found then
      raise exception 'Rellena primero los datos de tu empresa.' using errcode = 'GU005';
    end if;
    if v_b.razon_social is null then v_falta := v_falta || 'la razón social'::text; end if;
    if v_b.cif is null then v_falta := v_falta || 'el CIF'::text; end if;
    if v_b.nombre_contacto is null then v_falta := v_falta || 'tu nombre'::text; end if;
    if v_b.servicio is null then v_falta := v_falta || 'el servicio que te interesa'::text; end if;
    if cardinality(v_falta) > 0 then
      raise exception 'Falta %.', array_to_string(v_falta, ', ') using errcode = 'GU005';
    end if;
    update public.alta_borradores b set estado = 'enviada', enviada_at = coalesce(b.enviada_at, now())
    where b.auth_user_id = v_uid;
    return query select v_b.enviada_at is null, v_b.razon_social;
  end;
  $f$;

  -- ===================== CRM (EXECUTE authenticated; exigen is_admin()) =====================

  -- Dar de alta (p_empresa_id y p_contact_id nulos: se crean con los datos
  -- enviados) o vincular a lo existente (los datos enviados no se escriben
  -- en la ficha). En una transacción: empresa, contacto, vínculo de la
  -- cuenta, destino de los documentos, deal del servicio pedido (origen
  -- 'portal') y borrado del borrador. Los ficheros los mueve después
  -- portal-cuentas (admin_alta_movimientos / admin_alta_registrar_documento).
  create or replace function public.admin_alta_resolver(p_auth_user_id uuid, p_empresa_id uuid, p_contact_id uuid)
  returns table(empresa_id uuid, contact_id uuid, documentos_pendientes integer)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_email   text;
    v_conf    timestamptz;
    v_b       public.alta_borradores%rowtype;
    v_empresa uuid := p_empresa_id;
    v_contact uuid := p_contact_id;
    v_c       public.contactos%rowtype;
    v_deal    uuid;
    v_n       integer;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select u.email::text, u.email_confirmed_at into v_email, v_conf
    from auth.users u where u.id = p_auth_user_id and u.deleted_at is null;
    if not found then raise exception 'La cuenta no existe' using errcode = 'GU010'; end if;
    if v_conf is null then raise exception 'La cuenta todavía no ha confirmado su email' using errcode = 'GU010'; end if;
    if exists (select 1 from public.admins a where a.auth_user_id = p_auth_user_id) then
      raise exception 'La cuenta es de un administrador' using errcode = 'GU010';
    end if;
    if exists (select 1 from public.contactos c where c.auth_user_id = p_auth_user_id) then
      raise exception 'La cuenta ya está vinculada a un contacto' using errcode = 'GU010';
    end if;
    select * into v_b from public.alta_borradores b where b.auth_user_id = p_auth_user_id for update;

    -- Empresa
    if v_empresa is null then
      if v_b.razon_social is null then
        raise exception 'Falta la razón social para crear la empresa: elige una existente' using errcode = 'GU010';
      end if;
      begin
        insert into public.empresas (razon_social, cif, address, city, province)
        values (v_b.razon_social, v_b.cif, v_b.direccion, v_b.ciudad, v_b.provincia)
        returning id into v_empresa;
      exception when unique_violation then
        raise exception 'Ya hay una empresa con el CIF %: usa «Vincular a existente»', v_b.cif using errcode = 'GU010';
      end;
    elsif not exists (select 1 from public.empresas e where e.id = v_empresa) then
      raise exception 'La empresa no existe' using errcode = 'GU010';
    end if;

    -- Contacto
    if v_contact is null then
      insert into public.contactos (full_name, email, phone, lifecycle, source, auth_user_id)
      values (coalesce(v_b.nombre_contacto, v_email), v_email, v_b.telefono, 'new', 'Área cliente', p_auth_user_id)
      returning id into v_contact;
      insert into public.contacto_empresa (contact_id, empresa_id, principal) values (v_contact, v_empresa, true);
    else
      select * into v_c from public.contactos c where c.id = v_contact for update;
      if not found then raise exception 'El contacto no existe' using errcode = 'GU010'; end if;
      if v_c.auth_user_id is not null then raise exception 'El contacto ya tiene una cuenta vinculada' using errcode = 'GU010'; end if;
      if not exists (select 1 from public.contacto_empresa ce where ce.contact_id = v_contact and ce.empresa_id = v_empresa) then
        insert into public.contacto_empresa (contact_id, empresa_id, principal)
        values (v_contact, v_empresa, not exists (select 1 from public.contacto_empresa ce where ce.contact_id = v_contact and ce.principal));
      end if;
      begin
        update public.contactos set auth_user_id = p_auth_user_id where id = v_contact;
      exception when unique_violation then
        raise exception 'La cuenta ya está vinculada a un contacto' using errcode = 'GU010';
      end;
    end if;

    -- Documentos: destino fijado aquí; el fichero se mueve después.
    update public.alta_documentos d
    set empresa_destino = v_empresa, contacto_destino = v_contact,
        destino_path = 'cliente/' || v_empresa || '/' || d.id || '/' || regexp_replace(d.storage_path, '^.*/', '')
    where d.auth_user_id = p_auth_user_id and d.destino_path is null;
    get diagnostics v_n = row_count;

    -- Servicio pedido → deal en la primera etapa, origen 'portal'.
    if v_b.servicio is not null and public.servicio_nombre(v_b.servicio) is not null then
      insert into public.deals (title, contact_id, empresa_id, service, stage, origen)
      values (public.servicio_nombre(v_b.servicio) || ' — solicitud del área cliente', v_contact, v_empresa, v_b.servicio, 'nueva_solicitud', 'portal')
      returning id into v_deal;
      if v_b.mensaje is not null then
        insert into public.notas (body, contact_id, deal_id)
        values ('Mensaje del cliente (alta en el área cliente): ' || v_b.mensaje, v_contact, v_deal);
      end if;
    end if;

    delete from public.alta_borradores b where b.auth_user_id = p_auth_user_id;
    return query select v_empresa, v_contact, v_n;
  end;
  $f$;

  -- Documentos de un alta ya resuelta pendientes de mover.
  create or replace function public.admin_alta_movimientos(p_auth_user_id uuid)
  returns table(documento_id uuid, origen text, destino text)
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
    select d.id, d.storage_path, d.destino_path
    from public.alta_documentos d
    where d.auth_user_id = p_auth_user_id and d.destino_path is not null
    order by d.created_at;
  end;
  $f$;

  -- Tras mover el fichero: comprueba que está en su destino y crea la fila
  -- en documentos ("Aportados por el cliente" de la empresa). Idempotente.
  create or replace function public.admin_alta_registrar_documento(p_documento_id uuid)
  returns table(documento_id uuid)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_d public.alta_documentos%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select * into v_d from public.alta_documentos d where d.id = p_documento_id and d.destino_path is not null for update;
    if not found then
      raise exception 'Ese documento no está pendiente de mover' using errcode = 'GU010';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'documentos' and o.name = v_d.destino_path) then
      raise exception 'El fichero todavía no está en su sitio' using errcode = 'GU010';
    end if;
    if not exists (select 1 from public.documentos x where x.id = v_d.id) then
      insert into public.documentos (id, storage_path, mime_type, size_bytes, original_filename, status,
                                     empresa_id, folder_id, source, contact_id, uploaded_by, visible)
      values (v_d.id, v_d.destino_path, v_d.mime_type, v_d.size_bytes, v_d.original_filename, 'stored',
              v_d.empresa_destino, public.carpeta_cliente(v_d.empresa_destino), 'cliente', v_d.contacto_destino, null, false);
    end if;
    delete from public.alta_documentos d where d.id = v_d.id;
    return query select v_d.id;
  end;
  $f$;

  -- Rechazar: borra borrador y documentos del alta y devuelve las rutas de
  -- los ficheros; portal-cuentas los borra con la API de Storage y elimina
  -- la cuenta. Nunca un admin ni una cuenta vinculada.
  create or replace function public.admin_alta_rechazar(p_auth_user_id uuid)
  returns table(storage_path text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_rutas text[];
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    if exists (select 1 from public.admins a where a.auth_user_id = p_auth_user_id)
       or exists (select 1 from public.contactos c where c.auth_user_id = p_auth_user_id) then
      raise exception 'Esta cuenta no se puede rechazar: es de un administrador o está vinculada a un contacto' using errcode = 'GU010';
    end if;
    select coalesce(array_agg(d.storage_path), '{}') into v_rutas from public.alta_documentos d where d.auth_user_id = p_auth_user_id;
    delete from public.alta_documentos d where d.auth_user_id = p_auth_user_id;
    delete from public.alta_borradores b where b.auth_user_id = p_auth_user_id;
    return query select unnest(v_rutas);
  end;
  $f$;

  -- ===================== limpieza (EXECUTE solo service_role) =====================

  -- Huérfanos: cliente/ (como antes) y pendientes/ sin fila de alta, con
  -- más de 24 h.
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
      and not exists (select 1 from public.documentos d where d.storage_path = o.name)
      and not exists (select 1 from public.alta_documentos a where a.storage_path = o.name or a.destino_path = o.name)
    order by o.created_at
    limit greatest(coalesce(p_limite, 500), 0)
  $f$;

  -- Altas caducadas: cuentas sin vincular, que no son admin, creadas hace
  -- más de p_dias. Con las rutas de sus ficheros (portal-limpieza los borra
  -- y después elimina la cuenta; el borrador cae en cascada).
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
    order by u.created_at
    limit greatest(coalesce(p_limite, 100), 0)
  $f$;

  -- ===================== permisos =====================
  revoke all on function public.portal_servicios()                    from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta()                         from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta_guardar(text, text, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta_documentos()              from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta_preparar_subida(bigint)   from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta_confirmar_subida(uuid, text) from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta_borrar_documento(uuid)    from public, anon, authenticated, service_role;
  revoke all on function public.portal_alta_enviar()                  from public, anon, authenticated, service_role;
  revoke all on function public.admin_alta_resolver(uuid, uuid, uuid) from public, anon, authenticated, service_role;
  revoke all on function public.admin_alta_movimientos(uuid)          from public, anon, authenticated, service_role;
  revoke all on function public.admin_alta_registrar_documento(uuid)  from public, anon, authenticated, service_role;
  revoke all on function public.admin_alta_rechazar(uuid)             from public, anon, authenticated, service_role;
  revoke all on function public.portal_huerfanos_cliente(integer)     from public, anon, authenticated, service_role;
  revoke all on function public.portal_altas_caducadas(integer, integer) from public, anon, authenticated, service_role;

  grant execute on function public.portal_servicios()                    to authenticated;
  grant execute on function public.portal_alta()                         to authenticated;
  grant execute on function public.portal_alta_guardar(text, text, text, text, text, text, text, text, text) to authenticated;
  grant execute on function public.portal_alta_documentos()              to authenticated;
  grant execute on function public.portal_alta_preparar_subida(bigint)   to authenticated;
  grant execute on function public.portal_alta_confirmar_subida(uuid, text) to authenticated;
  grant execute on function public.portal_alta_borrar_documento(uuid)    to authenticated;
  grant execute on function public.portal_alta_enviar()                  to authenticated;
  grant execute on function public.admin_alta_resolver(uuid, uuid, uuid) to authenticated;
  grant execute on function public.admin_alta_movimientos(uuid)          to authenticated;
  grant execute on function public.admin_alta_registrar_documento(uuid)  to authenticated;
  grant execute on function public.admin_alta_rechazar(uuid)             to authenticated;
  grant execute on function public.portal_huerfanos_cliente(integer)     to service_role;
  grant execute on function public.portal_altas_caducadas(integer, integer) to service_role;
end
$b2$;


-- ============================================================
-- 2C (verificación) — Lo esperado (16 filas):
--   - alta_cuenta_pendiente y portal_texto: false/false/false
--   - portal_huerfanos_cliente y portal_altas_caducadas: false/false/true
--   - el resto: false/true/false
--   - todas con search_path=public, pg_temp; todas definer salvo portal_texto
-- ============================================================
select p.proname as funcion,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, '; ') as config,
       has_function_privilege('anon', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_authenticated_service
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('alta_cuenta_pendiente', 'portal_texto', 'portal_servicios', 'portal_alta', 'portal_alta_guardar',
                    'portal_alta_documentos', 'portal_alta_preparar_subida', 'portal_alta_confirmar_subida',
                    'portal_alta_borrar_documento', 'portal_alta_enviar', 'admin_alta_resolver', 'admin_alta_movimientos',
                    'admin_alta_registrar_documento', 'admin_alta_rechazar', 'portal_altas_caducadas', 'portal_huerfanos_cliente')
order by 4, 1;
