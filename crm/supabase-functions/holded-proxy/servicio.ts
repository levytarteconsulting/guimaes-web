// Lógica de la Edge Function holded-proxy (bloque 2): el asistente del CRM
// consulta Holded de una empresa. SOLO LECTURA (ver consultas.ts).
//
// Entrada (POST, Authorization: Bearer <JWT del usuario del CRM>, la reenvía
// la función agente): { consulta, empresa_id, params }
// Salida 200: { ok: true, datos, desde_cache, truncado, motivo_truncado? }
//          o  { ok: false, codigo, mensaje } (sin conexión, cupo, 403…)
//          400/401/403 si la petición o el usuario no valen.
//
// Pasos: usuario (JWT) → holded_iniciar (usuario activo del CRM, conexión,
// caché, cupo y reserva atómica, auditoría) → si no sale de la caché, la
// clave (holded_clave_de, solo service_role) → consultas a Holded →
// holded_terminar (llamadas hechas y código). La clave no sale de aquí: no
// se devuelve, no se registra y los mensajes de error se limpian.

import type { Fetch } from "../_shared/holded.ts";
import { claveCache, Corte, ejecutar, lector, MAX_LLAMADAS, type Tipo, validar } from "./consultas.ts";

export const CACHE_MS = 5 * 60_000;
export const CACHE_MAX = 300;
export const PLAZO_MS = 40_000;            // la función agente espera 45 s
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ErrorRpc = { code?: string; message: string } | null;
export type Deps = {
  usuario: (authorization: string) => Promise<string | null>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: ErrorRpc }>;
  fetchHolded: Fetch;                    // ya envuelto con fetchSoloLectura
  ahora?: () => number;
  esperar?: (ms: number) => Promise<void>;
  log?: (...a: unknown[]) => void;
};
type Entrada = { version: string; at: number; datos: unknown; truncado: boolean; motivo: string | null };
export type Cache = Map<string, Entrada>;
export const nuevaCache = (): Cache => new Map();

const limpiar = (s: string) => s.replace(/pat_[A-Za-z0-9_\-]*/g, "pat_…");
const r = (status: number, body: unknown) => ({ status, body });

const MENSAJES: Record<string, string> = {
  sin_conexion: "Esta empresa no tiene Holded conectado en el CRM, así que no hay datos de Holded que consultar. Se conecta en Configuración → Integraciones → Holded.",
  conexion_error: "La conexión con Holded de esta empresa tiene un error",
  cupo: "Se ha llegado al tope de llamadas a Holded de este mes para esta empresa",
};

export async function atender(deps: Deps, cache: Cache, authorization: string, body: unknown) {
  const ahora = deps.ahora ?? Date.now;
  const log = deps.log ?? (() => {});
  const inicio = ahora();

  const uid = authorization ? await deps.usuario(authorization).catch(() => null) : null;
  if (!uid) return r(401, { error: "No autorizado." });

  if (!body || typeof body !== "object" || Array.isArray(body)) return r(400, { error: "Cuerpo no válido." });
  const b = body as Record<string, unknown>;
  const tipo = typeof b.consulta === "string" ? b.consulta : "";
  const empresa = typeof b.empresa_id === "string" && RE_UUID.test(b.empresa_id) ? b.empresa_id.toLowerCase() : null;
  if (!empresa) return r(400, { error: "empresa_id no válido." });
  const v = validar(tipo, b.params);
  if (!v.ok) return r(400, { error: v.error });

  // Caché: solo se usa si holded_iniciar confirma que la conexión es la misma.
  const k = claveCache(empresa, tipo, v.params);
  let enCache = cache.get(k);
  if (enCache && inicio - enCache.at > CACHE_MS) { cache.delete(k); enCache = undefined; }

  const ini = await deps.rpc("holded_iniciar", {
    p_usuario: uid, p_empresa: empresa, p_tipo: tipo, p_max: MAX_LLAMADAS[tipo as Tipo], p_version_cache: enCache?.version ?? null,
  });
  if (ini.error) {
    if (ini.error.code === "42501") return r(403, { error: "Solo para usuarios activos del CRM." });
    log("holded-proxy: holded_iniciar", ini.error.code);
    return r(500, { error: "No se ha podido preparar la consulta." });
  }
  const i = ini.data as Record<string, unknown>;
  if (i.ok !== true) {
    const motivo = String(i.motivo);
    let mensaje = MENSAJES[motivo] ?? "No se puede consultar Holded para esta empresa.";
    if (motivo === "conexion_error") mensaje += `: ${limpiar(String(i.error ?? "error desconocido"))}. Hay que revisarla en Configuración → Integraciones → Holded.`;
    if (motivo === "cupo") mensaje += ` (${i.usadas} de ${i.cupo}). No se consulta más hasta el mes que viene, salvo que un admin suba el tope en Configuración → Integraciones → Holded.`;
    return r(200, { ok: false, codigo: motivo, mensaje });
  }
  if (i.desde_cache === true && enCache) {
    return r(200, { ok: true, datos: enCache.datos, desde_cache: true, truncado: enCache.truncado,
                    ...(enCache.motivo ? { motivo_truncado: enCache.motivo } : {}) });
  }

  const consulta = String(i.consulta_id);
  const terminar = async (llamadas: number, codigo: string) => {
    const t = await deps.rpc("holded_terminar", { p_consulta: consulta, p_llamadas: llamadas, p_codigo: codigo });
    if (t.error) log("holded-proxy: holded_terminar", t.error.code);
  };

  const c = await deps.rpc("holded_clave_de", { p_empresa: empresa });
  const clave = typeof c.data === "string" ? c.data : null;
  if (c.error || !clave) {
    await terminar(0, "sin_clave");
    return r(200, { ok: false, codigo: "sin_conexion", mensaje: MENSAJES.sin_conexion });
  }

  const l = lector(clave, {
    fetch: deps.fetchHolded, reservadas: Number(i.reservadas) || 0, plazo: inicio + PLAZO_MS, ahora, esperar: deps.esperar,
  });
  try {
    const datos = await ejecutar(tipo as Tipo, v.params, l);
    const { truncado, motivo } = l.estado;
    await terminar(l.estado.llamadas, "200");
    // No se guarda en caché lo cortado por cupo o por tiempo (estaría incompleto).
    if (motivo !== "cupo" && motivo !== "tiempo") {
      if (cache.size >= CACHE_MAX) {
        for (const [kk, e] of cache) if (ahora() - e.at > CACHE_MS) cache.delete(kk);
        while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      }
      cache.set(k, { version: String(i.version), at: ahora(), datos, truncado, motivo });
    }
    return r(200, {
      ok: true, datos, desde_cache: false, truncado,
      ...(motivo ? { motivo_truncado: motivo === "cupo" ? `se ha llegado al tope mensual de llamadas de esta empresa (${i.cupo})`
                    : motivo === "tiempo" ? "Holded ha tardado demasiado" : `como mucho se leen 500 documentos por serie` } : {}),
    });
  } catch (e) {
    if (e instanceof Corte) {
      await terminar(l.estado.llamadas, e.codigo);
      return r(200, { ok: false, codigo: e.codigo, mensaje: e.mensaje });
    }
    await terminar(l.estado.llamadas, "error");
    log("holded-proxy: fallo en la consulta", tipo);   // sin el error: podría arrastrar datos
    return r(200, { ok: false, codigo: "error", mensaje: "No se ha podido completar la consulta a Holded." });
  }
}
