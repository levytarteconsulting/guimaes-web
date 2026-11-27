// Lógica de la Edge Function holded-acciones: ACCIONES (escritura) en Holded
// con aprobación humana. Ver crm/supabase-holded-acciones.sql.
//
// Entrada (POST):
//   { accion: "proponer", empresa_id, tipo, parametros, origen? }
//       con el JWT de un usuario activo del CRM (el asistente o el CRM), o
//       con x-hook-secret (el operador). Solo lee Holded y crea la propuesta
//       en estado «propuesta» (o «aprobada» si la política de la empresa es
//       automática y está dentro de sus topes). Nunca ejecuta.
//   { accion: "ejecutar" }
//       solo con x-hook-secret (pg_cron, cada minuto). Reclama lotes de
//       acciones YA APROBADAS en el CRM y los ejecuta respetando el ritmo por
//       minuto y Retry-After. Un usuario no puede pedir «ejecutar».
//
// La clave de cada empresa solo se lee aquí (holded_clave_de, service_role)
// y nunca se devuelve ni se registra.

import type { Fetch } from "../_shared/holded.ts";
import { aprobarTicket, detalleError, OPERACIONES } from "./operaciones.ts";
import { construir, ErrorPropuesta, validarParams } from "./propuesta.ts";

export const PLAZO_EJECUCION_MS = 45_000;       // pg_cron llama cada minuto: sin solaparse
export const POR_MINUTO_POR_DEFECTO = 40;
export const LOTE = 10;
export const MAX_ESPERA_429_S = 15;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ErrorRpc = { code?: string; message: string } | null;
export type Deps = {
  env: (k: string) => string | undefined;
  usuario: (authorization: string) => Promise<string | null>;
  /** is_admin() con el JWT del propio usuario. */
  esUsuarioCrm: (authorization: string) => Promise<boolean>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: ErrorRpc }>;
  fetchHolded: Fetch;                     // ya envuelto con fetchAcciones
  ahora?: () => number;
  esperar?: (ms: number) => Promise<void>;
  log?: (...a: unknown[]) => void;
};

const r = (status: number, body: unknown) => ({ status, body });
const limpiar = (s: string) => s.replace(/pat_[A-Za-z0-9_\-]*/g, "pat_…");

function igualSeguro(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
}

export async function atender(deps: Deps, cabeceras: { authorization: string; hook: string | null }, body: unknown) {
  const log = deps.log ?? (() => {});
  let quien: "cron" | { uid: string };
  if (cabeceras.hook !== null) {
    const secreto = deps.env("HOLDED_ACCIONES_CRON_SECRET") ?? "";
    if (!secreto || !igualSeguro(cabeceras.hook, secreto)) return r(401, { error: "No autorizado." });
    quien = "cron";
  } else {
    const uid = cabeceras.authorization ? await deps.usuario(cabeceras.authorization).catch(() => null) : null;
    if (!uid) return r(401, { error: "No autorizado." });
    if (!(await deps.esUsuarioCrm(cabeceras.authorization).catch(() => false))) return r(403, { error: "Solo para usuarios activos del CRM." });
    quien = { uid };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return r(400, { error: "Cuerpo no válido." });
  const b = body as Record<string, unknown>;

  if (b.accion === "ejecutar") {
    if (quien !== "cron") return r(403, { error: "La ejecución solo la lanza el sistema, tras la aprobación en el CRM." });
    return r(200, await ejecutar(deps));
  }
  if (b.accion === "proponer") {
    try {
      return await proponer(deps, quien, b);
    } catch (e) {
      log("holded-acciones: proponer", e instanceof Error ? limpiar(e.message).slice(0, 200) : "error");
      return r(500, { error: "No se ha podido preparar la propuesta." });
    }
  }
  return r(400, { error: "Acción no válida." });
}

// ---------------------------------------------------------------- proponer
async function proponer(deps: Deps, quien: "cron" | { uid: string }, b: Record<string, unknown>) {
  const empresa = typeof b.empresa_id === "string" && RE_UUID.test(b.empresa_id) ? b.empresa_id.toLowerCase() : null;
  if (!empresa) return r(400, { error: "empresa_id no válido." });
  if (typeof b.tipo !== "string" || !(OPERACIONES as readonly string[]).includes(b.tipo)) {
    return r(400, { error: `Tipo de acción no permitido. Por ahora solo: ${OPERACIONES.join(", ")}.` });
  }
  const v = validarParams(b.parametros);
  if (!v.ok) return r(400, { error: v.error });
  const origen = quien === "cron" ? "operador" : b.origen === "agente" ? "agente" : "crm";

  const c = await deps.rpc("holded_clave_de", { p_empresa: empresa });
  const clave = typeof c.data === "string" ? c.data : null;
  if (c.error || !clave) {
    return r(200, { ok: false, codigo: "sin_conexion", mensaje: "Esta empresa no tiene Holded conectado en el CRM." });
  }
  let p;
  try {
    p = await construir(clave, v.params, deps.fetchHolded);
  } catch (e) {
    if (e instanceof ErrorPropuesta) return r(200, { ok: false, codigo: e.codigo, mensaje: e.message });
    throw e;
  }
  const cr = await deps.rpc("holded_acciones_crear", {
    p_usuario: quien === "cron" ? null : quien.uid, p_origen: origen, p_empresa: empresa, p_tipo: b.tipo,
    p_parametros: p.parametros, p_resumen: p.resumen, p_muestra: p.muestra, p_excluidos: p.excluidos,
    p_avisos: p.avisos, p_ids: p.ids, p_llamadas: p.llamadas,
  });
  if (cr.error) {
    if (cr.error.code === "42501") return r(403, { error: "Solo para usuarios activos del CRM." });
    if (["22023", "GU010", "GU011"].includes(cr.error.code ?? "")) {
      return r(200, { ok: false, codigo: cr.error.code, mensaje: limpiar(cr.error.message) });
    }
    throw new Error(cr.error.message);
  }
  const d = cr.data as { id: string; estado: string; documentos: number };
  return r(200, {
    ok: true,
    propuesta: { id: d.id, estado: d.estado, resumen: p.resumen, avisos: p.avisos, excluidos: p.excluidos.length,
                 muestra: p.muestra.slice(0, 5) },
  });
}

// ---------------------------------------------------------------- ejecutar
type Resultado = { id: string; estado: "ok" | "error" | "pendiente"; codigo?: number | null; error?: string | null };

export async function ejecutar(deps: Deps) {
  const ahora = deps.ahora ?? Date.now;
  const esperar = deps.esperar ?? ((ms) => new Promise<void>((res) => setTimeout(res, ms)));
  const log = deps.log ?? (() => {});
  const inicio = ahora();
  const porMinuto = (() => {
    const n = Number(deps.env("HOLDED_ACCIONES_POR_MINUTO"));
    return Number.isInteger(n) && n >= 1 && n <= 300 ? n : POR_MINUTO_POR_DEFECTO;
  })();
  const intervalo = Math.ceil(60_000 / porMinuto);
  const claves = new Map<string, string | null>();
  const resumen = { lotes: 0, ok: 0, error: 0, reintentar: 0, llamadas: 0, pausas: [] as string[] };
  let proxima = inicio;

  while (ahora() - inicio < PLAZO_EJECUCION_MS - intervalo) {
    const rc = await deps.rpc("holded_acciones_reclamar", { p_max: LOTE });
    if (rc.error) { log("holded-acciones: reclamar", rc.error.code); break; }
    const lote = rc.data as { accion_id: string; empresa_id: string; tipo: string; ids: string[] } | null;
    if (!lote || !lote.ids?.length) break;
    resumen.lotes++;

    if (!claves.has(lote.empresa_id)) {
      const c = await deps.rpc("holded_clave_de", { p_empresa: lote.empresa_id });
      claves.set(lote.empresa_id, typeof c.data === "string" ? c.data : null);
    }
    const clave = claves.get(lote.empresa_id);
    const res: Resultado[] = [];
    let pausar: string | null = null;
    let llamadas = 0;
    let cortar = false;

    if (!clave || lote.tipo !== "aprobar_tickets_venta") {
      pausar = !clave ? "La empresa ya no tiene la clave de Holded" : "Tipo de acción no permitido";
      for (const id of lote.ids) res.push({ id, estado: "pendiente" });
    } else {
      for (let i = 0; i < lote.ids.length; i++) {
        const id = lote.ids[i];
        if (pausar || cortar || ahora() - inicio >= PLAZO_EJECUCION_MS) { res.push({ id, estado: "pendiente" }); continue; }
        // Ritmo: como mucho porMinuto llamadas por minuto.
        const espera = proxima - ahora();
        if (espera > 0) await esperar(espera);
        proxima = Math.max(ahora(), proxima) + intervalo;

        let h = await aprobarTicket(clave, id, deps.fetchHolded);
        llamadas++;
        if (h.status === 429 && h.ventana !== "month") {
          const s = h.retryAfter ?? 5;
          if (s <= MAX_ESPERA_429_S && ahora() - inicio + s * 1000 < PLAZO_EJECUCION_MS) {
            await esperar(s * 1000);
            proxima = ahora() + intervalo;
            h = await aprobarTicket(clave, id, deps.fetchHolded);
            llamadas++;
          }
        }
        const st = h.status;
        if (st >= 200 && st < 300) res.push({ id, estado: "ok", codigo: st });
        else if (st === 429 && h.ventana === "month") {
          res.push({ id, estado: "pendiente", codigo: st }); pausar = "Holded: cupo mensual de la API de la cuenta agotado";
        } else if (st === 429) {
          res.push({ id, estado: "pendiente", codigo: st }); cortar = true;   // sigue en la próxima ejecución
        } else if (st === 401 || st === 403) {
          res.push({ id, estado: "pendiente", codigo: st });
          pausar = st === 401 ? "Holded rechaza la clave de la empresa (401)" : "La clave de Holded no tiene permiso para aprobar tickets (403)";
        } else if (st === 402) {
          res.push({ id, estado: "pendiente", codigo: st }); pausar = "Holded: se ha alcanzado el límite anual de facturas del plan (402)";
        } else if (st === 0 || st >= 500) {
          res.push({ id, estado: "pendiente", codigo: st || null, error: st ? `Holded ${st}` : "Sin respuesta de Holded" });
        } else {
          res.push({ id, estado: "error", codigo: st,
                     error: (st === 404 ? "No encontrado en Holded" : `Holded ${st}`) + (detalleError(h.datos) ? `: ${detalleError(h.datos)}` : "") });
        }
      }
    }
    resumen.llamadas += llamadas;
    for (const x of res) resumen[x.estado === "pendiente" ? "reintentar" : x.estado]++;
    const fin = await deps.rpc("holded_acciones_resultado", {
      p_accion: lote.accion_id, p_resultados: res, p_llamadas: llamadas, p_pausar: pausar,
    });
    if (fin.error) { log("holded-acciones: resultado", fin.error.code); break; }
    if (pausar) resumen.pausas.push(pausar);
    if (cortar) break;
  }
  return { ...resumen, ms: ahora() - inicio };
}
