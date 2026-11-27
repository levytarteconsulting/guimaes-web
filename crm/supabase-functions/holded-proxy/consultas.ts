// Consultas de solo lectura a Holded para el asistente (holded-proxy).
//
// SOLO LECTURA, en dos capas:
//   1. RUTAS es la lista cerrada de rutas que se pueden pedir. lector()
//      rechaza cualquier otra antes de tocar la red.
//   2. fetchSoloLectura() envuelve el fetch real: solo deja pasar GET a
//      https://api.holded.com/api/v2 + una ruta de RUTAS. Cualquier otro
//      método, host o ruta lanza un error y no sale ninguna petición.
// Las pruebas (holded-proxy_test.ts) fallan si se intenta otro método o una
// ruta fuera de la lista, y si aparece en este código un método de escritura.
//
// Cada consulta tiene un máximo de llamadas a la API (MAX_LLAMADAS, con el
// reintento incluido), que es lo que se reserva del cupo mensual de la
// empresa (holded_iniciar). Si la reserva es menor, la consulta se corta y
// sale con truncado: true.

import { type Fetch, HOLDED_BASE, holdedGet, type RespuestaHolded } from "../_shared/holded.ts";

export const RUTAS = [
  "/invoices", "/credit-notes", "/purchases", "/purchase-refunds",
  "/contacts", "/contacts/search", "/treasury/accounts",
] as const;
export type Ruta = typeof RUTAS[number];

export const TIPOS = ["facturas", "resumen", "contactos", "tesoreria"] as const;
export type Tipo = typeof TIPOS[number];

export const MAX_PAGINAS = 5;           // por ruta y consulta (500 documentos)
export const POR_PAGINA = 100;
export const MAX_RETRY_AFTER_S = 10;
export const MAX_DIAS = 400;
export const MAX_LLAMADAS: Record<Tipo, number> = {
  facturas: 2 * MAX_PAGINAS + 1,        // facturas (+ rectificativas) + 1 reintento
  resumen: 4 * MAX_PAGINAS + 1,         // 4 series + 1 reintento
  contactos: 2,
  tesoreria: 2,
};
export const ESTADOS = ["pending", "completed", "partial", "cancelled", "failed", "overdue", "outstanding"] as const;
export const TIPOS_CONTACTO = ["client", "supplier", "lead", "debtor", "creditor"] as const;

// ---------------------------------------------------------------- solo lectura
/** fetch que solo deja salir GET a la API v2 de Holded y a una ruta de la lista. */
export function fetchSoloLectura(base: Fetch): Fetch {
  return (url, init) => {
    const metodo = (init?.method ?? "GET").toUpperCase();
    if (metodo !== "GET") throw new Error(`Holded: método ${metodo} no permitido (solo lectura)`);
    const u = new URL(url);
    const b = new URL(HOLDED_BASE);
    const ruta = u.pathname.startsWith(b.pathname) ? u.pathname.slice(b.pathname.length) : null;
    if (u.origin !== b.origin || ruta === null || !(RUTAS as readonly string[]).includes(ruta)) {
      throw new Error("Holded: ruta no permitida (solo lectura)");
    }
    return base(url, init);
  };
}

export class Corte extends Error {
  readonly codigo: string;
  readonly mensaje: string;
  constructor(codigo: string, mensaje: string) { super(mensaje); this.codigo = codigo; this.mensaje = mensaje; }
}

type Pagina = { items: Record<string, unknown>[]; cursor: string | null; hayMas: boolean };

/** Lector de una consulta: cuenta llamadas, respeta la reserva y el plazo,
 *  reintenta una vez un 429 por minuto y corta en los errores. */
export function lector(clave: string, opciones: {
  fetch: Fetch; reservadas: number; plazo: number; ahora?: () => number;
  esperar?: (ms: number) => Promise<void>; timeoutMs?: number;
}) {
  const ahora = opciones.ahora ?? Date.now;
  const esperar = opciones.esperar ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let reintentado = false;
  const estado = { llamadas: 0, truncado: false, motivo: null as null | "paginas" | "cupo" | "tiempo" };

  async function una(ruta: Ruta, params: Record<string, string | number | undefined>): Promise<RespuestaHolded | null> {
    if (!(RUTAS as readonly string[]).includes(ruta)) throw new Error("Holded: ruta no permitida (solo lectura)");
    while (true) {
      if (estado.llamadas >= opciones.reservadas) { estado.truncado = true; estado.motivo = "cupo"; return null; }
      if (ahora() >= opciones.plazo) { estado.truncado = true; estado.motivo = "tiempo"; return null; }
      estado.llamadas++;
      const r = await holdedGet(clave, ruta, params, { fetch: opciones.fetch, timeoutMs: opciones.timeoutMs ?? 10_000 });
      if (r.status === 429) {
        if (r.ventana === "month") {
          throw new Corte("429-mes", "Holded dice que esta cuenta ha agotado su cupo mensual de llamadas a la API. No hay datos hasta el mes que viene (o hasta que el cliente amplíe su plan de Holded).");
        }
        const s = r.retryAfter ?? 2;
        if (reintentado || s > MAX_RETRY_AFTER_S) {
          throw new Corte("429-minuto", "Holded limita las llamadas por minuto de esta cuenta y ahora no responde. Inténtalo dentro de un minuto.");
        }
        reintentado = true;
        await esperar(Math.max(0, s) * 1000);
        continue;
      }
      if (r.status === 401) throw new Corte("401", "Holded rechaza la clave de esta empresa (401): puede estar revocada o caducada. Hay que volver a cargarla en Configuración → Integraciones → Holded.");
      if (r.status === 403) throw new Corte("403", `La clave de Holded de esta empresa no tiene permiso para leer ${QUE[ruta]} (403).`);
      if (r.status === 0) throw new Corte("red", "No se ha podido contactar con Holded (sin respuesta o tiempo agotado).");
      if (r.status < 200 || r.status >= 300) throw new Corte(String(r.status), `Holded ha respondido con un error (${r.status}).`);
      return r;
    }
  }

  async function pagina(ruta: Ruta, params: Record<string, string | number | undefined>): Promise<Pagina | null> {
    const r = await una(ruta, params);
    if (!r) return null;
    const d = (r.datos ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d.items) ? d.items as Record<string, unknown>[] : Array.isArray(r.datos) ? r.datos as Record<string, unknown>[] : [];
    const cur = d.cursor as unknown;
    const cursor = typeof cur === "string" ? cur
      : cur && typeof cur === "object" && typeof (cur as Record<string, unknown>).next === "string" ? (cur as Record<string, string>).next : null;
    return { items, cursor, hayMas: d.has_more === true && !!cursor };
  }

  /** Todas las páginas (hasta MAX_PAGINAS) de una ruta. */
  async function todas(ruta: Ruta, params: Record<string, string | number | undefined>) {
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < MAX_PAGINAS; n++) {
      const p = await pagina(ruta, { ...params, limit: POR_PAGINA, cursor });
      if (!p) return items;
      items.push(...p.items);
      if (!p.hayMas) return items;
      cursor = p.cursor!;
    }
    estado.truncado = true;
    estado.motivo ??= "paginas";
    return items;
  }

  return { estado, pagina, todas };
}

const QUE: Record<Ruta, string> = {
  "/invoices": "facturas", "/credit-notes": "facturas rectificativas", "/purchases": "compras",
  "/purchase-refunds": "rectificativas de compras", "/contacts": "contactos", "/contacts/search": "contactos",
  "/treasury/accounts": "cuentas de tesorería",
};

// ---------------------------------------------------------------- validación
export type Params = Record<string, unknown>;
type Valida = { ok: true; params: Params } | { ok: false; error: string };
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_ID_HOLDED = /^[A-Za-z0-9_-]{1,64}$/;

function dia(v: unknown): number | null {
  if (typeof v !== "string" || !RE_DIA.test(v)) return null;
  const t = Date.parse(v + "T00:00:00Z");
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? null : t;
}
function periodo(p: Params): string | null {
  const d = dia(p.desde), h = dia(p.hasta);
  if (d === null || h === null) return "desde y hasta tienen que ser fechas AAAA-MM-DD";
  if (h < d) return "hasta no puede ser anterior a desde";
  if ((h - d) / 86_400_000 > MAX_DIAS) return `el periodo no puede pasar de ${MAX_DIAS} días`;
  return null;
}
function soloClaves(p: Params, permitidas: string[]): string | null {
  const otra = Object.keys(p).find((k) => !permitidas.includes(k));
  return otra ? `parámetro desconocido "${otra}"` : null;
}

/** Valida los parámetros de una consulta (otra vez: el agente ya lo hizo). */
export function validar(tipo: string, entrada: unknown): Valida {
  if (!(TIPOS as readonly string[]).includes(tipo)) return { ok: false, error: "Consulta de Holded no válida." };
  if (entrada !== undefined && (typeof entrada !== "object" || entrada === null || Array.isArray(entrada))) {
    return { ok: false, error: "Parámetros no válidos." };
  }
  const p = { ...(entrada as Params ?? {}) };
  for (const k of Object.keys(p)) if (p[k] === null || p[k] === undefined) delete p[k];
  const mal = (e: string): Valida => ({ ok: false, error: e.charAt(0).toUpperCase() + e.slice(1) + "." });
  let e: string | null;
  switch (tipo as Tipo) {
    case "facturas":
      if ((e = soloClaves(p, ["tipo", "desde", "hasta", "estado", "contacto_id", "rectificativas", "limite"]))) return mal(e);
      if (p.tipo !== "emitidas" && p.tipo !== "recibidas") return mal('tipo tiene que ser "emitidas" o "recibidas"');
      if ((e = periodo(p))) return mal(e);
      if (p.estado !== undefined && !(ESTADOS as readonly unknown[]).includes(p.estado)) return mal(`estado: ${ESTADOS.join(", ")}`);
      if (p.contacto_id !== undefined && (typeof p.contacto_id !== "string" || !RE_ID_HOLDED.test(p.contacto_id))) return mal("contacto_id no válido");
      if (p.rectificativas !== undefined && typeof p.rectificativas !== "boolean") return mal("rectificativas tiene que ser true o false");
      if (p.limite !== undefined && !(Number.isInteger(p.limite) && (p.limite as number) >= 1 && (p.limite as number) <= 100)) return mal("limite entre 1 y 100");
      return { ok: true, params: p };
    case "resumen":
      if ((e = soloClaves(p, ["desde", "hasta"]))) return mal(e);
      if ((e = periodo(p))) return mal(e);
      return { ok: true, params: p };
    case "contactos":
      if ((e = soloClaves(p, ["nombre", "tipo", "limite"]))) return mal(e);
      if (p.nombre !== undefined && (typeof p.nombre !== "string" || p.nombre.trim().length < 2 || p.nombre.length > 100)) return mal("nombre: entre 2 y 100 caracteres");
      if (p.tipo !== undefined && !(TIPOS_CONTACTO as readonly unknown[]).includes(p.tipo)) return mal(`tipo: ${TIPOS_CONTACTO.join(", ")}`);
      if (p.limite !== undefined && !(Number.isInteger(p.limite) && (p.limite as number) >= 1 && (p.limite as number) <= 100)) return mal("limite entre 1 y 100");
      return { ok: true, params: p };
    case "tesoreria":
      if ((e = soloClaves(p, []))) return mal(e);
      return { ok: true, params: p };
  }
}

/** Clave de la caché: empresa, consulta y parámetros en orden estable. */
export function claveCache(empresa: string, tipo: string, p: Params): string {
  return `${empresa}|${tipo}|${JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]))}`;
}

// ---------------------------------------------------------------- utilidades de datos
/** Medianoche de un día AAAA-MM-DD en Madrid, en RFC 3339 con su desfase. */
export function medianocheMadrid(diaIso: string): string {
  const [a, m, d] = diaIso.split("-").map(Number);
  const guess = Date.UTC(a, m - 1, d);
  const partes = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const comoUtc = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute);
  const min = Math.round((comoUtc - guess) / 60_000);   // +60 o +120
  const s = min >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(min) / 60)).padStart(2, "0"), mm = String(Math.abs(min) % 60).padStart(2, "0");
  return `${diaIso}T00:00:00${s}${hh}:${mm}`;
}
function diaSiguiente(diaIso: string): string {
  return new Date(Date.parse(diaIso + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
}
/** Final del día "hasta" (incluido) en Madrid: 23:59:59 con el desfase de
 *  esa hora (el del día siguiente a medianoche; el cambio de hora es a las 2-3). */
export function finDiaMadrid(diaIso: string): string {
  return `${diaIso}T23:59:59${medianocheMadrid(diaSiguiente(diaIso)).slice(19)}`;
}

const cent = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const eur = (c: number) => c / 100;
const txt = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
function fecha(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString().slice(0, 10);
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
    }
    return v.slice(0, 10);
  }
  return null;
}
const moneda = (d: Record<string, unknown>) => (txt(d.currency, 8) ?? "eur").toUpperCase();

type Totales = { documentos: number; base: number; impuestos: number; total: number; pendiente: number };
const totalesVacios = (): Totales => ({ documentos: 0, base: 0, impuestos: 0, total: 0, pendiente: 0 });
function sumar(t: Record<string, Totales>, d: Record<string, unknown>, signo = 1) {
  const m = moneda(d);
  const x = (t[m] ??= totalesVacios());
  x.documentos++;
  x.base += signo * Math.abs(cent(d.subtotal));
  x.impuestos += signo * Math.abs(cent(d.tax));
  x.total += signo * Math.abs(cent(d.total));
  x.pendiente += signo * Math.abs(cent(d.payments_pending));
}
const enEuros = (t: Record<string, Totales>) => Object.fromEntries(Object.entries(t).map(([m, x]) =>
  [m, { documentos: x.documentos, base: eur(x.base), impuestos: eur(x.impuestos), total: eur(x.total), pendiente: eur(x.pendiente) }]));

/** Separa borradores y anuladas (no cuentan en los totales salvo que se pidan). */
function cuentan(d: Record<string, unknown>, estadoPedido?: unknown): boolean {
  if (d.draft === true) return false;
  if (d.status === "cancelled" && estadoPedido !== "cancelled") return false;
  return true;
}

// ---------------------------------------------------------------- consultas
export type Lector = ReturnType<typeof lector>;

export async function ejecutar(tipo: Tipo, p: Params, l: Lector): Promise<Record<string, unknown>> {
  switch (tipo) {
    case "facturas": return await facturas(p, l);
    case "resumen": return await resumen(p, l);
    case "contactos": return await contactos(p, l);
    case "tesoreria": return await tesoreria(l);
  }
}

function filtrosPeriodo(p: Params) {
  return { start_date: medianocheMadrid(p.desde as string), end_date: finDiaMadrid(p.hasta as string) };
}

async function facturas(p: Params, l: Lector) {
  const emitidas = p.tipo === "emitidas";
  const filtros = { ...filtrosPeriodo(p), status: p.estado as string | undefined, contact_id: p.contacto_id as string | undefined };
  const docs = (await l.todas(emitidas ? "/invoices" : "/purchases", filtros)).map((d) => ({ d, rect: false }));
  if (p.rectificativas) {
    docs.push(...(await l.todas(emitidas ? "/credit-notes" : "/purchase-refunds", filtros)).map((d) => ({ d, rect: true })));
  }
  const totales: Record<string, Totales> = {};
  const rect: Record<string, Totales> = {};
  let borradores = 0, anuladas = 0;
  for (const { d, rect: r } of docs) {
    if (d.draft === true) { borradores++; continue; }
    if (!cuentan(d, p.estado)) { anuladas++; continue; }
    sumar(r ? rect : totales, d);
  }
  const limite = (p.limite as number | undefined) ?? 50;
  const lista = docs.filter(({ d }) => d.draft !== true)
    .sort((a, b) => String(fecha(b.d.date)).localeCompare(String(fecha(a.d.date))))
    .slice(0, limite)
    .map(({ d, rect: r }) => ({
      id: txt(d.id, 64), numero: txt(d.document_number ?? d.docNumber, 40), fecha: fecha(d.date), vencimiento: fecha(d.due_date),
      contacto: txt(d.contact_name), contacto_id: txt(d.contact_id, 64), base: eur(cent(d.subtotal)), impuestos: eur(cent(d.tax)),
      total: eur(cent(d.total)), pendiente: eur(cent(d.payments_pending)), estado: txt(d.status, 20), moneda: moneda(d),
      ...(r ? { rectificativa: true } : {}),
    }));
  return {
    tipo: emitidas ? "facturas emitidas (ventas)" : "facturas recibidas (compras y gastos)",
    periodo: { desde: p.desde, hasta: p.hasta }, ...(p.estado ? { estado: p.estado } : {}),
    totales_por_moneda: enEuros(totales),
    ...(p.rectificativas ? { rectificativas_por_moneda: enEuros(rect) } : {}),
    excluidas_de_los_totales: { borradores, anuladas },
    documentos: lista, documentos_en_total: docs.length - borradores,
    ...(docs.length - borradores > lista.length ? { nota_lista: `Solo se listan ${lista.length}; los totales cuentan todos los leídos.` } : {}),
  };
}

async function resumen(p: Params, l: Lector) {
  const f = filtrosPeriodo(p);
  const series: [Ruta, "ventas" | "rect_ventas" | "compras" | "rect_compras"][] = [
    ["/invoices", "ventas"], ["/credit-notes", "rect_ventas"], ["/purchases", "compras"], ["/purchase-refunds", "rect_compras"],
  ];
  const t: Record<string, Record<string, Totales>> = { ventas: {}, rect_ventas: {}, compras: {}, rect_compras: {} };
  let borradores = 0, anuladas = 0;
  for (const [ruta, k] of series) {
    for (const d of await l.todas(ruta, f)) {
      if (d.draft === true) { borradores++; continue; }
      if (!cuentan(d)) { anuladas++; continue; }
      sumar(t[k], d);
    }
    if (l.estado.motivo === "cupo" || l.estado.motivo === "tiempo") break;
  }
  const monedas = [...new Set(Object.values(t).flatMap((x) => Object.keys(x)))].sort();
  const porMoneda = Object.fromEntries((monedas.length ? monedas : ["EUR"]).map((m) => {
    const g = (k: string) => t[k][m] ?? totalesVacios();
    const v = g("ventas"), rv = g("rect_ventas"), c = g("compras"), rc = g("rect_compras");
    const ingresos = v.base - rv.base, gastos = c.base - rc.base;
    const repercutido = v.impuestos - rv.impuestos, soportado = c.impuestos - rc.impuestos;
    return [m, {
      ingresos: { facturado: eur(v.base), rectificado: eur(rv.base), neto: eur(ingresos), facturas: v.documentos, rectificativas: rv.documentos,
                  pendiente_de_cobro: eur(v.pendiente) },
      gastos: { facturado: eur(c.base), rectificado: eur(rc.base), neto: eur(gastos), facturas: c.documentos, rectificativas: rc.documentos,
                pendiente_de_pago: eur(c.pendiente) },
      resultado_antes_de_impuestos: eur(ingresos - gastos),
      impuestos: { repercutidos: eur(repercutido), soportados: eur(soportado), diferencia: eur(repercutido - soportado) },
    }];
  }));
  return {
    periodo: { desde: p.desde, hasta: p.hasta },
    por_moneda: porMoneda,
    excluidas: { borradores, anuladas },
    nota: "Importes sin IVA (base imponible). Los impuestos son la suma del campo de impuestos de cada documento en Holded " +
      "(puede incluir recargos o retenciones): es una aproximación, no sustituye a la liquidación del IVA. Solo facturas, no la contabilidad completa.",
  };
}

async function contactos(p: Params, l: Lector) {
  const limite = (p.limite as number | undefined) ?? 25;
  const pag = typeof p.nombre === "string"
    ? await l.pagina("/contacts/search", { name: p.nombre.trim(), limit: POR_PAGINA })
    : await l.pagina("/contacts", { type: p.tipo as string | undefined, limit: POR_PAGINA });
  let items = pag?.items ?? [];
  if (typeof p.nombre === "string" && p.tipo) items = items.filter((c) => c.type === p.tipo);
  if (pag?.hayMas) { l.estado.truncado = true; l.estado.motivo ??= "paginas"; }
  const lista = items.slice(0, limite).map((c) => ({
    id: txt(c.id, 64), nombre: txt(c.name), nombre_comercial: txt(c.trade_name ?? c.tradeName), tipo: txt(c.type, 20),
    nif: txt(c.vat_number ?? c.code, 30), email: txt(c.email), telefono: txt(c.phone ?? c.mobile, 30),
  }));
  if (items.length > lista.length) { l.estado.truncado = true; l.estado.motivo ??= "paginas"; }
  return { contactos: lista, ...(p.nombre ? { busqueda: p.nombre } : {}), ...(p.tipo ? { tipo: p.tipo } : {}) };
}

async function tesoreria(l: Lector) {
  const pag = await l.pagina("/treasury/accounts", { limit: POR_PAGINA });
  if (pag?.hayMas) { l.estado.truncado = true; l.estado.motivo ??= "paginas"; }
  const cuentas = (pag?.items ?? []).filter((c) => c.archived !== true).map((c) => {
    const iban = typeof c.iban === "string" ? c.iban.replace(/\s/g, "") : "";
    return {
      nombre: txt(c.name), tipo: txt(c.type, 30), moneda: moneda(c), saldo: eur(cent(c.balance)),
      iban: iban.length >= 4 ? "…" + iban.slice(-4) : null,
    };
  });
  const saldos: Record<string, number> = {};
  for (const c of cuentas) saldos[c.moneda] = (saldos[c.moneda] ?? 0) + Math.round(c.saldo * 100);
  return {
    cuentas, saldo_total_por_moneda: Object.fromEntries(Object.entries(saldos).map(([m, c]) => [m, eur(c)])),
    nota: "Saldos según Holded (dependen de la última conciliación o sincronización bancaria de la cuenta).",
  };
}
