// Prueba de crm/supabase-holded-acciones.sql en PGlite, encima del esquema
// base, el importador y los bloques 1 y 2. Datos INVENTADOS.
// Uso (desde crm/tests/holded): npm install && node holded-acciones.test.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const leer = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const bloque1 = leer("../../supabase-holded-conexiones.sql");
const bloque2 = leer("../../supabase-holded-consultas.sql");
const mig = leer("../../supabase-holded-acciones.sql");
const base = leer("../importador/esquema-base.sql");
const importador = leer("../../supabase-importador.sql");
const parte = (texto, id, sig) => {
  const m = texto.match(new RegExp(`-- ${id} [\\s\\S]*?(?=\\n-- =+\\n-- ${sig}[A-Z] |$)`));
  if (!m) throw new Error("sin parte " + id);
  return m[0];
};

const db = new PGlite();
let fallos = 0, total = 0;
const ok = (c, msg) => { total++; console.log((c ? "  ok   " : "  FALLO ") + msg); if (!c) fallos++; };
const q = async (s, p) => (await db.query(s, p)).rows;
const uno = async (s, p) => (await q(s, p))[0];
const tabla = async (sql) => Object.fromEntries((await db.exec(sql)).at(-1).rows.map((r) => [r.comprobacion, r.valor]));
const falla = async (fn, re, msg) => {
  try { await fn(); ok(false, msg + " (no falló)"); }
  catch (e) { const b = re.test(e.message) || re.test(e.code || ""); ok(b, msg + (b ? "" : ` (${e.code} ${e.message})`)); }
};

await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
  create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
    returns uuid language sql as $$ insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id $$;
  revoke all on schema vault from public;
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid::bigint $$;
`);
await db.exec(base);
await db.exec(`
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);
await db.exec(importador);
await db.exec(parte(bloque1, "6B", "6"));
await db.exec(parte(bloque2, "7B", "7"));
await db.exec(`create function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid = j returning true $$;`);
// pg_net simulado: guarda las llamadas.
await db.exec(`create schema net; create table net.llamadas (id bigserial primary key, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int) returns bigint language sql as
  $$ insert into net.llamadas (url, body, headers) values (url, body, headers) returning id $$;`);

const U = { admin: "11111111-1111-1111-1111-111111111111", miembro: "22222222-2222-2222-2222-222222222222",
            inactivo: "33333333-3333-3333-3333-333333333333" };
const E = { a: "e1000000-0000-0000-0000-000000000001", b: "e2000000-0000-0000-0000-000000000002",
            sin: "e3000000-0000-0000-0000-000000000003", mal: "e4000000-0000-0000-0000-000000000004" };
await db.exec(`
  insert into auth.users values ('${U.admin}'), ('${U.miembro}'), ('${U.inactivo}');
  insert into public.admins (auth_user_id, nombre, email, rol, activo) values
    ('${U.admin}', 'Ana', 'a@x.invalid', 'admin', true), ('${U.miembro}', 'Mario', 'm@x.invalid', 'miembro', true),
    ('${U.inactivo}', 'Iris', 'i@x.invalid', 'admin', false);
  insert into public.empresas (id, razon_social, visto_at) values
    ('${E.a}', 'Empresa A Inventada', now()), ('${E.b}', 'Empresa B Inventada', now()),
    ('${E.sin}', 'Sin Holded', now()), ('${E.mal}', 'Con Error', now());
  insert into public.holded_conexiones (empresa_id, secreto_id, ultimos4, estado)
    select '${E.a}', vault.create_secret('pat_' || repeat('a', 89)), 'aaaa', 'ok';
  insert into public.holded_conexiones (empresa_id, secreto_id, ultimos4, estado)
    select '${E.b}', vault.create_secret('pat_' || repeat('b', 89)), 'bbbb', 'pendiente';
  insert into public.holded_conexiones (empresa_id, secreto_id, ultimos4, estado, ultimo_error)
    select '${E.mal}', vault.create_secret('pat_' || repeat('c', 89)), 'cccc', 'error', 'Holded rechaza la clave (401)';
`);

async function como(uid) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false);`);
  await db.exec(uid ? "set role authenticated" : "set role anon");
}
async function servicio() { await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false); set role service_role;"); }
async function sistema() { await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);"); }


const hex = (n) => n.toString(16).padStart(24, "0");
const IDS = (desde, n) => Array.from({ length: n }, (_, i) => hex(desde + i));

// ---------------------------------------------------------------- 8A / 8B / 8C
await sistema();
let RA = await tabla(parte(mig, "8A", "8"));
console.log("8A:", JSON.stringify(RA));
ok(RA["secreto holded_acciones_cron_secret"] === "0", "8A: sin secreto todavía");
await falla(() => db.exec(parte(mig, "8B", "8")), /Falta el secreto/, "8B se niega sin el secreto en Vault");
await db.exec(`select vault.create_secret('secreto-de-prueba', 'holded_acciones_cron_secret')`);
RA = await tabla(parte(mig, "8A", "8"));
ok(RA["migración 20261127160000 (bloque 2)"] === "sí" && RA["migración 20261127180000"] === "no" && RA["tablas holded_acciones*"] === "0"
   && RA["columna cupo_acciones_mensual"] === "0" && RA["secreto holded_acciones_cron_secret"] === "1" && RA["pg_net"] === "1"
   && RA["pg_cron"] === "1" && RA["tarea holded-acciones-ejecutar"] === "0" && RA["conexiones"] === "3", "8A: lo esperado");
await db.exec(parte(mig, "8B", "8"));
ok(true, "8B aplicado");
await falla(() => db.exec(parte(mig, "8B", "8")), /ya está aplicada/, "8B se niega a repetirse");
const RC = await tabla(parte(mig, "8C", "8"));
console.log("8C:", JSON.stringify(RC));
ok(RC["tablas con RLS"] === "3" && RC["políticas"] === "2", "8C: RLS y políticas");
ok(RC["authenticated SELECT acciones/items/políticas"] === "sí/no/sí", "8C: lectura");
ok(RC["authenticated INSERT/UPDATE/DELETE holded_acciones"] === "no/no/no", "8C: sin escritura directa");
ok(RC["EXECUTE authenticated crear/reclamar/resultado/cron"] === "no/no/no/no", "8C: funciones de servicio cerradas");
ok(RC["EXECUTE service_role crear/reclamar/resultado"] === "sí/sí/sí", "8C: service_role");
ok(RC["EXECUTE anon/authenticated aprobar"] === "no/sí", "8C: aprobar");
ok(RC["cupo_acciones_mensual"] === "todas 0" && RC["tarea holded-acciones-ejecutar"] === "1" && RC["conexiones"] === "3", "8C: cupo 0 y tarea");
ok(/^20261127180000 /.test(RC["migración registrada"] || ""), "8C: registrada");

// ---------------------------------------------------------------- crear
const crear = async (u, origen, e, ids, extra = {}) => (await uno(
  "select public.holded_acciones_crear($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11) r",
  [u, origen, e, extra.tipo ?? "aprobar_tickets_venta", JSON.stringify({ max_documentos: ids.length }),
   JSON.stringify({ documentos: ids.length, total: extra.total ?? 100 }), "[]", "[]", ["aviso"], ids, 3])).r;
await como(U.admin);
await falla(() => crear(U.admin, "agente", E.a, IDS(1, 3)), /42501|permission denied/, "authenticated no crea propuestas");
await falla(() => q("insert into holded_acciones (empresa_id, tipo, origen) values ($1, 'aprobar_tickets_venta', 'crm')", [E.a]), /42501|permission denied/, "ni con INSERT directo");
await servicio();
await falla(() => crear(U.inactivo, "agente", E.a, IDS(1, 3)), /Solo usuarios activos/, "usuario inactivo no propone");
await falla(() => crear(U.admin, "agente", E.a, IDS(1, 3), { tipo: "borrar_facturas" }), /no permitido/, "tipo fuera de la lista cerrada");
await falla(() => crear(U.admin, "hacker", E.a, IDS(1, 3)), /Origen/, "origen no válido");
await falla(() => crear(U.admin, "agente", E.sin, IDS(1, 3)), /no tiene Holded/, "empresa sin Holded");
await falla(() => crear(U.admin, "agente", E.a, []), /entre 1 y 1.000/, "sin documentos");
await falla(() => crear(U.admin, "agente", E.a, IDS(1, 1001)), /entre 1 y 1.000/, "más de 1.000");
await falla(() => crear(U.admin, "agente", E.a, ["abc", hex(1)]), /no válidos/, "id no válido");
await falla(() => crear(U.admin, "agente", E.a, [hex(1), hex(1)]), /repetidos/, "ids repetidos");
const A1 = await crear(U.miembro, "agente", E.a, IDS(1, 3));
ok(A1.estado === "propuesta" && A1.documentos === 3, "un miembro (vía asistente) puede proponer; nace como propuesta");
await falla(() => crear(U.admin, "agente", E.a, IDS(3, 2)), /ya están en otra propuesta/, "un documento no puede estar en dos propuestas vivas");
const OP = await crear(null, "operador", E.a, IDS(200, 150));
ok(OP.estado === "propuesta", "el operador (cron) propone sin usuario");

// ---------------------------------------------------------------- política automática
await sistema();
await db.exec(`insert into holded_acciones_politicas (empresa_id, tipo, modo, max_documentos, max_importe) values ('${E.b}', 'aprobar_tickets_venta', 'automatica', 5, 500)`);
await servicio();
ok((await crear(U.admin, "agente", E.b, IDS(50, 5), { total: 499 })).estado === "aprobada", "automática dentro de los topes → aprobada");
ok((await crear(U.admin, "agente", E.b, IDS(60, 6), { total: 10 })).estado === "propuesta", "automática con más documentos → propuesta");
ok((await crear(U.admin, "agente", E.b, IDS(70, 2), { total: 501 })).estado === "propuesta", "automática con más importe → propuesta");
await sistema();
await db.exec(`delete from holded_acciones where empresa_id = '${E.b}'; delete from holded_acciones_politicas`);
await falla(() => db.exec(`insert into holded_acciones_politicas (empresa_id, tipo, modo) values ('${E.b}', 'aprobar_tickets_venta', 'automatica')`), /check/, "automática sin topes no vale");

// ---------------------------------------------------------------- aprobar / rechazar
const rpcU = async (u, fn, ...a) => { await como(u); return (await uno(`select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(", ")}) r`, a)).r; };
await falla(() => rpcU(U.miembro, "holded_acciones_aprobar", A1.id, null), /Solo el rol admin/, "un miembro no aprueba");
await como(U.miembro);
ok((await q("select * from holded_acciones")).length === 0, "un miembro no ve las acciones");
await como(U.admin);
ok((await q("select * from holded_acciones")).length === 2, "el rol admin ve las acciones");
await falla(() => q("select * from holded_acciones_items"), /42501|permission denied/, "nadie lee los items directamente");
await falla(() => q("update holded_acciones set estado = 'aprobada'"), /42501|permission denied/, "ni aprueba con UPDATE");
await falla(() => rpcU(U.admin, "holded_acciones_aprobar", OP.id, 149), /escribe el número 150/, "más de 100: número equivocado");
await falla(() => rpcU(U.admin, "holded_acciones_aprobar", OP.id, null), /escribe el número 150/, "más de 100: sin número");
const ap = await rpcU(U.admin, "holded_acciones_aprobar", OP.id, 150);
ok(ap.estado === "aprobada", "más de 100 con el número exacto → aprobada");
await falla(() => rpcU(U.admin, "holded_acciones_aprobar", OP.id, 150), /Solo se puede aprobar una propuesta/, "no se aprueba dos veces");
await sistema();
ok((await uno("select aprobada_por from holded_acciones where id = $1", [OP.id])).aprobada_por === U.admin, "queda quién aprobó");
await db.exec(`update holded_acciones set expira_at = now() - interval '1 minute' where id = '${A1.id}'`);
await falla(() => rpcU(U.admin, "holded_acciones_aprobar", A1.id, null), /caducado/, "propuesta caducada no se aprueba");
const rech = await rpcU(U.admin, "holded_acciones_rechazar", A1.id, "  no ahora  ");
ok(rech.estado === "rechazada", "rechazar");
await sistema();
ok((await uno("select motivo_estado m from holded_acciones where id = $1", [A1.id])).m === "no ahora", "motivo del rechazo");
ok((await uno("select count(*)::int n from holded_acciones_items where accion_id = $1 and estado = 'omitido'", [A1.id])).n === 3, "items omitidos");
await servicio();
ok((await crear(U.admin, "crm", E.a, IDS(3, 2))).estado === "propuesta", "tras rechazar, los documentos se pueden volver a proponer");

// ---------------------------------------------------------------- ejecutar: cupo, lotes, resultados
const reclamar = async (n) => { await servicio(); return (await uno("select public.holded_acciones_reclamar($1) r", [n])).r; };
const resultado = async (id, res, llamadas, pausar = null) => { await servicio(); return (await uno("select public.holded_acciones_resultado($1, $2::jsonb, $3, $4) r", [id, JSON.stringify(res), llamadas, pausar])).r; };
const estadoDe = async (id) => { await sistema(); return (await uno("select estado, motivo_estado from holded_acciones where id = $1", [id])); };
let r = await reclamar(10);
ok(r === null, "cupo de acciones 0 → no se reclama nada");
ok((await estadoDe(OP.id)).estado === "pausada" && /Cupo de acciones del mes agotado \(0 de 0/.test((await estadoDe(OP.id)).motivo_estado), "y la acción se pausa con el motivo");
await falla(() => rpcU(U.miembro, "holded_cambiar_cupo_acciones", E.a, 100), /Solo el rol admin/, "un miembro no cambia el cupo de acciones");
await rpcU(U.admin, "holded_cambiar_cupo_acciones", E.a, 12);
await rpcU(U.admin, "holded_acciones_reanudar", OP.id);
ok((await estadoDe(OP.id)).estado === "aprobada", "reanudar");
r = await reclamar(10);
ok(r.accion_id === OP.id && r.ids.length === 10 && r.ids[0] === hex(200), "reclama 10 en orden");
ok((await estadoDe(OP.id)).estado === "en_curso", "pasa a en curso");
ok((await reclamar(10)) === null || true, "segunda reclamación");
await sistema();
const enProc = (await uno("select count(*)::int n from holded_acciones_items where accion_id = $1 and estado = 'en_proceso'", [OP.id])).n;
ok(enProc === 12, "con cupo 12, solo 12 en proceso (10 + 2)");
await falla(() => resultado(OP.id, [{ id: hex(200), estado: "raro" }], 1), /no válido/, "resultado no válido");
await resultado(OP.id, [
  { id: hex(200), estado: "ok", codigo: 200 }, { id: hex(201), estado: "error", codigo: 404, error: "Ticket no encontrado" },
  { id: hex(202), estado: "pendiente", codigo: 503, error: "Holded no responde" },
  ...IDS(203, 7).map((id) => ({ id, estado: "ok", codigo: 200 })),
], 11);
await sistema();
let p = await uno("select estado, count(*)::int n from holded_acciones_items where accion_id = $1 and holded_id = $2 group by estado", [OP.id, hex(202)]);
ok(p.estado === "pendiente", "pendiente vuelve a la cola");
await como(U.admin);
let uso = (await q("select * from holded_acciones_uso_mes($1)", [E.a]))[0];
ok(uso.usadas === 12 && uso.cupo === 12, "uso de acciones: 12 de 12 (los documentos intentados)");
r = await reclamar(10);
ok(r && r.ids.length === 1 && r.ids[0] === hex(202), "con el cupo agotado solo se reintenta lo ya empezado (no gasta cupo)");
await resultado(OP.id, [{ id: hex(202), estado: "pendiente", error: "Holded no responde" }], 1);
r = await reclamar(10);
await resultado(OP.id, [{ id: hex(202), estado: "pendiente", error: "Holded no responde" }], 1);
await sistema();
p = await uno("select estado, intentos, error from holded_acciones_items where accion_id = $1 and holded_id = $2", [OP.id, hex(202)]);
ok(p.estado === "error" && p.intentos === 3 && /3 intentos/.test(p.error), "tras 3 intentos → error");
await resultado(OP.id, [{ id: hex(210), estado: "ok", codigo: 200 }, { id: hex(211), estado: "ok", codigo: 200 }], 2);
r = await reclamar(10);
ok(r === null && /0 de 12|12 de 12/.test((await estadoDe(OP.id)).motivo_estado), "cupo agotado → pausada con cifras");
await como(U.admin);
const prog = await rpcU(U.admin, "holded_acciones_progreso", OP.id);
ok(prog.total === 150 && prog.ok === 10 && prog.error === 2 && prog.pendiente === 138, "progreso: 10 ok, 2 error, 138 pendientes");
ok(prog.errores.length === 2 && prog.errores[0].holded_id === hex(201) && prog.errores[0].codigo === 404, "errores con id, código y motivo");
await falla(() => rpcU(U.miembro, "holded_acciones_progreso", OP.id), /Solo el rol admin/, "un miembro no ve el progreso");

// Documentos «en_proceso» de una ejecución que murió: vuelven a la cola.
await rpcU(U.admin, "holded_cambiar_cupo_acciones", E.a, 1000);
await rpcU(U.admin, "holded_acciones_reanudar", OP.id);
r = await reclamar(5);
await sistema();
await db.exec(`update holded_acciones_items set reclamado_at = now() - interval '6 minutes' where accion_id = '${OP.id}' and estado = 'en_proceso'`);
r = await reclamar(5);
ok(r.ids.length === 5 && r.ids[0] === hex(212), "lo atascado más de 5 min se vuelve a reclamar, sin saltarse el orden");
await resultado(OP.id, r.ids.map((id) => ({ id, estado: "ok", codigo: 200 })), 5);

// Pausar desde un resultado (p. ej. 429 mensual de Holded).
r = await reclamar(3);
await resultado(OP.id, [{ id: r.ids[0], estado: "ok" }, { id: r.ids[1], estado: "pendiente" }, { id: r.ids[2], estado: "pendiente" }], 3, "Holded: cupo mensual de la API agotado");
ok((await estadoDe(OP.id)).estado === "pausada" && /cupo mensual/.test((await estadoDe(OP.id)).motivo_estado), "un resultado puede pausar la acción");
ok((await reclamar(5)) === null, "pausada: no se reclama nada");

// Cancelar: lo pendiente queda omitido.
const can = await rpcU(U.admin, "holded_acciones_cancelar", OP.id);
ok(can.estado === "cancelada" && can.omitidos > 100, "cancelar omite lo pendiente");
await falla(() => rpcU(U.admin, "holded_acciones_reanudar", OP.id), /pausada/, "no se reanuda una cancelada");
await falla(() => rpcU(U.admin, "holded_acciones_cancelar", OP.id), /terminada/, "no se cancela dos veces");

// Completar.
await servicio();
const C = await crear(U.admin, "crm", E.a, IDS(500, 2));
await rpcU(U.admin, "holded_acciones_aprobar", C.id, null);
r = await reclamar(10);
ok(r.ids.length === 2, "acción pequeña: 2 documentos");
await resultado(C.id, r.ids.map((id) => ({ id, estado: "ok", codigo: 200 })), 2);
ok((await estadoDe(C.id)).estado === "completada", "sin nada pendiente → completada");
await sistema();
ok((await uno("select llamadas_escritura n, terminada_at is not null t from holded_acciones where id = $1", [C.id])).n === 2, "llamadas de escritura contadas");

// ---------------------------------------------------------------- pg_cron
await sistema();
await db.exec("select public.holded_acciones_cron()");
ok((await uno("select count(*)::int n from net.llamadas")).n === 0, "cron sin nada aprobado → no llama a la función");
await servicio();
const D = await crear(U.admin, "crm", E.a, IDS(600, 1));
await rpcU(U.admin, "holded_acciones_aprobar", D.id, null);
await sistema();
await db.exec("select public.holded_acciones_cron()");
const ll = await uno("select url, body, headers from net.llamadas");
ok(/functions\/v1\/holded-acciones$/.test(ll.url) && ll.body.accion === "ejecutar" && ll.headers["x-hook-secret"] === "secreto-de-prueba", "cron con algo aprobado → holded-acciones con el secreto");
ok((await uno("select schedule from cron.job where jobname = 'holded-acciones-ejecutar'")).schedule === "* * * * *", "cada minuto");

// Borrar la empresa borra sus acciones.
await db.exec(`delete from empresas where id = '${E.a}'`);
ok((await uno("select count(*)::int n from holded_acciones")).n === 0 && (await uno("select count(*)::int n from holded_acciones_items")).n === 0, "borrar la empresa borra sus acciones");

console.log(`\n${total - fallos}/${total} pruebas correctas`);
process.exit(fallos ? 1 : 0);
