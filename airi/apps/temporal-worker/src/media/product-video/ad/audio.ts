import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../../process-runner";
import type { RunProcess } from "../media";
import { PULSE_INTERVAL_MS } from "../pulse";

// The ad's voice: the owner's OWN words from their video, polished. For each
// product, the stretch the import's review clip plays (the owner saying its
// price) is cut from the video's original sound; background noise and music
// are turned down (ElevenLabs Voice Isolator, else ffmpeg's denoiser), not
// removed: on the paid gate's footage the isolator took 2-5 dB off the
// noise floor and 1-2 dB off QazOner's music bed, which stays audible; the
// voice is evened (EQ and gentle compression); long pauses are tightened,
// with a short fade at every cut; and the whole track is normalised to
// about -16 LUFS and -1.5 dBTP. It still sounds like the owner: nothing is
// synthesised. ffmpeg does the filtering; the cutting, pauses and placing
// are done here on the samples, so they read the same on every ffmpeg.

export const VOICE_SAMPLE_RATE = 48_000;
const FFMPEG_TIMEOUT_MS = 2 * 60_000;
// Local files only, in the formats the voice passes through.
const INPUT_GUARD = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,matroska,webm,wav,mp3,ogg,flac",
];

export type VoiceDeps = {
  runProcess?: RunProcess;
  signal?: AbortSignal;
  pulse?: () => void;
};

function ffmpeg(args: string[], deps: VoiceDeps, logLevel = "error") {
  return (deps.runProcess ?? runProcess)({
    command: "ffmpeg",
    args: [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-v",
      logLevel,
      ...args,
    ],
    timeoutMs: FFMPEG_TIMEOUT_MS,
    signal: deps.signal,
    onPulse: deps.pulse,
    pulseIntervalMs: deps.pulse ? PULSE_INTERVAL_MS : undefined,
  });
}

const input = (path: string) => [...INPUT_GUARD, "-i", path];
const PCM_OUT = [
  "-ac",
  "1",
  "-ar",
  String(VOICE_SAMPLE_RATE),
  "-c:a",
  "pcm_s16le",
];

// ---------------------------------------------------------------------------
// Samples: 16-bit mono PCM at 48 kHz, read from and written to WAV.

export type Pcm = { samples: Int16Array; sampleRate: number };

/** The PCM in a 16-bit WAV file, its channels mixed to mono. */
export function readWav(file: Buffer): Pcm {
  if (
    file.toString("ascii", 0, 4) !== "RIFF" ||
    file.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("Not a WAV file");
  let offset = 12;
  let channels = 1;
  let sampleRate = VOICE_SAMPLE_RATE;
  let bits = 16;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = file.readUInt16LE(body + 2);
      sampleRate = file.readUInt32LE(body + 4);
      bits = file.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16)
        throw new Error(`WAV has ${bits}-bit samples; 16 expected`);
      const end = Math.min(file.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++)
          sum += file.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = Math.round(sum / channels);
      }
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data");
}

/** A 16-bit mono WAV file. */
export function writeWav(pcm: Pcm): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 2);
  pcm.samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export const pcmSeconds = (pcm: Pcm) => pcm.samples.length / pcm.sampleRate;

// ---------------------------------------------------------------------------
// Getting the owner's words.

/**
 * Where a product's words are: the import's original video, cut at the
 * review clip's window, or the review clip saved with the product (its
 * sound is the original's too, in a smaller copy).
 */
export type VoiceSource =
  | { kind: "video"; path: string; fromSeconds: number; toSeconds: number }
  | { kind: "clip"; path: string };

/**
 * The sound of a voice source as 48 kHz mono WAV; null for a video without
 * sound.
 */
export async function extractVoice(
  source: VoiceSource,
  outPath: string,
  deps: VoiceDeps = {},
): Promise<Pcm | null> {
  const window =
    source.kind === "video"
      ? [
          "-ss",
          Math.max(0, source.fromSeconds).toFixed(3),
          ...input(source.path),
          "-t",
          Math.max(0.1, source.toSeconds - source.fromSeconds).toFixed(3),
        ]
      : input(source.path);
  try {
    await ffmpeg(
      [...window, "-map", "0:a:0", "-vn", ...PCM_OUT, outPath],
      deps,
    );
  } catch (error) {
    if (/matches no streams|does not contain any stream/i.test(String(error)))
      return null;
    throw error;
  }
  const pcm = readWav(await readFile(outPath));
  return pcm.samples.length > 0 ? pcm : null;
}

/** Gap between clips sent to the Voice Isolator together. */
const JOIN_GAP_SECONDS = 0.6;
/**
 * The Voice Isolator refuses a recording under 4.6 s ("Audio duration is 3.8
 * seconds, which is below the minimum of 4.6 seconds", HTTP 400, seen in the
 * paid gate on 2026-11-02): a shorter one is sent with silence after it.
 */
export const ISOLATOR_MIN_SECONDS = 5;

/**
 * The clips as one recording, a gap of silence between them, so the Voice
 * Isolator is called once: where each clip starts in it, and its length. It
 * lasts at least ISOLATOR_MIN_SECONDS, the silence at its end made longer.
 */
export function joinClips(clips: Pcm[]): {
  joined: Pcm;
  spans: Array<{ start: number; length: number }>;
} {
  const gap = Math.round(JOIN_GAP_SECONDS * VOICE_SAMPLE_RATE);
  const total = Math.max(
    clips.reduce((sum, clip) => sum + clip.samples.length, 0) +
      gap * (clips.length + 1),
    Math.round(ISOLATOR_MIN_SECONDS * VOICE_SAMPLE_RATE),
  );
  const samples = new Int16Array(total);
  const spans: Array<{ start: number; length: number }> = [];
  let at = gap;
  for (const clip of clips) {
    samples.set(clip.samples, at);
    spans.push({ start: at, length: clip.samples.length });
    at += clip.samples.length + gap;
  }
  return { joined: { samples, sampleRate: VOICE_SAMPLE_RATE }, spans };
}

/** The clips back out of the isolated recording, by where they were put. */
export function splitClips(
  isolated: Pcm,
  spans: Array<{ start: number; length: number }>,
): Pcm[] {
  return spans.map(({ start, length }) => ({
    samples: isolated.samples.slice(
      start,
      Math.min(isolated.samples.length, start + length),
    ),
    sampleRate: isolated.sampleRate,
  }));
}

/** Why the Voice Isolator's answer wasn't used, so the denoiser stepped in. */
export type IsolatorSkip = "call_failed" | "undecodable" | "length_mismatch";

export type PolishDeps = VoiceDeps & {
  /**
   * Told when the isolator was asked but its answer couldn't be used, with
   * why: a fallback to the denoiser is otherwise silent (the paid gate
   * found the isolator refusing short recordings only by calling it alone).
   */
  onIsolatorSkipped?: (reason: IsolatorSkip, detail: string) => void;
};

const detailOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * The clips without their background, by the Voice Isolator: one call for
 * all of them, its answer decoded and cut back into the clips. Null when it
 * can't be used, for the denoiser to step in: no isolator, a failed call,
 * or an answer whose length doesn't match what was sent; each but the first
 * is told to `onIsolatorSkipped`.
 */
export async function isolateClips(
  clips: Pcm[],
  isolate: ((wav: Buffer, seconds: number) => Promise<Buffer>) | null,
  workDir: string,
  deps: PolishDeps = {},
): Promise<Pcm[] | null> {
  if (!isolate || clips.length === 0) return null;
  const skipped = (reason: IsolatorSkip, detail: string) => {
    deps.onIsolatorSkipped?.(reason, detail);
    return null;
  };
  const { joined, spans } = joinClips(clips);
  let answer: Buffer;
  try {
    answer = await isolate(writeWav(joined), pcmSeconds(joined));
  } catch (error) {
    return skipped("call_failed", detailOf(error));
  }
  const answerPath = join(workDir, "isolated.audio");
  const decodedPath = join(workDir, "isolated.wav");
  await writeFile(answerPath, answer);
  try {
    await ffmpeg([...input(answerPath), ...PCM_OUT, decodedPath], deps);
  } catch (error) {
    return skipped("undecodable", detailOf(error));
  }
  const isolated = readWav(await readFile(decodedPath));
  // The isolator answers the whole recording; one much shorter or longer
  // can't be cut back into the clips by position.
  if (Math.abs(pcmSeconds(isolated) - pcmSeconds(joined)) > 0.25)
    return skipped(
      "length_mismatch",
      `sent ${pcmSeconds(joined).toFixed(2)} s, got ${pcmSeconds(isolated).toFixed(2)} s`,
    );
  return splitClips(isolated, spans);
}

/**
 * ffmpeg's EQ and compression, after the isolator or the denoiser: rumble
 * cut, a little less mud, a little more presence, and the loud and quiet
 * words brought closer. `denoise` adds the FFT denoiser for a clip the
 * isolator didn't clean. Every filter exists in ffmpeg 5.1. The rumble cut
 * is two 12 dB/octave stages at 100 Hz: on the paid gate's toy shelf, the
 * room rumble the isolator kept (80-200 Hz) came out 5.7 dB lower than with
 * one stage at 80 Hz, and the words 0.6 dB lower.
 */
export function toneFilter(denoise: boolean): string {
  return [
    "highpass=f=100",
    "highpass=f=100",
    ...(denoise ? ["afftdn=nr=14:nf=-42"] : []),
    "equalizer=f=250:t=q:w=1:g=-2",
    "equalizer=f=3500:t=q:w=1.2:g=2.5",
    "acompressor=threshold=0.1:ratio=3:attack=5:release=90:makeup=1.6",
  ].join(",");
}

async function tone(
  clip: Pcm,
  denoise: boolean,
  workDir: string,
  name: string,
  deps: VoiceDeps,
): Promise<Pcm> {
  const inPath = join(workDir, `${name}-in.wav`);
  const outPath = join(workDir, `${name}-toned.wav`);
  await writeFile(inPath, writeWav(clip));
  await ffmpeg(
    [...input(inPath), "-af", toneFilter(denoise), ...PCM_OUT, outPath],
    deps,
  );
  return readWav(await readFile(outPath));
}

// ---------------------------------------------------------------------------
// Pauses: found on the samples, tightened, with a fade at every cut.

export type Span = { from: number; to: number };

const FRAME_SECONDS = 0.01;
/** A pause is quieter than the loudest moment by this much, for at least this long. */
const PAUSE_BELOW_PEAK_DB = 32;
const QUIETEST_PAUSE_DB = -55;
const MIN_PAUSE_SECONDS = 0.25;
/** Below this the clip holds no speech: the denoiser's or isolator's floor. */
const SPEECH_PEAK_DB = -40;

/** The clip's pauses, and whether it holds speech at all. */
export function findPauses(clip: Pcm): { pauses: Span[]; speech: boolean } {
  const frame = Math.max(1, Math.round(FRAME_SECONDS * clip.sampleRate));
  const levels: number[] = [];
  for (let start = 0; start < clip.samples.length; start += frame) {
    const end = Math.min(clip.samples.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++)
      sum += clip.samples[i]! * clip.samples[i]!;
    const rms = Math.sqrt(sum / Math.max(1, end - start)) / 32768;
    levels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  const peak = Math.max(-120, ...levels);
  if (peak < SPEECH_PEAK_DB) return { pauses: [], speech: false };
  const floor = Math.max(QUIETEST_PAUSE_DB, peak - PAUSE_BELOW_PEAK_DB);
  const pauses: Span[] = [];
  let quietFrom = -1;
  const close = (index: number) => {
    if (
      quietFrom >= 0 &&
      (index - quietFrom) * FRAME_SECONDS >= MIN_PAUSE_SECONDS
    )
      pauses.push({
        from: quietFrom * FRAME_SECONDS,
        to: Math.min(pcmSeconds(clip), index * FRAME_SECONDS),
      });
    quietFrom = -1;
  };
  levels.forEach((level, index) => {
    if (level < floor) {
      if (quietFrom < 0) quietFrom = index;
    } else close(index);
  });
  close(levels.length);
  return { pauses, speech: true };
}

/** Kept before and after each stretch of speech. */
const LEAD_SECONDS = 0.08;
const TAIL_SECONDS = 0.14;
/** Pauses up to this long are kept whole; longer ones shrink to LEAD + TAIL. */
const KEEP_PAUSE_SECONDS = 0.5;
/** A sound this short is a click, not a word. */
const CLICK_SECONDS = 0.12;
/** A sound this short between two long pauses is a hesitation ("ээ") or a breath. */
const HESITATION_SECONDS = 0.22;
const HESITATION_PAUSE_SECONDS = 0.35;

/**
 * The stretches of a clip to keep: its speech, with a little air before and
 * after; pauses up to 0.5 s kept whole and longer ones tightened to about
 * 0.2 s; clicks, and short sounds alone between long pauses (a hesitation or
 * a breath), cut out. Pure, for the tests.
 */
export function planSpeech(seconds: number, pauses: Span[]): Span[] {
  const sorted = [...pauses]
    .map((pause) => ({
      from: Math.max(0, pause.from),
      to: Math.min(seconds, pause.to),
    }))
    .filter((pause) => pause.to > pause.from)
    .sort((a, b) => a.from - b.from);
  const speech: Span[] = [];
  let at = 0;
  for (const pause of sorted) {
    if (pause.from > at) speech.push({ from: at, to: pause.from });
    at = Math.max(at, pause.to);
  }
  if (at < seconds) speech.push({ from: at, to: seconds });

  const kept = speech.filter((span, index) => {
    const length = span.to - span.from;
    if (length < CLICK_SECONDS) return false;
    if (length >= HESITATION_SECONDS) return true;
    const before = index === 0 ? span.from : span.from - speech[index - 1]!.to;
    const after =
      index === speech.length - 1
        ? seconds - span.to
        : speech[index + 1]!.from - span.to;
    const alone =
      (index === 0 || before >= HESITATION_PAUSE_SECONDS) &&
      (index === speech.length - 1 || after >= HESITATION_PAUSE_SECONDS);
    return !alone;
  });

  const merged: Span[] = [];
  for (const span of kept) {
    const padded = {
      from: Math.max(0, span.from - LEAD_SECONDS),
      to: Math.min(seconds, span.to + TAIL_SECONDS),
    };
    const last = merged.at(-1);
    if (
      last &&
      padded.from - last.to <= KEEP_PAUSE_SECONDS - LEAD_SECONDS - TAIL_SECONDS
    )
      last.to = padded.to;
    else merged.push(padded);
  }
  return merged;
}

const CUT_FADE_SECONDS = 0.01;
/** The fades the spec asks for at the words' start and end. */
export const VOICE_FADE_IN_SECONDS = 0.08;
export const VOICE_FADE_OUT_SECONDS = 0.15;

function fade(
  samples: Int16Array,
  from: number,
  length: number,
  rising: boolean,
) {
  for (let i = 0; i < length && from + i < samples.length; i++) {
    const gain = rising ? i / length : 1 - i / length;
    samples[from + i] = Math.round(samples[from + i]! * gain);
  }
}

/** The kept stretches joined, with a short fade at every cut and the words' own fades at the ends. */
export function cutSpeech(clip: Pcm, spans: Span[]): Pcm {
  const rate = clip.sampleRate;
  const pieces = spans.map((span) =>
    clip.samples.slice(
      Math.round(span.from * rate),
      Math.round(span.to * rate),
    ),
  );
  const samples = new Int16Array(
    pieces.reduce((sum, piece) => sum + piece.length, 0),
  );
  let at = 0;
  const cut = Math.round(CUT_FADE_SECONDS * rate);
  pieces.forEach((piece, index) => {
    const copy = Int16Array.from(piece);
    if (index > 0) fade(copy, 0, Math.min(cut, copy.length), true);
    if (index < pieces.length - 1)
      fade(
        copy,
        Math.max(0, copy.length - cut),
        Math.min(cut, copy.length),
        false,
      );
    samples.set(copy, at);
    at += copy.length;
  });
  fade(
    samples,
    0,
    Math.min(samples.length, Math.round(VOICE_FADE_IN_SECONDS * rate)),
    true,
  );
  const out = Math.min(
    samples.length,
    Math.round(VOICE_FADE_OUT_SECONDS * rate),
  );
  fade(samples, samples.length - out, out, false);
  return { samples, sampleRate: rate };
}

export type PolishedVoice = {
  productId: string;
  voice: Pcm;
  /** Whether the Voice Isolator cleaned it (else ffmpeg's denoiser). */
  isolated: boolean;
};

/**
 * The owner's words for each product, polished: extracted, isolated (or
 * denoised), toned, and tightened. A product whose stretch has no sound, or
 * no speech once cleaned, gets no voice.
 */
export async function polishVoices(
  clips: Array<{ productId: string; source: VoiceSource }>,
  isolate: ((wav: Buffer, seconds: number) => Promise<Buffer>) | null,
  workDir: string,
  deps: PolishDeps = {},
): Promise<PolishedVoice[]> {
  const raw: Array<{ productId: string; pcm: Pcm }> = [];
  for (const [index, clip] of clips.entries()) {
    const pcm = await extractVoice(
      clip.source,
      join(workDir, `raw-${index}.wav`),
      deps,
    );
    if (pcm && pcmSeconds(pcm) >= 0.3)
      raw.push({ productId: clip.productId, pcm });
  }
  const isolated = await isolateClips(
    raw.map((clip) => clip.pcm),
    isolate,
    workDir,
    deps,
  );
  const polished: PolishedVoice[] = [];
  for (const [index, clip] of raw.entries()) {
    const cleaned = isolated?.[index] ?? clip.pcm;
    const toned = await tone(
      cleaned,
      isolated === null,
      workDir,
      `voice-${index}`,
      deps,
    );
    const { pauses, speech } = findPauses(toned);
    if (!speech) continue;
    const spans = planSpeech(pcmSeconds(toned), pauses);
    if (spans.length === 0) continue;
    polished.push({
      productId: clip.productId,
      voice: cutSpeech(toned, spans),
      isolated: isolated !== null,
    });
  }
  return polished;
}

/** A polished voice as FLAC, the way it is kept for later renders. */
export async function encodeFlac(
  voice: Pcm,
  workDir: string,
  name: string,
  deps: VoiceDeps = {},
): Promise<Buffer> {
  const inPath = join(workDir, `${name}.wav`);
  const outPath = join(workDir, `${name}.flac`);
  await writeFile(inPath, writeWav(voice));
  await ffmpeg([...input(inPath), "-c:a", "flac", outPath], deps);
  return readFile(outPath);
}

/**
 * The voice said faster by `factor` (1 to 1.25), its pitch kept: ffmpeg's
 * atempo, in every ffmpeg since long before 5.1. New words read by
 * ElevenLabs that run a little over their scene are fitted this way.
 */
export async function changeTempo(
  voice: Pcm,
  factor: number,
  workDir: string,
  name: string,
  deps: VoiceDeps = {},
): Promise<Pcm> {
  if (!Number.isFinite(factor) || factor < 1 || factor > 1.25)
    throw new RangeError("A tempo change is between 1 and 1.25");
  if (factor === 1) return voice;
  const inPath = join(workDir, `${name}-tempo-in.wav`);
  const outPath = join(workDir, `${name}-tempo.wav`);
  await writeFile(inPath, writeWav(voice));
  await ffmpeg(
    [
      ...input(inPath),
      "-af",
      `atempo=${factor.toFixed(4)}`,
      ...PCM_OUT,
      outPath,
    ],
    deps,
  );
  return readWav(await readFile(outPath));
}

/** A kept voice back as samples. */
export async function decodeVoice(
  path: string,
  workDir: string,
  name: string,
  deps: VoiceDeps = {},
): Promise<Pcm> {
  const outPath = join(workDir, `${name}.wav`);
  await ffmpeg([...input(path), ...PCM_OUT, outPath], deps);
  return readWav(await readFile(outPath));
}

// ---------------------------------------------------------------------------
// The voice track.

export type VoicePlacement = {
  voice: Pcm;
  /** When the words start in the video. */
  at: number;
  /** How long they may last; words cut short end on a fade. */
  seconds: number;
};

/** The words placed on the video's timeline, silent elsewhere. Pure. */
export function placeVoices(
  placements: VoicePlacement[],
  totalSeconds: number,
): Pcm {
  const rate = VOICE_SAMPLE_RATE;
  const samples = new Int16Array(Math.round(totalSeconds * rate));
  for (const placement of placements) {
    const start = Math.round(placement.at * rate);
    const allowed = Math.max(
      0,
      Math.min(Math.round(placement.seconds * rate), samples.length - start),
    );
    if (allowed === 0) continue;
    const words = Int16Array.from(placement.voice.samples.subarray(0, allowed));
    if (words.length < placement.voice.samples.length) {
      const out = Math.min(
        words.length,
        Math.round(VOICE_FADE_OUT_SECONDS * rate),
      );
      fade(words, words.length - out, out, false);
    }
    samples.set(words, start);
  }
  return { samples, sampleRate: rate };
}

type Loudness = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/** The loudness ffmpeg's loudnorm measured, from the JSON it prints last. */
export function parseLoudness(stderr: string): Loudness | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const value = JSON.parse(stderr.slice(start, end + 1)) as Partial<Loudness>;
    const keys = [
      "input_i",
      "input_tp",
      "input_lra",
      "input_thresh",
      "target_offset",
    ] as const;
    if (
      !keys.every(
        (key) =>
          typeof value[key] === "string" && Number.isFinite(Number(value[key])),
      )
    )
      return null;
    return value as Loudness;
  } catch {
    return null;
  }
}

/** The target: about -16 LUFS integrated, -1.5 dBTP, loudness range 11. */
export const LOUDNORM_TARGET = "I=-16:TP=-1.5:LRA=11";

/** A 16-bit stereo (2-channel) WAV file from mono PCM. */
export function writeStereoWav(pcm: Pcm): Buffer {
  const data = Buffer.alloc(pcm.samples.length * 4);
  for (let i = 0; i < pcm.samples.length; i++) {
    const sample = pcm.samples[i]!;
    data.writeInt16LE(sample, i * 4);
    data.writeInt16LE(sample, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Mixes an instrumental music bed under the normalized voice track (or alone
 * when there is no voice). The music ducks smoothly during spoken words, swells
 * gently in the intro, price card and ending, and fades in/out at the video's
 * ends, keeping peaks under -1.5 dBTP.
 */
export function mixMusicBed(
  voice: Pcm | null,
  music: Pcm,
  placements: VoicePlacement[],
  totalSeconds: number,
): Pcm {
  const rate = VOICE_SAMPLE_RATE;
  const total = Math.max(1, Math.round(totalSeconds * rate));
  const out = new Int16Array(total);
  let musicPeak = 0;
  for (let i = 0; i < music.samples.length; i++) {
    const abs = Math.abs(music.samples[i]!);
    if (abs > musicPeak) musicPeak = abs;
  }
  if (musicPeak === 0 || music.samples.length === 0) {
    if (voice) out.set(voice.samples.subarray(0, total));
    return { samples: out, sampleRate: rate };
  }
  const speechMask = new Uint8Array(total);
  for (const placement of placements) {
    const from = Math.max(0, Math.round((placement.at - 0.15) * rate));
    const to = Math.min(
      total,
      Math.round((placement.at + placement.seconds + 0.2) * rate),
    );
    for (let i = from; i < to; i++) speechMask[i] = 1;
  }
  const openAmp = (placements.length > 0 ? 0.22 : 0.28) * 32767;
  const duckedAmp = 0.095 * 32767;
  const alpha = 1 / Math.max(1, Math.round(0.25 * rate));
  const fadeInSamples = Math.max(1, Math.round(0.4 * rate));
  const fadeOutSamples = Math.max(1, Math.round(0.8 * rate));
  let env = speechMask[0] ? duckedAmp : openAmp;
  const musicLen = music.samples.length;
  for (let i = 0; i < total; i++) {
    const target = speechMask[i] ? duckedAmp : openAmp;
    env += (target - env) * alpha;
    let endGain = 1;
    if (i < fadeInSamples) endGain = i / fadeInSamples;
    else if (i > total - fadeOutSamples)
      endGain = Math.max(0, (total - i) / fadeOutSamples);
    const musicSample =
      (music.samples[i % musicLen]! / musicPeak) * env * endGain;
    const voiceSample =
      voice && i < voice.samples.length ? voice.samples[i]! : 0;
    const mixed = Math.round(voiceSample + musicSample);
    out[i] = Math.max(-27500, Math.min(27500, mixed));
  }
  return { samples: out, sampleRate: rate };
}

/**
 * The voice and background music track as 48 kHz stereo WAV, normalised in two
 * passes: loudnorm measures the words first, then applies one linear gain
 * where it can, and mixes the ducked music bed underneath when `music` is
 * given. False when there are neither words nor music, for the render to use
 * silence.
 */
export async function buildVoiceTrack(
  placements: VoicePlacement[],
  totalSeconds: number,
  outPath: string,
  workDir: string,
  deps: VoiceDeps = {},
  music: Pcm | null = null,
): Promise<boolean> {
  const hasMusic = Boolean(music && music.samples.length > 0);
  if (placements.length === 0 && !hasMusic) return false;
  if (placements.length === 0 && music) {
    const mixed = mixMusicBed(null, music, [], totalSeconds);
    await writeFile(outPath, writeStereoWav(mixed));
    return true;
  }
  const trackPath = join(workDir, "voice-track.wav");
  await writeFile(trackPath, writeWav(placeVoices(placements, totalSeconds)));
  const measured = await ffmpeg(
    [
      ...input(trackPath),
      "-af",
      `loudnorm=${LOUDNORM_TARGET}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    deps,
    "info",
  );
  const loudness = parseLoudness(measured.stderr);
  const filter =
    loudness && Number(loudness.input_i) > -70
      ? `loudnorm=${LOUDNORM_TARGET}:measured_I=${loudness.input_i}:measured_TP=${loudness.input_tp}` +
        `:measured_LRA=${loudness.input_lra}:measured_thresh=${loudness.input_thresh}` +
        `:offset=${loudness.target_offset}:linear=true`
      : `loudnorm=${LOUDNORM_TARGET}`;
  const normPath = hasMusic ? join(workDir, "voice-norm.wav") : outPath;
  await ffmpeg(
    [
      ...input(trackPath),
      "-af",
      `${filter},aresample=${VOICE_SAMPLE_RATE}`,
      "-ac",
      "2",
      "-ar",
      String(VOICE_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      "-t",
      totalSeconds.toFixed(3),
      normPath,
    ],
    deps,
  );
  if (hasMusic && music) {
    const normVoice = readWav(await readFile(normPath));
    const mixed = mixMusicBed(normVoice, music, placements, totalSeconds);
    await writeFile(outPath, writeStereoWav(mixed));
  }
  return true;
}
