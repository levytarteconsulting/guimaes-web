/* Área cliente — autenticación (Supabase Auth, registro público habilitado) */
(function () {
  "use strict";
  var cfg = window.SUPABASE_CONFIG || {};
  var configured = !!(cfg.url && cfg.anonKey &&
    cfg.url.indexOf("YOUR-PROJECT") === -1 && cfg.anonKey.indexOf("YOUR-ANON-KEY") === -1);
  var client = (configured && window.supabase) ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

  // PASSWORD_RECOVERY: Supabase lo dispara UNA sola vez, muy pronto (dentro
  // de su propio setTimeout(0) al detectar el token de recuperación en la
  // URL, justo al crear el cliente) — mucho antes de que React monte y
  // llame a ClientAuth.onAuthStateChange() desde app.jsx (aquí encima con
  // más motivo: esta página transpila JSX con Babel en el navegador antes
  // de poder montar nada). Si nadie está escuchando en ese instante
  // exacto, el evento se pierde para siempre y el enlace de "olvidé mi
  // contraseña" deja al usuario dentro de su cuenta antigua sin haber
  // cambiado nada. Por eso nos suscribimos aquí mismo, en la misma línea
  // en que se crea el cliente, y guardamos el evento si nadie lo ha
  // reclamado todavía, para repetírselo al primer callback que se
  // registre después (ver onAuthStateChange más abajo).
  var authListeners = [];
  var pendingRecoverySession = null;
  if (client) {
    client.auth.onAuthStateChange(function (event, session) {
      if (event === "PASSWORD_RECOVERY") pendingRecoverySession = session;
      authListeners.forEach(function (cb) { cb(event, session); });
    });
  }

  function friendlyError(msg) {
    if (!msg) return "Ha ocurrido un error. Inténtalo de nuevo.";
    if (/invalid login credentials/i.test(msg)) return "Correo o contraseña incorrectos.";
    if (/already registered|already been registered|user already exists/i.test(msg)) return "Ya existe una cuenta con ese correo — prueba a iniciar sesión.";
    if (/password.*(least|character|6)/i.test(msg)) return "La contraseña debe tener al menos 6 caracteres.";
    if (/email not confirmed/i.test(msg)) return "Confirma tu correo antes de iniciar sesión (revisa tu bandeja de entrada).";
    return msg;
  }

  async function signUp(email, password, name) {
    if (!client) return { error: { message: "El área cliente aún no está configurada." } };
    var res = await client.auth.signUp({ email: email, password: password, options: { data: { name: name } } });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    return { data: res.data };
  }
  async function signIn(email, password) {
    if (!client) return { error: { message: "El área cliente aún no está configurada." } };
    var res = await client.auth.signInWithPassword({ email: email, password: password });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    return { data: res.data };
  }
  async function signInWithGoogle() {
    if (!client) return { error: { message: "El área cliente aún no está configurada." } };
    return client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href.split("#")[0] } });
  }
  async function sendPasswordReset(email) {
    if (!client) return { error: { message: "El área cliente aún no está configurada." } };
    // Fijo (no window.location.href): el Site URL del proyecto de Supabase
    // es la raíz del dominio y no se puede cambiar, así que sin esto el
    // enlace del correo manda siempre a https://guimaes.es y nunca aquí.
    var res = await client.auth.resetPasswordForEmail(email, { redirectTo: "https://guimaes.es/area-cliente" });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    return {};
  }
  async function updatePassword(newPassword) {
    if (!client) return { error: { message: "El área cliente aún no está configurada." } };
    var res = await client.auth.updateUser({ password: newPassword });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    return {};
  }
  async function signOut() { if (client) await client.auth.signOut(); }
  async function getSession() { if (!client) return null; var r = await client.auth.getSession(); return r.data.session; }
  function onAuthStateChange(cb) {
    authListeners.push(cb);
    if (pendingRecoverySession) {
      cb("PASSWORD_RECOVERY", pendingRecoverySession);
      pendingRecoverySession = null;
    }
  }

  window.ClientAuth = {
    configured: configured,
    signUp: signUp, signIn: signIn, signInWithGoogle: signInWithGoogle,
    sendPasswordReset: sendPasswordReset, updatePassword: updatePassword,
    signOut: signOut, getSession: getSession, onAuthStateChange: onAuthStateChange
  };
})();
