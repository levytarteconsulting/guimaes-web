/* Área cliente — autenticación (Supabase Auth, registro público habilitado) */
(function () {
  "use strict";
  var cfg = window.SUPABASE_CONFIG || {};
  var configured = !!(cfg.url && cfg.anonKey &&
    cfg.url.indexOf("YOUR-PROJECT") === -1 && cfg.anonKey.indexOf("YOUR-ANON-KEY") === -1);
  var client = (configured && window.supabase) ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

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
    var res = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split("#")[0] });
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
  function onAuthStateChange(cb) { if (client) client.auth.onAuthStateChange(cb); }

  window.ClientAuth = {
    configured: configured,
    signUp: signUp, signIn: signIn, signInWithGoogle: signInWithGoogle,
    sendPasswordReset: sendPasswordReset, updatePassword: updatePassword,
    signOut: signOut, getSession: getSession, onAuthStateChange: onAuthStateChange
  };
})();
