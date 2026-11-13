// Supabase Edge Function: agente
// Asistente de IA del CRM (fase 1: solo lectura). Lógica, reglas y límites:
// ./agente.ts. Herramientas: ./herramientas.ts (RPC agente_* de
// crm/supabase-agente.sql). Pruebas: ./agente_test.ts.
//
// Todo se hace con el JWT de quien pregunta (cliente con la anon key y su
// Authorization): las herramientas pasan por la RLS y por is_admin(), y la
// auditoría (agente_conversaciones/_mensajes/_tool_calls) se escribe con ese
// mismo JWT. Esta función NO usa la service role.
//
// Entrada (POST, Authorization: Bearer <JWT del usuario del CRM>):
//   { pregunta, conversacion_id?, contexto?: { vista, id? } }
// Salida: text/event-stream con los eventos conversacion, texto,
//   herramienta, error y fin; o JSON { error } con 400/401/403/404/409/429/503.
//
// Secrets (Project Settings → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   — clave de la API de Claude (sin ella responde 503)
//   AGENTE_MODELO       — opcional; por defecto claude-sonnet-5-5
//   AGENTE_ESFUERZO     — opcional; low | medium | high | xhigh | max (medium)
//   AGENTE_TOPE_DIARIO  — opcional; preguntas por usuario y día (50)
//   SUPABASE_URL, SUPABASE_ANON_KEY — inyectadas por Supabase
//
// Desplegar (desde crm/, lee verify_jwt = true de crm/supabase/config.toml):
//   supabase functions deploy agente --project-ref zuktsotrcolqdowpbnrx

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.8.0";
import { createHandler } from "./agente.ts";
import type { Db, ErrorDb, Modelo } from "./agente.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

function clienteUsuario(jwt: string) {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function ok<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data;
}

function db(jwt: string): Db {
  const c = clienteUsuario(jwt);
  return {
    async esUsuarioCrm() {
      return ok(await c.rpc("is_admin")) === true;
    },
    async preguntasDesde(authUserId, desdeIso) {
      const r = await c.from("agente_mensajes").select("id", { count: "exact", head: true })
        .eq("auth_user_id", authUserId).eq("tipo", "pregunta").gte("created_at", desdeIso);
      if (r.error) throw r.error;
      return r.count ?? 0;
    },
    async admins() {
      return ok(await c.from("admins").select("id, nombre, rol, activo").order("nombre")) ?? [];
    },
    async conversacionPropia(id, authUserId) {
      const d = ok(await c.from("agente_conversaciones").select("id").eq("id", id).eq("auth_user_id", authUserId).maybeSingle());
      return !!d;
    },
    async mensajes(conversacionId) {
      return ok(await c.from("agente_mensajes").select("orden, rol, tipo, contenido")
        .eq("conversacion_id", conversacionId).order("orden")) ?? [];
    },
    async crearConversacion(titulo, modelo) {
      return (ok(await c.from("agente_conversaciones").insert({ titulo, modelo }).select("id").single()) as { id: string }).id;
    },
    async guardarMensaje(m) {
      return (ok(await c.from("agente_mensajes").insert(m).select("id").single()) as { id: string }).id;
    },
    async guardarLlamadas(l) {
      ok(await c.from("agente_tool_calls").insert(l));
    },
    async rpc(nombre, args) {
      const r = await c.rpc(nombre, args);
      if (r.error) throw { code: r.error.code, message: r.error.message } satisfies ErrorDb;
      return r.data;
    },
  };
}

async function usuario(jwt: string): Promise<string | null> {
  const { data, error } = await clienteUsuario(jwt).auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user.id;
}

// Una sola instancia por proceso; se crea al primer uso (solo si hay clave).
let anthropic: Anthropic | null = null;
const modelo = (): Modelo => {
  anthropic ??= new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY"), maxRetries: 1 });
  const cliente = anthropic;
  return { stream: (params, signal) => cliente.beta.messages.stream(params, { signal }) };
};

Deno.serve(createHandler({
  env: (k) => Deno.env.get(k),
  usuario,
  db,
  modelo,
  log: (...a) => console.error(...a),
}));
