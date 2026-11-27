// Pruebas de crm/importador-util.js (lector de xlsx/csv, correspondencia de
// columnas, normalización y catálogos). Uso: node importador-util.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {
  casar, casarAdmin, CAMPOS, construirFilas, FRECUENCIAS, incidencias, leerCsv, leerEntero, leerImporte,
  leerXlsx, mapeoInicial, norm, normCif, normEmail, normTelefono,
} from "../../importador-util.js";
import { CABECERAS, FILAS, csv, xlsx } from "./generar-ejemplo.mjs";

// Catálogos reales del CRM (crm/data.js), cargado como en el navegador.
const ctx = { window: {}, console, Intl };
vm.runInNewContext(fs.readFileSync(new URL("../../data.js", import.meta.url), "utf8"), ctx);
const CRM = ctx.window.CRM;
const ADMINS = [{ id: "id-ana", name: "Ana", activo: true }, { id: "id-mario", name: "Mario", activo: true },
                { id: "id-guille", name: "Guillermo", activo: true }, { id: "id-iris", name: "Iris", activo: false }];
export const CAT = { servicios: CRM.SERVICES, etapas: CRM.STAGES, lifecycle: CRM.LIFECYCLE, prioridades: CRM.PRIORITIES, admins: ADMINS };

test("los catálogos de la migración coinciden con crm/data.js", () => {
  const sql = fs.readFileSync(new URL("../../supabase-importador.sql", import.meta.url), "utf8");
  const arr = (n) => JSON.stringify(sql.match(new RegExp(`${n}\\s+text\\[\\] := array\\[([^\\]]*)\\]`))[1].split(",").map((s) => s.trim().replace(/'/g, "")));
  assert.equal(arr("c_etapas"), JSON.stringify(CRM.STAGES.map((s) => s.id)));
  assert.equal(arr("c_ciclo"), JSON.stringify(CRM.LIFECYCLE.map((s) => s.id)));
  assert.equal(arr("c_prioridad"), JSON.stringify(CRM.PRIORITIES.map((s) => s.id)));
  assert.equal(arr("c_frecuencia"), JSON.stringify(FRECUENCIAS.map((s) => s.id)));
  const serv = JSON.parse(sql.match(/c_servicios\s+jsonb := '([^']*)'/)[1]);
  assert.deepEqual(serv, Object.fromEntries(CRM.SERVICES.map((s) => [s.id, s.name])));
});

test("normalización", () => {
  assert.equal(normCif(" b-123.456 78 "), "B12345678");
  assert.equal(normEmail("  Laura@Ejemplo.INVALID "), "laura@ejemplo.invalid");
  assert.equal(normTelefono("600222333.0"), "600222333");
  assert.equal(normTelefono("+34 611-444-555"), "34611444555");
  assert.equal(leerEntero("12.0"), 12); assert.equal(leerEntero(""), null); assert.ok(Number.isNaN(leerEntero("muchos")));
  assert.deepEqual(leerImporte("1800"), { valor: 1800, dudoso: false });
  assert.deepEqual(leerImporte("3.200,50"), { valor: 3200.5, dudoso: false });
  assert.deepEqual(leerImporte("1,800.50"), { valor: 1800.5, dudoso: false });
  assert.deepEqual(leerImporte("650 €"), { valor: 650, dudoso: false });
  assert.deepEqual(leerImporte("12,5"), { valor: 12.5, dudoso: false });
  assert.deepEqual(leerImporte("1.800"), { valor: 1800, dudoso: true });
  assert.equal(leerImporte("0").valor, null); assert.equal(leerImporte("").valor, null);
  assert.ok(Number.isNaN(leerImporte("mil").valor));
  assert.equal(norm("  Planificación   FISCAL "), "planificacion fiscal");
});

test("catálogos: sin tildes ni mayúsculas, por id, nombre o abreviatura", () => {
  assert.equal(casar("planificacion fiscal", CRM.SERVICES), "s2");
  assert.equal(casar("Contable", CRM.SERVICES), "s3");
  assert.equal(casar("s6", CRM.SERVICES), "s6");
  assert.equal(casar("Reunión", CRM.STAGES), "reunion");
  assert.equal(casar("REUNION", CRM.STAGES), "reunion");
  assert.equal(casar("Propuesta enviada", CRM.STAGES), "propuesta");
  assert.equal(casar("Cliente activo", CRM.LIFECYCLE), "active_client");
  assert.equal(casar("Alta", CRM.PRIORITIES), "high");
  assert.equal(casar("MENSUAL", FRECUENCIAS), "mensual");
  assert.equal(casar("Captación de clientes", CRM.SERVICES), null);
  assert.equal(casar("Ganado", CRM.STAGES), null);
});

test("responsable: por nombre completo, palabras o nombre de pila", () => {
  const a = [...ADMINS, { id: "id-ana2", name: "Ana Torres", activo: true }];
  assert.equal(casarAdmin("Guillermo Guimaes", ADMINS).id, "id-guille");
  assert.equal(casarAdmin("guillermo", ADMINS).id, "id-guille");
  assert.equal(casarAdmin("Mario Prueba Apellido", ADMINS).id, "id-mario");
  assert.equal(casarAdmin("Iris", ADMINS).id, null);                 // inactiva
  assert.equal(casarAdmin("Nadie", ADMINS).id, null);
  assert.equal(casarAdmin("Ana Torres", a).id, "id-ana2");           // exacto gana
  const amb = casarAdmin("Ana Inventada", a);                         // "Ana" ⊂ texto; "Ana Torres" no
  assert.equal(amb.id, "id-ana");
  assert.equal(casarAdmin("ana", a).id, "id-ana");                    // exacto
  assert.equal(casarAdmin("ana lópez", [{ id: "1", name: "Ana Torres" }, { id: "2", name: "Ana Ruiz" }]).ambiguo, true);
});

test("CSV: separador, comillas, BOM y filas vacías finales", () => {
  const f = leerCsv('﻿A;B;C\r\n"x;1";"di ""y""";\r\n2;;3\r\n;;\r\n');
  assert.deepEqual(f, [["A", "B", "C"], ["x;1", 'di "y"', ""], ["2", "", "3"]]);
  assert.deepEqual(leerCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("xlsx de ejemplo: textos compartidos, en línea, ricos, números y huecos", async () => {
  const buf = xlsx([CABECERAS, ...FILAS]);
  const f = await leerXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.deepEqual(f[0], CABECERAS);
  assert.equal(f.length, FILAS.length + 1);
  assert.equal(f[1][0], "Talleres Ficticios SL");
  assert.equal(f[1][6], "600222333");             // número
  assert.equal(f[2][2], "");                        // hueco sin celda
  assert.equal(f[2][3], "Óscar Demo");
  assert.equal(f[12][3], "Rich Texto");            // texto rico, sin la pronunciación
  assert.equal(f[12][6], "600555666");             // notación científica → dígitos
  assert.deepEqual(f[11].filter(Boolean), []);      // fila vacía en medio
  await assert.rejects(leerXlsx(new TextEncoder().encode("no es un zip").buffer), /no es un .xlsx/);
});

test("correspondencia inicial con las cabeceras habituales (dos 'Etapa')", () => {
  const m = mapeoInicial(CABECERAS);
  assert.deepEqual(CAMPOS.map((c) => m[c.id]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  const otro = mapeoInicial(["Teléfono", "EMPRESA", "e-mail", "Etapa del negocio", "Servicio"]);
  assert.equal(otro.empresa, 1); assert.equal(otro.telefono, 0); assert.equal(otro.email, 2);
  assert.equal(otro.etapa_negocio, 3); assert.equal(otro.etapa_contacto, -1); assert.equal(otro.cif, -1);
});

test("construirFilas con el archivo de ejemplo", () => {
  const filas = [CABECERAS, ...FILAS.map((f) => f.map((v) => (Array.isArray(v) ? v[0] : v)))];
  const r = construirFilas(filas, mapeoInicial(CABECERAS), CAT);
  const fila = (n) => r.find((x) => x.fila === n);
  assert.equal(r.length, FILAS.length - 1);         // la vacía no cuenta
  const f2 = fila(2).datos;
  assert.deepEqual(f2.empresa, { nombre: "Talleres Ficticios SL", cif: "B11111111", direccion: "Av. Falsa 2, Madrid", empleados: "5" });
  assert.deepEqual(f2.contacto, { nombre: "Laura Prueba", email: "laura@ejemplo.invalid", telefono: "600222333", etapa: "new", owner: "id-ana" });
  assert.deepEqual(f2.negocio, { servicio: "s1", etapa: "cliente_activo", importe: "1800", frecuencia: "mensual", owner: "id-ana", prioridad: "high" });
  const f3 = fila(3).datos;
  assert.equal(f3.negocio.importe, "3200.5"); assert.equal(f3.negocio.frecuencia, "anual"); assert.equal(f3.negocio.prioridad, "medium");
  assert.equal(f3.contacto.telefono, "611444555"); assert.equal(f3.contacto.etapa, "opportunity");
  assert.equal(fila(5).datos.negocio.importe, "");  // 0 → vacío (nulo en la base)
  assert.equal(fila(5).datos.negocio.servicio, "s3");
  assert.equal(fila(6).datos.empresa.empleados, "3");
  assert.equal(fila(6).datos.negocio.importe, "650");
  assert.equal(fila(7).datos.negocio, null);
  assert.equal(fila(8).datos.contacto.telefono, "600333444");
  assert.equal(fila(8).datos.negocio.owner, "id-mario");
  assert.equal(fila(10).datos.contacto, null);
  assert.equal(fila(13).datos.contacto.telefono, "600555666");
  const malo = fila(11);
  assert.equal(malo.datos, null);
  assert.equal(malo.errores.length, 8, malo.errores.join(" | "));
  assert.ok(malo.errores.some((e) => /Servicio «Servicio Inventado»/.test(e)));
  assert.ok(malo.errores.some((e) => /Responsable «Nadie»/.test(e)));
  const inc = incidencias(r, [{ fila: 4, errores: [], avisos: ["Negocio duplicado"] }, { fila: 2, errores: [], avisos: [] }]);
  assert.deepEqual(inc.map((x) => x.fila), [4, 11]);
});

test("CSV de ejemplo da lo mismo que el xlsx", async () => {
  const buf = xlsx([CABECERAS, ...FILAS]);
  const a = await leerXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const b = leerCsv(csv([CABECERAS, ...FILAS.map((f) => f.map((v) => (Array.isArray(v) ? v[0] : v)))]));
  const m = mapeoInicial(CABECERAS);
  const ca = construirFilas(a, m, CAT), cb = construirFilas(b, m, CAT);
  // El xlsx convierte 6.00555666E+8 a dígitos; en el CSV llega tal cual (texto).
  assert.deepEqual(ca.filter((x) => x.fila !== 13), cb.filter((x) => x.fila !== 13));
});
