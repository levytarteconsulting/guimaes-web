// Prueba de crm/supabase-holded-consultas.sql (bloque 2) en PGlite, encima
// del esquema base, el importador y el bloque 1. Datos y claves INVENTADOS.
// Uso (desde crm/tests/holded): npm install && node holded-consultas.test.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const leer = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const bloque1 = leer("../../supabase-holded-conexiones.sql");
const mig = leer("../../supabase-holded-consultas.sql");
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

// ---------------------------------------------------------------- 7A / 7B / 7C
await sistema();
const RA = await tabla(parte(mig, "7A", "7"));
console.log("7A:", JSON.stringify(RA));
ok(RA["migración 20261127140000 (bloque 1)"] === "sí" && RA["migración 20261127160000"] === "no", "7A: bloque 1 sí, bloque 2 no");
ok(RA["tabla holded_consultas"] === "0" && RA["columna cupo_mensual"] === "0" && RA["funciones nuevas"] === "0", "7A: nada del bloque 2");
ok(RA["holded_clave_de"] === "1" && RA["is_admin(uuid) / is_admin_role(uuid)"] === "1/1", "7A: funciones base");
ok(RA["conexiones"] === "3", "7A: 3 conexiones");
await db.exec(parte(mig, "7B", "7"));
ok(true, "7B aplicado");
await falla(() => db.exec(parte(mig, "7B", "7")), /ya está aplicada/, "7B se niega a repetirse");
const RC = await tabla(parte(mig, "7C", "7"));
console.log("7C:", JSON.stringify(RC));
ok(RC["holded_consultas con RLS / políticas"] === "1/0", "7C: RLS sin políticas");
ok(RC["authenticated SELECT/INSERT holded_consultas"] === "no/no", "7C: authenticated no toca la auditoría");
ok(RC["authenticated SELECT cupo_mensual / UPDATE holded_conexiones"] === "sí/no", "7C: ve el cupo, no actualiza");
ok(RC["cupo_mensual por defecto en las conexiones"] === "todas 150", "7C: cupo 150");
ok(RC["EXECUTE authenticated holded_iniciar/terminar"] === "no/no", "7C: iniciar/terminar cerradas a authenticated");
ok(RC["EXECUTE service_role holded_iniciar/terminar"] === "sí/sí", "7C: service_role las ejecuta");
ok(RC["EXECUTE anon/authenticated holded_uso_mes"] === "no/sí", "7C: uso_mes");
ok(RC["EXECUTE anon/authenticated holded_cambiar_cupo"] === "no/sí", "7C: cambiar_cupo");
ok(RC["conexiones"] === "3" && /^20261127160000 /.test(RC["migración registrada"] || ""), "7C: conexiones y registro");

// ---------------------------------------------------------------- permisos
const ini = async (u, e, tipo = "facturas", max = 5, ver = null) =>
  (await uno("select public.holded_iniciar($1, $2, $3, $4, $5) r", [u, e, tipo, max, ver])).r;
const ter = async (id, n, cod) => q("select public.holded_terminar($1, $2, $3)", [id, n, cod]);
await como(U.admin);
await falla(() => ini(U.admin, E.a), /42501|permission denied/, "authenticated no puede llamar a holded_iniciar");
await falla(() => ter(E.a, 1, "200"), /42501|permission denied/, "authenticated no puede llamar a holded_terminar");
await falla(() => q("select * from public.holded_consultas"), /42501|permission denied/, "authenticated no lee la auditoría");
await falla(() => q("update public.holded_conexiones set cupo_mensual = 9999"), /42501|permission denied/, "authenticated no cambia el cupo a mano");
await como(null);
await falla(() => q("select * from public.holded_uso_mes()"), /42501|permission denied/, "anon no ve el uso");
await servicio();
await falla(() => ini(U.inactivo, E.a), /Solo usuarios activos/, "usuario inactivo no consulta");
await falla(() => ini("99999999-9999-9999-9999-999999999999", E.a), /Solo usuarios activos/, "usuario desconocido no consulta");
await falla(() => ini(U.admin, E.a, "crear_factura"), /Tipo de consulta/, "tipo fuera de la lista");
await falla(() => ini(U.admin, E.a, "facturas", 51), /Máximo de llamadas/, "más de 50 llamadas por consulta");

// ---------------------------------------------------------------- iniciar / terminar
let r = await ini(U.miembro, E.sin, "tesoreria");
ok(r.ok === false && r.motivo === "sin_conexion", "sin conexión → sin_conexion (miembro sí puede preguntar)");
r = await ini(U.admin, "88888888-8888-8888-8888-888888888888", "tesoreria");
ok(r.ok === false && r.motivo === "sin_conexion", "empresa inexistente → sin_conexion");
r = await ini(U.admin, E.mal, "facturas");
ok(r.ok === false && r.motivo === "conexion_error" && /401/.test(r.error), "conexión con error → conexion_error con su mensaje");
r = await ini(U.admin, E.a, "facturas", 5);
ok(r.ok && !r.desde_cache && r.reservadas === 5 && r.usadas === 0 && r.cupo === 150 && /^[0-9a-f]{32}$/.test(r.version), "reserva 5 de 150");
ok(!JSON.stringify(r).includes("pat_"), "iniciar no devuelve la clave");
const version = r.version;
await ter(r.consulta_id, 2, "200");
await sistema();
let c = await uno("select llamadas, codigo, terminada_at is not null t from holded_consultas where id = $1", [r.consulta_id]);
ok(c.llamadas === 2 && c.codigo === "200" && c.t, "terminar: 2 llamadas hechas, se liberan 3");
await servicio();
await ter(r.consulta_id, 50, "200");
await sistema();
c = await uno("select llamadas from holded_consultas where id = $1", [r.consulta_id]);
ok(c.llamadas === 2, "terminar dos veces no cambia nada");
await servicio();
r = await ini(U.admin, E.a, "facturas", 5, version);
ok(r.ok && r.desde_cache === true && r.consulta_id === undefined, "versión de la caché coincide → desde la caché, sin reserva");
r = await ini(U.admin, E.a, "facturas", 5, "otra-version");
ok(r.ok && !r.desde_cache && r.usadas === 2, "versión distinta → consulta real; usadas = 2");
const enCurso = r.consulta_id;

// Una reserva sin terminar sigue contando.
r = await ini(U.admin, E.a, "resumen", 20);
ok(r.usadas === 7, "la reserva en curso (5) cuenta: usadas = 7");
await ter(enCurso, 5, "429-minuto");
await ter(r.consulta_id, 20, "200");

// ---------------------------------------------------------------- cupo
await como(U.miembro);
await falla(() => q("select public.holded_cambiar_cupo($1, 30)", [E.a]), /Solo el rol admin/, "miembro no cambia el cupo");
await como(U.admin);
await falla(() => q("select public.holded_cambiar_cupo($1, -1)", [E.a]), /entre 0 y 100.000/, "cupo negativo");
await falla(() => q("select public.holded_cambiar_cupo($1, 10)", [E.sin]), /no tiene Holded/, "cupo de empresa sin conexión");
await q("select public.holded_cambiar_cupo($1, 30)", [E.a]);
let uso = await q("select * from public.holded_uso_mes() order by empresa_id");
const ua = uso.find((x) => x.empresa_id === E.a);
ok(uso.length === 3 && ua.usadas === 27 && ua.cupo === 30, "uso del mes: 27 de 30 (2 + 5 + 20; caché y rechazos no cuentan)");
ok((await q("select * from public.holded_uso_mes($1)", [E.b]))[0].usadas === 0, "uso de una sola empresa");
await como(U.miembro);
ok((await q("select * from public.holded_uso_mes($1)", [E.a]))[0].usadas === 27, "un miembro ve el uso");
await servicio();
r = await ini(U.admin, E.a, "contactos", 5);
ok(r.ok && r.reservadas === 3, "quedan 3: reserva solo 3 aunque pida 5");
const r2 = await ini(U.admin, E.a, "contactos", 5);
ok(r2.ok === false && r2.motivo === "cupo" && r2.usadas === 30 && r2.cupo === 30, "con todo reservado → cupo agotado");
r = await ini(U.admin, E.a, "contactos", 5, version);
ok(r.ok && r.desde_cache, "con el cupo agotado, la caché sigue sirviendo");
await sistema();
const cods = await q("select codigo, count(*)::int n from holded_consultas group by codigo order by codigo");
console.log("   códigos:", JSON.stringify(cods));
ok(cods.find((x) => x.codigo === "cupo")?.n === 1 && cods.find((x) => x.codigo === "sin_conexion")?.n === 2, "auditoría de rechazos");
// Mes anterior: no cuenta.
await db.exec(`update holded_consultas set created_at = holded_inicio_mes() - interval '1 second'`);
await como(U.admin);
ok((await q("select * from public.holded_uso_mes($1)", [E.a]))[0].usadas === 0, "lo del mes pasado no cuenta");
await sistema();
ok((await uno("select holded_inicio_mes() <= now() and holded_inicio_mes() > now() - interval '32 days' b")).b, "inicio de mes razonable");

// Borrar la empresa deja la auditoría (empresa_id = null).
await db.exec(`delete from public.empresas where id = '${E.b}'`);
await servicio();
await sistema();
ok((await uno("select count(*)::int n from holded_consultas where empresa_id is null")).n >= 1, "consultas de empresas inexistentes con empresa_id null");

console.log(`\n${total - fallos}/${total} pruebas correctas`);
process.exit(fallos ? 1 : 0);
