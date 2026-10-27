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
const { createServer } = await import(
  pathToFileURL(widgetRequire.resolve("vite")).href
);
const tailwind = webRequire("@tailwindcss/postcss");
const port = 4181;
const entry = "/airi-chat-browser-app.tsx";
const startupStarted = performance.now();
let ready = false;

// Reuse installed workspace tools, as the Offices and WhatsApp harnesses do.
// No app route, auth bypass, provider, dependency or production configuration
// is added: Playwright answers every API request inside the spec.
const server = await createServer({
  configFile: false,
  root: testRoot,
  cacheDir:
    process.env.AIRI_CHAT_BROWSER_VITE_CACHE_DIR ||
    resolve(tmpdir(), "airi-chat-browser", "vite-cache"),
  plugins: [
    {
      name: "airi-chat-browser-readiness",
      configureServer(viteServer) {
        viteServer.middlewares.use((request, response, next) => {
          if (
            !ready &&
            request.url?.split("?")[0] === "/airi-chat-browser.html"
          ) {
            response.statusCode = 503;
            response.end(
              "Airi chat browser harness is preparing its module graph."
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
      "next/link": resolve(testRoot, "airi-chat-browser-link.tsx"),
      "next/image": resolve(testRoot, "airi-chat-browser-image.tsx"),
      "next/navigation": resolve(
        testRoot,
        "whatsapp-templates-browser-navigation.ts"
      ),
      "next/dynamic": resolve(
        testRoot,
        "whatsapp-templates-browser-dynamic.tsx"
      ),
      // Before "@": the first matching alias wins.
      "@/lib/auth/auth-context": resolve(testRoot, "airi-chat-browser-auth.ts"),
      "@": resolve(webRoot, "src"),
    },
  },
  define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  css: { postcss: { plugins: [tailwind()] } },
  optimizeDeps: { entries: [resolve(testRoot, "airi-chat-browser.html")] },
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
await server.listen();

// Transform the whole module graph and wait for dependency bundling before
// the page is served, so a cold cache cannot reload the first test's page.
const client = server.environments.client;
const crawled = new Set();
async function crawl(url) {
  if (crawled.has(url) || /\/(node_modules|deps)\//.test(url)) return;
  crawled.add(url);
  await client.transformRequest(url);
  if (!/\.[cm]?[jt]sx?(\?|$)/.test(url)) return;
  const node = await client.moduleGraph.getModuleByUrl(url);
  await Promise.all(
    [...(node?.importedModules ?? [])].map(imported => crawl(imported.url))
  );
}
await crawl(entry);
await server.waitForRequestsIdle();
const optimizer = client.depsOptimizer;
await optimizer?.scanProcessing;
for (;;) {
  const pending = Object.values(optimizer?.metadata?.discovered ?? {})
    .map(dependency => dependency.processing)
    .filter(Boolean);
  if (pending.length === 0) break;
  await Promise.all(pending);
}
// Take the full reload Vite keeps for the first page that connects.
await new Promise((resolveReady, reject) => {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`,
    "vite-hmr"
  );
  socket.addEventListener(
    "message",
    () => {
      socket.close();
      resolveReady();
    },
    { once: true }
  );
  socket.addEventListener("error", reject, { once: true });
});
ready = true;
console.log(
  `Airi chat browser harness ready after ${Math.round(performance.now() - startupStarted)}ms.`
);
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
