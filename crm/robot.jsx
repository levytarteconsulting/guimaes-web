import React from "react";
/* GUIMAES CRM — Guillermito, el robot del asistente (SVG + CSS, sin librerías).
   Dos versiones:
     · grande (≥ 48 px): cabeza, auriculares, cuerpo, manos flotantes y, al
       trabajar, teclado holográfico. Solo en la bienvenida.
     · pequeña (< 48 px, mínimo 28 px): cabeza, auriculares, visor con los
       ojos y antena. Cabecera del chat (dentro de un avatar) y línea de estado.
   Estados: reposo · saludo · trabajando · hecho · error.
   Las animaciones son solo transform y opacity (styles.css, prefijo .gm-).
   Con prefers-reduced-motion no se mueve ni sigue el cursor. */

const { useEffect, useRef, useId, useMemo } = React;
export const TAM_MINIMO = 28;
const ESTADOS = ["reposo", "saludo", "trabajando", "hecho", "error"];

const sinMovimiento = () => typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Defs({ id }) {
  return <defs>
    <radialGradient id={`gm-cab-${id}`} cx="35%" cy="28%" r="80%"><stop offset="0" stopColor="#ffffff" /><stop offset=".55" stopColor="#f1f4f9" /><stop offset="1" stopColor="#c9d3e2" /></radialGradient>
    <linearGradient id={`gm-vis-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#16304f" /><stop offset="1" stopColor="#040b17" /></linearGradient>
    <radialGradient id={`gm-cue-${id}`} cx="35%" cy="22%" r="85%"><stop offset="0" stopColor="#21466f" /><stop offset=".5" stopColor="#0b2238" /><stop offset="1" stopColor="#07142a" /></radialGradient>
    <linearGradient id={`gm-azu-${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7aa2ff" /><stop offset=".5" stopColor="#2f6bff" /><stop offset="1" stopColor="#1946c8" /></linearGradient>
    <linearGradient id={`gm-oro-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f4e2a8" /><stop offset=".5" stopColor="#d4af5a" /><stop offset="1" stopColor="#a5823a" /></linearGradient>
    <radialGradient id={`gm-ojo-${id}`} cx="50%" cy="40%" r="60%"><stop offset="0" stopColor="#e8f7ff" /><stop offset=".55" stopColor="#8fd8ff" /><stop offset="1" stopColor="#3fa9ff" /></radialGradient>
    <filter id={`gm-brillo-${id}`} x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
    <filter id={`gm-somb-${id}`} x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#07142a" floodOpacity=".22" /></filter>
  </defs>;
}

/* Ojos según el estado. cx: centros de los ojos; r: radios; grande: versión grande. */
function Ojos({ id, estado, cx, cy, rx, ry, ojosRef }) {
  const u = `url(#gm-ojo-${id})`;
  if (estado === "hecho") {   // ojos «contentos» (arcos)
    return <g className="gm-ojos">{cx.map((x, i) => <path key={i} d={`M${x - rx} ${cy + 3} Q${x} ${cy - ry} ${x + rx} ${cy + 3}`} stroke={u} strokeWidth={rx * 0.55} strokeLinecap="round" fill="none" />)}</g>;
  }
  if (estado === "error") {   // duda: un ojo más cerrado e inclinado
    return <g className="gm-ojos">
      <ellipse cx={cx[0]} cy={cy} rx={rx} ry={ry * 0.75} fill={u} />
      <ellipse cx={cx[1]} cy={cy + 1} rx={rx} ry={ry * 0.45} fill={u} transform={`rotate(-14 ${cx[1]} ${cy + 1})`} />
    </g>;
  }
  return <g ref={ojosRef} className={"gm-ojos" + (estado === "trabajando" ? " gm-ojos--leer" : "")}>
    {cx.map((x, i) => <g key={i} className="gm-parpado"><ellipse cx={x} cy={cy} rx={rx} ry={ry} fill={u} /></g>)}
  </g>;
}

function Antena({ id, grande }) {
  return grande ? <>
    <path d="M100 30 Q104 18 112 14" stroke="#8a97ab" strokeWidth="3" strokeLinecap="round" fill="none" />
    <circle className="gm-antena-onda" cx="113" cy="13" r="6" fill="none" stroke="#2f6bff" strokeWidth="2" />
    <circle className="gm-antena-luz" cx="113" cy="13" r="5.5" fill={`url(#gm-azu-${id})`} />
  </> : <>
    <path d="M100 30 Q104 16 113 12" stroke="#7d8aa0" strokeWidth="5" strokeLinecap="round" fill="none" />
    <circle className="gm-antena-onda" cx="114" cy="11" r="8" fill="none" stroke="#2f6bff" strokeWidth="3" />
    <circle className="gm-antena-luz" cx="114" cy="11" r="8" fill={`url(#gm-azu-${id})`} />
  </>;
}

function Grande({ id, estado, ojosRef }) {
  const u = (n) => `url(#gm-${n}-${id})`;
  const trabajando = estado === "trabajando";
  const mano = (x, y, cls) => <g className={cls}><ellipse cx={x} cy={y} rx="10" ry="12" fill={u("cab")} /><rect x={x - 6} y={y - 8} width="12" height="3" rx="1.5" fill="#2f6bff" opacity=".7" /></g>;
  return <>
    <ellipse className="gm-sombra" cx="100" cy="234" rx="40" ry="6" fill="#07142a" />
    <g className="gm-flota">
      <g className="gm-cuerpo" filter={u("somb")}>
        <Antena id={id} grande />
        <path d="M70 134 Q100 122 130 134 Q144 168 122 186 Q100 196 78 186 Q56 168 70 134 Z" fill={u("cue")} />
        <path d="M68 150 Q100 160 132 150" stroke={u("oro")} strokeWidth="5" fill="none" strokeLinecap="round" />
        <rect x="90" y="160" width="20" height="14" rx="5" fill={u("azu")} /><rect x="93" y="163" width="6" height="3" rx="1.5" fill="#fff" opacity=".6" />
        {trabajando
          ? <>{mano(72, 186, "gm-mano gm-mano--i")}{mano(128, 186, "gm-mano gm-mano--d")}</>
          : <>{mano(44, 168, "gm-mano gm-mano--i")}{mano(156, 168, "gm-mano gm-mano--d gm-mano--saluda")}</>}
        <g className="gm-cabeza">
          <ellipse cx="100" cy="82" rx="60" ry="54" fill={u("cab")} />
          <ellipse cx="74" cy="48" rx="18" ry="8" fill="#fff" opacity=".85" transform="rotate(-20 74 48)" />
          <rect x="31" y="66" width="16" height="36" rx="8" fill={u("azu")} /><rect x="153" y="66" width="16" height="36" rx="8" fill={u("azu")} />
          <rect x="33" y="80" width="12" height="8" rx="4" fill={u("oro")} /><rect x="155" y="80" width="12" height="8" rx="4" fill={u("oro")} />
          <path d="M54 82 Q54 60 100 60 Q146 60 146 82 Q146 108 100 108 Q54 108 54 82 Z" fill={u("vis")} />
          <path d="M64 72 Q80 64 100 64" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".18" fill="none" />
          <g filter={u("brillo")}><Ojos id={id} estado={estado} cx={[82, 118]} cy={84} rx={9} ry={11} ojosRef={ojosRef} /></g>
          {estado === "error" && <text className="gm-duda" x="150" y="40" fontSize="30" fontWeight="700" fill={u("oro")} fontFamily="Georgia, serif">?</text>}
        </g>
      </g>
      {trabajando && <g className="gm-holo">
        <path d="M40 196 H160 L148 214 H52 Z" fill="#2f6bff" opacity=".22" stroke="#6f9bff" strokeWidth="1.5" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <rect key={i} className={i % 3 === 0 ? "gm-tecla-a" : i % 3 === 1 ? "gm-tecla-b" : ""} x={56 + i * 11} y="200" width="8" height="4" rx="1" fill="#9cc0ff" />)}
        {[0, 1, 2, 3, 4, 5].map((i) => <rect key={"b" + i} x={62 + i * 12} y="207" width="9" height="4" rx="1" fill="#9cc0ff" opacity=".7" />)}
      </g>}
      {estado === "hecho" && <g className="gm-chispa" fill={u("oro")}>
        <path d="M168 120 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 Z" /><path d="M30 124 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 Z" />
      </g>}
    </g>
  </>;
}

function Pequeno({ id, estado, ojosRef }) {
  const u = (n) => `url(#gm-${n}-${id})`;
  return <g className="gm-cabeza">
    <Antena id={id} />
    <rect x="28" y="62" width="20" height="42" rx="10" fill={u("azu")} /><rect x="152" y="62" width="20" height="42" rx="10" fill={u("azu")} />
    <rect x="31" y="78" width="14" height="10" rx="5" fill={u("oro")} /><rect x="155" y="78" width="14" height="10" rx="5" fill={u("oro")} />
    <ellipse cx="100" cy="82" rx="60" ry="54" fill={u("cab")} stroke="#c3cddc" strokeWidth="2" />
    <ellipse cx="72" cy="46" rx="16" ry="7" fill="#fff" opacity=".9" transform="rotate(-20 72 46)" />
    <path d="M50 84 Q50 58 100 58 Q150 58 150 84 Q150 112 100 112 Q50 112 50 84 Z" fill={u("vis")} />
    <Ojos id={id} estado={estado} cx={[80, 120]} cy={85} rx={12} ry={14} ojosRef={ojosRef} />
  </g>;
}

/**
 * <Guillermito px={40} estado="reposo" />
 * px: tamaño en píxeles (mínimo 28). Por debajo de 48 se usa la versión pequeña.
 */
export function Guillermito({ px = 40, estado = "reposo", className = "", titulo }) {
  const tam = Math.max(TAM_MINIMO, px);
  const grande = tam >= 48;
  const est = ESTADOS.includes(estado) ? estado : "reposo";
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const svgRef = useRef(null), ojosRef = useRef(null);
  // Cada robot parpadea a su ritmo (si no, todos a la vez).
  const desfase = useMemo(() => `-${(Math.random() * 5).toFixed(2)}s`, []);

  // Los ojos siguen el cursor: solo en reposo y sin «reducir movimiento». Sin re-render.
  useEffect(() => {
    if (est !== "reposo" || sinMovimiento()) return;
    let pend = 0, ultimo = null;
    const aplicar = () => {
      pend = 0;
      const s = svgRef.current, o = ojosRef.current;
      if (!s || !o || !ultimo) return;
      const r = s.getBoundingClientRect();
      const dx = Math.max(-1, Math.min(1, (ultimo.x - (r.left + r.width / 2)) / 320));
      const dy = Math.max(-1, Math.min(1, (ultimo.y - (r.top + r.height * 0.35)) / 320));
      o.style.transform = `translate(${(dx * 6).toFixed(2)}px, ${(dy * 4).toFixed(2)}px)`;
    };
    const mover = (e) => { ultimo = { x: e.clientX, y: e.clientY }; if (!pend) pend = requestAnimationFrame(aplicar); };
    window.addEventListener("pointermove", mover, { passive: true });
    return () => { window.removeEventListener("pointermove", mover); if (pend) cancelAnimationFrame(pend); if (ojosRef.current) ojosRef.current.style.transform = ""; };
  }, [est]);

  return <svg ref={svgRef} className={`gm gm--${est} ${grande ? "gm--grande" : "gm--peq"} ${className}`}
    viewBox={grande ? "0 0 200 245" : "22 -2 156 148"} width={tam} height={grande ? Math.round(tam * 245 / 200) : tam}
    role={titulo ? "img" : undefined} aria-label={titulo || undefined} aria-hidden={titulo ? undefined : true}
    style={{ "--gm-desfase": desfase }} focusable="false">
    <Defs id={id} />
    {grande ? <Grande id={id} estado={est} ojosRef={ojosRef} /> : <Pequeno id={id} estado={est} ojosRef={ojosRef} />}
  </svg>;
}

/** Avatar de la cabecera del chat: el robot pequeño dentro de un círculo azul marino (40 px). */
export function AvatarGuillermito({ estado = "reposo" }) {
  return <span className={"gm-avatar gm-avatar--" + estado} aria-hidden="true"><Guillermito px={32} estado={estado} /></span>;
}
