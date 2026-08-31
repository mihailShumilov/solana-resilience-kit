import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

// The generated TypeDoc API reference lives in `public/api` (so the build copies
// it to `dist/api`). In dev AND preview, Vite's SPA history-fallback serves the
// app's index.html for any extension-less path — so `/api` would render the app,
// not the docs. This plugin intercepts `/api` (302 → `/api/`, so the docs' own
// RELATIVE links resolve under `/api/…`) and serves `public/api/index.html` for
// `/api/`. Deep links like `/api/classes/x.html` are real static files and pass
// through untouched.
function serveTypedoc(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api") {
      res.statusCode = 302;
      res.setHeader("Location", "/api/");
      res.end();
      return;
    }
    if (path === "/api/") req.url = "/api/index.html";
    next();
  };
  return {
    name: "serve-typedoc-api",
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}

// The lab imports the real SDK from ../src and the harness from ../test/harness,
// both of which live outside this package's root, so the dev server must be
// allowed to read the repository root. Vite/esbuild resolve the SDK's `.js`
// relative imports to their `.ts` sources automatically.
//
// The SDK source imports `@solana/kit` as a bare specifier. Node resolves that
// from the *importer* (../src), i.e. the repo root's node_modules — which means
// a deploy that only installs this package (Cloudflare with root directory =
// demo) wouldn't find it. We declare it as this package's own dependency and
// alias the bare specifier to this package's node_modules so the demo is fully
// self-contained. (`@opentelemetry/api` is aliased too, for demo code that
// registers a MeterProvider — the SDK itself no longer imports it; see #15.)
// The alias targets the package *directory* (not a file) so Vite still applies
// the `browser` export condition (@solana/kit ships a dedicated browser build).
const demoModule = (name: string) =>
  fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

// The cookbook examples import the published package names —
// `solana-resilience-kit` and `solana-resilience-kit/testing` — so the displayed
// code is exactly what a consumer writes. There is no published copy on disk
// here, so we alias those specifiers to the in-repo TypeScript sources (`../src`
// and `../test/harness`). Vite resolves their `.js` ESM imports to the `.ts`
// sources, just like the Lab does.
const repoFile = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

export default defineConfig({
  plugins: [react(), serveTypedoc()],
  // @solana/web3.js v1 and the wallet-adapter reference `global`; map it to globalThis.
  define: { global: "globalThis" },
  resolve: {
    // Array form so the `/testing` subpath is matched before the bare package
    // (first match wins). Order matters.
    alias: [
      { find: /^solana-resilience-kit\/testing$/, replacement: repoFile("test/harness/index.ts") },
      { find: /^solana-resilience-kit$/, replacement: repoFile("src/index.ts") },
      { find: "@solana/kit", replacement: demoModule("@solana/kit") },
      { find: "@opentelemetry/api", replacement: demoModule("@opentelemetry/api") },
    ],
  },
  server: {
    fs: { allow: [".."] },
  },
});
