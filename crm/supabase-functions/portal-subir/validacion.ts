// Validación de nombres y tipos de las subidas del área cliente.
//
// Es solo un aviso temprano (antes de pedir la URL de subida): la regla que
// manda está en la RPC public.portal_confirmar_subida
// (crm/supabase-portal-fase1.sql, con public.portal_tipo_permitido), que es
// ejecutable por authenticated y por tanto no puede fiarse de nada de lo
// que se compruebe aquí. Si se cambia una tabla, hay que cambiar la otra.

export const MAX_BYTES = 15 * 1024 * 1024; // = file_size_limit del bucket "documentos"
export const MAX_NOMBRE = 150;

// Extensión → MIME canónico y MIME admitidos. Además de los admitidos se
// acepta un MIME vacío o application/octet-stream (se guarda el canónico).
export const TIPOS: Record<string, { canonico: string; admitidos: string[] }> = {
  pdf: { canonico: "application/pdf", admitidos: ["application/pdf"] },
  jpg: { canonico: "image/jpeg", admitidos: ["image/jpeg"] },
  jpeg: { canonico: "image/jpeg", admitidos: ["image/jpeg"] },
  png: { canonico: "image/png", admitidos: ["image/png"] },
  heic: { canonico: "image/heic", admitidos: ["image/heic", "image/heif"] },
  heif: { canonico: "image/heif", admitidos: ["image/heif", "image/heic"] },
  docx: {
    canonico: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    admitidos: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  },
  xlsx: {
    canonico: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    admitidos: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  },
  xml: { canonico: "application/xml", admitidos: ["application/xml", "text/xml"] },
  csv: { canonico: "text/csv", admitidos: ["text/csv", "application/vnd.ms-excel"] },
};

// Mismo saneado que la RPC: NFC, fuera caracteres de control (también NUL,
// que Postgres no admite en un texto) y barras, sin espacios en los extremos.
export function sanearNombre(nombre: string): string {
  return (nombre ?? "")
    .normalize("NFC")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .trim();
}

// Última extensión, en minúsculas (como substring(... from '\.([A-Za-z0-9]+)$')).
export function extension(nombre: string): string | null {
  const m = nombre.match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}

export function tipoPermitido(ext: string | null, mime: string | null | undefined): string | null {
  if (!ext) return null;
  const t = TIPOS[ext.toLowerCase()];
  if (!t) return null;
  const m = (mime ?? "").trim().toLowerCase();
  if (m === "" || m === "application/octet-stream" || t.admitidos.includes(m)) return t.canonico;
  return null;
}

// Nombre apto para una clave de Storage. Es el mismo algoritmo que
// storageSafeFilename en crm/data.js (Supabase rechaza acentos, eñes y
// varios signos en la ruta). El nombre original se guarda aparte.
export function nombreSeguroStorage(nombre: string): string {
  const dot = (nombre || "").lastIndexOf(".");
  let base = dot > 0 ? nombre.slice(0, dot) : (nombre || "");
  let ext = dot > 0 ? nombre.slice(dot + 1) : "";
  const clean = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^[_.]+|[_.]+$/g, "");
  base = clean(base).slice(0, 80) || "documento";
  ext = clean(ext).slice(0, 10);
  return ext ? base + "." + ext : base;
}

export type ResultadoSolicitud =
  | { ok: true; nombre: string; ext: string; mime: string; nombreSeguro: string }
  | { ok: false; error: string };

export function validarSolicitud(nombre: unknown, tamano: unknown, tipo: unknown): ResultadoSolicitud {
  if (typeof nombre !== "string") return { ok: false, error: "Falta el nombre del fichero." };
  const limpio = sanearNombre(nombre);
  const ext = extension(limpio);
  if (!limpio || limpio.length > MAX_NOMBRE || !ext || limpio.slice(0, limpio.length - ext.length - 1).trim() === "") {
    return { ok: false, error: "Nombre de fichero no admitido." };
  }
  const mime = tipoPermitido(ext, typeof tipo === "string" ? tipo : "");
  if (!mime) {
    return { ok: false, error: "Tipo de fichero no admitido. Se aceptan PDF, JPG, PNG, HEIC, DOCX, XLSX, XML y CSV." };
  }
  if (typeof tamano !== "number" || !Number.isFinite(tamano) || tamano < 1 || tamano > MAX_BYTES) {
    return { ok: false, error: "El fichero tiene que pesar entre 1 byte y 15 MB." };
  }
  return { ok: true, nombre: limpio, ext, mime, nombreSeguro: nombreSeguroStorage(limpio) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function esUuid(x: unknown): x is string {
  return typeof x === "string" && UUID_RE.test(x);
}
