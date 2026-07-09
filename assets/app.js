/* ============================================================
   GUIMAES — Interacciones compartidas
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Idioma ES / EN ----------
     El idioma lo fija la URL: las páginas /en/ declaran <html lang="en">.
     El botón de idioma NO alterna en la misma página, sino que navega a la
     versión equivalente (atributo data-lang-alt en cada botón). */
  function applyLang(lang) {
    document.documentElement.setAttribute("lang", lang);
    // Placeholders traducibles
    document.querySelectorAll("[data-ph-es]").forEach(function (el) {
      el.setAttribute("placeholder", el.getAttribute(lang === "en" ? "data-ph-en" : "data-ph-es") || "");
    });
    // Opciones de <select>
    document.querySelectorAll("[data-opt-es]").forEach(function (el) {
      el.textContent = el.getAttribute(lang === "en" ? "data-opt-en" : "data-opt-es") || el.textContent;
    });
  }
  function initLang() {
    var pageLang = document.documentElement.getAttribute("lang") || "es";
    applyLang(pageLang);
    // El botón muestra el idioma AL QUE cambiarás
    var target = pageLang === "es" ? "EN" : "ES";
    document.querySelectorAll("[data-lang-toggle]").forEach(function (b) {
      b.querySelectorAll("[data-lang-current]").forEach(function (el) { el.textContent = target; });
      var alt = b.getAttribute("data-lang-alt");
      b.addEventListener("click", function () {
        if (alt) { window.location.href = alt + window.location.hash; }
        else { applyLang(document.documentElement.getAttribute("lang") === "es" ? "en" : "es"); }
      });
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

  /* ---------- Animaciones de entrada ---------- */
  function initReveal() {
    var els = document.querySelectorAll("[data-reveal]");
    if (!("IntersectionObserver" in window) || !els.length) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    els.forEach(function (el) { io.observe(el); });
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
    if (window.supabase) _sbClient = window.supabase.createClient(SB_URL, SB_KEY);
    return _sbClient;
  }

  function initForm() {
    var form = document.querySelector("#contact-form");
    if (!form) return;
    var isEN = function () { return document.documentElement.lang === "en"; };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var ok = form.querySelector(".form-ok");
      var fields = form.querySelector(".form-fields");
      var oldErr = form.querySelector(".form-err");
      if (oldErr) oldErr.parentNode.removeChild(oldErr);

      var val = function (id) { var el = form.querySelector("#" + id); return el ? el.value.trim() : ""; };
      var svcEl = form.querySelector("#servicio");
      var svcLabel = svcEl && svcEl.selectedIndex >= 0 ? svcEl.options[svcEl.selectedIndex].text.trim() : "";
      if (svcEl && !svcEl.value) svcLabel = ""; // opción vacía = sin servicio elegido

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
        })
        .catch(function (err) {
          if (window.console) console.error("Lead insert error:", err);
          showError();
        });
    });
  }

  /* ---------- Botones flotantes: WhatsApp + teléfono ---------- */
  var WA_NUMBER = "34637420068";      // WhatsApp Business (sin +)
  var TEL_NUMBER = "+34637420068";    // Teléfono clickable
  function initFloats() {
    if (document.querySelector(".floats")) return;
    var waMsg = encodeURIComponent("Hola, me gustaría hablar con un experto de GUIMAES.");
    var wrap = document.createElement("div");
    wrap.className = "floats";
    wrap.innerHTML =
      '<a class="fab-wa" href="https://wa.me/' + WA_NUMBER + '?text=' + waMsg + '" target="_blank" rel="noopener" aria-label="WhatsApp">' +
        '<span class="tip"><span data-lang-es>Escríbenos por WhatsApp</span><span data-lang-en>Message us on WhatsApp</span></span>' +
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
  var COOKIE_KEY = "guimaes_cookie_consent";
  function getConsent() {
    try { return JSON.parse(localStorage.getItem(COOKIE_KEY)); } catch (e) { return null; }
  }
  function setConsent(analytics) {
    var consent = { analytics: !!analytics, ts: Date.now() };
    try { localStorage.setItem(COOKIE_KEY, JSON.stringify(consent)); } catch (e) {}
    window.guimaesConsent = consent;
    document.dispatchEvent(new CustomEvent("guimaes:consent", { detail: consent }));
  }
  window.hasAnalyticsConsent = function () {
    var c = getConsent();
    return !!(c && c.analytics);
  };
  function initCookieBanner() {
    var existing = getConsent();
    window.guimaesConsent = existing || null;
    if (existing) return; // ya ha decidido

    var wrap = document.createElement("div");
    wrap.className = "cookie-banner";
    wrap.innerHTML =
      '<div class="cookie-banner__inner">' +
        '<div class="cookie-banner__txt">' +
          '<strong><span data-lang-es>Usamos cookies</span><span data-lang-en>We use cookies</span></strong>' +
          '<span><span data-lang-es> — las técnicas son necesarias para que la web funcione; las analíticas solo se activan si las aceptas. Más información en nuestra </span><span data-lang-en> — technical cookies are required for the site to work; analytics cookies only activate if you accept them. More information in our </span><a href="' + (document.documentElement.lang === "en" ? "../politica-cookies.html" : "politica-cookies.html") + '"><span data-lang-es>Política de Cookies</span><span data-lang-en>Cookie Policy</span></a>.</span>' +
        '</div>' +
        '<div class="cookie-banner__actions">' +
          '<button type="button" class="btn btn--ghost btn--sm" data-cookie-configure><span data-lang-es>Configurar</span><span data-lang-en>Configure</span></button>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-cookie-reject><span data-lang-es>Rechazar</span><span data-lang-en>Reject</span></button>' +
          '<button type="button" class="btn btn--primary btn--sm" data-cookie-accept><span data-lang-es>Aceptar todas</span><span data-lang-en>Accept all</span></button>' +
        '</div>' +
        '<div class="cookie-banner__prefs" hidden>' +
          '<label class="cookie-toggle"><input type="checkbox" checked disabled /><span><b><span data-lang-es>Técnicas</span><span data-lang-en>Technical</span></b><span data-lang-es> — siempre activas, imprescindibles para el funcionamiento.</span><span data-lang-en> — always on, required for the site to work.</span></span></label>' +
          '<label class="cookie-toggle"><input type="checkbox" data-cookie-analytics /><span><b><span data-lang-es>Analíticas</span><span data-lang-en>Analytics</span></b><span data-lang-es> — nos ayudan a entender el uso del sitio.</span><span data-lang-en> — help us understand site usage.</span></span></label>' +
          '<button type="button" class="btn btn--primary btn--sm" data-cookie-save><span data-lang-es>Guardar preferencias</span><span data-lang-en>Save preferences</span></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    applyLang(document.documentElement.getAttribute("lang") || "es");

    var prefs = wrap.querySelector(".cookie-banner__prefs");
    var actions = wrap.querySelector(".cookie-banner__actions");
    wrap.querySelector("[data-cookie-accept]").addEventListener("click", function () {
      setConsent(true); wrap.remove();
    });
    wrap.querySelector("[data-cookie-reject]").addEventListener("click", function () {
      setConsent(false); wrap.remove();
    });
    wrap.querySelector("[data-cookie-configure]").addEventListener("click", function () {
      prefs.hidden = !prefs.hidden;
    });
    wrap.querySelector("[data-cookie-save]").addEventListener("click", function () {
      var analytics = wrap.querySelector("[data-cookie-analytics]").checked;
      setConsent(analytics); wrap.remove();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initLang();
    initMenu();
    initHeader();
    initReveal();
    initForm();
    initYear();
    initFloats();
    initCookieBanner();
  });
})();
