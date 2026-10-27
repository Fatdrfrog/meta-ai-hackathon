import fs from "node:fs";
import path from "node:path";

import mongoose from "mongoose";

type ScanCliArgs = {
  mode: "scan";
  apply: boolean;
  workspaceId?: string;
  batchSize: number;
  cursor?: string;
  maxPages?: number;
  finalReportPath?: string;
};

type AttestationCliArgs = {
  mode: "attestation";
  inventoryReportPath: string;
  writerDrainEvidencePath: string;
  compatReleaseId: string;
  requireRolloutReady: boolean;
};

type CliArgs = ScanCliArgs | AttestationCliArgs;

function loadEnvFile(filePath: string): void {
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

function loadMongoEnv(): void {
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

function parsePositiveInteger(
  value: string,
  name: string,
  maximum?: number
): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (maximum !== undefined && parsed > maximum)
  ) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive safe integer`
        : `${name} must be an integer from 1 through ${maximum}`
    );
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliArgs {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const valueFlags = new Set([
    "--workspace-id",
    "--batch-size",
    "--cursor",
    "--max-pages",
    "--final-report",
    "--attest-inventory-report",
    "--writer-drain-evidence",
    "--compat-release-id",
  ]);
  const switchFlags = new Set(["--apply", "--require-rollout-ready"]);

  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    const separatorIndex = argument.indexOf("=");
    const flag =
      separatorIndex >= 0 ? argument.slice(0, separatorIndex) : argument;
    if (switchFlags.has(flag)) {
      if (separatorIndex >= 0 || switches.has(flag)) {
        throw new Error(`Duplicate or invalid migration argument: ${flag}`);
      }
      switches.add(flag);
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag)) {
      throw new Error(`Unknown or duplicate migration argument: ${argument}`);
    }
    const value =
      separatorIndex >= 0
        ? argument.slice(separatorIndex + 1)
        : normalizedArgv[(index += 1)];
    if (!value || value.startsWith("--") || !value.trim()) {
      throw new Error(`${flag} requires a nonempty value`);
    }
    values.set(flag, value.trim());
  }

  const attestationRequested = [
    "--attest-inventory-report",
    "--writer-drain-evidence",
    "--compat-release-id",
  ].some(flag => values.has(flag));
  if (attestationRequested) {
    const inventoryReportPath = values.get("--attest-inventory-report");
    const writerDrainEvidencePath = values.get("--writer-drain-evidence");
    const compatReleaseId = values.get("--compat-release-id");
    if (!inventoryReportPath || !writerDrainEvidencePath || !compatReleaseId) {
      throw new Error(
        "Attestation requires --attest-inventory-report, --writer-drain-evidence, and --compat-release-id"
      );
    }
    const forbidden = [
      "--workspace-id",
      "--batch-size",
      "--cursor",
      "--max-pages",
      "--final-report",
    ].find(flag => values.has(flag));
    if (switches.has("--apply") || forbidden) {
      throw new Error("Attestation mode forbids scan and mutation arguments");
    }
    return {
      mode: "attestation",
      inventoryReportPath,
      writerDrainEvidencePath,
      compatReleaseId,
      requireRolloutReady: switches.has("--require-rollout-ready"),
    };
  }

  if (switches.has("--require-rollout-ready")) {
    throw new Error(
      "--require-rollout-ready is valid only in attestation mode"
    );
  }
  return {
    mode: "scan",
    apply: switches.has("--apply"),
    batchSize: values.has("--batch-size")
      ? parsePositiveInteger(values.get("--batch-size")!, "Batch size", 500)
      : 100,
    ...(values.has("--workspace-id")
      ? { workspaceId: values.get("--workspace-id") }
      : {}),
    ...(values.has("--cursor") ? { cursor: values.get("--cursor") } : {}),
    ...(values.has("--max-pages")
      ? {
          maxPages: parsePositiveInteger(
            values.get("--max-pages")!,
            "Max pages"
          ),
        }
      : {}),
    ...(values.has("--final-report")
      ? { finalReportPath: values.get("--final-report") }
      : {}),
  };
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function loadMigrationModule(): Promise<
  typeof import("../src/lib/whatsapp/qr-entry-points/manager-migration")
> {
  const namespace = await import(
    "../src/lib/whatsapp/qr-entry-points/manager-migration"
  );
  const namespaceRecord = namespace as unknown as Record<string, unknown>;
  const defaultRecord =
    namespaceRecord.default !== null &&
    typeof namespaceRecord.default === "object"
      ? (namespaceRecord.default as Record<string, unknown>)
      : {};
  const candidate = { ...defaultRecord, ...namespaceRecord };
  if (
    typeof candidate.attestWhatsAppQrManagerRollout !== "function" ||
    typeof candidate.runWhatsAppQrManagerMigration !== "function"
  ) {
    throw new Error("WhatsApp QR Manager migration module is invalid");
  }
  return candidate as typeof import("../src/lib/whatsapp/qr-entry-points/manager-migration");
}

async function writeFinalReport(
  outputPath: string,
  report: unknown
): Promise<void> {
  const resolvedPath = path.resolve(outputPath);
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
  await fs.promises.writeFile(resolvedPath, bytes, { flag: "wx" });
  emit({
    type: "whatsapp_qr_manager_final_report_written",
    bytes: bytes.length,
  });
}

let databaseMode = false;

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mode === "attestation") {
    const migration = await loadMigrationModule();
    const [inventoryReportBytes, writerDrainEvidenceBytes] = await Promise.all([
      fs.promises.readFile(args.inventoryReportPath),
      fs.promises.readFile(args.writerDrainEvidencePath),
    ]);
    const attestation = migration.attestWhatsAppQrManagerRollout({
      inventoryReportBytes,
      writerDrainEvidenceBytes,
      compatReleaseId: args.compatReleaseId,
    });
    emit({
      type: "whatsapp_qr_manager_rollout_attestation",
      ...attestation,
    });
    if (args.requireRolloutReady && !attestation.rolloutReady) {
      process.exitCode = 2;
    }
    return;
  }

  loadMongoEnv();
  databaseMode = true;
  const migration = await loadMigrationModule();
  const summary = await migration.runWhatsAppQrManagerMigration(
    {
      apply: args.apply,
      batchSize: args.batchSize,
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.maxPages ? { maxPages: args.maxPages } : {}),
    },
    { emit }
  );
  if (args.finalReportPath) {
    await writeFinalReport(args.finalReportPath, summary);
  }
}

main()
  .catch(() => {
    process.stderr.write(
      `${JSON.stringify({
        type: "whatsapp_qr_manager_migration_error",
        code: "operator_failed",
        message: "WhatsApp QR Manager operator failed",
      })}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (databaseMode) await mongoose.disconnect().catch(() => undefined);
  });
