-- Estructura (sin datos) de las tablas que usa crm/supabase-agente.sql, exportada
-- de producción con pg_dump --schema-only --no-owner --no-privileges -t ... el
-- 2026-11-13, sin triggers ni líneas SET/\. Revisada: sin secretos ni URLs.
-- Ver README.md para regenerarla.

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
    provisional_at timestamp with time zone
);


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
    archived_by uuid
);


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


