// Pruebas de las OPERACIONES genéricas de holded-acciones con Holded y la base
// de datos simulados (sin red). Ejecutar (desde crm/supabase-functions):
//   deno test --allow-read --no-lock holded-acciones/
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { fetchAcciones } from "./operaciones.ts";
import { encontrarOperacion, OPERACIONES_HOLDED, type Operacion } from "./catalogo.ts";
import { atender, type Deps, ejecutar } from "./servicio.ts";
import CATALOGO from "./catalogo.json" with { type: "json" };

const CLAVE = "pat_" + "e5".repeat(44) + "QRST";   // inventada
const CRON = "secreto-cron-de-prueba";
const UID = "11111111-1111-1111-1111-111111111111";
const EMP = "e1000000-0000-0000-0000-000000000001";
const hex = (n: number) => n.toString(16).padStart(24, "0");
// deno-lint-ignore no-explicit-any
type X = any;
type Pedida = { metodo: string; ruta: string; query: string; cuerpo: unknown; auth: string | null };

function holded(responder: (p: Pedida) => { status?: number; body?: unknown; headers?: Record<string, string> } = () => ({})) {
  const pedidas: Pedida[] = [];
  const crudo = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const p = { metodo: (init.method ?? "GET").toUpperCase(), ruta: u.pathname.replace(/^\/api\/v2/, ""), query: u.search,
                cuerpo: init.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init.headers).get("authorization") };
    pedidas.push(p);
    const x = p.metodo === "GET" ? { body: { id: p.ruta.split("/").at(-1), name: "Viejo", email: "viejo@x.invalid", notes: "algo" }, ...responder(p) }
                                 : { status: p.metodo === "POST" ? 201 : 200, body: { id: hex(999) }, ...responder(p) };
    const st = x.status ?? 200;
    return new Response(st === 204 ? null : JSON.stringify(x.body ?? {}), { status: st, headers: { "content-type": "application/json", ...(x.headers ?? {}) } });
  };
  return { fetch: fetchAcciones(crudo), pedidas };
}
function base(lotes: X[] = []) {
  const rpcs: { fn: string; args: X }[] = [];
  const resultados: X[] = [];
  const rpc: Deps["rpc"] = (fn, args) => {
    rpcs.push({ fn, args });
    const ok = (data: unknown) => Promise.resolve({ data, error: null });
    if (fn === "holded_clave_de") return ok(CLAVE);
    if (fn === "holded_acciones_crear_operacion") {
      return ok({ id: "a0000000-0000-0000-0000-000000000009", estado: "propuesta", documentos: (args.p_peticiones as unknown[]).length,
                  riesgo: OPERACIONES_HOLDED.find((o) => o.id === args.p_operacion)!.riesgo });
    }
    if (fn === "holded_acciones_reclamar") return ok(lotes.shift() ?? null);
    if (fn === "holded_acciones_resultado") { resultados.push(args); return ok({ estado: "en_curso" }); }
    return Promise.resolve({ data: null, error: { message: "sin simular" } });
  };
  return { rpc, rpcs, resultados };
}
function montar(h: ReturnType<typeof holded>, b = base()) {
  let t = 0;
  const deps: Deps = {
    env: (k) => ({ HOLDED_ACCIONES_CRON_SECRET: CRON } as Record<string, string>)[k],
    usuario: (a) => Promise.resolve(a === "Bearer bueno" || a === "Bearer portal" ? UID : null),
    esUsuarioCrm: (a) => Promise.resolve(a === "Bearer bueno"),
    rpc: b.rpc, fetchHolded: h.fetch, ahora: () => t, esperar: (ms) => { t += ms; return Promise.resolve(); }, log: () => {},
  };
  const pedir = (body: X, cab: { authorization?: string; hook?: string | null } = { authorization: "Bearer bueno" }) =>
    atender(deps, { authorization: cab.authorization ?? "", hook: cab.hook ?? null }, { accion: "proponer_operacion", empresa_id: EMP, ...body });
  return { pedir, deps, b };
}
const crear = (b: ReturnType<typeof base>) => b.rpcs.find((x) => x.fn === "holded_acciones_crear_operacion")?.args;
const sinClave = (x: unknown) => { const s = JSON.stringify(x); assert(!s.includes(CLAVE.slice(4, 20)) && !s.includes(CLAVE.slice(-12)), "aparece la clave"); };

/** Ruta concreta y cuerpo mínimo de una operación del catálogo. */
function ejemplo(op: Operacion) {
  let n = 0;
  const ruta = op.ruta.replace(/\{([^}]+)\}/g, (_, k) => {
    const p = op.params[k];
    return !p || p.tipo === "id" ? hex(++n) : p.tipo === "enum" ? p.valores![0] : "etiqueta";
  });
  const cuerpo = op.cuerpo === "json" ? Object.fromEntries((op.requeridos.length ? op.requeridos : ["nota"]).map((k) => [k, "x"])) : undefined;
  return { ruta, cuerpo };
}

// ================================================================= catálogo
Deno.test("catálogo: generado desde la especificación oficial; 232 escrituras, cada una con su riesgo; sin ficheros", () => {
  const c = CATALOGO as X;
  assertEquals(c.fuente, "https://api.holded.com/openapi/es.json");
  assertEquals(OPERACIONES_HOLDED.length, 232);
  assert(OPERACIONES_HOLDED.every((o) => ["POST", "PUT", "PATCH", "DELETE"].includes(o.metodo) && ["normal", "alto"].includes(o.riesgo)));
  assert(OPERACIONES_HOLDED.filter((o) => o.metodo === "DELETE").every((o) => o.riesgo === "alto"), "borrar siempre es alto");
  for (const r of [/\/approve$/, /\/send$/, /\/payments$/, /^\/treasury\/accounts/, /^\/ledger-entries/, /^\/payments/, /^\/account\/users/, /^\/webhooks/, /^\/payslips/]) {
    const ops = OPERACIONES_HOLDED.filter((o) => r.test(o.ruta));
    assert(ops.length && ops.every((o) => o.riesgo === "alto"), `${r} tiene que ser riesgo alto`);
  }
  for (const id of ["create_contact", "update_contact", "create_invoice", "update_invoice", "create_product", "create_estimate"]) {
    assertEquals(OPERACIONES_HOLDED.find((o) => o.id === id)!.riesgo, "normal", id);
  }
  assertEquals(c.excluidas.length, 13);
  assert(c.excluidas.every((e: X) => /fichero/.test(e.motivo)));
  // El catálogo SQL de la migración es el mismo.
  const sql = Deno.readTextFileSync(new URL("../../supabase-holded-operaciones.sql", import.meta.url));
  const filas = [...sql.matchAll(/^\s+\('([A-Za-z0-9_]+)', '(POST|PUT|PATCH|DELETE)', '([^']+)', '(?:[^']|'')*', '(?:[^']|'')*', '(normal|alto)'\)/gm)];
  assertEquals(filas.length, 232);
  for (const f of filas) {
    const o = OPERACIONES_HOLDED.find((x) => x.id === f[1])!;
    assertEquals([o.metodo, o.ruta, o.riesgo], [f[2], f[3], f[4]], f[1]);
  }
});

Deno.test("cada operación del catálogo: se propone (con su estado anterior si cambia algo) y se ejecuta con la petición exacta", async () => {
  for (const op of OPERACIONES_HOLDED) {
    const { ruta, cuerpo } = ejemplo(op);
    const h = holded();
    const b = base();
    const { pedir } = montar(h, b);
    const r = await pedir({ metodo: op.metodo, ruta, ...(cuerpo ? { cuerpo } : {}), descripcion: `Prueba ${op.id}` });
    assertEquals((r.body as X).ok, true, `${op.id}: ${JSON.stringify(r.body)}`);
    const cr = crear(b);
    assertEquals(cr.p_operacion, op.id);
    assertEquals(cr.p_peticiones.length, 1);
    assertEquals([cr.p_peticiones[0].metodo, cr.p_peticiones[0].ruta], [op.metodo, ruta]);
    assert(h.pedidas.every((p) => p.metodo === "GET"), `${op.id}: proponer no escribe`);
    const cambia = !!op.lectura && /\{/.test(op.ruta);
    assertEquals(h.pedidas.length, cambia ? 1 : 0, `${op.id}: lecturas`);
    if (cambia) assertEquals(cr.p_peticiones[0].estado_anterior.name, "Viejo");
    if (op.riesgo === "alto") assert(cr.p_avisos.some((a: string) => /RIESGO ALTO.*CONFIRMAR/.test(a)), op.id);

    const h2 = holded();
    const b2 = base([{ accion_id: "x", empresa_id: EMP, tipo: "operacion", operacion: op.id,
                       peticiones: [{ orden: 1, metodo: op.metodo, ruta, cuerpo: cuerpo ?? null }] }]);
    await ejecutar(montar(h2, b2).deps);
    assertEquals(h2.pedidas.length, 1, op.id);
    assertEquals([h2.pedidas[0].metodo, h2.pedidas[0].ruta + h2.pedidas[0].query], [op.metodo, ruta], op.id);
    assertEquals(h2.pedidas[0].cuerpo, cuerpo, op.id);
    assertEquals(h2.pedidas[0].auth, `Bearer ${CLAVE}`);
    assertEquals(b2.resultados[0].p_resultados[0].estado, "ok", op.id);
    sinClave([b.rpcs.map((x) => x.args), r.body, b2.resultados]);
  }
});

// ================================================================= lista cerrada
Deno.test("fuera de la lista cerrada: se rechaza sin llamar a Holded ni crear nada", async () => {
  const casos: [string, string][] = [
    ["POST", `/invoices/${hex(1)}/attachments`], ["POST", "/invoices/inventado"], ["PATCH", "/contacts"], ["PUT", "/contacts"],
    ["DELETE", `/contacts/${hex(1)}/otra-cosa`], ["POST", "/contacts/../account/users"], ["POST", "/v1/contacts"], ["GET", "/contacts"],
    ["POST", `/sales-receipts/${"ZZ".repeat(12)}/approve`], ["DELETE", `/crm/funnels/${hex(1)}?borrar_todo=1`],
  ];
  for (const [metodo, ruta] of casos) {
    const h = holded();
    const b = base();
    const r = (await montar(h, b).pedir({ metodo, ruta, descripcion: "Prueba" })).body as X;
    assertEquals(r.ok, false, `${metodo} ${ruta}`);
    assertMatch(r.mensaje, /lista cerrada|metodo tiene que ser/, `${metodo} ${ruta}`);
    assertEquals(h.pedidas.length, 0);
    assertEquals(crear(b), undefined);
  }
  assertEquals(encontrarOperacion("POST", "/contacts"), encontrarOperacion("post", "/contacts"));
  assertEquals(encontrarOperacion("DELETE", `/crm/funnels/${hex(1)}?reassign_to_funnel_id=${hex(2)}`)?.op.id, "delete_crm_funnel");
});

Deno.test("ejecutar: una petición que no casa con la operación de la acción pausa sin llamar a Holded", async () => {
  const h = holded();
  const b = base([{ accion_id: "x", empresa_id: EMP, tipo: "operacion", operacion: "create_contact",
                    peticiones: [{ orden: 1, metodo: "DELETE", ruta: `/invoices/${hex(1)}`, cuerpo: null }] }]);
  await ejecutar(montar(h, b).deps);
  assertEquals(h.pedidas.length, 0);
  assertMatch(b.resultados[0].p_pausar, /fuera de la lista cerrada/);
});

// ================================================================= validación
Deno.test("validación: descripción, campos obligatorios, cuerpo donde no va y tamaños", async () => {
  for (const [entrada, re] of [
    [{ metodo: "POST", ruta: "/contacts", cuerpo: { name: "A" } }, /descripción/],
    [{ metodo: "POST", ruta: "/invoices", cuerpo: { contact_id: hex(1) }, descripcion: "Factura" }, /Faltan campos obligatorios de create_invoice: items/],
    [{ metodo: "POST", ruta: "/invoices", descripcion: "Factura" }, /necesita un cuerpo con: contact_id, items/],
    [{ metodo: "DELETE", ruta: `/invoices/${hex(1)}`, cuerpo: { a: 1 }, descripcion: "Borrar" }, /no lleva cuerpo/],
    [{ metodo: "POST", ruta: "/contacts", cuerpo: "texto", descripcion: "Contacto" }, /objeto JSON/],
    [{ metodo: "POST", ruta: "/contacts", cuerpo: { name: "x".repeat(70_000) }, descripcion: "Contacto" }, /pasa de 60 KB/],
    [{ metodo: "GETS", ruta: "/contacts", descripcion: "Contacto" }, /metodo tiene que ser/],
  ] as const) {
    const h = holded();
    const b = base();
    const r = (await montar(h, b).pedir(entrada)).body as X;
    assertEquals(r.ok, false, JSON.stringify(entrada).slice(0, 80));
    assertMatch(r.mensaje, re);
    assertEquals(crear(b), undefined);
  }
  // La ruta puede venir con /api/v2 o la URL completa.
  const h = holded();
  const b = base();
  await montar(h, b).pedir({ metodo: "POST", ruta: "https://api.holded.com/api/v2/contacts", cuerpo: { name: "A" }, descripcion: "Contacto A" });
  assertEquals(crear(b).p_peticiones[0].ruta, "/contacts");
});

Deno.test("autorización: un usuario que no es del CRM no propone; un usuario del CRM sí (origen agente)", async () => {
  const h = holded();
  const b = base();
  const { pedir } = montar(h, b);
  const q = { metodo: "POST", ruta: "/contacts", cuerpo: { name: "A" }, descripcion: "Crear contacto A", origen: "agente" };
  assertEquals((await pedir(q, { authorization: "Bearer portal" })).status, 403);
  assertEquals((await pedir(q, { authorization: "" })).status, 401);
  assertEquals((await pedir(q)).status, 200);
  assertEquals([crear(b).p_usuario, crear(b).p_origen], [UID, "agente"]);
});

// ================================================================= lote
Deno.test("lote por ids: la misma operación sobre cada id, con su estado anterior", async () => {
  const h = holded();
  const b = base();
  const ids = [hex(10), hex(11), hex(12)];
  const r = (await montar(h, b).pedir({ metodo: "PUT", ruta: "/contacts/{id}", cuerpo: { name: "Nuevo", email: "n@x.invalid" },
                                        lote: { ids }, descripcion: "Renombrar 3 contactos" })).body as X;
  assertEquals(r.ok, true);
  const cr = crear(b);
  assertEquals(cr.p_peticiones.map((p: X) => p.ruta), ids.map((i) => `/contacts/${i}`));
  assertEquals(cr.p_peticiones.map((p: X) => p.holded_id), ids);
  assertEquals(h.pedidas.map((p) => `${p.metodo} ${p.ruta}`), ids.map((i) => `GET /contacts/${i}`));
  assert(cr.p_avisos.some((a: string) => /reemplaza el documento entero.*notes/.test(a)), "PUT: avisa de los campos que se perderían");
  assert(cr.p_avisos.some((a: string) => /3 llamadas/.test(a)));
  assertEquals(cr.p_muestra.length, 3);
});

Deno.test("lote por cuerpos: un POST por cuerpo; límites del lote", async () => {
  const h = holded();
  const b = base();
  await montar(h, b).pedir({ metodo: "POST", ruta: "/contacts", lote: { cuerpos: [{ name: "A" }, { name: "B" }] }, descripcion: "Dos contactos" });
  assertEquals(crear(b).p_peticiones.map((p: X) => p.cuerpo.name), ["A", "B"]);
  assert(crear(b).p_avisos.some((a: string) => /Crea 2 documento/.test(a)));
  for (const [lote, re] of [
    [{ ids: Array.from({ length: 101 }, (_, i) => hex(i)) }, /entre 1 y 100/], [{ ids: [hex(1), hex(1)] }, /repetidos/],
    [{ ids: ["abc"] }, /24 caracteres/], [{ cuerpos: [] }, /entre 1 y 100/], [{ ids: [hex(1)], cuerpos: [{}] }, /no los dos/],
    [{ otra: 1 }, /desconocido/],
  ] as const) {
    const b2 = base();
    const r = (await montar(holded(), b2).pedir({ metodo: "PUT", ruta: "/contacts/{id}", cuerpo: { name: "x" }, lote, descripcion: "Lote" })).body as X;
    assertMatch(r.mensaje, re);
  }
  const r = (await montar(holded(), base()).pedir({ metodo: "PUT", ruta: `/contacts/${hex(1)}`, cuerpo: { name: "x" }, lote: { ids: [hex(2)] }, descripcion: "Lote" })).body as X;
  assertMatch(r.mensaje, /lleva \{id\} una vez/);
});

Deno.test("estado anterior: 404 avisa; 401 corta la propuesta", async () => {
  const b = base();
  await montar(holded((p) => (p.metodo === "GET" ? { status: 404, body: {} } : {})), b)
    .pedir({ metodo: "DELETE", ruta: `/invoices/${hex(5)}`, descripcion: "Borrar factura de prueba" });
  assert(crear(b).p_avisos.some((a: string) => /no existen en Holded \(404\)/.test(a)));
  assert(crear(b).p_avisos.some((a: string) => /no se puede deshacer/.test(a)));
  const b2 = base();
  const r = (await montar(holded(() => ({ status: 401 })), b2).pedir({ metodo: "DELETE", ruta: `/invoices/${hex(5)}`, descripcion: "Borrar" })).body as X;
  assertMatch(r.mensaje, /401/);
  assertEquals(crear(b2), undefined);
});

// ================================================================= ejecutar
Deno.test("ejecutar: un POST sin respuesta queda «desconocido» (no se repite); un PUT vuelve a la cola; el id creado se guarda", async () => {
  const h = holded((p) => (p.metodo === "POST" ? { status: 503 } : p.metodo === "PUT" ? { status: 502 } : {}));
  const b = base([{ accion_id: "x", empresa_id: EMP, tipo: "operacion", operacion: "create_contact",
                    peticiones: [{ orden: 1, metodo: "POST", ruta: "/contacts", cuerpo: { name: "A" } }] },
                  { accion_id: "y", empresa_id: EMP, tipo: "operacion", operacion: "update_contact",
                    peticiones: [{ orden: 1, metodo: "PUT", ruta: `/contacts/${hex(1)}`, cuerpo: { name: "B" } }] }]);
  await ejecutar(montar(h, b).deps);
  assertEquals(h.pedidas.filter((p) => p.metodo === "POST").length, 1, "el POST no se reintenta");
  assertEquals(b.resultados[0].p_resultados[0].estado, "desconocido");
  assertMatch(b.resultados[0].p_resultados[0].error, /puede que se haya hecho/);
  assertEquals(b.resultados[1].p_resultados[0].estado, "pendiente");

  const h2 = holded();
  const b2 = base([{ accion_id: "z", empresa_id: EMP, tipo: "operacion", operacion: "create_contact",
                     peticiones: [{ orden: 1, metodo: "POST", ruta: "/contacts", cuerpo: { name: "A" } }, { orden: 2, metodo: "POST", ruta: "/contacts", cuerpo: { name: "B" } }] }]);
  await ejecutar(montar(h2, b2).deps);
  assertEquals(b2.resultados[0].p_resultados.map((x: X) => [x.orden, x.estado, x.resultado_id]), [[1, "ok", hex(999)], [2, "ok", hex(999)]]);
});

Deno.test("ejecutar: 422 con el detalle de Holded; 403 pausa", async () => {
  const h = holded(() => ({ status: 422, body: { title: "Unprocessable", detail: "items is required" } }));
  const b = base([{ accion_id: "x", empresa_id: EMP, tipo: "operacion", operacion: "create_invoice",
                    peticiones: [{ orden: 1, metodo: "POST", ruta: "/invoices", cuerpo: { contact_id: hex(1), items: [] } }] }]);
  await ejecutar(montar(h, b).deps);
  assertEquals(b.resultados[0].p_resultados[0].estado, "error");
  assertMatch(b.resultados[0].p_resultados[0].error, /Holded 422: Unprocessable: items is required/);
  const b2 = base([{ accion_id: "x", empresa_id: EMP, tipo: "operacion", operacion: "create_contact",
                     peticiones: [{ orden: 1, metodo: "POST", ruta: "/contacts", cuerpo: { name: "A" } }, { orden: 2, metodo: "POST", ruta: "/contacts", cuerpo: { name: "B" } }] }]);
  const h2 = holded(() => ({ status: 403 }));
  await ejecutar(montar(h2, b2).deps);
  assertMatch(b2.resultados[0].p_pausar, /no tiene permiso para esta operación/);
  assertEquals(h2.pedidas.length, 1);
});
