import {
  assertContractVersion,
  WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION,
  type WorkspaceUsageRepairActivityInput,
  type WorkspaceUsageRepairActivityResult,
} from "@icecore/temporal";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";

export async function workspaceUsageRepairActivity(
  input: WorkspaceUsageRepairActivityInput,
): Promise<WorkspaceUsageRepairActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { max: WORKSPACE_USAGE_REPAIR_WORKFLOW_CONTRACT_VERSION },
    "workspace usage repair",
  );

  airiWorkerLogger.info("workspace.usage.repair", {
    note: "started",
    companyIds: input.companyIds?.length || 0,
    workspaceIds: input.workspaceIds?.length || 0,
    limit: input.limit || null,
    reason: input.reason || null,
    historicalMessageCountsIgnored:
      input.includeHistoricalMessageCounts === true,
  });

  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  const { repairCompanyUsageSnapshots } = await import(
    "@/lib/limits/company-usage-repair"
  );
  const result = await repairCompanyUsageSnapshots(supabaseAdmin, input);

  airiWorkerLogger.info("workspace.usage.repair", {
    note: "completed",
    scannedCompanies: result.scannedCompanies,
    repairedCompanies: result.repairedCompanies,
  });

  return result;
}
