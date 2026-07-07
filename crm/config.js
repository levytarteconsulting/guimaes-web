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
