// Prueba de crm/supabase-agente-escritura.sql en PGlite (datos inventados):
// estructura real de las tablas (esquema-base.sql) + crm/supabase-agente.sql
// + admin_borrar_contacto, y después 10A/10B/10C y las propuestas del chat.
// Uso (desde crm/tests/agente): npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const agente = fs.readFileSync(new URL("../../supabase-agente.sql", import.meta.url), "utf8");
const mig = fs.readFileSync(new URL("../../supabase-agente-escritura.sql", import.meta.url), "utf8");
const base = fs.readFileSync(dir + "esquema-base.sql", "utf8");
const parte = (txt, id, sig) => {
  const m = txt.match(new RegExp(`-- ${id} [\\s\\S]*?(?=\\n-- =+\\n-- ${sig} |$)`));
  if (!m) throw new Error("sin parte " + id);
  return m[0];
};

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
await db.exec(base.replace(/CREATE POLICY[\s\S]*?;\n/g, ""));
await db.exec(`
  CREATE FUNCTION public.is_admin(uid uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public' AS $$ select exists (select 1 from public.admins where auth_user_id = uid and activo = true) $$;
  CREATE FUNCTION public.is_admin_role(uid uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public' AS $$ select exists (select 1 from public.admins where auth_user_id = uid and activo = true and rol = 'admin') $$;
`);
await db.exec((base.match(/CREATE POLICY[\s\S]*?;\n/g) || []).join("\n"));
await db.exec(`
  grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
  grant execute on all functions in schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
`);
await db.exec(parte(agente, "1B", "1[A-Z]"));
// Columna posterior al volcado de esquema-base.sql (en producción ya existe).
await db.exec(`alter table public.empresas add column if not exists empleados integer check (empleados is null or empleados >= 0)`);
// admin_borrar_contacto, como en producción (crm/supabase-pasoB.sql).
await db.exec(`
CREATE FUNCTION public.admin_borrar_contacto(p_contact_id uuid)
 RETURNS TABLE(deals_conservados integer, deals_borrados integer) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp' AS $function$
  declare v_borrados integer; v_quedan integer;
  begin
    if not public.is_admin() then raise exception 'No autorizado' using errcode = '42501'; end if;
    perform 1 from public.contactos c where c.id = p_contact_id for update;
    if not found then raise exception 'El contacto no existe' using errcode = 'GU010'; end if;
    delete from public.deals d where d.contact_id = p_contact_id and d.empresa_id is null;
    get diagnostics v_borrados = row_count;
    select count(*) into v_quedan from public.deals d where d.contact_id = p_contact_id;
    update public.notas n set contact_id = null where n.contact_id = p_contact_id and n.deal_id is not null;
    update public.tareas t set contact_id = null where t.contact_id = p_contact_id and t.deal_id is not null;
    delete from public.contactos c where c.id = p_contact_id;
    return query select v_quedan, v_borrados;
  end; $function$;`);

// ---------------------------------------------------------------- datos inventados
const U = { admin: "11111111-1111-1111-1111-111111111111", miembro: "22222222-2222-2222-2222-222222222222",
            inactivo: "33333333-3333-3333-3333-333333333333", portal: "44444444-4444-4444-4444-444444444444" };
const E1 = "e1000000-0000-0000-0000-000000000001", E2 = "e2000000-0000-0000-0000-000000000002";
const C1 = "c1000000-0000-0000-0000-000000000001", C2 = "c2000000-0000-0000-0000-000000000002";
const L1 = "d1000000-0000-0000-0000-000000000001";
await db.exec(`
  insert into auth.users values ('${U.admin}'), ('${U.miembro}'), ('${U.inactivo}'), ('${U.portal}');
  insert into public.admins (auth_user_id, nombre, email, rol, activo) values
    ('${U.admin}', 'Ana', 'a@x.invalid', 'admin', true), ('${U.miembro}', 'Mario', 'm@x.invalid', 'miembro', true),
    ('${U.inactivo}', 'Iris', 'i@x.invalid', 'admin', false);
  insert into public.empresas (id, razon_social, cif, city) values ('${E1}', 'Panadería Muñoz SL', 'B12345678', 'Pozuelo');
  insert into public.empresas (id, razon_social, cif) values ('${E2}', 'Talleres Ejemplo SA', 'A87654321');
  insert into public.leads (id, nombre, source) values ('${L1}', 'José', 'web');
  insert into public.contactos (id, full_name, email, phone, dni, lifecycle, lead_id) values
    ('${C1}', 'José Pérez', 'jose@x.invalid', '+34 600 111 222', '12345678Z', 'active_client', '${L1}');
  insert into public.contactos (id, full_name, email, lifecycle) values ('${C2}', 'Lucía Gómez', 'lucia@x.invalid', 'new');
  insert into public.contacto_empresa (contact_id, empresa_id, principal) values ('${C1}', '${E1}', true), ('${C2}', '${E1}', true);
`);
const ADM = (await q(`select id from public.admins where auth_user_id = '${U.admin}'`))[0].id;
const MIE = (await q(`select id from public.admins where auth_user_id = '${U.miembro}'`))[0].id;

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

// ---------------------------------------------------------------- 10A
console.log("10A:");
const tabla = async (sql) => Object.fromEntries((await db.exec(sql)).at(-1).rows.map((r) => [r.comprobacion, r.valor]));
const A = await tabla(parte(mig, "10A", "10B"));
console.log("   ", JSON.stringify(A));
ok(A["migración 20261113120000 (agente)"] === "sí" && A["migración 20261128100000"] === "no"
   && A["tablas agente_propuestas/agente_escrituras"] === "0" && A["admin_borrar_contacto"] === "sí" && A["agente_norm"] === "sí"
   && A["columnas usadas"] === "52",
   "10A: lo esperado");

// ---------------------------------------------------------------- 10B
console.log("10B:");
const B = parte(mig, "10B", "10C");
await db.exec(B);
ok(true, "10B aplicado");
try { await db.exec(B); ok(false, "10B dos veces debería fallar"); }
catch (e) { ok(/ya está aplicada/.test(e.message), "10B se niega a repetirse"); }

// ---------------------------------------------------------------- 10C
console.log("10C:");
const C = await tabla(parte(mig, "10C", "1[0-9][A-Z]"));
console.log("   ", JSON.stringify(C));
ok(C["tablas con RLS"] === "2" && C["políticas"] === "5", "10C: RLS y políticas");
ok(C["funciones agente_* nuevas (invoker)"] === "14" && C["con EXECUTE para anon"] === "0", "10C: 14 funciones invoker, anon sin EXECUTE");
ok(C["authenticated propuestas s/i/u/d"] === "true/true/true/false", "10C: privilegios propuestas");
ok(C["authenticated escrituras s/i/u/d"] === "true/true/false/false", "10C: privilegios escrituras");
ok(C["filas propuestas/escrituras"] === "0/0" && /^20261128100000 /.test(C["migración registrada"] || ""), "10C: vacías y registrada");

// ---------------------------------------------------------------- conversaciones
const conv = async (quien) => (await como(quien, `insert into public.agente_conversaciones (modelo) values ('m') returning id`)).rows[0].id;
const CA = await conv("admin"), CM = await conv("miembro");
let n = 0;
const proponer = (quien, tipo, registro, datos, c = quien === "admin" ? CA : CM) =>
  rpc(quien, `public.agente_proponer($1, $2, $3, $4, $5)`, [c, `tu_${++n}`, tipo, registro, JSON.stringify(datos)]);
const confirmar = (quien, id, datos = null, texto = null) =>
  rpc(quien, `public.agente_confirmar($1, $2, $3)`, [id, datos === null ? null : JSON.stringify(datos), texto]);
const cuenta = async (sql) => (await q(`select count(*)::int n from ${sql}`))[0].n;

// ---------------------------------------------------------------- proponer no escribe
console.log("Proponer no escribe; confirmar sí:");
const empresasAntes = await cuenta("public.empresas");
let r = await proponer("miembro", "crear_empresa", null, { razon_social: "  Asesoría   Inventada  SL ", cif: "b 99999999", city: "Madrid" });
ok(!r.error, "un miembro propone crear una empresa " + (r.error || ""));
const P1 = r.v;
ok(P1.estado === "pendiente" && P1.datos.razon_social === "Asesoría Inventada SL" && P1.datos.cif === "B99999999",
   "los datos se normalizan como en la interfaz (espacios, CIF)");
ok(await cuenta("public.empresas") === empresasAntes, "proponer no crea nada en empresas");
ok(P1.resumen === "Crear la empresa «Asesoría Inventada SL»", "resumen legible");
r = await confirmar("admin", P1.id);
ok(r.code === "GU010", "otro usuario no puede confirmar una propuesta ajena (aunque sea rol admin)");
r = await confirmar("miembro", P1.id);
ok(!r.error && r.v.ok && r.v.tabla === "empresas", "quien la propuso la confirma " + (r.error || ""));
ok(await cuenta("public.empresas") === empresasAntes + 1, "al confirmar, se crea la empresa");
ok(await cuenta(`public.agente_escrituras where auth_user_id = '${U.miembro}' and accion = 'crear_empresa' and registro_id = '${r.v.registro_id}'`) === 1,
   "queda en la auditoría: usuario, acción, registro");
r = await confirmar("miembro", P1.id);
ok(r.error && /ya está confirmada/.test(r.error), "no se confirma dos veces");
const E3 = (await q(`select id from public.empresas where cif = 'B99999999'`))[0].id;

// ---------------------------------------------------------------- duplicados
console.log("Duplicados:");
r = await proponer("admin", "crear_empresa", null, { razon_social: "PANADERIA MUNOZ, S.L.", cif: "B-12345678" });
ok(!r.error && r.v.coincidencias.some((x) => x.id === E1 && x.motivo === "mismo CIF/NIF"), "mismo CIF con guiones → coincidencia");
r = await proponer("admin", "crear_empresa", null, { razon_social: "panadería muñoz" });
ok(!r.error && r.v.coincidencias.some((x) => x.id === E1 && x.motivo === "nombre parecido"), "mismo nombre sin acentos ni forma jurídica");
r = await proponer("admin", "crear_contacto", null, { full_name: "Otro", phone: "600111222", empresa_id: E1 });
ok(!r.error && r.v.coincidencias.some((x) => x.id === C1 && x.motivo === "mismo teléfono"), "mismo teléfono (últimos 9 dígitos)");
r = await proponer("admin", "crear_contacto", null, { full_name: "Otra", email: "JOSE@x.invalid ", empresa_id: E1 });
ok(!r.error && r.v.coincidencias.some((x) => x.id === C1 && x.motivo === "mismo email"), "mismo email (sin mayúsculas)");
r = await rpc("admin", `public.agente_buscar_duplicados(p_dni => '12345678-z')`);
ok(!r.error && r.v.some((x) => x.id === C1 && x.motivo === "mismo DNI"), "agente_buscar_duplicados por DNI");

// ---------------------------------------------------------------- validaciones
console.log("Validaciones:");
const mal = async (tipo, registro, datos, re, quien = "admin") => {
  const x = await proponer(quien, tipo, registro, datos);
  ok(x.error && re.test(x.error) && (x.code === "22023" || x.code === "GU010"), `${tipo} ${JSON.stringify(datos).slice(0, 60)} → ${x.error}`);
};
await mal("crear_empresa", null, { cif: "B1" }, /razón social/);
await mal("crear_empresa", null, { razon_social: "X", web: "x" }, /Campo desconocido "web"/);
await mal("crear_empresa", null, { razon_social: "X", empleados: "-3" }, /entre 0/);
await mal("crear_contacto", null, { full_name: "Sin empresa" }, /una de las dos/);
await mal("crear_contacto", null, { full_name: "Dos", empresa_id: E1, nueva_empresa: { razon_social: "Y" } }, /una de las dos/);
await mal("crear_contacto", null, { full_name: "X", email: "no-es-email", empresa_id: E1 }, /dirección válida/);
await mal("crear_contacto", null, { full_name: "X", lifecycle: "vip", empresa_id: E1 }, /valores válidos/);
await mal("crear_contacto", null, { full_name: "X", owner: "alguien", empresa_id: E1 }, /usuario del CRM/);
await mal("crear_deal", null, { title: "Sin contacto" }, /contacto asociado/);
await mal("crear_deal", null, { title: "X", contact_id: C1, service: "s9" }, /valores válidos/);
await mal("crear_deal", null, { title: "X", contact_id: C1, amount: "mucho" }, /número/);
await mal("crear_tarea", null, { title: "X", due_at: "mañana" }, /fecha no válida/);
await mal("crear_nota", null, { body: "Suelta" }, /contacto .* o en un negocio/);
await mal("crear_nota", null, { body: "   ", contact_id: C1 }, /vacía/);
await mal("modificar_empresa", "e9000000-0000-0000-0000-000000000009", { city: "X" }, /no existe/);
await mal("modificar_contacto", C1, {}, /ningún cambio/);
await mal("desvincular_empresa", C2, { empresa_id: E1 }, /al menos una empresa/);
await mal("borrar_tarea", null, {}, /Falta el id/);
r = await proponer("inactivo", "crear_empresa", null, { razon_social: "X" }, CA);
ok(r.code === "42501", "un admin inactivo no propone");
r = await proponer("portal", "crear_empresa", null, { razon_social: "X" }, CA);
ok(r.code === "42501", "un cliente del portal no propone");
r = await proponer("miembro", "crear_empresa", null, { razon_social: "X" }, CA);
ok(r.code === "42501", "no se propone en la conversación de otro");
r = await rpc("anon", `public.agente_confirmar('${P1.id}')`);
ok(!!r.error, "anon no puede confirmar");

// ---------------------------------------------------------------- contacto con empresa nueva, editar al confirmar
console.log("Contactos:");
r = await proponer("admin", "crear_contacto", null, { full_name: "Marta Inventada", email: "marta@x.invalid", owner: String(ADM),
                                                     nueva_empresa: { razon_social: "Inventos Marta SL", cif: "B55555555" } });
ok(!r.error && r.v.datos.nueva_empresa.razon_social === "Inventos Marta SL", "contacto con empresa nueva " + (r.error || ""));
r = await confirmar("admin", r.v.id, { full_name: "Marta Inventada López", email: "marta@x.invalid", owner: String(ADM),
                                      nueva_empresa: { razon_social: "Inventos Marta SL", cif: "B55555555" } });
ok(!r.error && r.v.ok, "se confirma con un dato editado " + (r.error || ""));
const C3 = r.v.registro_id;
const fila = (await q(`select c.full_name, c.lifecycle, c.source, ce.principal, e.razon_social from public.contactos c
                        join public.contacto_empresa ce on ce.contact_id = c.id join public.empresas e on e.id = ce.empresa_id where c.id = '${C3}'`))[0];
ok(fila && fila.full_name === "Marta Inventada López" && fila.principal && fila.razon_social === "Inventos Marta SL"
   && fila.lifecycle === "new" && fila.source === "Alta manual", "contacto, empresa nueva y vínculo principal; valores por defecto de la interfaz");
ok(await cuenta(`public.agente_escrituras where registro_id = '${C3}' or (accion = 'crear_empresa' and propuesta_id is not null)`) >= 2,
   "se auditan el contacto y la empresa nueva");
r = await proponer("admin", "crear_contacto", null, { full_name: "Edición mala", empresa_id: E1 });
const PX = r.v.id;
r = await confirmar("admin", PX, { full_name: "Edición mala", email: "roto", empresa_id: E1 });
ok(r.error && /dirección válida/.test(r.error), "lo editado se valida otra vez al confirmar");
ok((await q(`select estado from public.agente_propuestas where id = '${PX}'`))[0].estado === "pendiente", "y la propuesta sigue pendiente");
r = await rpc("admin", `public.agente_cancelar('${PX}')`);
ok(!r.error && r.v.estado === "cancelada", "cancelar");
r = await confirmar("admin", PX);
ok(r.error && /cancelada/.test(r.error), "una cancelada no se confirma");

r = await proponer("admin", "modificar_contacto", C1, { phone: "+34 611 000 000", city: "" });
ok(!r.error && r.v.antes.phone === "+34 600 111 222" && "city" in r.v.antes, "modificar: enseña el estado anterior de lo que cambia");
r = await confirmar("admin", r.v.id);
const c1 = (await q(`select phone, city, email from public.contactos where id = '${C1}'`))[0];
ok(!r.error && c1.phone === "+34 611 000 000" && c1.city === null && c1.email === "jose@x.invalid", "modificar solo cambia lo propuesto; '' vacía el campo");

// vincular / desvincular / principal
r = await proponer("admin", "vincular_empresa", C2, { empresa_id: E2 });
r = await confirmar("admin", r.v.id);
ok(!r.error && await cuenta(`public.contacto_empresa where contact_id = '${C2}'`) === 2, "vincular a otra empresa");
r = await proponer("admin", "vincular_empresa", C2, { empresa_id: E2, principal: true });
r = await confirmar("admin", r.v.id);
const ppal = await q(`select empresa_id from public.contacto_empresa where contact_id = '${C2}' and principal`);
ok(!r.error && ppal.length === 1 && ppal[0].empresa_id === E2, "poner como principal deja una sola principal");
r = await proponer("admin", "desvincular_empresa", C2, { empresa_id: E2 });
r = await confirmar("admin", r.v.id);
const ppal2 = await q(`select empresa_id from public.contacto_empresa where contact_id = '${C2}' and principal`);
ok(!r.error && ppal2.length === 1 && ppal2[0].empresa_id === E1, "al quitar la principal, pasa a serlo la que queda");

// ---------------------------------------------------------------- negocios, tareas, notas
console.log("Negocios, tareas y notas:");
r = await proponer("miembro", "crear_deal", null, { title: "Contabilidad 2027", contact_id: C1, empresa_id: E1, service: "s3",
                                                   amount: "1.234,50", frequency: "mensual", owner: String(MIE) });
ok(!r.error && r.v.datos.amount === 1234.5 && r.v.datos.stage === "reunion", "negocio: importe con formato español; etapa por defecto");
r = await confirmar("miembro", r.v.id);
const D1 = r.v.registro_id;
ok(!r.error && (await q(`select amount::float8 a from public.deals where id = '${D1}'`))[0].a === 1234.5, "negocio creado");
r = await proponer("miembro", "modificar_deal", D1, { stage: "perdido", loss_reason: "precio_alto" });
r = await confirmar("miembro", r.v.id);
ok(!r.error && (await q(`select stage from public.deals where id = '${D1}'`))[0].stage === "perdido", "negocio modificado");

r = await proponer("admin", "crear_tarea", null, { title: "Llamar a José", assigned_to: String(MIE), due_at: "2026-12-02", contact_id: C1 });
ok(!r.error, "tarea con responsable " + (r.error || ""));
r = await confirmar("admin", r.v.id);
const T1 = r.v.registro_id;
const t1 = (await q(`select assigned_to, to_char(due_at at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') due, status, archived from public.tareas where id = '${T1}'`))[0];
ok(t1.assigned_to === String(MIE) && t1.due === "2026-12-02 09:00" && t1.status === "pending" && !t1.archived,
   "solo la fecha → 09:00 en Madrid; pendiente por defecto");
r = await proponer("admin", "modificar_tarea", T1, { status: "done" });
r = await confirmar("admin", r.v.id);
const t1b = (await q(`select status, archived from public.tareas where id = '${T1}'`))[0];
ok(!r.error && t1b.status === "done" && t1b.archived, "marcarla hecha la archiva, como el botón de la interfaz");

r = await proponer("miembro", "crear_nota", null, { body: "Primera línea\nSegunda línea", deal_id: D1 });
r = await confirmar("miembro", r.v.id);
const nota = (await q(`select body, author from public.notas where id = '${r.v.registro_id}'`))[0];
ok(!r.error && nota.body === "Primera línea\nSegunda línea" && nota.author === String(MIE), "nota: conserva los saltos de línea; autor = quien confirma");

// ---------------------------------------------------------------- borrar
console.log("Borrar:");
r = await proponer("admin", "borrar_tarea", T1, {});
ok(!r.error && r.v.confirmacion === "BORRAR" && r.v.antes.titulo === "Llamar a José", "borrar: pide BORRAR y enseña qué se borra");
const PB = r.v.id;
r = await confirmar("admin", PB, null, "borrar no");
ok(r.error && /escribir BORRAR/.test(r.error) && await cuenta(`public.tareas where id = '${T1}'`) === 1, "sin BORRAR no se borra");
r = await confirmar("admin", PB, null, " borrar ");
ok(!r.error && await cuenta(`public.tareas where id = '${T1}'`) === 0, "con BORRAR (sin mayúsculas ni espacios) se borra");
r = await proponer("admin", "borrar_contacto", C1, {});
ok(!r.error && r.v.antes.negocios_que_se_quedan === 1, "borrar contacto: avisa de los negocios que se quedan");
r = await confirmar("admin", r.v.id, null, "BORRAR");
ok(!r.error && await cuenta(`public.contactos where id = '${C1}'`) === 0, "contacto borrado con admin_borrar_contacto");
ok((await q(`select status from public.leads where id = '${L1}'`))[0].status === "deleted", "y su lead queda como borrado (como la interfaz)");
ok(await cuenta(`public.deals where id = '${D1}'`) === 1, "el negocio con empresa se queda, sin interlocutor");
r = await proponer("admin", "borrar_empresa", E1, {});
ok(!!r.error, "no hay borrar_empresa: tiene su pantalla en el CRM");

// ---------------------------------------------------------------- RLS de las tablas nuevas
console.log("RLS:");
r = await como("miembro", `select count(*)::int n from public.agente_propuestas`);
const propias = (await q(`select count(*)::int n from public.agente_propuestas where auth_user_id = '${U.miembro}'`))[0].n;
ok(!r.error && r.rows[0].n === propias, "un miembro solo ve sus propuestas");
r = await como("admin", `select count(*)::int n from public.agente_propuestas`);
ok(!r.error && r.rows[0].n === await cuenta("public.agente_propuestas"), "el rol admin ve todas");
r = await como("miembro", `delete from public.agente_escrituras`);
ok(!!r.error, "nadie borra la auditoría");
r = await como("miembro", `update public.agente_escrituras set accion = 'x'`);
ok(!!r.error, "nadie cambia la auditoría");
r = await como("miembro", `insert into public.agente_escrituras (auth_user_id, accion, tabla, registro_id) values ('${U.admin}', 'x', 'notas', '${E1}')`);
ok(!!r.error, "nadie audita en nombre de otro");
r = await como("miembro", `update public.agente_propuestas set datos = '{"marca": 1}' where auth_user_id = '${U.admin}'`);
ok(!r.error && (await q(`select count(*)::int n from public.agente_propuestas where datos ? 'marca'`))[0].n === 0,
   "nadie toca las propuestas de otro");
await db.exec(`update public.agente_propuestas set expira_at = now() - interval '1 minute' where id = (
  select id from public.agente_propuestas where estado = 'pendiente' and auth_user_id = '${U.admin}' limit 1)`);
const cad = (await q(`select id from public.agente_propuestas where expira_at < now() and estado = 'pendiente'`))[0].id;
r = await confirmar("admin", cad);
ok(r.error && /caducado/.test(r.error), "una propuesta caducada no se confirma");
// Sin permiso de RLS: un portal (sin is_admin) no lo consigue ni a través del agente.
await db.exec(`delete from public.agente_conversaciones where id = '${CM}'`);
ok(await cuenta(`public.agente_propuestas where conversacion_id = '${CM}'`) === 0, "las propuestas se van con su conversación");
ok(await cuenta(`public.agente_escrituras where auth_user_id = '${U.miembro}'`) > 0, "la auditoría se queda");

console.log(`\n${total - fallos}/${total} ok${fallos ? `, ${fallos} FALLOS` : ""}`);
process.exit(fallos ? 1 : 0);
