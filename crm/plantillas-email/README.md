# Plantillas de correo de Supabase Auth (español)

Valen para el CRM y para el área de cliente a la vez: Supabase usa una sola plantilla por tipo.
Se pegan en Authentication → Emails → Templates. Para cada una: el **Subject** de esta tabla y el **Body** (todo el contenido del fichero).

| Plantilla en Supabase | Fichero | Subject |
|---|---|---|
| Confirm signup | `1-confirmar-registro.html` | Confirma tu email para el área de cliente de GUIMAES |
| Reset Password | `2-recuperar-contrasena.html` | Restablece tu contraseña de GUIMAES |
| Change Email Address | `3-cambio-email.html` | Confirma el cambio de email de tu cuenta de GUIMAES |

Variables que usan: `{{ .ConfirmationURL }}`, `{{ .Email }}` y `{{ .NewEmail }}` (las de Supabase). Estilos en línea, sin imágenes externas, para que se vean igual en Gmail, Outlook y móvil.

## Captcha (Cloudflare Turnstile) — preparado, sin activar

El código ya lo soporta en el área de cliente (acceso, registro y recuperar contraseña) y en el login del CRM (acceso y recuperar contraseña; Google no lo usa). Mientras `turnstileSiteKey` esté vacío en `crm/config.js`, no se carga nada de Cloudflare ni aparece el recuadro.

**El orden importa.** Supabase, con el captcha activado, exige el token en *todos* los accesos con contraseña, registros y recuperaciones (CRM incluido). Si se activa en Supabase antes de que esté desplegada la Site Key, nadie podrá entrar.

1. **Cloudflare** → Turnstile → *Add widget*: nombre `Guimaes`, hostname `guimaes.es` (y `www.guimaes.es` si se usa), modo *Managed*. Da una **Site Key** (pública) y una **Secret Key**.
2. **Repo**: poner la Site Key en `crm/config.js` → `turnstileSiteKey: "…"`. La Secret Key **nunca** va en el repo.
3. **Compilar los dos** (los dos incluyen `config.js` en su build): `cd crm && npm run build` y `cd area-cliente && npm run build`; subir `VERSION` en `sw.js`; commit y push (despliega Vercel).
4. **Comprobar** en https://guimaes.es/area-cliente y https://guimaes.es/crm que aparece el recuadro de Cloudflare y que se puede entrar.
5. **Solo entonces, Supabase** → Authentication → Attack Protection → *Enable Captcha protection* → *Turnstile by Cloudflare* → pegar la **Secret Key** → Save.
6. Comprobar de nuevo acceso, registro y recuperar contraseña en los dos sitios.

Para desactivarlo, en orden inverso: primero apagarlo en Supabase y después vaciar `turnstileSiteKey`, compilar y desplegar.
