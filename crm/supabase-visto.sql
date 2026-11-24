-- ============================================================
-- GUIMAES — Marca "Nuevo" en contactos y empresas
--
-- Columna visto_at (timestamptz) en public.contactos y public.empresas:
--   * null  → "Nuevo": nadie ha abierto todavía su ficha.
--   * fecha → la primera vez que alguien del equipo abrió la ficha.
-- Es un estado compartido (no por usuario). Como la columna nace sin valor
-- por defecto, cualquier alta nueva — formulario de la web, Meta, portal,
-- alta manual, lo que sea — entra como "Nuevo" sin tocar ninguno de esos
-- caminos. El CRM la rellena al abrir la ficha con
--   update ... set visto_at = now() where id = ... and visto_at is null
-- (RLS de siempre: is_admin()).
--
-- Los registros que ya existen se marcan como vistos (visto_at = now()).
--
-- Migración 20261124100000. Ejecutar en orden 3A → 3B → 3C con
--   psql -v ON_ERROR_STOP=1. Probada en PGlite (crm/tests/agente).
-- ============================================================


-- ============================================================
-- 3A (comprobación previa, solo lectura) — Lo esperado:
--   columna contactos.visto_at: no
--   columna empresas.visto_at: no
--   migración 20261124100000: no
--   (y los recuentos de filas, para compararlos con 3C)
-- ============================================================
select 'columna contactos.visto_at' as comprobacion,
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                         and table_name = 'contactos' and column_name = 'visto_at') then 'sí' else 'no' end as valor
union all
select 'columna empresas.visto_at',
       case when exists (select 1 from information_schema.columns where table_schema = 'public'
                         and table_name = 'empresas' and column_name = 'visto_at') then 'sí' else 'no' end
union all
select 'migración 20261124100000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261124100000')
            then 'sí' else 'no' end
union all
select 'filas contactos', count(*)::text from public.contactos
union all
select 'filas empresas', count(*)::text from public.empresas;


-- ============================================================
-- 3B (cambio) — un único DO atómico; se niega a ejecutarse dos veces.
-- ============================================================
do $mig$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261124100000') then
    raise exception 'La migración 20261124100000 (visto_at) ya está aplicada.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name in ('contactos', 'empresas') and column_name = 'visto_at') then
    raise exception 'Ya existe una columna visto_at en contactos o empresas: estado inesperado, no se toca nada.';
  end if;

  alter table public.contactos add column visto_at timestamptz;
  alter table public.empresas  add column visto_at timestamptz;
  comment on column public.contactos.visto_at is 'Primera vez que alguien del equipo abrió la ficha; null = "Nuevo".';
  comment on column public.empresas.visto_at  is 'Primera vez que alguien del equipo abrió la ficha; null = "Nuevo".';

  -- Lo que ya existe no es nuevo. Se desactivan solo los triggers de
  -- updated_at para no cambiar esa fecha a todos los registros.
  alter table public.contactos disable trigger contactos_set_updated_at;
  alter table public.empresas  disable trigger empresas_set_updated_at;
  update public.contactos set visto_at = now() where visto_at is null;
  update public.empresas  set visto_at = now() where visto_at is null;
  alter table public.contactos enable trigger contactos_set_updated_at;
  alter table public.empresas  enable trigger empresas_set_updated_at;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261124100000', array['contactos.visto_at, empresas.visto_at'], 'visto_at: marca Nuevo (crm/supabase-visto.sql)');
end
$mig$;

notify pgrst, 'reload schema';


-- ============================================================
-- 3C (verificación, solo lectura) — Lo esperado:
--   columnas visto_at (contactos/empresas): sí/sí
--   contactos sin ver: 0          empresas sin ver: 0
--   filas contactos / empresas: las mismas que en 3A
--   triggers de updated_at activos: 2
--   migración registrada: 20261124100000 ...
-- ============================================================
select 'columnas visto_at (contactos/empresas)' as comprobacion,
       (case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'contactos' and column_name = 'visto_at') then 'sí' else 'no' end) || '/' ||
       (case when exists (select 1 from information_schema.columns where table_schema = 'public'
                          and table_name = 'empresas' and column_name = 'visto_at') then 'sí' else 'no' end) as valor
union all
select 'contactos sin ver', count(*)::text from public.contactos where visto_at is null
union all
select 'empresas sin ver', count(*)::text from public.empresas where visto_at is null
union all
select 'filas contactos', count(*)::text from public.contactos
union all
select 'filas empresas', count(*)::text from public.empresas
union all
select 'triggers de updated_at activos', count(*)::text from pg_trigger
where tgname in ('contactos_set_updated_at', 'empresas_set_updated_at') and tgenabled = 'O'
union all
select 'migración registrada', version || ' ' || name
from supabase_migrations.schema_migrations where version = '20261124100000';
