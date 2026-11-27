// Pruebas de holded-proxy con la base de datos y Holded simulados (sin red).
// Ejecutar (desde crm/supabase-functions):
//   deno test --allow-read holded-proxy/
import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import {
  claveCache, fetchSoloLectura, finDiaMadrid, lector, MAX_LLAMADAS, MAX_PAGINAS, medianocheMadrid, RUTAS, validar,
} from "./consultas.ts";
import { atender, type Deps, nuevaCache } from "./servicio.ts";
import { HOLDED_BASE } from "../_shared/holded.ts";

const CLAVE = "pat_" + "c3".repeat(44) + "LMNO";   // inventada
const UID = "11111111-1111-1111-1111-111111111111";
const EMP = "e1000000-0000-0000-0000-000000000001";
const SIN = "e2000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------- Holded simulado
type Pedida = { metodo: string; ruta: string; params: Record<string, string>; auth: string | null };
type Respuesta = { status?: number; body?: unknown; headers?: Record<string, string> };
function holded(responder: (p: Pedida, n: number) => Respuesta) {
  const pedidas: Pedida[] = [];
  const crudo = (url: string, init: RequestInit) => {
    const u = new URL(url);
    const p: Pedida = {
      metodo: init.method ?? "GET", ruta: u.pathname.replace(/^\/api\/v2/, ""),
      params: Object.fromEntries(u.searchParams), auth: new Headers(init.headers).get("authorization"),
    };
    pedidas.push(p);
    const x = responder(p, pedidas.length);
    return Promise.resolve(new Response(JSON.stringify(x.body ?? { items: [], has_more: false }), {
      status: x.status ?? 200, headers: { "content-type": "application/json", ...(x.headers ?? {}) },
    }));
  };
  // Todo lo que sale pasa por fetchSoloLectura, como en index.ts.
  return { fetch: fetchSoloLectura(crudo), pedidas };
}
const pag = (items: unknown[], cursor: string | null = null) => ({ items, has_more: !!cursor, cursor });
const factura = (n: number, x: Record<string, unknown> = {}) => ({
  id: `f${n}`, document_number: `F-${n}`, contact_id: "c1", contact_name: "Cliente Inventado", date: "2026-10-05T00:00:00+02:00",
  due_date: "2026-11-05", subtotal: "100.00", tax: "21.00", total: "121.00", currency: "eur", status: "pending",
  draft: false, payments_total: "0", payments_pending: "121.00", ...x,
});

// ---------------------------------------------------------------- base de datos simulada
type Conexion = { version: string; cupo: number; clave: string | null; estado: "ok" | "pendiente" | "error"; error?: string };
function base(conexiones: Record<string, Conexion> = { [EMP]: { version: "v1", cupo: 150, clave: CLAVE, estado: "ok" } }) {
  const consultas: { id: string; tipo: string; llamadas: number; codigo: string; cache: boolean }[] = [];
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const usadas = () => consultas.filter((c) => !c.cache).reduce((a, c) => a + c.llamadas, 0);
  const rpc: Deps["rpc"] = (fn, args) => {
    rpcs.push({ fn, args });
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    if (fn === "holded_iniciar") {
      if (args.p_usuario !== UID) return Promise.resolve({ data: null, error: { code: "42501", message: "Solo usuarios activos del CRM" } });
      const c = conexiones[args.p_empresa as string];
      if (!c) { consultas.push({ id: "x", tipo: String(args.p_tipo), llamadas: 0, codigo: "sin_conexion", cache: false }); return ok({ ok: false, motivo: "sin_conexion" }); }
      if (c.estado === "error") return ok({ ok: false, motivo: "conexion_error", error: c.error });
      if (args.p_version_cache === c.version) {
        consultas.push({ id: "c", tipo: String(args.p_tipo), llamadas: 0, codigo: "200", cache: true });
        return ok({ ok: true, desde_cache: true });
      }
      if (usadas() >= c.cupo) return ok({ ok: false, motivo: "cupo", usadas: usadas(), cupo: c.cupo });
      const res = Math.min(Number(args.p_max), c.cupo - usadas());
      const id = `q${consultas.length + 1}`;
      consultas.push({ id, tipo: String(args.p_tipo), llamadas: res, codigo: "en_curso", cache: false });
      return ok({ ok: true, desde_cache: false, consulta_id: id, reservadas: res, version: c.version, usadas: usadas() - res, cupo: c.cupo });
    }
    if (fn === "holded_terminar") {
      const q = consultas.find((x) => x.id === args.p_consulta && x.codigo === "en_curso");
      if (q) { q.llamadas = Math.min(q.llamadas, Number(args.p_llamadas)); q.codigo = String(args.p_codigo); }
      return ok(null);
    }
    if (fn === "holded_clave_de") return ok(conexiones[args.p_empresa as string]?.clave ?? null);
    return Promise.resolve({ data: null, error: { message: "sin simular" } });
  };
  return { rpc, consultas, rpcs, usadas };
}

function montar(h: ReturnType<typeof holded>, b = base(), extra: Partial<Deps> = {}) {
  const esperas: number[] = [];
  const logs: unknown[][] = [];
  const deps: Deps = {
    usuario: (a) => Promise.resolve(a === "Bearer bueno" ? UID : a === "Bearer inactivo" ? "99999999-9999-9999-9999-999999999999" : null),
    rpc: b.rpc, fetchHolded: h.fetch, esperar: (ms) => { esperas.push(ms); return Promise.resolve(); },
    log: (...a) => logs.push(a), ...extra,
  };
  const cache = nuevaCache();
  const pedir = (body: unknown, auth = "Bearer bueno") => atender(deps, cache, auth, body);
  return { pedir, esperas, logs, cache, b };
}
// deno-lint-ignore no-explicit-any
type Cuerpo = any;
const sinClave = (x: unknown) => { const s = JSON.stringify(x); assert(!s.includes(CLAVE.slice(4, 20)) && !s.includes(CLAVE.slice(-12)), "aparece la clave"); };

// ================================================================= SOLO LECTURA
Deno.test("solo lectura: fetchSoloLectura rechaza cualquier método que no sea GET", () => {
  let salio = 0;
  const f = fetchSoloLectura(() => { salio++; return Promise.resolve(new Response("{}")); });
  for (const metodo of ["POST", "PUT", "PATCH", "DELETE", "post", "HEAD", "OPTIONS"]) {
    assertThrows(() => f(HOLDED_BASE + "/invoices", { method: metodo }), Error, "no permitido", metodo);
  }
  assertEquals(salio, 0, "no puede salir ninguna petición que no sea GET");
});

Deno.test("solo lectura: fetchSoloLectura rechaza rutas y hosts fuera de la lista cerrada", () => {
  let salio = 0;
  const f = fetchSoloLectura(() => { salio++; return Promise.resolve(new Response("{}")); });
  for (const url of [
    HOLDED_BASE + "/invoices/abc123", HOLDED_BASE + "/invoices/abc123/pay", HOLDED_BASE + "/invoices/abc123/send",
    HOLDED_BASE + "/contacts/abc", HOLDED_BASE + "/products", HOLDED_BASE + "/usage", HOLDED_BASE + "/",
    HOLDED_BASE + "/treasury/accounts/x", "https://api.holded.com/api/invoicing/v1/documents/invoice",
    "https://evil.example.com/api/v2/invoices", "http://api.holded.com/api/v2/invoices",
  ]) {
    assertThrows(() => f(url, { method: "GET" }), Error, "ruta no permitida", url);
  }
  assertEquals(salio, 0);
  for (const ruta of RUTAS) f(HOLDED_BASE + ruta + "?limit=1", { method: "GET" });
  assertEquals(salio, RUTAS.length, "las rutas de la lista sí pasan con GET");
  assertEquals([...RUTAS].sort(), ["/contacts", "/contacts/search", "/credit-notes", "/invoices", "/purchase-refunds", "/purchases", "/treasury/accounts"]);
});

Deno.test("solo lectura: el lector rechaza una ruta fuera de la lista antes de llamar", async () => {
  const h = holded(() => ({}));
  const l = lector(CLAVE, { fetch: h.fetch, reservadas: 5, plazo: Date.now() + 10_000 });
  let error = "";
  // deno-lint-ignore no-explicit-any
  try { await l.pagina("/invoices/123/pay" as any, {}); } catch (e) { error = (e as Error).message; }
  assertMatch(error, /no permitida/);
  assertEquals(h.pedidas.length, 0);
});

Deno.test("solo lectura: todas las consultas hacen solo GET a rutas de la lista", async () => {
  const h = holded((p) => p.ruta === "/treasury/accounts" ? { body: pag([{ name: "Banco", balance: "10", iban: "ES00 1234" }]) }
    : p.ruta.startsWith("/contacts") ? { body: pag([{ id: "c1", name: "X", type: "client" }]) }
    : { body: pag([factura(1)]) });
  const { pedir } = montar(h);
  const cuerpos = [
    { consulta: "facturas", empresa_id: EMP, params: { tipo: "emitidas", desde: "2026-01-01", hasta: "2026-12-31", rectificativas: true } },
    { consulta: "facturas", empresa_id: EMP, params: { tipo: "recibidas", desde: "2026-01-01", hasta: "2026-12-31", rectificativas: true } },
    { consulta: "resumen", empresa_id: EMP, params: { desde: "2026-01-01", hasta: "2026-03-31" } },
    { consulta: "contactos", empresa_id: EMP, params: { nombre: "Cliente" } },
    { consulta: "contactos", empresa_id: EMP, params: { tipo: "supplier" } },
    { consulta: "tesoreria", empresa_id: EMP, params: {} },
  ];
  for (const c of cuerpos) assertEquals((await pedir(c)).status, 200);
  assertEquals(h.pedidas.length, 11);   // 2 + 2 + 4 + 1 + 1 + 1
  for (const p of h.pedidas) {
    assertEquals(p.metodo, "GET");
    assert((RUTAS as readonly string[]).includes(p.ruta), p.ruta);
    assertEquals(p.auth, `Bearer ${CLAVE}`);
  }
  assertEquals(new Set(h.pedidas.map((p) => p.ruta)).size, RUTAS.length, "se usan todas las rutas de la lista");
});

Deno.test("solo lectura: el código hacia Holded no contiene métodos de escritura y todo fetch pasa por fetchSoloLectura", () => {
  const sinComentarios = (f: string) => Deno.readTextFileSync(new URL(f, import.meta.url)).split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
  for (const f of ["./consultas.ts", "../_shared/holded.ts"]) {
    const codigo = sinComentarios(f);
    assert(!/\b(POST|PUT|PATCH|DELETE)\b/.test(codigo), `${f} contiene un método de escritura`);
    assert(!/method\s*:\s*["'`](?!GET["'`])/i.test(codigo), `${f} usa un método que no es GET`);
  }
  assertMatch(sinComentarios("../_shared/holded.ts"), /method: "GET"/);
  const index = sinComentarios("./index.ts");
  assertEquals(index.match(/\bfetch\(/g)?.length, 1, "index.ts solo puede tener el fetch envuelto");
  assertMatch(index, /fetchSoloLectura\(\(u, init\) => fetch\(u, init\)\)/);
  assert(!/\bfetch\(/.test(sinComentarios("./servicio.ts")), "servicio.ts no puede llamar a fetch directamente");
});

Deno.test("solo lectura: una consulta que no está en la lista no llega ni a la base de datos", async () => {
  const h = holded(() => ({}));
  const { pedir, b } = montar(h);
  for (const consulta of ["crear_factura", "borrar_contacto", "pagar", "", "../invoices"]) {
    const r = await pedir({ consulta, empresa_id: EMP, params: {} });
    assertEquals(r.status, 400, consulta);
  }
  assertEquals(b.rpcs.length, 0);
  assertEquals(h.pedidas.length, 0);
});

// ================================================================= autorización y conexión
Deno.test("sin usuario → 401; usuario que no es del CRM → 403; empresa no válida → 400", async () => {
  const h = holded(() => ({}));
  const { pedir } = montar(h);
  const ok = { consulta: "tesoreria", empresa_id: EMP, params: {} };
  assertEquals((await pedir(ok, "")).status, 401);
  assertEquals((await pedir(ok, "Bearer malo")).status, 401);
  assertEquals((await pedir(ok, "Bearer inactivo")).status, 403);
  assertEquals((await pedir({ ...ok, empresa_id: "x" })).status, 400);
  assertEquals((await pedir({ ...ok, params: { otra: 1 } })).status, 400);
  assertEquals(h.pedidas.length, 0);
});

Deno.test("empresa sin Holded: lo dice y no llama a Holded", async () => {
  const h = holded(() => ({}));
  const { pedir, b } = montar(h);
  const r = await pedir({ consulta: "resumen", empresa_id: SIN, params: { desde: "2026-01-01", hasta: "2026-01-31" } });
  const c = r.body as Cuerpo;
  assertEquals(c.ok, false);
  assertEquals(c.codigo, "sin_conexion");
  assertMatch(c.mensaje, /no tiene Holded conectado/);
  assertEquals(h.pedidas.length, 0);
  assertEquals(b.consultas[0].codigo, "sin_conexion");
});

Deno.test("conexión con error: lo dice, sin llamar, y limpia cualquier cosa con forma de clave", async () => {
  const h = holded(() => ({}));
  const { pedir } = montar(h, base({ [EMP]: { version: "v1", cupo: 150, clave: CLAVE, estado: "error", error: `401 con ${CLAVE}` } }));
  const c = (await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo;
  assertEquals(c.codigo, "conexion_error");
  sinClave(c);
  assertEquals(h.pedidas.length, 0);
});

// ================================================================= cupo y caché
Deno.test("cupo agotado: lo dice con las cifras y no consulta", async () => {
  const h = holded(() => ({ body: pag([]) }));
  const b = base({ [EMP]: { version: "v1", cupo: 2, clave: CLAVE, estado: "ok" } });
  const { pedir } = montar(h, b);
  assertEquals(((await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo).ok, true);
  assertEquals(((await pedir({ consulta: "contactos", empresa_id: EMP, params: {} })).body as Cuerpo).ok, true);
  assertEquals(b.usadas(), 2);
  const c = (await pedir({ consulta: "contactos", empresa_id: EMP, params: { tipo: "client" } })).body as Cuerpo;
  assertEquals(c.codigo, "cupo");
  assertMatch(c.mensaje, /2 de 2/);
  assertEquals(h.pedidas.length, 2);
});

Deno.test("reserva menor que la consulta: se corta, avisa con truncado y no pasa de lo reservado", async () => {
  const h = holded((p, n) => ({ body: pag([factura(n)], `cur${n}`) }));
  const b = base({ [EMP]: { version: "v1", cupo: 3, clave: CLAVE, estado: "ok" } });
  const { pedir, cache } = montar(h, b);
  const c = (await pedir({ consulta: "resumen", empresa_id: EMP, params: { desde: "2026-01-01", hasta: "2026-12-31" } })).body as Cuerpo;
  assertEquals(c.ok, true);
  assertEquals(c.truncado, true);
  assertMatch(c.motivo_truncado, /tope mensual/);
  assertEquals(h.pedidas.length, 3);
  assertEquals(b.usadas(), 3);
  assertEquals(cache.size, 0, "lo cortado por cupo no se guarda en caché");
});

Deno.test("caché de 5 minutos: la segunda vez no llama a Holded ni cuenta; caduca a los 5 min", async () => {
  let t = 1_000_000;
  const h = holded(() => ({ body: pag([{ name: "Banco", balance: "1.50" }]) }));
  const { pedir, b } = montar(h, base(), { ahora: () => t });
  const q = { consulta: "tesoreria", empresa_id: EMP, params: {} };
  const c1 = (await pedir(q)).body as Cuerpo;
  t += 4 * 60_000;
  const c2 = (await pedir(q)).body as Cuerpo;
  assertEquals(c1.desde_cache, false);
  assertEquals(c2.desde_cache, true);
  assertEquals(c2.datos, c1.datos);
  assertEquals(h.pedidas.length, 1);
  assertEquals(b.consultas.map((x) => x.cache), [false, true]);
  assertEquals(b.rpcs.filter((x) => x.fn === "holded_iniciar")[1].args.p_version_cache, "v1");
  assertEquals(b.rpcs.filter((x) => x.fn === "holded_clave_de").length, 1, "con caché no se lee la clave");
  t += 2 * 60_000;
  assertEquals(((await pedir(q)).body as Cuerpo).desde_cache, false);
  assertEquals(h.pedidas.length, 2);
});

Deno.test("caché: otra clave (reemplazada) u otros parámetros → consulta de nuevo", async () => {
  const h = holded(() => ({ body: pag([]) }));
  const conexiones = { [EMP]: { version: "v1", cupo: 150, clave: CLAVE, estado: "ok" as const } };
  const { pedir } = montar(h, base(conexiones));
  await pedir({ consulta: "contactos", empresa_id: EMP, params: { tipo: "client" } });
  await pedir({ consulta: "contactos", empresa_id: EMP, params: { tipo: "supplier" } });
  assertEquals(h.pedidas.length, 2);
  conexiones[EMP].version = "v2";
  await pedir({ consulta: "contactos", empresa_id: EMP, params: { tipo: "client" } });
  assertEquals(h.pedidas.length, 3);
  assertEquals(claveCache(EMP, "x", { b: 1, a: 2 }), claveCache(EMP, "x", { a: 2, b: 1 }));
});

// ================================================================= límites de Holded
Deno.test("429 por minuto: espera Retry-After y reintenta una vez", async () => {
  const h = holded((_p, n) => n === 1 ? { status: 429, headers: { "retry-after": "3", "x-ratelimit-window": "minute" } } : { body: pag([]) });
  const { pedir, esperas, b } = montar(h);
  const c = (await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo;
  assertEquals(c.ok, true);
  assertEquals(esperas, [3000]);
  assertEquals(h.pedidas.length, 2);
  assertEquals(b.consultas[0].llamadas, 2, "el reintento cuenta como llamada");
});

Deno.test("429 por minuto dos veces, o con Retry-After > 10 s: no insiste", async () => {
  const h = holded(() => ({ status: 429, headers: { "retry-after": "1", "x-ratelimit-window": "minute" } }));
  const { pedir, b } = montar(h);
  const c = (await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo;
  assertEquals(c.codigo, "429-minuto");
  assertEquals(h.pedidas.length, 2);
  assertEquals(b.consultas[0].codigo, "429-minuto");
  const h2 = holded(() => ({ status: 429, headers: { "retry-after": "30" } }));
  const m2 = montar(h2);
  assertEquals(((await m2.pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo).codigo, "429-minuto");
  assertEquals(h2.pedidas.length, 1);
  assertEquals(m2.esperas, []);
});

Deno.test("429 mensual de Holded: lo dice y no reintenta", async () => {
  const h = holded(() => ({ status: 429, headers: { "retry-after": "1", "x-ratelimit-window": "month" } }));
  const { pedir, esperas } = montar(h);
  const c = (await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo;
  assertEquals(c.codigo, "429-mes");
  assertMatch(c.mensaje, /cupo mensual/);
  assertEquals(h.pedidas.length, 1);
  assertEquals(esperas, []);
});

Deno.test("403 (sin permiso) y 401 (clave rechazada): mensaje claro, sin datos ni clave", async () => {
  for (const [status, re] of [[403, /no tiene permiso para leer cuentas de tesorería/], [401, /rechaza la clave/]] as const) {
    const h = holded(() => ({ status, body: { error: `token ${CLAVE}` } }));
    const { pedir, logs } = montar(h);
    const c = (await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo;
    assertEquals(c.ok, false);
    assertMatch(c.mensaje, re);
    sinClave(c); sinClave(logs);
  }
});

Deno.test("paginación: como mucho 5 páginas por serie, con truncado", async () => {
  const h = holded((p, n) => ({ body: pag([factura(n)], `cur${n}`) }));
  const { pedir, b } = montar(h);
  const c = (await pedir({ consulta: "facturas", empresa_id: EMP, params: { tipo: "emitidas", desde: "2026-01-01", hasta: "2026-12-31" } })).body as Cuerpo;
  assertEquals(h.pedidas.length, MAX_PAGINAS);
  assertEquals(c.truncado, true);
  assertMatch(c.motivo_truncado, /500 documentos/);
  assertEquals(h.pedidas[1].params.cursor, "cur1");
  assertEquals(h.pedidas[0].params.limit, "100");
  assertEquals(b.consultas[0].llamadas, MAX_PAGINAS, "se libera lo reservado y no usado");
  assert(MAX_LLAMADAS.facturas >= 2 * MAX_PAGINAS + 1 && MAX_LLAMADAS.resumen >= 4 * MAX_PAGINAS + 1);
});

// ================================================================= cálculos
Deno.test("facturas: filtros del periodo en hora de Madrid; totales sin borradores ni anuladas", async () => {
  const h = holded((p) => ({ body: pag(p.ruta === "/invoices" ? [
    factura(1), factura(2, { subtotal: "50.50", tax: "10.61", total: "61.11", payments_pending: "0", status: "completed" }),
    factura(3, { draft: true }), factura(4, { status: "cancelled" }),
  ] : [factura(9, { subtotal: "-20", tax: "-4.2", total: "-24.2", payments_pending: "0" })]) }));
  const { pedir } = montar(h);
  const c = (await pedir({ consulta: "facturas", empresa_id: EMP,
    params: { tipo: "emitidas", desde: "2026-01-01", hasta: "2026-07-31", estado: "pending", rectificativas: true, limite: 2 } })).body as Cuerpo;
  assertEquals(h.pedidas[0].params.start_date, "2026-01-01T00:00:00+01:00");
  assertEquals(h.pedidas[0].params.end_date, "2026-07-31T23:59:59+02:00");
  assertEquals(h.pedidas[0].params.status, "pending");
  assertEquals(h.pedidas[1].ruta, "/credit-notes");
  assertEquals(c.datos.totales_por_moneda.EUR, { documentos: 2, base: 150.5, impuestos: 31.61, total: 182.11, pendiente: 121 });
  assertEquals(c.datos.rectificativas_por_moneda.EUR.base, 20);
  assertEquals(c.datos.excluidas_de_los_totales, { borradores: 1, anuladas: 1 });
  assertEquals(c.datos.documentos.length, 2);
  assertEquals(c.datos.documentos[0].fecha, "2026-10-05");
  sinClave(c);
});

Deno.test("resumen: ingresos, gastos e impuestos netos de rectificativas", async () => {
  const series: Record<string, unknown[]> = {
    "/invoices": [factura(1), factura(2)],
    "/credit-notes": [factura(3, { subtotal: "-10", tax: "-2.10", total: "-12.10" })],
    "/purchases": [factura(4, { subtotal: "40", tax: "8.40", total: "48.40" })],
    "/purchase-refunds": [],
  };
  const h = holded((p) => ({ body: pag(series[p.ruta]) }));
  const { pedir } = montar(h);
  const c = (await pedir({ consulta: "resumen", empresa_id: EMP, params: { desde: "2026-01-01", hasta: "2026-03-31" } })).body as Cuerpo;
  const e = c.datos.por_moneda.EUR;
  assertEquals(e.ingresos.neto, 190);
  assertEquals(e.gastos.neto, 40);
  assertEquals(e.resultado_antes_de_impuestos, 150);
  assertEquals(e.impuestos, { repercutidos: 39.9, soportados: 8.4, diferencia: 31.5 });
  assertEquals(h.pedidas.map((p) => p.ruta), ["/invoices", "/credit-notes", "/purchases", "/purchase-refunds"]);
});

Deno.test("contactos: búsqueda por nombre o listado por tipo", async () => {
  const h = holded(() => ({ body: pag([{ id: "c1", name: "Proveedor Inventado", type: "supplier", vat_number: "B00000000" },
                                      { id: "c2", name: "Proveedor Cliente", type: "client" }]) }));
  const { pedir } = montar(h);
  const c = (await pedir({ consulta: "contactos", empresa_id: EMP, params: { nombre: "Proveedor", tipo: "supplier" } })).body as Cuerpo;
  assertEquals(h.pedidas[0].ruta, "/contacts/search");
  assertEquals(h.pedidas[0].params.name, "Proveedor");
  assertEquals(c.datos.contactos.map((x: Cuerpo) => x.id), ["c1"]);
  await pedir({ consulta: "contactos", empresa_id: EMP, params: { tipo: "client" } });
  assertEquals(h.pedidas[1].ruta, "/contacts");
  assertEquals(h.pedidas[1].params.type, "client");
});

Deno.test("tesorería: saldos por moneda, IBAN solo con los 4 últimos y sin archivadas", async () => {
  const h = holded(() => ({ body: pag([
    { name: "Cuenta 1", type: "bank", balance: "1000.10", currency: "eur", iban: "ES91 2100 0418 4502 0005 1332" },
    { name: "Caja", type: "cash", balance: 50 },
    { name: "Vieja", balance: "999", archived: true },
  ]) }));
  const { pedir } = montar(h);
  const c = (await pedir({ consulta: "tesoreria", empresa_id: EMP, params: {} })).body as Cuerpo;
  assertEquals(c.datos.cuentas.length, 2);
  assertEquals(c.datos.cuentas[0].iban, "…1332");
  assert(!JSON.stringify(c).includes("2100 0418"));
  assertEquals(c.datos.saldo_total_por_moneda, { EUR: 1050.1 });
});

Deno.test("validación de parámetros y fechas de Madrid", () => {
  assert(!validar("facturas", { tipo: "emitidas", desde: "2026-02-30", hasta: "2026-03-01" }).ok);
  assert(!validar("facturas", { tipo: "emitidas", desde: "2026-03-01", hasta: "2026-01-01" }).ok);
  assert(!validar("facturas", { tipo: "emitidas", desde: "2024-01-01", hasta: "2026-01-01" }).ok);
  assert(!validar("facturas", { tipo: "todas", desde: "2026-01-01", hasta: "2026-01-31" }).ok);
  assert(!validar("facturas", { tipo: "emitidas", desde: "2026-01-01", hasta: "2026-01-31", contacto_id: "a/b" }).ok);
  assert(validar("facturas", { tipo: "recibidas", desde: "2026-01-01", hasta: "2026-01-31", estado: "overdue", limite: 100 }).ok);
  assert(!validar("contactos", { nombre: "x" }).ok);
  assert(!validar("tesoreria", { cuenta: 1 }).ok);
  assertEquals(medianocheMadrid("2026-03-29"), "2026-03-29T00:00:00+01:00");   // día del cambio a verano
  assertEquals(finDiaMadrid("2026-03-29"), "2026-03-29T23:59:59+02:00");
  assertEquals(medianocheMadrid("2026-10-25"), "2026-10-25T00:00:00+02:00");   // día del cambio a invierno
  assertEquals(finDiaMadrid("2026-10-25"), "2026-10-25T23:59:59+01:00");
});
