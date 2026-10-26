import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createMetaClient, loadConfig, openSpendLedger } from "@vitrina/meta";
import { createApp } from "./app.ts";
import { startJobRunner } from "./jobs.ts";
import { DATA_DIR, ROOT, WEB_DIST } from "./paths.ts";
import { openStore } from "./store.ts";

const config = loadConfig({ ...process.env, SPEND_LEDGER_PATH: process.env.SPEND_LEDGER_PATH ?? join(ROOT, ".data", "spend.json") });
const meta = createMetaClient(config, openSpendLedger(config.ledgerPath, config.budgetUsd));
const store = openStore(join(DATA_DIR, "vitrina.db"));
const runner = startJobRunner(store, meta, "elevenlabs");
const app = createApp(store, { dataDir: DATA_DIR, onVideoQueued: runner.kick });

// In production the server also hands out the built web app; in development Vite does.
if (existsSync(WEB_DIST)) {
  const root = relative(process.cwd(), WEB_DIST);
  app.use("/*", serveStatic({ root }));
  const index = serveStatic({ path: join(root, "index.html") });
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") || c.req.path.startsWith("/media/") ? next() : index(c, next)));
}

const port = Number(process.env.PORT ?? "8787");
serve({ fetch: app.fetch, port }, (info) => console.log(`Vitrina server on http://localhost:${info.port}`));
