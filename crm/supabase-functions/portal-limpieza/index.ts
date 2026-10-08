// Supabase Edge Function: portal-limpieza
// 1) Huérfanos: borra de Storage las subidas del área cliente que nunca llegaron a tener
// fila en documentos: objetos bajo cliente/ con más de 24 h y sin fila
// (pidieron URL, subieron y no confirmaron, o se rechazaron y no se pudieron
// borrar en el momento). La lista la da la RPC portal_huerfanos_cliente
// (solo service_role); el borrado va por la API de Storage, que es la que
// borra el fichero de verdad (un DELETE sobre storage.objects no lo haría).
//
// (también los de pendientes/ del alta autónoma sin fila de alta).
// 2) Altas caducadas (crm/supabase-portal-fase32.sql): cuentas sin vincular,
// que no son admin, creadas hace más de 30 días. Borra sus ficheros con la
// API de Storage y elimina la cuenta (el borrador cae en cascada). Justo
// antes de cada borrado se vuelve a comprobar que no es admin ni está
// vinculada.
//
// La lanza pg_cron una vez al día (crm/supabase-portal-fase1.sql, bloque
// 3B) con la anon key como Authorization —para pasar verify_jwt— y el
// secreto compartido en x-hook-secret. El lado SQL lo lee de Supabase
// Vault en cada llamada (secreto 'portal_limpieza_hook_secret'); no está
// escrito ni en la función ni en el job.
//
// Secrets:
//   PORTAL_LIMPIEZA_HOOK_SECRET — el mismo valor que el secreto
//                                 'portal_limpieza_hook_secret' de Vault.
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase secrets set PORTAL_LIMPIEZA_HOOK_SECRET=<valor> --project-ref zuktsotrcolqdowpbnrx
//   supabase functions deploy portal-limpieza --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const LIMITE = 1000;   // objetos por ejecución (lo que quede, al día siguiente)
const LOTE = 100;      // rutas por llamada a remove()
const DIAS_CADUCIDAD = 30; // altas sin validar

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Método no permitido." });

  const hookSecret = Deno.env.get("PORTAL_LIMPIEZA_HOOK_SECRET");
  const incoming = req.headers.get("x-hook-secret");
  if (!hookSecret || !incoming || incoming !== hookSecret) return json(401, { error: "No autorizado." });

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await admin.rpc("portal_huerfanos_cliente", { p_limite: LIMITE });
    if (error) throw error;
    // Doble seguro: aunque la RPC ya filtra, nunca se borra nada fuera de cliente/.
    const rutas = ((data || []) as { nombre: string }[])
      .map((r) => r.nombre)
      .filter((n) => typeof n === "string" && (n.startsWith("cliente/") || n.startsWith("pendientes/")));

    let borrados = 0, errores = 0;
    for (let i = 0; i < rutas.length; i += LOTE) {
      const lote = rutas.slice(i, i + LOTE);
      const { data: hechos, error: rmErr } = await admin.storage.from("documentos").remove(lote);
      if (rmErr) { errores += lote.length; console.error("portal-limpieza: remove", rmErr); continue; }
      borrados += (hechos || []).length;
    }

    // ---- 2) altas caducadas ----
    const { data: cad, error: cadErr } = await admin.rpc("portal_altas_caducadas", { p_dias: DIAS_CADUCIDAD, p_limite: 100 });
    if (cadErr) throw cadErr;
    let cuentasBorradas = 0, cuentasError = 0;
    for (const c of (cad || []) as { auth_user_id: string; rutas: string[] }[]) {
      try {
        const suyas = (c.rutas || []).filter((r) => r.startsWith(`pendientes/${c.auth_user_id}/`));
        if (suyas.length) {
          const { error: rmErr } = await admin.storage.from("documentos").remove(suyas);
          if (rmErr) throw rmErr;
        }
        const [esAdmin, vinculada] = await Promise.all([
          admin.from("admins").select("id").eq("auth_user_id", c.auth_user_id).limit(1),
          admin.from("contactos").select("id").eq("auth_user_id", c.auth_user_id).limit(1),
        ]);
        if (esAdmin.error || vinculada.error || (esAdmin.data || []).length || (vinculada.data || []).length) continue;
        const { error: delErr } = await admin.auth.admin.deleteUser(c.auth_user_id);
        if (delErr) throw delErr;
        cuentasBorradas++;
      } catch (e) {
        cuentasError++;
        console.error("portal-limpieza: no se pudo borrar el alta caducada", c.auth_user_id, e);
      }
    }

    console.log(`portal-limpieza: huérfanos ${rutas.length}/${borrados} (errores ${errores}); altas caducadas ${cuentasBorradas} (errores ${cuentasError})`);
    return json(200, { encontrados: rutas.length, borrados, errores, altas_caducadas: cuentasBorradas, altas_error: cuentasError });
  } catch (e) {
    console.error("portal-limpieza: fallo inesperado", e);
    return json(500, { error: "Error interno." });
  }
});
