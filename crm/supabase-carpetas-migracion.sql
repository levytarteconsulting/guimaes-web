-- ============================================================
-- GUIMAES — Fase 5: migración de documentos a carpetas (Paso A)
--
-- Siembra el juego por defecto en los contactos que aún no tienen ninguna
-- carpeta, crea la carpeta WhatsApp de los contactos que ya tienen
-- adjuntos y asigna folder_id a esos adjuntos.
--
-- Requiere que crm/supabase-carpetas.sql ya se haya ejecutado.
--
-- Filtra por source = 'whatsapp' y no por folder = 'WhatsApp': hoy son lo
-- mismo, pero así la migración no depende de la columna folder (que se
-- borra en el Paso B, donde este BLOQUE B se vuelve a ejecutar para
-- recoger lo que haya entrado entre medias) ni de qué webhook estaba
-- desplegado cuando entró el adjunto.
--
-- SIN TABLAS TEMPORALES A PROPÓSITO: el SQL Editor de Supabase va detrás
-- de un pooler en modo transacción, así que dos sentencias de la misma
-- ejecución pueden acabar en conexiones de servidor distintas. Cada
-- sentencia de abajo es autónoma e idempotente.
--
-- TRES BLOQUES:
--   BLOQUE A: solo lectura. Ejecútalo y revisa el resultado.
--   BLOQUE B: la migración real. EL ORDEN IMPORTA: el sembrado va antes
--             que la carpeta WhatsApp; al revés, los contactos con
--             adjuntos ya tendrían una carpeta y el sembrado se los
--             saltaría.
--   BLOQUE C: comprobación posterior (solo lectura).
-- ============================================================

-- ============================================================
-- BLOQUE A — Revisión (no escribe nada)
-- ============================================================

-- Qué hay hoy. Esperado: solo source='whatsapp' (folder='WhatsApp'). Si
-- sale algún source='manual', parar y revisar antes de seguir.
select source, folder, status, (contact_id is not null) as con_contacto, count(*)
from public.documentos
group by 1, 2, 3, 4
order by 1, 2, 3, 4;

-- Contactos que recibirán el juego por defecto.
select count(*) as contactos_sin_carpetas
from public.contactos c
where not exists (select 1 from public.carpetas k where k.contact_id = c.id);

-- Contactos a los que se creará carpeta WhatsApp, y cuántos adjuntos irán a ella.
select d.contact_id, c.full_name, c.company, count(*) as adjuntos
from public.documentos d
join public.contactos c on c.id = d.contact_id
where d.source = 'whatsapp' and d.folder_id is null
  and not exists (select 1 from public.carpetas k
                  where k.contact_id = d.contact_id and k.system_key = 'whatsapp')
group by d.contact_id, c.full_name, c.company
order by adjuntos desc;

-- ============================================================
-- BLOQUE B — Migración real (ejecutar tras revisar el BLOQUE A)
-- ============================================================

-- 1) Juego por defecto, con la misma función que usa el trigger de alta.
select public.sembrar_carpetas_por_defecto(c.id)
from public.contactos c
where not exists (select 1 from public.carpetas k where k.contact_id = c.id);

-- 2) Carpeta WhatsApp para los contactos con adjuntos.
insert into public.carpetas (contact_id, nombre, system_key, orden)
select distinct d.contact_id, 'WhatsApp', 'whatsapp', 100
from public.documentos d
where d.source = 'whatsapp' and d.contact_id is not null
on conflict do nothing;

-- 3) Asignar folder_id. Actualiza también updated_at de esas filas.
update public.documentos d
set folder_id = k.id
from public.carpetas k
where k.contact_id = d.contact_id and k.system_key = 'whatsapp'
  and d.source = 'whatsapp' and d.folder_id is null;

-- ============================================================
-- BLOQUE C — Comprobación (no escribe nada). Todo a 0.
-- ============================================================
select
  count(*) filter (where contact_id is not null and folder_id is null) as con_contacto_sin_carpeta,
  count(*) filter (where contact_id is null and folder_id is not null) as sin_contacto_con_carpeta
from public.documentos;

select count(*) as contactos_sin_carpetas
from public.contactos c
where not exists (select 1 from public.carpetas k where k.contact_id = c.id);
