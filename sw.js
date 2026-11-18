/* =============================================================================
   Service worker — Perfiles geológicos
   Estrategia:
     · shell de la app  → precache, stale-while-revalidate
     · Sentinel-2 (EOX) y DEM Terrarium → cache-first en CACHE_TILES (libres)
     · Esri (satélite / hillshade) → solo red; sin conexión devuelve un píxel
       transparente, porque sus términos no permiten cacheo masivo
   ============================================================================= */
"use strict";

const VERSION = "v1.5.0";
const SHELL = `perfil-shell-${VERSION}`;
const CACHE_TILES = "perfil-tiles-v1";     // no se borra al actualizar la app

const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/util.js", "./js/db.js", "./js/geo.js", "./js/dem.js", "./js/state.js",
  "./js/map.js", "./js/projection.js", "./js/construct.js", "./js/kinematics.js", "./js/kinpanel.js", "./js/sectionedit.js", "./js/profile.js", "./js/import.js", "./js/export.js", "./js/zone.js", "./js/app.js",
  "./js/vendor/jszip/jszip.min.js", "./js/vendor/shpjs/shp.min.js",
  "./js/vendor/togeojson/togeojson.umd.js", "./js/vendor/proj4/proj4.js",
  "./js/vendor/geotiff/geotiff.js",
  "./manifest.webmanifest",
  "./js/vendor/leaflet/leaflet.js",
  "./js/vendor/leaflet/leaflet.css",
  "./js/vendor/leaflet/images/marker-icon.png",
  "./js/vendor/leaflet/images/marker-icon-2x.png",
  "./js/vendor/leaflet/images/marker-shadow.png",
  "./js/vendor/leaflet/images/layers.png",
  "./js/vendor/leaflet/images/layers-2x.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

const TILE_HOSTS = [
  "tiles.maps.eox.at",              // Sentinel-2 cloudless, CC BY-NC-SA
  "s3.amazonaws.com",               // DEM Terrarium, dominio público
];

// GIF 1×1 transparente para teselas que no se pueden cachear ni pedir
const BLANK = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (c) => c.charCodeAt(0)
);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll falla entero si un recurso falla: se agrega uno por uno
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: "reload" }));
        if (res.ok) await cache.put(url, res);
      } catch { /* se reintenta en el próximo arranque */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((n) => {
      if (n !== SHELL && n !== CACHE_TILES) return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // ---------- teselas libres: cache-first ----------
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileCacheFirst(req));
    return;
  }

  // ---------- Esri: solo red ----------
  if (url.hostname === "server.arcgisonline.com") {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return new Response(BLANK, {
          headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
        });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // ---------- navegación: red y, si falla, shell ----------
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put("./index.html", fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match("./index.html")) ||
               (await cache.match("./")) ||
               new Response("Sin conexión y sin caché.", { status: 503 });
      }
    })());
    return;
  }

  // ---------- recursos propios: stale-while-revalidate ----------
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || new Response("", { status: 504 });
  })());
});

async function tileCacheFirst(req) {
  const cache = await caches.open(CACHE_TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req, { mode: "cors", credentials: "omit" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response(BLANK, {
      headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
    });
  }
}
