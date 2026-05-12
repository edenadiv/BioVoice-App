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

export default defineConfig({
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
