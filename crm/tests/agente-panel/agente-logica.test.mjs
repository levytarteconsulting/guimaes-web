// Tests de crm/agente-logica.js (panel del asistente). Sin dependencias.
// Ejecutar desde crm/:  node --test tests/agente-panel/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  crearLectorSSE, mensajeDeError, avisoDeFin, destinoCrm, urlExterna, contextoDeVista,
  enLinea, markdown, burbujasDeHistorial, anadirTexto, anotarHerramienta, etiquetaHerramienta,
  idDocumento, idsDocumentos, estadoDocumento, AVISO_SIN_RESPUESTA,
} from "../../agente-logica.js";

const ID = "3f1c2b4a-1111-4a2b-8c3d-0123456789ab";

/* ---------------- SSE ---------------- */
test("SSE: eventos partidos en trozos arbitrarios, pings ignorados", () => {
  const flujo = `: ping\n\nevent: conversacion\ndata: {"id":"${ID}"}\n\nevent: texto\ndata: {"delta":"Hola"}\n\n: ping\n\nevent: fin\ndata: {"motivo":"fin","vueltas":1}\n\n`;
  for (const tam of [1, 3, 7, 1000]) {
    const leer = crearLectorSSE();
    const evs = [];
    for (let i = 0; i < flujo.length; i += tam) evs.push(...leer(flujo.slice(i, i + tam)));
    assert.deepEqual(evs.map((e) => e.evento), ["conversacion", "texto", "fin"], `trozos de ${tam}`);
    assert.equal(evs[0].data.id, ID);
    assert.equal(evs[1].data.delta, "Hola");
  }
});
test("SSE: CRLF, data incompleta y JSON roto", () => {
  const leer = crearLectorSSE();
  assert.deepEqual(leer('event: texto\r\ndata: {"delta":"a"}\r\n\r\nevent: texto\ndata: {roto}\n\nevent: texto\ndata: {"del'), [{ evento: "texto", data: { delta: "a" } }]);
  assert.deepEqual(leer('ta":"b"}\n\n'), [{ evento: "texto", data: { delta: "b" } }]);
});

/* ---------------- Errores ---------------- */
test("errores HTTP: 429 y 409 muestran el mensaje del servidor; red y otros, uno genérico", () => {
  assert.equal(mensajeDeError(429, { error: "Has llegado al máximo de 50 preguntas por hoy. Mañana se renueva." }),
    "Has llegado al máximo de 50 preguntas por hoy. Mañana se renueva.");
  assert.match(mensajeDeError(429, null), /máximo de preguntas por hoy/);
  assert.match(mensajeDeError(409, null), /muy larga: empieza una nueva/);
  assert.match(mensajeDeError(401, { error: "x" }), /sesión ha caducado/);
  assert.match(mensajeDeError(500, { error: "detalle interno" }), /no responde ahora mismo/);
  assert.match(mensajeDeError(502, null), /no responde ahora mismo/);
});
test("avisos de fin", () => {
  assert.equal(avisoDeFin("fin"), null);
  assert.equal(avisoDeFin("error"), null);
  for (const m of ["cancelado", "plazo", "vueltas", "max_tokens", "rechazo"]) assert.ok(avisoDeFin(m), m);
});
test("etiquetas de herramientas", () => {
  assert.equal(etiquetaHerramienta("buscar"), "Buscando en el CRM");
  assert.equal(etiquetaHerramienta("desconocida"), "Consultando");
});

/* ---------------- Enlaces ---------------- */
test("enlaces crm: → destino de nav()", () => {
  assert.deepEqual(destinoCrm(`crm:empresa/${ID}`), { name: "empresa", id: ID });
  assert.deepEqual(destinoCrm(`crm:contacto/${ID}`), { name: "contact", id: ID });
  assert.deepEqual(destinoCrm(`crm:deal/${ID}`), { name: "deal", id: ID });
  assert.deepEqual(destinoCrm(`crm:whatsapp/${ID}`), { name: "whatsapp", id: ID });
  assert.deepEqual(destinoCrm(`crm:correo/${ID}`), { name: "inbox", id: null });
  assert.equal(destinoCrm("crm:empresa/no-es-uuid"), null);
  assert.equal(destinoCrm(`crm:config/${ID}`), null);
  assert.equal(destinoCrm(`crm:empresa/${ID}/x`), null);
});
test("urls externas: solo http(s)", () => {
  assert.equal(urlExterna("https://guimaes.es/x"), "https://guimaes.es/x");
  assert.equal(urlExterna("javascript:alert(1)"), null);
  assert.equal(urlExterna("data:text/html,hola"), null);
  assert.equal(urlExterna("/relativa"), null);
});
test("contexto de la vista", () => {
  assert.deepEqual(contextoDeVista({ name: "empresa", id: ID }), { vista: "empresa", id: ID });
  assert.deepEqual(contextoDeVista({ name: "config", id: "notificaciones" }), { vista: "config" });
  assert.deepEqual(contextoDeVista({ name: "home", id: null }), { vista: "home" });
  assert.equal(contextoDeVista({ name: "Mal-Nombre" }), null);
  assert.equal(contextoDeVista(null), null);
});

/* ---------------- Markdown ---------------- */
// Recorre el árbol y junta todas las cadenas (para buscar HTML colado).
const cadenas = (x) => typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(cadenas)
  : x && typeof x === "object" ? Object.values(x).flatMap(cadenas) : [];

test("en línea: negrita, cursiva, código y enlaces", () => {
  assert.deepEqual(enLinea("Hola **Ana** y *b* con `x`"), [
    { t: "texto", v: "Hola " }, { t: "negrita", h: [{ t: "texto", v: "Ana" }] }, { t: "texto", v: " y " },
    { t: "cursiva", h: [{ t: "texto", v: "b" }] }, { t: "texto", v: " con " }, { t: "codigo", v: "x" },
  ]);
  assert.deepEqual(enLinea(`[ACME SL](crm:empresa/${ID})`), [{ t: "crm", v: "ACME SL", destino: { name: "empresa", id: ID } }]);
  assert.deepEqual(enLinea("[web](https://guimaes.es)"), [{ t: "url", v: "web", href: "https://guimaes.es/" }]);
  assert.deepEqual(enLinea("[malo](javascript:alert(1))"), [{ t: "texto", v: "malo" }, { t: "texto", v: ")" }]);
  assert.deepEqual(enLinea("2 * 3 * 4"), [{ t: "texto", v: "2 * 3 * 4" }]);
  assert.deepEqual(enLinea("mi_nombre_largo"), [{ t: "texto", v: "mi_nombre_largo" }]);
});
test("el HTML del modelo queda como texto (no hay nodos html)", () => {
  const arbol = markdown('<img src=x onerror="alert(1)"> **<b>hola</b>**\n\n| a | <script>x</script> |\n|---|---|\n| 1 | 2 |');
  const tipos = new Set(JSON.stringify(arbol).match(/"t":"[a-z]+"/g));
  for (const t of tipos) assert.match(t, /"t":"(p|h|ul|ol|tabla|pre|hr|texto|br|negrita|cursiva|codigo|crm|url)"/);
  assert.ok(cadenas(arbol).some((s) => s.includes("<img src=x")));
});
test("bloques: títulos, listas, tabla, código y párrafos con salto", () => {
  const b = markdown("## Resumen\n\nLínea 1\nLínea 2\n\n- uno\n- **dos**\n\n3. tres\n4. cuatro\n\n| Empresa | Etapa |\n|:--|--:|\n| A | Reunión |\n| B | Propuesta |\n\n```\ncódigo\n```\n\n---");
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "ul", "ol", "tabla", "pre", "hr"]);
  assert.equal(b[0].nivel, 2);
  assert.deepEqual(b[1].h, [{ t: "texto", v: "Línea 1" }, { t: "br" }, { t: "texto", v: "Línea 2" }]);
  assert.equal(b[2].items.length, 2);
  assert.equal(b[3].inicio, 3);
  assert.equal(b[4].cabecera.length, 2);
  assert.equal(b[4].filas.length, 2);
  assert.equal(b[5].v, "código");
});
test("markdown a medio llegar (streaming) no rompe", () => {
  for (const t of ["**neg", "[ACME](crm:empresa/", "| a | b |", "```\nsin cerrar", "- ", "#", ""]) {
    assert.doesNotThrow(() => markdown(t), t);
  }
});

/* ---------------- Historial y streaming ---------------- */
test("historial: pregunta + varias vueltas → dos burbujas; rechazo como aviso", () => {
  const filas = [
    { orden: 4, rol: "assistant", tipo: "modelo", texto: "Respuesta final", stop_reason: "end_turn" },
    { orden: 1, rol: "user", tipo: "pregunta", texto: "¿Qué tal ACME?", stop_reason: null },
    { orden: 2, rol: "assistant", tipo: "modelo", texto: "Lo busco.", stop_reason: "tool_use" },
    { orden: 3, rol: "user", tipo: "herramientas", texto: null, stop_reason: null },
    { orden: 5, rol: "user", tipo: "pregunta", texto: "¿Y esto otro?", stop_reason: null },
    { orden: 6, rol: "assistant", tipo: "modelo", texto: null, stop_reason: "refusal" },
  ];
  const b = burbujasDeHistorial(filas);
  assert.deepEqual(b.map((x) => x.rol), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(b[1].partes.map((p) => p.texto), ["Lo busco.", "Respuesta final"]);
  assert.ok(b[3].aviso);
  assert.equal(b[3].partes.length, 0);
});
test("streaming: texto se concatena; herramientas por id, en orden", () => {
  let p = [];
  p = anadirTexto(p, "Bus");
  p = anadirTexto(p, "co.");
  p = anotarHerramienta(p, { id: "t1", nombre: "buscar", estado: "inicio" });
  p = anotarHerramienta(p, { id: "t2", nombre: "ficha_empresa", estado: "inicio" });
  p = anotarHerramienta(p, { id: "t1", nombre: "buscar", estado: "fin", filas: 3 });
  p = anotarHerramienta(p, { id: "t2", nombre: "ficha_empresa", estado: "fin", error: true });
  p = anadirTexto(p, "Listo");
  assert.deepEqual(p, [
    { tipo: "texto", texto: "Busco." },
    { tipo: "herramienta", id: "t1", nombre: "buscar", estado: "fin", filas: 3, error: false },
    { tipo: "herramienta", id: "t2", nombre: "ficha_empresa", estado: "fin", filas: undefined, error: true },
    { tipo: "texto", texto: "Listo" },
  ]);
});

/* ---------------- Documentos (doc:ID) ---------------- */
const DOC = "9a8b7c6d-1234-4abc-9def-0123456789ab";
test("doc: con uuid válido → nodo doc; en mayúsculas se normaliza", () => {
  assert.equal(idDocumento(`doc:${DOC}`), DOC);
  assert.equal(idDocumento(`doc:${DOC.toUpperCase()}`), DOC);
  assert.deepEqual(enLinea(`Ver [contrato.pdf](doc:${DOC}) ya`), [
    { t: "texto", v: "Ver " }, { t: "doc", v: "contrato.pdf", id: DOC }, { t: "texto", v: " ya" },
  ]);
});
test("doc: con id no válido → texto plano (sin acciones)", () => {
  for (const malo of ["doc:123", "doc:", `doc:${DOC}x`, `doc:${DOC}/otro`, "doc:../../etc", `docs:${DOC}`]) {
    assert.equal(idDocumento(malo), null, malo);
    const n = enLinea(`[f.pdf](${malo})`);
    assert.ok(n.every((x) => x.t === "texto"), malo);
    assert.equal(n[0].v, "f.pdf", malo);
  }
});
test("doc: dentro de tablas y listas", () => {
  const b = markdown(`| Documento | Carpeta |\n|---|---|\n| [a.pdf](doc:${DOC}) | Fiscal |\n\n- [b.png](doc:${DOC})`);
  assert.deepEqual(b[0].filas[0][0], [{ t: "doc", v: "a.pdf", id: DOC }]);
  assert.deepEqual(b[1].items[0], [{ t: "doc", v: "b.png", id: DOC }]);
});
test("idsDocumentos: únicos, solo válidos, ignora enlaces a medio llegar", () => {
  const otro = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(idsDocumentos(`[a](doc:${DOC}) [b](doc:${DOC.toUpperCase()}) [c](doc:${otro}) [d](doc:xx) [e](crm:empresa/${otro}) [f](doc:${DOC.slice(0, 10)}`),
    [DOC, otro]);
  assert.deepEqual(idsDocumentos(""), []);
});
test("estado del documento: solo 'stored' tiene acciones", () => {
  assert.deepEqual(estadoDocumento({ status: "stored" }), { acciones: true, aviso: null });
  for (const [st, aviso] of [["pending", /descarg/i], ["failed", /no se pudo/i], ["too_large", /grande/i], ["raro", /no disponible/i]]) {
    const e = estadoDocumento({ status: st });
    assert.equal(e.acciones, false, st);
    assert.match(e.aviso, aviso, st);
  }
  assert.deepEqual(estadoDocumento(null), { acciones: false, aviso: "No encontrado" });
  assert.equal(estadoDocumento(undefined).cargando, true);
  assert.equal(estadoDocumento(undefined).acciones, false);
});

/* ---------------- Bug: pregunta duplicada en el historial ---------------- */
test("historial: pregunta sin respuesta repetida igual → una sola burbuja", () => {
  // Lo que había en producción: pregunta (falló), la misma 10 min después, respuesta.
  const b = burbujasDeHistorial([
    { orden: 0, rol: "user", tipo: "pregunta", texto: "¿Qué documentos tiene ACME?" },
    { orden: 1, rol: "user", tipo: "pregunta", texto: "¿Qué documentos tiene ACME? " },
    { orden: 2, rol: "assistant", tipo: "modelo", texto: "Busco.", stop_reason: "tool_use" },
    { orden: 3, rol: "user", tipo: "herramientas", texto: null },
    { orden: 4, rol: "assistant", tipo: "modelo", texto: "Tiene 3.", stop_reason: "end_turn" },
  ]);
  assert.deepEqual(b.map((x) => x.rol), ["user", "assistant"]);
  assert.equal(b.filter((x) => x.rol === "user").length, 1);
  assert.deepEqual(b[1].partes.map((p) => p.texto), ["Busco.", "Tiene 3."]);
});
test("historial: pregunta sin respuesta seguida de otra distinta → aviso, sin duplicar", () => {
  const b = burbujasDeHistorial([
    { orden: 0, rol: "user", tipo: "pregunta", texto: "Primera" },
    { orden: 1, rol: "user", tipo: "pregunta", texto: "Segunda" },
    { orden: 2, rol: "assistant", tipo: "modelo", texto: "Respuesta", stop_reason: "end_turn" },
  ]);
  assert.deepEqual(b.map((x) => x.rol), ["user", "assistant", "user", "assistant"]);
  assert.equal(b[1].aviso, AVISO_SIN_RESPUESTA);
  assert.deepEqual(b.filter((x) => x.rol === "user").map((x) => x.texto), ["Primera", "Segunda"]);
});
test("historial: la última pregunta sin respuesta queda marcada", () => {
  const b = burbujasDeHistorial([{ orden: 0, rol: "user", tipo: "pregunta", texto: "Hola" }]);
  assert.deepEqual(b.map((x) => x.rol), ["user", "assistant"]);
  assert.equal(b[1].aviso, AVISO_SIN_RESPUESTA);
});
test("historial normal: nunca dos burbujas de usuario seguidas", () => {
  const filas = [];
  for (let i = 0; i < 5; i++) {
    filas.push({ orden: i * 2, rol: "user", tipo: "pregunta", texto: "P" + i });
    filas.push({ orden: i * 2 + 1, rol: "assistant", tipo: "modelo", texto: "R" + i, stop_reason: "end_turn" });
  }
  const b = burbujasDeHistorial(filas);
  assert.equal(b.length, 10);
  for (let i = 1; i < b.length; i++) assert.notEqual(b[i].rol, b[i - 1].rol);
});
