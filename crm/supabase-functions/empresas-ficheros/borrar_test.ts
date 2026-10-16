// Pruebas del borrado de ficheros de empresas eliminadas.
// Ejecutar desde crm/:  deno test supabase-functions/empresas-ficheros/borrar_test.ts
import assert from "node:assert/strict";
import { Admin, borrarPendientes, LOTE } from "./borrar.ts";

function fake(rutas: string[], fallos: (lote: string[]) => string | null | "throw" = () => null) {
  const marcadas: { rutas: string[]; error: string | null }[] = [];
  const llamadas: string[][] = [];
  const admin: Admin = {
    rpc: async (fn, args) => {
      if (fn === "storage_borrados_pendientes") return { data: rutas.map((ruta) => ({ ruta })), error: null };
      if (fn === "storage_borrados_resultado") { marcadas.push({ rutas: args.p_rutas as string[], error: args.p_error as string | null }); return { data: 1, error: null }; }
      throw new Error("rpc inesperada " + fn);
    },
    storage: { from: (b) => { assert.equal(b, "documentos"); return { remove: async (lote) => {
      llamadas.push(lote);
      const f = fallos(lote);
      if (f === "throw") throw new Error("red caída");
      return { data: f ? null : lote.map((name) => ({ name })), error: f ? { message: f } : null };
    } }; } },
  };
  return { admin, marcadas, llamadas };
}

Deno.test("borra por lotes de 100 y marca cada lote como borrado", async () => {
  const rutas = Array.from({ length: 250 }, (_, i) => `manual/e/${i}/f.pdf`);
  const f = fake(rutas);
  assert.deepEqual(await borrarPendientes(f.admin, null), { encontrados: 250, borrados: 250, errores: 0 });
  assert.deepEqual(f.llamadas.map((l) => l.length), [LOTE, LOTE, 50]);
  assert.ok(f.marcadas.every((m) => m.error === null));
  assert.equal(f.marcadas.flatMap((m) => m.rutas).length, 250);
});

Deno.test("si Storage falla en un lote, ese lote queda pendiente con el error y los demás se borran", async () => {
  const rutas = Array.from({ length: 150 }, (_, i) => `cliente/e/${i}/f.pdf`);
  const f = fake(rutas, (lote) => (lote[0] === rutas[0] ? "Storage 503" : null));
  assert.deepEqual(await borrarPendientes(f.admin, "lote"), { encontrados: 150, borrados: 50, errores: 100 });
  assert.deepEqual(f.marcadas.map((m) => [m.rutas.length, m.error]), [[100, "Storage 503"], [50, null]]);
});

Deno.test("una excepción de red cuenta como error y se registra, sin cortar el resto", async () => {
  const f = fake(["a", "b"], () => "throw");
  assert.deepEqual(await borrarPendientes(f.admin, null), { encontrados: 2, borrados: 0, errores: 2 });
  assert.deepEqual(f.marcadas, [{ rutas: ["a", "b"], error: "red caída" }]);
});

Deno.test("nada pendiente: no llama a Storage", async () => {
  const f = fake([]);
  assert.deepEqual(await borrarPendientes(f.admin, null), { encontrados: 0, borrados: 0, errores: 0 });
  assert.equal(f.llamadas.length, 0);
});
