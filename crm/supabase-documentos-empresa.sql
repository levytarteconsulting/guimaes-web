-- ============================================================
-- GUIMAES — Migración: documentos y carpetas pasan del CONTACTO a la EMPRESA
--
-- La documentación de una asesoría es de la sociedad, no de la persona
-- que la aporta. Antes: carpetas.contact_id y documentos.contact_id, con
-- FK compuesta (folder_id, contact_id). Después: carpetas.empresa_id y
-- documentos.empresa_id, con FK compuesta (folder_id, empresa_id), y
-- documentos.contact_id como "quién lo aportó" (ver crm/supabase-carpetas.sql).
--
-- Empresa destino de cada contacto: la principal; si no tiene ninguna
-- marcada, la enlazada más antigua (mismo criterio que
-- resolve_contacto_company y que public.empresa_principal_de).
--
-- Fusión: varios contactos de la misma empresa tienen hoy cada uno su
-- "Fiscal", "Laboral"... Por cada empresa y nombre normalizado (minúsculas,
-- sin espacios en los extremos — el mismo criterio que el índice único)
-- sobrevive la carpeta más antigua; los documentos de las demás se
-- reapuntan a ella y las demás se borran. Ningún documento se borra ni
-- cambia de fichero: solo cambian folder_id y empresa_id.
--
-- SIN TABLAS TEMPORALES A PROPÓSITO: el SQL Editor de Supabase va detrás
-- de un pooler en modo transacción. El cambio de verdad es un único
-- bloque DO (BLOQUE B): una sentencia, una transacción, una conexión.
--
-- ORDEN — cada paso a mano y por separado en el SQL Editor:
--   1. BLOQUE A (solo lectura). Revísalo.
--   2. BLOQUE B (el DO). Cambia estructura y datos y deja DESACTIVADOS los
--      triggers que dependían del modelo antiguo.
--   3. crm/supabase-carpetas.sql entero: crea las funciones y triggers del
--      modelo nuevo (y los vuelve a activar).
--   4. BLOQUE B2: siembra las empresas sin carpetas y coloca los adjuntos
--      de WhatsApp que hayan entrado entre el paso 2 y el 3.
--   5. BLOQUE C (solo lectura). Verificación.
-- Entre el paso 2 y el 3 el webhook sigue guardando adjuntos (sin
-- empresa ni carpeta, nada se pierde) y los RPCs de carpetas fallan con
-- error: conviene hacer 2 y 3 seguidos.
--
-- Requiere: crm/supabase-empresas.sql y el modelo anterior de
-- crm/supabase-carpetas.sql (carpetas por contacto) ya aplicado.
-- ============================================================

-- ============================================================
-- BLOQUE A — Revisión (no escribe nada)
-- ============================================================

-- A1) Empresas "Por definir" con más de un contacto. Debe salir vacío: si
-- no, sus contactos (sin relación entre sí) acabarían compartiendo
-- carpetas y documentos. El BLOQUE B se niega a seguir si sale algo.
select e.id, e.razon_social, count(*) as contactos
from public.empresas e
join public.contacto_empresa ce on ce.empresa_id = e.id
where lower(btrim(e.razon_social)) = 'por definir'
group by e.id, e.razon_social
having count(*) > 1;

-- A2) Contactos con documentos y MÁS DE UNA empresa: todos sus documentos
-- irán a la empresa destino. Revísalos: si alguno es de otra sociedad, se
-- mueve después con mover_documentos (la carpeta destino decide la empresa).
with destino as (
  select distinct on (contact_id) contact_id, empresa_id
  from public.contacto_empresa
  order by contact_id, principal desc, created_at asc, id
)
select c.id as contact_id, c.full_name, count(distinct ce.empresa_id) as empresas,
       (select count(*) from public.documentos d where d.contact_id = c.id) as documentos,
       e.razon_social as empresa_destino
from public.contactos c
join public.contacto_empresa ce on ce.contact_id = c.id
join destino de on de.contact_id = c.id
join public.empresas e on e.id = de.empresa_id
where exists (select 1 from public.documentos d where d.contact_id = c.id)
group by c.id, c.full_name, e.razon_social
having count(distinct ce.empresa_id) > 1
order by c.full_name;

-- A3) Contactos con documentos y SIN empresa. Debe salir vacío (todo
-- contacto tiene empresa); si sale algo, el BLOQUE B se niega.
select d.contact_id, count(*) as documentos
from public.documentos d
where d.contact_id is not null
  and not exists (select 1 from public.contacto_empresa ce where ce.contact_id = d.contact_id)
group by d.contact_id;

-- A4) Carpetas que se fusionarán: mismo nombre normalizado en la misma
-- empresa destino, con cuántos documentos entre todas.
with destino as (
  select distinct on (contact_id) contact_id, empresa_id
  from public.contacto_empresa
  order by contact_id, principal desc, created_at asc, id
)
select e.razon_social as empresa, lower(btrim(k.nombre)) as carpeta,
       count(*) as carpetas_a_fusionar,
       (select count(*) from public.documentos d where d.folder_id = any(array_agg(k.id))) as documentos
from public.carpetas k
join destino de on de.contact_id = k.contact_id
join public.empresas e on e.id = de.empresa_id
group by e.razon_social, lower(btrim(k.nombre))
having count(*) > 1
order by 1, 2;

-- A5) Totales de referencia: el BLOQUE B comprueba que no cambian, y el
-- BLOQUE C los repite.
select count(*) as documentos,
       count(folder_id) as con_carpeta,
       count(contact_id) as con_contacto
from public.documentos;

-- ============================================================
-- BLOQUE B — La migración (un único DO, atómico)
-- ============================================================
do $$
declare
  v_docs_antes int;
  v_con_carpeta_antes int;
  v_con_contacto_antes int;
  v_docs_despues int;
  v_con_carpeta_despues int;
  v_con_contacto_despues int;
begin
  -- Ya migrado: nada que hacer.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'carpetas' and column_name = 'contact_id') then
    raise notice 'carpetas ya cuelga de empresas: migración ya aplicada, nada que hacer.';
    return;
  end if;

  -- Salvaguardas (A1 y A3).
  if exists (select 1 from public.empresas e
             join public.contacto_empresa ce on ce.empresa_id = e.id
             where lower(btrim(e.razon_social)) = 'por definir'
             group by e.id having count(*) > 1) then
    raise exception 'Hay una empresa "Por definir" con varios contactos: sepárala antes (ver BLOQUE A1).';
  end if;
  if exists (select 1 from public.documentos d
             where d.contact_id is not null
               and not exists (select 1 from public.contacto_empresa ce where ce.contact_id = d.contact_id)) then
    raise exception 'Hay documentos de contactos sin empresa (ver BLOQUE A3): asígnales una empresa antes.';
  end if;

  select count(*), count(folder_id), count(contact_id)
    into v_docs_antes, v_con_carpeta_antes, v_con_contacto_antes
  from public.documentos;

  -- Los triggers del modelo antiguo estorban (impiden cambiar la carpeta
  -- de dueño, recolocan documentos al tocarlos) y sus funciones dejan de
  -- tener sentido. Se desactivan aquí y supabase-carpetas.sql los recrea.
  alter table public.carpetas disable trigger carpetas_proteger;
  alter table public.documentos disable trigger documentos_resolver_carpeta;

  -- Funciones y trigger del modelo antiguo cuya firma cambia (el
  -- parámetro pasa de p_contact_id a p_empresa_id, y create or replace no
  -- puede renombrar parámetros) o que desaparecen.
  drop trigger if exists contactos_sembrar_carpetas on public.contactos;
  drop function if exists public.contactos_sembrar_carpetas();
  drop function if exists public.sembrar_carpetas_por_defecto(uuid);
  drop function if exists public.carpeta_whatsapp(uuid);

  -- 1) Soltar la FK compuesta antigua (folder_id, contact_id).
  alter table public.documentos drop constraint if exists documentos_carpeta_fkey;

  -- 2) Cada carpeta pasa a la empresa destino de su contacto.
  alter table public.carpetas add column empresa_id uuid;
  update public.carpetas k
  set empresa_id = de.empresa_id
  from (select distinct on (contact_id) contact_id, empresa_id
        from public.contacto_empresa
        order by contact_id, principal desc, created_at asc, id) de
  where de.contact_id = k.contact_id;

  -- Carpetas de contactos sin empresa: solo pueden estar vacías (los
  -- documentos de su contacto habrían parado la migración arriba, y la FK
  -- compuesta antigua garantizaba que una carpeta solo contenía
  -- documentos de su contacto). Se descartan.
  delete from public.carpetas where empresa_id is null;

  -- 3) Cada documento, a la empresa de su carpeta (= la empresa destino de
  -- su contacto). Los adjuntos sin contacto no tienen carpeta: se quedan
  -- sin empresa.
  alter table public.documentos add column if not exists empresa_id uuid;
  update public.documentos d
  set empresa_id = k.empresa_id
  from public.carpetas k
  where k.id = d.folder_id;

  -- 4) Fusionar duplicados: por empresa y nombre normalizado sobrevive la
  -- más antigua. El check de "WhatsApp reservado" garantiza que el nombre
  -- normalizado 'whatsapp' es siempre la carpeta de sistema, así que las
  -- WhatsApp de varios contactos se fusionan en una sola por empresa.
  update public.documentos d
  set folder_id = r.superviviente
  from (select id,
               first_value(id) over (partition by empresa_id, lower(btrim(nombre)) order by created_at, id) as superviviente
        from public.carpetas) r
  where d.folder_id = r.id and r.id <> r.superviviente;

  delete from public.carpetas k
  using (select id,
                first_value(id) over (partition by empresa_id, lower(btrim(nombre)) order by created_at, id) as superviviente
         from public.carpetas) r
  where k.id = r.id and r.id <> r.superviviente;

  -- 5) Esquema nuevo de carpetas.
  alter table public.carpetas drop constraint if exists carpetas_id_contact_key;
  drop index if exists public.carpetas_contact_nombre_key;
  drop index if exists public.carpetas_contact_system_key;
  alter table public.carpetas drop column contact_id;
  alter table public.carpetas alter column empresa_id set not null;
  alter table public.carpetas add constraint carpetas_empresa_id_fkey
    foreign key (empresa_id) references public.empresas(id) on delete cascade;
  alter table public.carpetas add constraint carpetas_id_empresa_key unique (id, empresa_id);
  create unique index carpetas_empresa_nombre_key
    on public.carpetas (empresa_id, lower(btrim(nombre)));
  create unique index carpetas_empresa_system_key
    on public.carpetas (empresa_id, system_key) where system_key is not null;

  -- 6) Esquema nuevo de documentos. Las FKs se validan aquí mismo sobre
  -- los datos ya migrados: si algún documento quedara en una carpeta de
  -- otra empresa, el DO entero se deshace.
  alter table public.documentos add constraint documentos_empresa_fkey
    foreign key (empresa_id) references public.empresas(id) on delete restrict;
  alter table public.documentos add constraint documentos_carpeta_fkey
    foreign key (folder_id, empresa_id) references public.carpetas (id, empresa_id)
    on delete set null (folder_id);
  drop index if exists public.documentos_contact_folder_id_idx;
  create index if not exists documentos_empresa_folder_idx on public.documentos (empresa_id, folder_id);
  create index if not exists documentos_contact_idx on public.documentos (contact_id);

  -- 7) Comprobación final: los mismos documentos, con las mismas carpetas
  -- y los mismos contactos (contact_id no se toca: ahora es "quién lo
  -- aportó"); y la regla empresa ⇔ carpeta cumplida.
  select count(*), count(folder_id), count(contact_id)
    into v_docs_despues, v_con_carpeta_despues, v_con_contacto_despues
  from public.documentos;

  if v_docs_despues <> v_docs_antes
     or v_con_carpeta_despues <> v_con_carpeta_antes
     or v_con_contacto_despues <> v_con_contacto_antes then
    raise exception 'Los totales no cuadran (documentos %→%, con carpeta %→%, con contacto %→%): no se aplica nada.',
      v_docs_antes, v_docs_despues, v_con_carpeta_antes, v_con_carpeta_despues, v_con_contacto_antes, v_con_contacto_despues;
  end if;
  if exists (select 1 from public.documentos where (empresa_id is null) <> (folder_id is null)) then
    raise exception 'Queda algún documento con empresa y sin carpeta (o al revés): no se aplica nada.';
  end if;

  raise notice 'Migración aplicada: % documentos, % con carpeta. Ejecuta ahora crm/supabase-carpetas.sql y después el BLOQUE B2.',
    v_docs_despues, v_con_carpeta_despues;
end;
$$;

-- ============================================================
-- BLOQUE B2 — Completar (ejecutar DESPUÉS de crm/supabase-carpetas.sql)
-- Idempotente: se puede repetir.
-- ============================================================

-- B2.1) Juego por defecto para las empresas que no tengan ninguna carpeta
-- (empresas cuyos contactos tenían otra como principal, o creadas en la
-- Fase 4 sin documentos). Las que ya recibieron carpetas fusionadas se
-- dejan como están: si un admin borró alguna de las de serie, no se recrea.
select public.sembrar_carpetas_por_defecto(e.id)
from public.empresas e
where not exists (select 1 from public.carpetas k where k.empresa_id = e.id);

-- B2.2) Adjuntos de WhatsApp que entraron entre el BLOQUE B y
-- supabase-carpetas.sql: con contacto y sin empresa. Al ponerles empresa,
-- el trigger documentos_resolver_carpeta los coloca en la carpeta WhatsApp
-- de esa empresa.
update public.documentos d
set empresa_id = public.empresa_principal_de(d.contact_id)
where d.source = 'whatsapp' and d.contact_id is not null and d.empresa_id is null
  and public.empresa_principal_de(d.contact_id) is not null;

-- ============================================================
-- BLOQUE C — Verificación (no escribe nada)
-- ============================================================

-- C1) Totales: deben coincidir con A5 (más los adjuntos que hayan entrado
-- entre medias).
select count(*) as documentos,
       count(folder_id) as con_carpeta,
       count(contact_id) as con_contacto,
       count(empresa_id) as con_empresa
from public.documentos;

-- C2) La regla empresa ⇔ carpeta, y que cada carpeta es de la empresa de
-- su documento (la FK lo impide; esto lo enseña). Todo a 0.
select
  count(*) filter (where empresa_id is not null and folder_id is null) as empresa_sin_carpeta,
  count(*) filter (where empresa_id is null and folder_id is not null) as carpeta_sin_empresa,
  (select count(*) from public.documentos d join public.carpetas k on k.id = d.folder_id
   where k.empresa_id is distinct from d.empresa_id) as carpeta_de_otra_empresa
from public.documentos;

-- C3) Adjuntos de WhatsApp con contacto vinculado y sin empresa: solo
-- pueden ser de contactos sin empresa. Debe salir vacío.
select d.id, d.contact_id, d.created_at
from public.documentos d
where d.source = 'whatsapp' and d.contact_id is not null and d.empresa_id is null;

-- C4) Empresas sin ninguna carpeta. Debe salir vacío.
select e.id, e.razon_social
from public.empresas e
where not exists (select 1 from public.carpetas k where k.empresa_id = e.id);

-- C5) Carpetas duplicadas por empresa (el índice único lo impide; esto lo
-- enseña). Debe salir vacío.
select empresa_id, lower(btrim(nombre)) as nombre, count(*)
from public.carpetas
group by 1, 2 having count(*) > 1;

-- C6) Ya no queda nada del modelo antiguo. Las dos deben salir vacías.
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'carpetas' and column_name = 'contact_id';
select tgname from pg_trigger where tgname = 'contactos_sembrar_carpetas';
