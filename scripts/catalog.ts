// Turns a shop video into a catalog from the command line: the same pipeline the studio runs.
// Run: pnpm catalog <video> [--speech=elevenlabs|openai]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, contactSheet, type SpeechProvider } from "@vitrina/catalog";
import { createMetaClient, loadConfig, openSpendLedger } from "@vitrina/meta";

const args = process.argv.slice(2);
const [videoPath] = args.filter((arg) => !arg.startsWith("--"));
const speech = (args.find((arg) => arg.startsWith("--speech="))?.slice("--speech=".length) ?? "elevenlabs") as SpeechProvider;
if (!videoPath) {
  console.error("Usage: pnpm catalog <shop-video.mp4|.mov> [--speech=elevenlabs|openai]");
  process.exit(1);
}

const config = loadConfig();
const meta = createMetaClient(config, openSpendLedger(config.ledgerPath, config.budgetUsd));
const workDir = join(".data", "catalogs", String(Date.now()));
mkdirSync(workDir, { recursive: true });

const result = await buildCatalog({
  sourcePath: videoPath,
  workDir,
  meta,
  speech,
  onProgress: (p) => console.log(p.stage === "cutting" ? `cutting ${p.done}/${p.total}` : p.stage),
});

const price = (p: (typeof result.products)[number]) => (p.price === null ? "-" : `${p.price} ${p.currency ?? ""}`);
await contactSheet(
  result.products.map((p) => ({
    path: p.cutoutPath ?? p.framePath,
    lines: [p.local_name, `${price(p)}${p.doubt || p.checks.length ? "  ⚠ confirm" : ""}`],
  })),
  join(workDir, "contact-sheet.png"),
);
writeFileSync(join(workDir, "catalog.json"), `${JSON.stringify(result, null, 2)}\n`);

console.log(`\nTranscript (${result.language}):\n${result.transcript}\n`);
console.table(
  result.products.map((p) => ({
    product: p.local_name,
    english: p.name,
    price: price(p),
    quote: p.price_quote ?? "",
    cutout: p.cutoutPath ? (p.samConfidence?.toFixed(2) ?? "yes") : "none",
    confirm: [p.doubt, ...p.checks].filter(Boolean).join(" "),
  })),
);
const s = result.seconds;
console.log(
  `Took ${(s.prepare + s.listen + s.watch + s.cut).toFixed(0)}s (prepare ${s.prepare.toFixed(0)}, listen ${s.listen.toFixed(0)}, watch ${s.watch.toFixed(0)}, cut ${s.cut.toFixed(0)}); ` +
    `this run cost about $${result.spentUsd.toFixed(3)}. Output: ${workDir}`,
);
