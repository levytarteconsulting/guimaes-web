-- ============================================================
-- GUIMAES — Fase 5: Carpetas de documentos (Paso A)
-- Carpetas de UN nivel por contacto, en tabla propia (public.carpetas) en
-- vez del texto libre documentos.folder. Juego por defecto al crear un
-- contacto (Fiscal, Laboral, Mercantil, Contratos) y una carpeta de
-- sistema "WhatsApp" que se crea sola cuando llega el primer adjunto de un
-- contacto vinculado.
--
-- Requiere que supabase-contactos.sql (usa public.set_updated_at()),
-- supabase-admins.sql (usa public.is_admin()), supabase-whatsapp.sql y
-- supabase-documentos.sql ya se hayan ejecutado.
--
-- Después de este fichero: crm/supabase-carpetas-migracion.sql (asigna
-- carpeta a los documentos que ya existen).
--
-- documentos.folder (texto) NO se borra aquí: cuando se escribió esto el
-- webhook desplegado aún lo escribía. Se elimina en el Paso B
-- (crm/supabase-carpetas-paso-b.sql), con el webhook y el frontend nuevos
-- ya desplegados.
--
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run. Idempotente.
-- ============================================================

-- ============================================================
-- 1) Tabla carpetas
--
-- La carpeta WhatsApp se identifica por system_key, no por el nombre: el
-- webhook y vincular_conversacion() la buscan por clave. El check de
-- nombre reserva "WhatsApp" (sin distinguir mayúsculas/espacios) para la
-- carpeta de sistema, así ninguna carpeta normal puede chocar con ella en
-- el índice de nombre cuando carpeta_whatsapp() intenta crearla.
--
-- (id, contact_id) único: es el destino de la FK compuesta de
-- documentos (punto 2), que garantiza que un documento solo puede estar
-- en una carpeta de su propio contacto.
-- ============================================================
create table if not exists public.carpetas (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  contact_id  uuid not null references public.contactos(id) on delete cascade,
  nombre      text not null,
  system_key  text,             -- 'whatsapp' para la carpeta de sistema; NULL en el resto
  orden       int  not null default 0
);

alter table public.carpetas drop constraint if exists carpetas_nombre_check;
alter table public.carpetas add constraint carpetas_nombre_check
  check (length(btrim(nombre)) between 1 and 60);

alter table public.carpetas drop constraint if exists carpetas_system_key_check;
alter table public.carpetas add constraint carpetas_system_key_check
  check (system_key in ('whatsapp'));

alter table public.carpetas drop constraint if exists carpetas_whatsapp_reservado_check;
alter table public.carpetas add constraint carpetas_whatsapp_reservado_check
  check ((system_key is not distinct from 'whatsapp') = (lower(btrim(nombre)) = 'whatsapp'));

alter table public.carpetas drop constraint if exists carpetas_id_contact_key cascade;
alter table public.carpetas add constraint carpetas_id_contact_key unique (id, contact_id);

create unique index if not exists carpetas_contact_nombre_key
  on public.carpetas (contact_id, lower(btrim(nombre)));
create unique index if not exists carpetas_contact_system_key
  on public.carpetas (contact_id, system_key) where system_key is not null;

drop trigger if exists carpetas_set_updated_at on public.carpetas;
create trigger carpetas_set_updated_at
  before update on public.carpetas
  for each row execute function public.set_updated_at();

alter table public.carpetas enable row level security;

drop policy if exists "admins leen carpetas" on public.carpetas;
create policy "admins leen carpetas"
  on public.carpetas for select to authenticated using (public.is_admin());

drop policy if exists "admins crean carpetas" on public.carpetas;
create policy "admins crean carpetas"
  on public.carpetas for insert to authenticated with check (public.is_admin());

drop policy if exists "admins actualizan carpetas" on public.carpetas;
create policy "admins actualizan carpetas"
  on public.carpetas for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins borran carpetas" on public.carpetas;
create policy "admins borran carpetas"
  on public.carpetas for delete to authenticated using (public.is_admin());

-- ============================================================
-- 2) Cambios en public.documentos
--
-- folder_id nullable: NULL solo si el documento no tiene contacto (adjunto
-- de una conversación sin vincular, o contacto borrado). Un documento con
-- contacto siempre tiene carpeta — no hay estado "Sin carpeta". Eso no
-- puede ser un CHECK: al borrar un contacto, el set null de contact_id y
-- el cascade de sus carpetas son dos acciones RI de orden no garantizado,
-- y en medio la fila pasa por "contacto sí, carpeta no". Lo impone el
-- trigger documentos_resolver_carpeta (punto 4), que distingue ese caso.
--
-- FK compuesta con MATCH SIMPLE (por defecto): si folder_id es NULL no se
-- comprueba nada. "on delete set null (folder_id)" (PG15+) anula solo
-- folder_id, no contact_id.
-- ============================================================
alter table public.documentos add column if not exists folder_id uuid;

alter table public.documentos drop constraint if exists documentos_carpeta_fkey;
alter table public.documentos add constraint documentos_carpeta_fkey
  foreign key (folder_id, contact_id) references public.carpetas (id, contact_id)
  on delete set null (folder_id);

create index if not exists documentos_contact_folder_id_idx
  on public.documentos (contact_id, folder_id);
create index if not exists documentos_folder_id_idx
  on public.documentos (folder_id);

-- Antes eran "on delete cascade": borrar una conversación o un mensaje
-- borraba la fila de documentos y dejaba el fichero huérfano en Storage.
-- Con set null la fila sobrevive (y con ella el fichero, localizable),
-- igual que al borrar un contacto.
alter table public.documentos drop constraint if exists documentos_whatsapp_conversation_id_fkey;
alter table public.documentos add constraint documentos_whatsapp_conversation_id_fkey
  foreign key (whatsapp_conversation_id) references public.whatsapp_conversations(id) on delete set null;

alter table public.documentos drop constraint if exists documentos_whatsapp_message_id_fkey;
alter table public.documentos add constraint documentos_whatsapp_message_id_fkey
  foreign key (whatsapp_message_id) references public.whatsapp_messages(id) on delete set null;

-- Una subida manual sube primero el fichero y crea la fila después, así
-- que nace ya 'stored': nunca pasa por 'pending' y el cron de adjuntos
-- colgados (crm/supabase-documentos-stuck-cron.sql) no puede marcarla.
alter table public.documentos drop constraint if exists documentos_manual_stored_check;
alter table public.documentos add constraint documentos_manual_stored_check
  check (source = 'whatsapp' or status = 'stored');

-- ============================================================
-- 3) Funciones de carpetas
-- ============================================================

-- Juego por defecto. La lista vive SOLO aquí: la usan el trigger de alta
-- de contactos (abajo) y la migración (crm/supabase-carpetas-migracion.sql).
create or replace function public.sembrar_carpetas_por_defecto(p_contact_id uuid)
returns void
language sql
set search_path = public
as $$
  insert into public.carpetas (contact_id, nombre, orden)
  values (p_contact_id, 'Fiscal',    1),
         (p_contact_id, 'Laboral',   2),
         (p_contact_id, 'Mercantil', 3),
         (p_contact_id, 'Contratos', 4)
  on conflict do nothing;
$$;

-- Trigger y no llamada desde el frontend: el alta de un contacto (addContact,
-- convertLeadToContact en crm/data.js, y cualquier insert futuro desde SQL
-- o una Edge Function) no puede quedarse a medias con un contacto sin
-- carpetas — el insert del contacto y el de sus carpetas van en la misma
-- sentencia. Si convertLeadToContact choca con el 23505 del lead ya
-- convertido no hay insert, así que tampoco se siembra dos veces.
create or replace function public.contactos_sembrar_carpetas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.sembrar_carpetas_por_defecto(new.id);
  return new;
end;
$$;

drop trigger if exists contactos_sembrar_carpetas on public.contactos;
create trigger contactos_sembrar_carpetas
  after insert on public.contactos
  for each row execute function public.contactos_sembrar_carpetas();

-- Devuelve la carpeta WhatsApp del contacto, creándola si no existe.
-- Concurrencia: si dos adjuntos llegan a la vez, el segundo "on conflict"
-- espera al commit del primero y no inserta; el select de después (nuevo
-- snapshot en READ COMMITTED) ya la ve.
create or replace function public.carpeta_whatsapp(p_contact_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.carpetas (contact_id, nombre, system_key, orden)
  values (p_contact_id, 'WhatsApp', 'whatsapp', 100)
  on conflict (contact_id, system_key) where system_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.carpetas
    where contact_id = p_contact_id and system_key = 'whatsapp';
  end if;
  return v_id;
end;
$$;

-- Protección de carpetas:
--   - contact_id no cambia nunca (las carpetas son de un contacto).
--   - system_key no se toca desde fuera.
--   - La carpeta WhatsApp no se renombra mientras tenga documentos. Si se
--     renombra vacía, deja de ser la de sistema (system_key → NULL) y el
--     próximo adjunto creará otra "WhatsApp".
--   - Ninguna carpeta con documentos se borra: hay que moverlos antes
--     (borrar_carpeta() lo hace en una sola transacción). Excepción: si el
--     contacto ya no existe, es el cascade del borrado del contacto, y los
--     documentos se quedan sin contacto ni carpeta (ver
--     documentos_resolver_carpeta).
create or replace function public.carpetas_proteger()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.contact_id is distinct from old.contact_id then
      raise exception 'Una carpeta no puede cambiar de contacto';
    end if;
    if new.system_key is distinct from old.system_key then
      raise exception 'system_key no es editable';
    end if;
    if old.system_key = 'whatsapp' and new.nombre is distinct from old.nombre then
      if exists (select 1 from public.documentos where folder_id = old.id) then
        raise exception 'La carpeta WhatsApp tiene documentos: no se puede renombrar';
      end if;
      new.system_key := null;
    end if;
    return new;
  end if;

  -- DELETE
  if exists (select 1 from public.documentos where folder_id = old.id)
     and exists (select 1 from public.contactos where id = old.contact_id) then
    raise exception 'La carpeta "%" tiene documentos: muévelos antes de borrarla', old.nombre;
  end if;
  return old;
end;
$$;

drop trigger if exists carpetas_proteger on public.carpetas;
create trigger carpetas_proteger
  before update or delete on public.carpetas
  for each row execute function public.carpetas_proteger();

-- ============================================================
-- 4) Triggers de documentos
-- ============================================================

-- Mantiene la regla "con contacto ⇒ con carpeta; sin contacto ⇒ sin carpeta":
--   - Sin contacto: folder_id se anula (desvincular, borrar contacto).
--   - Update que deja contacto sin carpeta con el contacto ya borrado: es
--     el cascade de carpetas del borrado del contacto llegando antes que
--     el set null de contact_id; se adelanta ese set null. Va antes que
--     el caso WhatsApp: carpeta_whatsapp() de un contacto borrado
--     fallaría por la FK.
--   - Adjunto de WhatsApp con contacto y sin carpeta: va a la carpeta
--     WhatsApp del contacto, creándola si hace falta. En INSERT es lo que
--     permite que el webhook no resuelva nada ni haga ningún viaje más
--     antes de responder a Meta — va dentro del mismo insert. En UPDATE
--     cubre el frontend actual (linkWhatsappConversation solo reescribe
--     contact_id) y las filas antiguas aún sin migrar, que siguen
--     recibiendo updates de status del webhook y del cron. Consecuencia:
--     poner folder_id a NULL en un adjunto de WhatsApp no lo deja "sin
--     carpeta", lo devuelve a WhatsApp. Moverlo fuera exige destino
--     (mover_documentos).
--   - Cambio de contacto sin tocar folder_id: la carpeta era del contacto
--     anterior y ya no vale (la FK compuesta lo rechazaría); se descarta y
--     se resuelve como si no tuviera. Un adjunto de WhatsApp acaba en la
--     carpeta WhatsApp del nuevo contacto; un manual da error.
--   - Cualquier otro caso de contacto sin carpeta es un error (p. ej. una
--     subida manual sin carpeta).
create or replace function public.documentos_resolver_carpeta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.contact_id is null then
    new.folder_id := null;
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.contact_id is distinct from old.contact_id
     and new.folder_id is not distinct from old.folder_id then
    new.folder_id := null;
  end if;
  if new.folder_id is not null then
    return new;
  end if;

  if tg_op = 'UPDATE' and not exists (select 1 from public.contactos where id = new.contact_id) then
    new.contact_id := null;
    return new;
  end if;
  if new.source = 'whatsapp' then
    new.folder_id := public.carpeta_whatsapp(new.contact_id);
    return new;
  end if;

  raise exception 'Un documento con contacto tiene que estar en una carpeta';
end;
$$;

drop trigger if exists documentos_resolver_carpeta on public.documentos;
create trigger documentos_resolver_carpeta
  before insert or update on public.documentos
  for each row execute function public.documentos_resolver_carpeta();

-- Al borrar un adjunto de WhatsApp, el mensaje sigue apuntando a él en
-- meta.attachment.documento_id: se marca 'deleted' para que el chat no
-- intente firmar una URL de algo que ya no existe. Mismo jsonb_set que
-- fail_stuck_documento_downloads(). SECURITY DEFINER: whatsapp_messages no
-- tiene política de update para authenticated, y quien borra es un admin.
create or replace function public.documentos_marcar_mensaje_borrado()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.whatsapp_message_id is not null then
    update public.whatsapp_messages
    set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{attachment,status}', '"deleted"')
    where id = old.whatsapp_message_id;
  end if;
  return old;
end;
$$;

drop trigger if exists documentos_marcar_mensaje_borrado on public.documentos;
create trigger documentos_marcar_mensaje_borrado
  after delete on public.documentos
  for each row execute function public.documentos_marcar_mensaje_borrado();

-- ============================================================
-- 5) RPCs para el frontend
--
-- SECURITY INVOKER (por defecto): la RLS de cada tabla sigue aplicando.
-- El is_admin() explícito del principio está porque la RLS de
-- whatsapp_conversations es "to authenticated using (true)", no
-- is_admin(), y porque con RLS un update sin permiso no falla: afecta a
-- cero filas en silencio.
-- ============================================================

-- Vincula (p_contact_id = uuid) o desvincula (NULL) una conversación y
-- arrastra sus documentos, todo en una transacción. Sustituye a los dos
-- updates sueltos de linkWhatsappConversation (crm/data.js).
--   - Vincular a C: los documentos de la conversación que no sean ya de C
--     pasan a la carpeta WhatsApp de C (creándola solo si hay alguno). Los
--     que ya son de C no se tocan: volver a vincular al mismo contacto no
--     deshace lo que un admin haya archivado a mano.
--   - Desvincular: todos quedan sin contacto; documentos_resolver_carpeta
--     anula folder_id.
create or replace function public.vincular_conversacion(p_conversation_id uuid, p_contact_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_carpeta uuid;
begin
  if not public.is_admin() then
    raise exception 'No autorizado';
  end if;

  update public.whatsapp_conversations set contact_id = p_contact_id where id = p_conversation_id;
  if not found then
    raise exception 'Conversación no encontrada: %', p_conversation_id;
  end if;

  if p_contact_id is null then
    update public.documentos set contact_id = null
    where whatsapp_conversation_id = p_conversation_id and contact_id is not null;
    return;
  end if;

  if not exists (select 1 from public.documentos
                 where whatsapp_conversation_id = p_conversation_id
                   and contact_id is distinct from p_contact_id) then
    return;
  end if;

  v_carpeta := public.carpeta_whatsapp(p_contact_id);
  update public.documentos
  set contact_id = p_contact_id, folder_id = v_carpeta
  where whatsapp_conversation_id = p_conversation_id
    and contact_id is distinct from p_contact_id;
end;
$$;

-- Mueve documentos a otra carpeta. El destino es obligatorio: no existe
-- "Sin carpeta", y sacar un documento de WhatsApp obliga a decir a dónde
-- va. Todos los documentos tienen que ser del contacto de la carpeta
-- destino (la FK compuesta lo impediría igualmente; esto da un error
-- legible).
create or replace function public.mover_documentos(p_documento_ids uuid[], p_carpeta_destino uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_contact uuid;
  v_pedidos int;
  v_movidos int;
begin
  if not public.is_admin() then
    raise exception 'No autorizado';
  end if;
  if p_carpeta_destino is null then
    raise exception 'Hace falta una carpeta destino';
  end if;

  select contact_id into v_contact from public.carpetas where id = p_carpeta_destino;
  if not found then
    raise exception 'Carpeta destino no encontrada: %', p_carpeta_destino;
  end if;

  if exists (select 1 from public.documentos
             where id = any(p_documento_ids) and contact_id is distinct from v_contact) then
    raise exception 'Todos los documentos tienen que ser del contacto de la carpeta destino';
  end if;

  update public.documentos set folder_id = p_carpeta_destino where id = any(p_documento_ids);
  get diagnostics v_movidos = row_count;

  select count(distinct x) into v_pedidos from unnest(p_documento_ids) as x;
  if v_movidos <> v_pedidos then
    raise exception 'Se pidieron % documentos pero se encontraron %', v_pedidos, v_movidos;
  end if;
  return v_movidos;
end;
$$;

-- Borra una carpeta. Si tiene documentos, p_destino es obligatorio y se
-- mueven ahí antes de borrar, en la misma transacción. La carpeta
-- WhatsApp con documentos no se borra ni con destino: hay que vaciarla
-- antes a mano, moviendo sus documentos con mover_documentos().
-- "for update" bloquea la carpeta: un adjunto que entre a la vez espera
-- (el insert en documentos toma un lock sobre la carpeta por la FK) y, si
-- llega después, carpetas_proteger impide el borrado.
create or replace function public.borrar_carpeta(p_carpeta_id uuid, p_destino uuid default null)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_carpeta public.carpetas%rowtype;
  v_docs uuid[];
begin
  if not public.is_admin() then
    raise exception 'No autorizado';
  end if;

  select * into v_carpeta from public.carpetas where id = p_carpeta_id for update;
  if not found then
    raise exception 'Carpeta no encontrada: %', p_carpeta_id;
  end if;

  select coalesce(array_agg(id), '{}') into v_docs from public.documentos where folder_id = p_carpeta_id;

  if cardinality(v_docs) > 0 then
    if v_carpeta.system_key = 'whatsapp' then
      raise exception 'La carpeta WhatsApp tiene documentos: muévelos antes de borrarla';
    end if;
    if p_destino is null then
      raise exception 'La carpeta "%" tiene % documento(s): indica la carpeta destino', v_carpeta.nombre, cardinality(v_docs);
    end if;
    if p_destino = p_carpeta_id then
      raise exception 'La carpeta destino no puede ser la misma que se borra';
    end if;
    perform public.mover_documentos(v_docs, p_destino);
  end if;

  delete from public.carpetas where id = p_carpeta_id;
end;
$$;

-- ============================================================
-- Comprobar tras ejecutar:
--   select * from public.carpetas limit 10;
--   select proname from pg_proc where proname in
--     ('sembrar_carpetas_por_defecto','carpeta_whatsapp','vincular_conversacion',
--      'mover_documentos','borrar_carpeta');
-- ============================================================
