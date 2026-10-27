import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import {
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import connectDB from "@/lib/mongoose";
import {
  analyticsPolicyInput,
  getAnalyticsPolicy,
} from "@/lib/analytics/analytics-policy";
import { AnalyticsPolicy } from "@/models/analytics-policy";
import { loadCrmPipelineStages } from "@/lib/crm/board";
import { getEffectivePipelineStages } from "@/lib/crm/stages";
import { noStoreJson } from "@/lib/http/no-store-json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ workspaceId: string }> };
const json = (data: unknown, status = 200) =>
  noStoreJson(data, status, { cacheControl: "private, no-store" });
const unavailable = () =>
  json({ error: "Analytics qualification policy unavailable" }, 503);
const conflict = () =>
  json(
    {
      error: "Qualification policy changed; reload",
      code: "revision_conflict",
    },
    409
  );
export async function GET(_request: Request, { params }: Context) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const [stages, membership] = await Promise.all([
      loadCrmPipelineStages({ supabase: access.supabase, workspaceId }),
      access.supabase
        .from("company_users")
        .select("role")
        .eq("workspace_id", workspaceId)
        .eq("user_id", access.userId)
        .maybeSingle(),
    ]);
    if (membership.error) return unavailable();
    await connectDB();
    return json({
      ...(await getAnalyticsPolicy(workspaceId)),
      stages: getEffectivePipelineStages(stages).map(stage => ({
        key: stage.key,
        name: stage.name,
      })),
      canEdit: isCompanyAdminRole(membership.data?.role),
    });
  } catch {
    return unavailable();
  }
}
export async function PUT(request: Request, { params }: Context) {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;
    const { data: member, error } = await access.supabase
      .from("company_users")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", access.userId)
      .maybeSingle();
    if (error) return unavailable();
    if (!member || !isCompanyAdminRole(member.role))
      return json(
        { error: "Only workspace admins can change qualification" },
        403
      );
    let parsed;
    try {
      parsed = analyticsPolicyInput.safeParse(
        await readJsonBodyWithinLimit(request, 4096)
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof JsonBodyTooLargeError
              ? "Policy body too large"
              : "Invalid policy body",
        },
        error instanceof JsonBodyTooLargeError ? 413 : 400
      );
    }
    if (!parsed.success)
      return json({ error: "Invalid qualification policy" }, 400);
    const stages = await loadCrmPipelineStages({
      supabase: access.supabase,
      workspaceId,
    });
    const active = new Set(
      getEffectivePipelineStages(stages).map(stage => stage.key)
    );
    if (parsed.data.qualifiedStageKeys.some(key => !active.has(key)))
      return json({ error: "Choose an active CRM stage" }, 400);
    await connectDB();
    const updated = await AnalyticsPolicy.findOneAndUpdate(
      { workspaceId, revision: parsed.data.revision },
      {
        $set: {
          qualifiedStageKeys: [...new Set(parsed.data.qualifiedStageKeys)],
        },
        $inc: { revision: 1 },
      },
      { new: true, upsert: parsed.data.revision === 0 }
    ).lean<{ qualifiedStageKeys: string[]; revision: number } | null>();
    return updated
      ? json({
          qualifiedStageKeys: updated.qualifiedStageKeys,
          revision: updated.revision,
        })
      : conflict();
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) return conflict();
    return unavailable();
  }
}
