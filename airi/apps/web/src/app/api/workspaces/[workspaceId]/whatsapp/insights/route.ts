import {
  enableWhatsAppTemplateInsights,
  type WhatsAppInsightsActivationOutcome,
} from "@/lib/analytics/whatsapp-insights-activation";
import { logger } from "@/lib/logger";
import { isCompanyAdminRole } from "@/lib/supabase/company-users";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { NextResponse } from "next/server";
import { getWorkspaceMemberRole } from "@/lib/supabase/queries";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

async function readWorkspaceAdminAccess(workspaceId: string) {
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access;
  const role = await getWorkspaceMemberRole(
    access.supabase,
    access.userId,
    workspaceId
  );
  return { ...access, canManage: isCompanyAdminRole(role) };
}

/** Whether the viewer may enable template insights (owners and admins). */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await context.params;
  const access = await readWorkspaceAdminAccess(workspaceId);
  if (!access.ok) return access.response;
  return NextResponse.json(
    { canManage: access.canManage },
    { headers: noStore }
  );
}

const STATUS_BY_OUTCOME: Record<WhatsAppInsightsActivationOutcome, number> = {
  enabled: 200,
  already_enabled: 200,
  would_enable: 200,
  not_found: 404,
  not_connected: 409,
  permission_required: 409,
  busy: 409,
  unsupported: 422,
  rate_limited: 429,
  unavailable: 503,
};

/**
 * Enables Meta template analytics for one WhatsApp source's WABA. Meta keeps it
 * on permanently, so only owners/admins may call this, after confirming.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await context.params;
  const access = await readWorkspaceAdminAccess(workspaceId);
  if (!access.ok) return access.response;
  if (!access.canManage)
    return NextResponse.json(
      { error: "Workspace admin role required" },
      { status: 403, headers: noStore }
    );
  const body: unknown = await request.json().catch(() => null);
  const sourceId =
    body && typeof body === "object" && "sourceId" in body
      ? body.sourceId
      : null;
  if (typeof sourceId !== "string" || !sourceId.trim() || sourceId.length > 128)
    return NextResponse.json(
      { error: "sourceId is required" },
      { status: 400, headers: noStore }
    );
  try {
    const result = await enableWhatsAppTemplateInsights({
      workspaceId,
      sourceId: sourceId.trim(),
    });
    logger.info("whatsapp.template_insights_activation", {
      event: "whatsapp.template_insights_activation",
      workspaceId,
      sourceId: result.sourceId,
      accountKey: result.accountKey,
      outcome: result.outcome,
      userId: access.userId,
    });
    return NextResponse.json(
      {
        outcome: result.outcome,
        sourceId: result.sourceId,
        cooldownUntil: result.cooldownUntil ?? null,
      },
      { status: STATUS_BY_OUTCOME[result.outcome], headers: noStore }
    );
  } catch (error) {
    logger.warn("whatsapp.template_insights_activation_failed", {
      event: "whatsapp.template_insights_activation_failed",
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { outcome: "unavailable", error: "Template insights unavailable" },
      { status: 503, headers: noStore }
    );
  }
}
