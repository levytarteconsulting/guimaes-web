-- ============================================================
-- GUIMAES — Agente de IA del CRM, fase 1B: base de datos (solo lectura)
--
-- Qué crea:
--   * 12 RPC de LECTURA que usará la Edge Function "agente" como
--     herramientas del modelo. Todas:
--       - SECURITY INVOKER: se ejecutan con el JWT de quien pregunta, así
--         que la RLS de cada tabla sigue mandando. Nunca con service role.
--       - STABLE, search_path fijo, devuelven jsonb.
--       - Empiezan exigiendo public.is_admin() (usuario activo del CRM,
--         admin o miembro): segunda barrera además de la RLS.
--       - Recortan el límite de filas y el tamaño de los textos aquí, en
--         la base de datos, no en la función.
--       - EXECUTE solo para authenticated.
--     agente_buscar, agente_ficha_empresa, agente_ficha_contacto,
--     agente_listar_deals, agente_listar_tareas, agente_listar_documentos,
--     agente_listar_conversaciones_whatsapp, agente_leer_whatsapp,
--     agente_buscar_correos, agente_leer_correo, agente_listar_leads,
--     agente_resumen_actividad.
--   * 4 auxiliares sin acceso a datos (normalizar texto sin acentos, patrón
--     LIKE escapado, recortar texto, HTML de correo a texto plano) y
--     agente_fecha (hora de Madrid). Solo authenticated.
--   * Auditoría: agente_conversaciones, agente_mensajes, agente_tool_calls.
--       - Cada usuario lee sus conversaciones; el rol admin
--         (is_admin_role()) lee las de todos. Un miembro no ve las ajenas.
--       - Se escriben con el JWT del usuario: solo insertar (más renombrar
--         o archivar sus conversaciones). Mensajes y llamadas no se pueden
--         cambiar ni borrar desde el CRM: el historial solo crece (lo exige
--         además la API para devolver intactos los bloques de thinking).
--       - auth_user_id lo pone la base de datos (default auth.uid()); quien
--         inserta no puede elegirlo.
--   * Retención: agente_retencion(90) borra las conversaciones sin
--     actividad en 90 días (mensajes y llamadas, en cascada). pg_cron la
--     lanza cada día a las 03:40 UTC (job "agente-retencion").
--   * Registro en supabase_migrations.schema_migrations y notify pgrst.
--
-- Errores: 42501 = no es usuario activo del CRM; 22023 = parámetro no
-- válido (el mensaje se le devuelve al modelo para que corrija la llamada).
--
-- Requiere: admins, empresas, contactos, contacto_empresa, deals, tareas,
-- notas, leads, documentos, carpetas, whatsapp_*, correo_mensajes,
-- correo_adjuntos, empresa_solicitudes; is_admin, is_admin_role,
-- correo_emails_de, set_updated_at; pg_cron.
--
-- Orden: 1A → copia (pg_dump) → 1B → 1C.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado en la columna valor:
--   tablas base: 15 · columnas usadas: 137 · funciones base: 4 · pg_cron: sí
--   tablas agente_*: 0 · funciones agente_*: 0 · job agente-retencion: 0
--   migración 20261113120000: no
-- ============================================================
select 'tablas base' as comprobacion, count(*)::text as valor
from pg_tables where schemaname = 'public' and tablename in (
  'admins', 'empresas', 'contactos', 'contacto_empresa', 'deals', 'tareas', 'notas', 'leads', 'documentos',
  'carpetas', 'whatsapp_conversations', 'whatsapp_messages', 'correo_mensajes', 'correo_adjuntos', 'empresa_solicitudes')
union all
select 'columnas usadas', count(*)::text
from information_schema.columns c
join (values
  ('empresas', 'id'), ('empresas', 'razon_social'), ('empresas', 'cif'), ('empresas', 'address'), ('empresas', 'city'),
  ('empresas', 'province'), ('empresas', 'provisional_at'), ('empresas', 'archived_at'), ('empresas', 'created_at'),
  ('contactos', 'id'), ('contactos', 'full_name'), ('contactos', 'email'), ('contactos', 'phone'), ('contactos', 'dni'),
  ('contactos', 'company'), ('contactos', 'city'), ('contactos', 'province'), ('contactos', 'employees'),
  ('contactos', 'lifecycle'), ('contactos', 'priority'), ('contactos', 'owner'), ('contactos', 'source'), ('contactos', 'kyc'),
  ('contactos', 'auth_user_id'), ('contactos', 'lead_id'), ('contactos', 'provisional_at'), ('contactos', 'created_at'),
  ('contacto_empresa', 'contact_id'), ('contacto_empresa', 'empresa_id'), ('contacto_empresa', 'principal'),
  ('deals', 'id'), ('deals', 'title'), ('deals', 'contact_id'), ('deals', 'empresa_id'), ('deals', 'service'), ('deals', 'stage'),
  ('deals', 'owner'), ('deals', 'amount'), ('deals', 'frequency'), ('deals', 'priority'), ('deals', 'loss_reason'),
  ('deals', 'signed_at'), ('deals', 'renewal_at'), ('deals', 'num_nominas'), ('deals', 'coste_nomina'), ('deals', 'origen'),
  ('deals', 'created_at'), ('deals', 'updated_at'),
  ('tareas', 'id'), ('tareas', 'title'), ('tareas', 'due_at'), ('tareas', 'assigned_to'), ('tareas', 'status'),
  ('tareas', 'archived'), ('tareas', 'contact_id'), ('tareas', 'deal_id'), ('tareas', 'created_at'),
  ('notas', 'id'), ('notas', 'body'), ('notas', 'author'), ('notas', 'contact_id'), ('notas', 'deal_id'), ('notas', 'created_at'),
  ('leads', 'id'), ('leads', 'created_at'), ('leads', 'nombre'), ('leads', 'empresa'), ('leads', 'email'), ('leads', 'telefono'),
  ('leads', 'servicio'), ('leads', 'mensaje'), ('leads', 'source'), ('leads', 'page'), ('leads', 'status'),
  ('leads', 'meta_leadgen_id'), ('leads', 'contact_id'), ('leads', 'utm_source'), ('leads', 'utm_medium'), ('leads', 'utm_campaign'),
  ('documentos', 'id'), ('documentos', 'created_at'), ('documentos', 'mime_type'), ('documentos', 'size_bytes'),
  ('documentos', 'original_filename'), ('documentos', 'status'), ('documentos', 'source'), ('documentos', 'visible'),
  ('documentos', 'folder_id'), ('documentos', 'empresa_id'), ('documentos', 'aportado_por_contact_id'),
  ('documentos', 'whatsapp_message_id'),
  ('carpetas', 'id'), ('carpetas', 'nombre'), ('carpetas', 'empresa_id'), ('carpetas', 'parent_id'),
  ('whatsapp_conversations', 'id'), ('whatsapp_conversations', 'contact_id'), ('whatsapp_conversations', 'phone'),
  ('whatsapp_conversations', 'wa_id'), ('whatsapp_conversations', 'last_customer_message_at'),
  ('whatsapp_conversations', 'owner'), ('whatsapp_conversations', 'archived'), ('whatsapp_conversations', 'updated_at'),
  ('whatsapp_messages', 'id'), ('whatsapp_messages', 'conversation_id'), ('whatsapp_messages', 'direction'),
  ('whatsapp_messages', 'type'), ('whatsapp_messages', 'body'), ('whatsapp_messages', 'delivery_status'),
  ('whatsapp_messages', 'created_at'),
  ('correo_mensajes', 'id'), ('correo_mensajes', 'conversation_id'), ('correo_mensajes', 'carpeta'),
  ('correo_mensajes', 'remitente_email'), ('correo_mensajes', 'remitente_nombre'), ('correo_mensajes', 'para'),
  ('correo_mensajes', 'cc'), ('correo_mensajes', 'asunto'), ('correo_mensajes', 'extracto'), ('correo_mensajes', 'cuerpo_html'),
  ('correo_mensajes', 'fecha'), ('correo_mensajes', 'leido'), ('correo_mensajes', 'tiene_adjuntos'),
  ('correo_mensajes', 'fuera_bandeja'), ('correo_mensajes', 'emails_norm'), ('correo_mensajes', 'contact_id'),
  ('correo_mensajes', 'empresa_id'),
  ('correo_adjuntos', 'mensaje_id'), ('correo_adjuntos', 'nombre'), ('correo_adjuntos', 'tipo'), ('correo_adjuntos', 'tamano'),
  ('correo_adjuntos', 'inline'),
  ('empresa_solicitudes', 'empresa_id'), ('empresa_solicitudes', 'campo'), ('empresa_solicitudes', 'valor_solicitado'),
  ('empresa_solicitudes', 'estado'), ('empresa_solicitudes', 'created_at')
) x(t, col) on c.table_schema = 'public' and c.table_name = x.t and c.column_name = x.col
union all
select 'funciones base', count(*)::text from (values
  (to_regprocedure('public.is_admin(uuid)')), (to_regprocedure('public.is_admin_role(uuid)')),
  (to_regprocedure('public.correo_emails_de(jsonb)')), (to_regprocedure('public.set_updated_at()'))) f(p)
where f.p is not null
union all
select 'pg_cron', case when exists (select 1 from pg_extension where extname = 'pg_cron') then 'sí' else 'no' end
union all
select 'tablas agente_*', count(*)::text from pg_tables where schemaname = 'public' and tablename like 'agente\_%'
union all
select 'funciones agente_*', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'agente\_%'
union all
select 'job agente-retencion', count(*)::text from cron.job where jobname = 'agente-retencion'
union all
select 'migración 20261113120000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261113120000') then 'sí' else 'no' end;


-- ============================================================
-- 1B (CAMBIO) — Un único DO; se niega a ejecutarse dos veces.
-- ============================================================
do $b1$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261113120000')
     or to_regclass('public.agente_conversaciones') is not null then
    raise exception 'La migración 20261113120000 ya está aplicada: 1B no se repite. No se ha cambiado nada.';
  end if;

  -- ===================== auxiliares (sin acceso a datos) =====================

  -- Minúsculas y sin acentos (no hay unaccent instalado).
  create function public.agente_norm(p text)
  returns text language sql immutable set search_path = public, pg_temp
  as $f$
    select lower(translate(coalesce(p, ''),
      'ÁÀÂÄÃáàâäãÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
      'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'))
  $f$;

  -- '%texto%' normalizado, con %, _ y \ escapados: lo que escribe el modelo
  -- se busca literalmente.
  create function public.agente_patron(p text)
  returns text language sql immutable set search_path = public, pg_temp
  as $f$
    select '%' || replace(replace(replace(public.agente_norm(btrim(p)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  $f$;

  create function public.agente_corta(p text, n integer)
  returns text language sql immutable set search_path = public, pg_temp
  as $f$
    select case when p is null then null when length(p) > n then left(p, n) || '…' else p end
  $f$;

  -- Fechas para el modelo, en hora de Madrid ('2026-11-13 10:05').
  create function public.agente_fecha(t timestamptz)
  returns text language sql stable set search_path = public, pg_temp
  as $f$
    select to_char(t at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI')
  $f$;

  -- HTML de correo a texto plano (sin estilos, scripts ni etiquetas). Solo
  -- los primeros 200.000 caracteres, para acotar el coste.
  create function public.agente_html_a_texto(p text)
  returns text language plpgsql immutable set search_path = public, pg_temp
  as $f$
  declare
    t text := left(coalesce(p, ''), 200000);
  begin
    t := regexp_replace(t, '<(style|script|head|title)\y[^>]*?>.*?</\1\s*>', ' ', 'gi');
    t := regexp_replace(t, '<!--.*?-->', ' ', 'g');
    t := regexp_replace(t, '<br\s*/?>', E'\n', 'gi');
    t := regexp_replace(t, '</(p|div|tr|h[1-6]|blockquote|table|ul|ol)\s*>', E'\n', 'gi');
    t := regexp_replace(t, '<li\y[^>]*>', E'\n- ', 'gi');
    t := regexp_replace(t, '<[^>]*>', '', 'g');
    t := replace(t, '&nbsp;', ' ');
    t := replace(t, '&lt;', '<');
    t := replace(t, '&gt;', '>');
    t := replace(t, '&quot;', '"');
    t := replace(t, '&#39;', '''');
    t := replace(t, '&apos;', '''');
    t := replace(t, '&amp;', '&');
    t := regexp_replace(t, '[ \t\r\f\v]+', ' ', 'g');
    t := regexp_replace(t, ' ?\n ?', E'\n', 'g');
    t := regexp_replace(t, '\n{3,}', E'\n\n', 'g');
    return btrim(t, E' \n');
  end
  $f$;

  -- ===================== 1. buscar =====================
  create function public.agente_buscar(p_q text, p_tipos text[] default null, p_limite integer default 10)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 10), 1), 25);
    v_tipos text[] := coalesce(p_tipos, array['empresa', 'contacto', 'deal']);
    v_pat text;
    v_dig text;
    v_res jsonb := '[]';
    v_trunc boolean := false;
    v_part jsonb;
    v_n int;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_q is null or length(btrim(p_q)) < 2 then
      raise exception 'agente_buscar: escribe al menos 2 caracteres' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_tipos) t where t is null or t not in ('empresa', 'contacto', 'deal')) then
      raise exception 'agente_buscar: tipos válidos: empresa, contacto, deal' using errcode = '22023';
    end if;
    v_pat := public.agente_patron(p_q);
    v_dig := regexp_replace(p_q, '\D', '', 'g');
    if length(v_dig) < 6 then v_dig := null; end if;

    if 'empresa' = any (v_tipos) then
      select coalesce(jsonb_agg(x.j order by x.o), '[]'), count(*) into v_part, v_n from (
        select e.razon_social as o,
               jsonb_build_object('tipo', 'empresa', 'id', e.id, 'titulo', e.razon_social,
                 'subtitulo', concat_ws(' · ', e.cif, e.city,
                   case when e.archived_at is not null then 'archivada' end,
                   case when e.provisional_at is not null then 'alta pendiente de validar' end)) as j
        from public.empresas e
        where public.agente_norm(e.razon_social) like v_pat or public.agente_norm(e.cif) like v_pat
        order by e.razon_social
        limit v_lim + 1) x;
      if v_n > v_lim then v_part := v_part - v_lim; v_trunc := true; end if;
      v_res := v_res || v_part;
    end if;

    if 'contacto' = any (v_tipos) then
      select coalesce(jsonb_agg(x.j order by x.o), '[]'), count(*) into v_part, v_n from (
        select coalesce(c.full_name, c.email, '') as o,
               jsonb_build_object('tipo', 'contacto', 'id', c.id,
                 'titulo', coalesce(c.full_name, c.email, '(sin nombre)'),
                 'subtitulo', concat_ws(' · ', c.email, c.phone, c.company)) as j
        from public.contactos c
        where public.agente_norm(c.full_name) like v_pat
           or public.agente_norm(c.email) like v_pat
           or public.agente_norm(c.company) like v_pat
           or public.agente_norm(c.dni) like v_pat
           or (v_dig is not null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || v_dig || '%')
        order by 1
        limit v_lim + 1) x;
      if v_n > v_lim then v_part := v_part - v_lim; v_trunc := true; end if;
      v_res := v_res || v_part;
    end if;

    if 'deal' = any (v_tipos) then
      select coalesce(jsonb_agg(x.j order by x.o desc), '[]'), count(*) into v_part, v_n from (
        select d.updated_at as o,
               jsonb_build_object('tipo', 'deal', 'id', d.id, 'titulo', coalesce(d.title, '(sin título)'),
                 'subtitulo', concat_ws(' · ', e.razon_social, d.stage, d.service, d.amount::text)) as j
        from public.deals d
        left join public.empresas e on e.id = d.empresa_id
        where public.agente_norm(d.title) like v_pat
        order by d.updated_at desc
        limit v_lim + 1) x;
      if v_n > v_lim then v_part := v_part - v_lim; v_trunc := true; end if;
      v_res := v_res || v_part;
    end if;

    return jsonb_build_object('resultados', v_res, 'truncado', v_trunc);
  end
  $f$;

  -- ===================== 2. ficha_empresa =====================
  create function public.agente_ficha_empresa(p_empresa_id uuid)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
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
        'provincia', e.province, 'alta_pendiente_validar', e.provisional_at is not null,
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

  -- ===================== 3. ficha_contacto =====================
  create function public.agente_ficha_contacto(p_contact_id uuid)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    c public.contactos%rowtype;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    select * into c from public.contactos where id = p_contact_id;
    if not found then
      return jsonb_build_object('encontrado', false);
    end if;
    return jsonb_build_object(
      'encontrado', true,
      'contacto', jsonb_build_object(
        'id', c.id, 'nombre', c.full_name, 'email', c.email, 'telefono', c.phone, 'dni', c.dni,
        'empresa_texto', c.company, 'ciudad', c.city, 'provincia', c.province, 'empleados', c.employees,
        'ciclo_vida', c.lifecycle, 'prioridad', c.priority, 'owner', c.owner, 'origen', c.source, 'kyc', c.kyc,
        'cuenta_portal', c.auth_user_id is not null, 'alta_provisional', c.provisional_at is not null,
        'creado', public.agente_fecha(c.created_at)),
      'empresas', (select coalesce(jsonb_agg(x.j order by x.p desc, x.n), '[]') from (
          select ce.principal as p, e.razon_social as n,
                 jsonb_build_object('id', e.id, 'razon_social', e.razon_social, 'principal', ce.principal,
                   'archivada', e.archived_at is not null) as j
          from public.contacto_empresa ce join public.empresas e on e.id = ce.empresa_id
          where ce.contact_id = c.id
          order by ce.principal desc, e.razon_social
          limit 20) x),
      'deals', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by d.updated_at desc) as o,
                 jsonb_build_object('id', d.id, 'titulo', d.title, 'servicio', d.service, 'etapa', d.stage,
                   'importe', d.amount, 'frecuencia', d.frequency, 'owner', d.owner,
                   'firmado', d.signed_at, 'renovacion', d.renewal_at, 'empresa_id', d.empresa_id) as j
          from public.deals d where d.contact_id = c.id
          order by d.updated_at desc
          limit 20) x),
      'tareas_abiertas', (select coalesce(jsonb_agg(x.j order by x.o nulls last), '[]') from (
          select t.due_at as o,
                 jsonb_build_object('id', t.id, 'titulo', t.title, 'vence', public.agente_fecha(t.due_at),
                   'vencida', t.due_at < now(), 'asignada_a', t.assigned_to, 'deal_id', t.deal_id) as j
          from public.tareas t
          where t.status <> 'done' and not t.archived
            and (t.contact_id = c.id or t.deal_id in (select id from public.deals where contact_id = c.id))
          order by t.due_at nulls last
          limit 20) x),
      'notas', (select coalesce(jsonb_agg(x.j order by x.o desc), '[]') from (
          select n.created_at as o,
                 jsonb_build_object('fecha', public.agente_fecha(n.created_at), 'autor', n.author,
                   'texto', public.agente_corta(n.body, 500), 'deal_id', n.deal_id) as j
          from public.notas n
          where n.contact_id = c.id or n.deal_id in (select id from public.deals where contact_id = c.id)
          order by n.created_at desc
          limit 10) x),
      'formularios', (select coalesce(jsonb_agg(x.j order by x.o desc), '[]') from (
          select l.created_at as o,
                 jsonb_build_object('id', l.id, 'fecha', public.agente_fecha(l.created_at), 'servicio', l.servicio,
                   'origen', l.source, 'pagina', l.page, 'campana', l.utm_campaign,
                   'mensaje', public.agente_corta(l.mensaje, 500)) as j
          from public.leads l
          where (l.id = c.lead_id or l.contact_id = c.id) and coalesce(l.status, '') <> 'deleted'
          order by l.created_at desc
          limit 5) x),
      'recuentos', jsonb_build_object(
        'correos', (select count(*) from public.correo_mensajes where contact_id = c.id),
        'conversaciones_whatsapp', (select count(*) from public.whatsapp_conversations where contact_id = c.id),
        'documentos_aportados', (select count(*) from public.documentos where aportado_por_contact_id = c.id))
    );
  end
  $f$;

  -- ===================== 4. listar_deals =====================
  create function public.agente_listar_deals(
    p_etapa text default null, p_servicio text default null, p_owner text default null,
    p_empresa_id uuid default null, p_contact_id uuid default null,
    p_renovacion_antes date default null, p_firmado_desde date default null, p_limite integer default 25)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 25), 1), 50);
    v jsonb;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    with f as (
      select d.* from public.deals d
      where (p_etapa is null or d.stage = p_etapa)
        and (p_servicio is null or d.service = p_servicio)
        and (p_owner is null or d.owner = p_owner)
        and (p_empresa_id is null or d.empresa_id = p_empresa_id)
        and (p_contact_id is null or d.contact_id = p_contact_id)
        and (p_renovacion_antes is null or d.renewal_at <= p_renovacion_antes)
        and (p_firmado_desde is null or d.signed_at >= p_firmado_desde)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'por_etapa', (select coalesce(jsonb_agg(jsonb_build_object('etapa', s.stage, 'n', s.n, 'importe_por_frecuencia', s.imp)
                                              order by s.n desc, s.stage), '[]')
                    from (select stage, sum(n)::int as n, jsonb_object_agg(coalesce(frequency, 'sin_frecuencia'), imp) as imp
                          from (select stage, frequency, count(*) as n, coalesce(sum(amount), 0) as imp
                                from f group by stage, frequency) y
                          group by stage) s),
      'deals', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by case when p_renovacion_antes is not null then f.renewal_at end asc nulls last,
                                             f.updated_at desc) as o,
                 jsonb_build_object('id', f.id, 'titulo', f.title, 'servicio', f.service, 'etapa', f.stage,
                   'importe', f.amount, 'frecuencia', f.frequency, 'owner', f.owner, 'prioridad', f.priority,
                   'firmado', f.signed_at, 'renovacion', f.renewal_at, 'motivo_perdida', f.loss_reason,
                   'empresa', case when e.id is not null then jsonb_build_object('id', e.id, 'razon_social', e.razon_social) end,
                   'contacto', case when c.id is not null then jsonb_build_object('id', c.id, 'nombre', c.full_name) end,
                   'actualizado', public.agente_fecha(f.updated_at)) as j
          from f
          left join public.empresas e on e.id = f.empresa_id
          left join public.contactos c on c.id = f.contact_id
          order by 1
          limit v_lim) x)
    ) into v;
    return v || jsonb_build_object('truncado', (v->>'total')::int > v_lim);
  end
  $f$;

  -- ===================== 5. listar_tareas =====================
  create function public.agente_listar_tareas(
    p_estado text default null, p_asignada_a text default null, p_vencidas boolean default false,
    p_vencen_antes timestamptz default null, p_contact_id uuid default null, p_deal_id uuid default null,
    p_incluir_archivadas boolean default false, p_limite integer default 25)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 25), 1), 50);
    v jsonb;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_estado is not null and p_estado not in ('pending', 'done') then
      raise exception 'agente_listar_tareas: estado válido: pending o done' using errcode = '22023';
    end if;
    with f as (
      select t.* from public.tareas t
      where (p_estado is null or t.status = p_estado)
        and (p_asignada_a is null or t.assigned_to = p_asignada_a)
        and (not coalesce(p_vencidas, false) or (t.due_at < now() and t.status <> 'done'))
        and (p_vencen_antes is null or t.due_at <= p_vencen_antes)
        and (p_contact_id is null or t.contact_id = p_contact_id)
        and (p_deal_id is null or t.deal_id = p_deal_id)
        and (coalesce(p_incluir_archivadas, false) or not t.archived)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'tareas', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by f.due_at asc nulls last, f.created_at desc) as o,
                 jsonb_build_object('id', f.id, 'titulo', f.title, 'vence', public.agente_fecha(f.due_at),
                   'vencida', f.due_at < now() and f.status <> 'done', 'asignada_a', f.assigned_to,
                   'estado', f.status, 'archivada', f.archived,
                   'contacto', case when c.id is not null then jsonb_build_object('id', c.id, 'nombre', c.full_name) end,
                   'deal', case when d.id is not null then jsonb_build_object('id', d.id, 'titulo', d.title) end) as j
          from f
          left join public.contactos c on c.id = f.contact_id
          left join public.deals d on d.id = f.deal_id
          order by 1
          limit v_lim) x)
    ) into v;
    return v || jsonb_build_object('truncado', (v->>'total')::int > v_lim);
  end
  $f$;

  -- ===================== 6. listar_documentos (solo metadatos) =====================
  create function public.agente_listar_documentos(
    p_empresa_id uuid, p_carpeta_id uuid default null, p_q text default null, p_origen text default null,
    p_desde timestamptz default null, p_limite integer default 30)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 30), 1), 100);
    v_pat text := case when nullif(btrim(coalesce(p_q, '')), '') is not null then public.agente_patron(p_q) end;
    v jsonb;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_empresa_id is null then
      raise exception 'agente_listar_documentos: falta empresa_id' using errcode = '22023';
    end if;
    if p_origen is not null and p_origen not in ('manual', 'whatsapp', 'cliente') then
      raise exception 'agente_listar_documentos: origen válido: manual, whatsapp o cliente' using errcode = '22023';
    end if;
    if not exists (select 1 from public.empresas where id = p_empresa_id) then
      return jsonb_build_object('encontrada', false);
    end if;
    if p_carpeta_id is not null
       and not exists (select 1 from public.carpetas where id = p_carpeta_id and empresa_id = p_empresa_id) then
      raise exception 'agente_listar_documentos: esa carpeta no es de esta empresa' using errcode = '22023';
    end if;

    with recursive r as (      -- ruta legible de cada carpeta de la empresa
      select k.id, k.nombre::text as ruta from public.carpetas k where k.empresa_id = p_empresa_id and k.parent_id is null
      union all
      select k.id, r.ruta || ' / ' || k.nombre from public.carpetas k join r on k.parent_id = r.id
      where k.empresa_id = p_empresa_id
    ),
    sub as (                   -- la carpeta pedida y todas sus subcarpetas
      select k.id from public.carpetas k where k.id = p_carpeta_id and k.empresa_id = p_empresa_id
      union all
      select k.id from public.carpetas k join sub on k.parent_id = sub.id where k.empresa_id = p_empresa_id
    ),
    f as (
      select d.*, r.ruta from public.documentos d
      left join r on r.id = d.folder_id
      where d.empresa_id = p_empresa_id
        and (p_carpeta_id is null or d.folder_id in (select id from sub))
        and (v_pat is null or public.agente_norm(d.original_filename) like v_pat)
        and (p_origen is null or d.source = p_origen)
        and (p_desde is null or d.created_at >= p_desde)
    )
    select jsonb_build_object(
      'encontrada', true,
      'total', (select count(*) from f),
      'documentos', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by f.created_at desc) as o,
                 jsonb_build_object('id', f.id, 'nombre', f.original_filename, 'carpeta', f.ruta, 'tipo', f.mime_type,
                   'tamano_kb', round(coalesce(f.size_bytes, 0) / 1024.0)::bigint, 'fecha', public.agente_fecha(f.created_at),
                   'origen', f.source, 'estado', f.status, 'visible_en_portal', f.visible,
                   'aportado_por', case when c.id is not null then jsonb_build_object('id', c.id, 'nombre', c.full_name) end) as j
          from f left join public.contactos c on c.id = f.aportado_por_contact_id
          order by 1
          limit v_lim) x)
    ) into v;
    return v || jsonb_build_object('truncado', (v->>'total')::int > v_lim);
  end
  $f$;

  -- ===================== 7. listar_conversaciones_whatsapp =====================
  create function public.agente_listar_conversaciones_whatsapp(
    p_contact_id uuid default null, p_sin_responder boolean default false,
    p_incluir_archivadas boolean default false, p_limite integer default 20)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 20), 1), 50);
    v jsonb;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    with f as (
      select w.*, u.direction as u_dir, u.type as u_tipo, u.body as u_body, u.created_at as u_fecha
      from public.whatsapp_conversations w
      left join lateral (select m.direction, m.type, m.body, m.created_at from public.whatsapp_messages m
                         where m.conversation_id = w.id order by m.created_at desc limit 1) u on true
      where (p_contact_id is null or w.contact_id = p_contact_id)
        and (coalesce(p_incluir_archivadas, false) or not w.archived)
        and (not coalesce(p_sin_responder, false) or u.direction = 'in')
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'conversaciones', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by coalesce(f.u_fecha, f.updated_at) desc) as o,
                 jsonb_build_object('id', f.id,
                   'contacto', case when c.id is not null then jsonb_build_object('id', c.id, 'nombre', c.full_name) end,
                   'telefono', coalesce(f.phone, '+' || f.wa_id), 'owner', f.owner, 'archivada', f.archived,
                   'ultimo_mensaje', case when f.u_fecha is not null then jsonb_build_object(
                     'fecha', public.agente_fecha(f.u_fecha), 'de', case when f.u_dir = 'in' then 'cliente' else 'despacho' end,
                     'tipo', f.u_tipo, 'texto', public.agente_corta(f.u_body, 300)) end,
                   'sin_responder', f.u_dir = 'in',
                   'ventana_24h_abierta', coalesce(f.last_customer_message_at > now() - interval '24 hours', false)) as j
          from f left join public.contactos c on c.id = f.contact_id
          order by 1
          limit v_lim) x)
    ) into v;
    return v || jsonb_build_object('truncado', (v->>'total')::int > v_lim);
  end
  $f$;

  -- ===================== 8. leer_whatsapp =====================
  create function public.agente_leer_whatsapp(
    p_conversation_id uuid, p_desde timestamptz default null, p_limite integer default 30)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 30), 1), 80);
    w public.whatsapp_conversations%rowtype;
    v_total int;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    select * into w from public.whatsapp_conversations where id = p_conversation_id;
    if not found then
      return jsonb_build_object('encontrada', false);
    end if;
    select count(*) into v_total from public.whatsapp_messages
    where conversation_id = w.id and (p_desde is null or created_at >= p_desde);
    return jsonb_build_object(
      'encontrada', true,
      'conversacion', jsonb_build_object('id', w.id, 'telefono', coalesce(w.phone, '+' || w.wa_id),
        'contacto', (select jsonb_build_object('id', c.id, 'nombre', c.full_name) from public.contactos c where c.id = w.contact_id),
        'ventana_24h_abierta', coalesce(w.last_customer_message_at > now() - interval '24 hours', false)),
      'total', v_total,
      'truncado', v_total > v_lim,
      'mensajes', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select m.created_at as o,
                 jsonb_build_object('fecha', public.agente_fecha(m.created_at),
                   'de', case when m.direction = 'in' then 'cliente' else 'despacho' end,
                   'tipo', m.type, 'texto', public.agente_corta(m.body, 800), 'estado_entrega', m.delivery_status,
                   'documento', (select jsonb_build_object('id', d.id, 'nombre', d.original_filename)
                                 from public.documentos d where d.whatsapp_message_id = m.id)) as j
          from public.whatsapp_messages m
          where m.conversation_id = w.id and (p_desde is null or m.created_at >= p_desde)
          order by m.created_at desc
          limit v_lim) x)
    );
  end
  $f$;

  -- ===================== 9. buscar_correos =====================
  create function public.agente_buscar_correos(
    p_q text default null, p_contact_id uuid default null, p_empresa_id uuid default null, p_carpeta text default null,
    p_desde timestamptz default null, p_hasta timestamptz default null, p_no_leidos boolean default false,
    p_limite integer default 15)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 15), 1), 40);
    v_pat text := case when nullif(btrim(coalesce(p_q, '')), '') is not null then public.agente_patron(p_q) end;
    v jsonb;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_carpeta is not null and p_carpeta not in ('inbox', 'sentitems') then
      raise exception 'agente_buscar_correos: carpeta válida: inbox o sentitems' using errcode = '22023';
    end if;
    with f as (
      select m.* from public.correo_mensajes m
      where (v_pat is null
             or public.agente_norm(m.asunto) like v_pat
             or public.agente_norm(m.extracto) like v_pat
             or public.agente_norm(m.remitente_nombre) like v_pat
             or exists (select 1 from unnest(m.emails_norm) x(e) where x.e like v_pat))
        and (p_contact_id is null or m.contact_id = p_contact_id)
        and (p_empresa_id is null or m.empresa_id = p_empresa_id)
        and (p_carpeta is null or m.carpeta = p_carpeta)
        and (p_desde is null or m.fecha >= p_desde)
        and (p_hasta is null or m.fecha < p_hasta)
        and (not coalesce(p_no_leidos, false) or (not m.leido and m.carpeta = 'inbox'))
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'correos', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by f.fecha desc) as o,
                 jsonb_build_object('id', f.id, 'fecha', public.agente_fecha(f.fecha), 'carpeta', f.carpeta,
                   'de', jsonb_build_object('nombre', f.remitente_nombre, 'email', f.remitente_email),
                   'para', to_jsonb(public.correo_emails_de(f.para)),
                   'asunto', public.agente_corta(f.asunto, 200), 'extracto', public.agente_corta(f.extracto, 300),
                   'leido', f.leido, 'adjuntos', f.tiene_adjuntos, 'fuera_de_bandeja', f.fuera_bandeja,
                   'contacto_id', f.contact_id, 'empresa_id', f.empresa_id) as j
          from f
          order by 1
          limit v_lim) x)
    ) into v;
    return v || jsonb_build_object('truncado', (v->>'total')::int > v_lim);
  end
  $f$;

  -- ===================== 10. leer_correo =====================
  create function public.agente_leer_correo(p_mensaje_id uuid)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    m public.correo_mensajes%rowtype;
    v_texto text;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    select * into m from public.correo_mensajes where id = p_mensaje_id;
    if not found then
      return jsonb_build_object('encontrado', false);
    end if;
    v_texto := public.agente_html_a_texto(m.cuerpo_html);
    return jsonb_build_object(
      'encontrado', true,
      'id', m.id, 'fecha', public.agente_fecha(m.fecha), 'carpeta', m.carpeta,
      'de', jsonb_build_object('nombre', m.remitente_nombre, 'email', m.remitente_email),
      'para', to_jsonb(public.correo_emails_de(m.para)), 'cc', to_jsonb(public.correo_emails_de(m.cc)),
      'asunto', public.agente_corta(m.asunto, 300),
      'texto', public.agente_corta(v_texto, 8000),
      'texto_truncado', length(v_texto) > 8000,
      'adjuntos', (select coalesce(jsonb_agg(jsonb_build_object('nombre', a.nombre, 'tipo', a.tipo,
                     'tamano_kb', round(coalesce(a.tamano, 0) / 1024.0)::bigint) order by a.nombre), '[]')
                   from (select * from public.correo_adjuntos where mensaje_id = m.id and not inline order by nombre limit 30) a),
      'contacto', (select jsonb_build_object('id', c.id, 'nombre', c.full_name) from public.contactos c where c.id = m.contact_id),
      'empresa', (select jsonb_build_object('id', e.id, 'razon_social', e.razon_social) from public.empresas e where e.id = m.empresa_id),
      'mensajes_en_hilo', case when m.conversation_id is not null
                               then (select count(*) from public.correo_mensajes where conversation_id = m.conversation_id) end
    );
  end
  $f$;

  -- ===================== 11. listar_leads =====================
  create function public.agente_listar_leads(
    p_desde timestamptz default null, p_estado text default null, p_servicio text default null,
    p_origen text default null, p_limite integer default 25)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_lim int := least(greatest(coalesce(p_limite, 25), 1), 50);
    v jsonb;
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    with f as (
      select l.* from public.leads l
      where (p_desde is null or l.created_at >= p_desde)
        and (case when p_estado is null then coalesce(l.status, '') <> 'deleted' else l.status = p_estado end)
        and (p_servicio is null or l.servicio = p_servicio)
        and (p_origen is null or l.source = p_origen)
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'leads', (select coalesce(jsonb_agg(x.j order by x.o), '[]') from (
          select row_number() over (order by f.created_at desc) as o,
                 jsonb_build_object('id', f.id, 'fecha', public.agente_fecha(f.created_at), 'nombre', f.nombre,
                   'empresa', f.empresa, 'email', f.email, 'telefono', f.telefono, 'servicio', f.servicio,
                   'origen', f.source, 'pagina', f.page, 'estado', f.status, 'es_meta', f.meta_leadgen_id is not null,
                   'mensaje', public.agente_corta(f.mensaje, 500),
                   'utm', jsonb_strip_nulls(jsonb_build_object('source', f.utm_source, 'medium', f.utm_medium,
                                                               'campaign', f.utm_campaign)),
                   'contacto_id', f.contact_id) as j
          from f
          order by 1
          limit v_lim) x)
    ) into v;
    return v || jsonb_build_object('truncado', (v->>'total')::int > v_lim);
  end
  $f$;

  -- ===================== 12. resumen_actividad (solo recuentos) =====================
  create function public.agente_resumen_actividad(p_desde timestamptz, p_hasta timestamptz default null)
  returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp
  as $f$
  declare
    v_hasta timestamptz := coalesce(p_hasta, now());
  begin
    if not public.is_admin() then
      raise exception 'agente: solo usuarios activos del CRM' using errcode = '42501';
    end if;
    if p_desde is null or p_desde >= v_hasta then
      raise exception 'agente_resumen_actividad: desde tiene que ser anterior a hasta' using errcode = '22023';
    end if;
    if v_hasta - p_desde > interval '366 days' then
      raise exception 'agente_resumen_actividad: el periodo máximo es de un año' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'periodo', jsonb_build_object('desde', public.agente_fecha(p_desde), 'hasta', public.agente_fecha(v_hasta)),
      'leads', jsonb_build_object(
        'nuevos', (select count(*) from public.leads
                   where created_at >= p_desde and created_at < v_hasta and coalesce(status, '') <> 'deleted'),
        'por_origen', (select coalesce(jsonb_object_agg(o, n), '{}') from (
                         select coalesce(source, 'sin_origen') as o, count(*) as n from public.leads
                         where created_at >= p_desde and created_at < v_hasta and coalesce(status, '') <> 'deleted'
                         group by 1) s)),
      'contactos_nuevos', (select count(*) from public.contactos where created_at >= p_desde and created_at < v_hasta),
      'deals', jsonb_build_object(
        'creados', (select count(*) from public.deals where created_at >= p_desde and created_at < v_hasta),
        'firmados', (select count(*) from public.deals
                     where signed_at >= p_desde::date and signed_at <= v_hasta::date),
        'firmados_importe_por_frecuencia', (select coalesce(jsonb_object_agg(fq, imp), '{}') from (
                     select coalesce(frequency, 'sin_frecuencia') as fq, coalesce(sum(amount), 0) as imp from public.deals
                     where signed_at >= p_desde::date and signed_at <= v_hasta::date group by 1) s),
        'pipeline_actual_por_etapa', (select coalesce(jsonb_object_agg(stage, n), '{}') from (
                     select stage, count(*) as n from public.deals group by stage) s),
        'renovaciones_proximos_30_dias', (select count(*) from public.deals
                     where renewal_at >= current_date and renewal_at <= current_date + 30)),
      'tareas', jsonb_build_object(
        'vencidas_ahora', (select count(*) from public.tareas where status <> 'done' and not archived and due_at < now()),
        'vencen_proximos_7_dias', (select count(*) from public.tareas
                     where status <> 'done' and not archived and due_at >= now() and due_at < now() + interval '7 days'),
        'creadas', (select count(*) from public.tareas where created_at >= p_desde and created_at < v_hasta)),
      'correo', jsonb_build_object(
        'recibidos', (select count(*) from public.correo_mensajes
                      where carpeta = 'inbox' and fecha >= p_desde and fecha < v_hasta),
        'enviados', (select count(*) from public.correo_mensajes
                     where carpeta = 'sentitems' and fecha >= p_desde and fecha < v_hasta),
        'no_leidos_ahora', (select count(*) from public.correo_mensajes
                            where carpeta = 'inbox' and not leido and not fuera_bandeja)),
      'whatsapp', jsonb_build_object(
        'mensajes_recibidos', (select count(*) from public.whatsapp_messages
                               where direction = 'in' and created_at >= p_desde and created_at < v_hasta),
        'mensajes_enviados', (select count(*) from public.whatsapp_messages
                              where direction = 'out' and created_at >= p_desde and created_at < v_hasta),
        'conversaciones_sin_responder_ahora', (select count(*) from public.whatsapp_conversations w
                              where not w.archived
                                and (select m.direction from public.whatsapp_messages m where m.conversation_id = w.id
                                     order by m.created_at desc limit 1) = 'in')),
      'portal', jsonb_build_object(
        'solicitudes_pendientes_ahora', (select count(*) from public.empresa_solicitudes where estado = 'pendiente'),
        'altas_pendientes_validar_ahora', (select count(*) from public.empresas
                                           where provisional_at is not null and archived_at is null),
        'documentos_aportados_por_clientes', (select count(*) from public.documentos
                                              where source = 'cliente' and created_at >= p_desde and created_at < v_hasta))
    );
  end
  $f$;

  -- ===================== auditoría =====================
  create table public.agente_conversaciones (
    id            uuid primary key default gen_random_uuid(),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    auth_user_id  uuid not null default auth.uid(),
    titulo        text check (titulo is null or char_length(titulo) <= 200),
    modelo        text not null check (char_length(modelo) <= 100),
    archivada     boolean not null default false
  );
  create index agente_conversaciones_usuario_idx on public.agente_conversaciones (auth_user_id, updated_at desc);
  create index agente_conversaciones_updated_idx on public.agente_conversaciones (updated_at);
  create trigger agente_conversaciones_set_updated_at before update on public.agente_conversaciones
    for each row execute function public.set_updated_at();

  create table public.agente_mensajes (
    id               uuid primary key default gen_random_uuid(),
    created_at       timestamptz not null default now(),
    conversacion_id  uuid not null references public.agente_conversaciones(id) on delete cascade,
    auth_user_id     uuid not null default auth.uid(),
    orden            integer not null check (orden >= 0),
    rol              text not null check (rol in ('user', 'assistant')),
    -- pregunta = texto del usuario; herramientas = tool_result; modelo = respuesta del modelo
    tipo             text not null check (tipo in ('pregunta', 'herramientas', 'modelo')),
    contenido        jsonb not null check (jsonb_typeof(contenido) in ('array', 'string')),
    texto            text,
    modelo           text check (modelo is null or char_length(modelo) <= 100),
    stop_reason      text check (stop_reason is null or char_length(stop_reason) <= 50),
    uso              jsonb,
    request_id       text check (request_id is null or char_length(request_id) <= 200),
    latencia_ms      integer,
    constraint agente_mensajes_rol_tipo check ((rol = 'user') = (tipo in ('pregunta', 'herramientas'))),
    constraint agente_mensajes_orden_key unique (conversacion_id, orden),
    constraint agente_mensajes_id_conversacion_key unique (id, conversacion_id)
  );
  create index agente_mensajes_preguntas_idx on public.agente_mensajes (auth_user_id, created_at) where tipo = 'pregunta';

  create table public.agente_tool_calls (
    id               uuid primary key default gen_random_uuid(),
    created_at       timestamptz not null default now(),
    conversacion_id  uuid not null references public.agente_conversaciones(id) on delete cascade,
    mensaje_id       uuid not null,
    auth_user_id     uuid not null default auth.uid(),
    tool_use_id      text not null check (char_length(tool_use_id) <= 200),
    herramienta      text not null check (char_length(herramienta) <= 64),
    parametros       jsonb not null check (jsonb_typeof(parametros) = 'object'),
    filas            integer,
    bytes            integer,
    es_error         boolean not null default false,
    error            text check (error is null or char_length(error) <= 2000),
    duracion_ms      integer,
    constraint agente_tool_calls_mensaje_fk foreign key (mensaje_id, conversacion_id)
      references public.agente_mensajes (id, conversacion_id) on delete cascade,
    constraint agente_tool_calls_tool_use_key unique (conversacion_id, tool_use_id)
  );
  create index agente_tool_calls_mensaje_idx on public.agente_tool_calls (mensaje_id, conversacion_id);

  alter table public.agente_conversaciones enable row level security;
  alter table public.agente_mensajes enable row level security;
  alter table public.agente_tool_calls enable row level security;

  create policy "agente: cada usuario lee las suyas; el rol admin, todas" on public.agente_conversaciones
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: cada usuario crea las suyas" on public.agente_conversaciones
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()));
  create policy "agente: cada usuario renombra o archiva las suyas" on public.agente_conversaciones
    for update to authenticated
    using (auth_user_id = (select auth.uid()) and (select public.is_admin()))
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()));

  create policy "agente: cada usuario lee los suyos; el rol admin, todos" on public.agente_mensajes
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: cada usuario añade a sus conversaciones" on public.agente_mensajes
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin())
                and exists (select 1 from public.agente_conversaciones c
                            where c.id = conversacion_id and c.auth_user_id = (select auth.uid())));

  create policy "agente: cada usuario lee las suyas; el rol admin, todas" on public.agente_tool_calls
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: cada usuario añade a sus conversaciones" on public.agente_tool_calls
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin())
                and exists (select 1 from public.agente_conversaciones c
                            where c.id = conversacion_id and c.auth_user_id = (select auth.uid())));

  -- Privilegios: anon nada; authenticated solo lo que hace falta y por
  -- columnas (auth_user_id, fechas e id los pone la base de datos).
  revoke all on public.agente_conversaciones, public.agente_mensajes, public.agente_tool_calls from public, anon, authenticated;
  grant select on public.agente_conversaciones, public.agente_mensajes, public.agente_tool_calls to authenticated;
  grant insert (titulo, modelo) on public.agente_conversaciones to authenticated;
  grant update (titulo, archivada) on public.agente_conversaciones to authenticated;
  grant insert (conversacion_id, orden, rol, tipo, contenido, texto, modelo, stop_reason, uso, request_id, latencia_ms)
    on public.agente_mensajes to authenticated;
  grant insert (conversacion_id, mensaje_id, tool_use_id, herramienta, parametros, filas, bytes, es_error, error, duracion_ms)
    on public.agente_tool_calls to authenticated;
  grant all on public.agente_conversaciones, public.agente_mensajes, public.agente_tool_calls to service_role;

  -- Cada mensaje nuevo marca la conversación como activa (para la lista
  -- del panel y para la retención). SECURITY DEFINER porque el usuario no
  -- tiene UPDATE sobre updated_at.
  create function public.agente_mensaje_toca_conversacion()
  returns trigger language plpgsql security definer set search_path = public, pg_temp
  as $f$
  begin
    update public.agente_conversaciones set updated_at = now() where id = new.conversacion_id;
    return null;
  end
  $f$;
  revoke all on function public.agente_mensaje_toca_conversacion() from public, anon, authenticated, service_role;
  create trigger agente_mensajes_toca_conversacion after insert on public.agente_mensajes
    for each row execute function public.agente_mensaje_toca_conversacion();

  -- Retención: conversaciones sin actividad en p_dias (mínimo 30).
  create function public.agente_retencion(p_dias integer default 90)
  returns integer language plpgsql security definer set search_path = public, pg_temp
  as $f$
  declare
    n integer;
  begin
    if p_dias is null or p_dias < 30 then
      raise exception 'agente_retencion: el mínimo son 30 días';
    end if;
    delete from public.agente_conversaciones where updated_at < now() - make_interval(days => p_dias);
    get diagnostics n = row_count;
    return n;
  end
  $f$;
  revoke all on function public.agente_retencion(integer) from public, anon, authenticated, service_role;

  -- EXECUTE: las 12 RPC y los auxiliares, solo authenticated.
  revoke all on function
    public.agente_norm(text), public.agente_patron(text), public.agente_corta(text, integer),
    public.agente_fecha(timestamptz), public.agente_html_a_texto(text),
    public.agente_buscar(text, text[], integer),
    public.agente_ficha_empresa(uuid),
    public.agente_ficha_contacto(uuid),
    public.agente_listar_deals(text, text, text, uuid, uuid, date, date, integer),
    public.agente_listar_tareas(text, text, boolean, timestamptz, uuid, uuid, boolean, integer),
    public.agente_listar_documentos(uuid, uuid, text, text, timestamptz, integer),
    public.agente_listar_conversaciones_whatsapp(uuid, boolean, boolean, integer),
    public.agente_leer_whatsapp(uuid, timestamptz, integer),
    public.agente_buscar_correos(text, uuid, uuid, text, timestamptz, timestamptz, boolean, integer),
    public.agente_leer_correo(uuid),
    public.agente_listar_leads(timestamptz, text, text, text, integer),
    public.agente_resumen_actividad(timestamptz, timestamptz)
  from public, anon, service_role;
  grant execute on function
    public.agente_norm(text), public.agente_patron(text), public.agente_corta(text, integer),
    public.agente_fecha(timestamptz), public.agente_html_a_texto(text),
    public.agente_buscar(text, text[], integer),
    public.agente_ficha_empresa(uuid),
    public.agente_ficha_contacto(uuid),
    public.agente_listar_deals(text, text, text, uuid, uuid, date, date, integer),
    public.agente_listar_tareas(text, text, boolean, timestamptz, uuid, uuid, boolean, integer),
    public.agente_listar_documentos(uuid, uuid, text, text, timestamptz, integer),
    public.agente_listar_conversaciones_whatsapp(uuid, boolean, boolean, integer),
    public.agente_leer_whatsapp(uuid, timestamptz, integer),
    public.agente_buscar_correos(text, uuid, uuid, text, timestamptz, timestamptz, boolean, integer),
    public.agente_leer_correo(uuid),
    public.agente_listar_leads(timestamptz, text, text, text, integer),
    public.agente_resumen_actividad(timestamptz, timestamptz)
  to authenticated;

  perform cron.schedule('agente-retencion', '40 3 * * *', 'select public.agente_retencion(90);');

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261113120000', null, 'agente fase 1B (crm/supabase-agente.sql)');
end
$b1$;

notify pgrst, 'reload schema';


-- ============================================================
-- 1C (verificación, solo lectura) — Lo esperado en la columna valor:
--   tablas: 3 · RLS activada: 3 · políticas: 7
--   RPC agente_* (invoker, stable): 12 · auxiliares: 5
--   funciones agente_* con EXECUTE para anon: 0 · sin EXECUTE para authenticated: 2
--     (agente_retencion y el trigger)
--   authenticated conversaciones s/i/u/d: true/true/true/false
--   authenticated mensajes s/i/u/d: true/true/false/false
--   authenticated tool_calls s/i/u/d: true/true/false/false
--   anon conversaciones/mensajes/tool_calls select: false/false/false
--   job agente-retencion: 40 3 * * *
--   filas conversaciones/mensajes/tool_calls: 0/0/0
--   migración registrada: 20261113120000
-- ============================================================
select 'tablas' as comprobacion, count(*)::text as valor
from pg_tables where schemaname = 'public' and tablename in ('agente_conversaciones', 'agente_mensajes', 'agente_tool_calls')
union all
select 'RLS activada', count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relrowsecurity and c.relname in ('agente_conversaciones', 'agente_mensajes', 'agente_tool_calls')
union all
select 'políticas', count(*)::text from pg_policies
where schemaname = 'public' and tablename in ('agente_conversaciones', 'agente_mensajes', 'agente_tool_calls')
union all
select 'RPC agente_* (invoker, stable)', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and not p.prosecdef and p.provolatile = 's' and p.prorettype = 'jsonb'::regtype
  and p.proname in ('agente_buscar', 'agente_ficha_empresa', 'agente_ficha_contacto', 'agente_listar_deals',
                    'agente_listar_tareas', 'agente_listar_documentos', 'agente_listar_conversaciones_whatsapp',
                    'agente_leer_whatsapp', 'agente_buscar_correos', 'agente_leer_correo', 'agente_listar_leads',
                    'agente_resumen_actividad')
union all
select 'auxiliares', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and not p.prosecdef
  and p.proname in ('agente_norm', 'agente_patron', 'agente_corta', 'agente_fecha', 'agente_html_a_texto')
union all
select 'funciones agente_* con EXECUTE para anon', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'agente\_%' and has_function_privilege('anon', p.oid, 'EXECUTE')
union all
select 'funciones agente_* sin EXECUTE para authenticated', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'agente\_%' and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
union all
select 'authenticated conversaciones s/i/u/d',
       has_table_privilege('authenticated', 'public.agente_conversaciones', 'SELECT') || '/'
       || has_any_column_privilege('authenticated', 'public.agente_conversaciones', 'INSERT') || '/'
       || has_any_column_privilege('authenticated', 'public.agente_conversaciones', 'UPDATE') || '/'
       || has_table_privilege('authenticated', 'public.agente_conversaciones', 'DELETE')
union all
select 'authenticated mensajes s/i/u/d',
       has_table_privilege('authenticated', 'public.agente_mensajes', 'SELECT') || '/'
       || has_any_column_privilege('authenticated', 'public.agente_mensajes', 'INSERT') || '/'
       || has_any_column_privilege('authenticated', 'public.agente_mensajes', 'UPDATE') || '/'
       || has_table_privilege('authenticated', 'public.agente_mensajes', 'DELETE')
union all
select 'authenticated tool_calls s/i/u/d',
       has_table_privilege('authenticated', 'public.agente_tool_calls', 'SELECT') || '/'
       || has_any_column_privilege('authenticated', 'public.agente_tool_calls', 'INSERT') || '/'
       || has_any_column_privilege('authenticated', 'public.agente_tool_calls', 'UPDATE') || '/'
       || has_table_privilege('authenticated', 'public.agente_tool_calls', 'DELETE')
union all
select 'anon conversaciones/mensajes/tool_calls select',
       has_table_privilege('anon', 'public.agente_conversaciones', 'SELECT') || '/'
       || has_table_privilege('anon', 'public.agente_mensajes', 'SELECT') || '/'
       || has_table_privilege('anon', 'public.agente_tool_calls', 'SELECT')
union all
select 'job agente-retencion', string_agg(schedule, ', ') from cron.job where jobname = 'agente-retencion'
union all
select 'filas conversaciones/mensajes/tool_calls',
       (select count(*) from public.agente_conversaciones) || '/' || (select count(*) from public.agente_mensajes)
       || '/' || (select count(*) from public.agente_tool_calls)
union all
select 'migración registrada', string_agg(version || ' ' || name, ', ')
from supabase_migrations.schema_migrations where version = '20261113120000';
