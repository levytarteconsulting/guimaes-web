// Supabase Edge Function: notify-new-lead
// Envía un email de aviso (vía Resend) y una notificación push a todo el
// equipo cuando se crea un nuevo lead en public.leads. Pensada para
// invocarse desde un trigger de Postgres (net.http_post) que envía el nuevo
// registro como { record: NEW }.
//
// El push es best-effort y va DESPUÉS del email en el código, pero es
// completamente independiente: si push-send falla, no se toca la respuesta
// de este email (el email es el canal fiable, sobre todo en iOS); igualmente,
// un fallo del email no impide intentar el push. Ver notifyTeamPush() abajo.
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   RESEND_API_KEY               — API key de Resend
//   NOTIFY_TO                    — email que recibe el aviso
//   HOOK_SECRET                  — secreto compartido con el trigger, para validar x-hook-secret
//   SUPABASE_URL                  — inyectada automáticamente por Supabase (llamar a push-send)
//   SUPABASE_SERVICE_ROLE_KEY     — inyectada automáticamente; credencial para llamar a push-send
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase login
//   supabase link --project-ref zuktsotrcolqdowpbnrx
//   supabase functions deploy notify-new-lead --project-ref zuktsotrcolqdowpbnrx

const CRM_URL = "https://guimaes.es/crm";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

// Llama a push-send servidor a servidor con la service_role key (la misma que
// ya usa cualquier Edge Function para su propio cliente de Supabase) — nunca
// sale de las secrets, no pasa por el navegador. Lanza si push-send responde
// con error; el llamante decide si eso debe importarle o no (aquí no: ver
// el try/catch en Deno.serve).
async function notifyTeamPush(title: string, body: string): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Faltan SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.");

  const res = await fetch(`${supabaseUrl}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ all: true, title, body, url: CRM_URL }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`push-send respondió ${res.status}: ${errText}`);
  }
}

Deno.serve(async (req) => {
  try {
    const hookSecret = Deno.env.get("HOOK_SECRET");
    const incomingSecret = req.headers.get("x-hook-secret");
    if (!hookSecret || incomingSecret !== hookSecret) {
      return new Response(JSON.stringify({ error: "No autorizado." }), { status: 401 });
    }

    const { record } = await req.json();
    const nombre = record?.nombre || "";
    const empresa = record?.empresa || "";
    const email = record?.email || "";
    const telefono = record?.telefono || "";
    const servicio = record?.servicio || "";
    const mensaje = record?.mensaje || "";

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const notifyTo = Deno.env.get("NOTIFY_TO");

    const subject = "Nuevo lead web: " + (servicio || "sin especificar") + " — " + (nombre || "sin nombre");
    const html = `
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        <tr><td><b>Empresa</b></td><td>${escapeHtml(empresa || "—")}</td></tr>
        <tr><td><b>Nombre</b></td><td>${escapeHtml(nombre || "—")}</td></tr>
        <tr><td><b>Email</b></td><td>${escapeHtml(email || "—")}</td></tr>
        <tr><td><b>Teléfono</b></td><td>${escapeHtml(telefono || "—")}</td></tr>
        <tr><td><b>Servicio</b></td><td>${escapeHtml(servicio || "—")}</td></tr>
        <tr><td><b>Mensaje</b></td><td>${escapeHtml(mensaje || "—")}</td></tr>
      </table>
      <p><a href="${CRM_URL}">Abrir en el CRM</a></p>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Guimaes CRM <notificaciones@guimaes.es>",
        to: [notifyTo],
        subject,
        html,
      }),
    });

    // Push best-effort, independiente del email en ambas direcciones: un
    // fallo aquí no debe convertir un email que sí salió en una respuesta de
    // error, y viceversa — por eso va en su propio try/catch, sin tocar el
    // "return" del email que viene justo debajo.
    try {
      await notifyTeamPush(
        "Nuevo lead — " + (servicio || "Formulario web"),
        [nombre, empresa, telefono].filter(Boolean).join(" · ") || "Sin datos de contacto",
      );
    } catch (e) {
      console.error("notify-new-lead: push falló (no bloquea el email)", e);
    }

    if (!resendRes.ok) {
      const errBody = await resendRes.text();
      console.error("notify-new-lead: Resend error", resendRes.status, errBody);
      return new Response(JSON.stringify({ error: "Resend error: " + errBody }), { status: 500 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    console.error("notify-new-lead: fallo", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
