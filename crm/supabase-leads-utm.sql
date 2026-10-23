-- ============================================================
-- GUIMAES — UTM y gclid en public.leads
--
-- La landing de Google Ads (gestoria-pozuelo.html) guarda en cada lead los
-- parámetros de campaña con los que llegó la visita: utm_source,
-- utm_medium, utm_campaign, utm_term, utm_content y gclid. Columnas de
-- texto, opcionales (los leads de la web sin campaña y los de Meta las
-- dejan en NULL), con un tope de 500 caracteres para que la inserción
-- pública no admita textos arbitrariamente largos.
--
-- La política de INSERT de la web (crm/supabase-meta-leads.sql) no se
-- toca: no menciona estas columnas, así que anon puede rellenarlas.
--
-- Requiere supabase-leads.sql y supabase-meta-leads.sql ya ejecutados.
-- Tres bloques: A (comprobación, solo lectura), B (cambio, atómico; se
-- niega a ejecutarse dos veces) y C (verificación, solo lectura).
-- ============================================================

-- ---- A) Comprobación (solo lectura). Lo esperado:
--   columnas utm_*/gclid: ninguna
--   anon con INSERT en public.leads: true
--   políticas de INSERT: una, "web puede insertar leads"
select count(*) as "columnas utm/gclid ya existentes"
from information_schema.columns
where table_schema = 'public' and table_name = 'leads'
  and column_name in ('utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid');

select has_table_privilege('anon', 'public.leads', 'INSERT') as "anon puede insertar";

select policyname, cmd, roles from pg_policies
where schemaname = 'public' and tablename = 'leads' and cmd = 'INSERT';
-- ---- fin A

-- ---- B) Cambio
do $m$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'leads'
               and column_name in ('utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid')) then
    raise exception 'leads ya tiene columnas utm/gclid: este fichero ya está aplicado. No se ha cambiado nada.';
  end if;

  alter table public.leads
    add column utm_source   text constraint leads_utm_source_len   check (char_length(utm_source)   <= 500),
    add column utm_medium   text constraint leads_utm_medium_len   check (char_length(utm_medium)   <= 500),
    add column utm_campaign text constraint leads_utm_campaign_len check (char_length(utm_campaign) <= 500),
    add column utm_term     text constraint leads_utm_term_len     check (char_length(utm_term)     <= 500),
    add column utm_content  text constraint leads_utm_content_len  check (char_length(utm_content)  <= 500),
    add column gclid        text constraint leads_gclid_len        check (char_length(gclid)        <= 500);
end
$m$;
-- ---- fin B

-- ---- C) Verificación (solo lectura). Lo esperado:
--   las 6 columnas, text, nullable, sin default
--   las 6 restricciones leads_*_len
--   anon con INSERT en las 6 columnas: true en todas
select column_name, data_type, column_default, is_nullable,
       has_column_privilege('anon', 'public.leads', column_name, 'INSERT') as anon_insert
from information_schema.columns
where table_schema = 'public' and table_name = 'leads'
  and column_name in ('utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid')
order by column_name;

select conname from pg_constraint
where conrelid = 'public.leads'::regclass and conname like 'leads\_%\_len' escape '\'
order by conname;
-- ---- fin C
