import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testRoot, "..");
const repoRoot = resolve(webRoot, "../..");
const webRequire = createRequire(resolve(webRoot, "package.json"));
const widgetRequire = createRequire(
  resolve(repoRoot, "apps/widget/package.json")
);
const { createServer, normalizePath } = await import(
  pathToFileURL(widgetRequire.resolve("vite")).href
);
const tailwind = webRequire("@tailwindcss/postcss");
const managerPath = resolve(
  webRoot,
  "src/components/whatsapp-flows/flows-manager.tsx"
);
const inlineEditorPath = resolve(
  webRoot,
  "src/components/scenarios/builders/whatsapp/inline-editor.tsx"
);
const startupStarted = performance.now();
let ready = false;
const templatesSurface = process.env.WHATSAPP_BROWSER_SURFACE === "templates";
const templateManagerPath = resolve(
  webRoot,
  "src/components/whatsapp-templates/templates-manager.tsx"
);
const templateEditorPath = resolve(
  webRoot,
  "src/components/whatsapp-templates/template-editor-form.tsx"
);
const entryName = templatesSurface
  ? "whatsapp-templates-browser"
  : "whatsapp-flows-browser";

// Reuse installed workspace tools. No app route, auth bypass, provider,
// dependency or production configuration is added by this harness.
const server = await createServer({
  configFile: false,
  root: testRoot,
  cacheDir: templatesSurface
    ? resolve(tmpdir(), "airi-whatsapp-templates-browser", "vite-cache")
    : process.env.FLOW_BROWSER_VITE_CACHE_DIR,
  plugins: [
    {
      name: "whatsapp-flows-browser-readiness",
      configureServer(viteServer) {
        viteServer.middlewares.use((request, response, next) => {
          if (!ready && request.url?.split("?")[0] === `/${entryName}.html`) {
            response.statusCode = 503;
            response.end(
              "WhatsApp Flows browser harness is preparing its module graph."
            );
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      ...(templatesSurface
        ? {
            "@/features/panel/messengers/whatsapp-templates/actions": resolve(
              testRoot,
              "whatsapp-templates-browser-actions.ts"
            ),
            "next/navigation": resolve(
              testRoot,
              "whatsapp-templates-browser-navigation.ts"
            ),
            "next/dynamic": resolve(
              testRoot,
              "whatsapp-templates-browser-dynamic.tsx"
            ),
            "@/lib/supabase/client": resolve(
              testRoot,
              "whatsapp-templates-browser-supabase.ts"
            ),
          }
        : {}),
      "@": resolve(webRoot, "src"),
    },
  },
  define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  css: { postcss: { plugins: [tailwind()] } },
  optimizeDeps: {
    entries: [
      resolve(testRoot, `${entryName}.html`),
      ...(templatesSurface
        ? [templateManagerPath, templateEditorPath]
        : [managerPath, inlineEditorPath]),
    ],
  },
  server: {
    host: "127.0.0.1",
    port: templatesSurface ? 4179 : 4178,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
await server.listen();
// The application loads TipTap lazily. Prepare that graph before Playwright's
// readiness check succeeds, so cold optimization cannot reload an open editor.
await Promise.all([
  server.warmupRequest(`/${entryName}-app.tsx`),
  server.warmupRequest(
    `/@fs/${normalizePath(templatesSurface ? templateEditorPath : inlineEditorPath)}`
  ),
]);
await server.waitForRequestsIdle();
ready = true;
console.log(
  `WhatsApp Flows browser harness ready after ${Math.round(performance.now() - startupStarted)}ms.`
);
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
