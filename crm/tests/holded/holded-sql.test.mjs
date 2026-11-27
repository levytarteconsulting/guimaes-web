// Prueba de crm/supabase-holded-conexiones.sql en PGlite: estructura real de
// producción (../importador/esquema-base.sql + migración del importador),
// Vault y pg_cron simulados, datos y claves INVENTADOS.
// Uso (desde crm/tests/holded): npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const leer = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const mig = leer("../../supabase-holded-conexiones.sql");
const base = leer("../importador/esquema-base.sql");
const importador = leer("../../supabase-importador.sql");

function parte(id) {
  const re = new RegExp(`-- ${id} [\\s\\S]*?(?=\\n-- =+\\n-- 6[A-Z] |$)`);
  const m = mig.match(re); if (!m) throw new Error("sin parte " + id);
  return m[0];
}

const db = new PGlite();
let fallos = 0, total = 0;
const ok = (c, msg) => { total++; console.log((c ? "  ok   " : "  FALLO ") + msg); if (!c) fallos++; };
const q = async (s, p) => (await db.query(s, p)).rows;
const uno = async (s, p) => (await q(s, p))[0];
const tabla = async (sql) => Object.fromEntries((await db.exec(sql)).at(-1).rows.map((r) => [r.comprobacion, r.valor]));
const falla = async (fn, re, msg) => {
  try { await fn(); ok(false, msg + " (no falló)"); }
  catch (e) { ok(re.test(e.message) || re.test(e.code || ""), msg + (re.test(e.message) || re.test(e.code || "") ? "" : ` (${e.code} ${e.message})`)); }
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
  -- Vault simulado (misma firma que supabase_vault)
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text not null);
  create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
    returns uuid language sql as $$ insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id $$;
  revoke all on schema vault from public;
  -- pg_cron simulado
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
await db.exec(importador);   // 4A + 4B + 4C: deja public.importaciones y admin_deshacer_importacion

// ---------------------------------------------------------------- datos (inventados)
const U = { admin: "11111111-1111-1111-1111-111111111111", miembro: "22222222-2222-2222-2222-222222222222",
            inactivo: "33333333-3333-3333-3333-333333333333", admin2: "44444444-4444-4444-4444-444444444444" };
const E = { previa: "e1000000-0000-0000-0000-000000000001", talleres: "e2000000-0000-0000-0000-000000000002",
            dup1: "e3000000-0000-0000-0000-000000000003", dup2: "e4000000-0000-0000-0000-000000000004",
            archivada: "e5000000-0000-0000-0000-000000000005" };
await db.exec(`
  insert into auth.users values ('${U.admin}'), ('${U.miembro}'), ('${U.inactivo}'), ('${U.admin2}');
  insert into public.admins (auth_user_id, nombre, email, rol, activo) values
    ('${U.admin}', 'Ana', 'a@x.invalid', 'admin', true), ('${U.miembro}', 'Mario', 'm@x.invalid', 'miembro', true),
    ('${U.inactivo}', 'Iris', 'i@x.invalid', 'admin', false), ('${U.admin2}', 'Bea', 'b@x.invalid', 'admin', true);
  insert into public.empresas (id, razon_social, cif, visto_at, archived_at) values
    ('${E.previa}', 'Panadería Previa SL', 'B-12345678', now(), null),
    ('${E.talleres}', 'Talleres Ficticios S.L.', null, now(), null),
    ('${E.dup1}', 'Duplicada SL', null, now(), null),
    ('${E.dup2}', 'Duplicada, S.L.', null, now(), null),
    ('${E.archivada}', 'Archivada SLU', 'B99999999', now(), now());
`);
const secretosVault = async () => (await uno("select count(*)::int n from vault.secrets")).n;
const nEmpresas = async () => (await uno("select count(*)::int n from public.empresas")).n;
const v0 = await secretosVault();

async function como(uid) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false);`);
  await db.exec(uid ? "set role authenticated" : "set role anon");
}
async function servicio() { await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false); set role service_role;"); }
async function sistema() { await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);"); }

// Claves inventadas con la forma de las de Holded (pat_ + 89).
const clave = (n) => "pat_" + String(n).repeat(89).slice(0, 89);
const K = [null, clave(1), clave(2), clave(3), clave(4), clave(5), clave(6), clave(7), clave(8), clave(9)];

// ---------------------------------------------------------------- 6A / 6B / 6C
console.log("6A:");
await sistema();
const RA = await tabla(parte("6A"));
console.log("   ", JSON.stringify(RA));
ok(RA["migración 20261127140000"] === "no" && RA["tablas holded_*"] === "0" && RA["funciones holded_*"] === "0", "6A: nada de Holded aún");
ok(RA["vault.create_secret"] === "1" && RA["tabla importaciones"] === "1" && RA["pg_cron"] === "1"
   && RA["tarea holded-limpiar-cargas"] === "0", "6A: Vault, importaciones y pg_cron presentes");
ok(RA["funciones base (is_admin, is_admin_role, agente_norm, set_updated_at)"] === "4", "6A: funciones base");

console.log("6B:");
await db.exec(parte("6B"));
ok(true, "6B aplicado");
await falla(() => db.exec(parte("6B")), /ya está aplicada/, "6B se niega a repetirse");

console.log("6C:");
const RC = await tabla(parte("6C"));
console.log("   ", JSON.stringify(RC));
ok(RC["tablas holded_conexiones/holded_cargas con RLS"] === "2" && RC["políticas holded_conexiones"] === "1"
   && RC["políticas holded_cargas"] === "0", "6C: tablas, RLS y políticas");
ok(RC["authenticated SELECT secreto_id / estado"] === "no/sí", "6C: authenticated no ve secreto_id");
ok(RC["authenticated INSERT/UPDATE/DELETE holded_conexiones"] === "no/no/no", "6C: authenticated no escribe conexiones");
ok(RC["authenticated SELECT holded_cargas"] === "no", "6C: authenticated no ve cargas");
ok(RC["EXECUTE authenticated holded_clave_de/previsualizar/confirmar/marcar"] === "no/no/no/no", "6C: funciones de servicio cerradas a authenticated");
ok(RC["EXECUTE service_role holded_clave_de/previsualizar/confirmar/marcar"] === "sí/sí/sí/sí", "6C: service_role las ejecuta");
ok(RC["EXECUTE anon/authenticated holded_revocar"] === "no/sí", "6C: revocar solo authenticated");
ok(RC["triggers holded_*"] === "3" && RC["tarea holded-limpiar-cargas"] === "1", "6C: triggers y tarea de limpieza");
ok(RC["secretos en Vault"] === String(v0), "6C: Vault sin cambios");
ok(/^20261127140000 /.test(RC["migración registrada"] || ""), "6C: migración registrada");

// ---------------------------------------------------------------- normalización
console.log("normalización:");
const n = async (f, v) => (await uno(`select public.${f}($1) r`, [v])).r;
ok(await n("holded_norm_nif", " es-b 123.456/78 ") === "B12345678", "NIF: ES, guiones, puntos y espacios");
ok(await n("holded_norm_nif", "  ") === null, "NIF vacío → null");
ok(await n("holded_norm_nombre", "Talleres Ficticios, S.L.U.") === "talleres ficticios", "nombre sin S.L.U., comas ni puntos");
ok(await n("holded_norm_nombre", "PANADERÍA  previa   s. l.") === "panaderia previa", "nombre sin tildes ni «s. l.»");
ok(await n("holded_norm_nombre", "Slusa SL") === "slusa", "solo quita la forma jurídica final");
ok(await n("holded_norm_nombre", "Fábrica SA") === "fabrica sa", "SA no se quita (no pedido)");

// ---------------------------------------------------------------- permisos
console.log("permisos:");
const prev = async (uid, filas) => (await uno("select public.holded_previsualizar($1, $2::jsonb) r", [uid, JSON.stringify(filas)])).r;
const conf = async (uid, carga, dec, archivo = "cuentas.json") =>
  (await uno("select public.holded_confirmar($1, $2, $3::jsonb, $4) r", [uid, carga, JSON.stringify(dec), archivo])).r;
await como(U.admin);
await falla(() => prev(U.admin, [{ fila: 1, cliente: "X", clave: K[1] }]), /42501|permission denied/, "authenticated no puede llamar a previsualizar");
await falla(() => q("select public.holded_clave_de($1)", [E.previa]), /42501|permission denied/, "authenticated no puede leer claves");
await falla(() => q("select * from public.holded_cargas"), /42501|permission denied/, "authenticated no lee cargas");
await falla(() => q("insert into public.holded_conexiones (empresa_id, secreto_id, ultimos4) values ($1, gen_random_uuid(), 'abcd')", [E.previa]),
  /42501|permission denied/, "authenticated no inserta conexiones");
await falla(() => q("select * from vault.decrypted_secrets"), /42501|permission denied/, "authenticated no ve Vault");
await como(null);
await falla(() => q("select public.holded_revocar($1)", [E.previa]), /42501|permission denied/, "anon no puede revocar");
await servicio();
await falla(() => prev(U.miembro, [{ fila: 1, cliente: "X", clave: K[1] }]), /Solo el rol admin/, "miembro no carga claves");
await falla(() => prev(U.inactivo, [{ fila: 1, cliente: "X", clave: K[1] }]), /Solo el rol admin/, "admin inactivo no carga claves");
await falla(() => prev(U.admin, []), /no tiene filas/, "archivo vacío");
await falla(() => prev(U.admin, Array.from({ length: 501 }, (_, i) => ({ fila: i + 2, cliente: "X" + i, clave: clave(i) }))), /500 filas/, "más de 500 filas");

// ---------------------------------------------------------------- vista previa
console.log("vista previa:");
const FILAS = [
  { fila: 2, cliente: "Panaderia previa", nif: "ESB12345678", subdominio: "previa", clave: K[1] },   // NIF
  { fila: 3, cliente: "TALLERES FICTICIOS SL", nif: "", clave: K[2] },                                // nombre
  { fila: 4, cliente: "Duplicada S.L.", nif: "", clave: K[3] },                                       // ambigua
  { fila: 5, cliente: "Nueva Inventada SLU", nif: " b 777 666 55 ", clave: K[4] },                    // crear
  { fila: 6, cliente: "Sin Nif Nueva", nif: "", clave: K[5] },                                        // crear, NIF pendiente
  { fila: 7, cliente: "Vieja", nif: "", clave: "a1b2c3d4e5f6a7b8c9d0e1f2" },                         // API antigua
  { fila: 8, cliente: "Repetida", nif: "", clave: K[1] },                                             // clave repetida
  { fila: 9, cliente: "nueva inventada s.l.u.", nif: "", clave: K[8] },                               // nombre repetido en el archivo
  { fila: 10, cliente: "Otra", nif: "B99999999", clave: K[9] },                                       // archivada (por NIF)
  { fila: 11, cliente: "", nif: "", clave: K[7] },                                                    // sin cliente ni NIF
];
const P = await prev(U.admin, FILAS);
const f = (n) => P.filas.find((x) => x.fila === n);
ok(K.slice(1).every((k) => !JSON.stringify(P).includes(k.slice(0, 12)) && !JSON.stringify(P).includes(k.slice(-12))), "la vista previa no devuelve ninguna clave");
ok(f(2).ultimos4 === K[1].slice(-4) && f(2).empresa_id === E.previa && f(2).via === "nif", "fila 2: por NIF (con ES y guión)");
ok(f(3).empresa_id === E.talleres && f(3).via === "nombre" && f(3).avisos.length === 0, "fila 3: por nombre normalizado");
ok(f(4).empresa_id === null && !f(4).se_puede_crear && f(4).avisos.some((a) => /Varias empresas/.test(a)), "fila 4: ambigua, sin crear");
ok(f(5).empresa_id === null && f(5).se_puede_crear && f(5).avisos.length === 0, "fila 5: se puede crear");
ok(f(6).se_puede_crear && f(6).avisos.includes("NIF pendiente"), "fila 6: crear con NIF pendiente");
ok(f(7).errores.some((e) => /pat_/.test(e)), "fila 7: clave de la API antigua → error");
ok(f(8).errores.some((e) => /repetida/.test(e)), "fila 8: clave repetida → error");
ok(!f(9).se_puede_crear && f(9).avisos.some((a) => /mismo nombre/.test(a)), "fila 9: nombre repetido en el archivo, sin crear");
ok(f(10).empresa_id === E.archivada && f(10).avisos.includes("La empresa está archivada"), "fila 10: archivada, con aviso");
ok(f(11).errores.some((e) => /cliente y el NIF/.test(e)), "fila 11: sin cliente ni NIF → error");
ok(f(2).conexion_existente === null, "sin conexión previa");
await sistema();
ok(await secretosVault() === v0 + 7, "7 claves válidas en Vault (provisionales)");
ok((await uno("select count(*)::int n from holded_cargas where carga = $1", [P.carga])).n === 7, "7 cargas");

// ---------------------------------------------------------------- confirmar
console.log("confirmar:");
await servicio();
await falla(() => conf(U.miembro, P.carga, []), /Solo el rol admin/, "miembro no confirma");
await falla(() => conf(U.admin2, P.carga, []), /caducado o no existe/, "otro admin no confirma una carga ajena");
await falla(() => conf(U.admin, P.carga, [{ fila: 99, accion: "omitir" }]), /no están en la vista previa/, "fila inexistente");
const e0 = await nEmpresas();
const DEC = [
  { fila: 2, accion: "conectar", empresa_id: E.previa }, { fila: 3, accion: "conectar", empresa_id: E.talleres },
  { fila: 4, accion: "conectar", empresa_id: E.dup1 }, { fila: 5, accion: "crear" }, { fila: 6, accion: "crear" },
  { fila: 9, accion: "omitir" }, { fila: 10, accion: "omitir" },
];
await falla(() => conf(U.admin, P.carga, [...DEC.slice(0, 3), { fila: 5, accion: "conectar", empresa_id: E.dup1 }]),
  /misma empresa/, "dos filas a la misma empresa → nada");
await falla(() => conf(U.admin, P.carga, [{ fila: 9, accion: "crear" }, { fila: 5, accion: "crear" }]),
  /mismo nombre/, "dos filas crean el mismo nombre → nada");
await falla(() => conf(U.admin, P.carga, [{ fila: 4, accion: "crear" }]), /ya existe una empresa con ese nombre/, "crear un nombre que ya existe → nada");
await falla(() => conf(U.admin, P.carga, [{ fila: 2, accion: "borrar" }]), /no válida/, "acción desconocida");
await sistema();
ok(await nEmpresas() === e0 && (await uno("select count(*)::int n from holded_conexiones")).n === 0
   && await secretosVault() === v0 + 7, "los rechazos no escriben nada");
await servicio();
const R = await conf(U.admin, P.carga, DEC);
const rf = (n) => R.filas.find((x) => x.fila === n);
ok(rf(2).resultado === "conectada" && rf(3).resultado === "conectada" && rf(4).resultado === "conectada", "3 conectadas");
ok(rf(5).resultado === "creada" && !rf(5).nif_pendiente && rf(6).resultado === "creada" && rf(6).nif_pendiente, "2 creadas (una con NIF pendiente)");
ok(rf(9).resultado === "omitida" && rf(10).resultado === "omitida", "2 omitidas");
ok(R.verificar.length === 5 && R.lote, "5 para verificar y un lote");
await sistema();
ok(await nEmpresas() === e0 + 2, "2 empresas nuevas");
const nuevas = await q("select razon_social, cif, visto_at is not null visto, importacion_id from empresas where importacion_id = $1 order by razon_social", [R.lote]);
ok(nuevas.length === 2 && nuevas.every((x) => x.visto), "entran como vistas y con el lote");
ok(nuevas.find((x) => x.razon_social === "Nueva Inventada SLU").cif === "B77766655", "NIF en mayúsculas y sin espacios");
ok(nuevas.find((x) => x.razon_social === "Sin Nif Nueva").cif === null, "sin NIF → cif null");
const lote = await uno("select archivo, filas, resumen, created_by from importaciones where id = $1", [R.lote]);
ok(lote.archivo === "Holded: cuentas.json" && lote.filas === 2 && lote.resumen.origen === "holded"
   && lote.resumen.empresas_nuevas === 2 && lote.created_by === U.admin, "lote en importaciones");
ok((await uno("select count(*)::int n from contactos where importacion_id = $1", [R.lote])).n === 0
   && (await uno("select count(*)::int n from deals where importacion_id = $1", [R.lote])).n === 0, "sin contactos ni negocios");
ok((await uno("select count(*)::int n from holded_conexiones where estado = 'pendiente'")).n === 5, "5 conexiones pendientes");
ok((await uno("select count(*)::int n from holded_cargas")).n === 0, "la carga se borra");
ok(await secretosVault() === v0 + 5, "Vault: solo quedan las 5 claves conectadas");
await servicio();
ok((await uno("select public.holded_clave_de($1) k", [E.previa])).k === K[1], "service_role lee la clave de la conexión");
await falla(() => conf(U.admin, P.carga, DEC), /caducado o no existe/, "la carga no se puede confirmar dos veces");

// ---------------------------------------------------------------- lectura desde el CRM
console.log("CRM:");
await como(U.miembro);
const vis = await q("select empresa_id, estado, ultimos4, permisos from holded_conexiones");
ok(vis.length === 5, "un miembro ve el estado (is_admin)");
await falla(() => q("select secreto_id from holded_conexiones"), /permission denied/, "nadie ve secreto_id");
await falla(() => q("select * from holded_conexiones"), /permission denied/, "select * tampoco");
await falla(() => q("update holded_conexiones set estado = 'ok'"), /permission denied/, "no se puede marcar a mano");
await como(null);
await falla(() => q("select estado from holded_conexiones"), /permission denied/, "anon no ve nada");

// ---------------------------------------------------------------- reemplazar
console.log("reemplazar:");
await servicio();
const P2 = await prev(U.admin, [{ fila: 2, cliente: "Panadería Previa", nif: "B12345678", clave: K[6] }]);
ok(P2.filas[0].conexion_existente && P2.filas[0].conexion_existente.ultimos4 === K[1].slice(-4), "avisa de la conexión existente");
await falla(() => conf(U.admin, P2.carga, [{ fila: 2, accion: "conectar", empresa_id: E.previa }]), /ya tiene Holded/, "sin reemplazar → nada");
const vAntes = await (async () => { await sistema(); const x = await secretosVault(); await servicio(); return x; })();
const R2 = await conf(U.admin, P2.carga, [{ fila: 2, accion: "conectar", empresa_id: E.previa, reemplazar: true }]);
ok(R2.filas[0].resultado === "reemplazada" && R2.lote === null, "reemplazada, sin lote");
ok((await uno("select public.holded_clave_de($1) k", [E.previa])).k === K[6], "la nueva clave sustituye a la anterior");
await sistema();
ok(await secretosVault() === vAntes - 1, "la clave anterior se borra de Vault (la nueva pasa de la carga a la conexión)");
ok((await uno("select count(*)::int n from vault.secrets where secret = $1", [K[1]])).n === 0, "la clave anterior ya no existe");

// ---------------------------------------------------------------- verificación
console.log("verificación:");
await servicio();
await falla(() => q("select * from public.holded_para_verificar($1, $2)", [U.miembro, [E.previa]]), /Solo el rol admin/, "miembro no verifica");
await falla(() => q("select * from public.holded_para_verificar($1, $2::uuid[])", [U.admin, Array(11).fill(E.previa)]), /10 empresas/, "como mucho 10");
const pv = await q("select * from public.holded_para_verificar($1, $2::uuid[])", [U.admin, [E.previa, E.dup2]]);
ok(pv.length === 1 && pv[0].holded_para_verificar === E.previa, "solo las que tienen conexión");
await q("select public.holded_marcar_verificacion($1, 'ok', null, $2::jsonb, 'ESB-12345678', $3::jsonb)",
  [E.previa, JSON.stringify({ facturas: true, compras: false }), JSON.stringify({ periodo: "2026-11", usadas: 14, limite: 2000 })]);
await q("select public.holded_marcar_verificacion($1, 'error', $2, '{}'::jsonb, 'B00000000', null)", [E.talleres, "x".repeat(400)]);
await falla(() => q("select public.holded_marcar_verificacion($1, 'pendiente', null, null, null, null)", [E.previa]), /no válido/, "estado no válido");
await sistema();
const v1 = await uno("select estado, ultimo_error, permisos, nif_coincide, uso_holded, verificada_at from holded_conexiones where empresa_id = $1", [E.previa]);
ok(v1.estado === "ok" && v1.ultimo_error === null && v1.permisos.compras === false && v1.nif_coincide === true
   && v1.uso_holded.limite === 2000 && v1.verificada_at, "ok con permisos, NIF coincide y uso");
const v2 = await uno("select estado, length(ultimo_error) l, nif_coincide from holded_conexiones where empresa_id = $1", [E.talleres]);
ok(v2.estado === "error" && v2.l === 300 && v2.nif_coincide === null, "error recortado; sin CIF en el CRM → nif_coincide null");

// ---------------------------------------------------------------- revocar
console.log("revocar:");
await como(U.miembro);
await falla(() => q("select public.holded_revocar($1)", [E.previa]), /Solo el rol admin/, "miembro no revoca");
await como(U.admin);
const vr = await (async () => { await sistema(); const x = await secretosVault(); await como(U.admin); return x; })();
ok((await uno("select public.holded_revocar($1) r", [E.previa])).r.revocada === true, "admin revoca");
ok((await uno("select public.holded_revocar($1) r", [E.previa])).r.revocada === false, "revocar dos veces no falla");
await sistema();
ok(await secretosVault() === vr - 1 && (await uno("select count(*)::int n from vault.secrets where secret = $1", [K[6]])).n === 0,
  "revocar borra la clave de Vault");

// ---------------------------------------------------------------- borrar empresa / deshacer lote
console.log("borrado y deshacer:");
await db.exec(`delete from public.empresas where id = '${E.talleres}'`);
ok((await uno("select count(*)::int n from vault.secrets where secret = $1", [K[2]])).n === 0, "borrar la empresa borra su clave");
await como(U.admin);
const D = (await uno("select public.admin_deshacer_importacion($1) r", [R.lote])).r;
await sistema();
ok((await uno("select count(*)::int n from empresas where importacion_id = $1", [R.lote])).n === 0, "deshacer el lote borra las empresas creadas");
ok((await uno("select count(*)::int n from vault.secrets where secret in ($1, $2)", [K[4], K[5]])).n === 0, "… y sus claves de Vault");
ok((await uno("select count(*)::int n from holded_conexiones")).n === 1 && await secretosVault() === v0 + 1, "queda solo la conexión de Duplicada SL");
ok(D && typeof D === "object", "deshacer devuelve resumen");

// ---------------------------------------------------------------- caducidad
console.log("caducidad:");
await servicio();
const P3 = await prev(U.admin, [{ fila: 2, cliente: "Caduca SL", clave: clave("c") }]);
await sistema();
ok(await secretosVault() === v0 + 2, "carga provisional en Vault");
await db.exec(`update holded_cargas set expira_at = now() - interval '1 minute' where carga = '${P3.carga}'`);
await servicio();
await falla(() => conf(U.admin, P3.carga, [{ fila: 2, accion: "crear" }]), /caducado/, "carga caducada no se confirma");
await sistema();
ok((await uno("select public.holded_limpiar_cargas() n")).n === 1, "la limpieza borra la carga caducada");
ok(await secretosVault() === v0 + 1, "… y su clave de Vault");
await servicio();
const P4 = await prev(U.admin, [{ fila: 2, cliente: "Caduca Dos SL", clave: clave("d") }]);
await sistema();
await db.exec(`update holded_cargas set expira_at = now() - interval '1 minute' where carga = '${P4.carga}'`);
await servicio();
await prev(U.admin, [{ fila: 2, cliente: "Nueva carga", clave: clave("e") }]);
await sistema();
ok((await uno("select count(*)::int n from holded_cargas where carga = $1", [P4.carga])).n === 0, "cada vista previa limpia las caducadas");

console.log(`\n${total - fallos}/${total} comprobaciones correctas`);
process.exit(fallos ? 1 : 0);
