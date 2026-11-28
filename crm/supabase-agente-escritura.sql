-- ============================================================
-- GUIMAES — Agente de IA: escrituras en el CRM con confirmación
--
-- El asistente deja de ser solo de consulta. Sus herramientas de escritura
-- NO escriben: crean una PROPUESTA (agente_propuestas) con los datos
-- exactos, que el chat enseña como tarjeta (Confirmar / Editar / Cancelar).
-- Solo agente_confirmar, llamada desde el CRM con el JWT de quien pulsa
-- Confirmar, escribe. Todo es SECURITY INVOKER: la RLS de cada tabla manda,
-- así que lo que un usuario no puede hacer en el CRM tampoco lo consigue
-- pidiéndoselo al asistente.
--
-- Qué crea:
--   * agente_propuestas: una fila por propuesta. Cada usuario ve y resuelve
--     las suyas (el rol admin, además, las ve todas). Caducan a las 24 h.
--     Se borran con su conversación (retención de 90 días del agente).
--   * agente_escrituras: auditoría de lo escrito (usuario, acción, tabla,
--     id del registro, fecha). Sin contenido. Solo se inserta.
--   * Tipos: crear/modificar empresa, contacto, negocio y tarea; crear nota;
--     vincular/desvincular contacto y empresa; borrar contacto, negocio,
--     tarea o nota (exige escribir BORRAR). Borrar EMPRESAS no: tiene su
--     pantalla propia en el CRM.
--   * agente_preparar (validar y normalizar, como la interfaz),
--     agente_buscar_duplicados, agente_proponer, agente_confirmar,
--     agente_cancelar. EXECUTE solo para authenticated.
--
-- Errores: 42501 = sin permiso; 22023 = dato no válido (el mensaje va al
-- modelo o a la tarjeta para corregirlo); GU010 = no existe o no se ve.
--
-- Requiere: crm/supabase-agente.sql (agente_conversaciones, agente_norm) y
-- admin_borrar_contacto (crm/supabase-pasoB.sql).
--
-- Patrón (CLAUDE.md): 10A solo lectura → 10B un único DO que se niega a
-- repetirse → 10C verificación. Probado en PGlite:
-- crm/tests/agente/agente-escritura.test.mjs.
-- ============================================================


-- ============================================================
-- 10A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261113120000 (agente): sí     migración 20261128100000: no
--   tablas agente_propuestas/agente_escrituras: 0
--   admin_borrar_contacto: sí      agente_norm: sí
--   columnas usadas: 52
-- ============================================================
select 'migración 20261113120000 (agente)' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261113120000') then 'sí' else 'no' end as valor
union all select 'migración 20261128100000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128100000') then 'sí' else 'no' end
union all select 'tablas agente_propuestas/agente_escrituras',
       (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname in ('agente_propuestas', 'agente_escrituras'))
union all select 'admin_borrar_contacto',
       case when to_regprocedure('public.admin_borrar_contacto(uuid)') is not null then 'sí' else 'no' end
union all select 'agente_norm',
       case when to_regprocedure('public.agente_norm(text)') is not null then 'sí' else 'no' end
union all select 'columnas usadas',
       (select count(*)::text from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (
         ('empresas', 'id'), ('empresas', 'razon_social'), ('empresas', 'cif'), ('empresas', 'address'), ('empresas', 'city'),
         ('empresas', 'province'), ('empresas', 'empleados'), ('empresas', 'archived_at'),
         ('contactos', 'id'), ('contactos', 'full_name'), ('contactos', 'email'), ('contactos', 'phone'), ('contactos', 'dni'),
         ('contactos', 'city'), ('contactos', 'province'), ('contactos', 'employees'), ('contactos', 'lifecycle'), ('contactos', 'priority'),
         ('contactos', 'owner'), ('contactos', 'source'), ('contactos', 'kyc'), ('contactos', 'company'), ('contactos', 'lead_id'),
         ('contactos', 'auth_user_id'),
         ('contacto_empresa', 'id'), ('contacto_empresa', 'contact_id'), ('contacto_empresa', 'empresa_id'), ('contacto_empresa', 'principal'),
         ('contacto_empresa', 'created_at'),
         ('deals', 'id'), ('deals', 'title'), ('deals', 'contact_id'), ('deals', 'empresa_id'), ('deals', 'service'), ('deals', 'stage'),
         ('deals', 'owner'), ('deals', 'amount'), ('deals', 'frequency'), ('deals', 'priority'), ('deals', 'loss_reason'),
         ('deals', 'signed_at'), ('deals', 'renewal_at'), ('deals', 'num_nominas'), ('deals', 'coste_nomina'),
         ('tareas', 'title'), ('tareas', 'assigned_to'), ('tareas', 'due_at'), ('tareas', 'status'), ('tareas', 'archived'),
         ('notas', 'body'), ('notas', 'author'), ('leads', 'status')));


-- ============================================================
-- 10B (cambio, atómico, se niega a repetirse)
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261128100000')
     or to_regclass('public.agente_propuestas') is not null then
    raise exception 'La migración 20261128100000 ya está aplicada. No se ha cambiado nada.';
  end if;
  if to_regclass('public.agente_conversaciones') is null or to_regprocedure('public.agente_norm(text)') is null then
    raise exception 'Falta crm/supabase-agente.sql. No se ha cambiado nada.';
  end if;
  if to_regprocedure('public.admin_borrar_contacto(uuid)') is null then
    raise exception 'Falta admin_borrar_contacto (crm/supabase-pasoB.sql). No se ha cambiado nada.';
  end if;

  -- ===================== tablas =====================
  create table public.agente_propuestas (
    id               uuid primary key default gen_random_uuid(),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    conversacion_id  uuid not null references public.agente_conversaciones(id) on delete cascade,
    tool_use_id      text not null check (char_length(tool_use_id) between 1 and 200),
    auth_user_id     uuid not null default auth.uid(),
    tipo             text not null check (tipo in (
                       'crear_empresa', 'modificar_empresa', 'crear_contacto', 'modificar_contacto',
                       'vincular_empresa', 'desvincular_empresa', 'crear_deal', 'modificar_deal',
                       'crear_tarea', 'modificar_tarea', 'crear_nota',
                       'borrar_contacto', 'borrar_deal', 'borrar_tarea', 'borrar_nota')),
    registro_id      uuid,
    datos            jsonb not null check (jsonb_typeof(datos) = 'object' and pg_column_size(datos) <= 20000),
    antes            jsonb check (antes is null or pg_column_size(antes) <= 20000),
    coincidencias    jsonb not null default '[]'::jsonb check (jsonb_typeof(coincidencias) = 'array'),
    resumen          text not null check (char_length(resumen) between 1 and 300),
    estado           text not null default 'pendiente' check (estado in ('pendiente', 'confirmada', 'cancelada')),
    resultado_id     uuid,
    expira_at        timestamptz not null default now() + interval '24 hours',
    resuelta_at      timestamptz,
    constraint agente_propuestas_tool_use_key unique (conversacion_id, tool_use_id),
    constraint agente_propuestas_registro_chk check ((tipo like 'crear_%') = (registro_id is null))
  );
  create index agente_propuestas_conv_idx on public.agente_propuestas (conversacion_id, created_at);
  create trigger agente_propuestas_set_updated_at before update on public.agente_propuestas
    for each row execute function public.set_updated_at();

  create table public.agente_escrituras (
    id            uuid primary key default gen_random_uuid(),
    created_at    timestamptz not null default now(),
    auth_user_id  uuid not null default auth.uid(),
    propuesta_id  uuid references public.agente_propuestas(id) on delete set null,
    accion        text not null check (char_length(accion) <= 40),
    tabla         text not null check (tabla in ('empresas', 'contactos', 'contacto_empresa', 'deals', 'tareas', 'notas')),
    registro_id   uuid not null
  );
  create index agente_escrituras_usuario_idx on public.agente_escrituras (auth_user_id, created_at desc);

  alter table public.agente_propuestas enable row level security;
  alter table public.agente_escrituras enable row level security;
  create policy "agente: cada usuario lee sus propuestas; el rol admin, todas" on public.agente_propuestas
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: cada usuario crea sus propuestas" on public.agente_propuestas
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()) and estado = 'pendiente');
  create policy "agente: cada usuario resuelve sus propuestas pendientes" on public.agente_propuestas
    for update to authenticated
    using (auth_user_id = (select auth.uid()) and (select public.is_admin()) and estado = 'pendiente')
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()));
  create policy "agente: cada usuario lee su auditoría; el rol admin, toda" on public.agente_escrituras
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: se audita con el usuario propio" on public.agente_escrituras
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()));
  revoke all on public.agente_propuestas, public.agente_escrituras from anon;
  revoke delete, truncate on public.agente_propuestas, public.agente_escrituras from authenticated;
  revoke update on public.agente_escrituras from authenticated;
  grant select, insert, update on public.agente_propuestas to authenticated;
  grant select, insert on public.agente_escrituras to authenticated;

  -- ===================== auxiliares =====================
  -- Texto de un campo: recortado, '' → null; demasiado largo → error.
  create function public.agente_txt(p jsonb, k text, p_max integer)
  returns text language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    if p is null or not (p ? k) or jsonb_typeof(p -> k) = 'null' then return null; end if;
    if jsonb_typeof(p -> k) not in ('string', 'number', 'boolean') then
      raise exception '"%" tiene que ser texto', k using errcode = '22023';
    end if;
    v := nullif(btrim(regexp_replace(p ->> k, '\s+', ' ', 'g')), '');
    if v is not null and char_length(v) > p_max then
      raise exception '"%": como mucho % caracteres', k, p_max using errcode = '22023';
    end if;
    return v;
  end $f$;

  create function public.agente_num(p jsonb, k text, p_entero boolean, p_max numeric)
  returns numeric language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v text; n numeric;
  begin
    v := public.agente_txt(p, k, 40);
    if v is null then return null; end if;
    v := replace(replace(v, ' ', ''), '€', '');
    if v ~ '^-?\d{1,3}(\.\d{3})+(,\d+)?$' then v := replace(replace(v, '.', ''), ',', '.');   -- 1.234,56
    elsif v ~ '^-?\d+,\d+$' then v := replace(v, ',', '.'); end if;
    if v !~ '^-?\d+(\.\d+)?$' then raise exception '"%" tiene que ser un número', k using errcode = '22023'; end if;
    n := v::numeric;
    if n < 0 or n > p_max then raise exception '"%": entre 0 y %', k, p_max using errcode = '22023'; end if;
    if p_entero and n <> trunc(n) then raise exception '"%" tiene que ser un número entero', k using errcode = '22023'; end if;
    return n;
  end $f$;

  create function public.agente_uuid(p jsonb, k text)
  returns uuid language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    v := public.agente_txt(p, k, 40);
    if v is null then return null; end if;
    if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception '"%" tiene que ser un id (uuid)', k using errcode = '22023';
    end if;
    return v::uuid;
  end $f$;

  create function public.agente_enum(p jsonb, k text, p_validos text[])
  returns text language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    v := public.agente_txt(p, k, 60);
    if v is not null and not (v = any (p_validos)) then
      raise exception '"%": valores válidos: %', k, array_to_string(p_validos, ', ') using errcode = '22023';
    end if;
    return v;
  end $f$;

  create function public.agente_bool(p jsonb, k text)
  returns boolean language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    v := lower(coalesce(public.agente_txt(p, k, 10), ''));
    if v = '' then return null; end if;
    if v in ('true', 'sí', 'si', '1') then return true; end if;
    if v in ('false', 'no', '0') then return false; end if;
    raise exception '"%" tiene que ser sí o no', k using errcode = '22023';
  end $f$;

  -- Solo estas claves; ninguna más.
  create function public.agente_claves(p jsonb, p_validas text[])
  returns void language plpgsql immutable set search_path = public, pg_temp as $f$
  declare k text;
  begin
    for k in select jsonb_object_keys(p) loop
      if not (k = any (p_validas)) then
        raise exception 'Campo desconocido "%". Válidos: %', k, array_to_string(p_validas, ', ') using errcode = '22023';
      end if;
    end loop;
  end $f$;

  -- Id de usuario del CRM (owner, asignada_a): un admins.id existente.
  create function public.agente_usuario_crm(p jsonb, k text)
  returns text language plpgsql stable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    v := public.agente_txt(p, k, 100);
    if v is null then return null; end if;
    if not exists (select 1 from public.admins a where a.id::text = v) then
      raise exception '"%": no es ningún usuario del CRM (usa un id de la lista de usuarios)', k using errcode = '22023';
    end if;
    return v;
  end $f$;

  -- Fecha y hora: AAAA-MM-DD (09:00 en Madrid) o con hora; sin zona = Madrid.
  create function public.agente_momento(p jsonb, k text)
  returns timestamptz language plpgsql stable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    v := public.agente_txt(p, k, 40);
    if v is null then return null; end if;
    begin
      if v ~ '^\d{4}-\d{2}-\d{2}$' then return (v || ' 09:00')::timestamp at time zone 'Europe/Madrid'; end if;
      if v ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$' then return replace(v, 'T', ' ')::timestamp at time zone 'Europe/Madrid'; end if;
      if v ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$' then return v::timestamptz; end if;
    exception when others then null;
    end;
    raise exception '"%": fecha no válida (AAAA-MM-DD o AAAA-MM-DDTHH:MM)', k using errcode = '22023';
  end $f$;

  create function public.agente_dia(p jsonb, k text)
  returns date language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v text;
  begin
    v := public.agente_txt(p, k, 20);
    if v is null then return null; end if;
    if v ~ '^\d{4}-\d{2}-\d{2}$' then
      begin return v::date; exception when others then null; end;
    end if;
    raise exception '"%": fecha no válida (AAAA-MM-DD)', k using errcode = '22023';
  end $f$;

  -- ===================== duplicados =====================
  -- Empresas y contactos que podrían ser el mismo: CIF/NIF, email, teléfono
  -- (últimos 9 dígitos), DNI o nombre normalizado (sin acentos, sin forma
  -- jurídica). Con la RLS de quien pregunta. Devuelve como mucho 10.
  create function public.agente_buscar_duplicados(p_razon_social text default null, p_cif text default null,
    p_full_name text default null, p_email text default null, p_phone text default null, p_dni text default null)
  returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
  declare
    v_cif text := nullif(upper(regexp_replace(coalesce(p_cif, ''), '[^A-Za-z0-9]', '', 'g')), '');
    v_dni text := nullif(upper(regexp_replace(coalesce(p_dni, ''), '[^A-Za-z0-9]', '', 'g')), '');
    v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
    v_tel text := case when length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 9
                       then right(regexp_replace(p_phone, '\D', '', 'g'), 9) end;
    v_rs text; v_nom text; v jsonb;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    v_rs := nullif(btrim(regexp_replace(public.agente_norm(coalesce(p_razon_social, '')),
              '[[:space:][:punct:]]+(s\.?\s?l\.?u?|s\.?\s?a\.?u?|s\.?\s?c\.?|s\.?\s?l\.?\s?p\.?|c\.?\s?b\.?|slne)\.?$', '')), '');
    v_nom := nullif(public.agente_norm(btrim(coalesce(p_full_name, ''))), '');
    select coalesce(jsonb_agg(x order by x->>'tipo', x->>'nombre'), '[]'::jsonb) into v from (
      select jsonb_build_object('tipo', 'empresa', 'id', e.id, 'nombre', e.razon_social, 'cif', e.cif,
               'archivada', e.archived_at is not null,
               'motivo', case when v_cif is not null and upper(regexp_replace(coalesce(e.cif, ''), '[^A-Za-z0-9]', '', 'g')) = v_cif then 'mismo CIF/NIF'
                              else 'nombre parecido' end) x
        from public.empresas e
       where (v_cif is not null and upper(regexp_replace(coalesce(e.cif, ''), '[^A-Za-z0-9]', '', 'g')) = v_cif)
          or (v_rs is not null and char_length(v_rs) >= 3 and public.agente_norm(e.razon_social) like '%' || v_rs || '%')
      union all
      select jsonb_build_object('tipo', 'contacto', 'id', c.id, 'nombre', c.full_name, 'email', c.email, 'empresa', c.company,
               'motivo', case when v_email is not null and lower(btrim(c.email)) = v_email then 'mismo email'
                              when v_tel is not null and public.phone_last9(c.phone) = v_tel then 'mismo teléfono'
                              when v_dni is not null and upper(regexp_replace(coalesce(c.dni, ''), '[^A-Za-z0-9]', '', 'g')) = v_dni then 'mismo DNI'
                              else 'mismo nombre' end)
        from public.contactos c
       where (v_email is not null and lower(btrim(c.email)) = v_email)
          or (v_tel is not null and public.phone_last9(c.phone) = v_tel)
          or (v_dni is not null and upper(regexp_replace(coalesce(c.dni, ''), '[^A-Za-z0-9]', '', 'g')) = v_dni)
          or (v_nom is not null and char_length(v_nom) >= 3 and public.agente_norm(c.full_name) = v_nom)
      limit 10
    ) t;
    return v;
  end $f$;

  -- ===================== preparar (validar, normalizar, leer el estado actual) =====================
  -- Devuelve {datos, antes, coincidencias, resumen}. La interfaz y el modelo
  -- pasan por aquí; agente_confirmar la vuelve a llamar con lo editado.
  create function public.agente_preparar(p_tipo text, p_registro uuid, p_datos jsonb)
  returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
  declare
    d jsonb := coalesce(p_datos, '{}'::jsonb);
    o jsonb := '{}'::jsonb;              -- datos normalizados
    v_antes jsonb; v_coinc jsonb := '[]'::jsonb; v_res text; v_fila jsonb; v_emp jsonb;
    c_empresa constant text[] := array['razon_social', 'cif', 'address', 'city', 'province', 'empleados'];
    c_contacto constant text[] := array['full_name', 'email', 'phone', 'dni', 'city', 'province', 'employees', 'lifecycle',
                                        'priority', 'owner', 'source', 'kyc'];
    c_deal constant text[] := array['title', 'contact_id', 'empresa_id', 'service', 'stage', 'owner', 'amount', 'frequency',
                                    'priority', 'loss_reason', 'signed_at', 'renewal_at', 'num_nominas', 'coste_nomina'];
    c_tarea constant text[] := array['title', 'assigned_to', 'due_at', 'contact_id', 'deal_id', 'status', 'archived'];
    e_ciclo constant text[] := array['new', 'opportunity', 'proposal', 'active_client', 'lost'];
    e_prio constant text[] := array['high', 'medium', 'low'];
    e_serv constant text[] := array['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
    e_etapa constant text[] := array['nueva_solicitud', 'contactado', 'reunion', 'propuesta', 'negociacion', 'cliente_activo', 'perdido'];
    e_frec constant text[] := array['mensual', 'anual', 'puntual'];
    e_motivo constant text[] := array['no_contesta', 'precio_alto', 'contratado_otro', 'no_interesado', 'fuera_perfil', 'gestiona_interno'];
    k text; v text;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    if jsonb_typeof(d) <> 'object' then raise exception 'Los datos tienen que ser un objeto' using errcode = '22023'; end if;
    if p_tipo like 'crear_%' and p_registro is not null then raise exception 'Para crear no se pasa id' using errcode = '22023'; end if;
    if p_tipo not like 'crear_%' and p_registro is null then raise exception 'Falta el id del registro' using errcode = '22023'; end if;

    -- ---------- empresas ----------
    if p_tipo in ('crear_empresa', 'modificar_empresa') then
      perform public.agente_claves(d, c_empresa);
      if p_tipo = 'modificar_empresa' then
        select to_jsonb(e) into v_fila from public.empresas e where e.id = p_registro;
        if v_fila is null then raise exception 'La empresa no existe o no tienes acceso' using errcode = 'GU010'; end if;
        if d = '{}'::jsonb then raise exception 'No hay ningún cambio' using errcode = '22023'; end if;
      end if;
      foreach k in array c_empresa loop
        continue when not (d ? k);
        o := o || jsonb_build_object(k, case k
          when 'razon_social' then to_jsonb(public.agente_txt(d, k, 200))
          when 'cif' then to_jsonb(upper(replace(public.agente_txt(d, k, 20), ' ', '')))
          when 'address' then to_jsonb(public.agente_txt(d, k, 300))
          when 'empleados' then to_jsonb(public.agente_num(d, k, true, 1000000))
          else to_jsonb(public.agente_txt(d, k, 100)) end);
      end loop;
      if (p_tipo = 'crear_empresa' or o ? 'razon_social') and coalesce(o ->> 'razon_social', '') = '' then
        raise exception 'La empresa necesita una razón social' using errcode = '22023';
      end if;
      if p_tipo = 'crear_empresa' then
        v_coinc := public.agente_buscar_duplicados(p_razon_social => o ->> 'razon_social', p_cif => o ->> 'cif');
        v_res := 'Crear la empresa «' || (o ->> 'razon_social') || '»';
      else
        select jsonb_object_agg(x.key, v_fila -> x.key) into v_antes from jsonb_object_keys(o) x(key);
        v_res := 'Modificar la empresa «' || (v_fila ->> 'razon_social') || '»';
      end if;

    -- ---------- contactos ----------
    elsif p_tipo in ('crear_contacto', 'modificar_contacto') then
      perform public.agente_claves(d, c_contacto || case when p_tipo = 'crear_contacto' then array['empresa_id', 'nueva_empresa'] else '{}'::text[] end);
      if p_tipo = 'modificar_contacto' then
        select to_jsonb(c) into v_fila from public.contactos c where c.id = p_registro;
        if v_fila is null then raise exception 'El contacto no existe o no tienes acceso' using errcode = 'GU010'; end if;
        if d = '{}'::jsonb then raise exception 'No hay ningún cambio' using errcode = '22023'; end if;
      end if;
      foreach k in array c_contacto loop
        continue when not (d ? k);
        o := o || jsonb_build_object(k, case k
          when 'full_name' then to_jsonb(public.agente_txt(d, k, 200))
          when 'email' then to_jsonb(lower(public.agente_txt(d, k, 254)))
          when 'phone' then to_jsonb(public.agente_txt(d, k, 40))
          when 'dni' then to_jsonb(upper(replace(public.agente_txt(d, k, 20), ' ', '')))
          when 'employees' then to_jsonb(public.agente_num(d, k, true, 1000000))
          when 'lifecycle' then to_jsonb(public.agente_enum(d, k, e_ciclo))
          when 'priority' then to_jsonb(public.agente_enum(d, k, e_prio))
          when 'owner' then to_jsonb(public.agente_usuario_crm(d, k))
          when 'kyc' then to_jsonb(coalesce(public.agente_bool(d, k), false))
          else to_jsonb(public.agente_txt(d, k, 100)) end);
      end loop;
      if o ->> 'email' is not null and o ->> 'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception '"email" no es una dirección válida' using errcode = '22023';
      end if;
      if (p_tipo = 'crear_contacto' or o ? 'full_name') and coalesce(o ->> 'full_name', '') = '' then
        raise exception 'El contacto necesita un nombre' using errcode = '22023';
      end if;
      if p_tipo = 'crear_contacto' then
        if o ? 'lifecycle' and o ->> 'lifecycle' is null then o := o - 'lifecycle'; end if;
        -- Todo contacto pertenece a una empresa: una existente o una nueva.
        if (d ? 'empresa_id' and jsonb_typeof(d -> 'empresa_id') <> 'null') = (d ? 'nueva_empresa' and jsonb_typeof(d -> 'nueva_empresa') <> 'null') then
          raise exception 'Indica la empresa del contacto: empresa_id de una existente o nueva_empresa, una de las dos' using errcode = '22023';
        end if;
        if d ? 'empresa_id' and jsonb_typeof(d -> 'empresa_id') <> 'null' then
          o := o || jsonb_build_object('empresa_id', public.agente_uuid(d, 'empresa_id'));
          select jsonb_build_object('id', e.id, 'razon_social', e.razon_social) into v_emp from public.empresas e where e.id = (o ->> 'empresa_id')::uuid;
          if v_emp is null then raise exception 'La empresa del contacto no existe o no tienes acceso' using errcode = 'GU010'; end if;
          v_antes := jsonb_build_object('empresa', v_emp);
        else
          if jsonb_typeof(d -> 'nueva_empresa') <> 'object' then raise exception '"nueva_empresa" tiene que ser un objeto' using errcode = '22023'; end if;
          v_emp := public.agente_preparar('crear_empresa', null, d -> 'nueva_empresa');
          o := o || jsonb_build_object('nueva_empresa', v_emp -> 'datos');
          v_coinc := v_coinc || (v_emp -> 'coincidencias');
        end if;
        v_coinc := v_coinc || public.agente_buscar_duplicados(p_full_name => o ->> 'full_name', p_email => o ->> 'email',
                                                              p_phone => o ->> 'phone', p_dni => o ->> 'dni');
        v_res := 'Crear el contacto «' || (o ->> 'full_name') || '» en '
                 || coalesce('«' || (v_antes #>> '{empresa,razon_social}') || '»', 'la nueva empresa «' || (o #>> '{nueva_empresa,razon_social}') || '»');
      else
        select jsonb_object_agg(x.key, v_fila -> x.key) into v_antes from jsonb_object_keys(o) x(key);
        v_res := 'Modificar el contacto «' || coalesce(v_fila ->> 'full_name', '(sin nombre)') || '»';
      end if;

    -- ---------- contacto ↔ empresa ----------
    elsif p_tipo in ('vincular_empresa', 'desvincular_empresa') then
      perform public.agente_claves(d, case when p_tipo = 'vincular_empresa' then array['empresa_id', 'principal'] else array['empresa_id'] end);
      select to_jsonb(c) into v_fila from public.contactos c where c.id = p_registro;
      if v_fila is null then raise exception 'El contacto no existe o no tienes acceso' using errcode = 'GU010'; end if;
      o := jsonb_build_object('empresa_id', public.agente_uuid(d, 'empresa_id'));
      if o ->> 'empresa_id' is null then raise exception 'Falta "empresa_id"' using errcode = '22023'; end if;
      select jsonb_build_object('id', e.id, 'razon_social', e.razon_social) into v_emp from public.empresas e where e.id = (o ->> 'empresa_id')::uuid;
      if v_emp is null then raise exception 'La empresa no existe o no tienes acceso' using errcode = 'GU010'; end if;
      select jsonb_build_object('empresas', coalesce(jsonb_agg(jsonb_build_object('empresa_id', ce.empresa_id, 'razon_social', e.razon_social,
                                                                                 'principal', ce.principal) order by ce.principal desc, ce.created_at), '[]'::jsonb))
        into v_antes from public.contacto_empresa ce join public.empresas e on e.id = ce.empresa_id where ce.contact_id = p_registro;
      if p_tipo = 'vincular_empresa' then
        o := o || jsonb_build_object('principal', coalesce(public.agente_bool(d, 'principal'), false));
        if exists (select 1 from public.contacto_empresa ce where ce.contact_id = p_registro and ce.empresa_id = (o ->> 'empresa_id')::uuid
                    and (ce.principal or not (o ->> 'principal')::boolean)) then
          raise exception 'Ese contacto ya está en esa empresa%', case when (o ->> 'principal')::boolean then ' como principal' else '' end using errcode = '22023';
        end if;
        v_res := case when (o ->> 'principal')::boolean then 'Poner «' || (v_emp ->> 'razon_social') || '» como empresa principal de «'
                      else 'Añadir «' || (v_emp ->> 'razon_social') || '» a las empresas de «' end || coalesce(v_fila ->> 'full_name', '') || '»';
      else
        if not exists (select 1 from public.contacto_empresa ce where ce.contact_id = p_registro and ce.empresa_id = (o ->> 'empresa_id')::uuid) then
          raise exception 'Ese contacto no está en esa empresa' using errcode = '22023';
        end if;
        if (select count(*) from public.contacto_empresa ce where ce.contact_id = p_registro) <= 1 then
          raise exception 'Un contacto debe tener al menos una empresa' using errcode = '22023';
        end if;
        v_res := 'Quitar «' || (v_emp ->> 'razon_social') || '» de las empresas de «' || coalesce(v_fila ->> 'full_name', '') || '»';
      end if;

    -- ---------- negocios ----------
    elsif p_tipo in ('crear_deal', 'modificar_deal') then
      perform public.agente_claves(d, c_deal);
      if p_tipo = 'modificar_deal' then
        select to_jsonb(x) into v_fila from public.deals x where x.id = p_registro;
        if v_fila is null then raise exception 'El negocio no existe o no tienes acceso' using errcode = 'GU010'; end if;
        if d = '{}'::jsonb then raise exception 'No hay ningún cambio' using errcode = '22023'; end if;
      end if;
      foreach k in array c_deal loop
        continue when not (d ? k);
        o := o || jsonb_build_object(k, case k
          when 'title' then to_jsonb(public.agente_txt(d, k, 200))
          when 'contact_id' then to_jsonb(public.agente_uuid(d, k))
          when 'empresa_id' then to_jsonb(public.agente_uuid(d, k))
          when 'service' then to_jsonb(public.agente_enum(d, k, e_serv))
          when 'stage' then to_jsonb(public.agente_enum(d, k, e_etapa))
          when 'owner' then to_jsonb(public.agente_usuario_crm(d, k))
          when 'amount' then to_jsonb(public.agente_num(d, k, false, 100000000))
          when 'frequency' then to_jsonb(public.agente_enum(d, k, e_frec))
          when 'priority' then to_jsonb(public.agente_enum(d, k, e_prio))
          when 'loss_reason' then to_jsonb(public.agente_enum(d, k, e_motivo))
          when 'signed_at' then to_jsonb(public.agente_dia(d, k))
          when 'renewal_at' then to_jsonb(public.agente_dia(d, k))
          when 'num_nominas' then to_jsonb(public.agente_num(d, k, true, 100000))
          when 'coste_nomina' then to_jsonb(public.agente_num(d, k, false, 1000000)) end);
      end loop;
      if p_tipo = 'crear_deal' then
        if coalesce(o ->> 'title', '') = '' then raise exception 'El negocio necesita un título' using errcode = '22023'; end if;
        if o ->> 'contact_id' is null then raise exception 'Un negocio necesita un contacto asociado (contact_id)' using errcode = '22023'; end if;
        if o ->> 'stage' is null then o := o || '{"stage": "reunion"}'; end if;
      elsif o ? 'contact_id' and o ->> 'contact_id' is null then
        raise exception 'Un negocio necesita un contacto asociado' using errcode = '22023';
      end if;
      if o ->> 'contact_id' is not null and not exists (select 1 from public.contactos c where c.id = (o ->> 'contact_id')::uuid) then
        raise exception 'El contacto del negocio no existe o no tienes acceso' using errcode = 'GU010';
      end if;
      if o ->> 'empresa_id' is not null and not exists (select 1 from public.empresas e where e.id = (o ->> 'empresa_id')::uuid) then
        raise exception 'La empresa del negocio no existe o no tienes acceso' using errcode = 'GU010';
      end if;
      if p_tipo = 'crear_deal' then
        v_res := 'Crear el negocio «' || (o ->> 'title') || '»';
      else
        select jsonb_object_agg(x.key, v_fila -> x.key) into v_antes from jsonb_object_keys(o) x(key);
        v_res := 'Modificar el negocio «' || coalesce(v_fila ->> 'title', '(sin título)') || '»';
      end if;

    -- ---------- tareas ----------
    elsif p_tipo in ('crear_tarea', 'modificar_tarea') then
      perform public.agente_claves(d, c_tarea);
      if p_tipo = 'modificar_tarea' then
        select to_jsonb(t) into v_fila from public.tareas t where t.id = p_registro;
        if v_fila is null then raise exception 'La tarea no existe o no tienes acceso' using errcode = 'GU010'; end if;
        if d = '{}'::jsonb then raise exception 'No hay ningún cambio' using errcode = '22023'; end if;
      end if;
      foreach k in array c_tarea loop
        continue when not (d ? k);
        o := o || jsonb_build_object(k, case k
          when 'title' then to_jsonb(public.agente_txt(d, k, 300))
          when 'assigned_to' then to_jsonb(public.agente_usuario_crm(d, k))
          when 'due_at' then to_jsonb(public.agente_momento(d, k))
          when 'contact_id' then to_jsonb(public.agente_uuid(d, k))
          when 'deal_id' then to_jsonb(public.agente_uuid(d, k))
          when 'status' then to_jsonb(public.agente_enum(d, k, array['pending', 'done']))
          when 'archived' then to_jsonb(coalesce(public.agente_bool(d, k), false)) end);
      end loop;
      if (p_tipo = 'crear_tarea' or o ? 'title') and coalesce(o ->> 'title', '') = '' then
        raise exception 'La tarea necesita un título' using errcode = '22023';
      end if;
      if o ->> 'contact_id' is not null and not exists (select 1 from public.contactos c where c.id = (o ->> 'contact_id')::uuid) then
        raise exception 'El contacto de la tarea no existe o no tienes acceso' using errcode = 'GU010';
      end if;
      if o ->> 'deal_id' is not null and not exists (select 1 from public.deals x where x.id = (o ->> 'deal_id')::uuid) then
        raise exception 'El negocio de la tarea no existe o no tienes acceso' using errcode = 'GU010';
      end if;
      -- Marcar como hecha también la archiva (como el botón de la interfaz).
      if o ->> 'status' = 'done' and not (o ? 'archived') then o := o || '{"archived": true}'; end if;
      if p_tipo = 'crear_tarea' then
        if o ->> 'status' is null then o := o || '{"status": "pending"}'; end if;
        v_res := 'Crear la tarea «' || (o ->> 'title') || '»';
      else
        select jsonb_object_agg(x.key, v_fila -> x.key) into v_antes from jsonb_object_keys(o) x(key);
        v_res := 'Modificar la tarea «' || (v_fila ->> 'title') || '»';
      end if;

    -- ---------- notas ----------
    elsif p_tipo = 'crear_nota' then
      perform public.agente_claves(d, array['body', 'contact_id', 'deal_id']);
      o := jsonb_build_object('body', public.agente_txt(d, 'body', 5000), 'contact_id', public.agente_uuid(d, 'contact_id'),
                              'deal_id', public.agente_uuid(d, 'deal_id'));
      -- La nota conserva los saltos de línea que escribió el usuario.
      if jsonb_typeof(d -> 'body') = 'string' then o := o || jsonb_build_object('body', nullif(btrim(d ->> 'body'), '')); end if;
      if o ->> 'body' is null then raise exception 'La nota no puede estar vacía' using errcode = '22023'; end if;
      if char_length(o ->> 'body') > 5000 then raise exception '"body": como mucho 5000 caracteres' using errcode = '22023'; end if;
      if o ->> 'contact_id' is null and o ->> 'deal_id' is null then
        raise exception 'La nota va en un contacto (contact_id) o en un negocio (deal_id)' using errcode = '22023';
      end if;
      if o ->> 'contact_id' is not null and not exists (select 1 from public.contactos c where c.id = (o ->> 'contact_id')::uuid) then
        raise exception 'El contacto de la nota no existe o no tienes acceso' using errcode = 'GU010';
      end if;
      if o ->> 'deal_id' is not null and not exists (select 1 from public.deals x where x.id = (o ->> 'deal_id')::uuid) then
        raise exception 'El negocio de la nota no existe o no tienes acceso' using errcode = 'GU010';
      end if;
      o := jsonb_strip_nulls(o);
      v_res := 'Añadir una nota';

    -- ---------- borrar ----------
    elsif p_tipo in ('borrar_contacto', 'borrar_deal', 'borrar_tarea', 'borrar_nota') then
      if d <> '{}'::jsonb then raise exception 'Para borrar no se pasan datos' using errcode = '22023'; end if;
      if p_tipo = 'borrar_contacto' then
        select jsonb_build_object('nombre', c.full_name, 'email', c.email, 'empresa', c.company,
                 'negocios_que_se_borran', (select count(*) from public.deals x where x.contact_id = c.id and x.empresa_id is null),
                 'negocios_que_se_quedan', (select count(*) from public.deals x where x.contact_id = c.id and x.empresa_id is not null),
                 'tareas', (select count(*) from public.tareas t where t.contact_id = c.id),
                 'notas', (select count(*) from public.notas n where n.contact_id = c.id),
                 'cuenta_area_cliente', c.auth_user_id is not null)
          into v_antes from public.contactos c where c.id = p_registro;
        v_res := 'Borrar el contacto «' || coalesce(v_antes ->> 'nombre', '') || '»';
      elsif p_tipo = 'borrar_deal' then
        select jsonb_build_object('titulo', x.title, 'etapa', x.stage, 'importe', x.amount, 'frecuencia', x.frequency,
                 'tareas', (select count(*) from public.tareas t where t.deal_id = x.id),
                 'notas', (select count(*) from public.notas n where n.deal_id = x.id))
          into v_antes from public.deals x where x.id = p_registro;
        v_res := 'Borrar el negocio «' || coalesce(v_antes ->> 'titulo', '') || '»';
      elsif p_tipo = 'borrar_tarea' then
        select jsonb_build_object('titulo', t.title, 'vence', t.due_at, 'estado', t.status) into v_antes from public.tareas t where t.id = p_registro;
        v_res := 'Borrar la tarea «' || coalesce(v_antes ->> 'titulo', '') || '»';
      else
        select jsonb_build_object('fecha', n.created_at, 'extracto', left(n.body, 200)) into v_antes from public.notas n where n.id = p_registro;
        v_res := 'Borrar una nota';
      end if;
      if v_antes is null then raise exception 'No existe o no tienes acceso' using errcode = 'GU010'; end if;
    else
      raise exception 'Tipo de cambio no válido: %', p_tipo using errcode = '22023';
    end if;

    return jsonb_build_object('datos', o, 'antes', v_antes, 'coincidencias', v_coinc, 'resumen', left(v_res, 300));
  end $f$;

  -- ===================== proponer (lo llama el agente; no escribe en el CRM) =====================
  create function public.agente_proponer(p_conversacion uuid, p_tool_use_id text, p_tipo text, p_registro uuid, p_datos jsonb)
  returns jsonb language plpgsql volatile set search_path = public, pg_temp as $f$
  declare v jsonb; v_id uuid; v_exp timestamptz;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    if not exists (select 1 from public.agente_conversaciones c where c.id = p_conversacion and c.auth_user_id = auth.uid()) then
      raise exception 'Conversación no válida' using errcode = '42501';
    end if;
    v := public.agente_preparar(p_tipo, p_registro, p_datos);
    insert into public.agente_propuestas (conversacion_id, tool_use_id, tipo, registro_id, datos, antes, coincidencias, resumen)
    values (p_conversacion, p_tool_use_id, p_tipo, p_registro, v -> 'datos', v -> 'antes', v -> 'coincidencias', v ->> 'resumen')
    returning id, expira_at into v_id, v_exp;
    return v || jsonb_build_object('id', v_id, 'tipo', p_tipo, 'estado', 'pendiente', 'expira_at', v_exp,
                                   'confirmacion', case when p_tipo like 'borrar_%' then 'BORRAR' end);
  end $f$;

  -- ===================== confirmar (lo llama el CRM al pulsar Confirmar) =====================
  create function public.agente_confirmar(p_propuesta uuid, p_datos jsonb default null, p_texto text default null)
  returns jsonb language plpgsql volatile set search_path = public, pg_temp as $f$
  declare
    p public.agente_propuestas%rowtype; v jsonb; d jsonb; v_id uuid; v_emp uuid; v_tabla text; v_admin text;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    select * into p from public.agente_propuestas x where x.id = p_propuesta and x.auth_user_id = auth.uid();
    if not found then raise exception 'La propuesta no existe o no es tuya' using errcode = 'GU010'; end if;
    if p.estado <> 'pendiente' then raise exception 'Esta propuesta ya está %', p.estado using errcode = '22023'; end if;
    -- Bloqueo: dos clics a la vez no escriben dos veces.
    select * into p from public.agente_propuestas x where x.id = p_propuesta and x.estado = 'pendiente' for update;
    if not found then raise exception 'Esta propuesta ya está resuelta' using errcode = '22023'; end if;
    if p.expira_at < now() then raise exception 'La propuesta ha caducado: pídesela otra vez al asistente' using errcode = '22023'; end if;
    if p.tipo like 'borrar_%' and upper(btrim(coalesce(p_texto, ''))) <> 'BORRAR' then
      raise exception 'Para borrar hay que escribir BORRAR' using errcode = '22023';
    end if;
    -- Lo que se escribe se valida otra vez (con lo editado, si lo hay) y con el estado de ahora.
    v := public.agente_preparar(p.tipo, p.registro_id, coalesce(p_datos, p.datos));
    d := v -> 'datos';

    if p.tipo = 'crear_empresa' then
      insert into public.empresas (razon_social, cif, address, city, province, empleados)
      values (d ->> 'razon_social', d ->> 'cif', d ->> 'address', d ->> 'city', d ->> 'province', (d ->> 'empleados')::int)
      returning id into v_id;
      v_tabla := 'empresas';
    elsif p.tipo = 'modificar_empresa' then
      update public.empresas e set
        razon_social = case when d ? 'razon_social' then d ->> 'razon_social' else e.razon_social end,
        cif = case when d ? 'cif' then d ->> 'cif' else e.cif end,
        address = case when d ? 'address' then d ->> 'address' else e.address end,
        city = case when d ? 'city' then d ->> 'city' else e.city end,
        province = case when d ? 'province' then d ->> 'province' else e.province end,
        empleados = case when d ? 'empleados' then (d ->> 'empleados')::int else e.empleados end
      where e.id = p.registro_id returning e.id into v_id;
      v_tabla := 'empresas';
    elsif p.tipo = 'crear_contacto' then
      if d ? 'nueva_empresa' then
        insert into public.empresas (razon_social, cif, address, city, province, empleados)
        values (d #>> '{nueva_empresa,razon_social}', d #>> '{nueva_empresa,cif}', d #>> '{nueva_empresa,address}',
                d #>> '{nueva_empresa,city}', d #>> '{nueva_empresa,province}', (d #>> '{nueva_empresa,empleados}')::int)
        returning id into v_emp;
        insert into public.agente_escrituras (propuesta_id, accion, tabla, registro_id) values (p.id, 'crear_empresa', 'empresas', v_emp);
      else
        v_emp := (d ->> 'empresa_id')::uuid;
      end if;
      insert into public.contactos (full_name, email, phone, dni, city, province, employees, lifecycle, priority, owner, source, kyc)
      values (d ->> 'full_name', d ->> 'email', d ->> 'phone', d ->> 'dni', d ->> 'city', d ->> 'province', (d ->> 'employees')::int,
              coalesce(d ->> 'lifecycle', 'new'), d ->> 'priority', d ->> 'owner', coalesce(d ->> 'source', 'Alta manual'),
              coalesce((d ->> 'kyc')::boolean, false))
      returning id into v_id;
      insert into public.contacto_empresa (contact_id, empresa_id, principal) values (v_id, v_emp, true);
      v_tabla := 'contactos';
    elsif p.tipo = 'modificar_contacto' then
      update public.contactos c set
        full_name = case when d ? 'full_name' then d ->> 'full_name' else c.full_name end,
        email = case when d ? 'email' then d ->> 'email' else c.email end,
        phone = case when d ? 'phone' then d ->> 'phone' else c.phone end,
        dni = case when d ? 'dni' then d ->> 'dni' else c.dni end,
        city = case when d ? 'city' then d ->> 'city' else c.city end,
        province = case when d ? 'province' then d ->> 'province' else c.province end,
        employees = case when d ? 'employees' then (d ->> 'employees')::int else c.employees end,
        lifecycle = case when d ? 'lifecycle' then coalesce(d ->> 'lifecycle', c.lifecycle) else c.lifecycle end,
        priority = case when d ? 'priority' then d ->> 'priority' else c.priority end,
        owner = case when d ? 'owner' then d ->> 'owner' else c.owner end,
        source = case when d ? 'source' then d ->> 'source' else c.source end,
        kyc = case when d ? 'kyc' then coalesce((d ->> 'kyc')::boolean, false) else c.kyc end
      where c.id = p.registro_id returning c.id into v_id;
      v_tabla := 'contactos';
    elsif p.tipo = 'vincular_empresa' then
      if (d ->> 'principal')::boolean then
        update public.contacto_empresa ce set principal = false where ce.contact_id = p.registro_id and ce.principal;
      end if;
      update public.contacto_empresa ce set principal = true
       where ce.contact_id = p.registro_id and ce.empresa_id = (d ->> 'empresa_id')::uuid and (d ->> 'principal')::boolean
       returning ce.id into v_id;
      if v_id is null then
        insert into public.contacto_empresa (contact_id, empresa_id, principal)
        values (p.registro_id, (d ->> 'empresa_id')::uuid, (d ->> 'principal')::boolean) returning id into v_id;
      end if;
      v_tabla := 'contacto_empresa';
    elsif p.tipo = 'desvincular_empresa' then
      delete from public.contacto_empresa ce where ce.contact_id = p.registro_id and ce.empresa_id = (d ->> 'empresa_id')::uuid
      returning ce.id into v_id;
      -- Si era la principal, pasa a serlo la más antigua de las que quedan.
      if not exists (select 1 from public.contacto_empresa ce where ce.contact_id = p.registro_id and ce.principal) then
        update public.contacto_empresa ce set principal = true
         where ce.id = (select x.id from public.contacto_empresa x where x.contact_id = p.registro_id order by x.created_at limit 1);
      end if;
      v_tabla := 'contacto_empresa';
    elsif p.tipo = 'crear_deal' then
      insert into public.deals (title, contact_id, empresa_id, service, stage, owner, amount, frequency, priority, loss_reason,
                                signed_at, renewal_at, num_nominas, coste_nomina)
      values (d ->> 'title', (d ->> 'contact_id')::uuid, (d ->> 'empresa_id')::uuid, d ->> 'service', d ->> 'stage', d ->> 'owner',
              (d ->> 'amount')::numeric, d ->> 'frequency', d ->> 'priority', d ->> 'loss_reason', (d ->> 'signed_at')::date,
              (d ->> 'renewal_at')::date, (d ->> 'num_nominas')::int, (d ->> 'coste_nomina')::numeric)
      returning id into v_id;
      v_tabla := 'deals';
    elsif p.tipo = 'modificar_deal' then
      update public.deals x set
        title = case when d ? 'title' then d ->> 'title' else x.title end,
        contact_id = case when d ? 'contact_id' then (d ->> 'contact_id')::uuid else x.contact_id end,
        empresa_id = case when d ? 'empresa_id' then (d ->> 'empresa_id')::uuid else x.empresa_id end,
        service = case when d ? 'service' then d ->> 'service' else x.service end,
        stage = case when d ? 'stage' then coalesce(d ->> 'stage', x.stage) else x.stage end,
        owner = case when d ? 'owner' then d ->> 'owner' else x.owner end,
        amount = case when d ? 'amount' then (d ->> 'amount')::numeric else x.amount end,
        frequency = case when d ? 'frequency' then d ->> 'frequency' else x.frequency end,
        priority = case when d ? 'priority' then d ->> 'priority' else x.priority end,
        loss_reason = case when d ? 'loss_reason' then d ->> 'loss_reason' else x.loss_reason end,
        signed_at = case when d ? 'signed_at' then (d ->> 'signed_at')::date else x.signed_at end,
        renewal_at = case when d ? 'renewal_at' then (d ->> 'renewal_at')::date else x.renewal_at end,
        num_nominas = case when d ? 'num_nominas' then (d ->> 'num_nominas')::int else x.num_nominas end,
        coste_nomina = case when d ? 'coste_nomina' then (d ->> 'coste_nomina')::numeric else x.coste_nomina end
      where x.id = p.registro_id returning x.id into v_id;
      v_tabla := 'deals';
    elsif p.tipo = 'crear_tarea' then
      insert into public.tareas (title, assigned_to, due_at, contact_id, deal_id, status, archived)
      values (d ->> 'title', d ->> 'assigned_to', (d ->> 'due_at')::timestamptz, (d ->> 'contact_id')::uuid, (d ->> 'deal_id')::uuid,
              coalesce(d ->> 'status', 'pending'), coalesce((d ->> 'archived')::boolean, false))
      returning id into v_id;
      v_tabla := 'tareas';
    elsif p.tipo = 'modificar_tarea' then
      update public.tareas t set
        title = case when d ? 'title' then d ->> 'title' else t.title end,
        assigned_to = case when d ? 'assigned_to' then d ->> 'assigned_to' else t.assigned_to end,
        due_at = case when d ? 'due_at' then (d ->> 'due_at')::timestamptz else t.due_at end,
        contact_id = case when d ? 'contact_id' then (d ->> 'contact_id')::uuid else t.contact_id end,
        deal_id = case when d ? 'deal_id' then (d ->> 'deal_id')::uuid else t.deal_id end,
        status = case when d ? 'status' then coalesce(d ->> 'status', t.status) else t.status end,
        archived = case when d ? 'archived' then coalesce((d ->> 'archived')::boolean, false) else t.archived end
      where t.id = p.registro_id returning t.id into v_id;
      v_tabla := 'tareas';
    elsif p.tipo = 'crear_nota' then
      select a.id::text into v_admin from public.admins a where a.auth_user_id = auth.uid();
      insert into public.notas (body, author, contact_id, deal_id)
      values (d ->> 'body', v_admin, (d ->> 'contact_id')::uuid, (d ->> 'deal_id')::uuid) returning id into v_id;
      v_tabla := 'notas';
    elsif p.tipo = 'borrar_contacto' then
      select c.lead_id into v_emp from public.contactos c where c.id = p.registro_id;
      perform public.admin_borrar_contacto(p.registro_id);
      -- Como la interfaz: si venía de un lead, el lead queda borrado para que no se vuelva a convertir.
      if v_emp is not null then update public.leads l set status = 'deleted' where l.id = v_emp; end if;
      v_emp := null;
      v_id := p.registro_id; v_tabla := 'contactos';
    elsif p.tipo = 'borrar_deal' then
      delete from public.deals x where x.id = p.registro_id returning x.id into v_id;
      v_tabla := 'deals';
    elsif p.tipo = 'borrar_tarea' then
      delete from public.tareas t where t.id = p.registro_id returning t.id into v_id;
      v_tabla := 'tareas';
    elsif p.tipo = 'borrar_nota' then
      delete from public.notas n where n.id = p.registro_id returning n.id into v_id;
      v_tabla := 'notas';
    end if;
    if v_id is null then raise exception 'No se ha podido escribir: no tienes permiso o el registro ya no existe' using errcode = '42501'; end if;

    insert into public.agente_escrituras (propuesta_id, accion, tabla, registro_id) values (p.id, p.tipo, v_tabla, v_id);
    update public.agente_propuestas x set estado = 'confirmada', resuelta_at = now(), datos = d, resultado_id = v_id
     where x.id = p.id;
    return jsonb_build_object('ok', true, 'id', p.id, 'tipo', p.tipo, 'tabla', v_tabla, 'registro_id', v_id,
                              'empresa_id', v_emp, 'contact_id', case when p.tipo in ('vincular_empresa', 'desvincular_empresa') then p.registro_id end);
  end $f$;

  create function public.agente_cancelar(p_propuesta uuid)
  returns jsonb language plpgsql volatile set search_path = public, pg_temp as $f$
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    update public.agente_propuestas x set estado = 'cancelada', resuelta_at = now()
     where x.id = p_propuesta and x.auth_user_id = auth.uid() and x.estado = 'pendiente';
    if not found then raise exception 'La propuesta no existe, no es tuya o ya está resuelta' using errcode = 'GU010'; end if;
    return jsonb_build_object('ok', true, 'id', p_propuesta, 'estado', 'cancelada');
  end $f$;

  -- ===================== permisos =====================
  revoke execute on function public.agente_txt(jsonb, text, integer), public.agente_num(jsonb, text, boolean, numeric),
    public.agente_uuid(jsonb, text), public.agente_enum(jsonb, text, text[]), public.agente_bool(jsonb, text),
    public.agente_claves(jsonb, text[]), public.agente_usuario_crm(jsonb, text), public.agente_momento(jsonb, text),
    public.agente_dia(jsonb, text), public.agente_buscar_duplicados(text, text, text, text, text, text),
    public.agente_preparar(text, uuid, jsonb), public.agente_proponer(uuid, text, text, uuid, jsonb),
    public.agente_confirmar(uuid, jsonb, text), public.agente_cancelar(uuid) from public, anon;
  grant execute on function public.agente_txt(jsonb, text, integer), public.agente_num(jsonb, text, boolean, numeric),
    public.agente_uuid(jsonb, text), public.agente_enum(jsonb, text, text[]), public.agente_bool(jsonb, text),
    public.agente_claves(jsonb, text[]), public.agente_usuario_crm(jsonb, text), public.agente_momento(jsonb, text),
    public.agente_dia(jsonb, text), public.agente_buscar_duplicados(text, text, text, text, text, text),
    public.agente_preparar(text, uuid, jsonb), public.agente_proponer(uuid, text, text, uuid, jsonb),
    public.agente_confirmar(uuid, jsonb, text), public.agente_cancelar(uuid) to authenticated;

  insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261128100000', 'Agente: escrituras en el CRM con confirmación (crm/supabase-agente-escritura.sql)', array[]::text[]);
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 10C (verificación, solo lectura) — Lo esperado:
--   tablas con RLS: 2      políticas: 5
--   funciones agente_* nuevas (invoker): 14     con EXECUTE para anon: 0
--   authenticated propuestas s/i/u/d: true/true/true/false
--   authenticated escrituras s/i/u/d: true/true/false/false
--   filas propuestas/escrituras: 0/0
--   migración registrada: 20261128100000 …
-- ============================================================
select 'tablas con RLS' as comprobacion,
       (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace
          and relname in ('agente_propuestas', 'agente_escrituras') and relrowsecurity) as valor
union all select 'políticas',
       (select count(*)::text from pg_policies where schemaname = 'public' and tablename in ('agente_propuestas', 'agente_escrituras'))
union all select 'funciones agente_* nuevas (invoker)',
       (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and not prosecdef
          and proname in ('agente_txt', 'agente_num', 'agente_uuid', 'agente_enum', 'agente_bool', 'agente_claves', 'agente_usuario_crm',
                          'agente_momento', 'agente_dia', 'agente_buscar_duplicados', 'agente_preparar', 'agente_proponer',
                          'agente_confirmar', 'agente_cancelar'))
union all select 'con EXECUTE para anon',
       (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace
          and proname in ('agente_txt', 'agente_num', 'agente_uuid', 'agente_enum', 'agente_bool', 'agente_claves', 'agente_usuario_crm',
                          'agente_momento', 'agente_dia', 'agente_buscar_duplicados', 'agente_preparar', 'agente_proponer',
                          'agente_confirmar', 'agente_cancelar')
          and has_function_privilege('anon', oid, 'execute'))
union all select 'authenticated propuestas s/i/u/d',
       has_table_privilege('authenticated', 'public.agente_propuestas', 'select')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_propuestas', 'insert')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_propuestas', 'update')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_propuestas', 'delete')::text
union all select 'authenticated escrituras s/i/u/d',
       has_table_privilege('authenticated', 'public.agente_escrituras', 'select')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_escrituras', 'insert')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_escrituras', 'update')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_escrituras', 'delete')::text
union all select 'filas propuestas/escrituras',
       (select count(*)::text from public.agente_propuestas) || '/' || (select count(*)::text from public.agente_escrituras)
union all select 'migración registrada',
       (select version || ' ' || name from supabase_migrations.schema_migrations where version = '20261128100000');
