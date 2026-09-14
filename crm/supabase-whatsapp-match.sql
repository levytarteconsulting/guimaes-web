-- ============================================================
-- GUIMAES — Matching de teléfono entre contactos y WhatsApp (últimos 9
-- dígitos). Requiere que supabase-contactos.sql y supabase-whatsapp.sql ya
-- se hayan ejecutado antes.
--
-- Por qué esto vive en Postgres y no en el código (TypeScript del webhook
-- o JS del frontend): son dos runtimes que no comparten build ni imports
-- entre sí (cada Edge Function de este proyecto es autocontenida a
-- propósito — ver comentario en whatsapp-webhook/index.ts — y el frontend
-- se empaqueta aparte con Vite). Postgres es el único sitio que los dos
-- pueden llamar sin duplicar la lógica: el webhook via una query normal
-- (ya habla con esta misma base de datos) y el frontend via
-- `client.rpc('find_contact_by_phone_last9', {...})` si algún día hace
-- falta ahí. Así, además, la función de comparación y el índice que la
-- acelera son exactamente la misma expresión — no hay riesgo de que el
-- índice quede desincronizado de cómo compara la aplicación.
--
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run. Idempotente.
-- ============================================================

-- ---- Normalización: últimos 9 dígitos de cualquier formato ----
-- "+34 600 11 22 33", "0034600112233", "600112233", "600-11-22-33" → "600112233".
-- Sin al menos 9 dígitos no se puede comparar con fiabilidad: NULL (y NULL
-- nunca es igual a NULL en una comparación, así que dos teléfonos vacíos o
-- inválidos jamás "coinciden" por accidente).
create or replace function public.phone_last9(raw text)
returns text
language sql immutable as $$
  select case
    when length(regexp_replace(coalesce(raw, ''), '\D', '', 'g')) >= 9
    then right(regexp_replace(raw, '\D', '', 'g'), 9)
    else null
  end;
$$;

-- Índice funcional — ver nota de rendimiento más abajo sobre si hace falta
-- con el volumen actual. Crearlo no tiene coste real aunque no se necesite
-- todavía: la tabla de contactos de un despacho como este es pequeña y esto
-- también acelera el propio script de vinculación retroactiva.
create index if not exists contactos_phone_last9_idx on public.contactos (public.phone_last9(phone));

-- ---- Busca el contacto por coincidencia de los últimos 9 dígitos ----
-- Devuelve el id SOLO si hay exactamente una coincidencia; NULL si hay
-- cero o varias — nunca "adivina". raw_phone puede venir en cualquier
-- formato (se normaliza igual que phone en contactos), así que sirve tanto
-- para un wa_id de Meta (dígitos puros) como para cualquier otro texto.
-- Postgres no tiene min()/max() para uuid, así que en vez de agregar sobre
-- id se limita la subquery a 2 filas: con count(*)=1 solo puede haber
-- salido una, y (array_agg(id))[1] la saca sin agregados sobre uuid.
-- Con 0 o 2 (=2 o más coincidencias reales) el CASE cae en NULL.
create or replace function public.find_contact_by_phone_last9(raw_phone text)
returns uuid
language sql stable as $$
  select case when count(*) = 1 then (array_agg(id))[1] end
  from (
    select id from public.contactos
    where public.phone_last9(phone) = public.phone_last9(raw_phone)
    limit 2
  ) matches
$$;

-- ============================================================
-- ¿Merece la pena el índice con el volumen actual?
-- No tengo acceso a tu base de datos para medirlo desde aquí — compruébalo
-- tú con:
--   select count(*) from public.contactos;
-- Pero el razonamiento no depende mucho del resultado: find_contact_by_
-- phone_last9 solo se ejecuta UNA vez por cada conversación de WhatsApp
-- NUEVA (la primera vez que escribe un número que nunca había escrito),
-- no por cada mensaje — para un despacho de este tamaño eso es como mucho
-- unas pocas veces al día. Un seq scan sobre una tabla de contactos de
-- cientos o pocos miles de filas tarda microsegundos igualmente; el índice
-- no es necesario para que esto vaya rápido HOY. Lo creo de todas formas
-- porque es prácticamente gratis (tabla pequeña, CREATE INDEX instantáneo)
-- y también acelera el UPDATE del script de vinculación retroactiva
-- (crm/supabase-whatsapp-retro-link.sql), que si compara fila a fila sin
-- índice sobre todos los contactos existentes sí nota la diferencia si el
-- despacho ya tiene miles de fichas.
-- ============================================================
