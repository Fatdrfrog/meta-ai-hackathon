import type {
  ScenarioGeneratedAsset,
  ScenarioGenerationStatus,
  ScenarioGraphNode,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";
import {
  downloadVertexVideoResult,
  extractVertexVideoResults,
  pollVertexVideoOperation,
} from "@/lib/ai/vertex-video";
import connectDB from "@/lib/mongoose";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { mutateScenarioGraphWithCas } from "@/lib/scenarios/scenario-graph-mutation";
import { buildWhatsAppTemplateButtonIdsPatch } from "@/lib/scenarios/whatsapp-template-button-branches";
import {
  ensureBusinessMediaBucket,
  resolveBusinessMediaBucket,
} from "@/lib/media/business-media-bucket";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { storeSupabaseWorkspaceBuffer } from "@icecore/airi-runtime/storage-quota";
import { ScenarioGeneratedMediaAsset } from "@/models/scenario-generated-media-asset";
import { ScenarioGenerationJob } from "@/models/scenario-generation-job";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";
import { sanitizeStorageFilename } from "@icecore/shared/lib/storage-filename";

type Params = Promise<{ workspaceId: string; jobId: string }>;

export const runtime = "nodejs";

type LeanRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function serializeJob(job: LeanRecord) {
  return {
    id: String(job._id),
    scenarioId: job.scenarioId || null,
    status: job.status,
    error: job.error || null,
    mediaProvider: job.mediaProvider || null,
    updatedAt:
      job.updatedAt instanceof Date
        ? job.updatedAt.toISOString()
        : job.updatedAt || null,
  };
}

function serializeMediaAsset(asset: LeanRecord) {
  return {
    id: String(asset._id),
    scenarioId: asset.scenarioId || null,
    branchId: asset.branchId || null,
    kind: asset.kind,
    source: asset.source,
    url: asset.url,
    mimeType: asset.mimeType || null,
    fileName: asset.fileName || null,
    durationSeconds: asset.durationSeconds || null,
    status: asset.status,
    error: asset.error || null,
  };
}

async function loadMediaAssets(params: {
  workspaceId: string;
  jobId: string;
}): Promise<LeanRecord[]> {
  return ScenarioGeneratedMediaAsset.find({
    workspaceId: params.workspaceId,
    jobId: params.jobId,
  })
    .sort({ createdAt: 1 })
    .lean<LeanRecord[]>();
}

async function uploadGeneratedVideo(params: {
  assetId: string;
  workspaceId: string;
  scenarioId: string;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const bucketName = resolveBusinessMediaBucket(
    process.env.SUPABASE_SCENARIO_ASSETS_BUCKET
  );
  await ensureBusinessMediaBucket(supabaseAdmin.storage, bucketName);
  const safeName = sanitizeStorageFilename(
    params.fileName || "generated-video.mp4",
    `generated-video-${Date.now()}.mp4`
  );
  const storagePath = `scenarios/${params.workspaceId}/generated-videos/${params.scenarioId}/${params.assetId}/${safeName}`;
  await storeSupabaseWorkspaceBuffer({
    storage: supabaseAdmin.storage,
    workspaceId: params.workspaceId,
    bucket: bucketName,
    path: storagePath,
    buffer: params.buffer,
    mimeType: params.mimeType,
  });

  const {
    data: { publicUrl },
  } = supabaseAdmin.storage.from(bucketName).getPublicUrl(storagePath);

  if (!publicUrl) {
    throw new Error("Supabase did not return a public URL for generated video");
  }
  return publicUrl;
}

async function pollQueuedVertexAssets(params: {
  workspaceId: string;
  jobId: string;
  scenarioId: string;
  mediaAssets: LeanRecord[];
}): Promise<{ changed: boolean; errorMessages: string[] }> {
  let changed = false;
  const errorMessages: string[] = [];
  const queuedAssets = params.mediaAssets.filter(
    asset =>
      asset.kind === "video" &&
      asset.source === "vertex" &&
      asset.status === "queued" &&
      typeof asset.providerOperationId === "string" &&
      asset.providerOperationId
  );

  for (const asset of queuedAssets) {
    try {
      const operation = await pollVertexVideoOperation(
        asset.providerOperationId as string
      );
      if (!operation.done) {
        continue;
      }
      if (operation.error) {
        throw new Error(
          typeof operation.error === "string"
            ? operation.error
            : JSON.stringify(operation.error)
        );
      }

      const [result] = extractVertexVideoResults(operation.response);
      if (!result) {
        throw new Error("Completed Vertex operation did not return a video");
      }

      const downloaded = await downloadVertexVideoResult(result);
      const publicUrl = await uploadGeneratedVideo({
        assetId: String(asset._id),
        workspaceId: params.workspaceId,
        scenarioId: params.scenarioId,
        fileName: asString(asset.fileName) || "generated-video.mp4",
        buffer: downloaded.buffer,
        mimeType: downloaded.mimeType,
      });

      await ScenarioGeneratedMediaAsset.findByIdAndUpdate(asset._id, {
        url: publicUrl,
        mimeType: downloaded.mimeType,
        status: "complete",
        error: null,
      });
      changed = true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to complete Vertex video generation";
      await ScenarioGeneratedMediaAsset.findByIdAndUpdate(asset._id, {
        status: "failed",
        error: message,
      });
      errorMessages.push(message);
      changed = true;
    }
  }

  return { changed, errorMessages };
}

function resolveGenerationStatus(
  currentStatus: unknown,
  mediaAssets: LeanRecord[]
): ScenarioGenerationStatus {
  const hasQueued = mediaAssets.some(asset => asset.status === "queued");
  const hasFailed = mediaAssets.some(asset => asset.status === "failed");
  const hasGeneratedMedia = mediaAssets.some(
    asset => asset.source === "vertex" || asset.source === "elevenlabs"
  );

  if (hasQueued) return "generating_media";
  if (hasGeneratedMedia && hasFailed) return "failed";
  if (hasGeneratedMedia) return "complete";
  return currentStatus === "failed" ? "failed" : "complete";
}

function generatedAssetFromMedia(asset: LeanRecord): ScenarioGeneratedAsset {
  return {
    id: String(asset._id),
    kind: asString(asset.kind) as ScenarioGeneratedAsset["kind"],
    source: asString(asset.source) as ScenarioGeneratedAsset["source"],
    url: asString(asset.url),
    mimeType: asString(asset.mimeType) || undefined,
    fileName: asString(asset.fileName) || undefined,
    durationSeconds:
      typeof asset.durationSeconds === "number"
        ? asset.durationSeconds
        : undefined,
    status:
      asset.status === "queued" ||
      asset.status === "complete" ||
      asset.status === "failed"
        ? asset.status
        : undefined,
    providerOperationId: asString(asset.providerOperationId) || undefined,
  };
}

function resolveTemplateHeaderMediaFormat(
  asset: ScenarioGeneratedAsset
): "IMAGE" | "VIDEO" | "DOCUMENT" | null {
  if (asset.kind === "image") return "IMAGE";
  if (asset.kind === "video") return "VIDEO";
  if (asset.kind === "document") return "DOCUMENT";
  return null;
}

function isGeneratedTemplateDraftMutable(
  draft: ScenarioNodeData["generatedTemplateDraft"]
): boolean {
  if (!draft) return false;
  const status = String(draft.status || "").toLowerCase();
  return status === "draft" || status === "rejected";
}

function mergeTemplateMediaHeader(params: {
  components: WhatsAppComponent[] | undefined;
  asset: ScenarioGeneratedAsset;
}): WhatsAppComponent[] | null {
  const format = resolveTemplateHeaderMediaFormat(params.asset);
  if (!format || !params.asset.url) return null;

  const header: WhatsAppComponent = {
    type: "HEADER",
    format,
    example: {
      header_handle: [params.asset.url],
    },
  };

  return [
    header,
    ...(params.components || []).filter(
      component => component.type !== "HEADER"
    ),
  ];
}

function patchDraftTemplateMedia(params: {
  data: ScenarioNodeData;
  asset: ScenarioGeneratedAsset;
}): ScenarioNodeData {
  if (
    params.data.kind !== "action" ||
    params.data.actionType !== "whatsapp_template" ||
    !isGeneratedTemplateDraftMutable(params.data.generatedTemplateDraft)
  ) {
    return params.data;
  }

  const nextComponents = mergeTemplateMediaHeader({
    components:
      params.data.actionWhatsAppTemplateComponents ||
      params.data.generatedTemplateDraft?.components,
    asset: params.asset,
  });
  if (!nextComponents) return params.data;

  const headerMediaFormat = resolveTemplateHeaderMediaFormat(params.asset);
  return {
    ...params.data,
    actionWhatsAppTemplateComponents: nextComponents,
    ...buildWhatsAppTemplateButtonIdsPatch({
      previous: params.data,
      components: nextComponents,
      match: "byIndex",
    }),
    generatedTemplateDraft: {
      ...params.data.generatedTemplateDraft!,
      headerMediaUrl: params.asset.url,
      headerMediaFormat: headerMediaFormat || undefined,
      components: nextComponents,
    },
  };
}

function patchScenarioNodesForCompletedMedia<
  TNode extends ScenarioGraphNode,
>(params: {
  nodes: TNode[];
  mediaAssets: LeanRecord[];
  generationStatus: ScenarioGenerationStatus;
  generationJobId: string;
}): {
  nodes: TNode[];
  nodeUpdates: Array<{ id: string; data: ScenarioNodeData }>;
} {
  const ownsGenerationRevision = params.nodes.some(
    node =>
      node.data.kind === "bulk" &&
      node.data.bulkRootConfig?.generationJobId === params.generationJobId
  );
  if (!ownsGenerationRevision) {
    return { nodes: params.nodes, nodeUpdates: [] };
  }

  const completeAssets = params.mediaAssets.filter(
    asset =>
      asset.status === "complete" &&
      asset.kind === "video" &&
      asset.source === "vertex" &&
      typeof asset.url === "string" &&
      asset.url
  );
  const firstActionNodeByBranch = new Map<string, string>();
  for (const node of params.nodes) {
    if (node.data.kind !== "action") continue;
    const branchId = node.data.bulkRecipientBranchId || "default";
    if (!firstActionNodeByBranch.has(branchId)) {
      firstActionNodeByBranch.set(branchId, node.id);
    }
  }

  const nodeUpdates: Array<{ id: string; data: ScenarioNodeData }> = [];
  const nextNodes = params.nodes.map(node => {
    let nextData = node.data;

    if (node.data.kind === "bulk" && node.data.bulkRootConfig) {
      if (
        node.data.bulkRootConfig.generationJobId === params.generationJobId &&
        node.data.bulkRootConfig.generationStatus !== params.generationStatus
      ) {
        nextData = {
          ...nextData,
          bulkRootConfig: {
            ...node.data.bulkRootConfig,
            generationStatus: params.generationStatus,
          },
        };
      }
    }

    if (node.data.kind === "action") {
      const assetsForNode = completeAssets.filter(asset => {
        const branchId = asString(asset.branchId) || "default";
        const targetNodeId =
          firstActionNodeByBranch.get(branchId) ||
          firstActionNodeByBranch.get("default");
        return targetNodeId === node.id;
      });

      if (assetsForNode.length > 0) {
        const existingAssets = node.data.actionMediaAssets || [];
        const assetIds = new Set(existingAssets.map(asset => asset.id));
        const assetUrls = new Set(existingAssets.map(asset => asset.url));
        const nextAssets = [...existingAssets];
        for (const asset of assetsForNode.map(generatedAssetFromMedia)) {
          if (!assetIds.has(asset.id) && !assetUrls.has(asset.url)) {
            nextAssets.push(asset);
            assetIds.add(asset.id);
            assetUrls.add(asset.url);
          }
        }

        if (nextAssets.length !== existingAssets.length) {
          nextData = {
            ...nextData,
            actionMediaAssets: nextAssets,
            actionImageUrls: Array.from(
              new Set([
                ...(node.data.actionImageUrls || []),
                ...nextAssets.map(asset => asset.url).filter(Boolean),
              ])
            ),
          };
        }

        for (const asset of nextAssets) {
          if (!asset.url || asset.source !== "vertex") continue;
          nextData = patchDraftTemplateMedia({
            data: nextData,
            asset,
          });
        }
      }
    }

    if (nextData !== node.data) {
      nodeUpdates.push({ id: node.id, data: nextData });
      return { ...node, data: nextData };
    }
    return node;
  });

  return { nodes: nextNodes, nodeUpdates };
}

type ScenarioPatchResult = {
  nodeUpdates: Array<{ id: string; data: ScenarioNodeData }>;
  previousScenarioUpdatedAt: string | null;
  scenarioUpdatedAt: string | null;
  scenarioRevisionConflict: boolean;
};

async function patchGeneratedScenarioWithCas(params: {
  workspaceId: string;
  scenarioId: string;
  generationJobId: string;
  mediaAssets: LeanRecord[];
  generationStatus: ScenarioGenerationStatus;
}): Promise<ScenarioPatchResult> {
  const result = await mutateScenarioGraphWithCas({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    project: snapshot => {
      const patched = patchScenarioNodesForCompletedMedia({
        nodes: snapshot.nodes as ScenarioGraphNode[],
        mediaAssets: params.mediaAssets,
        generationStatus: params.generationStatus,
        generationJobId: params.generationJobId,
      });
      return patched.nodeUpdates.length > 0
        ? {
            changed: true,
            nodes: patched.nodes,
            edges: snapshot.edges,
            value: patched.nodeUpdates,
          }
        : {
            changed: false,
            value: patched.nodeUpdates,
          };
    },
  });
  if (result.status === "updated" || result.status === "unchanged") {
    return {
      nodeUpdates: result.value,
      previousScenarioUpdatedAt: result.previousScenarioUpdatedAt,
      scenarioUpdatedAt: result.scenarioUpdatedAt,
      scenarioRevisionConflict: false,
    };
  }
  return {
    nodeUpdates: [],
    previousScenarioUpdatedAt: result.previousScenarioUpdatedAt,
    scenarioUpdatedAt: result.scenarioUpdatedAt,
    scenarioRevisionConflict: result.status === "conflict",
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId, jobId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;
  if (!Types.ObjectId.isValid(jobId)) {
    return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  }

  await connectDB();
  const job = await ScenarioGenerationJob.findOne({
    _id: new Types.ObjectId(jobId),
    workspaceId,
  }).lean<Record<string, unknown> | null>();
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  let mediaAssets = await loadMediaAssets({ workspaceId, jobId });
  const scenarioId = asString(job.scenarioId);
  const shouldPollMedia =
    scenarioId &&
    (job.status === "generating_media" ||
      mediaAssets.some(asset => asset.status === "queued"));
  let pollErrors: string[] = [];

  if (shouldPollMedia) {
    const pollResult = await pollQueuedVertexAssets({
      workspaceId,
      jobId,
      scenarioId,
      mediaAssets,
    });
    pollErrors = pollResult.errorMessages;
    if (pollResult.changed) {
      mediaAssets = await loadMediaAssets({ workspaceId, jobId });
    }
  }

  const generationStatus = shouldPollMedia
    ? resolveGenerationStatus(job.status, mediaAssets)
    : (job.status as ScenarioGenerationStatus);
  const jobUpdate: Record<string, unknown> = {};
  if (shouldPollMedia && generationStatus !== job.status) {
    jobUpdate.status = generationStatus;
  }
  if (pollErrors.length > 0) {
    jobUpdate.error = pollErrors[0];
  } else if (generationStatus === "complete") {
    jobUpdate.error = null;
  }
  if (Object.keys(jobUpdate).length > 0) {
    await ScenarioGenerationJob.findByIdAndUpdate(job._id, jobUpdate);
    Object.assign(job, jobUpdate);
  }

  const scenarioPatch =
    scenarioId && Types.ObjectId.isValid(scenarioId)
      ? await patchGeneratedScenarioWithCas({
          workspaceId,
          scenarioId,
          generationJobId: jobId,
          mediaAssets,
          generationStatus,
        })
      : {
          nodeUpdates: [],
          previousScenarioUpdatedAt: null,
          scenarioUpdatedAt: null,
          scenarioRevisionConflict: false,
        };

  return NextResponse.json({
    generationJobId: jobId,
    job: serializeJob(job),
    mediaAssets: mediaAssets.map(serializeMediaAsset),
    ...scenarioPatch,
  });
}
