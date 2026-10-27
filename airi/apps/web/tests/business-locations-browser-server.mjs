import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testRoot, "..");
const repoRoot = resolve(webRoot, "../..");
const webRequire = createRequire(resolve(webRoot, "package.json"));
const widgetRequire = createRequire(
  resolve(repoRoot, "apps/widget/package.json")
);
const { createServer } = await import(
  pathToFileURL(widgetRequire.resolve("vite")).href
);
const tailwind = webRequire("@tailwindcss/postcss");
const managerPath = resolve(
  webRoot,
  "src/components/settings/business-locations/business-locations-manager.tsx"
);
const startupStarted = performance.now();
let ready = false;

// Reuse installed workspace tools. No app route, auth bypass, provider,
// dependency or production configuration is added by this harness.
const server = await createServer({
  configFile: false,
  root: testRoot,
  // Its own cache, so the Flows harness's dependency set never invalidates it.
  cacheDir:
    process.env.BUSINESS_LOCATIONS_BROWSER_VITE_CACHE_DIR ||
    resolve(webRoot, "node_modules/.cache/business-locations-browser"),
  plugins: [
    {
      name: "business-locations-browser-readiness",
      configureServer(viteServer) {
        viteServer.middlewares.use((request, response, next) => {
          if (
            !ready &&
            request.url?.split("?")[0] === "/business-locations-browser.html"
          ) {
            response.statusCode = 503;
            response.end(
              "Offices browser harness is preparing its module graph."
            );
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: { alias: { "@": resolve(webRoot, "src") } },
  define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  css: { postcss: { plugins: [tailwind()] } },
  optimizeDeps: {
    entries: [
      resolve(testRoot, "business-locations-browser.html"),
      managerPath,
    ],
    // The import dialog loads SheetJS only when an Excel file is chosen.
    // Bundle it up front, so a first XLSX import cannot reload the page.
    include: ["xlsx", "csv-parse/browser/esm/sync"],
  },
  server: {
    host: "127.0.0.1",
    port: 4180,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
await server.listen();

// Transform the app's whole module graph, as a browser would request it, so
// every dependency is discovered and bundled before the page is served. A
// dependency first seen by the browser would otherwise re-bundle the
// dependencies and reload the open page.
const client = server.environments.client;
const crawled = new Set();
async function crawl(url) {
  if (crawled.has(url) || /\/(node_modules|deps)\//.test(url)) return;
  crawled.add(url);
  await client.transformRequest(url);
  // Tailwind lists every scanned source file as an import of the stylesheet;
  // only script imports are what the page loads.
  if (!/\.[cm]?[jt]sx?(\?|$)/.test(url)) return;
  const node = await client.moduleGraph.getModuleByUrl(url);
  await Promise.all(
    [...(node?.importedModules ?? [])].map(imported => crawl(imported.url))
  );
}
await crawl("/business-locations-browser-app.tsx");
await server.waitForRequestsIdle();
// The crawl's end starts the dependency bundling; wait until every
// discovered dependency is bundled. The optimizer has no public promise for
// this, so a missing internal falls back to the crawl above.
const optimizer = client.depsOptimizer;
await optimizer?.scanProcessing;
for (;;) {
  const pending = Object.values(optimizer?.metadata?.discovered ?? {})
    .map(dependency => dependency.processing)
    .filter(Boolean);
  if (pending.length === 0) break;
  await Promise.all(pending);
}
// Vite keeps a full reload sent while no page was connected and hands it to
// the first page that connects. Connect once here to take it, so the first
// test's page is not reloaded mid-test.
await new Promise((resolve, reject) => {
  const socket = new WebSocket(
    `ws://127.0.0.1:4180/?token=${server.config.webSocketToken}`,
    "vite-hmr"
  );
  socket.addEventListener(
    "message",
    () => {
      socket.close();
      resolve();
    },
    { once: true }
  );
  socket.addEventListener("error", reject, { once: true });
});
ready = true;
console.log(
  `Offices browser harness ready after ${Math.round(performance.now() - startupStarted)}ms.`
);
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
