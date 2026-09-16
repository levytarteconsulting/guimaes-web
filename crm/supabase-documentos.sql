-- ============================================================
-- GUIMAES — Storage de documentos (bucket "documentos") y tabla
-- public.documentos, compartida entre los adjuntos entrantes de WhatsApp
-- y la futura Fase 5 (subida manual de documentos por contacto).
--
-- Requiere que supabase-contactos.sql (usa public.set_updated_at()),
-- supabase-whatsapp.sql y supabase-admins.sql (usa public.is_admin())
-- ya se hayan ejecutado.
--
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run. Idempotente.
-- ============================================================

-- ============================================================
-- 1) Bucket privado, con tope de tamaño a nivel de plataforma como
-- segunda línea de defensa además de la comprobación que hace el propio
-- webhook contra el file_size que informa Meta (ver punto 3 más abajo) —
-- así, aunque hubiera un bug en ese chequeo, Storage rechazaría igualmente
-- cualquier subida de más de 15 MB.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('documentos', 'documentos', false, 15728640) -- 15 MB
on conflict (id) do update set public = false, file_size_limit = 15728640;

-- ============================================================
-- 2) RLS de Storage sobre este bucket — mismo criterio que el resto del
-- CRM (cualquier admin autenticado tiene acceso total), pero usando
-- public.is_admin() en vez de "to authenticated using (true)" como hacían
-- las tablas más antiguas (contactos, tareas...): is_admin() sí comprueba
-- contra public.admins (incluido activo=true), así que un admin
-- desactivado deja de poder leer/escribir ficheros de inmediato, no solo
-- de iniciar sesión. service_role (el webhook) ignora RLS igual que en
-- cualquier otra tabla.
-- ============================================================
drop policy if exists "admins leen documentos (storage)" on storage.objects;
create policy "admins leen documentos (storage)"
  on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and public.is_admin());

drop policy if exists "admins suben documentos (storage)" on storage.objects;
create policy "admins suben documentos (storage)"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and public.is_admin());

drop policy if exists "admins actualizan documentos (storage)" on storage.objects;
create policy "admins actualizan documentos (storage)"
  on storage.objects for update to authenticated
  using (bucket_id = 'documentos' and public.is_admin())
  with check (bucket_id = 'documentos' and public.is_admin());

drop policy if exists "admins borran documentos (storage)" on storage.objects;
create policy "admins borran documentos (storage)"
  on storage.objects for delete to authenticated
  using (bucket_id = 'documentos' and public.is_admin());

-- ============================================================
-- 3) Tabla de metadatos. storage_path es la identidad permanente del
-- objeto en Storage (ver crm/supabase-documentos.sql — la ruta de un
-- adjunto de WhatsApp se indexa por whatsapp_conversation_id y NUNCA
-- cambia; vincular/desvincular la conversación a un contacto solo
-- reescribe contact_id aquí, nunca mueve el fichero).
-- ============================================================
create table if not exists public.documentos (
  id                        uuid primary key default gen_random_uuid(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Storage
  storage_path              text not null,
  mime_type                 text,
  size_bytes                bigint,
  original_filename         text,
  status                    text not null default 'pending', -- 'pending' / 'stored' / 'failed' / 'too_large'

  -- Organización / visibilidad
  contact_id                uuid references public.contactos(id) on delete set null,
  folder                    text not null default 'General',  -- 'WhatsApp' reservada para adjuntos entrantes

  -- Origen
  source                    text not null default 'manual',   -- 'manual' / 'whatsapp'
  whatsapp_conversation_id  uuid references public.whatsapp_conversations(id) on delete cascade,
  whatsapp_message_id       uuid references public.whatsapp_messages(id) on delete cascade,
  uploaded_by               uuid references public.admins(id) on delete set null,

  visible                   boolean not null default false
);

alter table public.documentos drop constraint if exists documentos_status_check;
alter table public.documentos add constraint documentos_status_check
  check (status in ('pending','stored','failed','too_large'));

alter table public.documentos drop constraint if exists documentos_source_check;
alter table public.documentos add constraint documentos_source_check
  check (source in ('manual','whatsapp'));

create unique index if not exists documentos_storage_path_key on public.documentos (storage_path);
create unique index if not exists documentos_whatsapp_message_id_key
  on public.documentos (whatsapp_message_id) where whatsapp_message_id is not null;

-- Las dos consultas más frecuentes: adjuntos de un hilo de WhatsApp
-- (independiente de si está vinculado a un contacto), y documentos de un
-- contacto por carpeta (incluida su carpeta "WhatsApp" una vez vinculado).
create index if not exists documentos_whatsapp_conversation_idx
  on public.documentos (whatsapp_conversation_id);
create index if not exists documentos_contact_folder_idx
  on public.documentos (contact_id, folder);

drop trigger if exists documentos_set_updated_at on public.documentos;
create trigger documentos_set_updated_at
  before update on public.documentos
  for each row execute function public.set_updated_at();

-- ============================================================
-- 4) RLS de la propia tabla (no la de Storage, que es aparte — ver punto 2)
-- ============================================================
alter table public.documentos enable row level security;

drop policy if exists "admins leen documentos" on public.documentos;
create policy "admins leen documentos"
  on public.documentos for select to authenticated using (public.is_admin());

drop policy if exists "admins crean documentos" on public.documentos;
create policy "admins crean documentos"
  on public.documentos for insert to authenticated with check (public.is_admin());

drop policy if exists "admins actualizan documentos" on public.documentos;
create policy "admins actualizan documentos"
  on public.documentos for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins borran documentos" on public.documentos;
create policy "admins borran documentos"
  on public.documentos for delete to authenticated using (public.is_admin());
