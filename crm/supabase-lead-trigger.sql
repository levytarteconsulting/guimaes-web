-- ============================================================
-- GUIMAES — Trigger de aviso de lead nuevo (email + push)
--
-- Este trigger YA EXISTE en la base de datos de producción — se creó a mano
-- en su día y nunca se había versionado. Este fichero es la copia fiel de esa
-- definición (extraída con crm/supabase-inspect-lead-trigger.sql), para tener
-- el estado real de producción en el repo. NO lo ejecutes ni lo despliegues:
-- es documentación, no una migración pendiente.
--
-- Antes de poder ejecutarlo (p. ej. para recrear el trigger en otro entorno)
-- hay que sustituir los dos marcadores:
--   <ANON_KEY>     — la anon key del proyecto (Project Settings → API)
--   <HOOK_SECRET>  — debe coincidir EXACTAMENTE con el secret HOOK_SECRET
--                    configurado en la Edge Function notify-new-lead
--                    (Project Settings → Edge Functions → Secrets); si no
--                    coinciden, notify-new-lead responde 401 y no se envía
--                    ni el email ni el push.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  perform net.http_post(
    url     := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/notify-new-lead',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-hook-secret', '<HOOK_SECRET>'
    ),
    body    := jsonb_build_object('record', to_jsonb(NEW))
  );
  return NEW;
end;
$function$;

CREATE TRIGGER on_new_lead AFTER INSERT ON public.leads
FOR EACH ROW EXECUTE FUNCTION public.handle_new_lead();
