-- ============================================================
-- GUIMAES — Deals → empresa (cambio ADITIVO)
--
-- deals.empresa_id (nullable, FK a empresas) se rellena con la empresa
-- principal del contacto, con la misma regla que el resto del CRM:
-- public.empresa_principal_de() (crm/supabase-carpetas.sql). contact_id se
-- conserva como interlocutor; no se borra ni se renombra nada, y las
-- políticas is_admin() de deals no cambian.
--
-- Escrito sobre el esquema REAL de producción (con num_nominas y
-- coste_nomina), no sobre crm/supabase-deals.sql, que está desactualizado.
--
-- Cada bloque se ejecuta por separado en Supabase → SQL Editor, en este
-- orden: A1–A4 (lectura), B (cambio), C1–C4 (verificación), D (limpieza
-- de "Por definir", opcional). El editor solo muestra el resultado de la
-- última sentencia, por eso cada bloque es una sola sentencia. Ningún
-- bloque usa tablas temporales: el pooler puede repartir sentencias
-- entre conexiones.
-- ============================================================


-- ============================================================
-- A1 (solo lectura) — Qué haría el backfill.
-- Cuadre: 2 + 3 = 1; 2a + 2b = 2; 3a + 3b = 3.
-- ============================================================
with d as (
  select d.contact_id,
         public.empresa_principal_de(d.contact_id) as empresa,
         exists (select 1 from public.contacto_empresa ce
                 where ce.contact_id = d.contact_id and ce.principal) as tiene_principal,
         (select count(*) from public.contacto_empresa ce
          where ce.contact_id = d.contact_id) as n_empresas
  from public.deals d
), s as (
  select count(*)                                                          as total,
         count(*) filter (where empresa is not null)                       as con_empresa,
         count(*) filter (where empresa is not null and tiene_principal)   as via_principal,
         count(*) filter (where empresa is not null and not tiene_principal) as via_mas_antigua,
         count(*) filter (where empresa is null)                           as sin_empresa,
         count(*) filter (where contact_id is null)                        as sin_contacto,
         count(*) filter (where contact_id is not null and empresa is null) as contacto_sin_empresa,
         count(distinct contact_id) filter (where n_empresas > 1)          as contactos_varias,
         count(*) filter (where n_empresas > 1)                            as deals_contactos_varias
  from d
)
select v.orden, v.metrica, v.valor
from s cross join lateral (values
  ('1',  'Deals en total',                                              s.total),
  ('2',  'Obtendrían empresa',                                          s.con_empresa),
  ('2a', '  … por la empresa marcada como principal',                   s.via_principal),
  ('2b', '  … sin principal marcada: la enlazada más antigua',          s.via_mas_antigua),
  ('3',  'Quedarían con empresa_id NULL',                               s.sin_empresa),
  ('3a', '  … porque el deal no tiene contact_id',                      s.sin_contacto),
  ('3b', '  … porque su contacto no tiene ninguna empresa',             s.contacto_sin_empresa),
  ('4',  'Contactos con deals y más de una empresa',                    s.contactos_varias),
  ('4a', '  … deals de esos contactos (van a la principal o la más antigua)',          s.deals_contactos_varias)
) as v(orden, metrica, valor)
order by v.orden;


-- ============================================================
-- A2 (solo lectura) — Triggers sobre deals (5.4a), funciones que
-- mencionan deals (5.4b) y permiso de ejecutar empresa_principal_de.
-- Lo esperado: un único trigger, deals_set_updated_at; ninguna función;
-- EXECUTE = true. Si sale algo más, no ejecutes el bloque B (además, B
-- se niega a seguir si encuentra triggers inesperados).
-- ============================================================
select 'trigger' as tipo,
       t.tgname::text as nombre,
       pg_get_triggerdef(t.oid) || case t.tgenabled when 'D' then '  [DESACTIVADO]' else '' end as detalle
from pg_trigger t
where t.tgrelid = 'public.deals'::regclass and not t.tgisinternal
union all
select 'funcion',
       n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       case when p.prosecdef then 'SECURITY DEFINER' else 'invoker' end
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema')
  and p.prolang <> (select oid from pg_language where lanname = 'c')
  and p.prosrc ilike '%deals%'
union all
select 'permiso',
       'authenticated EXECUTE public.empresa_principal_de(uuid)',
       has_function_privilege('authenticated', 'public.empresa_principal_de(uuid)', 'EXECUTE')::text
order by 1, 2;


-- ============================================================
-- A3 (solo lectura) — Empresa "Por definir".
-- carpetas_de_serie = las cuatro que siembra empresas_sembrar_carpetas
-- (Fiscal, Laboral, Mercantil, Contratos) en la raíz.
-- ============================================================
select e.id, e.razon_social, e.created_at,
       (select count(*) from public.contacto_empresa ce where ce.empresa_id = e.id) as contactos,
       (select count(*) from public.documentos d where d.empresa_id = e.id)          as documentos,
       (select count(*) from public.carpetas c where c.empresa_id = e.id)            as carpetas,
       (select count(*) from public.carpetas c
        where c.empresa_id = e.id and c.parent_id is null and c.system_key is null
          and c.nombre in ('Fiscal', 'Laboral', 'Mercantil', 'Contratos'))      as carpetas_de_serie,
       (select count(*) from public.deals d
        where public.empresa_principal_de(d.contact_id) = e.id)                as deals_que_recibiria
from public.empresas e
where lower(btrim(e.razon_social)) = 'por definir';


-- ============================================================
-- A4 (solo lectura) — Jobs de pg_cron que mencionan deals (5.4c).
-- Aparte porque cron.job puede pedir permisos que el editor no tenga;
-- si falla, no afecta a nada más. Lo esperado: ninguna fila.
-- ============================================================
select jobid, jobname, schedule, command
from cron.job
where command ilike '%deals%';


-- ============================================================
-- B (CAMBIO) — Un único DO: o se aplica entero o no se aplica nada.
--
-- FK con ON DELETE RESTRICT, no SET NULL:
--   - Coherencia: hoy una empresa con documentos no se puede borrar
--     (documentos.empresa_id es RESTRICT). Un deal es historia comercial
--     de la empresa, igual que un documento: borrar la empresa no debe
--     llevarse por delante ni dejar a medias esa historia.
--   - SET NULL dejaría deals sin empresa en silencio, justo lo que el
--     trigger de abajo quiere evitar. Y como el trigger solo actúa al
--     insertar, esos deals ya no se rellenarían nunca más.
--   - No rompe ningún camino actual: la aplicación no borra empresas
--     (no hay removeEmpresa), y borrar un contacto no borra empresas: solo
--     su enlace en contacto_empresa (y sus deals, por el CASCADE de
--     contact_id, que no se toca).
--
-- Backfill: deals_set_updated_at se desactiva solo dentro de esta
-- transacción, para que rellenar una columna técnica no cambie el
-- updated_at de todos los deals.
-- ============================================================
do $b$
declare
  v_triggers text;
  v_pendientes bigint;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'deals' and column_name = 'empresa_id') then
    raise exception 'deals.empresa_id ya existe: el bloque B ya está aplicado. No se ha cambiado nada.';
  end if;

  -- 5.4a no se pudo ejecutar en producción: si hay triggers que no
  -- conocemos, el UPDATE del backfill o los inserts los dispararían.
  select string_agg(tgname, ', ' order by tgname) into v_triggers
  from pg_trigger
  where tgrelid = 'public.deals'::regclass and not tgisinternal
    and tgname <> 'deals_set_updated_at';
  if v_triggers is not null then
    raise exception 'deals tiene triggers no previstos (%): revísalos antes. No se ha cambiado nada.', v_triggers;
  end if;

  -- 1) Columna, FK e índice
  alter table public.deals add column empresa_id uuid;
  alter table public.deals add constraint deals_empresa_id_fkey
    foreign key (empresa_id) references public.empresas(id) on delete restrict;
  create index deals_empresa_idx on public.deals (empresa_id);

  -- 2) Backfill con la misma regla que el resto del CRM
  alter table public.deals disable trigger deals_set_updated_at;
  update public.deals d
  set empresa_id = public.empresa_principal_de(d.contact_id)
  where d.contact_id is not null;
  alter table public.deals enable trigger deals_set_updated_at;

  -- 3) Ningún camino (alta manual, pipeline, alta de empresa, leads) crea
  -- un deal sin empresa si su contacto tiene alguna. Si empresa_id viene
  -- informado se respeta: la aplicación lo elige a propósito (p. ej. la
  -- empresa recién creada en el alta de empresa, que no es la principal).
  create function public.deals_rellenar_empresa()
  returns trigger
  language plpgsql
  set search_path = public
  as $f$
  begin
    if new.empresa_id is null and new.contact_id is not null then
      new.empresa_id := public.empresa_principal_de(new.contact_id);
    end if;
    return new;
  end;
  $f$;

  create trigger deals_rellenar_empresa
    before insert on public.deals
    for each row execute function public.deals_rellenar_empresa();

  -- 4) Comprobación final dentro de la misma transacción
  select count(*) into v_pendientes
  from public.deals
  where empresa_id is null and public.empresa_principal_de(contact_id) is not null;
  if v_pendientes > 0 then
    raise exception 'Quedan % deals sin empresa pudiendo tenerla. No se ha cambiado nada.', v_pendientes;
  end if;
end
$b$;


-- ============================================================
-- C1 (verificación) — Recuentos. Deben cuadrar con A1:
--   1 = A1.1;  2 = A1.2;  3 = A1.3;  3a = A1.3a;  3b = A1.3b.
--   5, 6 y 7 deben ser 0 (7 puede no serlo si alguien editó un deal
--   justo en esos minutos).
-- ============================================================
with s as (
  select count(*)                                                        as total,
         count(*) filter (where empresa_id is not null)                  as con_empresa,
         count(*) filter (where empresa_id is null)                      as sin_empresa,
         count(*) filter (where empresa_id is null and contact_id is null) as sin_contacto,
         count(*) filter (where empresa_id is null and contact_id is not null) as contacto_sin_empresa,
         count(*) filter (where empresa_id is distinct from public.empresa_principal_de(contact_id)) as distinta_principal,
         count(*) filter (where empresa_id is not null and not exists (
                            select 1 from public.contacto_empresa ce
                            where ce.contact_id = deals.contact_id and ce.empresa_id = deals.empresa_id))
                                                                         as empresa_ajena,
         count(*) filter (where updated_at > now() - interval '15 minutes') as tocados_15min
  from public.deals
)
select v.orden, v.metrica, v.valor
from s cross join lateral (values
  ('1',  'Deals en total',                                         s.total),
  ('2',  'Con empresa_id',                                         s.con_empresa),
  ('3',  'Con empresa_id NULL',                                    s.sin_empresa),
  ('3a', '  … sin contact_id',                                     s.sin_contacto),
  ('3b', '  … con contacto sin empresa',                           s.contacto_sin_empresa),
  ('5',  'empresa_id distinta de empresa_principal_de(contact_id)', s.distinta_principal),
  ('6',  'empresa_id que no es del contacto',                      s.empresa_ajena),
  ('7',  'updated_at en los últimos 15 min',                       s.tocados_15min)
) as v(orden, metrica, valor)
order by v.orden;


-- ============================================================
-- C2 (verificación) — Muestra de 10 deals con contacto y empresa.
-- Primero los de contactos con varias empresas, que son los delicados.
-- ============================================================
select x.title, x.stage, x.contacto, x.company_del_contacto, x.empresa_del_deal,
       x.vinculo, x.empresas_del_contacto
from (
  select d.title, d.stage, d.created_at,
         c.full_name as contacto,
         c.company   as company_del_contacto,
         e.razon_social as empresa_del_deal,
         case when ce.principal then 'principal'
              when ce.id is not null then 'secundaria'
              else '—' end as vinculo,
         (select count(*) from public.contacto_empresa x where x.contact_id = d.contact_id) as empresas_del_contacto
  from public.deals d
  left join public.contactos c        on c.id = d.contact_id
  left join public.empresas e         on e.id = d.empresa_id
  left join public.contacto_empresa ce on ce.contact_id = d.contact_id and ce.empresa_id = d.empresa_id
) x
order by (x.empresas_del_contacto > 1) desc, x.created_at desc
limit 10;


-- ============================================================
-- C3 (verificación) — Prueba del trigger. Termina SIEMPRE con un error
-- a propósito: es el ROLLBACK. El DO es una sola transacción y el error
-- la deshace entera, así que no queda ningún deal de prueba. Se hace así
-- (y no con BEGIN … ROLLBACK) porque el editor solo enseña el resultado
-- de la última sentencia, y el mensaje del error sí se ve.
-- Lo esperado: "PRUEBA OK — ROLLBACK intencionado …".
-- ============================================================
do $c$
declare
  v_contact  uuid;
  v_esperada uuid;
  v_otra     uuid;
  r_auto     uuid;
  r_explic   uuid;
  r_sin      uuid;
  v_ok       boolean;
begin
  -- Contacto con empresa; si hay alguno con varias, ese.
  select ce.contact_id into v_contact
  from public.contacto_empresa ce
  group by ce.contact_id
  order by count(*) desc, ce.contact_id
  limit 1;
  if v_contact is null then
    raise exception 'PRUEBA NO EJECUTADA: no hay contactos con empresa';
  end if;
  v_esperada := public.empresa_principal_de(v_contact);

  -- 1) Sin empresa_id → el trigger pone la principal
  insert into public.deals (title, contact_id)
  values ('PRUEBA trigger (rollback)', v_contact)
  returning empresa_id into r_auto;

  -- 2) Con empresa_id explícita → se respeta
  select empresa_id into v_otra from public.contacto_empresa
  where contact_id = v_contact and empresa_id <> v_esperada limit 1;
  if v_otra is null then
    select id into v_otra from public.empresas where id <> v_esperada limit 1;
  end if;
  if v_otra is not null then
    insert into public.deals (title, contact_id, empresa_id)
    values ('PRUEBA trigger (rollback)', v_contact, v_otra)
    returning empresa_id into r_explic;
  end if;

  -- 3) Sin contacto → NULL, sin error
  insert into public.deals (title) values ('PRUEBA trigger (rollback)')
  returning empresa_id into r_sin;

  v_ok := r_auto = v_esperada
          and (v_otra is null or r_explic = v_otra)
          and r_sin is null;

  raise exception '% — ROLLBACK intencionado, no se ha guardado nada. 1) sin empresa_id: % (esperada %). 2) explícita: % (esperada %). 3) sin contacto: % (esperada NULL).',
    case when v_ok then 'PRUEBA OK' else 'PRUEBA FALLIDA' end,
    r_auto, v_esperada,
    coalesce(r_explic::text, 'no probada'), coalesce(v_otra::text, '—'),
    coalesce(r_sin::text, 'NULL');
end
$c$;


-- ============================================================
-- C4 (verificación) — Las políticas de deals siguen siendo las cuatro
-- con is_admin() y authenticated tiene permiso sobre la columna nueva.
-- Las políticas RLS son por fila, no por columna: is_admin() cubre
-- empresa_id sin cambiar nada. Los permisos de columna salen del GRANT
-- a nivel de tabla, que incluye las columnas que se añadan después.
-- Lo esperado: 4 políticas con is_admin() y los 4 permisos = true.
-- ============================================================
select 'politica' as tipo,
       p.policyname::text as nombre,
       p.cmd || ' · roles=' || array_to_string(p.roles, ',')
             || ' · using=' || coalesce(p.qual, '—')
             || ' · check=' || coalesce(p.with_check, '—') as detalle
from pg_policies p
where p.schemaname = 'public' and p.tablename = 'deals'
union all
select 'permiso', 'authenticated ' || priv || ' deals.empresa_id',
       has_column_privilege('authenticated', 'public.deals', 'empresa_id', priv)::text
from unnest(array['SELECT', 'INSERT', 'UPDATE']) as priv
union all
select 'permiso', 'authenticated EXECUTE empresa_principal_de',
       has_function_privilege('authenticated', 'public.empresa_principal_de(uuid)', 'EXECUTE')::text
order by 1, 2;


-- ============================================================
-- D (LIMPIEZA, opcional e independiente) — Borra "Por definir" solo si
-- está vacía. Ejecutar después de B (cuenta deals.empresa_id).
--
-- Vacía = sin contactos en contacto_empresa, sin documentos, sin deals,
-- y sus únicas carpetas son de serie: raíz, sin system_key y con nombre
-- Fiscal, Laboral, Mercantil o Contratos (las que siembra
-- sembrar_carpetas_por_defecto; si alguien borró una, sigue valiendo).
-- "Sin documentos en las carpetas" y "sin subcarpetas" quedan cubiertos:
-- un documento de sus carpetas es de la empresa (FK compuesta de
-- documentos) y una subcarpeta no es raíz, así que no es de serie.
--
-- Si hay varias "Por definir" y alguna no está vacía, no se borra
-- ninguna. Todo en un único DO: o se borra todo o nada.
--
-- Cómo leer el resultado:
--   - "Success. No rows returned" → borradas (comprueba con A3: 0 filas).
--   - Error "NO SE BORRA: …" → dice qué tiene; no se ha cambiado nada.
--   - Error "NADA QUE HACER: …" → no existe; no se ha cambiado nada.
--   Los dos últimos son errores a propósito: es la forma de que el
--   mensaje se vea en el editor.
-- ============================================================
do $d$
declare
  r            record;
  n_contactos  bigint;
  n_documentos bigint;
  n_deals      bigint;
  v_otras      text;
  v_tiene      text;
  v_borrar     uuid[] := '{}';
  v_motivos    text[] := '{}';
begin
  for r in
    select e.id, e.razon_social
    from public.empresas e
    where lower(btrim(e.razon_social)) = 'por definir'
    order by e.created_at, e.id
    for update
  loop
    select count(*) into n_contactos  from public.contacto_empresa ce where ce.empresa_id = r.id;
    select count(*) into n_documentos from public.documentos d       where d.empresa_id  = r.id;
    select count(*) into n_deals      from public.deals d            where d.empresa_id  = r.id;
    select string_agg(format('"%s"%s', c.nombre,
                             case when c.parent_id is not null then ' (subcarpeta)'
                                  when c.system_key is not null then ' (' || c.system_key || ')'
                                  else '' end), ', ' order by c.nombre)
      into v_otras
    from public.carpetas c
    where c.empresa_id = r.id
      and not (c.parent_id is null and c.system_key is null
               and c.nombre in ('Fiscal', 'Laboral', 'Mercantil', 'Contratos'));

    v_tiene := concat_ws('; ',
      case when n_contactos  > 0 then n_contactos  || ' contacto(s)' end,
      case when n_documentos > 0 then n_documentos || ' documento(s)' end,
      case when n_deals      > 0 then n_deals      || ' deal(s)' end,
      case when v_otras is not null then 'carpetas que no son de serie: ' || v_otras end);

    if v_tiene = '' then
      v_borrar := v_borrar || r.id;
    else
      v_motivos := v_motivos || format('%s [%s] tiene %s', r.razon_social, r.id, v_tiene);
    end if;
  end loop;

  if cardinality(v_borrar) = 0 and cardinality(v_motivos) = 0 then
    raise exception 'NADA QUE HACER: no existe ninguna empresa "Por definir". No se ha cambiado nada.';
  end if;
  if cardinality(v_motivos) > 0 then
    raise exception 'NO SE BORRA: %. No se ha cambiado nada.', array_to_string(v_motivos, ' | ');
  end if;

  -- Primero sus carpetas de serie (pasan por carpetas_proteger: sin
  -- documentos ni subcarpetas, no objeta), después la empresa.
  delete from public.carpetas where empresa_id = any (v_borrar);
  delete from public.empresas where id = any (v_borrar);
end
$d$;


