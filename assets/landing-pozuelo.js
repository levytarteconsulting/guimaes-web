/* ============================================================
   GUIMAES — Formulario de la landing de Google Ads (gestoria-pozuelo.html)
   ============================================================
   Mismo camino que el formulario de contacto (initForm en assets/app.js):
   cliente anon de Supabase sin sesión, insert en la tabla "leads" y, solo
   si el insert sale bien, dataLayer.push({ event: 'form_submit_success' }),
   que es el disparador de GTM del evento envio_formulario_contacto.
   Además guarda los UTM y el gclid de la URL (columnas de
   crm/supabase-leads-utm.sql).

   Va aparte para no tocar app.js, que comparten todas las páginas:
   SB_URL y SB_KEY son los mismos que allí; si cambian, cambiarlos en los
   dos sitios. El formulario se llama #landing-form (no #contact-form)
   para que initForm de app.js no se enganche también a él. */
(function () {
  "use strict";

  var SB_URL = "https://zuktsotrcolqdowpbnrx.supabase.co";
  var SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1a3Rzb3RyY29scWRvd3BibnJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMzMDY5MjksImV4cCI6MjA5ODg4MjkyOX0.BmOBBZbnTWvuUgy74gyKKHz5mPnyOI1d0gzf_UjQcwQ";
  var SOURCE = "Landing gestoría Pozuelo";
  var CAMPAIGN_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"];

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
    // Sin sesión, como en app.js: no debe leer la sesión del CRM.
    if (window.supabase) _sbClient = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return _sbClient;
  }

  // Parámetros de campaña de la URL de llegada. Se leen al cargar y se
  // guardan en sessionStorage: si la visita navega y vuelve a la landing sin
  // ellos, el lead sigue atribuido a la campaña. Tope de 500 caracteres,
  // el mismo que las restricciones de la tabla.
  var STORE_KEY = "guimaes_landing_campaign";
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
      try { sessionStorage.setItem(STORE_KEY, JSON.stringify(fromUrl)); } catch (e) {}
      return fromUrl;
    }
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  var campaign = readCampaign();

  function initForm() {
    var form = document.querySelector("#landing-form");
    if (!form) return;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      var ok = form.querySelector(".form-ok");
      var fields = form.querySelector(".form-fields");
      var oldErr = form.querySelector(".form-err");
      if (oldErr) oldErr.parentNode.removeChild(oldErr);

      var val = function (id) { var el = form.querySelector("#" + id); return el ? el.value.trim() : ""; };
      var svcEl = form.querySelector("#servicio");
      var svcLabel = svcEl && svcEl.value && svcEl.selectedIndex >= 0 ? svcEl.options[svcEl.selectedIndex].text.trim() : "";

      var payload = {
        nombre: val("nombre"),
        empresa: val("empresa"),
        email: val("email"),
        telefono: val("telefono"),
        servicio: svcLabel,
        mensaje: val("mensaje"),
        lang: "es",
        source: SOURCE,
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

      // Sin forma de responder no sirve de nada el lead.
      if (!payload.nombre || (!payload.email && !payload.telefono)) {
        showFieldError("Indícanos tu nombre y un email o teléfono para poder responderte.");
        return;
      }

      // RGPD: sin la casilla marcada no se envía nada (el <form> lleva novalidate).
      var consentEl = form.querySelector("#consent");
      if (consentEl && !consentEl.checked) {
        showFieldError("Por favor, acepta la Política de Privacidad antes de enviar.");
        consentEl.focus();
        return;
      }

      // Igual que en contacto: el CRM crea el deal a partir del servicio.
      if (!payload.servicio) {
        showFieldError("Por favor, selecciona en qué podemos ayudarte antes de enviar.");
        if (svcEl) svcEl.focus();
        return;
      }

      // Honeypot: un bot lo rellena; fingimos éxito sin guardar nada ni medir.
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
          window.dataLayer.push({ event: 'form_submit_success' });
        })
        .catch(function (err) {
          if (window.console) console.error("Lead insert error:", err);
          showFieldError("No hemos podido enviar tu mensaje. Inténtalo de nuevo, llámanos al +34 637 420 068 o escríbenos a info@guimaes.es.");
        });
    });
  }

  document.addEventListener("DOMContentLoaded", initForm);
})();
