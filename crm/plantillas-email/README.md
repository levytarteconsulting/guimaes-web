# Plantillas de correo de Supabase Auth (español)

Valen para el CRM y para el área de cliente a la vez: Supabase usa una sola plantilla por tipo.
Se pegan en Authentication → Emails → Templates. Para cada una: el **Subject** de esta tabla y el **Body** (todo el contenido del fichero).

| Plantilla en Supabase | Fichero | Subject |
|---|---|---|
| Confirm signup | `1-confirmar-registro.html` | Confirma tu email para el área de cliente de GUIMAES |
| Reset Password | `2-recuperar-contrasena.html` | Restablece tu contraseña de GUIMAES |
| Change Email Address | `3-cambio-email.html` | Confirma el cambio de email de tu cuenta de GUIMAES |

Variables que usan: `{{ .ConfirmationURL }}`, `{{ .Email }}` y `{{ .NewEmail }}` (las de Supabase). Estilos en línea, sin imágenes externas, para que se vean igual en Gmail, Outlook y móvil.
