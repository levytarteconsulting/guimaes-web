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
-- objeto en Storage y NUNCA cambia: la ruta de un adjunto de WhatsApp se
-- indexa por whatsapp_conversation_id y la de una subida manual por
-- contacto y documento (manual/{contact_id}/{documento_id}/{nombre}).
-- Vincular/desvincular una conversación, mover un documento de carpeta o
-- renombrarlo solo reescribe columnas de esta tabla (contact_id,
-- folder_id, original_filename), nunca mueve el fichero.
--
-- Carpetas y dueño: los documentos son de la EMPRESA. public.carpetas,
-- documentos.empresa_id y documentos.folder_id los crea
-- crm/supabase-carpetas.sql, que va después de este fichero. contact_id
-- (abajo) ya no es el dueño: es quién aportó el documento. La antigua
-- columna de texto documentos.folder se eliminó en el Paso B
-- (crm/supabase-carpetas-paso-b.sql) y ya no se crea aquí.
--
-- whatsapp_conversation_id / whatsapp_message_id: "on delete set null"
-- (no cascade) — borrar una conversación o un mensaje no borra la fila de
-- documentos, que sobrevive con su fichero localizable, igual que al
-- borrar un contacto. En una base ya existente, ese cambio de FK lo aplica
-- crm/supabase-carpetas.sql (este "create table if not exists" no toca
-- una tabla que ya existe).
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

  -- Quién lo aportó (NO el dueño: empresa_id/folder_id los añade crm/supabase-carpetas.sql)
  contact_id                uuid references public.contactos(id) on delete set null,

  -- Origen
  source                    text not null default 'manual',   -- 'manual' / 'whatsapp'
  whatsapp_conversation_id  uuid references public.whatsapp_conversations(id) on delete set null,
  whatsapp_message_id       uuid references public.whatsapp_messages(id) on delete set null,
  uploaded_by               uuid references public.admins(id) on delete set null,

  visible                   boolean not null default false
);

alter table public.documentos drop constraint if exists documentos_status_check;
alter table public.documentos add constraint documentos_status_check
  check (status in ('pending','stored','failed','too_large'));

alter table public.documentos drop constraint if exists documentos_source_check;
alter table public.documentos add constraint documentos_source_check
  check (source in ('manual','whatsapp','cliente'));

create unique index if not exists documentos_storage_path_key on public.documentos (storage_path);
create unique index if not exists documentos_whatsapp_message_id_key
  on public.documentos (whatsapp_message_id) where whatsapp_message_id is not null;

-- Adjuntos de un hilo de WhatsApp (independiente de si está vinculado a
-- un contacto). El índice de "documentos de un contacto por carpeta"
-- (contact_id, folder_id) lo crea crm/supabase-carpetas.sql junto con la
-- columna.
create index if not exists documentos_whatsapp_conversation_idx
  on public.documentos (whatsapp_conversation_id);

-- Compartido con el cliente: cuándo y qué admin puso visible = true
-- (crm/supabase-portal-fase1.sql). Lo rellena el trigger con auth.uid();
-- se limpia al dejar de compartir y no se puede tocar a mano mientras
-- visible no cambie. shared_by → admins(id), como uploaded_by.
alter table public.documentos add column if not exists shared_at timestamptz;
alter table public.documentos add column if not exists shared_by uuid references public.admins(id) on delete set null;

create or replace function public.documentos_registrar_compartido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.visible is not distinct from old.visible then
    new.shared_at := old.shared_at;
    new.shared_by := old.shared_by;
  elsif new.visible then
    new.shared_at := now();
    new.shared_by := (select a.id from public.admins a where a.auth_user_id = auth.uid());
  else
    new.shared_at := null;
    new.shared_by := null;
  end if;
  return new;
end;
$$;
revoke all on function public.documentos_registrar_compartido() from public, anon, authenticated, service_role;

drop trigger if exists documentos_registrar_compartido on public.documentos;
create trigger documentos_registrar_compartido
  before insert or update on public.documentos
  for each row execute function public.documentos_registrar_compartido();

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
