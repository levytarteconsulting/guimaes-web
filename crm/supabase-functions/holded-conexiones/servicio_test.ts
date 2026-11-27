// Pruebas de holded-conexiones con la base de datos y Holded simulados.
// Ejecutar (desde crm/supabase-functions):
//   deno test --allow-read holded-conexiones/ _shared/
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { atender, type Deps } from "./servicio.ts";
import { leerArchivo } from "./archivo.ts";
import { verificarClave } from "./verificar.ts";
import { holdedGet } from "../_shared/holded.ts";

const CLAVE = "pat_" + "a1".repeat(44) + "WXYZ";   // inventada
const CLAVE2 = "pat_" + "b2".repeat(44) + "QRST";
const UID = "11111111-1111-1111-1111-111111111111";
const EMP = "e1000000-0000-0000-0000-000000000001";
const b64 = (s: string | Uint8Array) => btoa(String.fromCharCode(...(typeof s === "string" ? new TextEncoder().encode(s) : s)));

// .xlsx mínimo (zip sin comprimir; el lector no comprueba el CRC).
function xlsx(filas: string[][]): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const hoja = `<worksheet><sheetData>${filas.map((f, r) => `<row r="${r + 1}">${f.map((v) =>
    `<c t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const entradas: [string, string][] = [["xl/worksheets/sheet1.xml", hoja]];
  const enc = new TextEncoder(); const partes: Uint8Array[] = []; const central: Uint8Array[] = []; let off = 0;
  for (const [nombre, txt] of entradas) {
    const n = enc.encode(nombre), d = enc.encode(txt);
    const lh = new Uint8Array(30), dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint32(18, d.length, true); dv.setUint32(22, d.length, true); dv.setUint16(26, n.length, true);
    const ch = new Uint8Array(46), dc = new DataView(ch.buffer);
    dc.setUint32(0, 0x02014b50, true); dc.setUint32(20, d.length, true); dc.setUint32(24, d.length, true);
    dc.setUint16(28, n.length, true); dc.setUint32(42, off, true);
    partes.push(lh, n, d); central.push(ch, n); off += 30 + n.length + d.length;
  }
  const cd = central.reduce((a, x) => a + x.length, 0);
  const eo = new Uint8Array(22), de = new DataView(eo.buffer);
  de.setUint32(0, 0x06054b50, true); de.setUint16(8, entradas.length, true); de.setUint16(10, entradas.length, true);
  de.setUint32(12, cd, true); de.setUint32(16, off, true);
  const todo = [...partes, ...central, eo]; const out = new Uint8Array(todo.reduce((a, x) => a + x.length, 0));
  let p = 0; for (const x of todo) { out.set(x, p); p += x.length; } return out;
}

type Llamada = { fn: string; args: Record<string, unknown> };
function deps(respuestas: Record<string, (a: Record<string, unknown>) => { data: unknown; error: { code?: string; message: string } | null }>,
              fetchHolded?: Deps["fetchHolded"]) {
  const llamadas: Llamada[] = [];
  const d: Deps = {
    usuario: (a) => Promise.resolve(a === "Bearer bueno" ? UID : null),
    rpc: (fn, args) => { llamadas.push({ fn, args }); return Promise.resolve(respuestas[fn] ? respuestas[fn](args) : { data: null, error: { message: "sin simular" } }); },
    fetchHolded,
  };
  return { d, llamadas };
}

// Holded simulado: estado por ruta; registra método, URL y cabeceras.
function holded(estado: Record<string, number | [number, Record<string, string>]>, cuerpos: Record<string, unknown> = {}) {
  const vistas: { metodo: string; url: string; auth: string | null }[] = [];
  const f = (url: string, init: RequestInit) => {
    const u = new URL(url);
    vistas.push({ metodo: String(init.method), url, auth: new Headers(init.headers).get("authorization") });
    const ruta = u.pathname.replace("/api/v2", "");
    const e = estado[ruta] ?? 200;
    const [st, cab] = Array.isArray(e) ? e : [e, {}];
    return Promise.resolve(new Response(JSON.stringify(cuerpos[ruta] ?? { items: [], has_more: false }), { status: st, headers: cab }));
  };
  return { f, vistas };
}

Deno.test("sin JWT válido → 401 y no se llama a la base", async () => {
  const { d, llamadas } = deps({});
  const r = await atender(d, "Bearer malo", { accion: "previsualizar" });
  assertEquals(r.status, 401); assertEquals(llamadas.length, 0);
});

Deno.test("archivo: JSON, CSV y Excel con sinónimos de columnas", async () => {
  const j = await leerArchivo("c.json", new TextEncoder().encode(JSON.stringify({ cuentas: [
    { cliente: "Uno SL", nif: "B1", subdominio: "uno", api_token: CLAVE }, { Cliente: "Dos", "NIF/CIF": "B2", "API Token": CLAVE2 }] })));
  assertEquals(j.map((x) => [x.fila, x.cliente, x.nif, x.subdominio, x.clave]),
    [[1, "Uno SL", "B1", "uno", CLAVE], [2, "Dos", "B2", "", CLAVE2]]);
  const c = await leerArchivo("c.csv", new TextEncoder().encode(`﻿Cliente;NIF;Subdominio;api_token\r\nUno SL;B1;uno;${CLAVE}\r\n;;;\r\nDos;B2;;${CLAVE2}\r\n`));
  assertEquals(c.map((x) => [x.fila, x.cliente, x.clave]), [[2, "Uno SL", CLAVE], [4, "Dos", CLAVE2]]);
  const x = await leerArchivo("c.xlsx", xlsx([["cliente", "nif", "api_token"], ["Uno & Cía SL", "B1", CLAVE]]));
  assertEquals(x.map((f) => [f.fila, f.cliente, f.nif, f.clave]), [[2, "Uno & Cía SL", "B1", CLAVE]]);
  await assertRejects(() => leerArchivo("c.csv", new TextEncoder().encode("cliente;nif\nUno;B1\n")), Error, "api_token");
  await assertRejects(() => leerArchivo("c.pdf", new Uint8Array(3)), Error, "Formato no admitido");
  await assertRejects(() => leerArchivo("c.json", new TextEncoder().encode("{malo")), Error, "JSON no es válido");
  await assertRejects(() => leerArchivo("c.xlsx", new TextEncoder().encode("no es zip")), Error, "Excel");
  await assertRejects(() => leerArchivo("c.json", new TextEncoder().encode(JSON.stringify(Array(501).fill({ api_token: "x" })))), Error, "500");
});

Deno.test("previsualizar: las claves van a la base y no vuelven al navegador", async () => {
  const { d, llamadas } = deps({
    holded_previsualizar: (a) => ({ data: { carga: "c", filas: (a.p_filas as { fila: number; clave: string }[]).map((f) => ({ fila: f.fila, ultimos4: f.clave.slice(-4) })) }, error: null }),
  });
  const r = await atender(d, "Bearer bueno", { accion: "previsualizar", archivo: { nombre: "c.csv", base64: b64(`cliente;api_token\nUno;${CLAVE}\n`) } });
  assertEquals(r.status, 200);
  assertEquals(llamadas[0].fn, "holded_previsualizar");
  assertEquals(llamadas[0].args.p_usuario, UID);
  assertEquals((llamadas[0].args.p_filas as { clave: string }[])[0].clave, CLAVE);
  assert(!JSON.stringify(r.body).includes(CLAVE.slice(0, 20)), "la respuesta no lleva la clave");
  assertEquals((r.body as { filas: { ultimos4: string }[] }).filas[0].ultimos4, "WXYZ");
});

Deno.test("errores de la base: 42501 → 403; nada que parezca una clave en el mensaje", async () => {
  const a = deps({ holded_previsualizar: () => ({ data: null, error: { code: "42501", message: "Solo el rol admin" } }) });
  const r1 = await atender(a.d, "Bearer bueno", { accion: "previsualizar", archivo: { nombre: "c.csv", base64: b64(`cliente;api_token\nUno;${CLAVE}\n`) } });
  assertEquals(r1.status, 403);
  const b = deps({ holded_previsualizar: () => ({ data: null, error: { code: "22P02", message: `valor raro: ${CLAVE}` } }) });
  const r2 = await atender(b.d, "Bearer bueno", { accion: "previsualizar", archivo: { nombre: "c.csv", base64: b64(`cliente;api_token\nUno;${CLAVE}\n`) } });
  assertEquals(r2.status, 400);
  assert(!JSON.stringify(r2.body).includes(CLAVE.slice(4, 20)));
});

Deno.test("confirmar: valida la entrada y pasa las decisiones normalizadas", async () => {
  const { d, llamadas } = deps({ holded_confirmar: () => ({ data: { lote: null, filas: [], verificar: [] }, error: null }) });
  assertEquals((await atender(d, "Bearer bueno", { accion: "confirmar", carga: "x", decisiones: [] })).status, 400);
  assertEquals((await atender(d, "Bearer bueno", { accion: "confirmar", carga: EMP, decisiones: [{ fila: "a" }] })).status, 400);
  const r = await atender(d, "Bearer bueno", { accion: "confirmar", carga: EMP, archivo_nombre: "c.json",
    decisiones: [{ fila: 2, accion: "conectar", empresa_id: EMP, reemplazar: "sí" }, { fila: 3, accion: "crear", empresa_id: "no-uuid" }] });
  assertEquals(r.status, 200);
  assertEquals(llamadas.at(-1)!.args.p_decisiones, [
    { fila: 2, accion: "conectar", empresa_id: EMP, reemplazar: false }, { fila: 3, accion: "crear", empresa_id: null, reemplazar: false }]);
});

Deno.test("verificar: solo GET a api.holded.com con Bearer; permisos por 200/403", async () => {
  const h = holded({ "/purchases": 403, "/treasury/accounts": 403 },
    { "/account": { vat_number: "ESB12345678", name: "x" }, "/usage": { period: "2026-11", usage: 20, limit: 2000 } });
  const { d, llamadas } = deps({
    holded_para_verificar: () => ({ data: [EMP], error: null }),
    holded_clave_de: () => ({ data: CLAVE, error: null }),
    holded_marcar_verificacion: () => ({ data: null, error: null }),
  }, h.f);
  const r = await atender(d, "Bearer bueno", { accion: "verificar", empresas: [EMP, EMP] });
  assertEquals(r.status, 200);
  assertEquals(h.vistas.length, 6);
  assert(h.vistas.every((v) => v.metodo === "GET" && v.url.startsWith("https://api.holded.com/api/v2/") && v.auth === `Bearer ${CLAVE}`));
  const m = llamadas.find((l) => l.fn === "holded_marcar_verificacion")!.args;
  assertEquals(m.p_estado, "ok");
  assertEquals(m.p_permisos, { cuenta: true, facturas: true, compras: false, contactos: true, bancos: false, uso: true });
  assertEquals(m.p_nif_holded, "ESB12345678");
  assertEquals(m.p_uso, { periodo: "2026-11", usadas: 20, limite: 2000 });
  assertEquals(llamadas.find((l) => l.fn === "holded_para_verificar")!.args.p_empresas, [EMP]);
  assert(!JSON.stringify(r.body).includes(CLAVE.slice(4, 20)), "la respuesta no lleva la clave");
});

Deno.test("verificar: 401, 429 mensual, sin permisos útiles, red caída", async () => {
  const caso = async (estado: Parameters<typeof holded>[0]) => verificarClave(CLAVE, { fetch: holded(estado).f });
  const a = await caso({ "/account": 401 });
  assertEquals([a.estado, /401/.test(a.error!)], ["error", true]);
  const b = await caso({ "/invoices": [429, { "retry-after": "3600", "x-ratelimit-window": "month" }] });
  assertEquals([b.estado, /cupo mensual/.test(b.error!)], ["error", true]);
  const c = await caso({ "/invoices": 403, "/purchases": 403, "/contacts": 403, "/treasury/accounts": 403 });
  assertEquals([c.estado, /no tiene permiso/.test(c.error!)], ["error", true]);
  const caida = await verificarClave(CLAVE, { fetch: () => Promise.reject(new Error("red")) });
  assertEquals([caida.estado, /no respondió/.test(caida.error!)], ["error", true]);
});

Deno.test("verificar: >10 empresas → 400; sin clave en Vault → error guardado", async () => {
  const { d } = deps({});
  assertEquals((await atender(d, "Bearer bueno", { accion: "verificar", empresas: Array(11).fill(0).map((_, i) => EMP.slice(0, -2) + String(i).padStart(2, "0")) })).status, 400);
  const x = deps({
    holded_para_verificar: () => ({ data: [EMP], error: null }),
    holded_clave_de: () => ({ data: null, error: null }),
    holded_marcar_verificacion: () => ({ data: null, error: null }),
  }, () => { throw new Error("no debería llamar a Holded"); });
  const r = await atender(x.d, "Bearer bueno", { accion: "verificar", empresas: [EMP] });
  assertEquals((r.body as { resultados: { estado: string }[] }).resultados[0].estado, "error");
});

Deno.test("cliente de Holded: solo rutas relativas simples", async () => {
  const f = () => Promise.resolve(new Response("{}"));
  for (const mala of ["https://otro.example/x", "/invoices?x=1", "/../admin", "//otro", "/Invoices", "/invoices/../x"]) {
    await assertRejects(() => holdedGet(CLAVE, mala, {}, { fetch: f }), Error, "no permitida");
  }
  const r = await holdedGet(CLAVE, "/invoices", { limit: 1, cursor: undefined }, { fetch: (u) => { assertEquals(u, "https://api.holded.com/api/v2/invoices?limit=1"); return f(); } });
  assertEquals(r.status, 200);
});

Deno.test("no hay en el código ningún método de escritura hacia Holded", () => {
  for (const p of ["../_shared/holded.ts", "./verificar.ts", "./servicio.ts", "./index.ts"]) {
    const s = Deno.readTextFileSync(new URL(p, import.meta.url));
    assert(!/method:\s*["'`](POST|PUT|PATCH|DELETE)/i.test(s), p);
  }
});
