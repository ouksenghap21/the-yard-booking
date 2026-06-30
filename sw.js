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
 */
"use strict";

const CACHE_VERSION = "yard-v26-qa-round2";
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
  // The Yard's three HTML pages, served from GitHub Pages
  return /\/(admin|index|tournament)\.html$/.test(url) ||
         /\/$/.test(url);
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

  // 3. HTML pages — stale-while-revalidate
  if (isPage(url) || event.request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(event.request);
      const networkPromise = fetch(event.request).then(resp => {
        if (resp.ok) cache.put(event.request, resp.clone());
        return resp;
      }).catch(() => null);

      // Return cache first if available, otherwise wait for network
      return cached || networkPromise || fetch(event.request);
    })());
    return;
  }

  // 4. Everything else — pass through
});
