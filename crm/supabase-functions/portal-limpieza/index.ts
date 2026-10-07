// Supabase Edge Function: portal-limpieza
// Borra de Storage las subidas del área cliente que nunca llegaron a tener
// fila en documentos: objetos bajo cliente/ con más de 24 h y sin fila
// (pidieron URL, subieron y no confirmaron, o se rechazaron y no se pudieron
// borrar en el momento). La lista la da la RPC portal_huerfanos_cliente
// (solo service_role); el borrado va por la API de Storage, que es la que
// borra el fichero de verdad (un DELETE sobre storage.objects no lo haría).
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
      .filter((n) => typeof n === "string" && n.startsWith("cliente/"));

    let borrados = 0, errores = 0;
    for (let i = 0; i < rutas.length; i += LOTE) {
      const lote = rutas.slice(i, i + LOTE);
      const { data: hechos, error: rmErr } = await admin.storage.from("documentos").remove(lote);
      if (rmErr) { errores += lote.length; console.error("portal-limpieza: remove", rmErr); continue; }
      borrados += (hechos || []).length;
    }

    console.log(`portal-limpieza: encontrados ${rutas.length}, borrados ${borrados}, errores ${errores}`);
    return json(200, { encontrados: rutas.length, borrados, errores });
  } catch (e) {
    console.error("portal-limpieza: fallo inesperado", e);
    return json(500, { error: "Error interno." });
  }
});
