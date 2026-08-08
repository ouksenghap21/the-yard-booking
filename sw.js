/**
 * The Yard — service worker.
 *
 * Purpose: make repeat loads of admin.html / index.html / tournament.html
 * essentially instant by serving them from cache. The CDN-served vendor
 * libraries (React, jsPDF, autotable, Babel) get cached the first time
 * they load and never need to be re-downloaded for the same version.
 *
 * Caching strategy:
 *   - HTML pages: stale-while-revalidate. Serve cached version immediately
 *     for instant paint, fetch a fresh copy in the background for next load.
 *   - CDN vendor JS: cache-first (immutable URLs include version).
 *   - API calls (Apps Script): NEVER cached. Always go to network.
 *
 * Invalidation: bump CACHE_VERSION whenever HTML/CSS/JS changes. Old caches
 * are deleted in the activate event.
 *
 * Registration is opt-in via the page (see admin.html / index.html bottom).
 *
 * ---------------------------------------------------------------------------
 * v120 — THE ESCAPE HATCH MUST NEVER BE COLDER THAN THE PLAIN URL
 * ---------------------------------------------------------------------------
 * `admin.html?ui=desktop` is the documented recovery route out of a broken
 * mobile layout, and `admin.html?_r=<timestamp>` is what the in-app error
 * boundary reloads with. Both are the SAME document as `admin.html`, but
 * Cache API matching is query-string sensitive, so before v120:
 *
 *   - the first ever `?ui=desktop` load had no cache entry, and the HTML
 *     branch returned `cached || networkPromise || fetch(...)` where
 *     networkPromise is `fetch(...).catch(() => null)` — ALWAYS truthy — so
 *     the trailing `fetch()` was dead code and a flaky network resolved the
 *     respondWith to `null`, failing the navigation outright. The owner's
 *     way out of a crash was strictly more fragile than the crash itself.
 *   - every crash-reload added one more `?_r=…` entry to the cache, forever.
 *
 * Fix: page requests are cached and matched under a key with the query
 * string and hash STRIPPED. One entry per document; `?ui=desktop` and
 * `?_r=…` both hit the entry that plain `admin.html` already populated; the
 * cache cannot grow without bound. And the response chain now ends in a real
 * Response — never `null` — so a dead network produces a readable page that
 * names the escape hatch instead of a dead tab.
 *
 * This is safe because all three pages are single-document SPAs: the query
 * string is read by the page's own JS at runtime and never changes the bytes
 * the server returns for that path.
 */
"use strict";

const CACHE_VERSION = "yard-v123-manualremind";
const VENDOR_CACHE = "yard-vendor-v1";

// Vendor URLs we know are immutable (include a version in the path)
const VENDOR_PATTERNS = [
  /unpkg\.com\/react@/,
  /unpkg\.com\/react-dom@/,
  /unpkg\.com\/@babel\/standalone@/,
  /cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\//,
  /cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf-autotable\//
];

// Apps Script API — NEVER cache.
const API_PATTERNS = [
  /script\.google\.com\/macros/,
  /apis\.google\.com/
];

function isVendor(url) {
  return VENDOR_PATTERNS.some(re => re.test(url));
}
function isApi(url) {
  return API_PATTERNS.some(re => re.test(url));
}
function isPage(url) {
  // The Yard's three HTML pages, served from GitHub Pages.
  // NOTE: `url` may carry a query string (admin.html?ui=desktop), so match
  // on the PATH, not on the whole URL — an anchored /\.html$/ against the
  // full URL misses every query-carrying page request, including the
  // escape hatch, and pushes it into the `mode === "navigate"` branch only.
  const p = pagePath(url);
  return /\/(admin|index|tournament)\.html$/.test(p) || /\/$/.test(p);
}

// Path portion of a URL, no query, no hash. Falls back to the raw string
// if the URL is unparseable (never throws inside a fetch handler).
function pagePath(url) {
  try { return new URL(url).pathname; } catch (e) { return String(url).split(/[?#]/)[0]; }
}

/**
 * Cache key for a page request: the same document always gets ONE entry.
 * `admin.html`, `admin.html?ui=desktop` and `admin.html?_r=1735…` are the
 * same bytes from the server, so they share a key. This is what makes the
 * escape hatch hit a warm cache on its first ever use, and what stops the
 * error boundary's cache-busting reload from growing the cache per crash.
 */
function pageCacheKey(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch (e) {
    return String(url).split(/[?#]/)[0];
  }
}

// Last-resort body when the network is dead and nothing is cached. Returning
// this instead of `null` is the whole point: respondWith(null) is a hard
// navigation failure with no text on screen, which is exactly the wrong
// outcome at the moment the owner is trying to recover.
function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>The Yard — offline</title>' +
    '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:34em;' +
    'margin:12vh auto;padding:0 24px;line-height:1.6">' +
    '<h1 style="font-weight:400;font-style:italic">No connection.</h1>' +
    '<p>This page is not cached on this device yet and the network did not answer. ' +
    'Reload once you are back online.</p>' +
    '<p>If the admin panel loads but the phone/tablet layout is broken, add ' +
    '<b>?ui=desktop</b> to the address and reload — that forces the desktop ' +
    'layout back on and remembers it.</p></div>',
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

self.addEventListener("install", (event) => {
  // Activate immediately on first install — no waiting for tabs to close
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Clean up old version caches
    const names = await caches.keys();
    await Promise.all(names.map(n => {
      if (n !== CACHE_VERSION && n !== VENDOR_CACHE) {
        return caches.delete(n);
      }
    }));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // 0. Only GET is cacheable. cache.put() REJECTS on a non-GET request, and
  //    that rejection used to be swallowed by the `.catch(() => null)` below,
  //    turning a perfectly good POST navigation response into a null response.
  if (event.request.method !== "GET") return;

  // 1. API calls — pass through, never cache
  if (isApi(url)) return;

  // 2. Vendor JS — cache-first (immutable)
  if (isVendor(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(VENDOR_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const resp = await fetch(event.request);
        if (resp.ok) cache.put(event.request, resp.clone());
        return resp;
      } catch (e) {
        // Network failed AND no cache — let the browser handle the error
        throw e;
      }
    })());
    return;
  }

  // 3. HTML pages — stale-while-revalidate, keyed WITHOUT the query string
  if (isPage(url) || event.request.mode === "navigate") {
    event.respondWith((async () => {
      const key = pageCacheKey(url);
      const cache = await caches.open(CACHE_VERSION);
      // `key` is a plain URL string, so ?ui=desktop / ?_r=… find the entry
      // that the plain page URL already wrote.
      const cached = await cache.match(key);
      const networkPromise = fetch(event.request).then(resp => {
        if (resp && resp.ok) {
          // Fire-and-forget; a cache write must never reject the response.
          cache.put(key, resp.clone()).catch(() => {});
        }
        return resp;
      }).catch(() => null);

      // Cache first for instant paint...
      if (cached) return cached;
      // ...otherwise wait for the network. `networkPromise` is a PROMISE and
      // therefore always truthy, so it must be awaited before it can be
      // tested — the old `cached || networkPromise || fetch(...)` made the
      // trailing fallback dead code and let a failed fetch resolve to null.
      const fresh = await networkPromise;
      if (fresh) return fresh;
      // Nothing cached, network refused. One honest retry, then a real
      // Response. Never null.
      try {
        const retry = await fetch(event.request);
        if (retry) return retry;
      } catch (e) {}
      return offlineResponse();
    })());
    return;
  }

  // 4. Everything else — pass through
});
