// ── Versiones de la app y del SW (deben coincidir en cada release) ──
// Sistema de versiones reiniciado a v3 — el banner superior muestra esta versión
// y la app verifica automáticamente contra version.json si hay una versión mayor.
const APP_VERSION  = '230';
const CACHE = 'axontech-v230';
const STATIC = [
  './', './index.html', './admin.html', './app.css', './app.js',
  './app.min.js',   // v211: el JS minificado que cargan index/admin (app.js queda por compat)
  './manifest.json', './version.json',
  './fuentes/sora-var-latin.woff2', './fuentes/sora-var-latin-ext.woff2',

  './iconos/favicon-96.png', './iconos/icon-192.png', './iconos/icon-512.png',
  './iconos/icon-192-maskable.png', './iconos/icon-512-maskable.png', './iconos/icon-1024-maskable.png',
  './offline.html'
];
// tasa.json queda FUERA de esta lista a propósito: cambia varias veces al día y
// precargarlo aquí serviría siempre la copia de cuando se instaló la versión.
// La app lo pide con ?t=<hora>, que se salta la caché.

// ── Precarga perezosa de fotos ──
// Las fotos NO se bajan en install() (podrían ser 850KB). En su lugar,
// se cachean on-demand cuando el usuario las ve por primera vez.
// Como cada foto tiene un hash MD5 en el nombre (p-<id>-<hash>.webp),
// si el contenido cambia, el hash cambia, así que cache-first es seguro.
const PHOTO_PATH_PREFIX = '/photos/';

self.addEventListener('install', e => {
  // v34: Do NOT call skipWaiting() here automatically.
  // ANTES: skipWaiting() causaba que el nuevo SW se activara inmediatamente
  // incluso con cache incompleto, llevando a "se queda pegado".
  // Ahora: el nuevo SW espera hasta que el usuario pulse "Recargar ahora",
  // lo cual envía SKIP_WAITING vía applyUpdate().
  e.waitUntil(
    caches.open(CACHE).then(c => {
      // v34 FIX: Use Promise.all instead of Promise.allSettled.
      // ANTES: allSettled permitía instalar el SW con cache incompleto
      // si algún asset fallaba. Ahora, si un asset falla, la instalación
      // falla y el SW viejo sigue controlando → app estable.
      return Promise.all(STATIC.map(url => fetch(url).then(r => {
        if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
        return c.put(url, r);
      })));
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      // Borra TODAS las cachés anteriores (v89, v90, v91, v92, v93, etc.)
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => {
      // v34 FIX: Sequence properly: claim clients FIRST, then notify.
      // ANTES: claim() y matchAll() se ejecutaban en paralelo, causando
      // que algunos clientes recibieran SW_UPDATED antes de que el nuevo SW
      // los controlara, llevando a recargas en el SW viejo.
      return self.clients.claim();
    }).then(() => {
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    }).then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'SW_UPDATED', version: APP_VERSION });
      });
    })
  );
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin) || e.request.method !== 'GET') return;

  // For navigation requests: network-first with offline fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, resClone));
          }
          return res;
        })
        .catch(() => {
          return caches.match(e.request).then(cached => {
            return cached || caches.match('./offline.html');
          });
        })
    );
    return;
  }

  const url = new URL(e.request.url);

  // ── FOTOS en /photos/ — cache-first puro ──
  // Las fotos tienen hash MD5 en el nombre (p-<id>-<hash>.webp), así que
  // si cambian, la URL cambia. Esto significa que cualquier foto cacheada
  // es válida para siempre. Cache-first = cero latencia en conexiones lentas.
  if (url.pathname.startsWith(PHOTO_PATH_PREFIX)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;  // ¡Hit! Servir inmediatamente.
        // Miss: bajar y cachar para la próxima vez.
        return fetch(e.request).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const resClone = res.clone();
            caches.open(CACHE).then(k => k.put(e.request, resClone));
          }
          return res;
        }).catch(() => caches.match(e.request));
      })
    );
    return;
  }

  // ── version.json: NETWORK-FIRST ──
  // v218: es la SEÑAL de actualización — si se servía del caché (regla
  // genérica de .json, stale-while-revalidate), checkVersion leía la versión
  // vieja aunque el servidor ya tuviera una nueva: el banner tardaba en salir
  // o la app juraba estar al día. Este JSON siempre mira a la red primero;
  // solo cae al caché sin conexión. data.json sigue en stale-while-revalidate.
  if (/\/version\.json$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const resClone = res.clone();
          caches.open(CACHE).then(k => k.put(e.request, resClone));
        }
        return res;
      }).catch(() =>
        caches.match(e.request).then(c => c || Response.error())
      )
    );
    return;
  }

  // ── JSON de datos (data.json, version.json) ──
  // Stale-while-revalidate agresivo: servir cache local INMEDIATAMENTE (sin
  // esperar red), y refrescar en background. En 3G esto significa que la app
  // arranca con los datos de la última sesión sin esperar a bajar 1.2MB.
  // Si no hay cache local, cae a network-first.
  // (v218: version.json ya se despachó arriba — network-first.)
  if (/\.(json)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const resClone = res.clone();
            caches.open(CACHE).then(k => k.put(e.request, resClone));
          }
          return res;
        }).catch(() => cached);
        // Servir cache local inmediatamente si existe; si no, esperar red.
        return cached || fetchPromise;
      })
    );
    return;
  }

  // ── BUGFIX: NO usar ignoreSearch:true para app.js y app.css ──
  // Antes usábamos ignoreSearch:true que trataba app.js?v=89 y app.js?v=94
  // como la MISMA entrada de caché. Eso hacía que los usuarios con v89
  // cacheada siguieran viendo v89 aunque el HTML pidiera v94.
  // Ahora respetamos el query string para app.js/app.css/index.html/admin.html
  // (que cambian con cada release) y solo ignoramos el query en imágenes
  // (que no cambian entre versiones).
  const esEstatico = /\.(css|js|png|jpe?g|gif|webp|woff2?|ttf|svg|ico)$/.test(url.pathname);
  if (esEstatico) {
    // Archivos que cambian con cada release → respetar el query string
    const respetaQuery = /\.(css|js)$/.test(url.pathname) ||
                         /\/(index|admin|catalogo|offline)\.html$/i.test(url.pathname);
    const cacheOpts = respetaQuery ? undefined : { ignoreSearch: true };
    e.respondWith(
      caches.match(e.request, cacheOpts).then(cached => {
        // Revalidar en segundo plano sin bloquear la respuesta
        const net = fetch(e.request).then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const resClone = res.clone();
            caches.open(CACHE).then(k => k.put(e.request, resClone));
          }
          return res;
        }).catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  // For other requests: network-first strategy
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const resClone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, resClone));
        }
        return res;
      })
      .catch(() => {
        return caches.match(e.request);
      })
  );
});

// Allow page to trigger immediate SW activation when a new version is waiting
// y responder consultas de versión desde la página.
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (e.data && e.data.type === 'GET_VERSION' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: APP_VERSION });
  }
  // ── v15: Background Sync API ──
  // La página envía 'TRIGGER_SYNC' cuando un write falla y quiere que el SW
  // intente de nuevo. Esto es un fallback del Background Sync nativo (que se
  // registra con reg.sync.register) para navegadores que no lo soportan
  // (Safari iOS).
  if (e.data && e.data.type === 'TRIGGER_SYNC') {
    // Notificar a TODAS las pestañas abiertas para que re-procesen su cola.
    // El SW no tiene acceso al estado de sync de la página, pero la
    // página sí. Le pedimos que lo intente.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'SW_SYNC_REQUEST' });
      });
    });
  }
});

// ── v15: Background Sync API ──
// Permite al SW reintentar writes cuando la conexión vuelve, incluso si la
// página está cerrada. La página registra 'vales-sync' después de cada
// sendVale. El browser lo dispara cuando hay conexión (o inmediatamente si
// ya la hay).
// Nota: iOS Safari NO soporta Background Sync. En ese caso, la página sigue
// haciendo su propio retry con setInterval + visibilitychange + online event.
self.addEventListener('sync', e => {
  if (e.tag === 'vales-sync') {
    e.waitUntil(
      // Pedir a las pestañas abiertas que procesen su cola. Si no hay
      // pestañas abiertas, no podemos hacer nada (no tenemos acceso al
      // estado de sync). Background Sync se disparará de nuevo cuando
      // el usuario abra la app.
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length === 0) {
          // Sin pestañas abiertas — lanzar una excepción para que el browser
          // reintente el sync más tarde.
          return Promise.reject(new Error('No clients to sync'));
        }
        clients.forEach(client => {
          client.postMessage({ type: 'SW_SYNC_REQUEST' });
        });
        // Esperar un poco para dar tiempo a que la página procese.
        return new Promise(resolve => setTimeout(resolve, 5000));
      })
    );
  }
});
