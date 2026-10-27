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

function parseArgs(args: string[]) {
  if (
    args.length !== 4 ||
    args[0] !== "--workspace-id" ||
    args[2] !== "--source-id"
  ) {
    throw new Error(
      "Usage: verify:whatsapp-qr-manager-query-plans --workspace-id <id> --source-id <id>"
    );
  }
  const workspaceId = args[1]?.trim();
  const sourceId = args[3]?.trim();
  if (!workspaceId || !sourceId) {
    throw new Error(
      "Usage: verify:whatsapp-qr-manager-query-plans --workspace-id <id> --source-id <id>"
    );
  }
  return { workspaceId, sourceId };
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  loadMongoEnv();
  const { verifyWhatsAppQrManagerQueryPlans } = await import(
    "../src/lib/whatsapp/qr-entry-points/query-plan"
  );
  await verifyWhatsAppQrManagerQueryPlans({
    ...params,
    emit: line => process.stdout.write(`${line}\n`),
  });
}

main()
  .catch(error => {
    process.stderr.write(
      `${JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "WhatsApp QR Manager query-plan verification failed",
      })}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
