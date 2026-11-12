-- ============================================================
-- GUIMAES — Correo de info@guimaes.es en el CRM (parte 1: esquema)
--
-- La Edge Function "correo" (crm/supabase-functions/correo/) copia aquí los
-- mensajes de la bandeja de entrada y de Elementos enviados de
-- info@guimaes.es (Microsoft Graph, delta query) y envía/responde desde el
-- CRM. Esta migración solo crea el esquema; el job de pg_cron va en una
-- migración aparte (crm/supabase-correo-cron.sql), cuando la función ya
-- esté desplegada.
--
-- Qué crea:
--   * correo_mensajes: un mensaje de Graph por fila (graph_id único).
--       - carpeta: 'inbox' o 'sentitems'.
--       - para / cc / cco: jsonb, lista de {email, nombre}.
--       - cuerpo_html: HTML ya saneado por la Edge Function.
--       - fuera_bandeja (+ fuera_bandeja_at): Graph lo ha quitado de la
--         carpeta (@removed en el delta: borrado o movido). La fila no se
--         borra: se oculta de la bandeja, pero sigue en las fichas de
--         contacto y empresa. Si vuelve a aparecer en el delta, la función
--         la desmarca.
--       - emails_norm: emails de remitente y destinatarios normalizados
--         (lower(btrim())), sin el buzón; lo rellena el trigger.
--       - contact_id / empresa_id: vínculo automático (ver abajo).
--       - enviado_por: usuario del CRM que lo envió desde el CRM.
--   * correo_adjuntos: solo metadatos (los ficheros no se guardan; la
--     función los descarga de Graph bajo demanda).
--   * correo_sync: estado de la sincronización por carpeta (deltaLink,
--     nextLink para reanudar una importación cortada, reserva para que dos
--     ejecuciones no se pisen, último error).
--   * Vinculación automática por email normalizado (misma expresión que el
--     índice contactos_email_norm_idx):
--       - al insertar un mensaje (o cambiar sus direcciones) sin contacto:
--         primer email de la lista (inbox: remitente, para, cc; enviados:
--         para, cc, cco) que coincida con un contacto. Entre varios
--         contactos con el mismo email: el no provisional y más antiguo.
--         La empresa es la principal del contacto (contacto_empresa).
--       - al crear un contacto o cambiarle el email: se vinculan los
--         mensajes sin contacto que tengan ese email.
--       - al dar a un contacto una empresa (contacto_empresa): sus
--         mensajes sin empresa toman esa empresa.
--     Nunca se cambia un vínculo ya hecho.
--   * correo_sync_reservar(carpeta, segundos): reserva atómica para la
--     función (solo service_role).
--   * RLS: los usuarios del CRM (is_admin()) solo leen. Toda escritura
--     (incluido marcar leído, que también va a Outlook) pasa por la Edge
--     Function con la service role. De correo_sync el cliente solo ve las
--     columnas de estado, no los enlaces de Graph.
--   * Registro en supabase_migrations.schema_migrations y notify pgrst.
--
-- Requiere: admins (is_admin), contactos, empresas, contacto_empresa,
-- set_updated_at, supabase_migrations.schema_migrations.
--
-- Orden: 1A → copia (pg_dump) → 1B → 1C → 1D (prueba con rollback).
-- 1A y 1C son solo lectura; 1B es un único DO atómico que se niega a
-- ejecutarse dos veces; 1D escribe dentro de una transacción que se deshace.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado:
--   función is_admin, set_updated_at: sí
--   tablas contactos, empresas, contacto_empresa, admins: sí
--   índice contactos_email_norm_idx: sí
--   schema_migrations: existe
--   tablas correo*: 0 · funciones correo*: 0 · triggers correo*: 0
-- ============================================================
select 'función ' || x.n as comprobacion,
       case when exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                         where s.nspname = 'public' and p.proname = x.n) then 'sí' else 'NO' end as valor
from (values ('is_admin'), ('set_updated_at')) x(n)
union all
select 'tabla ' || x.n,
       case when to_regclass('public.' || x.n) is not null then 'sí' else 'NO' end
from (values ('contactos'), ('empresas'), ('contacto_empresa'), ('admins')) x(n)
union all
select 'índice contactos_email_norm_idx',
       case when to_regclass('public.contactos_email_norm_idx') is not null then 'sí' else 'NO' end
union all
select 'supabase_migrations.schema_migrations',
       case when to_regclass('supabase_migrations.schema_migrations') is null then 'NO EXISTE' else 'existe' end
union all
select 'tablas correo*', count(*)::text from pg_tables where schemaname = 'public' and tablename like 'correo%'
union all
select 'funciones correo*', count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname like 'correo%'
union all
select 'triggers correo*', count(*)::text from pg_trigger where tgname like 'correo%' and not tgisinternal;


-- ============================================================
-- 1B (CAMBIO) — Un único DO; se niega a ejecutarse dos veces. Después,
-- notify pgrst (psql con ON_ERROR_STOP=1 se para antes si el DO falla).
-- ============================================================
do $b1$
begin
  if to_regclass('public.correo_mensajes') is not null then
    raise exception 'public.correo_mensajes ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261112120000') then
    raise exception 'La migración 20261112120000 ya está registrada. No se ha cambiado nada.';
  end if;

  -- ===================== tablas =====================
  create table public.correo_mensajes (
    id                 uuid primary key default gen_random_uuid(),
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    graph_id           text not null,
    internet_message_id text,
    conversation_id    text,
    carpeta            text not null,
    remitente_email    text,
    remitente_nombre   text,
    para               jsonb not null default '[]'::jsonb,
    cc                 jsonb not null default '[]'::jsonb,
    cco                jsonb not null default '[]'::jsonb,
    asunto             text not null default '',
    extracto           text not null default '',
    cuerpo_html        text not null default '',
    fecha              timestamptz not null,
    leido              boolean not null default false,
    tiene_adjuntos     boolean not null default false,
    fuera_bandeja      boolean not null default false,
    fuera_bandeja_at   timestamptz,
    emails_norm        text[] not null default '{}',
    contact_id         uuid references public.contactos(id) on delete set null,
    empresa_id         uuid references public.empresas(id) on delete set null,
    enviado_por        uuid references public.admins(id) on delete set null,
    constraint correo_mensajes_graph_id_key unique (graph_id),
    constraint correo_mensajes_carpeta_chk check (carpeta in ('inbox', 'sentitems')),
    constraint correo_mensajes_fuera_chk check (fuera_bandeja = (fuera_bandeja_at is not null)),
    constraint correo_mensajes_listas_chk check (jsonb_typeof(para) = 'array'
                                                 and jsonb_typeof(cc) = 'array'
                                                 and jsonb_typeof(cco) = 'array')
  );
  create index correo_mensajes_bandeja_idx on public.correo_mensajes (carpeta, fecha desc) where not fuera_bandeja;
  create index correo_mensajes_conversacion_idx on public.correo_mensajes (conversation_id, fecha);
  create index correo_mensajes_contacto_idx on public.correo_mensajes (contact_id, fecha desc) where contact_id is not null;
  create index correo_mensajes_empresa_idx on public.correo_mensajes (empresa_id, fecha desc) where empresa_id is not null;
  create index correo_mensajes_sin_vincular_idx on public.correo_mensajes (fecha desc) where contact_id is null;
  create index correo_mensajes_emails_idx on public.correo_mensajes using gin (emails_norm);

  create table public.correo_adjuntos (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    mensaje_id  uuid not null references public.correo_mensajes(id) on delete cascade,
    graph_id    text not null,
    nombre      text not null default '',
    tipo        text,
    tamano      bigint,
    inline      boolean not null default false,
    content_id  text,
    constraint correo_adjuntos_mensaje_graph_key unique (mensaje_id, graph_id)
  );

  create table public.correo_sync (
    carpeta           text primary key,
    updated_at        timestamptz not null default now(),
    delta_link        text,          -- solo cuando se han procesado todas las páginas
    next_link         text,          -- página pendiente de una ronda cortada
    importacion_desde timestamptz,   -- límite de la importación inicial (90 días)
    reservado_hasta   timestamptz,
    ultima_ejecucion  timestamptz,
    ultimo_ok         timestamptz,
    ultimo_error      text,
    constraint correo_sync_carpeta_chk check (carpeta in ('inbox', 'sentitems'))
  );
  insert into public.correo_sync (carpeta) values ('inbox'), ('sentitems');

  -- ===================== funciones =====================
  create function public.correo_norm(p text)
  returns text language sql immutable as $f$
    select nullif(lower(btrim(p)), '')
  $f$;

  -- Emails de una lista jsonb [{email, nombre}], normalizados y en orden.
  create function public.correo_emails_de(p jsonb)
  returns text[] language sql immutable as $f$
    select coalesce(array_agg(public.correo_norm(e->>'email') order by o), '{}')
    from jsonb_array_elements(coalesce(p, '[]'::jsonb)) with ordinality as x(e, o)
    where public.correo_norm(e->>'email') is not null
  $f$;

  -- Contacto para un email: el no provisional y más antiguo.
  create function public.correo_contacto_de(p_email text)
  returns uuid language sql stable security definer set search_path = public as $f$
    select c.id from public.contactos c
    where lower(btrim(c.email)) = p_email
    order by (c.provisional_at is not null), c.created_at, c.id
    limit 1
  $f$;

  -- Empresa de un contacto: la principal; si no hay, la primera vinculada.
  create function public.correo_empresa_de(p_contact uuid)
  returns uuid language sql stable security definer set search_path = public as $f$
    select ce.empresa_id from public.contacto_empresa ce
    where ce.contact_id = p_contact
    order by ce.principal desc, ce.created_at, ce.empresa_id
    limit 1
  $f$;

  -- BEFORE INSERT/UPDATE en correo_mensajes: emails_norm y vínculo.
  create function public.correo_mensajes_vincular()
  returns trigger language plpgsql security definer set search_path = public as $f$
  declare
    v_lista text[];
    v_email text;
    v_contacto uuid;
  begin
    if tg_op = 'INSERT'
       or new.remitente_email is distinct from old.remitente_email
       or new.para is distinct from old.para
       or new.cc is distinct from old.cc
       or new.cco is distinct from old.cco
       or new.carpeta is distinct from old.carpeta then
      if new.carpeta = 'inbox' then
        v_lista := array_remove(array[public.correo_norm(new.remitente_email)], null)
                   || public.correo_emails_de(new.para) || public.correo_emails_de(new.cc);
      else
        v_lista := public.correo_emails_de(new.para) || public.correo_emails_de(new.cc)
                   || public.correo_emails_de(new.cco);
      end if;
      -- Sin duplicados (manteniendo el orden) y sin el propio buzón.
      select coalesce(array_agg(e order by o), '{}') into new.emails_norm
      from (select e, min(o) as o from unnest(v_lista) with ordinality as u(e, o)
            where e <> 'info@guimaes.es' group by e) d;
    end if;

    if new.contact_id is null then
      foreach v_email in array new.emails_norm loop
        v_contacto := public.correo_contacto_de(v_email);
        if v_contacto is not null then
          new.contact_id := v_contacto;
          exit;
        end if;
      end loop;
    end if;
    if new.contact_id is not null and new.empresa_id is null then
      new.empresa_id := public.correo_empresa_de(new.contact_id);
    end if;
    return new;
  end
  $f$;

  -- AFTER INSERT / UPDATE OF email en contactos: vincular mensajes sueltos.
  create function public.correo_contactos_vincular()
  returns trigger language plpgsql security definer set search_path = public as $f$
  declare
    v_email text := public.correo_norm(new.email);
  begin
    if v_email is null then return null; end if;
    if tg_op = 'UPDATE' and v_email is not distinct from public.correo_norm(old.email) then
      return null;
    end if;
    -- Si hay varios contactos con ese email, manda el criterio de siempre.
    if public.correo_contacto_de(v_email) is distinct from new.id then return null; end if;
    update public.correo_mensajes m
       set contact_id = new.id,
           empresa_id = coalesce(m.empresa_id, public.correo_empresa_de(new.id))
     where m.contact_id is null and m.emails_norm @> array[v_email];
    return null;
  end
  $f$;

  -- AFTER INSERT / UPDATE en contacto_empresa: empresa para mensajes sin ella.
  create function public.correo_contacto_empresa_vincular()
  returns trigger language plpgsql security definer set search_path = public as $f$
  begin
    update public.correo_mensajes m
       set empresa_id = public.correo_empresa_de(new.contact_id)
     where m.contact_id = new.contact_id and m.empresa_id is null;
    return null;
  end
  $f$;

  -- Reserva atómica de una carpeta para una ejecución de la función.
  create function public.correo_sync_reservar(p_carpeta text, p_segundos integer)
  returns boolean language sql volatile security definer set search_path = public as $f$
    with r as (
      update public.correo_sync
         set reservado_hasta = now() + make_interval(secs => p_segundos),
             ultima_ejecucion = now(), updated_at = now()
       where carpeta = p_carpeta
         and (reservado_hasta is null or reservado_hasta < now())
      returning 1
    )
    select exists (select 1 from r)
  $f$;

  -- ===================== triggers =====================
  create trigger correo_mensajes_vincular
    before insert or update on public.correo_mensajes
    for each row execute function public.correo_mensajes_vincular();
  create trigger correo_mensajes_set_updated_at
    before update on public.correo_mensajes
    for each row execute function public.set_updated_at();
  create trigger correo_sync_set_updated_at
    before update on public.correo_sync
    for each row execute function public.set_updated_at();
  create trigger correo_contactos_vincular
    after insert or update of email on public.contactos
    for each row execute function public.correo_contactos_vincular();
  create trigger correo_contacto_empresa_vincular
    after insert or update on public.contacto_empresa
    for each row execute function public.correo_contacto_empresa_vincular();

  -- ===================== RLS y permisos =====================
  alter table public.correo_mensajes enable row level security;
  alter table public.correo_adjuntos enable row level security;
  alter table public.correo_sync     enable row level security;

  create policy "usuarios CRM leen correo_mensajes" on public.correo_mensajes
    for select to authenticated using ((select public.is_admin()));
  create policy "usuarios CRM leen correo_adjuntos" on public.correo_adjuntos
    for select to authenticated using ((select public.is_admin()));
  create policy "usuarios CRM leen correo_sync" on public.correo_sync
    for select to authenticated using ((select public.is_admin()));

  revoke all on public.correo_mensajes, public.correo_adjuntos, public.correo_sync from public, anon, authenticated;
  grant select on public.correo_mensajes, public.correo_adjuntos to authenticated;
  grant select (carpeta, updated_at, importacion_desde, ultima_ejecucion, ultimo_ok, ultimo_error)
    on public.correo_sync to authenticated;
  grant all on public.correo_mensajes, public.correo_adjuntos, public.correo_sync to service_role;

  revoke all on function public.correo_norm(text)                  from public, anon;
  revoke all on function public.correo_emails_de(jsonb)            from public, anon;
  revoke all on function public.correo_contacto_de(text)           from public, anon, authenticated;
  revoke all on function public.correo_empresa_de(uuid)            from public, anon, authenticated;
  revoke all on function public.correo_mensajes_vincular()         from public, anon, authenticated, service_role;
  revoke all on function public.correo_contactos_vincular()        from public, anon, authenticated, service_role;
  revoke all on function public.correo_contacto_empresa_vincular() from public, anon, authenticated, service_role;
  revoke all on function public.correo_sync_reservar(text, integer) from public, anon, authenticated;
  grant execute on function public.correo_norm(text)               to authenticated, service_role;
  grant execute on function public.correo_emails_de(jsonb)         to authenticated, service_role;
  grant execute on function public.correo_contacto_de(text)        to service_role;
  grant execute on function public.correo_empresa_de(uuid)         to service_role;
  grant execute on function public.correo_sync_reservar(text, integer) to service_role;

  -- ===================== registro =====================
  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261112120000', null, 'correo (crm/supabase-correo.sql)');
end
$b1$;

notify pgrst, 'reload schema';


-- ============================================================
-- 1C (verificación, solo lectura) — Lo esperado en la columna valor:
--   tablas: 3 · RLS activada: 3 · políticas: 3
--   filas correo_sync: inbox, sentitems · mensajes: 0 · adjuntos: 0
--   triggers: 5 · funciones correo*: 8
--   authenticated: select en mensajes/adjuntos sí, insert/update/delete no;
--     correo_sync.delta_link/next_link no; ultimo_error sí
--   anon: select en mensajes no
--   correo_sync_reservar: authenticated no, service_role sí
--   migración registrada: 20261112120000
-- ============================================================
select 'tablas' as comprobacion, count(*)::text as valor
from pg_tables where schemaname = 'public' and tablename in ('correo_mensajes', 'correo_adjuntos', 'correo_sync')
union all
select 'RLS activada', count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relrowsecurity and c.relname in ('correo_mensajes', 'correo_adjuntos', 'correo_sync')
union all
select 'políticas', count(*)::text from pg_policies where schemaname = 'public' and tablename like 'correo%'
union all
select 'filas correo_sync', string_agg(carpeta, ', ' order by carpeta) from public.correo_sync
union all
select 'mensajes', count(*)::text from public.correo_mensajes
union all
select 'adjuntos', count(*)::text from public.correo_adjuntos
union all
select 'triggers', count(*)::text from pg_trigger where tgname like 'correo%' and not tgisinternal
union all
select 'funciones correo*', count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname like 'correo%'
union all
select 'authenticated mensajes s/i/u/d',
       has_table_privilege('authenticated', 'public.correo_mensajes', 'SELECT') || '/'
       || has_table_privilege('authenticated', 'public.correo_mensajes', 'INSERT') || '/'
       || has_table_privilege('authenticated', 'public.correo_mensajes', 'UPDATE') || '/'
       || has_table_privilege('authenticated', 'public.correo_mensajes', 'DELETE')
union all
select 'authenticated adjuntos s/i', has_table_privilege('authenticated', 'public.correo_adjuntos', 'SELECT') || '/'
       || has_table_privilege('authenticated', 'public.correo_adjuntos', 'INSERT')
union all
select 'authenticated correo_sync delta_link/next_link/ultimo_error',
       has_column_privilege('authenticated', 'public.correo_sync', 'delta_link', 'SELECT') || '/'
       || has_column_privilege('authenticated', 'public.correo_sync', 'next_link', 'SELECT') || '/'
       || has_column_privilege('authenticated', 'public.correo_sync', 'ultimo_error', 'SELECT')
union all
select 'anon mensajes select', has_table_privilege('anon', 'public.correo_mensajes', 'SELECT')::text
union all
select 'correo_sync_reservar authenticated/service_role',
       has_function_privilege('authenticated', 'public.correo_sync_reservar(text, integer)', 'EXECUTE') || '/'
       || has_function_privilege('service_role', 'public.correo_sync_reservar(text, integer)', 'EXECUTE')
union all
select 'migración registrada', string_agg(version || ' ' || name, ', ')
from supabase_migrations.schema_migrations where version = '20261112120000';


-- ============================================================
-- 1D (prueba de vinculación; todo se deshace con rollback) — Como
-- service_role: inserta un contacto y una empresa de prueba con un email
-- inventado (@ejemplo.invalid), mensajes de prueba, y comprueba el vínculo
-- en los dos sentidos y que @removed solo marca. No toca Graph ni avisa a
-- nadie (no hay triggers de aviso sobre estas tablas ni sobre contactos).
-- Lo esperado: todas las filas con ok = true.
-- ============================================================
begin;
create temp table correo_prueba (paso text, ok boolean) on commit drop;
grant all on correo_prueba to service_role;
set local role service_role;
do $d$
declare
  v_c uuid; v_e uuid; v_m1 uuid; v_m2 uuid; v_m3 uuid; v_ok boolean;
begin
  insert into public.contactos (full_name, email) values ('Prueba 1D', '  Prueba.1D@Ejemplo.invalid ')
  returning id into v_c;
  insert into public.empresas (razon_social) values ('Prueba 1D correo SL') returning id into v_e;
  insert into public.contacto_empresa (contact_id, empresa_id, principal) values (v_c, v_e, true);

  -- Recibido de un contacto existente → vínculo con contacto y empresa.
  insert into public.correo_mensajes (graph_id, carpeta, remitente_email, para, fecha)
  values ('prueba-1d-1', 'inbox', 'PRUEBA.1d@ejemplo.invalid',
          '[{"email":"info@guimaes.es"}]', now())
  returning id into v_m1;
  insert into correo_prueba
  select 'recibido vinculado', contact_id = v_c and empresa_id = v_e
         and emails_norm = array['prueba.1d@ejemplo.invalid']
  from public.correo_mensajes where id = v_m1;

  -- Enviado a alguien sin contacto → sin vincular; al crear el contacto, se vincula.
  insert into public.correo_mensajes (graph_id, carpeta, para, cc, fecha)
  values ('prueba-1d-2', 'sentitems', '[{"email":"Nuevo.1D@ejemplo.invalid","nombre":"x"}]',
          '[{"email":"info@guimaes.es"}]', now())
  returning id into v_m2;
  insert into correo_prueba
  select 'enviado sin vincular', contact_id is null and emails_norm = array['nuevo.1d@ejemplo.invalid']
  from public.correo_mensajes where id = v_m2;
  insert into public.contactos (full_name, email) values ('Nuevo 1D', 'nuevo.1d@ejemplo.invalid');
  insert into correo_prueba
  select 'vinculado al crear contacto', m.contact_id = c.id and m.empresa_id is null
  from public.correo_mensajes m, public.contactos c
  where m.id = v_m2 and c.email = 'nuevo.1d@ejemplo.invalid';
  insert into public.contacto_empresa (contact_id, empresa_id, principal)
  select id, v_e, true from public.contactos where email = 'nuevo.1d@ejemplo.invalid';
  insert into correo_prueba
  select 'empresa al vincular empresa', empresa_id = v_e from public.correo_mensajes where id = v_m2;

  -- @removed: se marca, no se borra; volver a aparecer desmarca.
  update public.correo_mensajes set fuera_bandeja = true, fuera_bandeja_at = now() where id = v_m1;
  update public.correo_mensajes set fuera_bandeja = false, fuera_bandeja_at = null where id = v_m1;
  insert into correo_prueba
  select 'fuera_bandeja ida y vuelta', not fuera_bandeja and contact_id = v_c
  from public.correo_mensajes where id = v_m1;

  -- Un cambio de leído no rompe el vínculo; un vínculo hecho no se cambia.
  update public.correo_mensajes set leido = true where id = v_m1;
  update public.contactos set email = 'otro.1d@ejemplo.invalid' where id = v_c;
  insert into correo_prueba
  select 'vínculo estable', contact_id = v_c and leido from public.correo_mensajes where id = v_m1;

  -- Reserva: la primera vez sí, la segunda no.
  insert into correo_prueba values ('reserva 1', public.correo_sync_reservar('inbox', 60));
  insert into correo_prueba values ('reserva 2', not public.correo_sync_reservar('inbox', 60));

  -- Adjunto: se borra con su mensaje.
  insert into public.correo_mensajes (graph_id, carpeta, remitente_email, fecha, tiene_adjuntos)
  values ('prueba-1d-3', 'inbox', 'nadie@ejemplo.invalid', now(), true) returning id into v_m3;
  insert into public.correo_adjuntos (mensaje_id, graph_id, nombre) values (v_m3, 'adj-1', 'a.pdf');
  delete from public.correo_mensajes where id = v_m3;
  insert into correo_prueba
  select 'adjunto en cascada', count(*) = 0 from public.correo_adjuntos where graph_id = 'adj-1';
end
$d$;
reset role;
select * from correo_prueba;
rollback;
