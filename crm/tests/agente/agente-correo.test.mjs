// Prueba de crm/supabase-agente-correo.sql en PGlite (datos inventados, emails
// en .invalid): esquema-base.sql + crm/supabase-agente.sql +
// crm/supabase-agente-escritura.sql, y después 11A/11B/11C y los correos.
// Uso (desde crm/tests/agente): npm install && npm test
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const dir = new URL(".", import.meta.url).pathname;
const agente = fs.readFileSync(new URL("../../supabase-agente.sql", import.meta.url), "utf8");
const escritura = fs.readFileSync(new URL("../../supabase-agente-escritura.sql", import.meta.url), "utf8");
const mig = fs.readFileSync(new URL("../../supabase-agente-correo.sql", import.meta.url), "utf8");
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

await db.exec(parte(escritura, "10B", "10C"));
const D1 = "f1000000-0000-0000-0000-000000000001", D2 = "f2000000-0000-0000-0000-000000000002", D3 = "f3000000-0000-0000-0000-000000000003";
await db.exec(`
  insert into public.documentos (id, storage_path, mime_type, size_bytes, original_filename, status, source, empresa_id) values
    ('${D1}', 'e1/a.pdf', 'application/pdf', 1000, 'Contrato inventado.pdf', 'stored', 'manual', '${E1}'),
    ('${D2}', 'e2/b.pdf', 'application/pdf', 1000, 'Otro.pdf', 'stored', 'manual', '${E2}'),
    ('${D3}', 'e1/c.pdf', 'application/pdf', 1000, 'Pendiente.pdf', 'pending', 'whatsapp', '${E1}');
`);
await db.exec(`insert into public.agente_conversaciones (id, auth_user_id, titulo, modelo) values
  ('aa000000-0000-0000-0000-000000000001', '${U.admin}', 't', 'm'), ('bb000000-0000-0000-0000-000000000001', '${U.miembro}', 't', 'm');`);
const CA = "aa000000-0000-0000-0000-000000000001", CM = "bb000000-0000-0000-0000-000000000001";

// ---------------------------------------------------------------- 11A
console.log("11A:");
const tabla = async (sql) => Object.fromEntries((await db.exec(sql)).at(-1).rows.map((r) => [r.comprobacion, r.valor]));
const A = await tabla(parte(mig, "11A", "11B"));
console.log("   ", JSON.stringify(A));
ok(A["migración 20261128100000"] === "sí" && A["migración 20261128140000"] === "no" && A["tabla agente_correos"] === "0"
   && A["restricción de tabla en agente_escrituras"] === "1" && A["columnas usadas"] === "14", "11A: lo esperado");

// ---------------------------------------------------------------- 11B
console.log("11B:");
await db.exec(parte(mig, "11B", "11C"));
ok(true, "11B se aplica");
let rep = null; try { await db.exec(parte(mig, "11B", "11C")); } catch (e) { rep = e.message; }
ok(/ya está aplicada/.test(rep || ""), "11B se niega a repetirse");

console.log("11C:");
const C = await tabla(parte(mig, "11C", "ZZZ"));
console.log("   ", JSON.stringify(C));
ok(C["RLS en agente_correos"] === "true" && C["políticas"] === "3" && C["funciones nuevas (invoker)"] === "5"
   && C["con EXECUTE para anon"] === "0" && C["authenticated correos s/i/u/d"] === "true/true/false/false"
   && C["authenticated insert / update(estado) / update(enviado_por)"] === "true/true/false"
   && C["tabla agente_correos admitida en la auditoría"] === "sí" && C["filas"] === "0"
   && /^20261128140000 /.test(C["migración registrada"] || ""), "11C: lo esperado");

// ---------------------------------------------------------------- redactar
console.log("redactar:");
const J = (o) => JSON.stringify(o);
const proponer = (quien, conv, tu, datos) => rpc(quien, `public.agente_proponer_correo($1, $2, $3::jsonb)`, [conv, tu, J(datos)]);
let r = await proponer("admin", CA, "t1", { para: "José <JOSE@x.invalid>; otra@x.invalid, jose@x.invalid", asunto: "  Hola   José ",
  texto: "Línea 1\r\n\nLínea 2  ", contact_id: C1, documentos: [D1] });
ok(!r.error, "el admin redacta: " + (r.error || ""));
ok(J(r.v?.datos?.para) === J(["jose@x.invalid", "otra@x.invalid"]), "emails normalizados, sin repetir y con «Nombre <email>»");
ok(r.v?.datos?.asunto === "Hola José" && r.v?.datos?.texto === "Línea 1\n\nLínea 2", "asunto recortado; el texto conserva los saltos");
ok(r.v?.datos?.empresa_id === E1, "sin empresa: la principal del contacto");
ok(r.v?.adjuntos?.length === 1 && r.v.adjuntos[0].nombre === "Contrato inventado.pdf", "adjuntos con su nombre");
ok(r.v?.avisos?.length === 1 && /otra@x.invalid/.test(r.v.avisos[0]), "aviso: dirección que no es de ningún contacto");
ok(r.v?.puede_enviar === true && r.v?.estado === "pendiente", "el admin puede enviar");
ok(/^Correo a jose@x.invalid y 1 más: «Hola José»$/.test(r.v?.resumen || ""), "resumen");
const K1 = r.v?.id;
const fila = (await q(`select estado, para, documentos, contact_id, empresa_id, expira_at > now() + interval '6 days' as siete from public.agente_correos where id = $1`, [K1]))[0];
ok(fila.estado === "pendiente" && fila.para.length === 2 && fila.documentos[0] === D1 && fila.contact_id === C1 && fila.siete, "fila guardada (caduca a los 7 días)");
ok((await q(`select count(*)::int n from public.correo_mensajes`))[0].n === 0, "redactar no envía ni registra nada en el buzón");

r = await proponer("miembro", CM, "t1", { para: ["lucia@x.invalid"], asunto: "A", texto: "B" });
ok(!r.error && r.v.puede_enviar === false, "un miembro redacta, pero no puede enviar");
const K2 = r.v?.id;
r = await proponer("miembro", CA, "t9", { para: ["lucia@x.invalid"], asunto: "A", texto: "B" });
ok(r.code === "42501", "en la conversación de otro, no");
r = await proponer("inactivo", CA, "t9", { para: ["lucia@x.invalid"], asunto: "A", texto: "B" });
ok(r.code === "42501", "un usuario inactivo, no");
r = await proponer("anon", CA, "t9", { para: ["lucia@x.invalid"], asunto: "A", texto: "B" });
ok(!!r.error, "anon, no");

const mal = async (datos, re, msg) => { const x = await proponer("admin", CA, "m" + Math.random(), datos); ok(x.error && re.test(x.error), msg + " → " + (x.error || "sin error")); };
await mal({ asunto: "A", texto: "B" }, /al menos un destinatario/, "sin destinatarios");
await mal({ para: ["no-es-email"], asunto: "A", texto: "B" }, /Email no válido/, "email mal escrito");
await mal({ para: ["a@x.invalid"], texto: "B" }, /Falta el asunto/, "sin asunto");
await mal({ para: ["a@x.invalid"], asunto: "A", texto: "   " }, /Falta el texto/, "texto vacío");
await mal({ para: ["a@x.invalid"], asunto: "A", texto: "B", firma: "x" }, /./, "clave desconocida");
await mal({ para: ["a@x.invalid"], asunto: "A", texto: "B", documentos: [D1] }, /indica la empresa/, "documentos sin empresa");
await mal({ para: ["a@x.invalid"], asunto: "A", texto: "B", empresa_id: E1, documentos: [D2] }, /no es de la empresa/, "documento de otra empresa");
await mal({ para: ["a@x.invalid"], asunto: "A", texto: "B", empresa_id: E1, documentos: [D3] }, /no está disponible/, "documento sin subir del todo");
await mal({ para: ["a@x.invalid"], asunto: "A", texto: "B", contact_id: "c9000000-0000-0000-0000-000000000009" }, /no existe/, "contacto que no existe");
await mal({ para: Array.from({ length: 51 }, (_, i) => `p${i}@x.invalid`), asunto: "A", texto: "B" }, /Demasiados|50/, "más de 50");
ok((await q(`select count(*)::int n from public.agente_correos`))[0].n === 2, "lo que no valida no deja fila");

// ---------------------------------------------------------------- ver, editar, cancelar
console.log("editar y cancelar:");
let v = await como("miembro", `select id from public.agente_correos`);
ok(v.rows.length === 1 && v.rows[0].id === K2, "un miembro solo ve los suyos");
v = await como("admin", `select id from public.agente_correos`);
ok(v.rows.length === 2, "el rol admin ve todos (es quien envía)");
r = await rpc("admin", `public.agente_correo_editar($1, $2::jsonb)`, [K2, J({ para: ["lucia@x.invalid"], cc: "jose@x.invalid", asunto: "Nuevo", texto: "Otro texto" })]);
ok(!r.error && r.v.datos.asunto === "Nuevo", "el admin edita el correo de un miembro antes de enviarlo");
r = await rpc("miembro", `public.agente_correo_editar($1, $2::jsonb)`, [K1, J({ para: ["a@x.invalid"], asunto: "x", texto: "y" })]);
ok(r.code === "GU010", "un miembro no edita el de otro");
r = await rpc("admin", `public.agente_correo_editar($1, $2::jsonb)`, [K1, J({ para: ["mal"], asunto: "x", texto: "y" })]);
ok(r.error && /Email no válido/.test(r.error), "lo editado se valida");
v = await como("miembro", `update public.agente_correos set estado = 'enviada' where id = '${K2}'`);
ok(!!v.error, "nadie marca un correo como enviado desde el CRM");
v = await como("miembro", `update public.agente_correos set enviado_por = '${MIE}' where id = '${K2}'`);
ok(!!v.error, "ni pone quién lo envió");
v = await como("miembro", `delete from public.agente_correos where id = '${K2}'`);
ok(!!v.error, "ni lo borra");
r = await rpc("miembro", `public.agente_correo_cancelar($1)`, [K2]);
ok(!r.error && r.v.estado === "cancelada", "quien lo redactó lo cancela");
r = await rpc("admin", `public.agente_correo_cancelar($1)`, [K2]);
ok(r.error && /ya está cancelada/.test(r.error), "cancelar dos veces, no");
r = await rpc("admin", `public.agente_correo_editar($1, $2::jsonb)`, [K2, J({ para: ["a@x.invalid"], asunto: "x", texto: "y" })]);
ok(r.error && /ya está cancelada/.test(r.error), "uno cancelado no se edita");

// Enviando/enviada: lo pone la función correo (service role); después ya no se toca.
await db.exec(`set role service_role; update public.agente_correos set estado = 'enviada', enviado_por = '${ADM}', enviado_at = now(), graph_id = 'g1' where id = '${K1}'; reset role;`);
r = await rpc("admin", `public.agente_correo_editar($1, $2::jsonb)`, [K1, J({ para: ["a@x.invalid"], asunto: "x", texto: "y" })]);
ok(r.error && /ya está enviada/.test(r.error), "uno enviado no se edita");
r = await rpc("admin", `public.agente_correo_cancelar($1)`, [K1]);
ok(r.error && /ya está enviada/.test(r.error), "ni se cancela");

// Caducado.
r = await proponer("admin", CA, "t3", { para: ["jose@x.invalid"], asunto: "A", texto: "B" });
await db.exec(`update public.agente_correos set expira_at = now() - interval '1 minute' where id = '${r.v.id}'`);
const r2 = await rpc("admin", `public.agente_correo_editar($1, $2::jsonb)`, [r.v.id, J({ para: ["jose@x.invalid"], asunto: "A", texto: "C" })]);
ok(r2.error && /caducado/.test(r2.error), "caducado no se edita");

// Auditoría del envío y borrado con la conversación.
await db.exec(`set role service_role; insert into public.agente_escrituras (auth_user_id, accion, tabla, registro_id) values ('${U.admin}', 'enviar_correo', 'agente_correos', '${K1}'); reset role;`);
ok((await q(`select count(*)::int n from public.agente_escrituras where tabla = 'agente_correos'`))[0].n === 1, "la auditoría admite el envío de correos");
await db.exec(`delete from public.agente_conversaciones where id = '${CM}'`);
ok((await q(`select count(*)::int n from public.agente_correos where conversacion_id = '${CM}'`))[0].n === 0, "los correos se borran con su conversación");

console.log(`\n${total - fallos}/${total} ok`);
process.exit(fallos ? 1 : 0);
