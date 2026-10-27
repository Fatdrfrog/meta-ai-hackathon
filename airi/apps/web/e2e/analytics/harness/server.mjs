import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const qaRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(qaRoot, "../../..");
const webRequire = createRequire(resolve(webRoot, "package.json"));
const widgetRequire = createRequire(resolve(webRoot, "../widget/package.json"));
const { dashboardFixtureKey, fixtures, responseFixture } = createRequire(
  import.meta.url
)("../fixtures.cjs");
const demo = process.env.ANALYTICS_QA_DEMO === "1";
let demoPreferences = { state: null, revision: null };
const fixtureKeys = new Set([
  "acquisition",
  "chat-leakage",
  "whatsapp",
  "service-lifecycle",
  "policy",
  "dashboards",
  "bulk",
]);
function fixtureJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}
const { createServer } = await import(
  pathToFileURL(widgetRequire.resolve("vite")).href
);
const port = Number(process.env.ANALYTICS_QA_PORT || 3015);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("ANALYTICS_QA_PORT must be a port between 1 and 65535");
}

// Reuse fonts already emitted by Next when available; a fresh checkout can use
// the system fallback without fetching fonts or copying generated build assets.
const mediaRoot = resolve(webRoot, ".next/static/media");
const fontFiles = new Set();
const fontFaces = new Set();
for (const directory of ["chunks", "css"]) {
  const cssRoot = resolve(webRoot, ".next/static", directory);
  const files = await readdir(cssRoot, { recursive: true }).catch(() => []);
  for (const file of files.filter(file => file.endsWith(".css"))) {
    const css = await readFile(resolve(cssRoot, file), "utf8");
    for (const [face] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      if (
        !/font-family\s*:\s*["']?(?:Inter(?: Fallback)?|GeistMono)["']?\s*;/.test(
          face
        )
      )
        continue;
      fontFaces.add(
        face.replace(/url\(([^)]+)\)/g, (original, source) => {
          const name = basename(source.replace(/["']/g, ""));
          if (!name.endsWith(".woff2")) return original;
          fontFiles.add(name);
          return `url(/native-fonts/${name})`;
        })
      );
    }
  }
}

const vitePath = path => path.replaceAll("\\", "/");
const server = await createServer({
  root: qaRoot,
  configFile: false,
  // This harness renders web sources; use that app's compiler options for all
  // workspace imports instead of discovering unrelated package build configs.
  tsconfig: resolve(webRoot, "tsconfig.json"),
  cacheDir: resolve(webRoot, "node_modules/.cache/analytics-outcomes-qa"),
  plugins: [
    {
      name: "analytics-qa-fixture-api",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url, "http://localhost");
          if (!url.pathname.startsWith("/api/")) return next();
          if (!demo)
            return fixtureJson(response, 503, {
              error: "qa_fixture_interception_required",
            });
          const match =
            /^\/api\/workspaces\/qa-workspace\/analytics\/([^/]+)$/.exec(
              url.pathname
            );
          const ownWorkspace =
            url.searchParams.get("workspaceId") === "qa-workspace";
          const key =
            match?.[1] ||
            (url.pathname === "/api/dashboard" && ownWorkspace
              ? dashboardFixtureKey(url)
              : url.pathname === "/api/analytics/llm" && ownWorkspace
                ? "llm"
                : null);
          if (
            !key ||
            (!["dashboard", "dashboardOverview", "llm"].includes(key) &&
              !fixtureKeys.has(key))
          )
            return fixtureJson(response, 404, {
              error: "qa_fixture_scope_only",
            });
          try {
            if (key === "dashboards") {
              if (request.method === "GET")
                return fixtureJson(response, 200, {
                  ...demoPreferences,
                  recommendation: fixtures.recommendation,
                });
              if (request.method !== "PUT")
                return fixtureJson(response, 405, {
                  error: "method_not_allowed",
                });
              const chunks = [];
              let length = 0;
              for await (const chunk of request) {
                length += chunk.length;
                if (length > 65536)
                  return fixtureJson(response, 413, {
                    error: "qa_fixture_payload_too_large",
                  });
                chunks.push(chunk);
              }
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (body.revision !== demoPreferences.revision)
                return fixtureJson(response, 409, {
                  error: "qa_fixture_revision_conflict",
                });
              // Dashboards saves may omit Outcomes; Outcomes saves always send it.
              if (
                !body.state ||
                body.state.version !== 1 ||
                !Array.isArray(body.state.views) ||
                (body.state.outcomes !== undefined &&
                  !Array.isArray(body.state.outcomes?.cards))
              )
                return fixtureJson(response, 400, {
                  error: "qa_fixture_state_required",
                });
              demoPreferences = {
                state: body.state,
                revision: (demoPreferences.revision || 0) + 1,
              };
              return fixtureJson(response, 200, demoPreferences);
            }
            if (request.method !== "GET")
              return fixtureJson(response, 405, {
                error: "method_not_allowed",
              });
            // Fixtures use UTC epochs. Local browser dates stay in the requested
            // labels; real timezone/population comparisons remain withheld.
            const fixtureUrl = new URL(url);
            fixtureUrl.searchParams.set("timeZone", "UTC");
            fixtureUrl.searchParams.set("timezone", "UTC");
            return fixtureJson(response, 200, responseFixture(key, fixtureUrl));
          } catch {
            return fixtureJson(response, 400, {
              error: "qa_fixture_request_invalid",
            });
          }
        });
      },
    },
    {
      name: "analytics-qa-native-fonts",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url, "http://localhost").pathname;
          if (pathname === "/fonts.css") {
            response.setHeader("Content-Type", "text/css");
            response.end([...fontFaces].join("\n"));
          } else if (pathname.startsWith("/native-fonts/")) {
            const name = pathname.slice("/native-fonts/".length);
            if (!fontFiles.has(name)) {
              response.statusCode = 404;
              response.end();
              return;
            }
            try {
              const bytes = await readFile(resolve(mediaRoot, name));
              response.setHeader("Content-Type", "font/woff2");
              response.end(bytes);
            } catch {
              response.statusCode = 404;
              response.end();
            }
          } else {
            next();
          }
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    fs: { allow: [resolve(webRoot, "../..")] },
  },
  resolve: {
    alias: [
      { find: "next/link", replacement: vitePath(resolve(qaRoot, "link.jsx")) },
      {
        find: "next/dynamic",
        replacement: vitePath(resolve(qaRoot, "dynamic.jsx")),
      },
      {
        find: "next/navigation",
        replacement: vitePath(resolve(qaRoot, "navigation.js")),
      },
      { find: "@", replacement: vitePath(resolve(webRoot, "src")) },
      { find: /^react$/, replacement: webRequire.resolve("react") },
      {
        find: /^react\/(.*)$/,
        replacement: `${vitePath(resolve(webRoot, "node_modules/react"))}/$1`,
      },
      { find: /^react-dom$/, replacement: webRequire.resolve("react-dom") },
      {
        find: /^react-dom\/(.*)$/,
        replacement: `${vitePath(resolve(webRoot, "node_modules/react-dom"))}/$1`,
      },
      { find: /^next-intl$/, replacement: webRequire.resolve("next-intl") },
      { find: /^jotai$/, replacement: webRequire.resolve("jotai") },
      { find: /^swr$/, replacement: webRequire.resolve("swr") },
    ],
    dedupe: ["react", "react-dom"],
  },
  esbuild: { jsx: "automatic" },
  css: {
    postcss: {
      plugins: [webRequire("@tailwindcss/postcss")({ base: webRoot })],
    },
  },
});

await server.listen();
server.printUrls();
if (demo)
  server.config.logger.info(
    "QA fixture demo enabled for qa-workspace only; preferences stay in this process."
  );
server.config.logger.info(
  fontFiles.size
    ? `Reusing ${fontFiles.size} native font assets from apps/web/.next.`
    : "No emitted Next font assets found; using system font fallbacks."
);
