-- ============================================================
-- GUIMAES — RLS: solo administradores activos en las tablas del CRM
--
-- Las tablas más antiguas se crearon con políticas "to authenticated using
-- (true)": cualquier sesión válida tenía acceso total. Era seguro solo
-- mientras las únicas cuentas fueran de administradores; con el área de
-- cliente (registro propio) cualquier cliente podría leer y modificar
-- todo el CRM con la clave pública. Este fichero las sustituye por
-- public.is_admin() (admins.activo = true), el mismo criterio que ya usan
-- admins, empresas, contacto_empresa, documentos y carpetas.
--
-- ES LA ÚNICA FUENTE de las políticas de estas tablas. Los ficheros base
-- (supabase-contactos.sql, -deals, -tareas, -notas, -leads, -whatsapp)
-- ya no crean políticas — antes recreaban las "using (true)" cada vez que
-- se volvían a ejecutar. No pueden usar is_admin() ellos mismos:
-- supabase-admins.sql (que la define) va después de supabase-contactos.sql
-- (que define set_updated_at(), que admins necesita). Si este fichero aún
-- no se ha ejecutado, esas tablas tienen RLS activada y ninguna política:
-- nadie salvo service_role puede leerlas (falla cerrado, no abierto).
--
-- Se mantiene a propósito: "web puede insertar leads" (supabase-leads.sql),
-- INSERT para anon y authenticated. Es el formulario público de la web
-- (assets/app.js), que inserta sin leer nada después. authenticated sigue
-- incluido porque la web usa el mismo proyecto de Supabase en el mismo
-- dominio: si alguien con sesión abierta del CRM rellena el formulario, la
-- petición va como authenticated. Insertar un lead no da acceso a leer
-- ninguno.
--
-- Fuera de este fichero: service_role (Edge Functions) y las funciones
-- SECURITY DEFINER / pg_cron (que corren como el dueño de las tablas) no
-- pasan por RLS — ver BLOQUE D para comprobarlo.
--
-- Requiere: supabase-admins.sql (public.is_admin()) y las tablas creadas.
--
-- (select public.is_admin()) y no public.is_admin() a secas: envuelta en
-- un select, Postgres la evalúa UNA vez por consulta en vez de una vez por
-- fila (es SECURITY DEFINER, así que no se puede "inlinear"). Con
-- whatsapp_messages eso es la diferencia entre una consulta a admins o
-- miles.
--
-- Ejecutar en Supabase → SQL Editor, bloque a bloque. Idempotente.
-- ============================================================

-- ============================================================
-- BLOQUE A — Revisión (no escribe nada)
-- Todas las políticas actuales de las tablas afectadas y qué les pasará.
-- ============================================================
select tablename, policyname, cmd, roles, qual, with_check,
       case
         when tablename = 'leads' and cmd = 'INSERT' then 'SE MANTIENE (formulario web)'
         when qual = 'true' or with_check = 'true'   then 'SE ELIMINA (using/with check true) → is_admin()'
         else 'se elimina y se recrea con is_admin()'
       end as accion
from pg_policies
where schemaname = 'public'
  and tablename in ('contactos','deals','tareas','notas','leads',
                    'whatsapp_conversations','whatsapp_messages','whatsapp_templates')
order by tablename, cmd, policyname;

-- ============================================================
-- BLOQUE B — El cambio
--
-- Un único bloque DO: todo en una sentencia, así que es atómico y no
-- depende de en qué conexión del pooler caiga cada parte. Primero elimina
-- TODAS las políticas de estas tablas (salvo el INSERT público de leads),
-- también las que se hubieran creado a mano desde el dashboard con otro
-- nombre; luego crea el juego exacto. Mismas operaciones que existían
-- (p. ej. notas no tiene UPDATE, leads no tiene DELETE): solo cambia quién.
-- ============================================================
do $$
declare
  p record;
begin
  for p in
    select tablename, policyname, cmd
    from pg_policies
    where schemaname = 'public'
      and tablename in ('contactos','deals','tareas','notas','leads',
                        'whatsapp_conversations','whatsapp_messages','whatsapp_templates')
  loop
    if p.tablename = 'leads' and p.cmd = 'INSERT' then
      continue;
    end if;
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;

  -- RLS activa en todas (ya lo estaba; idempotente).
  alter table public.contactos              enable row level security;
  alter table public.deals                  enable row level security;
  alter table public.tareas                 enable row level security;
  alter table public.notas                  enable row level security;
  alter table public.leads                  enable row level security;
  alter table public.whatsapp_conversations enable row level security;
  alter table public.whatsapp_messages      enable row level security;
  alter table public.whatsapp_templates     enable row level security;

  -- contactos
  create policy "admins leen contactos"       on public.contactos for select to authenticated using ((select public.is_admin()));
  create policy "admins crean contactos"      on public.contactos for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan contactos" on public.contactos for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "admins borran contactos"     on public.contactos for delete to authenticated using ((select public.is_admin()));

  -- deals
  create policy "admins leen deals"       on public.deals for select to authenticated using ((select public.is_admin()));
  create policy "admins crean deals"      on public.deals for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan deals" on public.deals for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "admins borran deals"     on public.deals for delete to authenticated using ((select public.is_admin()));

  -- tareas
  create policy "admins leen tareas"       on public.tareas for select to authenticated using ((select public.is_admin()));
  create policy "admins crean tareas"      on public.tareas for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan tareas" on public.tareas for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "admins borran tareas"     on public.tareas for delete to authenticated using ((select public.is_admin()));

  -- notas (sin UPDATE: las notas no se editan, igual que antes)
  create policy "admins leen notas"   on public.notas for select to authenticated using ((select public.is_admin()));
  create policy "admins crean notas"  on public.notas for insert to authenticated with check ((select public.is_admin()));
  create policy "admins borran notas" on public.notas for delete to authenticated using ((select public.is_admin()));

  -- leads (el INSERT público se mantiene; sin DELETE, igual que antes)
  create policy "admins leen leads"       on public.leads for select to authenticated using ((select public.is_admin()));
  create policy "admins actualizan leads" on public.leads for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

  -- whatsapp_conversations
  create policy "admins leen whatsapp_conversations"       on public.whatsapp_conversations for select to authenticated using ((select public.is_admin()));
  create policy "admins crean whatsapp_conversations"      on public.whatsapp_conversations for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan whatsapp_conversations" on public.whatsapp_conversations for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "admins borran whatsapp_conversations"     on public.whatsapp_conversations for delete to authenticated using ((select public.is_admin()));

  -- whatsapp_messages
  create policy "admins leen whatsapp_messages"       on public.whatsapp_messages for select to authenticated using ((select public.is_admin()));
  create policy "admins crean whatsapp_messages"      on public.whatsapp_messages for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan whatsapp_messages" on public.whatsapp_messages for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "admins borran whatsapp_messages"     on public.whatsapp_messages for delete to authenticated using ((select public.is_admin()));

  -- whatsapp_templates
  create policy "admins leen whatsapp_templates"       on public.whatsapp_templates for select to authenticated using ((select public.is_admin()));
  create policy "admins crean whatsapp_templates"      on public.whatsapp_templates for insert to authenticated with check ((select public.is_admin()));
  create policy "admins actualizan whatsapp_templates" on public.whatsapp_templates for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
  create policy "admins borran whatsapp_templates"     on public.whatsapp_templates for delete to authenticated using ((select public.is_admin()));
end;
$$;

-- ============================================================
-- BLOQUE C — Comprobación (no escribe nada)
-- ============================================================

-- C1) Estado final de las tablas afectadas: todas con is_admin() salvo el
-- INSERT público de leads.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('contactos','deals','tareas','notas','leads',
                    'whatsapp_conversations','whatsapp_messages','whatsapp_templates')
order by tablename, cmd, policyname;

-- C2) Barrido de TODO public y storage: cualquier política que quede con
-- "true". Debe salir solo "web puede insertar leads".
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname in ('public','storage')
  and (qual = 'true' or with_check = 'true')
order by schemaname, tablename, policyname;

-- C3) Tablas de public con RLS desactivada (debe salir vacío): una tabla
-- sin RLS es accesible entera para cualquiera con la clave pública.
select c.relname as tabla_sin_rls
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity
order by 1;

-- ============================================================
-- BLOQUE D — Quién se salta RLS (no escribe nada)
-- Confirma lo que asumen las Edge Functions, triggers y crons:
--   - service_role con rolbypassrls = true (Edge Functions).
--   - Las tablas son del mismo rol que las funciones SECURITY DEFINER y que
--     agenda los cron (normalmente postgres), y relforcerowsecurity = false:
--     el dueño de una tabla no pasa por su RLS salvo que se fuerce.
-- ============================================================
select rolname, rolbypassrls from pg_roles
where rolname in ('postgres','service_role','authenticated','anon')
order by 1;

select c.relname as tabla, pg_get_userbyid(c.relowner) as dueno, c.relrowsecurity as rls, c.relforcerowsecurity as rls_forzada
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('contactos','deals','tareas','notas','leads','whatsapp_conversations',
                    'whatsapp_messages','whatsapp_templates','documentos','carpetas','admins')
order by 1;

select p.proname as funcion, pg_get_userbyid(p.proowner) as dueno
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.prosecdef
order by 1;

select jobname, username, schedule from cron.job order by 1;
