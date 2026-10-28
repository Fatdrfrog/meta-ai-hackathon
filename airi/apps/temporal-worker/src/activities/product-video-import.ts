import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitElevenLabsAudioTranscriptionFromUrl } from "@icecore/airi-runtime/elevenlabs-stt";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import {
  assertContractVersion,
  PRODUCT_VIDEO_IMPORT_ACTIVITY_CONTRACT_VERSION,
  type ProductVideoImportActivityInput,
  type ProductVideoImportActivityResult,
  type ProductVideoImportFailActivityInput,
} from "@icecore/temporal";
import {
  activityInfo,
  ApplicationFailure,
  Context,
  heartbeat,
} from "@temporalio/activity";
import {
  downloadGcsCreativeAssetObject,
  uploadGcsCreativeAssetBuffer,
} from "../gcs-creative-assets.js";
import {
  classifyImportError,
  MAX_SOURCE_VIDEO_BYTES,
  runProductVideoImport,
  type ImportJobPorts,
  type ImportProduct,
  type ImportRecord,
} from "../media/product-video/import-job.js";
import { scribeTranscriptLines } from "../media/product-video/transcript.js";

/** The web code this activity uses, through its one host module. */
async function loadWebHost() {
  const host = await import("@/lib/products/import-worker-host");
  return readDefaultExport<typeof host>(host);
}

type WebHost = Awaited<ReturnType<typeof loadWebHost>>;

function importActionId(importId: string): string {
  return `product-video-import:${importId}`;
}

function mongoStore(
  host: WebHost,
  input: ProductVideoImportActivityInput,
): ImportJobPorts["store"] {
  const { ProductVideoImport, WorkspaceProduct } = host;
  const importFilter = { _id: input.importId, workspaceId: input.workspaceId };
  const productFilter = {
    workspaceId: input.workspaceId,
    importId: input.importId,
  };
  return {
    async loadImport() {
      const doc = await ProductVideoImport.findOne(importFilter)
        .select("status video transcript presenter")
        .lean();
      if (!doc) return null;
      return {
        status: doc.status,
        video: { bucket: doc.video.bucket, path: doc.video.path },
        transcript: doc.transcript ?? null,
        presenter: doc.presenter
          ? {
              momentSeconds: doc.presenter.momentSeconds,
              done: Boolean(doc.presenter.photo),
            }
          : null,
      } satisfies ImportRecord;
    },
    async updateImport(set, inc) {
      await ProductVideoImport.updateOne(importFilter, {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(inc ? { $inc: inc } : {}),
      });
    },
    async listProducts() {
      const docs = await WorkspaceProduct.find(productFilter)
        .sort({ importIndex: 1 })
        .select(
          "name englishName options.description options.samPhrase options.videoWindow options.photo.method",
        )
        .lean();
      return docs.map(
        (doc): ImportProduct => ({
          id: String(doc._id),
          englishName: doc.englishName || doc.name,
          options: (doc.options ?? []).map((option, index) => ({
            index,
            description: option.description || doc.englishName || doc.name,
            samPhrase:
              option.samPhrase ||
              option.description ||
              doc.englishName ||
              doc.name,
            videoWindow: option.videoWindow ?? { fromSeconds: 0, toSeconds: 0 },
            photoMethod: option.photo?.method ?? "pending",
          })),
        }),
      );
    },
    async createProducts(drafts) {
      if (drafts.length === 0) return;
      const last = await WorkspaceProduct.findOne({
        workspaceId: input.workspaceId,
      })
        .sort({ position: -1 })
        .select("position")
        .lean();
      const base = (last?.position ?? -1) + 1;
      try {
        await WorkspaceProduct.insertMany(
          drafts.map((draft) => ({
            ...draft,
            workspaceId: input.workspaceId,
            status: "draft",
            importId: input.importId,
            position: base + draft.importIndex,
            options: draft.options.map((option) => ({
              ...option,
              photo: { method: "pending" },
              notes: [],
            })),
          })),
          { ordered: false },
        );
      } catch (error) {
        // A previous attempt already created some: the unique (importId,
        // importIndex) index keeps one row each.
        if (!isDuplicateKeyError(error)) throw error;
      }
    },
    async savePhoto(productId, optionIndex, photo, notes) {
      await WorkspaceProduct.updateOne(
        { _id: productId, ...productFilter },
        {
          $set: { [`options.${optionIndex}.photo`]: photo },
          ...(notes.length
            ? { $push: { [`options.${optionIndex}.notes`]: { $each: notes } } }
            : {}),
        },
      );
    },
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; writeErrors?: unknown };
  if (record.code === 11000) return true;
  return (
    Array.isArray(record.writeErrors) &&
    record.writeErrors.every(
      (writeError: { code?: unknown; err?: { code?: unknown } }) =>
        writeError?.code === 11000 || writeError?.err?.code === 11000,
    )
  );
}

export async function productVideoImportActivity(
  input: ProductVideoImportActivityInput,
): Promise<ProductVideoImportActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { max: PRODUCT_VIDEO_IMPORT_ACTIVITY_CONTRACT_VERSION },
    "product video import activity",
  );
  const host = await loadWebHost();
  await host.connectDB();
  const store = mongoStore(host, input);
  const actionId = importActionId(input.importId);
  const context = Context.current();
  let currentStage = "starting";
  const pulse = () =>
    heartbeat({ importId: input.importId, stage: currentStage });

  const tracked = await host.productImportSpend.tracked(
    input.workspaceId,
    actionId,
  );
  const workDir = await mkdtemp(join(tmpdir(), "product-import-"));
  try {
    await store.updateImport({
      workflowId: input.workflowId,
      startedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    });
    const { productCount } = await runProductVideoImport({
      store: {
        ...store,
        async updateImport(set, inc) {
          if (typeof set.stage === "string") currentStage = set.stage;
          await store.updateImport(set, inc);
        },
      },
      storage: {
        async downloadVideo(video, destination) {
          await downloadGcsCreativeAssetObject({
            ...video,
            workspaceId: input.workspaceId,
            destination,
            maxBytes: MAX_SOURCE_VIDEO_BYTES,
          });
        },
        async savePhoto(productId, file) {
          const stored = await uploadGcsCreativeAssetBuffer({
            workspaceId: input.workspaceId,
            assetId: `product-${productId}-${Date.now().toString(36)}`,
            kind: "image",
            buffer: file.buffer,
            mimeType: file.mimeType,
            fileName: file.fileName,
            customMetadata: {
              productId,
              importId: input.importId,
            },
          });
          return { bucket: stored.bucket, path: stored.path };
        },
        async savePresenterPhoto(file) {
          const stored = await uploadGcsCreativeAssetBuffer({
            workspaceId: input.workspaceId,
            assetId: `presenter-${input.importId}-${Date.now().toString(36)}`,
            kind: "image",
            buffer: file.buffer,
            mimeType: file.mimeType,
            fileName: file.fileName,
            customMetadata: { importId: input.importId, role: "presenter" },
          });
          return { bucket: stored.bucket, path: stored.path };
        },
      },
      spend: tracked
        ? {
            reserve: (operationId, provider, maxCostMicros) =>
              host.productImportSpend.reserve({
                workspaceId: input.workspaceId,
                actionId,
                operationId,
                provider,
                maxCostMicros,
              }),
            settle: (reservation, actualCostMicros) =>
              host.productImportSpend.settle(
                reservation as Parameters<
                  WebHost["productImportSpend"]["settle"]
                >[0],
                actualCostMicros,
              ),
          }
        : null,
      async transcribe(audioPath) {
        const submission = await submitElevenLabsAudioTranscriptionFromUrl(
          "https://storage.invalid/narration.mp3",
          "audio/mpeg",
          {
            workflowKind: "product_video_import",
            workflowId: input.workflowId,
            workspaceId: input.workspaceId,
            importId: input.importId,
            mediaType: "audio",
          },
          {
            fileBuffer: await readFile(audioPath),
            filename: "narration.mp3",
            timestampsGranularity: "word",
            delivery: "inline",
          },
        );
        return scribeTranscriptLines(submission.responsePayload);
      },
      async emit(reason, productId) {
        try {
          await host.emitProductsChangedRealtimeEvent({
            workspaceId: input.workspaceId,
            importId: input.importId,
            reason,
            productId: productId ?? null,
          });
        } catch (error) {
          // The panel also refreshes on its own; a lost event only delays it.
          airiWorkerLogger.warn("products.realtime_emit_failed", {
            importId: input.importId,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      pulse,
      signal: context.cancellationSignal,
      attempt: activityInfo().attempt,
      workDir,
    });
    return { importId: input.importId, status: "ready", productCount };
  } catch (error) {
    const failure = classifyImportError(error);
    if (failure.retryable) {
      throw ApplicationFailure.retryable(
        failure.message,
        "ProductVideoImportInterrupted",
      );
    }
    // Nothing will retry this: record why, for the owner.
    await store.updateImport({
      status: "failed",
      stage: null,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 500),
      finishedAt: new Date(),
    });
    throw ApplicationFailure.nonRetryable(
      failure.message,
      "ProductVideoImportRejected",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Records a failure the import activity couldn't, after its last attempt. */
export async function productVideoImportFailActivity(
  input: ProductVideoImportFailActivityInput,
): Promise<ProductVideoImportActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { max: PRODUCT_VIDEO_IMPORT_ACTIVITY_CONTRACT_VERSION },
    "product video import fail activity",
  );
  const host = await loadWebHost();
  await host.connectDB();
  const { ProductVideoImport, WorkspaceProduct } = host;
  await ProductVideoImport.updateOne(
    {
      _id: input.importId,
      workspaceId: input.workspaceId,
      status: { $ne: "ready" },
    },
    [
      {
        $set: {
          status: "failed",
          stage: null,
          // The activity's own code, when it recorded one before giving up.
          errorCode: { $ifNull: ["$errorCode", "failed"] },
          errorMessage: input.error.slice(0, 500),
          finishedAt: new Date(),
        },
      },
    ],
  );
  try {
    await host.emitProductsChangedRealtimeEvent({
      workspaceId: input.workspaceId,
      importId: input.importId,
      reason: "import",
    });
  } catch {
    // The panel also refreshes on its own.
  }
  const productCount = await WorkspaceProduct.countDocuments({
    workspaceId: input.workspaceId,
    importId: input.importId,
  });
  return { importId: input.importId, status: "failed", productCount };
}
