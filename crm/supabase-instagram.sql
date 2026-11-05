-- ============================================================
-- GUIMAES — Publicación automática en el feed de Instagram (parte A: esquema)
--
-- Piezas (imagen suelta o carrusel de 2 a 10 láminas) que se suben por lotes
-- desde el CRM, se aprueban y las publica la Edge Function "instagram"
-- (crm/supabase-functions/instagram/) a su hora, llamada por pg_cron.
--
-- Qué crea:
--   * Bucket público instagram-media (solo image/jpeg, 8 MB): Meta descarga
--     cada lámina desde su URL pública. Políticas de Storage para usuarios
--     del CRM (is_admin()); las láminas de piezas aprobadas, publicándose,
--     publicadas o con error no se pueden borrar ni sobrescribir desde el
--     cliente.
--   * instagram_posts, instagram_post_slides (con ancho y alto de cada
--     lámina) e instagram_terminos_prohibidos. RLS: usuarios del CRM
--     (is_admin()); los términos solo los edita el rol admin.
--   * instagram_revisar(caption, fecha, post): lista de errores (impiden
--     aprobar) y avisos. La usan el trigger al aprobar y el editor del CRM
--     mientras se escribe. Reglas:
--       - términos prohibidos (palabras completas, sin mayúsculas ni tildes);
--       - nombres de clientes: razón social de una empresa (completa o sin
--         la forma jurídica; 6 caracteres o más) y nombre completo de un
--         contacto (dos palabras o más), como palabras completas. Se
--         excluyen las empresas cuya razón social contiene «Guimaes» y los
--         contactos con el email de un usuario del CRM;
--       - aviso legal obligatorio;
--       - 2200 caracteres, 30 hashtags, 20 menciones;
--       - al menos una lámina, proporción entre 4:5 y 1,91:1 (error) y
--         misma proporción en todo el carrusel (aviso);
--       - fecha obligatoria (aviso si ya ha pasado).
--   * Trigger de reglas (SECURITY DEFINER) sobre instagram_posts y otro
--     sobre instagram_post_slides. "Cliente" = petición con JWT de usuario
--     (authenticated/anon); la service role (Edge Function) y pg_cron no
--     llevan esas restricciones.
--       - el cliente no pone publicando/publicada/error ni toca lo
--         publicado ni los campos que rellena el servidor;
--       - cambiar texto o fecha de una aprobada (o sus láminas) la devuelve
--         a borrador;
--       - aprobar y cancelar una aprobada: solo rol admin (is_admin_role(),
--         crm/supabase-admins.sql). Al aprobar se pasa instagram_revisar;
--       - eliminar: solo borradores y canceladas.
--   * instagram_espacio(): bytes de instagram-media y de todo Storage.
--   * pg_cron (secreto en Vault 'instagram_cron_secret', mismo patrón que
--     portal-limpieza; con verify_jwt = false no hace falta la anon key):
--       instagram-atascadas  */5: publicando > 15 min → error (sin reintento)
--       instagram-publicar   */5: llama a la función solo si existen
--                                aprobadas con la hora cumplida
--       instagram-metricas   05:15 UTC: métricas de las publicadas
--     Llamadas con timeout_milliseconds = 150000 (pg_net trae 5 s).
--   * supabase_migrations.schema_migrations (no existía) y el registro de
--     esta migración. Al final, notify pgrst para recargar la caché.
--
-- Requiere: admins (is_admin, is_admin_role), empresas, contactos; pg_cron,
-- pg_net y supabase_vault instalados.
--
-- Orden: 1A → copia → 1B → 1C → secreto (script aparte, nunca en el repo)
-- → desplegar la función (parte B) → 1D (prueba de reglas, con rollback).
-- 1A y 1C son solo lectura; 1B cambia (un único DO, atómico, que se niega a
-- ejecutarse dos veces); 1D escribe dentro de una transacción que se deshace.
-- ============================================================


-- ============================================================
-- 1A (solo lectura) — Lo esperado:
--   extensiones pg_cron, pg_net, supabase_vault: sí
--   funciones is_admin, is_admin_role: sí
--   tablas/bucket/jobs/secreto instagram: no (0)
--   schema_migrations: no existe
-- ============================================================
select 'extensión ' || x.n as comprobacion,
       case when exists (select 1 from pg_extension e where e.extname = x.n) then 'sí' else 'NO' end as valor
from (values ('pg_cron'), ('pg_net'), ('supabase_vault')) x(n)
union all
select 'función ' || x.n,
       case when exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                         where s.nspname = 'public' and p.proname = x.n) then 'sí' else 'NO' end
from (values ('is_admin'), ('is_admin_role')) x(n)
union all
select 'tablas instagram*', count(*)::text from pg_tables where schemaname = 'public' and tablename like 'instagram%'
union all
select 'funciones instagram*', count(*)::text from pg_proc p join pg_namespace s on s.oid = p.pronamespace
where s.nspname = 'public' and p.proname like 'instagram%'
union all
select 'bucket instagram-media', count(*)::text from storage.buckets where id = 'instagram-media'
union all
select 'políticas storage instagram', count(*)::text from pg_policies where schemaname = 'storage' and policyname like '%instagram%'
union all
select 'jobs instagram-*', count(*)::text from cron.job where jobname like 'instagram-%'
union all
select 'secreto instagram_cron_secret', count(*)::text from vault.secrets where name = 'instagram_cron_secret'
union all
select 'supabase_migrations.schema_migrations',
       case when to_regclass('supabase_migrations.schema_migrations') is null then 'no existe' else 'EXISTE' end;


-- ============================================================
-- 1B (CAMBIO) — Esquema completo. Un único DO; se niega a ejecutarse dos
-- veces. Después del DO, notify pgrst (solo si el DO ha ido bien: psql con
-- ON_ERROR_STOP=1 se para antes).
-- ============================================================
do $b1$
begin
  if to_regclass('public.instagram_posts') is not null then
    raise exception 'public.instagram_posts ya existe: 1B ya está aplicado. No se ha cambiado nada.';
  end if;
  if exists (select 1 from storage.buckets where id = 'instagram-media') then
    raise exception 'El bucket instagram-media ya existe. No se ha cambiado nada.';
  end if;

  -- ===================== registro de migraciones =====================
  -- Misma estructura que crea la CLI de Supabase. Hasta hoy las migraciones
  -- del CRM (crm/supabase-*.sql) no se registraban; esta es la primera.
  create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (
    version    text primary key,
    statements text[],
    name       text
  );

  -- ===================== tablas =====================
  create table public.instagram_posts (
    id             uuid primary key default gen_random_uuid(),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    created_by     uuid references public.admins(id) on delete set null,
    titulo         text not null default '',
    lote           text,                       -- etiqueta del lote de subida
    caption        text not null default '',
    scheduled_for  timestamptz,
    status         text not null default 'borrador',
    approved_by    uuid references public.admins(id) on delete set null,
    approved_at    timestamptz,
    reservada_at   timestamptz,                -- cuándo pasó a publicando
    ig_media_id    text,
    permalink      text,
    published_at   timestamptz,
    error          text,
    attempts       integer not null default 0,
    metrics        jsonb,
    metrics_at     timestamptz,
    constraint instagram_posts_status_check
      check (status in ('borrador', 'aprobada', 'publicando', 'publicada', 'error', 'cancelada')),
    constraint instagram_posts_caption_len check (char_length(caption) <= 2200),
    constraint instagram_posts_publicada_media check (status <> 'publicada' or ig_media_id is not null)
  );
  create index instagram_posts_pendientes_idx on public.instagram_posts (scheduled_for) where status = 'aprobada';
  create index instagram_posts_status_idx on public.instagram_posts (status, scheduled_for);

  create table public.instagram_post_slides (
    id            uuid primary key default gen_random_uuid(),
    created_at    timestamptz not null default now(),
    post_id       uuid not null references public.instagram_posts(id) on delete cascade,
    position      smallint not null,
    storage_path  text not null,
    width         integer not null,
    height        integer not null,
    constraint instagram_post_slides_position_check check (position between 1 and 10),
    constraint instagram_post_slides_dim_check check (width > 0 and height > 0),
    constraint instagram_post_slides_path_check check (storage_path <> '' and left(storage_path, 1) <> '/'),
    constraint instagram_post_slides_post_position_key unique (post_id, position) deferrable initially deferred,
    constraint instagram_post_slides_path_key unique (storage_path)
  );

  create table public.instagram_terminos_prohibidos (
    id          uuid primary key default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    termino     text not null,
    constraint instagram_terminos_no_vacio check (btrim(termino) <> '')
  );

  -- ===================== normalización y búsqueda =====================
  -- Minúsculas, sin tildes (translate: no hace falta la extensión unaccent)
  -- y espacios normalizados (incluidos el no separable y el estrecho, que
  -- se cuelan en «100 %»). translate antes de lower: lower de ASCII no
  -- depende de la configuración regional.
  create function public.instagram_normalizar(p text)
  returns text
  language sql
  immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $f$
    select btrim(regexp_replace(
      lower(translate(coalesce(p, ''),
        'ÁÀÄÂÃáàäâãÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÇçÑñ',
        'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')),
      '[[:space:]' || chr(160) || chr(8239) || ']+', ' ', 'g'))
  $f$;

  -- ¿Contiene el texto (normalizado) el término (normalizado) como palabras
  -- completas? Antes y después del término: inicio/fin o algo que no sea
  -- letra ni número. Así «la mejor» no salta con «la mejora» y «100%» no
  -- salta con «1100%».
  create function public.instagram_contiene(p_texto_norm text, p_termino_norm text)
  returns boolean
  language sql
  immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $f$
    select coalesce(p_termino_norm, '') <> ''
       and strpos(coalesce(p_texto_norm, ''), p_termino_norm) > 0
       and coalesce(p_texto_norm, '') ~ ('(^|[^[:alnum:]])'
             || regexp_replace(p_termino_norm, '([^[:alnum:] ])', '\\\1', 'g')
             || '([^[:alnum:]]|$)')
  $f$;

  -- Razón social (normalizada) sin la forma jurídica final: «talleres perez,
  -- s.l.» → «talleres perez». Exige un separador antes, para no recortar
  -- nombres que acaban en «sa» o «sl» («mesa»).
  create function public.instagram_sin_forma_juridica(p_norm text)
  returns text
  language sql
  immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $f$
    select btrim(regexp_replace(coalesce(p_norm, ''),
      '[ ,.]+(sociedad (limitada|anonima)( (unipersonal|laboral|profesional))?|sociedad cooperativa'
      || '|s\.? ?l\.? ?[up]\.?|s\.? ?a\.? ?[ul]\.?|s\.? ?l\.?|s\.? ?a\.?|s\.? ?c\.? ?p\.?|s\.? ?c\.?'
      || '|c\.? ?b\.?|s\.? ?coop\.?)[ ,.]*$', ''), ' ,.-')
  $f$;

  create function public.instagram_aviso_legal()
  returns text
  language sql
  immutable parallel safe
  set search_path = pg_catalog, pg_temp
  as $f$
    select 'Información general: no sustituye el asesoramiento profesional.'::text
  $f$;

  -- ¿La petición viene de un usuario (JWT authenticated/anon)? La service
  -- role y pg_cron (sin JWT) no son "cliente".
  create function public.instagram_es_cliente()
  returns boolean
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $f$
    select coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
             nullif(current_setting('request.jwt.claim.role', true), ''),
             '') in ('authenticated', 'anon')
  $f$;

  -- ===================== revisión de contenido =====================
  create function public.instagram_revisar(p_caption text, p_scheduled_for timestamptz, p_post_id uuid)
  returns table(nivel text, codigo text, mensaje text)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_texto      text := coalesce(p_caption, '');
    v_norm       text := public.instagram_normalizar(p_caption);
    v_n          integer;
    v_rec        record;
    v_nombre_n   text;
    v_corto      text;
    v_props      numeric[];
  begin
    if public.instagram_es_cliente() and not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;

    -- Longitud, hashtags, menciones
    if char_length(v_texto) > 2200 then
      nivel := 'error'; codigo := 'longitud';
      mensaje := 'El texto tiene ' || char_length(v_texto) || ' caracteres (máximo 2200).';
      return next;
    end if;
    select count(*) into v_n from regexp_matches(v_texto, '(^|[^[:alnum:]_&])#[^[:space:]#@]+', 'g');
    if v_n > 30 then
      nivel := 'error'; codigo := 'hashtags';
      mensaje := 'El texto tiene ' || v_n || ' hashtags (máximo 30).';
      return next;
    end if;
    select count(*) into v_n from regexp_matches(v_texto, '(^|[^[:alnum:]_.@])@[[:alnum:]._]+', 'g');
    if v_n > 20 then
      nivel := 'error'; codigo := 'menciones';
      mensaje := 'El texto tiene ' || v_n || ' menciones (máximo 20).';
      return next;
    end if;

    -- Aviso legal (se ignora el punto final)
    if not public.instagram_contiene(v_norm, rtrim(public.instagram_normalizar(public.instagram_aviso_legal()), '.')) then
      nivel := 'error'; codigo := 'aviso_legal';
      mensaje := 'Falta el aviso «' || public.instagram_aviso_legal() || '».';
      return next;
    end if;

    -- Términos prohibidos
    for v_rec in
      select t.termino from public.instagram_terminos_prohibidos t
      where public.instagram_contiene(v_norm, public.instagram_normalizar(t.termino))
      order by t.termino
    loop
      nivel := 'error'; codigo := 'termino';
      mensaje := 'Término no permitido: «' || v_rec.termino || '».';
      return next;
    end loop;

    -- Nombres de clientes: empresas (sin las nuestras)
    for v_rec in
      select e.razon_social from public.empresas e
      where strpos(public.instagram_normalizar(e.razon_social), 'guimaes') = 0
      order by e.razon_social
    loop
      v_nombre_n := public.instagram_normalizar(v_rec.razon_social);
      v_corto := public.instagram_sin_forma_juridica(v_nombre_n);
      if (char_length(v_corto) >= 6 and public.instagram_contiene(v_norm, v_corto))
         or (char_length(v_nombre_n) >= 6 and public.instagram_contiene(v_norm, v_nombre_n)) then
        nivel := 'error'; codigo := 'cliente';
        mensaje := 'Nombre de cliente en el texto: «' || v_rec.razon_social || '» (empresa).';
        return next;
      end if;
    end loop;

    -- Nombres de clientes: contactos con nombre y apellido (sin los usuarios del CRM)
    for v_rec in
      select distinct c.full_name from public.contactos c
      where public.instagram_normalizar(c.full_name) ~ '^[^ ]+( [^ ]+)+$'
        and not exists (select 1 from public.admins a
                        where c.email is not null and lower(btrim(a.email)) = lower(btrim(c.email)))
        and public.instagram_contiene(v_norm, public.instagram_normalizar(c.full_name))
      order by c.full_name
    loop
      nivel := 'error'; codigo := 'cliente';
      mensaje := 'Nombre de cliente en el texto: «' || v_rec.full_name || '» (contacto).';
      return next;
    end loop;

    -- Láminas
    select count(*), array_agg(round(s.width::numeric / s.height, 3) order by s.position)
      into v_n, v_props
    from public.instagram_post_slides s where p_post_id is not null and s.post_id = p_post_id;
    if v_n = 0 then
      nivel := 'error'; codigo := 'sin_imagenes';
      mensaje := 'La pieza no tiene imágenes.';
      return next;
    end if;
    for v_rec in
      select s.position, s.width, s.height from public.instagram_post_slides s
      where p_post_id is not null and s.post_id = p_post_id
        and (s.width::numeric / s.height < 0.799 or s.width::numeric / s.height > 1.912)
      order by s.position
    loop
      nivel := 'error'; codigo := 'proporcion';
      mensaje := 'La lámina ' || v_rec.position || ' mide ' || v_rec.width || '×' || v_rec.height
                 || ': Instagram solo acepta proporciones entre 4:5 y 1,91:1.';
      return next;
    end loop;
    if v_n > 1 and (select count(distinct x) from unnest(v_props) x) > 1 then
      nivel := 'aviso'; codigo := 'proporcion_carrusel';
      mensaje := 'Las láminas del carrusel no tienen la misma proporción: Instagram recorta todas a la de la primera.';
      return next;
    end if;

    -- Fecha
    if p_scheduled_for is null then
      nivel := 'error'; codigo := 'sin_fecha';
      mensaje := 'La pieza no tiene fecha de publicación.';
      return next;
    elsif p_scheduled_for < now() then
      nivel := 'aviso'; codigo := 'fecha_pasada';
      mensaje := 'La fecha ya ha pasado: si se aprueba, se publicará en los próximos minutos.';
      return next;
    end if;
  end;
  $f$;

  -- ===================== trigger de reglas: piezas =====================
  create function public.instagram_posts_reglas()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_cliente  boolean := public.instagram_es_cliente();
    v_errores  text;
  begin
    if tg_op = 'DELETE' then
      if v_cliente and old.status not in ('borrador', 'cancelada') then
        raise exception 'Solo se pueden eliminar borradores y piezas canceladas (esta está «%»).', old.status
          using errcode = 'GU020';
      end if;
      return old;
    end if;

    if tg_op = 'INSERT' then
      if v_cliente then
        if new.status <> 'borrador' then
          raise exception 'Las piezas nuevas se crean como borrador.' using errcode = 'GU020';
        end if;
        if new.approved_by is not null or new.approved_at is not null or new.reservada_at is not null
           or new.ig_media_id is not null or new.permalink is not null or new.published_at is not null
           or new.error is not null or new.attempts <> 0 or new.metrics is not null or new.metrics_at is not null then
          raise exception 'Hay campos que solo rellena la publicación automática.' using errcode = 'GU020';
        end if;
        new.created_by := (select a.id from public.admins a where a.auth_user_id = auth.uid());
        new.created_at := now();
        new.updated_at := now();
      end if;
      return new;
    end if;

    -- UPDATE
    new.updated_at := now();

    if not v_cliente then
      -- Servidor (Edge Function / pg_cron): sin restricciones de estado.
      if new.status = 'publicando' and old.status is distinct from 'publicando' then
        new.reservada_at := now();
      end if;
      if new.status = 'publicada' and new.published_at is null then
        new.published_at := now();
      end if;
      return new;
    end if;

    if old.status in ('publicando', 'publicada') then
      raise exception 'Una pieza «%» no se puede modificar.', old.status using errcode = 'GU020';
    end if;
    if new.status in ('publicando', 'publicada', 'error') and new.status is distinct from old.status then
      raise exception 'El estado «%» solo lo pone la publicación automática.', new.status using errcode = 'GU020';
    end if;
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by
       or new.reservada_at is distinct from old.reservada_at or new.ig_media_id is distinct from old.ig_media_id
       or new.permalink is distinct from old.permalink or new.published_at is distinct from old.published_at
       or new.error is distinct from old.error or new.attempts is distinct from old.attempts
       or new.metrics is distinct from old.metrics or new.metrics_at is distinct from old.metrics_at then
      raise exception 'Hay campos que solo rellena la publicación automática.' using errcode = 'GU020';
    end if;
    if old.status = 'error' and new.status = 'error' then
      raise exception 'Pasa la pieza a borrador para editarla.' using errcode = 'GU020';
    end if;

    if new.status = 'aprobada' and old.status <> 'aprobada' then
      -- Aprobar
      if old.status <> 'borrador' then
        raise exception 'Solo se puede aprobar un borrador.' using errcode = 'GU020';
      end if;
      if not public.is_admin_role() then
        raise exception 'Solo el rol admin puede aprobar.' using errcode = '42501';
      end if;
      select string_agg(r.mensaje, ' · ') into v_errores
      from public.instagram_revisar(new.caption, new.scheduled_for, new.id) r
      where r.nivel = 'error';
      if v_errores is not null then
        raise exception 'No se puede aprobar: %', v_errores using errcode = 'GU021';
      end if;
      new.approved_by := (select a.id from public.admins a where a.auth_user_id = auth.uid());
      new.approved_at := now();
    elsif new.status = 'aprobada' then
      -- Sigue aprobada: si cambia el texto o la fecha, vuelve a borrador.
      if new.caption is distinct from old.caption or new.scheduled_for is distinct from old.scheduled_for then
        new.status := 'borrador';
        new.approved_by := null;
        new.approved_at := null;
      else
        new.approved_by := old.approved_by;
        new.approved_at := old.approved_at;
      end if;
    else
      if old.status = 'aprobada' and new.status = 'cancelada' and not public.is_admin_role() then
        raise exception 'Solo el rol admin puede cancelar una pieza aprobada.' using errcode = '42501';
      end if;
      new.approved_by := null;
      new.approved_at := null;
    end if;

    return new;
  end;
  $f$;

  create trigger instagram_posts_reglas
    before insert or update or delete on public.instagram_posts
    for each row execute function public.instagram_posts_reglas();

  -- ===================== trigger de reglas: láminas =====================
  create function public.instagram_slides_reglas()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_status text;
  begin
    if not public.instagram_es_cliente() then
      return case when tg_op = 'DELETE' then old else new end;
    end if;
    if tg_op = 'UPDATE' and new.post_id is distinct from old.post_id then
      raise exception 'Una lámina no se puede mover a otra pieza.' using errcode = 'GU020';
    end if;

    select p.status into v_status from public.instagram_posts p
    where p.id = case when tg_op = 'DELETE' then old.post_id else new.post_id end
    for update;
    if not found then
      -- Borrado en cascada de la propia pieza.
      return case when tg_op = 'DELETE' then old else new end;
    end if;

    if v_status in ('publicando', 'publicada') then
      raise exception 'No se pueden cambiar las láminas de una pieza «%».', v_status using errcode = 'GU020';
    end if;
    if v_status = 'aprobada' then
      update public.instagram_posts set status = 'borrador'
      where id = case when tg_op = 'DELETE' then old.post_id else new.post_id end;
    end if;

    return case when tg_op = 'DELETE' then old else new end;
  end;
  $f$;

  create trigger instagram_slides_reglas
    before insert or update or delete on public.instagram_post_slides
    for each row execute function public.instagram_slides_reglas();

  -- ===================== RLS =====================
  alter table public.instagram_posts enable row level security;
  alter table public.instagram_post_slides enable row level security;
  alter table public.instagram_terminos_prohibidos enable row level security;

  create policy "crm lee instagram_posts" on public.instagram_posts
    for select to authenticated using ((select public.is_admin()));
  create policy "crm crea instagram_posts" on public.instagram_posts
    for insert to authenticated with check ((select public.is_admin()));
  create policy "crm edita instagram_posts" on public.instagram_posts
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "crm borra instagram_posts" on public.instagram_posts
    for delete to authenticated using ((select public.is_admin()));

  create policy "crm lee instagram_post_slides" on public.instagram_post_slides
    for select to authenticated using ((select public.is_admin()));
  create policy "crm crea instagram_post_slides" on public.instagram_post_slides
    for insert to authenticated with check ((select public.is_admin()));
  create policy "crm edita instagram_post_slides" on public.instagram_post_slides
    for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "crm borra instagram_post_slides" on public.instagram_post_slides
    for delete to authenticated using ((select public.is_admin()));

  create policy "crm lee instagram_terminos" on public.instagram_terminos_prohibidos
    for select to authenticated using ((select public.is_admin()));
  create policy "rol admin crea instagram_terminos" on public.instagram_terminos_prohibidos
    for insert to authenticated with check ((select public.is_admin_role()));
  create policy "rol admin edita instagram_terminos" on public.instagram_terminos_prohibidos
    for update to authenticated using ((select public.is_admin_role())) with check ((select public.is_admin_role()));
  create policy "rol admin borra instagram_terminos" on public.instagram_terminos_prohibidos
    for delete to authenticated using ((select public.is_admin_role()));

  revoke all on table public.instagram_posts, public.instagram_post_slides, public.instagram_terminos_prohibidos from anon;

  insert into public.instagram_terminos_prohibidos (termino) values
    ('garantizado'), ('garantizada'), ('100 %'), ('100%'), ('sin riesgo'), ('ahorro asegurado'),
    ('no pagar impuestos'), ('el mejor'), ('la mejor'), ('los mejores'), ('las mejores');

  -- ===================== Storage =====================
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('instagram-media', 'instagram-media', true, 8388608, array['image/jpeg']);

  create policy "crm lee instagram-media (storage)" on storage.objects
    for select to authenticated
    using (bucket_id = 'instagram-media' and public.is_admin());
  create policy "crm sube instagram-media (storage)" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'instagram-media' and public.is_admin());
  -- Ni sobrescribir ni borrar láminas de piezas aprobadas, publicándose,
  -- publicadas o con error (pueden estar ya en Instagram).
  create policy "crm actualiza instagram-media (storage)" on storage.objects
    for update to authenticated
    using (bucket_id = 'instagram-media' and public.is_admin()
           and not exists (select 1 from public.instagram_post_slides s
                           join public.instagram_posts p on p.id = s.post_id
                           where s.storage_path = objects.name
                             and p.status in ('aprobada', 'publicando', 'publicada', 'error')))
    with check (bucket_id = 'instagram-media' and public.is_admin());
  create policy "crm borra instagram-media (storage)" on storage.objects
    for delete to authenticated
    using (bucket_id = 'instagram-media' and public.is_admin()
           and not exists (select 1 from public.instagram_post_slides s
                           join public.instagram_posts p on p.id = s.post_id
                           where s.storage_path = objects.name
                             and p.status in ('aprobada', 'publicando', 'publicada', 'error')));

  create function public.instagram_espacio()
  returns table(instagram_bytes bigint, instagram_objetos bigint, total_bytes bigint)
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if not public.is_admin() then
      raise exception 'No autorizado' using errcode = '42501';
    end if;
    return query
    select coalesce(sum((o.metadata ->> 'size')::bigint) filter (where o.bucket_id = 'instagram-media'), 0)::bigint,
           count(*) filter (where o.bucket_id = 'instagram-media'),
           coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
    from storage.objects o;
  end;
  $f$;

  -- ===================== pg_cron =====================
  -- Llamada a la Edge Function con el secreto leído de Vault en cada
  -- llamada (nunca escrito aquí). Devuelve el id de net._http_response.
  create function public.instagram_lanzar(p_accion text)
  returns bigint
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_secreto text;
  begin
    if p_accion not in ('comprobar', 'publicar_pendientes', 'metricas') then
      raise exception 'Acción no válida: %', p_accion;
    end if;
    select ds.decrypted_secret into v_secreto
    from vault.decrypted_secrets ds
    where ds.name = 'instagram_cron_secret';
    if v_secreto is null or v_secreto = '' then
      raise exception 'Falta el secreto instagram_cron_secret en Vault';
    end if;
    return net.http_post(
      url                  := 'https://zuktsotrcolqdowpbnrx.supabase.co/functions/v1/instagram',
      body                 := jsonb_build_object('accion', p_accion),
      headers              := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_secreto),
      timeout_milliseconds := 150000
    );
  end;
  $f$;

  -- Publicando hace más de 15 minutos → error. No se reintenta sola: puede
  -- haberse publicado ya (hay que mirarlo en Instagram).
  create function public.instagram_cron_atascadas()
  returns integer
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  declare
    v_n integer;
  begin
    update public.instagram_posts
    set status = 'error',
        error = 'Más de 15 minutos publicándose sin terminar. Comprueba en Instagram si se llegó a publicar antes de volver a aprobarla.'
    where status = 'publicando' and coalesce(reservada_at, updated_at) < now() - interval '15 minutes';
    get diagnostics v_n = row_count;
    return v_n;
  end;
  $f$;

  create function public.instagram_cron_publicar()
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if exists (select 1 from public.instagram_posts p
               where p.status = 'aprobada' and p.scheduled_for <= now()) then
      perform public.instagram_lanzar('publicar_pendientes');
    end if;
  end;
  $f$;

  create function public.instagram_cron_metricas()
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $f$
  begin
    if exists (select 1 from public.instagram_posts p
               where p.status = 'publicada' and p.ig_media_id is not null) then
      perform public.instagram_lanzar('metricas');
    end if;
  end;
  $f$;

  perform cron.unschedule(jobid) from cron.job where jobname in ('instagram-atascadas', 'instagram-publicar', 'instagram-metricas');
  perform cron.schedule('instagram-atascadas', '*/5 * * * *', 'select public.instagram_cron_atascadas();');
  perform cron.schedule('instagram-publicar',  '*/5 * * * *', 'select public.instagram_cron_publicar();');
  perform cron.schedule('instagram-metricas',  '15 5 * * *',  'select public.instagram_cron_metricas();');

  -- ===================== permisos de funciones =====================
  revoke all on function public.instagram_normalizar(text)                         from public, anon;
  revoke all on function public.instagram_contiene(text, text)                     from public, anon;
  revoke all on function public.instagram_sin_forma_juridica(text)                 from public, anon;
  revoke all on function public.instagram_aviso_legal()                            from public, anon;
  revoke all on function public.instagram_es_cliente()                             from public, anon, authenticated, service_role;
  revoke all on function public.instagram_revisar(text, timestamptz, uuid)         from public, anon;
  revoke all on function public.instagram_espacio()                                from public, anon;
  revoke all on function public.instagram_posts_reglas()                           from public, anon, authenticated, service_role;
  revoke all on function public.instagram_slides_reglas()                          from public, anon, authenticated, service_role;
  revoke all on function public.instagram_lanzar(text)                             from public, anon, authenticated, service_role;
  revoke all on function public.instagram_cron_atascadas()                         from public, anon, authenticated, service_role;
  revoke all on function public.instagram_cron_publicar()                          from public, anon, authenticated, service_role;
  revoke all on function public.instagram_cron_metricas()                          from public, anon, authenticated, service_role;
  grant execute on function public.instagram_normalizar(text)                      to authenticated, service_role;
  grant execute on function public.instagram_contiene(text, text)                  to authenticated, service_role;
  grant execute on function public.instagram_sin_forma_juridica(text)              to authenticated, service_role;
  grant execute on function public.instagram_aviso_legal()                         to authenticated, service_role;
  grant execute on function public.instagram_revisar(text, timestamptz, uuid)      to authenticated, service_role;
  grant execute on function public.instagram_espacio()                             to authenticated;

  -- ===================== registro =====================
  insert into supabase_migrations.schema_migrations (version, statements, name)
  values ('20261105120000', null, 'instagram (crm/supabase-instagram.sql)');
end
$b1$;

notify pgrst, 'reload schema';


-- ============================================================
-- 1C (verificación, solo lectura) — Lo esperado en la columna valor:
--   tablas: 3 · RLS activada en las 3 · políticas tablas: 12
--   bucket: público, 8388608, {image/jpeg} · políticas storage: 4
--   triggers: 2 · términos: 11
--   jobs: instagram-atascadas */5, instagram-publicar */5, instagram-metricas 15 5 * * *
--   instagram_lanzar: lee de Vault, sin secreto escrito; sin EXECUTE para nadie
--   instagram_revisar: authenticated sí, anon no
--   migración registrada: 20261105120000
-- ============================================================
select 'tablas' as comprobacion, count(*)::text as valor
from pg_tables where schemaname = 'public'
  and tablename in ('instagram_posts', 'instagram_post_slides', 'instagram_terminos_prohibidos')
union all
select 'RLS activada', count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relrowsecurity
  and c.relname in ('instagram_posts', 'instagram_post_slides', 'instagram_terminos_prohibidos')
union all
select 'políticas tablas', count(*)::text from pg_policies
where schemaname = 'public' and tablename like 'instagram%'
union all
select 'bucket', 'público=' || b.public || ', ' || b.file_size_limit || ', ' || b.allowed_mime_types::text
from storage.buckets b where b.id = 'instagram-media'
union all
select 'políticas storage', count(*)::text from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname like '%instagram-media%'
union all
select 'triggers', count(*)::text from pg_trigger
where tgname in ('instagram_posts_reglas', 'instagram_slides_reglas') and not tgisinternal
union all
select 'términos', count(*)::text from public.instagram_terminos_prohibidos
union all
select 'job ' || j.jobname, j.schedule || ' · activo=' || j.active || ' · ' || j.command
from cron.job j where j.jobname like 'instagram-%'
union all
select 'instagram_lanzar',
       case when p.prosrc like '%vault.decrypted_secrets%' and p.prosrc like '%timeout_milliseconds := 150000%'
            then 'lee de Vault, sin secreto escrito' else 'REVISAR' end
       || ' · anon/authenticated/service_role = '
       || has_function_privilege('anon', p.oid, 'EXECUTE') || '/'
       || has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/'
       || has_function_privilege('service_role', p.oid, 'EXECUTE')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'instagram_lanzar'
union all
select 'instagram_revisar', 'authenticated=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
       || ' anon=' || has_function_privilege('anon', p.oid, 'EXECUTE')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'instagram_revisar'
union all
select 'migración registrada', string_agg(version || ' ' || name, ', ')
from supabase_migrations.schema_migrations;


-- ============================================================
-- 1D (prueba de reglas; todo se deshace con rollback) — Simula a un usuario
-- con rol admin desde el cliente (JWT authenticated). No hay triggers que
-- avisen al equipo sobre estas tablas. Si algún nombre de cliente saltara
-- con el texto de prueba, el resultado lo diría (y habría que revisarlo).
-- Lo esperado: todas las filas con ok = true.
-- ============================================================
begin;
create temp table if not exists pg_temp.instagram_prueba (paso text, ok boolean, detalle text) on commit drop;
grant all on pg_temp.instagram_prueba to authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated',
                    'sub', (select a.auth_user_id from public.admins a
                            where a.activo and a.rol = 'admin' and a.auth_user_id is not null
                            order by a.created_at limit 1))::text, true);
set local role authenticated;
do $d$
declare
  v_id   uuid;
  v_st   text;
  v_ok   boolean;
  v_msg  text;
  v_aviso constant text := 'Información general: no sustituye el asesoramiento profesional.';
begin
  insert into public.instagram_posts (titulo, caption, scheduled_for)
  values ('prueba 1D', 'Texto de prueba. ' || v_aviso, now() + interval '7 days')
  returning id into v_id;
  insert into pg_temp.instagram_prueba values ('crear borrador', true, null);

  -- Aprobar sin láminas: debe fallar.
  begin
    update public.instagram_posts set status = 'aprobada' where id = v_id;
    insert into pg_temp.instagram_prueba values ('aprobar sin láminas falla', false, 'se aprobó');
  exception when others then
    insert into pg_temp.instagram_prueba values ('aprobar sin láminas falla', sqlerrm like '%no tiene imágenes%', sqlerrm);
  end;

  -- Lámina fuera de proporción: debe fallar al aprobar.
  insert into public.instagram_post_slides (post_id, position, storage_path, width, height)
  values (v_id, 1, 'prueba-1d/' || v_id || '/01.jpg', 1080, 1440);
  begin
    update public.instagram_posts set status = 'aprobada' where id = v_id;
    insert into pg_temp.instagram_prueba values ('proporción 3:4 falla', false, 'se aprobó');
  exception when others then
    insert into pg_temp.instagram_prueba values ('proporción 3:4 falla', sqlerrm like '%proporciones entre 4:5%', sqlerrm);
  end;
  update public.instagram_post_slides set height = 1350 where post_id = v_id;

  -- Término prohibido con mayúsculas y tildes: debe fallar.
  update public.instagram_posts set caption = 'Ahorro ASEGURADO. ' || v_aviso where id = v_id;
  begin
    update public.instagram_posts set status = 'aprobada' where id = v_id;
    insert into pg_temp.instagram_prueba values ('término prohibido falla', false, 'se aprobó');
  exception when others then
    insert into pg_temp.instagram_prueba values ('término prohibido falla', sqlerrm like '%ahorro asegurado%', sqlerrm);
  end;

  -- Sin aviso legal: debe fallar.
  update public.instagram_posts set caption = 'Texto sin aviso.' where id = v_id;
  begin
    update public.instagram_posts set status = 'aprobada' where id = v_id;
    insert into pg_temp.instagram_prueba values ('sin aviso falla', false, 'se aprobó');
  exception when others then
    insert into pg_temp.instagram_prueba values ('sin aviso falla', sqlerrm like '%Falta el aviso%', sqlerrm);
  end;

  -- Correcto: se aprueba.
  update public.instagram_posts set caption = 'Texto de prueba sobre la mejora fiscal. ' || v_aviso where id = v_id;
  begin
    update public.instagram_posts set status = 'aprobada' where id = v_id;
    select status into v_st from public.instagram_posts where id = v_id;
    insert into pg_temp.instagram_prueba values ('aprobar correcto', v_st = 'aprobada', v_st);
  exception when others then
    insert into pg_temp.instagram_prueba values ('aprobar correcto', false, sqlerrm);
  end;

  -- Cambiar el texto de una aprobada la devuelve a borrador.
  update public.instagram_posts set caption = caption || ' ' where id = v_id;
  select status into v_st from public.instagram_posts where id = v_id;
  insert into pg_temp.instagram_prueba values ('editar aprobada → borrador', v_st = 'borrador', v_st);

  -- Cambiar láminas de una aprobada la devuelve a borrador.
  update public.instagram_posts set status = 'aprobada' where id = v_id;
  update public.instagram_post_slides set width = 1080 where post_id = v_id;
  select status into v_st from public.instagram_posts where id = v_id;
  insert into pg_temp.instagram_prueba values ('láminas de aprobada → borrador', v_st = 'borrador', v_st);

  -- El cliente no puede poner «publicada».
  begin
    update public.instagram_posts set status = 'publicada', ig_media_id = 'x' where id = v_id;
    insert into pg_temp.instagram_prueba values ('cliente no publica', false, 'lo permitió');
  exception when others then
    insert into pg_temp.instagram_prueba values ('cliente no publica', sqlerrm like '%publicación automática%', sqlerrm);
  end;

  -- No se puede eliminar una aprobada; sí un borrador.
  update public.instagram_posts set status = 'aprobada' where id = v_id;
  begin
    delete from public.instagram_posts where id = v_id;
    insert into pg_temp.instagram_prueba values ('no borrar aprobada', false, 'la borró');
  exception when others then
    insert into pg_temp.instagram_prueba values ('no borrar aprobada', sqlerrm like '%Solo se pueden eliminar%', sqlerrm);
  end;
  update public.instagram_posts set status = 'borrador' where id = v_id;
  delete from public.instagram_posts where id = v_id;
  insert into pg_temp.instagram_prueba values ('borrar borrador', not exists (select 1 from public.instagram_posts where id = v_id), null);
end
$d$;
select * from pg_temp.instagram_prueba;
rollback;
