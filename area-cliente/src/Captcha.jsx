// Cloudflare Turnstile, opcional. Solo se activa si crm/config.js trae
// turnstileSiteKey; si no, no se carga nada y los formularios funcionan
// como siempre. El token es de un solo uso: el formulario cambia la `key`
// del componente tras cada envío para pedir uno nuevo.
import { useEffect, useRef } from "react";

const SITE_KEY = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.turnstileSiteKey) || "";
export const captchaActivo = !!SITE_KEY;

let carga = null;
function cargarTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!carga) {
    carga = new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.onload = ok; s.onerror = mal;
      document.head.appendChild(s);
    });
  }
  return carga;
}

export function Captcha({ onToken }) {
  const div = useRef(null);
  useEffect(() => {
    if (!captchaActivo) return undefined;
    let id = null, vivo = true;
    cargarTurnstile().then(() => {
      if (!vivo || !div.current) return;
      id = window.turnstile.render(div.current, {
        sitekey: SITE_KEY,
        language: "es",
        callback: (t) => onToken(t),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    }).catch(() => onToken(null));
    return () => { vivo = false; if (id !== null && window.turnstile) window.turnstile.remove(id); };
  }, []);
  if (!captchaActivo) return null;
  return <div className="pt-captcha" ref={div} />;
}
