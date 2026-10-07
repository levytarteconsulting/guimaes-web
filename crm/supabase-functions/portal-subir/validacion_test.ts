// Pruebas de la validación de subidas del área cliente.
// Ejecutar desde crm/:  deno test supabase-functions/portal-subir/validacion_test.ts
// (sin red ni permisos: solo usa node:assert, que viene con Deno).
import assert from "node:assert/strict";
import {
  esUuid,
  extension,
  MAX_BYTES,
  nombreSeguroStorage,
  sanearNombre,
  tipoPermitido,
  validarSolicitud,
} from "./validacion.ts";

const PDF = "application/pdf";

Deno.test("acepta los tipos de la lista con su MIME", () => {
  const casos: [string, string][] = [
    ["Factura.pdf", PDF],
    ["foto.jpg", "image/jpeg"],
    ["foto.JPEG", "image/jpeg"],
    ["captura.png", "image/png"],
    ["IMG_0001.HEIC", "image/heic"],
    ["IMG_0002.heic", "image/heif"],
    ["contrato.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["balance.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["factura-e.xml", "text/xml"],
    ["movimientos.csv", "application/vnd.ms-excel"],
  ];
  for (const [n, m] of casos) {
    const r = validarSolicitud(n, 1000, m);
    assert.equal(r.ok, true, `${n} (${m})`);
  }
});

Deno.test("MIME vacío u octet-stream: se acepta y se usa el canónico", () => {
  const a = validarSolicitud("Factura.pdf", 10, "");
  const b = validarSolicitud("Factura.pdf", 10, "application/octet-stream");
  assert.ok(a.ok && a.mime === PDF);
  assert.ok(b.ok && b.mime === PDF);
  assert.equal(tipoPermitido("csv", undefined), "text/csv");
});

Deno.test("rechaza extensiones fuera de la lista", () => {
  for (const n of ["virus.exe", "macro.docm", "viejo.doc", "viejo.xls", "macro.xlsm", "todo.zip", "todo.rar",
                   "logo.svg", "pagina.html", "nota.txt", "sin_extension", "script.js"]) {
    const r = validarSolicitud(n, 1000, "");
    assert.equal(r.ok, false, n);
  }
});

Deno.test("cuenta la ÚLTIMA extensión (doble extensión)", () => {
  assert.equal(validarSolicitud("factura.pdf.exe", 1000, PDF).ok, false);
  const r = validarSolicitud("informe.final.v2.pdf", 1000, PDF);
  assert.ok(r.ok && r.ext === "pdf");
});

Deno.test("rechaza un MIME que no casa con la extensión", () => {
  assert.equal(validarSolicitud("factura.pdf", 1000, "text/html").ok, false);
  assert.equal(validarSolicitud("foto.png", 1000, "image/jpeg").ok, false);
  assert.equal(validarSolicitud("logo.png", 1000, "image/svg+xml").ok, false);
});

Deno.test("tamaño entre 1 byte y 15 MB", () => {
  assert.equal(validarSolicitud("a.pdf", 0, PDF).ok, false);
  assert.equal(validarSolicitud("a.pdf", -5, PDF).ok, false);
  assert.equal(validarSolicitud("a.pdf", MAX_BYTES + 1, PDF).ok, false);
  assert.equal(validarSolicitud("a.pdf", Number.NaN, PDF).ok, false);
  assert.equal(validarSolicitud("a.pdf", "100", PDF).ok, false);
  assert.equal(validarSolicitud("a.pdf", 1, PDF).ok, true);
  assert.equal(validarSolicitud("a.pdf", MAX_BYTES, PDF).ok, true);
});

Deno.test("nombres: vacío, solo extensión, demasiado largo, no texto", () => {
  assert.equal(validarSolicitud("", 10, PDF).ok, false);
  assert.equal(validarSolicitud("   ", 10, PDF).ok, false);
  assert.equal(validarSolicitud(".pdf", 10, PDF).ok, false);
  assert.equal(validarSolicitud("   .pdf", 10, PDF).ok, false);
  assert.equal(validarSolicitud("a".repeat(147) + ".pdf", 10, PDF).ok, false); // 151
  assert.equal(validarSolicitud("a".repeat(146) + ".pdf", 10, PDF).ok, true); // 150
  assert.equal(validarSolicitud(undefined, 10, PDF).ok, false);
  assert.equal(validarSolicitud(42, 10, PDF).ok, false);
});

Deno.test("saneado: barras, control y espacios fuera; acentos se conservan en el nombre visible", () => {
  assert.equal(sanearNombre("  ../../etc/passwd.pdf "), "....etcpasswd.pdf");
  assert.equal(sanearNombre("a\\b\u0000c\u0007d.pdf"), "abcd.pdf");
  const r = validarSolicitud("  Nómina marzo.pdf ", 10, PDF);
  assert.ok(r.ok && r.nombre === "Nómina marzo.pdf");
  // NFC: "o" + acento combinado → "ó" de un solo carácter.
  assert.equal(sanearNombre("Nómina.pdf".normalize("NFD")), "Nómina.pdf");
});

Deno.test("nombre seguro para Storage (mismo algoritmo que crm/data.js)", () => {
  assert.equal(nombreSeguroStorage("Nómina marzo.pdf"), "Nomina_marzo.pdf");
  assert.equal(nombreSeguroStorage("Año 2026 — cuentas (v2).xlsx"), "Ano_2026_cuentas_v2.xlsx");
  assert.equal(nombreSeguroStorage("ñ.pdf"), "n.pdf");
  assert.equal(nombreSeguroStorage("¿?.pdf"), "documento.pdf");
  assert.equal(nombreSeguroStorage("x".repeat(200) + ".pdf"), "x".repeat(80) + ".pdf");
  // La extensión del nombre seguro coincide con la del original (la RPC lo comprueba).
  for (const n of ["Factura.PDF", "foto.Jpeg", "IMG.HEIC", "a.b.c.csv"]) {
    assert.equal(extension(nombreSeguroStorage(n)), extension(n), n);
  }
});

Deno.test("esUuid", () => {
  assert.equal(esUuid("e0000000-0000-0000-0000-0000000000a1"), true);
  assert.equal(esUuid("E0000000-0000-0000-0000-0000000000A1"), true);
  assert.equal(esUuid("e0000000-0000-0000-0000-0000000000a1' or 1=1"), false);
  assert.equal(esUuid("../x"), false);
  assert.equal(esUuid(null), false);
});
