// Pruebas de holded-acciones con la base de datos y Holded simulados (sin red).
// Ejecutar (desde crm/supabase-functions):
//   deno test --allow-read --no-lock holded-acciones/
import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import { aprobarTicket, fetchAcciones } from "./operaciones.ts";
import { construir, motivoExclusion, validarParams } from "./propuesta.ts";
import { atender, type Deps, ejecutar, LOTE } from "./servicio.ts";
import { HOLDED_BASE } from "../_shared/holded.ts";

const CLAVE = "pat_" + "d4".repeat(44) + "WXYZ";   // inventada
const CRON = "secreto-cron-de-prueba";
const UID = "11111111-1111-1111-1111-111111111111";
const EMP = "e1000000-0000-0000-0000-000000000001";
const hex = (n: number) => n.toString(16).padStart(24, "0");
// deno-lint-ignore no-explicit-any
type X = any;

// ---------------------------------------------------------------- Holded simulado
type Pedida = { metodo: string; ruta: string; params: Record<string, string>; auth: string | null };
type Resp = { status?: number; body?: unknown; headers?: Record<string, string> };
function holded(responder: (p: Pedida, n: number) => Resp) {
  const pedidas: Pedida[] = [];
  const crudo = (url: string, init: RequestInit) => {
    const u = new URL(url);
    const p = { metodo: (init.method ?? "GET").toUpperCase(), ruta: u.pathname.replace(/^\/api\/v2/, ""),
                params: Object.fromEntries(u.searchParams), auth: new Headers(init.headers).get("authorization") };
    pedidas.push(p);
    const x = responder(p, pedidas.length);
    const st = x.status ?? 200;
    return Promise.resolve(new Response(st === 204 ? null : JSON.stringify(x.body ?? {}), {
      status: st, headers: { "content-type": "application/json", ...(x.headers ?? {}) } }));
  };
  return { fetch: fetchAcciones(crudo), pedidas };
}
const ticket = (n: number, x: Record<string, unknown> = {}) => ({
  id: hex(n), document_number: null, contact_id: null, contact_name: "Cliente de mostrador", description: `Venta ${n}`,
  date: "2026-01-10", subtotal: "10.00", discount: "0", total: "12.10", tax: "2.10", currency: "eur", status: "pending",
  lines: [{ name: `Producto ${n}`, units: 1 }], ...x,
});
/** Tickets pendientes paginados de 100 en 100, como Holded. */
function listado(tickets: X[], uso = { usage: 42400, limit: 100000, period: "2026-11" }) {
  return (p: Pedida): Resp => {
    if (p.ruta === "/usage") return { body: uso };
    if (p.ruta === "/sales-receipts") {
      const desde = p.params.cursor ? Number(p.params.cursor) : 0;
      const lim = Number(p.params.limit);
      const items = tickets.slice(desde, desde + lim);
      const mas = desde + lim < tickets.length;
      return { body: { items, has_more: mas, cursor: mas ? String(desde + lim) : null } };
    }
    return { status: 404 };
  };
}

// ---------------------------------------------------------------- base de datos simulada
function base(opciones: { clave?: string | null; lotes?: X[] } = {}) {
  const rpcs: { fn: string; args: X }[] = [];
  const lotes = [...(opciones.lotes ?? [])];
  const resultados: X[] = [];
  const rpc: Deps["rpc"] = (fn, args) => {
    rpcs.push({ fn, args });
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    if (fn === "holded_clave_de") return ok(opciones.clave === undefined ? CLAVE : opciones.clave);
    if (fn === "holded_acciones_crear") return ok({ id: "a0000000-0000-0000-0000-000000000001", estado: "propuesta", documentos: (args.p_ids as string[]).length });
    if (fn === "holded_acciones_reclamar") return ok(lotes.shift() ?? null);
    if (fn === "holded_acciones_resultado") { resultados.push(args); return ok({ estado: "en_curso" }); }
    return Promise.resolve({ data: null, error: { message: "sin simular" } });
  };
  return { rpc, rpcs, resultados, lotes };
}
function montar(h: ReturnType<typeof holded>, b = base(), extra: Partial<Deps> = {}) {
  let t = 0;
  const esperas: number[] = [];
  const logs: unknown[][] = [];
  const deps: Deps = {
    env: (k) => ({ HOLDED_ACCIONES_CRON_SECRET: CRON } as Record<string, string>)[k],
    usuario: (a) => Promise.resolve(a === "Bearer bueno" || a === "Bearer portal" ? UID : null),
    esUsuarioCrm: (a) => Promise.resolve(a === "Bearer bueno"),
    rpc: b.rpc, fetchHolded: h.fetch,
    ahora: () => t, esperar: (ms) => { esperas.push(ms); t += ms; return Promise.resolve(); },
    log: (...a) => logs.push(a), ...extra,
  };
  const pedir = (body: unknown, cab: { authorization?: string; hook?: string | null } = { authorization: "Bearer bueno" }) =>
    atender(deps, { authorization: cab.authorization ?? "", hook: cab.hook ?? null }, body);
  return { pedir, deps, esperas, logs, b, avanzar: (ms: number) => { t += ms; } };
}
const sinClave = (x: unknown) => { const s = JSON.stringify(x); assert(!s.includes(CLAVE.slice(4, 20)) && !s.includes(CLAVE.slice(-12)), "aparece la clave"); };

// ================================================================= LISTA CERRADA
Deno.test("lista cerrada: solo las escrituras del catálogo, las lecturas de propuesta y el GET por id del documento", () => {
  let salio = 0;
  const f = fetchAcciones(() => { salio++; return Promise.resolve(new Response("{}")); });
  const no: [string, string][] = [
    ["PATCH", `/sales-receipts/${hex(1)}`], ["POST", `/sales-receipts/${hex(1)}/attachments`], ["POST", `/sales-receipts/${hex(1)}/pagar`],
    ["POST", "/sales-receipts/abc/approve"], ["POST", `/sales-receipts/${hex(1)}/approve/`], ["POST", `/sales-receipts/${hex(1)}/approve?x=1`],
    ["DELETE", "/sales-receipts"], ["PUT", "/contacts"], ["POST", "/contacts/../account/users"], ["POST", "/contacts/%2e%2e/account/users"], ["POST", "//contacts"], ["POST", "/./contacts"], ["POST", `/contacts/${"AB".repeat(12)}/shipping-addresses`],
    ["GET", "/invoices"], ["GET", "/contacts"], ["GET", `/contacts/${hex(1)}/attachments`], ["HEAD", "/usage"],
    ["POST", "/numbering-series/inventado"], ["DELETE", `/crm/funnels/${hex(1)}?reassign_to_funnel_id=abc`], ["OPTIONS", "/contacts"],
  ];
  for (const [m, ruta] of no) assertThrows(() => f(HOLDED_BASE + ruta, { method: m }), Error, "no permitida", `${m} ${ruta}`);
  assertThrows(() => f(`https://evil.example.com/api/v2/sales-receipts/${hex(1)}/approve`, { method: "POST" }), Error, "no permitida");
  assertThrows(() => f(`http://api.holded.com/api/v2/sales-receipts/${hex(1)}/approve`, { method: "POST" }), Error, "no permitida");
  assertThrows(() => f(`https://api.holded.com/api/v1/sales-receipts/${hex(1)}/approve`, { method: "POST" }), Error, "no permitida");
  assertEquals(salio, 0, "no sale ninguna petición fuera de la lista");
  const si: [string, string][] = [
    ["GET", "/sales-receipts?limit=1"], ["GET", "/usage"], ["POST", `/sales-receipts/${hex(1)}/approve`], ["GET", `/invoices/${hex(1)}`],
    ["POST", "/contacts"], ["PUT", `/contacts/${hex(1)}`], ["DELETE", `/invoices/${hex(1)}`], ["POST", "/numbering-series/invoice"],
    ["DELETE", `/crm/funnels/${hex(1)}?reassign_to_funnel_id=${hex(2)}`],
  ];
  for (const [m, ruta] of si) f(HOLDED_BASE + ruta, { method: m });
  assertEquals(salio, si.length);
});

Deno.test("lista cerrada: aprobarTicket rechaza un id que no es de Holded", async () => {
  const h = holded(() => ({}));
  let e = "";
  try { await aprobarTicket(CLAVE, "../invoices/bulk", h.fetch); } catch (x) { e = (x as Error).message; }
  assertMatch(e, /no válido/);
  assertEquals(h.pedidas.length, 0);
});

Deno.test("lista cerrada: el código solo tiene una escritura y todo fetch va envuelto; holded-proxy sigue sin escrituras", () => {
  const leerSin = (f: string) => Deno.readTextFileSync(new URL(f, import.meta.url)).split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  const op = leerSin("./operaciones.ts");
  assertEquals(op.match(/method: "POST"/g)?.length, 1, "una sola llamada POST fija (aprobar ticket)");
  assertEquals(op.match(/method: metodo/g)?.length, 1, "y una genérica, siempre detrás de fetchAcciones");
  assert(!/\b(PUT|PATCH|DELETE)\b/.test(op));
  assertEquals(leerSin("./index.ts").match(/\bfetch\(/g)?.length, 1);
  assertMatch(leerSin("./index.ts"), /fetchAcciones\(\(u, init\) => fetch\(u, init\)\)/);
  for (const f of ["./servicio.ts", "./propuesta.ts"]) assert(!/\bfetch\(/.test(leerSin(f)), f);
  for (const f of ["../holded-proxy/consultas.ts", "../holded-proxy/servicio.ts", "../_shared/holded.ts"]) {
    assert(!/\b(POST|PUT|PATCH|DELETE)\b/.test(leerSin(f)), `${f} tiene un método de escritura`);
  }
});

// ================================================================= autorización
Deno.test("autorización: sin JWT 401; usuario que no es del CRM 403; secreto de cron incorrecto 401", async () => {
  const h = holded(() => ({}));
  const { pedir, b } = montar(h);
  const q = { accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: {} };
  assertEquals((await pedir(q, { authorization: "" })).status, 401);
  assertEquals((await pedir(q, { authorization: "Bearer portal" })).status, 403);
  assertEquals((await pedir(q, { hook: "otro" })).status, 401);
  assertEquals((await pedir(q, { hook: "" })).status, 401);
  assertEquals(b.rpcs.length, 0);
  assertEquals(h.pedidas.length, 0);
});

Deno.test("un usuario no puede lanzar la ejecución: solo el sistema (pg_cron)", async () => {
  const h = holded(() => ({}));
  const b = base({ lotes: [{ accion_id: "x", empresa_id: EMP, tipo: "aprobar_tickets_venta", ids: [hex(1)] }] });
  const { pedir } = montar(h, b);
  assertEquals((await pedir({ accion: "ejecutar" })).status, 403);
  assertEquals(b.rpcs.length, 0);
  assertEquals(h.pedidas.length, 0);
});

Deno.test("tipos de acción: solo los de la lista", async () => {
  const h = holded(() => ({}));
  const { pedir, b } = montar(h);
  for (const tipo of ["borrar_facturas", "aprobar_facturas", "", "aprobar_tickets_venta "]) {
    assertEquals((await pedir({ accion: "proponer", empresa_id: EMP, tipo, parametros: {} })).status, 400, tipo);
  }
  assertEquals((await pedir({ accion: "aprobar", empresa_id: EMP })).status, 400);
  assertEquals(b.rpcs.length, 0);
});

// ================================================================= proponer
Deno.test("proponer: solo lee (ningún POST), corta en un día completo y nace como propuesta", async () => {
  // 1.010 pendientes: 600 del 10/01, 400 del 11/01 y 10 del 12/01; máx. 1.000 → 10 y 11 enteros.
  const ts = [
    ...Array.from({ length: 600 }, (_, i) => ticket(1000 + i, { date: "2026-01-10" })),
    ...Array.from({ length: 400 }, (_, i) => ticket(2000 + i, { date: "2026-01-11" })),
    ...Array.from({ length: 10 }, (_, i) => ticket(3000 + i, { date: "2026-01-12" })),
  ];
  const h = holded(listado(ts));
  const { pedir, b } = montar(h);
  const r = await pedir({ accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: { max_documentos: 1000 }, origen: "agente" });
  assertEquals(r.status, 200);
  const c = r.body as X;
  assertEquals(c.ok, true);
  assertEquals(c.propuesta.estado, "propuesta");
  assert(h.pedidas.every((p) => p.metodo === "GET"), "proponer no escribe");
  assertEquals(h.pedidas[0].params.approval_status, "draft");
  assertEquals(h.pedidas[0].params.sort, "date");
  const cr = b.rpcs.find((x) => x.fn === "holded_acciones_crear")!.args;
  assertEquals(cr.p_ids.length, 1000);
  assertEquals(cr.p_origen, "agente");
  assertEquals(cr.p_usuario, UID);
  assertEquals([cr.p_resumen.desde, cr.p_resumen.hasta], ["2026-01-10", "2026-01-11"]);
  assertEquals(cr.p_resumen.mas_pendientes_despues, true);
  assertEquals(cr.p_muestra.length, 20);
  assertEquals(cr.p_llamadas, h.pedidas.length);
  assert(cr.p_avisos.some((a: string) => /VeriFactu/.test(a)) && cr.p_avisos.some((a: string) => /quedan 57600/.test(a)));
  sinClave(r.body); sinClave(b.rpcs.map((x) => x.args));
});

Deno.test("proponer: si el día del corte no cabe entero, se queda fuera", async () => {
  const ts = [
    ...Array.from({ length: 5 }, (_, i) => ticket(100 + i, { date: "2026-01-01" })),
    ...Array.from({ length: 8 }, (_, i) => ticket(200 + i, { date: "2026-01-02" })),
  ];
  const h = holded(listado(ts));
  const { pedir, b } = montar(h);
  await pedir({ accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: { max_documentos: 10 } }, { hook: CRON });
  const cr = b.rpcs.find((x) => x.fn === "holded_acciones_crear")!.args;
  assertEquals(cr.p_ids.length, 5, "solo el 01/01 entero; el 02/01 tiene 8 y no caben");
  assertEquals(cr.p_origen, "operador");
  assertEquals(cr.p_usuario, null);
  const r = await montar(holded(listado(Array.from({ length: 12 }, (_, i) => ticket(i, { date: "2026-01-01" }))))).pedir(
    { accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: { max_documentos: 10 } });
  assertMatch((r.body as X).mensaje, /más de 10 tickets pendientes el 2026-01-01/);
});

Deno.test("proponer: importe 0 o negativo, IVA incoherente y duplicados se excluyen y se listan aparte", async () => {
  const ts = [
    ticket(1), ticket(2, { total: "0", subtotal: "0", tax: "0" }), ticket(3, { total: "-5", subtotal: "-5", tax: "0" }),
    ticket(4, { tax: "5.00", total: "15.00" }), ticket(5, { total: "20.00" }),
    ticket(6, { description: "Igual", lines: [{ a: 1 }] }), ticket(7, { description: "Igual", lines: [{ a: 1 }] }),
    ticket(8, { subtotal: "10", discount: "1", tax: "1.89", total: "10.89" }),
  ];
  const h = holded(listado(ts));
  const { pedir, b } = montar(h);
  await pedir({ accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: {} });
  const cr = b.rpcs.find((x) => x.fn === "holded_acciones_crear")!.args;
  assertEquals(cr.p_ids, [hex(1), hex(8)]);
  const motivos = Object.fromEntries(cr.p_excluidos.map((e: X) => [e.id, e.motivo]));
  assertEquals(motivos[hex(2)], "Importe 0");
  assertEquals(motivos[hex(3)], "Importe negativo");
  assertMatch(motivos[hex(4)], /más del 26,2 %/);
  assertMatch(motivos[hex(5)], /no cuadra/);
  assertMatch(motivos[hex(6)], /duplicado/);
  assertMatch(motivos[hex(7)], /duplicado/);
  assertEquals(cr.p_resumen.documentos, 2);
  assertEquals(cr.p_resumen.excluidos, 6);
  assertEquals([cr.p_resumen.base, cr.p_resumen.iva, cr.p_resumen.total], [20, 3.99, 22.99]);
  assert(cr.p_avisos.some((a: string) => /6 ticket\(s\) del rango no se aprueban/.test(a)));
});

Deno.test("proponer: sin margen en el cupo de Holded lo avisa con la cifra que cabe", async () => {
  const h = holded(listado(Array.from({ length: 100 }, (_, i) => ticket(i + 1)), { usage: 1950, limit: 2000, period: "2026-11" }));
  const { pedir, b } = montar(h);
  await pedir({ accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: { max_documentos: 100 } });
  const cr = b.rpcs.find((x) => x.fn === "holded_acciones_crear")!.args;
  assert(cr.p_avisos.some((a: string) => /No hay margen suficiente.*unos 38/.test(a)), JSON.stringify(cr.p_avisos));
});

Deno.test("proponer: sin conexión, 403 o nada pendiente → mensaje y no se crea nada", async () => {
  for (const [b, h, re] of [
    [base({ clave: null }), holded(() => ({})), /no tiene Holded/],
    [base(), holded(() => ({ status: 403 })), /no tiene permiso para leer tickets/],
    [base(), holded(listado([])), /No hay tickets de venta pendientes/],
  ] as const) {
    const { pedir } = montar(h, b);
    const r = (await pedir({ accion: "proponer", empresa_id: EMP, tipo: "aprobar_tickets_venta", parametros: {} })).body as X;
    assertEquals(r.ok, false);
    assertMatch(r.mensaje, re);
    assert(!b.rpcs.some((x) => x.fn === "holded_acciones_crear"));
  }
});

Deno.test("validación de parámetros y de documentos", () => {
  assert(!validarParams({ max_documentos: 1001 }).ok);
  assert(!validarParams({ max_documentos: 0 }).ok);
  assert(!validarParams({ desde: "2026-02-30" }).ok);
  assert(!validarParams({ desde: "2026-03-01", hasta: "2026-02-01" }).ok);
  assert(!validarParams({ otro: 1 }).ok);
  assertEquals(validarParams({}), { ok: true, params: { max_documentos: 1000, desde: undefined, hasta: undefined } });
  assertEquals(motivoExclusion(ticket(1)), null);
  assertEquals(motivoExclusion(ticket(1, { date: null })), "Sin fecha");
  assertEquals(motivoExclusion(ticket(1, { subtotal: "x" })), "Importes que no se pueden leer");
  assertEquals(motivoExclusion(ticket(1, { subtotal: "100", tax: "26.20", total: "126.20" })), null, "21 % + recargo 5,2 %");
});

Deno.test("construir: el orden es por fecha y, a igual fecha, por id", async () => {
  const ts = [ticket(9, { date: "2026-01-02" }), ticket(3, { date: "2026-01-01" }), ticket(1, { date: "2026-01-02" })];
  const h = holded(listado(ts));
  const p = await construir(CLAVE, { max_documentos: 10 }, h.fetch);
  assertEquals(p.ids, [hex(3), hex(1), hex(9)]);
});

// ================================================================= ejecutar
const lote = (ids: string[], accion = "acc-1") => ({ accion_id: accion, empresa_id: EMP, tipo: "aprobar_tickets_venta", ids });

Deno.test("ejecutar: aprueba con POST uno a uno, al ritmo configurado, y devuelve resultados por documento", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => hex(i + 1));
  const h = holded((p) => p.ruta.endsWith(`${hex(5)}/approve`) ? { status: 404, body: { title: "Not Found", detail: "Sales receipt not found" } } : { status: 200, body: {} });
  const b = base({ lotes: [lote(ids.slice(0, LOTE)), lote(ids.slice(LOTE))] });
  const { pedir, esperas } = montar(h, b);
  const r = (await pedir({ accion: "ejecutar" }, { hook: CRON })).body as X;
  assertEquals(h.pedidas.length, 12);
  assert(h.pedidas.every((p) => p.metodo === "POST" && /^\/sales-receipts\/[0-9a-f]{24}\/approve$/.test(p.ruta)));
  assertEquals(h.pedidas.map((p) => p.ruta.slice(16, 40)), ids, "en orden");
  assertEquals([r.ok, r.error, r.llamadas], [11, 1, 12]);
  assertEquals(b.resultados.length, 2);
  const e = b.resultados[0].p_resultados.find((x: X) => x.id === hex(5));
  assertEquals([e.estado, e.codigo], ["error", 404]);
  assertMatch(e.error, /No encontrado en Holded: Not Found: Sales receipt not found/);
  assert(esperas.every((ms) => ms === 1500) && esperas.length === 11, "40 por minuto = una cada 1,5 s");
  sinClave(b.resultados);
});

Deno.test("ejecutar: 429 por minuto con Retry-After corto → espera y reintenta; largo → deja el resto para la próxima", async () => {
  let n = 0;
  const h = holded(() => (++n === 2 ? { status: 429, headers: { "retry-after": "3", "x-ratelimit-window": "minute" } } : { status: 200 }));
  const b = base({ lotes: [lote([hex(1), hex(2), hex(3)])] });
  const { esperas } = montar(h, b);
  await ejecutar(montar(h, b).deps);
  void esperas;
  assertEquals(b.resultados[0].p_resultados.map((x: X) => x.estado), ["ok", "ok", "ok"]);
  assertEquals(b.resultados[0].p_llamadas, 4);

  const h2 = holded(() => ({ status: 429, headers: { "retry-after": "60", "x-ratelimit-window": "minute" } }));
  const b2 = base({ lotes: [lote([hex(1), hex(2), hex(3)]), lote([hex(4)])] });
  await ejecutar(montar(h2, b2).deps);
  assertEquals(b2.resultados[0].p_resultados.map((x: X) => x.estado), ["pendiente", "pendiente", "pendiente"]);
  assertEquals(h2.pedidas.length, 1, "no insiste");
  assertEquals(b2.resultados.length, 1, "y no pide más lotes en esta ejecución");
  assertEquals(b2.resultados[0].p_pausar, null, "sin pausar: sigue en la próxima");
});

Deno.test("ejecutar: 429 mensual, 401, 403 y 402 pausan la acción con el motivo", async () => {
  for (const [resp, re] of [
    [{ status: 429, headers: { "retry-after": "1", "x-ratelimit-window": "month" } }, /cupo mensual/],
    [{ status: 401 }, /rechaza la clave/], [{ status: 403 }, /no tiene permiso para aprobar/], [{ status: 402 }, /límite anual de facturas/],
  ] as const) {
    const h = holded(() => resp);
    const b = base({ lotes: [lote([hex(1), hex(2)])] });
    await ejecutar(montar(h, b).deps);
    assertMatch(b.resultados[0].p_pausar, re);
    assertEquals(b.resultados[0].p_resultados.map((x: X) => x.estado), ["pendiente", "pendiente"]);
    assertEquals(h.pedidas.length, 1, "al pausar no se sigue aprobando");
  }
});

Deno.test("ejecutar: 5xx o sin respuesta → vuelve a la cola (la base lo pasa a error a los 3 intentos)", async () => {
  const h = holded((_p, n) => (n === 1 ? { status: 503 } : { status: 200 }));
  const b = base({ lotes: [lote([hex(1), hex(2)])] });
  await ejecutar(montar(h, b).deps);
  assertEquals(b.resultados[0].p_resultados.map((x: X) => x.estado), ["pendiente", "ok"]);
});

Deno.test("ejecutar: sin clave (revocada) pausa sin llamar; para antes del plazo de 45 s", async () => {
  const b = base({ clave: null, lotes: [lote([hex(1)])] });
  const h = holded(() => ({ status: 200 }));
  await ejecutar(montar(h, b).deps);
  assertEquals(h.pedidas.length, 0);
  assertMatch(b.resultados[0].p_pausar, /ya no tiene la clave/);

  const muchos = Array.from({ length: 10 }, (_, k) => lote(Array.from({ length: LOTE }, (_, i) => hex(k * 100 + i))));
  const h2 = holded(() => ({ status: 200 }));
  const b2 = base({ lotes: muchos });
  const r = await ejecutar(montar(h2, b2).deps);
  assert(h2.pedidas.length <= 31 && h2.pedidas.length >= 28, `a 40/min caben unas 30 en 45 s (${h2.pedidas.length})`);
  assert(r.ms < 45_000);
  const todos = b2.resultados.flatMap((x: X) => x.p_resultados);
  assertEquals(todos.filter((x: X) => x.estado === "ok").length, h2.pedidas.length, "lo no intentado vuelve a la cola");
});

// ================================================================= inspeccionar (solo lectura, solo operador)
Deno.test("inspeccionar: solo el operador, solo GET, recuentos y numeración sin datos de clientes", async () => {
  const ts = [ticket(1, { date: "2026-11-26", document_number: "LS3-00101" }), ticket(2, { date: "2026-11-26", document_number: "LS3-00102" }),
              ticket(3, { date: "2026-11-26", document_number: null })];
  const h = holded(listado(ts));
  const { pedir, b } = montar(h);
  const q = { accion: "inspeccionar", empresa_id: EMP, parametros: { desde: "2026-11-26", hasta: "2026-11-26" } };
  assertEquals((await pedir(q)).status, 403, "un usuario del CRM no puede");
  assertEquals(h.pedidas.length, 0);
  const r = (await pedir(q, { hook: CRON })).body as X;
  assert(h.pedidas.every((p) => p.metodo === "GET" && p.ruta === "/sales-receipts"));
  assertEquals(h.pedidas[0].params.approval_status, "draft");
  assertEquals([r.documentos, r.total], [3, 36.3]);
  assertEquals(r.numeracion.prefijos, { "LS3-": 2, "(sin número)": 1 });
  assertEquals([r.numeracion.primero, r.numeracion.ultimo], ["LS3-00101", "LS3-00102"]);
  const s = JSON.stringify(r);
  assert(!s.includes("Cliente de mostrador") && !s.includes("Venta 1") && !s.includes("Producto"), "sin clientes, conceptos ni líneas");
  assert(!b.rpcs.some((x) => x.fn === "holded_acciones_crear"), "no crea nada");
  sinClave(r);
  assertEquals((await pedir({ ...q, parametros: { desde: "2026-01-01", hasta: "2026-03-01" } }, { hook: CRON })).status, 400, "como mucho 31 días");
});
