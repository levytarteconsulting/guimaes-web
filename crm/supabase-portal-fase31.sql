-- ============================================================
-- GUIMAES — Área cliente, FASE 3.1: edición de la empresa y solicitudes
--
-- 1. Edición directa de dirección, ciudad y provincia (los únicos datos de
--    la empresa que no la identifican: empresas no tiene datos de contacto),
--    con historial de cambios.
-- 2. Solicitudes de cambio de razón social y CIF: las aplica (o rechaza)
--    el equipo desde el CRM.
-- 3. Solicitud de servicios desde el portal: crea un deal en la primera
--    etapa con origen 'portal' (columna nueva deals.origen).
--
-- Mismas reglas que la fase 1 (crm/supabase-portal-fase1.sql): el cliente
-- no tiene ninguna política RLS; todo pasa por RPC SECURITY DEFINER con
-- search_path fijo, sin parámetro de uid, columnas explícitas, EXECUTE solo
-- para authenticated y validación contra mis_empresas().
-- Los avisos push al equipo los manda la Edge Function portal-solicitudes,
-- que envuelve las tres RPC de escritura (llamarlas directamente funciona
-- igual, pero sin aviso: el aviso no es parte de la seguridad).
--
-- Errores nuevos (además de GU001 'No disponible'):
--   GU004 límite diario de solicitudes de servicio
--   GU005 dato no válido (texto pensado para enseñarse al cliente)
--
-- Bloques, cada uno por separado en el editor: 1A, 1B, 1C, 2A, 2B, 2C.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado: ninguna fila.
-- ============================================================
select 'tabla ' || c.relname as ya_existe
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('empresa_cambios', 'empresa_solicitudes')
union all
select 'columna deals.' || column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'deals' and column_name = 'origen';


-- ============================================================
-- 1B (CAMBIO) — Tablas y columna. Un único DO: atómico.
-- Las dos tablas, solo lectura para admins (RLS is_admin()); nadie escribe
-- en ellas por la API: lo hacen las RPC, como su dueño.
-- ============================================================
do $b1$
begin
  if to_regclass('public.empresa_cambios') is not null then
    raise exception 'empresa_cambios ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;

  -- Historial de lo que el cliente cambia directamente.
  create table public.empresa_cambios (
    id              uuid primary key default gen_random_uuid(),
    created_at      timestamptz not null default now(),
    empresa_id      uuid not null references public.empresas(id) on delete cascade,
    campo           text not null check (campo in ('address', 'city', 'province')),
    valor_anterior  text,
    valor_nuevo     text,
    contact_id      uuid references public.contactos(id) on delete set null,
    auth_user_id    uuid references auth.users(id) on delete set null
  );
  create index empresa_cambios_empresa_idx on public.empresa_cambios (empresa_id, created_at desc);
  alter table public.empresa_cambios enable row level security;
  create policy "admins leen empresa_cambios" on public.empresa_cambios
    for select to authenticated using ((select public.is_admin()));

  -- Solicitudes de cambio de los datos que identifican a la empresa.
  create table public.empresa_solicitudes (
    id                uuid primary key default gen_random_uuid(),
    created_at        timestamptz not null default now(),
    empresa_id        uuid not null references public.empresas(id) on delete cascade,
    campo             text not null check (campo in ('razon_social', 'cif')),
    valor_actual      text,
    valor_solicitado  text not null,
    comentario        text,
    estado            text not null default 'pendiente' check (estado in ('pendiente', 'aplicada', 'rechazada')),
    contact_id        uuid references public.contactos(id) on delete set null,
    auth_user_id      uuid references auth.users(id) on delete set null,
    resuelta_at       timestamptz,
    resuelta_por      uuid references public.admins(id) on delete set null
  );
  -- Como mucho una pendiente por empresa y dato.
  create unique index empresa_solicitudes_pendiente_key
    on public.empresa_solicitudes (empresa_id, campo) where estado = 'pendiente';
  create index empresa_solicitudes_empresa_idx on public.empresa_solicitudes (empresa_id, created_at desc);
  alter table public.empresa_solicitudes enable row level security;
  create policy "admins leen empresa_solicitudes" on public.empresa_solicitudes
    for select to authenticated using ((select public.is_admin()));

  -- Origen del deal: 'crm' (todo lo de hasta ahora) o 'portal' (pedido por
  -- el cliente). Solo los de origen 'portal' se le enseñan en etapas previas
  -- a la propuesta ("Solicitado").
  alter table public.deals add column origen text not null default 'crm';
  alter table public.deals add constraint deals_origen_check check (origen in ('crm', 'portal'));
end
$b1$;


-- ============================================================
-- 1C (verificación) — Lo esperado: las dos tablas con RLS activa y una
-- única política (SELECT con is_admin()); deals.origen text not null
-- default 'crm'.
-- ============================================================
select 'tabla ' || c.relname as comprobacion,
       'rls=' || c.relrowsecurity || ' · políticas: ' ||
       coalesce((select string_agg(p.cmd || ' ' || p.qual, '; ') from pg_policies p
                 where p.schemaname = 'public' and p.tablename = c.relname), 'ninguna') as valor
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('empresa_cambios', 'empresa_solicitudes')
union all
select 'columna deals.origen', data_type || ' · nullable=' || is_nullable || ' · default=' || column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'deals' and column_name = 'origen'
order by 1;


-- ============================================================
-- 2A (solo lectura) — Lo esperado: solo portal_deals (ya existe y se
-- sustituye); ninguna de las nuevas.
-- ============================================================
select p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('portal_deals', 'portal_servicios', 'portal_solicitar_servicio', 'portal_actualizar_empresa',
                    'portal_solicitar_cambio_empresa', 'portal_solicitudes_empresa', 'admin_resolver_solicitud')
order by 1;


-- ============================================================
-- 2B (CAMBIO) — Funciones. Un único DO. Re-ejecutable.
-- ============================================================
do $b2$
begin
  -- ---------- portal_deals: también lo que pidió el cliente ----------
  -- Contratado (cliente_activo), En estudio (propuesta, negociación) y,
  -- SOLO si lo pidió el cliente desde el portal, Solicitado (etapas
  -- anteriores). Los deals internos de etapas previas siguen ocultos.
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
    order by case when d.stage = 'cliente_activo' then 0 when d.stage in ('propuesta', 'negociacion') then 1 else 2 end,
             d.created_at desc;
  end;
  $f$;

  -- ---------- catálogo que puede pedir el cliente ----------
  -- Los mismos códigos y nombres que servicio_nombre() (cuyo catálogo es el
  -- de crm/data.js:93-101). Solo para clientes vinculados.
  create or replace function public.portal_servicios()
  returns table(codigo text, nombre text)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not exists (select 1 from public.mis_empresas()) then
      raise exception 'No disponible' using errcode = 'GU001';
    end if;
    return query
    select c.codigo, public.servicio_nombre(c.codigo)
    from unnest(array['s1', 's2', 's3', 's4', 's5', 's6', 's7']) with ordinality as c(codigo, n)
    where public.servicio_nombre(c.codigo) is not null
    order by c.n;
  end;
  $f$;

  -- ---------- solicitar un servicio ----------
  -- Deal en la primera etapa ('nueva_solicitud'), de la empresa, con el
  -- contacto que lo pide como interlocutor y origen 'portal'; el mensaje,
  -- si lo hay, como nota del deal. Máximo 5 por empresa y día (Madrid).
  create or replace function public.portal_solicitar_servicio(p_empresa_id uuid, p_servicio text, p_mensaje text)
  returns table(servicio text, razon_social text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_nombre   text;
    v_mensaje  text;
    v_contacto uuid;
    v_deal     uuid;
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    v_nombre := public.servicio_nombre(p_servicio);
    if v_nombre is null then
      raise exception 'Elige un servicio de la lista.' using errcode = 'GU005';
    end if;
    -- Se conservan los saltos de línea; fuera el resto de caracteres de control.
    v_mensaje := btrim(regexp_replace(normalize(coalesce(p_mensaje, ''), NFC), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g'));
    if length(v_mensaje) > 1000 then
      raise exception 'El mensaje no puede tener más de 1000 caracteres.' using errcode = 'GU005';
    end if;
    if (select count(*) from public.deals d
        where d.empresa_id = p_empresa_id and d.origen = 'portal'
          and d.created_at >= (date_trunc('day', now() at time zone 'Europe/Madrid') at time zone 'Europe/Madrid')) >= 5 then
      raise exception 'Has alcanzado el máximo de 5 solicitudes por día para esta empresa. Inténtalo mañana o escríbenos.'
        using errcode = 'GU004';
    end if;

    select c.id into v_contacto from public.contactos c where c.auth_user_id = auth.uid();
    insert into public.deals (title, contact_id, empresa_id, service, stage, origen)
    values (v_nombre || ' — solicitud del área cliente', v_contacto, p_empresa_id, p_servicio, 'nueva_solicitud', 'portal')
    returning id into v_deal;
    if v_mensaje <> '' then
      insert into public.notas (body, contact_id, deal_id)
      values ('Mensaje del cliente (área cliente): ' || v_mensaje, v_contacto, v_deal);
    end if;

    return query select v_nombre, e.razon_social from public.empresas e where e.id = p_empresa_id;
  end;
  $f$;

  -- ---------- editar dirección, ciudad y provincia ----------
  -- Vacío = sin dato (NULL). Sin caracteres de control ni saltos de línea.
  -- Cada campo que cambia queda en empresa_cambios con quién lo hizo.
  create or replace function public.portal_actualizar_empresa(p_empresa_id uuid, p_direccion text, p_ciudad text, p_provincia text)
  returns table(direccion text, ciudad text, provincia text, cambios integer)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_actual   public.empresas%rowtype;
    v_dir      text;
    v_ciudad   text;
    v_prov     text;
    v_contacto uuid;
    v_n        integer := 0;
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    v_dir    := nullif(btrim(regexp_replace(normalize(coalesce(p_direccion, ''), NFC), '\s+', ' ', 'g')), '');
    v_ciudad := nullif(btrim(regexp_replace(normalize(coalesce(p_ciudad, ''), NFC), '\s+', ' ', 'g')), '');
    v_prov   := nullif(btrim(regexp_replace(normalize(coalesce(p_provincia, ''), NFC), '\s+', ' ', 'g')), '');
    v_dir    := regexp_replace(v_dir, '[\x01-\x1f\x7f]', '', 'g');
    v_ciudad := regexp_replace(v_ciudad, '[\x01-\x1f\x7f]', '', 'g');
    v_prov   := regexp_replace(v_prov, '[\x01-\x1f\x7f]', '', 'g');
    if length(v_dir) > 200 then raise exception 'La dirección no puede tener más de 200 caracteres.' using errcode = 'GU005'; end if;
    if length(v_ciudad) > 100 then raise exception 'La ciudad no puede tener más de 100 caracteres.' using errcode = 'GU005'; end if;
    if length(v_prov) > 100 then raise exception 'La provincia no puede tener más de 100 caracteres.' using errcode = 'GU005'; end if;

    select * into v_actual from public.empresas e where e.id = p_empresa_id for update;
    select c.id into v_contacto from public.contactos c where c.auth_user_id = auth.uid();

    if v_dir is distinct from v_actual.address then
      insert into public.empresa_cambios (empresa_id, campo, valor_anterior, valor_nuevo, contact_id, auth_user_id)
      values (p_empresa_id, 'address', v_actual.address, v_dir, v_contacto, auth.uid());
      v_n := v_n + 1;
    end if;
    if v_ciudad is distinct from v_actual.city then
      insert into public.empresa_cambios (empresa_id, campo, valor_anterior, valor_nuevo, contact_id, auth_user_id)
      values (p_empresa_id, 'city', v_actual.city, v_ciudad, v_contacto, auth.uid());
      v_n := v_n + 1;
    end if;
    if v_prov is distinct from v_actual.province then
      insert into public.empresa_cambios (empresa_id, campo, valor_anterior, valor_nuevo, contact_id, auth_user_id)
      values (p_empresa_id, 'province', v_actual.province, v_prov, v_contacto, auth.uid());
      v_n := v_n + 1;
    end if;
    if v_n > 0 then
      update public.empresas set address = v_dir, city = v_ciudad, province = v_prov where id = p_empresa_id;
    end if;

    return query select v_dir, v_ciudad, v_prov, v_n;
  end;
  $f$;

  -- ---------- solicitar cambio de razón social o CIF ----------
  -- CIF: 9 letras o números (NIF, CIF o NIE), en mayúsculas y sin espacios,
  -- puntos ni guiones. Razón social: 2 a 200 caracteres. Una sola pendiente
  -- por empresa y dato.
  create or replace function public.portal_solicitar_cambio_empresa(p_empresa_id uuid, p_campo text, p_valor text, p_comentario text)
  returns table(campo text, valor_solicitado text, razon_social text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_actual     public.empresas%rowtype;
    v_valor      text;
    v_comentario text;
    v_contacto   uuid;
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    if p_campo is null or p_campo not in ('razon_social', 'cif') then
      raise exception 'Solo se puede solicitar el cambio de la razón social o del CIF.' using errcode = 'GU005';
    end if;
    select * into v_actual from public.empresas e where e.id = p_empresa_id;

    if p_campo = 'cif' then
      v_valor := upper(regexp_replace(coalesce(p_valor, ''), '[\s.\-]', '', 'g'));
      if v_valor !~ '^[A-Z0-9]{9}$' then
        raise exception 'El CIF o NIF tiene que tener 9 letras o números (por ejemplo, B12345678).' using errcode = 'GU005';
      end if;
      if v_valor = upper(regexp_replace(coalesce(v_actual.cif, ''), '[\s.\-]', '', 'g')) then
        raise exception 'Es el mismo CIF que ya figura.' using errcode = 'GU005';
      end if;
    else
      v_valor := btrim(regexp_replace(regexp_replace(normalize(coalesce(p_valor, ''), NFC), '[\x01-\x1f\x7f]', '', 'g'), '\s+', ' ', 'g'));
      if length(v_valor) < 2 or length(v_valor) > 200 then
        raise exception 'La razón social tiene que tener entre 2 y 200 caracteres.' using errcode = 'GU005';
      end if;
      if lower(v_valor) = lower(btrim(coalesce(v_actual.razon_social, ''))) then
        raise exception 'Es la misma razón social que ya figura.' using errcode = 'GU005';
      end if;
    end if;

    v_comentario := nullif(btrim(regexp_replace(normalize(coalesce(p_comentario, ''), NFC), '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', 'g')), '');
    if length(v_comentario) > 500 then
      raise exception 'El comentario no puede tener más de 500 caracteres.' using errcode = 'GU005';
    end if;

    select c.id into v_contacto from public.contactos c where c.auth_user_id = auth.uid();
    begin
      insert into public.empresa_solicitudes (empresa_id, campo, valor_actual, valor_solicitado, comentario, contact_id, auth_user_id)
      values (p_empresa_id, p_campo, case when p_campo = 'cif' then v_actual.cif else v_actual.razon_social end,
              v_valor, v_comentario, v_contacto, auth.uid());
    exception when unique_violation then
      raise exception 'Ya hay una solicitud pendiente para este dato. Guimaes la revisará en breve.' using errcode = 'GU005';
    end;

    return query select p_campo, v_valor, v_actual.razon_social;
  end;
  $f$;

  -- ---------- solicitudes de la empresa (para el portal) ----------
  -- Las pendientes y las resueltas en los últimos 30 días. Sin comentario
  -- ni quién la resolvió.
  create or replace function public.portal_solicitudes_empresa(p_empresa_id uuid)
  returns table(campo text, valor_solicitado text, estado text, fecha timestamptz)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    perform public.portal_exigir_empresa(p_empresa_id);
    return query
    select s.campo, s.valor_solicitado, s.estado, coalesce(s.resuelta_at, s.created_at)
    from public.empresa_solicitudes s
    where s.empresa_id = p_empresa_id
      and (s.estado = 'pendiente' or s.resuelta_at > now() - interval '30 days')
    order by s.created_at desc;
  end;
  $f$;

  -- ---------- CRM: aplicar o rechazar una solicitud ----------
  create or replace function public.admin_resolver_solicitud(p_solicitud_id uuid, p_aplicar boolean)
  returns table(estado text)
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_s public.empresa_solicitudes%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    select * into v_s from public.empresa_solicitudes s where s.id = p_solicitud_id for update;
    if not found then
      raise exception 'La solicitud no existe' using errcode = 'GU010';
    end if;
    if v_s.estado <> 'pendiente' then
      raise exception 'Esta solicitud ya estaba resuelta' using errcode = 'GU010';
    end if;
    if coalesce(p_aplicar, false) then
      begin
        if v_s.campo = 'cif' then
          update public.empresas set cif = v_s.valor_solicitado where id = v_s.empresa_id;
        else
          update public.empresas set razon_social = v_s.valor_solicitado where id = v_s.empresa_id;
        end if;
      exception when unique_violation then
        raise exception 'Ese CIF ya lo tiene otra empresa del CRM' using errcode = 'GU010';
      end;
    end if;
    update public.empresa_solicitudes s
    set estado = case when coalesce(p_aplicar, false) then 'aplicada' else 'rechazada' end,
        resuelta_at = now(),
        resuelta_por = (select a.id from public.admins a where a.auth_user_id = auth.uid())
    where s.id = p_solicitud_id;
    return query select case when coalesce(p_aplicar, false) then 'aplicada' else 'rechazada' end;
  end;
  $f$;

  -- ---------- permisos ----------
  revoke all on function public.portal_deals(uuid)                                   from public, anon, authenticated, service_role;
  revoke all on function public.portal_servicios()                                   from public, anon, authenticated, service_role;
  revoke all on function public.portal_solicitar_servicio(uuid, text, text)          from public, anon, authenticated, service_role;
  revoke all on function public.portal_actualizar_empresa(uuid, text, text, text)    from public, anon, authenticated, service_role;
  revoke all on function public.portal_solicitar_cambio_empresa(uuid, text, text, text) from public, anon, authenticated, service_role;
  revoke all on function public.portal_solicitudes_empresa(uuid)                     from public, anon, authenticated, service_role;
  revoke all on function public.admin_resolver_solicitud(uuid, boolean)              from public, anon, authenticated, service_role;
  grant execute on function public.portal_deals(uuid)                                   to authenticated;
  grant execute on function public.portal_servicios()                                   to authenticated;
  grant execute on function public.portal_solicitar_servicio(uuid, text, text)          to authenticated;
  grant execute on function public.portal_actualizar_empresa(uuid, text, text, text)    to authenticated;
  grant execute on function public.portal_solicitar_cambio_empresa(uuid, text, text, text) to authenticated;
  grant execute on function public.portal_solicitudes_empresa(uuid)                     to authenticated;
  grant execute on function public.admin_resolver_solicitud(uuid, boolean)              to authenticated;
end
$b2$;


-- ============================================================
-- 2C (verificación) — Lo esperado: 7 filas, todas security_definer = true,
-- search_path=public, pg_temp y anon/authenticated/service_role =
-- false/true/false.
-- ============================================================
select p.proname as funcion,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, '; ') as config,
       has_function_privilege('anon', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('service_role', p.oid, 'EXECUTE') as anon_authenticated_service
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('portal_deals', 'portal_servicios', 'portal_solicitar_servicio', 'portal_actualizar_empresa',
                    'portal_solicitar_cambio_empresa', 'portal_solicitudes_empresa', 'admin_resolver_solicitud')
order by 1;
