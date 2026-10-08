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
const ESTADOS = [["Contratado", "Contratados"], ["En estudio", "En estudio"], ["Solicitado", "Solicitados"]];
const CAMPO_NOMBRE = { razon_social: "Razón social", cif: "CIF" };
const ESTADO_SOLICITUD = { pendiente: "pendiente de revisión", aplicada: "aplicada", rechazada: "no aplicada" };
const nombreCarpeta = (k) => (k.aportados ? "Aportados por vosotros" : k.nombre);

// Ruta de navegación: "Inicio › Fiscal › 2026". El último tramo no es enlace.
function Ruta({ tramos }) {
  return <nav className="pt-ruta" aria-label="Ruta">
    <ol>{tramos.map((t, i) => <li key={i}>
      {i < tramos.length - 1 ? <button className="pt-enlace" onClick={t.ir}>{t.txt}</button> : <span aria-current="page">{t.txt}</span>}
    </li>)}</ol>
  </nav>;
}

function Servicio({ d }) {
  return <li className="pt-servicio">
    <div className="pt-servicio__cab">
      <h4>{d.servicio || "Servicio"}</h4>
      <span className={"pt-estado " + (d.estado === "Contratado" ? "pt-estado--ok" : d.estado === "En estudio" ? "pt-estado--curso" : "pt-estado--pedido")}>{d.estado}</span>
    </div>
    {d.importe != null && <p className="pt-importe">{eur.format(d.importe)} <span>{FRECUENCIA[d.frecuencia] || d.frecuencia || ""}</span></p>}
    {d.num_nominas != null && d.coste_nomina != null && <p className="pt-desglose">{d.num_nominas} nóminas × {eur.format(d.coste_nomina)}</p>}
    {d.estado === "Solicitado" && d.importe == null && <p className="pt-desglose">Te contactaremos para preparar la propuesta.</p>}
  </li>;
}

function Subida({ empresaId, onSubido, titulo = "Enviar un documento" }) {
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
      setOk(`«${r.nombre}» se ha enviado a Guimaes. Lo tienes en «Aportados por vosotros».`);
      onSubido();
    } catch (err) { setError(err.message); }
    finally { setPaso(null); }
  };
  const textoPaso = { preparando: "Preparando la subida…", subiendo: "Subiendo el fichero…", comprobando: "Comprobando el fichero…" };
  return <section className="pt-subida" aria-label={titulo}>
    <div className="pt-subida__fila">
      <div>
        <h3>{titulo}</h3>
        <p className="pt-nota">Formatos: {api.FORMATOS}. Máximo 15 MB.</p>
      </div>
      <input ref={input} id="fichero" type="file" accept={api.ACCEPT} className="pt-oculto" onChange={elegir} disabled={!!paso} />
      <button className="btn btn--primary btn--sm" onClick={() => input.current && input.current.click()} disabled={!!paso}>
        {paso ? textoPaso[paso] : "Subir documento"}
      </button>
    </div>
    {paso && <div className="pt-progreso" role="progressbar" aria-label={textoPaso[paso]}><div /></div>}
    <div aria-live="polite"><Aviso>{error}</Aviso><Aviso tipo="ok">{ok}</Aviso></div>
  </section>;
}

// ----- inicio (dashboard) -----
function Inicio({ empresa, datos, ir, onRecargar }) {
  const { deals, carpetas, docs, solicitudes } = datos;
  const raices = carpetas.filter((k) => !k.carpeta_padre_id).sort((a, b) => (b.aportados - a.aportados) || (a.orden - b.orden));
  const cuenta = (k) => docs.filter((d) => d.carpeta_id === k.carpeta_id || carpetas.some((h) => h.carpeta_padre_id === k.carpeta_id && h.carpeta_id === d.carpeta_id)).length;
  const pendientes = solicitudes.filter((x) => x.estado === "pendiente");
  return <div className="pt-dashboard">
    <section className="pt-card" aria-labelledby="t-empresa">
      <div className="pt-card__cab"><h2 id="t-empresa">Tu empresa</h2>
        <button className="btn btn--ghost btn--sm" onClick={() => ir({ tipo: "empresa" })}>Editar datos</button></div>
      <dl className="pt-mini">
        <div><dt>Razón social</dt><dd>{empresa.razon_social}</dd></div>
        <div><dt>CIF</dt><dd>{empresa.cif || "—"}</dd></div>
        <div><dt>Dirección</dt><dd>{[empresa.direccion, empresa.ciudad, empresa.provincia && empresa.provincia !== empresa.ciudad ? empresa.provincia : null].filter(Boolean).join(", ") || "—"}</dd></div>
      </dl>
      {pendientes.length > 0 && <p className="pt-nota">Tienes {pendientes.length === 1 ? "un cambio solicitado" : pendientes.length + " cambios solicitados"} pendiente{pendientes.length === 1 ? "" : "s"} de revisión.</p>}
    </section>

    <section className="pt-card" aria-labelledby="t-servicios">
      <div className="pt-card__cab"><h2 id="t-servicios">Servicios</h2>
        <button className="btn btn--primary btn--sm" onClick={() => ir({ tipo: "solicitar" })}>Solicitar un servicio</button></div>
      {deals.length === 0 ? <p className="pt-vacio">Todavía no tienes servicios con nosotros.</p>
        : ESTADOS.map(([estado, titulo]) => {
          const lista = deals.filter((d) => d.estado === estado);
          return lista.length ? <div key={estado} className="pt-grupo"><h3>{titulo}</h3><ul className="pt-lista">{lista.map((d, i) => <Servicio key={i} d={d} />)}</ul></div> : null;
        })}
    </section>

    <section className="pt-card pt-card--ancha" aria-labelledby="t-docs">
      <div className="pt-card__cab"><h2 id="t-docs">Documentos</h2></div>
      <Subida empresaId={empresa.empresa_id} onSubido={onRecargar} />
      <ul className="pt-carpetas">{raices.map((k) => <li key={k.carpeta_id}>
        <button className={"pt-carpeta-card" + (k.aportados ? " pt-carpeta-card--aportados" : "")} onClick={() => ir({ tipo: "carpeta", id: k.carpeta_id })}>
          <span className="pt-carpeta-card__icono" aria-hidden="true">{k.aportados ? "⇪" : "▤"}</span>
          <span className="pt-carpeta-card__nombre">{nombreCarpeta(k)}</span>
          <span className="pt-carpeta-card__n">{cuenta(k)} documento{cuenta(k) === 1 ? "" : "s"}</span>
        </button>
      </li>)}</ul>
      {raices.every((k) => k.aportados) && docs.length === 0 && <p className="pt-nota">Cuando Guimaes comparta documentos contigo, aparecerán aquí por carpetas.</p>}
    </section>
  </div>;
}

// ----- una carpeta -----
function Carpeta({ empresa, datos, id, ir, onRecargar }) {
  const [error, setError] = useState(null); const [bajando, setBajando] = useState(null);
  const { carpetas, docs } = datos;
  const k = carpetas.find((x) => x.carpeta_id === id);
  if (!k) return <><Ruta tramos={[{ txt: "Inicio", ir: () => ir({ tipo: "inicio" }) }, { txt: "Carpeta" }]} /><p className="pt-vacio">Esta carpeta ya no está disponible.</p></>;
  const madre = k.carpeta_padre_id && carpetas.find((x) => x.carpeta_id === k.carpeta_padre_id);
  const hijas = carpetas.filter((x) => x.carpeta_padre_id === k.carpeta_id);
  const aqui = docs.filter((d) => d.carpeta_id === k.carpeta_id);
  const bajar = async (d) => {
    setError(null); setBajando(d.documento_id);
    try { await api.descargar(d.documento_id); } catch (e) { setError(e.message); }
    finally { setBajando(null); }
  };
  const tramos = [{ txt: "Inicio", ir: () => ir({ tipo: "inicio" }) }];
  if (madre) tramos.push({ txt: nombreCarpeta(madre), ir: () => ir({ tipo: "carpeta", id: madre.carpeta_id }) });
  tramos.push({ txt: nombreCarpeta(k) });
  return <>
    <Ruta tramos={tramos} />
    <h2 className="pt-h2">{nombreCarpeta(k)}</h2>
    {k.aportados && <Subida empresaId={empresa.empresa_id} onSubido={onRecargar} titulo="Enviar un documento a Guimaes" />}
    <Aviso>{error}</Aviso>
    {hijas.length > 0 && <ul className="pt-carpetas">{hijas.map((h) => {
      const n = docs.filter((d) => d.carpeta_id === h.carpeta_id).length;
      return <li key={h.carpeta_id}><button className="pt-carpeta-card" onClick={() => ir({ tipo: "carpeta", id: h.carpeta_id })}>
        <span className="pt-carpeta-card__icono" aria-hidden="true">▤</span>
        <span className="pt-carpeta-card__nombre">{h.nombre}</span>
        <span className="pt-carpeta-card__n">{n} documento{n === 1 ? "" : "s"}</span>
      </button></li>;
    })}</ul>}
    {aqui.length > 0 ? <ul className="pt-docs">{aqui.map((d) => (
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
    ))}</ul> : hijas.length === 0 && <p className="pt-vacio">{k.aportados ? "Todavía no nos has enviado ningún documento." : "Esta carpeta está vacía."}</p>}
  </>;
}

// ----- datos de la empresa: edición y solicitudes de cambio -----
function SolicitarCambio({ empresa, campo, onHecho }) {
  const [abierto, setAbierto] = useState(false);
  const [valor, setValor] = useState(""); const [comentario, setComentario] = useState("");
  const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  if (!abierto) return <button className="pt-enlace" onClick={() => setAbierto(true)}>Solicitar cambio</button>;
  const enviar = async (e) => {
    e.preventDefault(); setError(null);
    if (!valor.trim()) return setError(campo === "cif" ? "Escribe el CIF nuevo." : "Escribe la razón social nueva.");
    setBusy(true);
    try { await api.solicitarCambio(empresa.empresa_id, campo, valor, comentario); setAbierto(false); setValor(""); setComentario(""); onHecho(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <form className="pt-cambio" onSubmit={enviar} noValidate>
    <Aviso>{error}</Aviso>
    <div className="field"><label htmlFor={"nuevo-" + campo}>{campo === "cif" ? "CIF nuevo" : "Razón social nueva"}</label>
      <input id={"nuevo-" + campo} value={valor} onChange={(e) => setValor(e.target.value)} maxLength={campo === "cif" ? 20 : 200} autoComplete="off" /></div>
    <div className="field"><label htmlFor={"com-" + campo}>Comentario (opcional)</label>
      <textarea id={"com-" + campo} value={comentario} onChange={(e) => setComentario(e.target.value)} maxLength={500} rows={2} /></div>
    <div className="pt-botones">
      <button className="btn btn--primary btn--sm" type="submit" disabled={busy}>{busy ? "Enviando…" : "Enviar solicitud"}</button>
      <button className="btn btn--ghost btn--sm" type="button" onClick={() => { setAbierto(false); setError(null); }} disabled={busy}>Cancelar</button>
    </div>
    <p className="pt-nota">Guimaes revisará el cambio y lo aplicará.</p>
  </form>;
}

// Razón social o CIF: solo lectura, con su solicitud de cambio (la más
// reciente: pendiente, o resuelta en los últimos 30 días).
function Fijo({ empresa, campo, valor, solicitud: s, onSolicitado }) {
  return <div className="pt-fijo">
    <div><span className="pt-fijo__k">{CAMPO_NOMBRE[campo]}</span><span className="pt-fijo__v">{valor || "—"}</span></div>
    {s && s.estado === "pendiente"
      ? <p className="pt-nota">Cambio a <b>{s.valor_solicitado}</b> {ESTADO_SOLICITUD.pendiente}.</p>
      : <>{s && <p className="pt-nota">Tu solicitud de cambio a <b>{s.valor_solicitado}</b> fue {ESTADO_SOLICITUD[s.estado]}.</p>}
          <SolicitarCambio empresa={empresa} campo={campo} onHecho={onSolicitado} /></>}
  </div>;
}

function EditarEmpresa({ empresa, datos, ir, onGuardado, onSolicitado }) {
  const [f, setF] = useState({ direccion: empresa.direccion || "", ciudad: empresa.ciudad || "", provincia: empresa.provincia || "" });
  const [error, setError] = useState(null); const [ok, setOk] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setOk(null); };
  const guardar = async (e) => {
    e.preventDefault(); setError(null); setOk(null); setBusy(true);
    try {
      const r = await api.actualizarEmpresa(empresa.empresa_id, f);
      setOk(r.cambios > 0 ? "Datos guardados." : "No había ningún cambio que guardar.");
      if (r.cambios > 0) onGuardado();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const solicitud = (campo) => datos.solicitudes.find((x) => x.campo === campo);
  return <>
    <Ruta tramos={[{ txt: "Inicio", ir: () => ir({ tipo: "inicio" }) }, { txt: "Datos de la empresa" }]} />
    <h2 className="pt-h2">Datos de la empresa</h2>
    <section className="pt-card" aria-labelledby="t-identificacion">
      <h3 id="t-identificacion" className="pt-card__titulo">Identificación</h3>
      <p className="pt-nota">La razón social y el CIF los cambia Guimaes: solicítanos el cambio y lo revisaremos.</p>
      <Fijo empresa={empresa} campo="razon_social" valor={empresa.razon_social} solicitud={solicitud("razon_social")} onSolicitado={onSolicitado} />
      <Fijo empresa={empresa} campo="cif" valor={empresa.cif} solicitud={solicitud("cif")} onSolicitado={onSolicitado} />
    </section>
    <form className="pt-card" onSubmit={guardar} noValidate aria-labelledby="t-domicilio">
      <h3 id="t-domicilio" className="pt-card__titulo">Domicilio</h3>
      <Aviso>{error}</Aviso><Aviso tipo="ok">{ok}</Aviso>
      <Campo id="direccion" label="Dirección" value={f.direccion} onChange={set("direccion")} maxLength={200} autoComplete="street-address" />
      <div className="form-row two">
        <Campo id="ciudad" label="Ciudad" value={f.ciudad} onChange={set("ciudad")} maxLength={100} autoComplete="address-level2" />
        <Campo id="provincia" label="Provincia" value={f.provincia} onChange={set("provincia")} maxLength={100} autoComplete="address-level1" />
      </div>
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar cambios"}</button>
    </form>
  </>;
}

// ----- solicitar un servicio -----
function SolicitarServicio({ empresa, ir, onSolicitado }) {
  const [catalogo, setCatalogo] = useState(null);
  const [servicio, setServicio] = useState(""); const [mensaje, setMensaje] = useState("");
  const [error, setError] = useState(null); const [hecho, setHecho] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.servicios().then(setCatalogo).catch((e) => setError(e.message)); }, []);
  const enviar = async (e) => {
    e.preventDefault(); setError(null);
    if (!servicio) return setError("Elige un servicio.");
    setBusy(true);
    try { const r = await api.solicitarServicio(empresa.empresa_id, servicio, mensaje); setHecho(r.servicio); onSolicitado(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <>
    <Ruta tramos={[{ txt: "Inicio", ir: () => ir({ tipo: "inicio" }) }, { txt: "Solicitar un servicio" }]} />
    <h2 className="pt-h2">Solicitar un servicio</h2>
    {hecho ? <section className="pt-card" role="status">
      <p><b>Hemos recibido tu solicitud de {hecho}.</b> Te contactaremos para preparar la propuesta. La verás en tus servicios como «Solicitado».</p>
      <button className="btn btn--primary btn--sm" onClick={() => ir({ tipo: "inicio" })}>Volver al inicio</button>
    </section>
    : <form className="pt-card" onSubmit={enviar} noValidate>
      <Aviso>{error}</Aviso>
      <div className="field"><label htmlFor="servicio">Servicio</label>
        <select id="servicio" value={servicio} onChange={(e) => setServicio(e.target.value)} disabled={!catalogo}>
          <option value="">{catalogo ? "Elige un servicio…" : "Cargando…"}</option>
          {(catalogo || []).map((s) => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
        </select></div>
      <div className="field"><label htmlFor="mensaje">Cuéntanos qué necesitas (opcional)</label>
        <textarea id="mensaje" value={mensaje} onChange={(e) => setMensaje(e.target.value)} maxLength={1000} rows={5} aria-describedby="mensaje-n" />
        <span id="mensaje-n" className="pt-nota">{mensaje.length}/1000</span></div>
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "Enviando…" : "Enviar solicitud"}</button>
    </form>}
  </>;
}

function AppCliente({ estado }) {
  const [empresas, setEmpresas] = useState(null);
  const [empresaId, setEmpresaId] = useState(null);
  const [datos, setDatos] = useState(null); // {id, deals, carpetas, docs, solicitudes}
  const [error, setError] = useState(null);
  const [vista, setVista] = useState({ tipo: "inicio" });

  // Atrás/adelante del navegador (importante en móvil): cada vista es una
  // entrada del historial.
  const ir = (v) => { setVista(v); window.history.pushState({ vista: v }, ""); window.scrollTo(0, 0); };
  useEffect(() => {
    window.history.replaceState({ vista: { tipo: "inicio" } }, "");
    const pop = (e) => setVista((e.state && e.state.vista) || { tipo: "inicio" });
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  const cargarEmpresas = () => api.empresas().then((lista) => {
    setEmpresas(lista);
    setEmpresaId((actual) => {
      if (actual && lista.some((e) => e.empresa_id === actual)) return actual;
      let guardada = null; try { guardada = localStorage.getItem(CLAVE_EMPRESA); } catch { /* sin almacenamiento */ }
      const inicial = lista.find((e) => e.empresa_id === guardada) || lista.find((e) => e.principal) || lista[0];
      return inicial ? inicial.empresa_id : null;
    });
  }).catch((e) => setError(e.message));
  useEffect(() => { cargarEmpresas(); }, []);
  const cargar = async (id) => {
    setError(null);
    try {
      const [deals, carpetas, docs, solicitudes] = await Promise.all([api.deals(id), api.carpetas(id), api.documentos(id), api.solicitudes(id)]);
      setDatos({ id, deals, carpetas, docs, solicitudes });
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { if (empresaId) { setDatos(null); cargar(empresaId); } }, [empresaId]);
  const elegirEmpresa = (id) => { setEmpresaId(id); ir({ tipo: "inicio" }); try { localStorage.setItem(CLAVE_EMPRESA, id); } catch { /* sin almacenamiento */ } };
  const recargar = () => cargar(empresaId);

  const empresa = empresas && empresas.find((e) => e.empresa_id === empresaId);
  const listo = empresa && datos && datos.id === empresaId;
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
      {empresa && !listo && !error && <p className="pt-vacio">Cargando…</p>}
      {listo && (
        vista.tipo === "carpeta" ? <Carpeta empresa={empresa} datos={datos} id={vista.id} ir={ir} onRecargar={recargar} />
        : vista.tipo === "empresa" ? <EditarEmpresa key={empresa.empresa_id} empresa={empresa} datos={datos} ir={ir}
            onGuardado={cargarEmpresas} onSolicitado={recargar} />
        : vista.tipo === "solicitar" ? <SolicitarServicio empresa={empresa} ir={ir} onSolicitado={recargar} />
        : <Inicio empresa={empresa} datos={datos} ir={ir} onRecargar={recargar} />
      )}
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
