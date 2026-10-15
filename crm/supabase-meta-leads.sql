-- ============================================================
-- GUIMAES — Leads de Meta (Lead Ads) en public.leads
--
-- Los leads de los formularios de Meta entran por el mismo camino que los
-- de la web: una fila en public.leads → trigger on_new_lead (email + push
-- vía notify-new-lead) → el CRM la convierte en contacto + deal
-- (loadWebLeads/convertLeadToContact en crm/data.js). Los inserta la Edge
-- Function meta-leads (crm/supabase-functions/meta-leads) con la service
-- role. Este fichero añade lo que ese camino necesita:
--
--   1. leads.meta_leadgen_id — id del lead en Meta, ÚNICO: si Meta reenvía
--      el webhook (o se repite la importación) el segundo insert choca y no
--      se duplica nada. Índice no parcial para poder usar ON CONFLICT
--      (los leads de la web lo tienen NULL, y los NULL no chocan entre sí).
--   2. leads.meta_origen (jsonb) — página, formulario, campaña, conjunto y
--      anuncio (ids y nombres, lo que dé la API) y fecha en Meta.
--   3. leads.respuestas (jsonb) — el resto de preguntas del formulario,
--      [{campo, pregunta, respuesta}] en el orden del formulario.
--   4. leads.contact_id — el contacto al que corresponde el lead: el que
--      se creó al convertirlo o, si el email/teléfono ya existía, el
--      contacto existente (status 'linked', sin crear otro). Se rellena
--      para los ya convertidos a partir de contactos.lead_id.
--   5. leads.aviso — false en la importación de leads antiguos: no manda
--      un email y un push por cada uno (la función manda un único push de
--      resumen). El trigger pasa a ser "when (new.aviso)".
--   6. La política de inserción de la web impide rellenar 1–5 desde anon:
--      si no, cualquiera podría insertar un meta_leadgen_id inventado y el
--      lead real se descartaría como duplicado.
--   7. find_contact_by_email(): contacto por email sin distinguir
--      mayúsculas ni espacios (el más antiguo si hay varios). Igual que
--      find_contact_by_phone_last9 (crm/supabase-whatsapp-match.sql), que
--      la función usa para el teléfono.
--
-- Requiere supabase-leads.sql, supabase-leads-dedupe.sql,
-- supabase-contactos.sql y supabase-whatsapp-match.sql ya ejecutados, y el
-- trigger de crm/supabase-lead-trigger.sql en producción.
--
-- Un único bloque DO (atómico; se niega a ejecutarse dos veces) seguido de
-- su verificación (solo lectura). Ejecutar en Supabase → SQL Editor.
-- ============================================================

do $m$
declare
  p record;
  v_triggers text;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'leads' and column_name = 'meta_leadgen_id') then
    raise exception 'leads.meta_leadgen_id ya existe: este fichero ya está aplicado. No se ha cambiado nada.';
  end if;

  -- El trigger se recrea con su condición: antes de tocarlo, comprobar que
  -- el que hay es exactamente el que está versionado. Si hubiera otro, al
  -- recrear solo on_new_lead quedarían dos avisos por lead.
  select string_agg(tgname || ' → ' || tgfoid::regproc::text, ', ' order by tgname)
    into v_triggers
    from pg_trigger
   where tgrelid = 'public.leads'::regclass and not tgisinternal;
  if v_triggers is distinct from 'on_new_lead → handle_new_lead' then
    raise exception 'Triggers en public.leads distintos de lo esperado (on_new_lead → handle_new_lead): %. No se ha cambiado nada.', coalesce(v_triggers, 'ninguno');
  end if;

  -- 1–5) Columnas
  alter table public.leads add column meta_leadgen_id text;
  alter table public.leads add column meta_origen jsonb;
  alter table public.leads add column respuestas jsonb;
  alter table public.leads add column contact_id uuid
    references public.contactos(id) on delete set null;
  alter table public.leads add column aviso boolean not null default true;

  create unique index leads_meta_leadgen_id_key on public.leads (meta_leadgen_id);
  create index leads_contact_id_idx on public.leads (contact_id);

  update public.leads l
     set contact_id = c.id
    from public.contactos c
   where c.lead_id = l.id and l.contact_id is null;

  -- 5) Trigger de aviso solo para los leads que lo piden. La función
  --    handle_new_lead (con sus secretos) no se toca.
  drop trigger on_new_lead on public.leads;
  create trigger on_new_lead after insert on public.leads
    for each row when (new.aviso) execute function public.handle_new_lead();

  -- 6) Inserción pública: cualquier política de INSERT que haya (la de
  --    supabase-leads.sql o una creada a mano) se sustituye por esta.
  for p in select policyname from pg_policies
            where schemaname = 'public' and tablename = 'leads' and cmd = 'INSERT'
  loop
    execute format('drop policy %I on public.leads', p.policyname);
  end loop;
  create policy "web puede insertar leads"
    on public.leads for insert to anon, authenticated
    with check (meta_leadgen_id is null and meta_origen is null and respuestas is null
                and contact_id is null and aviso);

  -- 7) Búsqueda por email
  create index if not exists contactos_email_norm_idx
    on public.contactos (lower(btrim(email)));
end
$m$;

create or replace function public.find_contact_by_email(raw_email text)
returns uuid
language sql stable as $$
  select id from public.contactos
  where btrim(coalesce(raw_email, '')) <> ''
    and lower(btrim(email)) = lower(btrim(raw_email))
  order by created_at
  limit 1
$$;


-- ============================================================
-- Verificación (solo lectura). Lo esperado:
--   columnas: las 5, aviso con default true y not null
--   índice único leads_meta_leadgen_id_key
--   trigger: "... WHEN (new.aviso) EXECUTE FUNCTION handle_new_lead()"
--   política de INSERT: una sola, con el with check de arriba
--   leads convertidos sin contact_id: 0
-- ============================================================
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'leads'
  and column_name in ('meta_leadgen_id','meta_origen','respuestas','contact_id','aviso')
order by column_name;

select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'leads' and indexname like 'leads_%';

select tgname, pg_get_triggerdef(oid) from pg_trigger
where tgrelid = 'public.leads'::regclass and not tgisinternal;

select policyname, cmd, roles, with_check from pg_policies
where schemaname = 'public' and tablename = 'leads' order by cmd, policyname;

select count(*) as "leads convertidos sin contact_id"
from public.leads l join public.contactos c on c.lead_id = l.id
where l.contact_id is null;
