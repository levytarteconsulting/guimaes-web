// Crea 3 tickets de venta de PRUEBA, pendientes de aprobar, en la cuenta de
// Holded DEMO CLAUDE (solo esa), para probar de punta a punta las Acciones
// del CRM. Después comprueba que salen en la lista de pendientes
// (approval_status=draft). No aprueba nada.
//
// La clave se lee de HOLDED_DEMO_KEY (cargada con read -s, nunca escrita en
// un fichero) y NO se imprime: solo códigos HTTP, ids y mensajes de error
// de Holded. Gasta 4 llamadas (3 POST + 1 GET).
//
// Uso (en tu terminal, desde crm/tests/holded):
//   read -s HOLDED_DEMO_KEY; export HOLDED_DEMO_KEY
//   deno run --allow-env=HOLDED_DEMO_KEY --allow-net=api.holded.com crear-tickets-demo.ts
//   unset HOLDED_DEMO_KEY

const clave = Deno.env.get("HOLDED_DEMO_KEY") ?? "";
if (!clave.startsWith("pat_")) { console.error("Falta HOLDED_DEMO_KEY (empieza por pat_)"); Deno.exit(1); }
const BASE = "https://api.holded.com/api/v2";
const cab = { Authorization: `Bearer ${clave}`, Accept: "application/json", "Content-Type": "application/json" };
const limpio = (s: string) => s.replace(/pat_[A-Za-z0-9_\-]*/g, "pat_…").slice(0, 600);

// Tres tickets distintos (fecha, importe y concepto) para que ninguno parezca duplicado.
const TICKETS = [
  { date: "2026-11-24", name: "Prueba CRM GUIMAES · ticket 1", price: 10 },
  { date: "2026-11-25", name: "Prueba CRM GUIMAES · ticket 2", price: 20 },
  { date: "2026-11-26", name: "Prueba CRM GUIMAES · ticket 3", price: 30 },
];

const ids: string[] = [];
for (const t of TICKETS) {
  const body = {
    contact_name: "Cliente de prueba GUIMAES",
    date: t.date,
    description: t.name,
    items: [{ name: t.name, units: 1, price: t.price, taxes: ["s_iva_21"] }],
  };
  const res = await fetch(`${BASE}/sales-receipts`, { method: "POST", headers: cab, body: JSON.stringify(body) });
  const txt = await res.text();
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(txt); } catch { /* sin JSON */ }
  if (!res.ok) {
    console.log(`POST /sales-receipts (${t.date}) → ${res.status}: ${limpio(txt)}`);
    console.log("Paro aquí: no se ha creado el ticket. Pásale este mensaje a Claude.");
    Deno.exit(2);
  }
  const id = String(d.id ?? (d as { data?: { id?: string } }).data?.id ?? "");
  console.log(`POST /sales-receipts (${t.date}) → ${res.status} · id ${id || "(sin id en la respuesta)"} · estado de aprobación: ${String(d.approval_status ?? "—")}`);
  if (id) ids.push(id);
}

const q = new URLSearchParams({ approval_status: "draft", start_date: "2026-11-24T00:00:00+01:00", end_date: "2026-11-26T23:59:59+01:00", limit: "100" });
const res = await fetch(`${BASE}/sales-receipts?${q}`, { headers: cab });
const lista = res.ok ? ((await res.json()) as { items?: { id: string }[] }).items ?? [] : [];
const pendientes = new Set(lista.map((x) => x.id));
console.log(`\nGET /sales-receipts?approval_status=draft (24–26/11) → ${res.status} · ${lista.length} pendientes en esas fechas`);
for (const id of ids) console.log(`  ${id}: ${pendientes.has(id) ? "PENDIENTE de aprobar ✓" : "NO aparece como pendiente ✗"}`);
if (ids.length !== 3 || ids.some((id) => !pendientes.has(id))) {
  console.log("\nAlgo no cuadra (Claude debe parar y revisarlo). Pásale esta salida.");
  Deno.exit(3);
}
console.log("\nListo: 3 tickets de prueba pendientes. Pásale esta salida a Claude.");
