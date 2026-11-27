// Lógica de holded-conexiones sin Deno.serve (probada en servicio_test.ts).
//
// Acciones (POST JSON, Authorization: Bearer <JWT de un usuario con rol admin>):
//   previsualizar {archivo: {nombre, base64}}
//     → {carga, expira_at, filas: [...]}  (sin claves: solo 4 últimos caracteres)
//   confirmar {carga, archivo_nombre, decisiones: [{fila, accion, empresa_id?, reemplazar?}]}
//     → {lote, filas, verificar: [empresa_id]}
//   verificar {empresas: [empresa_id] (≤ 10)}
//     → {resultados: [{empresa_id, estado, error, permisos}]}
//
// El rol se comprueba dos veces: aquí se identifica al usuario por su JWT
// y cada función SQL exige que ese usuario tenga rol admin. Las claves solo
// existen en memoria durante la petición: nunca se devuelven ni se escriben
// en logs.
import { ErrorArchivo, leerArchivo } from "./archivo.ts";
import { verificarClave, type Verificacion } from "./verificar.ts";
import type { Fetch } from "../_shared/holded.ts";

export type ErrorRpc = { code?: string; message: string } | null;
export type Deps = {
  usuario: (authorization: string) => Promise<string | null>;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: ErrorRpc }>;
  fetchHolded?: Fetch;
};
export type Respuesta = { status: number; body: unknown };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (body: unknown): Respuesta => ({ status: 200, body });
const err = (status: number, error: string): Respuesta => ({ status, body: { error } });

// Mensaje de error de la base apto para el navegador: nunca con nada que
// parezca una clave.
const limpiar = (m: string) => m.replace(/pat_[A-Za-z0-9_\-]+/g, "pat_…").slice(0, 600);
function errorDeRpc(e: NonNullable<ErrorRpc>): Respuesta {
  if (e.code === "42501") return err(403, "Solo el rol admin puede gestionar las conexiones con Holded.");
  return err(400, limpiar(e.message || "Error en la base de datos."));
}

function base64ABytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function enParalelo<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export async function atender(deps: Deps, authorization: string, body: unknown): Promise<Respuesta> {
  const uid = await deps.usuario(authorization);
  if (!uid) return err(401, "No autorizado.");
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (b.accion === "previsualizar") {
    const a = (b.archivo ?? {}) as Record<string, unknown>;
    if (typeof a.nombre !== "string" || typeof a.base64 !== "string") return err(400, "Falta el archivo.");
    if (a.base64.length > 3_000_000) return err(400, "El archivo pasa de 2 MB.");
    let filas;
    try { filas = await leerArchivo(a.nombre, base64ABytes(a.base64)); }
    catch (e) { return err(400, e instanceof ErrorArchivo ? e.message : "No se pudo leer el archivo."); }
    const { data, error } = await deps.rpc("holded_previsualizar", { p_usuario: uid, p_filas: filas });
    filas = null;
    if (error) return errorDeRpc(error);
    return ok(data);
  }

  if (b.accion === "confirmar") {
    if (typeof b.carga !== "string" || !UUID_RE.test(b.carga)) return err(400, "Vista previa no válida.");
    if (!Array.isArray(b.decisiones)) return err(400, "Faltan las decisiones.");
    const decisiones = b.decisiones.map((d) => {
      const x = (d ?? {}) as Record<string, unknown>;
      return {
        fila: Number(x.fila), accion: String(x.accion ?? "omitir"),
        empresa_id: typeof x.empresa_id === "string" && UUID_RE.test(x.empresa_id) ? x.empresa_id : null,
        reemplazar: x.reemplazar === true,
      };
    });
    if (decisiones.some((d) => !Number.isInteger(d.fila))) return err(400, "Decisiones no válidas.");
    const { data, error } = await deps.rpc("holded_confirmar", {
      p_usuario: uid, p_carga: b.carga, p_decisiones: decisiones,
      p_archivo: typeof b.archivo_nombre === "string" ? b.archivo_nombre.slice(0, 150) : null,
    });
    if (error) return errorDeRpc(error);
    return ok(data);
  }

  if (b.accion === "verificar") {
    const ids = Array.isArray(b.empresas) ? b.empresas.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];
    if (!ids.length) return err(400, "Indica qué empresas verificar.");
    if (ids.length > 10) return err(400, "Como mucho 10 empresas por llamada.");
    const { data, error } = await deps.rpc("holded_para_verificar", { p_usuario: uid, p_empresas: [...new Set(ids)] });
    if (error) return errorDeRpc(error);
    const conectadas = ((data as unknown[]) ?? []).map((x) =>
      typeof x === "string" ? x : String((x as Record<string, unknown>).holded_para_verificar ?? ""));
    const resultados = await enParalelo(conectadas, 5, async (empresa_id) => {
      const c = await deps.rpc("holded_clave_de", { p_empresa: empresa_id });
      let v: Verificacion;
      if (c.error || typeof c.data !== "string" || !c.data) {
        v = { estado: "error", error: "No se encontró la clave en Vault.", permisos: {}, nif_holded: null, uso: null };
      } else {
        v = await verificarClave(c.data, { fetch: deps.fetchHolded });
      }
      const m = await deps.rpc("holded_marcar_verificacion", {
        p_empresa: empresa_id, p_estado: v.estado, p_error: v.error, p_permisos: v.permisos,
        p_nif_holded: v.nif_holded, p_uso: v.uso,
      });
      if (m.error) return { empresa_id, estado: "error", error: "No se pudo guardar el resultado.", permisos: v.permisos };
      return { empresa_id, estado: v.estado, error: v.error, permisos: v.permisos };
    });
    return ok({ resultados });
  }

  return err(400, "Acción no reconocida.");
}
