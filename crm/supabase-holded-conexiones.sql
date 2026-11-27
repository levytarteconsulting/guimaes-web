-- ============================================================
-- GUIMAES — Holded, bloque 1: conexiones por empresa (claves en Vault)
--
--   * holded_conexiones: una por empresa. La clave NO está aquí: solo la
--     referencia al secreto de Supabase Vault (secreto_id) y sus 4 últimos
--     caracteres. authenticated ve el estado (RLS is_admin()) pero no la
--     columna secreto_id; la clave en claro solo la lee holded_clave_de(),
--     que solo puede ejecutar service_role (las Edge Functions).
--   * holded_cargas: claves de una vista previa todavía sin confirmar (ya
--     en Vault), que caducan a la hora. Sin acceso para authenticated.
--   * Borrar una conexión o una carga (revocar, reemplazar, borrar la
--     empresa, deshacer el lote, caducar) borra su secreto de Vault: trigger
--     holded_borrar_secreto.
--   * Funciones para la Edge Function holded-conexiones (solo service_role,
--     y además comprueban que p_usuario tiene rol admin):
--       holded_previsualizar, holded_confirmar, holded_para_verificar,
--       holded_clave_de, holded_marcar_verificacion.
--     Para el CRM (authenticated, rol admin): holded_revocar.
--   * Empresas creadas desde el archivo: un lote de public.importaciones
--     (se deshace con admin_deshacer_importacion), visto_at = now().
--   * pg_cron: holded-limpiar-cargas, cada hora, borra cargas caducadas.
--
-- Migración 20261127140000. Ejecutar en orden 6A → 6B → 6C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/holded).
-- ============================================================


-- ============================================================
-- 6A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127140000: no
--   tablas holded_*: 0          funciones holded_*: 0
--   vault.create_secret: 1      tabla importaciones: 1
--   funciones base (is_admin, is_admin_role, agente_norm, set_updated_at): 4
--   pg_cron: 1                  tarea holded-limpiar-cargas: 0
--   secretos en Vault: (anotar, para compararlo con 6C)
-- ============================================================
select 'migración 20261127140000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127140000')
            then 'sí' else 'no' end as valor
union all
select 'tablas holded_*', count(*)::text from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('holded_conexiones', 'holded_cargas')
union all
select 'funciones holded_*', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace and proname like 'holded\_%'
union all
select 'vault.create_secret', count(*)::text from pg_proc
 where pronamespace = to_regnamespace('vault') and proname = 'create_secret'
union all
select 'tabla importaciones', count(*)::text from pg_class
 where relnamespace = 'public'::regnamespace and relname = 'importaciones'
union all
select 'funciones base (is_admin, is_admin_role, agente_norm, set_updated_at)', count(distinct proname)::text from pg_proc
 where pronamespace = 'public'::regnamespace and proname in ('is_admin', 'is_admin_role', 'agente_norm', 'set_updated_at')
union all
select 'pg_cron', count(*)::text from pg_namespace where nspname = 'cron'
union all
select 'tarea holded-limpiar-cargas', (select count(*)::text from cron.job where jobname = 'holded-limpiar-cargas')
union all
select 'secretos en Vault', count(*)::text from vault.secrets;


-- ============================================================
-- 6B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261127140000')
     or to_regclass('public.holded_conexiones') is not null
     or to_regclass('public.holded_cargas') is not null then
    raise exception 'La migración 20261127140000 (Holded, conexiones) ya está aplicada: 6B no se repite. No se ha cambiado nada.';
  end if;
  if to_regclass('public.importaciones') is null then
    raise exception 'Falta public.importaciones (migración del importador): no se toca nada.';
  end if;

  -- ===================== normalización =====================
  -- NIF: mayúsculas, solo letras y dígitos, sin el prefijo ES del NIF-IVA.
  create function public.holded_norm_nif(p text)
  returns text
  language sql
  immutable
  set search_path = public, pg_temp
  as $f$
    select nullif(case when v ~ '^ES[A-Z0-9]{9}$' then substr(v, 3) else v end, '')
      from (select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) as v) s
  $f$;

  -- Nombre: sin tildes ni mayúsculas, sin puntos ni comas, espacios
  -- simples y sin la forma jurídica final SL / S.L. / SLU / S.L.U.
  create function public.holded_norm_nombre(p text)
  returns text
  language sql
  immutable
  set search_path = public, pg_temp
  as $f$
    select nullif(btrim(regexp_replace(
             btrim(regexp_replace(regexp_replace(public.agente_norm(p), '[.,]', '', 'g'), '\s+', ' ', 'g')),
             '\s(slu|sl|s l u|s l)$', '')), '')
  $f$;

  -- ===================== tablas =====================
  create table public.holded_conexiones (
    empresa_id    uuid primary key references public.empresas(id) on delete cascade,
    subdominio    text check (subdominio is null or length(subdominio) <= 100),
    secreto_id    uuid not null unique,               -- vault.secrets.id
    ultimos4      text not null check (length(ultimos4) = 4),
    estado        text not null default 'pendiente' check (estado in ('pendiente', 'ok', 'error')),
    ultimo_error  text check (ultimo_error is null or length(ultimo_error) <= 300),
    permisos      jsonb not null default '{}'::jsonb, -- {"facturas": true, "compras": false, ...}
    nif_coincide  boolean,                            -- NIF de la cuenta de Holded = CIF de la empresa
    uso_holded    jsonb,                              -- {"periodo", "usadas", "limite"} de /usage
    verificada_at timestamptz,
    creada_por    uuid,                               -- auth.uid() de quien la cargó
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
  );
  comment on table public.holded_conexiones is
    'Conexión con Holded de cada empresa (crm/supabase-holded-conexiones.sql). La clave está en Vault; aquí solo su referencia.';
  create trigger holded_conexiones_set_updated_at before update on public.holded_conexiones
    for each row execute function public.set_updated_at();
  alter table public.holded_conexiones enable row level security;
  create policy "equipo ve el estado de Holded" on public.holded_conexiones
    for select to authenticated using ((select public.is_admin()));
  revoke all on public.holded_conexiones from anon, authenticated;
  grant select (empresa_id, subdominio, ultimos4, estado, ultimo_error, permisos, nif_coincide, uso_holded,
                verificada_at, creada_por, created_at, updated_at)
    on public.holded_conexiones to authenticated;

  create table public.holded_cargas (
    id          uuid primary key default gen_random_uuid(),
    carga       uuid not null,
    fila        integer not null,
    cliente     text,
    nif         text,
    subdominio  text,
    secreto_id  uuid unique,                          -- null cuando pasa a holded_conexiones
    ultimos4    text not null,
    creada_por  uuid not null,
    expira_at   timestamptz not null default now() + interval '1 hour',
    unique (carga, fila)
  );
  comment on table public.holded_cargas is
    'Vista previa de Holded sin confirmar: secretos ya en Vault que caducan a la hora (holded_limpiar_cargas).';
  alter table public.holded_cargas enable row level security;   -- sin políticas: solo las funciones
  revoke all on public.holded_cargas from anon, authenticated;

  -- ===================== secretos de Vault =====================
  create function public.holded_borrar_secreto()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if tg_op = 'DELETE' then
      if old.secreto_id is not null then
        delete from vault.secrets where id = old.secreto_id;
      end if;
      return old;
    end if;
    -- UPDATE en holded_conexiones: clave reemplazada → fuera la anterior.
    if old.secreto_id is distinct from new.secreto_id and old.secreto_id is not null then
      delete from vault.secrets where id = old.secreto_id;
    end if;
    return new;
  end;
  $f$;
  revoke all on function public.holded_borrar_secreto() from public, anon, authenticated, service_role;
  create trigger holded_conexiones_borrar_secreto
    after delete or update of secreto_id on public.holded_conexiones
    for each row execute function public.holded_borrar_secreto();
  create trigger holded_cargas_borrar_secreto
    after delete on public.holded_cargas
    for each row execute function public.holded_borrar_secreto();

  create function public.holded_limpiar_cargas()
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_n int;
  begin
    delete from public.holded_cargas where expira_at < now();
    get diagnostics v_n = row_count;
    return v_n;
  end;
  $f$;
  revoke all on function public.holded_limpiar_cargas() from public, anon, authenticated, service_role;

  -- ===================== vista previa =====================
  -- p_filas: [{fila, cliente, nif, subdominio, clave}] (lo lee la Edge
  -- Function del archivo). Guarda cada clave válida en Vault como carga
  -- provisional y propone empresa: por NIF; si no, por nombre normalizado.
  -- Devuelve las filas SIN clave (solo los 4 últimos caracteres).
  create function public.holded_previsualizar(p_usuario uuid, p_filas jsonb)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_carga uuid := gen_random_uuid();
    v_expira timestamptz := now() + interval '1 hour';
    r record;
    v_fila int; v_cliente text; v_nif text; v_sub text; v_clave text; v_u4 text;
    v_errores text[]; v_avisos text[];
    v_nifn text; v_nomn text;
    v_ids uuid[]; v_emp uuid; v_via text; v_crear boolean;
    v_vistas_clave text[] := '{}'; v_vistas_emp uuid[] := '{}'; v_vistos_nom text[] := '{}';
    v_secreto uuid;
    v_con public.holded_conexiones%rowtype;
    v_e public.empresas%rowtype;
    v_out jsonb := '[]'::jsonb;
  begin
    if not public.is_admin_role(p_usuario) then
      raise exception 'Solo el rol admin puede cargar claves de Holded' using errcode = '42501';
    end if;
    if jsonb_typeof(p_filas) is distinct from 'array' or jsonb_array_length(p_filas) = 0 then
      raise exception 'El archivo no tiene filas' using errcode = '22023';
    end if;
    if jsonb_array_length(p_filas) > 500 then
      raise exception 'Como mucho 500 filas por archivo' using errcode = '22023';
    end if;
    perform public.holded_limpiar_cargas();

    for r in select x.value as v, x.ord from jsonb_array_elements(p_filas) with ordinality as x(value, ord) loop
      v_fila := coalesce(nullif(r.v->>'fila', '')::int, r.ord::int);
      v_cliente := nullif(btrim(regexp_replace(coalesce(r.v->>'cliente', ''), '\s+', ' ', 'g')), '');
      v_nif := nullif(btrim(coalesce(r.v->>'nif', '')), '');
      v_sub := nullif(btrim(coalesce(r.v->>'subdominio', '')), '');
      v_clave := btrim(coalesce(r.v->>'clave', ''));
      v_u4 := case when length(v_clave) >= 4 then right(v_clave, 4) else null end;
      v_errores := '{}'; v_avisos := '{}';
      v_emp := null; v_via := null; v_crear := false; v_secreto := null; v_ids := null;

      if v_clave = '' then
        v_errores := v_errores || 'Falta la clave'::text;
      elsif v_clave !~ '^pat_' then
        v_errores := v_errores || 'La clave no es de la API actual de Holded (debe empezar por pat_)'::text;
      elsif v_clave ~ '\s' or length(v_clave) < 20 or length(v_clave) > 500 then
        v_errores := v_errores || 'La clave tiene un formato extraño (espacios o longitud)'::text;
      elsif md5(v_clave) = any (v_vistas_clave) then
        v_errores := v_errores || 'Clave repetida en otra fila del archivo'::text;
      end if;
      if v_cliente is null and v_nif is null then
        v_errores := v_errores || 'Faltan el cliente y el NIF'::text;
      end if;
      if v_cliente is not null and length(v_cliente) > 200 then
        v_errores := v_errores || 'Nombre de cliente demasiado largo'::text;
      end if;
      if v_sub is not null and length(v_sub) > 100 then
        v_errores := v_errores || 'Subdominio demasiado largo'::text;
      end if;
      if v_clave <> '' then v_vistas_clave := v_vistas_clave || md5(v_clave); end if;

      -- ---------- empresa propuesta ----------
      v_nifn := public.holded_norm_nif(v_nif);
      v_nomn := public.holded_norm_nombre(v_cliente);
      if v_nifn is not null then
        select array_agg(e.id) into v_ids from public.empresas e where public.holded_norm_nif(e.cif) = v_nifn;
        if cardinality(v_ids) = 1 then v_emp := v_ids[1]; v_via := 'nif';
        elsif cardinality(v_ids) > 1 then v_avisos := v_avisos || 'Varias empresas del CRM tienen ese NIF: elige una'::text;
        end if;
      end if;
      if v_emp is null and coalesce(cardinality(v_ids), 0) <= 1 and v_nomn is not null then
        select array_agg(e.id) into v_ids from public.empresas e where public.holded_norm_nombre(e.razon_social) = v_nomn;
        if cardinality(v_ids) = 1 then
          v_emp := v_ids[1]; v_via := 'nombre';
          select * into v_e from public.empresas where id = v_emp;
          if v_nifn is not null and public.holded_norm_nif(v_e.cif) is not null then
            v_avisos := v_avisos || 'Casa por nombre, pero la empresa del CRM tiene otro CIF'::text;
          end if;
        elsif cardinality(v_ids) > 1 then
          v_avisos := v_avisos || 'Varias empresas del CRM se llaman así: elige una'::text;
        end if;
      end if;
      if v_emp is not null then
        select * into v_e from public.empresas where id = v_emp;
        if v_e.archived_at is not null then v_avisos := v_avisos || 'La empresa está archivada'::text; end if;
        if v_emp = any (v_vistas_emp) then
          v_avisos := v_avisos || 'Otra fila del archivo apunta a la misma empresa'::text;
        end if;
        v_vistas_emp := v_vistas_emp || v_emp;
      elsif coalesce(cardinality(v_ids), 0) = 0 then
        -- Sin coincidencia: se puede crear si hay nombre y no se repite en el archivo.
        if v_cliente is null then
          v_avisos := v_avisos || 'Sin nombre de cliente: no se puede crear la empresa'::text;
        elsif v_nomn = any (v_vistos_nom) then
          v_avisos := v_avisos || 'Otra fila del archivo crearía una empresa con el mismo nombre'::text;
        else
          v_crear := true;
          v_vistos_nom := v_vistos_nom || v_nomn;
          if v_nifn is null then v_avisos := v_avisos || 'NIF pendiente'::text; end if;
        end if;
      end if;

      -- ---------- clave a Vault (provisional) ----------
      if cardinality(v_errores) = 0 then
        v_secreto := vault.create_secret(v_clave, 'holded_carga_' || gen_random_uuid()::text,
                                         'GUIMAES Holded: carga provisional (caduca en 1 hora)');
        insert into public.holded_cargas (carga, fila, cliente, nif, subdominio, secreto_id, ultimos4, creada_por, expira_at)
        values (v_carga, v_fila, v_cliente, v_nif, v_sub, v_secreto, v_u4, p_usuario, v_expira);
      end if;
      v_clave := null;

      v_con := null;
      if v_emp is not null then
        select * into v_con from public.holded_conexiones where empresa_id = v_emp;
      end if;
      v_out := v_out || jsonb_build_object(
        'fila', v_fila, 'cliente', v_cliente, 'nif', v_nif, 'subdominio', v_sub, 'ultimos4', v_u4,
        'empresa_id', v_emp, 'empresa_nombre', case when v_emp is not null then v_e.razon_social end,
        'via', v_via, 'se_puede_crear', v_crear,
        'conexion_existente', case when v_con.empresa_id is not null then
           jsonb_build_object('estado', v_con.estado, 'ultimos4', v_con.ultimos4, 'verificada_at', v_con.verificada_at) end,
        'errores', to_jsonb(v_errores), 'avisos', to_jsonb(v_avisos));
    end loop;

    return jsonb_build_object('carga', v_carga, 'expira_at', v_expira, 'filas', v_out);
  end;
  $f$;
  revoke all on function public.holded_previsualizar(uuid, jsonb) from public, anon, authenticated, service_role;
  grant execute on function public.holded_previsualizar(uuid, jsonb) to service_role;

  -- ===================== confirmar =====================
  -- p_decisiones: [{fila, accion: 'conectar' | 'crear' | 'omitir',
  --                 empresa_id (conectar), reemplazar (bool)}].
  -- Todo o nada: si una decisión no es válida, no se guarda ninguna.
  -- Las filas sin decisión se omiten. La carga se borra al terminar (y con
  -- ella los secretos que no pasan a una conexión).
  create function public.holded_confirmar(p_usuario uuid, p_carga uuid, p_decisiones jsonb, p_archivo text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    c record;
    d jsonb;
    v_accion text; v_emp uuid; v_reemplazar boolean;
    v_nomn text; v_nifn text; v_cif text;
    v_problemas text[] := '{}';
    v_emps uuid[] := '{}'; v_noms text[] := '{}'; v_nifs text[] := '{}';
    v_lote uuid; v_ncrear int := 0;
    v_con public.holded_conexiones%rowtype;
    v_res text;
    v_out jsonb := '[]'::jsonb;
    v_verificar uuid[] := '{}';
  begin
    if not public.is_admin_role(p_usuario) then
      raise exception 'Solo el rol admin puede cargar claves de Holded' using errcode = '42501';
    end if;
    if p_decisiones is not null and jsonb_typeof(p_decisiones) <> 'array' then
      raise exception 'Decisiones no válidas' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext('guimaes_holded_conexiones'));
    if not exists (select 1 from public.holded_cargas
                    where carga = p_carga and creada_por = p_usuario and expira_at >= now()) then
      raise exception 'La vista previa ha caducado o no existe: vuelve a subir el archivo' using errcode = 'GU010';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_decisiones, '[]'::jsonb)) as x(value)
                where not exists (select 1 from public.holded_cargas h
                                   where h.carga = p_carga and h.fila = (x.value->>'fila')::int)) then
      raise exception 'Hay decisiones para filas que no están en la vista previa' using errcode = '22023';
    end if;

    -- ---------- 1) validar todo antes de escribir ----------
    for c in select * from public.holded_cargas where carga = p_carga order by fila loop
      d := null;
      select x.value into d from jsonb_array_elements(coalesce(p_decisiones, '[]'::jsonb)) as x(value)
       where (x.value->>'fila')::int = c.fila limit 1;
      v_accion := coalesce(d->>'accion', 'omitir');
      if v_accion = 'conectar' then
        v_emp := nullif(d->>'empresa_id', '')::uuid;
        if v_emp is null or not exists (select 1 from public.empresas where id = v_emp) then
          v_problemas := v_problemas || format('fila %s: la empresa elegida no existe', c.fila);
        elsif v_emp = any (v_emps) then
          v_problemas := v_problemas || format('fila %s: otra fila conecta la misma empresa', c.fila);
        elsif exists (select 1 from public.holded_conexiones where empresa_id = v_emp)
              and not coalesce((d->>'reemplazar')::boolean, false) then
          v_problemas := v_problemas || format('fila %s: la empresa ya tiene Holded conectado (marca reemplazar u omite la fila)', c.fila);
        end if;
        v_emps := v_emps || v_emp;
      elsif v_accion = 'crear' then
        v_nomn := public.holded_norm_nombre(c.cliente);
        v_nifn := public.holded_norm_nif(c.nif);
        if v_nomn is null then
          v_problemas := v_problemas || format('fila %s: sin nombre no se puede crear la empresa', c.fila);
        elsif exists (select 1 from public.empresas e where public.holded_norm_nombre(e.razon_social) = v_nomn) then
          v_problemas := v_problemas || format('fila %s: ya existe una empresa con ese nombre', c.fila);
        elsif v_nomn = any (v_noms) then
          v_problemas := v_problemas || format('fila %s: otra fila crea una empresa con el mismo nombre', c.fila);
        elsif v_nifn is not null and exists (select 1 from public.empresas e where public.holded_norm_nif(e.cif) = v_nifn) then
          v_problemas := v_problemas || format('fila %s: ya existe una empresa con ese NIF', c.fila);
        elsif v_nifn is not null and v_nifn = any (v_nifs) then
          v_problemas := v_problemas || format('fila %s: otra fila crea una empresa con el mismo NIF', c.fila);
        end if;
        v_noms := v_noms || v_nomn;
        if v_nifn is not null then v_nifs := v_nifs || v_nifn; end if;
        v_ncrear := v_ncrear + 1;
      elsif v_accion <> 'omitir' then
        v_problemas := v_problemas || format('fila %s: acción «%s» no válida', c.fila, v_accion);
      end if;
    end loop;
    if cardinality(v_problemas) > 0 then
      raise exception 'No se ha guardado nada: %', array_to_string(v_problemas, '; ') using errcode = 'GU021';
    end if;

    -- ---------- 2) escribir ----------
    if v_ncrear > 0 then
      insert into public.importaciones (created_by, archivo, filas, resumen)
      values (p_usuario, left('Holded: ' || coalesce(nullif(btrim(p_archivo), ''), 'archivo'), 200), v_ncrear,
              jsonb_build_object('origen', 'holded', 'empresas_nuevas', v_ncrear))
      returning id into v_lote;
    end if;

    for c in select * from public.holded_cargas where carga = p_carga order by fila loop
      d := null;
      select x.value into d from jsonb_array_elements(coalesce(p_decisiones, '[]'::jsonb)) as x(value)
       where (x.value->>'fila')::int = c.fila limit 1;
      v_accion := coalesce(d->>'accion', 'omitir');
      v_emp := null; v_res := 'omitida';
      if v_accion = 'crear' then
        v_cif := nullif(upper(regexp_replace(coalesce(c.nif, ''), '\s', '', 'g')), '');
        insert into public.empresas (razon_social, cif, visto_at, importacion_id)
        values (c.cliente, v_cif, now(), v_lote)
        returning id into v_emp;
        v_res := 'creada';
      elsif v_accion = 'conectar' then
        v_emp := (d->>'empresa_id')::uuid;
        v_res := 'conectada';
      end if;
      if v_emp is not null then
        update public.holded_cargas set secreto_id = null where id = c.id;   -- el secreto pasa a la conexión
        select * into v_con from public.holded_conexiones where empresa_id = v_emp for update;
        if found then
          update public.holded_conexiones
             set secreto_id = c.secreto_id, ultimos4 = c.ultimos4, subdominio = c.subdominio,
                 estado = 'pendiente', ultimo_error = null, permisos = '{}'::jsonb, nif_coincide = null,
                 uso_holded = null, verificada_at = null, creada_por = p_usuario
           where empresa_id = v_emp;
          v_res := 'reemplazada';
        else
          insert into public.holded_conexiones (empresa_id, subdominio, secreto_id, ultimos4, creada_por)
          values (v_emp, c.subdominio, c.secreto_id, c.ultimos4, p_usuario);
        end if;
        v_verificar := v_verificar || v_emp;
      end if;
      v_out := v_out || jsonb_build_object('fila', c.fila, 'empresa_id', v_emp, 'resultado', v_res,
        'nif_pendiente', v_accion = 'crear' and public.holded_norm_nif(c.nif) is null);
    end loop;

    delete from public.holded_cargas where carga = p_carga;   -- borra de Vault lo omitido
    return jsonb_build_object('lote', v_lote, 'filas', v_out, 'verificar', to_jsonb(v_verificar));
  end;
  $f$;
  revoke all on function public.holded_confirmar(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
  grant execute on function public.holded_confirmar(uuid, uuid, jsonb, text) to service_role;

  -- ===================== verificación =====================
  -- Qué empresas puede verificar p_usuario (rol admin): las pedidas que
  -- tienen conexión, como mucho 10 por llamada.
  create function public.holded_para_verificar(p_usuario uuid, p_empresas uuid[])
  returns setof uuid
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin_role(p_usuario) then
      raise exception 'Solo el rol admin puede verificar conexiones de Holded' using errcode = '42501';
    end if;
    if coalesce(cardinality(p_empresas), 0) > 10 then
      raise exception 'Como mucho 10 empresas por llamada' using errcode = '22023';
    end if;
    return query select c.empresa_id from public.holded_conexiones c where c.empresa_id = any (p_empresas);
  end;
  $f$;
  revoke all on function public.holded_para_verificar(uuid, uuid[]) from public, anon, authenticated, service_role;
  grant execute on function public.holded_para_verificar(uuid, uuid[]) to service_role;

  -- La clave en claro: SOLO service_role (Edge Functions).
  create function public.holded_clave_de(p_empresa uuid)
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
    select d.decrypted_secret from public.holded_conexiones c
      join vault.decrypted_secrets d on d.id = c.secreto_id
     where c.empresa_id = p_empresa
  $f$;
  revoke all on function public.holded_clave_de(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.holded_clave_de(uuid) to service_role;

  -- Resultado de la verificación. p_nif_holded (de /account) solo se
  -- compara con el CIF de la empresa; no se guarda.
  create function public.holded_marcar_verificacion(p_empresa uuid, p_estado text, p_error text,
                                                    p_permisos jsonb, p_nif_holded text, p_uso jsonb)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_cif text;
  begin
    if p_estado not in ('ok', 'error') then
      raise exception 'Estado no válido' using errcode = '22023';
    end if;
    select e.cif into v_cif from public.empresas e where e.id = p_empresa;
    update public.holded_conexiones
       set estado = p_estado,
           ultimo_error = case when p_estado = 'error' then left(coalesce(p_error, 'Error desconocido'), 300) end,
           permisos = case when jsonb_typeof(p_permisos) = 'object' then p_permisos else '{}'::jsonb end,
           nif_coincide = case when public.holded_norm_nif(p_nif_holded) is null or public.holded_norm_nif(v_cif) is null then null
                               else public.holded_norm_nif(p_nif_holded) = public.holded_norm_nif(v_cif) end,
           uso_holded = case when jsonb_typeof(p_uso) = 'object' then p_uso end,
           verificada_at = now()
     where empresa_id = p_empresa;
  end;
  $f$;
  revoke all on function public.holded_marcar_verificacion(uuid, text, text, jsonb, text, jsonb)
    from public, anon, authenticated, service_role;
  grant execute on function public.holded_marcar_verificacion(uuid, text, text, jsonb, text, jsonb) to service_role;

  -- ===================== revocar (CRM) =====================
  create function public.holded_revocar(p_empresa_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare v_n int;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede revocar la conexión con Holded' using errcode = '42501';
    end if;
    delete from public.holded_conexiones where empresa_id = p_empresa_id;   -- el trigger borra el secreto
    get diagnostics v_n = row_count;
    return jsonb_build_object('revocada', v_n > 0);
  end;
  $f$;
  revoke all on function public.holded_revocar(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.holded_revocar(uuid) to authenticated;

  revoke all on function public.holded_norm_nif(text) from public, anon;
  revoke all on function public.holded_norm_nombre(text) from public, anon;
  grant execute on function public.holded_norm_nif(text), public.holded_norm_nombre(text) to authenticated, service_role;

  -- ===================== limpieza programada =====================
  if to_regnamespace('cron') is not null then
    execute $c$select cron.schedule('holded-limpiar-cargas', '17 * * * *', 'select public.holded_limpiar_cargas()')$c$;
  end if;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261127140000', array['holded_conexiones, holded_cargas, holded_* (Vault)'],
          'Holded: conexiones por empresa (crm/supabase-holded-conexiones.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 6C (verificación, solo lectura) — Lo esperado:
--   tablas holded_conexiones/holded_cargas con RLS: 2
--   políticas holded_conexiones: 1     políticas holded_cargas: 0
--   authenticated SELECT secreto_id / estado: no/sí
--   authenticated INSERT/UPDATE/DELETE holded_conexiones: no/no/no
--   authenticated SELECT holded_cargas: no
--   EXECUTE authenticated holded_clave_de/previsualizar/confirmar/marcar: no/no/no/no
--   EXECUTE service_role  holded_clave_de/previsualizar/confirmar/marcar: sí/sí/sí/sí
--   EXECUTE anon/authenticated holded_revocar: no/sí
--   triggers holded_*: 3                tarea holded-limpiar-cargas: 1
--   secretos en Vault: los mismos que en 6A
--   migración registrada: 20261127140000 ...
-- ============================================================
select 'tablas holded_conexiones/holded_cargas con RLS' as comprobacion, count(*)::text as valor from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('holded_conexiones', 'holded_cargas') and relrowsecurity
union all
select 'políticas holded_conexiones', count(*)::text from pg_policies where schemaname = 'public' and tablename = 'holded_conexiones'
union all
select 'políticas holded_cargas', count(*)::text from pg_policies where schemaname = 'public' and tablename = 'holded_cargas'
union all
select 'authenticated SELECT secreto_id / estado',
       (case when has_column_privilege('authenticated', 'public.holded_conexiones', 'secreto_id', 'select') then 'sí' else 'no' end) || '/' ||
       (case when has_column_privilege('authenticated', 'public.holded_conexiones', 'estado', 'select') then 'sí' else 'no' end)
union all
select 'authenticated INSERT/UPDATE/DELETE holded_conexiones',
       (case when has_table_privilege('authenticated', 'public.holded_conexiones', 'insert') then 'sí' else 'no' end) || '/' ||
       (case when has_any_column_privilege('authenticated', 'public.holded_conexiones', 'update') then 'sí' else 'no' end) || '/' ||
       (case when has_table_privilege('authenticated', 'public.holded_conexiones', 'delete') then 'sí' else 'no' end)
union all
select 'authenticated SELECT holded_cargas',
       case when has_any_column_privilege('authenticated', 'public.holded_cargas', 'select') then 'sí' else 'no' end
union all
select 'EXECUTE authenticated holded_clave_de/previsualizar/confirmar/marcar',
       (case when has_function_privilege('authenticated', 'public.holded_clave_de(uuid)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_previsualizar(uuid, jsonb)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_confirmar(uuid, uuid, jsonb, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_marcar_verificacion(uuid, text, text, jsonb, text, jsonb)', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE service_role holded_clave_de/previsualizar/confirmar/marcar',
       (case when has_function_privilege('service_role', 'public.holded_clave_de(uuid)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('service_role', 'public.holded_previsualizar(uuid, jsonb)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('service_role', 'public.holded_confirmar(uuid, uuid, jsonb, text)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('service_role', 'public.holded_marcar_verificacion(uuid, text, text, jsonb, text, jsonb)', 'execute') then 'sí' else 'no' end)
union all
select 'EXECUTE anon/authenticated holded_revocar',
       (case when has_function_privilege('anon', 'public.holded_revocar(uuid)', 'execute') then 'sí' else 'no' end) || '/' ||
       (case when has_function_privilege('authenticated', 'public.holded_revocar(uuid)', 'execute') then 'sí' else 'no' end)
union all
select 'triggers holded_*', count(*)::text from pg_trigger
 where tgrelid in ('public.holded_conexiones'::regclass, 'public.holded_cargas'::regclass) and not tgisinternal
union all
select 'tarea holded-limpiar-cargas', (select count(*)::text from cron.job where jobname = 'holded-limpiar-cargas')
union all
select 'secretos en Vault', count(*)::text from vault.secrets
union all
select 'migración registrada', version || ' ' || name
  from supabase_migrations.schema_migrations where version = '20261127140000';
