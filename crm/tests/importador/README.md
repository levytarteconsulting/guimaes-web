# Pruebas del importador de clientes (PGlite)

Comprueban `crm/supabase-importador.sql` y `crm/importador-util.js` sin tocar producción.

- `importador-sql.test.mjs`: estructura real de producción (`esquema-base.sql`) en PGlite.
  - 4A, 4B y 4C, y que 4B se niega a ejecutarse dos veces.
  - Permisos: miembro, admin inactivo y anon reciben 42501.
  - Vista previa sin escrituras, errores bloqueantes y duplicados (en el CRM y dentro del archivo).
  - Huecos rellenados, `visto_at` y que no se escribe en leads ni en tareas.
  - Atomicidad.
  - Deshacer, con y sin cambios posteriores, y lotes encadenados.
  - `agente_buscar`, `agente_ficha_empresa` y `agente_ficha_contacto`.
  - El Excel de ejemplo de punta a punta.
- `importador-util.test.mjs`: lector de `.xlsx` y `.csv`, correspondencia de columnas,
  normalización, catálogos (y que los de la migración coinciden con `crm/data.js`) y
  responsables.
- `generar-ejemplo.mjs`: genera `ejemplo-clientes.xlsx` y `.csv` con datos inventados.

## Ejecutar

```sh
cd crm/tests/importador
npm install
npm test
```

## Regenerar `esquema-base.sql`

Desde `crm/`: `sh tests/importador/regenerar-esquema.sh`. Solo vuelca estructura, triggers y
una lista cerrada de funciones, y se niega a escribir el fichero si detecta algo que parezca un
secreto. Revisa el diff antes de commitear.
