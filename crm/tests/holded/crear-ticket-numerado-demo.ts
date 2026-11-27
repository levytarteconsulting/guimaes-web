// Crea 1 ticket de venta de PRUEBA, pendiente de aprobar y CON número propio
// (como los que manda el TPV de MDF: LS3-…), en la cuenta DEMO CLAUDE. Sirve
// para comprobar si al aprobarlo Holded mantiene ese número o le asigna otro.
// No aprueba nada. Gasta 2 llamadas (1 POST + 1 GET).
//
// La clave se lee de HOLDED_DEMO_KEY (read -s) y NO se imprime.
// Uso (desde crm/tests/holded):
//   read -s HOLDED_DEMO_KEY; export HOLDED_DEMO_KEY
//   deno run --allow-env=HOLDED_DEMO_KEY --allow-net=api.holded.com crear-ticket-numerado-demo.ts
//   unset HOLDED_DEMO_KEY

const clave = Deno.env.get("HOLDED_DEMO_KEY") ?? "";
if (!clave.startsWith("pat_")) { console.error("Falta HOLDED_DEMO_KEY (empieza por pat_)"); Deno.exit(1); }
const BASE = "https://api.holded.com/api/v2";
const cab = { Authorization: `Bearer ${clave}`, Accept: "application/json", "Content-Type": "application/json" };
const limpio = (s: string) => s.replace(/pat_[A-Za-z0-9_\-]*/g, "pat_…").slice(0, 600);
const NUMERO = "PRUEBA-0001";
const DIA = "2026-11-23";

const body = {
  contact_name: "Cliente de prueba GUIMAES", date: DIA, document_number: NUMERO, draft: true,
  description: "Prueba CRM GUIMAES · ticket con número propio",
  items: [{ name: "Prueba CRM GUIMAES · ticket con número propio", units: 1, price: 15, taxes: ["s_iva_21"] }],
};
const res = await fetch(`${BASE}/sales-receipts`, { method: "POST", headers: cab, body: JSON.stringify(body) });
const txt = await res.text();
let d: Record<string, unknown> = {};
try { d = JSON.parse(txt); } catch { /* sin JSON */ }
if (!res.ok) { console.log(`POST /sales-receipts → ${res.status}: ${limpio(txt)}`); Deno.exit(2); }
const id = String(d.id ?? "");
console.log(`POST /sales-receipts → ${res.status} · id ${id}`);

const q = new URLSearchParams({ start_date: `${DIA}T00:00:00+01:00`, end_date: `${DIA}T23:59:59+01:00`, limit: "100" });
const r = await fetch(`${BASE}/sales-receipts?${q}`, { headers: cab });
const t = (r.ok ? ((await r.json()) as { items?: Record<string, unknown>[] }).items ?? [] : []).find((x) => x.id === id);
if (!t) { console.log(`GET → ${r.status} · no aparece el ticket`); Deno.exit(3); }
console.log(`ANTES de aprobar: document_number=${String(t.document_number)} · draft=${String(t.draft)}`);
console.log(t.draft === true && t.document_number === NUMERO
  ? "\nListo: pendiente y con número propio. Pásale esta salida a Claude."
  : "\nNo ha quedado pendiente con el número pedido. Pásale esta salida a Claude (no sirve para la prueba).");
