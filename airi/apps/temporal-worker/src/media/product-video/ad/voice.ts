import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ElevenLabsSttError,
  isElevenLabsSttAcceptedRequest,
} from "@icecore/airi-runtime/elevenlabs-stt";
import {
  elevenLabsAdSpeechModels,
  elevenLabsSpokenSpan,
  type ElevenLabsSpeech,
} from "@icecore/airi-runtime/elevenlabs-tts";
import {
  productAdForeignKazakhLetters,
  productAdPriceSpeech,
  productAdPriceSpeechIssues,
  productAdShelfPrice,
  productAdSpeechCode,
  productAdSpeechSeconds,
  productAdSpokenNumbers,
  productAdStockVoice,
  type ProductAdMode,
  type ProductAdScript,
  type ProductAdSpeechCode,
  type ProductAdVoiceFallback,
  type ProductAdVoiceOver,
} from "@icecore/temporal";
import type { AdJobPorts, AdRecord } from "./ad-job";
import {
  changeTempo,
  cutSpeech,
  decodeVoice,
  encodeFlac,
  findPauses,
  pcmSeconds,
  planSpeech,
  type Pcm,
} from "./audio";
import { planTimeline } from "./layout";
import { AdSpendRefusal, type PaidCall } from "./spend";
import { makeVoiceClone, type VoiceClonePorts } from "./voice-clone";

// The ad's voice-over in new words (Part V): the script's spoken lines read
// by ElevenLabs, in the workspace's clone of the owner ("clone") or one of
// airi's voices ("stock"). ad-job.ts calls newWordsVoices for those two
// modes and places the lines exactly as it places the owner's recorded
// clips, one per product's scene (layout.ts fits each scene to its line).
//
// Each scene says Muse Spark's short line, then the shelf price in words
// code wrote and read back (ad-voice.ts); a line with a number of its own is
// replaced by the product's name. Before paying, the lines are fitted to the
// timeline by an estimate (a line too long drops to the price alone, then to
// the words alone); after, each is trimmed to its words by ElevenLabs'
// character timestamps and, when still a little long, said up to 15% faster.
// Every read is booked in the ad's one AI action (`tts:<productId>`). A
// "render" run never pays: it reuses the kept lines when the voice and the
// words are the same, or falls back. Anything short of the new words returns
// a fallback, and ad-job.ts uses the recording instead (silence without one)
// and saves why on the ad (`voiceResult`).

/** The workspace's cloned voice, as a run reads it. */
export type WorkspaceVoice =
  | { state: "ready"; voiceId: string }
  | { state: "pending" };

/** The audio steps, ffmpeg's by default; the tests' fakes. */
export type VoiceAudio = {
  decode(audio: Buffer, name: string): Promise<Pcm>;
  tempo(voice: Pcm, factor: number, name: string): Promise<Pcm>;
  flac(voice: Pcm, name: string): Promise<Buffer>;
};

/**
 * What reading the new words needs beyond the run's own ports: ElevenLabs'
 * text to speech and its list price, the workspace's cloned voice, and making
 * it when it's still pending. The activity builds them
 * (activities/product-ad-voice.ts); null when ElevenLabs isn't set up.
 */
export type VoiceOverPorts = {
  speak(input: {
    voiceId: string;
    text: string;
    modelId: string;
    languageCode: string | null;
  }): Promise<ElevenLabsSpeech>;
  /** The list price of reading `characters` with `modelId`, in micro-dollars. */
  speechCostMicros(characters: number, modelId: string): number;
  /** The workspace's cloned voice; null without a live one. */
  workspaceVoice(): Promise<WorkspaceVoice | null>;
  /** Making the pending voice in this run; null when it can't be made. */
  clone: VoiceClonePorts | null;
  audio?: VoiceAudio;
};

/** One run's ask for the new words. */
export type NewWordsRun = {
  ad: AdRecord;
  script: ProductAdScript;
  ports: VoiceOverPorts | null;
  /** The run's storage, to keep the lines and fetch them in a later render. */
  storage: AdJobPorts["storage"];
  /** The ad's one AI action: the text-to-speech books here. */
  paid: PaidCall;
  /** A "render" run never pays: it reuses the kept lines, or falls back. */
  mode: ProductAdMode;
  workDir: string;
  signal?: AbortSignal;
  pulse(): void;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/**
 * The new words, one line per product's scene, or why there are none. With
 * `ok`, ad-job.ts saves `voiceOver` on the ad, so a later render with the
 * same voice and words reuses it.
 */
export type NewWordsVoices =
  | { ok: true; voices: Map<string, Pcm>; voiceOver: ProductAdVoiceOver }
  | { ok: false; fallback: ProductAdVoiceFallback };

/** A line said a little long is said at most this much faster. */
export const MAX_TEMPO = 1.15;
/** Kept around the words: a breath before, and the last sound's tail after. */
const LEAD_SECONDS = 0.05;
const TAIL_SECONDS = 0.15;
const LINE_MAX_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The words each scene says.

/** What a product's scene may say: Muse Spark's line, and code's price sentence. */
export type PlannedLine = {
  productId: string;
  /** Muse Spark's line, or the product's name; "" for none. */
  line: string;
  /** The shelf price in code's words; null when code can't say it. */
  price: string | null;
};

/**
 * Each product's words: its scene's spoken line when it says no number and
 * spells Kazakh with Kazakh letters, else the product's name; and the shelf
 * price as code writes it, read back first. "price_unchecked" when a price
 * sentence doesn't read back as the shelf's amount: code never says it then.
 */
export function planVoiceLines(
  ad: Pick<AdRecord, "products" | "language" | "wordsCode" | "ending">,
  script: Pick<ProductAdScript, "scenes">,
  code: ProductAdSpeechCode | null,
): PlannedLine[] | "price_unchecked" {
  const names = [
    ad.ending.shopName,
    ...ad.products.map((product) => product.name),
  ];
  const planned: PlannedLine[] = [];
  for (const product of ad.products) {
    const spoken = (
      script.scenes.find((scene) => scene.productId === product.productId)
        ?.spoken ?? ""
    )
      .replace(/\s+/g, " ")
      .trim();
    // Code can only check for numbers in a language it has number words
    // for (kk, ru, en): in any other, a price the model wrote could be
    // said, so the scene says the product's name.
    const usable =
      code !== null &&
      spoken &&
      productAdSpokenNumbers(spoken, names).length === 0 &&
      (code !== "kk" ||
        productAdForeignKazakhLetters(spoken, names.join(" ")).length === 0);
    const name = product.name.replace(/\s+/g, " ").trim();
    const line = usable
      ? spoken
      : name
        ? /[.!?…]$/.test(name)
          ? name
          : `${name}.`
        : "";
    const shelf = productAdShelfPrice(product.priceText);
    let price: string | null = null;
    if (shelf && code) {
      price = productAdPriceSpeech(shelf, code);
      if (price && productAdPriceSpeechIssues(price, shelf).length > 0)
        return "price_unchecked";
    }
    planned.push({ productId: product.productId, line, price });
  }
  return planned;
}

/** The text a scene says, with the parts it was made of. */
export type FittedLine = { productId: string; text: string };

const joinLine = (line: string, price: string | null) => {
  if (!line) return price ?? "";
  if (!price) return line;
  return `${/[.!?…]$/.test(line) ? line : `${line}.`} ${price}`;
};

/** Each product scene's room for its words, given the words' seconds (layout.ts). */
export function voiceRooms(seconds: readonly number[]): number[] {
  const timeline = planTimeline(
    seconds.map((value) => ({ voiceSeconds: value > 0 ? value : null })),
  );
  return timeline.scenes.flatMap((scene) =>
    scene.kind === "product" ? [scene.voice ? scene.voice.seconds : 0] : [],
  );
}

/**
 * What each scene says, chosen before paying for it: the line and the
 * price; when that won't fit its scene by the estimate, the price alone,
 * then the line alone, then nothing (the scene is silent). Fitting one scene
 * changes the others' room (the ad is 10 to 20 s), so it's done until it
 * holds.
 */
export function fitVoiceLines(
  planned: readonly PlannedLine[],
  code: ProductAdSpeechCode | null,
): FittedLine[] {
  const options = planned.map((entry) =>
    [joinLine(entry.line, entry.price), entry.price ?? "", entry.line].filter(
      (text, index, all) => text && all.indexOf(text) === index,
    ),
  );
  const choice = planned.map(() => 0);
  const text = (index: number) => options[index]![choice[index]!] ?? "";
  for (let round = 0; round < 8; round++) {
    const seconds = planned.map((_, index) =>
      text(index) ? productAdSpeechSeconds(text(index), code) : 0,
    );
    const rooms = voiceRooms(seconds);
    // The longest overrun steps down first.
    let worst = -1;
    let overrun = 0;
    seconds.forEach((value, index) => {
      const over = value - rooms[index]! * MAX_TEMPO * 0.95;
      if (value > 0 && over > overrun) {
        overrun = over;
        worst = index;
      }
    });
    if (worst < 0) break;
    choice[worst] = choice[worst]! + 1;
  }
  return planned.map((entry, index) => ({
    productId: entry.productId,
    text: text(index),
  }));
}

/** The voice and the words it reads, hashed: a render with the same key reuses them. */
export function voiceOverKey(input: {
  mode: "clone" | "stock";
  voiceId: string;
  modelId: string;
  languageCode: string | null;
  lines: readonly FittedLine[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        1,
        input.mode,
        input.voiceId,
        input.modelId,
        input.languageCode,
        input.lines.map((line) => [line.productId, line.text]),
      ]),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Reading them.

function ffmpegAudio(run: NewWordsRun): VoiceAudio {
  const deps = { signal: run.signal, pulse: run.pulse };
  return {
    async decode(audio, name) {
      const path = join(run.workDir, `${name}.audio`);
      await writeFile(path, audio);
      return decodeVoice(path, run.workDir, name, deps);
    },
    tempo: (voice, factor, name) =>
      changeTempo(voice, factor, run.workDir, name, deps),
    flac: (voice, name) => encodeFlac(voice, run.workDir, name, deps),
  };
}

/** The read audio cut to its words, by the timestamps or, without them, by its pauses. */
export function trimToWords(
  voice: Pcm,
  span: { start: number; end: number } | null,
): Pcm {
  const seconds = pcmSeconds(voice);
  let from = 0;
  let to = seconds;
  if (span) {
    from = Math.max(0, span.start - LEAD_SECONDS);
    to = Math.min(seconds, span.end + TAIL_SECONDS);
  } else {
    const { pauses, speech } = findPauses(voice);
    const spans = speech ? planSpeech(seconds, pauses) : [];
    if (spans.length) {
      from = spans[0]!.from;
      to = spans.at(-1)!.to;
    }
  }
  return to > from ? cutSpeech(voice, [{ from, to }]) : voice;
}

/** Why a read failed, as the ad says it: a voice ElevenLabs no longer has, or any other. */
function readFailure(error: unknown): ProductAdVoiceFallback {
  if (error instanceof AdSpendRefusal) return "spend_refused";
  if (error instanceof ElevenLabsSttError) {
    const { status, message } = error.info;
    if (
      status === 404 ||
      (/voice/i.test(message) && /not.?found|does not exist/i.test(message))
    )
      return "no_voice";
  }
  return "unavailable";
}

/** A model ElevenLabs refused (a 4xx that isn't the key, the voice or the rate). */
function modelRefused(error: unknown): boolean {
  if (!(error instanceof ElevenLabsSttError)) return false;
  const { status, kind } = error.info;
  return (
    kind === "invalid_request" &&
    typeof status === "number" &&
    status !== 404 &&
    readFailure(error) === "unavailable"
  );
}

/** The kept lines back as audio, or null when any is missing. */
async function keptVoices(
  run: NewWordsRun,
  audio: VoiceAudio,
  kept: ProductAdVoiceOver,
): Promise<Map<string, Pcm> | null> {
  try {
    const voices = new Map<string, Pcm>();
    for (const [index, line] of kept.lines.entries()) {
      const path = join(run.workDir, `kept-line-${index}.flac`);
      await run.storage.download(line.audio, path, LINE_MAX_BYTES);
      voices.set(
        line.productId,
        await audio.decode(await readFile(path), `kept-line-${index}`),
      );
    }
    return voices;
  } catch (error) {
    run.log?.("products.ad_voice_over_kept_missing", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The ad's spoken lines read in its voice, or why they can't be. */
export async function newWordsVoices(
  run: NewWordsRun,
): Promise<NewWordsVoices> {
  const { ad, ports } = run;
  const fallback = (
    why: ProductAdVoiceFallback,
    detail?: Record<string, unknown>,
  ): NewWordsVoices => {
    run.log?.("products.ad_voice_over_fallback", { fallback: why, ...detail });
    return { ok: false, fallback: why };
  };
  const mode = ad.voice;
  if (mode !== "clone" && mode !== "stock") return fallback("unavailable");
  if (!ports) return fallback("unavailable", { reason: "not_configured" });
  const audio = ports.audio ?? ffmpegAudio(run);
  const code = productAdSpeechCode(ad.language, ad.wordsCode);
  const models = elevenLabsAdSpeechModels(code);
  const languageCode = code ?? null;

  // 1. The voice.
  let voiceId: string;
  if (mode === "stock") {
    const stock = productAdStockVoice(ad.stockVoiceId);
    if (!stock) return fallback("no_voice");
    voiceId = stock.id;
  } else {
    const own = await ports.workspaceVoice();
    if (!own) return fallback("no_voice");
    if (own.state === "ready") voiceId = own.voiceId;
    else {
      if (run.mode === "render" || !ports.clone)
        return fallback("unavailable", { reason: "pending" });
      const made = await makeVoiceClone({
        ports: ports.clone,
        storage: run.storage,
        paid: run.paid,
        workDir: run.workDir,
        signal: run.signal,
        pulse: run.pulse,
        log: run.log,
      });
      if (!made.ok)
        return fallback(
          made.reason === "removed" ? "no_voice" : "unavailable",
          {
            reason: made.reason,
          },
        );
      voiceId = made.voiceId;
    }
  }

  // 2. The words, fitted to the timeline before paying for them.
  const planned = planVoiceLines(ad, run.script, code);
  if (planned === "price_unchecked") return fallback("price_unchecked");
  const fitted = fitVoiceLines(planned, code);
  const said = fitted.filter((line) => line.text);
  if (said.length === 0) return fallback("too_long");
  const key = voiceOverKey({
    mode,
    voiceId,
    modelId: models.modelId,
    languageCode,
    lines: fitted,
  });

  // 3. The same voice and words as before: the kept lines, at no cost.
  if (ad.voiceOver?.key === key) {
    const kept = await keptVoices(run, audio, ad.voiceOver);
    if (kept) return { ok: true, voices: kept, voiceOver: ad.voiceOver };
  }
  if (run.mode === "render")
    return fallback("unavailable", { reason: "render_without_kept_lines" });

  // 4. Reading them, each booked in the ad's action.
  const read = async (line: FittedLine, modelId: string, operation: string) => {
    const cost = ports.speechCostMicros(line.text.length, modelId);
    return run.paid(operation, "elevenlabs", cost, async (onCost) => {
      try {
        return {
          value: await ports.speak({
            voiceId,
            text: line.text,
            modelId,
            languageCode,
          }),
          costMicros: cost,
        };
      } catch (error) {
        // A 2xx whose answer was lost still billed the characters.
        if (isElevenLabsSttAcceptedRequest(error))
          onCost(cost / 1_000_000, "text to speech");
        throw error;
      }
    });
  };
  let costMicros = 0;
  const settled = await Promise.allSettled(
    said.map(async (line) => {
      let speech: ElevenLabsSpeech;
      try {
        speech = await read(line, models.modelId, `tts:${line.productId}`);
      } catch (error) {
        if (!modelRefused(error)) throw error;
        run.log?.("products.ad_voice_over_model_refused", {
          modelId: models.modelId,
          error: error instanceof Error ? error.message : String(error),
        });
        speech = await read(
          line,
          models.fallbackModelId,
          `tts:${line.productId}:m2`,
        );
      }
      costMicros += ports.speechCostMicros(line.text.length, speech.modelId);
      run.pulse();
      return { line, speech };
    }),
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) {
    const error = (failed as PromiseRejectedResult).reason;
    const why = readFailure(error);
    // Only ElevenLabs and the ledger may stop the new words; anything else is a fault.
    if (
      !(error instanceof ElevenLabsSttError) &&
      !(error instanceof AdSpendRefusal)
    )
      throw error;
    return fallback(why, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const spoken = settled.map(
    (result) =>
      (
        result as PromiseFulfilledResult<{
          line: FittedLine;
          speech: ElevenLabsSpeech;
        }>
      ).value,
  );

  // 5. Each line cut to its words, and fitted to its scene.
  let lines: Array<{ line: FittedLine; voice: Pcm; modelId: string }> = [];
  try {
    for (const [index, { line, speech }] of spoken.entries())
      lines.push({
        line,
        modelId: speech.modelId,
        voice: trimToWords(
          await audio.decode(speech.audio, `line-${index}`),
          elevenLabsSpokenSpan(speech.alignment),
        ),
      });
  } catch (error) {
    return fallback("unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const secondsOf = () =>
    ad.products.map((product) => {
      const entry = lines.find(
        (item) => item.line.productId === product.productId,
      );
      return entry ? pcmSeconds(entry.voice) : 0;
    });
  const rooms = voiceRooms(secondsOf());
  const fittedLines: typeof lines = [];
  for (const [index, entry] of lines.entries()) {
    const room =
      rooms[
        ad.products.findIndex(
          (product) => product.productId === entry.line.productId,
        )
      ] ?? 0;
    const seconds = pcmSeconds(entry.voice);
    if (seconds <= room + 0.02) {
      fittedLines.push(entry);
      continue;
    }
    const factor = seconds / Math.max(0.1, room);
    if (factor > MAX_TEMPO) {
      run.log?.("products.ad_voice_over_line_dropped", {
        productId: entry.line.productId,
        seconds,
        room,
      });
      continue;
    }
    try {
      fittedLines.push({
        ...entry,
        voice: await audio.tempo(
          entry.voice,
          Math.min(MAX_TEMPO, factor * 1.01),
          `line-${index}`,
        ),
      });
    } catch (error) {
      return fallback("unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  lines = fittedLines;
  if (lines.length === 0) return fallback("too_long");

  // 6. Kept for later renders.
  const voices = new Map<string, Pcm>();
  const kept: ProductAdVoiceOver["lines"] = [];
  try {
    for (const [index, entry] of lines.entries()) {
      const flac = await audio.flac(entry.voice, `voice-over-${index}`);
      const ref = await run.storage.save({
        buffer: flac,
        mimeType: "audio/flac",
        fileName: `voice-over-${entry.line.productId}.flac`,
        kind: "audio",
      });
      voices.set(entry.line.productId, entry.voice);
      kept.push({
        productId: entry.line.productId,
        text: entry.line.text,
        audio: ref,
        seconds: Math.round(pcmSeconds(entry.voice) * 1000) / 1000,
      });
    }
  } catch (error) {
    return fallback("unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ok: true,
    voices,
    voiceOver: {
      mode,
      voiceId,
      modelId: lines[0]!.modelId,
      lines: kept,
      key,
      costMicros,
      madeAt: new Date(),
    },
  };
}
