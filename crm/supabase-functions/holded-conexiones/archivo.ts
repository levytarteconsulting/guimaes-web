// Archivo de cuentas de Holded → filas {fila, cliente, nif, subdominio, clave}.
// Formatos: JSON (lista de objetos, o un objeto con una lista dentro), CSV o
// Excel (.xlsx; primera hoja, primera fila = cabeceras). Columnas:
// cliente, nif, subdominio, api_token (se aceptan algunos sinónimos).
// Nada de esto se registra en logs: lleva las claves.
// @ts-types="../_shared/hoja.d.ts"
import { leerCsv, leerXlsx } from "../_shared/hoja.js";

export type FilaArchivo = { fila: number; cliente: string; nif: string; subdominio: string; clave: string };

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_FILAS = 500;

const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();

const SINONIMOS: Record<keyof Omit<FilaArchivo, "fila">, string[]> = {
  cliente: ["cliente", "nombre", "empresa", "razon social", "nombre cliente", "cuenta"],
  nif: ["nif", "cif", "nif cif", "cif nif", "vat", "vat number", "nif iva"],
  subdominio: ["subdominio", "subdomain", "dominio"],
  clave: ["api token", "token", "api key", "apikey", "clave", "clave api", "api"],
};

function campoDe(cabecera: unknown): keyof typeof SINONIMOS | null {
  const n = norm(cabecera);
  for (const [campo, lista] of Object.entries(SINONIMOS)) if (lista.includes(n)) return campo as keyof typeof SINONIMOS;
  return null;
}

const texto = (v: unknown) => (v == null ? "" : typeof v === "object" ? "" : String(v)).trim();

export class ErrorArchivo extends Error {}

function desdeObjetos(lista: unknown[]): FilaArchivo[] {
  return lista.map((o, i) => {
    const fila: FilaArchivo = { fila: i + 1, cliente: "", nif: "", subdominio: "", clave: "" };
    if (o && typeof o === "object" && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        const campo = campoDe(k);
        if (campo && !fila[campo]) fila[campo] = texto(v);
      }
    }
    return fila;
  });
}

function desdeTabla(filas: string[][]): FilaArchivo[] {
  if (!filas.length) throw new ErrorArchivo("El archivo está vacío.");
  const mapa = new Map<keyof typeof SINONIMOS, number>();
  filas[0].forEach((c, i) => { const campo = campoDe(c); if (campo && !mapa.has(campo)) mapa.set(campo, i); });
  if (!mapa.has("clave")) throw new ErrorArchivo("Falta la columna api_token en la primera fila.");
  if (!mapa.has("cliente") && !mapa.has("nif")) throw new ErrorArchivo("Falta la columna cliente o la columna nif.");
  const out: FilaArchivo[] = [];
  filas.slice(1).forEach((f, i) => {
    if (f.every((c) => !String(c ?? "").trim())) return;   // fila vacía
    const v = (campo: keyof typeof SINONIMOS) => (mapa.has(campo) ? texto(f[mapa.get(campo)!]) : "");
    out.push({ fila: i + 2, cliente: v("cliente"), nif: v("nif"), subdominio: v("subdominio"), clave: v("clave") });
  });
  return out;
}

export async function leerArchivo(nombre: string, bytes: Uint8Array): Promise<FilaArchivo[]> {
  if (bytes.length > MAX_BYTES) throw new ErrorArchivo("El archivo pasa de 2 MB.");
  const ext = (nombre.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  let filas: FilaArchivo[];
  if (ext === "json") {
    let datos: unknown;
    try { datos = JSON.parse(new TextDecoder().decode(bytes).replace(/^﻿/, "")); }
    catch { throw new ErrorArchivo("El JSON no es válido."); }
    if (datos && typeof datos === "object" && !Array.isArray(datos)) {
      const listas = Object.values(datos as Record<string, unknown>).filter(Array.isArray);
      datos = listas.length === 1 ? listas[0] : [datos];
    }
    if (!Array.isArray(datos)) throw new ErrorArchivo("El JSON tiene que ser una lista de cuentas.");
    filas = desdeObjetos(datos).filter((f) => f.cliente || f.nif || f.clave || f.subdominio);
  } else if (ext === "csv" || ext === "txt") {
    filas = desdeTabla(leerCsv(new TextDecoder().decode(bytes)));
  } else if (ext === "xlsx") {
    try { filas = desdeTabla(await leerXlsx(bytes.slice().buffer)); }
    catch (e) { throw e instanceof ErrorArchivo ? e : new ErrorArchivo("El Excel no se puede leer (¿es .xlsx?)."); }
  } else {
    throw new ErrorArchivo("Formato no admitido: sube un .json, .csv o .xlsx.");
  }
  if (!filas.length) throw new ErrorArchivo("El archivo no tiene ninguna cuenta.");
  if (filas.length > MAX_FILAS) throw new ErrorArchivo(`Como mucho ${MAX_FILAS} cuentas por archivo.`);
  return filas;
}
