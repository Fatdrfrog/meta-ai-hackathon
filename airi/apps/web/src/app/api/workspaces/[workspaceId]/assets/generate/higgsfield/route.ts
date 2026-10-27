import {
  queueVideoGeneration,
  VideoGenerationQueueError,
  type VideoProviderPolicy,
} from "@/lib/creative-assets/video-generation-queue";
import { videoGenerationQueueErrorResponse } from "@/lib/creative-assets/video-generation-http";
import { CreativeGenerationAdmissionBusyError } from "@/lib/creative-assets/creative-generation-admission";
import {
  expandStudioSkillPrompt,
  type StudioSkillId,
} from "@/lib/creative-assets/studio-skill-prompts";
import {
  resolveWorkspaceGoogleCreativeCredentials,
  OwnCreativeAiSourceRequiredError,
} from "@/lib/google/creative-credentials";
import {
  getGoogleImageGenerationModel,
  submitGoogleImageGeneration,
} from "@/lib/google/creative-assets";
import {
  serializeCreativeAssetForResponse,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import { storeCreativeAssetBuffer } from "@/lib/higgsfield/creative-asset-storage";
import { buildHiggsfieldGenerationRequest } from "@/lib/higgsfield/higgsfield-client";
import { resolveWorkspaceHiggsfieldGenerationAccess } from "@/lib/higgsfield/higgsfield-source";
import { isHiggsfieldWebhookConfigured } from "@/lib/higgsfield/higgsfield-webhook";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import {
  isTemporalConfigured,
  startHiggsfieldAssetGenerationWorkflow,
} from "@/lib/temporal/higgsfield-assets";
import { CreativeAsset } from "@/models/creative-asset";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const legacyImageBodySchema = z.object({
  mode: z.literal("text_to_image").optional(),
  prompt: z.string().trim().min(3).max(1200),
  aspectRatio: z.string().trim().max(16).optional(),
  resolution: z.string().trim().max(24).optional(),
  duration: z.union([z.number(), z.string()]).optional(),
  sourceAssetId: z.string().trim().max(80).optional(),
  skill: z.enum(["image", "banner"]).optional(),
});

const videoBodySchema = z.object({
  mode: z.literal("image_to_video"),
  prompt: z.string().min(3).max(1200),
  aspectRatio: z.string().trim().max(16).optional(),
  resolution: z.string().trim().max(24).optional(),
  duration: z.union([z.number(), z.string()]).optional(),
  sourceAssetId: z.string().trim().max(80),
  skill: z.literal("video").optional(),
});

const RFC_4122_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseVideoDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : Number(value);
}

type ExistingVideoGeneration = {
  providerSourceId?: string | null;
  generation?: {
    contractVersion?: number;
    spec?: { provider?: string };
  } | null;
};

function replayProviderPolicy(
  asset: ExistingVideoGeneration | null
): VideoProviderPolicy | null {
  if (asset?.generation?.contractVersion !== 1) return null;
  const provider = asset.generation.spec?.provider;
  if (provider === "google")
    return {
      provider: "google",
      providerSourceId: asset.providerSourceId || "",
    };
  if (provider === "higgsfield" && asset.providerSourceId) {
    return {
      provider: "higgsfield",
      providerSourceId: asset.providerSourceId,
    };
  }
  throw new VideoGenerationQueueError(
    409,
    "idempotency_key_conflict",
    "Idempotency-Key was already used by another video generation endpoint"
  );
}

async function queueVideoGenerationResponse(input: {
  workspaceId: string;
  createdBy: string | null;
  idempotencyKey: string;
  providerPolicy: VideoProviderPolicy;
  body: z.infer<typeof videoBodySchema>;
}): Promise<NextResponse> {
  const duration = parseVideoDuration(input.body.duration);
  const requestRecipe =
    input.providerPolicy.provider === "higgsfield"
      ? {
          mode: "image_to_video" as const,
          prompt: input.body.prompt,
          skill: "video" as const,
          durationSeconds: duration ?? 5,
          aspectRatio: input.body.aspectRatio ?? null,
          resolution: input.body.resolution ?? "provider_default",
          sourceAssetId: input.body.sourceAssetId,
          referenceAssetIds: [],
        }
      : {
          mode: "image_to_video" as const,
          prompt: input.body.prompt,
          skill: "video" as const,
          durationSeconds: duration ?? 6,
          aspectRatio: input.body.aspectRatio ?? "9:16",
          resolution: input.body.resolution ?? "720p",
          sourceAssetId: input.body.sourceAssetId,
          referenceAssetIds: [],
        };
  const result = await queueVideoGeneration({
    workspaceId: input.workspaceId,
    createdBy: input.createdBy,
    idempotencyKey: input.idempotencyKey,
    providerPolicy: input.providerPolicy,
    request: requestRecipe,
  });

  return NextResponse.json(
    {
      success: true,
      asset: await serializeCreativeAssetForResponse(
        result.asset as LeanCreativeAsset
      ),
      generationProvider: input.providerPolicy.provider,
    },
    { status: 202 }
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await requireWorkspaceApiAccess(workspaceId);
    if (!access.ok) return access.response;

    const bodyResult = await readJsonBodyOrResponse(request);
    if (!bodyResult.ok) return bodyResult.response;
    const rawBody = bodyResult.body;

    const isVideoRequest =
      typeof rawBody === "object" &&
      rawBody !== null &&
      (rawBody as { mode?: unknown }).mode === "image_to_video";
    const parsedBody = isVideoRequest
      ? videoBodySchema.safeParse(rawBody)
      : legacyImageBodySchema.safeParse(rawBody);
    if (!parsedBody.success) return zodErrorResponse(parsedBody.error);

    const idempotencyKey = isVideoRequest
      ? request.headers.get("Idempotency-Key") || ""
      : "";
    if (isVideoRequest) {
      if (!RFC_4122_UUID.test(idempotencyKey)) {
        return NextResponse.json(
          {
            error: "Idempotency-Key must be an RFC-4122 UUID",
            code: "invalid_idempotency_key",
          },
          { status: 400 }
        );
      }
    }

    let existingProviderPolicy: VideoProviderPolicy | null = null;
    if (isVideoRequest) {
      await connectDB();
      const existingVideoGeneration = (await CreativeAsset.findOne({
        workspaceId,
        "generation.requestIdempotencyKey": idempotencyKey,
      }).lean()) as ExistingVideoGeneration | null;
      existingProviderPolicy = replayProviderPolicy(existingVideoGeneration);
      if (existingProviderPolicy) {
        return queueVideoGenerationResponse({
          workspaceId,
          createdBy: access.userId || null,
          idempotencyKey,
          providerPolicy: existingProviderPolicy,
          body: parsedBody.data as z.infer<typeof videoBodySchema>,
        });
      }
    }

    const temporalConfigured = isTemporalConfigured();
    if (isVideoRequest && !temporalConfigured) {
      return NextResponse.json(
        { error: "Temporal is not configured for video generation" },
        { status: 503 }
      );
    }

    const higgsfieldAccess = await resolveWorkspaceHiggsfieldGenerationAccess({
      supabase: access.supabase,
      workspaceId,
    });
    if (!isVideoRequest) await connectDB();
    const canUseWorkspaceHiggsfield =
      higgsfieldAccess.available &&
      higgsfieldAccess.credentialSource === "workspace_source" &&
      isHiggsfieldWebhookConfigured() &&
      temporalConfigured;
    const googleCredentials = canUseWorkspaceHiggsfield
      ? null
      : await resolveWorkspaceGoogleCreativeCredentials({
          supabase: access.supabase,
          workspaceId,
        });

    if (isVideoRequest) {
      const body = parsedBody.data as z.infer<typeof videoBodySchema>;
      const providerPolicy: VideoProviderPolicy = canUseWorkspaceHiggsfield
        ? {
            provider: "higgsfield" as const,
            providerSourceId: higgsfieldAccess.sourceId || "",
          }
        : {
            provider: "google" as const,
            providerSourceId: googleCredentials!.sourceId,
          };
      return queueVideoGenerationResponse({
        workspaceId,
        createdBy: access.userId || null,
        idempotencyKey,
        providerPolicy,
        body,
      });
    }

    const body = parsedBody.data as z.infer<typeof legacyImageBodySchema>;
    const aspectRatio = body.aspectRatio || "9:16";
    const resolution = body.resolution || "720p";
    const skill: StudioSkillId = body.skill === "banner" ? "banner" : "image";
    const { modelPrompt } = expandStudioSkillPrompt({
      skill,
      variables: {
        user_prompt: body.prompt,
        aspect_ratio: aspectRatio,
        resolution,
        mode: "text_to_image",
      },
      maxLength: 1200,
    });
    const providerPayload = { skill, skillPromptApplied: true };

    if (!canUseWorkspaceHiggsfield) {
      const asset = await CreativeAsset.create({
        _id: String(new Types.ObjectId()),
        workspaceId,
        kind: "image",
        source: "google",
        provider: "google",
        status: "queued",
        prompt: body.prompt,
        modelId: getGoogleImageGenerationModel(),
        sourceAssetId: null,
        providerSourceId: googleCredentials!.sourceId,
        providerPayload,
        createdBy: access.userId || null,
        updatedBy: access.userId || null,
      });
      const assetId = String(asset._id);
      try {
        const generated = await submitGoogleImageGeneration({
          apiKey: googleCredentials!.apiKey,
          prompt: modelPrompt,
          aspectRatio,
        });
        const stored = await storeCreativeAssetBuffer({
          storageClient: access.supabase,
          workspaceId,
          assetId,
          kind: "image",
          buffer: generated.buffer,
          mimeType: generated.mimeType,
          fileName: generated.fileName,
        });
        const updated =
          (await CreativeAsset.findByIdAndUpdate(
            assetId,
            {
              status: "complete",
              url: stored.url,
              storageProvider: stored.storageProvider,
              bucket: stored.bucket,
              path: stored.path,
              mimeType: stored.mimeType,
              fileName: stored.fileName,
              fileSize: stored.fileSize,
              providerPayload: generated.raw,
              error: null,
              completedAt: new Date(),
              updatedBy: access.userId || null,
            },
            { new: true }
          )) || asset;
        return NextResponse.json(
          {
            success: true,
            asset: await serializeCreativeAssetForResponse(updated),
            generationProvider: "google",
          },
          { status: 201 }
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate image with Google";
        const updated =
          (await CreativeAsset.findByIdAndUpdate(
            assetId,
            {
              status: "failed",
              error: message,
              updatedBy: access.userId || null,
            },
            { new: true }
          )) || asset;
        return NextResponse.json(
          {
            error: message,
            asset: await serializeCreativeAssetForResponse(updated),
          },
          { status: 502 }
        );
      }
    }

    const requestShape = buildHiggsfieldGenerationRequest({
      mode: "text_to_image",
      prompt: modelPrompt,
      aspectRatio,
      resolution,
    });
    const asset = await CreativeAsset.create({
      workspaceId,
      kind: "image",
      source: "higgsfield",
      provider: "higgsfield",
      status: "queued",
      prompt: body.prompt,
      modelId: requestShape.modelId,
      sourceAssetId: null,
      providerSourceId: higgsfieldAccess.sourceId,
      providerPayload,
      createdBy: access.userId || null,
      updatedBy: access.userId || null,
    });
    const assetId = String(asset._id);
    try {
      await startHiggsfieldAssetGenerationWorkflow({
        workspaceId,
        assetId,
        mode: "text_to_image",
        prompt: modelPrompt,
        aspectRatio,
        resolution,
        imageUrl: "",
        duration: 5,
        sourceAssetId: null,
        providerSourceId: higgsfieldAccess.sourceId,
      });
      return NextResponse.json(
        {
          success: true,
          asset: await serializeCreativeAssetForResponse(asset),
        },
        { status: 202 }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start Higgsfield generation";
      const updated =
        (await CreativeAsset.findByIdAndUpdate(
          assetId,
          {
            status: "failed",
            error: message,
            updatedBy: access.userId || null,
          },
          { new: true }
        )) || asset;
      return NextResponse.json(
        {
          error: message,
          asset: await serializeCreativeAssetForResponse(updated),
        },
        { status: 502 }
      );
    }
  } catch (error) {
    if (error instanceof OwnCreativeAiSourceRequiredError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 403 }
      );
    if (error instanceof CreativeGenerationAdmissionBusyError) {
      return NextResponse.json(
        {
          error:
            "Creative generation is busy. Retry with the same Idempotency-Key.",
          code: "generation_admission_busy",
        },
        { status: 503, headers: { "Retry-After": "1" } }
      );
    }
    if (error instanceof VideoGenerationQueueError) {
      return videoGenerationQueueErrorResponse(error);
    }
    return NextResponse.json(
      { error: "Failed to start Higgsfield generation" },
      { status: 500 }
    );
  }
}
