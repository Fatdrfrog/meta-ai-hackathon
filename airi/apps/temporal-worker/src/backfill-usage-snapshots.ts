import {
  WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
  type WorkspaceUsageRepairActivityInput,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";

import { loadTemporalWorkerEnv } from "./load-env.js";

function parseArgs(argv: string[]): WorkspaceUsageRepairActivityInput {
  const input: WorkspaceUsageRepairActivityInput = {
    contractVersion: WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
    reason: "manual_backfill",
    includeHistoricalMessageCounts: false,
  };

  for (const arg of argv) {
    if (arg.startsWith("--company-id=")) {
      input.companyIds = [
        ...(input.companyIds ?? []),
        arg.slice("--company-id=".length),
      ];
    } else if (arg.startsWith("--workspace-id=")) {
      input.workspaceIds = [
        ...(input.workspaceIds ?? []),
        arg.slice("--workspace-id=".length),
      ];
    } else if (arg.startsWith("--limit=")) {
      input.limit = Number.parseInt(arg.slice("--limit=".length), 10);
    } else if (arg === "--skip-historical-message-counts") {
      input.includeHistoricalMessageCounts = false;
    } else if (arg === "--include-historical-message-counts") {
      input.includeHistoricalMessageCounts = true;
    }
  }

  return input;
}

async function main() {
  loadTemporalWorkerEnv();
  const input = parseArgs(process.argv.slice(2));
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { repairCompanyUsageSnapshots } = await import(
    "@/lib/limits/company-usage-repair"
  );
  const result = await repairCompanyUsageSnapshots(supabaseAdmin, input);

  airiWorkerLogger.info("workspace.usage.backfill", {
    note: "completed",
    scannedCompanies: result.scannedCompanies,
    repairedCompanies: result.repairedCompanies,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  airiWorkerLogger.error("workspace.usage.backfill", error, {
    note: "failed",
  });
  process.exit(1);
});
