import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import mongoose from "mongoose";

type BackfillArgs = {
  limit: number;
  workspaceId: string | null;
  campaignId: string | null;
  afterCampaignId: string | null;
  afterMessageId: string | null;
  pageSize: number;
  maxPages: number;
  dryRun: boolean;
};

type CampaignRow = {
  id: string;
  workspace_id: string;
};

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

  // The canonical replay service reads NEXT_PUBLIC_SUPABASE_URL.
  // Allow SUPABASE_URL-only envs used by CLI/scripts.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
    process.env.SUPABASE_URL
  ) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  }
}

function parseArgs(argv: string[]): BackfillArgs {
  const args: BackfillArgs = {
    limit: 25,
    workspaceId: null,
    campaignId: null,
    afterCampaignId: null,
    afterMessageId: null,
    pageSize: 250,
    maxPages: 20,
    dryRun: true,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--apply") {
      args.dryRun = false;
    } else if (arg.startsWith("--limit=")) {
      const limit = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(limit) && limit > 0) {
        args.limit = Math.min(100, limit);
      }
    } else if (arg.startsWith("--workspace-id=")) {
      const workspaceId = arg.slice("--workspace-id=".length).trim();
      args.workspaceId = workspaceId || null;
    } else if (arg.startsWith("--campaign-id=")) {
      const campaignId = arg.slice("--campaign-id=".length).trim();
      args.campaignId = campaignId || null;
    } else if (arg.startsWith("--after-campaign-id=")) {
      args.afterCampaignId =
        arg.slice("--after-campaign-id=".length).trim() || null;
    } else if (arg.startsWith("--after-message-id=")) {
      args.afterMessageId =
        arg.slice("--after-message-id=".length).trim() || null;
    } else if (arg.startsWith("--page-size=")) {
      const value = Number.parseInt(arg.slice("--page-size=".length), 10);
      if (Number.isFinite(value) && value > 0)
        args.pageSize = Math.min(500, value);
    } else if (arg.startsWith("--max-pages=")) {
      const value = Number.parseInt(arg.slice("--max-pages=".length), 10);
      if (Number.isFinite(value) && value > 0)
        args.maxPages = Math.min(200, value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.afterMessageId && !args.campaignId)
    throw new Error("--after-message-id requires --campaign-id");
  // Writes are reviewed one campaign at a time from a dry-run listing.
  if (!args.dryRun && !args.campaignId)
    throw new Error("--apply requires --campaign-id");
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const { replayWhatsAppCampaignPricingPage } = await import(
    "../src/lib/campaign/whatsapp-campaign-pricing-replay"
  );

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL");
  }
  const supabase = createClient(
    supabaseUrl,
    requireEnv("SUPABASE_SERVICE_ROLE_KEY")
  );

  let query = supabase
    .from("campaign_history")
    .select("id, workspace_id")
    .eq("channel", "whatsapp")
    .order("id")
    .limit(args.limit + 1);

  // Legacy zeros also lack coverage. An explicitly selected campaign can be
  // replayed again when a later provider receipt corrects its pricing flags.
  if (!args.campaignId)
    query = query.or(
      "cost_coverage_started_at.is.null,unknown_cost_count.gt.0"
    );
  if (args.afterCampaignId) query = query.gt("id", args.afterCampaignId);

  if (args.workspaceId) {
    query = query.eq("workspace_id", args.workspaceId);
  }
  if (args.campaignId) {
    query = query.eq("id", args.campaignId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const candidates = (data || []) as CampaignRow[];
  const campaigns = candidates.slice(0, args.limit);
  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        candidates: campaigns.length,
        workspaceId: args.workspaceId,
        campaignId: args.campaignId,
      },
      null,
      2
    )
  );

  let completed = 0;
  let partial = 0;
  let failed = 0;
  let legacySkipped = 0;

  try {
    for (const campaign of campaigns) {
      try {
        let afterId = args.afterMessageId || undefined;
        for (let page = 0; page < args.maxPages; page++) {
          const result = await replayWhatsAppCampaignPricingPage({
            workspaceId: campaign.workspace_id,
            campaignId: campaign.id,
            afterId,
            limit: args.pageSize,
            dryRun: args.dryRun,
          });
          console.log(
            JSON.stringify({
              campaignId: campaign.id,
              page: page + 1,
              ...result,
            })
          );
          // Legacy estimates are never rewritten; nothing to page through.
          if (result.skipped) {
            legacySkipped++;
            break;
          }
          if (!result.hasMore) {
            completed++;
            break;
          }
          afterId = result.nextId || undefined;
          if (page === args.maxPages - 1) partial++;
        }
      } catch (err) {
        failed += 1;
        console.error(
          JSON.stringify({
            id: campaign.id,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          completed,
          partial,
          failed,
          legacySkipped,
          dryRun: args.dryRun,
          hasMoreCampaigns: candidates.length > args.limit,
          nextCampaignId: campaigns.at(-1)?.id || null,
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
