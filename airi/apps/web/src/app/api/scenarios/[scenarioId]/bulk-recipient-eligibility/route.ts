import { bulkCampaignEligibilityErrorResponse } from "@/lib/campaign/bulk-campaign-eligibility-response";
import { previewGeneratedBulkCampaignEligibility } from "@/lib/campaign/generated-bulk-send-orchestrator";
import { logger } from "@/lib/logger";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = Promise<{ scenarioId: string }>;

const PreviewBodySchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    observedPlanRevision: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { scenarioId } = await params;
  const parsed = PreviewBodySchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success || !Types.ObjectId.isValid(scenarioId)) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  // Set once access is granted, so a failure is only attributed to a
  // workspace the caller may read.
  let workspaceId: string | null = null;
  try {
    const access = await requireWorkspaceApiAccess(parsed.data.workspaceId);
    if (!access.ok) return access.response;
    workspaceId = parsed.data.workspaceId;

    const result = await previewGeneratedBulkCampaignEligibility({
      workspaceId,
      scenarioId,
      ...(parsed.data.observedPlanRevision
        ? { observedPlanRevision: parsed.data.observedPlanRevision }
        : {}),
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // Answered like the recipient-eligibility route: a coded blocked body,
    // Retry-After for a Meta rate limit, and the real cause in the log.
    return bulkCampaignEligibilityErrorResponse(error, {
      logger,
      workspaceId,
      policy: { version: 1, excludePriorFailedBulkSends: false },
    });
  }
}
