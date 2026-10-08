// Cliente de Supabase del área cliente.
//
// URL y anon key salen de crm/config.js (window.SUPABASE_CONFIG), la misma
// fuente que el CRM: son públicas; el control de acceso está en las RPC.
// storageKey propia (fase 0): el CRM vive en el mismo origen con la clave por
// defecto de supabase-js; con la misma clave, entrar en uno cerraría o
// cambiaría la sesión del otro.
import "../../crm/config.js";
import { createClient } from "@supabase/supabase-js";

const cfg = window.SUPABASE_CONFIG || {};
export const supabase = createClient(cfg.url, cfg.anonKey, {
  auth: { storageKey: "guimaes-portal-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// PASSWORD_RECOVERY: Supabase lo emite UNA vez, muy pronto (al detectar el
// token de recuperación en la URL, justo al crear el cliente), antes de que
// React monte. Se escucha aquí mismo y se guarda para el primer componente
// que se suscriba; si no, el enlace de "olvidé mi contraseña" dejaría al
// usuario dentro sin pedirle la contraseña nueva.
const oyentes = [];
let recuperacionPendiente = null;
supabase.auth.onAuthStateChange((evento, sesion) => {
  if (evento === "PASSWORD_RECOVERY") recuperacionPendiente = sesion;
  oyentes.forEach((cb) => cb(evento, sesion));
});
export function alCambiarSesion(cb) {
  oyentes.push(cb);
  if (recuperacionPendiente) { cb("PASSWORD_RECOVERY", recuperacionPendiente); recuperacionPendiente = null; }
  return () => { const i = oyentes.indexOf(cb); if (i > -1) oyentes.splice(i, 1); };
}
