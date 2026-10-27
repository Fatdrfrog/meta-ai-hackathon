import { executeGeneratedBulkSend } from "@/lib/campaign/generated-bulk-send-orchestrator";
import { BulkCampaignIdempotencyKeySchema } from "@/lib/campaign/bulk-campaign-contracts";
import { normalizeBulkSendScheduledAt } from "@/lib/campaign/bulk-send-schedule";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";

type Params = Promise<{ workspaceId: string }>;

const SendBodySchema = z
  .object({
    scenarioId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    acknowledgeMediaFailures: z.boolean().optional(),
    audienceConfirmationFingerprint: z.string().nullable().optional(),
    scheduledAt: z.string().nullable().optional(),
  })
  .strict();

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const rawBody: unknown = await request.json().catch(() => null);
  const parsedBody = SendBodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", operationDisposition: "not_started" },
      { status: 400 }
    );
  }
  const body = parsedBody.data;
  const scenarioId = readStringOrEmpty(body.scenarioId, { trim: true });
  if (!Types.ObjectId.isValid(scenarioId)) {
    return NextResponse.json(
      { error: "Invalid scenarioId", operationDisposition: "not_started" },
      { status: 400 }
    );
  }
  const fingerprint = readStringOrEmpty(body.audienceConfirmationFingerprint, {
    trim: true,
  });
  if (fingerprint && !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    return NextResponse.json(
      {
        error: "Invalid audience confirmation fingerprint",
        operationDisposition: "not_started",
      },
      { status: 400 }
    );
  }
  const idempotencyKeyWasProvided = Object.prototype.hasOwnProperty.call(
    body,
    "idempotencyKey"
  );
  const idempotencyKey = readStringOrEmpty(body.idempotencyKey, { trim: true });
  if (
    idempotencyKeyWasProvided &&
    !BulkCampaignIdempotencyKeySchema.safeParse(idempotencyKey).success
  ) {
    return NextResponse.json(
      {
        error: "idempotencyKey must be between 8 and 128 characters",
        operationDisposition: "not_started",
      },
      { status: 400 }
    );
  }

  const scheduledAtWasProvided = Object.prototype.hasOwnProperty.call(
    body,
    "scheduledAt"
  );
  const schedule = scheduledAtWasProvided
    ? normalizeBulkSendScheduledAt(body.scheduledAt, { requireFuture: false })
    : null;
  if (schedule && !schedule.ok) {
    return NextResponse.json(
      { error: schedule.error, operationDisposition: "not_started" },
      { status: 400 }
    );
  }

  const result = await executeGeneratedBulkSend({
    workspaceId,
    scenarioId,
    userId: access.userId,
    requestUrl: request.url,
    idempotencyKey: idempotencyKey || null,
    acknowledgeMediaFailures: body.acknowledgeMediaFailures === true,
    audienceConfirmationFingerprint: fingerprint || null,
    ...(schedule?.ok ? { scheduledAt: schedule.scheduledAtIso } : {}),
  });
  return NextResponse.json(result.body, {
    status: result.status,
    ...(result.headers ? { headers: result.headers } : {}),
  });
}
