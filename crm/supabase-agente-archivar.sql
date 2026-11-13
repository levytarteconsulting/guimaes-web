-- ============================================================
-- GUIMAES — Agente de IA: archivar conversaciones sin alargar la retención
--
-- El CRM ya puede archivar (columna archivada, con UPDATE para el propio
-- usuario: crm/supabase-agente.sql). Pero el trigger genérico set_updated_at
-- ponía updated_at = now() en cualquier UPDATE, y la retención
-- (agente_retencion, 90 días) se cuenta desde updated_at: archivar (o
-- renombrar) reiniciaba los 90 días.
--
-- Cambio: se quita ese trigger de agente_conversaciones. updated_at pasa a
-- ser "última actividad": solo lo mueve agente_mensaje_toca_conversacion al
-- entrar un mensaje (lo pone explícitamente). El usuario no puede tocar
-- updated_at (solo tiene UPDATE en titulo y archivada). Las conversaciones
-- archivadas se siguen borrando a los 90 días de su último mensaje, igual
-- que las demás.
--
-- Migración 20261113140000. Ejecutar en orden 2A → 2B → 2C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/agente).
-- ============================================================


-- ============================================================
-- 2A (comprobación previa, solo lectura) — Lo esperado:
--   trigger set_updated_at en agente_conversaciones: 1
--   trigger de mensajes (toca conversación): 1
--   UPDATE de authenticated en titulo/archivada: true/true
--   UPDATE de authenticated en updated_at: false
--   migración 20261113140000: no
-- ============================================================
select 'trigger set_updated_at en agente_conversaciones' as comprobacion, count(*)::text as valor
from pg_trigger where tgrelid = 'public.agente_conversaciones'::regclass
  and tgname = 'agente_conversaciones_set_updated_at' and not tgisinternal
union all
select 'trigger de mensajes (toca conversación)', count(*)::text
from pg_trigger where tgrelid = 'public.agente_mensajes'::regclass
  and tgname = 'agente_mensajes_toca_conversacion' and not tgisinternal
union all
select 'UPDATE de authenticated en titulo/archivada',
       has_column_privilege('authenticated', 'public.agente_conversaciones', 'titulo', 'UPDATE') || '/'
       || has_column_privilege('authenticated', 'public.agente_conversaciones', 'archivada', 'UPDATE')
union all
select 'UPDATE de authenticated en updated_at',
       has_column_privilege('authenticated', 'public.agente_conversaciones', 'updated_at', 'UPDATE')::text
union all
select 'migración 20261113140000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261113140000')
            then 'sí' else 'no' end;


-- ============================================================
-- 2B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261113140000') then
    raise exception 'La migración 20261113140000 (agente: archivar) ya está aplicada.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.agente_conversaciones'::regclass
                   and tgname = 'agente_conversaciones_set_updated_at' and not tgisinternal) then
    raise exception 'No existe el trigger agente_conversaciones_set_updated_at: estado inesperado, no se toca nada.';
  end if;
  if has_column_privilege('authenticated', 'public.agente_conversaciones', 'updated_at', 'UPDATE') then
    raise exception 'authenticated puede cambiar updated_at: estado inesperado, no se toca nada.';
  end if;

  drop trigger agente_conversaciones_set_updated_at on public.agente_conversaciones;
  comment on column public.agente_conversaciones.updated_at is
    'Última actividad (último mensaje). La mueve solo agente_mensaje_toca_conversacion; archivar o renombrar no la cambia. La retención (agente_retencion) cuenta desde aquí.';

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261113140000', null, 'agente: archivar sin alargar la retención (crm/supabase-agente-archivar.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 2C (verificación, solo lectura) — Lo esperado:
--   trigger set_updated_at en agente_conversaciones: 0
--   trigger de mensajes (toca conversación): 1
--   UPDATE de authenticated en titulo/archivada: true/true
--   UPDATE de authenticated en updated_at: false
--   políticas agente_conversaciones: 3
--   migración registrada: 20261113140000 agente: archivar sin alargar la retención (…)
-- ============================================================
select 'trigger set_updated_at en agente_conversaciones' as comprobacion, count(*)::text as valor
from pg_trigger where tgrelid = 'public.agente_conversaciones'::regclass
  and tgname = 'agente_conversaciones_set_updated_at' and not tgisinternal
union all
select 'trigger de mensajes (toca conversación)', count(*)::text
from pg_trigger where tgrelid = 'public.agente_mensajes'::regclass
  and tgname = 'agente_mensajes_toca_conversacion' and not tgisinternal
union all
select 'UPDATE de authenticated en titulo/archivada',
       has_column_privilege('authenticated', 'public.agente_conversaciones', 'titulo', 'UPDATE') || '/'
       || has_column_privilege('authenticated', 'public.agente_conversaciones', 'archivada', 'UPDATE')
union all
select 'UPDATE de authenticated en updated_at',
       has_column_privilege('authenticated', 'public.agente_conversaciones', 'updated_at', 'UPDATE')::text
union all
select 'políticas agente_conversaciones', count(*)::text from pg_policies
where schemaname = 'public' and tablename = 'agente_conversaciones'
union all
select 'migración registrada', string_agg(version || ' ' || name, ', ')
from supabase_migrations.schema_migrations where version = '20261113140000';
