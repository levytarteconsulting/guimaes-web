// Supabase Edge Function: notify-new-lead
// Envía un email de aviso (vía Resend) cuando se crea un nuevo lead en public.leads.
// Pensada para invocarse desde un trigger de Postgres (net.http_post) que envía
// el nuevo registro como { record: NEW }.
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   RESEND_API_KEY  — API key de Resend
//   NOTIFY_TO       — email que recibe el aviso
//   HOOK_SECRET     — secreto compartido con el trigger, para validar la cabecera x-hook-secret
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
