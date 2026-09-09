-- Ejecutar en Supabase → SQL Editor. No modifica nada, solo lee catálogos.
-- Te da dos resultados: el DDL del/los trigger(s) sobre public.leads, y el
-- cuerpo completo de la función que cada uno invoca (sea cual sea su nombre
-- real — no lo doy por supuesto).

-- 1) Trigger(s) definidos sobre public.leads
select
  tgname as trigger_name,
  pg_get_triggerdef(oid) as trigger_definition
from pg_trigger
where tgrelid = 'public.leads'::regclass
  and not tgisinternal;

-- 2) Cuerpo de la(s) función(es) que disparan esos triggers
select distinct
  tgfoid::regproc::text as function_name,
  pg_get_functiondef(tgfoid) as function_definition
from pg_trigger
where tgrelid = 'public.leads'::regclass
  and not tgisinternal;
