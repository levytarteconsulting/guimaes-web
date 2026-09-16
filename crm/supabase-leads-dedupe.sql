-- ============================================================
-- GUIMAES — Protección real contra doble conversión de leads +
-- registro persistente de fallos.
--
-- Contexto: un lead del 15/09 quedó en leads.status='converted' sin
-- contacto ni deal — crm/data.js marcaba el lead como convertido ANTES de
-- crear el contacto, así que cualquier fallo entre medias lo dejaba
-- invisible para siempre. El código ya se cambió (crm/data.js:
-- convertLeadToContact/loadWebLeads) para crear el contacto primero y
-- marcar 'converted' solo si eso tuvo éxito — este fichero es el SQL que
-- ese cambio necesita para funcionar:
--   1) el índice único que de verdad impide duplicar un contacto por lead
--      (no depende del orden de las operaciones ni de leads.status, así
--      que sigue protegiendo aunque dos sesiones lean el mismo lead a la
--      vez, o alguien recargue a mitad de una conversión que ya tuvo éxito).
--   2) la columna donde queda constancia de un fallo, para que sobreviva
--      aunque nadie tuviera la consola abierta en ese momento.
--
-- Requiere que supabase-contactos.sql y supabase-leads.sql ya se hayan
-- ejecutado. Ejecutar UNA vez en el SQL Editor. Idempotente.
-- ============================================================

-- ---- 1) contactos.lead_id + índice único parcial ----
-- Si tu proyecto ya tiene esta columna creada a mano (el código ya la usa
-- desde hace tiempo), esto no hace nada — es solo para que quede
-- documentada en el repo, que es donde faltaba.
alter table public.contactos add column if not exists lead_id uuid;

alter table public.contactos drop constraint if exists contactos_lead_id_fkey;
alter table public.contactos add constraint contactos_lead_id_fkey
  foreign key (lead_id) references public.leads(id) on delete set null;

-- Parcial (where lead_id is not null): permite muchos contactos con
-- lead_id NULL (altas manuales, la mayoría), pero como mucho UNO por cada
-- lead real — es la pieza que hace innecesario (y peligroso) marcar
-- 'converted' antes de crear el contacto: ahora el propio INSERT rechaza
-- el segundo intento (código de error 23505), lo capture quien lo capture.
create unique index if not exists contactos_lead_id_key
  on public.contactos (lead_id) where lead_id is not null;

-- ---- 2) leads.error_message ----
-- Se pone cuando loadWebLeads no consigue convertir un lead (ver
-- crm/data.js) y se limpia (a NULL) en cuanto la conversión tiene éxito —
-- así "error_message is not null" es siempre "esto necesita que alguien
-- lo mire", sin tener que interpretar status para saberlo.
alter table public.leads add column if not exists error_message text;
