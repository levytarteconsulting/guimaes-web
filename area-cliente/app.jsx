/* Área cliente — app React (login/registro + edición de datos) */
const { useState: uState, useEffect: uEffect } = React;

function GoogleG({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9C16.66 14.2 17.64 11.9 17.64 9.2Z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18Z"/>
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.17.29-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.35 2.83.94 4.03l3.01-2.33Z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.97l3.01 2.33C4.66 5.17 6.65 3.58 9 3.58Z"/>
  </svg>;
}
function Field({ label, children }) { return <div className="fld"><label className="fld__l">{label}</label>{children}</div>; }

function AuthScreen({ onAuthed }) {
  const [mode, setMode] = uState("login");
  const [name, setName] = uState(""); const [email, setEmail] = uState(""); const [password, setPassword] = uState("");
  const [err, setErr] = uState(null); const [notice, setNotice] = uState(null); const [busy, setBusy] = uState(false);

  const submit = async (e) => {
    e.preventDefault(); setErr(null); setNotice(null); setBusy(true);
    if (mode === "signup") {
      const { data, error } = await ClientAuth.signUp(email, password, name);
      setBusy(false);
      if (error) { setErr(error.message); return; }
      if (data && data.session) { onAuthed(data.session); return; }
      setNotice("Cuenta creada. Si te pedimos confirmar el correo, revisa tu bandeja y después inicia sesión.");
      return;
    }
    const { data, error } = await ClientAuth.signIn(email, password);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onAuthed(data.session);
  };
  const google = async () => {
    setErr(null);
    const { error } = await ClientAuth.signInWithGoogle();
    if (error) setErr(error.message);
  };
  const forgot = async (e) => {
    e.preventDefault();
    if (!email) { setErr("Escribe tu correo arriba primero."); return; }
    setErr(null);
    const { error } = await ClientAuth.sendPasswordReset(email);
    if (error) { setErr(error.message); return; }
    setNotice("Te hemos enviado un correo a " + email + " para restablecer tu contraseña.");
  };

  return (
    <div className="ac-wrap">
      <div className="ac-card">
        <div className="ac-brand">GUIMAES</div>
        <div className="ac-tag">Área cliente</div>
        <div className="ac-tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setErr(null); setNotice(null); }}>Iniciar sesión</button>
          <button className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setErr(null); setNotice(null); }}>Crear cuenta</button>
        </div>
        {err && <div className="ac-err">{err}</div>}
        {notice && <div className="ac-notice">{notice}</div>}
        <form onSubmit={submit}>
          {mode === "signup" && <Field label="Nombre y apellidos"><input className="inp" value={name} onChange={e => setName(e.target.value)} required /></Field>}
          <Field label="Correo electrónico"><input className="inp" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
          <Field label="Contraseña"><input className="inp" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} required minLength={6} /></Field>
          {mode === "login" && <div style={{ textAlign: "right", margin: "-10px 0 14px" }}><a className="ac-link" onClick={forgot}>¿Olvidaste tu contraseña?</a></div>}
          <button className="btn btn--primary" type="submit" style={{ width: "100%" }} disabled={busy}>{busy ? "Un momento…" : (mode === "signup" ? "Crear cuenta" : "Entrar")}</button>
        </form>
        <div className="ac-divider"><span>o</span></div>
        <button className="btn btn--ghost" style={{ width: "100%" }} onClick={google}><GoogleG size={17} />Continuar con Google</button>
        {!ClientAuth.configured && <div className="ac-notice" style={{ marginTop: 14 }}>⚠ El área cliente aún no está conectada. Vuelve pronto.</div>}
        <a className="ac-back" href="/">← Volver a la web</a>
      </div>
    </div>
  );
}

function profileKey(session) { return "guimaes_client_profile_" + session.user.id; }
function loadProfile(session) {
  try { const raw = localStorage.getItem(profileKey(session)); if (raw) return JSON.parse(raw); } catch (e) {}
  return { company: "", cif: "", address: "", city: "", province: "", contact_name: session.user.user_metadata?.name || "", email: session.user.email, phone: "" };
}
function saveProfile(session, profile) { localStorage.setItem(profileKey(session), JSON.stringify(profile)); }

function Dashboard({ session, onLogout }) {
  const [f, setF] = uState(() => loadProfile(session));
  const [saved, setSaved] = uState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = (e) => { e.preventDefault(); saveProfile(session, f); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div className="ac-dash">
      <div className="ac-dash__nav">
        <span className="ac-brand" style={{ fontSize: 20 }}>GUIMAES</span>
        <span className="ac-pill">Área cliente</span>
        <div className="right row" style={{ gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{f.contact_name || session.user.email}</span>
          <button className="btn btn--sm btn--ghost" onClick={onLogout}>Cerrar sesión</button>
        </div>
      </div>
      <div className="ac-dash__wrap">
        <h1 style={{ fontSize: 26 }}>Tus datos</h1>
        <p className="muted" style={{ margin: "8px 0 24px" }}>Mantén actualizados los datos de tu empresa y de contacto.</p>
        <form onSubmit={save} className="card">
          <div className="card__body">
            <div className="section-title" style={{ marginBottom: 12 }}>Empresa</div>
            <div className="fld-row"><Field label="Nombre de la empresa"><input className="inp" value={f.company} onChange={set("company")} /></Field><Field label="CIF / NIF"><input className="inp" value={f.cif} onChange={set("cif")} /></Field></div>
            <div className="fld-row"><Field label="Dirección"><input className="inp" value={f.address} onChange={set("address")} /></Field><Field label="Ciudad"><input className="inp" value={f.city} onChange={set("city")} /></Field></div>
            <Field label="Provincia"><input className="inp" value={f.province} onChange={set("province")} /></Field>
            <div className="section-title" style={{ margin: "22px 0 12px" }}>Persona de contacto</div>
            <div className="fld-row"><Field label="Nombre y apellidos"><input className="inp" value={f.contact_name} onChange={set("contact_name")} /></Field><Field label="Teléfono"><input className="inp" value={f.phone} onChange={set("phone")} /></Field></div>
            <Field label="Correo electrónico"><input className="inp" value={f.email} disabled /></Field>
            <div className="row" style={{ justifyContent: "flex-end", gap: 12, marginTop: 8 }}>
              {saved && <span className="ac-saved">Guardado ✓</span>}
              <button className="btn btn--primary" type="submit">Guardar cambios</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = uState(null); const [booting, setBooting] = uState(true);
  uEffect(() => {
    let mounted = true;
    (async () => {
      if (ClientAuth.configured) {
        const s = await ClientAuth.getSession();
        if (mounted && s) setSession(s);
        ClientAuth.onAuthStateChange((event, s) => {
          if (event === "SIGNED_IN") setSession(s);
          if (event === "SIGNED_OUT") setSession(null);
        });
      }
      if (mounted) setBooting(false);
    })();
    return () => { mounted = false; };
  }, []);
  const logout = async () => { await ClientAuth.signOut(); setSession(null); };
  if (booting) return <div className="ac-wrap"></div>;
  if (!session) return <AuthScreen onAuthed={setSession} />;
  return <Dashboard session={session} onLogout={logout} />;
}
ReactDOM.createRoot(document.getElementById("root")).render(<App />);
