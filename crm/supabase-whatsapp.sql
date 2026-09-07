-- ============================================================
-- GUIMAES — WhatsApp Business (conversaciones, mensajes, plantillas)
-- Requiere que supabase-contactos.sql ya se haya ejecutado antes
-- (usa la función public.set_updated_at() definida allí).
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run
-- ============================================================

-- ============================================================
-- Conversaciones de WhatsApp
-- Una fila por número de teléfono con el que se ha hablado.
-- contact_id es nullable: puede llegar un mensaje de un número que
-- todavía no está dado de alta como contacto en public.contactos.
-- ============================================================
create table if not exists public.whatsapp_conversations (
  id                       uuid primary key default gen_random_uuid(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Identidad del hilo
  contact_id               uuid references public.contactos(id) on delete set null,
  phone                    text,        -- en formato E.164, ej. +34600000000
  wa_id                    text,        -- identificador de WhatsApp del contacto (Meta)

  -- Ventana de servicio de 24h (Meta solo permite texto libre dentro de este plazo
  -- desde el último mensaje del cliente; fuera de él hay que usar plantilla)
  last_customer_message_at timestamptz,

  -- Asignación y estado
  owner                    text,                          -- asesor responsable (mismo criterio que owner en deals)
  archived                 boolean not null default false
);

-- Nota: contact_id usa "on delete set null" (no cascade, a diferencia de deals)
-- para conservar el historial de la conversación aunque se borre el contacto.

create index if not exists whatsapp_conversations_contact_idx on public.whatsapp_conversations (contact_id);
create index if not exists whatsapp_conversations_owner_idx   on public.whatsapp_conversations (owner);

-- ============================================================
-- Seguridad a nivel de fila (RLS) — solo administradores autenticados
-- (mismo criterio que contactos/deals; revisar cuando exista el área de cliente)
-- ============================================================
alter table public.whatsapp_conversations enable row level security;

drop policy if exists "admins leen whatsapp_conversations" on public.whatsapp_conversations;
create policy "admins leen whatsapp_conversations"
  on public.whatsapp_conversations for select to authenticated using (true);

drop policy if exists "admins crean whatsapp_conversations" on public.whatsapp_conversations;
create policy "admins crean whatsapp_conversations"
  on public.whatsapp_conversations for insert to authenticated with check (true);

drop policy if exists "admins actualizan whatsapp_conversations" on public.whatsapp_conversations;
create policy "admins actualizan whatsapp_conversations"
  on public.whatsapp_conversations for update to authenticated using (true) with check (true);

drop policy if exists "admins borran whatsapp_conversations" on public.whatsapp_conversations;
create policy "admins borran whatsapp_conversations"
  on public.whatsapp_conversations for delete to authenticated using (true);

drop trigger if exists whatsapp_conversations_set_updated_at on public.whatsapp_conversations;
create trigger whatsapp_conversations_set_updated_at
  before update on public.whatsapp_conversations
  for each row execute function public.set_updated_at();

-- ============================================================
-- Mensajes de WhatsApp
-- Cada fila es un mensaje individual dentro de una conversación.
-- ============================================================
create table if not exists public.whatsapp_messages (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  conversation_id  uuid not null references public.whatsapp_conversations(id) on delete cascade,

  direction        text not null,               -- 'in' / 'out' (catálogo en código)
  type             text not null default 'text', -- 'text' / 'template' / 'image' / 'document' (catálogo en código)
  body             text,                         -- texto del mensaje o caption del adjunto

  wa_message_id    text,        -- id del mensaje en Meta; sirve para deduplicar reintentos del webhook
  delivery_status  text default 'sent'  -- 'sent' / 'delivered' / 'read' / 'failed' (catálogo en código)
);

-- updated_at SÍ aplica aquí (a diferencia de leads/contactos-solo-creación):
-- delivery_status cambia después de creado el mensaje (sent → delivered → read
-- vía webhook), y conviene registrar cuándo fue la última actualización.

create index if not exists whatsapp_messages_conversation_idx on public.whatsapp_messages (conversation_id);

-- Único parcial (ignora NULLs) para poder deduplicar por wa_message_id sin
-- bloquear mensajes salientes que aún no tienen id de Meta confirmado.
create unique index if not exists whatsapp_messages_wa_message_id_key
  on public.whatsapp_messages (wa_message_id) where wa_message_id is not null;

-- ============================================================
-- Seguridad a nivel de fila (RLS)
-- Nota: el webhook de recepción (Edge Function) usará la service_role key,
-- que ignora RLS por completo — las policies de aquí abajo son solo para
-- el acceso desde el CRM autenticado (lectura del hilo, envío manual, etc.)
-- ============================================================
alter table public.whatsapp_messages enable row level security;

drop policy if exists "admins leen whatsapp_messages" on public.whatsapp_messages;
create policy "admins leen whatsapp_messages"
  on public.whatsapp_messages for select to authenticated using (true);

drop policy if exists "admins crean whatsapp_messages" on public.whatsapp_messages;
create policy "admins crean whatsapp_messages"
  on public.whatsapp_messages for insert to authenticated with check (true);

drop policy if exists "admins actualizan whatsapp_messages" on public.whatsapp_messages;
create policy "admins actualizan whatsapp_messages"
  on public.whatsapp_messages for update to authenticated using (true) with check (true);

drop policy if exists "admins borran whatsapp_messages" on public.whatsapp_messages;
create policy "admins borran whatsapp_messages"
  on public.whatsapp_messages for delete to authenticated using (true);

drop trigger if exists whatsapp_messages_set_updated_at on public.whatsapp_messages;
create trigger whatsapp_messages_set_updated_at
  before update on public.whatsapp_messages
  for each row execute function public.set_updated_at();

-- ============================================================
-- Plantillas de WhatsApp (sincronizadas desde el WhatsApp Business Manager de Meta)
-- ============================================================
create table if not exists public.whatsapp_templates (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),

  name        text not null,             -- nombre técnico de la plantilla en Meta
  category    text,                      -- 'Utilidad' / 'Marketing' / 'Recordatorio'... (catálogo en código)
  language    text default 'es_ES',      -- código de idioma de Meta, ej. es_ES
  body        text,                      -- cuerpo con variables {{1}}, {{2}}...
  status      text not null default 'pending', -- 'approved' / 'pending' / 'rejected' (estado en Meta)
  variables   jsonb default '[]'::jsonb, -- metadatos de las variables (nombre, ejemplo, tipo)

  synced_at   timestamptz                -- última vez que se sincronizó con Meta
);

-- Una plantilla se identifica en Meta por nombre + idioma; evita duplicados al resincronizar.
create unique index if not exists whatsapp_templates_name_language_key
  on public.whatsapp_templates (name, language);

-- ============================================================
-- Seguridad a nivel de fila (RLS)
-- ============================================================
alter table public.whatsapp_templates enable row level security;

drop policy if exists "admins leen whatsapp_templates" on public.whatsapp_templates;
create policy "admins leen whatsapp_templates"
  on public.whatsapp_templates for select to authenticated using (true);

drop policy if exists "admins crean whatsapp_templates" on public.whatsapp_templates;
create policy "admins crean whatsapp_templates"
  on public.whatsapp_templates for insert to authenticated with check (true);

drop policy if exists "admins actualizan whatsapp_templates" on public.whatsapp_templates;
create policy "admins actualizan whatsapp_templates"
  on public.whatsapp_templates for update to authenticated using (true) with check (true);

drop policy if exists "admins borran whatsapp_templates" on public.whatsapp_templates;
create policy "admins borran whatsapp_templates"
  on public.whatsapp_templates for delete to authenticated using (true);

-- ============================================================
-- Pieza 2 — plantillas: enviar plantillas de verdad requiere el array
-- "components" crudo de Meta (hoy solo se guardaba el texto del BODY y un
-- resumen de variables — insuficiente si la plantilla tiene HEADER o BUTTONS).
-- Bloque idempotente: seguro tanto en una BD nueva (recién creada con este
-- mismo fichero) como en la BD actual, ya poblada.
-- ============================================================
alter table public.whatsapp_templates
  add column if not exists components jsonb not null default '[]'::jsonb; -- array "components" crudo de la Graph API, sin parsear

alter table public.whatsapp_templates
  add column if not exists parameter_format text; -- 'POSITIONAL' / 'NAMED' según Meta; nullable

alter table public.whatsapp_templates
  add column if not exists meta_template_id text; -- id de la plantilla en Meta (no confundir con el id propio, uuid)

alter table public.whatsapp_messages
  add column if not exists meta jsonb; -- metadatos del envío (p. ej. plantilla usada + variables); nullable
