// Prueba de crm/supabase-agente.sql en PGlite: estructura real (pg_dump
// --schema-only, sin datos) de las tablas implicadas + stubs de Supabase.
// Uso (desde crm/tests/agente): npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const mig = fs.readFileSync(process.argv[2] || new URL("../../supabase-agente.sql", import.meta.url), "utf8");
const base = fs.readFileSync(dir + "esquema-base.sql", "utf8");

function parte(id) {
  const re = new RegExp(`-- ${id} [\\s\\S]*?(?=\\n-- =+\\n-- 1[A-Z] |$)`);
  const m = mig.match(re); if (!m) throw new Error("sin parte " + id);
  return m[0];
}

const db = new PGlite();
let fallos = 0, total = 0;
const ok = (c, msg) => { total++; console.log((c ? "  ok   " : "  FALLO ") + msg); if (!c) fallos++; };
const q = async (s, p) => (await db.query(s, p)).rows;

await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create function public.set_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at := now(); return new; end $$;
  create function public.phone_last9(raw text) returns text language sql immutable as $$
    select case when length(regexp_replace(coalesce(raw, ''), '\\D', '', 'g')) >= 9
                then right(regexp_replace(raw, '\\D', '', 'g'), 9) else null end $$;
  create function public.correo_norm(p text) returns text language sql immutable as $$ select nullif(lower(btrim(p)), '') $$;
  create function public.correo_emails_de(p jsonb) returns text[] language sql immutable as $$
    select coalesce(array_agg(public.correo_norm(e->>'email') order by o), '{}')
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) with ordinality as x(e, o)
    where public.correo_norm(e->>'email') is not null $$;
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
`);
// is_admin / is_admin_role van después de crear admins (son SQL).
const baseSinPoliticas = base;
await db.exec(baseSinPoliticas.replace(/CREATE POLICY[\s\S]*?;\n/g, ""));
await db.exec(`
  CREATE FUNCTION public.is_admin(uid uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public' AS $$ select exists (select 1 from public.admins where auth_user_id = uid and activo = true) $$;
  CREATE FUNCTION public.is_admin_role(uid uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public' AS $$ select exists (select 1 from public.admins where auth_user_id = uid and activo = true and rol = 'admin') $$;
`);
await db.exec((base.match(/CREATE POLICY[\s\S]*?;\n/g) || []).join("\n"));
// Privilegios como en Supabase: las tablas existentes las lee authenticated
// (la RLS decide); las funciones nuevas nacen con EXECUTE para anon y
// authenticated (default privileges de Supabase), que la migración revoca.
await db.exec(`
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);
console.log(`políticas base cargadas: ${(await q("select count(*)::int n from pg_policies"))[0].n}`);

// ---------------------------------------------------------------- 1A
console.log("1A:");
const A = Object.fromEntries((await db.exec(parte("1A"))).at(-1).rows.map(r => [r.comprobacion, r.valor]));
console.log("   ", JSON.stringify(A));
const paresColumnas = (parte("1A").match(/\('[a-z_]+', '[a-z_0-9]+'\)/g) || []).length;
ok(paresColumnas === 137, `1A: la lista tiene 137 columnas (${paresColumnas})`);
ok(A["tablas base"] === "15" && A["columnas usadas"] === "137" && A["funciones base"] === "4",
   "1A: dependencias presentes");
ok(A["pg_cron"] === "no", "1A: pg_cron = no en PGlite (cron está simulado; en producción debe salir sí)");
ok(A["tablas agente_*"] === "0" && A["funciones agente_*"] === "0" && A["job agente-retencion"] === "0"
   && A["migración 20261113120000"] === "no", "1A: nada del agente existe aún");

// ---------------------------------------------------------------- 1B
console.log("1B:");
await db.exec(parte("1B"));
ok(true, "1B aplicado");
try { await db.exec(parte("1B")); ok(false, "1B dos veces debería fallar"); }
catch (e) { ok(/ya está aplicada/.test(e.message), "1B se niega a repetirse"); }

// ---------------------------------------------------------------- 1C
console.log("1C:");
const C = Object.fromEntries((await db.exec(parte("1C"))).at(-1).rows.map(r => [r.comprobacion, r.valor]));
console.log("   ", JSON.stringify(C));
ok(C["tablas"] === "3" && C["RLS activada"] === "3" && C["políticas"] === "7", "1C: tablas, RLS, políticas");
ok(C["RPC agente_* (invoker, stable)"] === "12" && C["auxiliares"] === "5", "1C: 12 RPC + 5 auxiliares");
ok(C["funciones agente_* con EXECUTE para anon"] === "0", "1C: anon sin EXECUTE");
ok(C["funciones agente_* sin EXECUTE para authenticated"] === "2", "1C: retención y trigger sin EXECUTE");
ok(C["authenticated conversaciones s/i/u/d"] === "true/true/true/false", "1C: privilegios conversaciones");
ok(C["authenticated mensajes s/i/u/d"] === "true/true/false/false", "1C: privilegios mensajes");
ok(C["authenticated tool_calls s/i/u/d"] === "true/true/false/false", "1C: privilegios tool_calls");
ok(C["anon conversaciones/mensajes/tool_calls select"] === "false/false/false", "1C: anon sin tablas");
ok(C["job agente-retencion"] === "40 3 * * *", "1C: job de retención");
ok(C["filas conversaciones/mensajes/tool_calls"] === "0/0/0", "1C: tablas vacías");
ok(/^20261113120000 /.test(C["migración registrada"] || ""), "1C: migración registrada");

// ---------------------------------------------------------------- datos de prueba
const U = { admin: "11111111-1111-1111-1111-111111111111", miembro: "22222222-2222-2222-2222-222222222222",
            inactivo: "33333333-3333-3333-3333-333333333333", portal: "44444444-4444-4444-4444-444444444444" };
const E1 = "e1000000-0000-0000-0000-000000000001", E2 = "e2000000-0000-0000-0000-000000000002";
const C1 = "c1000000-0000-0000-0000-000000000001", C2 = "c2000000-0000-0000-0000-000000000002";
const K1 = "a1000000-0000-0000-0000-000000000001", K2 = "a2000000-0000-0000-0000-000000000002",
      K3 = "a3000000-0000-0000-0000-000000000003", KX = "a9000000-0000-0000-0000-000000000009";
const W1 = "f1000000-0000-0000-0000-000000000001", M1 = "b1000000-0000-0000-0000-000000000001";
const L1 = "d1000000-0000-0000-0000-000000000001";
const largo = "x".repeat(2000);
await db.exec(`
  insert into auth.users values ('${U.admin}'), ('${U.miembro}'), ('${U.inactivo}'), ('${U.portal}');
  insert into public.admins (auth_user_id, nombre, email, rol, activo) values
    ('${U.admin}', 'Ana', 'a@x.invalid', 'admin', true),
    ('${U.miembro}', 'Mario', 'm@x.invalid', 'miembro', true),
    ('${U.inactivo}', 'Iris', 'i@x.invalid', 'admin', false);
  insert into public.empresas (id, razon_social, cif, city) values ('${E1}', 'Panadería Muñoz SL', 'B12345678', 'Pozuelo');
  insert into public.empresas (id, razon_social, cif, archived_at) values ('${E2}', 'Otra 100% SA', 'A87654321', now());
  insert into public.leads (id, nombre, servicio, source, mensaje, utm_campaign, created_at)
    values ('${L1}', 'José', 's3', 'web', '${largo}', 'otono', now() - interval '2 days');
  insert into public.leads (nombre, source, status) values ('Borrado', 'web', 'deleted');
  insert into public.contactos (id, full_name, email, phone, lifecycle, lead_id) values
    ('${C1}', 'José Pérez', 'jose@x.invalid', '+34 600 111 222', 'active_client', '${L1}');
  insert into public.contactos (id, full_name, email, lifecycle, auth_user_id) values
    ('${C2}', 'Lucía Gómez', 'lucia@x.invalid', 'new', '${U.portal}');
  insert into public.contacto_empresa (contact_id, empresa_id, principal) values ('${C1}', '${E1}', true), ('${C2}', '${E1}', true);
  insert into public.deals (title, contact_id, empresa_id, service, stage, amount, frequency, renewal_at, signed_at)
    select 'Deal ' || g, '${C1}', '${E1}', case when g % 2 = 0 then 's3' else 's4' end,
           case when g <= 40 then 'cliente_activo' else 'propuesta' end, 100 + g,
           case when g % 3 = 0 then 'anual' else 'mensual' end,
           current_date + g, current_date - g
    from generate_series(1, 60) g;
  insert into public.tareas (title, due_at, assigned_to, status, contact_id) values
    ('Vencida', now() - interval '1 day', 'x', 'pending', '${C1}'),
    ('Futura', now() + interval '3 days', 'x', 'pending', '${C1}'),
    ('Hecha', now() - interval '5 days', 'x', 'done', '${C1}');
  insert into public.notas (body, author, contact_id) values ('${largo}', 'Ana', '${C1}');
  insert into public.carpetas (id, nombre, empresa_id, orden) values
    ('${K1}', 'Contabilidad', '${E1}', 1), ('${K3}', 'Laboral', '${E1}', 2), ('${KX}', 'Ajena', '${E2}', 1);
  insert into public.carpetas (id, nombre, empresa_id, parent_id, orden) values ('${K2}', '2026', '${E1}', '${K1}', 1);
  insert into public.documentos (storage_path, original_filename, status, source, empresa_id, folder_id, size_bytes) values
    ('p/1', 'Balance 2026.pdf', 'stored', 'manual', '${E1}', '${K2}', 2048),
    ('p/2', 'Nómina enero.pdf', 'stored', 'cliente', '${E1}', '${K3}', 1024),
    ('p/3', 'Raíz contabilidad.xlsx', 'stored', 'manual', '${E1}', '${K1}', 10);
  insert into public.whatsapp_conversations (id, contact_id, phone, last_customer_message_at) values ('${W1}', '${C1}', '+34600111222', now());
  insert into public.whatsapp_messages (conversation_id, direction, type, body, created_at)
    select '${W1}', case when g % 2 = 0 then 'out' else 'in' end, 'text', 'mensaje ' || g || ' ${largo}', now() - (100 - g) * interval '1 minute'
    from generate_series(1, 99) g;
  insert into public.correo_mensajes (id, graph_id, carpeta, remitente_email, remitente_nombre, asunto, extracto, cuerpo_html,
                                      fecha, emails_norm, contact_id, empresa_id, para)
    values ('${M1}', 'g1', 'inbox', 'jose@x.invalid', 'José Pérez', 'Facturación de otoño', 'Hola',
            '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p>Hola &amp; adiós&nbsp;&lt;3</p><br><ul><li>uno</li></ul>${"y".repeat(9000)}</body></html>',
            now(), array['jose@x.invalid'], '${C1}', '${E1}', '[{"email":"INFO@guimaes.es"}]');
  insert into public.correo_adjuntos (mensaje_id, graph_id, nombre, inline) values ('${M1}', 'a1', 'factura.pdf', false), ('${M1}', 'a2', 'logo.png', true);
  insert into public.empresa_solicitudes (empresa_id, campo, valor_solicitado, estado) values ('${E1}', 'cif', 'B00000000', 'pendiente');
`);

async function como(quien, sql, params) {
  if (quien === "anon") await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  else await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${U[quien]}', false);`);
  try { return { rows: (await db.query(sql, params)).rows }; }
  catch (e) { return { error: e.message, code: e.code }; }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const rpc = async (quien, sql, params) => {
  const r = await como(quien, `select ${sql} as v`, params);
  return r.error ? r : { v: r.rows[0].v };
};

// ---------------------------------------------------------------- permisos de las RPC
console.log("Permisos de las 12 RPC:");
const llamadas = [
  `public.agente_buscar('munoz')`, `public.agente_ficha_empresa('${E1}')`, `public.agente_ficha_contacto('${C1}')`,
  `public.agente_listar_deals()`, `public.agente_listar_tareas()`, `public.agente_listar_documentos('${E1}')`,
  `public.agente_listar_conversaciones_whatsapp()`, `public.agente_leer_whatsapp('${W1}')`, `public.agente_buscar_correos()`,
  `public.agente_leer_correo('${M1}')`, `public.agente_listar_leads()`, `public.agente_resumen_actividad(now() - interval '30 days')`,
];
for (const l of llamadas) {
  const nombre = l.match(/agente_[a-z_]+/)[0];
  const a = await rpc("admin", l), m = await rpc("miembro", l);
  const i = await rpc("inactivo", l), p = await rpc("portal", l), n = await rpc("anon", l);
  ok(!a.error && !m.error, `${nombre}: admin y miembro leen ${a.error || m.error || ""}`);
  ok(i.code === "42501" && p.code === "42501", `${nombre}: admin inactivo y cliente del portal → 42501`);
  ok(!!n.error && /permission denied/.test(n.error), `${nombre}: anon sin EXECUTE`);
}

// ---------------------------------------------------------------- contenido y límites
console.log("Contenido y límites:");
let r;
r = (await rpc("admin", `public.agente_buscar('MUNOZ')`)).v;
ok(r.resultados.some(x => x.tipo === "empresa" && x.id === E1), "buscar: sin acentos ni mayúsculas (munoz → Muñoz)");
r = (await rpc("admin", `public.agente_buscar('perez', array['contacto'])`)).v;
ok(r.resultados.length === 1 && r.resultados[0].id === C1, "buscar: perez → José Pérez, solo contactos");
r = (await rpc("admin", `public.agente_buscar('600 111 222')`)).v;
ok(r.resultados.some(x => x.id === C1), "buscar: por teléfono");
r = (await rpc("admin", `public.agente_buscar('100%')`)).v;
ok(r.resultados.length === 1 && r.resultados[0].id === E2, "buscar: % se busca literal (no comodín)");
r = (await rpc("admin", `public.agente_buscar('Deal', null, 999)`)).v;
ok(r.resultados.length === 25 && r.truncado === true, "buscar: límite recortado a 25 y truncado");
r = await rpc("admin", `public.agente_buscar('x')`);
ok(r.code === "22023", "buscar: menos de 2 caracteres → 22023");
r = await rpc("admin", `public.agente_buscar('abc', array['factura'])`);
ok(r.code === "22023", "buscar: tipo no válido → 22023");

r = (await rpc("miembro", `public.agente_ficha_empresa('${E1}')`)).v;
ok(r.encontrada && r.total_contactos === 2 && r.contactos.length === 2 && r.total_deals === 60 && r.deals.length === 20,
   "ficha_empresa: contactos y deals (20 de 60)");
ok(r.recuentos.documentos === 3 && r.recuentos.documentos_aportados_por_cliente === 1 && r.recuentos.correos === 1
   && r.recuentos.conversaciones_whatsapp === 1, "ficha_empresa: recuentos");
ok(r.solicitudes_portal_pendientes.length === 1 && r.tareas_abiertas.length === 2, "ficha_empresa: solicitudes y tareas abiertas");
r = (await rpc("admin", `public.agente_ficha_empresa('00000000-0000-0000-0000-000000000000')`)).v;
ok(r.encontrada === false, "ficha_empresa: inexistente → encontrada=false");

r = (await rpc("admin", `public.agente_ficha_contacto('${C1}')`)).v;
ok(r.encontrado && r.empresas.length === 1 && r.deals.length === 20 && r.tareas_abiertas.length === 2, "ficha_contacto: empresas, deals, tareas");
ok(r.notas.length === 1 && r.notas[0].texto.length === 501, "ficha_contacto: nota truncada a 500 + …");
ok(r.formularios.length === 1 && r.formularios[0].mensaje.length === 501, "ficha_contacto: formulario de origen truncado");
ok((await rpc("admin", `public.agente_ficha_contacto('${C2}')`)).v.contacto.cuenta_portal === true, "ficha_contacto: cuenta del portal");

r = (await rpc("admin", `public.agente_listar_deals(p_limite => 1000)`)).v;
ok(r.total === 60 && r.deals.length === 50 && r.truncado === true, "listar_deals: tope 50, total 60, truncado");
ok(r.por_etapa.length === 2 && r.por_etapa.find(e => e.etapa === "cliente_activo").n === 40, "listar_deals: por_etapa");
const imp = r.por_etapa.find(e => e.etapa === "propuesta").importe_por_frecuencia;
ok(imp.anual !== undefined && imp.mensual !== undefined, "listar_deals: importes separados por frecuencia");
r = (await rpc("admin", `public.agente_listar_deals(p_etapa => 'propuesta', p_servicio => 's3')`)).v;
ok(r.total === 10 && r.truncado === false, "listar_deals: filtros etapa + servicio");
r = (await rpc("admin", `public.agente_listar_deals(p_renovacion_antes => current_date + 3)`)).v;
ok(r.total === 3 && r.deals[0].titulo === "Deal 1", "listar_deals: renovaciones ordenadas por fecha");

r = (await rpc("admin", `public.agente_listar_tareas(p_vencidas => true)`)).v;
ok(r.total === 1 && r.tareas[0].titulo === "Vencida" && r.tareas[0].vencida, "listar_tareas: vencidas");
r = (await rpc("admin", `public.agente_listar_tareas(p_estado => 'done')`)).v;
ok(r.total === 1, "listar_tareas: por estado");
ok((await rpc("admin", `public.agente_listar_tareas(p_estado => 'hecha')`)).code === "22023", "listar_tareas: estado no válido → 22023");

r = (await rpc("admin", `public.agente_listar_documentos('${E1}')`)).v;
ok(r.total === 3 && r.documentos.some(d => d.carpeta === "Contabilidad / 2026"), "listar_documentos: ruta de carpeta");
r = (await rpc("admin", `public.agente_listar_documentos('${E1}', '${K1}')`)).v;
ok(r.total === 2, "listar_documentos: carpeta incluye subcarpetas");
r = (await rpc("admin", `public.agente_listar_documentos('${E1}', p_q => 'nomina')`)).v;
ok(r.total === 1 && r.documentos[0].aportado_por === null && r.documentos[0].origen === "cliente", "listar_documentos: por nombre sin acentos");
ok((await rpc("admin", `public.agente_listar_documentos('${E1}', '${KX}')`)).code === "22023", "listar_documentos: carpeta de otra empresa → 22023");
ok((await rpc("admin", `public.agente_listar_documentos(null)`)).code === "22023", "listar_documentos: sin empresa → 22023");

r = (await rpc("admin", `public.agente_listar_conversaciones_whatsapp(p_sin_responder => true)`)).v;
ok(r.total === 1 && r.conversaciones[0].sin_responder === true && r.conversaciones[0].ultimo_mensaje.texto.length === 301,
   "whatsapp: sin responder, último mensaje truncado a 300");
r = (await rpc("admin", `public.agente_leer_whatsapp('${W1}', p_limite => 500)`)).v;
ok(r.total === 99 && r.mensajes.length === 80 && r.truncado, "leer_whatsapp: tope 80 de 99");
ok(r.mensajes[79].texto.startsWith("mensaje 99") && r.mensajes[0].texto.startsWith("mensaje 20"), "leer_whatsapp: los más recientes, en orden cronológico");
ok(r.mensajes.every(m => m.texto.length <= 801), "leer_whatsapp: textos truncados a 800");

r = (await rpc("admin", `public.agente_buscar_correos('otono')`)).v;
ok(r.total === 1 && r.correos[0].para[0] === "info@guimaes.es", "buscar_correos: asunto sin acentos y destinatarios");
ok((await rpc("admin", `public.agente_buscar_correos(p_no_leidos => true)`)).v.total === 1, "buscar_correos: no leídos");
ok((await rpc("admin", `public.agente_buscar_correos(p_carpeta => 'spam')`)).code === "22023", "buscar_correos: carpeta no válida → 22023");
r = (await rpc("admin", `public.agente_leer_correo('${M1}')`)).v;
ok(r.encontrado && r.texto.startsWith("Hola & adiós <3") && !/color:red|alert\(|<\/?[a-z]/i.test(r.texto),
   "leer_correo: HTML a texto (sin estilos, scripts ni etiquetas; entidades)");
ok(r.texto.includes("- uno"), "leer_correo: listas");
ok(r.texto.length === 8001 && r.texto_truncado === true, "leer_correo: texto truncado a 8000");
ok(r.adjuntos.length === 1 && r.adjuntos[0].nombre === "factura.pdf", "leer_correo: adjuntos sin los inline");

r = (await rpc("admin", `public.agente_listar_leads()`)).v;
ok(r.total === 1 && r.leads[0].utm.campaign === "otono", "listar_leads: sin borrados, con utm");
ok((await rpc("admin", `public.agente_listar_leads(p_estado => 'deleted')`)).v.total === 1, "listar_leads: borrados si se piden");

r = (await rpc("admin", `public.agente_resumen_actividad(now() - interval '7 days')`)).v;
ok(r.leads.nuevos === 1 && r.tareas.vencidas_ahora === 1 && r.correo.no_leidos_ahora === 1
   && r.whatsapp.conversaciones_sin_responder_ahora === 1 && r.portal.solicitudes_pendientes_ahora === 1
   && r.deals.firmados === 7 && r.deals.renovaciones_proximos_30_dias === 30, "resumen_actividad: recuentos");
ok((await rpc("admin", `public.agente_resumen_actividad(now() - interval '2 years')`)).code === "22023", "resumen_actividad: periodo > 1 año → 22023");
ok((await rpc("admin", `public.agente_resumen_actividad(now() + interval '1 day')`)).code === "22023", "resumen_actividad: desde futuro → 22023");
ok(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(r.periodo.hasta), "fechas en formato 'AAAA-MM-DD HH:MI' (Madrid)");

// ---------------------------------------------------------------- auditoría
console.log("Auditoría (RLS):");
const ins = async (quien, sql) => como(quien, sql);
let cA = await ins("admin", `insert into public.agente_conversaciones (titulo, modelo) values ('de Ana', 'claude-sonnet-5-5') returning id, auth_user_id`);
ok(!cA.error && cA.rows[0].auth_user_id === U.admin, "admin crea conversación (auth_user_id lo pone la base de datos)");
const convA = cA.rows[0].id;
let cM = await ins("miembro", `insert into public.agente_conversaciones (titulo, modelo) values ('de Mario', 'claude-sonnet-5-5') returning id`);
ok(!cM.error, "miembro crea conversación");
const convM = cM.rows[0].id;
ok(!!(await ins("miembro", `insert into public.agente_conversaciones (titulo, modelo, auth_user_id) values ('x', 'm', '${U.admin}')`)).error,
   "no se puede elegir auth_user_id (privilegio de columna)");
ok(!!(await ins("inactivo", `insert into public.agente_conversaciones (titulo, modelo) values ('x', 'm')`)).error, "admin inactivo no crea");
ok(!!(await ins("portal", `insert into public.agente_conversaciones (titulo, modelo) values ('x', 'm')`)).error, "cliente del portal no crea");
ok(!!(await ins("anon", `insert into public.agente_conversaciones (titulo, modelo) values ('x', 'm')`)).error, "anon no crea");

const msg = (conv, orden, rol, tipo) =>
  `insert into public.agente_mensajes (conversacion_id, orden, rol, tipo, contenido, texto) values ('${conv}', ${orden}, '${rol}', '${tipo}', '[{"type":"text","text":"hola"}]', 'hola') returning id`;
let mA = await ins("admin", msg(convA, 0, "user", "pregunta"));
ok(!mA.error, "admin añade pregunta a su conversación " + (mA.error || ""));
let mA1 = await ins("admin", msg(convA, 1, "assistant", "modelo"));
const msgA1 = mA1.rows[0].id;
let mM = await ins("miembro", msg(convM, 0, "user", "pregunta"));
let mM1 = await ins("miembro", msg(convM, 1, "assistant", "modelo"));
ok(!mM.error && !mM1.error, "miembro añade mensajes a la suya");
ok(!!(await ins("miembro", msg(convA, 2, "user", "pregunta"))).error, "miembro no añade mensajes a la de otro");
ok(!!(await ins("admin", msg(convM, 2, "user", "pregunta"))).error, "el rol admin tampoco escribe en la de otro");
ok(!!(await ins("admin", msg(convA, 1, "user", "pregunta"))).error, "orden repetido → rechazado");
ok(!!(await ins("admin", msg(convA, 5, "user", "modelo"))).error, "rol/tipo incoherentes → rechazado");
ok(!!(await ins("admin", `insert into public.agente_mensajes (conversacion_id, orden, rol, tipo, contenido) values ('${convA}', 9, 'user', 'pregunta', '{"a":1}')`)).error,
   "contenido que no es array ni string → rechazado");

const tc = (conv, mid, tid) =>
  `insert into public.agente_tool_calls (conversacion_id, mensaje_id, tool_use_id, herramienta, parametros, filas) values ('${conv}', '${mid}', '${tid}', 'buscar', '{"q":"x"}', 3) returning id`;
ok(!(await ins("admin", tc(convA, msgA1, "tu_1"))).error, "admin registra llamada a herramienta");
ok(!!(await ins("admin", tc(convA, msgA1, "tu_1"))).error, "tool_use_id repetido → rechazado");
ok(!!(await ins("admin", tc(convA, mM1.rows[0].id, "tu_2"))).error, "mensaje de otra conversación → rechazado (FK compuesta)");
ok(!!(await ins("miembro", tc(convA, msgA1, "tu_3"))).error, "miembro no registra llamadas en conversación ajena");
ok(!(await ins("miembro", tc(convM, mM1.rows[0].id, "tu_1"))).error, "miembro registra en la suya");

const cuenta = async (quien, t) => { const x = await como(quien, `select count(*)::int n from public.${t}`); return x.error ? "error" : x.rows[0].n; };
for (const t of ["agente_conversaciones", "agente_mensajes", "agente_tool_calls"]) {
  ok(await cuenta("miembro", t) === (t === "agente_tool_calls" ? 1 : t === "agente_mensajes" ? 2 : 1), `${t}: el miembro solo ve lo suyo`);
  ok(await cuenta("admin", t) === (t === "agente_tool_calls" ? 2 : t === "agente_mensajes" ? 4 : 2), `${t}: el rol admin ve lo de todos`);
  ok(await cuenta("inactivo", t) === 0, `${t}: admin inactivo no ve nada`);
  ok(await cuenta("portal", t) === 0, `${t}: cliente del portal no ve nada`);
  ok(await cuenta("anon", t) === "error", `${t}: anon sin privilegio`);
}
ok((await como("miembro", `select count(*)::int n from public.agente_mensajes where conversacion_id = '${convA}'`)).rows[0].n === 0,
   "miembro no lee los mensajes de la conversación de Ana");

r = await ins("admin", `update public.agente_conversaciones set titulo = 'nuevo', archivada = true where id = '${convA}' returning titulo`);
ok(!r.error && r.rows.length === 1, "renombra y archiva la suya");
r = await ins("admin", `update public.agente_conversaciones set titulo = 'pisado' where id = '${convM}' returning id`);
ok(!r.error && r.rows.length === 0, "el rol admin no modifica conversaciones ajenas");
ok(!!(await ins("admin", `update public.agente_conversaciones set modelo = 'otro' where id = '${convA}'`)).error, "no se cambia el modelo");
ok(!!(await ins("admin", `update public.agente_conversaciones set auth_user_id = '${U.miembro}' where id = '${convA}'`)).error, "no se cambia el propietario");
ok(!!(await ins("admin", `update public.agente_mensajes set texto = 'otro'`)).error, "mensajes: no se modifican");
ok(!!(await ins("admin", `delete from public.agente_mensajes`)).error, "mensajes: no se borran");
ok(!!(await ins("admin", `delete from public.agente_tool_calls`)).error, "tool_calls: no se borran");
ok(!!(await ins("admin", `update public.agente_tool_calls set filas = 0`)).error, "tool_calls: no se modifican");
ok(!!(await ins("admin", `delete from public.agente_conversaciones`)).error, "conversaciones: no se borran desde el CRM");

const envejecer = (id, dias) => db.exec(`alter table public.agente_conversaciones disable trigger agente_conversaciones_set_updated_at;
  update public.agente_conversaciones set updated_at = now() - interval '${dias} days' where id = '${id}';
  alter table public.agente_conversaciones enable trigger agente_conversaciones_set_updated_at;`);
await envejecer(convM, 200);
ok((await q(`select updated_at < now() - interval '199 days' v from public.agente_conversaciones where id = '${convM}'`))[0].v, "(conversación envejecida para la prueba)");
await ins("miembro", msg(convM, 2, "user", "pregunta"));
ok((await q(`select updated_at > now() - interval '1 minute' v from public.agente_conversaciones where id = '${convM}'`))[0].v,
   "un mensaje nuevo reactiva la conversación (trigger)");

console.log("Retención:");
await envejecer(convM, 91);
ok(!!(await como("admin", `select public.agente_retencion(90)`)).error, "authenticated no ejecuta la retención");
ok(!!(await db.query(`select public.agente_retencion(10)`).catch(e => ({ error: e }))).error, "retención < 30 días → error");
r = await q(`select public.agente_retencion(90) n`);
ok(r[0].n === 1, "borra la conversación de más de 90 días");
ok((await q(`select count(*)::int n from public.agente_mensajes where conversacion_id = '${convM}'`))[0].n === 0
   && (await q(`select count(*)::int n from public.agente_tool_calls where conversacion_id = '${convM}'`))[0].n === 0,
   "mensajes y llamadas en cascada");
ok((await q(`select count(*)::int n from public.agente_conversaciones`))[0].n === 1, "la reciente se conserva");

console.log(`\n${total - fallos}/${total} ok${fallos ? `, ${fallos} FALLOS` : ""}`);
process.exit(fallos ? 1 : 0);
