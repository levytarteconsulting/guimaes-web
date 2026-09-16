-- ============================================================
-- GUIMAES — Chequeo de adjuntos de WhatsApp colgados en 'pending'
-- Requiere que crm/supabase-documentos.sql ya se haya ejecutado, y
-- pg_cron/pg_net activos (ya deberían estarlo — se activaron en la Fase 3
-- para el recordatorio de vencimiento de tareas; el bloque de abajo los
-- vuelve a pedir con IF NOT EXISTS por si este fichero se ejecuta en un
-- proyecto donde ese otro aún no corrió).
--
-- Va en un cron y una función APARTE del recordatorio de tareas
-- (crm/supabase-tareas-due-reminder-cron.sql) a propósito: son dos
-- responsabilidades sin relación entre sí — mezclar "avisar de tareas" y
-- "limpiar descargas de WhatsApp colgadas" en la misma función solo haría
-- más difícil leer y depurar cada una por separado.
--
-- Por qué una fila puede quedarse en 'pending' más de un par de minutos:
-- EdgeRuntime.waitUntil() sigue el trabajo en segundo plano tras responder
-- a Meta, pero esa ejecución en segundo plano tiene su propio límite de
-- tiempo — si la función muere a mitad de la descarga (red, Storage caído,
-- el propio límite de tiempo), la fila se queda en 'pending' para
-- siempre si nadie la revisa. Cada 5 minutos basta: esto no es una
-- ventana de tiempo de cara al usuario (como si lo es el recordatorio de
-- tareas), es solo higiene para no dejar nada colgado sin explicación.
-- ============================================================

create extension if not exists pg_cron schema cron;
create extension if not exists pg_net;

create or replace function public.fail_stuck_documento_downloads()
returns void
language plpgsql
security definer
as $$
declare
  r record;
begin
  for r in
    update public.documentos
    set status = 'failed'
    where status = 'pending'
      and created_at < now() - interval '5 minutes'
    returning id, whatsapp_message_id
  loop
    -- jsonb_set en vez de reescribir meta entero: solo toca la clave
    -- attachment.status, sin pisar cualquier otra cosa que ya hubiera en
    -- meta (p. ej. delivery_error, aunque para un mensaje entrante no
    -- debería darse el caso).
    if r.whatsapp_message_id is not null then
      update public.whatsapp_messages
      set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{attachment,status}', '"failed"')
      where id = r.whatsapp_message_id;
    end if;
  end loop;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'documentos-pendientes-colgados';

select cron.schedule(
  'documentos-pendientes-colgados',
  '*/5 * * * *',
  $$select public.fail_stuck_documento_downloads();$$
);

-- ============================================================
-- Comprobar que corre:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'documentos-pendientes-colgados';
--   select status, start_time, return_message from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'documentos-pendientes-colgados')
--   order by start_time desc limit 10;
-- ============================================================
