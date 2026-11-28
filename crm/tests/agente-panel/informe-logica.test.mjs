// Tests de crm/informe-logica.js (gráficos y PDF de los informes). Sin dependencias.
// Ejecutar desde crm/:  node --test tests/agente-panel/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PALETA, fmtNum, marcasEje, porcionesTarta, arco, geometria, recortar, nombrePdf, anchosColumnas, columnaNumerica, celda, peticionDe, textoPdf,
} from "../../informe-logica.js";

const nb = (s) => s.replace(/ | /g, " ");
test("números en español: €, %, enteros, compactos", () => {
  assert.equal(nb(fmtNum(1234.5, "€")), "1234,50 €");   // en español, 4 cifras sin separador de miles
  assert.equal(nb(fmtNum(12345, "€")), "12.345 €");
  assert.equal(nb(fmtNum(1500000, "€", true)), "1,5 M €");
  assert.equal(nb(fmtNum(12.5, "%")), "12,5 %");
  assert.equal(fmtNum(7, ""), "7");
  assert.equal(fmtNum(null), "—");
  assert.equal(nb(fmtNum(3, "nóminas")), "3 nóminas");
});

test("eje: incluye el 0, cubre el rango y usa pasos redondos", () => {
  assert.deepEqual(marcasEje(0, 95), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(marcasEje(120, 130), [0, 50, 100, 150]);
  assert.deepEqual(marcasEje(-30, 40), [-40, -20, 0, 20, 40]);
  assert.deepEqual(marcasEje(0, 0), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual(marcasEje(0, 2.5e6).slice(0, 2), [0, 500000]);
});

test("tarta: sin ceros ni negativos, de mayor a menor, como mucho 8 (resto en «Otros»), colores en orden", () => {
  const p = porcionesTarta(["a", "b", "c", "d"], [10, 0, 30, -5]);
  assert.deepEqual(p.map((x) => x.etiqueta), ["c", "a"]);
  assert.deepEqual(p.map((x) => x.color), PALETA.slice(0, 2));
  assert.ok(Math.abs(p[0].pct - 0.75) < 1e-9);
  assert.ok(Math.abs(p.at(-1).a1 - (-Math.PI / 2 + 2 * Math.PI)) < 1e-9, "cierra la vuelta");
  const muchas = porcionesTarta("abcdefghij".split(""), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(muchas.length, 8);
  assert.equal(muchas[7].etiqueta, "Otros");
  assert.equal(muchas[7].valor, 6);
  assert.match(arco(50, 50, 40, 0, Math.PI / 2), /^M 50 50 L 90\.00 50\.00 A 40 40 0 0 1 50\.00 90\.00 Z$/);
  assert.match(arco(50, 50, 40, 0, 2 * Math.PI), /A 40 40 0 1 1/);
});

test("geometría: barras agrupadas con 2 px de separación y anclaje en el 0; líneas con un punto por etiqueta", () => {
  const g = { tipo: "barras", etiquetas: ["e", "f"], series: [{ nombre: "A", valores: [10, -5] }, { nombre: "B", valores: [20, 5] }] };
  const r = geometria(g, 560, 260);
  assert.equal(r.barras.length, 4);
  const [a0, a1, b0] = [r.barras[0], r.barras[1], r.barras[2]];
  assert.ok(Math.abs(b0.x - (a0.x + a0.w + 2)) < 1e-9, "2 px entre series");
  assert.ok(Math.abs(a0.y + a0.h - r.y(0)) < 1e-6, "la positiva sale del 0 hacia arriba");
  assert.ok(Math.abs(a1.y - r.y(0)) < 1e-6 && !a1.positivo, "la negativa sale del 0 hacia abajo");
  const l = geometria({ tipo: "lineas", etiquetas: ["1", "2", "3"], series: [{ nombre: "A", valores: [1, 2, 3] }] }, 560, 260);
  assert.equal(l.lineas[0].puntos.length, 3);
  assert.ok(l.lineas[0].puntos[0].y > l.lineas[0].puntos[2].y, "sube");
  const n = geometria({ tipo: "lineas", etiquetas: Array.from({ length: 60 }, (_, i) => String(i)), series: [{ nombre: "A", valores: Array(60).fill(1) }] }, 560, 260);
  assert.ok(n.salto > 1, "con 60 etiquetas no se pintan todas");
});

test("PDF: nombre del fichero, anchos de columna, alineación y celdas", () => {
  assert.equal(nombrePdf('Ventas: 2026 / "MDF"', new Date(2026, 10, 28)), "Informe - Ventas 2026 MDF - 2026-11-28.pdf");
  assert.equal(nombrePdf("", new Date(2026, 0, 5)), "Informe - informe - 2026-01-05.pdf");
  const a = anchosColumnas(["Empresa", "Nº"], [["Panadería Inventada SL", 3]], 180);
  assert.ok(Math.abs(a[0] + a[1] - 180) < 1e-9 && a[0] > a[1]);
  assert.equal(columnaNumerica([[1, "a"], [null, "b"]], 0), true);
  assert.equal(columnaNumerica([[1, "a"]], 1), false);
  assert.equal(nb(celda(12345.5)), "12.345,5");
  assert.equal(celda(null), "—");
  assert.equal(recortar("abcdef", 4), "abc…");
});

test("guardar informe: la petición es la última pregunta antes de la respuesta", () => {
  const bs = [{ rol: "user", texto: "uno" }, { rol: "assistant" }, { rol: "user", texto: "Gráfico de ventas" }, { rol: "assistant" }];
  assert.equal(peticionDe(bs, 3), "Gráfico de ventas");
  assert.equal(peticionDe(bs, 1), "uno");
  assert.equal(peticionDe(bs, 0), "");
});

test("PDF: el texto se queda en lo que pueden dibujar las fuentes estándar", () => {
  assert.equal(textoPdf("Facturación «2026»: 1.234,50 € — señor Muñoz… ✓ 📈"), "Facturación «2026»: 1.234,50 € — señor Muñoz… OK ");
  assert.equal(textoPdf("≥ 100 → bien"), ">= 100 -> bien");
  assert.equal(textoPdf(null), "");
});
