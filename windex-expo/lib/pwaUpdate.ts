import { Platform } from 'react-native';

/**
 * PWA auto-update coordination (web only).
 *
 * The service worker registers as `/sw.js?v=<BUILD_ID>`. Each deploy ships a
 * new BUILD_ID → a new script URL → the browser installs the new SW, which
 * skipWaiting()s and claims clients, firing `controllerchange` in the page.
 * We then reload once so the open app runs the new bundle — UNLESS the chat
 * composer is busy (focused or holding unsent text), in which case the reload
 * is deferred until the composer goes idle (or the next app load), so a
 * surprise reload never eats a half-typed message.
 */

let composerBusy = false; // chat composer focused or holding unsent text
let reloadPending = false; // a SW update is waiting to be applied
let refreshing = false; // a reload is already in flight (in-memory loop guard)

function maybeReload(): void {
  if (refreshing || !reloadPending || composerBusy) return;
  if (typeof window === 'undefined') return;
  // Cross-reload loop guard: never reload twice within 10s in one tab session.
  try {
    const KEY = 'windex-sw-last-reload';
    const last = Number(window.sessionStorage.getItem(KEY) || '0');
    if (Date.now() - last < 10000) return;
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable — rely on the in-memory refreshing guard */
  }
  refreshing = true;
  reloadPending = false;
  window.location.reload();
}

/**
 * The chat composer reports whether it's "busy" (focused or has unsent text).
 * When it transitions to idle, any deferred SW reload is applied.
 */
export function setComposerBusy(busy: boolean): void {
  composerBusy = busy;
  if (!busy) maybeReload();
}

/** Register the service worker and wire composer-aware auto-reload. No-op off web. */
export function registerServiceWorker(buildId: string): void {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  // If there's no controller yet, the first activation is the INITIAL install,
  // not an update — skip the reload for that one.
  let sawController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!sawController) {
      sawController = true;
      return;
    }
    reloadPending = true;
    maybeReload();
  });
  navigator.serviceWorker.register(`/sw.js?v=${buildId}`).catch(() => {
    /* registration failure is non-fatal; the app still works without the SW */
  });
}
