/* GUIMAES CRM — Autenticación (Supabase Auth) */
(function () {
  "use strict";
  var cfg = window.SUPABASE_CONFIG || {};
  var configured = !!(cfg.url && cfg.anonKey &&
    cfg.url.indexOf("YOUR-PROJECT") === -1 && cfg.anonKey.indexOf("YOUR-ANON-KEY") === -1);

  var client = (configured && window.supabase) ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

  // PASSWORD_RECOVERY: Supabase lo dispara UNA sola vez, muy pronto (dentro
  // de su propio setTimeout(0) al detectar el token de recuperación en la
  // URL, justo al crear el cliente) — mucho antes de que React monte y
  // llame a Auth.onAuthStateChange() desde app.jsx. Si nadie está
  // escuchando en ese instante exacto, el evento se pierde para siempre y
  // el enlace de "olvidé mi contraseña" no muestra el formulario de nueva
  // contraseña (el resto del login sigue funcionando, por eso este fallo
  // pasa desapercibido). Por eso nos suscribimos aquí mismo, en la misma
  // línea en que se crea el cliente — lo antes posible — y guardamos el
  // evento si todavía nadie lo ha reclamado, para repetírselo al primer
  // callback que se registre después (ver onAuthStateChange más abajo).
  var authListeners = [];
  var pendingRecoverySession = null;
  if (client) {
    client.auth.onAuthStateChange(function (event, session) {
      if (event === "PASSWORD_RECOVERY") pendingRecoverySession = session;
      authListeners.forEach(function (cb) { cb(event, session); });
    });
  }

  // Consulta real contra public.admins (sustituye a la antigua lista
  // hardcodeada en crm/data.js). Se comprueba por auth_user_id, no por
  // email, porque es el dato ya verificado por Supabase Auth en `user` —
  // comparar por email otra vez sería fiarse de una cadena que en teoría ya
  // no puede mentir, pero sin ganar nada a cambio. Cualquier fallo de la
  // consulta (red, RLS, tabla inexistente) deniega el acceso: nunca hay que
  // "abrir por defecto" ante un error.
  async function isAllowed(user) {
    if (!user || !client) return false;
    try {
      var res = await client.from("admins").select("id").eq("auth_user_id", user.id).eq("activo", true).maybeSingle();
      if (res.error) { if (window.console) console.error("Auth.isAllowed:", res.error); return false; }
      return !!res.data;
    } catch (e) {
      if (window.console) console.error("Auth.isAllowed:", e);
      return false;
    }
  }

  function friendlyError(msg) {
    if (!msg) return "Ha ocurrido un error. Inténtalo de nuevo.";
    if (/invalid login credentials/i.test(msg)) return "Correo o contraseña incorrectos.";
    if (/email not confirmed/i.test(msg)) return "Confirma tu correo antes de iniciar sesión.";
    if (/already.*registered|already been registered|email.*exists/i.test(msg)) return "Ya existe una cuenta con ese correo.";
    if (/failed to send a request|failed to fetch|networkerror|404/i.test(msg)) return "No se pudo conectar con la función 'admin-users' de Supabase. ¿La has desplegado? (ver crm/SETUP-SUPABASE.md)";
    return msg;
  }

  async function signInWithPassword(email, password) {
    if (!client) return { error: { message: "El acceso aún no está configurado (Supabase)." } };
    var res = await client.auth.signInWithPassword({ email: email, password: password });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    if (!(await isAllowed(res.data.user))) {
      await client.auth.signOut();
      return { error: { message: "Esta cuenta no tiene acceso al CRM." } };
    }
    return { data: res.data };
  }

  async function signInWithGoogle() {
    if (!client) return { error: { message: "El acceso aún no está configurado (Supabase)." } };
    return client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href.split("#")[0] }
    });
  }

  async function sendPasswordReset(email) {
    if (!client) return { error: { message: "El acceso aún no está configurado (Supabase)." } };
    // Fijo (no window.location.href): el Site URL del proyecto de Supabase
    // es la raíz del dominio (no se puede cambiar, la usará el área
    // cliente), así que sin esto el enlace del correo manda siempre a
    // https://guimaes.es y nunca aquí.
    var res = await client.auth.resetPasswordForEmail(email, { redirectTo: "https://guimaes.es/crm" });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    return {};
  }

  async function updatePassword(newPassword) {
    if (!client) return { error: { message: "El acceso aún no está configurado (Supabase)." } };
    var res = await client.auth.updateUser({ password: newPassword });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    return {};
  }

  async function createAdminUser(email, password, name, rol) {
    if (!client) return { error: { message: "El acceso aún no está configurado (Supabase)." } };
    const res = await client.functions.invoke("admin-users", { body: { action: "create", email, password, name, rol } });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    if (res.data && res.data.error) return { error: { message: friendlyError(res.data.error) } };
    return { data: res.data };
  }

  async function deleteAdminUser(email) {
    if (!client) return { error: { message: "El acceso aún no está configurado (Supabase)." } };
    const res = await client.functions.invoke("admin-users", { body: { action: "delete", email } });
    if (res.error) return { error: { message: friendlyError(res.error.message) } };
    if (res.data && res.data.error) return { error: { message: friendlyError(res.data.error) } };
    return { data: res.data };
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

  window.Auth = {
    configured: configured, isAllowed: isAllowed, client: client,
    signInWithPassword: signInWithPassword, signInWithGoogle: signInWithGoogle,
    sendPasswordReset: sendPasswordReset, updatePassword: updatePassword,
    createAdminUser: createAdminUser, deleteAdminUser: deleteAdminUser,
    signOut: signOut, getSession: getSession, onAuthStateChange: onAuthStateChange
  };
})();
