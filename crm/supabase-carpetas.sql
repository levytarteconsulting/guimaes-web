-- ============================================================
-- GUIMAES — Carpetas de documentos por EMPRESA
-- Carpetas de UN nivel por empresa (public.carpetas). La documentación de
-- una asesoría es de la sociedad, no de la persona que la aporta: tanto
-- las carpetas como los documentos cuelgan de public.empresas.
-- Juego por defecto al crear una empresa (Fiscal, Laboral, Mercantil,
-- Contratos) y una carpeta de sistema "WhatsApp" por empresa, que se crea
-- sola con el primer adjunto que llega de cualquiera de sus contactos.
--
-- documentos.contact_id ya NO es el dueño del documento: es quién lo
-- aportó (el contacto que lo mandó por WhatsApp; NULL si lo subió un
-- admin). El dueño es documentos.empresa_id. Se renombrará a
-- aportado_por_contact_id en un paso posterior, cuando el webhook ya no lo
-- escriba.
--
-- Requiere que supabase-contactos.sql (set_updated_at()), supabase-admins.sql
-- (is_admin()), supabase-empresas.sql, supabase-whatsapp.sql y
-- supabase-documentos.sql ya se hayan ejecutado.
--
-- En una base que todavía tenga el modelo anterior (carpetas por
-- contacto), ejecutar ANTES el BLOQUE B de
-- crm/supabase-documentos-empresa.sql — este fichero se niega a correr
-- sobre el modelo antiguo (ver punto 0).
--
-- Ejecutar en Supabase → SQL Editor → New query → Run. Idempotente.
-- ============================================================

-- ============================================================
-- 0) Salvaguarda: no aplicar el modelo nuevo encima del antiguo
-- ============================================================
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'carpetas' and column_name = 'contact_id') then
    raise exception 'public.carpetas aún cuelga de contactos: ejecuta antes el BLOQUE B de crm/supabase-documentos-empresa.sql.';
  end if;
end;
$$;

-- ============================================================
-- 1) Tabla carpetas
--
-- La carpeta WhatsApp se identifica por system_key, no por el nombre. El
-- check de nombre reserva "WhatsApp" (sin distinguir mayúsculas/espacios)
-- para la carpeta de sistema, así ninguna carpeta normal puede chocar con
-- ella en el índice de nombre cuando carpeta_whatsapp() intenta crearla.
--
-- (id, empresa_id) único: es el destino de la FK compuesta de documentos
-- (punto 2), que garantiza que un documento solo puede estar en una
-- carpeta de su propia empresa.
-- ============================================================
create table if not exists public.carpetas (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  empresa_id  uuid not null references public.empresas(id) on delete cascade,
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

alter table public.carpetas drop constraint if exists carpetas_id_empresa_key cascade;
alter table public.carpetas add constraint carpetas_id_empresa_key unique (id, empresa_id);

create unique index if not exists carpetas_empresa_nombre_key
  on public.carpetas (empresa_id, lower(btrim(nombre)));
create unique index if not exists carpetas_empresa_system_key
  on public.carpetas (empresa_id, system_key) where system_key is not null;

drop trigger if exists carpetas_set_updated_at on public.carpetas;
create trigger carpetas_set_updated_at
  before update on public.carpetas
  for each row execute function public.set_updated_at();

alter table public.carpetas enable row level security;

drop policy if exists "admins leen carpetas" on public.carpetas;
create policy "admins leen carpetas"
  on public.carpetas for select to authenticated using ((select public.is_admin()));

drop policy if exists "admins crean carpetas" on public.carpetas;
create policy "admins crean carpetas"
  on public.carpetas for insert to authenticated with check ((select public.is_admin()));

drop policy if exists "admins actualizan carpetas" on public.carpetas;
create policy "admins actualizan carpetas"
  on public.carpetas for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists "admins borran carpetas" on public.carpetas;
create policy "admins borran carpetas"
  on public.carpetas for delete to authenticated using ((select public.is_admin()));

-- ============================================================
-- 2) Cambios en public.documentos
--
-- empresa_id: el dueño. NULL solo para adjuntos de una conversación sin
-- vincular (o vinculada a un contacto sin empresa). "on delete restrict":
-- una empresa con documentos no se puede borrar sin decidir antes qué
-- pasa con ellos — nunca se quedan huérfanos en silencio.
--
-- folder_id: NULL si y solo si no hay empresa. Un documento con empresa
-- siempre tiene carpeta (no hay "Sin carpeta"); lo impone el trigger
-- documentos_resolver_carpeta (punto 4), no un CHECK, por el mismo motivo
-- que antes: durante un cascade la fila pasa un instante por estados
-- intermedios.
--
-- FK compuesta (folder_id, empresa_id) → carpetas(id, empresa_id), MATCH
-- SIMPLE: con folder_id NULL no se comprueba nada. "on delete set null
-- (folder_id)" (PG15+) anula solo folder_id.
--
-- contact_id (de supabase-documentos.sql): quién lo aportó. Ya no forma
-- parte de ninguna regla de pertenencia.
-- ============================================================
alter table public.documentos add column if not exists folder_id uuid;
alter table public.documentos add column if not exists empresa_id uuid;

alter table public.documentos drop constraint if exists documentos_empresa_fkey;
alter table public.documentos add constraint documentos_empresa_fkey
  foreign key (empresa_id) references public.empresas(id) on delete restrict;

alter table public.documentos drop constraint if exists documentos_carpeta_fkey;
alter table public.documentos add constraint documentos_carpeta_fkey
  foreign key (folder_id, empresa_id) references public.carpetas (id, empresa_id)
  on delete set null (folder_id);

create index if not exists documentos_empresa_folder_idx
  on public.documentos (empresa_id, folder_id);
create index if not exists documentos_folder_id_idx
  on public.documentos (folder_id);
create index if not exists documentos_contact_idx
  on public.documentos (contact_id);

comment on column public.documentos.contact_id is
  'Quién aportó el documento (contacto que lo mandó por WhatsApp). NO es el dueño: el dueño es empresa_id.';

-- Borrar una conversación o un mensaje no borra la fila de documentos.
alter table public.documentos drop constraint if exists documentos_whatsapp_conversation_id_fkey;
alter table public.documentos add constraint documentos_whatsapp_conversation_id_fkey
  foreign key (whatsapp_conversation_id) references public.whatsapp_conversations(id) on delete set null;

alter table public.documentos drop constraint if exists documentos_whatsapp_message_id_fkey;
alter table public.documentos add constraint documentos_whatsapp_message_id_fkey
  foreign key (whatsapp_message_id) references public.whatsapp_messages(id) on delete set null;

-- Una subida manual sube primero el fichero y crea la fila después, así
-- que nace ya 'stored' y el cron de adjuntos colgados no puede marcarla.
alter table public.documentos drop constraint if exists documentos_manual_stored_check;
alter table public.documentos add constraint documentos_manual_stored_check
  check (source = 'whatsapp' or status = 'stored');

-- ============================================================
-- 3) Funciones de carpetas
-- ============================================================

-- Empresa a la que van los adjuntos de un contacto: la principal; si no
-- tiene ninguna marcada, la enlazada más antigua. Mismo criterio que
-- resolve_contacto_company (crm/supabase-empresas.sql). NULL si el
-- contacto no tiene empresa. La usan el trigger de documentos y
-- vincular_conversacion(), para que los dos decidan igual.
create or replace function public.empresa_principal_de(p_contact_id uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select ce.empresa_id
  from public.contacto_empresa ce
  where ce.contact_id = p_contact_id
  order by ce.principal desc, ce.created_at asc, ce.id
  limit 1;
$$;

-- Juego por defecto. La lista vive SOLO aquí.
create or replace function public.sembrar_carpetas_por_defecto(p_empresa_id uuid)
returns void
language sql
set search_path = public
as $$
  insert into public.carpetas (empresa_id, nombre, orden)
  values (p_empresa_id, 'Fiscal',    1),
         (p_empresa_id, 'Laboral',   2),
         (p_empresa_id, 'Mercantil', 3),
         (p_empresa_id, 'Contratos', 4)
  on conflict do nothing;
$$;

-- Al crear una empresa, por cualquier camino (alta guiada, alta de
-- contacto con empresa nueva, conversión de leads, SQL): el insert de la
-- empresa y el de sus carpetas van en la misma sentencia.
create or replace function public.empresas_sembrar_carpetas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.sembrar_carpetas_por_defecto(new.id);
  return new;
end;
$$;

drop trigger if exists empresas_sembrar_carpetas on public.empresas;
create trigger empresas_sembrar_carpetas
  after insert on public.empresas
  for each row execute function public.empresas_sembrar_carpetas();

-- Carpeta WhatsApp de la empresa, creándola si no existe. Concurrencia: si
-- dos adjuntos llegan a la vez, el segundo "on conflict" espera al commit
-- del primero y no inserta; el select de después ya la ve.
create or replace function public.carpeta_whatsapp(p_empresa_id uuid)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.carpetas (empresa_id, nombre, system_key, orden)
  values (p_empresa_id, 'WhatsApp', 'whatsapp', 100)
  on conflict (empresa_id, system_key) where system_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.carpetas
    where empresa_id = p_empresa_id and system_key = 'whatsapp';
  end if;
  return v_id;
end;
$$;

-- Protección de carpetas:
--   - empresa_id no cambia nunca.
--   - system_key no se toca desde fuera.
--   - La carpeta WhatsApp no se renombra mientras tenga documentos. Si se
--     renombra vacía, deja de ser la de sistema (system_key → NULL).
--   - Ninguna carpeta con documentos se borra: hay que moverlos antes
--     (borrar_carpeta() lo hace en una transacción). Si el borrado viene
--     del cascade de borrar la empresa (la empresa ya no existe), el
--     mensaje lo dice: una empresa con documentos no se puede borrar
--     (además lo impide documentos.empresa_id, "on delete restrict").
create or replace function public.carpetas_proteger()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.empresa_id is distinct from old.empresa_id then
      raise exception 'Una carpeta no puede cambiar de empresa';
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
  if exists (select 1 from public.documentos where folder_id = old.id) then
    if not exists (select 1 from public.empresas where id = old.empresa_id) then
      raise exception 'La empresa tiene documentos: no se puede borrar sin moverlos antes a otra empresa';
    end if;
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

-- Resuelve quién aportó, de qué empresa es y en qué carpeta va:
--   1. Adjunto de WhatsApp nuevo sin contact_id: el contacto vinculado a su
--      conversación EN ESTE MOMENTO. El webhook ya no necesita mandarlo, y
--      se cierra la carrera de "se vinculó la conversación entre que el
--      webhook la leyó y el insert". Si lo manda (webhook antiguo), se usa.
--   2. Adjunto de WhatsApp nuevo sin empresa: la principal de ese contacto.
--      Todo dentro del mismo insert: ningún viaje más antes del 200 a Meta.
--   3. Sin empresa ⇒ sin carpeta.
--   4. Cambio de empresa sin tocar folder_id: la carpeta era de la empresa
--      anterior (la FK compuesta lo rechazaría); se descarta y se resuelve.
--   5. Adjunto de WhatsApp con empresa y sin carpeta: a la carpeta WhatsApp
--      de su empresa. (En UPDATE también: poner folder_id a NULL en un
--      adjunto lo devuelve a WhatsApp; sacarlo de ahí exige destino.)
--   6. Cualquier otro documento con empresa y sin carpeta: error (p. ej.
--      una subida manual sin carpeta).
create or replace function public.documentos_resolver_carpeta()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.source = 'whatsapp' then
    if new.contact_id is null and new.whatsapp_conversation_id is not null then
      select contact_id into new.contact_id
      from public.whatsapp_conversations where id = new.whatsapp_conversation_id;
    end if;
    if new.empresa_id is null and new.contact_id is not null then
      new.empresa_id := public.empresa_principal_de(new.contact_id);
    end if;
  end if;

  if new.empresa_id is null then
    new.folder_id := null;
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.empresa_id is distinct from old.empresa_id
     and new.folder_id is not distinct from old.folder_id then
    new.folder_id := null;
  end if;
  if new.folder_id is not null then
    return new;
  end if;

  if new.source = 'whatsapp' then
    new.folder_id := public.carpeta_whatsapp(new.empresa_id);
    return new;
  end if;

  raise exception 'Un documento de una empresa tiene que estar en una carpeta';
end;
$$;

drop trigger if exists documentos_resolver_carpeta on public.documentos;
create trigger documentos_resolver_carpeta
  before insert or update on public.documentos
  for each row execute function public.documentos_resolver_carpeta();

-- Al borrar un adjunto de WhatsApp, el mensaje sigue apuntando a él en
-- meta.attachment.documento_id: se marca 'deleted' para que el chat no
-- intente firmar una URL de algo que ya no existe. SECURITY DEFINER:
-- whatsapp_messages solo la actualiza quien pasa su RLS, y esto debe
-- ocurrir siempre que se borre el documento.
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
-- SECURITY INVOKER: la RLS de cada tabla sigue aplicando. El is_admin()
-- explícito del principio hace que un no-admin reciba un error claro en
-- vez de un update que afecta a cero filas en silencio.
-- ============================================================

-- Vincula (p_contact_id = uuid) o desvincula (NULL) una conversación y
-- arrastra sus adjuntos, todo en una transacción.
--   - Vincular a C: los adjuntos quedan aportados por C y, si no están ya
--     en la empresa principal de C, pasan a la carpeta WhatsApp de esa
--     empresa. Los que ya están en ella no se tocan: volver a vincular no
--     deshace lo que un admin haya archivado a mano. Si C no tiene empresa,
--     los adjuntos se quedan sin empresa (nunca en la del contacto anterior).
--   - Desvincular: sin contacto, sin empresa y sin carpeta. Desvincular
--     significa "esta conversación no era de esa persona": sus adjuntos no
--     pueden quedarse en la empresa.
--   - Cambiar después la empresa principal de C NO mueve nada: los
--     documentos son de la empresa en la que se archivaron; la principal
--     solo decide dónde van los adjuntos futuros.
create or replace function public.vincular_conversacion(p_conversation_id uuid, p_contact_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_empresa uuid;
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
    update public.documentos set contact_id = null, empresa_id = null
    where whatsapp_conversation_id = p_conversation_id
      and (contact_id is not null or empresa_id is not null);
    return;
  end if;

  update public.documentos set contact_id = p_contact_id
  where whatsapp_conversation_id = p_conversation_id
    and contact_id is distinct from p_contact_id;

  v_empresa := public.empresa_principal_de(p_contact_id);
  if v_empresa is null then
    update public.documentos set empresa_id = null
    where whatsapp_conversation_id = p_conversation_id and empresa_id is not null;
    return;
  end if;

  if not exists (select 1 from public.documentos
                 where whatsapp_conversation_id = p_conversation_id
                   and empresa_id is distinct from v_empresa) then
    return;
  end if;

  v_carpeta := public.carpeta_whatsapp(v_empresa);
  update public.documentos
  set empresa_id = v_empresa, folder_id = v_carpeta
  where whatsapp_conversation_id = p_conversation_id
    and empresa_id is distinct from v_empresa;
end;
$$;

-- Mueve documentos a una carpeta. El destino es obligatorio (no existe
-- "Sin carpeta") y decide también la empresa: mover a una carpeta de otra
-- empresa cambia el documento de empresa. Es la vía para corregir un
-- adjunto que acabó en la sociedad equivocada; la interfaz ofrece por
-- defecto solo las carpetas de la misma empresa.
create or replace function public.mover_documentos(p_documento_ids uuid[], p_carpeta_destino uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_empresa uuid;
  v_pedidos int;
  v_movidos int;
begin
  if not public.is_admin() then
    raise exception 'No autorizado';
  end if;
  if p_carpeta_destino is null then
    raise exception 'Hace falta una carpeta destino';
  end if;

  select empresa_id into v_empresa from public.carpetas where id = p_carpeta_destino;
  if not found then
    raise exception 'Carpeta destino no encontrada: %', p_carpeta_destino;
  end if;

  update public.documentos
  set empresa_id = v_empresa, folder_id = p_carpeta_destino
  where id = any(p_documento_ids);
  get diagnostics v_movidos = row_count;

  select count(distinct x) into v_pedidos from unnest(p_documento_ids) as x;
  if v_movidos <> v_pedidos then
    raise exception 'Se pidieron % documentos pero se encontraron %', v_pedidos, v_movidos;
  end if;
  return v_movidos;
end;
$$;

-- Borra una carpeta. Si tiene documentos, p_destino es obligatorio y debe
-- ser otra carpeta DE LA MISMA EMPRESA (cambiar de empresa es una decisión
-- aparte, con mover_documentos). La carpeta WhatsApp con documentos no se
-- borra ni con destino. "for update" bloquea la carpeta mientras tanto.
create or replace function public.borrar_carpeta(p_carpeta_id uuid, p_destino uuid default null)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_carpeta public.carpetas%rowtype;
  v_destino_empresa uuid;
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
    select empresa_id into v_destino_empresa from public.carpetas where id = p_destino;
    if v_destino_empresa is distinct from v_carpeta.empresa_id then
      raise exception 'La carpeta destino tiene que ser de la misma empresa';
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
--     ('empresa_principal_de','sembrar_carpetas_por_defecto','carpeta_whatsapp',
--      'documentos_resolver_carpeta','vincular_conversacion','mover_documentos','borrar_carpeta');
-- ============================================================
