// Supabase Edge Function: admin-users
// Crea o elimina accesos de administrador en Supabase Auth, invocada desde el CRM.
// SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase
// automáticamente en el entorno de la función — no hay que configurar nada más.
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase login
//   supabase link --project-ref TU_PROJECT_REF
//   supabase functions deploy admin-users
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Verifica que quien llama tiene una sesión válida (ya es un administrador logueado,
    // porque el registro público está desactivado — solo existen cuentas de admin).
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "No autorizado." }), { status: 401, headers: corsHeaders });
    }

    // Cliente con permisos de administrador — solo se usa aquí, en el servidor.
    const admin = createClient(url, serviceKey);
    const { action, email, password, name } = await req.json();

    if (action === "create") {
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name },
      });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      return new Response(JSON.stringify({ user: data.user }), { headers: corsHeaders });
    }

    if (action === "delete") {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers();
      if (listErr) return new Response(JSON.stringify({ error: listErr.message }), { status: 400, headers: corsHeaders });
      const target = list.users.find((u) => (u.email || "").toLowerCase() === (email || "").toLowerCase());
      if (!target) return new Response(JSON.stringify({ error: "Ese usuario no existe en Supabase." }), { status: 404, headers: corsHeaders });
      const { error } = await admin.auth.admin.deleteUser(target.id);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Acción no reconocida." }), { status: 400, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
