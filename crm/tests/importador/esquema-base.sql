-- Generado por regenerar-esquema.sh: estructura de producción, sin datos.
set check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.agente_buscar(p_q text, p_tipos text[] DEFAULT NULL::text[], p_limite integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  $function$
;
CREATE OR REPLACE FUNCTION public.agente_corta(p text, n integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select case when p is null then null when length(p) > n then left(p, n) || '…' else p end
  $function$
;
CREATE OR REPLACE FUNCTION public.agente_fecha(t timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select to_char(t at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI')
  $function$
;
CREATE OR REPLACE FUNCTION public.agente_ficha_contacto(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  $function$
;
CREATE OR REPLACE FUNCTION public.agente_ficha_empresa(p_empresa_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  $function$
;
CREATE OR REPLACE FUNCTION public.agente_norm(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select lower(translate(coalesce(p, ''),
      'ÁÀÂÄÃáàâäãÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÖÕóòôöõÚÙÛÜúùûüÑñÇç',
      'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuNnCc'))
  $function$
;
CREATE OR REPLACE FUNCTION public.agente_patron(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select '%' || replace(replace(replace(public.agente_norm(btrim(p)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  $function$
;
CREATE OR REPLACE FUNCTION public.carpeta_cliente(p_empresa_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  $function$
;
CREATE OR REPLACE FUNCTION public.correo_contacto_de(p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select c.id from public.contactos c
    where lower(btrim(c.email)) = p_email
    order by (c.provisional_at is not null), c.created_at, c.id
    limit 1
  $function$
;
CREATE OR REPLACE FUNCTION public.correo_contacto_empresa_vincular()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  begin
    update public.correo_mensajes m
       set empresa_id = public.correo_empresa_de(new.contact_id)
     where m.contact_id = new.contact_id and m.empresa_id is null;
    return null;
  end
  $function$
;
CREATE OR REPLACE FUNCTION public.correo_contactos_vincular()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  declare
    v_email text := public.correo_norm(new.email);
  begin
    if v_email is null then return null; end if;
    if tg_op = 'UPDATE' and v_email is not distinct from public.correo_norm(old.email) then
      return null;
    end if;
    -- Si hay varios contactos con ese email, manda el criterio de siempre.
    if public.correo_contacto_de(v_email) is distinct from new.id then return null; end if;
    update public.correo_mensajes m
       set contact_id = new.id,
           empresa_id = coalesce(m.empresa_id, public.correo_empresa_de(new.id))
     where m.contact_id is null and m.emails_norm @> array[v_email];
    return null;
  end
  $function$
;
CREATE OR REPLACE FUNCTION public.correo_empresa_de(p_contact uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select ce.empresa_id from public.contacto_empresa ce
    where ce.contact_id = p_contact
    order by ce.principal desc, ce.created_at, ce.empresa_id
    limit 1
  $function$
;
CREATE OR REPLACE FUNCTION public.correo_norm(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select nullif(lower(btrim(p)), '')
  $function$
;
CREATE OR REPLACE FUNCTION public.deals_rellenar_empresa()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  begin
    if new.empresa_id is null and new.contact_id is not null then
      new.empresa_id := public.empresa_principal_de(new.contact_id);
    end if;
    return new;
  end;
  $function$
;
CREATE OR REPLACE FUNCTION public.empresa_principal_de(p_contact_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select ce.empresa_id
  from public.contacto_empresa ce
  where ce.contact_id = p_contact_id
  order by ce.principal desc, ce.created_at asc, ce.id
  limit 1;
$function$
;
CREATE OR REPLACE FUNCTION public.empresas_sembrar_carpetas()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  perform public.sembrar_carpetas_por_defecto(new.id);
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.is_admin(uid uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.admins where auth_user_id = uid and activo = true
  );
$function$
;
CREATE OR REPLACE FUNCTION public.is_admin_role(uid uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.admins where auth_user_id = uid and activo = true and rol = 'admin'
  );
$function$
;
CREATE OR REPLACE FUNCTION public.phone_last9(raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when length(regexp_replace(coalesce(raw, ''), '\D', '', 'g')) >= 9
    then right(regexp_replace(raw, '\D', '', 'g'), 9)
    else null
  end;
$function$
;
CREATE OR REPLACE FUNCTION public.resolve_contacto_company(p_contact_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select e.razon_social
  from public.contacto_empresa ce
  join public.empresas e on e.id = ce.empresa_id
  where ce.contact_id = p_contact_id
  order by ce.principal desc, ce.created_at asc
  limit 1;
$function$
;
CREATE OR REPLACE FUNCTION public.sembrar_carpetas_por_defecto(p_empresa_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
  begin
    insert into public.carpetas (empresa_id, nombre, orden)
    values (p_empresa_id, 'Fiscal',    1),
           (p_empresa_id, 'Laboral',   2),
           (p_empresa_id, 'Mercantil', 3),
           (p_empresa_id, 'Contratos', 4)
    on conflict do nothing;
    perform public.carpeta_cliente(p_empresa_id);
  end;
  $function$
;
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.sync_contacto_company()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  target_contact_id uuid := coalesce(new.contact_id, old.contact_id);
begin
  update public.contactos
  set company = public.resolve_contacto_company(target_contact_id)
  where id = target_contact_id;
  return coalesce(new, old);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_empresa_rename()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if new.razon_social is distinct from old.razon_social then
    update public.contactos c
    set company = public.resolve_contacto_company(c.id)
    from public.contacto_empresa ce
    where ce.empresa_id = new.id and ce.contact_id = c.id;
  end if;
  return new;
end;
$function$
;
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6




--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_user_id uuid,
    nombre text NOT NULL,
    email text NOT NULL,
    rol text DEFAULT 'miembro'::text NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admins_rol_check CHECK ((rol = ANY (ARRAY['admin'::text, 'miembro'::text])))
);


--
-- Name: carpetas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carpetas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    nombre text NOT NULL,
    system_key text,
    orden integer DEFAULT 0 NOT NULL,
    empresa_id uuid NOT NULL,
    parent_id uuid,
    admite_subcarpetas boolean GENERATED ALWAYS AS (((parent_id IS NULL) AND (system_key IS NULL))) STORED,
    padre_admite boolean GENERATED ALWAYS AS (
CASE
    WHEN (parent_id IS NOT NULL) THEN true
    ELSE NULL::boolean
END) STORED,
    CONSTRAINT carpetas_cliente_reservado_check CHECK (((NOT (system_key IS DISTINCT FROM 'cliente'::text)) = (lower(btrim(nombre)) = 'aportados por el cliente'::text))),
    CONSTRAINT carpetas_nombre_check CHECK (((length(btrim(nombre)) >= 1) AND (length(btrim(nombre)) <= 60))),
    CONSTRAINT carpetas_sistema_es_raiz_check CHECK (((system_key IS NULL) OR (parent_id IS NULL))),
    CONSTRAINT carpetas_system_key_check CHECK ((system_key = ANY (ARRAY['whatsapp'::text, 'cliente'::text]))),
    CONSTRAINT carpetas_whatsapp_reservado_check CHECK (((NOT (system_key IS DISTINCT FROM 'whatsapp'::text)) = (lower(btrim(nombre)) = 'whatsapp'::text)))
);


--
-- Name: contacto_empresa; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacto_empresa (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_id uuid NOT NULL,
    empresa_id uuid NOT NULL,
    principal boolean DEFAULT false NOT NULL
);


--
-- Name: contactos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contactos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    company text,
    full_name text,
    email text,
    phone text,
    dni text,
    city text,
    province text,
    employees integer,
    lifecycle text DEFAULT 'lead'::text NOT NULL,
    priority text,
    owner text,
    source text DEFAULT 'Alta manual'::text,
    kyc boolean DEFAULT false NOT NULL,
    auth_user_id uuid,
    lead_id uuid,
    provisional_at timestamp with time zone,
    visto_at timestamp with time zone
);


--
-- Name: COLUMN contactos.visto_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contactos.visto_at IS 'Primera vez que alguien del equipo abrió la ficha; null = "Nuevo".';


--
-- Name: correo_adjuntos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correo_adjuntos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mensaje_id uuid NOT NULL,
    graph_id text NOT NULL,
    nombre text DEFAULT ''::text NOT NULL,
    tipo text,
    tamano bigint,
    inline boolean DEFAULT false NOT NULL,
    content_id text
);


--
-- Name: correo_borradores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correo_borradores (
    graph_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    creado_por uuid,
    tipo text NOT NULL,
    origen_id uuid,
    empresa_id uuid,
    sesiones jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT correo_borradores_origen_chk CHECK (((tipo <> 'nuevo'::text) OR (origen_id IS NULL))),
    CONSTRAINT correo_borradores_sesiones_chk CHECK ((jsonb_typeof(sesiones) = 'array'::text)),
    CONSTRAINT correo_borradores_tipo_chk CHECK ((tipo = ANY (ARRAY['nuevo'::text, 'respuesta'::text, 'respuesta_todos'::text, 'reenvio'::text])))
);


--
-- Name: correo_mensajes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.correo_mensajes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    graph_id text NOT NULL,
    internet_message_id text,
    conversation_id text,
    carpeta text NOT NULL,
    remitente_email text,
    remitente_nombre text,
    para jsonb DEFAULT '[]'::jsonb NOT NULL,
    cc jsonb DEFAULT '[]'::jsonb NOT NULL,
    cco jsonb DEFAULT '[]'::jsonb NOT NULL,
    asunto text DEFAULT ''::text NOT NULL,
    extracto text DEFAULT ''::text NOT NULL,
    cuerpo_html text DEFAULT ''::text NOT NULL,
    fecha timestamp with time zone NOT NULL,
    leido boolean DEFAULT false NOT NULL,
    tiene_adjuntos boolean DEFAULT false NOT NULL,
    fuera_bandeja boolean DEFAULT false NOT NULL,
    fuera_bandeja_at timestamp with time zone,
    emails_norm text[] DEFAULT '{}'::text[] NOT NULL,
    contact_id uuid,
    empresa_id uuid,
    enviado_por uuid,
    CONSTRAINT correo_mensajes_carpeta_chk CHECK ((carpeta = ANY (ARRAY['inbox'::text, 'sentitems'::text]))),
    CONSTRAINT correo_mensajes_fuera_chk CHECK ((fuera_bandeja = (fuera_bandeja_at IS NOT NULL))),
    CONSTRAINT correo_mensajes_listas_chk CHECK (((jsonb_typeof(para) = 'array'::text) AND (jsonb_typeof(cc) = 'array'::text) AND (jsonb_typeof(cco) = 'array'::text)))
);


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text,
    contact_id uuid,
    service text,
    stage text DEFAULT 'reunion'::text NOT NULL,
    owner text,
    amount numeric,
    frequency text,
    priority text,
    loss_reason text,
    signed_at date,
    renewal_at date,
    num_nominas integer,
    coste_nomina numeric,
    empresa_id uuid,
    origen text DEFAULT 'crm'::text NOT NULL,
    CONSTRAINT deals_origen_check CHECK ((origen = ANY (ARRAY['crm'::text, 'portal'::text])))
);


--
-- Name: documentos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documentos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_path text NOT NULL,
    mime_type text,
    size_bytes bigint,
    original_filename text,
    status text DEFAULT 'pending'::text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    whatsapp_conversation_id uuid,
    whatsapp_message_id uuid,
    uploaded_by uuid,
    visible boolean DEFAULT false NOT NULL,
    folder_id uuid,
    empresa_id uuid,
    shared_at timestamp with time zone,
    shared_by uuid,
    mover_a text,
    aportado_por_contact_id uuid,
    CONSTRAINT documentos_manual_stored_check CHECK (((source = 'whatsapp'::text) OR (status = 'stored'::text))),
    CONSTRAINT documentos_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'whatsapp'::text, 'cliente'::text]))),
    CONSTRAINT documentos_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'stored'::text, 'failed'::text, 'too_large'::text])))
);


--
-- Name: COLUMN documentos.aportado_por_contact_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documentos.aportado_por_contact_id IS 'Quién aportó el documento (contacto que lo mandó por WhatsApp o lo subió desde el área cliente). NO es el dueño: el dueño es empresa_id.';


--
-- Name: empresa_cambios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empresa_cambios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    empresa_id uuid NOT NULL,
    campo text NOT NULL,
    valor_anterior text,
    valor_nuevo text,
    contact_id uuid,
    auth_user_id uuid,
    CONSTRAINT empresa_cambios_campo_check CHECK ((campo = ANY (ARRAY['address'::text, 'city'::text, 'province'::text])))
);


--
-- Name: empresa_solicitudes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empresa_solicitudes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    empresa_id uuid NOT NULL,
    campo text NOT NULL,
    valor_actual text,
    valor_solicitado text NOT NULL,
    comentario text,
    estado text DEFAULT 'pendiente'::text NOT NULL,
    contact_id uuid,
    auth_user_id uuid,
    resuelta_at timestamp with time zone,
    resuelta_por uuid,
    CONSTRAINT empresa_solicitudes_campo_check CHECK ((campo = ANY (ARRAY['razon_social'::text, 'cif'::text]))),
    CONSTRAINT empresa_solicitudes_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aplicada'::text, 'rechazada'::text])))
);


--
-- Name: empresas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.empresas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    razon_social text NOT NULL,
    cif text,
    address text,
    city text,
    province text,
    provisional_at timestamp with time zone,
    archived_at timestamp with time zone,
    archived_by uuid,
    visto_at timestamp with time zone
);


--
-- Name: COLUMN empresas.visto_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.empresas.visto_at IS 'Primera vez que alguien del equipo abrió la ficha; null = "Nuevo".';


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    nombre text,
    empresa text,
    email text,
    telefono text,
    servicio text,
    mensaje text,
    lang text DEFAULT 'es'::text,
    source text DEFAULT 'Formulario web'::text,
    page text,
    status text DEFAULT 'new'::text,
    error_message text,
    meta_leadgen_id text,
    meta_origen jsonb,
    respuestas jsonb,
    contact_id uuid,
    aviso boolean DEFAULT true NOT NULL,
    utm_source text,
    utm_medium text,
    utm_campaign text,
    utm_term text,
    utm_content text,
    gclid text,
    CONSTRAINT leads_gclid_len CHECK ((char_length(gclid) <= 500)),
    CONSTRAINT leads_utm_campaign_len CHECK ((char_length(utm_campaign) <= 500)),
    CONSTRAINT leads_utm_content_len CHECK ((char_length(utm_content) <= 500)),
    CONSTRAINT leads_utm_medium_len CHECK ((char_length(utm_medium) <= 500)),
    CONSTRAINT leads_utm_source_len CHECK ((char_length(utm_source) <= 500)),
    CONSTRAINT leads_utm_term_len CHECK ((char_length(utm_term) <= 500))
);


--
-- Name: notas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    body text NOT NULL,
    author text,
    contact_id uuid,
    deal_id uuid
);


--
-- Name: tareas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tareas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text NOT NULL,
    due_at timestamp with time zone,
    assigned_to text,
    status text DEFAULT 'pending'::text NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    contact_id uuid,
    deal_id uuid,
    reminder_sent_at timestamp with time zone
);


--
-- Name: whatsapp_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_id uuid,
    phone text,
    wa_id text,
    last_customer_message_at timestamp with time zone,
    owner text,
    archived boolean DEFAULT false NOT NULL
);


--
-- Name: whatsapp_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    conversation_id uuid NOT NULL,
    direction text NOT NULL,
    type text DEFAULT 'text'::text NOT NULL,
    body text,
    wa_message_id text,
    delivery_status text DEFAULT 'sent'::text,
    meta jsonb
);


--
-- Name: admins admins_auth_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_auth_user_id_key UNIQUE (auth_user_id);


--
-- Name: admins admins_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_email_key UNIQUE (email);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: carpetas carpetas_id_empresa_admite_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carpetas
    ADD CONSTRAINT carpetas_id_empresa_admite_key UNIQUE (id, empresa_id, admite_subcarpetas);


--
-- Name: carpetas carpetas_id_empresa_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carpetas
    ADD CONSTRAINT carpetas_id_empresa_key UNIQUE (id, empresa_id);


--
-- Name: carpetas carpetas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carpetas
    ADD CONSTRAINT carpetas_pkey PRIMARY KEY (id);


--
-- Name: contacto_empresa contacto_empresa_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacto_empresa
    ADD CONSTRAINT contacto_empresa_pkey PRIMARY KEY (id);


--
-- Name: contactos contactos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contactos
    ADD CONSTRAINT contactos_pkey PRIMARY KEY (id);


--
-- Name: correo_adjuntos correo_adjuntos_mensaje_graph_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_adjuntos
    ADD CONSTRAINT correo_adjuntos_mensaje_graph_key UNIQUE (mensaje_id, graph_id);


--
-- Name: correo_adjuntos correo_adjuntos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_adjuntos
    ADD CONSTRAINT correo_adjuntos_pkey PRIMARY KEY (id);


--
-- Name: correo_borradores correo_borradores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_borradores
    ADD CONSTRAINT correo_borradores_pkey PRIMARY KEY (graph_id);


--
-- Name: correo_mensajes correo_mensajes_graph_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_mensajes
    ADD CONSTRAINT correo_mensajes_graph_id_key UNIQUE (graph_id);


--
-- Name: correo_mensajes correo_mensajes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_mensajes
    ADD CONSTRAINT correo_mensajes_pkey PRIMARY KEY (id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: documentos documentos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_pkey PRIMARY KEY (id);


--
-- Name: empresa_cambios empresa_cambios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_cambios
    ADD CONSTRAINT empresa_cambios_pkey PRIMARY KEY (id);


--
-- Name: empresa_solicitudes empresa_solicitudes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_solicitudes
    ADD CONSTRAINT empresa_solicitudes_pkey PRIMARY KEY (id);


--
-- Name: empresas empresas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresas
    ADD CONSTRAINT empresas_pkey PRIMARY KEY (id);


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);


--
-- Name: notas notas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas
    ADD CONSTRAINT notas_pkey PRIMARY KEY (id);


--
-- Name: tareas tareas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tareas
    ADD CONSTRAINT tareas_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_conversations whatsapp_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_messages whatsapp_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_pkey PRIMARY KEY (id);


--
-- Name: admins_auth_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admins_auth_user_idx ON public.admins USING btree (auth_user_id);


--
-- Name: admins_email_lower_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admins_email_lower_idx ON public.admins USING btree (lower(email));


--
-- Name: carpetas_empresa_system_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX carpetas_empresa_system_key ON public.carpetas USING btree (empresa_id, system_key) WHERE (system_key IS NOT NULL);


--
-- Name: carpetas_hermanas_nombre_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX carpetas_hermanas_nombre_key ON public.carpetas USING btree (empresa_id, parent_id, lower(btrim(nombre))) NULLS NOT DISTINCT;


--
-- Name: carpetas_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX carpetas_parent_idx ON public.carpetas USING btree (parent_id);


--
-- Name: contacto_empresa_empresa_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacto_empresa_empresa_idx ON public.contacto_empresa USING btree (empresa_id);


--
-- Name: contacto_empresa_pair_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacto_empresa_pair_key ON public.contacto_empresa USING btree (contact_id, empresa_id);


--
-- Name: contacto_empresa_principal_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacto_empresa_principal_key ON public.contacto_empresa USING btree (contact_id) WHERE principal;


--
-- Name: contactos_auth_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contactos_auth_user_id_key ON public.contactos USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: contactos_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contactos_email_idx ON public.contactos USING btree (email);


--
-- Name: contactos_email_norm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contactos_email_norm_idx ON public.contactos USING btree (lower(btrim(email)));


--
-- Name: contactos_lead_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contactos_lead_id_idx ON public.contactos USING btree (lead_id);


--
-- Name: contactos_lead_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contactos_lead_id_key ON public.contactos USING btree (lead_id) WHERE (lead_id IS NOT NULL);


--
-- Name: contactos_lifecycle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contactos_lifecycle_idx ON public.contactos USING btree (lifecycle);


--
-- Name: contactos_phone_last9_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contactos_phone_last9_idx ON public.contactos USING btree (public.phone_last9(phone));


--
-- Name: contactos_provisional_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contactos_provisional_idx ON public.contactos USING btree (provisional_at) WHERE (provisional_at IS NOT NULL);


--
-- Name: correo_borradores_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_borradores_created_idx ON public.correo_borradores USING btree (created_at);


--
-- Name: correo_mensajes_bandeja_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_bandeja_idx ON public.correo_mensajes USING btree (carpeta, fecha DESC) WHERE (NOT fuera_bandeja);


--
-- Name: correo_mensajes_contacto_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_contacto_idx ON public.correo_mensajes USING btree (contact_id, fecha DESC) WHERE (contact_id IS NOT NULL);


--
-- Name: correo_mensajes_conversacion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_conversacion_idx ON public.correo_mensajes USING btree (conversation_id, fecha);


--
-- Name: correo_mensajes_emails_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_emails_idx ON public.correo_mensajes USING gin (emails_norm);


--
-- Name: correo_mensajes_empresa_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_empresa_idx ON public.correo_mensajes USING btree (empresa_id, fecha DESC) WHERE (empresa_id IS NOT NULL);


--
-- Name: correo_mensajes_internet_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_internet_id_idx ON public.correo_mensajes USING btree (internet_message_id) WHERE (internet_message_id IS NOT NULL);


--
-- Name: correo_mensajes_sin_vincular_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX correo_mensajes_sin_vincular_idx ON public.correo_mensajes USING btree (fecha DESC) WHERE (contact_id IS NULL);


--
-- Name: deals_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_contact_idx ON public.deals USING btree (contact_id);


--
-- Name: deals_empresa_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_empresa_idx ON public.deals USING btree (empresa_id);


--
-- Name: deals_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_stage_idx ON public.deals USING btree (stage);


--
-- Name: documentos_aportado_por_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documentos_aportado_por_idx ON public.documentos USING btree (aportado_por_contact_id);


--
-- Name: documentos_empresa_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documentos_empresa_folder_idx ON public.documentos USING btree (empresa_id, folder_id);


--
-- Name: documentos_folder_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documentos_folder_id_idx ON public.documentos USING btree (folder_id);


--
-- Name: documentos_mover_a_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documentos_mover_a_key ON public.documentos USING btree (mover_a) WHERE (mover_a IS NOT NULL);


--
-- Name: documentos_storage_path_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documentos_storage_path_key ON public.documentos USING btree (storage_path);


--
-- Name: documentos_whatsapp_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documentos_whatsapp_conversation_idx ON public.documentos USING btree (whatsapp_conversation_id);


--
-- Name: documentos_whatsapp_message_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documentos_whatsapp_message_id_key ON public.documentos USING btree (whatsapp_message_id) WHERE (whatsapp_message_id IS NOT NULL);


--
-- Name: empresa_cambios_empresa_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX empresa_cambios_empresa_idx ON public.empresa_cambios USING btree (empresa_id, created_at DESC);


--
-- Name: empresa_solicitudes_empresa_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX empresa_solicitudes_empresa_idx ON public.empresa_solicitudes USING btree (empresa_id, created_at DESC);


--
-- Name: empresa_solicitudes_pendiente_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX empresa_solicitudes_pendiente_key ON public.empresa_solicitudes USING btree (empresa_id, campo) WHERE (estado = 'pendiente'::text);


--
-- Name: empresas_archived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX empresas_archived_idx ON public.empresas USING btree (archived_at) WHERE (archived_at IS NOT NULL);


--
-- Name: empresas_cif_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX empresas_cif_key ON public.empresas USING btree (upper(TRIM(BOTH FROM cif))) WHERE ((cif IS NOT NULL) AND (TRIM(BOTH FROM cif) <> ''::text) AND (provisional_at IS NULL));


--
-- Name: empresas_provisional_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX empresas_provisional_idx ON public.empresas USING btree (provisional_at) WHERE (provisional_at IS NOT NULL);


--
-- Name: empresas_razon_social_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX empresas_razon_social_idx ON public.empresas USING btree (lower(razon_social));


--
-- Name: leads_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leads_contact_id_idx ON public.leads USING btree (contact_id);


--
-- Name: leads_meta_leadgen_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX leads_meta_leadgen_id_key ON public.leads USING btree (meta_leadgen_id);


--
-- Name: notas_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notas_contact_idx ON public.notas USING btree (contact_id);


--
-- Name: notas_deal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notas_deal_idx ON public.notas USING btree (deal_id);


--
-- Name: tareas_assigned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tareas_assigned_idx ON public.tareas USING btree (assigned_to);


--
-- Name: tareas_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tareas_contact_idx ON public.tareas USING btree (contact_id);


--
-- Name: tareas_deal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tareas_deal_idx ON public.tareas USING btree (deal_id);


--
-- Name: tareas_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tareas_status_idx ON public.tareas USING btree (status, archived);


--
-- Name: whatsapp_conversations_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_conversations_contact_idx ON public.whatsapp_conversations USING btree (contact_id);


--
-- Name: whatsapp_conversations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_conversations_owner_idx ON public.whatsapp_conversations USING btree (owner);


--
-- Name: whatsapp_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_messages_conversation_idx ON public.whatsapp_messages USING btree (conversation_id);


--
-- Name: whatsapp_messages_wa_message_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX whatsapp_messages_wa_message_id_key ON public.whatsapp_messages USING btree (wa_message_id) WHERE (wa_message_id IS NOT NULL);


--
-- Name: admins admins_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: carpetas carpetas_proteger; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: carpetas carpetas_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: contacto_empresa contacto_empresa_sync_company; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: contactos contactos_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: correo_borradores correo_borradores_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: contacto_empresa correo_contacto_empresa_vincular; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: contactos correo_contactos_vincular; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: correo_mensajes correo_mensajes_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: correo_mensajes correo_mensajes_vincular; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: deals deals_rellenar_empresa; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: deals deals_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: documentos documentos_marcar_mensaje_borrado; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: documentos documentos_registrar_compartido; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: documentos documentos_resolver_carpeta; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: documentos documentos_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: empresas empresas_sembrar_carpetas; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: empresas empresas_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: empresas empresas_sync_rename; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: leads on_new_lead; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: tareas tareas_notify_assignment; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: tareas tareas_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: whatsapp_conversations whatsapp_conversations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: whatsapp_messages whatsapp_messages_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--



--
-- Name: admins admins_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: carpetas carpetas_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carpetas
    ADD CONSTRAINT carpetas_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;


--
-- Name: carpetas carpetas_padre_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carpetas
    ADD CONSTRAINT carpetas_padre_fkey FOREIGN KEY (parent_id, empresa_id, padre_admite) REFERENCES public.carpetas(id, empresa_id, admite_subcarpetas);


--
-- Name: contacto_empresa contacto_empresa_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacto_empresa
    ADD CONSTRAINT contacto_empresa_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE CASCADE;


--
-- Name: contacto_empresa contacto_empresa_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacto_empresa
    ADD CONSTRAINT contacto_empresa_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;


--
-- Name: contactos contactos_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contactos
    ADD CONSTRAINT contactos_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: contactos contactos_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contactos
    ADD CONSTRAINT contactos_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: correo_adjuntos correo_adjuntos_mensaje_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_adjuntos
    ADD CONSTRAINT correo_adjuntos_mensaje_id_fkey FOREIGN KEY (mensaje_id) REFERENCES public.correo_mensajes(id) ON DELETE CASCADE;


--
-- Name: correo_borradores correo_borradores_creado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_borradores
    ADD CONSTRAINT correo_borradores_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: correo_borradores correo_borradores_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_borradores
    ADD CONSTRAINT correo_borradores_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE SET NULL;


--
-- Name: correo_borradores correo_borradores_origen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_borradores
    ADD CONSTRAINT correo_borradores_origen_id_fkey FOREIGN KEY (origen_id) REFERENCES public.correo_mensajes(id) ON DELETE SET NULL;


--
-- Name: correo_mensajes correo_mensajes_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_mensajes
    ADD CONSTRAINT correo_mensajes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: correo_mensajes correo_mensajes_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_mensajes
    ADD CONSTRAINT correo_mensajes_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE SET NULL;


--
-- Name: correo_mensajes correo_mensajes_enviado_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.correo_mensajes
    ADD CONSTRAINT correo_mensajes_enviado_por_fkey FOREIGN KEY (enviado_por) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: deals deals_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: deals deals_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE RESTRICT;


--
-- Name: documentos documentos_aportado_por_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_aportado_por_contact_id_fkey FOREIGN KEY (aportado_por_contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: documentos documentos_carpeta_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_carpeta_fkey FOREIGN KEY (folder_id, empresa_id) REFERENCES public.carpetas(id, empresa_id) ON DELETE SET NULL (folder_id);


--
-- Name: documentos documentos_empresa_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_empresa_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE RESTRICT;


--
-- Name: documentos documentos_shared_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_shared_by_fkey FOREIGN KEY (shared_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: documentos documentos_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: documentos documentos_whatsapp_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_whatsapp_conversation_id_fkey FOREIGN KEY (whatsapp_conversation_id) REFERENCES public.whatsapp_conversations(id) ON DELETE SET NULL;


--
-- Name: documentos documentos_whatsapp_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documentos
    ADD CONSTRAINT documentos_whatsapp_message_id_fkey FOREIGN KEY (whatsapp_message_id) REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL;


--
-- Name: empresa_cambios empresa_cambios_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_cambios
    ADD CONSTRAINT empresa_cambios_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: empresa_cambios empresa_cambios_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_cambios
    ADD CONSTRAINT empresa_cambios_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: empresa_cambios empresa_cambios_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_cambios
    ADD CONSTRAINT empresa_cambios_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;


--
-- Name: empresa_solicitudes empresa_solicitudes_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_solicitudes
    ADD CONSTRAINT empresa_solicitudes_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: empresa_solicitudes empresa_solicitudes_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_solicitudes
    ADD CONSTRAINT empresa_solicitudes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: empresa_solicitudes empresa_solicitudes_empresa_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_solicitudes
    ADD CONSTRAINT empresa_solicitudes_empresa_id_fkey FOREIGN KEY (empresa_id) REFERENCES public.empresas(id) ON DELETE CASCADE;


--
-- Name: empresa_solicitudes empresa_solicitudes_resuelta_por_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresa_solicitudes
    ADD CONSTRAINT empresa_solicitudes_resuelta_por_fkey FOREIGN KEY (resuelta_por) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: empresas empresas_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.empresas
    ADD CONSTRAINT empresas_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: leads leads_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: notas notas_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas
    ADD CONSTRAINT notas_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE CASCADE;


--
-- Name: notas notas_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notas
    ADD CONSTRAINT notas_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: tareas tareas_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tareas
    ADD CONSTRAINT tareas_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE CASCADE;


--
-- Name: tareas tareas_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tareas
    ADD CONSTRAINT tareas_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversations whatsapp_conversations_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contactos(id) ON DELETE SET NULL;


--
-- Name: whatsapp_messages whatsapp_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE;


--
-- Name: admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

--
-- Name: carpetas admins actualizan carpetas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan carpetas" ON public.carpetas FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: contacto_empresa admins actualizan contacto_empresa; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan contacto_empresa" ON public.contacto_empresa FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: contactos admins actualizan contactos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan contactos" ON public.contactos FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: deals admins actualizan deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan deals" ON public.deals FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: documentos admins actualizan documentos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan documentos" ON public.documentos FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: empresas admins actualizan empresas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan empresas" ON public.empresas FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: leads admins actualizan leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan leads" ON public.leads FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: tareas admins actualizan tareas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan tareas" ON public.tareas FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_conversations admins actualizan whatsapp_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan whatsapp_conversations" ON public.whatsapp_conversations FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_messages admins actualizan whatsapp_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins actualizan whatsapp_messages" ON public.whatsapp_messages FOR UPDATE TO authenticated USING (( SELECT public.is_admin() AS is_admin)) WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: carpetas admins borran carpetas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran carpetas" ON public.carpetas FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: contacto_empresa admins borran contacto_empresa; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran contacto_empresa" ON public.contacto_empresa FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: contactos admins borran contactos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran contactos" ON public.contactos FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: deals admins borran deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran deals" ON public.deals FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: documentos admins borran documentos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran documentos" ON public.documentos FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: empresas admins borran empresas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran empresas" ON public.empresas FOR DELETE TO authenticated USING (public.is_admin());


--
-- Name: notas admins borran notas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran notas" ON public.notas FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: tareas admins borran tareas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran tareas" ON public.tareas FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_conversations admins borran whatsapp_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran whatsapp_conversations" ON public.whatsapp_conversations FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_messages admins borran whatsapp_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins borran whatsapp_messages" ON public.whatsapp_messages FOR DELETE TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: carpetas admins crean carpetas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean carpetas" ON public.carpetas FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: contacto_empresa admins crean contacto_empresa; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean contacto_empresa" ON public.contacto_empresa FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: contactos admins crean contactos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean contactos" ON public.contactos FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: deals admins crean deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean deals" ON public.deals FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: documentos admins crean documentos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean documentos" ON public.documentos FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: empresas admins crean empresas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean empresas" ON public.empresas FOR INSERT TO authenticated WITH CHECK (public.is_admin());


--
-- Name: notas admins crean notas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean notas" ON public.notas FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: tareas admins crean tareas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean tareas" ON public.tareas FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_conversations admins crean whatsapp_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean whatsapp_conversations" ON public.whatsapp_conversations FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_messages admins crean whatsapp_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins crean whatsapp_messages" ON public.whatsapp_messages FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_admin() AS is_admin));


--
-- Name: admins admins leen admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen admins" ON public.admins FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: carpetas admins leen carpetas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen carpetas" ON public.carpetas FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: contacto_empresa admins leen contacto_empresa; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen contacto_empresa" ON public.contacto_empresa FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: contactos admins leen contactos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen contactos" ON public.contactos FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: deals admins leen deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen deals" ON public.deals FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: documentos admins leen documentos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen documentos" ON public.documentos FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: empresa_cambios admins leen empresa_cambios; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen empresa_cambios" ON public.empresa_cambios FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: empresa_solicitudes admins leen empresa_solicitudes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen empresa_solicitudes" ON public.empresa_solicitudes FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: empresas admins leen empresas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen empresas" ON public.empresas FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: leads admins leen leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen leads" ON public.leads FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: notas admins leen notas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen notas" ON public.notas FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: tareas admins leen tareas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen tareas" ON public.tareas FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_conversations admins leen whatsapp_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen whatsapp_conversations" ON public.whatsapp_conversations FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: whatsapp_messages admins leen whatsapp_messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "admins leen whatsapp_messages" ON public.whatsapp_messages FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: carpetas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.carpetas ENABLE ROW LEVEL SECURITY;

--
-- Name: contacto_empresa; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacto_empresa ENABLE ROW LEVEL SECURITY;

--
-- Name: contactos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contactos ENABLE ROW LEVEL SECURITY;

--
-- Name: correo_adjuntos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.correo_adjuntos ENABLE ROW LEVEL SECURITY;

--
-- Name: correo_borradores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.correo_borradores ENABLE ROW LEVEL SECURITY;

--
-- Name: correo_mensajes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.correo_mensajes ENABLE ROW LEVEL SECURITY;

--
-- Name: deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

--
-- Name: documentos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documentos ENABLE ROW LEVEL SECURITY;

--
-- Name: empresa_cambios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.empresa_cambios ENABLE ROW LEVEL SECURITY;

--
-- Name: empresa_solicitudes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.empresa_solicitudes ENABLE ROW LEVEL SECURITY;

--
-- Name: empresas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;

--
-- Name: leads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

--
-- Name: notas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notas ENABLE ROW LEVEL SECURITY;

--
-- Name: admins rol admin actualiza admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rol admin actualiza admins" ON public.admins FOR UPDATE TO authenticated USING (public.is_admin_role()) WITH CHECK (public.is_admin_role());


--
-- Name: admins rol admin borra admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rol admin borra admins" ON public.admins FOR DELETE TO authenticated USING (public.is_admin_role());


--
-- Name: admins rol admin crea admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "rol admin crea admins" ON public.admins FOR INSERT TO authenticated WITH CHECK (public.is_admin_role());


--
-- Name: tareas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tareas ENABLE ROW LEVEL SECURITY;

--
-- Name: correo_adjuntos usuarios CRM leen correo_adjuntos; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "usuarios CRM leen correo_adjuntos" ON public.correo_adjuntos FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: correo_mensajes usuarios CRM leen correo_mensajes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "usuarios CRM leen correo_mensajes" ON public.correo_mensajes FOR SELECT TO authenticated USING (( SELECT public.is_admin() AS is_admin));


--
-- Name: leads web puede insertar leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "web puede insertar leads" ON public.leads FOR INSERT TO authenticated, anon WITH CHECK (((meta_leadgen_id IS NULL) AND (meta_origen IS NULL) AND (respuestas IS NULL) AND (contact_id IS NULL) AND aviso));


--
-- Name: whatsapp_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


CREATE TRIGGER contacto_empresa_sync_company AFTER INSERT OR DELETE OR UPDATE ON public.contacto_empresa FOR EACH ROW EXECUTE FUNCTION sync_contacto_company();
CREATE TRIGGER correo_contacto_empresa_vincular AFTER INSERT OR UPDATE ON public.contacto_empresa FOR EACH ROW EXECUTE FUNCTION correo_contacto_empresa_vincular();
CREATE TRIGGER contactos_set_updated_at BEFORE UPDATE ON public.contactos FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER correo_contactos_vincular AFTER INSERT OR UPDATE OF email ON public.contactos FOR EACH ROW EXECUTE FUNCTION correo_contactos_vincular();
CREATE TRIGGER deals_rellenar_empresa BEFORE INSERT ON public.deals FOR EACH ROW EXECUTE FUNCTION deals_rellenar_empresa();
CREATE TRIGGER deals_set_updated_at BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER empresas_sembrar_carpetas AFTER INSERT ON public.empresas FOR EACH ROW EXECUTE FUNCTION empresas_sembrar_carpetas();
CREATE TRIGGER empresas_set_updated_at BEFORE UPDATE ON public.empresas FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER empresas_sync_rename AFTER UPDATE ON public.empresas FOR EACH ROW EXECUTE FUNCTION sync_empresa_rename();
