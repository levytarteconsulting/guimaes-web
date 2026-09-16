-- ============================================================
-- GUIMAES — Fase 4: migración de contactos.company → empresas
--
-- Crea una empresa por cada valor distinto de contactos.company (vacío o
-- NULL se trata como "Por definir", igual que el resto de la app) y
-- enlaza cada contacto a la suya como principal. La normalización
-- (minúsculas + espacios colapsados) es solo para AGRUPAR sin duplicar
-- por "Empresa SL" vs " empresa sl" — el texto que se guarda en
-- razon_social es el original tal cual (el más repetido del grupo, si
-- hay varias variantes de mayúsculas/espacios para el mismo contacto).
--
-- Requiere que supabase-empresas.sql ya se haya ejecutado.
--
-- SIN TABLAS TEMPORALES A PROPÓSITO: el SQL Editor de Supabase va detrás
-- de un pooler en modo transacción, así que dos sentencias de la misma
-- ejecución pueden acabar en conexiones de servidor distintas — una
-- tabla temporal creada en la primera sentencia puede no existir ya para
-- la segunda. Cada sentencia de abajo recalcula su propia agrupación
-- desde contactos/empresas en vez de depender de nada creado por otra.
--
-- DOS BLOQUES SEPARADOS a propósito:
--   BLOQUE A: solo lectura. Ejecútalo y revisa el resultado.
--   BLOQUE B: la migración real (dos sentencias INSERT independientes).
--             Ejecútalo solo después de revisar A.
-- Es seguro volver a ejecutar el archivo entero por error: el BLOQUE B
-- ignora los contactos que ya tengan alguna empresa enlazada y las
-- empresas cuyo nombre normalizado ya exista, así que un segundo pase no
-- duplica nada.
-- ============================================================

-- ============================================================
-- BLOQUE A — Revisión (no escribe nada)
-- ============================================================
with base as (
  select
    id as contact_id,
    trim(coalesce(company, '')) as company_raw
  from public.contactos
  where id not in (select contact_id from public.contacto_empresa)
),
normalized as (
  select
    contact_id,
    case when company_raw = '' then 'Por definir' else company_raw end as company_final
  from base
),
grouped as (
  select
    lower(regexp_replace(company_final, '\s+', ' ', 'g')) as norm_key,
    company_final,
    contact_id
  from normalized
)
select
  norm_key,
  mode() within group (order by company_final) as razon_social_a_crear,
  count(*) as num_contactos,
  array_agg(distinct company_final) as variantes_originales,
  array_agg(contact_id) as contact_ids
from grouped
group by norm_key
order by num_contactos desc;

-- ============================================================
-- BLOQUE B — Migración real (ejecutar tras revisar el BLOQUE A)
-- ============================================================

-- 1) Crear las empresas que falten. "not exists" contra el nombre ya
-- normalizado protege tanto de una segunda ejecución de este script como
-- de empresas que alguien ya hubiera creado a mano desde la nueva UI con
-- el mismo nombre.
with base as (
  select
    id as contact_id,
    trim(coalesce(company, '')) as company_raw
  from public.contactos
  where id not in (select contact_id from public.contacto_empresa)
),
normalized as (
  select
    contact_id,
    case when company_raw = '' then 'Por definir' else company_raw end as company_final
  from base
),
grouped as (
  select
    lower(regexp_replace(company_final, '\s+', ' ', 'g')) as norm_key,
    company_final
  from normalized
),
por_crear as (
  select
    norm_key,
    mode() within group (order by company_final) as razon_social
  from grouped
  group by norm_key
)
insert into public.empresas (razon_social)
select p.razon_social
from por_crear p
where not exists (
  select 1 from public.empresas e
  where lower(regexp_replace(trim(e.razon_social), '\s+', ' ', 'g')) = p.norm_key
);

-- 2) Enlazar cada contacto migrado a su empresa (principal = true, es su
-- única empresa en este punto). "distinct on" al mapear norm_key →
-- empresa_id asegura como mucho un enlace por contacto aunque ya
-- existieran dos empresas distintas con el mismo nombre normalizado (si
-- no, el índice único de "como mucho una principal por contacto" podría
-- chocar al intentar marcar dos como principal a la vez). on conflict
-- por si el archivo se ejecuta dos veces sobre el mismo contacto.
with base as (
  select
    id as contact_id,
    trim(coalesce(company, '')) as company_raw
  from public.contactos
  where id not in (select contact_id from public.contacto_empresa)
),
normalized as (
  select
    contact_id,
    case when company_raw = '' then 'Por definir' else company_raw end as company_final
  from base
),
por_contacto as (
  select
    contact_id,
    lower(regexp_replace(company_final, '\s+', ' ', 'g')) as norm_key
  from normalized
),
empresa_por_norm as (
  select distinct on (norm_key)
    lower(regexp_replace(trim(razon_social), '\s+', ' ', 'g')) as norm_key,
    id as empresa_id
  from public.empresas
  order by norm_key, id
)
insert into public.contacto_empresa (contact_id, empresa_id, principal)
select pc.contact_id, en.empresa_id, true
from por_contacto pc
join empresa_por_norm en on en.norm_key = pc.norm_key
on conflict (contact_id, empresa_id) do nothing;

-- ============================================================
-- Comprobar tras ejecutar el BLOQUE B:
--   select count(*) from public.contactos;
--   select count(*) from public.contacto_empresa;   -- debería coincidir
--   select c.full_name, c.company, e.razon_social
--   from public.contactos c
--   join public.contacto_empresa ce on ce.contact_id = c.id
--   join public.empresas e on e.id = ce.empresa_id;
-- ============================================================
