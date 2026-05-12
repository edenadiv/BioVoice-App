/// <reference lib="webworker" />
// P3 — Hand-written service worker for the BioVoice PWA install
// surface. Runs as a Web Worker; `self` refers to the SW global scope.
//
// Strategy: precache static assets (HTML/JS/CSS/icons) for offline
// boot of the SPA. Pass through every request to /users/, /verify,
// /embed, /spoof, /identify, /enroll, /metrics, /readyz, /health,
// /results — these need a live backend and must NEVER serve stale
// cached responses.

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// API routes that must always hit the network. fetch() calls into
// these never see a service-worker response.
const API_PREFIXES = [
  "/health",
  "/readyz",
  "/metrics",
  "/users",
  "/enroll",
  "/verify",
  "/identify",
  "/embed",
  "/spoof",
  "/results",
];

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Precache the static bundle. `self.__WB_MANIFEST` is injected at
// build time by vite-plugin-pwa with the list of hashed assets.
// Type comes from workbox-precaching's ambient declarations.
precacheAndRoute((self as unknown as { __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0] }).__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// API pass-through — fetch() to API routes goes straight to the
// network and never touches a cache.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (isApiPath(url.pathname)) {
    event.respondWith(fetch(event.request));
  }
});

export {};
