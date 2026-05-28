import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// API routes that must always hit the network — never serve a cached
// (or fallback HTML) response. Keeping this list explicit beats trying
// to enumerate every SPA route.
const API_ROUTES_DENYLIST = [
  /^\/health$/,
  /^\/readyz$/,
  /^\/metrics(\/|$)/,
  /^\/users(\/|$)/,
  /^\/enroll$/,
  /^\/verify$/,
  /^\/identify$/,
  /^\/embed$/,
  /^\/spoof(\/|$)/,
  /^\/results$/,
];

// Dev + preview serve the SPA on :5173 while the FastAPI backend runs on
// :8000. In production FastAPI serves both from one origin, so the app
// uses relative API paths. To make those same relative paths reach the
// backend across the two-port dev/preview setup, proxy the backend route
// prefixes through to :8000 (no CORS, no VITE_API_BASE_URL needed).
const BACKEND_TARGET = process.env.VITE_DEV_BACKEND ?? "http://127.0.0.1:8000";
const API_PROXY = Object.fromEntries(
  ["/health", "/readyz", "/metrics", "/users", "/enroll", "/verify", "/identify", "/embed", "/explain", "/spoof", "/results"]
    .map((path) => [path, { target: BACKEND_TARGET, changeOrigin: true }]),
);

export default defineConfig({
  server: { proxy: API_PROXY },
  preview: { proxy: API_PROXY },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/source.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable.png"],
      manifest: {
        name: "BioVoice — Voice Biometric Authentication",
        short_name: "BioVoice",
        description: "Operator console for voice verification + spoof detection.",
        theme_color: "#04070d",
        background_color: "#04070d",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // injectManifest mode lets us hand-write the SW instead of having
      // workbox-build templatize a generated one. Workaround for an
      // upstream workbox-build bug where the template literal fails on
      // project paths that contain an apostrophe (cf. "Eden's Files").
      strategies: "injectManifest",
      srcDir: "src/sw",
      filename: "sw.ts",
      injectManifest: {
        // No need to pass the API denylist here — our hand-written SW
        // already filters by URL path.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
      },
    }),
  ],
});
