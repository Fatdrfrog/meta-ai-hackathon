import { join } from "node:path";
import {
  isElevenLabsSttAcceptedRequest,
  isElevenLabsSttRefusedRequest,
} from "@icecore/airi-runtime/elevenlabs-stt";
import {
  PRODUCT_VIDEO_MAX_BYTES,
  PRODUCT_VOICE_MAX_SPEECH_SECONDS,
  PRODUCT_VOICE_MIN_SPEECH_SECONDS,
  type ProductAdFileRef,
  type ProductVoiceErrorCode,
} from "@icecore/temporal";
import { pcmSeconds, polishVoices, writeWav, type Pcm } from "./audio";
import { isMissingFile, type AdJobPorts } from "./ad-job";
import type { PaidCall } from "./spend";

// The workspace's cloned voice, made inside the first ad that asks for "Your
// voice, new words" (Part V): the owner ticked the consent on the web, which
// saved the voice as pending with the video it's made from. Here the run
// claims it, cuts up to CLONE_SOURCE_SECONDS of the video's narration from
// its first words, cleans it as the owner's own clips are cleaned (Voice
// Isolator booked in the ad's action, else ffmpeg's denoiser; EQ, gentle
// compression, long pauses tightened), and sends it to ElevenLabs as an
// Instant Voice Clone, which has no price of its own. Under
// PRODUCT_VOICE_MIN_SPEECH_SECONDS of clear speech it isn't made.

/** Narration sent at most, from the first words: about a minute of speech once tightened. */
export const CLONE_SOURCE_SECONDS = 75;
const ELEVENLABS_ISOLATION_MIN_MICROS = 10_000;

/** The video the voice is made from, with its narration's timed lines. */
export type CloneSource = {
  video: ProductAdFileRef;
  transcript: string | null;
};

/** How making the voice ended, as the workspace's voice saves it. */
export type CloneOutcome =
  | {
      state: "ready";
      elevenVoiceId: string;
      speechSeconds: number;
      costMicros: number;
    }
  | {
      state: "failed";
      errorCode: ProductVoiceErrorCode;
      errorMessage: string;
      speechSeconds: number | null;
      costMicros: number;
    };

/** What making the workspace's pending voice needs (activities/product-ad-voice.ts). */
export type VoiceClonePorts = {
  /**
   * Throws (workspace_ai_disabled) once the company turned AI off: the
   * clone itself reserves nothing, so no ledger refusal would stop it.
   */
  assertAiEnabled(): Promise<void>;
  /**
   * Takes the pending voice for this run (or takes it back, for a retried
   * attempt of the same run); false when another run has it, or it's gone.
   */
  claim(): Promise<boolean>;
  /** Lets the pending voice go again, untouched, for a later run to make. */
  release(): Promise<void>;
  source(): Promise<CloneSource | null>;
  /** ElevenLabs Voice Isolator; null when it isn't configured. */
  isolate: ((wav: Buffer) => Promise<Buffer>) | null;
  isolationCostMicros(seconds: number): number;
  /** The Instant Voice Clone: its voice id. */
  create(sample: {
    audio: Buffer;
    filename: string;
    mimeType: string;
  }): Promise<string>;
  /**
   * Deletes a clone at ElevenLabs; one that can't be deleted now is kept on
   * the voice, for "Remove my voice" to delete.
   */
  remove(voiceId: string): Promise<void>;
  /**
   * Deletes, as `remove` does, any clone ElevenLabs has under this voice's
   * name: one an earlier run made and never saved (it stopped, or the
   * create's answer was lost).
   */
  sweep(): Promise<void>;
  /** The clone the voice holds now; undefined when it can't be read. */
  savedVoiceId(): Promise<string | null | undefined>;
  /** Saves the outcome on the workspace's voice; false when it was removed meanwhile. */
  finish(outcome: CloneOutcome): Promise<boolean>;
};

export type CloneResult =
  | { ok: true; voiceId: string }
  | { ok: false; reason: "busy" | "removed" | ProductVoiceErrorCode };

/**
 * Where to cut the narration from: just before its first timed line ("[12.3]
 * …"), for CLONE_SOURCE_SECONDS. The video's start without a transcript.
 */
export function cloneWindow(transcript: string | null): {
  fromSeconds: number;
  toSeconds: number;
} {
  const match = /\[(\d+(?:\.\d+)?)\]/.exec(transcript ?? "");
  const first = match ? Number(match[1]) : 0;
  const fromSeconds = Math.max(0, Number.isFinite(first) ? first - 0.3 : 0);
  return { fromSeconds, toSeconds: fromSeconds + CLONE_SOURCE_SECONDS };
}

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Makes the workspace's pending voice now, in this run. Every final outcome
 * is saved on the voice; a voice the owner removed while it was made is
 * deleted at ElevenLabs again at once. A run cancelled, or stopped by a
 * passing failure (storage, ElevenLabs down), lets the voice go untouched
 * ("busy"; a cancelled run throws), so the owner's consent isn't lost to it,
 * and leaves no clone of it behind at ElevenLabs.
 */
export async function makeVoiceClone(run: {
  ports: VoiceClonePorts;
  storage: AdJobPorts["storage"];
  paid: PaidCall;
  workDir: string;
  signal?: AbortSignal;
  pulse(): void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<CloneResult> {
  const { ports } = run;
  // A company that turned AI off never has the owner's narration sent to
  // ElevenLabs; the voice stays pending, its consent kept, and the run fails.
  await ports.assertAiEnabled();
  if (!(await ports.claim())) return { ok: false, reason: "busy" };
  let costMicros = 0;
  const fail = async (
    errorCode: ProductVoiceErrorCode,
    errorMessage: string,
    speechSeconds: number | null,
  ): Promise<CloneResult> => {
    run.log?.("products.ad_voice_clone_failed", { errorCode, errorMessage });
    const saved = await ports.finish({
      state: "failed",
      errorCode,
      errorMessage,
      speechSeconds,
      costMicros,
    });
    return { ok: false, reason: saved ? errorCode : "removed" };
  };
  // Not the voice's fault: it goes back untouched for a later run, and a
  // cancelled run stops here.
  const letGo = async (error: unknown): Promise<CloneResult> => {
    run.log?.("products.ad_voice_clone_released", {
      error: messageOf(error),
      cancelled: Boolean(run.signal?.aborted),
    });
    await ports.release().catch((releaseError: unknown) =>
      run.log?.("products.ad_voice_clone_release_failed", {
        error: messageOf(releaseError),
      }),
    );
    if (run.signal?.aborted) throw error;
    return { ok: false, reason: "busy" };
  };
  // Any clone this voice's name has at ElevenLabs that no voice holds.
  const sweep = () =>
    ports.sweep().catch((error: unknown) =>
      run.log?.("products.ad_voice_clone_sweep_failed", {
        error: messageOf(error),
      }),
    );

  const source = await ports.source();
  if (!source) return fail("no_source", "The video is gone", null);
  const videoPath = join(run.workDir, "clone-source");
  try {
    await run.storage.download(
      source.video,
      videoPath,
      PRODUCT_VIDEO_MAX_BYTES,
    );
  } catch (error) {
    // Only a video that's gone is the voice's end; a storage blip isn't.
    if (run.signal?.aborted || !isMissingFile(error)) return letGo(error);
    return fail("no_source", messageOf(error), null);
  }
  run.pulse();

  const window = cloneWindow(source.transcript);
  const isolate = ports.isolate;
  let voice: Pcm | null = null;
  try {
    const polished = await polishVoices(
      [
        {
          productId: "clone",
          source: { kind: "video", path: videoPath, ...window },
        },
      ],
      isolate
        ? (wav, seconds) => {
            const cost = ports.isolationCostMicros(seconds);
            return run.paid(
              "clone:isolate",
              "elevenlabs",
              Math.max(ELEVENLABS_ISOLATION_MIN_MICROS, cost),
              async (onCost) => {
                try {
                  const value = await isolate(wav);
                  costMicros += cost;
                  return { value, costMicros: cost };
                } catch (error) {
                  // A 2xx whose answer was lost still billed the audio.
                  if (isElevenLabsSttAcceptedRequest(error)) {
                    costMicros += cost;
                    onCost(cost / 1_000_000, "voice isolation");
                  }
                  throw error;
                }
              },
            );
          }
        : null,
      run.workDir,
      {
        signal: run.signal,
        pulse: run.pulse,
        onIsolatorSkipped: (reason, detail) =>
          run.log?.("products.ad_voice_clone_isolation_skipped", {
            reason,
            detail,
          }),
      },
    );
    voice = polished[0]?.voice ?? null;
  } catch (error) {
    if (run.signal?.aborted) return letGo(error);
    return fail("no_source", messageOf(error), null);
  }
  const seconds = voice ? pcmSeconds(voice) : 0;
  if (!voice || seconds < PRODUCT_VOICE_MIN_SPEECH_SECONDS)
    return fail(
      "too_little_speech",
      `The narration has ${seconds.toFixed(1)} s of clear speech`,
      Math.round(seconds * 10) / 10,
    );
  const kept =
    seconds > PRODUCT_VOICE_MAX_SPEECH_SECONDS
      ? {
          samples: voice.samples.slice(
            0,
            Math.round(PRODUCT_VOICE_MAX_SPEECH_SECONDS * voice.sampleRate),
          ),
          sampleRate: voice.sampleRate,
        }
      : voice;
  const speechSeconds = Math.round(pcmSeconds(kept) * 10) / 10;
  run.pulse();

  // Asked again right before the narration leaves: AI may have been turned
  // off while it was cleaned. The voice goes back untouched, still pending.
  try {
    await ports.assertAiEnabled();
  } catch (error) {
    await ports.release().catch(() => undefined);
    throw error;
  }
  // A run before this one may have made the clone and stopped before
  // saving it: that one goes first, so the voice is never at ElevenLabs twice.
  await sweep();
  let voiceId: string;
  try {
    voiceId = await ports.create({
      audio: writeWav(kept),
      filename: "narration.wav",
      mimeType: "audio/wav",
    });
  } catch (error) {
    // ElevenLabs refused it (a 4xx): the voice can't be made from this.
    if (!run.signal?.aborted && isElevenLabsSttRefusedRequest(error))
      return fail("clone_failed", messageOf(error), speechSeconds);
    // The answer may have been lost after ElevenLabs made it.
    await sweep();
    return letGo(error);
  }
  let saved: boolean;
  try {
    saved = await ports.finish({
      state: "ready",
      elevenVoiceId: voiceId,
      speechSeconds,
      costMicros,
    });
  } catch (error) {
    // Unless the voice holds it after all, the clone would be at
    // ElevenLabs with no record of it, out of the owner's reach.
    const held = await ports.savedVoiceId().catch(() => undefined);
    if (held !== voiceId)
      await ports.remove(voiceId).catch((removeError: unknown) =>
        run.log?.("products.ad_voice_clone_orphaned", {
          voiceId,
          error: messageOf(removeError),
        }),
      );
    throw error;
  }
  if (!saved) {
    // "Remove my voice" was pressed while it was made: it goes again now.
    await ports.remove(voiceId).catch((error: unknown) =>
      run.log?.("products.ad_voice_clone_orphaned", {
        voiceId,
        error: messageOf(error),
      }),
    );
    return { ok: false, reason: "removed" };
  }
  run.log?.("products.ad_voice_cloned", { speechSeconds, costMicros });
  return { ok: true, voiceId };
}
