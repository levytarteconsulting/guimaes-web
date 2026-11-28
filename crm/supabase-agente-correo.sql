-- ============================================================
-- GUIMAES — Agente de IA: correos desde info@ con tarjeta (Enviar)
--
-- El asistente REDACTA correos; no los envía. Su herramienta
-- proponer_correo crea una fila en agente_correos (destinatarios, asunto,
-- texto, documentos de la empresa como adjuntos) que el chat enseña como
-- tarjeta. Cualquier usuario del CRM puede redactar; solo el rol admin
-- envía, pulsando Enviar: el CRM llama a la Edge Function "correo"
-- (accion agente_enviar) con su JWT, y la función comprueba el rol, vuelve
-- a validar, envía por Microsoft Graph desde info@ y guarda el enviado en
-- correo_mensajes vinculado al contacto o la empresa del correo.
--
-- Qué crea:
--   * agente_correos: una fila por correo redactado. Cada usuario ve y
--     edita los suyos; el rol admin ve y edita todos (es quien los envía).
--     Estados: pendiente → enviando → enviada (lo pone la función correo),
--     o cancelada. Caducan a los 7 días. Se borran con su conversación.
--   * agente_emails, agente_correo_preparar (validar y normalizar),
--     agente_proponer_correo, agente_correo_editar, agente_correo_cancelar:
--     SECURITY INVOKER, EXECUTE solo para authenticated.
--   * agente_escrituras admite tabla 'agente_correos' (auditoría del envío).
--
-- Errores: 42501 sin permiso; 22023 dato no válido; GU010 no existe o no se ve.
-- Requiere: crm/supabase-agente-escritura.sql (20261128100000).
-- Patrón: 11A solo lectura → 11B un único DO que se niega a repetirse → 11C
-- verificación. Probado en PGlite: crm/tests/agente/agente-correo.test.mjs.
-- ============================================================


-- ============================================================
-- 11A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261128100000: sí      migración 20261128140000: no
--   tabla agente_correos: 0           restricción de tabla en agente_escrituras: 1
--   columnas usadas: 14
-- ============================================================
select 'migración 20261128100000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128100000') then 'sí' else 'no' end as valor
union all select 'migración 20261128140000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128140000') then 'sí' else 'no' end
union all select 'tabla agente_correos',
       (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = 'agente_correos')
union all select 'restricción de tabla en agente_escrituras',
       (select count(*)::text from pg_constraint where conrelid = 'public.agente_escrituras'::regclass and conname = 'agente_escrituras_tabla_check')
union all select 'columnas usadas',
       (select count(*)::text from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (
         ('contactos', 'id'), ('contactos', 'full_name'), ('contactos', 'email'),
         ('empresas', 'id'), ('empresas', 'razon_social'),
         ('contacto_empresa', 'contact_id'), ('contacto_empresa', 'empresa_id'), ('contacto_empresa', 'principal'), ('contacto_empresa', 'created_at'),
         ('documentos', 'id'), ('documentos', 'empresa_id'), ('documentos', 'status'), ('documentos', 'size_bytes'), ('documentos', 'original_filename')));


-- ============================================================
-- 11B (cambio, atómico, se niega a repetirse)
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261128140000')
     or to_regclass('public.agente_correos') is not null then
    raise exception 'La migración 20261128140000 ya está aplicada. No se ha cambiado nada.';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261128100000')
     or to_regclass('public.agente_escrituras') is null then
    raise exception 'Falta crm/supabase-agente-escritura.sql. No se ha cambiado nada.';
  end if;

  -- ===================== tabla =====================
  create table public.agente_correos (
    id               uuid primary key default gen_random_uuid(),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    conversacion_id  uuid not null references public.agente_conversaciones(id) on delete cascade,
    tool_use_id      text not null check (char_length(tool_use_id) between 1 and 200),
    auth_user_id     uuid not null default auth.uid(),
    para             text[] not null check (cardinality(para) between 1 and 50),
    cc               text[] not null default '{}',
    cco              text[] not null default '{}',
    asunto           text not null check (char_length(asunto) between 1 and 255),
    texto            text not null check (char_length(texto) between 1 and 20000),
    documentos       uuid[] not null default '{}' check (cardinality(documentos) <= 10),
    adjuntos         jsonb not null default '[]'::jsonb check (jsonb_typeof(adjuntos) = 'array'),
    avisos           jsonb not null default '[]'::jsonb check (jsonb_typeof(avisos) = 'array'),
    contact_id       uuid references public.contactos(id) on delete set null,
    empresa_id       uuid references public.empresas(id) on delete set null,
    resumen          text not null check (char_length(resumen) between 1 and 300),
    estado           text not null default 'pendiente' check (estado in ('pendiente', 'enviando', 'enviada', 'cancelada')),
    expira_at        timestamptz not null default now() + interval '7 days',
    enviado_por      uuid references public.admins(id) on delete set null,
    enviado_at       timestamptz,
    graph_id         text,
    ultimo_error     text check (ultimo_error is null or char_length(ultimo_error) <= 500),
    resuelta_at      timestamptz,
    constraint agente_correos_tool_use_key unique (conversacion_id, tool_use_id),
    constraint agente_correos_total_chk check (cardinality(para) + cardinality(cc) + cardinality(cco) <= 50)
  );
  create index agente_correos_conv_idx on public.agente_correos (conversacion_id, created_at);
  create index agente_correos_pendientes_idx on public.agente_correos (created_at desc) where estado = 'pendiente';
  create trigger agente_correos_set_updated_at before update on public.agente_correos
    for each row execute function public.set_updated_at();

  alter table public.agente_correos enable row level security;
  create policy "agente: cada usuario lee sus correos; el rol admin, todos" on public.agente_correos
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: cada usuario redacta sus correos" on public.agente_correos
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()) and estado = 'pendiente');
  -- Editar o cancelar mientras está pendiente: quien lo redactó o el rol admin.
  -- Enviando/enviada solo lo pone la función correo (service role).
  create policy "agente: editar o cancelar correos pendientes" on public.agente_correos
    for update to authenticated
    using (estado = 'pendiente' and (select public.is_admin())
           and (auth_user_id = (select auth.uid()) or (select public.is_admin_role())))
    with check (estado in ('pendiente', 'cancelada') and (select public.is_admin())
                and (auth_user_id = (select auth.uid()) or (select public.is_admin_role())));
  revoke all on public.agente_correos from anon, authenticated;
  grant select, insert on public.agente_correos to authenticated;
  grant update (para, cc, cco, asunto, texto, documentos, adjuntos, avisos, contact_id, empresa_id, resumen, estado, resuelta_at)
    on public.agente_correos to authenticated;
  grant select, insert, update on public.agente_correos to service_role;

  -- Auditoría: también el envío de correos del asistente.
  alter table public.agente_escrituras drop constraint agente_escrituras_tabla_check;
  alter table public.agente_escrituras add constraint agente_escrituras_tabla_check
    check (tabla in ('empresas', 'contactos', 'contacto_empresa', 'deals', 'tareas', 'notas', 'agente_correos'));

  -- ===================== validar =====================
  -- Lista de emails: array de textos o un texto separado por comas o punto y
  -- coma; acepta «Nombre <x@y.es>». En minúsculas, sin repetir.
  create function public.agente_emails(p jsonb, k text)
  returns text[] language plpgsql immutable set search_path = public, pg_temp as $f$
  declare v jsonb; t text; e text; out text[] := '{}';
  begin
    if p is null or not (p ? k) or jsonb_typeof(p -> k) = 'null' then return out; end if;
    v := p -> k;
    if jsonb_typeof(v) = 'string' then
      v := to_jsonb(regexp_split_to_array(v #>> '{}', '\s*[,;]\s*'));
    elsif jsonb_typeof(v) <> 'array' then
      raise exception '"%" tiene que ser una lista de emails', k using errcode = '22023';
    end if;
    for t in select x #>> '{}' from jsonb_array_elements(v) x loop
      if t is null then continue; end if;
      e := lower(btrim(coalesce(substring(t from '<([^<>]*)>\s*$'), t)));
      if e = '' then continue; end if;
      if e !~ '^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$' or char_length(e) > 254 then
        raise exception 'Email no válido en "%": %', k, left(e, 80) using errcode = '22023';
      end if;
      if not e = any(out) then out := out || e; end if;
    end loop;
    if cardinality(out) > 50 then raise exception 'Demasiados destinatarios en "%"', k using errcode = '22023'; end if;
    return out;
  end $f$;

  create function public.agente_correo_preparar(p jsonb)
  returns jsonb language plpgsql stable set search_path = public, pg_temp as $f$
  declare
    v_para text[]; v_cc text[]; v_cco text[]; v_asunto text; v_texto text;
    v_contacto uuid; v_empresa uuid; v_nc text; v_ne text;
    v_docs uuid[] := '{}'; v_doc record; v_x jsonb; v_id uuid; v_tam bigint := 0;
    v_adj jsonb := '[]'::jsonb; v_avisos jsonb := '[]'::jsonb; e text; v_resumen text;
  begin
    if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Faltan los datos del correo' using errcode = '22023'; end if;
    perform public.agente_claves(p, array['para', 'cc', 'cco', 'asunto', 'texto', 'documentos', 'contact_id', 'empresa_id']);
    v_para := public.agente_emails(p, 'para');
    v_cc := public.agente_emails(p, 'cc');
    v_cco := public.agente_emails(p, 'cco');
    if cardinality(v_para) = 0 then raise exception 'Falta al menos un destinatario en "para"' using errcode = '22023'; end if;
    if cardinality(v_para) + cardinality(v_cc) + cardinality(v_cco) > 50 then
      raise exception 'Como mucho 50 destinatarios en total' using errcode = '22023';
    end if;
    v_asunto := public.agente_txt(p, 'asunto', 255);
    if v_asunto is null then raise exception 'Falta el asunto' using errcode = '22023'; end if;
    if not (p ? 'texto') or jsonb_typeof(p -> 'texto') <> 'string' then raise exception 'Falta el texto del correo' using errcode = '22023'; end if;
    v_texto := btrim(replace(p ->> 'texto', E'\r\n', E'\n'), E' \t\n');
    if v_texto = '' then raise exception 'Falta el texto del correo' using errcode = '22023'; end if;
    if char_length(v_texto) > 20000 then raise exception '"texto": como mucho 20000 caracteres' using errcode = '22023'; end if;

    v_contacto := public.agente_uuid(p, 'contact_id');
    if v_contacto is not null then
      select c.full_name into v_nc from public.contactos c where c.id = v_contacto;
      if not found then raise exception 'El contacto no existe o no tienes acceso' using errcode = 'GU010'; end if;
    end if;
    v_empresa := public.agente_uuid(p, 'empresa_id');
    if v_empresa is null and v_contacto is not null then
      select ce.empresa_id into v_empresa from public.contacto_empresa ce where ce.contact_id = v_contacto
       order by ce.principal desc, ce.created_at, ce.empresa_id limit 1;
    end if;
    if v_empresa is not null then
      select e2.razon_social into v_ne from public.empresas e2 where e2.id = v_empresa;
      if not found then raise exception 'La empresa no existe o no tienes acceso' using errcode = 'GU010'; end if;
    end if;

    if p ? 'documentos' and jsonb_typeof(p -> 'documentos') <> 'null' then
      if jsonb_typeof(p -> 'documentos') <> 'array' then raise exception '"documentos" tiene que ser una lista de id' using errcode = '22023'; end if;
      for v_x in select * from jsonb_array_elements(p -> 'documentos') loop
        v_id := public.agente_uuid(jsonb_build_object('documento', v_x), 'documento');
        if v_id is not null and not v_id = any(v_docs) then v_docs := v_docs || v_id; end if;
      end loop;
      if cardinality(v_docs) > 10 then raise exception 'Como mucho 10 documentos por correo' using errcode = '22023'; end if;
      if cardinality(v_docs) > 0 and v_empresa is null then
        raise exception 'Para adjuntar documentos, indica la empresa del correo (empresa_id)' using errcode = '22023';
      end if;
      foreach v_id in array v_docs loop
        select d.id, d.empresa_id, d.status, d.size_bytes, d.original_filename into v_doc from public.documentos d where d.id = v_id;
        if not found then raise exception 'El documento % no existe o no tienes acceso', v_id using errcode = 'GU010'; end if;
        if v_doc.empresa_id is distinct from v_empresa then
          raise exception 'El documento % no es de la empresa del correo', v_id using errcode = '22023';
        end if;
        if v_doc.status <> 'stored' then raise exception 'El documento % no está disponible', v_id using errcode = '22023'; end if;
        v_tam := v_tam + coalesce(v_doc.size_bytes, 0);
        v_adj := v_adj || jsonb_build_object('id', v_doc.id, 'nombre', coalesce(v_doc.original_filename, 'documento'), 'tamano', v_doc.size_bytes);
      end loop;
      if v_tam > 25 * 1024 * 1024 then raise exception 'Los adjuntos superan 25 MB' using errcode = '22023'; end if;
    end if;

    -- Avisos (no impiden enviar): direcciones que no son de ningún contacto del CRM.
    foreach e in array v_para || v_cc || v_cco loop
      if not exists (select 1 from public.contactos c where lower(btrim(c.email)) = e) then
        v_avisos := v_avisos || to_jsonb(e || ' no es el email de ningún contacto del CRM');
      end if;
    end loop;
    if v_contacto is not null and not exists (select 1 from public.contactos c where c.id = v_contacto
                                                and lower(btrim(c.email)) = any(v_para || v_cc || v_cco)) then
      v_avisos := v_avisos || to_jsonb('El email del contacto vinculado no está entre los destinatarios'::text);
    end if;

    v_resumen := left('Correo a ' || v_para[1] || case when cardinality(v_para) + cardinality(v_cc) + cardinality(v_cco) > 1
                 then ' y ' || (cardinality(v_para) + cardinality(v_cc) + cardinality(v_cco) - 1) || ' más' else '' end
                 || ': «' || left(v_asunto, 120) || '»', 300);
    return jsonb_build_object(
      'datos', jsonb_build_object('para', to_jsonb(v_para), 'cc', to_jsonb(v_cc), 'cco', to_jsonb(v_cco), 'asunto', v_asunto,
                                  'texto', v_texto, 'documentos', to_jsonb(v_docs), 'contact_id', v_contacto, 'empresa_id', v_empresa),
      'adjuntos', v_adj, 'avisos', v_avisos, 'resumen', v_resumen, 'contacto', v_nc, 'empresa', v_ne);
  end $f$;

  -- ===================== redactar, editar, cancelar =====================
  create function public.agente_proponer_correo(p_conversacion uuid, p_tool_use_id text, p_datos jsonb)
  returns jsonb language plpgsql volatile set search_path = public, pg_temp as $f$
  declare v jsonb; d jsonb; v_id uuid; v_exp timestamptz;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    if not exists (select 1 from public.agente_conversaciones c where c.id = p_conversacion and c.auth_user_id = auth.uid()) then
      raise exception 'Conversación no válida' using errcode = '42501';
    end if;
    v := public.agente_correo_preparar(p_datos);
    d := v -> 'datos';
    insert into public.agente_correos (conversacion_id, tool_use_id, para, cc, cco, asunto, texto, documentos, adjuntos, avisos,
                                       contact_id, empresa_id, resumen)
    values (p_conversacion, p_tool_use_id,
            array(select jsonb_array_elements_text(d -> 'para')), array(select jsonb_array_elements_text(d -> 'cc')),
            array(select jsonb_array_elements_text(d -> 'cco')), d ->> 'asunto', d ->> 'texto',
            array(select jsonb_array_elements_text(d -> 'documentos'))::uuid[], v -> 'adjuntos', v -> 'avisos',
            (d ->> 'contact_id')::uuid, (d ->> 'empresa_id')::uuid, v ->> 'resumen')
    returning id, expira_at into v_id, v_exp;
    return v || jsonb_build_object('id', v_id, 'estado', 'pendiente', 'expira_at', v_exp, 'puede_enviar', public.is_admin_role());
  end $f$;

  create function public.agente_correo_editar(p_correo uuid, p_datos jsonb)
  returns jsonb language plpgsql volatile set search_path = public, pg_temp as $f$
  declare c public.agente_correos%rowtype; v jsonb; d jsonb;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    select * into c from public.agente_correos x where x.id = p_correo;
    if not found then raise exception 'El correo no existe o no es tuyo' using errcode = 'GU010'; end if;
    if c.estado <> 'pendiente' then raise exception 'Este correo ya está %', c.estado using errcode = '22023'; end if;
    if c.expira_at < now() then raise exception 'El correo ha caducado: pídeselo otra vez al asistente' using errcode = '22023'; end if;
    v := public.agente_correo_preparar(p_datos);
    d := v -> 'datos';
    update public.agente_correos x set
      para = array(select jsonb_array_elements_text(d -> 'para')), cc = array(select jsonb_array_elements_text(d -> 'cc')),
      cco = array(select jsonb_array_elements_text(d -> 'cco')), asunto = d ->> 'asunto', texto = d ->> 'texto',
      documentos = array(select jsonb_array_elements_text(d -> 'documentos'))::uuid[], adjuntos = v -> 'adjuntos', avisos = v -> 'avisos',
      contact_id = (d ->> 'contact_id')::uuid, empresa_id = (d ->> 'empresa_id')::uuid, resumen = v ->> 'resumen'
    where x.id = p_correo and x.estado = 'pendiente';
    if not found then raise exception 'No tienes permiso para editar este correo' using errcode = '42501'; end if;
    return v || jsonb_build_object('id', p_correo, 'estado', 'pendiente');
  end $f$;

  create function public.agente_correo_cancelar(p_correo uuid)
  returns jsonb language plpgsql volatile set search_path = public, pg_temp as $f$
  declare c public.agente_correos%rowtype;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    select * into c from public.agente_correos x where x.id = p_correo;
    if not found then raise exception 'El correo no existe o no es tuyo' using errcode = 'GU010'; end if;
    if c.estado <> 'pendiente' then raise exception 'Este correo ya está %', c.estado using errcode = '22023'; end if;
    update public.agente_correos x set estado = 'cancelada', resuelta_at = now() where x.id = p_correo and x.estado = 'pendiente';
    if not found then raise exception 'No tienes permiso para cancelar este correo' using errcode = '42501'; end if;
    return jsonb_build_object('ok', true, 'id', p_correo, 'estado', 'cancelada');
  end $f$;

  revoke execute on function public.agente_emails(jsonb, text), public.agente_correo_preparar(jsonb),
    public.agente_proponer_correo(uuid, text, jsonb), public.agente_correo_editar(uuid, jsonb),
    public.agente_correo_cancelar(uuid) from public, anon;
  grant execute on function public.agente_emails(jsonb, text), public.agente_correo_preparar(jsonb),
    public.agente_proponer_correo(uuid, text, jsonb), public.agente_correo_editar(uuid, jsonb),
    public.agente_correo_cancelar(uuid) to authenticated;

  insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261128140000', 'Agente: correos desde info@ con tarjeta (crm/supabase-agente-correo.sql)', array[]::text[]);
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 11C (verificación, solo lectura) — Lo esperado:
--   RLS en agente_correos: true      políticas: 3
--   funciones nuevas (invoker): 5    con EXECUTE para anon: 0
--   authenticated correos s/i/u/d: true/true/false/false   (update solo por columnas: ver la siguiente)
--   authenticated insert / update(estado) / update(enviado_por): true/true/false
--   tabla agente_correos admitida en la auditoría: sí
--   filas: 0       migración registrada: 20261128140000 …
-- ============================================================
select 'RLS en agente_correos' as comprobacion,
       (select relrowsecurity::text from pg_class where oid = 'public.agente_correos'::regclass) as valor
union all select 'políticas',
       (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'agente_correos')
union all select 'funciones nuevas (invoker)',
       (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and not prosecdef
          and proname in ('agente_emails', 'agente_correo_preparar', 'agente_proponer_correo', 'agente_correo_editar', 'agente_correo_cancelar'))
union all select 'con EXECUTE para anon',
       (select count(*)::text from pg_proc where pronamespace = 'public'::regnamespace
          and proname in ('agente_emails', 'agente_correo_preparar', 'agente_proponer_correo', 'agente_correo_editar', 'agente_correo_cancelar')
          and has_function_privilege('anon', oid, 'execute'))
union all select 'authenticated correos s/i/u/d',
       has_table_privilege('authenticated', 'public.agente_correos', 'select')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_correos', 'insert')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_correos', 'update')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_correos', 'delete')::text
union all select 'authenticated insert / update(estado) / update(enviado_por)',
       has_table_privilege('authenticated', 'public.agente_correos', 'insert')::text || '/' ||
       has_column_privilege('authenticated', 'public.agente_correos', 'estado', 'update')::text || '/' ||
       has_column_privilege('authenticated', 'public.agente_correos', 'enviado_por', 'update')::text
union all select 'tabla agente_correos admitida en la auditoría',
       case when pg_get_constraintdef((select oid from pg_constraint where conrelid = 'public.agente_escrituras'::regclass
                                         and conname = 'agente_escrituras_tabla_check')) like '%agente_correos%' then 'sí' else 'no' end
union all select 'filas',
       (select count(*)::text from public.agente_correos)
union all select 'migración registrada',
       (select version || ' ' || name from supabase_migrations.schema_migrations where version = '20261128140000');
