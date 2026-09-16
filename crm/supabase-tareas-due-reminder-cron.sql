-- ============================================================
-- GUIMAES — Recordatorio de vencimiento de tareas (10 minutos antes)
-- Requiere que supabase-tareas.sql, supabase-admins.sql y
-- supabase-tareas-notify-trigger.sql ya se hayan ejecutado, y que la Edge
-- Function notify-task-assignment esté desplegada con la versión que
-- entiende "type" (ver crm/supabase-functions/notify-task-assignment/index.ts).
--
-- Antes de ejecutar, sustituye <ANON_KEY> (Project Settings → API) y
-- <HOOK_SECRET> por el mismo valor que ya tengas puesto como secret
-- TASK_ASSIGNMENT_HOOK_SECRET de esa función — es la MISMA función y el
-- MISMO secreto que usa el trigger de asignación, no uno nuevo.
-- ============================================================

-- ============================================================
-- 1) Columna de idempotencia
--
-- Se eligió una columna en tareas (reminder_sent_at) en vez de una tabla
-- aparte tipo tareas_avisos: lo que pide el punto 2 (un único UPDATE con
-- RETURNING que marca y selecciona a la vez, para que dos ejecuciones
-- solapadas del cron no dupliquen el envío) es exactamente lo que un
-- UPDATE ... WHERE reminder_sent_at is null ... RETURNING resuelve solo,
-- con el bloqueo de fila normal de Postgres — la segunda ejecución
-- solapada simplemente no encuentra la fila (ya no cumple el WHERE en
-- cuanto la primera hace commit). Con una tabla de log aparte, esa misma
-- garantía habría que montarla con un unique constraint + upsert, y
-- además el "una fila por (tarea, tipo)" no encaja bien con el aviso de
-- asignación, que si tiene sentido que se repita cada vez que se
-- reasigna — no es "una vez por tarea", es "una vez por cada cambio de
-- asignado". Forzar los dos avisos al mismo esquema de tabla habría sido
-- más complicado sin ganar nada aquí.
--
-- ¿Y registrar también el aviso de asignación, como se planteaba en el
-- punto 1? No hace falta una tabla nueva para eso tampoco: pg_cron ya
-- lleva su propio historial de ejecuciones (cron.job_run_details) y
-- net._http_response ya registra cada llamada HTTP que hace cualquiera de
-- los dos triggers/cron — juntos ya dan trazabilidad de "qué se disparó y
-- cuándo" sin añadir esquema propio. Ver la sección de observabilidad al
-- final de este fichero.
-- ============================================================
alter table public.tareas add column if not exists reminder_sent_at timestamptz;

-- ============================================================
-- 2) Función: marca y notifica en una sola pasada
-- ============================================================
create or replace function public.send_due_task_reminders()
returns void
language plpgsql
security definer
as $$
declare
  r record;
begin
  -- Un único UPDATE con RETURNING hace de "marcar" y "seleccionar" a la
  -- vez — es lo que hace esto seguro frente a dos ejecuciones solapadas
  -- del cron (la fila deja de cumplir el WHERE en cuanto una la marca).
  --
  -- due_at - interval '10 minutes' <= now(): entra en la ventana tanto la
  -- tarea que vence dentro de 10 minutos como la que YA venció (si el cron
  -- estuvo parado, p. ej. por la pausa del proyecto en el plan free) — a
  -- todas se les marca reminder_sent_at, así no se quedan acumulando para
  -- siempre. should_notify (due_at > now()) es quien decide, fila a fila,
  -- si además de marcarla se manda el aviso: si ya venció, se marca pero
  -- NO se avisa tarde, en silencio (los bucles de abajo lo respetan).
  --
  -- status <> 'done' and archived = false: una tarea completada o
  -- archivada nunca entra en el UPDATE, así que tampoco se marca ni se
  -- cuenta para nada — si se reabriera más adelante y su due_at siguiera
  -- vigente, podría volver a generar recordatorio (reminder_sent_at solo
  -- se pone la primera vez que la tarea entra en esta consulta estando
  -- activa).
  for r in
    update public.tareas
    set reminder_sent_at = now()
    where reminder_sent_at is null
      and due_at is not null
      and status <> 'done'
      and archived = false
      and due_at - interval '10 minutes' <= now()
    returning id, title, due_at, assigned_to, (due_at > now()) as should_notify
  loop
    if r.should_notify and r.assigned_to is not null then
      perform net.http_post(
        url     := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/notify-task-assignment',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer <ANON_KEY>',
          'x-hook-secret', '<HOOK_SECRET>'
        ),
        body    := jsonb_build_object(
          'type', 'due_reminder',
          'record', jsonb_build_object(
            'id', r.id,
            'title', r.title,
            'due_at', r.due_at,
            'assigned_to', r.assigned_to
          )
        )
      );
    end if;
  end loop;
end;
$$;

-- ============================================================
-- 3) Activar pg_cron y pg_net (pg_net ya debería estar activo — lo usa el
--    trigger de leads y el de asignación de tareas — pero se incluye aquí
--    también para que este fichero sea autosuficiente si se ejecuta en un
--    proyecto nuevo).
-- ============================================================
create extension if not exists pg_cron schema cron;
create extension if not exists pg_net;

-- ============================================================
-- 4) Programar el chequeo cada minuto
-- ============================================================
select cron.unschedule(jobid) from cron.job where jobname = 'tareas-recordatorio-vencimiento';

select cron.schedule(
  'tareas-recordatorio-vencimiento',
  '* * * * *',
  $$select public.send_due_task_reminders();$$
);

-- ============================================================
-- Observabilidad — qué comprobar y cómo
-- ============================================================
--
-- ¿Está pg_cron corriendo y cuándo fue la última vez?
--   select jobid, jobname, schedule, active from cron.job;
--
--   select jrd.status, jrd.start_time, jrd.end_time, jrd.return_message
--   from cron.job_run_details jrd
--   join cron.job j on j.jobid = jrd.jobid
--   where j.jobname = 'tareas-recordatorio-vencimiento'
--   order by jrd.start_time desc
--   limit 20;
--
-- ¿Qué respondió la Edge Function en cada llamada real (tanto las de este
-- cron como las del trigger de asignación, comparten la misma tabla)?
--   select id, status_code, content, created
--   from net._http_response
--   order by created desc
--   limit 20;
--
-- ¿Cuántas tareas se han marcado como avisadas recientemente (incluye
-- tanto las que sí recibieron push/email como las descartadas por venir
-- ya vencidas)?
--   select count(*) from public.tareas
--   where reminder_sent_at is not null and reminder_sent_at > now() - interval '1 hour';
-- ============================================================
