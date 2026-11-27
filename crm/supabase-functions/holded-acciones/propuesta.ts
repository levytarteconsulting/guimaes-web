// Propuesta de «aprobar tickets de venta»: lee los tickets pendientes de
// aprobar (borradores) del más antiguo al más reciente, corta en un rango de
// fechas cerrado (todos los pendientes de esos días, como mucho N), separa
// los dudosos y prepara resumen, muestra y avisos. No escribe nada en Holded.

import type { Fetch } from "../_shared/holded.ts";
import { leer } from "./operaciones.ts";
import { finDiaMadrid, medianocheMadrid } from "../holded-proxy/consultas.ts";

export const MAX_DOCUMENTOS = 1000;
export const POR_PAGINA = 100;
export const MAX_PAGINAS = Math.ceil((MAX_DOCUMENTOS + 1) / POR_PAGINA) + 1;   // 12
export const TAM_MUESTRA = 20;
export const MARGEN = 0.3;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

export type Params = { max_documentos: number; desde?: string; hasta?: string };
export type Doc = Record<string, unknown>;
export type Propuesta = {
  ids: string[];
  parametros: Record<string, unknown>;
  resumen: Record<string, unknown>;
  muestra: Record<string, unknown>[];
  excluidos: Record<string, unknown>[];
  avisos: string[];
  llamadas: number;
};
export class ErrorPropuesta extends Error {
  codigo: string;
  constructor(codigo: string, mensaje: string) { super(mensaje); this.codigo = codigo; }
}

export function validarParams(p: unknown): { ok: true; params: Params } | { ok: false; error: string } {
  if (p !== undefined && (typeof p !== "object" || p === null || Array.isArray(p))) return { ok: false, error: "Parámetros no válidos." };
  const x = { ...(p as Record<string, unknown> ?? {}) };
  for (const k of Object.keys(x)) {
    if (!["max_documentos", "desde", "hasta"].includes(k)) return { ok: false, error: `Parámetro desconocido "${k}".` };
    if (x[k] === null) delete x[k];
  }
  const max = x.max_documentos ?? MAX_DOCUMENTOS;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_DOCUMENTOS) {
    return { ok: false, error: `max_documentos tiene que estar entre 1 y ${MAX_DOCUMENTOS}.` };
  }
  for (const k of ["desde", "hasta"]) {
    const v = x[k];
    if (v !== undefined && (typeof v !== "string" || !RE_DIA.test(v) || new Date(Date.parse(v)).toISOString().slice(0, 10) !== v)) {
      return { ok: false, error: `${k} tiene que ser una fecha AAAA-MM-DD.` };
    }
  }
  if (x.desde && x.hasta && (x.hasta as string) < (x.desde as string)) return { ok: false, error: "hasta no puede ser anterior a desde." };
  return { ok: true, params: { max_documentos: max as number, desde: x.desde as string | undefined, hasta: x.hasta as string | undefined } };
}

const cent = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const eur = (c: number) => c / 100;
export function dia(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(v < 1e12 ? v * 1000 : v));
  }
  if (typeof v === "string" && v) {
    if (RE_DIA.test(v)) return v;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(t));
  }
  return null;
}
const txt = (v: unknown, max = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Motivo para no aprobar un documento, o null si se puede. */
export function motivoExclusion(d: Doc): string | null {
  const base = cent(d.subtotal), iva = cent(d.tax), total = cent(d.total), dto = cent(d.discount ?? 0);
  if ([base, iva, total].some((x) => Number.isNaN(x))) return "Importes que no se pueden leer";
  if (!dia(d.date)) return "Sin fecha";
  if (total <= 0) return total === 0 ? "Importe 0" : "Importe negativo";
  if (base < 0 || iva < 0) return "Base o IVA negativos";
  if (iva > Math.round(base * 0.262) + 2) return "IVA incoherente: más del 26,2 % de la base";
  const cuadra = (b: number) => Math.abs(b + iva - total) <= Math.max(5, Math.round(total * 0.01));
  if (!cuadra(base) && !(dto > 0 && cuadra(base - dto))) return "IVA incoherente: base + IVA no cuadra con el total";
  return null;
}

/** Firma para detectar duplicados aparentes. */
function firma(d: Doc): string {
  return JSON.stringify([dia(d.date), d.contact_id ?? txt(d.contact_name), cent(d.total), txt(d.description, 500), d.lines ?? null]);
}

export async function construir(clave: string, p: Params, f: Fetch, cupoAccionesRestante: number | null = null): Promise<Propuesta> {
  let llamadas = 0;
  const todos: Doc[] = [];
  let cursor: string | undefined;
  let hayMas = false;
  for (let pag = 0; pag < MAX_PAGINAS; pag++) {
    llamadas++;
    const r = await leer(clave, "/sales-receipts", {
      approval_status: "draft", sort: "date", limit: POR_PAGINA, cursor,
      start_date: p.desde ? medianocheMadrid(p.desde) : undefined, end_date: p.hasta ? finDiaMadrid(p.hasta) : undefined,
    }, f);
    if (r.status === 401) throw new ErrorPropuesta("401", "Holded rechaza la clave de esta empresa (401).");
    if (r.status === 403) throw new ErrorPropuesta("403", "La clave de Holded de esta empresa no tiene permiso para leer tickets de venta (403).");
    if (r.status === 429) throw new ErrorPropuesta("429", r.ventana === "month"
      ? "Holded dice que esta cuenta ha agotado su cupo mensual de la API."
      : "Holded limita las llamadas por minuto de esta cuenta; inténtalo en un minuto.");
    if (r.status < 200 || r.status >= 300) throw new ErrorPropuesta(String(r.status), `Holded ha respondido con un error (${r.status}) al listar los tickets.`);
    const d = (r.datos ?? {}) as Record<string, unknown>;
    const items = (Array.isArray(d.items) ? d.items : []) as Doc[];
    todos.push(...items);
    const cur = typeof d.cursor === "string" ? d.cursor : null;
    hayMas = d.has_more === true && !!cur;
    if (!hayMas || todos.length > p.max_documentos) break;
    cursor = cur!;
  }
  // El más antiguo primero; a igual fecha, por id (los ObjectId crecen con el tiempo).
  const validos = todos.filter((d) => typeof d.id === "string" && /^[0-9a-f]{24}$/.test(d.id as string));
  validos.sort((a, b) => (dia(a.date) ?? "9999").localeCompare(dia(b.date) ?? "9999") || String(a.id).localeCompare(String(b.id)));
  const masAlla = validos.length > p.max_documentos || hayMas;
  let incl = validos.slice(0, p.max_documentos);
  let diaCorte: string | null = null;
  if (masAlla) {
    diaCorte = validos.length > p.max_documentos ? dia(validos[p.max_documentos].date) : null;
    if (diaCorte === null && hayMas) diaCorte = dia(incl.at(-1)?.date);   // no se ha leído el día siguiente entero
    if (diaCorte) incl = incl.filter((d) => (dia(d.date) ?? "9999") < diaCorte!);
  }
  if (!incl.length) {
    throw new ErrorPropuesta("vacio", validos.length
      ? `Hay más de ${p.max_documentos} tickets pendientes el ${diaCorte}: sube el máximo o elige otro rango.`
      : "No hay tickets de venta pendientes de aprobar" + (p.desde || p.hasta ? " en ese rango." : "."));
  }
  const desde = dia(incl[0].date)!, hasta = dia(incl.at(-1)!.date)!;

  // Dudosos: fuera, y listados aparte.
  const excluidos: Record<string, unknown>[] = [];
  const grupos = new Map<string, Doc[]>();
  for (const d of incl) { const k = firma(d); grupos.set(k, [...(grupos.get(k) ?? []), d]); }
  const numeros = new Map<string, number>();
  for (const d of incl) { const n = txt(d.document_number); if (n) numeros.set(n, (numeros.get(n) ?? 0) + 1); }
  const aprobables: Doc[] = [];
  for (const d of incl) {
    let motivo = motivoExclusion(d);
    const n = txt(d.document_number);
    if (!motivo && ((n && numeros.get(n)! > 1) || grupos.get(firma(d))!.length > 1)) motivo = "Posible duplicado (misma fecha, cliente, importe y líneas que otro)";
    if (motivo) excluidos.push({ id: d.id, fecha: dia(d.date), total: Number.isNaN(cent(d.total)) ? null : eur(cent(d.total)), motivo });
    else aprobables.push(d);
  }
  if (!aprobables.length) throw new ErrorPropuesta("vacio", `Los ${incl.length} tickets pendientes del rango tienen problemas y no se proponen.`);

  const sum = (k: string) => aprobables.reduce((a, d) => a + cent(d[k]), 0);
  const monedas = [...new Set(aprobables.map((d) => (txt(d.currency, 8) ?? "eur").toUpperCase()))];
  const paso = aprobables.length <= TAM_MUESTRA ? 1 : (aprobables.length - 1) / (TAM_MUESTRA - 1);
  const muestra = [...new Set(Array.from({ length: Math.min(TAM_MUESTRA, aprobables.length) }, (_, i) => Math.round(i * paso)))]
    .map((i) => aprobables[i]).map((d) => ({
      id: d.id, fecha: dia(d.date), contacto: txt(d.contact_name), descripcion: txt(d.description, 60),
      base: eur(cent(d.subtotal)), iva: eur(cent(d.tax)), total: eur(cent(d.total)),
    }));

  // Cupo de la API de Holded de la cuenta (una lectura).
  const avisos: string[] = [];
  llamadas++;
  const uso = await leer(clave, "/usage", {}, f);
  const necesarias = aprobables.length;
  const conMargen = Math.ceil(necesarias * (1 + MARGEN));
  if (uso.status === 200 && uso.datos && typeof uso.datos === "object") {
    const u = uso.datos as Record<string, unknown>;
    const usadas = Number(u.usage), limite = Number(u.limit);
    if (Number.isFinite(usadas) && Number.isFinite(limite) && limite > 0) {
      const quedan = limite - usadas;
      avisos.push(`Cupo de la API de Holded de la cuenta (${String(u.period ?? "este mes")}): ${usadas} de ${limite} usadas, quedan ${quedan}. ` +
        `Esta acción necesita ${necesarias} llamadas (${conMargen} con un 30 % de margen para el TPV y otras integraciones).`);
      if (quedan < conMargen) {
        avisos.push(`⚠ No hay margen suficiente: con lo que queda se podrían aprobar unos ${Math.max(0, Math.floor(quedan / (1 + MARGEN)))} este mes.`);
      }
    }
  } else {
    avisos.push("No se ha podido leer el cupo de la API de Holded de la cuenta.");
  }
  if (cupoAccionesRestante !== null && cupoAccionesRestante < necesarias) {
    avisos.push(`⚠ El cupo de acciones de esta empresa para este mes solo cubre ${Math.max(0, cupoAccionesRestante)} documentos: la ejecución se pausará al llegar.`);
  }
  avisos.push("Aprobar asigna a cada ticket el siguiente número de su serie y fija la fecha de aprobación. Un ticket aprobado ya no se puede modificar ni borrar en Holded: solo anular o rectificar.");
  avisos.push("Si la cuenta tiene VeriFactu activado, cada ticket aprobado genera su registro de facturación y Holded lo envía a la AEAT. Eso no se puede deshacer.");
  avisos.push(`Holded no aprueba tickets en lote: se aprueban de uno en uno, del más antiguo al más reciente, con ${necesarias} llamadas a la API.`);
  if (excluidos.length) avisos.push(`${excluidos.length} ticket(s) del rango no se aprueban por dudosos (importe 0 o negativo, IVA incoherente o posible duplicado): se quedan pendientes en Holded y se listan aparte.`);
  if (masAlla) avisos.push(`Hay más tickets pendientes después del ${hasta}: no se tocan.`);

  return {
    ids: aprobables.map((d) => d.id as string),
    parametros: { max_documentos: p.max_documentos, ...(p.desde ? { desde_pedido: p.desde } : {}), ...(p.hasta ? { hasta_pedido: p.hasta } : {}),
                  desde, hasta },
    resumen: {
      documentos: aprobables.length, base: eur(sum("subtotal")), iva: eur(sum("tax")), total: eur(sum("total")),
      moneda: monedas.length === 1 ? monedas[0] : monedas.join(", "), desde, hasta,
      pendientes_en_rango: incl.length, excluidos: excluidos.length, mas_pendientes_despues: masAlla,
    },
    muestra, excluidos: excluidos.slice(0, 500), avisos, llamadas,
  };
}
