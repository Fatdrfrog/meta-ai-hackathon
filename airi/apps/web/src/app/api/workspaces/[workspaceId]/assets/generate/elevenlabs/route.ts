import { expandStudioSkillPrompt } from "@/lib/creative-assets/studio-skill-prompts";
import {
  resolveCreativeAssetDisplayUrl,
  serializeCreativeAssetForResponse,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import {
  startElevenLabsDubbing,
  submitElevenLabsSoundEffect,
  submitElevenLabsTextToSpeech,
} from "@/lib/elevenlabs/creative-assets";
import { resolveWorkspaceElevenLabsGenerationAccess } from "@/lib/elevenlabs/elevenlabs-source";
import { storeCreativeAssetBuffer } from "@/lib/higgsfield/creative-asset-storage";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { startElevenLabsCreativeTranscriptionWorkflow } from "@/lib/temporal/elevenlabs-creative-transcription";
import { CreativeAsset, type CreativeAssetKind } from "@/models/creative-asset";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBodyOrResponse, zodErrorResponse } from "@/lib/api/json-body";
import { cleanString } from "@icecore/shared/lib/value-utils";

type Params = Promise<{ workspaceId: string }>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const elevenLabsBodySchema = z.object({
  mode: z.enum([
    "text_to_speech",
    "sound_effect",
    "transcript",
    "subtitles",
    "dub",
  ]),
  text: z.string().trim().max(2500).optional(),
  prompt: z.string().trim().max(1000).optional(),
  sourceAssetId: z.string().trim().max(80).optional(),
  targetLanguage: z.string().trim().max(24).optional(),
  sourceLanguage: z.string().trim().max(24).optional(),
  voiceId: z.string().trim().max(200).optional(),
  duration: z.union([z.number(), z.string()]).optional(),
});

function clampDuration(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(30, Math.max(0.5, Math.round(parsed * 10) / 10));
}

function sourceAssetTitle(asset: {
  fileName?: string | null;
  prompt?: string | null;
  _id?: unknown;
}): string {
  return (
    cleanString(asset.fileName, 120) ||
    cleanString(asset.prompt, 120) ||
    String(asset._id || "asset")
  );
}

async function loadCompleteSourceAsset(params: {
  workspaceId: string;
  sourceAssetId: string;
  allowedKinds: CreativeAssetKind[];
}) {
  if (!Types.ObjectId.isValid(params.sourceAssetId)) {
    throw new Error("Invalid source asset id");
  }

  return CreativeAsset.findOne({
    _id: params.sourceAssetId,
    workspaceId: params.workspaceId,
    kind: { $in: params.allowedKinds },
    status: "complete",
  }).lean<LeanCreativeAsset | null>();
}

async function createQueuedAsset(params: {
  workspaceId: string;
  kind: CreativeAssetKind;
  prompt: string;
  modelId: string;
  sourceAssetId?: string | null;
  providerSourceId: string;
  userId: string | null;
  providerPayload?: unknown;
}) {
  return CreativeAsset.create({
    workspaceId: params.workspaceId,
    kind: params.kind,
    source: "elevenlabs",
    provider: "elevenlabs",
    status: "queued",
    prompt: params.prompt,
    modelId: params.modelId,
    sourceAssetId: params.sourceAssetId || null,
    providerSourceId: params.providerSourceId,
    providerPayload: params.providerPayload || null,
    createdBy: params.userId,
    updatedBy: params.userId,
  });
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

    const parsedBody = elevenLabsBodySchema.safeParse(bodyResult.body);
    if (!parsedBody.success) return zodErrorResponse(parsedBody.error);

    const body = parsedBody.data;
    await connectDB();

    const elevenLabsAccess = await resolveWorkspaceElevenLabsGenerationAccess({
      supabase: access.supabase,
      workspaceId,
    });
    if (
      !elevenLabsAccess.available ||
      elevenLabsAccess.credentialSource !== "workspace_source" ||
      !elevenLabsAccess.apiKey ||
      !elevenLabsAccess.sourceId
    ) {
      return NextResponse.json(
        {
          error:
            "Connect ElevenLabs in Settings > Integrations to create audio or transcriptions.",
          code: "own_ai_source_required",
          elevenLabsConfigured: false,
          elevenLabsDisabledReason:
            elevenLabsAccess.reason || "source_required",
        },
        { status: 403 }
      );
    }

    const apiKey = elevenLabsAccess.apiKey;
    const providerSourceId = elevenLabsAccess.sourceId;

    if (body.mode === "text_to_speech") {
      const text = cleanString(body.text, 2500);
      if (!text) {
        return NextResponse.json(
          { error: "Text is required for voiceover generation" },
          { status: 400 }
        );
      }

      const asset = await createQueuedAsset({
        workspaceId,
        kind: "audio",
        prompt: text,
        modelId: "elevenlabs-tts",
        providerSourceId,
        userId: access.userId || null,
      });
      const assetId = String(asset._id);

      try {
        const generated = await submitElevenLabsTextToSpeech({
          apiKey,
          text,
          voiceId: body.voiceId || elevenLabsAccess.defaultVoiceId,
          language: body.targetLanguage,
        });
        const stored = await storeCreativeAssetBuffer({
          storageClient: access.supabase,
          workspaceId,
          assetId,
          kind: "audio",
          buffer: generated.buffer,
          mimeType: generated.mimeType,
          fileName: generated.fileName,
        });
        const updated =
          (await CreativeAsset.findByIdAndUpdate(
            assetId,
            {
              status: "complete",
              modelId: generated.modelId,
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
            elevenLabsConfigured: true,
          },
          { status: 201 }
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate voiceover";
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

    if (body.mode === "sound_effect") {
      const userPrompt = cleanString(body.prompt || body.text, 1000);
      if (!userPrompt) {
        return NextResponse.json(
          { error: "Prompt is required for sound effect generation" },
          { status: 400 }
        );
      }
      const soundEffectDuration = clampDuration(body.duration);
      const { modelPrompt } = expandStudioSkillPrompt({
        skill: "audio",
        variables: {
          user_prompt: userPrompt,
          audio_mode: "sound_effect",
          duration_seconds: soundEffectDuration ?? undefined,
        },
        maxLength: 1000,
      });

      const asset = await createQueuedAsset({
        workspaceId,
        kind: "audio",
        prompt: userPrompt,
        modelId: "eleven_text_to_sound_v2",
        providerSourceId,
        userId: access.userId || null,
        providerPayload: {
          skill: "audio",
          audioMode: "sound_effect",
          skillPromptApplied: true,
        },
      });
      const assetId = String(asset._id);

      try {
        const generated = await submitElevenLabsSoundEffect({
          apiKey,
          prompt: modelPrompt,
          durationSeconds: clampDuration(body.duration),
        });
        const stored = await storeCreativeAssetBuffer({
          storageClient: access.supabase,
          workspaceId,
          assetId,
          kind: "audio",
          buffer: generated.buffer,
          mimeType: generated.mimeType,
          fileName: generated.fileName,
        });
        const updated =
          (await CreativeAsset.findByIdAndUpdate(
            assetId,
            {
              status: "complete",
              modelId: generated.modelId,
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
            elevenLabsConfigured: true,
          },
          { status: 201 }
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to generate sound effect";
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

    const sourceAssetId = cleanString(body.sourceAssetId, 80);
    if (!sourceAssetId) {
      return NextResponse.json(
        { error: "Source audio or video asset is required" },
        { status: 400 }
      );
    }
    if (!Types.ObjectId.isValid(sourceAssetId)) {
      return NextResponse.json(
        { error: "Invalid source asset id" },
        { status: 400 }
      );
    }

    const sourceAsset = await loadCompleteSourceAsset({
      workspaceId,
      sourceAssetId,
      allowedKinds: ["audio", "video"],
    });
    if (!sourceAsset?.url || !sourceAsset.kind) {
      return NextResponse.json(
        { error: "Source audio or video asset is not available" },
        { status: 400 }
      );
    }
    if (body.mode === "dub") {
      const targetLanguage = cleanString(body.targetLanguage, 24).toLowerCase();
      if (!targetLanguage) {
        return NextResponse.json(
          { error: "Target language is required for dubbing" },
          { status: 400 }
        );
      }
      const sourceAssetUrl = await resolveCreativeAssetDisplayUrl(sourceAsset);
      if (!sourceAssetUrl) {
        return NextResponse.json(
          { error: "Source audio or video asset is not available" },
          { status: 400 }
        );
      }

      const asset = await createQueuedAsset({
        workspaceId,
        kind: sourceAsset.kind,
        prompt: `Dub ${sourceAssetTitle(sourceAsset)} to ${targetLanguage}`,
        modelId: "elevenlabs-dubbing",
        sourceAssetId,
        providerSourceId,
        userId: access.userId || null,
        providerPayload: {
          mode: "dub",
          targetLanguage,
          sourceLanguage: cleanString(body.sourceLanguage, 24) || null,
        },
      });
      const assetId = String(asset._id);

      try {
        const dubbing = await startElevenLabsDubbing({
          apiKey,
          sourceUrl: sourceAssetUrl,
          targetLanguage,
          sourceLanguage: body.sourceLanguage,
          name: `Airi ${sourceAssetTitle(sourceAsset)}`,
        });
        const updated =
          (await CreativeAsset.findByIdAndUpdate(
            assetId,
            {
              status: "queued",
              providerRequestId: dubbing.dubbingId,
              providerPayload: {
                mode: "dub",
                targetLanguage,
                sourceLanguage: cleanString(body.sourceLanguage, 24) || null,
                start: dubbing.raw,
                expectedDurationSec: dubbing.expectedDurationSec,
              },
              error: null,
              updatedBy: access.userId || null,
            },
            { new: true }
          )) || asset;
        return NextResponse.json(
          {
            success: true,
            asset: await serializeCreativeAssetForResponse(updated),
            elevenLabsConfigured: true,
          },
          { status: 202 }
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to start dubbing";
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

    const transcriptLabel =
      body.mode === "subtitles" ? "Subtitles" : "Transcript";
    const asset = await createQueuedAsset({
      workspaceId,
      kind: "text",
      prompt: `${transcriptLabel} for ${sourceAssetTitle(sourceAsset)}`,
      modelId: "scribe_v2",
      sourceAssetId,
      providerSourceId,
      userId: access.userId || null,
      providerPayload: { mode: body.mode },
    });
    const assetId = String(asset._id);

    try {
      const mediaType = sourceAsset.kind as Extract<
        CreativeAssetKind,
        "audio" | "video"
      >;
      const workflow = await startElevenLabsCreativeTranscriptionWorkflow({
        workspaceId,
        assetId,
        sourceAssetId,
        mode: body.mode,
        mediaType,
        providerSourceId,
      });
      const updated =
        (await CreativeAsset.findByIdAndUpdate(
          assetId,
          {
            status: "queued",
            providerPayload: {
              mode: body.mode,
              workflowId: workflow.workflowId,
              taskQueue: workflow.taskQueue,
              duplicate: workflow.duplicate,
            },
            error: null,
            updatedBy: access.userId || null,
          },
          { new: true }
        )) || asset;
      return NextResponse.json(
        {
          success: true,
          asset: await serializeCreativeAssetForResponse(updated),
          elevenLabsConfigured: true,
        },
        { status: 202 }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to start media transcription workflow";
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
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start ElevenLabs generation",
      },
      { status: 500 }
    );
  }
}
