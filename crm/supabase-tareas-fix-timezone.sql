-- ============================================================
-- GUIMAES — Corrección retroactiva del desfase de zona horaria en
-- tareas.due_at.
--
-- Causa (ya arreglada en el código — ver crm/data.js:madridDatetimeLocalToISO):
-- el <input type="datetime-local"> del formulario de tareas manda un
-- string sin zona ("2026-09-14T18:00"), y antes del arreglo se guardaba
-- tal cual en una columna timestamptz — Postgres lo interpretaba como si
-- esos dígitos ya fueran UTC. 18:00 escritas en Madrid quedaban guardadas
-- como 18:00 UTC (20:00 reales), un desfase de 1h en horario de invierno
-- (CET, UTC+1) o 2h en verano (CEST, UTC+2) — nunca un desfase fijo.
--
-- Esta migración NO resta 2 horas a ciegas: reinterpreta los dígitos de
-- reloj ya guardados (que hoy están etiquetados como UTC pero en realidad
-- son la hora de Madrid que se escribió) como Europe/Madrid de verdad, y
-- deja que Postgres resuelva el offset correcto según la fecha de cada
-- fila (usa las reglas DST reales de la zona, con el cambio de hora de
-- 2026 incluido) — así no hace falta decidir a mano qué filas caen en
-- horario de verano.
--
-- ⚠️ Ejecutar el UPDATE UNA sola vez. No hay ninguna marca de "ya
-- migrado" en la tabla — volver a ejecutarlo desplazaría las fechas otra
-- vez, en la dirección equivocada.
--
-- Ejecutar en dos pasos, cada uno a mano en el SQL Editor:
--   1) el SELECT de comprobación — antes/después de cada fila afectada.
--   2) si el resultado tiene sentido (debería mostrar las 4 tareas con
--      due_at que mencionaste), el UPDATE final.
-- ============================================================

-- ---- 1) Comprobación: qué cambiaría (no escribe nada) ----
select
  id,
  title,
  due_at                                                as due_at_actual,
  (due_at at time zone 'UTC') at time zone 'Europe/Madrid' as due_at_corregido
from public.tareas
where due_at is not null
order by due_at;

-- ---- 2) Update — ejecutar solo tras revisar el SELECT de arriba ----
update public.tareas
set due_at = (due_at at time zone 'UTC') at time zone 'Europe/Madrid'
where due_at is not null;
