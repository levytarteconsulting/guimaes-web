// Service worker del CRM de Guimaes (no toca la web pública — se registra con
// scope "/crm", ver crm.html).
//
// crm/dist/main.js no lleva hash en el nombre (no hay build en el servidor),
// así que la única forma de que un despliegue nuevo no se quede cacheado para
// siempre es que el propio script de este service worker cambie de bytes.
// *** SUBE ESTE NÚMERO CADA VEZ QUE DESPLIEGUES UN CAMBIO EN crm/dist/main.js
// O crm/styles.css *** — eso basta para que el navegador detecte un SW nuevo,
// lo instale, descargue el shell entero de cero y active el reemplazo sin
// esperar a que se cierren las pestañas abiertas.
const VERSION = "v5";

const SHELL_CACHE = "guimaes-crm-shell-" + VERSION;
const FONT_CACHE = "guimaes-crm-fonts"; // sin versión: las fuentes de Google no cambian con los despliegues del CRM

// vercel.json tiene cleanUrls:true: /crm.html SIEMPRE redirige (308) a /crm,
// así que el documento que de verdad carga el navegador vive en "/crm", no en
// "/crm.html" — sin esta entrada, isShell() nunca hacía match para el propio
// HTML y el cacheo de shell para la página en sí no funcionaba. Se mantiene
// también "/crm.html" por si algo (un enlace viejo, un push) abre esa URL
// directamente estando offline, antes de que Vercel pueda redirigir.
const SHELL_URLS = [
  "/crm",
  "/crm.html",
  "/crm/styles.css",
  "/crm/dist/main.js",
  "/crm/manifest.json",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
  "/assets/icon-maskable-192.png",
  "/assets/icon-maskable-512.png",
  "/assets/apple-touch-icon.png",
  "/assets/favicon-32.png",
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll aborta todo si UNA sola URL falla; con cache.add() por
      // separado, un icono que falte (ver el aviso en el diff) no impide que
      // el resto del shell quede cacheado.
      Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // nunca tocar escrituras (Supabase, Auth, etc.)

  const url = new URL(req.url);
  const isFont = FONT_HOSTS.includes(url.hostname);
  const isShell = url.origin === self.location.origin && SHELL_URLS.includes(url.pathname);

  // Todo lo demás (Supabase REST/Auth, o cualquier otra cosa) ni se
  // intercepta: sin respondWith, la petición sigue a red exactamente igual
  // que si no hubiera service worker. Realtime usa WebSocket y ni siquiera
  // pasa por aquí.
  if (!isFont && !isShell) return;

  if (isFont) {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) =>
        cache.match(req).then(
          (cached) =>
            cached ||
            fetch(req).then((res) => {
              cache.put(req, res.clone());
              return res;
            })
        )
      )
    );
    return;
  }

  // Shell: stale-while-revalidate — sirve de caché al instante si existe (evita
  // la pantalla en blanco offline) y refresca la caché en segundo plano para
  // la siguiente carga. ignoreSearch: ahora que crm.html lleva estado en la
  // query string (?view=...&id=...), Cache.match por defecto compara la URL
  // completa y nunca encontraría la entrada cacheada de "/crm.html" a secas —
  // hay que decirle explícitamente que ignore la query string al buscar.
  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});

// ---- Notificaciones push ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Guimaes CRM", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Guimaes CRM";
  const options = {
    body: data.body || "",
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    tag: data.tag || undefined,
    // La navegación del CRM es estado en memoria (sin URL) — hoy no podemos
    // abrir una vista concreta, solo guardamos el destino para cuando sí se
    // pueda (ver notificationclick más abajo).
    data: { url: data.url || "/crm.html" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/crm.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        // Cualquier pestaña ya abierta del CRM sirve — no exigimos que la URL
        // coincida exacta, porque hoy no hay URLs de vista distintas.
        // Cuando el CRM adopte rutas de verdad (o al menos un router interno
        // direccionable), este postMessage ya deja el enganche listo: basta
        // con que app.jsx escuche "message" y navegue con el nav() que ya
        // existe — hoy no hay listener, así que este mensaje no hace nada,
        // pero tampoco rompe nada.
        if (client.url.indexOf("/crm") !== -1 && "focus" in client) {
          client.postMessage({ type: "push-navigate", url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
