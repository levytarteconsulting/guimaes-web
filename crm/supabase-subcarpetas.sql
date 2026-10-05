-- ============================================================
-- GUIMAES — Migración: subcarpetas (exactamente dos niveles)
--
-- Las carpetas de cada empresa pasan a admitir subcarpetas: una carpeta
-- raíz puede tener hijas; una subcarpeta no. La WhatsApp no admite hijas.
-- Todo lo garantiza la BD (ver punto 1b de crm/supabase-carpetas.sql):
-- una FK compuesta sobre dos columnas generadas, no un trigger.
--
-- Las carpetas actuales pasan TODAS a ser raíz (parent_id nace NULL) y ya
-- cumplen todas las reglas: no se mueve ningún dato. Lo único delicado es
-- cambiar la unicidad de nombre de "por empresa" a "entre hermanas" sin
-- dejar ningún instante sin índice único; por eso va en un único DO, y el
-- índice nuevo se crea antes de quitar el antiguo.
--
-- SIN TABLAS TEMPORALES. El cambio es un único bloque DO (BLOQUE B): una
-- sentencia, una transacción, una conexión del pooler.
--
-- ORDEN — cada paso a mano y por separado en el SQL Editor:
--   1. BLOQUE A (solo lectura). Revísalo.
--   2. BLOQUE B (el DO): el esquema.
--   3. crm/supabase-carpetas.sql entero: las funciones nuevas
--      (carpetas_proteger, borrar_carpeta, mover_carpeta). El resto del
--      fichero ya está aplicado y no cambia nada.
--   4. BLOQUE C (solo lectura). Verificación.
-- Entre el paso 2 y el 3 no se rompe nada: las funciones y el frontend
-- actuales funcionan igual (todas las carpetas siguen siendo raíz).
--
-- Requiere: crm/supabase-documentos-empresa.sql ya aplicado (carpetas por
-- empresa) y Postgres 15 o superior (NULLS NOT DISTINCT).
-- ============================================================

-- ============================================================
-- BLOQUE A — Revisión (no escribe nada)
-- ============================================================

-- A1) Versión de Postgres: hace falta 15 o superior (server_version_num ≥ 150000).
select current_setting('server_version') as version, current_setting('server_version_num')::int as version_num;

-- A2) ¿Ya aplicada? Si sale parent_id, el BLOQUE B no hará nada.
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'carpetas'
  and column_name in ('parent_id','admite_subcarpetas','padre_admite');

-- A3) Carpetas por empresa (todas pasarán a ser raíz) y carpetas de sistema.
select count(*) as carpetas,
       count(distinct empresa_id) as empresas,
       count(*) filter (where system_key = 'whatsapp') as whatsapp
from public.carpetas;

-- A4) Nombres repetidos en la misma empresa. Debe salir vacío (el índice
-- actual ya lo impide); con la regla nueva seguirían siendo hermanas.
select empresa_id, lower(btrim(nombre)) as nombre, count(*)
from public.carpetas
group by 1, 2 having count(*) > 1;

-- ============================================================
-- BLOQUE B — El esquema (un único DO, atómico)
-- ============================================================
do $$
declare
  v_carpetas_antes int;
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'Hace falta Postgres 15 o superior (NULLS NOT DISTINCT); este servidor es %.', current_setting('server_version');
  end if;

  if exists (select 1 from pg_constraint where conname = 'carpetas_padre_fkey') then
    raise notice 'Subcarpetas ya aplicadas: nada que hacer.';
    return;
  end if;

  select count(*) into v_carpetas_antes from public.carpetas;

  -- 1) Columnas. parent_id nace NULL: todas raíz.
  alter table public.carpetas add column if not exists parent_id uuid;
  alter table public.carpetas add column if not exists admite_subcarpetas boolean
    generated always as (parent_id is null and system_key is null) stored;
  alter table public.carpetas add column if not exists padre_admite boolean
    generated always as (case when parent_id is not null then true end) stored;

  -- 2) La carpeta de sistema siempre es raíz.
  alter table public.carpetas drop constraint if exists carpetas_sistema_es_raiz_check;
  alter table public.carpetas add constraint carpetas_sistema_es_raiz_check
    check (system_key is null or parent_id is null);

  -- 3) Dos niveles, misma empresa, nada dentro de WhatsApp: la FK.
  alter table public.carpetas add constraint carpetas_id_empresa_admite_key
    unique (id, empresa_id, admite_subcarpetas);
  alter table public.carpetas add constraint carpetas_padre_fkey
    foreign key (parent_id, empresa_id, padre_admite)
    references public.carpetas (id, empresa_id, admite_subcarpetas);

  -- 4) Nombre único entre hermanas. El nuevo antes de quitar el antiguo.
  create unique index if not exists carpetas_hermanas_nombre_key
    on public.carpetas (empresa_id, parent_id, lower(btrim(nombre))) nulls not distinct;
  drop index if exists public.carpetas_empresa_nombre_key;
  create index if not exists carpetas_parent_idx on public.carpetas (parent_id);

  -- 5) Comprobación final.
  if (select count(*) from public.carpetas) <> v_carpetas_antes then
    raise exception 'El número de carpetas ha cambiado: no se aplica nada.';
  end if;
  if exists (select 1 from public.carpetas where parent_id is not null) then
    raise exception 'Hay carpetas con padre tras la migración: no se aplica nada.';
  end if;

  raise notice 'Subcarpetas aplicadas: % carpetas, todas raíz. Ejecuta ahora crm/supabase-carpetas.sql y después el BLOQUE C.', v_carpetas_antes;
end;
$$;

-- ============================================================
-- BLOQUE C — Verificación (no escribe nada)
-- ============================================================

-- C1) Las tres columnas existen; las dos últimas son generadas ('s' = stored).
select column_name, is_generated, generation_expression
from information_schema.columns
where table_schema = 'public' and table_name = 'carpetas'
  and column_name in ('parent_id','admite_subcarpetas','padre_admite')
order by column_name;

-- C2) Restricciones e índices nuevos presentes; el índice antiguo, fuera.
-- Deben salir carpetas_hermanas_nombre_key, carpetas_id_empresa_admite_key,
-- carpetas_padre_fkey, carpetas_parent_idx y carpetas_sistema_es_raiz_check
-- — y NO carpetas_empresa_nombre_key.
select conname as nombre, 'restricción' as tipo from pg_constraint
where conrelid = 'public.carpetas'::regclass
  and conname in ('carpetas_id_empresa_admite_key','carpetas_padre_fkey','carpetas_sistema_es_raiz_check')
union all
select indexname, 'índice' from pg_indexes
where schemaname = 'public' and tablename = 'carpetas'
  and indexname in ('carpetas_hermanas_nombre_key','carpetas_parent_idx','carpetas_empresa_nombre_key')
order by 1;

-- C3) Todas las carpetas son raíz, y las de sistema no admiten hijas.
select count(*) as carpetas,
       count(*) filter (where parent_id is not null) as subcarpetas,
       count(*) filter (where admite_subcarpetas) as admiten_subcarpetas,
       count(*) filter (where system_key = 'whatsapp' and admite_subcarpetas) as whatsapp_que_admite
from public.carpetas;

-- C4) Funciones nuevas (tras ejecutar crm/supabase-carpetas.sql). Debe salir
-- mover_carpeta, y carpetas_proteger/borrar_carpeta deben mencionar las
-- subcarpetas.
select proname,
       position('subcarpeta' in prosrc) > 0 as conoce_subcarpetas
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('carpetas_proteger','borrar_carpeta','mover_carpeta')
order by proname;
