# Pruebas de Holded (conexiones, consultas del asistente y acciones)

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

- `holded-consultas.test.mjs` (PGlite): `crm/supabase-holded-consultas.sql` encima del bloque 1.
  - 7A/7B/7C y que 7B no se repite.
  - Auditoría cerrada a authenticated; `holded_iniciar`/`holded_terminar` solo service_role.
  - Sin conexión, conexión con error, caché (no cuenta ni mira el cupo), reserva atómica,
    lo no usado se libera, tope mensual (150 por defecto, editable solo por rol admin), mes de Madrid.
- `../../supabase-functions/holded-proxy/holded-proxy_test.ts` (Deno): SOLO LECTURA (falla si sale
  otro método que GET o una ruta fuera de la lista cerrada, o si aparece un método de escritura en
  el código), cupo, caché de 5 min, 429 por minuto (un reintento) y mensual, 401/403, 5 páginas
  como máximo, cálculos de facturas, resumen, contactos y tesorería.
- `../../supabase-functions/agente/agente_test.ts` (Node): herramientas `holded_*` = lo que acepta
  holded-proxy; el modelo recibe los datos pero el historial guarda `[datos de Holded no guardados]`;
  sin conexión o sin cupo → error que prohíbe suponer cifras.

- `holded-acciones.test.mjs` (PGlite): `crm/supabase-holded-acciones.sql` encima de los bloques 1 y 2,
  con pg_net simulado.
  - 8A/8B/8C, que 8B se niega sin el secreto en Vault y no se repite.
  - Propuestas solo por service_role; un documento no puede estar en dos propuestas vivas; política
    automática con topes; aprobar solo rol admin, con el número si son más de 100; caducidad a las 72 h.
  - Cupo de acciones (0 por defecto: no se ejecuta nada), reintentos sin gastar cupo, 3 intentos,
    atascados más de 5 min, pausar, reanudar, cancelar, completar, pg_cron.
- `../../supabase-functions/holded-acciones/holded-acciones_test.ts` (Deno): lista cerrada (solo GET
  `/sales-receipts`, GET `/usage` y POST `/sales-receipts/{id}/approve`), un usuario no puede
  ejecutar, propuesta en días completos con exclusiones y avisos, ritmo de 40/min, Retry-After,
  pausa por 429 mensual/401/403/402.
- `crear-tickets-demo.ts`: crea 3 tickets de prueba pendientes en DEMO CLAUDE (lo lanzas tú con
  `read -s`; ver la cabecera del fichero).

```sh
cd crm/tests/holded && npm install && npm test
cd ../../supabase-functions && deno test --allow-read --no-lock holded-acciones/ holded-proxy/
cd crm/supabase-functions && deno test --allow-read holded-conexiones/ holded-proxy/ _shared/
cd crm && node --experimental-strip-types --test supabase-functions/agente/
```

## Sonda contra la cuenta DEMO CLAUDE

`sonda-demo.ts` hace 8 GET de solo lectura e imprime códigos y nombres de campos, nunca la clave
ni datos. Se ejecuta en tu terminal, con la clave en una variable que no queda en el historial:

```sh
read -s HOLDED_DEMO_KEY; export HOLDED_DEMO_KEY
deno run --allow-env=HOLDED_DEMO_KEY --allow-net=api.holded.com sonda-demo.ts
unset HOLDED_DEMO_KEY
```
