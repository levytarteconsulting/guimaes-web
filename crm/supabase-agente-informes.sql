-- ============================================================
-- GUIMAES — Agente de IA: informes guardados
--
-- «Guardar informe» en una tarjeta de informe del chat guarda SOLO la
-- petición (el texto que se le pidió al asistente), un título y, si es de
-- una empresa, cuál. Nunca las cifras: al regenerarlo, el asistente vuelve a
-- consultar los datos de ese momento en una conversación nueva.
--
-- Qué crea: agente_informes, con RLS: cada usuario del CRM ve, crea, renombra
-- y borra los suyos; el rol admin, además, ve los de todos.
-- Requiere: crm/supabase-agente.sql. Patrón: 13A → 13B (un DO que se niega a
-- repetirse) → 13C. Probado en PGlite: crm/tests/agente/agente-correo.test.mjs.
-- ============================================================


-- ============================================================
-- 13A (comprobación previa, solo lectura) — Lo esperado:
--   migración 20261128180000: sí     migración 20261128200000: no
--   tabla agente_informes: 0
-- ============================================================
select 'migración 20261128180000' as comprobacion,
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128180000') then 'sí' else 'no' end as valor
union all select 'migración 20261128200000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261128200000') then 'sí' else 'no' end
union all select 'tabla agente_informes',
       (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = 'agente_informes');


-- ============================================================
-- 13B (cambio, atómico, se niega a repetirse)
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261128200000')
     or to_regclass('public.agente_informes') is not null then
    raise exception 'La migración 20261128200000 ya está aplicada. No se ha cambiado nada.';
  end if;
  if to_regclass('public.agente_conversaciones') is null then
    raise exception 'Falta crm/supabase-agente.sql. No se ha cambiado nada.';
  end if;

  create table public.agente_informes (
    id             uuid primary key default gen_random_uuid(),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    auth_user_id   uuid not null default auth.uid(),
    titulo         text not null check (char_length(btrim(titulo)) between 1 and 200),
    peticion       text not null check (char_length(btrim(peticion)) between 1 and 4000),
    empresa_id     uuid references public.empresas(id) on delete set null,
    ultimo_uso_at  timestamptz
  );
  create index agente_informes_usuario_idx on public.agente_informes (auth_user_id, created_at desc);
  create trigger agente_informes_set_updated_at before update on public.agente_informes
    for each row execute function public.set_updated_at();

  alter table public.agente_informes enable row level security;
  create policy "agente: cada usuario lee sus informes; el rol admin, todos" on public.agente_informes
    for select to authenticated
    using ((auth_user_id = (select auth.uid()) and (select public.is_admin())) or (select public.is_admin_role()));
  create policy "agente: cada usuario guarda sus informes" on public.agente_informes
    for insert to authenticated
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()));
  create policy "agente: cada usuario cambia sus informes" on public.agente_informes
    for update to authenticated
    using (auth_user_id = (select auth.uid()) and (select public.is_admin()))
    with check (auth_user_id = (select auth.uid()) and (select public.is_admin()));
  create policy "agente: cada usuario borra sus informes" on public.agente_informes
    for delete to authenticated
    using (auth_user_id = (select auth.uid()) and (select public.is_admin()));
  revoke all on public.agente_informes from anon, authenticated;
  grant select, delete on public.agente_informes to authenticated;
  grant insert (titulo, peticion, empresa_id) on public.agente_informes to authenticated;
  grant update (titulo, ultimo_uso_at) on public.agente_informes to authenticated;
  grant all on public.agente_informes to service_role;

  insert into supabase_migrations.schema_migrations (version, name, statements)
  values ('20261128200000', 'Agente: informes guardados (crm/supabase-agente-informes.sql)', array[]::text[]);
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 13C (verificación, solo lectura) — Lo esperado:
--   RLS: true      políticas: 4
--   authenticated s/d, insert(peticion), update(titulo), update(peticion): true/true/true/true/false
--   filas: 0       migración registrada: 20261128200000 …
-- ============================================================
select 'RLS' as comprobacion,
       (select relrowsecurity::text from pg_class where oid = 'public.agente_informes'::regclass) as valor
union all select 'políticas',
       (select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'agente_informes')
union all select 'authenticated s/d, insert(peticion), update(titulo), update(peticion)',
       has_table_privilege('authenticated', 'public.agente_informes', 'select')::text || '/' ||
       has_table_privilege('authenticated', 'public.agente_informes', 'delete')::text || '/' ||
       has_column_privilege('authenticated', 'public.agente_informes', 'peticion', 'insert')::text || '/' ||
       has_column_privilege('authenticated', 'public.agente_informes', 'titulo', 'update')::text || '/' ||
       has_column_privilege('authenticated', 'public.agente_informes', 'peticion', 'update')::text
union all select 'filas',
       (select count(*)::text from public.agente_informes)
union all select 'migración registrada',
       (select version || ' ' || name from supabase_migrations.schema_migrations where version = '20261128200000');
