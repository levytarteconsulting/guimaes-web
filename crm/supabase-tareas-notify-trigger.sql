-- ============================================================
-- GUIMAES — Trigger de aviso al asignar una tarea (push + email)
-- Requiere que supabase-tareas.sql y supabase-admins.sql ya se hayan
-- ejecutado, y pg_net habilitado (ya lo está: lo usa el trigger de leads,
-- ver supabase-lead-trigger.sql).
--
-- Por qué un trigger y no una llamada explícita desde el CRM tras el
-- update: un trigger cubre cualquier forma en que assigned_to pueda
-- cambiar (la propia app, el SQL Editor, un script futuro) sin depender de
-- que cada sitio del código se acuerde de avisar — y net.http_post es
-- asíncrono: el trigger devuelve el control y la fila de tareas queda
-- guardada ANTES de que la llamada HTTP siquiera se resuelva, así que un
-- fallo del aviso no puede deshacer ni bloquear la asignación (el requisito
-- de "que la asignación nunca falle por esto" queda garantizado por diseño,
-- no por un try/catch que alguien tenga que acordarse de poner). La
-- contrapartida, como no tiene consola del navegador ni red del propio
-- CRM, es que depurarlo requiere mirar los logs de la Edge Function y la
-- tabla net._http_response (ver nota al final).
--
-- auth.uid() SÍ funciona dentro de este trigger: como tareas.insert/update
-- lo ejecuta siempre el propio CRM autenticado (crm/data.js usa
-- Auth.client, con la sesión del navegador), PostgREST propaga el JWT de
-- quien hizo la petición y auth.uid() devuelve su auth_user_id real — así
-- resolvemos "quién asigna" sin que el CRM tenga que mandarlo aparte (y
-- sin que un cliente pueda mentir sobre quién es).
--
-- Antes de ejecutar, sustituye <ANON_KEY> por la anon key del proyecto
-- (Project Settings → API) y <HOOK_SECRET> por el mismo valor que hayas
-- puesto como secret TASK_ASSIGNMENT_HOOK_SECRET de la Edge Function
-- notify-task-assignment (que hay que desplegar ANTES de ejecutar esto).
-- ============================================================

create or replace function public.notify_task_assignment()
returns trigger
language plpgsql
security definer
as $$
declare
  do_notify boolean;
begin
  -- OLD no existe en un INSERT — de ahí la rama separada en vez de un único
  -- "NEW.assigned_to is distinct from OLD.assigned_to" que fallaría ahí.
  if TG_OP = 'INSERT' then
    do_notify := NEW.assigned_to is not null;
  else
    do_notify := NEW.assigned_to is not null and NEW.assigned_to is distinct from OLD.assigned_to;
  end if;

  if do_notify then
    perform net.http_post(
      url     := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/notify-task-assignment',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer <ANON_KEY>',
        'x-hook-secret', '<HOOK_SECRET>'
      ),
      body    := jsonb_build_object('record', to_jsonb(NEW), 'assigned_by_auth_uid', auth.uid())
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists tareas_notify_assignment on public.tareas;
create trigger tareas_notify_assignment
  after insert or update on public.tareas
  for each row execute function public.notify_task_assignment();

-- ============================================================
-- Para depurar: net._http_response guarda cada respuesta HTTP que ha hecho
-- pg_net (incluida esta), con status_code y el cuerpo de la respuesta. Para
-- ver las últimas llamadas de este trigger:
--
--   select id, status_code, content, created
--   from net._http_response
--   order by created desc
--   limit 20;
-- ============================================================
