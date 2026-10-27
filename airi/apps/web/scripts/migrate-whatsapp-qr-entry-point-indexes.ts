import fs from "node:fs";
import path from "node:path";

import mongoose from "mongoose";

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function loadMongoEnv() {
  const appRoot = process.cwd();
  const repoRoot = path.resolve(appRoot, "..", "..");
  for (const filePath of [
    path.join(appRoot, ".env.local"),
    path.join(appRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env"),
  ]) {
    loadEnvFile(filePath);
  }
}

async function main() {
  loadMongoEnv();
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply") || args.length > 1) {
    throw new Error("Usage: migrate:whatsapp-qr-entry-point-indexes [--apply]");
  }
  const { runWhatsAppQrEntryPointIndexMigration } = await import(
    "../src/lib/whatsapp/qr-entry-points/index-migration"
  );
  const result = await runWhatsAppQrEntryPointIndexMigration({
    apply: args[0] === "--apply",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch(error => {
    process.stderr.write(
      `${JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "WhatsApp QR index migration failed",
      })}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
