import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { loadWebOperatorEnv } from "./load-web-operator-env";
import {
  MONGO_INDEX_COST_CANDIDATES,
  findProtectedMongoIndexCandidates,
  parseMongoIndexCostOperatorArgs,
  runMongoIndexCostOperation,
  type MongoIndexCostAdapter,
  type MongoIndexMetadata,
  type MongoIndexUsage,
} from "../src/lib/mongo-index-cost-operator";

function applicationSources(): string[] {
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  const sources: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          ![
            "node_modules",
            "dist",
            "build",
            "__tests__",
            "tests",
            "e2e",
          ].includes(entry.name) &&
          !entry.name.startsWith(".")
        )
          walk(entryPath);
      } else if (
        /\.(?:ts|tsx|js|mjs)$/.test(entry.name) &&
        !/\.(?:test|spec|d)\./.test(entry.name) &&
        entry.name !== "mongo-index-cost-operator.ts"
      ) {
        sources.push(fs.readFileSync(entryPath, "utf8"));
      }
    }
  };
  for (const directory of [
    "apps/web/src",
    "apps/temporal-worker/src",
    "packages",
  ]) {
    walk(path.join(repoRoot, directory));
  }
  return sources;
}

async function databaseAdapter(): Promise<MongoIndexCostAdapter> {
  loadWebOperatorEnv();
  const { default: connectDB } = await import("../src/lib/mongoose");
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("database_unavailable");
  return {
    readIndexes: async collection =>
      (await db
        .collection(collection)
        .listIndexes()
        .toArray()) as unknown as MongoIndexMetadata[],
    readIndexSizes: async collection => {
      const stats = await db.command({ collStats: collection, scale: 1 });
      return stats.indexSizes as Record<string, number>;
    },
    readUsage: async collection =>
      (await db
        .collection(collection)
        .aggregate([{ $indexStats: {} }], { maxTimeMS: 10_000 })
        .toArray()) as MongoIndexUsage[],
    setHidden: async (collection, index, hidden) => {
      await db.command({ collMod: collection, index: { name: index, hidden } });
    },
    dropIndex: async (collection, index) => {
      await db.collection(collection).dropIndex(index);
    },
  };
}

export async function runMongoIndexCostOperator(
  argv: string[],
  dependencies: {
    adapter?: MongoIndexCostAdapter;
    sources?: readonly string[];
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
  } = {}
): Promise<number> {
  const stdout =
    dependencies.stdout ?? (value => process.stdout.write(`${value}\n`));
  const stderr =
    dependencies.stderr ?? (value => process.stderr.write(`${value}\n`));
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      const candidateCollections = [
        ...new Set(
          MONGO_INDEX_COST_CANDIDATES.map(candidate => candidate.collection)
        ),
      ];
      stdout(
        JSON.stringify(
          {
            command: "operator:mongo-index-costs",
            default: `Report ${MONGO_INDEX_COST_CANDIDATES.length} vetted candidates across ${candidateCollections.length} collections; no writes.`,
            flags: [
              "--operation=report|hide|unhide|drop",
              `--collection=${candidateCollections.join("|")}`,
              "--index=ALLOWLISTED_NAME",
              "--apply",
              "--dry-run",
              "--observed-since=ISO_UTC_TIMESTAMP",
            ],
            drop: "Requires a hidden index and an attested observation period: 24 hours when a replacement index exists, 7 days when none does. Inspect query errors and latency over representative traffic first.",
          },
          null,
          2
        )
      );
      return 0;
    }
    const args = parseMongoIndexCostOperatorArgs(argv);
    const hintedIndexes = findProtectedMongoIndexCandidates(
      dependencies.sources ?? applicationSources()
    );
    const adapter = dependencies.adapter ?? (await databaseAdapter());
    stdout(
      JSON.stringify(
        await runMongoIndexCostOperation(adapter, args, { hintedIndexes }),
        null,
        2
      )
    );
    return 0;
  } catch (error) {
    // Never echo connection errors, credentials, URIs, or provider payloads.
    stderr(
      JSON.stringify({
        status: "error",
        reason: safeErrorReason(error),
      })
    );
    return 1;
  } finally {
    if (!dependencies.adapter)
      await mongoose.disconnect().catch(() => undefined);
  }
}

function safeErrorReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const codeName = (error as { codeName?: unknown } | null)?.codeName;
  if (code === 13 || codeName === "Unauthorized")
    return "mongo_permission_denied";
  if (
    code === 85 ||
    code === 86 ||
    codeName === "IndexOptionsConflict" ||
    codeName === "IndexKeySpecsConflict"
  )
    return "mongo_index_definition_conflict";
  const message = error instanceof Error ? error.message : "";
  const internalReasons = [
    "invalid_arguments",
    "database_unavailable",
    "candidate_absent",
    "candidate_metadata_changed",
    "candidate_is_hinted",
    "replacement_unavailable",
    "candidate_must_be_hidden",
    "drop_observation_required",
    "mutation_verification_failed",
  ];
  return internalReasons.includes(message)
    ? message
    : "mongo_index_cost_operator_failed";
}

if (/mongo-index-cost-operator\.(?:ts|js|mjs)$/.test(process.argv[1] || "")) {
  void runMongoIndexCostOperator(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
