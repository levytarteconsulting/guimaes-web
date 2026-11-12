// Pruebas de crm/correo-util.js. Ejecutar desde crm/: node --test correo-util.test.js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agruparConversaciones, cidsDe, contraparte, destinatariosTexto, documentoVisor, emailsInvalidos,
  filtrarConversaciones, fmtTamano, listaEmails, mensajeParaResponder, tieneExternas,
} from "./correo-util.js";

const m = (id, o = {}) => ({ id, conversation_id: "c1", carpeta: "inbox", fecha: "2026-11-10T10:00:00Z", leido: true, asunto: "Hola", para: [], cc: [], ...o });

test("agrupar: por conversación, orden interno ascendente y conversaciones por el último", () => {
  const cs = agruparConversaciones([
    m("a", { fecha: "2026-11-10T10:00:00Z", leido: false }),
    m("b", { carpeta: "sentitems", fecha: "2026-11-10T11:00:00Z", asunto: "RE: Hola" }),
    m("c", { conversation_id: "c2", fecha: "2026-11-11T09:00:00Z", contact_id: "k1", empresa_id: "e1" }),
    m("d", { conversation_id: null, fecha: "2026-11-09T09:00:00Z" }),
  ]);
  assert.deepEqual(cs.map((c) => c.id), ["c2", "c1", "m:d"]);
  const c1 = cs[1];
  assert.deepEqual(c1.mensajes.map((x) => x.id), ["a", "b"]);
  assert.equal(c1.asunto, "Hola");
  assert.equal(c1.noLeidos, 1);
  assert.equal(c1.enInbox && c1.enEnviados, true);
  assert.equal(cs[0].contact_id, "k1");
  assert.equal(cs[0].empresa_id, "e1");
});

test("filtros: recibidos, enviados y sin vincular", () => {
  const cs = agruparConversaciones([
    m("a"), m("b", { conversation_id: "c2", carpeta: "sentitems" }), m("c", { conversation_id: "c3", contact_id: "k" }),
  ]);
  assert.deepEqual(filtrarConversaciones(cs, "inbox").map((c) => c.id).sort(), ["c1", "c3"]);
  assert.deepEqual(filtrarConversaciones(cs, "sentitems").map((c) => c.id), ["c2"]);
  assert.deepEqual(filtrarConversaciones(cs, "sin_vincular").map((c) => c.id), ["c1"]);
});

test("contraparte y mensaje al que responder", () => {
  assert.deepEqual(contraparte(m("a", { remitente_email: "x@y.es", remitente_nombre: "X" })), { email: "x@y.es", nombre: "X" });
  assert.deepEqual(contraparte(m("a", { carpeta: "sentitems", para: [{ email: "INFO@guimaes.es" }, { email: "z@y.es", nombre: "Z" }] })), { email: "z@y.es", nombre: "Z" });
  const conv = agruparConversaciones([
    m("a", { fecha: "2026-11-10T10:00:00Z" }), m("b", { fecha: "2026-11-10T11:00:00Z", fuera_bandeja: true }),
    m("c", { carpeta: "sentitems", fecha: "2026-11-10T12:00:00Z" }),
  ])[0];
  assert.equal(mensajeParaResponder(conv).id, "a");
  assert.equal(mensajeParaResponder(agruparConversaciones([m("x", { carpeta: "sentitems" })])[0]), null);
});

test("emails: lista y validación", () => {
  assert.deepEqual(listaEmails(" a@b.es, c@d.es;e@f.es  "), ["a@b.es", "c@d.es", "e@f.es"]);
  assert.deepEqual(emailsInvalidos(["a@b.es", "malo", "x@y"]), ["malo", "x@y"]);
  assert.equal(destinatariosTexto([{ email: "a@b.es", nombre: "A" }, { email: "c@d.es" }]), "A <a@b.es>, c@d.es");
});

test("visor: CSP sin red, cid → blob y externas solo al pedirlo", () => {
  const html = '<p>x</p><img data-cid="image001.png@01DB"><img data-src-externa="https://pixel.invalid/t.gif?a=1&amp;b=2"><img data-cid="otro">';
  assert.deepEqual(cidsDe(html), ["image001.png@01DB", "otro"]);
  assert.equal(tieneExternas(html), true);
  const d1 = documentoVisor(html, { cidUrls: { "image001.png@01DB": "blob:https://guimaes.es/123", otro: "https://malo.invalid/x" } });
  assert.match(d1, /default-src 'none'; img-src data: blob:;/);
  assert.match(d1, /<img src="blob:https:\/\/guimaes.es\/123">/);
  assert.match(d1, /<img data-cid="otro">/, "solo blob: para los cid");
  assert.match(d1, /data-src-externa=/, "externas sin cargar");
  assert.ok(!/src="https:\/\/pixel/.test(d1));
  const d2 = documentoVisor(html, { mostrarExternas: true });
  assert.match(d2, /img-src data: blob: https: http:;/);
  assert.match(d2, /<img src="https:\/\/pixel.invalid\/t.gif\?a=1&amp;b=2">/);
  assert.ok(!documentoVisor('<img data-src-externa="javascript:alert(1)">', { mostrarExternas: true }).includes('src="javascript'));
});

test("tamaño legible", () => {
  assert.equal(fmtTamano(30846), "30 KB");
  assert.equal(fmtTamano(2_500_000), "2,4 MB");
  assert.equal(fmtTamano(12), "12 B");
});
