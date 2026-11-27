-- ============================================================
-- GUIMAES — Importador de clientes (Configuración → Importar)
--
-- Cambio ADITIVO (no borra ni renombra nada):
--   * public.importaciones: un registro por lote importado.
--   * public.importacion_rellenos: campos vacíos de registros que YA
--     existían y que un lote rellenó (para revertirlos al deshacer).
--   * importacion_id (FK a importaciones) en empresas, contactos, deals y
--     contacto_empresa: qué creó cada lote.
--   * empresas.empleados (integer >= 0).
--   * RPC admin_importar_clientes(archivo, filas, simular): solo rol admin
--     (is_admin_role()), security definer, una transacción. Con
--     simular = true devuelve la vista previa y no deja nada escrito.
--   * RPC admin_deshacer_importacion(id): borra lo creado por un lote si
--     nada de ello ha cambiado después.
--   * agente_ficha_empresa: añade 'empleados'.
--
-- Los catálogos de valores válidos (servicios, etapas, ciclo de vida,
-- prioridad, frecuencia) son copia de crm/data.js; la prueba
-- crm/tests/importador comprueba que coinciden.
--
-- No escribe en leads ni en tareas: no salen avisos al equipo. Todo lo
-- creado entra con visto_at = now() (sin la marca "Sin abrir").
--
-- Migración 20261127100000. Ejecutar en orden 4A → 4B → 4C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/importador).
-- ============================================================


-- ============================================================
-- 4A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261127100000: no
--   tablas importaciones/importacion_rellenos: 0
--   columnas importacion_id: 0          columna empresas.empleados: no
--   funciones admin_importar/deshacer: 0
--   funciones base: 6
--   (y los recuentos de filas, para compararlos con 4C)
-- ============================================================
select 'migración 20261127100000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261127100000')
            then 'sí' else 'no' end as valor
union all
select 'tablas importaciones/importacion_rellenos',
       count(*)::text from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('importaciones', 'importacion_rellenos')
union all
select 'columnas importacion_id', count(*)::text from information_schema.columns
 where table_schema = 'public' and column_name = 'importacion_id'
union all
select 'columna empresas.empleados',
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                         and table_name = 'empresas' and column_name = 'empleados') then 'sí' else 'no' end
union all
select 'funciones admin_importar/deshacer', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('admin_importar_clientes', 'admin_deshacer_importacion')
union all
select 'funciones base', count(distinct proname)::text from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('is_admin_role', 'correo_contacto_de', 'phone_last9', 'agente_norm',
                   'agente_ficha_empresa', 'agente_fecha')
union all select 'filas empresas', count(*)::text from public.empresas
union all select 'filas contactos', count(*)::text from public.contactos
union all select 'filas deals', count(*)::text from public.deals
union all select 'filas contacto_empresa', count(*)::text from public.contacto_empresa;


-- ============================================================
-- 4B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261127100000')
     or to_regclass('public.importaciones') is not null then
    raise exception 'La migración 20261127100000 (importador) ya está aplicada: 4B no se repite. No se ha cambiado nada.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
               and (column_name = 'importacion_id' or (table_name = 'empresas' and column_name = 'empleados'))) then
    raise exception 'Ya existe importacion_id o empresas.empleados: estado inesperado, no se toca nada.';
  end if;

  -- ===================== tablas =====================
  create table public.importaciones (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    created_by  uuid,                      -- auth.uid() de quien importó
    archivo     text,
    filas       integer not null default 0,
    resumen     jsonb not null default '{}'::jsonb,
    deshecha_at timestamptz,
    deshecha_by uuid,
    deshecha_resumen jsonb
  );
  comment on table public.importaciones is 'Lotes del importador de clientes (crm/supabase-importador.sql).';
  alter table public.importaciones enable row level security;
  create policy "rol admin lee importaciones" on public.importaciones
    for select to authenticated using ((select public.is_admin_role()));
  revoke all on public.importaciones from anon, authenticated;
  grant select on public.importaciones to authenticated;

  create table public.importacion_rellenos (
    id             uuid primary key default gen_random_uuid(),
    importacion_id uuid not null references public.importaciones(id),
    tabla          text not null check (tabla in ('empresas', 'contactos')),
    registro_id    uuid not null,
    columna        text not null,
    valor          text not null
  );
  create index importacion_rellenos_lote_idx on public.importacion_rellenos (importacion_id);
  alter table public.importacion_rellenos enable row level security;  -- sin políticas: solo las RPC
  revoke all on public.importacion_rellenos from anon, authenticated;

  alter table public.empresas         add column importacion_id uuid references public.importaciones(id);
  alter table public.contactos        add column importacion_id uuid references public.importaciones(id);
  alter table public.deals            add column importacion_id uuid references public.importaciones(id);
  alter table public.contacto_empresa add column importacion_id uuid references public.importaciones(id);
  create index empresas_importacion_idx         on public.empresas (importacion_id) where importacion_id is not null;
  create index contactos_importacion_idx        on public.contactos (importacion_id) where importacion_id is not null;
  create index deals_importacion_idx            on public.deals (importacion_id) where importacion_id is not null;
  create index contacto_empresa_importacion_idx on public.contacto_empresa (importacion_id) where importacion_id is not null;

  alter table public.empresas add column empleados integer check (empleados is null or empleados >= 0);
  comment on column public.empresas.empleados is 'Número de empleados de la empresa.';

  -- ===================== importar =====================
  -- p_filas: array de objetos ya normalizados por el CRM (crm/importador-util.js):
  --   {fila, empresa:{nombre,cif,direccion,empleados},
  --    contacto:{nombre,email,telefono,etapa,owner} | null,
  --    negocio:{servicio,etapa,importe,frecuencia,owner,prioridad} | null}
  -- Aquí se vuelve a normalizar y validar todo, y se resuelven los
  -- duplicados contra la base y dentro del archivo.
  create function public.admin_importar_clientes(p_archivo text, p_filas jsonb, p_simular boolean default true)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    c_servicios  jsonb := '{"s1":"CFO Externo","s2":"Planificación Fiscal","s3":"Asesoría Contable","s4":"Asesoría Laboral","s5":"Legal y Cumplimiento","s6":"Planificación Estratégica","s7":"Expansión LatAm"}';
    c_etapas     text[] := array['nueva_solicitud','contactado','reunion','propuesta','negociacion','cliente_activo','perdido'];
    c_ciclo      text[] := array['new','opportunity','proposal','active_client','lost'];
    c_prioridad  text[] := array['high','medium','low'];
    c_frecuencia text[] := array['mensual','trimestral','anual','puntual'];

    v_lote uuid := gen_random_uuid();
    v_ahora timestamptz := now();
    r jsonb; e jsonb; c jsonb; n jsonb;
    v_fila int;
    v_err jsonb; v_av jsonb;
    v_res_filas jsonb := '[]';
    v_bloqueado boolean := false;

    -- claves → id (lo visto en este archivo)
    m_emp_cif jsonb := '{}'; m_emp_nombre jsonb := '{}';
    m_con_email jsonb := '{}'; m_con_tel jsonb := '{}'; m_con_nombre jsonb := '{}';
    m_deal jsonb := '{}';
    m_fila_emp jsonb := '{}';          -- empresa_id → primera fila
    s_emp_nuevas uuid[] := '{}'; s_emp_exist uuid[] := '{}';
    s_con_nuevos uuid[] := '{}'; s_con_exist uuid[] := '{}';
    v_vinculos int := 0; v_deals int := 0; v_deals_omit int := 0; v_rellenos int := 0;

    v_nombre text; v_cif text; v_dir text; v_empl int; v_empl_txt text;
    v_c_nombre text; v_email text; v_tel text; v_tel9 text; v_c_etapa text; v_c_owner text;
    v_servicio text; v_d_etapa text; v_importe numeric; v_imp_txt text; v_frec text; v_d_owner text; v_prio text;
    v_hay_contacto boolean; v_hay_negocio boolean;
    v_emp_id uuid; v_emp_estado text; v_emp_razon text; v_emp_nueva boolean;
    v_con_id uuid; v_con_estado text; v_con_nuevo boolean;
    v_deal_estado text;
    v_n_mismo int;
    v_tmp_txt text; v_x_email text; v_x_tel text; v_x_nombre text;
    v_resultado jsonb;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede importar' using errcode = '42501';
    end if;
    if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
      raise exception 'No hay filas que importar' using errcode = '22023';
    end if;
    if jsonb_array_length(p_filas) > 2000 then
      raise exception 'Máximo 2000 filas por lote' using errcode = '22023';
    end if;

    -- Dos importaciones a la vez se pisarían los duplicados.
    perform pg_advisory_xact_lock(hashtext('guimaes_importador_clientes'));

    begin  -- subtransacción: en simulación (o con errores) se deshace al final
      insert into public.importaciones (id, created_by, archivo, filas)
      values (v_lote, auth.uid(), left(nullif(btrim(p_archivo), ''), 200), jsonb_array_length(p_filas));

      for r in select x from jsonb_array_elements(p_filas) x loop
        v_err := '[]'; v_av := '[]';
        v_fila := coalesce((r->>'fila')::int, 0);
        e := coalesce(r->'empresa', '{}'); c := r->'contacto'; n := r->'negocio';
        if jsonb_typeof(c) is distinct from 'object' then c := null; end if;
        if jsonb_typeof(n) is distinct from 'object' then n := null; end if;

        -- ---------- normalizar y validar ----------
        v_nombre := nullif(btrim(regexp_replace(coalesce(e->>'nombre', ''), '\s+', ' ', 'g')), '');
        v_cif    := nullif(upper(regexp_replace(coalesce(e->>'cif', ''), '[\s.\-]', '', 'g')), '');
        v_dir    := nullif(btrim(coalesce(e->>'direccion', '')), '');
        v_empl_txt := nullif(btrim(coalesce(e->>'empleados', '')), '');
        v_empl := null;
        if v_empl_txt is not null then
          if v_empl_txt ~ '^\d{1,7}(\.0+)?$' then v_empl := split_part(v_empl_txt, '.', 1)::int;
          else v_err := v_err || jsonb_build_array('Empleados no es un número entero'); end if;
        end if;
        if v_nombre is null then v_err := v_err || jsonb_build_array('Falta el nombre de la empresa'); end if;

        v_c_nombre := nullif(btrim(regexp_replace(coalesce(c->>'nombre', ''), '\s+', ' ', 'g')), '');
        v_email    := nullif(lower(btrim(coalesce(c->>'email', ''))), '');
        v_tel      := nullif(regexp_replace(regexp_replace(coalesce(c->>'telefono', ''), '\.0+$', ''), '\D', '', 'g'), '');
        v_tel9     := case when length(v_tel) >= 9 then right(v_tel, 9) else v_tel end;
        v_c_etapa  := nullif(btrim(coalesce(c->>'etapa', '')), '');
        v_c_owner  := nullif(btrim(coalesce(c->>'owner', '')), '');
        v_hay_contacto := coalesce(v_c_nombre, v_email, v_tel) is not null;
        if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$' then
          v_err := v_err || jsonb_build_array('Email con formato inválido');
        end if;
        if v_c_etapa is not null and not (v_c_etapa = any (c_ciclo)) then
          v_err := v_err || jsonb_build_array('Etapa del contacto no válida');
        end if;
        if v_c_owner is not null and not exists (select 1 from public.admins a where a.id::text = v_c_owner and a.activo) then
          v_err := v_err || jsonb_build_array('Responsable no válido');
        end if;
        if not v_hay_contacto and (v_c_etapa is not null) then
          v_av := v_av || jsonb_build_array('Etapa del contacto sin nombre, email ni teléfono: no se crea contacto');
        end if;

        v_servicio := nullif(btrim(coalesce(n->>'servicio', '')), '');
        v_d_etapa  := nullif(btrim(coalesce(n->>'etapa', '')), '');
        v_imp_txt  := nullif(btrim(coalesce(n->>'importe', '')), '');
        v_frec     := nullif(btrim(coalesce(n->>'frecuencia', '')), '');
        v_d_owner  := nullif(btrim(coalesce(n->>'owner', '')), '');
        v_prio     := nullif(btrim(coalesce(n->>'prioridad', '')), '');
        v_importe := null;
        if v_imp_txt is not null then
          if v_imp_txt ~ '^\d+(\.\d+)?$' then
            v_importe := nullif(v_imp_txt::numeric, 0);
          else v_err := v_err || jsonb_build_array('Importe no es un número válido'); end if;
        end if;
        v_hay_negocio := coalesce(v_servicio, v_d_etapa, v_imp_txt, v_frec, v_d_owner, v_prio) is not null;
        if v_hay_negocio then
          if v_servicio is null then v_err := v_err || jsonb_build_array('Falta el servicio del negocio');
          elsif not (c_servicios ? v_servicio) then v_err := v_err || jsonb_build_array('Servicio no válido'); end if;
          if v_d_etapa is null then v_err := v_err || jsonb_build_array('Falta la etapa del negocio');
          elsif not (v_d_etapa = any (c_etapas)) then v_err := v_err || jsonb_build_array('Etapa del negocio no válida'); end if;
          if v_frec is not null and not (v_frec = any (c_frecuencia)) then v_err := v_err || jsonb_build_array('Frecuencia no válida'); end if;
          if v_prio is not null and not (v_prio = any (c_prioridad)) then v_err := v_err || jsonb_build_array('Prioridad no válida'); end if;
          if v_d_owner is not null and not exists (select 1 from public.admins a where a.id::text = v_d_owner and a.activo) then
            v_err := v_err || jsonb_build_array('Responsable no válido');
          end if;
        end if;

        if jsonb_array_length(v_err) > 0 then
          v_bloqueado := true;
          v_res_filas := v_res_filas || jsonb_build_array(jsonb_build_object('fila', v_fila, 'errores', v_err, 'avisos', v_av));
          continue;
        end if;

        -- ---------- empresa ----------
        v_emp_id := null; v_emp_nueva := false;
        if v_cif is not null then
          v_emp_id := (m_emp_cif->>v_cif)::uuid;
          if v_emp_id is not null then
            v_emp_estado := 'misma que la fila ' || (m_fila_emp->>v_emp_id::text);
            select razon_social into v_emp_razon from public.empresas where id = v_emp_id;
            if public.agente_norm(v_emp_razon) <> public.agente_norm(v_nombre) then
              v_av := v_av || jsonb_build_array('Mismo CIF que la fila ' || (m_fila_emp->>v_emp_id::text) || ' con otro nombre: se usa el de esa fila');
            end if;
          else
            select id into v_emp_id from public.empresas
             where upper(regexp_replace(coalesce(cif, ''), '[\s.\-]', '', 'g')) = v_cif
             order by archived_at nulls first, created_at limit 1;
            if v_emp_id is not null then
              v_emp_estado := 'ya existe';
              if exists (select 1 from public.empresas where id = v_emp_id and archived_at is not null) then
                v_av := v_av || jsonb_build_array('La empresa con ese CIF está archivada en el CRM');
              end if;
            end if;
          end if;
        else
          v_emp_id := (m_emp_nombre->>public.agente_norm(v_nombre))::uuid;
          if v_emp_id is not null then
            v_emp_estado := 'misma que la fila ' || (m_fila_emp->>v_emp_id::text);
          else
            -- Sin CIF: la misma si en el CRM hay UNA empresa con ese nombre;
            -- con varias no se puede saber cuál (error: hace falta el CIF).
            select count(*), min(x.id::text) into v_n_mismo, v_tmp_txt from public.empresas x
             where public.agente_norm(btrim(x.razon_social)) = public.agente_norm(v_nombre);
            if v_n_mismo = 1 then
              v_emp_id := v_tmp_txt::uuid;
              v_emp_estado := 'ya existe';
              v_av := v_av || jsonb_build_array('Sin CIF: se asocia a la empresa del CRM con el mismo nombre');
            elsif v_n_mismo > 1 then
              v_err := v_err || jsonb_build_array('Sin CIF y hay ' || v_n_mismo || ' empresas con este nombre en el CRM: añade el CIF');
            else
              v_av := v_av || jsonb_build_array('Sin CIF: se crea una empresa nueva');
            end if;
          end if;
        end if;

        if jsonb_array_length(v_err) > 0 then
          v_bloqueado := true;
          v_res_filas := v_res_filas || jsonb_build_array(jsonb_build_object('fila', v_fila, 'errores', v_err, 'avisos', v_av));
          continue;
        end if;

        if v_emp_id is null then
          insert into public.empresas (razon_social, cif, address, empleados, visto_at, importacion_id)
          values (v_nombre, v_cif, v_dir, v_empl, v_ahora, v_lote)
          returning id into v_emp_id;
          v_emp_nueva := true; v_emp_estado := 'nueva';
          s_emp_nuevas := s_emp_nuevas || v_emp_id;
          m_fila_emp := m_fila_emp || jsonb_build_object(v_emp_id::text, v_fila);
        else
          if not (v_emp_id = any (s_emp_nuevas)) and not (v_emp_id = any (s_emp_exist)) then
            s_emp_exist := s_emp_exist || v_emp_id;
            m_fila_emp := m_fila_emp || jsonb_build_object(v_emp_id::text, v_fila);
          end if;
          -- Solo rellenar huecos.
          if v_dir is not null and exists (select 1 from public.empresas where id = v_emp_id and nullif(btrim(address), '') is null) then
            update public.empresas set address = v_dir where id = v_emp_id;
            if not (v_emp_id = any (s_emp_nuevas)) then
              insert into public.importacion_rellenos (importacion_id, tabla, registro_id, columna, valor)
              values (v_lote, 'empresas', v_emp_id, 'address', v_dir);
              v_rellenos := v_rellenos + 1;
              v_av := v_av || jsonb_build_array('Se rellena la dirección de la empresa');
            end if;
          end if;
          if v_empl is not null and exists (select 1 from public.empresas where id = v_emp_id and empleados is null) then
            update public.empresas set empleados = v_empl where id = v_emp_id;
            if not (v_emp_id = any (s_emp_nuevas)) then
              insert into public.importacion_rellenos (importacion_id, tabla, registro_id, columna, valor)
              values (v_lote, 'empresas', v_emp_id, 'empleados', v_empl::text);
              v_rellenos := v_rellenos + 1;
              v_av := v_av || jsonb_build_array('Se rellena el nº de empleados de la empresa');
            end if;
          end if;
        end if;
        if v_cif is not null then m_emp_cif := m_emp_cif || jsonb_build_object(v_cif, v_emp_id);
        else m_emp_nombre := m_emp_nombre || jsonb_build_object(public.agente_norm(v_nombre), v_emp_id); end if;
        select razon_social into v_emp_razon from public.empresas where id = v_emp_id;

        -- ---------- contacto ----------
        v_con_id := null; v_con_estado := null; v_con_nuevo := false;
        if v_hay_contacto then
          if v_email is not null then
            v_con_id := (m_con_email->>v_email)::uuid;
            if v_con_id is null then v_con_id := public.correo_contacto_de(v_email); end if;
          elsif v_tel is not null then
            v_con_id := (m_con_tel->>v_tel9)::uuid;
            if v_con_id is null then
              select id into v_con_id from public.contactos x
               where (case when length(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g')) >= 9
                           then right(regexp_replace(x.phone, '\D', '', 'g'), 9)
                           else nullif(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), '') end) = v_tel9
               order by (x.provisional_at is not null), x.created_at, x.id limit 1;
            end if;
          else
            v_con_id := (m_con_nombre->>(v_emp_id::text || '|' || public.agente_norm(v_c_nombre)))::uuid;
            if v_con_id is null then
              select x.id into v_con_id from public.contactos x
                join public.contacto_empresa ce on ce.contact_id = x.id and ce.empresa_id = v_emp_id
               where public.agente_norm(x.full_name) = public.agente_norm(v_c_nombre)
               order by x.created_at, x.id limit 1;
            end if;
          end if;

          if v_con_id is null then
            insert into public.contactos (full_name, email, phone, lifecycle, owner, source, visto_at, importacion_id)
            values (v_c_nombre, v_email, v_tel, coalesce(v_c_etapa, 'new'), coalesce(v_c_owner, v_d_owner),
                    'Importación', v_ahora, v_lote)
            returning id into v_con_id;
            v_con_nuevo := true; v_con_estado := 'nuevo';
            s_con_nuevos := s_con_nuevos || v_con_id;
          else
            if v_con_id = any (s_con_nuevos) or v_con_id = any (s_con_exist) then
              v_con_estado := 'repetido en el archivo';
            else
              v_con_estado := 'ya existe';
              s_con_exist := s_con_exist || v_con_id;
            end if;
            -- Solo rellenar huecos (los de lote: sin registro de relleno).
            if v_c_nombre is not null and exists (select 1 from public.contactos where id = v_con_id and nullif(btrim(full_name), '') is null) then
              update public.contactos set full_name = v_c_nombre where id = v_con_id;
              if not (v_con_id = any (s_con_nuevos)) then
                insert into public.importacion_rellenos (importacion_id, tabla, registro_id, columna, valor)
                values (v_lote, 'contactos', v_con_id, 'full_name', v_c_nombre);
                v_rellenos := v_rellenos + 1;
                v_av := v_av || jsonb_build_array('Se rellena el nombre del contacto');
              end if;
            end if;
            if v_tel is not null and exists (select 1 from public.contactos where id = v_con_id and nullif(btrim(phone), '') is null) then
              update public.contactos set phone = v_tel where id = v_con_id;
              if not (v_con_id = any (s_con_nuevos)) then
                insert into public.importacion_rellenos (importacion_id, tabla, registro_id, columna, valor)
                values (v_lote, 'contactos', v_con_id, 'phone', v_tel);
                v_rellenos := v_rellenos + 1;
                v_av := v_av || jsonb_build_array('Se rellena el teléfono del contacto');
              end if;
            end if;
            v_tmp_txt := coalesce(v_c_owner, v_d_owner);
            if v_tmp_txt is not null and exists (select 1 from public.contactos where id = v_con_id and nullif(btrim(owner), '') is null) then
              update public.contactos set owner = v_tmp_txt where id = v_con_id;
              if not (v_con_id = any (s_con_nuevos)) then
                insert into public.importacion_rellenos (importacion_id, tabla, registro_id, columna, valor)
                values (v_lote, 'contactos', v_con_id, 'owner', v_tmp_txt);
                v_rellenos := v_rellenos + 1;
                v_av := v_av || jsonb_build_array('Se rellena el responsable del contacto');
              end if;
            end if;
            if v_c_etapa is not null and not (v_con_id = any (s_con_nuevos))
               and exists (select 1 from public.contactos where id = v_con_id and lifecycle <> v_c_etapa) then
              v_av := v_av || jsonb_build_array('El contacto ya existe con otra etapa: se conserva la del CRM');
            end if;
          end if;
          -- índices para las filas siguientes
          select nullif(lower(btrim(x.email)), ''),
                 nullif(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), ''),
                 nullif(btrim(x.full_name), '')
            into v_x_email, v_x_tel, v_x_nombre
            from public.contactos x where x.id = v_con_id;
          if v_x_email is not null then
            m_con_email := m_con_email || jsonb_build_object(v_x_email, v_con_id);
          end if;
          if v_x_tel is not null then
            m_con_tel := m_con_tel || jsonb_build_object(case when length(v_x_tel) >= 9 then right(v_x_tel, 9) else v_x_tel end, v_con_id);
          end if;
          if v_x_nombre is not null then
            m_con_nombre := m_con_nombre || jsonb_build_object(v_emp_id::text || '|' || public.agente_norm(v_x_nombre), v_con_id);
          end if;

          -- vínculo con la empresa
          if not exists (select 1 from public.contacto_empresa where contact_id = v_con_id and empresa_id = v_emp_id) then
            insert into public.contacto_empresa (contact_id, empresa_id, principal, importacion_id)
            values (v_con_id, v_emp_id,
                    not exists (select 1 from public.contacto_empresa where contact_id = v_con_id), v_lote);
            v_vinculos := v_vinculos + 1;
          end if;
        end if;

        -- ---------- negocio ----------
        v_deal_estado := null;
        if v_hay_negocio then
          if m_deal ? (v_emp_id::text || '|' || v_servicio) then
            v_deal_estado := 'omitido';
            v_deals_omit := v_deals_omit + 1;
            v_av := v_av || jsonb_build_array('Negocio duplicado: la fila ' || (m_deal->>(v_emp_id::text || '|' || v_servicio))
                                                || ' ya crea un negocio de ' || (c_servicios->>v_servicio) || ' para esta empresa');
          elsif exists (select 1 from public.deals d where d.empresa_id = v_emp_id and d.service = v_servicio) then
            v_deal_estado := 'omitido';
            v_deals_omit := v_deals_omit + 1;
            v_av := v_av || jsonb_build_array('La empresa ya tiene un negocio de ' || (c_servicios->>v_servicio) || ': no se crea otro');
          else
            insert into public.deals (title, contact_id, empresa_id, service, stage, owner, amount, frequency, priority, importacion_id)
            values ((c_servicios->>v_servicio) || ' — ' || v_emp_razon, v_con_id, v_emp_id, v_servicio, v_d_etapa,
                    v_d_owner, v_importe, v_frec, v_prio, v_lote);
            v_deal_estado := 'nuevo';
            v_deals := v_deals + 1;
            m_deal := m_deal || jsonb_build_object(v_emp_id::text || '|' || v_servicio, v_fila);
          end if;
        end if;

        v_res_filas := v_res_filas || jsonb_build_array(jsonb_build_object(
          'fila', v_fila, 'errores', v_err, 'avisos', v_av,
          'empresa', v_emp_estado, 'empresa_id', v_emp_id,
          'contacto', v_con_estado, 'contacto_id', v_con_id, 'negocio', v_deal_estado));
      end loop;

      v_resultado := jsonb_build_object(
        'importacion_id', v_lote,
        'simulado', p_simular or v_bloqueado,
        'bloqueado', v_bloqueado,
        'resumen', jsonb_build_object(
          'filas', jsonb_array_length(p_filas),
          'filas_con_error', (select count(*) from jsonb_array_elements(v_res_filas) x where jsonb_array_length(x->'errores') > 0),
          'empresas_nuevas', coalesce(array_length(s_emp_nuevas, 1), 0),
          'empresas_existentes', coalesce(array_length(s_emp_exist, 1), 0),
          'contactos_nuevos', coalesce(array_length(s_con_nuevos, 1), 0),
          'contactos_existentes', coalesce(array_length(s_con_exist, 1), 0),
          'vinculos_nuevos', v_vinculos,
          'negocios_nuevos', v_deals,
          'negocios_omitidos', v_deals_omit,
          'campos_rellenados', v_rellenos),
        'filas', v_res_filas);

      if p_simular or v_bloqueado then
        raise exception using errcode = 'GU900', message = 'simulación';
      end if;
      update public.importaciones set resumen = v_resultado->'resumen' where id = v_lote;
    exception when sqlstate 'GU900' then
      -- Se deshace todo lo de la subtransacción; v_resultado se conserva.
      v_resultado := v_resultado - 'importacion_id';
    end;
    return v_resultado;
  end;
  $f$;
  revoke all on function public.admin_importar_clientes(text, jsonb, boolean) from public, anon, authenticated, service_role;
  grant execute on function public.admin_importar_clientes(text, jsonb, boolean) to authenticated;

  -- ===================== deshacer =====================
  create function public.admin_deshacer_importacion(p_importacion_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_imp public.importaciones%rowtype;
    v_motivos text[] := '{}';
    v_n int;
    v_deals int; v_vinc int; v_con int; v_emp int; v_rev int := 0;
    rr record;
    v_res jsonb;
  begin
    if not public.is_admin_role() then
      raise exception 'Solo el rol admin puede deshacer importaciones' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('guimaes_importador_clientes'));
    select * into v_imp from public.importaciones where id = p_importacion_id for update;
    if not found then
      raise exception 'La importación no existe' using errcode = 'GU010';
    end if;
    if v_imp.deshecha_at is not null then
      raise exception 'Esta importación ya se deshizo' using errcode = 'GU011';
    end if;

    -- ---------- ¿algo cambió después? ----------
    select count(*) into v_n from public.empresas where importacion_id = p_importacion_id and updated_at <> created_at;
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' empresa(s) editadas después'); end if;
    select count(*) into v_n from public.contactos where importacion_id = p_importacion_id and updated_at <> created_at;
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' contacto(s) editados después'); end if;
    select count(*) into v_n from public.deals where importacion_id = p_importacion_id and updated_at <> created_at;
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' negocio(s) editados después'); end if;
    select count(*) into v_n from public.deals d
     where d.importacion_id is distinct from p_importacion_id
       and (d.empresa_id in (select id from public.empresas where importacion_id = p_importacion_id)
            or d.contact_id in (select id from public.contactos where importacion_id = p_importacion_id));
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' negocio(s) añadidos después a lo importado'); end if;
    select count(*) into v_n from public.contacto_empresa ce
     where ce.importacion_id is distinct from p_importacion_id
       and (ce.empresa_id in (select id from public.empresas where importacion_id = p_importacion_id)
            or ce.contact_id in (select id from public.contactos where importacion_id = p_importacion_id));
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' vínculo(s) contacto–empresa añadidos después'); end if;
    select count(*) into v_n from public.notas x
     where x.contact_id in (select id from public.contactos where importacion_id = p_importacion_id)
        or x.deal_id in (select id from public.deals where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' nota(s)'); end if;
    select count(*) into v_n from public.tareas x
     where x.contact_id in (select id from public.contactos where importacion_id = p_importacion_id)
        or x.deal_id in (select id from public.deals where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' tarea(s)'); end if;
    select count(*) into v_n from public.documentos x
     where x.empresa_id in (select id from public.empresas where importacion_id = p_importacion_id)
        or x.aportado_por_contact_id in (select id from public.contactos where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' documento(s)'); end if;
    select count(*) into v_n from public.carpetas k join public.empresas e on e.id = k.empresa_id
     where e.importacion_id = p_importacion_id and (k.created_at <> e.created_at or k.updated_at <> k.created_at);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' carpeta(s) creadas o cambiadas después'); end if;
    select count(*) into v_n from public.whatsapp_conversations x
     where x.contact_id in (select id from public.contactos where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' conversación(es) de WhatsApp'); end if;
    select count(*) into v_n from public.leads x
     where x.contact_id in (select id from public.contactos where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' formulario(s) web enlazados'); end if;
    select count(*) into v_n from public.empresa_solicitudes x
     where x.empresa_id in (select id from public.empresas where importacion_id = p_importacion_id)
        or x.contact_id in (select id from public.contactos where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' solicitud(es) del portal'); end if;
    select count(*) into v_n from public.empresa_cambios x
     where x.empresa_id in (select id from public.empresas where importacion_id = p_importacion_id)
        or x.contact_id in (select id from public.contactos where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' cambio(s) registrados del portal'); end if;
    select count(*) into v_n from public.correo_borradores x
     where x.empresa_id in (select id from public.empresas where importacion_id = p_importacion_id);
    if v_n > 0 then v_motivos := v_motivos || (v_n || ' borrador(es) de correo'); end if;

    if array_length(v_motivos, 1) > 0 then
      raise exception 'No se puede deshacer: %', array_to_string(v_motivos, '; ') using errcode = 'GU020';
    end if;

    -- ---------- borrar lo creado ----------
    delete from public.deals where importacion_id = p_importacion_id;
    get diagnostics v_deals = row_count;
    delete from public.contacto_empresa where importacion_id = p_importacion_id;
    get diagnostics v_vinc = row_count;
    delete from public.contactos where importacion_id = p_importacion_id;
    get diagnostics v_con = row_count;
    delete from public.empresas where importacion_id = p_importacion_id;   -- carpetas: on delete cascade
    get diagnostics v_emp = row_count;

    -- ---------- revertir huecos rellenados (si siguen con el valor puesto) ----------
    for rr in select * from public.importacion_rellenos where importacion_id = p_importacion_id loop
      if rr.tabla = 'empresas' and rr.columna = 'address' then
        update public.empresas set address = null where id = rr.registro_id and address = rr.valor;
      elsif rr.tabla = 'empresas' and rr.columna = 'empleados' then
        update public.empresas set empleados = null where id = rr.registro_id and empleados::text = rr.valor;
      elsif rr.tabla = 'contactos' and rr.columna = 'full_name' then
        update public.contactos set full_name = null where id = rr.registro_id and full_name = rr.valor;
      elsif rr.tabla = 'contactos' and rr.columna = 'phone' then
        update public.contactos set phone = null where id = rr.registro_id and phone = rr.valor;
      elsif rr.tabla = 'contactos' and rr.columna = 'owner' then
        update public.contactos set owner = null where id = rr.registro_id and owner = rr.valor;
      else
        continue;
      end if;
      get diagnostics v_n = row_count;
      v_rev := v_rev + v_n;
    end loop;

    v_res := jsonb_build_object('negocios_borrados', v_deals, 'vinculos_borrados', v_vinc,
                                'contactos_borrados', v_con, 'empresas_borradas', v_emp,
                                'campos_revertidos', v_rev);
    update public.importaciones
       set deshecha_at = now(), deshecha_by = auth.uid(), deshecha_resumen = v_res
     where id = p_importacion_id;
    return v_res;
  end;
  $f$;
  revoke all on function public.admin_deshacer_importacion(uuid) from public, anon, authenticated, service_role;
  grant execute on function public.admin_deshacer_importacion(uuid) to authenticated;

  -- ===================== agente: empleados en la ficha de empresa =====================
  create or replace function public.agente_ficha_empresa(p_empresa_id uuid)
  returns jsonb
  language plpgsql
  stable
  set search_path = public, pg_temp
  as $f$
  declare
    e public.empresas%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    select * into e from public.empresas where id = p_empresa_id;
    if not found then
      return jsonb_build_object('encontrada', false);
    end if;
    return jsonb_build_object(
      'encontrada', true,
      'empresa', jsonb_build_object(
        'id', e.id, 'razon_social', e.razon_social, 'cif', e.cif, 'direccion', e.address, 'ciudad', e.city,
        'provincia', e.province, 'empleados', e.empleados, 'alta_pendiente_validar', e.provisional_at is not null,
        'archivada', e.archived_at is not null, 'creada', public.agente_fecha(e.created_at)),
      'total_contactos', (select count(*) from public.contacto_empresa where empresa_id = e.id),
      'contactos', (select coalesce(jsonb_agg(x.j order by x.p desc, x.n), '[]') from (
          select ce.principal as p, coalesce(c.full_name, '') as n,
                 jsonb_build_object('id', c.id, 'nombre', c.full_name, 'email', c.email, 'telefono', c.phone,
                   'empresa_principal', ce.principal, 'cuenta_portal', c.auth_user_id is not null) as j
          from public.contacto_empresa ce join public.contactos c on c.id = ce.contact_id
          where ce.empresa_id = e.id
          order by ce.principal desc, c.full_name
          limit 20) x),
      'total_deals', (select count(*) from public.deals where empresa_id = e.id),
      'deals', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by d.updated_at desc) as o,
                 jsonb_build_object('id', d.id, 'titulo', d.title, 'servicio', d.service, 'etapa', d.stage,
                   'importe', d.amount, 'frecuencia', d.frequency, 'owner', d.owner, 'prioridad', d.priority,
                   'firmado', d.signed_at, 'renovacion', d.renewal_at, 'motivo_perdida', d.loss_reason,
                   'num_nominas', d.num_nominas, 'coste_nomina', d.coste_nomina, 'origen', d.origen) as j
          from public.deals d where d.empresa_id = e.id
          order by d.updated_at desc
          limit 20) x),
      'tareas_abiertas', (select coalesce(jsonb_agg(x.j order by x.o nulls last), '[]') from (
          select t.due_at as o,
                 jsonb_build_object('id', t.id, 'titulo', t.title, 'vence', public.agente_fecha(t.due_at),
                   'vencida', t.due_at < now(), 'asignada_a', t.assigned_to) as j
          from public.tareas t
          where t.status <> 'done' and not t.archived
            and (t.deal_id in (select id from public.deals where empresa_id = e.id)
                 or t.contact_id in (select contact_id from public.contacto_empresa where empresa_id = e.id))
          order by t.due_at nulls last
          limit 10) x),
      'solicitudes_portal_pendientes', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select s.created_at as o,
                 jsonb_build_object('campo', s.campo, 'valor_solicitado', public.agente_corta(s.valor_solicitado, 300),
                   'fecha', public.agente_fecha(s.created_at)) as j
          from public.empresa_solicitudes s
          where s.empresa_id = e.id and s.estado = 'pendiente'
          order by s.created_at
          limit 10) x),
      'recuentos', jsonb_build_object(
        'documentos', (select count(*) from public.documentos where empresa_id = e.id),
        'documentos_aportados_por_cliente', (select count(*) from public.documentos where empresa_id = e.id and source = 'cliente'),
        'correos', (select count(*) from public.correo_mensajes where empresa_id = e.id),
        'conversaciones_whatsapp', (select count(*) from public.whatsapp_conversations w
                                    where w.contact_id in (select contact_id from public.contacto_empresa where empresa_id = e.id)))
    );
  end
  $f$;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261127100000', array['importaciones, importacion_rellenos, importacion_id, empresas.empleados, admin_importar_clientes, admin_deshacer_importacion'],
          'importador de clientes (crm/supabase-importador.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 4C (verificación, solo lectura) — Lo esperado:
--   tablas importaciones/importacion_rellenos: 2      RLS activada: 2
--   políticas importaciones: 1                         filas importaciones: 0
--   columnas importacion_id: 4                         columna empresas.empleados: sí
--   funciones admin_importar/deshacer (definer): 2
--   funciones con EXECUTE para anon: 0                 para authenticated: 2
--   agente_ficha_empresa con empleados: sí
--   filas empresas/contactos/deals/contacto_empresa: las mismas que en 4A
--   migración registrada: 20261127100000 ...
-- ============================================================
select 'tablas importaciones/importacion_rellenos' as comprobacion,
       count(*)::text as valor from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('importaciones', 'importacion_rellenos')
union all
select 'RLS activada', count(*)::text from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('importaciones', 'importacion_rellenos') and relrowsecurity
union all
select 'políticas importaciones', count(*)::text from pg_policies
 where schemaname = 'public' and tablename in ('importaciones', 'importacion_rellenos')
union all
select 'filas importaciones', count(*)::text from public.importaciones
union all
select 'columnas importacion_id', count(*)::text from information_schema.columns
 where table_schema = 'public' and column_name = 'importacion_id'
   and table_name in ('empresas', 'contactos', 'deals', 'contacto_empresa')
union all
select 'columna empresas.empleados',
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                         and table_name = 'empresas' and column_name = 'empleados') then 'sí' else 'no' end
union all
select 'funciones admin_importar/deshacer (definer)', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace and prosecdef
   and proname in ('admin_importar_clientes', 'admin_deshacer_importacion')
union all
select 'funciones con EXECUTE para anon', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('admin_importar_clientes', 'admin_deshacer_importacion')
   and has_function_privilege('anon', oid, 'execute')
union all
select 'funciones con EXECUTE para authenticated', count(*)::text from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('admin_importar_clientes', 'admin_deshacer_importacion')
   and has_function_privilege('authenticated', oid, 'execute')
union all
select 'agente_ficha_empresa con empleados',
       case when pg_get_functiondef('public.agente_ficha_empresa'::regproc) like '%''empleados'', e.empleados%'
            then 'sí' else 'no' end
union all select 'filas empresas', count(*)::text from public.empresas
union all select 'filas contactos', count(*)::text from public.contactos
union all select 'filas deals', count(*)::text from public.deals
union all select 'filas contacto_empresa', count(*)::text from public.contacto_empresa
union all
select 'migración registrada', version || ' ' || name
  from supabase_migrations.schema_migrations where version = '20261127100000';
