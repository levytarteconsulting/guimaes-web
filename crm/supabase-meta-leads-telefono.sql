-- ============================================================
-- GUIMAES — Leads de Meta: teléfono que llegó como pregunta personalizada
--
-- Hasta ahora meta-leads solo tomaba el teléfono de phone_number (y unas
-- pocas claves fijas). En formularios con la pregunta personalizada
-- «Número de teléfono» el teléfono quedaba solo en leads.respuestas y el
-- contacto se quedaba sin phone. La función ya lo reconoce (leads.ts); esto
-- rellena lo que ya había entrado:
--   * contactos con phone vacío y source = 'Meta Lead Ads' cuyo lead (por
--     leads.contact_id o contactos.lead_id) tenga un teléfono válido en
--     respuestas → phone;
--   * leads de Meta con telefono vacío y teléfono válido en respuestas →
--     telefono (para que una conversión posterior lo lleve al contacto).
-- La regla es la de normPhone() en crm/supabase-functions/meta-leads/leads.ts:
-- clave (campo o pregunta, en minúsculas, sin tildes ni símbolos) que
-- contenga telefono, phone, movil o celular; valor sin espacios ni símbolos,
-- 00 → +; +8–15 cifras, o 9 cifras españolas (6/7/8/9) o 34 + 9 → +34…;
-- el primero válido en el orden del formulario.
-- No cambia el esquema. Ningún trigger de UPDATE de contactos o leads avisa
-- a nadie (on_new_lead es solo de INSERT).
--
-- Orden: A → copia (pg_dump) → B → C.
-- ============================================================


-- ============================================================
-- A (solo lectura) — recuentos de afectados.
-- ============================================================
with tel as (
  select distinct on (lead_id) lead_id,
         case when d ~ '^\+[0-9]{8,15}$' then d
              when d ~ '^[6789][0-9]{8}$' then '+34' || d
              else '+' || d end as telefono
  from (
    select l.id as lead_id, r.ord,
           regexp_replace(translate(lower(coalesce(r.v->>'campo', '') || ' ' || coalesce(r.v->>'pregunta', '')),
                                    'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'), '[^a-z0-9]+', '_', 'g') as clave,
           regexp_replace(regexp_replace(coalesce(r.v->>'respuesta', ''), '[[:space:]().\/-]', '', 'g'), '^00', '+') as d
    from public.leads l
    cross join lateral jsonb_array_elements(case when jsonb_typeof(l.respuestas) = 'array' then l.respuestas else '[]'::jsonb end)
         with ordinality r(v, ord)
    where l.source = 'Meta Lead Ads'
  ) x
  where clave ~ '(telefono|phone|movil|celular)'
    and (d ~ '^\+[0-9]{8,15}$' or d ~ '^[6789][0-9]{8}$' or d ~ '^34[6789][0-9]{8}$')
  order by lead_id, ord
)
select 'contactos Meta con phone vacío' as comprobacion,
       count(*)::text as valor
from public.contactos c
where c.source = 'Meta Lead Ads' and coalesce(btrim(c.phone), '') = ''
union all
select 'contactos a rellenar',
       count(*)::text
from public.contactos c
where c.source = 'Meta Lead Ads' and coalesce(btrim(c.phone), '') = ''
  and exists (select 1 from public.leads l join tel t on t.lead_id = l.id
              where l.contact_id = c.id or c.lead_id = l.id)
union all
select 'leads Meta con telefono vacío', count(*)::text
from public.leads l where l.source = 'Meta Lead Ads' and coalesce(btrim(l.telefono), '') = ''
union all
select 'leads a rellenar', count(*)::text
from public.leads l join tel t on t.lead_id = l.id
where coalesce(btrim(l.telefono), '') = ''
union all
select 'migración 20261112180000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261112180000') then 'sí' else 'no' end;


-- ============================================================
-- B (CAMBIO) — Un único DO; se niega a ejecutarse dos veces.
-- ============================================================
do $b$
declare
  v_c int; v_l int;
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261112180000') then
    raise exception 'La migración 20261112180000 ya está registrada: B ya está aplicado. No se ha cambiado nada.';
  end if;

  create temp table meta_tel on commit drop as
  select distinct on (lead_id) lead_id,
         case when d ~ '^\+[0-9]{8,15}$' then d
              when d ~ '^[6789][0-9]{8}$' then '+34' || d
              else '+' || d end as telefono
  from (
    select l.id as lead_id, r.ord,
           regexp_replace(translate(lower(coalesce(r.v->>'campo', '') || ' ' || coalesce(r.v->>'pregunta', '')),
                                    'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'), '[^a-z0-9]+', '_', 'g') as clave,
           regexp_replace(regexp_replace(coalesce(r.v->>'respuesta', ''), '[[:space:]().\/-]', '', 'g'), '^00', '+') as d
    from public.leads l
    cross join lateral jsonb_array_elements(case when jsonb_typeof(l.respuestas) = 'array' then l.respuestas else '[]'::jsonb end)
         with ordinality r(v, ord)
    where l.source = 'Meta Lead Ads'
  ) x
  where clave ~ '(telefono|phone|movil|celular)'
    and (d ~ '^\+[0-9]{8,15}$' or d ~ '^[6789][0-9]{8}$' or d ~ '^34[6789][0-9]{8}$')
  order by lead_id, ord;

  -- Contactos: el teléfono del lead más antiguo que lo tenga.
  update public.contactos c
     set phone = s.telefono
    from (
      select distinct on (c2.id) c2.id, t.telefono
      from public.contactos c2
      join public.leads l on l.contact_id = c2.id or c2.lead_id = l.id
      join meta_tel t on t.lead_id = l.id
      where c2.source = 'Meta Lead Ads' and coalesce(btrim(c2.phone), '') = ''
      order by c2.id, l.created_at, l.id
    ) s
   where c.id = s.id;
  get diagnostics v_c = row_count;

  update public.leads l
     set telefono = t.telefono
    from meta_tel t
   where t.lead_id = l.id and coalesce(btrim(l.telefono), '') = '';
  get diagnostics v_l = row_count;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261112180000', null, 'meta leads teléfono desde respuestas (crm/supabase-meta-leads-telefono.sql)');
  raise notice 'Rellenados: % contacto(s), % lead(s)', v_c, v_l;
end
$b$;

notify pgrst, 'reload schema';


-- ============================================================
-- C (verificación, solo lectura) — Lo esperado:
--   contactos Meta con phone vacío y teléfono en el formulario: 0
--   leads Meta con telefono vacío y teléfono en el formulario: 0
--   migración registrada: 20261112180000
-- ============================================================
with tel as (
  select distinct lead_id
  from (
    select l.id as lead_id,
           regexp_replace(translate(lower(coalesce(r.v->>'campo', '') || ' ' || coalesce(r.v->>'pregunta', '')),
                                    'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'), '[^a-z0-9]+', '_', 'g') as clave,
           regexp_replace(regexp_replace(coalesce(r.v->>'respuesta', ''), '[[:space:]().\/-]', '', 'g'), '^00', '+') as d
    from public.leads l
    cross join lateral jsonb_array_elements(case when jsonb_typeof(l.respuestas) = 'array' then l.respuestas else '[]'::jsonb end) r(v)
    where l.source = 'Meta Lead Ads'
  ) x
  where clave ~ '(telefono|phone|movil|celular)'
    and (d ~ '^\+[0-9]{8,15}$' or d ~ '^[6789][0-9]{8}$' or d ~ '^34[6789][0-9]{8}$')
)
select 'contactos Meta con phone vacío y teléfono en el formulario' as comprobacion, count(*)::text as valor
from public.contactos c
where c.source = 'Meta Lead Ads' and coalesce(btrim(c.phone), '') = ''
  and exists (select 1 from public.leads l join tel t on t.lead_id = l.id where l.contact_id = c.id or c.lead_id = l.id)
union all
select 'leads Meta con telefono vacío y teléfono en el formulario', count(*)::text
from public.leads l join tel t on t.lead_id = l.id
where coalesce(btrim(l.telefono), '') = ''
union all
select 'contactos Meta con phone en formato +', count(*)::text
from public.contactos c where c.source = 'Meta Lead Ads' and c.phone ~ '^\+[0-9]{8,15}$'
union all
select 'migración registrada', coalesce(string_agg(version || ' ' || name, ', '), '(ninguna)')
from supabase_migrations.schema_migrations where version = '20261112180000';
