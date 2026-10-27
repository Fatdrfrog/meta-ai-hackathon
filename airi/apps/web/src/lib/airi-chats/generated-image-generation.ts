import "server-only";

import { getGoogleImageGenerationModel } from "@/lib/google/creative-assets";
import { createHash } from "node:crypto";
import { withWorkspaceCreativeGenerationAdmission } from "@/lib/creative-assets/creative-generation-admission";
import { resolveWorkspaceGoogleCreativeCredentials } from "@/lib/google/creative-credentials";
import { supabaseAdmin } from "@/lib/supabase/admin";
import connectDB from "@/lib/mongoose";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import {
  isTemporalConfigured,
  startCreativeImageGenerationWorkflow,
} from "@/lib/temporal/creative-image-generation";
import { CreativeAsset } from "@/models/creative-asset";
import { Types } from "mongoose";
import { normalizeWhitespace } from "@icecore/shared/lib/value-utils";
import type { AiriGeneratedAssetAttachment } from "./generated-assets";

export type AiriImageGenerationTarget =
  | {
      kind: "chat_attachment";
    }
  | {
      kind: "whatsapp_template_header";
      templateArtifactId?: string | null;
      templateRevision?: number | null;
    };

export type QueuedAiriImageGeneration = {
  assetId: string;
  attachment: AiriGeneratedAssetAttachment;
};

const compactText = (value: string, maxLength: number) =>
  normalizeWhitespace(value).slice(0, maxLength);

function normalizeAspectRatio(value: string | null | undefined): string {
  const normalized = compactText(value || "", 16);
  return normalized || "9:16";
}

function targetMetadata(
  target: AiriImageGenerationTarget
): Record<string, unknown> {
  if (target.kind === "whatsapp_template_header") {
    return {
      target: target.kind,
      templateArtifactId: target.templateArtifactId || null,
      templateRevision:
        typeof target.templateRevision === "number"
          ? target.templateRevision
          : null,
    };
  }
  return { target: target.kind };
}

function attachmentFromAsset(params: {
  assetId: string;
  workspaceId: string;
  title: string;
  prompt: string;
  target: AiriImageGenerationTarget;
}): AiriGeneratedAssetAttachment {
  return {
    id: params.assetId,
    workspaceId: params.workspaceId,
    kind: "image",
    provider: "google",
    providerLabel: "Nano Banana",
    status: "queued",
    title: params.title,
    prompt: params.prompt,
    target: params.target.kind,
    ...(params.target.kind === "whatsapp_template_header"
      ? {
          templateArtifactId: params.target.templateArtifactId || null,
          templateRevision:
            typeof params.target.templateRevision === "number"
              ? params.target.templateRevision
              : null,
        }
      : {}),
  };
}

function airiImageGenerationClaimKey(params: {
  assetId: string;
  threadId: string;
  userMessageId?: string | null;
  prompt: string;
  aspectRatio: string;
  target: AiriImageGenerationTarget;
}): string {
  const userMessageId = compactText(params.userMessageId || "", 200);
  if (!userMessageId) return `airi-image:asset:${params.assetId}`;
  const targetIdentity =
    params.target.kind === "whatsapp_template_header"
      ? `${params.target.kind}:${params.target.templateArtifactId || ""}:${
          params.target.templateRevision ?? ""
        }`
      : params.target.kind;
  return [
    "airi-image",
    compactText(params.threadId, 200),
    userMessageId,
    targetIdentity,
    params.aspectRatio,
    params.prompt,
  ].join(":");
}

export async function createQueuedAiriImageGeneration(params: {
  workspaceId: string;
  userId: string;
  threadId: string;
  userMessageId?: string | null;
  title: string;
  prompt: string;
  aspectRatio?: string | null;
  target: AiriImageGenerationTarget;
}): Promise<QueuedAiriImageGeneration | null> {
  if (!isTemporalConfigured()) {
    return null;
  }

  const prompt = compactText(params.prompt, 1600);
  if (prompt.length < 3) return null;
  const title = compactText(params.title, 160) || "Generated image";
  const aspectRatio = normalizeAspectRatio(params.aspectRatio);
  await connectDB();
  const requestedAssetId = String(new Types.ObjectId());
  const credentials = await resolveWorkspaceGoogleCreativeCredentials({
    supabase: supabaseAdmin,
    workspaceId: params.workspaceId,
  });
  const generationClaimKey = createHash("sha256")
    .update(params.workspaceId)
    .update("\0")
    .update(
      airiImageGenerationClaimKey({
        assetId: requestedAssetId,
        threadId: params.threadId,
        userMessageId: params.userMessageId,
        prompt,
        aspectRatio,
        target: params.target,
      })
    )
    .digest("hex");
  const asset = await withWorkspaceCreativeGenerationAdmission(
    params.workspaceId,
    async () => {
      const identity = {
        _id: generationClaimKey.slice(0, 24),
        workspaceId: params.workspaceId,
        provider: "google",
        "providerPayload.airi.generationClaimKey": generationClaimKey,
      };
      const existing = await CreativeAsset.findOne(identity).lean();
      if (existing) return existing;
      return CreativeAsset.create({
        _id: identity._id,
        workspaceId: params.workspaceId,
        kind: "image",
        source: "google",
        provider: "google",
        status: "queued",
        prompt,
        modelId: getGoogleImageGenerationModel(),
        sourceAssetId: null,
        providerSourceId: credentials.sourceId,
        providerPayload: {
          airi: {
            generationClaimKey,
            threadId: params.threadId,
            userMessageId: params.userMessageId || null,
            title,
            ...targetMetadata(params.target),
          },
          providerAlias: "nano_banana",
          aspectRatio,
          requestedAt: new Date().toISOString(),
        },
        createdBy: params.userId || null,
        updatedBy: params.userId || null,
      }).catch(async error => {
        if (!isMongoDuplicateKeyError(error)) throw error;
        const winner = await CreativeAsset.findOne(identity).lean();
        if (!winner) throw error;
        return winner;
      });
    }
  );
  if (!asset) return null;

  const assetId = String(asset._id);
  return {
    assetId,
    attachment: attachmentFromAsset({
      assetId,
      workspaceId: params.workspaceId,
      title,
      prompt,
      target: params.target,
    }),
  };
}

export async function updateQueuedAiriImageGenerationTarget(params: {
  workspaceId: string;
  assetId: string;
  target: AiriImageGenerationTarget;
}): Promise<void> {
  await connectDB();
  const asset = await CreativeAsset.findOne({
    _id: params.assetId,
    workspaceId: params.workspaceId,
  })
    .select("providerPayload")
    .lean<{ providerPayload?: unknown } | null>();
  if (!asset) return;

  const providerPayload =
    asset.providerPayload &&
    typeof asset.providerPayload === "object" &&
    !Array.isArray(asset.providerPayload)
      ? (asset.providerPayload as Record<string, unknown>)
      : {};
  const airi =
    providerPayload.airi &&
    typeof providerPayload.airi === "object" &&
    !Array.isArray(providerPayload.airi)
      ? (providerPayload.airi as Record<string, unknown>)
      : {};

  await CreativeAsset.findByIdAndUpdate(params.assetId, {
    providerPayload: {
      ...providerPayload,
      airi: {
        ...airi,
        ...targetMetadata(params.target),
      },
    },
    updatedAt: new Date(),
  });
}

export async function startQueuedAiriImageGeneration(params: {
  workspaceId: string;
  assetId: string;
  prompt: string;
  aspectRatio?: string | null;
}): Promise<void> {
  await connectDB();
  try {
    const asset = await CreativeAsset.findOne({
      _id: params.assetId,
      workspaceId: params.workspaceId,
      provider: "google",
    })
      .select("providerSourceId")
      .lean<{ providerSourceId?: string | null } | null>();
    const { resolveGoogleCreativeWorkerApiKey } = await import(
      "@/lib/google/creative-credentials"
    );
    await resolveGoogleCreativeWorkerApiKey({
      workspaceId: params.workspaceId,
      providerSourceId: asset?.providerSourceId,
    });
    await startCreativeImageGenerationWorkflow({
      providerSourceId: asset!.providerSourceId,
      workspaceId: params.workspaceId,
      assetId: params.assetId,
      provider: "google",
      prompt: params.prompt,
      aspectRatio: normalizeAspectRatio(params.aspectRatio),
    });
  } catch (error) {
    await CreativeAsset.findOneAndUpdate(
      { _id: params.assetId, workspaceId: params.workspaceId },
      {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start image generation",
        updatedAt: new Date(),
      }
    );
    throw error;
  }
}
