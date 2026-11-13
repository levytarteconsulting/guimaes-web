# Pruebas de `crm/supabase-agente.sql` (PGlite)

Comprueban la migración del agente (bloques 1A, 1B y 1C) en un Postgres en memoria
([PGlite](https://pglite.dev)), sin tocar producción:

- 1A da lo esperado, 1B se aplica y se niega a repetirse, 1C cuadra.
- Las 12 RPC `agente_*`: admin y miembro leen; un admin inactivo y un cliente del
  portal reciben `42501`; `anon` no tiene `EXECUTE`. Límites de filas y textos,
  búsqueda sin acentos, validaciones (`22023`).
- Auditoría: cada usuario ve lo suyo, el rol admin lo de todos; nadie escribe en
  conversaciones ajenas; mensajes y llamadas no se cambian ni se borran.
- Retención: borra solo lo de más de 90 días.

## Ejecutar

```sh
cd crm/tests/agente
npm install
npm test            # o: node agente-sql.test.mjs [ruta/a/otra-migracion.sql]
```

Termina con `N/N ok` y código 0, o lista los `FALLO` y sale con 1.

## Ficheros

- `agente-sql.test.mjs`: la prueba. Crea stubs de Supabase (roles, `auth.uid()`
  leyendo `request.jwt.claim.sub`, `cron.schedule`, `schema_migrations`),
  carga el esquema, aplica la migración y simula usuarios con `set role`.
- `esquema-base.sql`: **solo estructura** (sin datos) de las 15 tablas que usan
  las RPC, con sus políticas de RLS actuales. Sin triggers.

## Regenerar `esquema-base.sql`

Si cambia el esquema de alguna de esas tablas (desde `crm/`, con `~/.guimaes-db.env`):

```sh
source ~/.guimaes-db.env && /opt/homebrew/opt/libpq/bin/pg_dump "$GUIMAES_DB_URL" \
  --schema-only --no-owner --no-privileges \
  -t public.admins -t public.empresas -t public.contactos -t public.contacto_empresa \
  -t public.deals -t public.tareas -t public.notas -t public.leads -t public.documentos \
  -t public.carpetas -t public.whatsapp_conversations -t public.whatsapp_messages \
  -t public.correo_mensajes -t public.correo_adjuntos -t public.empresa_solicitudes \
  | grep -v '^\\' | grep -v '^SET ' | grep -v "set_config('search_path'" | grep -v '^CREATE TRIGGER' \
  > tests/agente/esquema-base.sql
```

Antes de commitearlo, revisar que no lleve secretos (claves, tokens, URLs con
credenciales, comandos de cron): solo debe haber tablas, índices, restricciones y
políticas.
