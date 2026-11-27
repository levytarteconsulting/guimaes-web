// Propuesta de una OPERACIÓN genérica en Holded (cualquier escritura de la
// lista cerrada): valida método, ruta y cuerpo contra el catálogo, arma las
// peticiones (una, o un lote de hasta 100 sobre una lista de ids o de
// cuerpos), lee con GET el estado actual de cada documento que se modifica o
// se borra, y prepara resumen, muestra y avisos. No escribe nada en Holded.

import type { Fetch } from "../_shared/holded.ts";
import { type Casada, documentoDe, encontrarOperacion, lecturaDe, type Operacion } from "./catalogo.ts";
import { leerDocumento } from "./operaciones.ts";
import { ErrorPropuesta } from "./propuesta.ts";

export const MAX_LOTE = 100;
export const MAX_CUERPO = 60_000;            // bytes de JSON por petición
export const MAX_ESTADO = 60_000;            // bytes del estado anterior guardado
export const PLAZO_LECTURAS_MS = 35_000;
const RE_ID = /^[0-9a-f]{24}$/;
const vacio = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)
  || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const META = new Set(["id", "_id", "created_at", "updated_at", "createdAt", "updatedAt", "document_number", "status", "draft",
  "payments_total", "payments_pending", "verifactu_status", "sii_status", "ticket_bai_status", "approved_at", "approval_status"]);

export type Peticion = { metodo: string; ruta: string; cuerpo?: unknown; holded_id?: string | null; estado_anterior?: unknown };
export type PropuestaOperacion = {
  operacion: Operacion; descripcion: string; peticiones: Peticion[];
  resumen: Record<string, unknown>; muestra: Record<string, unknown>[]; avisos: string[]; llamadas: number;
};

const mal = (m: string) => new ErrorPropuesta("22023", m);

/** Valida la entrada y arma las peticiones (sin llamar a Holded). */
export function armarPeticiones(b: Record<string, unknown>): { casadas: Casada[]; peticiones: Peticion[]; descripcion: string } {
  const metodo = typeof b.metodo === "string" ? b.metodo.toUpperCase() : "";
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(metodo)) throw mal("metodo tiene que ser POST, PUT, PATCH o DELETE.");
  let ruta = typeof b.ruta === "string" ? b.ruta.trim() : "";
  if (ruta.startsWith("https://api.holded.com")) ruta = ruta.slice("https://api.holded.com".length);
  if (ruta.startsWith("/api/v2/")) ruta = ruta.slice("/api/v2".length);
  if (!ruta.startsWith("/") || ruta.length > 300) throw mal("ruta tiene que ser una ruta de la API v2, por ejemplo /invoices o /contacts/{id}.");
  const descripcion = typeof b.descripcion === "string" ? b.descripcion.trim() : "";
  if (descripcion.length < 3 || descripcion.length > 300) throw mal("Falta la descripción legible (3 a 300 caracteres).");
  const lote = b.lote === undefined || b.lote === null ? null : b.lote;
  if (lote !== null && (typeof lote !== "object" || Array.isArray(lote))) throw mal("lote tiene que ser { ids: [...] } o { cuerpos: [...] }.");
  const l = (lote ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(l)) if (!["ids", "cuerpos"].includes(k)) throw mal(`lote: parámetro desconocido "${k}".`);
  if (l.ids !== undefined && l.cuerpos !== undefined) throw mal("lote: usa ids o cuerpos, no los dos.");

  let peticiones: Peticion[];
  if (Array.isArray(l.ids)) {
    const ids = l.ids as unknown[];
    if (!ids.length || ids.length > MAX_LOTE) throw mal(`lote.ids: entre 1 y ${MAX_LOTE} ids.`);
    if (ids.some((x) => typeof x !== "string" || !RE_ID.test(x))) throw mal("lote.ids: ids de Holded (24 caracteres hexadecimales).");
    if (new Set(ids).size !== ids.length) throw mal("lote.ids: hay ids repetidos.");
    if ((ruta.match(/\{id\}/g) ?? []).length !== 1) throw mal("Con lote.ids la ruta lleva {id} una vez, por ejemplo /contacts/{id}.");
    peticiones = (ids as string[]).map((id) => ({ metodo, ruta: ruta.replace("{id}", id), cuerpo: b.cuerpo }));
  } else if (Array.isArray(l.cuerpos)) {
    const cs = l.cuerpos as unknown[];
    if (!cs.length || cs.length > MAX_LOTE) throw mal(`lote.cuerpos: entre 1 y ${MAX_LOTE} cuerpos.`);
    if (b.cuerpo !== undefined && b.cuerpo !== null) throw mal("Con lote.cuerpos no se manda cuerpo aparte.");
    peticiones = cs.map((c) => ({ metodo, ruta, cuerpo: c }));
  } else if (lote !== null) {
    throw mal("lote tiene que ser { ids: [...] } o { cuerpos: [...] }.");
  } else {
    peticiones = [{ metodo, ruta, cuerpo: b.cuerpo }];
  }

  const casadas: Casada[] = [];
  for (const p of peticiones) {
    const c = encontrarOperacion(p.metodo, p.ruta);
    if (!c) throw mal(`${p.metodo} ${p.ruta.replace(/[0-9a-f]{24}/g, "{id}")} no está en la lista cerrada de operaciones de la API v2 de Holded. Consulta holded_documentacion.`);
    if (casadas.length && c.op.id !== casadas[0].op.id) throw mal("Todas las peticiones de un lote tienen que ser la misma operación.");
    casadas.push(c);
    const op = c.op;
    const cuerpo = p.cuerpo === null ? undefined : p.cuerpo;
    if (op.cuerpo === "ninguno" && cuerpo !== undefined) throw mal(`${op.metodo} ${op.ruta} no lleva cuerpo.`);
    if (op.cuerpo === "json") {
      if (cuerpo === undefined) {
        if (op.cuerpo_obligatorio || op.requeridos.length) throw mal(`${op.metodo} ${op.ruta} necesita un cuerpo${op.requeridos.length ? ` con: ${op.requeridos.join(", ")}` : ""}.`);
      } else {
        if (typeof cuerpo !== "object") throw mal("El cuerpo tiene que ser un objeto JSON.");
        if (bytes(cuerpo) > MAX_CUERPO) throw mal(`El cuerpo pasa de ${MAX_CUERPO / 1000} KB.`);
        if (!Array.isArray(cuerpo)) {
          const faltan = op.requeridos.filter((k) => vacio((cuerpo as Record<string, unknown>)[k]));
          if (faltan.length) throw mal(`Faltan campos obligatorios de ${op.id}: ${faltan.join(", ")}.`);
        }
      }
    }
    p.cuerpo = cuerpo;
    p.holded_id = documentoDe(c);
  }
  return { casadas, peticiones, descripcion };
}

export async function construirOperacion(clave: string, b: Record<string, unknown>, f: Fetch,
  opciones: { ahora?: () => number } = {}): Promise<PropuestaOperacion> {
  const ahora = opciones.ahora ?? Date.now;
  const { casadas, peticiones, descripcion } = armarPeticiones(b);
  const op = casadas[0].op;
  const avisos: string[] = [];
  let llamadas = 0, noLeidos = 0, noExisten = 0;
  const camposPerdidos = new Set<string>();

  // Estado anterior de lo que se modifica o se borra (no de lo que se crea).
  const inicio = ahora();
  for (let i = 0; i < peticiones.length; i++) {
    const lec = lecturaDe(casadas[i]);
    if (!lec || (op.metodo === "POST" && !/\{[^}]+\}/.test(op.ruta))) continue;
    if (ahora() - inicio > PLAZO_LECTURAS_MS) { noLeidos++; continue; }
    llamadas++;
    const r = await leerDocumento(clave, lec, f).catch(() => ({ status: 0, datos: null }));
    if (r.status === 401 || r.status === 403) throw new ErrorPropuesta(String(r.status), r.status === 401 ? "Holded rechaza la clave de esta empresa (401)." : "La clave de Holded de esta empresa no tiene permiso para leer ese documento (403).");
    if (r.status === 404) { noExisten++; peticiones[i].estado_anterior = { no_encontrado: true }; continue; }
    if (r.status !== 200) { noLeidos++; continue; }
    let est = r.datos;
    if (bytes(est) > MAX_ESTADO) est = { truncado: true, campos: est && typeof est === "object" ? Object.keys(est as object) : [] };
    peticiones[i].estado_anterior = est;
    const cuerpo = peticiones[i].cuerpo;
    if (op.reemplaza_todo && est && typeof est === "object" && cuerpo && typeof cuerpo === "object" && !Array.isArray(cuerpo)) {
      for (const [k, v] of Object.entries(est as Record<string, unknown>)) {
        if (!META.has(k) && !vacio(v) && !(k in (cuerpo as object))) camposPerdidos.add(k);
      }
    }
  }

  const n = peticiones.length;
  if (op.riesgo === "alto") avisos.push(`RIESGO ALTO: ${op.motivo_riesgo ?? "operación sensible"}. Para aprobarla hay que escribir CONFIRMAR.`);
  if (op.metodo === "DELETE") avisos.push("Borrar en Holded no se puede deshacer.");
  if (op.metodo === "POST" && !/\{[^}]+\}/.test(op.ruta)) avisos.push(`Crea ${n} documento(s) nuevo(s) en Holded.`);
  if (camposPerdidos.size) {
    avisos.push(`⚠ ${op.metodo} ${op.ruta} reemplaza el documento entero, y el cuerpo no incluye estos campos que hoy tienen valor: ` +
      [...camposPerdidos].slice(0, 15).join(", ") + (camposPerdidos.size > 15 ? "…" : "") + ". Comprueba que no se pierdan.");
  }
  if (noExisten) avisos.push(`⚠ ${noExisten} documento(s) no existen en Holded (404): esas peticiones fallarán.`);
  if (noLeidos) avisos.push(`No se ha podido leer el estado actual de ${noLeidos} documento(s).`);
  if (n > 1) avisos.push(`Se ejecuta de una en una: ${n} llamadas a la API de Holded.`);

  return {
    operacion: op, descripcion, peticiones,
    resumen: { descripcion, operacion: op.id, metodo: op.metodo, ruta: op.ruta, tema: op.tema, resumen_operacion: op.resumen,
               documentos: n, riesgo: op.riesgo, lecturas: llamadas },
    muestra: peticiones.slice(0, 20).map((p, i) => ({ orden: i + 1, ruta: p.ruta, holded_id: p.holded_id ?? null })),
    avisos, llamadas,
  };
}
