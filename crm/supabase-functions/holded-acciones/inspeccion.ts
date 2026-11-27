// Inspección de SOLO LECTURA de los tickets de venta de una empresa en un
// rango de días (solo el operador, con x-hook-secret). Sirve para decidir una
// propuesta: cuántos hay, totales, estado de aprobación y numeración. Usa solo
// GET /sales-receipts (de la lista cerrada). No devuelve clientes, conceptos
// ni líneas: recuentos, importes, números de documento y NOMBRES de campos.

import type { Fetch } from "../_shared/holded.ts";
import { finDiaMadrid, medianocheMadrid } from "../holded-proxy/consultas.ts";
import { leer } from "./operaciones.ts";
import { dia, ErrorPropuesta } from "./propuesta.ts";

export const MAX_PAGINAS_INSPECCION = 30;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_ID = /^[0-9a-f]{24}$/;
const CAMPOS_NUMERO = ["document_number", "doc_number", "number", "num", "draft_number", "tpv_number", "series", "serie", "numbering_series_id"];
const CAMPOS_APROBACION = ["approval_status", "approved", "approved_at", "approval_date", "status", "draft"];

export type ParamsInspeccion = { desde: string; hasta: string; solo_pendientes: boolean; ids?: string[] };

export function validarInspeccion(p: unknown): { ok: true; params: ParamsInspeccion } | { ok: false; error: string } {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "Parámetros no válidos." };
  const x = p as Record<string, unknown>;
  for (const k of Object.keys(x)) if (!["desde", "hasta", "solo_pendientes", "ids"].includes(k)) return { ok: false, error: `Parámetro desconocido "${k}".` };
  for (const k of ["desde", "hasta"]) {
    const v = x[k];
    if (typeof v !== "string" || !RE_DIA.test(v) || new Date(Date.parse(v)).toISOString().slice(0, 10) !== v) return { ok: false, error: `${k} tiene que ser AAAA-MM-DD.` };
  }
  if ((x.hasta as string) < (x.desde as string)) return { ok: false, error: "hasta no puede ser anterior a desde." };
  if ((Date.parse(x.hasta as string) - Date.parse(x.desde as string)) / 86_400_000 > 31) return { ok: false, error: "Como mucho 31 días." };
  if (x.ids !== undefined && (!Array.isArray(x.ids) || x.ids.length > 20 || x.ids.some((i) => typeof i !== "string" || !RE_ID.test(i)))) {
    return { ok: false, error: "ids: como mucho 20 ids de Holded." };
  }
  return { ok: true, params: { desde: x.desde as string, hasta: x.hasta as string, solo_pendientes: x.solo_pendientes !== false, ids: x.ids as string[] | undefined } };
}

const cent = (v: unknown) => { const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const prefijo = (n: string) => n.replace(/[0-9]+$/, "") || "(solo cifras)";
const corto = (v: unknown) => v === null || v === undefined ? null : typeof v === "object" ? "{…}" : String(v).slice(0, 40);

export async function inspeccionar(clave: string, p: ParamsInspeccion, f: Fetch) {
  const docs: Record<string, unknown>[] = [];
  let cursor: string | undefined, llamadas = 0, completo = false;
  for (let pag = 0; pag < MAX_PAGINAS_INSPECCION; pag++) {
    llamadas++;
    const r = await leer(clave, "/sales-receipts", {
      ...(p.solo_pendientes ? { approval_status: "draft" } : {}), sort: "date", limit: 100, cursor,
      start_date: medianocheMadrid(p.desde), end_date: finDiaMadrid(p.hasta),
    }, f);
    if (r.status < 200 || r.status >= 300) throw new ErrorPropuesta(String(r.status), `Holded ha respondido ${r.status} al listar los tickets.`);
    const d = (r.datos ?? {}) as Record<string, unknown>;
    docs.push(...((Array.isArray(d.items) ? d.items : []) as Record<string, unknown>[]));
    const cur = typeof d.cursor === "string" ? d.cursor : null;
    if (!(d.has_more === true && cur)) { completo = true; break; }
    cursor = cur;
  }
  const porDia: Record<string, { documentos: number; total: number }> = {};
  const aprob: Record<string, number> = {};
  const prefijos: Record<string, number> = {};
  const numeros: string[] = [];
  const campos = new Set<string>();
  const porDraft: Record<string, number> = {};
  let base = 0, iva = 0, total = 0;
  for (const d of docs) {
    Object.keys(d).forEach((k) => campos.add(k));
    const k = dia(d.date) ?? "sin fecha";
    porDia[k] ??= { documentos: 0, total: 0 };
    porDia[k].documentos++; porDia[k].total += cent(d.total);
    base += cent(d.subtotal); iva += cent(d.tax); total += cent(d.total);
    const a = `approval_status=${String(d.approval_status ?? "—")} draft=${String(d.draft ?? "—")} status=${String(d.status ?? "—")}`;
    aprob[a] = (aprob[a] ?? 0) + 1;
    const pre = `${String(d.draft)}:${typeof d.document_number === "string" && d.document_number.trim() ? prefijo(d.document_number.trim()) : "(sin número)"}`;
    porDraft[pre] = (porDraft[pre] ?? 0) + 1;
    const n = typeof d.document_number === "string" && d.document_number.trim() ? d.document_number.trim() : null;
    if (n) { numeros.push(n); prefijos[prefijo(n)] = (prefijos[prefijo(n)] ?? 0) + 1; } else prefijos["(sin número)"] = (prefijos["(sin número)"] ?? 0) + 1;
  }
  numeros.sort((x, y) => x.localeCompare(y, "es", { numeric: true }));
  const camposDe = (d: Record<string, unknown>) => Object.fromEntries(
    Object.keys(d).filter((k) => CAMPOS_NUMERO.includes(k) || CAMPOS_APROBACION.includes(k) || /number|serie|approv|draft/i.test(k)).map((k) => [k, corto(d[k])]));
  return {
    rango: { desde: p.desde, hasta: p.hasta, solo_pendientes: p.solo_pendientes }, completo, llamadas,
    documentos: docs.length, base: base / 100, iva: iva / 100, total: total / 100,
    por_dia: Object.fromEntries(Object.entries(porDia).sort().map(([k, v]) => [k, { documentos: v.documentos, total: v.total / 100 }])),
    estado_aprobacion: aprob,
    numeracion_por_draft: porDraft,
    numeracion: { prefijos, primero: numeros[0] ?? null, ultimo: numeros.at(-1) ?? null, con_numero: numeros.length },
    campos: [...campos].sort(),
    ejemplos_numeracion: docs.slice(0, 3).map(camposDe),
    ...(p.ids ? { por_id: p.ids.map((id) => { const d = docs.find((x) => x.id === id); return d ? { id, ...camposDe(d) } : { id, encontrado: false }; }) } : {}),
  };
}
