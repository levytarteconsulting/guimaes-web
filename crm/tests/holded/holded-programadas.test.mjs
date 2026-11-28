// Prueba de crm/supabase-holded-programadas.sql en PGlite, encima del esquema
// base, el importador, los bloques 1 y 2, las acciones (8B) y las operaciones (9B). Datos INVENTADOS.
// Uso (desde crm/tests/holded): npm install && node holded-programadas.test.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const leer = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const bloque1 = leer("../../supabase-holded-conexiones.sql");
const bloque2 = leer("../../supabase-holded-consultas.sql");
const acciones = leer("../../supabase-holded-acciones.sql");
const ops = leer("../../supabase-holded-operaciones.sql");
const mig = leer("../../supabase-holded-programadas.sql");
const catalogo = JSON.parse(leer("../../supabase-functions/holded-acciones/catalogo.json"));
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


const rpcU = async (u, fn, ...a) => { await como(u); return (await uno(`select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(", ")}) r`, a)).r; };
const estadoDe = async (id) => { await sistema(); return uno("select estado, motivo_estado from holded_acciones where id = $1", [id]); };
const reclamar = async (n) => { await servicio(); return (await uno("select public.holded_acciones_reclamar($1) r", [n])).r; };
const resultado = async (id, res, llamadas, pausar = null) => { await servicio(); return (await uno("select public.holded_acciones_resultado($1, $2::jsonb, $3, $4) r", [id, JSON.stringify(res), llamadas, pausar])).r; };

// ---------------------------------------------------------------- antes: acciones de tickets (8B) con datos
await sistema();
await db.exec(`select vault.create_secret('secreto-de-prueba', 'holded_acciones_cron_secret')`);
await db.exec(parte(acciones, "8B", "8"));
await db.exec(`update holded_conexiones set cupo_acciones_mensual = 1000 where empresa_id = '${E.a}'`);
await servicio();
const T = (await uno("select public.holded_acciones_crear($1, 'operador', $2, 'aprobar_tickets_venta', '{}', '{\"total\": 10}', '[]', '[]', '{}', $3, 1) r",
  [null, E.a, IDS(1, 3)])).r;
await rpcU(U.admin, "holded_acciones_aprobar", T.id, null);
let r = await reclamar(2);
await resultado(T.id, r.ids.map((id) => ({ id, estado: "ok", codigo: 200 })), 2);

// ---------------------------------------------------------------- operaciones (9B) debajo
await sistema();
await db.exec(parte(ops, "9B", "9"));

// ---------------------------------------------------------------- 14A / 14B / 14C
const RA = await tabla(parte(mig, "14A", "14"));
console.log("14A:", JSON.stringify(RA));
ok(RA["migración 20261127230000"] === "sí" && RA["migración 20261128220000"] === "no" && RA["tabla holded_acciones_programadas"] === "0"
   && RA["tarea holded-acciones-programadas"] === "0" && RA["secreto holded_acciones_cron_secret"] === "1", "14A: lo esperado");
await db.exec(parte(mig, "14B", "14"));
ok(true, "14B aplicado");
await falla(() => db.exec(parte(mig, "14B", "14")), /ya está aplicada/, "14B se niega a repetirse");
const RC = await tabla(parte(mig, "14C", "ZZ"));
console.log("14C:", JSON.stringify(RC));
ok(RC["RLS"] === "true" && RC["programaciones"] === "0" && RC["tarea holded-acciones-programadas"] === "*/10 * * * *"
   && RC["EXECUTE authenticated cambiar/turno/registrar/cron"] === "sí/no/no/no" && /^20261128220000 /.test(RC["migración registrada"] || ""), "14C: lo esperado");

const TIPO = "aprobar_tickets_venta";
const hoy = (await uno("select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM-DD') d")).d;
const horaMadrid = Number((await uno("select extract(hour from (now() at time zone 'Europe/Madrid'))::int h")).h);
const turno = async () => { await servicio(); return (await uno("select public.holded_programadas_turno() r")).r; };
const registrar = async (acc, msg, cerrar) => { await servicio(); await q("select public.holded_programada_registrar($1, $2, $3, $4, $5)", [E.a, TIPO, acc, msg, cerrar]); };
const prog = async () => { await sistema(); return uno("select * from holded_acciones_programadas where empresa_id = $1", [E.a]); };
const cron = async () => { await sistema(); return (await uno("select public.holded_programadas_cron() r")).r; };
const crear = async (desde, n) => { await servicio();
  return (await uno("select public.holded_acciones_crear(null, 'operador', $1, $2, '{}', '{\"total\": 10}', '[]', '[]', '{}', $3, 1) r", [E.a, TIPO, IDS(desde, n)])).r; };
const terminar = async (id, estadoItems) => { await sistema();
  await q("update holded_acciones_items set estado = $2 where accion_id = $1", [id, estadoItems]);
  await q("update holded_acciones set estado = 'completada', terminada_at = now() where id = $1", [id]); };

// ---------------------------------------------------------------- permisos
await falla(() => rpcU(U.miembro, "holded_cambiar_programacion", E.a, TIPO, true, false), /42501|rol admin/, "un miembro no programa");
await falla(() => rpcU(U.inactivo, "holded_cambiar_programacion", E.a, TIPO, true, false), /42501|rol admin/, "un admin inactivo no programa");
await falla(() => rpcU(U.admin, "holded_cambiar_programacion", E.sin, TIPO, true, false), /GU010|Holded conectado/, "sin Holded, no");
await falla(() => rpcU(U.admin, "holded_cambiar_programacion", E.a, "borrar_todo", true, false), /22023|no permitido/, "tipo cerrado");
ok((await cron()) === null, "sin programaciones, el cron no llama");
let x = await rpcU(U.admin, "holded_cambiar_programacion", E.a, TIPO, true, false);
ok(x.activa === true && x.dia_en_curso === null, "el admin la activa");
await como(U.miembro);
ok((await q("select * from holded_acciones_programadas")).length === 0, "un miembro no la ve");
await como(U.admin);
ok((await q("select * from holded_acciones_programadas")).length === 1, "el rol admin la ve");
await falla(() => q("update holded_acciones_programadas set hora = 1"), /permission denied|42501/, "nadie la cambia a mano desde el CRM");
await falla(() => q("select public.holded_programadas_turno()"), /permission denied|42501/, "authenticated no pide turnos");
await falla(() => q(`select public.holded_programada_registrar('${E.a}', '${TIPO}', null, 'x', true)`), /permission denied|42501/, "authenticated no registra");

// ---------------------------------------------------------------- todavía no es la hora
if (horaMadrid < 23) {
  await sistema(); await q("update holded_acciones_programadas set hora = 23");
  ok((await turno()).length === 0 && (await cron()) === null, "antes de las 23:00 de Madrid no hace nada");
} else ok(true, "(ahora son las 23 en Madrid: se omite la prueba de «antes de la hora»)");

// ---------------------------------------------------------------- una noche con dos tandas
await sistema(); await q("update holded_acciones_programadas set hora = 0");
await q(`insert into holded_acciones_politicas (empresa_id, tipo, modo, max_documentos, max_importe) values ($1, $2, 'automatica', 1000, 999999999999.99)`, [E.a, TIPO]);
const idCron = await cron();
const llamada = await uno("select body, headers from net.llamadas where id = $1", [idCron]);
ok(llamada && llamada.body.accion === "programadas" && llamada.headers["x-hook-secret"] === "secreto-de-prueba", "a la hora, el cron llama a la función con el secreto");
let t = await turno();
ok(t.length === 1 && t[0].hasta === hoy && t[0].tanda === 1 && t[0].empresa_id === E.a, "turno: tanda 1, tickets hasta hoy " + JSON.stringify(t));
ok((await turno()).length === 0, "no se pide otra mientras la tanda está pedida");
const A1 = await crear(100, 3);
ok(A1.estado === "aprobada", "con la política automática (sin tope de importe) la tanda se aprueba sola");
await registrar(A1.id, "Tanda 1: 3 tickets", false);
ok((await prog()).ultima_accion_id === A1.id && (await prog()).pedida_at === null, "registra la tanda");
ok((await turno()).length === 0, "espera mientras la tanda se ejecuta");
await terminar(A1.id, "ok");
t = await turno();
ok(t.length === 1 && t[0].tanda === 2, "terminada con aprobados: pide la tanda 2");
await registrar(null, "Terminado: no quedan tickets pendientes", true);
let p = await prog();
ok(p.dia_en_curso === null && String(p.ultimo_dia_completado).length > 0 && /no quedan/.test(p.ultimo_resultado), "sin tickets: la noche queda hecha");
ok((await turno()).length === 0 && (await cron()) === null, "hecha la de hoy, no vuelve a empezar hasta mañana");

// ---------------------------------------------------------------- paradas
const empezar = async () => { await sistema(); await q("update holded_acciones_programadas set ultimo_dia_completado = null, dia_en_curso = null, tandas = 0, ultima_accion_id = null, pedida_at = null"); };
await empezar(); await turno();
await sistema(); await q("delete from holded_acciones_politicas");
const A2 = await crear(200, 2);
ok(A2.estado === "propuesta", "sin política automática se queda en propuesta");
await registrar(A2.id, "Tanda 1", false);
ok((await turno()).length === 0 && /no se aprobó sola/.test((await prog()).ultimo_resultado), "si no se aprueba sola, para la noche");
await sistema(); await q("update holded_acciones set estado = 'cancelada' where id = $1", [A2.id]);
await q(`insert into holded_acciones_politicas (empresa_id, tipo, modo, max_documentos, max_importe) values ($1, $2, 'automatica', 1000, 999999999999.99)`, [E.a, TIPO]);

await empezar(); await turno();
const A3 = await crear(300, 2); await registrar(A3.id, "Tanda 1", false);
await terminar(A3.id, "error");
ok((await turno()).length === 0 && /no aprobó ningún ticket/.test((await prog()).ultimo_resultado), "si una tanda no aprueba ninguno, para (no da vueltas)");

await empezar(); await turno();
const A4 = await crear(400, 2); await registrar(A4.id, "Tanda 1", false);
await sistema(); await q("update holded_acciones set estado = 'pausada' where id = $1", [A4.id]);
ok((await turno()).length === 0 && /pausada/.test((await prog()).ultimo_resultado), "si la tanda se pausa (cupo), para");
await sistema(); await q("update holded_acciones set estado = 'cancelada' where id = $1", [A4.id]);

await empezar(); await sistema(); await q("update holded_acciones_programadas set dia_en_curso = $1, tandas = 20", [hoy]);
ok((await turno()).length === 0 && /20 tandas/.test((await prog()).ultimo_resultado), "como mucho 20 tandas por noche");

await empezar(); await sistema(); await q("update holded_acciones_programadas set dia_en_curso = $1, tandas = 1, pedida_at = now() - interval '20 minutes'", [hoy]);
t = await turno();
ok(t.length === 1 && t[0].tanda === 2, "una tanda pedida que nunca se registró se vuelve a pedir pasados 15 min");

await falla(() => registrar(T.id === undefined ? A1.id : A1.id, "x", false).then(async () => {
  await servicio(); await q("select public.holded_programada_registrar($1, $2, $3, 'x', false)", [E.b, TIPO, A1.id]); }),
  /no es de esta empresa/, "no se registra una acción de otra empresa");

// ---------------------------------------------------------------- ejecutar ahora y desactivar
await empezar();
await sistema(); await q("update holded_acciones_programadas set hora = 23, ultimo_dia_completado = null");
x = await rpcU(U.admin, "holded_cambiar_programacion", E.a, TIPO, true, true);
ok(x.dia_en_curso === hoy, "«ejecutar ahora» empieza una pasada aunque no sea la hora");
t = await turno();
ok(t.length === 1 && t[0].hasta === hoy, "la pasada manual pide su tanda");
await registrar(null, "Terminado", true);
p = await prog();
ok(p.dia_en_curso === null && p.ultimo_dia_completado === null, "la pasada manual no cuenta como la de la noche");
await rpcU(U.admin, "holded_cambiar_programacion", E.a, TIPO, true, true);
x = await rpcU(U.admin, "holded_cambiar_programacion", E.a, TIPO, false, false);
p = await prog();
ok(x.activa === false && p.dia_en_curso === null && /Desactivada con una pasada en marcha/.test(p.ultimo_resultado), "desactivar corta la pasada");
await sistema(); await q("update holded_acciones_programadas set hora = 0");
ok((await turno()).length === 0 && (await cron()) === null, "desactivada no hace nada aunque sea la hora");

console.log(`\n${total - fallos}/${total} pruebas correctas`);
process.exit(fallos ? 1 : 0);
