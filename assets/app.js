/* ============================================================
   GUIMAES — Interacciones compartidas
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Idioma ES / EN ----------
     El idioma lo fija la URL: las páginas /en/ declaran <html lang="en">.
     Cada HTML lleva SOLO el texto de su idioma (no hay data-lang-es/en): al
     editar un texto, cámbialo en x.html y en en/x.html. El botón de idioma
     navega a la versión equivalente (atributo data-lang-alt en cada botón;
     sin él, a la portada del otro idioma). Lo que genera este script elige
     su texto con L(es, en). */
  function isEN() { return document.documentElement.getAttribute("lang") === "en"; }
  function L(es, en) { return isEN() ? en : es; }
  function initLang() {
    // El botón muestra el idioma AL QUE cambiarás
    var target = isEN() ? "ES" : "EN";
    document.querySelectorAll("[data-lang-toggle]").forEach(function (b) {
      b.querySelectorAll("[data-lang-current]").forEach(function (el) { el.textContent = target; });
      var alt = b.getAttribute("data-lang-alt") || (isEN() ? "/" : "/en");
      b.addEventListener("click", function () { window.location.href = alt + window.location.hash; });
    });
  }

  /* ---------- Menú móvil ---------- */
  function initMenu() {
    var burger = document.querySelector(".burger");
    if (!burger) return;
    burger.addEventListener("click", function () {
      document.body.classList.toggle("menu-open");
    });
    document.querySelectorAll(".mobile-menu a").forEach(function (a) {
      a.addEventListener("click", function () { document.body.classList.remove("menu-open"); });
    });
  }

  /* ---------- Header al hacer scroll ---------- */
  function initHeader() {
    var h = document.querySelector(".site-header");
    if (!h) return;
    var onScroll = function () { h.classList.toggle("scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ---------- Animaciones de entrada ----------
     El contenido es visible por defecto en CSS (styles.css). Solo se oculta
     y anima si logramos montar el observer Y registrar todos los elementos
     sin errores: "js-reveal" se añade a <html> como último paso, dentro de
     un try/catch. Si falta soporte de IntersectionObserver, no hay
     elementos, o algo falla al construir/registrar el observer, la clase
     nunca se añade y el contenido se queda tal cual (visible, por CSS).
     threshold en 0.01 (en vez de 0.12) para que un scroll rápido en móvil
     no pueda saltarse la ventana de intersección de un elemento y dejarlo
     invisible para siempre. */
  function initReveal() {
    var els = document.querySelectorAll("[data-reveal]");
    if (!("IntersectionObserver" in window) || !els.length) { return; }
    try {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
        });
      }, { threshold: 0.01, rootMargin: "0px 0px -40px 0px" });
      els.forEach(function (el) { io.observe(el); });
      document.documentElement.classList.add("js-reveal");
    } catch (e) { /* algo falló: no ocultamos nada, el contenido se queda visible */ }
  }

  /* ---------- Formulario de contacto → Supabase (CRM) ----------
     Los envíos se guardan en la tabla "leads" de Supabase y aparecen
     automáticamente en el CRM (crm.html). La "anon key" es pública y
     segura de exponer: las políticas RLS solo permiten INSERTAR desde
     la web y LEER a los administradores autenticados del CRM.
     (Ver crm/SETUP-SUPABASE.md y crm/supabase-leads.sql) */
  var SB_URL = "https://zuktsotrcolqdowpbnrx.supabase.co";
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1a3Rzb3RyY29scWRvd3BibnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDY5MjksImV4cCI6MjA5ODg4MjkyOX0.BmOBBZbnTWvuUgy74gyKKHz5mPnyOI1d0gzf_UjQcwQ";
  var _sbClient = null, _sbLoading = null;
  function loadSupabase() {
    if (window.supabase) return Promise.resolve();
    if (_sbLoading) return _sbLoading;
    _sbLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("No se pudo cargar Supabase")); };
      document.head.appendChild(s);
    });
    return _sbLoading;
  }
  function sbClient() {
    if (_sbClient) return _sbClient;
    // Sin sesión: el formulario solo inserta en leads como anon. Comparte
    // origen con el CRM (crm/auth.js usa la clave de sesión por defecto); con
    // persistencia, este cliente leería y refrescaría la sesión de un admin
    // que tenga el CRM abierto en el mismo navegador.
    if (window.supabase) _sbClient = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return _sbClient;
  }

  // Una página puede tener varios formularios de lead (p. ej. el del hero y el
  // del final en las páginas de servicio): todos comparten este envío. Cada
  // uno dice dónde está con data-ubicacion (hero | final | contacto), que va
  // a la capa de datos junto con el servicio.
  function initForm() {
    var forms = [];
    document.querySelectorAll("#contact-form, form[data-lead-form]").forEach(function (f) {
      if (forms.indexOf(f) < 0) forms.push(f);
    });
    forms.forEach(bindLeadForm);
  }

  // Formularios con data-campaign (páginas locales /gestoria-*, por si van en
  // Google Ads): guardan los UTM y el gclid de la URL de llegada igual que
  // assets/landing-pozuelo.js (misma clave de sessionStorage, mismo tope de
  // 500 caracteres de las columnas de crm/supabase-leads-utm.sql).
  var CAMPAIGN_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"];
  var CAMPAIGN_KEY = "guimaes_landing_campaign";
  function readCampaign() {
    var fromUrl = {}, any = false;
    try {
      var q = new URLSearchParams(window.location.search);
      CAMPAIGN_PARAMS.forEach(function (k) {
        var v = (q.get(k) || "").trim();
        if (v) { fromUrl[k] = v.slice(0, 500); any = true; }
      });
    } catch (e) {}
    if (any) {
      try { sessionStorage.setItem(CAMPAIGN_KEY, JSON.stringify(fromUrl)); } catch (e) {}
      return fromUrl;
    }
    try { return JSON.parse(sessionStorage.getItem(CAMPAIGN_KEY)) || {}; } catch (e) { return {}; }
  }

  function bindLeadForm(form) {
    var campaign = form.hasAttribute("data-campaign") ? readCampaign() : {};
    var isEN = function () { return document.documentElement.lang === "en"; };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var ok = form.querySelector(".form-ok");
      var fields = form.querySelector(".form-fields");
      var oldErr = form.querySelector(".form-err");
      if (oldErr) oldErr.parentNode.removeChild(oldErr);

      // Campos por name, no por id: con dos formularios en la página los ids
      // del segundo llevan prefijo (h-nombre…) para no repetirse.
      var field = function (name) { return form.querySelector('[name="' + name + '"]'); };
      var val = function (name) { var el = field(name); return el ? el.value.trim() : ""; };
      var svcEl = form.querySelector('select[name="servicio"]');
      // Siempre el nombre del catálogo del CRM (data-opt-es), también en la web en inglés.
      var svcOpt = svcEl && svcEl.selectedIndex >= 0 ? svcEl.options[svcEl.selectedIndex] : null;
      var svcLabel = svcOpt ? (svcOpt.getAttribute("data-opt-es") || svcOpt.text).trim() : "";
      if (svcEl && !svcEl.value) svcLabel = ""; // opción vacía = sin servicio elegido
      // Páginas de servicio: no hay <select>, el servicio va en un campo oculto
      // con el nombre exacto del catálogo del CRM (crm/data.js, SERVICES).
      var svcHidden = form.querySelector('input[type="hidden"][name="servicio"]');
      if (!svcEl && svcHidden) svcLabel = svcHidden.value.trim();

      var payload = {
        nombre: val("nombre"),
        empresa: val("empresa"),
        email: val("email"),
        telefono: val("telefono"),
        servicio: svcLabel,
        mensaje: val("mensaje"),
        lang: isEN() ? "en" : "es",
        source: "Formulario web",
        page: location.pathname
      };
      CAMPAIGN_PARAMS.forEach(function (k) { if (campaign[k]) payload[k] = campaign[k]; });

      var showSuccess = function () {
        if (fields) fields.style.display = "none";
        if (ok) ok.classList.add("show");
      };
      var showFieldError = function (msg) {
        if (btn) btn.disabled = false;
        var p = document.createElement("p");
        p.className = "form-err";
        p.style.cssText = "margin-top:14px;color:#B4232E;font-weight:600;font-size:14px";
        p.textContent = msg;
        if (fields) fields.appendChild(p);
      };
      var showError = function () {
        showFieldError(isEN()
          ? "We couldn't send your message. Please try again or email us at info@guimaes.es."
          : "No hemos podido enviar tu mensaje. Inténtalo de nuevo o escríbenos a info@guimaes.es.");
      };

      // RGPD: sin la casilla de consentimiento marcada, no se envía nada a Supabase.
      // El atributo required no basta porque el <form> lleva novalidate — esta
      // comprobación es la única barrera real antes del insert.
      // Sin forma de responder no sirve de nada el lead (igual que en la landing).
      if (!payload.nombre || (!payload.email && !payload.telefono)) {
        showFieldError(isEN()
          ? "Please give us your name and an email or phone number so we can reply."
          : "Indícanos tu nombre y un email o teléfono para poder responderte.");
        var first = field(payload.nombre ? (field("telefono") ? "telefono" : "email") : "nombre");
        if (first) first.focus();
        return;
      }

      var consentEl = field("consent");
      if (consentEl && !consentEl.checked) {
        showFieldError(isEN()
          ? "Please accept the Privacy Policy before sending."
          : "Por favor, acepta la Política de Privacidad antes de enviar.");
        consentEl.focus();
        return;
      }

      // El servicio de interés es obligatorio: sin él no sabemos qué deal crear en el CRM.
      if (!payload.servicio) {
        showFieldError(isEN()
          ? "Please select a service before sending."
          : "Por favor, selecciona un servicio antes de enviar.");
        if (svcEl) svcEl.focus();
        return;
      }

      // Honeypot anti-spam: campo invisible para humanos que solo un bot rellenaría.
      // Si viene con contenido, fingimos éxito sin guardar nada en Supabase ni
      // incluirlo en el payload que se inserta en "leads".
      if (val("company_url")) {
        showSuccess();
        return;
      }

      if (btn) btn.disabled = true;
      loadSupabase()
        .then(function () {
          var sb = sbClient();
          if (!sb) throw new Error("Supabase no disponible");
          return sb.from("leads").insert([payload]);
        })
        .then(function (res) {
          if (res && res.error) throw res.error;
          showSuccess();
          window.dataLayer = window.dataLayer || [];
          window.dataLayer.push({
            event: 'form_submit_success',
            form_ubicacion: form.getAttribute("data-ubicacion") || "final",
            servicio: payload.servicio
          });
        })
        .catch(function (err) {
          if (window.console) console.error("Lead insert error:", err);
          showError();
        });
    });
  }

  /* ---------- Enlaces a un formulario de la misma página ----------
     (#formulario, #cuentanos…). Si el formulario ya está a la vista, el
     navegador no tiene adónde desplazarse y el clic parecía no hacer nada:
     además de bajar hasta él, se pone el cursor en su primer campo. */
  function initFormAnchors() {
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      var id = a.getAttribute("href").slice(1);
      var target = id && document.getElementById(id);
      if (!target || a.hasAttribute("data-lead-modal")) return;
      var form = target.tagName === "FORM" ? target : target.querySelector("form");
      if (!form) return;
      a.addEventListener("click", function () {
        var first = form.querySelector('input:not([type=hidden]):not([tabindex="-1"]), textarea');
        if (!first) return;
        setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); } }, 450);
      });
    });
  }

  /* ---------- Ventana con el formulario corto (portada) ----------
     Los enlaces con data-lead-modal (p. ej. «Habla con un experto» del hero)
     abren #lead-modal en vez de navegar; sin JS, o en una página sin la
     ventana, siguen su href (/contacto). El formulario de dentro es un
     data-lead-form normal: lo envía bindLeadForm, igual que los demás.
     Se cierra con la X, con Escape y pulsando fuera; el foco no sale de la
     ventana y vuelve al botón al cerrar. No se abre con el aviso de cookies
     pendiente de respuesta. */
  function initLeadModal() {
    var modal = document.getElementById("lead-modal");
    if (!modal) return;
    var box = modal.querySelector(".lead-modal__box");
    var root = document.documentElement;
    var opener = null;
    var focusables = function () {
      return Array.prototype.filter.call(
        box.querySelectorAll("a[href], button, input:not([type=hidden]):not([tabindex=\"-1\"]), textarea, select"),
        function (el) { return el.offsetParent !== null && !el.disabled; }
      );
    };
    function onKey(e) {
      if (e.key === "Escape" || e.key === "Esc") { e.preventDefault(); close(); return; }
      if (e.key !== "Tab") return;
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function open(trigger) {
      if (document.querySelector(".cookie-banner")) return false; // aviso de cookies pendiente
      opener = trigger || document.activeElement;
      modal.hidden = false;
      root.classList.add("lead-open");
      document.addEventListener("keydown", onKey);
      var first = box.querySelector("input[name=nombre]");
      try { (first || box).focus({ preventScroll: true }); } catch (e) { (first || box).focus(); }
      return true;
    }
    function close() {
      if (modal.hidden) return;
      modal.hidden = true;
      root.classList.remove("lead-open");
      document.removeEventListener("keydown", onKey);
      if (opener && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (e) { opener.focus(); } }
    }
    document.querySelectorAll("[data-lead-modal]").forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        open(a);
      });
    });
    modal.querySelectorAll("[data-lead-modal-close]").forEach(function (b) { b.addEventListener("click", close); });
    // Pulsar fuera de la ventana (en el fondo oscurecido) la cierra
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
  }

  /* ---------- Barra inferior de contacto (móvil, páginas de servicio) ----------
     Empieza oculta (clase is-hidden en el HTML) y se muestra cuando el
     formulario del hero (#cuentanos) no está en pantalla, para no duplicarlo.
     Sin IntersectionObserver o sin formulario, se muestra siempre. */
  function initCallbar() {
    var bar = document.querySelector("[data-callbar]");
    if (!bar) return;
    var target = document.querySelector(bar.getAttribute("data-callbar-target") || "#cuentanos");
    if (!target || !("IntersectionObserver" in window)) { bar.classList.remove("is-hidden"); return; }
    try {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { bar.classList.toggle("is-hidden", en.isIntersecting); });
      }).observe(target);
    } catch (e) { bar.classList.remove("is-hidden"); }
  }

  /* ---------- Botones flotantes: WhatsApp + teléfono ---------- */
  var WA_NUMBER = "34637420068";      // WhatsApp Business (sin +)
  var TEL_NUMBER = "+34637420068";    // Teléfono clickable
  function initFloats() {
    if (document.querySelector(".floats")) return;
    var waMsg = encodeURIComponent(L("Hola, me gustaría hablar con un experto de GUIMAES.", "Hi, I would like to talk to a GUIMAES expert."));
    var wrap = document.createElement("div");
    wrap.className = "floats";
    wrap.innerHTML =
      '<a class="fab-wa" href="https://wa.me/' + WA_NUMBER + '?text=' + waMsg + '" target="_blank" rel="noopener" aria-label="WhatsApp">' +
        '<span class="tip">' + L("Escríbenos por WhatsApp", "Message us on WhatsApp") + '</span>' +
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.87 1.22 3.07.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35Z"/><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.2 8.2 0 0 1-4.18-1.14l-.3-.18-3.11.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.39c0-4.54 3.7-8.24 8.24-8.24 2.2 0 4.27.86 5.82 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.23 8.23Z"/></svg>' +
      '</a>';
    document.body.appendChild(wrap);
  }

  /* ---------- Año en footer ---------- */
  function initYear() {
    document.querySelectorAll("[data-year]").forEach(function (el) {
      el.textContent = new Date().getFullYear();
    });
  }

  /* ---------- Banner de cookies (RGPD / LSSI-CE) ---------- */
  var COOKIE_KEY = "guimaes_cookie_consent_v2";
  function getConsent() {
    try { return JSON.parse(localStorage.getItem(COOKIE_KEY)); } catch (e) { return null; }
  }
  function setConsent(analytics, ads) {
    var consent = { analytics: !!analytics, ads: !!ads, ts: Date.now() };
    try { localStorage.setItem(COOKIE_KEY, JSON.stringify(consent)); } catch (e) {}
    window.guimaesConsent = consent;
    document.dispatchEvent(new CustomEvent("guimaes:consent", { detail: consent }));
  }
  window.hasAnalyticsConsent = function () {
    var c = getConsent();
    return !!(c && c.analytics);
  };
  window.hasAdsConsent = function () {
    var c = getConsent();
    return !!(c && c.ads);
  };

  /* ---------- Puente hacia Google Consent Mode v2 ---------- */
  document.addEventListener("guimaes:consent", function (e) {
    if (typeof gtag === "function") {
      gtag('consent', 'update', {
        analytics_storage: e.detail.analytics ? 'granted' : 'denied',
        ad_storage: e.detail.ads ? 'granted' : 'denied',
        ad_user_data: e.detail.ads ? 'granted' : 'denied',
        ad_personalization: e.detail.ads ? 'granted' : 'denied'
      });
    }
  });
  (function () {
    var existing = getConsent();
    if (existing && typeof gtag === "function") {
      gtag('consent', 'update', {
        analytics_storage: existing.analytics ? 'granted' : 'denied',
        ad_storage: existing.ads ? 'granted' : 'denied',
        ad_user_data: existing.ads ? 'granted' : 'denied',
        ad_personalization: existing.ads ? 'granted' : 'denied'
      });
    }
  })();

  function initCookieBanner() {
    var existing = getConsent();
    window.guimaesConsent = existing || null;
    if (existing) return; // ya ha decidido

    // Ventana centrada con fondo oscurecido. GTM depende de los atributos
    // data-cookie-accept / -reject / -configure / -save, de la clave
    // guimaes_cookie_consent_v2 y del gtag('consent', 'update') de arriba:
    // no cambiarlos. «Aceptar todas» y «Rechazar» llevan el mismo estilo.
    var wrap = document.createElement("div");
    wrap.className = "cookie-banner";
    wrap.innerHTML =
      '<div class="cookie-banner__inner" role="dialog" aria-modal="true" aria-labelledby="cookie-title" aria-describedby="cookie-desc" tabindex="-1">' +
        '<p class="cookie-banner__title" id="cookie-title">' + L("Usamos cookies", "We use cookies") + '</p>' +
        '<p class="cookie-banner__txt" id="cookie-desc">' + L("Las técnicas son necesarias para que la web funcione; las analíticas y las de publicidad solo se activan si las aceptas. Más información en nuestra ", "Technical cookies are required for the site to work; analytics and advertising cookies only activate if you accept them. More information in our ") + '<a href="' + L("/politica-cookies", "/en/politica-cookies") + '">' + L("Política de Cookies", "Cookie Policy") + '</a>.</p>' +
        '<div class="cookie-banner__prefs" id="cookie-prefs" hidden>' +
          '<label class="cookie-toggle"><input type="checkbox" checked disabled /><span><b>' + L("Técnicas", "Technical") + '</b>' + L("Siempre activas, imprescindibles para el funcionamiento.", "Always on, required for the site to work.") + '</span></label>' +
          '<label class="cookie-toggle"><input type="checkbox" data-cookie-analytics /><span><b>' + L("Analíticas", "Analytics") + '</b>' + L("Nos ayudan a entender el uso del sitio.", "Help us understand site usage.") + '</span></label>' +
          '<label class="cookie-toggle"><input type="checkbox" data-cookie-ads /><span><b>' + L("Publicidad", "Advertising") + '</b>' + L("Nos permiten medir la eficacia de nuestras campañas publicitarias.", "Let us measure the effectiveness of our ad campaigns.") + '</span></label>' +
          '<button type="button" class="btn btn--primary btn--sm cookie-banner__save" data-cookie-save>' + L("Guardar preferencias", "Save preferences") + '</button>' +
        '</div>' +
        '<div class="cookie-banner__actions">' +
          '<button type="button" class="btn btn--sm cookie-banner__choice" data-cookie-reject>' + L("Rechazar", "Reject") + '</button>' +
          '<button type="button" class="btn btn--sm cookie-banner__choice" data-cookie-accept>' + L("Aceptar todas", "Accept all") + '</button>' +
        '</div>' +
        '<button type="button" class="cookie-banner__link" data-cookie-configure aria-expanded="false" aria-controls="cookie-prefs">' + L("Configurar", "Configure") + '</button>' +
      '</div>';
    var root = document.documentElement;
    var lastFocus = document.activeElement;
    document.body.appendChild(wrap);
    root.classList.add("cookie-open"); // bloquea el scroll de fondo (extra.css)

    var dialog = wrap.querySelector(".cookie-banner__inner");
    var prefs = wrap.querySelector(".cookie-banner__prefs");
    var configure = wrap.querySelector("[data-cookie-configure]");
    var focusables = function () {
      return Array.prototype.filter.call(
        dialog.querySelectorAll("a[href], button, input:not([disabled])"),
        function (el) { return el.offsetParent !== null; }
      );
    };
    // Teclado: el foco empieza en la ventana y Tab no sale de ella.
    function onKey(e) {
      if (e.key !== "Tab") return;
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    wrap.addEventListener("keydown", onKey);
    try { dialog.focus({ preventScroll: true }); } catch (e) { dialog.focus(); }

    function close() {
      wrap.removeEventListener("keydown", onKey);
      wrap.remove();
      root.classList.remove("cookie-open");
      if (lastFocus && lastFocus.focus && document.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch (e) {} }
    }

    wrap.querySelector("[data-cookie-accept]").addEventListener("click", function () {
      setConsent(true, true); close();
    });
    wrap.querySelector("[data-cookie-reject]").addEventListener("click", function () {
      setConsent(false, false); close();
    });
    configure.addEventListener("click", function () {
      prefs.hidden = !prefs.hidden;
      configure.setAttribute("aria-expanded", String(!prefs.hidden));
      if (!prefs.hidden) { var a = prefs.querySelector("[data-cookie-analytics]"); if (a) a.focus(); }
    });
    wrap.querySelector("[data-cookie-save]").addEventListener("click", function () {
      var analytics = wrap.querySelector("[data-cookie-analytics]").checked;
      var ads = wrap.querySelector("[data-cookie-ads]").checked;
      setConsent(analytics, ads); close();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLang();
    initMenu();
    initHeader();
    initReveal();
    initForm();
    initCallbar();
    initYear();
    initFloats();
    initCookieBanner();
    initLeadModal();
    initFormAnchors();
  });
})();
