// Supabase Edge Function: portal-cuentas
// CRM: gestión de las cuentas del área cliente. Solo administradores
// activos (lo comprueban las propias RPC con is_admin(), llamadas con el
// JWT de quien pide la acción).
//
//   "vincular": RPC admin_vincular_cuenta (exige email confirmado, que la
//     cuenta no sea admin ni esté vinculada y que el contacto no tenga
//     otra) y, si sale bien, email al cliente por Resend.
//   Altas provisionales (crm/supabase-portal-fase33.sql), por empresa_id:
//   "confirmar": admin_provisional_confirmar (quita la marca); mueve los
//     ficheros pendientes y envía un email breve de cuenta validada.
//   "fusionar": admin_provisional_fusionar (una transacción: todo pasa a la
//     empresa existente y se borran la empresa y el contacto provisionales);
//     después mueve los ficheros a la ruta de la empresa destino con la API
//     de Storage y los apunta uno a uno (admin_documento_movido). Si algo
//     falla a medias, se reintenta con "mover_documentos". Email breve.
//   "rechazar": admin_provisional_rechazar (borra empresa, contacto,
//     documentos y deals del alta), borra sus ficheros y elimina la cuenta
//     (nunca un admin ni una vinculada).
//   "eliminar": borra una cuenta de Auth SOLO si es pendiente: está en
//     admin_cuentas_pendientes() (no es admin ni está vinculada). Justo
//     antes de borrar se repite la comprobación con la service role, para
//     cerrar la carrera entre las dos llamadas. Nunca borra un admin ni una
//     cuenta vinculada a un contacto.
//
// Entrada (POST, Authorization: Bearer <JWT del admin>):
//   { accion: "vincular", auth_user_id, contact_id }
//     → 200 { emails_coinciden, email_cuenta, email_contacto, email_enviado }
//   { accion: "eliminar", auth_user_id } → 200 { ok: true }
//   { accion: "confirmar", empresa_id } → 200 { documentos_movidos, documentos_pendientes, email_enviado }
//   { accion: "fusionar", empresa_id, destino_id, contact_id? }
//     → 200 { empresa_id, contact_id, documentos_movidos, documentos_pendientes, email_enviado }
//   { accion: "mover_documentos", empresa_id? } → 200 { documentos_movidos, documentos_pendientes }
//   { accion: "rechazar", empresa_id } → 200 { ok: true, ficheros_borrados, cuenta_borrada }
//   Errores: 400 { error } · 403 (no admin) · 409 (no se puede eliminar) · 401
//
// Secrets: RESEND_API_KEY (el mismo que ya usa notify-new-lead).
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy portal-cuentas --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://guimaes.es",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esUuid = (x: unknown): x is string => typeof x === "string" && UUID_RE.test(x);
const escapar = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 42501 (no admin) → 403; el resto de errores de las RPC de admin traen un
// texto pensado para enseñarse en el CRM.
const errorRpc = (e: { code?: string; message: string }) =>
  e.code === "42501" ? json(403, { error: "No autorizado." }) : json(400, { error: e.message });

async function enviarEmail(para: string, asunto: string, html: string): Promise<boolean> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) { console.error("portal-cuentas: falta RESEND_API_KEY"); return false; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "GUIMAES <notificaciones@guimaes.es>", to: [para], subject: asunto, html }),
  });
  if (!res.ok) {
    console.error("portal-cuentas: Resend respondió", res.status, await res.text());
    return false;
  }
  return true;
}
const saludo = (nombre: string | null) => (nombre ? `Hola, ${escapar(nombre)}:` : "Hola:");

function enviarEmailVinculada(para: string, nombre: string | null) {
  return enviarEmail(para, "Tu acceso al área de cliente de GUIMAES ya está activo",
    `<p>${saludo(nombre)}</p>` +
    `<p>Hemos activado tu acceso al área de cliente de GUIMAES. Desde ella puedes consultar ` +
    `los datos de tu empresa, tus servicios y los documentos que compartimos contigo, y enviarnos documentación.</p>` +
    `<p><a href="https://guimaes.es/area-cliente">Entrar en el área de cliente</a></p>` +
    `<p>Si no has solicitado este acceso, responde a este correo y lo revisaremos.</p>` +
    `<p>— El equipo de GUIMAES</p>`);
}
// Alta provisional confirmada o fusionada.
function enviarEmailValidada(para: string, nombre: string | null) {
  return enviarEmail(para, "Hemos validado tu cuenta de GUIMAES",
    `<p>${saludo(nombre)}</p>` +
    `<p>Hemos revisado y validado tu cuenta del área de cliente. A partir de ahora verás también ` +
    `los servicios y documentos que compartamos contigo.</p>` +
    `<p><a href="https://guimaes.es/area-cliente">Entrar en el área de cliente</a></p>` +
    `<p>— El equipo de GUIMAES</p>`);
}

// Mueve los ficheros pendientes (documentos.mover_a) y apunta cada uno. Uno
// a uno: si uno falla, los demás siguen, y el que falló se queda pendiente
// para reintentarlo. Si el fichero ya está en el destino (un intento
// anterior lo movió pero no llegó a apuntarlo), solo lo apunta.
// deno-lint-ignore no-explicit-any
async function moverDocumentos(userClient: any, admin: any, empresaId: string | null) {
  const { data, error } = await userClient.rpc("admin_documentos_por_mover", { p_empresa_id: empresaId });
  if (error) throw error;
  const movs = (data || []) as { documento_id: string; origen: string; destino: string }[];
  let movidos = 0;
  for (const m of movs) {
    try {
      const { error: mvErr } = await admin.storage.from("documentos").move(m.origen, m.destino);
      if (mvErr) {
        const carpeta = m.destino.slice(0, m.destino.lastIndexOf("/"));
        const { data: lista } = await admin.storage.from("documentos").list(carpeta, { limit: 10 });
        if (!(lista || []).some((o: { name: string }) => `${carpeta}/${o.name}` === m.destino)) throw mvErr;
      }
      const { error: regErr } = await userClient.rpc("admin_documento_movido", { p_documento_id: m.documento_id });
      if (regErr) throw regErr;
      movidos++;
    } catch (e) {
      console.error("portal-cuentas: no se pudo mover un documento (se reintentará)", m.documento_id, e);
    }
  }
  return { documentos_movidos: movidos, documentos_pendientes: movs.length - movidos };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Método no permitido." });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json(401, { error: "No autorizado." });

    const body = await req.json().catch(() => ({}));
    const { accion, auth_user_id, empresa_id } = body as Record<string, unknown>;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // ---------------- altas provisionales ----------------
    if (accion === "mover_documentos") {
      if (empresa_id != null && !esUuid(empresa_id)) return json(400, { error: "Empresa no válida." });
      try { return json(200, await moverDocumentos(userClient, admin, (empresa_id as string) ?? null)); }
      catch (e) { return errorRpc(e as { code?: string; message: string }); }
    }
    if (accion === "confirmar" || accion === "fusionar" || accion === "rechazar") {
      if (!esUuid(empresa_id)) return json(400, { error: "Empresa no válida." });
    }
    if (accion === "confirmar") {
      const { data, error } = await userClient.rpc("admin_provisional_confirmar", { p_empresa_id: empresa_id });
      if (error) return errorRpc(error);
      const r = ((data || []) as { email: string | null; nombre: string | null }[])[0];
      let mov = { documentos_movidos: 0, documentos_pendientes: 0 };
      try { mov = await moverDocumentos(userClient, admin, empresa_id as string); }
      catch (e) { console.error("portal-cuentas: mover tras confirmar", e); }
      let email_enviado = false;
      try { if (r?.email) email_enviado = await enviarEmailValidada(r.email, r.nombre); }
      catch (e) { console.error("portal-cuentas: fallo enviando el email", e); }
      return json(200, { ...mov, email_enviado });
    }
    if (accion === "fusionar") {
      const { destino_id, contact_id } = body as Record<string, unknown>;
      if (!esUuid(destino_id) || (contact_id != null && !esUuid(contact_id))) return json(400, { error: "Datos no válidos." });
      const { data, error } = await userClient.rpc("admin_provisional_fusionar", {
        p_empresa_id: empresa_id, p_destino_id: destino_id, p_contact_id: contact_id ?? null,
      });
      if (error) return errorRpc(error);
      const r = (data as { empresa_id: string; contact_id: string; email: string | null; nombre: string | null }[])[0];
      let mov = { documentos_movidos: 0, documentos_pendientes: 0 };
      try { mov = await moverDocumentos(userClient, admin, r.empresa_id); }
      catch (e) { console.error("portal-cuentas: mover tras fusionar", e); }
      let email_enviado = false;
      try { if (r.email) email_enviado = await enviarEmailValidada(r.email, r.nombre); }
      catch (e) { console.error("portal-cuentas: fallo enviando el email", e); }
      return json(200, { empresa_id: r.empresa_id, contact_id: r.contact_id, ...mov, email_enviado });
    }
    if (accion === "rechazar") {
      const { data, error } = await userClient.rpc("admin_provisional_rechazar", { p_empresa_id: empresa_id });
      if (error) return errorRpc(error);
      const r = ((data || []) as { auth_user_id: string | null; rutas: string[] | null }[])[0];
      const rutas = (r?.rutas || []).filter((x) => typeof x === "string" && x.length > 0);
      let ficheros_borrados = 0;
      for (let i = 0; i < rutas.length; i += 100) {
        const { data: hechos, error: rmErr } = await admin.storage.from("documentos").remove(rutas.slice(i, i + 100));
        if (rmErr) console.error("portal-cuentas: no se pudieron borrar ficheros del alta (los recoge portal-limpieza)", rmErr);
        ficheros_borrados += (hechos || []).length;
      }
      let cuenta_borrada = false;
      if (r?.auth_user_id) {
        // Misma doble comprobación que "eliminar": nunca un admin ni una vinculada.
        const [esAdmin, vinculada] = await Promise.all([
          admin.from("admins").select("id").eq("auth_user_id", r.auth_user_id).limit(1),
          admin.from("contactos").select("id").eq("auth_user_id", r.auth_user_id).limit(1),
        ]);
        if (!esAdmin.error && !vinculada.error && !(esAdmin.data || []).length && !(vinculada.data || []).length) {
          const { error: delErr } = await admin.auth.admin.deleteUser(r.auth_user_id);
          if (delErr && !/not found/i.test(delErr.message)) {
            console.error("portal-cuentas: deleteUser", delErr);
            return json(500, { error: "Se borró el alta, pero no la cuenta. Bórrala desde Área cliente." });
          }
          cuenta_borrada = true;
        }
      }
      return json(200, { ok: true, ficheros_borrados, cuenta_borrada });
    }

    if (!esUuid(auth_user_id)) return json(400, { error: "Cuenta no válida." });

    // ---------------- vincular ----------------
    if (accion === "vincular") {
      const { contact_id } = body as Record<string, unknown>;
      if (!esUuid(contact_id)) return json(400, { error: "Contacto no válido." });

      const { data, error } = await userClient.rpc("admin_vincular_cuenta", {
        p_auth_user_id: auth_user_id,
        p_contact_id: contact_id,
      });
      if (error) return errorRpc(error);
      const r = Array.isArray(data) ? data[0] as {
        emails_coinciden: boolean; email_cuenta: string; email_contacto: string | null; nombre_contacto: string | null;
      } : null;
      if (!r) return json(500, { error: "Respuesta inesperada." });

      let email_enviado = false;
      try { email_enviado = await enviarEmailVinculada(r.email_cuenta, r.nombre_contacto); }
      catch (e) { console.error("portal-cuentas: fallo enviando el email", e); }

      return json(200, {
        emails_coinciden: r.emails_coinciden,
        email_cuenta: r.email_cuenta,
        email_contacto: r.email_contacto,
        email_enviado,
      });
    }

    // ---------------- eliminar ----------------
    if (accion === "eliminar") {
      // 1) Con el JWT del admin: demuestra que quien llama es admin activo y
      //    que la cuenta es pendiente (ni admin ni vinculada).
      const { data: pendientes, error } = await userClient.rpc("admin_cuentas_pendientes");
      if (error) return errorRpc(error);
      const esPendiente = Array.isArray(pendientes) &&
        pendientes.some((p: { auth_user_id: string }) => p.auth_user_id === auth_user_id);
      if (!esPendiente) {
        return json(409, { error: "Esta cuenta no se puede eliminar: es de un administrador, está vinculada a un contacto o no existe." });
      }

      // 2) Con la service role, justo antes de borrar: otra vez, por si se
      //    vinculó o se hizo admin entre medias. Ante cualquier error, no borra.
      const [esAdmin, vinculada] = await Promise.all([
        admin.from("admins").select("id").eq("auth_user_id", auth_user_id).limit(1),
        admin.from("contactos").select("id").eq("auth_user_id", auth_user_id).limit(1),
      ]);
      if (esAdmin.error || vinculada.error) {
        console.error("portal-cuentas: no se pudo recomprobar", esAdmin.error, vinculada.error);
        return json(500, { error: "No se pudo comprobar la cuenta." });
      }
      if ((esAdmin.data || []).length || (vinculada.data || []).length) {
        return json(409, { error: "Esta cuenta no se puede eliminar: es de un administrador o está vinculada a un contacto." });
      }

      const { data: u, error: getErr } = await admin.auth.admin.getUserById(auth_user_id);
      if (getErr || !u?.user) return json(409, { error: "La cuenta no existe." });
      const { error: delErr } = await admin.auth.admin.deleteUser(auth_user_id);
      if (delErr) {
        console.error("portal-cuentas: deleteUser", delErr);
        return json(500, { error: "No se pudo eliminar la cuenta." });
      }
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida." });
  } catch (e) {
    console.error("portal-cuentas: fallo inesperado", e);
    return json(500, { error: "Error interno." });
  }
});
