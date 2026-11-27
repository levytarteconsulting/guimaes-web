#!/usr/bin/env python3
"""Genera, desde la especificación OFICIAL de la API v2 de Holded (OpenAPI),
la lista cerrada de operaciones de escritura y la referencia para el asistente.

  curl -sL https://api.holded.com/openapi/es.json -o /tmp/holded-es.json
  python3 -I crm/tests/holded/generar-catalogo.py /tmp/holded-es.json

Escribe:
  crm/supabase-functions/holded-acciones/catalogo.json   lista cerrada (holded-acciones solo ejecuta lo que case)
  crm/supabase-functions/agente/holded-referencia.json   referencia resumida por tema (holded_documentacion)
  crm/supabase-holded-operaciones.sql                     catálogo entre «-- <catalogo>» y «-- </catalogo>»

Riesgo ALTO: borrar cualquier cosa; aprobar, emitir, enviar o anular
documentos; pagos, cobros, devoluciones y conciliaciones; bancos y
tesorería; contabilidad; nóminas; usuarios de la cuenta, webhooks, series
de numeración y métodos de pago; operaciones en lote o de conversión.
Todo lo demás, normal. Lo que se sube como fichero (multipart) se excluye.
"""
import json, re, sys, os, datetime

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))   # crm/
spec = json.load(open(sys.argv[1]))
assert spec.get("openapi", "").startswith("3.") and spec["servers"][0]["url"] == "https://api.holded.com"
comp = spec.get("components", {})

def R(x):
    while isinstance(x, dict) and "$ref" in x:
        parts = x["$ref"].lstrip("#/").split("/")
        y = spec
        for p in parts: y = y[p]
        x = y
    return x

PREFIJO = "/api/v2"
SUFIJOS_ALTO = {"approve", "send", "payments", "refund", "reconcile", "cancel", "convert", "export",
                "bulk-delete", "batch-delete", "bulk-archive", "archive", "publish", "skip"}
TEMAS_ALTO = {"Cuentas bancarias", "Pagos", "Contabilidad", "Nóminas", "Registros de nómina", "Métodos de pago",
              "Cuenta", "Webhooks", "Series de numeración", "Cuentas de gastos", "Facturas recurrentes"}

def riesgo(metodo, ruta, tema):
    seg = [s for s in ruta.split("/") if s]
    ult = seg[-1]
    if metodo == "DELETE": return "alto", "Borra datos en Holded"
    if "bulk" in seg: return "alto", "Operación en lote de Holded"
    if ult in SUFIJOS_ALTO:
        return "alto", {"approve": "Aprueba o emite un documento", "send": "Envía un documento por correo al cliente",
                        "payments": "Registra pagos o cobros", "refund": "Registra una devolución",
                        "reconcile": "Concilia movimientos bancarios", "cancel": "Anula un documento",
                        "convert": "Convierte un documento en otro", "export": "Convierte un documento entrante en compra",
                        "archive": "Archiva", "publish": "Publica", "skip": "Salta una emisión recurrente"}.get(ult, "Operación sensible")
    if tema in TEMAS_ALTO: return "alto", f"{tema}: datos bancarios, contables, de pagos, nóminas o de acceso a la cuenta"
    return "normal", None

def tipo_param(pa):
    sc = R(pa.get("schema", {}))
    if sc.get("enum"): return {"tipo": "enum", "valores": sc["enum"]}
    pat = sc.get("pattern") or ""
    ej = str(sc.get("example") or "")
    if "{24}" in pat or re.fullmatch(r"[0-9a-f]{24}", ej) or re.search(r"(Id|^id)$", pa["name"]):
        return {"tipo": "id"}
    return {"tipo": "texto"}

def resumen_esquema(sc, prof=0):
    """{campo: 'tipo — descripción'} y, un nivel por debajo, los campos de objetos y listas."""
    sc = R(sc)
    if "allOf" in sc:
        m = {"properties": {}, "required": []}
        for x in sc["allOf"]:
            x = R(x); m["properties"].update(x.get("properties", {})); m["required"] += x.get("required", [])
        sc = m
    out = {}
    for k, v in (sc.get("properties") or {}).items():
        v = R(v)
        t = v.get("type") or ("oneOf" if "oneOf" in v else "anyOf" if "anyOf" in v else "?")
        if isinstance(t, list): t = "/".join(x for x in t if x != "null")
        extra = []
        if v.get("enum"): extra.append("valores: " + ", ".join(map(str, v["enum"][:12])))
        if v.get("format"): extra.append(v["format"])
        d = re.sub(r"\s+", " ", (v.get("description") or "")).strip()[:160]
        out[k] = f"{t}{' (' + '; '.join(extra) + ')' if extra else ''}{' — ' + d if d else ''}"
        if prof == 0:
            hijo = R(v.get("items", {})) if t == "array" else v if t == "object" else None
            if hijo and (hijo.get("properties") or "allOf" in hijo):
                sub = resumen_esquema(hijo, 1)
                req = R(hijo).get("required") or []
                out[k] += " · campos: " + "; ".join(f"{a}{'*' if a in req else ''}: {b[:90]}" for a, b in sub.items())
    return out

def ejemplo(media, sc):
    for src in (media.get("example"), *(R(e).get("value") for e in (media.get("examples") or {}).values()), R(sc).get("example")):
        if src is not None: return src
    return None

ops, excluidas = [], []
gets = {p[len(PREFIJO):] for p, o in spec["paths"].items() if "get" in o}
for ruta_c, item in sorted(spec["paths"].items()):
    assert ruta_c.startswith(PREFIJO + "/"), ruta_c
    ruta = ruta_c[len(PREFIJO):]
    comunes = item.get("parameters", [])
    for m, o in item.items():
        if m not in ("post", "put", "patch", "delete"): continue
        metodo = m.upper()
        tema = (o.get("tags") or ["Otros"])[0]
        base = {"id": o["operationId"], "metodo": metodo, "ruta": ruta, "tema": tema,
                "resumen": re.sub(r"\s+", " ", o.get("summary") or "").strip()}
        contenido = (o.get("requestBody") or {}).get("content") or {}
        if contenido and "application/json" not in contenido:
            excluidas.append({**base, "motivo": "Sube un fichero (" + ", ".join(contenido) + "): el asistente no envía ficheros"}); continue
        params, query = {}, {}
        for pa in [R(x) for x in comunes + o.get("parameters", [])]:
            if pa.get("in") == "path": params[pa["name"]] = tipo_param(pa)
            elif pa.get("in") == "query": query[pa["name"]] = {**tipo_param(pa), "obligatorio": bool(pa.get("required"))}
        faltan = set(re.findall(r"\{([^}]+)\}", ruta)) - set(params)
        for f in faltan: params[f] = {"tipo": "id"}
        media = contenido.get("application/json")
        sc = R(media["schema"]) if media else {}
        requeridos = list(sc.get("required") or []) if media else []
        # Lectura del documento afectado (para el estado anterior): GET del mismo recurso por su id.
        lectura = None
        seg = ruta.split("/")
        for n in range(len(seg), 1, -1):
            cand = "/".join(seg[:n])
            if cand.endswith("}") and cand in gets: lectura = cand; break
        r, motivo = riesgo(metodo, ruta, tema)
        ops.append({**base, "riesgo": r, **({"motivo_riesgo": motivo} if motivo else {}),
                    "cuerpo": "json" if media else "ninguno", **({"cuerpo_obligatorio": True} if (o.get("requestBody") or {}).get("required") else {}),
                    "requeridos": requeridos, "params": params, **({"query": query} if query else {}),
                    "lectura": lectura, "reemplaza_todo": metodo == "PUT" and "reemplazo completo" in (o.get("description") or "").lower(),
                    "_desc": re.sub(r"\*\*Permiso requerido:\*\*\s*`[^`]*`", "", re.sub(r"\s+", " ", o.get("description") or "")).strip()[:500],
                    "_campos": resumen_esquema(sc) if media else {}, "_ejemplo": ejemplo(media, sc) if media else None})

ids = [o["id"] for o in ops]
assert len(ids) == len(set(ids)), "operationId repetido"
hoy = datetime.date.today().isoformat()
fuente = {"fuente": "https://api.holded.com/openapi/es.json", "titulo": spec["info"].get("title"), "version": spec["info"].get("version"), "generado": hoy}

catalogo = {**fuente, "operaciones": [{k: v for k, v in o.items() if not k.startswith("_")} for o in ops],
            "excluidas": excluidas}
json.dump(catalogo, open(os.path.join(RAIZ, "supabase-functions/holded-acciones/catalogo.json"), "w"), ensure_ascii=False, indent=1)

temas = {}
for o in ops:
    temas.setdefault(o["tema"], []).append({
        "operacion": o["id"], "metodo": o["metodo"], "ruta": o["ruta"], "resumen": o["resumen"], "riesgo": o["riesgo"],
        **({"descripcion": o["_desc"]} if o["_desc"] and o["_desc"] != o["resumen"] else {}),
        **({"reemplaza_todo": True} if o["reemplaza_todo"] else {}),
        "requeridos": o["requeridos"], "campos": o["_campos"], **({"ejemplo": o["_ejemplo"]} if o["_ejemplo"] is not None else {}),
        **({"query": list(o["query"])} if o.get("query") else {}),
    })
# Lecturas útiles por tema (rutas GET), para saber de dónde salen los ids.
lecturas = {}
for ruta_c, item in spec["paths"].items():
    if "get" in item:
        t = (item["get"].get("tags") or ["Otros"])[0]
        lecturas.setdefault(t, []).append(f"GET {ruta_c[len(PREFIJO):]} — {re.sub(chr(10), ' ', item['get'].get('summary') or '')[:90]}")
json.dump({**fuente, "temas": temas, "lecturas": lecturas, "excluidas": [f"{e['metodo']} {e['ruta']} — {e['motivo']}" for e in excluidas]},
          open(os.path.join(RAIZ, "supabase-functions/agente/holded-referencia.json"), "w"), ensure_ascii=False, separators=(",", ":"))

# Catálogo para la base de datos (riesgo verificado también en SQL).
q = lambda s: "'" + str(s).replace("'", "''") + "'"
filas = ",\n".join(f"      ({q(o['id'])}, {q(o['metodo'])}, {q(o['ruta'])}, {q(o['tema'])}, {q(o['resumen'][:200])}, {q(o['riesgo'])})" for o in ops)
bloque = f"""-- <catalogo> (generado por crm/tests/holded/generar-catalogo.py el {hoy} desde {fuente['fuente']}; no editar a mano)
    insert into public.holded_operaciones (id, metodo, ruta, tema, resumen, riesgo) values
{filas};
    -- </catalogo>"""
sqlp = os.path.join(RAIZ, "supabase-holded-operaciones.sql")
if os.path.exists(sqlp):
    s = open(sqlp).read()
    s2 = re.sub(r"-- <catalogo>.*?-- </catalogo>", lambda _: bloque, s, flags=re.S)
    assert s2 != s or bloque in s, "no encuentro los marcadores del catálogo"
    open(sqlp, "w").write(s2)

from collections import Counter
print(f"{len(ops)} operaciones de escritura ({Counter(o['riesgo'] for o in ops)}), {len(excluidas)} excluidas, {len(temas)} temas")
