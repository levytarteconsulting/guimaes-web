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

import { agruparFicheros, clavePieza, leerTextosCsv, medidasFinales, parseCsv, repartirFechas } from "./instagram-util.js";

test("agrupar ficheros: sueltas, carruseles y problemas", () => {
  const r = agruparFicheros(["01-2.jpg", "01-1.png", "02.webp", "03.jpg", "03-1.jpg", "04-1.jpg", "04-1.jpeg", "notas.txt", "foto.jpg", "05-1.jpg", "05-3.jpg", "10.JPG", "06-1.jpg"]);
  const p = Object.fromEntries(r.piezas.map((x) => [x.clave, x]));
  assert.deepEqual(r.piezas.map((x) => x.clave), ["1", "2", "3", "4", "5", "6", "10"]);
  assert.deepEqual(p["1"].ficheros, ["01-1.png", "01-2.jpg"]);
  assert.deepEqual(p["2"].ficheros, ["02.webp"]);
  assert.match(p["3"].errores[0], /a la vez/);
  assert.match(p["4"].errores[0], /repetida/);
  assert.match(p["5"].avisos[0], /no van seguidas/);
  assert.match(p["6"].avisos[0], /imagen suelta/);
  assert.deepEqual(r.ignorados, ["notas.txt", "foto.jpg"]);
  const once = agruparFicheros(Array.from({ length: 11 }, (_, i) => `07-${i + 1}.jpg`));
  assert.equal(once.piezas[0].ficheros.length, 11); // el límite de 10 se comprueba en el resumen (erroresLaminas)
  assert.equal(clavePieza("007"), "7");
});

test("parseCsv: BOM, comillas, saltos de línea y CRLF", () => {
  const t = '﻿pieza;caption;fecha\r\n01;"Línea 1\r\nLínea 2; con ""comillas""";2026-11-10 09:00\r\n02;Sin comillas;\r\n\r\n';
  assert.deepEqual(parseCsv(t), [["pieza", "caption", "fecha"], ["01", 'Línea 1\r\nLínea 2; con "comillas"', "2026-11-10 09:00"], ["02", "Sin comillas", ""]]);
  assert.throws(() => parseCsv('pieza;caption\n01;"sin cerrar'), /comillas sin cerrar/);
});

test("leerTextosCsv: cabecera, fechas, duplicados", () => {
  const r = leerTextosCsv('Pieza;Caption;Fecha\n01;"Hola\nmundo";2026-11-10 09:00\n2;Adiós;\n3;x;10/11/2026\n01;otra;\n;sin pieza;');
  assert.deepEqual(r.errores, []);
  assert.equal(r.porPieza.get("1").caption, "Hola\nmundo");
  assert.equal(r.porPieza.get("1").fecha, "2026-11-10T08:00:00.000Z");
  assert.match(r.porPieza.get("1").errorFila, /más de una vez/);
  assert.equal(r.porPieza.get("2").fecha, null);
  assert.match(r.porPieza.get("3").errorFila, /Fecha no válida/);
  assert.match(r.avisos[0], /sin pieza/);
  assert.match(leerTextosCsv("a,b,c\n1,2,3").errores[0], /cabecera/);
  assert.equal(leerTextosCsv("pieza;caption\n01;Hola").porPieza.get("1").fecha, null);
});

test("repartirFechas: días elegidos, hora de Madrid y días ocupados", () => {
  // Desde el lunes 9-11-2026, lunes y jueves a las 10:00, con el jueves 12 ocupado.
  const r = repartirFechas(3, { desde: "2026-11-09", dias: [0, 3], hora: "10:00", ocupados: new Set(["2026-11-12"]) });
  assert.deepEqual(r, ["2026-11-09T09:00:00.000Z", "2026-11-16T09:00:00.000Z", "2026-11-19T09:00:00.000Z"]);
  assert.deepEqual(repartirFechas(0, { desde: "x", dias: [], hora: "" }), []);
  assert.throws(() => repartirFechas(1, { desde: "2026-11-09", dias: [], hora: "10:00" }), /al menos un día/);
});

test("medidas finales", () => {
  assert.deepEqual(medidasFinales(2160, 2700), { w: 1440, h: 1800 });
  assert.deepEqual(medidasFinales(1080, 1350), { w: 1080, h: 1350 });
});

import { erroresLaminas, esOculto, leerCaption, ordenNatural, organizarLote } from "./instagram-util.js";

test("orden natural y ficheros ocultos", () => {
  assert.deepEqual(["10.jpg", "2.jpg", "1.jpg", "Lámina 11.png", "lamina 3.png"].sort(ordenNatural), ["1.jpg", "2.jpg", "10.jpg", "lamina 3.png", "Lámina 11.png"]);
  assert.equal(esOculto("Lote/.DS_Store"), true);
  assert.equal(esOculto("Lote/01/._1.jpg"), true);
  assert.equal(esOculto("__MACOSX/01/1.jpg"), true);
  assert.equal(esOculto("Lote/01/Thumbs.db"), true);
  assert.equal(esOculto("Lote/01/1.jpg"), false);
  assert.deepEqual(erroresLaminas(10), []);
  assert.match(erroresLaminas(11)[0], /10 como máximo/);
  assert.match(erroresLaminas(0)[0], /No quedan/);
});

test("leerCaption: UTF-8 con y sin BOM, CRLF y no UTF-8", () => {
  const enc = new TextEncoder();
  assert.deepEqual(leerCaption(enc.encode("﻿Renta 2026\r\nLínea dos\r\n\r\n")), { texto: "Renta 2026\nLínea dos", utf8: true });
  assert.deepEqual(leerCaption(enc.encode("Sin BOM ñ")), { texto: "Sin BOM ñ", utf8: true });
  assert.equal(leerCaption(new Uint8Array([0x41, 0xf1, 0x6f])).utf8, false); // «Año» en Latin-1
  assert.equal(leerCaption("﻿hola\r").texto, "hola");
});

test("organizarLote: carpeta con subcarpetas", () => {
  const r = organizarLote([
    "Noviembre/.DS_Store", "Noviembre/textos.csv", "Noviembre/notas.pdf",
    "Noviembre/10 cierre/1.png",
    "Noviembre/2 iva/10.png", "Noviembre/2 iva/2.png", "Noviembre/2 iva/1.png", "Noviembre/2 iva/caption.txt", "Noviembre/2 iva/otro.txt",
    "Noviembre/1 renta/b.jpg", "Noviembre/1 renta/a.jpg", "Noviembre/1 renta/texto.txt",
    "Noviembre/3 sin texto/portada.webp", "Noviembre/3 sin texto/._portada.webp",
    "Noviembre/4 dos txt/1.jpg", "Noviembre/4 dos txt/a.txt", "Noviembre/4 dos txt/b.txt",
    "Noviembre/suelta.jpg",
  ]);
  assert.equal(r.tipo, "carpetas");
  assert.equal(r.raiz, "Noviembre");
  assert.equal(r.csv, "Noviembre/textos.csv");
  assert.equal(r.pideModo, false);
  assert.deepEqual(r.piezas.map((p) => p.nombre), ["1 renta", "2 iva", "3 sin texto", "4 dos txt", "10 cierre"]);
  const [renta, iva, sin, dos] = r.piezas;
  assert.deepEqual(iva.ficheros, ["Noviembre/2 iva/1.png", "Noviembre/2 iva/2.png", "Noviembre/2 iva/10.png"]);
  assert.equal(iva.texto, "Noviembre/2 iva/caption.txt");
  assert.equal(renta.texto, "Noviembre/1 renta/texto.txt"); // único .txt
  assert.deepEqual(renta.ficheros, ["Noviembre/1 renta/a.jpg", "Noviembre/1 renta/b.jpg"]);
  assert.equal(sin.texto, null);
  assert.deepEqual(sin.ficheros, ["Noviembre/3 sin texto/portada.webp"]);
  assert.equal(dos.texto, null);
  assert.match(dos.avisos[0], /ninguno se llama caption.txt/);
  assert.deepEqual(renta.clavesCsv, ["1 renta", "1"]);
  assert.deepEqual(r.piezas.map((p) => p.slug), ["01", "02", "03", "04", "05"]);
  assert.ok(r.avisos.some((a) => /notas\.pdf/.test(a)));
  assert.ok(r.avisos.some((a) => /suelta\.jpg/.test(a)));
  assert.ok(!r.avisos.some((a) => /DS_Store|\._portada/.test(a)));
});

test("organizarLote: varias carpetas soltadas a la vez (sin carpeta principal)", () => {
  const r = organizarLote(["01/1.jpg", "01/2.jpg", "02/1.jpg"]);
  assert.equal(r.tipo, "carpetas");
  assert.equal(r.raiz, null);
  assert.deepEqual(r.piezas.map((p) => [p.nombre, p.ficheros.length]), [["01", 2], ["02", 1]]);
  assert.deepEqual(r.piezas[0].clavesCsv, ["1"]);
});

test("organizarLote: la convención NN-M.jpg se mantiene", () => {
  const r = organizarLote(["01.jpg", "02-2.jpg", "02-1.jpg", "textos.csv"]);
  assert.equal(r.tipo, "convencion");
  assert.deepEqual(r.piezas.map((p) => [p.nombre, p.ficheros]), [["01", ["01.jpg"]], ["02", ["02-1.jpg", "02-2.jpg"]]]);
  // NN.jpg sueltas con textos.csv: también convención
  assert.equal(organizarLote(["1.jpg", "2.jpg", "textos.csv"]).tipo, "convencion");
});

test("organizarLote: imágenes sueltas → selector carrusel / una por imagen", () => {
  const conCaption = ["Carrusel IVA/10.png", "Carrusel IVA/2.png", "Carrusel IVA/1.png", "Carrusel IVA/caption.txt", "Carrusel IVA/.DS_Store"];
  const c = organizarLote(conCaption);
  assert.equal(c.tipo, "sueltas");
  assert.equal(c.raiz, "Carrusel IVA");
  assert.equal(c.pideModo, true);
  assert.equal(c.modo, "carrusel");             // por defecto con caption.txt
  assert.equal(c.piezas.length, 1);
  assert.deepEqual(c.piezas[0].ficheros, ["Carrusel IVA/1.png", "Carrusel IVA/2.png", "Carrusel IVA/10.png"]);
  assert.equal(c.piezas[0].texto, "Carrusel IVA/caption.txt");
  assert.equal(c.piezas[0].nombre, "Carrusel IVA");

  const s = organizarLote(conCaption, { modo: "sueltas" });
  assert.equal(s.modo, "sueltas");
  assert.deepEqual(s.piezas.map((p) => p.ficheros[0]), ["Carrusel IVA/1.png", "Carrusel IVA/2.png", "Carrusel IVA/10.png"]);
  assert.ok(s.piezas.every((p) => p.texto === null));
  assert.match(s.avisos.at(-1), /No se usan: caption\.txt/);

  // Sin caption.txt: por defecto, una publicación por imagen; un .txt con el mismo nombre es su texto.
  const f = organizarLote(["foto b.jpg", "foto a.jpg", "foto a.txt"]);
  assert.equal(f.modo, "sueltas");
  assert.equal(f.piezas[0].texto, "foto a.txt");
  // NN.jpg sin guion ni textos.csv: también pregunta.
  assert.equal(organizarLote(["1.jpg", "2.jpg", "caption.txt"]).modo, "carrusel");
  // Una sola imagen: no hay nada que elegir.
  const una = organizarLote(["portada.jpg", "caption.txt"]);
  assert.equal(una.pideModo, false);
  assert.equal(una.piezas[0].texto, "caption.txt");
});
