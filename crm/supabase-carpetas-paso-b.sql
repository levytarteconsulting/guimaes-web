-- ============================================================
-- GUIMAES — Fase 5, Paso B: retirar documentos.folder (texto)
--
-- La organización de documentos vive en public.carpetas + documentos.folder_id
-- (crm/supabase-carpetas.sql). El frontend y el webhook desplegados ya no
-- leen ni escriben documentos.folder, así que se elimina junto con su
-- índice.
--
-- Requiere que crm/supabase-carpetas.sql y
-- crm/supabase-carpetas-migracion.sql ya se hayan ejecutado.
--
-- SIN TABLAS TEMPORALES A PROPÓSITO: el SQL Editor de Supabase va detrás
-- de un pooler en modo transacción, así que dos sentencias de la misma
-- ejecución pueden acabar en conexiones de servidor distintas. Cada
-- sentencia de abajo es autónoma e idempotente.
--
-- CUATRO BLOQUES, cada uno a mano y por separado en el SQL Editor:
--   BLOQUE A: solo lectura. ¿Queda algún documento con contacto y sin
--             carpeta? Revísalo antes de seguir.
--   BLOQUE B: repite el backfill de la migración para lo que haya entrado
--             entre medias.
--   BLOQUE C: solo lectura. Misma comprobación que A, tras el backfill:
--             debe salir vacía.
--   BLOQUE D: el borrado. Un único bloque DO que vuelve a comprobar y NO
--             borra nada si aún queda algún documento con contacto y sin
--             carpeta — aunque se ejecute el fichero entero de golpe.
--             Ojo: si se ejecuta el fichero entero y el BLOQUE D se niega,
--             el SQL Editor deshace también el backfill del BLOQUE B (todo
--             va en la misma transacción). No queda nada a medias, pero
--             por eso conviene ir bloque a bloque.
-- ============================================================

-- ============================================================
-- BLOQUE A — Revisión (no escribe nada)
-- ============================================================

-- Detalle de los documentos con contacto y sin carpeta. Lo normal es que
-- salga vacío: el trigger documentos_resolver_carpeta no deja crear ni
-- dejar así un documento desde que existe. Si sale algo:
--   - source='whatsapp': el BLOQUE B lo coloca en la carpeta WhatsApp del
--     contacto.
--   - source='manual': el BLOQUE B NO puede decidir su carpeta. Hay que
--     asignarla a mano (update public.documentos set folder_id = ... where
--     id = ...) antes del BLOQUE D, o el BLOQUE D se negará a borrar.
-- (No lee documentos.folder: así este fichero se puede volver a ejecutar
-- entero después del BLOQUE D sin fallar.)
select d.id, d.source, d.status, d.original_filename, d.storage_path,
       d.contact_id, c.full_name, c.company, d.created_at
from public.documentos d
left join public.contactos c on c.id = d.contact_id
where d.contact_id is not null and d.folder_id is null
order by d.created_at;

-- Resumen por origen.
select source, count(*) as con_contacto_sin_carpeta
from public.documentos
where contact_id is not null and folder_id is null
group by source;

-- ============================================================
-- BLOQUE B — Backfill (mismo criterio que crm/supabase-carpetas-migracion.sql)
-- ============================================================

-- 1) Carpeta WhatsApp para los contactos con adjuntos SIN carpeta. El
-- filtro "folder_id is null" importa: sin él, este paso recrearía la
-- carpeta WhatsApp de un contacto cuyo admin ya sacó todos los adjuntos y
-- la borró.
insert into public.carpetas (contact_id, nombre, system_key, orden)
select distinct d.contact_id, 'WhatsApp', 'whatsapp', 100
from public.documentos d
where d.source = 'whatsapp' and d.contact_id is not null and d.folder_id is null
on conflict do nothing;

-- 2) Asignar folder_id.
update public.documentos d
set folder_id = k.id
from public.carpetas k
where k.contact_id = d.contact_id and k.system_key = 'whatsapp'
  and d.source = 'whatsapp' and d.folder_id is null;

-- ============================================================
-- BLOQUE C — Comprobación tras el backfill (no escribe nada). Debe salir 0.
-- ============================================================
select count(*) as con_contacto_sin_carpeta
from public.documentos
where contact_id is not null and folder_id is null;

-- ============================================================
-- BLOQUE D — Borrado de la columna y su índice
--
-- Un solo DO: la comprobación y el borrado van en la misma sentencia (y
-- por tanto en la misma transacción y la misma conexión del pooler), así
-- que no puede colarse nada entre medias ni ejecutarse el drop con la
-- comprobación fallida. Idempotente: con la columna ya borrada no hace
-- nada.
-- ============================================================
do $$
declare
  v_pendientes int;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'documentos' and column_name = 'folder') then
    raise notice 'documentos.folder ya no existe: nada que hacer.';
    return;
  end if;

  select count(*) into v_pendientes
  from public.documentos
  where contact_id is not null and folder_id is null;

  if v_pendientes > 0 then
    raise exception 'Quedan % documento(s) con contacto y sin carpeta: revisa el BLOQUE A antes de borrar documentos.folder.', v_pendientes;
  end if;

  drop index if exists public.documentos_contact_folder_idx;
  alter table public.documentos drop column folder;
  raise notice 'documentos.folder y documentos_contact_folder_idx eliminados.';
end;
$$;

-- ============================================================
-- Comprobar tras ejecutar (debe devolver 0 filas):
--   select column_name from information_schema.columns
--   where table_schema='public' and table_name='documentos' and column_name='folder';
--   select indexname from pg_indexes where indexname='documentos_contact_folder_idx';
-- ============================================================
