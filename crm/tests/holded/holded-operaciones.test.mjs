// Prueba de crm/supabase-holded-operaciones.sql en PGlite, encima del esquema
// base, el importador, los bloques 1 y 2 y las acciones (8B). Datos INVENTADOS.
// Uso (desde crm/tests/holded): npm install && node holded-operaciones.test.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const leer = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const bloque1 = leer("../../supabase-holded-conexiones.sql");
const bloque2 = leer("../../supabase-holded-consultas.sql");
const acciones = leer("../../supabase-holded-acciones.sql");
const mig = leer("../../supabase-holded-operaciones.sql");
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

// ---------------------------------------------------------------- 9A / 9B / 9C
await sistema();
const RA = await tabla(parte(mig, "9A", "9"));
console.log("9A:", JSON.stringify(RA));
ok(RA["migración 20261127180000"] === "sí" && RA["migración 20261127230000"] === "no" && RA["tabla holded_operaciones"] === "0"
   && RA["acciones de tipo operacion"] === "0" && RA["tarea holded-acciones-purgar"] === "0" && RA["cupos (0 / >0)"] === "2 / 1" && RA["items"] === "3", "9A: lo esperado");
await db.exec(parte(mig, "9B", "9"));
ok(true, "9B aplicado");
await falla(() => db.exec(parte(mig, "9B", "9")), /ya está aplicada/, "9B se niega a repetirse");
const RC = await tabla(parte(mig, "9C", "9"));
console.log("9C:", JSON.stringify(RC));
const nAlto = catalogo.operaciones.filter((o) => o.riesgo === "alto").length;
ok(RC["operaciones en el catálogo"] === `${catalogo.operaciones.length} (alto/normal: ${nAlto}/${catalogo.operaciones.length - nAlto})`, "9C: catálogo = catalogo.json");
ok(RC["EXECUTE authenticated crear_operacion/purgar"] === "no/no", "9C: crear_operacion y purgar cerradas");
ok(RC["EXECUTE authenticated aprobar(3)/peticiones/política"] === "sí/sí/sí", "9C: funciones del CRM");
ok(RC["aprobar(uuid, integer) antiguo"] === "no existe", "9C: aprobar antiguo borrado");
ok(RC["cupos con 0"] === "0" && RC["items"] === "3" && RC["tarea holded-acciones-purgar"] === "1", "9C: cupos, items y tarea");
ok(/^20261127230000 /.test(RC["migración registrada"]), "9C: registrada");
ok((await uno("select count(*)::int n from holded_operaciones o where not exists (select 1 from unnest($1::text[]) x where x = o.id)", [catalogo.operaciones.map((o) => o.id)])).n === 0, "los ids del catálogo SQL = catalogo.json");
ok((await uno("select cupo_acciones_mensual c from holded_conexiones where empresa_id = $1", [E.b])).c === 50, "cupo 50 para las que tenían 0");
ok((await uno("select cupo_acciones_mensual c from holded_conexiones where empresa_id = $1", [E.a])).c === 1000, "el que tenía cupo lo conserva");

// La acción de tickets sigue igual tras la migración.
r = await reclamar(5);
ok(r.tipo === "aprobar_tickets_venta" && r.ids.length === 1 && !r.peticiones, "tickets: se sigue reclamando por id");
await resultado(T.id, r.ids.map((id) => ({ id, estado: "ok", codigo: 200 })), 1);
ok((await estadoDe(T.id)).estado === "completada", "tickets: completa como antes");

// ---------------------------------------------------------------- crear operación
const OP = (id) => catalogo.operaciones.find((o) => o.id === id);
const pet = (metodo, ruta, extra = {}) => ({ metodo, ruta, ...extra });
const crearOp = async (u, origen, e, op, peticiones, desc = "Prueba inventada") => { await servicio(); return (await uno(
  "select public.holded_acciones_crear_operacion($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, $7, $8::jsonb, 0) r",
  [u, origen, e, op, desc, "{}", ["aviso"], JSON.stringify(peticiones)])).r; };
await como(U.admin);
await falla(() => q("select public.holded_acciones_crear_operacion($1, 'agente', $2, 'create_contact', 'x', '{}', '[]', '{}', $3::jsonb, 0)",
  [U.admin, E.a, JSON.stringify([pet("POST", "/contacts")])]), /42501|permission denied/, "authenticated no crea operaciones");
await falla(() => crearOp(U.admin, "agente", E.a, "borrar_todo", [pet("POST", "/contacts")]), /no permitida/, "operación fuera del catálogo");
await falla(() => crearOp(U.admin, "agente", E.a, "create_contact", [pet("PUT", "/contacts")]), /fuera de la operación/, "método distinto");
await falla(() => crearOp(U.admin, "agente", E.a, "create_contact", [pet("POST", "/contacts/x/../../account/users")]), /fuera de la operación|check/, "ruta distinta");
await falla(() => crearOp(U.admin, "agente", E.a, "update_contact", [pet("PUT", `/contacts/${hex(1)}/otra`)]), /fuera de la operación/, "ruta con más segmentos");
await falla(() => crearOp(U.admin, "agente", E.a, "create_contact", []), /entre 1 y 100/, "sin peticiones");
await falla(() => crearOp(U.admin, "agente", E.a, "create_contact", Array.from({ length: 101 }, () => pet("POST", "/contacts"))), /entre 1 y 100/, "más de 100");
await falla(() => crearOp(U.admin, "agente", E.a, "create_contact", [pet("POST", "/contacts")], "  "), /descripción/, "sin descripción");
await falla(() => crearOp(U.inactivo, "agente", E.a, "create_contact", [pet("POST", "/contacts")]), /Solo usuarios activos/, "usuario inactivo");
await falla(() => crearOp(U.admin, "agente", E.sin, "create_contact", [pet("POST", "/contacts")]), /no tiene Holded/, "empresa sin Holded");
await falla(() => crearOp(U.admin, "agente", E.a, "create_contact", [pet("POST", "/contacts", { cuerpo: { x: "a".repeat(70000) } })]), /check/, "cuerpo de más de 64 KB");
const C1 = await crearOp(U.miembro, "agente", E.a, "create_contact", [pet("POST", "/contacts", { cuerpo: { name: "Cliente Inventado" } })], "Crear contacto Cliente Inventado");
ok(C1.estado === "propuesta" && C1.riesgo === "normal" && C1.documentos === 1, "crear contacto: propuesta normal");
const D1 = await crearOp(U.admin, "agente", E.a, "delete_invoice",
  [pet("DELETE", `/invoices/${hex(50)}`, { holded_id: hex(50), estado_anterior: { id: hex(50), total: 121 } })], "Borrar factura de prueba");
ok(D1.riesgo === "alto", "borrar factura: riesgo alto");
const L = await crearOp(U.admin, "crm", E.a, "update_contact",
  IDS(100, 3).map((id) => pet("PUT", `/contacts/${id}`, { holded_id: id, cuerpo: { name: "Nuevo" }, estado_anterior: { id, name: "Viejo" } })), "Renombrar 3 contactos");
ok(L.documentos === 3, "lote de 3");

// ---------------------------------------------------------------- políticas
await falla(() => rpcU(U.miembro, "holded_cambiar_politica", E.a, "create_contact", "automatica", 5, null), /Solo el rol admin/, "un miembro no cambia políticas");
await falla(() => rpcU(U.admin, "holded_cambiar_politica", E.a, "delete_invoice", "automatica", 5, null), /riesgo alto no pueden ser automáticas/, "riesgo alto no puede ser automática");
await falla(() => rpcU(U.admin, "holded_cambiar_politica", E.a, "inventada", "automatica", 5, null), /desconocida/, "operación desconocida");
await falla(() => rpcU(U.admin, "holded_cambiar_politica", E.a, "create_contact", "automatica", null, null), /check|topes/, "automática sin tope");
await sistema();
await falla(() => db.exec(`insert into holded_acciones_politicas (empresa_id, tipo, modo, max_documentos) values ('${E.a}', 'delete_invoice', 'automatica', 5)`),
  /riesgo alto/, "ni insertando directamente");
await rpcU(U.admin, "holded_cambiar_politica", E.a, "create_contact", "automatica", 2, null);
ok((await crearOp(U.admin, "agente", E.a, "create_contact", [pet("POST", "/contacts"), pet("POST", "/contacts")])).estado === "aprobada", "automática normal dentro del tope → aprobada");
ok((await crearOp(U.admin, "agente", E.a, "create_contact", [1, 2, 3].map(() => pet("POST", "/contacts")))).estado === "propuesta", "por encima del tope → propuesta");
await rpcU(U.admin, "holded_cambiar_politica", E.a, "create_contact", "aprobacion", null, null);
await sistema();
ok((await uno("select count(*)::int n from holded_acciones_politicas")).n === 0, "volver a «requiere aprobación» borra la política");
await sistema();
await db.exec("update holded_acciones set estado = 'cancelada' where estado = 'aprobada' and tipo = 'operacion'");

// ---------------------------------------------------------------- aprobar: CONFIRMAR
await falla(() => rpcU(U.miembro, "holded_acciones_aprobar", C1.id, null, null), /Solo el rol admin/, "un miembro no aprueba");
await falla(() => rpcU(U.admin, "holded_acciones_aprobar", D1.id, null, null), /escribe CONFIRMAR/, "riesgo alto sin CONFIRMAR");
await falla(() => rpcU(U.admin, "holded_acciones_aprobar", D1.id, null, "confirmo"), /escribe CONFIRMAR/, "riesgo alto con otro texto");
ok((await rpcU(U.admin, "holded_acciones_aprobar", D1.id, null, " CONFIRMAR ")).estado === "aprobada", "riesgo alto con CONFIRMAR");
ok((await rpcU(U.admin, "holded_acciones_aprobar", C1.id, null, null)).estado === "aprobada", "riesgo normal sin texto");

// ---------------------------------------------------------------- peticiones (rol admin)
await falla(() => rpcU(U.miembro, "holded_acciones_peticiones", L.id, 1, 20), /Solo el rol admin/, "un miembro no ve las peticiones");
await como(U.admin);
let ps = await q("select * from holded_acciones_peticiones($1, 1, 20)", [L.id]);
ok(ps.length === 3 && ps[0].metodo === "PUT" && ps[0].ruta === `/contacts/${hex(100)}` && ps[0].cuerpo.name === "Nuevo" && ps[0].estado_anterior.name === "Viejo", "petición exacta y estado anterior");
await falla(() => q("select * from holded_acciones_items"), /42501|permission denied/, "items siguen cerrados");

// ---------------------------------------------------------------- ejecutar operaciones
r = await reclamar(10);
ok(r.accion_id === D1.id && r.tipo === "operacion" && r.operacion === "delete_invoice" && r.peticiones.length === 1
   && r.peticiones[0].metodo === "DELETE" && r.peticiones[0].ruta === `/invoices/${hex(50)}`, "reclamar devuelve las peticiones (método, ruta, cuerpo)");
await resultado(D1.id, [{ orden: 1, estado: "pendiente", codigo: 503 }], 1);
r = await reclamar(10);
ok(r.accion_id === D1.id && r.peticiones.length === 1, "DELETE con 5xx vuelve a la cola");
await resultado(D1.id, [{ orden: 1, estado: "ok", codigo: 204 }], 1);
ok((await estadoDe(D1.id)).estado === "completada", "y se completa");
r = await reclamar(10);
ok(r.accion_id === C1.id && r.peticiones[0].cuerpo.name === "Cliente Inventado", "POST con su cuerpo");
await resultado(C1.id, [{ orden: 1, estado: "desconocido", codigo: null, error: "Sin respuesta: puede que se haya hecho" }], 1);
ok((await estadoDe(C1.id)).estado === "completada", "POST desconocido: no se reintenta y la acción termina");
let pg = await rpcU(U.admin, "holded_acciones_progreso", C1.id);
ok(pg.desconocido === 1 && pg.errores[0].estado === "desconocido", "progreso cuenta lo desconocido");
await rpcU(U.admin, "holded_acciones_aprobar", L.id, null, null);
r = await reclamar(10);
ok(r.peticiones.length === 3, "lote de 3 PUT");
await resultado(L.id, [{ orden: 1, estado: "ok", codigo: 200, resultado_id: hex(100) }, { orden: 2, estado: "error", codigo: 422, error: "Campo no válido" },
                       { orden: 3, estado: "ok", codigo: 200, resultado_id: "no válido!" }], 3);
await como(U.admin);
ps = await q("select * from holded_acciones_peticiones($1, 1, 20)", [L.id]);
ok(ps[0].resultado_id === hex(100) && ps[1].estado === "error" && ps[2].resultado_id === null, "resultado por orden, id devuelto validado");

// POST atascado más de 5 min → desconocido (no se repite); PUT atascado → vuelve a la cola.
const P2 = await crearOp(U.admin, "crm", E.a, "create_contact", [pet("POST", "/contacts")], "Otro contacto");
const P3 = await crearOp(U.admin, "crm", E.a, "update_contact", [pet("PUT", `/contacts/${hex(300)}`, { holded_id: hex(300) })], "Otro cambio");
await rpcU(U.admin, "holded_acciones_aprobar", P2.id, null, null);
await rpcU(U.admin, "holded_acciones_aprobar", P3.id, null, null);
await reclamar(10); await reclamar(10);
await sistema();
await db.exec(`update holded_acciones_items set reclamado_at = now() - interval '6 minutes' where accion_id in ('${P2.id}', '${P3.id}')`);
r = await reclamar(10);
ok(r && r.accion_id === P3.id, "el PUT atascado se vuelve a reclamar");
await sistema();
ok((await uno("select estado from holded_acciones_items where accion_id = $1", [P2.id])).estado === "desconocido", "el POST atascado queda como desconocido");

// Cupo: aviso claro y ampliable.
await sistema();
await db.exec(`update holded_conexiones set cupo_acciones_mensual = 1 where empresa_id = '${E.b}'`);
const K = await crearOp(U.admin, "crm", E.b, "create_contact", [pet("POST", "/contacts"), pet("POST", "/contacts")], "Dos contactos");
await sistema();
ok((await uno("select avisos from holded_acciones where id = $1", [K.id])).avisos.some((a) => /CUPO: esta propuesta necesita 2 .* solo cubre 1/.test(a)), "aviso de cupo con cifras");

// ---------------------------------------------------------------- retención 90 días
await sistema();
await db.exec(`update holded_acciones set terminada_at = now() - interval '91 days' where id = '${L.id}'`);
await db.exec(`update holded_acciones set terminada_at = now() - interval '89 days' where id = '${D1.id}'`);
await sistema();   // pg_cron la ejecuta como propietario
const n = (await uno("select public.holded_acciones_purgar() n")).n;
await como(U.admin);
ps = await q("select * from holded_acciones_peticiones($1, 1, 20)", [L.id]);
ok(n === 3 && ps.every((p) => p.cuerpo === null && p.estado_anterior === null && p.purgado) && ps[0].metodo === "PUT" && ps[0].ruta && ps[0].resultado_id === hex(100) && ps[1].codigo === 422,
   "a los 90 días: sin cuerpo ni estado anterior; quedan método, ruta, resultado e id");
ps = await q("select * from holded_acciones_peticiones($1, 1, 20)", [D1.id]);
ok(ps[0].estado_anterior !== null, "antes de 90 días no se toca");
await sistema();
ok((await uno("select public.holded_acciones_purgar() n")).n === 0, "purgar dos veces no hace nada");
await sistema();
ok((await uno("select schedule from cron.job where jobname = 'holded-acciones-purgar'")).schedule === "17 3 * * *", "purga diaria");
await como(U.admin);
await falla(() => q("select public.holded_acciones_purgar()"), /42501|permission denied/, "authenticated no purga");

console.log(`\n${total - fallos}/${total} pruebas correctas`);
process.exit(fallos ? 1 : 0);
