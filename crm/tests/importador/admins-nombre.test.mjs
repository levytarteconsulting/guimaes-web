// Prueba de crm/supabase-admins-nombre.sql en PGlite (estructura real de
// producción en esquema-base.sql, datos inventados). Uso: node admins-nombre.test.mjs
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const mig = fs.readFileSync(new URL("../../supabase-admins-nombre.sql", import.meta.url), "utf8");
const parte = (id) => mig.match(new RegExp(`-- ${id} [\\s\\S]*?(?=\\n-- =+\\n-- 5[A-Z] |$)`))[0];
const db = new PGlite();
let fallos = 0, total = 0;
const ok = (c, msg) => { total++; console.log((c ? "  ok   " : "  FALLO ") + msg); if (!c) fallos++; };
const q = async (s, p) => (await db.query(s, p)).rows;
const tabla = async (sql) => Object.fromEntries((await db.exec(sql)).at(-1).rows.map((r) => [r.comprobacion, r.valor]));
async function falla(fn, re, msg) {
  try { await fn(); ok(false, msg + " (no falló)"); }
  catch (e) { ok(re.test(e.code || "") || re.test(e.message), msg + ` [${e.code} ${e.message.slice(0, 70)}]`); }
}

await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`);
await db.exec(fs.readFileSync(dir + "esquema-base.sql", "utf8"));
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
// set_updated_at de admins (en producción existe; esquema-base solo trae los triggers de 4 tablas)
await db.exec(`create trigger admins_set_updated_at before update on public.admins for each row execute function public.set_updated_at();`);

const U = { admin: "11111111-1111-1111-1111-111111111111", miembro: "22222222-2222-2222-2222-222222222222",
            inactivo: "33333333-3333-3333-3333-333333333333", otro: "44444444-4444-4444-4444-444444444444" };
const A = { g1: "aa000000-0000-0000-0000-000000000001", g2: "aa000000-0000-0000-0000-000000000002",
            mario: "aa000000-0000-0000-0000-000000000003", iris: "aa000000-0000-0000-0000-000000000004" };
await db.exec(`insert into auth.users values ('${U.admin}'), ('${U.miembro}'), ('${U.inactivo}'), ('${U.otro}');
  insert into public.admins (id, auth_user_id, nombre, email, rol, activo) values
    ('${A.g1}', '${U.admin}', 'Guillermo Inventado', 'g1@x.invalid', 'admin', true),
    ('${A.g2}', '${U.otro}', 'Guillermo Inventado', 'g2@x.invalid', 'admin', true),
    ('${A.mario}', '${U.miembro}', 'Mario', 'm@x.invalid', 'miembro', true),
    ('${A.iris}', '${U.inactivo}', 'Iris', 'i@x.invalid', 'miembro', false);`);
const antes = (await q("select count(*)::int n from admins"))[0].n;

console.log("5A:");
const RA = await tabla(parte("5A"));
console.log("   ", JSON.stringify(RA));
ok(RA["migración 20261127120000"] === "no" && RA["función admin_renombrar_usuario"] === "0"
   && RA["trigger admins_nombre_valido"] === "0" && RA["authenticated puede UPDATE email"] === "sí"
   && RA["funciones base (is_admin, is_admin_role, agente_norm)"] === "3", "5A: lo esperado");
console.log("5B:");
await db.exec(parte("5B"));
ok(true, "5B aplicado");
await falla(() => db.exec(parte("5B")), /ya está aplicada/, "5B se niega a repetirse");
console.log("5C:");
const RC = await tabla(parte("5C"));
console.log("   ", JSON.stringify(RC));
ok(RC["función admin_renombrar_usuario (definer)"] === "1" && RC["EXECUTE anon/authenticated"] === "no/sí"
   && RC["trigger admins_nombre_valido"] === "1" && RC["authenticated UPDATE email/auth_user_id"] === "no/no"
   && RC["authenticated UPDATE nombre/rol/activo"] === "sí/sí/sí" && RC["filas admins"] === String(antes)
   && /^20261127120000 /.test(RC["migración registrada"]), "5C: lo esperado");

async function como(uid) { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${uid ? "authenticated" : "anon"};`); }
const renombrar = async (id, n) => (await q("select public.admin_renombrar_usuario($1, $2) r", [id, n]))[0].r;
const nombre = async (id) => { await db.exec("reset role"); return (await q("select nombre from admins where id = $1", [id]))[0].nombre; };

console.log("rol admin:");
await como(U.admin);
ok((await renombrar(A.g2, "  Guillermo   Terán  ")).nombre === "Guillermo Terán", "renombra a otro y limpia espacios");
ok(await nombre(A.g2) === "Guillermo Terán", "guardado");
await como(U.admin);
ok((await renombrar(A.mario, "Mario Ejemplo")).nombre === "Mario Ejemplo", "renombra a un miembro");
await como(U.admin);
await falla(() => renombrar(A.mario, "   "), /23514/, "nombre vacío: error");
await como(U.admin);
await falla(() => renombrar(A.mario, "guillermo TERAN"), /23505/, "nombre de otro (sin tildes ni mayúsculas): error");
await como(U.admin);
await falla(() => renombrar("aa000000-0000-0000-0000-00000000ffff", "X"), /GU010/, "usuario inexistente: error");

console.log("miembro:");
await como(U.miembro);
ok((await renombrar(A.mario, "Mario Prueba")).nombre === "Mario Prueba", "un miembro cambia su propio nombre");
await como(U.miembro);
await falla(() => renombrar(A.g1, "Otro"), /42501/, "un miembro no cambia el nombre de otro");
await como(U.miembro);
await db.exec(`update admins set nombre = 'Directo' where id = '${A.g1}'`);
ok(await nombre(A.g1) === "Guillermo Inventado", "UPDATE directo de un miembro: la RLS no lo deja");
await como(U.inactivo);
await falla(() => renombrar(A.iris, "Iris Nueva"), /42501/, "un usuario inactivo no puede");
await como(null);
await falla(() => renombrar(A.mario, "X"), /42501|permission denied/, "anon no tiene EXECUTE");

console.log("email y otras columnas:");
await como(U.admin);
await falla(() => db.exec(`update admins set email = 'nuevo@x.invalid' where id = '${A.mario}'`), /permission denied|42501/, "el rol admin no puede cambiar el email por API");
await como(U.admin);
await falla(() => db.exec(`update admins set auth_user_id = null where id = '${A.mario}'`), /permission denied|42501/, "ni auth_user_id");
await como(U.admin);
await db.exec(`update admins set rol = 'admin' where id = '${A.mario}'`);
await db.exec(`update admins set activo = false where id = '${A.mario}'`);
await db.exec("reset role");
const m = (await q("select rol, activo, email from admins where id = $1", [A.mario]))[0];
ok(m.rol === "admin" && m.activo === false && m.email === "m@x.invalid", "rol y estado se siguen cambiando como antes; email intacto");
await como(U.admin);
await db.exec(`update admins set nombre = 'Ana  Directa ' where id = '${A.mario}'`);
ok(await nombre(A.mario) === "Ana Directa", "UPDATE directo del rol admin: también pasa por el trigger");

console.log("duplicados que ya existían:");
await db.exec(`reset role; alter table admins disable trigger admins_nombre_valido;
  update admins set nombre = 'Guillermo Inventado' where id = '${A.g2}';
  alter table admins enable trigger admins_nombre_valido;`);
await como(U.admin);
ok((await renombrar(A.g1, "guillermo inventado")).nombre === "guillermo inventado", "un repetido previo puede guardar su mismo nombre");
await como(U.admin);
ok((await renombrar(A.g1, "Guillermo Real")).nombre === "Guillermo Real", "y cambiarlo a uno libre");
await db.exec("reset role");
await falla(() => db.exec(`insert into admins (nombre, email) values (' Guillermo Real ', 'n@x.invalid')`), /23505/, "un alta con nombre repetido falla (Edge Function admin-users)");
await db.exec(`insert into admins (nombre, email) values (' Nuevo   Usuario ', 'n2@x.invalid')`);
ok((await q("select nombre from admins where email = 'n2@x.invalid'"))[0].nombre === "Nuevo Usuario", "un alta normal limpia espacios");

console.log("lo ve todo el equipo:");
await db.exec(`reset role; update admins set activo = true, rol = 'miembro' where id = '${A.mario}'`);
await como(U.miembro);
ok((await q("select nombre from admins where id = $1", [A.g1]))[0].nombre === "Guillermo Real", "un miembro lee el nombre nuevo (agente, avisos y CRM leen admins.nombre)");

console.log(`\n${total - fallos}/${total} ok`);
process.exit(fallos ? 1 : 0);
