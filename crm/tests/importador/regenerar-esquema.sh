#!/bin/sh
# Regenera esquema-base.sql desde producción: SOLO estructura (sin datos) de
# las tablas que toca el importador, sus triggers y una lista cerrada de
# funciones. Desde crm/: sh tests/importador/regenerar-esquema.sh
# Revisar el diff antes de commitear: no debe llevar secretos ni net.http_post.
set -e
. ~/.guimaes-db.env
BIN=/opt/homebrew/opt/libpq/bin
OUT=tests/importador/esquema-base.sql
TABLAS="admins empresas contactos contacto_empresa deals tareas notas leads documentos carpetas
        whatsapp_conversations whatsapp_messages correo_mensajes correo_adjuntos correo_borradores
        empresa_solicitudes empresa_cambios"
FUNCIONES="set_updated_at phone_last9 correo_norm correo_contacto_de correo_empresa_de
           resolve_contacto_company sync_contacto_company sync_empresa_rename
           empresas_sembrar_carpetas sembrar_carpetas_por_defecto carpeta_cliente
           deals_rellenar_empresa empresa_principal_de correo_contactos_vincular
           correo_contacto_empresa_vincular is_admin is_admin_role
           agente_norm agente_patron agente_fecha agente_corta
           agente_buscar agente_ficha_empresa agente_ficha_contacto"
TRIGGERS_DE="empresas contactos contacto_empresa deals"
ARGS=""; for t in $TABLAS; do ARGS="$ARGS -t public.$t"; done
LISTA_F=$(printf "'%s'," $FUNCIONES | sed 's/,$//')
LISTA_T=$(printf "'%s'," $TRIGGERS_DE | sed 's/,$//')
{
  echo "-- Generado por regenerar-esquema.sh: estructura de producción, sin datos."
  echo "set check_function_bodies = off;"
  "$BIN/psql" "$GUIMAES_DB_URL" -X -q -At -c "
    select pg_get_functiondef(p.oid) || ';' from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ($LISTA_F)
    order by p.proname"
  "$BIN/pg_dump" "$GUIMAES_DB_URL" --schema-only --no-owner --no-privileges $ARGS \
    | grep -v '^\\' | grep -v '^SET ' | grep -v "set_config('search_path'" | grep -v '^CREATE TRIGGER'
  "$BIN/psql" "$GUIMAES_DB_URL" -X -q -At -c "
    select pg_get_triggerdef(t.oid) || ';' from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relnamespace = 'public'::regnamespace and c.relname in ($LISTA_T)
    order by c.relname, t.tgname"
} > "$OUT"
if grep -n -i -E 'http_post|bearer|eyJ|x-hook-secret|decrypted_secret' "$OUT"; then
  echo "ATENCIÓN: posible secreto en $OUT" >&2; exit 1
fi
echo "ok: $(wc -l < "$OUT") líneas en $OUT"
