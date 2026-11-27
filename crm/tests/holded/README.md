# Pruebas de Holded (bloque 1: conexiones)

Sin tocar producción ni Holded:

- `holded-sql.test.mjs` (PGlite): `crm/supabase-holded-conexiones.sql` sobre la estructura real
  (`../importador/esquema-base.sql` + migración del importador), con Vault y pg_cron simulados.
  - 6A/6B/6C y que 6B no se repite.
  - Permisos: authenticated no ve `secreto_id`, ni las cargas, ni Vault, ni puede leer claves.
  - Vista previa: casar por NIF y por nombre normalizado, ambigüedades, crear, errores.
  - Confirmar todo o nada, lote deshacible y reemplazar.
  - Verificación, revocar, borrar empresa y caducidad: cada camino borra su secreto de Vault.
- `../../supabase-functions/holded-conexiones/servicio_test.ts` (Deno): lectura de JSON/CSV/Excel,
  que las claves no vuelven al navegador, solo GET a `api.holded.com`, permisos por 200/403,
  401/429/red.

```sh
cd crm/tests/holded && npm install && npm test
cd crm/supabase-functions && deno test --allow-read holded-conexiones/ _shared/hoja_test.ts
```

## Sonda contra la cuenta DEMO CLAUDE

`sonda-demo.ts` hace 8 GET de solo lectura e imprime códigos y nombres de campos, nunca la clave
ni datos. Se ejecuta en tu terminal, con la clave en una variable que no queda en el historial:

```sh
read -s HOLDED_DEMO_KEY; export HOLDED_DEMO_KEY
deno run --allow-env=HOLDED_DEMO_KEY --allow-net=api.holded.com sonda-demo.ts
unset HOLDED_DEMO_KEY
```
