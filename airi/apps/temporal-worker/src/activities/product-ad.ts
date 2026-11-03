import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  elevenLabsAudioIsolationCostMicros,
  isElevenLabsAudioIsolationConfigured,
  isolateElevenLabsAudio,
} from "@icecore/airi-runtime/elevenlabs-audio-isolation";
import { airiWorkerLogger } from "@icecore/airi-runtime/logging";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import {
  assertContractVersion,
  buildProductAdActionId,
  PRODUCT_AD_ACTIVITY_CONTRACT_VERSION,
  type ProductAdActivityInput,
  type ProductAdActivityResult,
  type ProductAdFailActivityInput,
  type ProductAdFileRef,
} from "@icecore/temporal";
import {
  activityInfo,
  ApplicationFailure,
  Context,
  heartbeat,
} from "@temporalio/activity";
import {
  createGcsCreativeAssetPath,
  downloadGcsCreativeAssetObject,
  getGcsCreativeAssetsBucketName,
  statGcsCreativeAssetObject,
  uploadGcsCreativeAssetBuffer,
} from "../gcs-creative-assets.js";
import {
  AdRunSuperseded,
  classifyAdError,
  removeWorkDir,
  runProductAd,
  type AdJobPorts,
  type AdProductSource,
  type AdRecord,
} from "../media/product-video/ad/ad-job.js";
import type { AdSpendPort } from "../media/product-video/ad/spend.js";

/** The web code this activity uses, through its one host module. */
async function loadWebHost() {
  const host = await import("@/lib/products/import-worker-host");
  return readDefaultExport<typeof host>(host);
}

type WebHost = Awaited<ReturnType<typeof loadWebHost>>;

const VOICE_MAX_BYTES = 20 * 1024 * 1024;

const ref = (
  value: { bucket?: string | null; path?: string | null } | null | undefined,
) =>
  value?.bucket && value.path
    ? { bucket: value.bucket, path: value.path }
    : null;

/**
 * The ad's AI spend, all on its one AI action (product-ad:<adId>), so a
 * retry or a later run never counts another included action.
 */
export function adSpendPort(
  spend: WebHost["productImportSpend"],
  ids: { workspaceId: string; actionId: string },
): AdSpendPort {
  return {
    allowance: () => spend.allowance(ids.workspaceId),
    reserve: (operationId, provider, maxCostMicros) =>
      spend.reserve({
        workspaceId: ids.workspaceId,
        actionId: ids.actionId,
        operationId,
        provider,
        maxCostMicros,
      }),
    settle: (reservation, actualCostMicros) =>
      spend.settle(
        reservation as Parameters<WebHost["productImportSpend"]["settle"]>[0],
        actualCostMicros,
      ),
  };
}

function mongoStore(
  host: WebHost,
  input: ProductAdActivityInput,
): AdJobPorts["store"] {
  const { ProductAd, ProductVideoImport, WorkspaceProduct } = host;
  const adFilter = { _id: input.adId, workspaceId: input.workspaceId };
  // Every write is this run's: a newer render (the owner edited again) wins.
  const runFilter = { ...adFilter, renderNo: input.renderNo };
  return {
    async loadAd() {
      const doc = await ProductAd.findOne(adFilter).lean();
      if (!doc) return null;
      return {
        status: doc.status,
        renderNo: doc.renderNo ?? 1,
        language: doc.language ?? null,
        wordsCode: doc.wordsCode ?? null,
        idea: { kind: doc.idea?.kind ?? "new", text: doc.idea?.text ?? null },
        voice: doc.voice ?? "none",
        presenter: doc.presenter
          ? {
              use: Boolean(doc.presenter.use),
              consentAt: doc.presenter.consentAt ?? null,
              photo: ref(doc.presenter.photo),
            }
          : null,
        ending: {
          phone: doc.ending?.phone ?? null,
          shopName: doc.ending?.shopName ?? "",
        },
        products: (doc.products ?? []).map((product) => ({
          productId: product.productId,
          importId: product.importId ?? null,
          name: product.name,
          englishName: product.englishName ?? null,
          priceText: product.priceText,
          priceQuote: product.priceQuote ?? null,
          cutout: ref(product.cutout),
          original: ref(product.original),
          clip: ref(product.clip),
          samPhrase: product.samPhrase ?? "",
          description: product.description ?? "",
        })),
        script: doc.script ?? null,
        scenes: (doc.scenes ?? []).map((scene) => ({
          productId: scene.productId,
          exact: ref(scene.exact),
          muse: ref(scene.muse),
          method: scene.method ?? "exact",
          check: scene.check
            ? {
                same: Boolean(scene.check.same),
                difference: scene.check.difference ?? null,
              }
            : null,
          box: scene.box ?? null,
          attempts: scene.attempts ?? 0,
        })),
        stills: {
          status: ref(doc.stills?.status),
          feed: ref(doc.stills?.feed),
        },
        costMicros: doc.costMicros ?? 0,
      } satisfies AdRecord;
    },
    async updateAd(set, inc) {
      const update = {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(inc && Object.keys(inc).length ? { $inc: inc } : {}),
      };
      if (Object.keys(update).length === 0)
        return (await ProductAd.countDocuments(runFilter)) > 0;
      const result = await ProductAd.updateOne(runFilter, update);
      return result.matchedCount > 0;
    },
    async loadSources(productIds) {
      const products = await WorkspaceProduct.find({
        _id: { $in: productIds },
        workspaceId: input.workspaceId,
      })
        .select("importId clip.fromSeconds clip.toSeconds")
        .lean();
      const importIds = [
        ...new Set(
          products
            .map((product) => product.importId)
            .filter(Boolean)
            .map(String),
        ),
      ];
      const imports = importIds.length
        ? await ProductVideoImport.find({
            _id: { $in: importIds },
            workspaceId: input.workspaceId,
          })
            .select("transcript video.bucket video.path")
            .lean()
        : [];
      const byImport = new Map(imports.map((doc) => [String(doc._id), doc]));
      return products.map((product): AdProductSource => {
        const source = product.importId
          ? byImport.get(String(product.importId))
          : undefined;
        const clip = product.clip;
        return {
          productId: String(product._id),
          transcript: source?.transcript ?? null,
          clipWindow:
            typeof clip?.fromSeconds === "number" &&
            typeof clip.toSeconds === "number" &&
            clip.toSeconds > clip.fromSeconds
              ? { fromSeconds: clip.fromSeconds, toSeconds: clip.toSeconds }
              : null,
          video: ref(source?.video),
        };
      });
    },
  };
}

function gcsStorage(input: ProductAdActivityInput): AdJobPorts["storage"] {
  const { workspaceId, adId, renderNo } = input;
  let saved = 0;
  // A product's polished words, kept where every later run finds them.
  const voiceObject = (productId: string) => ({
    bucket: getGcsCreativeAssetsBucketName(),
    path: createGcsCreativeAssetPath({
      workspaceId,
      assetId: `product-ad-${adId}-voice`,
      kind: "audio",
      fileName: `voice-${productId}.flac`,
    }),
  });
  return {
    async download(file: ProductAdFileRef, destination, maxBytes) {
      await downloadGcsCreativeAssetObject({
        ...file,
        workspaceId,
        destination,
        maxBytes,
      });
    },
    async save(file) {
      const stored = await uploadGcsCreativeAssetBuffer({
        workspaceId,
        assetId: `product-ad-${adId}-${Date.now().toString(36)}-${(saved++).toString(36)}`,
        kind: file.kind,
        buffer: file.buffer,
        mimeType: file.mimeType,
        fileName: file.fileName,
        customMetadata: { adId, renderNo: String(renderNo) },
      });
      return { bucket: stored.bucket, path: stored.path };
    },
    async loadVoice(productId, destination) {
      const object = voiceObject(productId);
      const found = await statGcsCreativeAssetObject({
        ...object,
        workspaceId,
      });
      if (!found.exists) return false;
      await downloadGcsCreativeAssetObject({
        ...object,
        workspaceId,
        destination,
        maxBytes: VOICE_MAX_BYTES,
      });
      return true;
    },
    async saveVoice(productId, flac) {
      await uploadGcsCreativeAssetBuffer({
        workspaceId,
        assetId: `product-ad-${adId}-voice`,
        kind: "audio",
        buffer: flac,
        mimeType: "audio/flac",
        fileName: `voice-${productId}.flac`,
        customMetadata: { adId, productId },
      });
    },
  };
}

export async function productAdActivity(
  input: ProductAdActivityInput,
): Promise<ProductAdActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { max: PRODUCT_AD_ACTIVITY_CONTRACT_VERSION },
    "product ad activity",
  );
  const { attempt, workflowExecution } = activityInfo();
  if (!workflowExecution) {
    throw ApplicationFailure.nonRetryable(
      "A product ad runs inside its workflow",
      "ProductAdRejected",
    );
  }
  const host = await loadWebHost();
  await host.connectDB();
  const store = mongoStore(host, input);
  const context = Context.current();
  let currentStep = "starting";
  const pulse = () =>
    heartbeat({
      adId: input.adId,
      renderNo: input.renderNo,
      step: currentStep,
    });
  const result = (status: "ready" | "failed"): ProductAdActivityResult => ({
    adId: input.adId,
    renderNo: input.renderNo,
    status,
  });

  const workDir = await mkdtemp(join(tmpdir(), "product-ad-"));
  try {
    const owner = await host.ProductAd.findOne({
      _id: input.adId,
      workspaceId: input.workspaceId,
    })
      .select("actionId")
      .lean();
    const actionId = owner?.actionId || buildProductAdActionId(input.adId);
    const isolationKey = isElevenLabsAudioIsolationConfigured();
    const run = await runProductAd({
      store: {
        ...store,
        async updateAd(set, inc) {
          if (typeof set.step === "string") currentStep = set.step;
          return store.updateAd(set, inc);
        },
      },
      storage: gcsStorage(input),
      spend: adSpendPort(host.productImportSpend, {
        workspaceId: input.workspaceId,
        actionId,
      }),
      isolate: isolationKey
        ? async (wav) =>
            (
              await isolateElevenLabsAudio(
                { audio: wav, filename: "voice.wav", mimeType: "audio/wav" },
                { signal: context.cancellationSignal },
              )
            ).audio
        : null,
      isolationCostMicros: elevenLabsAudioIsolationCostMicros,
      mode: input.mode,
      renderNo: input.renderNo,
      attempt,
      workDir,
      pulse,
      signal: context.cancellationSignal,
      log: (event, fields) =>
        airiWorkerLogger.warn(event, {
          adId: input.adId,
          renderNo: input.renderNo,
          ...fields,
        }),
      started: { workflowId: input.workflowId },
    });
    if (run.status === "superseded")
      airiWorkerLogger.info("products.ad_superseded", {
        adId: input.adId,
        renderNo: input.renderNo,
      });
    return result("ready");
  } catch (error) {
    if (error instanceof AdRunSuperseded) {
      airiWorkerLogger.info("products.ad_superseded", {
        adId: input.adId,
        renderNo: input.renderNo,
      });
      return result("ready");
    }
    const failure = classifyAdError(error);
    if (failure.retryable) {
      throw ApplicationFailure.retryable(
        failure.message,
        "ProductAdInterrupted",
      );
    }
    // Nothing will retry this: record why, for the owner.
    airiWorkerLogger.warn("products.ad_rejected", {
      adId: input.adId,
      renderNo: input.renderNo,
      code: failure.code,
      error: failure.message,
    });
    await store.updateAd({
      status: "failed",
      step: null,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 500),
    });
    throw ApplicationFailure.nonRetryable(failure.message, "ProductAdRejected");
  } finally {
    // Never in place of the run's own outcome (a rejection must stay final).
    await removeWorkDir(workDir, (error) =>
      airiWorkerLogger.warn("products.ad_work_dir_left", {
        adId: input.adId,
        renderNo: input.renderNo,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Records a failure the ad activity couldn't, after its last attempt. */
export async function productAdFailActivity(
  input: ProductAdFailActivityInput,
): Promise<ProductAdActivityResult> {
  assertContractVersion(
    input.contractVersion,
    { max: PRODUCT_AD_ACTIVITY_CONTRACT_VERSION },
    "product ad fail activity",
  );
  const host = await loadWebHost();
  await host.connectDB();
  await host.ProductAd.updateOne(
    {
      _id: input.adId,
      workspaceId: input.workspaceId,
      renderNo: input.renderNo,
      status: { $ne: "ready" },
    },
    [
      {
        $set: {
          status: "failed",
          step: null,
          // The activity's own code, when it recorded one before giving up.
          errorCode: { $ifNull: ["$errorCode", "failed"] },
          errorMessage: input.error.slice(0, 500),
        },
      },
    ],
  );
  return { adId: input.adId, renderNo: input.renderNo, status: "failed" };
}
