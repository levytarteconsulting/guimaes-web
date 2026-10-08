-- ============================================================
-- GUIMAES — Paso B: deuda técnica (despliegue sin cortes: expandir y contraer)
--
--   1. deals.contact_id: ON DELETE CASCADE → ON DELETE SET NULL. Borrar un
--      contacto ya no borra los deals de su empresa.
--   2. documentos.contact_id → documentos.aportado_por_contact_id ("quién
--      lo aportó"; el dueño es empresa_id).
--   3. contactos.registered fuera (redundante con auth_user_id).
--   Y admin_borrar_contacto: borrar un contacto en una transacción.
--
-- E (expansión): columna nueva sincronizada con la vieja en los dos
--   sentidos (trigger), nueva FK de deals y las funciones que tocan el
--   "aportado por" ya escriben la columna nueva. El código actual (que lee
--   contact_id) y el nuevo (que lee aportado_por_contact_id) funcionan a la vez.
-- Después de E: desplegar Edge Functions, CRM y portal.
-- K (contracción): comprueba que nada usa ya las columnas viejas, quita la
--   sincronización y borra documentos.contact_id y contactos.registered.
--
-- Cada bloque es un único DO (atómico; se niega a ejecutarse dos veces)
-- seguido de su verificación (solo lectura).
-- ============================================================


-- ============================================================
-- E (CAMBIO + verificación) — Expansión.
-- Lo esperado al final: "documentos desincronizados: 0", "FK
-- deals.contact_id: SET NULL", las 4 funciones con "usa
-- aportado_por_contact_id: sí", "trigger de sincronización: 1" y
-- admin_borrar_contacto "false/true/false".
-- ============================================================
do $e$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'documentos' and column_name = 'aportado_por_contact_id') then
    raise exception 'documentos.aportado_por_contact_id ya existe: E ya está aplicado. No se ha cambiado nada.';
  end if;

  -- 1) Columna nueva, con su FK, rellenada con la vieja. Sin tocar
  --    updated_at ni volver a resolver carpetas en el relleno.
  alter table public.documentos add column aportado_por_contact_id uuid;
  alter table public.documentos add constraint documentos_aportado_por_contact_id_fkey
    foreign key (aportado_por_contact_id) references public.contactos(id) on delete set null;
  alter table public.documentos disable trigger documentos_set_updated_at;
  alter table public.documentos disable trigger documentos_resolver_carpeta;
  update public.documentos set aportado_por_contact_id = contact_id where contact_id is not null;
  alter table public.documentos enable trigger documentos_set_updated_at;
  alter table public.documentos enable trigger documentos_resolver_carpeta;
  create index documentos_aportado_por_idx on public.documentos (aportado_por_contact_id);
  comment on column public.documentos.aportado_por_contact_id is
    'Quién aportó el documento (contacto que lo mandó por WhatsApp o lo subió desde el área cliente). NO es el dueño: el dueño es empresa_id.';

  -- 2) Sincronización en los dos sentidos mientras convivan las dos
  --    columnas. Se llama después de documentos_resolver_carpeta (orden
  --    alfabético de los triggers BEFORE), así que también copia lo que
  --    ese trigger resuelva. Si cambian las dos a la vez, manda la nueva.
  create function public.documentos_sincronizar_aportado()
  returns trigger
  language plpgsql
  set search_path = public
  as $f$
  begin
    if tg_op = 'INSERT' then
      if new.aportado_por_contact_id is null then
        new.aportado_por_contact_id := new.contact_id;
      else
        new.contact_id := new.aportado_por_contact_id;
      end if;
    elsif new.aportado_por_contact_id is distinct from old.aportado_por_contact_id then
      new.contact_id := new.aportado_por_contact_id;
    elsif new.contact_id is distinct from old.contact_id then
      new.aportado_por_contact_id := new.contact_id;
    end if;
    return new;
  end;
  $f$;
  revoke all on function public.documentos_sincronizar_aportado() from public, anon, authenticated, service_role;
  create trigger documentos_sincronizar_aportado
    before insert or update on public.documentos
    for each row execute function public.documentos_sincronizar_aportado();

  -- 3) Las funciones que fijan el "aportado por" escriben ya la columna nueva.
  create or replace function public.documentos_resolver_carpeta()
  returns trigger
  language plpgsql
  set search_path = public
  as $$
  begin
    if tg_op = 'INSERT' and new.source = 'whatsapp' then
      if new.aportado_por_contact_id is null and new.whatsapp_conversation_id is not null then
        select contact_id into new.aportado_por_contact_id
        from public.whatsapp_conversations where id = new.whatsapp_conversation_id;
      end if;
      if new.empresa_id is null and new.aportado_por_contact_id is not null then
        new.empresa_id := public.empresa_principal_de(new.aportado_por_contact_id);
      end if;
    end if;

    if new.empresa_id is null then
      new.folder_id := null;
      return new;
    end if;

  if tg_op = 'UPDATE'
     and new.empresa_id is distinct from old.empresa_id
     and new.folder_id is not distinct from old.folder_id then
    new.folder_id := null;
  end if;
  if new.folder_id is not null then
    if new.source <> 'cliente'
       and exists (select 1 from public.carpetas where id = new.folder_id and system_key = 'cliente') then
      raise exception 'En "Aportados por el cliente" solo puede haber documentos aportados por el cliente';
    end if;
    return new;
  end if;

  if new.source = 'whatsapp' then
    new.folder_id := public.carpeta_whatsapp(new.empresa_id);
    return new;
  end if;

  raise exception 'Un documento de una empresa tiene que estar en una carpeta';
end;
$$;

create or replace function public.vincular_conversacion(p_conversation_id uuid, p_contact_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_empresa uuid;
  v_carpeta uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado';
  end if;

  update public.whatsapp_conversations set contact_id = p_contact_id where id = p_conversation_id;
  if not found then
    raise exception 'Conversación no encontrada: %', p_conversation_id;
  end if;

  if p_contact_id is null then
    update public.documentos set aportado_por_contact_id = null, empresa_id = null
    where whatsapp_conversation_id = p_conversation_id
      and (aportado_por_contact_id is not null or empresa_id is not null);
    return;
  end if;

  update public.documentos set aportado_por_contact_id = p_contact_id
  where whatsapp_conversation_id = p_conversation_id
    and aportado_por_contact_id is distinct from p_contact_id;

  v_empresa := public.empresa_principal_de(p_contact_id);
  if v_empresa is null then
    update public.documentos set empresa_id = null
    where whatsapp_conversation_id = p_conversation_id and empresa_id is not null;
    return;
  end if;

  if not exists (select 1 from public.documentos
                 where whatsapp_conversation_id = p_conversation_id
                   and empresa_id is distinct from v_empresa) then
    return;
  end if;

  v_carpeta := public.carpeta_whatsapp(v_empresa);
  update public.documentos
  set empresa_id = v_empresa, folder_id = v_carpeta
  where whatsapp_conversation_id = p_conversation_id
    and empresa_id is distinct from v_empresa;
end;
$$;

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

  -- 4) deals.contact_id: borrar el contacto deja el deal sin interlocutor.
  alter table public.deals drop constraint deals_contact_id_fkey;
  alter table public.deals add constraint deals_contact_id_fkey
    foreign key (contact_id) references public.contactos(id) on delete set null;

  -- 5) Borrar un contacto desde el CRM, en una transacción: los deals de
  --    empresa se quedan sin interlocutor (FK de arriba); los que no tienen
  --    empresa no serían de nadie y se borran; las notas y tareas de los
  --    deals que se quedan siguen con su deal (notas no tiene UPDATE para
  --    admins: por eso va aquí, como su dueño). El resto de notas del
  --    contacto se van con él (notas.contact_id es ON DELETE CASCADE).
  create or replace function public.admin_borrar_contacto(p_contact_id uuid)
  returns table(deals_conservados integer, deals_borrados integer)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_borrados integer;
    v_quedan   integer;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    perform 1 from public.contactos c where c.id = p_contact_id for update;
    if not found then
      raise exception 'El contacto no existe' using errcode = 'GU010';
    end if;
    delete from public.deals d where d.contact_id = p_contact_id and d.empresa_id is null;
    get diagnostics v_borrados = row_count;
    select count(*) into v_quedan from public.deals d where d.contact_id = p_contact_id;
    update public.notas n set contact_id = null where n.contact_id = p_contact_id and n.deal_id is not null;
    update public.tareas t set contact_id = null where t.contact_id = p_contact_id and t.deal_id is not null;
    delete from public.contactos c where c.id = p_contact_id;
    return query select v_quedan, v_borrados;
  end;
  $f$;
  revoke all on function public.admin_borrar_contacto(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.admin_borrar_contacto(uuid) to authenticated;
end
$e$;

select 'documentos desincronizados (tiene que ser 0)' as que,
       (select count(*) from public.documentos where contact_id is distinct from aportado_por_contact_id)::text as valor
union all
select 'FK deals.contact_id', case confdeltype when 'n' then 'SET NULL' when 'c' then 'CASCADE (mal)' else confdeltype::text end
from pg_constraint where conname = 'deals_contact_id_fkey' and conrelid = 'public.deals'::regclass
union all
select 'función ' || p.proname, 'usa aportado_por_contact_id: ' || case when p.prosrc like '%aportado_por_contact_id%' then 'sí' else 'NO' end
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('documentos_resolver_carpeta', 'vincular_conversacion', 'portal_confirmar_subida', 'admin_provisional_fusionar')
union all
select 'trigger de sincronización', count(*)::text from pg_trigger where tgname = 'documentos_sincronizar_aportado'
union all
select 'admin_borrar_contacto (anon/authenticated/service)',
       has_function_privilege('anon', 'public.admin_borrar_contacto(uuid)', 'execute') || '/' ||
       has_function_privilege('authenticated', 'public.admin_borrar_contacto(uuid)', 'execute') || '/' ||
       has_function_privilege('service_role', 'public.admin_borrar_contacto(uuid)', 'execute')
order by 1;


-- ============================================================
-- K (CAMBIO + verificación) — Contracción. Solo después de desplegar el
-- código nuevo. Antes de cambiar nada comprueba que nada usa ya las
-- columnas viejas (funciones, vistas, políticas, triggers) y que la
-- sincronización está al día; si algo no cuadra, se detiene sin tocar nada.
-- Lo esperado al final: "documentos.contact_id: no existe",
-- "contactos.registered: no existe" y "trigger de sincronización: 0".
-- ============================================================
do $k$
declare
  v_txt text;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'documentos' and column_name = 'contact_id') then
    raise exception 'documentos.contact_id ya no existe: K ya está aplicado. No se ha cambiado nada.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'documentos' and column_name = 'aportado_por_contact_id') then
    raise exception 'Falta la expansión (bloque E). No se ha cambiado nada.';
  end if;

  if exists (select 1 from public.documentos where contact_id is distinct from aportado_por_contact_id) then
    raise exception 'Hay documentos con contact_id y aportado_por_contact_id distintos. No se ha cambiado nada.';
  end if;

  -- Funciones que mencionan documentos y contact_id y no están revisadas.
  -- Las de la lista usan contact_id solo de OTRAS tablas (contactos,
  -- contacto_empresa, deals, notas, whatsapp_conversations…).
  select string_agg(p.proname, ', ') into v_txt
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ~* '\mdocumentos\M' and p.prosrc ~* '\mcontact_id\M'
    and p.proname not in ('documentos_resolver_carpeta', 'vincular_conversacion', 'portal_confirmar_subida',
                          'admin_provisional_fusionar', 'admin_provisional_confirmar', 'alta_borrar_provisional',
                          'documentos_sincronizar_aportado');
  if v_txt is not null then
    raise exception 'Estas funciones pueden usar documentos.contact_id: %. No se ha cambiado nada.', v_txt;
  end if;
  select string_agg(p.proname, ', ') into v_txt
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('documentos_resolver_carpeta', 'vincular_conversacion', 'portal_confirmar_subida', 'admin_provisional_fusionar')
    and p.prosrc not like '%aportado_por_contact_id%';
  if v_txt is not null then
    raise exception 'Estas funciones no están en su versión nueva: %. No se ha cambiado nada.', v_txt;
  end if;
  select string_agg(p.proname, ', ') into v_txt
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ~* '\mregistered\M';
  if v_txt is not null then
    raise exception 'Estas funciones usan contactos.registered: %. No se ha cambiado nada.', v_txt;
  end if;

  -- Vistas, políticas o triggers que dependan de las columnas (los índices y
  -- las FK de la propia columna se van con ella).
  select string_agg(d.classid::regclass::text || ' ' || d.objid, ', ') into v_txt
  from pg_depend d
  join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
  where ((d.refobjid = 'public.documentos'::regclass and a.attname = 'contact_id')
         or (d.refobjid = 'public.contactos'::regclass and a.attname = 'registered'))
    and d.classid not in ('pg_class'::regclass, 'pg_constraint'::regclass, 'pg_attrdef'::regclass);
  if v_txt is not null then
    raise exception 'Hay objetos que dependen de las columnas viejas: %. No se ha cambiado nada.', v_txt;
  end if;

  drop trigger documentos_sincronizar_aportado on public.documentos;
  drop function public.documentos_sincronizar_aportado();
  alter table public.documentos drop column contact_id;
  alter table public.contactos drop column registered;
end
$k$;

select 'documentos.contact_id' as que,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documentos' and column_name = 'contact_id') then 'EXISTE (mal)' else 'no existe' end as valor
union all
select 'contactos.registered',
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contactos' and column_name = 'registered') then 'EXISTE (mal)' else 'no existe' end
union all
select 'documentos.aportado_por_contact_id',
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documentos' and column_name = 'aportado_por_contact_id') then 'existe' else 'NO EXISTE (mal)' end
union all
select 'trigger de sincronización', count(*)::text from pg_trigger where tgname = 'documentos_sincronizar_aportado'
order by 1;
