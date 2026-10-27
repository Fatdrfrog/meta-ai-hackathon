import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";

/**
 * Replaces synthetic `<channel>:<conversation id>` lead names, which older
 * builds stored when no name was found, with the name the customer aggregate
 * derives now (WhatsApp profile name, numeric Telegram/Instagram users), or
 * null. Only the name changes, and only while it still holds the old value.
 *
 * Dry run by default. Output is counts and customer ids, never names or phones.
 *   pnpm backfill:customer-display-names [--workspace-id=<id>] [--limit=500]
 *   pnpm backfill:customer-display-names --apply --workspace-id=<id>
 *   pnpm backfill:customer-display-names --apply --all-workspaces
 * Resume a long run with --after-id=<nextAfterId from the previous output>.
 */

type BackfillArgs = {
  workspaceId: string | null;
  allWorkspaces: boolean;
  afterId: string | null;
  limit: number;
  dryRun: boolean;
};

type Outcome =
  | "named"
  | "cleared"
  | "noConversations"
  | "notOwnConversation"
  | "changedConcurrently";

const SYNTHETIC_NAME = /^([a-z_]+):([0-9a-f]{24})$/;

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
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

function loadEnv() {
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

function parseArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = {
    workspaceId: null,
    allWorkspaces: false,
    afterId: null,
    limit: 500,
    dryRun: true,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--apply") {
      args.dryRun = false;
    } else if (arg === "--all-workspaces") {
      args.allWorkspaces = true;
    } else if (arg.startsWith("--workspace-id=")) {
      args.workspaceId = arg.slice("--workspace-id=".length).trim() || null;
    } else if (arg.startsWith("--after-id=")) {
      const afterId = arg.slice("--after-id=".length).trim();
      if (!mongoose.isValidObjectId(afterId)) {
        throw new Error(`Invalid --after-id: ${afterId}`);
      }
      args.afterId = afterId;
    } else if (arg.startsWith("--limit=")) {
      const limit = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(limit) && limit > 0) {
        args.limit = Math.min(5000, limit);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.workspaceId && args.allWorkspaces) {
    throw new Error("Pass either --workspace-id or --all-workspaces");
  }
  // Writes name their scope explicitly, after a dry run of the same scope.
  if (!args.dryRun && !args.workspaceId && !args.allWorkspaces) {
    throw new Error("--apply requires --workspace-id or --all-workspaces");
  }
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const [{ default: connectDB }, { default: Customer }, service] =
    await Promise.all([
      import("../src/lib/mongoose"),
      import("../src/models/customer"),
      import("../src/lib/customers/service"),
    ]);

  await connectDB();

  const filter: Record<string, unknown> = {
    displayName: { $regex: SYNTHETIC_NAME.source },
  };
  if (args.workspaceId) filter.workspaceId = args.workspaceId;
  if (args.afterId) {
    filter._id = { $gt: new mongoose.Types.ObjectId(args.afterId) };
  }

  const candidates = await Customer.find(filter)
    .select("_id workspaceId displayName conversationIds")
    .sort({ _id: 1 })
    .limit(args.limit + 1)
    .lean<
      Array<{
        _id: mongoose.Types.ObjectId;
        workspaceId: string;
        displayName: string;
        conversationIds?: unknown[];
      }>
    >();
  const batch = candidates.slice(0, args.limit);

  const byChannel: Record<string, Partial<Record<Outcome, number>>> = {};
  const workspaces = new Set<string>();
  const examples: Partial<Record<Outcome, string[]>> = {};
  let failed = 0;

  const record = (channel: string, outcome: Outcome, customerId: string) => {
    const counts = (byChannel[channel] ??= {});
    counts[outcome] = (counts[outcome] || 0) + 1;
    const ids = (examples[outcome] ??= []);
    if (ids.length < 5) ids.push(customerId);
  };

  try {
    for (const customer of batch) {
      const customerId = customer._id.toString();
      const match = SYNTHETIC_NAME.exec(customer.displayName);
      if (!match) continue;
      const [, channel, conversationId] = match;
      workspaces.add(customer.workspaceId);

      // Only names built from this lead's own conversation are synthetic.
      const ownConversation = (customer.conversationIds || []).some(
        id => String(id) === conversationId
      );
      if (!ownConversation) {
        record(channel, "notOwnConversation", customerId);
        continue;
      }

      try {
        const preview = await service.previewCustomerDisplayName(customerId);
        if (!preview) {
          record(channel, "noConversations", customerId);
          continue;
        }
        const outcome: Outcome = preview.next ? "named" : "cleared";
        if (!args.dryRun) {
          const result = await Customer.updateOne(
            { _id: customer._id, displayName: customer.displayName },
            { $set: { displayName: preview.next } }
          );
          if (result.matchedCount === 0) {
            record(channel, "changedConcurrently", customerId);
            continue;
          }
        }
        record(channel, outcome, customerId);
      } catch (error) {
        failed += 1;
        console.error(
          JSON.stringify({
            customerId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          dryRun: args.dryRun,
          scope:
            args.workspaceId || (args.allWorkspaces ? "all" : "all (read)"),
          scanned: batch.length,
          workspaces: workspaces.size,
          byChannel,
          failed,
          examples,
          hasMore: candidates.length > args.limit,
          nextAfterId: batch.at(-1)?._id.toString() || null,
        },
        null,
        2
      )
    );
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
