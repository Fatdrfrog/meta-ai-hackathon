/**
 * Operator rollout for Meta template insights (template sent/read/click
 * analytics). Dry run by default: lists each WhatsApp Business Account behind
 * WhatsApp sources (one workspace, or all of them) with what enabling would do.
 * `--apply` enables insights on exactly one reviewed source, named with
 * `--source-id`. Meta cannot turn insights off again, so run --apply only after
 * that workspace's owner confirmed. Prints ids only.
 *
 *   pnpm --filter @icecore/web operator:whatsapp-template-insights [--workspace-id=<uuid>] [--source-id=<uuid>] [--limit=50] [--after-source-id=<uuid>]
 *   pnpm --filter @icecore/web operator:whatsapp-template-insights --source-id=<uuid> --apply
 *
 * The package script runs `tsx --conditions=react-server`; server-only
 * modules refuse to load without that condition.
 */
import fs from "node:fs";
import path from "node:path";

type Args = {
  apply: boolean;
  workspaceId: string | null;
  sourceId: string | null;
  afterSourceId: string | null;
  limit: number;
};

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
    )
      value = value.slice(1, -1);
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
  ])
    loadEnvFile(filePath);
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && process.env.SUPABASE_URL)
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    workspaceId: null,
    sourceId: null,
    afterSourceId: null,
    limit: 50,
  };
  const value = (arg: string, name: string) =>
    arg.slice(name.length + 3).trim() || null;
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg.startsWith("--workspace-id="))
      args.workspaceId = value(arg, "workspace-id");
    else if (arg.startsWith("--source-id="))
      args.sourceId = value(arg, "source-id");
    else if (arg.startsWith("--after-source-id="))
      args.afterSourceId = value(arg, "after-source-id");
    else if (arg.startsWith("--limit=")) {
      const limit = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(limit) && limit > 0)
        args.limit = Math.min(200, limit);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  // Each irreversible change is one reviewed WABA from a dry-run listing.
  if (args.apply && !args.sourceId)
    throw new Error("--apply requires --source-id");
  return args;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const { enableWhatsAppTemplateInsights, listWhatsAppInsightsSources } =
    await import("../src/lib/analytics/whatsapp-insights-activation");
  const { sources, nextSourceId } = await listWhatsAppInsightsSources({
    workspaceId: args.workspaceId || undefined,
    sourceId: args.sourceId || undefined,
    afterSourceId: args.afterSourceId || undefined,
    limit: args.limit,
  });
  console.log(
    JSON.stringify({
      mode: args.apply ? "apply (irreversible at Meta)" : "dry-run",
      accounts: sources.length,
      workspaceId: args.workspaceId,
      sourceId: args.sourceId,
    })
  );
  const outcomes: Record<string, number> = {};
  for (const source of sources) {
    let outcome: string;
    try {
      ({ outcome } = await enableWhatsAppTemplateInsights({
        workspaceId: source.workspaceId,
        sourceId: source.id,
        dryRun: !args.apply,
      }));
    } catch (error) {
      outcome = "error";
      process.exitCode = 1;
      console.error(
        JSON.stringify({
          sourceId: source.id,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    console.log(
      JSON.stringify({
        workspaceId: source.workspaceId,
        sourceId: source.id,
        wabaId: source.accountKey,
        outcome,
      })
    );
  }
  console.log(
    JSON.stringify(
      {
        outcomes,
        // `would_enable` rows are the candidates; reconnect `permission_required` ones first.
        nextSourceId,
        dryRun: !args.apply,
      },
      null,
      2
    )
  );
}

if (
  /enable-whatsapp-template-insights\.(?:ts|js|mjs)$/.test(
    process.argv[1] || ""
  )
) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
