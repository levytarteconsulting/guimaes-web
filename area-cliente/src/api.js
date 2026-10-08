// Todo lo que hace el cliente pasa por las RPC del portal y las Edge
// Functions (crm/supabase-portal-fase1.sql): el cliente no tiene ninguna
// política sobre tablas ni Storage.
import { supabase } from "./supabase.js";
import { validarSolicitud } from "../../crm/supabase-functions/portal-subir/validacion.ts";

export { MAX_BYTES } from "../../crm/supabase-functions/portal-subir/validacion.ts";
export const FORMATOS = "PDF, JPG, PNG, HEIC, DOCX, XLSX, XML o CSV";
export const ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.heif,.docx,.xlsx,.xml,.csv";
const REDIRECT = "https://guimaes.es/area-cliente";

// ---------- Mensajes ----------
// Errores de Auth en español y sin detalles técnicos.
export function mensajeAuth(error) {
  const m = (error && (error.message || String(error))) || "";
  if (/invalid login credentials/i.test(m)) return "Email o contraseña incorrectos.";
  if (/email not confirmed/i.test(m)) return "Todavía no has confirmado tu email. Revisa tu bandeja de entrada (y la carpeta de spam).";
  if (/signups? not allowed|signup is disabled/i.test(m)) return "El registro todavía no está abierto. Inténtalo más adelante o escríbenos.";
  if (/already registered|already been registered|already exists/i.test(m)) return "Ya existe una cuenta con ese email. Inicia sesión o recupera tu contraseña.";
  if (/password.*(at least|characters|short)|weak password/i.test(m)) return "La contraseña es demasiado corta o débil: usa al menos 8 caracteres.";
  if (/captcha/i.test(m)) return "No se ha podido completar la comprobación de seguridad. Vuelve a intentarlo.";
  if (/rate limit|too many|security purposes/i.test(m)) return "Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.";
  if (/failed to fetch|network/i.test(m)) return "No hay conexión. Comprueba tu red y vuelve a probar.";
  return "No se ha podido completar. Vuelve a intentarlo en unos minutos.";
}
// Error de una RPC del portal. GU001 = "No disponible" (empresa o documento
// que no es tuyo o ya no existe).
function errorRpc(error) {
  if (error && error.code === "GU001") return new Error("Este contenido ya no está disponible.");
  // Mensajes pensados para el cliente: datos no válidos, límites, email sin confirmar.
  if (error && ["GU003", "GU005", "GU006"].includes(error.code)) return new Error(error.message);
  return new Error(error && /fetch|network/i.test(error.message || "") ? "No hay conexión. Comprueba tu red y vuelve a probar." : "No se han podido cargar los datos. Vuelve a intentarlo.");
}
async function rpc(nombre, args) {
  const { data, error } = await supabase.rpc(nombre, args || {});
  if (error) throw errorRpc(error);
  return data || [];
}
// Edge Function: ante un error, el mensaje que viene en su cuerpo
// ({error: "..."}), no el genérico de supabase-js para respuestas no 2xx.
async function funcion(nombre, body) {
  const { data, error } = await supabase.functions.invoke(nombre, { body });
  if (error) {
    let msg = null;
    try { const ctx = error.context; if (ctx && typeof ctx.json === "function") { const j = await ctx.json(); msg = j && j.error; } } catch { /* sin cuerpo */ }
    if (!msg || msg === "No disponible") msg = "Este contenido ya no está disponible.";
    throw new Error(msg);
  }
  return data;
}

// ---------- Auth ----------
// captchaToken: el de Turnstile si está activo (ver Captcha.jsx); si no, undefined.
export const entrar = (email, password, captchaToken) =>
  supabase.auth.signInWithPassword({ email: email.trim(), password, options: captchaToken ? { captchaToken } : undefined });
export const registrarse = (nombre, email, password, captchaToken) =>
  supabase.auth.signUp({ email: email.trim(), password, options: { data: { name: nombre.trim() }, emailRedirectTo: REDIRECT, ...(captchaToken ? { captchaToken } : {}) } });
export const recuperar = (email, captchaToken) =>
  supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: REDIRECT, ...(captchaToken ? { captchaToken } : {}) });
export const nuevaContrasena = (password) => supabase.auth.updateUser({ password });
export const salir = () => supabase.auth.signOut();

// ---------- Datos ----------
export async function estado() { return (await rpc("portal_estado"))[0] || null; }
export const empresas = () => rpc("portal_empresas");
export const deals = (empresaId) => rpc("portal_deals", { p_empresa_id: empresaId });
export const carpetas = (empresaId) => rpc("portal_carpetas", { p_empresa_id: empresaId });
export const documentos = (empresaId) => rpc("portal_documentos", { p_empresa_id: empresaId });
export const servicios = () => rpc("portal_servicios");
export const solicitudes = (empresaId) => rpc("portal_solicitudes_empresa", { p_empresa_id: empresaId });

// Escrituras que avisan al equipo: van por la Edge Function portal-solicitudes
// (las comprobaciones están en las RPC que llama; ver crm/supabase-portal-fase31.sql).
export const solicitarServicio = (empresaId, servicio, mensaje) =>
  funcion("portal-solicitudes", { accion: "servicio", empresa_id: empresaId, servicio, mensaje });
export const actualizarEmpresa = (empresaId, { direccion, ciudad, provincia }) =>
  funcion("portal-solicitudes", { accion: "editar_empresa", empresa_id: empresaId, direccion, ciudad, provincia });
export const solicitarCambio = (empresaId, campo, valor, comentario) =>
  funcion("portal-solicitudes", { accion: "cambio_empresa", empresa_id: empresaId, campo, valor, comentario });

// Descarga: URL firmada de 60 s con el nombre del fichero (Storage la sirve
// como adjunto, así que asignarla a location descarga sin salir de la página).
export async function descargar(documentoId) {
  const r = await funcion("portal-descargar", { documento_id: documentoId });
  window.location.assign(r.url);
}

// Subida en tres pasos: pedir URL firmada, subir el fichero, confirmar.
// La validación de aquí solo avisa antes; la que manda es la del servidor.
export function validar(file) {
  return validarSolicitud(file && file.name, file && file.size, file && file.type);
}
export async function subir(empresaId, file, onPaso) {
  const v = validar(file);
  if (!v.ok) throw new Error(v.error);
  onPaso && onPaso("preparando");
  const sol = await funcion("portal-subir", { accion: "solicitar", empresa_id: empresaId, nombre: file.name, tamano: file.size, tipo: file.type });
  onPaso && onPaso("subiendo");
  const up = await supabase.storage.from("documentos").uploadToSignedUrl(sol.ruta, sol.token, file, { contentType: file.type || v.mime });
  if (up.error) throw new Error("No se ha podido subir el fichero. Comprueba tu conexión y vuelve a probar.");
  onPaso && onPaso("comprobando");
  return funcion("portal-subir", { accion: "confirmar", empresa_id: empresaId, documento_id: sol.documento_id, nombre: file.name });
}

// ---------- Alta inmediata (cuenta pendiente; crm/supabase-portal-fase33.sql) ----------
// Crea la empresa y el contacto (pendientes de validar) y vincula la cuenta.
export const crearAlta = (f) => funcion("portal-alta", {
  accion: "crear", razon_social: f.razon_social, cif: f.cif, direccion: f.direccion, ciudad: f.ciudad,
  provincia: f.provincia, nombre_contacto: f.nombre_contacto, telefono: f.telefono,
});
