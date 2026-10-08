import { useEffect, useRef, useState } from "react";
import { supabase, alCambiarSesion } from "./supabase.js";
import * as api from "./api.js";

const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fecha = (iso) => (iso ? new Date(iso).toLocaleDateString("es-ES") : "");
const peso = (b) => (b == null ? "" : b < 1024 ? b + " B" : b < 1048576 ? Math.round(b / 1024) + " KB" : (b / 1048576).toFixed(1).replace(".", ",") + " MB");
const FRECUENCIA = { mensual: "al mes", trimestral: "al trimestre", anual: "al año", puntual: "pago único" };
const CLAVE_EMPRESA = "guimaes_portal_empresa";

// ---------- piezas ----------
function Marca() {
  return <a className="brand" href="/" aria-label="GUIMAES, ir a la web"><img className="brand__logo" src="/assets/guimaes-logo.png" alt="GUIMAES" /></a>;
}
function Cabecera({ derecha }) {
  return <header className="site-header pt-header"><div className="wrap nav"><Marca />{derecha && <div className="nav__right">{derecha}</div>}</div></header>;
}
function Aviso({ tipo = "error", children }) {
  if (!children) return null;
  return <div className={"pt-aviso pt-aviso--" + tipo} role={tipo === "error" ? "alert" : "status"}>{children}</div>;
}
function Campo({ id, label, ...props }) {
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} {...props} /></div>;
}
function Tarjeta({ titulo, children, sub }) {
  return <main className="pt-centro"><div className="form-card pt-tarjeta">
    {titulo && <h1 className="pt-titulo">{titulo}</h1>}
    {sub && <p className="pt-sub">{sub}</p>}
    {children}
  </div></main>;
}

// ---------- acceso, registro, olvidé ----------
function Acceso() {
  const [modo, setModo] = useState("entrar"); // entrar | registro | olvide
  const [nombre, setNombre] = useState(""); const [email, setEmail] = useState("");
  const [pass, setPass] = useState(""); const [pass2, setPass2] = useState("");
  const [error, setError] = useState(null); const [ok, setOk] = useState(null); const [busy, setBusy] = useState(false);
  const cambiar = (m) => { setModo(m); setError(null); setOk(null); };

  const enviar = async (e) => {
    e.preventDefault(); setError(null); setOk(null);
    // Validación propia (el formulario es noValidate): mensajes en español y
    // anunciados como alerta, en vez de las burbujas del navegador.
    if (modo === "registro" && !nombre.trim()) return setError("Escribe tu nombre y apellidos.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Escribe un email válido.");
    if (modo === "entrar" && !pass) return setError("Escribe tu contraseña.");
    if (modo === "registro") {
      if (pass.length < 8) return setError("La contraseña tiene que tener al menos 8 caracteres.");
      if (pass !== pass2) return setError("Las contraseñas no coinciden.");
    }
    setBusy(true);
    try {
      if (modo === "entrar") {
        const { error } = await api.entrar(email, pass);
        if (error) setError(api.mensajeAuth(error));
      } else if (modo === "registro") {
        const { data, error } = await api.registrarse(nombre, email, pass);
        if (error) setError(api.mensajeAuth(error));
        else if (!data.session) setOk("Te hemos enviado un email para confirmar tu cuenta. Abre el enlace y después inicia sesión aquí.");
      } else {
        const { error } = await api.recuperar(email);
        if (error && /rate limit|too many|security purposes/i.test(error.message || "")) setError(api.mensajeAuth(error));
        else setOk("Si existe una cuenta con ese email, te hemos enviado un enlace para crear una contraseña nueva.");
      }
    } catch (err) { setError(api.mensajeAuth(err)); }
    finally { setBusy(false); }
  };

  const titulos = { entrar: "Área de cliente", registro: "Crear cuenta", olvide: "Recuperar contraseña" };
  const subs = {
    entrar: "Consulta tus servicios y documentos, y envíanos documentación.",
    registro: "Cuando confirmes tu email, Guimaes verificará tu cuenta antes de darte acceso.",
    olvide: "Escribe tu email y te enviaremos un enlace para crear una contraseña nueva.",
  };
  return <>
    <Cabecera />
    <Tarjeta titulo={titulos[modo]} sub={subs[modo]}>
      {modo !== "olvide" && <div className="pt-segmento" role="tablist" aria-label="Acceso">
        <button role="tab" aria-selected={modo === "entrar"} className={modo === "entrar" ? "on" : ""} onClick={() => cambiar("entrar")}>Iniciar sesión</button>
        <button role="tab" aria-selected={modo === "registro"} className={modo === "registro" ? "on" : ""} onClick={() => cambiar("registro")}>Crear cuenta</button>
      </div>}
      <Aviso>{error}</Aviso>
      <Aviso tipo="ok">{ok}</Aviso>
      <form onSubmit={enviar} noValidate>
        {modo === "registro" && <Campo id="nombre" label="Nombre y apellidos" value={nombre} onChange={(e) => setNombre(e.target.value)} required autoComplete="name" />}
        <Campo id="email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        {modo !== "olvide" && <Campo id="pass" label="Contraseña" type="password" value={pass} onChange={(e) => setPass(e.target.value)} required
          minLength={modo === "registro" ? 8 : undefined} autoComplete={modo === "registro" ? "new-password" : "current-password"} />}
        {modo === "registro" && <Campo id="pass2" label="Repite la contraseña" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} required minLength={8} autoComplete="new-password" />}
        {modo === "entrar" && <p className="pt-enlace-der"><button type="button" className="pt-enlace" onClick={() => cambiar("olvide")}>¿Has olvidado tu contraseña?</button></p>}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? "Un momento…" : modo === "entrar" ? "Entrar" : modo === "registro" ? "Crear cuenta" : "Enviar enlace"}
        </button>
      </form>
      {modo === "olvide" && <p className="pt-pie"><button className="pt-enlace" onClick={() => cambiar("entrar")}>Volver a iniciar sesión</button></p>}
      <p className="pt-pie"><a className="pt-enlace" href="/">← Volver a la web</a></p>
    </Tarjeta>
  </>;
}

function NuevaContrasena({ onHecho }) {
  const [pass, setPass] = useState(""); const [pass2, setPass2] = useState("");
  const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  const enviar = async (e) => {
    e.preventDefault(); setError(null);
    if (pass.length < 8) return setError("La contraseña tiene que tener al menos 8 caracteres.");
    if (pass !== pass2) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const { error } = await api.nuevaContrasena(pass);
    setBusy(false);
    if (error) setError(api.mensajeAuth(error)); else onHecho();
  };
  return <>
    <Cabecera />
    <Tarjeta titulo="Nueva contraseña" sub="Elige la contraseña con la que entrarás a partir de ahora.">
      <Aviso>{error}</Aviso>
      <form onSubmit={enviar} noValidate>
        <Campo id="np1" label="Nueva contraseña" type="password" value={pass} onChange={(e) => setPass(e.target.value)} required minLength={8} autoComplete="new-password" />
        <Campo id="np2" label="Repite la contraseña" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} required minLength={8} autoComplete="new-password" />
        <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button>
      </form>
    </Tarjeta>
  </>;
}

// ---------- estados sin acceso ----------
function BotonSalir() {
  return <button className="btn btn--ghost btn--sm pt-salir" onClick={() => api.salir()}>Cerrar sesión</button>;
}
function EstadoAdmin() {
  return <>
    <Cabecera derecha={<BotonSalir />} />
    <Tarjeta titulo="Esta área es para clientes" sub="Has entrado con una cuenta del equipo de GUIMAES. Las cuentas del equipo trabajan desde el CRM.">
      <a className="btn btn--primary" href="/crm">Ir al CRM</a>
    </Tarjeta>
  </>;
}
function EstadoPendiente({ estado, onRecargar }) {
  const [busy, setBusy] = useState(false);
  return <>
    <Cabecera derecha={<BotonSalir />} />
    <Tarjeta titulo="Tu cuenta está pendiente de verificación por Guimaes"
      sub="Estamos comprobando tus datos. Te avisaremos por email en cuanto tu acceso esté activo; no tienes que hacer nada más.">
      {estado && estado.email && <p className="pt-dato">Cuenta: <b>{estado.email}</b></p>}
      <button className="btn btn--ghost" disabled={busy} onClick={async () => { setBusy(true); await onRecargar(); setBusy(false); }}>
        {busy ? "Comprobando…" : "Comprobar de nuevo"}
      </button>
    </Tarjeta>
  </>;
}

// ---------- aplicación del cliente ----------
function Servicios({ lista }) {
  if (!lista.length) return <p className="pt-vacio">No hay servicios en curso con esta empresa.</p>;
  return <ul className="pt-lista">{lista.map((d, i) => (
    <li key={i} className="pt-servicio">
      <div className="pt-servicio__cab">
        <h3>{d.servicio || "Servicio"}</h3>
        <span className={"pt-estado " + (d.estado === "Contratado" ? "pt-estado--ok" : "pt-estado--curso")}>{d.estado}</span>
      </div>
      {d.importe != null && <p className="pt-importe">{eur.format(d.importe)} <span>{FRECUENCIA[d.frecuencia] || d.frecuencia || ""}</span></p>}
      {d.num_nominas != null && d.coste_nomina != null && <p className="pt-desglose">{d.num_nominas} nóminas × {eur.format(d.coste_nomina)}</p>}
    </li>
  ))}</ul>;
}

function DatosEmpresa({ e }) {
  const filas = [["Razón social", e.razon_social], ["CIF", e.cif], ["Dirección", e.direccion],
    ["Ciudad", [e.ciudad, e.provincia && e.provincia !== e.ciudad ? e.provincia : null].filter(Boolean).join(", ")]];
  return <>
    <dl className="pt-datos">{filas.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || "—"}</dd></div>)}</dl>
    <p className="pt-nota">¿Algún dato no es correcto? <a className="pt-enlace" href="/contacto">Escríbenos</a> y lo actualizamos.</p>
  </>;
}

function Subida({ empresaId, onSubido }) {
  const input = useRef(null);
  const [paso, setPaso] = useState(null); // null | preparando | subiendo | comprobando
  const [error, setError] = useState(null); const [ok, setOk] = useState(null);
  const elegir = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setError(null); setOk(null);
    const v = api.validar(file);
    if (!v.ok) { setError(v.error); return; }
    try {
      const r = await api.subir(empresaId, file, setPaso);
      setOk(`«${r.nombre}» se ha enviado a Guimaes.`);
      onSubido();
    } catch (err) { setError(err.message); }
    finally { setPaso(null); }
  };
  const textoPaso = { preparando: "Preparando la subida…", subiendo: "Subiendo el fichero…", comprobando: "Comprobando el fichero…" };
  return <section className="pt-subida" aria-labelledby="t-subida">
    <h3 id="t-subida">Enviar un documento</h3>
    <p className="pt-nota">Formatos: {api.FORMATOS}. Máximo 15 MB por fichero.</p>
    <input ref={input} id="fichero" type="file" accept={api.ACCEPT} className="pt-oculto" onChange={elegir} disabled={!!paso} />
    <button className="btn btn--primary btn--sm" onClick={() => input.current && input.current.click()} disabled={!!paso} aria-describedby="t-subida">
      {paso ? textoPaso[paso] : "Elegir fichero"}
    </button>
    {paso && <div className="pt-progreso" role="progressbar" aria-label={textoPaso[paso]}><div /></div>}
    <div aria-live="polite"><Aviso>{error}</Aviso><Aviso tipo="ok">{ok}</Aviso></div>
  </section>;
}

function Documentos({ empresaId, carpetas, docs, onRecargar }) {
  const [error, setError] = useState(null); const [bajando, setBajando] = useState(null);
  const bajar = async (d) => {
    setError(null); setBajando(d.documento_id);
    try { await api.descargar(d.documento_id); } catch (e) { setError(e.message); }
    finally { setBajando(null); }
  };
  const nombreCarpeta = (k) => (k.aportados ? "Aportados por vosotros" : k.nombre);
  const raices = carpetas.filter((k) => !k.carpeta_padre_id);
  const hijas = (id) => carpetas.filter((k) => k.carpeta_padre_id === id);
  const enCarpeta = (id) => docs.filter((d) => d.carpeta_id === id);
  const Lista = ({ items }) => <ul className="pt-docs">{items.map((d) => (
    <li key={d.documento_id} className="pt-doc">
      <div className="pt-doc__info">
        <span className="pt-doc__nombre">{d.nombre}</span>
        <span className="pt-doc__meta">{[peso(d.tamano_bytes), fecha(d.fecha)].filter(Boolean).join(" · ")}
          {d.aportado_por_cliente && <span className="pt-marca">Aportado por vosotros</span>}</span>
      </div>
      <button className="btn btn--ghost btn--sm" onClick={() => bajar(d)} disabled={bajando === d.documento_id} aria-label={"Descargar " + d.nombre}>
        {bajando === d.documento_id ? "Abriendo…" : "Descargar"}
      </button>
    </li>
  ))}</ul>;
  const conAlgo = (k) => enCarpeta(k.carpeta_id).length || hijas(k.carpeta_id).some((h) => enCarpeta(h.carpeta_id).length);
  const visibles = raices.filter(conAlgo);
  return <>
    <Subida empresaId={empresaId} onSubido={onRecargar} />
    <Aviso>{error}</Aviso>
    {visibles.length === 0 ? <p className="pt-vacio">Todavía no hay documentos compartidos contigo.</p>
      : visibles.map((k) => <section key={k.carpeta_id} className="pt-carpeta" aria-label={nombreCarpeta(k)}>
          <h3>{nombreCarpeta(k)}</h3>
          {enCarpeta(k.carpeta_id).length > 0 && <Lista items={enCarpeta(k.carpeta_id)} />}
          {hijas(k.carpeta_id).filter((h) => enCarpeta(h.carpeta_id).length).map((h) => <div key={h.carpeta_id} className="pt-subcarpeta">
            <h4>{h.nombre}</h4><Lista items={enCarpeta(h.carpeta_id)} />
          </div>)}
        </section>)}
  </>;
}

function AppCliente({ estado }) {
  const [empresas, setEmpresas] = useState(null);
  const [empresaId, setEmpresaId] = useState(null);
  const [datos, setDatos] = useState(null); // {deals, carpetas, docs}
  const [error, setError] = useState(null);
  const [pestana, setPestana] = useState("documentos");

  useEffect(() => {
    api.empresas().then((lista) => {
      setEmpresas(lista);
      let guardada = null; try { guardada = localStorage.getItem(CLAVE_EMPRESA); } catch { /* sin almacenamiento */ }
      const inicial = lista.find((e) => e.empresa_id === guardada) || lista.find((e) => e.principal) || lista[0];
      setEmpresaId(inicial ? inicial.empresa_id : null);
    }).catch((e) => setError(e.message));
  }, []);
  const cargar = async (id) => {
    setError(null);
    try {
      const [deals, carpetas, docs] = await Promise.all([api.deals(id), api.carpetas(id), api.documentos(id)]);
      setDatos({ id, deals, carpetas, docs });
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { if (empresaId) { setDatos(null); cargar(empresaId); } }, [empresaId]);
  const elegirEmpresa = (id) => { setEmpresaId(id); try { localStorage.setItem(CLAVE_EMPRESA, id); } catch { /* sin almacenamiento */ } };

  const empresa = empresas && empresas.find((e) => e.empresa_id === empresaId);
  const pestanas = [["documentos", "Documentos"], ["servicios", "Servicios"], ["empresa", "Empresa"]];
  return <>
    <Cabecera derecha={<><span className="pt-usuario">{estado.nombre || estado.email}</span><BotonSalir /></>} />
    <main className="wrap pt-app">
      {empresas && empresas.length > 1 && <div className="field pt-selector">
        <label htmlFor="empresa">Empresa</label>
        <select id="empresa" value={empresaId || ""} onChange={(e) => elegirEmpresa(e.target.value)}>
          {empresas.map((e) => <option key={e.empresa_id} value={e.empresa_id}>{e.razon_social}</option>)}
        </select>
      </div>}
      <h1 className="pt-empresa">{empresa ? empresa.razon_social : empresas && empresas.length === 0 ? "Sin empresas" : "Cargando…"}</h1>
      <Aviso>{error}</Aviso>
      {empresas && empresas.length === 0 && <p className="pt-vacio">Tu cuenta todavía no tiene ninguna empresa asociada. Escríbenos y lo revisamos.</p>}
      {empresa && <>
        <div className="pt-pestanas" role="tablist" aria-label="Secciones">
          {pestanas.map(([id, txt]) => <button key={id} role="tab" id={"tab-" + id} aria-controls={"panel-" + id} aria-selected={pestana === id}
            className={pestana === id ? "on" : ""} onClick={() => setPestana(id)}>{txt}</button>)}
        </div>
        <section role="tabpanel" id={"panel-" + pestana} aria-labelledby={"tab-" + pestana} className="pt-panel">
          {!datos || datos.id !== empresaId ? <p className="pt-vacio">Cargando…</p>
            : pestana === "documentos" ? <Documentos empresaId={empresaId} carpetas={datos.carpetas} docs={datos.docs} onRecargar={() => cargar(empresaId)} />
            : pestana === "servicios" ? <Servicios lista={datos.deals} />
            : <DatosEmpresa e={empresa} />}
        </section>
      </>}
    </main>
  </>;
}

// ---------- raíz ----------
export default function App() {
  const [sesion, setSesion] = useState(undefined); // undefined = arrancando
  const [estado, setEstado] = useState(null);
  const [recuperando, setRecuperando] = useState(false);
  const [error, setError] = useState(null);

  const cargarEstado = async () => {
    try { setEstado(await api.estado()); setError(null); }
    catch (e) { setError(e.message); }
  };
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSesion(data.session || null));
    return alCambiarSesion((evento, s) => {
      if (evento === "PASSWORD_RECOVERY") { setRecuperando(true); setSesion(s); return; }
      if (evento === "SIGNED_OUT") { setSesion(null); setEstado(null); return; }
      if (evento === "SIGNED_IN" || evento === "TOKEN_REFRESHED" || evento === "USER_UPDATED") setSesion(s);
    });
  }, []);
  useEffect(() => { if (sesion && !recuperando) cargarEstado(); }, [sesion && sesion.user && sesion.user.id, recuperando]);

  if (sesion === undefined) return <div className="pt-cargando" aria-busy="true" />;
  if (recuperando) return <NuevaContrasena onHecho={() => setRecuperando(false)} />;
  if (!sesion) return <Acceso />;
  if (error) return <><Cabecera derecha={<BotonSalir />} /><Tarjeta titulo="No se ha podido cargar tu cuenta"><Aviso>{error}</Aviso>
    <button className="btn btn--primary" onClick={cargarEstado}>Reintentar</button></Tarjeta></>;
  if (!estado) return <div className="pt-cargando" aria-busy="true" />;
  if (estado.estado === "admin") return <EstadoAdmin />;
  if (estado.estado === "pendiente") return <EstadoPendiente estado={estado} onRecargar={cargarEstado} />;
  return <AppCliente estado={estado} />;
}
