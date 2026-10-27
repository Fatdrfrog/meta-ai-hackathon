import {
  getCompanyConversationLimitSnapshot,
  toPublicLimitPayload,
} from "@/lib/limits/company-limits";
import { getWorkspaceTextAiAllowance } from "@/lib/ai/workspace-ai-policy";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { workspaceId } = await context.params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  try {
    // Live counts, so the WhatsApp panel's pre-check matches the connect gate.
    const snapshot = await getCompanyConversationLimitSnapshot(
      supabaseAdmin,
      workspaceId,
      { includeBulkRecipientUsage: true, liveCounts: true }
    );

    const payload = toPublicLimitPayload(snapshot);
    if (snapshot.subscriptionType !== "pro") return NextResponse.json(payload);

    // Preserve unrelated limit data when the hard-admission database is unavailable.
    // An unavailable balance must never be presented as zero usage or unlimited AI.
    const textAiAllowance = await getWorkspaceTextAiAllowance(workspaceId)
      .then(allowance => ({ status: "available" as const, ...allowance }))
      .catch(() => ({ status: "unavailable" as const }));
    return NextResponse.json({ ...payload, textAiAllowance });
  } catch (error) {
    console.error("[Workspace Limits API] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load workspace limits" },
      { status: 500 }
    );
  }
}
