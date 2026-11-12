-- ============================================================
-- GUIMAES — Correo: redactor con adjuntos, reenvío y firma (parte 5: esquema)
--
-- Qué crea:
--   * correo_borradores: los borradores que ha creado el CRM en el buzón
--     (graph_id inmutable). La Edge Function "correo" solo adjunta, envía o
--     descarta borradores que estén aquí, y la limpieza de borradores viejos
--     (más de 2 h sin enviar) solo borra en Outlook los graph_id de esta
--     tabla: nunca un borrador que una persona tenga en Outlook.
--       - tipo: nuevo | respuesta | respuesta_todos | reenvio
--       - origen_id: mensaje al que se responde o que se reenvía
--       - empresa_id: empresa del contexto (de sus carpetas se pueden
--         adjuntar documentos)
--       - sesiones: subidas por trozos abiertas (createUploadSession). La URL
--         de cada sesión se guarda aquí y nunca se recibe del navegador.
--     Sin acceso para el cliente: solo la service role (la función).
--   * correo_firmas: una firma (HTML) por usuario del CRM. Cada usuario lee
--     y edita solo la suya (correo_admin_actual()).
--   * correo_admin_actual(): admins.id del usuario activo que llama (o null).
--   * Registro en supabase_migrations.schema_migrations y notify pgrst.
--
-- Ni ficheros ni su contenido van a ninguna tabla: los adjuntos pasan por la
-- función hacia Graph y solo sus metadatos llegan a correo_adjuntos cuando
-- la sincronización trae el enviado.
--
-- Requiere: crm/supabase-correo.sql (correo_mensajes), admins, empresas,
-- set_updated_at, is_admin.
--
-- Orden: 5A → copia (pg_dump) → 5B → 5C → 5D (prueba con rollback).
-- ============================================================


-- ============================================================
-- 5A (solo lectura) — Lo esperado:
--   tablas correo_mensajes, admins, empresas: sí · set_updated_at: sí
--   migración 20261112120000: sí
--   correo_borradores / correo_firmas: no · correo_admin_actual: 0
-- ============================================================
select 'tabla ' || x.n as comprobacion,
       case when to_regclass('public.' || x.n) is not null then 'sí' else 'no' end as valor
from (values ('correo_mensajes'), ('admins'), ('empresas'), ('correo_borradores'), ('correo_firmas')) x(n)
union all
select 'función set_updated_at',
       case when to_regprocedure('public.set_updated_at()') is not null then 'sí' else 'no' end
union all
select 'función correo_admin_actual', count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname = 'correo_admin_actual'
union all
select 'migración 20261112120000',
       case when exists (select 1 from supabase_migrations.schema_migrations where version = '20261112120000') then 'sí' else 'no' end;


-- ============================================================
-- 5B (CAMBIO) — Un único DO; se niega a ejecutarse dos veces.
-- ============================================================
do $b5$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261113100000') then
    raise exception 'La migración 20261113100000 ya está registrada: 5B ya está aplicado. No se ha cambiado nada.';
  end if;
  if to_regclass('public.correo_borradores') is not null or to_regclass('public.correo_firmas') is not null then
    raise exception 'correo_borradores o correo_firmas ya existen. No se ha cambiado nada.';
  end if;
  if to_regclass('public.correo_mensajes') is null then
    raise exception 'Falta crm/supabase-correo.sql (correo_mensajes). No se ha cambiado nada.';
  end if;

  create table public.correo_borradores (
    graph_id    text primary key,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    creado_por  uuid references public.admins(id) on delete set null,
    tipo        text not null,
    origen_id   uuid references public.correo_mensajes(id) on delete set null,
    empresa_id  uuid references public.empresas(id) on delete set null,
    sesiones    jsonb not null default '[]'::jsonb,
    constraint correo_borradores_tipo_chk check (tipo in ('nuevo', 'respuesta', 'respuesta_todos', 'reenvio')),
    -- un nuevo no tiene origen; el resto lo tiene (o null si se borró el mensaje)
    constraint correo_borradores_origen_chk check (tipo <> 'nuevo' or origen_id is null),
    constraint correo_borradores_sesiones_chk check (jsonb_typeof(sesiones) = 'array')
  );
  create index correo_borradores_created_idx on public.correo_borradores (created_at);

  create table public.correo_firmas (
    admin_id    uuid primary key references public.admins(id) on delete cascade,
    updated_at  timestamptz not null default now(),
    html        text not null default '',
    constraint correo_firmas_html_chk check (length(html) <= 20000)
  );

  create function public.correo_admin_actual()
  returns uuid language sql stable security definer set search_path = public as $f$
    select a.id from public.admins a where a.auth_user_id = auth.uid() and a.activo
  $f$;

  create trigger correo_borradores_set_updated_at
    before update on public.correo_borradores
    for each row execute function public.set_updated_at();
  create trigger correo_firmas_set_updated_at
    before update on public.correo_firmas
    for each row execute function public.set_updated_at();

  alter table public.correo_borradores enable row level security;
  alter table public.correo_firmas     enable row level security;
  -- correo_borradores: sin políticas para el cliente (solo service role).
  create policy "cada usuario lee su firma" on public.correo_firmas
    for select to authenticated using (admin_id = (select public.correo_admin_actual()));
  create policy "cada usuario crea su firma" on public.correo_firmas
    for insert to authenticated with check (admin_id = (select public.correo_admin_actual()));
  create policy "cada usuario cambia su firma" on public.correo_firmas
    for update to authenticated using (admin_id = (select public.correo_admin_actual()))
    with check (admin_id = (select public.correo_admin_actual()));
  create policy "cada usuario borra su firma" on public.correo_firmas
    for delete to authenticated using (admin_id = (select public.correo_admin_actual()));

  revoke all on public.correo_borradores, public.correo_firmas from public, anon, authenticated;
  grant select, insert, update, delete on public.correo_firmas to authenticated;
  grant all on public.correo_borradores, public.correo_firmas to service_role;

  revoke all on function public.correo_admin_actual() from public, anon;
  grant execute on function public.correo_admin_actual() to authenticated, service_role;

  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261113100000', null, 'correo redactor (crm/supabase-correo-redactor.sql)');
end
$b5$;

notify pgrst, 'reload schema';


-- ============================================================
-- 5C (verificación, solo lectura) — Lo esperado en la columna valor:
--   tablas: 2 · RLS activada: 2 · políticas correo_firmas: 4 · correo_borradores: 0
--   authenticated borradores s/i/u/d: false/false/false/false
--   authenticated firmas s/i/u/d: true/true/true/true · anon firmas select: false
--   correo_admin_actual: authenticated sí, anon no
--   filas: borradores 0, firmas 0
--   migración registrada: 20261113100000
-- ============================================================
select 'tablas' as comprobacion, count(*)::text as valor
from pg_tables where schemaname = 'public' and tablename in ('correo_borradores', 'correo_firmas')
union all
select 'RLS activada', count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relrowsecurity and c.relname in ('correo_borradores', 'correo_firmas')
union all
select 'políticas correo_firmas', count(*)::text from pg_policies where schemaname = 'public' and tablename = 'correo_firmas'
union all
select 'políticas correo_borradores', count(*)::text from pg_policies where schemaname = 'public' and tablename = 'correo_borradores'
union all
select 'authenticated borradores s/i/u/d',
       has_table_privilege('authenticated', 'public.correo_borradores', 'SELECT') || '/'
       || has_table_privilege('authenticated', 'public.correo_borradores', 'INSERT') || '/'
       || has_table_privilege('authenticated', 'public.correo_borradores', 'UPDATE') || '/'
       || has_table_privilege('authenticated', 'public.correo_borradores', 'DELETE')
union all
select 'authenticated firmas s/i/u/d',
       has_table_privilege('authenticated', 'public.correo_firmas', 'SELECT') || '/'
       || has_table_privilege('authenticated', 'public.correo_firmas', 'INSERT') || '/'
       || has_table_privilege('authenticated', 'public.correo_firmas', 'UPDATE') || '/'
       || has_table_privilege('authenticated', 'public.correo_firmas', 'DELETE')
union all
select 'anon firmas select', has_table_privilege('anon', 'public.correo_firmas', 'SELECT')::text
union all
select 'correo_admin_actual authenticated/anon',
       has_function_privilege('authenticated', 'public.correo_admin_actual()', 'EXECUTE') || '/'
       || has_function_privilege('anon', 'public.correo_admin_actual()', 'EXECUTE')
union all
select 'filas borradores/firmas',
       (select count(*) from public.correo_borradores) || '/' || (select count(*) from public.correo_firmas)
union all
select 'migración registrada', string_agg(version || ' ' || name, ', ')
from supabase_migrations.schema_migrations where version = '20261113100000';


-- ============================================================
-- 5D (prueba de RLS de firmas; todo se deshace con rollback) — Simula a dos
-- usuarios del CRM (JWT authenticated): cada uno crea y lee su firma, no ve
-- ni cambia la del otro, y no puede crear una firma a nombre de otro. No
-- toca Graph ni avisa a nadie. Si hay menos de dos usuarios activos con
-- cuenta, los pasos de "el otro" salen como omitidos.
-- Lo esperado: todas las filas con ok = true.
-- ============================================================
begin;
create temp table correo_prueba5 (paso text, ok boolean) on commit drop;
grant all on correo_prueba5 to authenticated;
do $d$
declare
  v_a uuid; v_b uuid; v_ua uuid; v_ub uuid; v_n int; v_ok boolean;
begin
  select id, auth_user_id into v_a, v_ua from public.admins where activo and auth_user_id is not null order by created_at limit 1;
  select id, auth_user_id into v_b, v_ub from public.admins where activo and auth_user_id is not null and id <> v_a order by created_at limit 1;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_ua)::text, true);
  perform set_config('request.jwt.claim.sub', v_ua::text, true);
  set local role authenticated;
  insert into public.correo_firmas (admin_id, html) values (v_a, '<p>Firma A</p>');
  insert into correo_prueba5 select 'A lee su firma', count(*) = 1 from public.correo_firmas where admin_id = v_a;
  if v_b is not null then
    begin
      insert into public.correo_firmas (admin_id, html) values (v_b, '<p>suplantada</p>');
      insert into correo_prueba5 values ('A no crea la firma de B', false);
    exception when insufficient_privilege or check_violation then
      insert into correo_prueba5 values ('A no crea la firma de B', true);
    end;
  else
    insert into correo_prueba5 values ('A no crea la firma de B (omitido: un solo usuario)', true);
  end if;
  reset role;

  if v_b is not null then
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_ub)::text, true);
    perform set_config('request.jwt.claim.sub', v_ub::text, true);
    set local role authenticated;
    insert into correo_prueba5 select 'B no ve la firma de A', count(*) = 0 from public.correo_firmas where admin_id = v_a;
    update public.correo_firmas set html = 'x' where admin_id = v_a;
    get diagnostics v_n = row_count;
    insert into correo_prueba5 values ('B no cambia la firma de A', v_n = 0);
    reset role;
  else
    insert into correo_prueba5 values ('B no ve ni cambia la firma de A (omitido: un solo usuario)', true);
  end if;

  set local role authenticated;
  begin
    perform 1 from public.correo_borradores;
    insert into correo_prueba5 values ('cliente sin acceso a correo_borradores', false);
  exception when insufficient_privilege then
    insert into correo_prueba5 values ('cliente sin acceso a correo_borradores', true);
  end;
  reset role;
end
$d$;
select * from correo_prueba5;
rollback;
