// Pruebas de crm/instagram-util.js. Ejecutar desde crm/: node --test instagram-util.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anadirAviso, AVISO_LEGAL, bytesTexto, contarHashtags, contarMenciones, csvCampo, csvMetricas,
  madridAUtc, madridDia, madridInput, mesCalendario, mesSiguiente, proporcion, textoAUtc, tieneAviso,
} from "./instagram-util.js";

test("hora de Madrid: invierno, verano y cambios de hora", () => {
  assert.equal(madridAUtc(2026, 1, 15, 9, 30), "2026-01-15T08:30:00.000Z");   // CET +1
  assert.equal(madridAUtc(2026, 7, 15, 9, 30), "2026-07-15T07:30:00.000Z");   // CEST +2
  assert.equal(madridAUtc(2026, 3, 29, 1, 59), "2026-03-29T00:59:00.000Z");   // antes del salto
  assert.equal(madridAUtc(2026, 3, 29, 3, 0), "2026-03-29T01:00:00.000Z");    // después del salto
  assert.equal(madridAUtc(2026, 10, 25, 12, 0), "2026-10-25T11:00:00.000Z");  // ya en CET
  assert.equal(madridInput("2026-07-15T07:30:00Z"), "2026-07-15T09:30");
  assert.equal(madridDia("2026-12-31T23:30:00Z"), "2027-01-01");               // ya es día 1 en Madrid
  assert.equal(madridInput(madridAUtc(2026, 11, 5, 18, 45)), "2026-11-05T18:45");
});

test("textoAUtc: formatos válidos e inválidos", () => {
  assert.equal(textoAUtc("2026-11-10 09:00"), "2026-11-10T08:00:00.000Z");
  assert.equal(textoAUtc("2026-11-10T9:05"), "2026-11-10T08:05:00.000Z");
  assert.equal(textoAUtc("2026-04-31 09:00"), null);
  assert.equal(textoAUtc("10/11/2026 09:00"), null);
  assert.equal(textoAUtc("2026-11-10 24:00"), null);
  assert.equal(textoAUtc(""), null);
});

test("contadores de hashtags y menciones", () => {
  assert.equal(contarHashtags("#renta #IVA2026 y #autónomos, no es#esto ni &#39;"), 3);
  assert.equal(contarMenciones("@guimaes_asesoria y @hacienda.es; correo info@guimaes.es"), 2);
});

test("aviso legal", () => {
  assert.equal(tieneAviso("Hola.\n\nINFORMACION general:  no sustituye el asesoramiento profesional"), true);
  assert.equal(tieneAviso("Hola."), false);
  assert.equal(anadirAviso("Hola.  \n"), "Hola.\n\n" + AVISO_LEGAL);
  assert.equal(anadirAviso(""), AVISO_LEGAL);
  const con = "Hola.\n\n" + AVISO_LEGAL;
  assert.equal(anadirAviso(con), con);
});

test("proporciones", () => {
  assert.deepEqual([proporcion(1080, 1350).nombre, proporcion(1080, 1350).ok], ["4:5", true]);
  assert.equal(proporcion(1440, 1801).ok, true);   // redondeo de 1 px
  assert.equal(proporcion(1080, 1440).ok, false);  // 3:4
  assert.equal(proporcion(1080, 1080).nombre, "1:1");
  assert.equal(proporcion(1910, 1000).ok, true);
  assert.equal(proporcion(2000, 1000).ok, false);
});

test("calendario: empieza en lunes y cubre el mes", () => {
  const nov = mesCalendario(2026, 11); // 1 de noviembre de 2026 es domingo
  assert.equal(nov[0][0].key, "2026-10-26");
  assert.equal(nov[0][6].key, "2026-11-01");
  assert.equal(nov.flat().filter((d) => d.enMes).length, 30);
  assert.equal(nov.at(-1).at(-1).key, "2026-12-06");
  const feb = mesCalendario(2027, 2); // 1 de febrero de 2027 es lunes: 4 semanas
  assert.equal(feb.length, 4);
  assert.deepEqual(mesSiguiente({ y: 2026, m: 12 }, 1), { y: 2027, m: 1 });
  assert.deepEqual(mesSiguiente({ y: 2026, m: 1 }, -1), { y: 2025, m: 12 });
});

test("CSV: BOM, separador, comillas y fórmulas", () => {
  assert.equal(csvCampo("a;b"), '"a;b"');
  assert.equal(csvCampo('di "hola"'), '"di ""hola"""');
  assert.equal(csvCampo("=SUMA(A1)"), "'=SUMA(A1)");
  assert.equal(csvCampo(1.5), "1,5");
  assert.equal(csvCampo(-3), "-3");
  const csv = csvMetricas([{ titulo: "Renta; claves", lote: "nov", published_at: "2026-11-05T09:00:00Z", permalink: "https://instagram.com/p/x", slides: [{}, {}], metrics: { reach: 120, likes: 9 }, metrics_at: "2026-11-06T05:15:00Z", caption: "Línea 1\nLínea 2" }]);
  assert.ok(csv.startsWith("﻿Título;Lote;"));
  const fila = csv.split("\r\n")[1];
  assert.ok(fila.startsWith('"Renta; claves";nov;'));
  assert.ok(fila.includes(";2;120;;9;"));
  assert.ok(csv.includes('"Línea 1\nLínea 2"'));
});

test("bytes", () => {
  assert.equal(bytesTexto(512), "512 B");
  assert.equal(bytesTexto(1536 * 1024), "1,5 MB");
  assert.equal(bytesTexto(1073741824), "1,00 GB");
});
