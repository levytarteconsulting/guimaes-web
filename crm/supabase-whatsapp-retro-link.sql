-- ============================================================
-- GUIMAES — Vinculación retroactiva de conversaciones de WhatsApp que
-- quedaron con contact_id NULL antes de este cambio.
--
-- Requiere haber ejecutado antes crm/supabase-whatsapp-match.sql (usa
-- public.find_contact_by_phone_last9). Aplica la misma regla que ahora usa
-- el webhook: si hay EXACTAMENTE un contacto cuyo teléfono coincide en los
-- últimos 9 dígitos con el wa_id de la conversación, se vincula; si hay 0
-- o varias coincidencias, se deja tal cual (no se adivina).
--
-- Ejecutar en dos pasos, cada uno a mano en el SQL Editor de Supabase:
--   1) los dos SELECT de comprobación — no escriben nada, solo dicen qué
--      pasaría y cuántas filas se verían afectadas.
--   2) si el resultado tiene sentido, el UPDATE final.
-- ============================================================

-- ---- 1a) Detalle: qué conversación se vincularía a qué contacto ----
select
  wc.id as conversation_id,
  wc.wa_id,
  wc.phone as conversation_phone,
  public.find_contact_by_phone_last9(wc.wa_id) as contact_id_propuesto,
  c.company,
  c.full_name,
  c.phone as contact_phone
from public.whatsapp_conversations wc
left join public.contactos c on c.id = public.find_contact_by_phone_last9(wc.wa_id)
where wc.contact_id is null
order by wc.created_at;

-- ---- 1b) Recuento: cuántas se vincularían de verdad (match único) ----
select count(*) as conversaciones_a_vincular
from public.whatsapp_conversations wc
where wc.contact_id is null
  and public.find_contact_by_phone_last9(wc.wa_id) is not null;

-- ---- 2) Update — ejecutar solo después de revisar los SELECT de arriba ----
update public.whatsapp_conversations wc
set contact_id = public.find_contact_by_phone_last9(wc.wa_id)
where wc.contact_id is null
  and public.find_contact_by_phone_last9(wc.wa_id) is not null;
