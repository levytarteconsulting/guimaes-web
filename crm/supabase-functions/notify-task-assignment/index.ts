// Supabase Edge Function: notify-task-assignment
// Avisa por push y por email a quien se le asigna una tarea (al crearla
// con asignado, o al cambiarle el asignado a una ya existente). La llama
// un trigger de Postgres sobre public.tareas vía net.http_post — ver
// crm/supabase-tareas-notify-trigger.sql. Nunca la llama el navegador.
//
// No avisa si quien asigna es la misma persona a la que se asigna
// (autoasignación) — esa comprobación vive AQUÍ, no en el trigger: hace
// falta cruzar admins.auth_user_id, y aquí ya tenemos permisos de
// servicio para hacerlo sin líos de RLS.
//
// Es también el único sitio donde se cruzan los dos "espacios de ids" del
// proyecto: tareas.assigned_to guarda admins.id, pero
// push_subscriptions.user_id guarda auth.users.id (= admins.auth_user_id).
// El email no necesita ese salto: admins.email está en la misma fila.
//
// Variables de entorno necesarias (Project Settings → Edge Functions → Secrets):
//   TASK_ASSIGNMENT_HOOK_SECRET  — secreto compartido con el trigger, para
//                                  validar x-hook-secret (propio de esta
//                                  función; no reutiliza el HOOK_SECRET de
//                                  notify-new-lead a propósito, para que
//                                  rotar uno no afecte al otro)
//   RESEND_API_KEY                — la misma cuenta de Resend que notify-new-lead
//   SUPABASE_URL                  — inyectada automáticamente por Supabase
//   SUPABASE_SERVICE_ROLE_KEY     — inyectada automáticamente (también para llamar a push-send)
//
// Desplegar con (una sola vez, desde tu ordenador con la Supabase CLI):
//   supabase functions deploy notify-task-assignment --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CRM_URL = "https://guimaes.es/crm";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] as string));
}

function fmtDue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // timeZone explícito: esta función corre en el servidor (Deno, UTC por
  // defecto), no en el navegador de nadie — sin esto, la fecha que verían
  // asesor y cliente en el aviso no coincidiría con la que ven dentro del
  // CRM (que sí usa la zona del navegador, normalmente ya Europe/Madrid).
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Madrid" })
    + " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
}

// Llama a push-send servidor a servidor con la service_role key — mismo
// patrón que notify-new-lead/whatsapp-webhook. Dirigido a un solo usuario
// (user_ids: [authUserId]), nunca all:true — esto es un aviso personal, no
// un anuncio al equipo entero.
async function sendPush(supabaseUrl: string, serviceKey: string, authUserId: string, title: string, body: string, taskId: string): Promise<void> {
  const res = await fetch(`${supabaseUrl}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_ids: [authUserId], title, body, url: "/crm?view=tareas&id=" + taskId, tag: "task-" + taskId }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`push-send respondió ${res.status}: ${errText}`);
  }
}

async function sendEmail(resendApiKey: string, toEmail: string, subject: string, html: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Guimaes CRM <notificaciones@guimaes.es>", to: [toEmail], subject, html }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Resend respondió ${res.status}: ${errText}`);
  }
}

Deno.serve(async (req) => {
  try {
    // ---- Autenticación: solo nuestro propio trigger, nunca el navegador ----
    // Igual que notify-new-lead: esto lo dispara Postgres (net.http_post),
    // no hay un usuario logueado detrás cuya sesión validar, así que el
    // mecanismo es un secreto compartido en una cabecera propia, no un JWT.
    const hookSecret = Deno.env.get("TASK_ASSIGNMENT_HOOK_SECRET");
    const incomingSecret = req.headers.get("x-hook-secret");
    if (!hookSecret || incomingSecret !== hookSecret) {
      return new Response(JSON.stringify({ error: "No autorizado." }), { status: 401 });
    }

    // { record: to_jsonb(NEW), assigned_by_auth_uid: auth.uid() } — mismo
    // shape "record" que ya usa notify-new-lead; assigned_by_auth_uid lo
    // añade el trigger porque auth.uid() solo se puede leer ahí (dentro de
    // la petición original del CRM), no aquí dentro de esta función.
    const { record, assigned_by_auth_uid: assignedByAuthUid } = await req.json();
    const taskId: string | undefined = record?.id;
    const assignedTo: string | undefined = record?.assigned_to; // admins.id
    const title: string = record?.title || "Tarea sin título";
    const dueAt: string | null = record?.due_at || null;

    if (!taskId || !assignedTo) {
      return new Response(JSON.stringify({ ok: true, skipped: "sin tarea o sin asignado" }), { status: 200 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: assignee, error: assigneeErr } = await supabase
      .from("admins")
      .select("id, nombre, email, auth_user_id, activo")
      .eq("id", assignedTo)
      .maybeSingle();
    if (assigneeErr) throw assigneeErr;
    if (!assignee || !assignee.activo) {
      return new Response(JSON.stringify({ ok: true, skipped: "asignado no encontrado o inactivo" }), { status: 200 });
    }

    if (assignedByAuthUid && assignee.auth_user_id === assignedByAuthUid) {
      return new Response(JSON.stringify({ ok: true, skipped: "autoasignación" }), { status: 200 });
    }

    let assignerName = "Alguien";
    if (assignedByAuthUid) {
      const { data: assigner } = await supabase.from("admins").select("nombre").eq("auth_user_id", assignedByAuthUid).maybeSingle();
      if (assigner?.nombre) assignerName = assigner.nombre;
    }

    const dueText = fmtDue(dueAt);
    const pushBody = assignerName + " te ha asignado: " + title + (dueText ? " (vence " + dueText + ")" : "");
    const results: Record<string, string> = {};

    // Push y email van cada uno en su propio try/catch: son best-effort e
    // independientes entre sí (igual que en notify-new-lead) — el fallo de
    // uno no debe impedir intentar el otro. Y ninguno de los dos puede ya
    // "romper" la asignación de la tarea en sí: para cuando esta función se
    // ejecuta, net.http_post ya ha devuelto el control al trigger y la fila
    // de tareas ya quedó guardada — esto solo se registra.
    if (assignee.auth_user_id) {
      try {
        await sendPush(supabaseUrl, serviceKey, assignee.auth_user_id, "Nueva tarea asignada", pushBody, taskId);
        results.push = "enviado";
      } catch (e) {
        results.push = "error";
        console.error("notify-task-assignment: push falló (no bloquea el email)", e);
      }
    } else {
      results.push = "sin auth_user_id";
    }

    if (assignee.email) {
      try {
        const subject = assignerName + " te ha asignado una tarea: " + title;
        const html = `
          <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
            <tr><td><b>Tarea</b></td><td>${escapeHtml(title)}</td></tr>
            <tr><td><b>Asignada por</b></td><td>${escapeHtml(assignerName)}</td></tr>
            ${dueText ? `<tr><td><b>Vence</b></td><td>${escapeHtml(dueText)}</td></tr>` : ""}
          </table>
          <p><a href="${CRM_URL}?view=tareas&id=${taskId}">Abrir en el CRM</a></p>
        `;
        const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
        await sendEmail(resendApiKey, assignee.email, subject, html);
        results.email = "enviado";
      } catch (e) {
        results.email = "error";
        console.error("notify-task-assignment: email falló", e);
      }
    } else {
      results.email = "sin email";
    }

    return new Response(JSON.stringify({ ok: true, ...results }), { status: 200 });
  } catch (e) {
    console.error("notify-task-assignment: fallo inesperado", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
