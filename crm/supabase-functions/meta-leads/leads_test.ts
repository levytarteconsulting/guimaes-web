// Pruebas de meta-leads con la Graph API y la base de datos simuladas.
// Ejecutar desde crm/:  deno test supabase-functions/meta-leads/leads_test.ts
// (sin red ni permisos).
import assert from "node:assert/strict";
import {
  Contacto, createHandler, Db, extractLeadgenEvents, LeadRow, mapLead, SOURCE,
} from "./leads.ts";

const APP_SECRET = "secreto-de-prueba";
const VERIFY = "verify-de-prueba";
const OPS = "ops-de-prueba";
const PAGE = "1111";
const FORM = "2222";

// ---- Graph simulada ----
type Lead = Record<string, unknown>;
function fakeGraph(leads: Record<string, Lead>, opts: { failFull?: boolean; failIds?: Set<string> } = {}) {
  const calls: string[] = [];
  const subs: { id: string; name: string; subscribed_fields: string[] }[] = [{ id: "999", name: "Guimaes_crm", subscribed_fields: ["feed"] }];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}?${url.searchParams.toString()}`);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const err = (status: number, code: number, message: string) =>
      new Response(JSON.stringify({ error: { message, type: "OAuthException", code, fbtrace_id: "T" } }), { status });
    const fields = url.searchParams.get("fields") ?? "";

    if (path === PAGE && fields === "access_token") return ok({ id: PAGE, access_token: "PAGE_TOKEN" });
    if (path === "app") return ok({ id: "999", name: "Guimaes_crm" });
    if (path === `${PAGE}/subscribed_apps` && method === "GET") return ok({ data: subs });
    if (path === `${PAGE}/subscribed_apps` && method === "POST") {
      subs[0].subscribed_fields = (url.searchParams.get("subscribed_fields") ?? "").split(",");
      return ok({ success: true });
    }
    if (path === `${PAGE}/leadgen_forms`) return ok({ data: [{ id: FORM, name: "Asesoría fiscal", status: "ACTIVE" }] });
    if (path === FORM) return ok({ id: FORM, name: "Asesoría fiscal" });
    if (path === `${FORM}/leads`) {
      const all = Object.values(leads);
      // Paginación: el primero en una página y el resto en la siguiente.
      if (url.searchParams.get("after") === "p2") return ok({ data: all.slice(1) });
      return ok({ data: all.slice(0, 1), paging: { next: `https://graph.facebook.com/v21.0/${FORM}/leads?after=p2&fields=${encodeURIComponent(fields)}` } });
    }
    if (leads[path]) {
      if (opts.failIds?.has(path)) return err(500, 2, "Service temporarily unavailable");
      if (opts.failFull && fields.includes("campaign_name")) return err(400, 200, "Requires ads_read permission");
      return ok(leads[path]);
    }
    return err(400, 100, `Unsupported get request: ${path}`);
  }) as typeof fetch;
  return { fetchFn, calls, subs };
}

// ---- Base de datos en memoria ----
function fakeDb(contactos: { id: string; email?: string; phone?: string; full_name?: string }[] = []) {
  const leads: LeadRow[] = [];
  const notas: { contact_id: string; body: string }[] = [];
  const last9 = (s?: string | null) => { const d = (s ?? "").replace(/\D/g, ""); return d.length >= 9 ? d.slice(-9) : null; };
  const db: Db = {
    async leadExists(id) { return leads.some((l) => l.meta_leadgen_id === id); },
    async findContact(email, tel): Promise<Contacto | null> {
      const byEmail = email ? contactos.find((c) => (c.email ?? "").trim().toLowerCase() === email.trim().toLowerCase()) : undefined;
      if (byEmail) return { id: byEmail.id, nombre: byEmail.full_name ?? "", matchedBy: "email" };
      const t = last9(tel);
      const byTel = t ? contactos.filter((c) => last9(c.phone) === t) : [];
      return byTel.length === 1 ? { id: byTel[0].id, nombre: byTel[0].full_name ?? "", matchedBy: "teléfono" } : null;
    },
    async insertLead(row) {
      if (leads.some((l) => l.meta_leadgen_id === row.meta_leadgen_id)) return null; // ON CONFLICT DO NOTHING
      leads.push(structuredClone(row));
      return "uuid-" + leads.length;
    },
    async insertNote(contact_id, body) { notas.push({ contact_id, body }); },
  };
  return { db, leads, notas };
}

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setup(leads: Record<string, Lead>, contactos: Parameters<typeof fakeDb>[0] = [], gopts = {}) {
  const g = fakeGraph(leads, gopts);
  const d = fakeDb(contactos);
  const pushes: string[] = [];
  const env: Record<string, string> = { APP_SECRET, META_LEADS_VERIFY_TOKEN: VERIFY, META_LEADS_OPS_KEY: OPS, META_LEADS_TOKEN: "SYSTEM_TOKEN" };
  const handler = createHandler({ env: (k) => env[k], fetch: g.fetchFn, db: () => d.db, push: async (t, b) => { pushes.push(`${t}: ${b}`); } });
  return { handler, ...g, ...d, pushes };
}

function webhookBody(...ids: string[]): string {
  return JSON.stringify({
    object: "page",
    entry: [{ id: PAGE, time: 1760000000, changes: ids.map((id) => ({ field: "leadgen", value: { leadgen_id: id, page_id: PAGE, form_id: FORM, ad_id: "33", adgroup_id: "33", created_time: 1760000000 } })) }],
  });
}

async function post(handler: (r: Request) => Promise<Response>, body: string, headers: Record<string, string> = {}) {
  return await handler(new Request("https://x/functions/v1/meta-leads", { method: "POST", body, headers }));
}

const LEAD_A: Lead = {
  id: "L1", created_time: "2026-10-01T09:15:00+0000", form_id: FORM, ad_id: "33", ad_name: "Anuncio otoño",
  adset_id: "44", adset_name: "Autónomos Madrid", campaign_id: "55", campaign_name: "Captación Q4", platform: "ig", is_organic: false,
  field_data: [
    { name: "full_name", values: ["Ana Pérez"] },
    { name: "email", values: ["  Ana.Perez@Example.COM "] },
    { name: "phone_number", values: ["+34600112233"] },
    { name: "company_name", values: ["Panadería Ana SL"] },
    { name: "¿cuántos_empleados_tienes?", values: ["1-5"] },
    { name: "job_title", values: ["Gerente"] },
  ],
};

// ---- GET (verificación del webhook) ----
Deno.test("GET: devuelve el challenge solo con el verify token correcto", async () => {
  const { handler } = setup({});
  const ok = await handler(new Request(`https://x/?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  const bad = await handler(new Request(`https://x/?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=12345`));
  assert.equal(bad.status, 403);
});

// ---- Firma ----
Deno.test("POST sin firma, con firma de otro secreto o de otro cuerpo: 401 y no toca nada", async () => {
  const { handler, leads, calls } = setup({ L1: LEAD_A });
  const body = webhookBody("L1");
  assert.equal((await post(handler, body)).status, 401);
  assert.equal((await post(handler, body, { "x-hub-signature-256": await sign(body, "otro") })).status, 401);
  assert.equal((await post(handler, body, { "x-hub-signature-256": await sign(body + " ") })).status, 401);
  assert.equal((await post(handler, body, { "x-hub-signature-256": "sha256=" })).status, 401);
  assert.equal((await post(handler, body, { "x-hub-signature-256": (await sign(body)).replace("sha256=", "sha1=") })).status, 401);
  assert.equal(leads.length, 0);
  assert.equal(calls.length, 0, "no se llama a Graph sin firma válida");
});

Deno.test("POST firmado: pide el lead a Graph con el token de página y lo guarda mapeado", async () => {
  const { handler, leads, calls } = setup({ L1: LEAD_A });
  const body = webhookBody("L1");
  const res = await post(handler, body, { "x-hub-signature-256": await sign(body) });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).results, { L1: "nuevo" });
  assert.equal(leads.length, 1);
  const l = leads[0];
  assert.equal(l.source, SOURCE);
  assert.equal(l.status, "new");
  assert.equal(l.aviso, true);
  assert.equal(l.meta_leadgen_id, "L1");
  assert.equal(l.nombre, "Ana Pérez");
  assert.equal(l.email, "ana.perez@example.com");
  assert.equal(l.telefono, "+34600112233");
  assert.equal(l.empresa, "Panadería Ana SL");
  assert.equal(l.servicio, "Asesoría fiscal", "sin pregunta de servicio, el nombre del formulario");
  assert.equal(l.created_at, "2026-10-01T09:15:00.000Z");
  assert.deepEqual(l.meta_origen, {
    page_id: PAGE, form_id: FORM, form_name: "Asesoría fiscal", campaign_id: "55", campaign_name: "Captación Q4",
    adset_id: "44", adset_name: "Autónomos Madrid", ad_id: "33", ad_name: "Anuncio otoño", platform: "ig",
    created_time: "2026-10-01T09:15:00+0000", is_organic: false,
  });
  assert.deepEqual(l.respuestas, [
    { campo: "¿cuántos_empleados_tienes?", pregunta: "¿cuántos empleados tienes?", respuesta: "1-5" },
    { campo: "job_title", pregunta: "Cargo", respuesta: "Gerente" },
  ]);
  assert.ok(calls.some((c) => c.startsWith("GET L1?") && c.includes("campaign_name")));
});

// ---- Idempotencia ----
Deno.test("reenvío del mismo leadgen_id (y repetido dentro del mismo lote): un solo lead, sin volver a pedirlo", async () => {
  const { handler, leads, calls } = setup({ L1: LEAD_A });
  const body = webhookBody("L1", "L1");
  const h = { "x-hub-signature-256": await sign(body) };
  assert.equal((await post(handler, body, h)).status, 200);
  const graphCalls = calls.length;
  const res2 = await post(handler, body, h);
  assert.equal(res2.status, 200);
  assert.deepEqual((await res2.json()).results, { L1: "existente" });
  assert.equal(leads.length, 1);
  assert.equal(calls.length, graphCalls, "el reenvío no vuelve a llamar a Graph");
});

Deno.test("dos entregas simultáneas: la segunda choca con el índice único y no duplica", async () => {
  const { handler, leads } = setup({ L1: LEAD_A });
  const body = webhookBody("L1");
  const h = { "x-hub-signature-256": await sign(body) };
  const [a, b] = await Promise.all([post(handler, body, h), post(handler, body, h)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(leads.length, 1);
});

// ---- Fallos de Graph ----
Deno.test("si Graph falla con un lead: 500 para que Meta reintente; los demás del lote sí se guardan", async () => {
  const LEAD_B = { ...LEAD_A, id: "L2", field_data: [{ name: "email", values: ["b@x.es"] }] };
  const { handler, leads } = setup({ L1: LEAD_A, L2: LEAD_B }, [], { failIds: new Set(["L1"]) });
  const body = webhookBody("L1", "L2");
  const res = await post(handler, body, { "x-hub-signature-256": await sign(body) });
  assert.equal(res.status, 500);
  const j = await res.json();
  assert.deepEqual(j.failed, ["L1"]);
  assert.equal(j.results.L2, "nuevo");
  assert.deepEqual(leads.map((l) => l.meta_leadgen_id), ["L2"]);
});

Deno.test("sin permiso para los nombres de campaña/anuncio: repite con los campos básicos y guarda los ids", async () => {
  const { handler, leads } = setup({ L1: LEAD_A }, [], { failFull: true });
  const body = webhookBody("L1");
  const res = await post(handler, body, { "x-hub-signature-256": await sign(body) });
  assert.equal(res.status, 200);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].meta_origen.campaign_id, "55");
});

// ---- Duplicados con contactos existentes ----
Deno.test("email ya existente (otra capitalización): se vincula al contacto, status linked y nota", async () => {
  const { handler, leads, notas } = setup({ L1: LEAD_A }, [{ id: "c-1", email: "ana.perez@example.com", full_name: "Ana" }]);
  const body = webhookBody("L1");
  const res = await post(handler, body, { "x-hub-signature-256": await sign(body) });
  assert.deepEqual((await res.json()).results, { L1: "vinculado" });
  assert.equal(leads[0].status, "linked");
  assert.equal(leads[0].contact_id, "c-1");
  assert.equal(notas.length, 1);
  assert.equal(notas[0].contact_id, "c-1");
  assert.match(notas[0].body, /mismo email/);
  assert.match(notas[0].body, /Captación Q4/);
  assert.match(notas[0].body, /¿cuántos empleados tienes\?: 1-5/);
});

Deno.test("teléfono existente en otro formato: se vincula por teléfono; con dos contactos con ese teléfono, no", async () => {
  const lead = { ...LEAD_A, field_data: [{ name: "phone_number", values: ["+34 600 11 22 33"] }] };
  let s = setup({ L1: lead }, [{ id: "c-2", phone: "600112233" }]);
  let body = webhookBody("L1");
  await post(s.handler, body, { "x-hub-signature-256": await sign(body) });
  assert.equal(s.leads[0].contact_id, "c-2");
  assert.match(s.notas[0].body, /mismo teléfono/);

  s = setup({ L1: lead }, [{ id: "c-2", phone: "600112233" }, { id: "c-3", phone: "0034 600112233" }]);
  body = webhookBody("L1");
  await post(s.handler, body, { "x-hub-signature-256": await sign(body) });
  assert.equal(s.leads[0].status, "new");
  assert.equal(s.leads[0].contact_id, undefined);
  assert.equal(s.notas.length, 0);
});

Deno.test("el reenvío de un lead vinculado no repite la nota", async () => {
  const { handler, notas } = setup({ L1: LEAD_A }, [{ id: "c-1", email: "ana.perez@example.com" }]);
  const body = webhookBody("L1");
  const h = { "x-hub-signature-256": await sign(body) };
  await post(handler, body, h);
  await post(handler, body, h);
  assert.equal(notas.length, 1);
});

// ---- Campos raros ----
Deno.test("campos raros: sin field_data, valores vacíos, varios valores, nombres partidos, casillas y textos largos", () => {
  assert.deepEqual(mapLead({ id: 7 }, {}).respuestas, []);
  const r = mapLead({
    id: "L9",
    created_time: "no-es-fecha",
    field_data: [
      { name: "first_name", values: ["  José "] },
      { name: "last_name", values: ["García\nLópez"] },
      { name: "email", values: [""] },
      { name: "work_email", values: ["JOSE@EMPRESA.ES"] },
      { name: "¿Qué servicio te interesa?", values: ["Laboral", "Fiscal"] },
      { name: "comentarios", values: ["x".repeat(5000)] },
      { name: "vacía", values: [] },
      { name: "nula", values: null },
      { name: "", values: ["sin nombre de campo"] },
      { name: "<b>html</b>", values: ["<script>"] },
      { name: "numero", values: [42] },
      { name: "objeto", values: [{ a: 1 }] },
      { name: "job_title", values: ["Uno"] },
      { name: "job_title", values: ["Repetido"] },
    ],
    custom_disclaimer_responses: [{ checkbox_key: "acepto_privacidad", is_checked: "1" }, { checkbox_key: "comerciales", is_checked: "" }],
  }, { formName: null });
  assert.equal(r.nombre, "José García López");
  assert.equal(r.email, "jose@empresa.es");
  assert.equal(r.telefono, null);
  assert.equal(r.empresa, null);
  assert.equal(r.servicio, "Laboral, Fiscal");
  assert.equal(r.mensaje!.length, 2000);
  assert.equal(r.created_at, undefined, "fecha inválida: la pone la base de datos");
  assert.equal(r.meta_leadgen_id, "L9");
  const preguntas = r.respuestas.map((x) => `${x.pregunta}=${x.respuesta}`);
  assert.deepEqual(preguntas, [
    "<b>html</b>=<script>",
    "Numero=42",
    'Objeto={"a":1}',
    "Cargo=Uno",
    "Casilla: Acepto privacidad=Sí",
    "Casilla: Comerciales=No",
  ]);
  // Los que sí acabaron en columnas propias o en servicio/mensaje no se repiten en respuestas.
  assert.ok(!preguntas.some((p) => /servicio|comentarios/i.test(p)));
});

Deno.test("extractLeadgenEvents ignora otros campos, cuerpos raros y leadgen sin id", () => {
  assert.deepEqual(extractLeadgenEvents(null), []);
  assert.deepEqual(extractLeadgenEvents({ entry: "x" }), []);
  assert.deepEqual(extractLeadgenEvents({
    entry: [{ id: "P", changes: [{ field: "feed", value: { leadgen_id: "no" } }, { field: "leadgen", value: {} }, { field: "leadgen", value: { leadgen_id: 123 } }] }],
  }), [{ leadgen_id: "123", page_id: "P", form_id: undefined, ad_id: undefined, adgroup_id: undefined }]);
});

Deno.test("POST firmado con JSON inválido: 400; sin eventos leadgen: 200 sin llamar a Graph", async () => {
  const { handler, calls } = setup({});
  const bad = "{no-json";
  assert.equal((await post(handler, bad, { "x-hub-signature-256": await sign(bad) })).status, 400);
  const other = JSON.stringify({ object: "page", entry: [{ id: PAGE, changes: [{ field: "feed", value: {} }] }] });
  assert.equal((await post(handler, other, { "x-hub-signature-256": await sign(other) })).status, 200);
  assert.equal(calls.length, 0);
});

// ---- Operación ----
Deno.test("acciones de operación: 401 sin la clave correcta (y nunca por la ruta firmada)", async () => {
  const { handler, calls } = setup({});
  const body = JSON.stringify({ action: "check" });
  assert.equal((await post(handler, body, { "x-ops-key": "mala" })).status, 401);
  assert.equal((await post(handler, body, { "x-ops-key": "" })).status, 401);
  assert.equal(calls.length, 0);
});

Deno.test("check: solo GET y no devuelve tokens", async () => {
  const { handler, calls } = setup({});
  const res = await post(handler, JSON.stringify({ action: "check", page_id: PAGE }), { "x-ops-key": OPS });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("PAGE_TOKEN") && !text.includes("SYSTEM_TOKEN"));
  assert.ok(calls.every((c) => c.startsWith("GET ")));
  const j = JSON.parse(text);
  assert.equal(j.page_details[PAGE].forms[0].name, "Asesoría fiscal");
  assert.equal(j.page_details[PAGE].page_token, "obtenido");
});

Deno.test("subscribe: añade leadgen conservando los campos que la app ya tenía", async () => {
  const { handler, subs } = setup({});
  const res = await post(handler, JSON.stringify({ action: "subscribe", page_id: PAGE }), { "x-ops-key": OPS });
  assert.equal(res.status, 200);
  assert.deepEqual(subs[0].subscribed_fields, ["feed", "leadgen"]);
});

Deno.test("import: dry_run por defecto no escribe; real recorre páginas, sin aviso por lead, sin duplicar, un push de resumen", async () => {
  const LEAD_B = { ...LEAD_A, id: "L2", field_data: [{ name: "email", values: ["ya@existe.es"] }] };
  const LEAD_C = { ...LEAD_A, id: "L3", field_data: [{ name: "full_name", values: ["Carla"] }] };
  const s = setup({ L1: LEAD_A, L2: LEAD_B, L3: LEAD_C }, [{ id: "c-9", email: "ya@existe.es" }]);

  const dry = await (await post(s.handler, JSON.stringify({ action: "import", page_id: PAGE }), { "x-ops-key": OPS })).json();
  assert.equal(dry.dry_run, true);
  assert.equal(dry.total, 3);
  assert.equal(dry.nuevos, 2);
  assert.equal(dry.vinculados, 1);
  assert.equal(s.leads.length, 0);
  assert.equal(s.pushes.length, 0);

  // L1 ya llegó antes por el webhook.
  const body = webhookBody("L1");
  await post(s.handler, body, { "x-hub-signature-256": await sign(body) });

  const real = await (await post(s.handler, JSON.stringify({ action: "import", page_id: PAGE, dry_run: false }), { "x-ops-key": OPS })).json();
  assert.equal(real.total, 3);
  assert.equal(real.existentes, 1);
  assert.equal(real.nuevos, 1);
  assert.equal(real.vinculados, 1);
  assert.equal(s.leads.length, 3);
  assert.deepEqual(s.leads.map((l) => l.aviso), [true, false, false]);
  assert.equal(s.leads.find((l) => l.meta_leadgen_id === "L2")!.contact_id, "c-9");
  assert.deepEqual(s.pushes, ["Leads de Meta importados: 1 nuevo(s), 1 vinculado(s) a contactos que ya existían"]);

  const again = await (await post(s.handler, JSON.stringify({ action: "import", page_id: PAGE, dry_run: false }), { "x-ops-key": OPS })).json();
  assert.equal(again.existentes, 3);
  assert.equal(s.leads.length, 3);
  assert.equal(s.pushes.length, 1, "sin nada nuevo no hay push");
});
