import type {
  HiggsfieldProviderLifecycleStatus,
  VideoGenerationStatusSignal,
} from "@icecore/temporal";
import { sanitizeVideoProviderPayload } from "@icecore/shared/lib/video-provider-payload";
import {
  JsonBodyTooLargeError,
  readJsonBodyWithinLimit,
} from "@/lib/api/json-body";
import {
  isHiggsfieldWebhookConfigured,
  verifyHiggsfieldWebhookToken,
} from "@/lib/higgsfield/higgsfield-webhook";
import {
  buildVideoGenerationNsfwAliasFilter,
  buildVideoGenerationNsfwUpdatePipeline,
} from "@/lib/creative-assets/video-generation-nsfw";
import {
  markVideoGenerationNsfwVerdictSweepCompleted,
  recordVideoGenerationNsfwVerdict,
} from "@/lib/creative-assets/video-generation-nsfw-verdict-store";
import connectDB from "@/lib/mongoose";
import { signalHiggsfieldAssetGenerationWorkflow } from "@/lib/temporal/higgsfield-assets";
import { signalVideoGenerationWorkflow } from "@/lib/temporal/video-generation";
import { CreativeAsset } from "@/models/creative-asset";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import {
  asRecord,
  readTrimmedString as asString,
} from "@icecore/shared/lib/value-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_WEBHOOK_SIGNAL_KEYS = 6;
const MAX_HIGGSFIELD_WEBHOOK_BYTES = 256 * 1024;

type HiggsfieldWebhookAsset = {
  _id: unknown;
  workspaceId?: string;
  status?: string;
  providerRequestId?: string | null;
  providerStatusUrl?: string | null;
  generation?: {
    contractVersion?: number;
    webhookSignalKeys?: string[];
    spec?: { provider?: string };
    orchestration?: { workflowId?: string };
    submission?: {
      state?: string;
      attemptToken?: string;
      providerRequestId?: string | null;
      submittedAt?: Date | null;
    };
  } | null;
};

function normalizeStatus(value: unknown): HiggsfieldProviderLifecycleStatus {
  const status = asString(value).toLowerCase();
  return status === "completed" ||
    status === "failed" ||
    status === "nsfw" ||
    status === "in_progress" ||
    status === "cancelled"
    ? status
    : "queued";
}

function parseVideoGenerationStatus(
  value: unknown
): VideoGenerationStatusSignal["status"] | null {
  const status = asString(value).toLowerCase();
  return status === "queued" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "failed" ||
    status === "nsfw" ||
    status === "cancelled"
    ? status
    : null;
}

function isTerminalAssetStatus(value: unknown): boolean {
  return value === "complete" || value === "failed" || value === "nsfw";
}

function hasWebhookSignalKey(
  asset: HiggsfieldWebhookAsset,
  signalKey: string
): boolean {
  return (
    Array.isArray(asset.generation?.webhookSignalKeys) &&
    asset.generation.webhookSignalKeys.includes(signalKey)
  );
}

function appendWebhookSignalKey(signalKey: string): Record<string, unknown> {
  return {
    $let: {
      vars: {
        keys: {
          $ifNull: ["$generation.webhookSignalKeys", []],
        },
      },
      in: {
        $slice: [
          {
            $cond: [
              {
                $in: [{ $literal: signalKey }, "$$keys"],
              },
              "$$keys",
              {
                $concatArrays: ["$$keys", { $literal: [signalKey] }],
              },
            ],
          },
          -MAX_WEBHOOK_SIGNAL_KEYS,
        ],
      },
    },
  };
}

function lateSubmissionFailure(
  strictStatus: VideoGenerationStatusSignal["status"],
  receivedAt: Date
): Record<string, unknown> | null {
  if (strictStatus === "failed" || strictStatus === "cancelled") {
    const cancelled = strictStatus === "cancelled";
    return {
      phase: "poll",
      code: cancelled ? "provider_cancelled" : "provider_failed",
      providerCode: strictStatus,
      message: cancelled
        ? "Provider cancelled the video generation"
        : "Provider failed the video generation",
      retryable: true,
      submissionUncertain: false,
      failedAt: receivedAt,
    };
  }
  return {
    phase: "poll",
    code: "provider_result_recovery_required",
    providerCode: strictStatus,
    message:
      "The provider accepted the request; resume the existing result without submitting again",
    retryable: true,
    submissionUncertain: false,
    failedAt: receivedAt,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isHiggsfieldWebhookConfigured()) {
      return NextResponse.json(
        { error: "Higgsfield webhook is not configured" },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const assetId = asString(url.searchParams.get("assetId"));
    const token = asString(url.searchParams.get("token"));

    if (!assetId) {
      return NextResponse.json({ error: "Missing asset id" }, { status: 400 });
    }
    if (!Types.ObjectId.isValid(assetId)) {
      return NextResponse.json({ error: "Invalid asset id" }, { status: 400 });
    }
    if (!verifyHiggsfieldWebhookToken(assetId, token)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let rawBody: unknown;
    try {
      rawBody = await readJsonBodyWithinLimit(
        request,
        MAX_HIGGSFIELD_WEBHOOK_BYTES
      );
    } catch (error) {
      if (error instanceof JsonBodyTooLargeError) {
        return NextResponse.json(
          { error: "Higgsfield webhook payload is too large" },
          { status: 413 }
        );
      }
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return NextResponse.json(
        { error: "Webhook payload must be an object" },
        { status: 400 }
      );
    }

    const payload = asRecord(rawBody);
    const requestId = asString(payload.request_id);
    const providerStatus = normalizeStatus(payload.status);

    await connectDB();
    let asset = await CreativeAsset.findOne({
      _id: assetId,
    }).lean<HiggsfieldWebhookAsset | null>();

    if (!asset) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    const contractV1 = asset.generation?.contractVersion === 1;
    const nestedRequestId = asString(
      asset.generation?.submission?.providerRequestId
    );
    const topLevelRequestId = asString(asset.providerRequestId);
    const providerRequestLocator = asString(asset.providerStatusUrl);
    const persistedRequestIds = contractV1
      ? [nestedRequestId, topLevelRequestId, providerRequestLocator].filter(
          Boolean
        )
      : [topLevelRequestId].filter(Boolean);

    if (
      requestId &&
      persistedRequestIds.some(
        persistedRequestId => requestId !== persistedRequestId
      )
    ) {
      return NextResponse.json(
        { error: "Higgsfield request id mismatch" },
        { status: 409 }
      );
    }

    if (contractV1) {
      if (asset.generation?.spec?.provider !== "higgsfield") {
        return NextResponse.json(
          { error: "Asset is not a Higgsfield video generation" },
          { status: 409 }
        );
      }
      if (!requestId || requestId.length > 500) {
        return NextResponse.json(
          { error: "Missing or invalid Higgsfield request id" },
          { status: 400 }
        );
      }
      const strictStatus = parseVideoGenerationStatus(payload.status);
      if (!strictStatus) {
        return NextResponse.json(
          { error: "Unknown Higgsfield generation status" },
          { status: 400 }
        );
      }
      const signalKey = `${requestId}:${strictStatus}`;
      const workspaceId = asString(asset.workspaceId);
      const attemptToken = asString(asset.generation?.submission?.attemptToken);
      const workflowId = asString(asset.generation?.orchestration?.workflowId);
      if (!workspaceId || !attemptToken || !workflowId) {
        return NextResponse.json(
          { error: "Video generation orchestration state is incomplete" },
          { status: 409 }
        );
      }
      const receivedAt = new Date();
      const sanitizedPayload = sanitizeVideoProviderPayload(payload);
      const nsfwVerdict =
        strictStatus === "nsfw"
          ? await recordVideoGenerationNsfwVerdict({
              workspaceId,
              providerRequestId: requestId,
              sourceAssetId: assetId,
              sourceAttemptToken: attemptToken,
              receivedAt,
            })
          : null;
      const submissionState = asString(asset.generation?.submission?.state);
      const ambiguousSubmission =
        !nestedRequestId &&
        !topLevelRequestId &&
        (!providerRequestLocator || providerRequestLocator === requestId) &&
        (submissionState === "dispatching" || submissionState === "unknown");
      let adoptedLateRequest = false;

      if (ambiguousSubmission) {
        const existingStatus = asString(asset.status);
        const definitiveFailure =
          strictStatus === "failed" || strictStatus === "cancelled";
        const failedRecovery =
          existingStatus === "failed" && !definitiveFailure;
        const nextStatus = definitiveFailure
          ? "failed"
          : failedRecovery
            ? "failed"
            : strictStatus === "queued"
              ? "queued"
              : "in_progress";
        const nextFailure =
          definitiveFailure || failedRecovery
            ? lateSubmissionFailure(strictStatus, receivedAt)
            : null;
        const adoption = await CreativeAsset.updateOne(
          {
            _id: assetId,
            workspaceId,
            status: existingStatus,
            providerRequestId: null,
            providerStatusUrl: providerRequestLocator || null,
            "generation.contractVersion": 1,
            "generation.spec.provider": "higgsfield",
            "generation.submission.state": submissionState,
            "generation.submission.attemptToken": attemptToken,
            "generation.submission.providerRequestId": null,
          },
          [
            {
              $set: {
                status: nextStatus,
                providerRequestId: requestId,
                providerStatusUrl: requestId,
                providerPayload: { $literal: sanitizedPayload },
                "generation.submission.state": "submitted",
                "generation.submission.providerRequestId": requestId,
                "generation.submission.submittedAt": receivedAt,
                "generation.webhookSignalKeys":
                  appendWebhookSignalKey(signalKey),
                "generation.failure": nextFailure,
                error: nextFailure?.message ?? null,
                updatedAt: receivedAt,
              },
            },
          ]
        );
        adoptedLateRequest = adoption.matchedCount === 1;
        if (!adoptedLateRequest) {
          const winner = await CreativeAsset.findOne({
            _id: assetId,
            workspaceId,
            "generation.contractVersion": 1,
            "generation.spec.provider": "higgsfield",
            "generation.submission.attemptToken": attemptToken,
            "generation.submission.providerRequestId": requestId,
            providerRequestId: requestId,
            providerStatusUrl: requestId,
          }).lean<HiggsfieldWebhookAsset | null>();
          if (!winner) {
            return NextResponse.json(
              {
                error:
                  "Video generation state changed before request identity adoption",
              },
              { status: 409 }
            );
          }
          asset = winner;
        }
      }

      if (
        strictStatus !== "nsfw" &&
        !adoptedLateRequest &&
        (isTerminalAssetStatus(asset.status) ||
          hasWebhookSignalKey(asset, signalKey))
      ) {
        return NextResponse.json({ status: "ok", duplicate: true });
      }

      const persisted =
        strictStatus === "nsfw"
          ? await CreativeAsset.updateMany(
              {
                ...buildVideoGenerationNsfwAliasFilter({
                  workspaceId,
                  providerRequestId: requestId,
                  sourceAssetId: assetId,
                  sourceAttemptToken: attemptToken,
                }),
                status: {
                  $in: ["queued", "in_progress", "complete", "failed"],
                },
              },
              buildVideoGenerationNsfwUpdatePipeline({
                providerRequestId: requestId,
                receivedAt,
                providerPayload: sanitizedPayload,
              })
            )
          : adoptedLateRequest
            ? { matchedCount: 1, modifiedCount: 1 }
            : await CreativeAsset.updateOne(
                {
                  _id: assetId,
                  workspaceId,
                  status: { $in: ["queued", "in_progress"] },
                  "generation.contractVersion": 1,
                  "generation.webhookSignalKeys": { $nin: [signalKey] },
                  [`generation.webhookSignalKeys.${MAX_WEBHOOK_SIGNAL_KEYS}`]: {
                    $exists: false,
                  },
                  "generation.submission.attemptToken": attemptToken,
                  "generation.submission.providerRequestId": requestId,
                },
                {
                  $set: {
                    providerPayload: sanitizedPayload,
                    updatedAt: receivedAt,
                  },
                  $addToSet: {
                    "generation.webhookSignalKeys": signalKey,
                  },
                }
              );
      if (nsfwVerdict) {
        await markVideoGenerationNsfwVerdictSweepCompleted({
          markerId: nsfwVerdict._id,
          workspaceId,
          providerRequestId: requestId,
          completedAt: receivedAt,
        });
      }
      if (persisted.matchedCount === 0) {
        const winner = await CreativeAsset.findOne({
          _id: assetId,
          workspaceId,
          "generation.contractVersion": 1,
          "generation.submission.attemptToken": attemptToken,
          "generation.submission.providerRequestId": requestId,
        }).lean<HiggsfieldWebhookAsset | null>();
        if (
          winner &&
          ((strictStatus === "nsfw" && winner.status === "nsfw") ||
            (strictStatus !== "nsfw" &&
              (isTerminalAssetStatus(winner.status) ||
                hasWebhookSignalKey(winner, signalKey))))
        ) {
          return NextResponse.json({ status: "ok", duplicate: true });
        }
        return NextResponse.json(
          {
            error: "Video generation state changed before webhook persistence",
          },
          { status: 409 }
        );
      }

      try {
        await signalVideoGenerationWorkflow({
          workflowId,
          signal: {
            contractVersion: 1,
            assetId,
            providerRequestId: requestId,
            status: strictStatus,
            receivedAt: receivedAt.toISOString(),
          },
        });
      } catch {
        return NextResponse.json(
          { status: "accepted", deferred: true },
          { status: 202 }
        );
      }

      return NextResponse.json({ status: "ok" });
    }

    if (asset.status === "complete") {
      return NextResponse.json({ status: "ok", duplicate: true });
    }

    try {
      await signalHiggsfieldAssetGenerationWorkflow({
        assetId,
        webhook: {
          requestId: requestId || null,
          status: providerStatus,
          payload,
          receivedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to signal Higgsfield workflow",
        },
        { status: 503 }
      );
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process Higgsfield webhook",
      },
      { status: 500 }
    );
  }
}
