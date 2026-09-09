/* GUIMAES CRM — Configuración de Supabase
   1. Crea un proyecto gratuito en https://supabase.com
   2. Ve a Project Settings → API y copia "Project URL" y "anon public" key
   3. Pégalas abajo. La "anon key" es pública y segura de exponer en el navegador
      (el control de acceso real se hace con RLS + que los usuarios no puedan
      auto-registrarse, ver crm/SETUP-SUPABASE.md) */
window.SUPABASE_CONFIG = {
  url: "https://zuktsotrcolqdowpbnrx.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1a3Rzb3RyY29scWRvd3BibnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDY5MjksImV4cCI6MjA5ODg4MjkyOX0.BmOBBZbnTWvuUgy74gyKKHz5mPnyOI1d0gzf_UjQcwQ"
};

/* Notificaciones push (Web Push + VAPID)
   1. Genera el par de claves con: npx web-push generate-vapid-keys
   2. La PRIVADA va como secret de la Edge Function push-send
      (supabase secrets set VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:...),
      NUNCA aquí.
   3. La PÚBLICA sí va aquí en texto plano — no permite enviar notificaciones
      ni descifrar las de nadie (ver crm/supabase-push.sql), es una clave de
      identidad de servidor pensada para ir en el cliente, igual que la
      anon key de arriba. */
window.PUSH_CONFIG = {
  vapidPublicKey: "REPLACE-WITH-VAPID-PUBLIC-KEY"
};
