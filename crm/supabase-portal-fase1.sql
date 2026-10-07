-- ============================================================
-- GUIMAES — Área cliente, FASE 1: backend
--
-- Principio: el cliente NO tiene ninguna política RLS sobre tablas ni
-- Storage. Tablas y Storage siguen siendo solo is_admin(). Todo lo que hace
-- el cliente pasa por las RPC SECURITY DEFINER de este fichero (que corren
-- como su dueño y filtran por auth.uid()) y por las Edge Functions
-- portal-descargar, portal-subir, portal-cuentas y portal-limpieza.
--
-- Identidad: cuenta de Auth → contactos.auth_user_id (único, fase 0) →
-- contacto_empresa → empresas. El cliente es la EMPRESA: ve todo lo de sus
-- empresas aunque lo gestione otro contacto. Una cuenta con fila en
-- public.admins (activa o no) nunca es cliente.
--
-- Orden de ejecución, cada bloque por separado (una sola sentencia cada
-- uno: el editor solo enseña la última y el pooler puede repartirlas):
--   1A, 1B, 1C  documentos y carpetas (compartido, carpeta "Aportados por
--               el cliente", source 'cliente')
--   2A, 2B, 2C  funciones del portal y de gestión de cuentas
--   — secret PORTAL_LIMPIEZA_HOOK_SECRET + el mismo valor en Vault, y
--     desplegar las Edge Functions —
--   3A, 3B, 3C  cron de limpieza de subidas sin confirmar
--
-- Las definiciones de 1B son las mismas que quedan en
-- crm/supabase-documentos.sql y crm/supabase-carpetas.sql (fuente para una
-- instalación nueva); este fichero es la migración de una base existente.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Antes de 1B. Lo esperado: valor 0 en todas las filas.
-- ============================================================
select 'carpetas que ya se llaman "Aportados por el cliente"' as comprobacion,
       count(*) as valor,
       string_agg(c.id::text || ' (empresa ' || c.empresa_id || ')', ', ') as detalle
from public.carpetas c
where lower(btrim(c.nombre)) = 'aportados por el cliente'
union all
select 'carpetas con system_key distinto de whatsapp', count(*),
       string_agg(distinct c.system_key, ', ')
from public.carpetas c
where c.system_key is not null and c.system_key <> 'whatsapp'
union all
select 'documentos con source distinto de manual/whatsapp', count(*),
       string_agg(distinct d.source, ', ')
from public.documentos d
where d.source not in ('manual', 'whatsapp')
union all
select 'documentos con visible = true (quedarán sin shared_at)', count(*), null
from public.documentos d
where d.visible
union all
select 'columnas shared_at/shared_by ya existentes', count(*),
       string_agg(column_name::text, ', ')
from information_schema.columns
where table_schema = 'public' and table_name = 'documentos' and column_name in ('shared_at', 'shared_by')
union all
select 'funciones de fase 1 ya existentes', count(*),
       string_agg(p.proname, ', ')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('carpeta_cliente', 'documentos_registrar_compartido', 'mis_empresas',
                    'servicio_nombre', 'portal_estado', 'portal_empresas', 'portal_deals',
                    'portal_carpetas', 'portal_documentos', 'portal_preparar_descarga',
                    'portal_preparar_subida', 'portal_confirmar_subida',
                    'admin_cuentas_pendientes', 'admin_vincular_cuenta', 'admin_desvincular_cuenta',
                    'portal_huerfanos_cliente', 'portal_lanzar_limpieza');


-- ============================================================
-- 1B (CAMBIO) — documentos y carpetas. Un único DO: atómico.
--
-- documentos:
--   - source 'cliente': subidas desde el portal.
--   - shared_at / shared_by: cuándo y qué admin lo compartió con el cliente
--     (visible pasa a true). shared_by → admins(id), como uploaded_by. Lo
--     rellena un trigger con auth.uid(); con la clave de servicio queda
--     shared_by NULL. Se limpian al dejar de compartir, y no se pueden
--     tocar a mano mientras visible no cambie.
-- carpetas:
--   - system_key 'cliente', "Aportados por el cliente": raíz, orden 90,
--     sin subcarpetas (admite_subcarpetas es false para las de sistema),
--     nombre reservado, NO se puede renombrar (a diferencia de WhatsApp).
--     Se puede borrar solo vacía; carpeta_cliente() la recrea en la
--     siguiente subida.
--   - En ella solo puede haber documentos source = 'cliente' (lo exige el
--     trigger documentos_resolver_carpeta: cubre la subida manual del CRM
--     y mover_documentos).
--   - borrar_carpeta: ninguna carpeta de sistema con documentos se borra
--     (antes solo WhatsApp). mover_carpeta: ninguna de sistema admite
--     subcarpetas (antes solo WhatsApp tenía mensaje claro).
--   - Se siembra en todas las empresas existentes y en las nuevas.
-- ============================================================
do $b1$
declare
  v_choques text;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'documentos' and column_name = 'shared_at') then
    raise exception 'documentos.shared_at ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;
  select string_agg(id::text, ', ') into v_choques
  from public.carpetas where lower(btrim(nombre)) = 'aportados por el cliente';
  if v_choques is not null then
    raise exception 'Ya hay carpetas llamadas "Aportados por el cliente" (%): renómbralas antes. No se ha cambiado nada.', v_choques;
  end if;

  -- ---------- documentos ----------
  alter table public.documentos drop constraint if exists documentos_source_check;
  alter table public.documentos add constraint documentos_source_check
    check (source in ('manual', 'whatsapp', 'cliente'));

  alter table public.documentos add column shared_at timestamptz;
  alter table public.documentos add column shared_by uuid references public.admins(id) on delete set null;

  create function public.documentos_registrar_compartido()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if tg_op = 'UPDATE' and new.visible is not distinct from old.visible then
      new.shared_at := old.shared_at;
      new.shared_by := old.shared_by;
    elsif new.visible then
      new.shared_at := now();
      new.shared_by := (select a.id from public.admins a where a.auth_user_id = auth.uid());
    else
      new.shared_at := null;
      new.shared_by := null;
    end if;
    return new;
  end;
  $f$;
  revoke all on function public.documentos_registrar_compartido() from public, anon, authenticated, service_role;

  create trigger documentos_registrar_compartido
    before insert or update on public.documentos
    for each row execute function public.documentos_registrar_compartido();

  -- ---------- carpetas: restricciones ----------
  alter table public.carpetas drop constraint if exists carpetas_system_key_check;
  alter table public.carpetas add constraint carpetas_system_key_check
    check (system_key in ('whatsapp', 'cliente'));

  alter table public.carpetas drop constraint if exists carpetas_cliente_reservado_check;
  alter table public.carpetas add constraint carpetas_cliente_reservado_check
    check ((system_key is not distinct from 'cliente') = (lower(btrim(nombre)) = 'aportados por el cliente'));

  -- ---------- carpetas: funciones ----------
  -- Carpeta "Aportados por el cliente" de la empresa, creándola si no
  -- existe (mismo patrón y misma concurrencia que carpeta_whatsapp).
  -- La usan sembrar_carpetas_por_defecto (desde el trigger de empresas,
  -- con el rol de quien crea la empresa: el CRM es authenticated) y
  -- portal_confirmar_subida (definer, corre como su dueño).
  -- SECURITY INVOKER con EXECUTE para authenticated y service_role: sin él,
  -- ni un admin desde el CRM ni código de servidor con la clave de servicio
  -- podrían crear empresas (el trigger de siembra corre con su rol).
  -- Llamada por un cliente, la RLS de carpetas (solo is_admin()) le impide
  -- crear o ver nada.
  create function public.carpeta_cliente(p_empresa_id uuid)
  returns uuid
  language plpgsql
  set search_path = public, pg_temp
  as $f$
  declare
    v_id uuid;
  begin
    insert into public.carpetas (empresa_id, nombre, system_key, orden)
    values (p_empresa_id, 'Aportados por el cliente', 'cliente', 90)
    on conflict (empresa_id, system_key) where system_key is not null do nothing
    returning id into v_id;

    if v_id is null then
      select id into v_id from public.carpetas
      where empresa_id = p_empresa_id and system_key = 'cliente';
    end if;
    return v_id;
  end;
  $f$;
  revoke all on function public.carpeta_cliente(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.carpeta_cliente(uuid) to authenticated, service_role;

  create or replace function public.sembrar_carpetas_por_defecto(p_empresa_id uuid)
  returns void
  language plpgsql
  set search_path = public
  as $f$
  begin
    insert into public.carpetas (empresa_id, nombre, orden)
    values (p_empresa_id, 'Fiscal',    1),
           (p_empresa_id, 'Laboral',   2),
           (p_empresa_id, 'Mercantil', 3),
           (p_empresa_id, 'Contratos', 4)
    on conflict do nothing;
    perform public.carpeta_cliente(p_empresa_id);
  end;
  $f$;

  create or replace function public.carpetas_proteger()
  returns trigger
  language plpgsql
  set search_path = public
  as $f$
  begin
    if tg_op = 'UPDATE' then
      if new.empresa_id is distinct from old.empresa_id then
        raise exception 'Una carpeta no puede cambiar de empresa';
      end if;
      if new.system_key is distinct from old.system_key then
        raise exception 'system_key no es editable';
      end if;
      if new.parent_id is distinct from old.parent_id
         and (old.parent_id is null or new.parent_id is null) then
        raise exception 'Solo se puede mover una subcarpeta a otra carpeta raíz';
      end if;
      if old.system_key = 'cliente' and new.nombre is distinct from old.nombre then
        raise exception 'La carpeta "Aportados por el cliente" no se puede renombrar';
      end if;
      if old.system_key = 'whatsapp' and new.nombre is distinct from old.nombre then
        if exists (select 1 from public.documentos where folder_id = old.id) then
          raise exception 'La carpeta WhatsApp tiene documentos: no se puede renombrar';
        end if;
        new.system_key := null;
      end if;
      return new;
    end if;

    -- DELETE
    if exists (select 1 from public.documentos where folder_id = old.id) then
      if not exists (select 1 from public.empresas where id = old.empresa_id) then
        raise exception 'La empresa tiene documentos: no se puede borrar sin moverlos antes a otra empresa';
      end if;
      raise exception 'La carpeta "%" tiene documentos: muévelos antes de borrarla', old.nombre;
    end if;
    if exists (select 1 from public.carpetas where parent_id = old.id)
       and exists (select 1 from public.empresas where id = old.empresa_id) then
      raise exception 'La carpeta "%" tiene subcarpetas: bórralas o muévelas antes', old.nombre;
    end if;
    return old;
  end;
  $f$;

  create or replace function public.documentos_resolver_carpeta()
  returns trigger
  language plpgsql
  set search_path = public
  as $f$
  begin
    if tg_op = 'INSERT' and new.source = 'whatsapp' then
      if new.contact_id is null and new.whatsapp_conversation_id is not null then
        select contact_id into new.contact_id
        from public.whatsapp_conversations where id = new.whatsapp_conversation_id;
      end if;
      if new.empresa_id is null and new.contact_id is not null then
        new.empresa_id := public.empresa_principal_de(new.contact_id);
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
  $f$;

  create or replace function public.borrar_carpeta(p_carpeta_id uuid, p_destino uuid default null)
  returns void
  language plpgsql
  set search_path = public
  as $f$
  declare
    v_carpeta public.carpetas%rowtype;
    v_destino_empresa uuid;
    v_docs uuid[];
  begin
    if not public.is_admin() then
      raise exception 'No autorizado';
    end if;

    select * into v_carpeta from public.carpetas where id = p_carpeta_id for update;
    if not found then
      raise exception 'Carpeta no encontrada: %', p_carpeta_id;
    end if;

    if exists (select 1 from public.carpetas where parent_id = p_carpeta_id) then
      raise exception 'La carpeta "%" tiene % subcarpeta(s): bórralas o muévelas antes',
        v_carpeta.nombre, (select count(*) from public.carpetas where parent_id = p_carpeta_id);
    end if;

    select coalesce(array_agg(id), '{}') into v_docs from public.documentos where folder_id = p_carpeta_id;

    if cardinality(v_docs) > 0 then
      if v_carpeta.system_key is not null then
        raise exception 'La carpeta "%" es de sistema y tiene documentos: muévelos antes de borrarla', v_carpeta.nombre;
      end if;
      if p_destino is null then
        raise exception 'La carpeta "%" tiene % documento(s): indica la carpeta destino', v_carpeta.nombre, cardinality(v_docs);
      end if;
      if p_destino = p_carpeta_id then
        raise exception 'La carpeta destino no puede ser la misma que se borra';
      end if;
      select empresa_id into v_destino_empresa from public.carpetas where id = p_destino;
      if v_destino_empresa is distinct from v_carpeta.empresa_id then
        raise exception 'La carpeta destino tiene que ser de la misma empresa';
      end if;
      perform public.mover_documentos(v_docs, p_destino);
    end if;

    delete from public.carpetas where id = p_carpeta_id;
  end;
  $f$;

  create or replace function public.mover_carpeta(p_carpeta_id uuid, p_nuevo_padre uuid)
  returns void
  language plpgsql
  set search_path = public
  as $f$
  declare
    v_carpeta public.carpetas%rowtype;
    v_destino public.carpetas%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado';
    end if;

    select * into v_carpeta from public.carpetas where id = p_carpeta_id for update;
    if not found then
      raise exception 'Carpeta no encontrada: %', p_carpeta_id;
    end if;
    if v_carpeta.parent_id is null then
      raise exception 'Solo se pueden mover subcarpetas; "%" es una carpeta raíz', v_carpeta.nombre;
    end if;
    if p_nuevo_padre is null then
      raise exception 'Hace falta una carpeta destino';
    end if;
    if p_nuevo_padre = v_carpeta.parent_id then
      return;
    end if;

    select * into v_destino from public.carpetas where id = p_nuevo_padre;
    if not found then
      raise exception 'Carpeta destino no encontrada: %', p_nuevo_padre;
    end if;
    if v_destino.empresa_id is distinct from v_carpeta.empresa_id then
      raise exception 'La carpeta destino tiene que ser de la misma empresa';
    end if;
    if v_destino.parent_id is not null then
      raise exception 'El destino tiene que ser una carpeta raíz: "%" ya es una subcarpeta', v_destino.nombre;
    end if;
    if v_destino.system_key is not null then
      raise exception 'La carpeta "%" es de sistema y no admite subcarpetas', v_destino.nombre;
    end if;
    if exists (select 1 from public.carpetas
               where parent_id = p_nuevo_padre and id <> p_carpeta_id
                 and lower(btrim(nombre)) = lower(btrim(v_carpeta.nombre))) then
      raise exception 'Ya existe "%" en "%": renombra una de las dos antes', v_carpeta.nombre, v_destino.nombre;
    end if;

    update public.carpetas set parent_id = p_nuevo_padre where id = p_carpeta_id;
  end;
  $f$;

  -- ---------- siembra en las empresas existentes ----------
  perform public.carpeta_cliente(e.id) from public.empresas e;
end
$b1$;


-- ============================================================
-- 1C (verificación) — Lo esperado:
--   - empresas sin carpeta "Aportados por el cliente": 0
--   - las restricciones con 'cliente' y el trigger nuevo presentes
--   - carpeta_cliente: EXECUTE para authenticated y service_role
--     (false/true/true);
--     documentos_registrar_compartido sin EXECUTE para nadie
--     (false/false/false: es un trigger, se dispara sin necesitarlo)
-- ============================================================
select 'empresas sin carpeta cliente' as comprobacion,
       (select count(*) from public.empresas e
        where not exists (select 1 from public.carpetas c
                          where c.empresa_id = e.id and c.system_key = 'cliente'))::text as valor
union all
select 'carpetas cliente (total)',
       (select count(*) from public.carpetas where system_key = 'cliente')::text
union all
select 'restricción ' || conname, pg_get_constraintdef(oid)
from pg_constraint
where conname in ('documentos_source_check', 'carpetas_system_key_check', 'carpetas_cliente_reservado_check')
union all
select 'columna documentos.' || column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'documentos' and column_name in ('shared_at', 'shared_by')
union all
select 'trigger ' || tgname, pg_get_triggerdef(oid)
from pg_trigger
where tgrelid = 'public.documentos'::regclass and tgname = 'documentos_registrar_compartido'
union all
select 'EXECUTE ' || f || ' (anon/authenticated/service_role)',
       has_function_privilege('anon', f, 'EXECUTE') || '/' ||
       has_function_privilege('authenticated', f, 'EXECUTE') || '/' ||
       has_function_privilege('service_role', f, 'EXECUTE')
from unnest(array['public.carpeta_cliente(uuid)', 'public.documentos_registrar_compartido()']) as f
order by 1;


-- ============================================================
-- 2A (solo lectura) — Antes de 2B. Lo esperado: ninguna fila (ninguna
-- de estas funciones existe todavía). Si 2B ya se aplicó, aparecen todas:
-- 2B se puede volver a ejecutar (create or replace + grants).
-- ============================================================
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mis_empresas', 'servicio_nombre', 'portal_exigir_empresa', 'portal_documento_visible',
                    'portal_tipo_permitido', 'portal_estado', 'portal_empresas', 'portal_deals',
                    'portal_carpetas', 'portal_documentos', 'portal_preparar_descarga',
                    'portal_preparar_subida', 'portal_confirmar_subida', 'portal_huerfanos_cliente',
                    'admin_cuentas_pendientes', 'admin_vincular_cuenta', 'admin_desvincular_cuenta')
order by 1;


-- ============================================================
-- 2B (CAMBIO) — Funciones del portal y de gestión de cuentas. Un único DO.
--
-- Todas: SECURITY DEFINER (corren como su dueño, que no pasa por RLS),
-- SET search_path = public, pg_temp, sin parámetro de uid (la identidad es
-- siempre auth.uid()), RETURNS TABLE con columnas explícitas (la firma es
-- la lista blanca). Supabase concede EXECUTE a anon/authenticated/
-- service_role sobre toda función nueva de public: por eso cada una
-- empieza con REVOKE ALL y solo después concede lo que toca.
--
-- Errores:
--   GU001 'No disponible'   — empresa o documento fuera de mis_empresas(),
--                              exista o no. Mismo texto y código siempre.
--   GU002 'Fichero no válido: …' — la subida se rechaza y NO hay ninguna
--                              fila que apunte al objeto: portal-subir
--                              puede borrarlo.
--   GU003 límite diario de subidas.
--   42501 'No autorizado'   — RPC de admin llamada sin ser admin.
--   GU010 validaciones de las RPC de admin (texto específico).
-- ============================================================
do $b2$
begin
  -- ===================== internas (sin EXECUTE para nadie) =====================

  -- Empresas del usuario actual. Vacío si no hay sesión, si la cuenta no
  -- está vinculada a un contacto o si tiene fila en admins (activa o no):
  -- un admin nunca es cliente.
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
  $f$;
  revoke all on function public.mis_empresas() from public, anon, authenticated, service_role;

  -- Lanza GU001 si la empresa no es del usuario actual (o no existe).
  create or replace function public.portal_exigir_empresa(p_empresa_id uuid)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if p_empresa_id is null
       or not exists (select 1 from public.mis_empresas() e where e = p_empresa_id) then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
  end;
  $f$;
  revoke all on function public.portal_exigir_empresa(uuid) from public, anon, authenticated, service_role;

  -- Única regla de "qué documento ve el cliente": compartido y guardado, o
  -- aportado por el cliente (de cualquier contacto de la empresa).
  create or replace function public.portal_documento_visible(p_visible boolean, p_status text, p_source text)
  returns boolean
  language sql
  immutable
  set search_path = public, pg_temp
  as $f$
    select (coalesce(p_visible, false) and p_status = 'stored') or p_source = 'cliente'
  $f$;
  revoke all on function public.portal_documento_visible(boolean, text, text) from public, anon, authenticated, service_role;

  -- Nombre visible de un servicio. El catálogo vive en crm/data.js:93-101
  -- (CRM.SERVICES): si se añade o renombra un servicio allí, hay que
  -- reflejarlo aquí. Código desconocido → NULL (el portal pinta "Servicio").
  create or replace function public.servicio_nombre(p_code text)
  returns text
  language sql
  immutable
  set search_path = public, pg_temp
  as $f$
    select case p_code
      when 's1' then 'CFO Externo'
      when 's2' then 'Planificación Fiscal'
      when 's3' then 'Asesoría Contable'
      when 's4' then 'Asesoría Laboral'
      when 's5' then 'Legal y Cumplimiento'
      when 's6' then 'Planificación Estratégica'
      when 's7' then 'Expansión LatAm'
    end
  $f$;
  revoke all on function public.servicio_nombre(text) from public, anon, authenticated, service_role;

  -- Tipos de fichero admitidos en las subidas del cliente. Manda la
  -- extensión; el MIME declarado tiene que ser uno de los suyos, o venir
  -- vacío / application/octet-stream (entonces se guarda el canónico).
  -- Devuelve el MIME canónico, o NULL si no se admite. La misma tabla está
  -- en crm/supabase-functions/portal-subir/validacion.ts (solo para avisar
  -- antes de subir; la que manda es esta).
  create or replace function public.portal_tipo_permitido(p_ext text, p_mime text)
  returns text
  language sql
  immutable
  set search_path = public, pg_temp
  as $f$
    with t(ext, canonico, admitidos) as (values
      ('pdf',  'application/pdf', array['application/pdf']),
      ('jpg',  'image/jpeg', array['image/jpeg']),
      ('jpeg', 'image/jpeg', array['image/jpeg']),
      ('png',  'image/png',  array['image/png']),
      ('heic', 'image/heic', array['image/heic', 'image/heif']),
      ('heif', 'image/heif', array['image/heif', 'image/heic']),
      ('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
               array['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
      ('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
      ('xml',  'application/xml', array['application/xml', 'text/xml']),
      ('csv',  'text/csv', array['text/csv', 'application/vnd.ms-excel'])
    )
    select t.canonico
    from t
    where t.ext = lower(p_ext)
      and (coalesce(lower(btrim(p_mime)), '') in ('', 'application/octet-stream')
           or lower(btrim(p_mime)) = any (t.admitidos))
  $f$;
  revoke all on function public.portal_tipo_permitido(text, text) from public, anon, authenticated, service_role;

  -- ===================== cliente (EXECUTE solo authenticated) =====================

  create or replace function public.portal_estado()
  returns table(estado text, nombre text, email text)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_uid uuid := auth.uid();
  begin
    if v_uid is null then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    return query
    select case
             when exists (select 1 from public.admins a where a.auth_user_id = v_uid) then 'admin'
             when c.id is not null then 'cliente'
             else 'pendiente'
           end,
           case
             when exists (select 1 from public.admins a where a.auth_user_id = v_uid) then null
             when c.id is not null then c.full_name
             else u.raw_user_meta_data ->> 'name'
           end,
           u.email::text
    from (select v_uid as id) yo
    left join auth.users u on u.id = yo.id
    left join public.contactos c on c.auth_user_id = yo.id;
  end;
  $f$;

  create or replace function public.portal_empresas()
  returns table(empresa_id uuid, razon_social text, cif text, direccion text, ciudad text,
                provincia text, principal boolean)
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select e.id, e.razon_social, e.cif, e.address, e.city, e.province,
           e.id = public.empresa_principal_de(c.id)
    from public.contactos c
    join public.contacto_empresa ce on ce.contact_id = c.id
    join public.empresas e on e.id = ce.empresa_id
    where c.auth_user_id = auth.uid()
      and e.id in (select public.mis_empresas())
    order by (e.id = public.empresa_principal_de(c.id)) desc, e.razon_social
  $f$;

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
    select case when d.stage = 'cliente_activo' then 'Contratado' else 'En estudio' end,
           public.servicio_nombre(d.service),
           d.amount,
           d.frequency,
           case when d.service = 's4' then d.num_nominas end,
           case when d.service = 's4' then d.coste_nomina end
    from public.deals d
    where d.empresa_id = p_empresa_id
      and d.stage in ('propuesta', 'negociacion', 'cliente_activo')
    order by (d.stage = 'cliente_activo') desc, d.created_at desc;
  end;
  $f$;

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
    order by d.created_at desc;
  end;
  $f$;

  -- Las carpetas que contienen algo que el cliente ve (y sus madres), más
  -- "Aportados por el cliente". Las vacías no se enseñan.
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

  -- Para portal-descargar: la ruta en Storage de un documento que el
  -- cliente puede ver. Conocer la ruta no da acceso a nada (el cliente no
  -- tiene políticas sobre Storage); la URL firmada la hace la función.
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
      and public.portal_documento_visible(d.visible, d.status, d.source);
    if not found then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
  end;
  $f$;

  -- Para portal-subir (solicitar): valida la empresa y el límite de 30
  -- subidas por empresa y día (Europe/Madrid), contando los objetos ya
  -- subidos hoy bajo cliente/{empresa_id}/. Devuelve cuántas quedan.
  create or replace function public.portal_preparar_subida(p_empresa_id uuid)
  returns table(subidas_restantes integer)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_hoy integer;
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
    return query select 30 - v_hoy;
  end;
  $f$;

  -- Para portal-subir (confirmar): registra la subida SOLO si el fichero
  -- está en Storage, en la ruta que corresponde a esta empresa y a este
  -- documento, y cumple tipo y tamaño (los reales, de storage.objects, no
  -- los que declaró el navegador). Es ejecutable por authenticated, así
  -- que todas las comprobaciones viven aquí: llamarla saltándose la Edge
  -- Function no permite registrar nada que no pase por ellas.
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

    -- Ya registrado (doble confirmación o id reutilizado): error genérico,
    -- NO GU002, porque portal-subir borraría un fichero que sí tiene fila.
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

    -- Límite diario también aquí, sobre filas: varias URLs pedidas a la vez
    -- (todas con el contador a 0) no pueden acabar registradas por encima.
    if (select count(*) from public.documentos d
        where d.empresa_id = p_empresa_id and d.source = 'cliente'
          and d.created_at >= (date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid')) >= 30 then
      raise exception 'Fichero no válido: se ha alcanzado el máximo de 30 documentos por día' using errcode = 'GU002';
    end if;

    v_tamano := nullif(v_objeto.metadata ->> 'size', '')::bigint;
    if v_tamano is null or v_tamano < 1 or v_tamano > 15728640 then
      raise exception 'Fichero no válido: el tamaño tiene que estar entre 1 byte y 15 MB' using errcode = 'GU002';
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
         empresa_id, folder_id, source, contact_id, uploaded_by, visible)
      values
        (p_documento_id, v_objeto.name, v_mime, v_tamano, v_nombre, 'stored',
         p_empresa_id, public.carpeta_cliente(p_empresa_id), 'cliente', v_contacto, null, false);
    exception when unique_violation then
      -- Dos confirmaciones a la vez: la otra ya lo registró.
      raise exception 'No disponible' using errcode = 'GU001';
    end;

    return query select p_documento_id, v_nombre, v_razon;
  end;
  $f$;

  -- ===================== limpieza (EXECUTE solo service_role) =====================

  -- Objetos bajo cliente/ con más de 24 h y sin fila en documentos: subidas
  -- que nunca se confirmaron o que se rechazaron sin poder borrarse. Los
  -- borra portal-limpieza con la API de Storage (un DELETE aquí no borraría
  -- el fichero).
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
      and o.name like 'cliente/%'
      and o.created_at < now() - interval '24 hours'
      and not exists (select 1 from public.documentos d where d.storage_path = o.name)
    order by o.created_at
    limit greatest(coalesce(p_limite, 500), 0)
  $f$;

  -- ===================== admin (EXECUTE solo authenticated; exigen is_admin()) =====================

  create or replace function public.admin_cuentas_pendientes()
  returns table(auth_user_id uuid, email text, nombre text, alta timestamptz, email_confirmado boolean)
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
    select u.id, u.email::text, u.raw_user_meta_data ->> 'name', u.created_at, u.email_confirmed_at is not null
    from auth.users u
    where u.deleted_at is null
      and not coalesce(u.is_anonymous, false)
      and not exists (select 1 from public.admins a where a.auth_user_id = u.id)
      and not exists (select 1 from public.contactos c where c.auth_user_id = u.id)
    order by u.created_at desc;
  end;
  $f$;

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

    return query
    select lower(btrim(coalesce(v_email_cuenta, ''))) = lower(btrim(coalesce(v_contacto.email, ''))),
           v_email_cuenta, v_contacto.email, v_contacto.full_name;
  end;
  $f$;

  create or replace function public.admin_desvincular_cuenta(p_contact_id uuid)
  returns boolean
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    if not exists (select 1 from public.contactos where id = p_contact_id) then
      raise exception 'El contacto no existe' using errcode = 'GU010';
    end if;
    update public.contactos set auth_user_id = null
    where id = p_contact_id and auth_user_id is not null;
    return found;
  end;
  $f$;

  -- ===================== permisos =====================
  revoke all on function public.portal_estado()                        from public, anon, authenticated, service_role;
  revoke all on function public.portal_empresas()                      from public, anon, authenticated, service_role;
  revoke all on function public.portal_deals(uuid)                     from public, anon, authenticated, service_role;
  revoke all on function public.portal_documentos(uuid)                from public, anon, authenticated, service_role;
  revoke all on function public.portal_carpetas(uuid)                  from public, anon, authenticated, service_role;
  revoke all on function public.portal_preparar_descarga(uuid)         from public, anon, authenticated, service_role;
  revoke all on function public.portal_preparar_subida(uuid)           from public, anon, authenticated, service_role;
  revoke all on function public.portal_confirmar_subida(uuid, uuid, text) from public, anon, authenticated, service_role;
  revoke all on function public.portal_huerfanos_cliente(integer)      from public, anon, authenticated, service_role;
  revoke all on function public.admin_cuentas_pendientes()             from public, anon, authenticated, service_role;
  revoke all on function public.admin_vincular_cuenta(uuid, uuid)      from public, anon, authenticated, service_role;
  revoke all on function public.admin_desvincular_cuenta(uuid)         from public, anon, authenticated, service_role;

  grant execute on function public.portal_estado()                        to authenticated;
  grant execute on function public.portal_empresas()                      to authenticated;
  grant execute on function public.portal_deals(uuid)                     to authenticated;
  grant execute on function public.portal_documentos(uuid)                to authenticated;
  grant execute on function public.portal_carpetas(uuid)                  to authenticated;
  grant execute on function public.portal_preparar_descarga(uuid)         to authenticated;
  grant execute on function public.portal_preparar_subida(uuid)           to authenticated;
  grant execute on function public.portal_confirmar_subida(uuid, uuid, text) to authenticated;
  grant execute on function public.admin_cuentas_pendientes()             to authenticated;
  grant execute on function public.admin_vincular_cuenta(uuid, uuid)      to authenticated;
  grant execute on function public.admin_desvincular_cuenta(uuid)         to authenticated;
  grant execute on function public.portal_huerfanos_cliente(integer)      to service_role;
end
$b2$;


-- ============================================================
-- 2C (verificación) — Una fila por función. Lo esperado:
--   - todas security_definer = true y con search_path=public, pg_temp
--     (salvo portal_documento_visible, portal_tipo_permitido y
--     servicio_nombre, que no son definer: no leen ninguna tabla)
--   - anon: false en todas
--   - authenticated: true SOLO en portal_* de cliente, admin_* y
--     carpeta_cliente (invoker: la llama el trigger de empresas con el rol
--     de quien crea la empresa; a un cliente la RLS de carpetas no le deja
--     hacer nada)
--   - service_role: true SOLO en portal_huerfanos_cliente y carpeta_cliente
-- ============================================================
select p.proname as funcion,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, '; ') as config,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('mis_empresas', 'servicio_nombre', 'portal_exigir_empresa', 'portal_documento_visible',
                    'portal_tipo_permitido', 'portal_estado', 'portal_empresas', 'portal_deals',
                    'portal_carpetas', 'portal_documentos', 'portal_preparar_descarga',
                    'portal_preparar_subida', 'portal_confirmar_subida', 'portal_huerfanos_cliente',
                    'admin_cuentas_pendientes', 'admin_vincular_cuenta', 'admin_desvincular_cuenta',
                    'carpeta_cliente', 'documentos_registrar_compartido')
order by authenticated desc, service_role desc, 1;


-- ============================================================
-- 3A (solo lectura) — Antes de 3B, y DESPUÉS de desplegar portal-limpieza,
-- poner su secret y crear el de Vault. Lo esperado: pg_cron, pg_net y
-- supabase_vault instalados; el secreto 'portal_limpieza_hook_secret' en
-- Vault (solo se dice si existe, nunca su valor); ningún job
-- 'portal-limpieza-huerfanos' todavía.
-- ============================================================
select 'extensión ' || e.extname as comprobacion, e.extversion as valor
from pg_extension e
where e.extname in ('pg_cron', 'pg_net', 'supabase_vault')
union all
select 'secreto en Vault portal_limpieza_hook_secret',
       case when count(*) = 1 then 'existe' else count(*) || ' (esperado 1)' end
from vault.secrets
where name = 'portal_limpieza_hook_secret'
union all
select 'job ' || j.jobname, j.schedule || ' · ' || j.command
from cron.job j
where j.jobname = 'portal-limpieza-huerfanos';


-- ============================================================
-- 3B (CAMBIO) — Cron diario de limpieza: una función SECURITY DEFINER
-- que llama a portal-limpieza con pg_net, programada con pg_cron (mismo
-- esquema que send_due_task_reminders).
--
-- A diferencia de aquella, el secreto NO está escrito ni en la función ni
-- en el job: se lee de Supabase Vault (vault.decrypted_secrets) en cada
-- llamada. Se crea aparte con vault.create_secret(<valor>,
-- 'portal_limpieza_hook_secret', …), con el MISMO valor que el secret
-- PORTAL_LIMPIEZA_HOOK_SECRET de la Edge Function. Si falta, la función
-- falla en vez de llamar sin secreto.
--
-- La anon key va escrita: es pública (la misma que crm/config.js) y solo
-- sirve para pasar verify_jwt; no da ningún permiso.
-- Todos los días a las 03:30 UTC.
-- ============================================================
do $b3$
begin
  create or replace function public.portal_lanzar_limpieza()
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_secreto text;
  begin
    select ds.decrypted_secret into v_secreto
    from vault.decrypted_secrets ds
    where ds.name = 'portal_limpieza_hook_secret';
    if v_secreto is null or v_secreto = '' then
      raise exception 'Falta el secreto portal_limpieza_hook_secret en Vault';
    end if;

    perform net.http_post(
      url     := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/portal-limpieza',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1a3Rzb3RyY29scWRvd3BibnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDY5MjksImV4cCI6MjA5ODg4MjkyOX0.BmOBBZbnTWvuUgy74gyKKHz5mPnyOI1d0gzf_UjQcwQ',
        'x-hook-secret', v_secreto
      ),
      body    := '{}'::jsonb
    );
  end;
  $f$;
  revoke all on function public.portal_lanzar_limpieza() from public, anon, authenticated, service_role;

  perform cron.unschedule(jobid) from cron.job where jobname = 'portal-limpieza-huerfanos';
  perform cron.schedule('portal-limpieza-huerfanos', '30 3 * * *', 'select public.portal_lanzar_limpieza();');
end
$b3$;


-- ============================================================
-- 3C (verificación) — Lo esperado:
--   - job activo '30 3 * * *' con el comando "select public.portal_lanzar_limpieza();"
--   - función: "lee de Vault, sin secreto escrito" y anon/authenticated/
--     service_role = false/false/false
--   - secreto en Vault: existe (nunca se muestra el valor)
-- Tras la primera ejecución (o lanzándola a mano con
-- "select public.portal_lanzar_limpieza();"), la respuesta está en
-- net._http_response: select status_code, content, created
-- from net._http_response order by created desc limit 5;
-- ============================================================
select 'job ' || j.jobname as comprobacion,
       j.schedule || ' · activo=' || j.active || ' · ' || j.command as valor
from cron.job j
where j.jobname = 'portal-limpieza-huerfanos'
union all
select 'función portal_lanzar_limpieza',
       case when p.prosrc like '%vault.decrypted_secrets%'
                 and p.prosrc not like '%x-hook-secret'', ''%'
            then 'lee de Vault, sin secreto escrito' else 'REVISAR: no lee de Vault o lleva un literal' end
       || ' · anon/authenticated/service_role = '
       || has_function_privilege('anon', p.oid, 'EXECUTE') || '/'
       || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/'
       || has_function_privilege('service_role', p.oid, 'EXECUTE')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'portal_lanzar_limpieza'
union all
select 'secreto en Vault portal_limpieza_hook_secret',
       case when count(*) = 1 then 'existe' else count(*) || ' (esperado 1)' end
from vault.secrets
where name = 'portal_limpieza_hook_secret';
