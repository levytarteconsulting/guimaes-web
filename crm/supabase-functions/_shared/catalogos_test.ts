// Los catálogos de _shared/catalogos.ts tienen que coincidir con crm/data.js.
// Ejecutar desde crm/:
//   node --experimental-strip-types --test supabase-functions/_shared/
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { CICLO_VIDA, ETAPAS, MOTIVOS_PERDIDA, PRIORIDADES, SERVICIOS } from "./catalogos.ts";

// crm/data.js es un IIFE que deja window.CRM: se ejecuta en un contexto
// aislado con un window vacío (solo define funciones y catálogos al cargar).
function cargarCrm() {
  const codigo = fs.readFileSync(new URL("../../data.js", import.meta.url), "utf8");
  const ctx: Record<string, unknown> = { console, Intl };
  ctx.window = ctx;
  vm.runInNewContext(codigo, ctx, { filename: "data.js" });
  // deno-lint-ignore no-explicit-any
  return (ctx as any).CRM;
}
const CRM = cargarCrm();
// Los objetos vienen de otro contexto de vm: se copian para compararlos.
const plano = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("servicios = crm/data.js SERVICES (id, nombre, frecuencia)", () => {
  assert.deepEqual(plano(CRM.SERVICES.map((s: { id: string; name: string; frequency: string }) =>
    ({ id: s.id, nombre: s.name, frecuencia: s.frequency }))), plano(SERVICIOS));
});

test("etapas = crm/data.js STAGES (id, etiqueta, fase)", () => {
  assert.deepEqual(plano(CRM.STAGES.map((s: { id: string; label: string; phase: string }) =>
    ({ id: s.id, etiqueta: s.label, fase: s.phase }))), plano(ETAPAS));
});

for (const [nombre, nuestro, suyo] of [
  ["ciclo de vida = LIFECYCLE", CICLO_VIDA, "LIFECYCLE"],
  ["prioridades = PRIORITIES", PRIORIDADES, "PRIORITIES"],
  ["motivos de pérdida = LOSS_REASONS", MOTIVOS_PERDIDA, "LOSS_REASONS"],
] as const) {
  test(`${nombre} (id, etiqueta)`, () => {
    assert.deepEqual(plano(CRM[suyo].map((o: { id: string; label: string }) => ({ id: o.id, etiqueta: o.label }))), plano(nuestro));
  });
}
