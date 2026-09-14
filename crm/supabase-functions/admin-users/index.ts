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

    // Esta función usa la service role key, que ignora las RLS de
    // public.admins por completo — así que la comprobación de que quien
    // llama tiene rol 'admin' (no solo "está logueado") hay que hacerla a
    // mano aquí, si no cualquier cuenta con acceso al CRM podría crear o
    // borrar administradores sin importar su rol.
    const { data: caller, error: callerErr } = await admin
      .from("admins")
      .select("rol, activo")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (callerErr) return new Response(JSON.stringify({ error: callerErr.message }), { status: 500, headers: corsHeaders });
    if (!caller || !caller.activo || caller.rol !== "admin") {
      return new Response(JSON.stringify({ error: "Solo los administradores con rol 'admin' pueden gestionar accesos." }), { status: 403, headers: corsHeaders });
    }

    const { action, email, password, name, rol } = await req.json();

    if (action === "create") {
      const { data, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { name },
      });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });

      // La fila de public.admins se crea aquí, en la misma llamada que el
      // usuario de Auth — si esto falla, se deshace la creación de Auth en
      // vez de dejar una cuenta huérfana sin fila (inerte para el login,
      // pero invisible y no reutilizable: el email ya estaría "gastado"
      // en Auth aunque nadie lo vea en la pantalla de Usuarios).
      const { data: adminRow, error: adminErr } = await admin
        .from("admins")
        .insert({ auth_user_id: data.user.id, nombre: name, email, rol: rol === "admin" ? "admin" : "miembro" })
        .select()
        .single();
      if (adminErr) {
        await admin.auth.admin.deleteUser(data.user.id);
        return new Response(JSON.stringify({ error: adminErr.message }), { status: 400, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ user: data.user, admin: adminRow }), { headers: corsHeaders });
    }

    if (action === "delete") {
      const { data: list, error: listErr } = await admin.auth.admin.listUsers();
      if (listErr) return new Response(JSON.stringify({ error: listErr.message }), { status: 400, headers: corsHeaders });
      const target = list.users.find((u) => (u.email || "").toLowerCase() === (email || "").toLowerCase());
      if (!target) return new Response(JSON.stringify({ error: "Ese usuario no existe en Supabase." }), { status: 404, headers: corsHeaders });
      const { error } = await admin.auth.admin.deleteUser(target.id);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
      // Limpia también la fila de admins — si no, el email queda "ocupado"
      // por la unique constraint y no se puede volver a dar de alta.
      await admin.from("admins").delete().eq("auth_user_id", target.id);
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Acción no reconocida." }), { status: 400, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
});
