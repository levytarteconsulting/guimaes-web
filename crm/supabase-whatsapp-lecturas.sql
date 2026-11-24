-- ============================================================
-- GUIMAES — WhatsApp: conversaciones no leídas (estado compartido)
--
-- Hasta ahora "no leída" solo existía en memoria del navegador: al recargar
-- todo salía leído, y abrir una conversación en un dispositivo no la
-- marcaba en los demás.
--
-- Tabla public.whatsapp_lecturas, una fila por conversación:
--   leido_hasta: los mensajes entrantes (direction = 'in') con created_at
--   posterior están sin leer. Sin fila = todo lo entrante está sin leer
--   (conversación nueva que crea el webhook).
-- Estado compartido por todo el equipo (no por usuario). El CRM:
--   * al abrir la conversación (o responder, o si entra un mensaje con
--     ella abierta) pone leido_hasta = created_at de su último mensaje;
--   * "Marcar como no leída" pone leido_hasta justo antes del último
--     mensaje entrante.
-- Tabla aparte (y no una columna en whatsapp_conversations) para que leer
-- no mueva whatsapp_conversations.updated_at, que usan el agente y la lista.
-- RLS: usuarios del CRM (is_admin()), como el resto de WhatsApp. En la
-- publicación supabase_realtime, para que el cambio llegue a los demás
-- dispositivos sin recargar.
--
-- Las conversaciones que ya existen quedan leídas (leido_hasta = now()).
--
-- Migración 20261124120000. Ejecutar en orden 4A → 4B → 4C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/agente).
-- ============================================================


-- ============================================================
-- 4A (comprobación previa, solo lectura) — Lo esperado:
--   tabla whatsapp_lecturas: no
--   publicación supabase_realtime: sí
--   función is_admin: sí
--   migración 20261124120000: no
--   (y el número de conversaciones, para compararlo con 4C)
-- ============================================================
select 'tabla whatsapp_lecturas' as comprobacion,
       case when to_regclass('public.whatsapp_lecturas') is null then 'no' else 'sí' end as valor
union all
select 'publicación supabase_realtime',
       case when exists (select 1 from pg_publication where pubname = 'supabase_realtime') then 'sí' else 'no' end
union all
select 'función is_admin',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = 'is_admin') then 'sí' else 'no' end
union all
select 'migración 20261124120000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261124120000')
            then 'sí' else 'no' end
union all
select 'conversaciones', count(*)::text from public.whatsapp_conversations;


-- ============================================================
-- 4B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261124120000') then
    raise exception 'La migración 20261124120000 (whatsapp_lecturas) ya está aplicada.';
  end if;
  if to_regclass('public.whatsapp_lecturas') is not null then
    raise exception 'public.whatsapp_lecturas ya existe: estado inesperado, no se toca nada.';
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'No existe la publicación supabase_realtime: estado inesperado, no se toca nada.';
  end if;

  create table public.whatsapp_lecturas (
    conversation_id uuid primary key references public.whatsapp_conversations(id) on delete cascade,
    leido_hasta     timestamptz not null,
    updated_at      timestamptz not null default now()
  );
  comment on table public.whatsapp_lecturas is
    'Hasta dónde está leída cada conversación de WhatsApp (compartido por el equipo). Sin fila = todo lo entrante sin leer.';

  create trigger whatsapp_lecturas_set_updated_at before update on public.whatsapp_lecturas
    for each row execute function public.set_updated_at();

  alter table public.whatsapp_lecturas enable row level security;
  create policy "admins leen whatsapp_lecturas" on public.whatsapp_lecturas
    for select to authenticated using ((select public.is_admin()));
  create policy "admins crean whatsapp_lecturas" on public.whatsapp_lecturas
    for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan whatsapp_lecturas" on public.whatsapp_lecturas
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  -- Sin política de DELETE: las filas se van solas con la conversación.

  -- Supabase da todos los privilegios por defecto a anon y authenticated.
  revoke all on public.whatsapp_lecturas from anon, authenticated;
  grant select, insert, update on public.whatsapp_lecturas to authenticated;

  -- Lo que ya existe queda leído.
  insert into public.whatsapp_lecturas (conversation_id, leido_hasta)
  select id, now() from public.whatsapp_conversations;

  alter publication supabase_realtime add table public.whatsapp_lecturas;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261124120000', array['create table whatsapp_lecturas'], 'whatsapp no leídas (crm/supabase-whatsapp-lecturas.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 4C (verificación, solo lectura) — Lo esperado:
--   tabla whatsapp_lecturas: sí          RLS activada: sí
--   políticas: 3                         en supabase_realtime: sí
--   anon select: false                   authenticated s/i/u/d: true/true/true/false
--   lecturas = conversaciones (las de 4A)
--   migración registrada: 20261124120000 ...
-- ============================================================
select 'tabla whatsapp_lecturas' as comprobacion,
       case when to_regclass('public.whatsapp_lecturas') is null then 'no' else 'sí' end as valor
union all
select 'RLS activada',
       case when (select relrowsecurity from pg_class where oid = to_regclass('public.whatsapp_lecturas')) then 'sí' else 'no' end
union all
select 'políticas', count(*)::text from pg_policies where schemaname = 'public' and tablename = 'whatsapp_lecturas'
union all
select 'en supabase_realtime',
       case when exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                         and schemaname = 'public' and tablename = 'whatsapp_lecturas') then 'sí' else 'no' end
union all
select 'anon select', has_table_privilege('anon', 'public.whatsapp_lecturas', 'SELECT')::text
union all
select 'authenticated s/i/u/d',
       has_table_privilege('authenticated', 'public.whatsapp_lecturas', 'SELECT') || '/' ||
       has_table_privilege('authenticated', 'public.whatsapp_lecturas', 'INSERT') || '/' ||
       has_table_privilege('authenticated', 'public.whatsapp_lecturas', 'UPDATE') || '/' ||
       has_table_privilege('authenticated', 'public.whatsapp_lecturas', 'DELETE')
union all
select 'lecturas', count(*)::text from public.whatsapp_lecturas
union all
select 'conversaciones', count(*)::text from public.whatsapp_conversations
union all
select 'migración registrada', version || ' ' || name
from supabase_migrations.schema_migrations where version = '20261124120000';
