import "server-only";
import {
  elevenLabsAdSpeechModels,
  speakElevenLabsWithTimestamps,
} from "@icecore/airi-runtime/elevenlabs-tts";
import {
  deleteElevenLabsVoice,
  isElevenLabsVoicesConfigured,
} from "@icecore/airi-runtime/elevenlabs-voices";
import { logger } from "@/lib/logger";
import {
  adAdmissionStop,
  adChangesIssues,
  adChangesSet,
  loadProductAdRecord,
  startAdRun,
} from "@/lib/products/ads";
import { productImportSpend } from "@/lib/products/import-spend";
import {
  PRODUCT_AD_STOCK_VOICES,
  PRODUCT_AD_VOICE_SAMPLE_TEXT,
  PRODUCT_VOICE_MIN_SPEECH_SECONDS,
  productAdMotionOf,
  productAdRecordingIsPaid,
  productAdStockVoice,
  type ProductAdAdmissionStop,
  type ProductAdRecord,
  type ProductAdVoiceRequest,
  type ProductShopWordsCode,
  type ProductVoiceCreateRequest,
  type ProductVoiceRecord,
  type ProductVoiceSamplesResponse,
  type ProductVoiceSource,
} from "@/lib/products/types";
import { ProductAd, type IProductAd } from "@/models/product-ad";
import { ProductVideoImport } from "@/models/product-video-import";
import { ProductVoice, type IProductVoice } from "@/models/product-voice";
import { ProductVoiceSample } from "@/models/product-voice-sample";
import { WorkspaceProduct } from "@/models/workspace-product";

// The workspace's cloned voice and airi's voices (Part V), on the web: the
// owner's consent saves the voice as pending with the video it's made from
// (the worker makes the clone in the first ad that reads it, booked in that
// ad's AI action); "Remove my voice" deletes it at ElevenLabs first; airi's
// voices' samples are made once and kept; and an ad is read again in
// another voice as a "voice" run. What the API takes is checked in the
// routes; the worker's side is media/product-video/ad/voice*.ts.

/** The live voice: pending or ready, not removed (one per workspace). */
const LIVE = { live: true, removedAt: null };

/**
 * About how many seconds of speech a narration holds, from its timed lines
 * ("[12.3] Кукла, бес мың."): each line lasts until the next starts, at
 * most as long as its letters take to say (13 a second, with a little air).
 */
export function narrationSpeechSeconds(
  transcript: string | null | undefined
): number {
  const lines = (transcript ?? "")
    .split("\n")
    .map(line => /^\s*\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({
      start: Number(match[1]),
      text: match[2]!.replace(/\[\d+(?:\.\d+)?\]/g, ""),
    }));
  let total = 0;
  lines.forEach((line, index) => {
    const letters = (line.text.match(/[0-9A-Za-zÀ-ɏЀ-ԯ]/g) ?? []).length;
    const said = letters / 13 + 0.3;
    const next = lines[index + 1]?.start;
    total +=
      next !== undefined && next > line.start
        ? Math.min(next - line.start, said)
        : said;
  });
  return Math.round(total * 10) / 10;
}

type VoiceDoc = Pick<
  IProductVoice,
  | "state"
  | "sourceImportId"
  | "speechSeconds"
  | "errorCode"
  | "consentAt"
  | "createdAt"
>;

async function toVoiceRecord(
  workspaceId: string,
  doc: VoiceDoc
): Promise<ProductVoiceRecord | null> {
  if (doc.state === "removed") return null;
  const source = await ProductVideoImport.findOne({
    _id: doc.sourceImportId,
    workspaceId,
  })
    .select("createdAt")
    .lean<{ createdAt?: Date } | null>();
  return {
    state: doc.state,
    sourceImportId: doc.sourceImportId,
    sourceVideoAt: source?.createdAt ? source.createdAt.toISOString() : null,
    speechSeconds:
      typeof doc.speechSeconds === "number" ? doc.speechSeconds : null,
    errorCode: doc.errorCode ?? null,
    consentAt: doc.consentAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
  };
}

/** The workspace's newest voice not removed (live, or the failed one saying why); null for none. */
export async function loadProductVoice(
  workspaceId: string
): Promise<ProductVoiceRecord | null> {
  const doc = await ProductVoice.findOne({
    workspaceId,
    removedAt: null,
    state: { $ne: "removed" },
  })
    .sort({ createdAt: -1 })
    .lean<IProductVoice | null>();
  return doc ? toVoiceRecord(workspaceId, doc) : null;
}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === 11000;

/**
 * The video to clone from: the one asked for, else the one with the most
 * speech among the videos the products came from. Null when none has a
 * video in this workspace.
 */
async function cloneSource(
  workspaceId: string,
  request: Pick<ProductVoiceCreateRequest, "importId" | "productIds">
): Promise<{
  importId: string;
  speechSeconds: number;
  createdAt: Date | null;
  productNames: string[];
} | null> {
  let importIds: string[] = request.importId ? [request.importId] : [];
  let products: Array<{ importId?: unknown; name?: unknown }> = [];
  if (importIds.length === 0 && request.productIds?.length) {
    products = await WorkspaceProduct.find({
      workspaceId,
      _id: { $in: request.productIds },
    })
      .select("importId name")
      .lean<Array<{ importId?: unknown; name?: unknown }>>();
    importIds = [
      ...new Set(
        products.flatMap(product =>
          product.importId ? [String(product.importId)] : []
        )
      ),
    ];
  }
  if (importIds.length === 0) return null;
  const imports = await ProductVideoImport.find({
    workspaceId,
    _id: { $in: importIds },
  })
    .select("transcript video.bucket video.path createdAt")
    .lean<
      Array<{
        _id: unknown;
        transcript?: string | null;
        video?: { bucket?: string; path?: string } | null;
        createdAt?: Date | null;
      }>
    >();
  const withVideo = imports
    .filter(entry => entry.video?.bucket && entry.video.path)
    .map(entry => ({
      importId: String(entry._id),
      speechSeconds: narrationSpeechSeconds(entry.transcript),
      createdAt: entry.createdAt ?? null,
      productNames: products.flatMap(product =>
        String(product.importId) === String(entry._id) &&
        typeof product.name === "string"
          ? [product.name]
          : []
      ),
    }))
    .sort((a, b) => b.speechSeconds - a.speechSeconds);
  return withVideo[0] ?? null;
}

/**
 * The video a copy of the owner's voice would be made from for these
 * products, before they agree: the consent then names that video, and is
 * sent for it (`importId`), so the voice copied is the one they saw.
 */
export async function productVoiceSource(
  workspaceId: string,
  productIds: readonly string[]
): Promise<ProductVoiceSource | null> {
  const source = await cloneSource(workspaceId, {
    productIds: [...productIds],
  });
  return source
    ? {
        importId: source.importId,
        sourceVideoAt: source.createdAt ? source.createdAt.toISOString() : null,
        speechSeconds: source.speechSeconds,
        productNames: source.productNames,
      }
    : null;
}

/**
 * The owner's consent to clone their voice: the workspace's live voice when
 * it has one; else a pending voice made from the video, which the first ad
 * read in "Your voice, new words" clones; or, for a video with under
 * PRODUCT_VOICE_MIN_SPEECH_SECONDS of speech, a failed one saying so.
 */
export async function createProductVoice(params: {
  workspaceId: string;
  userId: string;
  request: ProductVoiceCreateRequest;
  now?: Date;
}): Promise<
  | { voice: ProductVoiceRecord; created: boolean }
  | { refused: "import_not_found" | "voice_unavailable" }
> {
  const { workspaceId, userId, request } = params;
  if (!isElevenLabsVoicesConfigured()) return { refused: "voice_unavailable" };
  const live = await ProductVoice.findOne({
    workspaceId,
    ...LIVE,
  }).lean<IProductVoice | null>();
  if (live) {
    const record = await toVoiceRecord(workspaceId, live);
    if (record) return { voice: record, created: false };
  }
  const source = await cloneSource(workspaceId, request);
  if (!source) return { refused: "import_not_found" };
  const now = params.now ?? new Date();
  const enough = source.speechSeconds >= PRODUCT_VOICE_MIN_SPEECH_SECONDS;
  try {
    const doc = await ProductVoice.create({
      workspaceId,
      state: enough ? "pending" : "failed",
      live: enough,
      sourceImportId: source.importId,
      consentBy: userId,
      consentAt: now,
      speechSeconds: source.speechSeconds,
      errorCode: enough ? null : "too_little_speech",
      errorMessage: enough
        ? null
        : `The narration has about ${source.speechSeconds} s of speech`,
    });
    const record = await toVoiceRecord(workspaceId, doc.toObject());
    if (!record) throw new Error("The new voice reads as removed");
    return { voice: record, created: true };
  } catch (error) {
    // Two consent presses at once: the first made the voice.
    if (!isDuplicateKeyError(error)) throw error;
    const first = await ProductVoice.findOne({
      workspaceId,
      ...LIVE,
    }).lean<IProductVoice | null>();
    const record = first ? await toVoiceRecord(workspaceId, first) : null;
    if (!record) throw error;
    return { voice: record, created: false };
  }
}

/** How many times Remove reads, deletes and marks again while a run saves a clone under it. */
const REMOVE_ROUNDS = 3;

type RemovableVoice = Pick<
  IProductVoice,
  "_id" | "elevenVoiceId" | "orphanVoiceIds" | "removedAt"
>;

/**
 * "Remove my voice": deleted at ElevenLabs first, then marked removed, so a
 * voice ElevenLabs still has is never shown as gone; with it go any clones a
 * run made of it and couldn't delete. A voice being made now is removed too:
 * each is marked only while it holds the clone read here, so a clone the run
 * saves meanwhile is read again and deleted in the next round (or, marked
 * first, the run finds it removed and deletes its clone itself). A workspace
 * without a voice gets the same answer.
 */
export async function removeProductVoice(params: {
  workspaceId: string;
  now?: Date;
}): Promise<{ removed: boolean } | { refused: "voice_unavailable" }> {
  const { workspaceId } = params;
  const removedAt = params.now ?? new Date();
  for (let round = 0; round < REMOVE_ROUNDS; round += 1) {
    const docs = await ProductVoice.find({
      workspaceId,
      $or: [
        { removedAt: null, state: { $ne: "removed" } },
        { "orphanVoiceIds.0": { $exists: true } },
      ],
    })
      .select("_id elevenVoiceId orphanVoiceIds removedAt")
      .lean<RemovableVoice[]>();
    if (docs.length === 0) return { removed: round > 0 };
    for (const doc of docs)
      for (const voiceId of [
        doc.elevenVoiceId,
        ...(doc.orphanVoiceIds ?? []),
      ]) {
        if (!voiceId) continue;
        try {
          await deleteElevenLabsVoice(voiceId);
        } catch (error) {
          logger.error("[Products] voice delete at ElevenLabs failed", error, {
            event: "products.voice_delete_failed",
            workspaceId,
          });
          return { refused: "voice_unavailable" };
        }
      }
    let settled = true;
    for (const doc of docs) {
      const marked = await ProductVoice.updateOne(
        { _id: doc._id, workspaceId, elevenVoiceId: doc.elevenVoiceId ?? null },
        {
          $set: {
            state: "removed",
            live: false,
            elevenVoiceId: null,
            removedAt: doc.removedAt ?? removedAt,
            claimedAt: null,
          },
          $pullAll: { orphanVoiceIds: doc.orphanVoiceIds ?? [] },
        }
      );
      // A run saved a clone on it meanwhile: read it again, and delete that.
      if (marked.matchedCount === 0) settled = false;
    }
    if (settled) return { removed: true };
  }
  logger.error("[Products] voice remove didn't settle", undefined, {
    event: "products.voice_remove_unsettled",
    workspaceId,
  });
  return { refused: "voice_unavailable" };
}

// ---------------------------------------------------------------------------
// Airi voices' samples.

/** The sample text's version: bump it with PRODUCT_AD_VOICE_SAMPLE_TEXT. */
export const VOICE_SAMPLE_VERSION = 1;
const SAMPLE_FORMAT = "mp3_22050_32";

/** The Airi voices for `language`, each with its sample's link. */
export function productVoiceSamples(
  workspaceId: string,
  language: ProductShopWordsCode
): ProductVoiceSamplesResponse {
  return {
    language,
    samples: PRODUCT_AD_STOCK_VOICES.filter(voice =>
      voice.languages.includes(language)
    ).map(voice => ({
      voiceId: voice.id,
      name: voice.name,
      about: voice.about,
      url: `/api/workspaces/${encodeURIComponent(workspaceId)}/products/voice/samples/${encodeURIComponent(voice.id)}?language=${language}`,
    })),
  };
}

/**
 * One Airi voice's sample in `language`: kept from before, or made now
 * (ElevenLabs on airi's key, a few seconds of speech) and kept for every
 * workspace. Null for a voice that isn't one of airi's, or when ElevenLabs
 * isn't set up. It's airi's own cost, a fraction of a cent once per voice
 * and language, so no workspace's AI ledger books it; but a company that
 * turned AI off makes none (WorkspaceAiAccessError), and plays only kept ones.
 */
export async function productVoiceSampleAudio(
  workspaceId: string,
  voiceId: string,
  language: ProductShopWordsCode
): Promise<{ audio: Buffer; mimeType: string } | null> {
  const voice = productAdStockVoice(voiceId);
  if (!voice || !voice.languages.includes(language)) return null;
  const key = { voiceId: voice.id, language, version: VOICE_SAMPLE_VERSION };
  // Hydrated, so the audio reads back as a Buffer.
  const kept = await ProductVoiceSample.findOne(key).select("audio mimeType");
  if (kept && Buffer.isBuffer(kept.audio) && kept.audio.length > 0)
    return { audio: Buffer.from(kept.audio), mimeType: kept.mimeType };
  if (!isElevenLabsVoicesConfigured()) return null;
  // Main's rule covers every provider and payer, airi's own key included.
  await productImportSpend.assertAiEnabled(workspaceId);
  const text = PRODUCT_AD_VOICE_SAMPLE_TEXT[language];
  const speech = await speakElevenLabsWithTimestamps(
    {
      voiceId: voice.id,
      text,
      modelId: elevenLabsAdSpeechModels(language).modelId,
      languageCode: language,
      outputFormat: SAMPLE_FORMAT,
    },
    { timeoutMs: 20_000 }
  );
  await ProductVoiceSample.updateOne(
    key,
    {
      $setOnInsert: {
        ...key,
        audio: speech.audio,
        mimeType: speech.mimeType,
        characters: speech.characters,
      },
    },
    { upsert: true }
  ).catch(error => {
    // Another press kept one first, or the store is down: this one still plays.
    logger.error("[Products] voice sample not kept", error, {
      event: "products.voice_sample_keep_failed",
      voiceId: voice.id,
      language,
    });
  });
  return { audio: speech.audio, mimeType: speech.mimeType };
}

// ---------------------------------------------------------------------------
// Reading an ad again in another voice.

/**
 * The finished ad read again in another voice: a "voice" run (the workflow's
 * "make" mode) that pays only for the new reading, when the new voice reads
 * new words. Only a ready ad with a video takes it. The same voice it has,
 * when it didn't fall back, starts nothing; a press repeated while its run
 * goes is answered as the ad is. The workbench's pending free changes ride
 * along, checked as PATCH checks them, so one press makes one video. When
 * the run can't start, the ad goes back to how it was and the error goes to
 * the caller.
 */
export async function changeProductAdVoice(params: {
  workspaceId: string;
  adId: string;
  request: Pick<ProductAdVoiceRequest, "voice" | "stockVoiceId" | "changes">;
  now?: Date;
}): Promise<
  | { ad: ProductAdRecord; started: boolean }
  | {
      refused:
        | "ad_not_found"
        | "ad_not_ready"
        | "voice_not_found"
        | ProductAdAdmissionStop;
    }
  | { refused: "invalid_request"; issues: string[] }
> {
  const { workspaceId, adId, request } = params;
  const stockVoiceId =
    request.voice === "stock" ? (request.stockVoiceId ?? null) : null;
  const doc = await ProductAd.findOne({
    _id: adId,
    workspaceId,
  }).lean<IProductAd | null>();
  if (!doc) return { refused: "ad_not_found" };
  const same =
    doc.voice === request.voice && (doc.stockVoiceId ?? null) === stockVoiceId;
  const current = async () => {
    const ad = await loadProductAdRecord(workspaceId, adId);
    return ad ? { ad, started: false } : ({ refused: "ad_not_found" } as const);
  };
  // The same press again while its run goes.
  if (doc.status === "making" && doc.runKind === "voice" && same)
    return current();
  if (doc.status !== "ready" || !doc.render || !doc.script)
    return { refused: "ad_not_ready" };
  // A voice run that failed fell back to ready with the voice it asked for
  // stored but not in the video (the worker's edit-run fallback), so the
  // same voice is read again rather than answered as already there.
  const voiceRunFailed =
    doc.lastRun?.kind === "voice" &&
    doc.lastRun.outcome === "failed" &&
    doc.lastRun.renderNo === doc.renderNo;
  if (same && !doc.voiceResult?.fallback && !voiceRunFailed) return current();
  const changes = request.changes ?? null;
  if (changes) {
    const issues = adChangesIssues(doc, changes);
    if (issues.length > 0) return { refused: "invalid_request", issues };
  }
  if (request.voice === "clone") {
    const live = await ProductVoice.exists({ workspaceId, ...LIVE });
    if (!live) return { refused: "voice_not_found" };
  }
  // New words are paid for in the ad's action, and so is the recording on
  // an ad that never had it cleaned up (productAdRecordingIsPaid); the
  // recording kept and silence aren't.
  if (
    request.voice === "clone" ||
    request.voice === "stock" ||
    (request.voice === "own" && productAdRecordingIsPaid(doc))
  ) {
    const stop = await adAdmissionStop(workspaceId, {
      admitted: (doc.costMicros ?? 0) > 0,
    });
    if (stop) return { refused: stop };
  }
  const renderNo = doc.renderNo + 1;
  const updated = await ProductAd.findOneAndUpdate(
    { _id: adId, workspaceId, status: "ready", renderNo: doc.renderNo },
    {
      $set: {
        ...(changes ? adChangesSet(doc, changes) : {}),
        voice: request.voice,
        stockVoiceId,
        // The old fallback was the old voice's: the run writes the new
        // voice's own (the recording and silence have none).
        voiceResult: null,
        runKind: "voice",
        status: "making",
        step: "video",
        renderNo,
        requestedAt: params.now ?? new Date(),
        startedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    },
    { new: true }
  ).lean<IProductAd | null>();
  // Another change or run got there first.
  if (!updated) return { refused: "ad_not_ready" };
  try {
    await startAdRun(workspaceId, adId, renderNo, "make");
  } catch (error) {
    logger.error("[Products] ad voice run start failed", error, {
      event: "products.ad_voice_start_failed",
      workspaceId,
      adId,
      renderNo,
    });
    await ProductAd.updateOne(
      { _id: adId, workspaceId, renderNo },
      {
        $set: {
          ...(changes
            ? {
                script: doc.script,
                scenes: doc.scenes,
                motion: productAdMotionOf(doc.motion),
              }
            : {}),
          voice: doc.voice,
          stockVoiceId: doc.stockVoiceId ?? null,
          voiceResult: doc.voiceResult ?? null,
          runKind: doc.runKind ?? "make",
          status: "ready",
          step: null,
          renderNo: doc.renderNo,
          requestedAt: doc.requestedAt ?? doc.createdAt,
          startedAt: doc.startedAt ?? null,
        },
      }
    );
    throw error;
  }
  const ad = await loadProductAdRecord(workspaceId, adId);
  if (!ad) return { refused: "ad_not_found" };
  return { ad, started: true };
}
