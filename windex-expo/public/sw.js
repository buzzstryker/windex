/* eslint-env serviceworker, browser */
/*
 * Windex PWA service worker.
 *
 * Strategy — FRESH CODE FIRST, offline as a bonus, never the reverse:
 *   - Navigations (index.html / any SPA route): NETWORK-FIRST. Always fetch
 *     from the network; fall back to the cached shell ONLY when offline. Any
 *     offline route returns the cached /index.html shell (expo-router resolves
 *     the route client-side) instead of 404ing.
 *   - Immutable hashed assets under /_expo/static/: STALE-WHILE-REVALIDATE,
 *     cached by URL. Safe because the URL embeds a content hash that changes
 *     every build, so a cached entry is ALWAYS the correct code for that exact
 *     URL, and the network-first index.html always points at the current
 *     hashes — stale CODE is therefore impossible.
 *   - Other same-origin GETs (manifest, icons): network-first, cache fallback.
 *   - Cross-origin (Supabase REST/Realtime) and non-GET requests: untouched.
 *
 * Auto-update: registered as /sw.js?v=<BUILD_SHA>. A new deploy ships a new
 * ?v, so the browser sees a new script, installs it, skipWaiting()s, and
 * claims clients — the page's controllerchange handler (lib/pwaUpdate.ts) then
 * reloads once (deferred while the chat composer is busy). The cache is keyed
 * by that same SHA (read from this script's own URL), so activate() drops
 * every prior build's cache.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * KILL SWITCH — recovery if this SW ever misbehaves (caches wrong, won't
 * update, serves broken code). PROCEDURE:
 *   1. Replace this ENTIRE file's body with the block below.
 *   2. Commit + push to master (Vercel rebuilds the PWA).
 *   3. Installed apps register /sw.js?v=<new SHA>, fetch this self-destructing
 *      script, wipe all caches, unregister the SW, and reload to a clean,
 *      SW-less state (plain network — always safe).
 *   4. Once propagated, restore this file (or ship a corrected SW) and deploy.
 *
 *   self.addEventListener('install', (e) => {
 *     e.waitUntil((async () => {
 *       const keys = await caches.keys();
 *       await Promise.all(keys.map((k) => caches.delete(k)));
 *       await self.skipWaiting();
 *     })());
 *   });
 *   self.addEventListener('activate', (e) => {
 *     e.waitUntil((async () => {
 *       await self.registration.unregister();
 *       const cs = await self.clients.matchAll({ type: 'window' });
 *       cs.forEach((c) => c.navigate(c.url));
 *     })());
 *   });
 * ───────────────────────────────────────────────────────────────────────────
 */

const BUILD = new URLSearchParams(self.location.search).get('v') || 'dev';
const CACHE = `windex-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        // Pre-cache the shell so offline deep links work from the first load.
        await cache.add('/index.html');
      } catch (err) {
        /* precache is best-effort; never fail install (that blocks activation) */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every previous build's cache — keep only this build's.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isHashedAsset(url) {
  return url.pathname.startsWith('/_expo/static/');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin alone

  // SPA navigations: network-first, fall back to the cached shell for ANY route.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(request);
          // The Vercel rewrite serves index.html for every route, so this
          // response IS the shell — keep it fresh for offline use.
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch (err) {
          const shell = await cache.match('/index.html');
          return shell || Response.error();
        }
      })()
    );
    return;
  }

  // Immutable hashed assets: stale-while-revalidate by URL.
  if (isHashedAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.ok) cache.put(request, resp.clone());
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })()
    );
    return;
  }

  // Other same-origin GETs: network-first, cache as offline fallback.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
