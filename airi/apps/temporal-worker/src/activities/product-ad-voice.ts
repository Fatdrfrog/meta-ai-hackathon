import {
  elevenLabsAudioIsolationCostMicros,
  isElevenLabsAudioIsolationConfigured,
  isolateElevenLabsAudio,
} from "@icecore/airi-runtime/elevenlabs-audio-isolation";
import { elevenLabsSpeechCostMicros } from "@icecore/airi-runtime/elevenlabs-pricing";
import { speakElevenLabsWithTimestamps } from "@icecore/airi-runtime/elevenlabs-tts";
import {
  createElevenLabsInstantVoice,
  deleteElevenLabsVoice,
  findElevenLabsVoicesByName,
  isElevenLabsVoicesConfigured,
} from "@icecore/airi-runtime/elevenlabs-voices";
import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import type { ProductAdActivityInput } from "@icecore/temporal";
import type { CloneOutcome } from "../media/product-video/ad/voice-clone.js";
import type {
  VoiceOverPorts,
  WorkspaceVoice,
} from "../media/product-video/ad/voice.js";

// The voice-over's ports for one ad run (Part V): ElevenLabs' text to speech
// on airi's platform key, and the workspace's cloned voice, read and made
// through the web host's ProductVoice as the ad activity reads the ad. The
// ad activity calls this once per run and hands the result to the job;
// nothing here touches Mongo or ElevenLabs until the job asks.

/** A claim on a pending voice older than this is a run that stopped: another may take it. */
export const CLONE_CLAIM_MS = 10 * 60_000;
/**
 * A clone's delete gets its own time, not the run's: a run cancelled or out
 * of time must still not leave the owner's voice at ElevenLabs.
 */
const REMOVE_TIMEOUT_MS = 20_000;

async function loadWebHost() {
  const host = await import("@/lib/products/import-worker-host");
  return readDefaultExport<typeof host>(host);
}

type Host = Pick<
  Awaited<ReturnType<typeof loadWebHost>>,
  "ProductVoice" | "ProductVideoImport" | "productImportSpend"
>;

const ref = (
  value: { bucket?: string | null; path?: string | null } | null | undefined,
) =>
  value?.bucket && value.path
    ? { bucket: value.bucket, path: value.path }
    : null;

/** The workspace's live voice: its newest one, pending or ready, not removed. */
const LIVE = { state: { $in: ["pending", "ready"] }, removedAt: null };

/**
 * The ports, over `host` (the web's models); `now` for the tests. Exported
 * for the tests; the activity calls productAdVoiceOverPorts.
 */
export function voiceOverPortsFor(
  host: Host,
  input: Pick<ProductAdActivityInput, "workspaceId" | "adId" | "renderNo">,
  signal: AbortSignal,
  now: () => Date = () => new Date(),
): VoiceOverPorts {
  const { ProductVoice, ProductVideoImport, productImportSpend } = host;
  const { workspaceId } = input;
  // The pending voice this run read, which only it may claim and finish.
  let pendingId: unknown = null;
  // The run (not just the ad): its retried attempt takes its claim back,
  // a newer run of the same ad doesn't.
  const runKey = `${input.adId}:${input.renderNo}`;
  // The clone's name at ElevenLabs carries the voice it was made for.
  const cloneName = () => `airi products ${String(pendingId)}`;
  const remove = async (voiceId: string) => {
    try {
      await deleteElevenLabsVoice(voiceId, {
        signal: AbortSignal.timeout(REMOVE_TIMEOUT_MS),
      });
    } catch (error) {
      // Kept on the voice, so "Remove my voice" deletes it later.
      await ProductVoice.updateOne(
        { _id: pendingId, workspaceId },
        { $addToSet: { orphanVoiceIds: voiceId } },
      );
      throw error;
    }
  };
  return {
    speak: (request) =>
      speakElevenLabsWithTimestamps(
        {
          voiceId: request.voiceId,
          text: request.text,
          modelId: request.modelId,
          languageCode: request.languageCode,
        },
        { signal },
      ),
    speechCostMicros: elevenLabsSpeechCostMicros,
    async workspaceVoice(): Promise<WorkspaceVoice | null> {
      const doc = await ProductVoice.findOne({ workspaceId, ...LIVE })
        .sort({ createdAt: -1 })
        .select("state elevenVoiceId")
        .lean();
      if (!doc) return null;
      if (doc.state === "ready" && doc.elevenVoiceId)
        return { state: "ready", voiceId: doc.elevenVoiceId };
      if (doc.state === "pending") {
        pendingId = doc._id;
        return { state: "pending" };
      }
      return null;
    },
    clone: {
      // The company's AI switch, read again now (main's workspace-ai-access).
      assertAiEnabled: () => productImportSpend.assertAiEnabled(workspaceId),
      async claim() {
        if (!pendingId) return false;
        const claimed = await ProductVoice.updateOne(
          {
            _id: pendingId,
            workspaceId,
            state: "pending",
            removedAt: null,
            $or: [
              { claimedAt: null },
              {
                claimedAt: { $lt: new Date(now().getTime() - CLONE_CLAIM_MS) },
              },
              { claimedBy: runKey },
            ],
          },
          { $set: { claimedAt: now(), claimedBy: runKey } },
        );
        return claimed.modifiedCount > 0;
      },
      async release() {
        if (!pendingId) return;
        await ProductVoice.updateOne(
          { _id: pendingId, workspaceId, state: "pending", claimedBy: runKey },
          { $set: { claimedAt: null, claimedBy: null } },
        );
      },
      async source() {
        const voice = await ProductVoice.findOne({
          _id: pendingId,
          workspaceId,
        })
          .select("sourceImportId")
          .lean();
        if (!voice?.sourceImportId) return null;
        const source = await ProductVideoImport.findOne({
          _id: voice.sourceImportId,
          workspaceId,
        })
          .select("transcript video.bucket video.path")
          .lean();
        const video = ref(source?.video);
        return video ? { video, transcript: source?.transcript ?? null } : null;
      },
      isolate: isElevenLabsAudioIsolationConfigured()
        ? async (wav) =>
            (
              await isolateElevenLabsAudio(
                {
                  audio: wav,
                  filename: "narration.wav",
                  mimeType: "audio/wav",
                },
                { signal },
              )
            ).audio
        : null,
      isolationCostMicros: elevenLabsAudioIsolationCostMicros,
      async create(sample) {
        const made = await createElevenLabsInstantVoice(
          {
            name: cloneName(),
            description:
              "A shop owner's voice for their airi video ads, cloned with their consent.",
            samples: [sample],
          },
          { signal },
        );
        return made.voiceId;
      },
      remove,
      async sweep() {
        if (!pendingId) return;
        const held = await ProductVoice.findOne({ _id: pendingId, workspaceId })
          .select("elevenVoiceId")
          .lean();
        const found = await findElevenLabsVoicesByName(cloneName(), {
          signal: AbortSignal.timeout(REMOVE_TIMEOUT_MS),
        });
        for (const voiceId of found)
          if (voiceId !== held?.elevenVoiceId) await remove(voiceId);
      },
      async savedVoiceId() {
        const doc = await ProductVoice.findOne({ _id: pendingId, workspaceId })
          .select("elevenVoiceId removedAt")
          .lean();
        return doc && !doc.removedAt ? (doc.elevenVoiceId ?? null) : null;
      },
      async finish(outcome: CloneOutcome) {
        const set =
          outcome.state === "ready"
            ? {
                state: "ready",
                elevenVoiceId: outcome.elevenVoiceId,
                speechSeconds: outcome.speechSeconds,
                costMicros: outcome.costMicros,
                errorCode: null,
                errorMessage: null,
                claimedAt: null,
              }
            : {
                state: "failed",
                live: false,
                speechSeconds: outcome.speechSeconds,
                costMicros: outcome.costMicros,
                errorCode: outcome.errorCode,
                errorMessage: outcome.errorMessage.slice(0, 500),
                claimedAt: null,
              };
        const saved = await ProductVoice.updateOne(
          { _id: pendingId, workspaceId, state: "pending", removedAt: null },
          { $set: set },
        );
        return saved.matchedCount > 0;
      },
    },
  };
}

/** The voice-over's ports for this run; null when airi's ElevenLabs key isn't set. */
export async function productAdVoiceOverPorts(
  input: ProductAdActivityInput,
  signal: AbortSignal,
): Promise<VoiceOverPorts | null> {
  if (!isElevenLabsVoicesConfigured()) return null;
  return voiceOverPortsFor(await loadWebHost(), input, signal);
}
