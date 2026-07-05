// Minimal service worker for the Control Panel PWA — caches ONLY the static app shell (this
// file list), never anything under /api/. That's a hard requirement, not an optimization detail:
// this app controls a live bus in real time (trip state, stop position, connect status), so it
// must never risk serving a cached, stale API response. All it buys is an instant app-shell
// load (useful right after a brief WiFi drop reconnecting to the Hub) — every actual API call
// still always goes straight to the network, exactly as if there were no service worker at all.

// The version placeholder below is substituted with the Hub's own package.json version at
// request time (see server.js's dedicated /panel/sw.js route, which serves this file
// dynamically rather than as a static asset) — this file's bytes changing on every real release
// is exactly what makes a driver's already-installed PWA notice there's an update and refresh
// its cached shell at all. Browsers only re-run a service worker's install/cache-refresh cycle
// when its own script bytes change; a hardcoded cache name here would leave every future
// release invisible to a phone that already has this PWA installed.
const CACHE_NAME = 'adkerala-panel-shell-__CACHE_VERSION__';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg'];

// Resolved against this SW's own scope (e.g. http://host/panel/) into exact absolute pathnames
// up front, so the fetch handler below can do a precise equality check — a substring/endsWith
// match risks accidentally matching API routes too (e.g. an empty-string edge case matching
// everything), which would be a real bug given the "never cache /api/" requirement above.
const SHELL_PATHS = SHELL_FILES.map((f) => new URL(f, self.registration.scope).pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isShellFile = url.origin === location.origin && SHELL_PATHS.includes(url.pathname);
  if (!isShellFile) return; // let the browser handle everything else normally — API calls, audio, etc.

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
