import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createBasetenClient, createMetaClient, loadBasetenConfig, loadConfig, openSpendLedger } from "@vitrina/meta";
import { runSellerTurn } from "@vitrina/seller";
import { createApp } from "./app.ts";
import { catalogSheet } from "./catalog-sheet.ts";
import { startJobRunner } from "./jobs.ts";
import { DATA_DIR, ROOT, WEB_DIST } from "./paths.ts";
import { openStore } from "./store.ts";

const config = loadConfig({ ...process.env, SPEND_LEDGER_PATH: process.env.SPEND_LEDGER_PATH ?? join(ROOT, ".data", "spend.json") });
const meta = createMetaClient(config, openSpendLedger(config.ledgerPath, config.budgetUsd));
const store = openStore(join(DATA_DIR, "vitrina.db"));
const runner = startJobRunner(store, meta, "elevenlabs");
// The seller runs on Muse Spark Open through Baseten and shares the spend cap with everything else.
const baseten = process.env.BASETEN_API_KEY ? createBasetenClient(loadBasetenConfig(), meta.ledger) : undefined;
if (!baseten) console.warn("BASETEN_API_KEY is not set, so the shop page's chat is off.");
const app = createApp(store, {
  dataDir: DATA_DIR,
  onVideoQueued: runner.kick,
  sell: baseten && ((input) => runSellerTurn(baseten, input)),
  catalogSheet: (shopId, items) => catalogSheet(DATA_DIR, shopId, items),
});

// In production the server also hands out the built web app; in development Vite does.
if (existsSync(WEB_DIST)) {
  const root = relative(process.cwd(), WEB_DIST);
  app.use("/*", serveStatic({ root }));
  const index = serveStatic({ path: join(root, "index.html") });
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") || c.req.path.startsWith("/media/") ? next() : index(c, next)));
}

const port = Number(process.env.PORT ?? "8787");
serve({ fetch: app.fetch, port }, (info) => console.log(`Vitrina server on http://localhost:${info.port}`));
