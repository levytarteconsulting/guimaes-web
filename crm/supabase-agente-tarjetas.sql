-- ============================================================
-- GUIMAES — Agente de IA: tarjetas de aprobación en el chat
--
-- Las propuestas de Holded del asistente (holded_proponer_accion y
-- holded_proponer_operacion) se aprueban o rechazan ahora también desde una
-- tarjeta en el chat, con las mismas reglas que la pantalla Acciones (las
-- aplica holded_acciones_aprobar: solo rol admin, el número si son más de
-- 100, CONFIRMAR si el riesgo es alto). Para volver a pintar cada tarjeta en
-- su sitio al reabrir una conversación, la llamada a la herramienta guarda
-- el id de lo que creó (propuesta del CRM, correo o acción de Holded).
--
-- Qué cambia: agente_tool_calls.tarjeta_id (uuid, opcional) y su permiso de
-- inserción por columna para authenticated. Nada más.
-- Requiere: crm/supabase-agente.sql. Patrón: 12A → 12B (un DO que se niega a
-- repetirse) → 12C. Probado en PGlite: crm/tests/agente/agente-correo.test.mjs.
-- ============================================================


-- ============================================================
-- 12A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261128140000: sí     migración 20261128180000: no
--   columna tarjeta_id: 0
-- ============================================================
select 'migración 20261128140000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128140000') then 'sí' else 'no' end as valor
union all select 'migración 20261128180000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128180000') then 'sí' else 'no' end
union all select 'columna tarjeta_id',
       (select count(*)::text from information_schema.columns
         where table_schema = 'public' and table_name = 'agente_tool_calls' and column_name = 'tarjeta_id');


-- ============================================================
-- 12B (cambio, atómico, se niega a repetirse)
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261128180000')
     or exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'agente_tool_calls' and column_name = 'tarjeta_id') then
    raise exception 'La migración 20261128180000 ya está aplicada. No se ha cambiado nada.';
  end if;
  if to_regclass('public.agente_tool_calls') is null then
    raise exception 'Falta crm/supabase-agente.sql. No se ha cambiado nada.';
  end if;

  alter table public.agente_tool_calls add column tarjeta_id uuid;
  create index agente_tool_calls_tarjeta_idx on public.agente_tool_calls (conversacion_id, created_at) where tarjeta_id is not null;
  grant insert (tarjeta_id) on public.agente_tool_calls to authenticated;

  insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261128180000', 'Agente: tarjetas de aprobación en el chat (crm/supabase-agente-tarjetas.sql)', array[]::text[]);
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 12C (verificación, solo lectura) — Lo esperado:
--   columna tarjeta_id: uuid      authenticated insert/update(tarjeta_id): true/false
--   migración registrada: 20261128180000 …
-- ============================================================
select 'columna tarjeta_id' as comprobacion,
       (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'agente_tool_calls' and column_name = 'tarjeta_id') as valor
union all select 'authenticated insert/update(tarjeta_id)',
       has_column_privilege('authenticated', 'public.agente_tool_calls', 'tarjeta_id', 'insert')::text || '/' ||
       has_column_privilege('authenticated', 'public.agente_tool_calls', 'tarjeta_id', 'update')::text
union all select 'migración registrada',
       (select version || ' ' || name from supabase_migrations.schema_migrations where version = '20261128180000');
