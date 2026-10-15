// Lógica de meta-leads, separada de index.ts para poder probarla con la
// Graph API y la base de datos simuladas (ver leads_test.ts). index.ts solo
// conecta esto con Deno.serve, fetch, Supabase y push-send.

export const GRAPH_API_VERSION = "v21.0"; // la misma que whatsapp-webhook
export const SOURCE = "Meta Lead Ads";

// ---- Firma X-Hub-Signature-256 (HMAC-SHA256 del cuerpo crudo con el App Secret) ----
// Igual que en whatsapp-webhook (cada función es autocontenida).
export async function verifySignature(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=") || !appSecret) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, signatureHeader.slice("sha256=".length));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Graph API ----
export class GraphError extends Error {
  constructor(public status: number, public body: any) {
    super(`Graph API ${status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  }
  // Lo que se le enseña a quien opera (acción check): el error tal cual lo
  // da Meta, sin el token.
  get detail() {
    const e = this.body?.error ?? {};
    return { status: this.status, code: e.code ?? null, subcode: e.error_subcode ?? null, type: e.type ?? null, message: e.message ?? null, fbtrace_id: e.fbtrace_id ?? null };
  }
}

export type Graph = (path: string, opts?: { token?: string; params?: Record<string, string>; method?: "GET" | "POST" }) => Promise<any>;

export function makeGraph(fetchFn: typeof fetch, defaultToken: string): Graph {
  return async (path, opts = {}) => {
    const url = path.startsWith("https://") ? new URL(path) : new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\//, "")}`);
    // paging.next llega en la respuesta: el token solo viaja a la Graph API.
    if (url.hostname !== "graph.facebook.com") throw new Error(`URL fuera de la Graph API: ${url.hostname}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    const res = await fetchFn(url.toString(), {
      method: opts.method ?? "GET",
      headers: { "Authorization": `Bearer ${opts.token ?? defaultToken}` },
    });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
    if (!res.ok || body?.error) throw new GraphError(res.status, body);
    return body;
  };
}

// Recorre una lista paginada de la Graph API (data + paging.next).
export async function graphAll(graph: Graph, path: string, opts: { token?: string; params?: Record<string, string> } = {}, max = 5000): Promise<any[]> {
  const out: any[] = [];
  let page = await graph(path, opts);
  while (true) {
    out.push(...(page.data ?? []));
    const next = page.paging?.next;
    if (!next || out.length >= max) break;
    page = await graph(next, { token: opts.token });
  }
  return out;
}

// Campos del lead. Los nombres (ad_name, campaign_name...) pueden necesitar
// permisos de anuncios que el token no tenga: si la petición completa falla,
// se repite con los básicos (los ids siguen llegando).
export const LEAD_FIELDS_FULL = "id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,is_organic,platform,custom_disclaimer_responses";
export const LEAD_FIELDS_BASIC = "id,created_time,field_data,form_id,ad_id,adset_id,campaign_id,is_organic,platform,custom_disclaimer_responses";

export async function fetchLead(graph: Graph, leadgenId: string, token?: string): Promise<any> {
  try {
    return await graph(encodeURIComponent(leadgenId), { token, params: { fields: LEAD_FIELDS_FULL } });
  } catch (e) {
    if (e instanceof GraphError && e.status !== 401 && e.body?.error?.code !== 190) {
      return await graph(encodeURIComponent(leadgenId), { token, params: { fields: LEAD_FIELDS_BASIC } });
    }
    throw e;
  }
}

export async function listFormLeads(graph: Graph, formId: string, token?: string): Promise<any[]> {
  try {
    return await graphAll(graph, `${encodeURIComponent(formId)}/leads`, { token, params: { fields: LEAD_FIELDS_FULL, limit: "100" } });
  } catch (e) {
    if (e instanceof GraphError && e.status !== 401 && e.body?.error?.code !== 190) {
      return await graphAll(graph, `${encodeURIComponent(formId)}/leads`, { token, params: { fields: LEAD_FIELDS_BASIC, limit: "100" } });
    }
    throw e;
  }
}

// Token de página: para leer formularios y leads y para subscribed_apps Meta
// pide el de la página; se obtiene con el del usuario del sistema. Si no lo
// devuelve (la página no está asignada al usuario del sistema), se sigue con
// el del usuario del sistema y que la API diga si le basta.
export async function pageToken(graph: Graph, pageId: string, cache: Map<string, string>): Promise<string | undefined> {
  if (cache.has(pageId)) return cache.get(pageId);
  try {
    const r = await graph(encodeURIComponent(pageId), { params: { fields: "access_token" } });
    if (typeof r.access_token === "string" && r.access_token) {
      cache.set(pageId, r.access_token);
      return r.access_token;
    }
  } catch (_) { /* sin token de página: se usa el del usuario del sistema */ }
  return undefined;
}

// ---- Mapeo de field_data a una fila de public.leads ----
const MAX_LEN = 2000;

function clean(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\s+/g, " ").trim();
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + "…" : s;
}

function valueOf(field: any): string {
  const vals = Array.isArray(field?.values) ? field.values : field?.values != null ? [field.values] : [];
  return vals.map(clean).filter(Boolean).join(", ");
}

function normKey(k: string): string {
  return k.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Etiquetas en castellano de las preguntas estándar de Meta que no tienen
// columna propia; las personalizadas se muestran con su propio nombre.
const LABELS: Record<string, string> = {
  job_title: "Cargo", city: "Ciudad", state: "Provincia", province: "Provincia", zip_code: "Código postal",
  post_code: "Código postal", country: "País", street_address: "Dirección", date_of_birth: "Fecha de nacimiento",
  gender: "Sexo", marital_status: "Estado civil", military_status: "Situación militar", relationship_status: "Situación sentimental",
  work_email: "Email de trabajo", work_phone_number: "Teléfono de trabajo", first_name: "Nombre", last_name: "Apellidos",
  national_id_number: "Documento de identidad", cpf_number: "CPF", company_name: "Empresa", full_name: "Nombre completo",
  phone_number: "Teléfono", email: "Email",
};

function humanize(key: string): string {
  const k = normKey(key);
  if (LABELS[k]) return LABELS[k];
  const s = clean(key).replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Pregunta sin nombre";
}

export type Respuesta = { campo: string; pregunta: string; respuesta: string };

export type LeadRow = {
  nombre: string | null; empresa: string | null; email: string | null; telefono: string | null;
  servicio: string | null; mensaje: string | null; lang: string; source: string; status: string;
  created_at?: string; meta_leadgen_id: string; meta_origen: Record<string, unknown>;
  respuestas: Respuesta[]; contact_id?: string | null; aviso: boolean;
};

export function mapLead(lead: any, ctx: { formName?: string | null; pageId?: string | null; adgroupId?: string | null }): LeadRow {
  const fields: any[] = Array.isArray(lead?.field_data) ? lead.field_data : [];
  const byKey = new Map<string, string>();
  for (const f of fields) {
    const k = normKey(String(f?.name ?? ""));
    const v = valueOf(f);
    if (k && v && !byKey.has(k)) byKey.set(k, v);
  }
  const take = (...keys: string[]) => {
    for (const k of keys) if (byKey.get(k)) return { key: k, value: byKey.get(k)! };
    return null;
  };

  const used = new Set<string>();
  const use = (r: { key: string; value: string } | null) => { if (r) used.add(r.key); return r?.value ?? null; };

  let nombre = use(take("full_name", "nombre_completo", "nombre_y_apellidos"));
  if (!nombre) {
    const first = take("first_name", "nombre");
    const last = take("last_name", "apellidos", "apellido");
    const parts = [use(first), use(last)].filter(Boolean);
    nombre = parts.length ? parts.join(" ") : null;
  }
  const emailRaw = use(take("email", "correo_electronico", "work_email"));
  const email = emailRaw ? emailRaw.replace(/\s+/g, "").toLowerCase() : null;
  const telefono = use(take("phone_number", "telefono", "phone", "work_phone_number", "movil"));
  const empresa = use(take("company_name", "empresa", "nombre_de_la_empresa", "company"));

  // Pregunta personalizada que parezca el servicio o un mensaje libre.
  let servicio: string | null = null;
  let mensaje: string | null = null;
  for (const [k, v] of byKey) {
    if (used.has(k)) continue;
    if (!servicio && /servicio/.test(k)) { servicio = v; used.add(k); }
    else if (!mensaje && /(mensaje|comentario|consulta|observaciones)/.test(k)) { mensaje = v; used.add(k); }
  }

  const respuestas: Respuesta[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    const raw = String(f?.name ?? "");
    const k = normKey(raw);
    if (!k || used.has(k) || seen.has(k)) continue;
    seen.add(k);
    const v = valueOf(f);
    if (!v) continue;
    respuestas.push({ campo: clean(raw), pregunta: humanize(raw), respuesta: v });
  }
  for (const d of Array.isArray(lead?.custom_disclaimer_responses) ? lead.custom_disclaimer_responses : []) {
    if (!d?.checkbox_key) continue;
    respuestas.push({ campo: clean(d.checkbox_key), pregunta: "Casilla: " + humanize(String(d.checkbox_key)), respuesta: d.is_checked === "1" || d.is_checked === true ? "Sí" : "No" });
  }

  const origen: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { const s = clean(v); if (s) origen[k] = s; };
  put("page_id", ctx.pageId);
  put("form_id", lead?.form_id);
  put("form_name", ctx.formName);
  put("campaign_id", lead?.campaign_id);
  put("campaign_name", lead?.campaign_name);
  put("adset_id", lead?.adset_id);
  put("adset_name", lead?.adset_name);
  put("ad_id", lead?.ad_id ?? ctx.adgroupId);
  put("ad_name", lead?.ad_name);
  put("platform", lead?.platform);
  put("created_time", lead?.created_time);
  if (typeof lead?.is_organic === "boolean") origen.is_organic = lead.is_organic;

  const created = lead?.created_time ? new Date(String(lead.created_time).replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : null;

  const row: LeadRow = {
    nombre, empresa, email, telefono,
    servicio: servicio ?? (clean(ctx.formName) || null),
    mensaje,
    lang: "es",
    source: SOURCE,
    status: "new",
    meta_leadgen_id: String(lead.id),
    meta_origen: origen,
    respuestas,
    aviso: true,
  };
  if (created && !isNaN(created.getTime())) row.created_at = created.toISOString();
  return row;
}

// ---- Base de datos (lo que la lógica necesita; index.ts lo implementa con Supabase) ----
export type Contacto = { id: string; nombre: string; matchedBy: "email" | "teléfono" };

export interface Db {
  leadExists(leadgenId: string): Promise<boolean>;
  findContact(email: string | null, telefono: string | null): Promise<Contacto | null>;
  // null si ya existía (conflicto con meta_leadgen_id): no se insertó nada.
  insertLead(row: LeadRow): Promise<string | null>;
  insertNote(contactId: string, body: string): Promise<void>;
}

export function linkNote(row: LeadRow, c: Contacto): string {
  const o = row.meta_origen as Record<string, string>;
  const donde = [o.form_name && `formulario «${o.form_name}»`, o.campaign_name && `campaña «${o.campaign_name}»`, o.ad_name && `anuncio «${o.ad_name}»`].filter(Boolean).join(", ");
  const lines = [
    `Nuevo lead de Meta Lead Ads${donde ? " (" + donde + ")" : ""}. Ya existía este contacto con el mismo ${c.matchedBy}, así que se ha vinculado aquí en vez de crear otro.`,
    ...[["Nombre", row.nombre], ["Email", row.email], ["Teléfono", row.telefono], ["Empresa", row.empresa]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    ...row.respuestas.map((r) => `${r.pregunta}: ${r.respuesta}`),
  ];
  return lines.join("\n");
}

export type Outcome = "nuevo" | "vinculado" | "existente";

// Guarda un lead ya leído de Meta. Idempotente: si el leadgen_id ya está, no
// hace nada. Si el email o el teléfono ya son de un contacto, el lead entra
// vinculado a él (status 'linked', el CRM no crea otro) y se deja una nota
// en ese contacto.
export async function storeLead(db: Db, row: LeadRow): Promise<{ outcome: Outcome; contact?: Contacto }> {
  const contact = await db.findContact(row.email, row.telefono);
  if (contact) { row.status = "linked"; row.contact_id = contact.id; }
  const id = await db.insertLead(row);
  if (!id) return { outcome: "existente" };
  if (contact) {
    try { await db.insertNote(contact.id, linkNote(row, contact)); }
    catch (e) { console.error("meta-leads: no se pudo crear la nota de vinculación", e); }
    return { outcome: "vinculado", contact };
  }
  return { outcome: "nuevo" };
}

// ---- Webhook: entry[].changes[] con field "leadgen" ----
export type LeadgenEvent = { leadgen_id: string; page_id?: string; form_id?: string; ad_id?: string; adgroup_id?: string };

export function extractLeadgenEvents(payload: any): LeadgenEvent[] {
  const out: LeadgenEvent[] = [];
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entry)) return out;
  for (const entry of payload.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "leadgen") continue;
      const v = change.value ?? {};
      if (v.leadgen_id === undefined || v.leadgen_id === null || v.leadgen_id === "") continue;
      out.push({
        leadgen_id: String(v.leadgen_id),
        page_id: v.page_id != null ? String(v.page_id) : entry?.id != null ? String(entry.id) : undefined,
        form_id: v.form_id != null ? String(v.form_id) : undefined,
        ad_id: v.ad_id != null ? String(v.ad_id) : undefined,
        adgroup_id: v.adgroup_id != null ? String(v.adgroup_id) : undefined,
      });
    }
  }
  return out;
}

async function formName(graph: Graph, formId: string | undefined, token: string | undefined, cache: Map<string, string | null>): Promise<string | null> {
  if (!formId) return null;
  if (cache.has(formId)) return cache.get(formId)!;
  let name: string | null = null;
  try { name = (await graph(encodeURIComponent(formId), { token, params: { fields: "name" } }))?.name ?? null; }
  catch (e) { console.error("meta-leads: no se pudo leer el nombre del formulario", formId, e); }
  cache.set(formId, name);
  return name;
}

// Procesa los leadgen_id de un webhook. Devuelve los que fallaron: el
// llamante responde 500 para que Meta reintente (los ya guardados no se
// duplican al reintentar).
export async function processWebhook(graph: Graph, db: Db, payload: any): Promise<{ results: Record<string, Outcome>; failed: string[] }> {
  const results: Record<string, Outcome> = {};
  const failed: string[] = [];
  const tokens = new Map<string, string>();
  const forms = new Map<string, string | null>();
  const events = extractLeadgenEvents(payload);
  const unique = [...new Map(events.map((e) => [e.leadgen_id, e])).values()];
  for (const ev of unique) {
    try {
      if (await db.leadExists(ev.leadgen_id)) { results[ev.leadgen_id] = "existente"; continue; }
      const token = ev.page_id ? await pageToken(graph, ev.page_id, tokens) : undefined;
      const lead = (await fetchLead(graph, ev.leadgen_id, token)) ?? {};
      lead.id ??= ev.leadgen_id;
      const name = await formName(graph, lead.form_id ?? ev.form_id, token, forms);
      const row = mapLead({ ...lead, form_id: lead.form_id ?? ev.form_id, ad_id: lead.ad_id ?? ev.ad_id }, { formName: name, pageId: ev.page_id, adgroupId: ev.adgroup_id });
      results[ev.leadgen_id] = (await storeLead(db, row)).outcome;
    } catch (e) {
      console.error("meta-leads: fallo procesando leadgen_id", ev.leadgen_id, e);
      failed.push(ev.leadgen_id);
    }
  }
  return { results, failed };
}

// ---- Operación (acciones check / subscribe / import) ----

// Solo lectura: quién es el token, qué permisos tiene, qué páginas ve, sus
// formularios y qué apps están suscritas. Nunca devuelve tokens.
export async function checkAccess(graph: Graph, pageId?: string): Promise<any> {
  const out: any = {};
  const step = async (name: string, fn: () => Promise<any>) => {
    try { out[name] = await fn(); }
    catch (e) { out[name] = { error: e instanceof GraphError ? e.detail : String(e) }; }
  };
  await step("me", () => graph("me", { params: { fields: "id,name" } }));
  await step("app", async () => { const a = await graph("app", { params: { fields: "id,name" } }); return { id: a.id, name: a.name }; });
  await step("permissions", async () => (await graph("me/permissions")).data);
  await step("pages", async () => (await graphAll(graph, "me/accounts", { params: { fields: "id,name,tasks", limit: "100" } }))
    .map((p: any) => ({ id: p.id, name: p.name, tasks: p.tasks })));
  const ids: string[] = pageId ? [pageId] : Array.isArray(out.pages) ? out.pages.map((p: any) => p.id) : [];
  out.page_details = {};
  for (const id of ids) {
    const d: any = {};
    const tokens = new Map<string, string>();
    const token = await pageToken(graph, id, tokens);
    d.page_token = token ? "obtenido" : "no disponible (se usa el del usuario del sistema)";
    try { d.page = await graph(encodeURIComponent(id), { token, params: { fields: "id,name" } }); }
    catch (e) { d.page = { error: e instanceof GraphError ? e.detail : String(e) }; }
    try {
      d.forms = (await graphAll(graph, `${encodeURIComponent(id)}/leadgen_forms`, { token, params: { fields: "id,name,status,leads_count,created_time", limit: "100" } }));
    } catch (e) { d.forms = { error: e instanceof GraphError ? e.detail : String(e) }; }
    try { d.subscribed_apps = (await graph(`${encodeURIComponent(id)}/subscribed_apps`, { token })).data; }
    catch (e) { d.subscribed_apps = { error: e instanceof GraphError ? e.detail : String(e) }; }
    out.page_details[id] = d;
  }
  return out;
}

// Suscribe la app a leadgen sin quitarle los campos que ya tuviera en esa
// página (POST subscribed_apps sustituye la lista de campos de la app).
export async function subscribePage(graph: Graph, pageId: string): Promise<any> {
  const tokens = new Map<string, string>();
  const token = await pageToken(graph, pageId, tokens);
  const app = await graph("app", { params: { fields: "id,name" } });
  const current = (await graph(`${encodeURIComponent(pageId)}/subscribed_apps`, { token })).data ?? [];
  const mine = current.find((a: any) => String(a.id) === String(app.id));
  const fields = new Set<string>(Array.isArray(mine?.subscribed_fields) ? mine.subscribed_fields : []);
  const before = [...fields];
  fields.add("leadgen");
  const res = await graph(`${encodeURIComponent(pageId)}/subscribed_apps`, { token, method: "POST", params: { subscribed_fields: [...fields].join(",") } });
  const after = (await graph(`${encodeURIComponent(pageId)}/subscribed_apps`, { token })).data ?? [];
  return { app: { id: app.id, name: app.name }, before, requested: [...fields], result: res, after };
}

// Importa los leads de todos los formularios de la página. Sin aviso por
// lead (aviso=false); el llamante manda un push de resumen. dryRun: cuenta
// sin escribir nada.
export async function importPage(graph: Graph, db: Db, pageId: string, dryRun: boolean): Promise<any> {
  const tokens = new Map<string, string>();
  const token = await pageToken(graph, pageId, tokens);
  const forms = await graphAll(graph, `${encodeURIComponent(pageId)}/leadgen_forms`, { token, params: { fields: "id,name,status,leads_count", limit: "100" } });
  const summary = { dry_run: dryRun, formularios: [] as any[], total: 0, nuevos: 0, vinculados: 0, existentes: 0, errores: [] as any[] };
  for (const form of forms) {
    const f = { id: form.id, name: form.name ?? null, status: form.status ?? null, leads: 0, nuevos: 0, vinculados: 0, existentes: 0 };
    let leads: any[];
    try { leads = await listFormLeads(graph, form.id, token); }
    catch (e) {
      summary.errores.push({ form_id: form.id, error: e instanceof GraphError ? e.detail : String(e) });
      summary.formularios.push(f);
      continue;
    }
    for (const lead of leads) {
      f.leads++; summary.total++;
      try {
        if (await db.leadExists(String(lead.id))) { f.existentes++; summary.existentes++; continue; }
        const row = mapLead({ ...lead, form_id: lead.form_id ?? form.id }, { formName: form.name ?? null, pageId });
        row.aviso = false;
        if (dryRun) {
          const c = await db.findContact(row.email, row.telefono);
          if (c) { f.vinculados++; summary.vinculados++; } else { f.nuevos++; summary.nuevos++; }
          continue;
        }
        const { outcome } = await storeLead(db, row);
        if (outcome === "nuevo") { f.nuevos++; summary.nuevos++; }
        else if (outcome === "vinculado") { f.vinculados++; summary.vinculados++; }
        else { f.existentes++; summary.existentes++; }
      } catch (e) {
        summary.errores.push({ leadgen_id: lead.id, error: e instanceof GraphError ? e.detail : String(e) });
      }
    }
    summary.formularios.push(f);
  }
  return summary;
}

// ---- Manejador HTTP (index.ts le pasa el entorno real; las pruebas, uno simulado) ----
export type Deps = {
  env: (k: string) => string | undefined;
  fetch: typeof fetch;
  db: () => Db;
  push: (title: string, body: string) => Promise<void>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function handleOps(req: Request, deps: Deps): Promise<Response> {
  const opsKey = deps.env("META_LEADS_OPS_KEY") ?? "";
  if (!opsKey || !timingSafeEqual(req.headers.get("x-ops-key") ?? "", opsKey)) return json({ error: "No autorizado." }, 401);
  const token = deps.env("META_LEADS_TOKEN");
  if (!token) return json({ error: "Falta META_LEADS_TOKEN." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido." }, 400); }
  const graph = makeGraph(deps.fetch, token);
  const pageId = body?.page_id ? String(body.page_id) : undefined;

  switch (body?.action) {
    case "check":
      return json(await checkAccess(graph, pageId));
    case "subscribe":
      if (!pageId) return json({ error: "Falta page_id." }, 400);
      return json(await subscribePage(graph, pageId));
    case "import": {
      if (!pageId) return json({ error: "Falta page_id." }, 400);
      // Sin dry_run:false explícito solo cuenta, no escribe.
      const dryRun = body.dry_run !== false;
      const summary = await importPage(graph, deps.db(), pageId, dryRun);
      if (!dryRun && summary.nuevos + summary.vinculados > 0) {
        try {
          await deps.push(
            "Leads de Meta importados",
            `${summary.nuevos} nuevo(s)` + (summary.vinculados ? `, ${summary.vinculados} vinculado(s) a contactos que ya existían` : ""),
          );
        } catch (e) { console.error("meta-leads: push de resumen falló", e); }
      }
      return json(summary);
    }
    default:
      return json({ error: "Acción desconocida (check | subscribe | import)." }, 400);
  }
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      // ---- GET: verificación del webhook (challenge de Meta) ----
      if (req.method === "GET") {
        const params = new URL(req.url).searchParams;
        const verifyToken = deps.env("META_LEADS_VERIFY_TOKEN");
        if (params.get("hub.mode") === "subscribe" && verifyToken && timingSafeEqual(params.get("hub.verify_token") ?? "", verifyToken)) {
          return new Response(params.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
        }
        return new Response("Forbidden", { status: 403 });
      }

      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

      if (req.headers.has("x-ops-key")) return await handleOps(req, deps);

      // ---- POST de Meta: solo firmado ----
      const rawBody = await req.text();
      if (!(await verifySignature(rawBody, req.headers.get("x-hub-signature-256"), deps.env("APP_SECRET") ?? ""))) {
        console.error("meta-leads: firma X-Hub-Signature-256 inválida o ausente");
        return json({ error: "Firma inválida." }, 401);
      }
      let payload: any;
      try { payload = JSON.parse(rawBody); } catch { return json({ error: "JSON inválido." }, 400); }

      const token = deps.env("META_LEADS_TOKEN");
      if (!token) {
        console.error("meta-leads: falta META_LEADS_TOKEN");
        return json({ error: "Falta META_LEADS_TOKEN." }, 500);
      }
      const { results, failed } = await processWebhook(makeGraph(deps.fetch, token), deps.db(), payload);
      // 500 si algún lead no se pudo guardar: Meta reintenta y los que ya
      // entraron no se duplican.
      if (failed.length) return json({ ok: false, results, failed }, 500);
      return json({ ok: true, results });
    } catch (e) {
      console.error("meta-leads: fallo inesperado", e);
      return json({ error: "Error interno." }, 500);
    }
  };
}
