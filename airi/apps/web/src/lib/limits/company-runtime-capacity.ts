import {
  withCompanyRuntimeCapacity,
  resolveRuntimeCompanyId,
  checkCompanyRuntimeThroughput,
  CompanyRuntimeCapacityDeferredError,
  type CompanyRuntimeLane,
} from "@icecore/shared/lib/company-runtime-capacity";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function admitCompanyConversationIngress(
  workspaceId: string
): Promise<void> {
  const result = await checkCompanyRuntimeThroughput(
    await resolveRuntimeCompanyId(await supabaseAdmin, workspaceId),
    "ingress"
  );
  if (result.status !== "granted")
    throw new CompanyRuntimeCapacityDeferredError(
      result.status,
      result.status === "limited" ? result.reset : undefined
    );
}

export async function withWorkspaceRuntimeCapacity<T>(
  workspaceId: string,
  lane: CompanyRuntimeLane,
  run: (companyId: string) => Promise<T>
): Promise<T> {
  return withCompanyRuntimeCapacity(
    await supabaseAdmin,
    workspaceId,
    lane,
    run
  );
}
