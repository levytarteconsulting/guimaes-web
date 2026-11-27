// Sonda de solo lectura contra la API v2 de Holded con la clave de la cuenta
// DEMO CLAUDE. La clave se lee de la variable HOLDED_DEMO_KEY (cargada con
// read -s, nunca escrita en un fichero) y NO se imprime: solo códigos HTTP,
// cabeceras de límite y NOMBRES de campos (ningún valor de datos).
// Gasta 8 llamadas de la cuota mensual de esa cuenta.
//
// Uso (en tu terminal, desde crm/tests/holded):
//   read -s HOLDED_DEMO_KEY; export HOLDED_DEMO_KEY
//   deno run --allow-env=HOLDED_DEMO_KEY --allow-net=api.holded.com sonda-demo.ts
//   unset HOLDED_DEMO_KEY

const clave = Deno.env.get("HOLDED_DEMO_KEY") ?? "";
if (!clave) { console.error("Falta HOLDED_DEMO_KEY"); Deno.exit(1); }
console.log(`clave: empieza por "pat_": ${clave.startsWith("pat_") ? "sí" : "NO"} · longitud ${clave.length}`);

const BASE = "https://api.holded.com/api/v2";
const RUTAS = ["/account", "/invoices?limit=1", "/credit-notes?limit=1", "/purchases?limit=1",
  "/purchase-refunds?limit=1", "/contacts?limit=1", "/treasury/accounts?limit=1", "/usage"];

const forma = (v: unknown, nivel = 0): unknown => {
  if (Array.isArray(v)) return v.length ? [forma(v[0], nivel + 1)] : [];
  if (v && typeof v === "object") {
    if (nivel > 2) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forma(x, nivel + 1)]));
  }
  return typeof v;
};

for (const r of RUTAS) {
  const res = await fetch(BASE + r, { headers: { Authorization: `Bearer ${clave}`, Accept: "application/json" } });
  const cab = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-window"]
    .map((h) => res.headers.get(h) ? `${h}=${res.headers.get(h)}` : null).filter(Boolean).join(" ");
  let cuerpo: unknown = null;
  try { cuerpo = await res.json(); } catch { /* sin JSON */ }
  console.log(`\n${r.split("?")[0]} → ${res.status} ${cab}`);
  if (res.ok) {
    const c = cuerpo as Record<string, unknown>;
    if (Array.isArray(c?.items)) console.log(`  items: ${c.items.length} · has_more: ${typeof c.has_more} · cursor: ${typeof c.cursor}`);
    console.log("  forma:", JSON.stringify(forma(cuerpo)).slice(0, 900));
    // Permisos: solo se imprimen valores de campos que parezcan ámbitos.
    for (const [k, v] of Object.entries(c ?? {})) {
      if (/scope|permis/i.test(k)) console.log(`  ${k}:`, JSON.stringify(v).slice(0, 600));
    }
    if (r === "/usage") console.log("  uso:", JSON.stringify(cuerpo).replace(/"[^"]*@[^"]*"/g, '"…"').slice(0, 600));
  } else {
    const c = cuerpo as Record<string, unknown> | null;
    console.log(`  error: ${c?.title ?? ""} · ${String(c?.detail ?? "").slice(0, 200)}`);
  }
}
