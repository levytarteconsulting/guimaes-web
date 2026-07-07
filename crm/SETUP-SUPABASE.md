# Configurar el acceso real al CRM (Supabase Auth)

## 1. Crear el proyecto
1. Ve a https://supabase.com → crea una cuenta/proyecto gratuito.
2. En **Project Settings → API**, copia el **Project URL** y la **anon public key**.
3. Pégalos en `crm/config.js`.

## 2. Restringir quién puede entrar (muy importante)
1. **Authentication → Providers → Email** → desactiva "Allow new users to sign up" (o "Enable email signups"). Así nadie puede auto-registrarse; solo existen las cuentas que un administrador cree explícitamente.
2. Marca "Auto Confirm User" en los usuarios que crees para que no necesiten confirmar el email.
3. Crea las cuentas iniciales (los 5 administradores) manualmente, una única vez, en **Authentication → Users → Add user**. A partir de ahí, ya puedes dar de alta a los siguientes administradores directamente desde el propio CRM (ver apartado 5) sin volver a tocar el dashboard.

La app además comprueba que el email que ha iniciado sesión pertenezca a un administrador dado de alta (ver `crm/data.js`) y cierra la sesión si no lo está — pero el paso 1 es el que de verdad bloquea el acceso a cualquier otra persona.

## 3. Activar "Continuar con Google"
1. En Google Cloud Console, crea un **OAuth Client ID** (tipo "Web application").
2. En **Authentication → Providers → Google** de Supabase, pega el Client ID y Client Secret. Supabase te muestra la "Redirect URL" que debes añadir en Google Cloud como Authorized redirect URI.
3. Con esto, cualquier administrador puede entrar con su cuenta de Gmail — pero solo si su email tiene una cuenta creada (si no, la app le cerrará la sesión automáticamente).

## 4. Recuperar contraseña
Ya está implementado ("¿Olvidaste tu contraseña?" en el login). Solo tienes que configurar en **Authentication → URL Configuration**:
- **Site URL**: la URL definitiva de la web (ej. `https://guimaes.es/crm.html`)
- **Redirect URLs**: añade también la URL donde estés probando el CRM mientras lo desarrollamos.

## 5. Crear administradores desde el propio CRM (sin tocar Supabase)
Config → Usuarios y roles → "Nuevo administrador" ya genera el acceso real (email + contraseña temporal) automáticamente. Para que funcione hace falta desplegar **una vez** una pequeña función en Supabase (no se puede crear usuarios con permisos de administrador directamente desde el navegador por seguridad — necesita ejecutarse en un servidor).

El código ya está listo en `crm/supabase-functions/admin-users/index.ts`. Para desplegarlo:
1. Instala la Supabase CLI (`npm install -g supabase` o ver https://supabase.com/docs/guides/cli).
2. Desde una terminal, en la carpeta del proyecto:
   ```
   supabase login
   supabase link --project-ref TU_PROJECT_REF   (el ref está en la URL del proyecto: https://supabase.com/dashboard/project/TU_PROJECT_REF)
   supabase functions deploy admin-users --project-ref TU_PROJECT_REF
   ```
3. Listo. No hace falta configurar ninguna clave adicional — Supabase inyecta las credenciales necesarias automáticamente dentro de la función.

Mientras no despliegues la función, "Nuevo administrador" en el CRM mostrará un aviso claro pidiéndote que la despliegues (y puedes seguir creando usuarios a mano en el paso 2 si lo prefieres).

## 6. Formulario de la web → CRM (leads reales) ✅ IMPLEMENTADO
Los envíos del formulario de contacto de la web ya se guardan en Supabase (tabla `leads`) y aparecen en el CRM como contactos nuevos (ciclo de vida "Nuevo", origen "Formulario web"), con el mensaje del cliente como nota.

**Para activarlo solo tienes que crear la tabla una vez:**
1. En Supabase → **SQL Editor → New query**.
2. Abre el archivo `crm/supabase-leads.sql`, copia todo su contenido, pégalo y pulsa **Run**.
3. Listo. A partir de ese momento, cada formulario enviado en `guimaes.es` (cualquier página, ES o EN) se registra automáticamente y lo verás en **Contactos** del CRM al iniciar sesión.

Cómo funciona (seguridad):
- La web usa la `anon key` (pública) y las políticas RLS solo permiten **INSERTAR** desde la web; nadie puede leer los leads con esa clave.
- Solo los administradores autenticados (los que inician sesión en el CRM) pueden **LEER** los leads.
- Los leads se cargan al iniciar sesión en el CRM. Si llega uno nuevo mientras el CRM está abierto, recarga la página para verlo.

## 7. Migrar el resto de datos (siguiente paso, cuando el proyecto esté terminado)
Ahora mismo contactos/deals/tareas/etc. siguen en `crm/data.js` (datos de ejemplo). Cuando quieras pasar a datos reales, creamos las tablas en Supabase (Postgres) e importamos tus clientes — avísame cuando quieras dar ese paso.
