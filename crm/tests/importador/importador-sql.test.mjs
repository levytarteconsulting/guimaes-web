// Prueba de crm/supabase-importador.sql en PGlite: estructura real de
// producción (esquema-base.sql, sin datos) + stubs de Supabase + datos
// inventados. Uso (desde crm/tests/importador): npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import { construirFilas, leerXlsx, mapeoInicial } from "../../importador-util.js";
import { CAT } from "./importador-util.test.mjs";

const dir = new URL(".", import.meta.url).pathname;
const mig = fs.readFileSync(new URL("../../supabase-importador.sql", import.meta.url), "utf8");
const base = fs.readFileSync(dir + "esquema-base.sql", "utf8");

function parte(id) {
  const re = new RegExp(`-- ${id} [\\s\\S]*?(?=\\n-- =+\\n-- 4[A-Z] |$)`);
  const m = mig.match(re); if (!m) throw new Error("sin parte " + id);
  return m[0];
}

const db = new PGlite();
let fallos = 0, total = 0;
const ok = (c, msg) => { total++; console.log((c ? "  ok   " : "  FALLO ") + msg); if (!c) fallos++; };
const q = async (s, p) => (await db.query(s, p)).rows;
const uno = async (s, p) => (await q(s, p))[0];
const tabla = async (sql) => Object.fromEntries((await db.exec(sql)).at(-1).rows.map(r => [r.comprobacion, r.valor]));

await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
`);
await db.exec(base);
await db.exec(`
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);
console.log(`esquema base: ${(await uno("select count(*)::int n from pg_policies")).n} políticas, ` +
            `${(await uno("select count(*)::int n from pg_trigger where not tgisinternal")).n} triggers`);

// ---------------------------------------------------------------- datos previos (inventados)
const U = { admin: "11111111-1111-1111-1111-111111111111", miembro: "22222222-2222-2222-2222-222222222222",
            inactivo: "33333333-3333-3333-3333-333333333333" };
const A = { ana: "aa000000-0000-0000-0000-000000000001", mario: "aa000000-0000-0000-0000-000000000002",
            iris: "aa000000-0000-0000-0000-000000000003" };
const E1 = "e1000000-0000-0000-0000-000000000001";
const C1 = "c1000000-0000-0000-0000-000000000001", C3 = "c3000000-0000-0000-0000-000000000003";
await db.exec(`
  insert into auth.users values ('${U.admin}'), ('${U.miembro}'), ('${U.inactivo}');
  insert into public.admins (id, auth_user_id, nombre, email, rol, activo) values
    ('${A.ana}', '${U.admin}', 'Ana', 'a@x.invalid', 'admin', true),
    ('${A.mario}', '${U.miembro}', 'Mario', 'm@x.invalid', 'miembro', true),
    ('${A.iris}', '${U.inactivo}', 'Iris', 'i@x.invalid', 'admin', false);
  insert into public.empresas (id, razon_social, cif, visto_at) values ('${E1}', 'Panadería Previa SL', 'B-12345678', now());
  insert into public.contactos (id, full_name, email, lifecycle, visto_at) values
    ('${C1}', 'José Previo', 'Jose@Previo.invalid', 'active_client', now());
  insert into public.contactos (id, full_name, phone, lifecycle, visto_at) values
    ('${C3}', null, '+34 600 111 222', 'new', now());
  insert into public.contacto_empresa (contact_id, empresa_id, principal) values ('${C1}', '${E1}', true);
  insert into public.deals (title, contact_id, empresa_id, service, stage) values ('Contable previo', '${C1}', '${E1}', 's3', 'cliente_activo');
`);
const cuenta = async () => uno(`select (select count(*) from empresas)::int e, (select count(*) from contactos)::int c,
  (select count(*) from deals)::int d, (select count(*) from contacto_empresa)::int v, (select count(*) from carpetas)::int k`);
const antes = await cuenta();

// ---------------------------------------------------------------- 4A
console.log("4A:");
const RA = await tabla(parte("4A"));
console.log("   ", JSON.stringify(RA));
ok(RA["migración 20261127100000"] === "no" && RA["tablas importaciones/importacion_rellenos"] === "0"
   && RA["columnas importacion_id"] === "0" && RA["columna empresas.empleados"] === "no"
   && RA["funciones admin_importar/deshacer"] === "0", "4A: nada del importador existe aún");
ok(RA["funciones base"] === "6", "4A: funciones base presentes");

// ---------------------------------------------------------------- 4B
console.log("4B:");
await db.exec(parte("4B"));
ok(true, "4B aplicado");
try { await db.exec(parte("4B")); ok(false, "4B dos veces debería fallar"); }
catch (e) { ok(/ya está aplicada/.test(e.message), "4B se niega a repetirse"); }

// ---------------------------------------------------------------- 4C
console.log("4C:");
const RC = await tabla(parte("4C"));
console.log("   ", JSON.stringify(RC));
ok(RC["tablas importaciones/importacion_rellenos"] === "2" && RC["RLS activada"] === "2"
   && RC["políticas importaciones"] === "1" && RC["filas importaciones"] === "0", "4C: tablas, RLS, políticas");
ok(RC["columnas importacion_id"] === "4" && RC["columna empresas.empleados"] === "sí", "4C: columnas");
ok(RC["funciones admin_importar/deshacer (definer)"] === "2" && RC["funciones con EXECUTE para anon"] === "0"
   && RC["funciones con EXECUTE para authenticated"] === "2", "4C: funciones y privilegios");
ok(RC["agente_ficha_empresa con empleados"] === "sí", "4C: agente con empleados");
ok(RC["filas empresas"] === String(antes.e) && RC["filas contactos"] === String(antes.c)
   && RC["filas deals"] === String(antes.d) && RC["filas contacto_empresa"] === String(antes.v), "4C: recuentos sin cambios");
ok(/^20261127100000 /.test(RC["migración registrada"] || ""), "4C: migración registrada");

// ---------------------------------------------------------------- helpers de sesión
async function como(uid) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false);`);
  await db.exec(uid ? "set role authenticated" : "set role anon");
}
async function sistema() { await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);"); }
async function importar(filas, simular, archivo = "prueba.xlsx") {
  return (await uno("select public.admin_importar_clientes($1, $2::jsonb, $3) r", [archivo, JSON.stringify(filas), simular])).r;
}
async function deshacer(id) { return (await uno("select public.admin_deshacer_importacion($1) r", [id])).r; }
async function falla(fn, re, msg) {
  try { await fn(); ok(false, msg + " (no falló)"); }
  catch (e) { ok(re.test(e.code || "") || re.test(e.message), msg + ` [${e.code} ${e.message.slice(0, 80)}]`); }
}

// Lote de prueba (filas = número de fila del Excel). Datos inventados.
const LOTE = [
  { fila: 2, empresa: { nombre: "Panadería Previa SL", cif: "b 12345678", direccion: "Calle Inventada 1", empleados: "12" },
    contacto: { nombre: "José Previo", email: "jose@previo.invalid", telefono: "", etapa: "opportunity", owner: A.ana },
    negocio: { servicio: "s3", etapa: "propuesta", importe: "650", frecuencia: "mensual", owner: A.ana, prioridad: "high" } },
  { fila: 3, empresa: { nombre: "Talleres Ficticios SL", cif: "B11111111", direccion: "Av. Falsa 2", empleados: "5" },
    contacto: { nombre: "Laura Prueba", email: "LAURA@ejemplo.invalid", telefono: "600222333.0", etapa: "new", owner: A.mario },
    negocio: { servicio: "s1", etapa: "cliente_activo", importe: "0", frecuencia: "", owner: A.mario, prioridad: "" } },
  { fila: 4, empresa: { nombre: "Talleres Ficticios S.L.", cif: "B-11111111", direccion: "", empleados: "" },
    contacto: { nombre: "Óscar Demo", email: "", telefono: "611 444 555", etapa: "", owner: "" },
    negocio: { servicio: "s1", etapa: "reunion", importe: "100", frecuencia: "puntual", owner: "", prioridad: "low" } },
  { fila: 5, empresa: { nombre: "Talleres Ficticios SL", cif: "B11111111" },
    contacto: null,
    negocio: { servicio: "s2", etapa: "propuesta", importe: "3200.50", frecuencia: "anual", owner: A.ana, prioridad: "medium" } },
  { fila: 6, empresa: { nombre: "Consultora Imaginaria SA", cif: "A22222222", empleados: "40" },
    contacto: { nombre: "Laura Prueba", email: "laura@ejemplo.invalid", telefono: "", etapa: "", owner: "" },
    negocio: null },
  { fila: 7, empresa: { nombre: "Sin Cif Inventada SL", cif: "" },
    contacto: { nombre: "Pedro Ejemplo" }, negocio: { servicio: "s5", etapa: "contactado", importe: "", frecuencia: "trimestral" } },
  { fila: 8, empresa: { nombre: "sin cif inventada sl", cif: "" },
    contacto: { nombre: "pedro ejemplo" }, negocio: null },
  { fila: 9, empresa: { nombre: "Consultora Imaginaria SA", cif: "A22222222" },
    contacto: { nombre: "", email: "", telefono: "600111222.0" }, negocio: null },
];

// ---------------------------------------------------------------- permisos
console.log("permisos:");
await como(U.miembro);
await falla(() => importar(LOTE, true), /42501/, "miembro no puede importar");
await como(U.inactivo);
await falla(() => importar(LOTE, true), /42501/, "admin inactivo no puede importar");
await como(null);
await falla(() => importar(LOTE, true), /42501|permission denied/, "anon no tiene EXECUTE");
await como(U.miembro);
ok((await q("select * from importaciones")).length === 0, "miembro no ve importaciones");

// ---------------------------------------------------------------- simulación
console.log("simulación:");
await como(U.admin);
const sim = await importar(LOTE, true);
const R = sim.resumen;
console.log("   ", JSON.stringify(R));
ok(sim.simulado === true && sim.bloqueado === false && !sim.importacion_id, "simulación: marcada, sin id de lote");
ok(R.empresas_nuevas === 3 && R.empresas_existentes === 1, "simulación: 3 empresas nuevas, 1 existente (CIF con guion)");
ok(R.contactos_nuevos === 3 && R.contactos_existentes === 2, "simulación: 3 contactos nuevos (Laura, Óscar, Pedro), 2 existentes (José por email, C3 por teléfono)");
ok(R.negocios_nuevos === 3 && R.negocios_omitidos === 2, "simulación: 3 negocios (s1, s2, s5), 2 omitidos (s3 ya existe, s1 repetido)");
ok(R.campos_rellenados === 3, "simulación: 3 huecos (dirección y empleados de E1, responsable de José)");
const porFila = Object.fromEntries(sim.filas.map(f => [f.fila, f]));
ok(porFila[2].empresa === "ya existe" && porFila[2].contacto === "ya existe" && porFila[2].negocio === "omitido", "fila 2: existente, negocio omitido");
ok(porFila[2].avisos.some(a => /ya tiene un negocio/.test(a)), "fila 2: aviso de negocio ya existente");
ok(porFila[2].avisos.some(a => /otra etapa/.test(a)), "fila 2: aviso de etapa distinta del contacto");
ok(porFila[4].empresa === "misma que la fila 3" && porFila[4].negocio === "omitido"
   && porFila[4].avisos.some(a => /fila 3/.test(a)), "fila 4: mismo CIF que la 3; negocio s1 repetido");
ok(porFila[6].contacto === "repetido en el archivo", "fila 6: Laura (mismo email, otra mayúscula) es el mismo contacto");
ok(porFila[7].avisos.some(a => /Sin CIF/.test(a)), "fila 7: aviso sin CIF");
ok(porFila[8].empresa === "misma que la fila 7" && porFila[8].contacto === "repetido en el archivo", "fila 8: mismo nombre de empresa y de contacto");
ok(porFila[9].contacto === "ya existe" && porFila[9].contacto_id === C3, "fila 9: teléfono con .0 casa con el contacto existente");
const tras = await cuenta();
ok(JSON.stringify(tras) === JSON.stringify(antes), "simulación: no deja nada escrito (ni carpetas)");
await sistema();
ok((await uno("select count(*)::int n from importaciones")).n === 0, "simulación: no deja lote");

// ---------------------------------------------------------------- errores bloqueantes
console.log("errores:");
await como(U.admin);
const malos = [
  ...LOTE.slice(0, 2),
  { fila: 10, empresa: { nombre: "Mala SL", cif: "B99999999", empleados: "muchos" },
    contacto: { nombre: "X", email: "no-es-un-email" }, negocio: { servicio: "s99", etapa: "inventada", frecuencia: "semanal", prioridad: "urgente", owner: A.iris } },
  { fila: 11, empresa: { nombre: "" }, contacto: null, negocio: { importe: "12,5" } },
];
const rm = await importar(malos, false);
const f10 = rm.filas.find(f => f.fila === 10), f11 = rm.filas.find(f => f.fila === 11);
ok(rm.bloqueado === true && rm.simulado === true, "con errores no importa aunque simular = false");
ok(f10.errores.length === 7, `fila 10: 7 errores (${f10.errores.join(" | ")})`);
ok(f11.errores.some(e => /nombre de la empresa/.test(e)) && f11.errores.some(e => /Importe/.test(e))
   && f11.errores.some(e => /servicio/.test(e)), "fila 11: sin empresa, importe y servicio");
ok(JSON.stringify(await cuenta()) === JSON.stringify(antes), "con errores: nada escrito");

// ---------------------------------------------------------------- importar de verdad
console.log("importar:");
const imp = await importar(LOTE, false, "lote1.xlsx");
const L1 = imp.importacion_id;
ok(imp.simulado === false && L1, "importación real con id de lote");
ok(JSON.stringify(imp.resumen) === JSON.stringify(R), "el resumen real coincide con la vista previa");
const desp = await cuenta();
ok(desp.e === antes.e + 3 && desp.c === antes.c + 3 && desp.d === antes.d + 3, "3 empresas, 3 contactos, 3 negocios más");
ok(desp.k === antes.k + 3 * 5, "carpetas por defecto sembradas (5 por empresa)");
const marcas = await uno(`select
  (select count(*) from empresas where importacion_id = $1 and visto_at is null)::int e_sin_ver,
  (select count(*) from contactos where importacion_id = $1 and visto_at is null)::int c_sin_ver,
  (select count(*) from empresas where importacion_id = $1)::int e,
  (select count(*) from contactos where importacion_id = $1)::int c,
  (select count(*) from deals where importacion_id = $1)::int d,
  (select count(*) from contacto_empresa where importacion_id = $1)::int v`, [L1]);
ok(marcas.e_sin_ver === 0 && marcas.c_sin_ver === 0, "todo entra como visto (visto_at)");
ok(marcas.e === 3 && marcas.c === 3 && marcas.d === 3, "importacion_id en lo creado");
ok(marcas.v === 5, `vínculos del lote: Laura×2, Óscar, Pedro, C3 (${marcas.v})`);
const t3 = await uno("select e.razon_social, e.cif, e.empleados, e.address from empresas e where cif = 'B11111111'");
ok(t3.empleados === 5 && t3.address === "Av. Falsa 2", "empresa nueva con empleados y dirección");
const dS1 = await uno("select title, amount, frequency, priority, owner, stage, contact_id from deals where service = 's1'");
ok(dS1.title === "CFO Externo — Talleres Ficticios SL", "título 'Servicio — Empresa'");
ok(dS1.amount === null && dS1.frequency === null && dS1.priority === null, "importe 0 → nulo; frecuencia vacía → nula");
ok(dS1.owner === A.mario && dS1.stage === "cliente_activo", "responsable y etapa");
const dS2 = await uno("select amount::text a, frequency, contact_id from deals where service = 's2'");
ok(dS2.a === "3200.50" && dS2.frequency === "anual" && dS2.contact_id === null, "negocio sin contacto, importe decimal, anual");
const laura = await uno("select id, email, phone, owner, lifecycle, source from contactos where email = 'laura@ejemplo.invalid'");
ok(laura && laura.phone === "600222333" && laura.owner === A.mario && laura.lifecycle === "new" && laura.source === "Importación",
   "contacto nuevo: email en minúsculas, teléfono sin .0, responsable");
const lauraEmp = await q("select principal from contacto_empresa where contact_id = $1 order by principal desc", [laura.id]);
ok(lauraEmp.length === 2 && lauraEmp[0].principal && !lauraEmp[1].principal, "Laura enlazada a 2 empresas, 1 principal");
const oscar = await uno("select phone, lifecycle, owner from contactos where full_name = 'Óscar Demo'");
ok(oscar.phone === "611444555" && oscar.lifecycle === "new" && oscar.owner === null, "contacto sin etapa → 'new'");
const e1 = await uno("select address, empleados, razon_social from empresas where id = $1", [E1]);
ok(e1.address === "Calle Inventada 1" && e1.empleados === 12 && e1.razon_social === "Panadería Previa SL", "empresa existente: solo se rellenan huecos");
const c1 = await uno("select lifecycle, full_name from contactos where id = $1", [C1]);
ok(c1.lifecycle === "active_client", "contacto existente: no se sobrescribe la etapa");
const c3 = await uno("select full_name, owner from contactos where id = $1", [C3]);
ok(c3.full_name === null, "contacto por teléfono sin nombre en la fila: sigue sin nombre");
ok((await uno("select count(*)::int n from contacto_empresa where contact_id = $1", [C3])).n === 1, "C3 enlazado a Consultora (principal)");
const company = await uno("select company from contactos where id = $1", [laura.id]);
ok(company.company === "Talleres Ficticios SL", "contactos.company sincronizado por trigger");
ok((await uno("select count(*)::int n from leads")).n === 0 && (await uno("select count(*)::int n from tareas")).n === 0,
   "no escribe en leads ni en tareas (sin avisos)");
const lote = await uno("select archivo, filas, created_by, resumen->>'empresas_nuevas' en from importaciones where id = $1", [L1]);
ok(lote.archivo === "lote1.xlsx" && lote.filas === 8 && lote.created_by === U.admin && lote.en === "3", "lote registrado");

// ---------------------------------------------------------------- agente
console.log("agente:");
const bus = (await uno("select public.agente_buscar('talleres ficticios') r")).r;
ok(bus.resultados.some(x => x.tipo === "empresa" && x.titulo === "Talleres Ficticios SL"), "agente_buscar encuentra la empresa");
ok(bus.resultados.some(x => x.tipo === "deal" && /CFO Externo — Talleres/.test(x.titulo)), "agente_buscar encuentra el negocio");
const busC = (await uno("select public.agente_buscar('laura@ejemplo') r")).r;
ok(busC.resultados.some(x => x.tipo === "contacto" && x.id === laura.id), "agente_buscar encuentra el contacto por email");
const busT = (await uno("select public.agente_buscar('611444555') r")).r;
ok(busT.resultados.some(x => x.tipo === "contacto" && x.titulo === "Óscar Demo"), "agente_buscar encuentra por teléfono");
const empId = (await uno("select id from empresas where cif = 'B11111111'")).id;
const fe = (await uno("select public.agente_ficha_empresa($1) r", [empId])).r;
ok(fe.encontrada && fe.empresa.empleados === 5 && fe.empresa.cif === "B11111111" && fe.empresa.direccion === "Av. Falsa 2", "ficha empresa: datos y empleados");
ok(fe.total_contactos === 2 && fe.total_deals === 2, "ficha empresa: 2 contactos y 2 negocios");
ok(fe.deals.some(d => d.servicio === "s2" && d.frecuencia === "anual" && d.owner === A.ana && d.prioridad === "medium"), "ficha empresa: negocio completo");
const fc = (await uno("select public.agente_ficha_contacto($1) r", [laura.id])).r;
ok(fc.encontrado && fc.contacto.email === "laura@ejemplo.invalid" && fc.contacto.ciclo_vida === "new", "ficha contacto: datos");
ok(fc.empresas.length === 2 && fc.deals.length === 1 && fc.deals[0].servicio === "s1", "ficha contacto: 2 empresas y su negocio");
await como(U.miembro);
const feM = (await uno("select public.agente_ficha_empresa($1) r", [empId])).r;
ok(feM.encontrada, "un miembro también ve lo importado con el agente");

// ---------------------------------------------------------------- reimportar el mismo archivo
console.log("reimportar:");
await como(U.admin);
const re = await importar(LOTE, true);
ok(re.resumen.empresas_nuevas === 0 && re.resumen.contactos_nuevos === 0 && re.resumen.negocios_nuevos === 0
   && re.resumen.negocios_omitidos === 5, "el mismo archivo otra vez: nada nuevo, 5 negocios omitidos");

// ---------------------------------------------------------------- deshacer
console.log("deshacer:");
await como(U.miembro);
await falla(() => deshacer(L1), /42501/, "miembro no puede deshacer");
await como(U.admin);
await sistema();
await db.exec(`insert into notas (body, author, contact_id) values ('nota', 'Ana', '${laura.id}')`);
await como(U.admin);
await falla(() => deshacer(L1), /GU020/, "con una nota posterior no se deshace");
await sistema();
await db.exec(`delete from notas`);
await db.exec(`update empresas set city = 'Otra' where id = '${empId}'`);
await como(U.admin);
await falla(() => deshacer(L1), /GU020/, "con una empresa editada después no se deshace");
await sistema();
await db.exec(`set session_replication_role = replica;
               update empresas set city = null, updated_at = created_at where id = '${empId}';
               set session_replication_role = origin;`);
await db.exec(`insert into contacto_empresa (contact_id, empresa_id) values ('${laura.id}', '${E1}')`);
await como(U.admin);
await falla(() => deshacer(L1), /GU020/, "con un vínculo añadido después no se deshace");
await sistema();
await db.exec(`delete from contacto_empresa where contact_id = '${laura.id}' and empresa_id = '${E1}';
               set session_replication_role = replica;
               update contactos set updated_at = created_at where id = '${laura.id}';
               update empresas set updated_at = created_at where id = '${E1}';
               set session_replication_role = origin;`);
ok(JSON.stringify(await cuenta()) === JSON.stringify(desp), "estado de vuelta al de tras importar");
await como(U.admin);
const dh = await deshacer(L1);
console.log("   ", JSON.stringify(dh));
ok(dh.negocios_borrados === 3 && dh.contactos_borrados === 3 && dh.empresas_borradas === 3 && dh.vinculos_borrados === 5
   && dh.campos_revertidos === 3, "deshacer borra lo creado y revierte los huecos");
ok(JSON.stringify(await cuenta()) === JSON.stringify(antes), "tras deshacer: mismos recuentos que antes (carpetas incluidas)");
const e1b = await uno("select address, empleados from empresas where id = $1", [E1]);
ok(e1b.address === null && e1b.empleados === null, "huecos rellenados vuelven a vacío");
ok((await uno("select count(*)::int n from deals where id is not null and title = 'Contable previo'")).n === 1, "lo previo sigue");
ok((await uno("select deshecha_at is not null and deshecha_by = $2 x from importaciones where id = $1", [L1, U.admin])).x, "lote marcado como deshecho");
await falla(() => deshacer(L1), /GU011/, "no se deshace dos veces");

// ---------------------------------------------------------------- atomicidad
console.log("atomicidad:");
await sistema();
await db.exec(`create function public.t_falla() returns trigger language plpgsql as $$
  begin if new.service = 's2' then raise exception 'fallo simulado'; end if; return new; end $$;
  create trigger t_falla before insert on public.deals for each row execute function public.t_falla();`);
await como(U.admin);
await falla(() => importar(LOTE, false), /fallo simulado/, "un fallo a mitad aborta la llamada");
ok(JSON.stringify(await cuenta()) === JSON.stringify(antes), "y no deja nada a medias");
await sistema();
ok((await uno("select count(*)::int n from importaciones where deshecha_at is null")).n === 0, "ni lote");
await db.exec("drop trigger t_falla on public.deals; drop function public.t_falla()");

// ---------------------------------------------------------------- un lote posterior bloquea deshacer el anterior
console.log("lotes encadenados:");
await como(U.admin);
const la = await importar([LOTE[1]], false);
const lb = await importar([{ fila: 2, empresa: { nombre: "Talleres Ficticios SL", cif: "B11111111" },
  contacto: null, negocio: { servicio: "s6", etapa: "reunion" } }], false);
ok(lb.resumen.empresas_existentes === 1 && lb.resumen.negocios_nuevos === 1, "segundo lote reutiliza la empresa del primero");
await falla(() => deshacer(la.importacion_id), /GU020/, "el primer lote no se deshace si otro añadió negocios");
ok((await deshacer(lb.importacion_id)).negocios_borrados === 1, "el segundo sí");
ok((await deshacer(la.importacion_id)).empresas_borradas === 1, "y después el primero");
ok(JSON.stringify(await cuenta()) === JSON.stringify(antes), "todo como al principio");

// ---------------------------------------------------------------- sin CIF y nombre ambiguo
console.log("sin CIF:");
await sistema();
await db.exec(`insert into empresas (razon_social, visto_at) values ('Repetida Inventada SL', now()), ('repetida inventada sl', now())`);
await como(U.admin);
const amb = await importar([{ fila: 2, empresa: { nombre: "Repetida Inventada SL" }, contacto: null, negocio: null }], true);
ok(amb.bloqueado && /añade el CIF/.test(amb.filas[0].errores[0] || ""), "sin CIF con 2 empresas del mismo nombre: error");

// ---------------------------------------------------------------- de punta a punta con el Excel de ejemplo
console.log("Excel de ejemplo:");
{
  const buf = fs.readFileSync(dir + "ejemplo-clientes.xlsx");
  const filas = await leerXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const cat = { ...CAT, admins: [{ id: A.ana, name: "Ana", activo: true }, { id: A.mario, name: "Mario", activo: true }] };
  const loc = construirFilas(filas, mapeoInicial(filas[0]), cat);
  const conError = loc.filter((x) => x.errores.length).map((x) => x.fila);
  ok(JSON.stringify(conError) === "[11]", `solo la fila 11 tiene errores locales (${conError})`);
  const datos = loc.filter((x) => x.datos).map((x) => x.datos);
  await como(U.admin);
  const s = await importar(datos, true, "ejemplo-clientes.xlsx");
  console.log("   ", JSON.stringify(s.resumen));
  ok(!s.bloqueado, "vista previa sin errores en la base");
  ok(s.resumen.empresas_nuevas === 6 && s.resumen.empresas_existentes === 0, "6 empresas nuevas");
  ok(s.resumen.contactos_nuevos === 5 && s.resumen.contactos_existentes === 0, "5 contactos nuevos (Laura, Óscar, Pedro, Marta, Rich)");
  ok(s.resumen.negocios_nuevos === 7 && s.resumen.negocios_omitidos === 2, "7 negocios, 2 omitidos (CFO y Laboral repetidos)");
  const r = await importar(datos, false, "ejemplo-clientes.xlsx");
  ok(r.importacion_id && r.resumen.negocios_nuevos === 7, "importado");
  const fe = (await uno("select public.agente_ficha_empresa(id) r from empresas where cif = 'B33333333'")).r;
  ok(fe.empresa.empleados === 12 && fe.total_contactos === 1 && fe.deals.length === 1
     && fe.deals[0].servicio === "s4" && fe.deals[0].importe === 480 && fe.deals[0].owner === A.mario, "agente: Gestoría con su negocio de Laboral");
  const b = (await uno("select public.agente_buscar('Rich Texto') r")).r;
  ok(b.resultados.some((x) => x.tipo === "contacto"), "agente: encuentra el contacto de texto rico");
  const fc = (await uno("select public.agente_ficha_contacto(id) r from contactos where email = 'laura@ejemplo.invalid'")).r;
  ok(fc.empresas.length === 2 && fc.contacto.telefono === "600222333", "agente: Laura en 2 empresas, teléfono limpio");
  ok((await deshacer(r.importacion_id)).empresas_borradas === 6, "y se deshace");
  ok(JSON.stringify(await cuenta()) === JSON.stringify({ ...antes, e: antes.e + 2, k: antes.k + 10 }), "recuentos como antes (+2 empresas 'Repetida')");
}

console.log(`\n${total - fallos}/${total} ok`);
process.exit(fallos ? 1 : 0);
