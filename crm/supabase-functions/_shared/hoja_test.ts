// _shared/hoja.js tiene que ser una copia literal del lector de crm/importador-util.js.
// Ejecutar: deno test --allow-read supabase-functions/_shared/hoja_test.ts (desde crm/)
import { assertEquals } from "jsr:@std/assert@1";

const tramo = (s: string) => {
  const i = s.indexOf("// ---------------------------------------------------------------- CSV");
  const j = s.indexOf("// ---------------------------------------------------------------- columnas");
  return s.slice(i, j < 0 ? undefined : j);
};

Deno.test("hoja.js = lector CSV/XLSX de importador-util.js", () => {
  const original = Deno.readTextFileSync(new URL("../../importador-util.js", import.meta.url));
  const copia = Deno.readTextFileSync(new URL("./hoja.js", import.meta.url));
  assertEquals(tramo(copia), tramo(original));
});
