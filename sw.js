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
const VERSION = "v7";

const SHELL_CACHE = "guimaes-crm-shell-" + VERSION;
const FONT_CACHE = "guimaes-crm-fonts"; // sin versión: las fuentes de Google no cambian con los despliegues del CRM

// vercel.json tiene cleanUrls:true: "/crm.html" SIEMPRE redirige (308) a
// "/crm" — por eso NO va en esta lista. El documento real que carga el
// navegador vive en "/crm"; cachear "/crm.html" guardaba una respuesta de
// tipo redirect, y Safari rechaza de plano que un service worker responda a
// una navegación con una respuesta redirigida ("Response served by service
// worker has redirections") — la página entera fallaba al abrir la PWA.
const SHELL_URLS = [
  "/crm",
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

// Un service worker no puede responder a una navegación con una respuesta
// redirigida (ver nota de "/crm.html" arriba) — y da igual que la redirección
// venga de una entrada en caché o de un fetch a red en caliente, Safari la
// rechaza en los dos casos. Esta función reconstruye una Response "limpia" a
// partir del cuerpo, sin el flag redirected, ANTES de guardar nada en caché o
// de pasarla a respondWith — así ninguna redirección (de Vercel o de
// cualquier otro origen) puede volver a colarse, aunque en el futuro se
// añada por error una URL a SHELL_URLS que redirija.
async function stripRedirect(res) {
  if (!res || !res.redirected) return res;
  const body = await res.clone().blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // No se usa cache.add() (no deja interceptar la respuesta antes de
      // guardarla): fetch + stripRedirect + put a mano. catch() por URL por
      // separado — un icono que falte no debe impedir que el resto del
      // shell quede cacheado.
      Promise.all(
        SHELL_URLS.map((url) =>
          fetch(url)
            .then(stripRedirect)
            .then((res) => cache.put(url, res))
            .catch(() => {})
        )
      )
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
            fetch(req)
              .then(stripRedirect)
              .then((res) => {
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
  // la siguiente carga. ignoreSearch: crm.html lleva estado en la query
  // string (?view=...&id=...), y Cache.match por defecto compara la URL
  // completa — sin esto nunca encontraría la entrada cacheada de "/crm" a
  // secas. stripRedirect se aplica tanto a lo que sale de caché (por si
  // quedó algo redirigido de una versión anterior) como a lo que llega de red.
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cachedRaw = await cache.match(req, { ignoreSearch: true });
      const cached = cachedRaw ? await stripRedirect(cachedRaw) : undefined;
      const network = fetch(req)
        .then(stripRedirect)
        .then((res) => {
          cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
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
