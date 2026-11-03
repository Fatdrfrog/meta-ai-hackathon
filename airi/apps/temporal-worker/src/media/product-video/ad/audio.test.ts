import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  buildVoiceTrack,
  cutSpeech,
  decodeVoice,
  encodeFlac,
  extractVoice,
  findPauses,
  isolateClips,
  ISOLATOR_MIN_SECONDS,
  joinClips,
  parseLoudness,
  pcmSeconds,
  placeVoices,
  planSpeech,
  polishVoices,
  readWav,
  splitClips,
  toneFilter,
  VOICE_SAMPLE_RATE,
  writeWav,
  type Pcm,
} from "./audio";

const RATE = VOICE_SAMPLE_RATE;

/** Speech-like sound: a tone in the bursts given, silence between. */
function sound(
  seconds: number,
  bursts: Array<[number, number]>,
  amplitude = 9000,
): Pcm {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (const [from, to] of bursts)
    for (
      let i = Math.round(from * RATE);
      i < Math.round(to * RATE) && i < samples.length;
      i++
    )
      samples[i] = Math.round(
        amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE),
      );
  return { samples, sampleRate: RATE };
}

const close = (actual: number, expected: number, tolerance = 0.011) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not about ${expected}`,
  );

let ffmpegChecked: boolean | null = null;
function hasFfmpeg(): boolean {
  if (ffmpegChecked === null) {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      ffmpegChecked = true;
    } catch {
      ffmpegChecked = false;
    }
  }
  return ffmpegChecked;
}

async function workDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "product-ad-voice-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("pauses: long ones tightened, short ones kept, the ends trimmed with air", () => {
  // 0.5 s of silence, words, a 1.2 s pause, words, a 0.3 s pause, words, silence.
  const spans = planSpeech(6, [
    { from: 0, to: 0.5 },
    { from: 1.5, to: 2.7 },
    { from: 3.7, to: 4.0 },
    { from: 5.0, to: 6 },
  ]);
  assert.equal(spans.length, 2);
  close(spans[0]!.from, 0.42);
  close(spans[0]!.to, 1.64);
  close(spans[1]!.from, 2.62);
  close(spans[1]!.to, 5.14);
  // The 1.2 s pause is now 0.22 s.
  const kept = spans.reduce((sum, span) => sum + span.to - span.from, 0);
  close(kept, 1.22 + 2.52);
});

test("pauses: clicks and lone hesitations are cut; a clip without pauses is kept whole", () => {
  const spans = planSpeech(5, [
    { from: 0, to: 0.6 },
    // A 0.1 s click at 0.6-0.7, then silence.
    { from: 0.7, to: 1.2 },
    // Words 1.2-2.0, then a hesitation 2.5-2.65 between two long pauses.
    { from: 2.0, to: 2.5 },
    { from: 2.65, to: 3.2 },
  ]);
  assert.deepEqual(
    spans.map((span) => [
      Number(span.from.toFixed(2)),
      Number(span.to.toFixed(2)),
    ]),
    [
      [1.12, 2.14],
      [3.12, 5],
    ],
  );
  assert.deepEqual(planSpeech(3, []), [{ from: 0, to: 3 }]);
  assert.deepEqual(planSpeech(2, [{ from: 0, to: 2 }]), []);
});

test("the cut words fade in, fade out and fade at every cut", () => {
  const clip = sound(3, [[0, 3]]);
  const cut = cutSpeech(clip, [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ]);
  close(pcmSeconds(cut), 2, 1 / RATE);
  assert.equal(cut.samples[0], 0);
  assert.equal(cut.samples.at(-1), 0);
  // At the cut (1 s in) the sound is faded to near silence on both sides.
  const atCut = Math.round(RATE);
  assert.ok(Math.abs(cut.samples[atCut - 1]!) < 200);
  assert.ok(Math.abs(cut.samples[atCut]!) < 200);
  // Mid-way it is untouched.
  assert.equal(
    cut.samples[Math.round(0.5 * RATE)],
    clip.samples[Math.round(0.5 * RATE)],
  );
});

test("pauses are found on the samples, relative to the loudest word", () => {
  const { pauses, speech } = findPauses(
    sound(4, [
      [0.3, 1.0],
      [2.0, 3.4],
    ]),
  );
  assert.equal(speech, true);
  assert.equal(pauses.length, 3);
  close(pauses[0]!.from, 0);
  close(pauses[0]!.to, 0.3);
  close(pauses[1]!.from, 1.0);
  close(pauses[1]!.to, 2.0);
  close(pauses[2]!.from, 3.4);
  // A clip of near silence holds no speech.
  assert.equal(findPauses(sound(2, [[0, 2]], 50)).speech, false);
});

test("WAV in and out; stereo read as mono", () => {
  const pcm = sound(0.5, [[0, 0.5]]);
  const back = readWav(writeWav(pcm));
  assert.equal(back.sampleRate, RATE);
  assert.deepEqual(back.samples, pcm.samples);
  // A stereo file with a LIST chunk before its data.
  const data = Buffer.alloc(8);
  data.writeInt16LE(100, 0);
  data.writeInt16LE(300, 2);
  data.writeInt16LE(-100, 4);
  data.writeInt16LE(-300, 6);
  const list = Buffer.concat([
    Buffer.from("LIST"),
    Buffer.from([4, 0, 0, 0]),
    Buffer.from("INFO"),
  ]);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(RATE, 12);
  fmt.writeUInt32LE(RATE * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(16, 22);
  const dataHeader = Buffer.concat([
    Buffer.from("data"),
    Buffer.from([8, 0, 0, 0]),
  ]);
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    fmt,
    list,
    dataHeader,
    data,
  ]);
  const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
  riff.writeUInt32LE(body.length, 4);
  assert.deepEqual([...readWav(riff).samples], [200, -200]);
});

test("the clips go to the isolator as one recording and come back apart", () => {
  const a = sound(3, [[0, 3]]);
  const b = sound(1.5, [[0, 1.5]], 4000);
  const { joined, spans } = joinClips([a, b]);
  close(pcmSeconds(joined), 0.6 + 3 + 0.6 + 1.5 + 0.6, 1 / RATE);
  const [backA, backB] = splitClips(joined, spans);
  assert.deepEqual(backA!.samples, a.samples);
  assert.deepEqual(backB!.samples, b.samples);
});

test("a short recording reaches the isolator's minimum with silence at its end", () => {
  // The Voice Isolator refuses recordings under 4.6 s (HTTP 400).
  const a = sound(1, [[0, 1]]);
  const b = sound(0.5, [[0, 0.5]], 4000);
  const { joined, spans } = joinClips([a, b]);
  close(pcmSeconds(joined), ISOLATOR_MIN_SECONDS, 1 / RATE);
  assert.ok(ISOLATOR_MIN_SECONDS >= 4.6);
  // The clips stay where they were; only the silence after them grew.
  const at = (seconds: number) => Math.round(seconds * RATE);
  assert.deepEqual(spans, [
    { start: at(0.6), length: at(1) },
    { start: at(2.2), length: at(0.5) },
  ]);
  assert.ok(joined.samples.subarray(at(2.7)).every((sample) => sample === 0));
  const [backA, backB] = splitClips(joined, spans);
  assert.deepEqual(backA!.samples, a.samples);
  assert.deepEqual(backB!.samples, b.samples);
});

test("a failed isolator call is told, with why, and the denoiser steps in", async () => {
  // The paid gate's refusal, before recordings were made long enough.
  const told: Array<[string, string]> = [];
  const isolated = await isolateClips(
    [sound(2.6, [[0, 2.6]])],
    async () => {
      throw new Error(
        "Audio duration is 3.8 seconds, which is below the minimum of 4.6 seconds.",
      );
    },
    "unused",
    { onIsolatorSkipped: (reason, detail) => told.push([reason, detail]) },
  );
  assert.equal(isolated, null);
  assert.deepEqual(told, [
    [
      "call_failed",
      "Audio duration is 3.8 seconds, which is below the minimum of 4.6 seconds.",
    ],
  ]);
  // No isolator is a setting, not a failure: nothing is told.
  assert.equal(
    await isolateClips([sound(1, [[0, 1]])], null, "unused", {
      onIsolatorSkipped: () => assert.fail("nothing failed"),
    }),
    null,
  );
});

test("the words are placed on the timeline; words cut short end on a fade", () => {
  const words = sound(2, [[0, 2]]);
  const track = placeVoices(
    [
      { voice: words, at: 0.35, seconds: 2 },
      { voice: words, at: 3, seconds: 1 },
    ],
    5,
  );
  close(pcmSeconds(track), 5, 1 / RATE);
  assert.equal(track.samples[Math.round(0.2 * RATE)], 0);
  assert.equal(
    track.samples[Math.round(0.35 * RATE) + 4800],
    words.samples[4800],
  );
  // Cut at 4 s with a fade: silent after, near silent just before.
  assert.equal(track.samples[Math.round(4.1 * RATE)], 0);
  assert.ok(Math.abs(track.samples[Math.round(4 * RATE) - 2]!) < 200);
});

test("loudnorm's measurement is read from its JSON", () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x55] \n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-9.02",\n\t"input_lra" : "3.10",\n\t"input_thresh" : "-38.09",\n\t"output_i" : "-16.20",\n\t"target_offset" : "0.20"\n}\n`;
  assert.deepEqual(parseLoudness(stderr), {
    input_i: "-27.61",
    input_tp: "-9.02",
    input_lra: "3.10",
    input_thresh: "-38.09",
    output_i: "-16.20",
    target_offset: "0.20",
  });
  assert.equal(parseLoudness("no json here"), null);
  assert.equal(parseLoudness('{"input_i": "-inf"}'), null);
});

test("the tone filter: EQ and compression, the denoiser only without the isolator", () => {
  // Two 12 dB/octave stages at 100 Hz cut the room rumble the isolator keeps.
  assert.equal(
    toneFilter(false),
    "highpass=f=100,highpass=f=100,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1.2:g=2.5,acompressor=threshold=0.1:ratio=3:attack=5:release=90:makeup=1.6",
  );
  assert.match(
    toneFilter(true),
    /^highpass=f=100,highpass=f=100,afftdn=nr=14:nf=-42,equalizer/,
  );
});

test("ffmpeg: the words cut from the video's sound are polished and tightened", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not installed");
  const dir = await workDir(t);
  // A short video: words, a long pause, words, with a quiet hiss throughout.
  const wav = join(dir, "voice.wav");
  const pcm = sound(5, [
    [0.4, 1.4],
    [3.0, 4.2],
  ]);
  for (let i = 0; i < pcm.samples.length; i++)
    pcm.samples[i] = Math.max(
      -32768,
      Math.min(32767, pcm.samples[i]! + ((i * 7919) % 61) - 30),
    );
  await writeFile(wav, writeWav(pcm));
  const video = join(dir, "video.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=160x120:d=5:r=10",
    "-i",
    wav,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    video,
  ]);

  const extracted = await extractVoice(
    { kind: "video", path: video, fromSeconds: 0.2, toSeconds: 4.6 },
    join(dir, "extracted.wav"),
  );
  assert.ok(extracted);
  close(pcmSeconds(extracted), 4.4, 0.05);

  let sent = 0;
  const polished = await polishVoices(
    [
      {
        productId: "doll",
        source: {
          kind: "video",
          path: video,
          fromSeconds: 0.2,
          toSeconds: 4.6,
        },
      },
    ],
    async () => {
      sent++;
      throw new Error("isolator unreachable");
    },
    dir,
  );
  assert.equal(sent, 1);
  assert.equal(polished.length, 1);
  assert.equal(polished[0]!.isolated, false);
  // The 1.6 s pause shrank to about 0.2 s.
  const seconds = pcmSeconds(polished[0]!.voice);
  assert.ok(seconds > 2.2 && seconds < 2.9, `${seconds} s`);

  // Kept as FLAC and read back the same length.
  const flac = await encodeFlac(polished[0]!.voice, dir, "kept");
  await writeFile(join(dir, "kept-copy.flac"), flac);
  const back = await decodeVoice(join(dir, "kept-copy.flac"), dir, "back");
  close(pcmSeconds(back), seconds, 0.002);

  // A video without sound has no voice.
  const silent = join(dir, "silent.mp4");
  execFileSync("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=160x120:d=2:r=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    silent,
  ]);
  assert.equal(
    await extractVoice({ kind: "clip", path: silent }, join(dir, "none.wav")),
    null,
  );
});

test("ffmpeg: the isolator's answer is decoded and cut back into the clips", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not installed");
  const dir = await workDir(t);
  const clips = [sound(1, [[0, 1]]), sound(0.8, [[0.1, 0.7]], 5000)];
  // The isolator hands back what it was sent, as WAV.
  const echoed = await isolateClips(clips, async (wav) => wav, dir);
  assert.ok(echoed);
  assert.deepEqual(echoed[0]!.samples, clips[0]!.samples);
  assert.deepEqual(echoed[1]!.samples, clips[1]!.samples);
  // An answer of another length can't be cut back: the denoiser steps in,
  // and why is told.
  const told: string[] = [];
  const onIsolatorSkipped = (reason: string) => told.push(reason);
  const shorter = await isolateClips(
    clips,
    async () => writeWav(sound(1, [[0, 1]])),
    dir,
    { onIsolatorSkipped },
  );
  assert.equal(shorter, null);
  // Nor can an answer that isn't audio.
  const garbled = await isolateClips(
    clips,
    async () => Buffer.from("not audio at all"),
    dir,
    { onIsolatorSkipped },
  );
  assert.equal(garbled, null);
  assert.deepEqual(told, ["length_mismatch", "undecodable"]);
  assert.equal(await isolateClips(clips, null, dir), null);
});

test("ffmpeg: the voice track is normalised in two passes to stereo 48 kHz", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg is not installed");
  const dir = await workDir(t);
  const out = join(dir, "voice.wav");
  const made = await buildVoiceTrack(
    [{ voice: sound(2, [[0, 2]], 3000), at: 0.35, seconds: 2 }],
    6,
    out,
    dir,
  );
  assert.equal(made, true);
  const file = await readFile(out);
  assert.equal(file.readUInt16LE(22), 2, "stereo");
  assert.equal(file.readUInt32LE(24), 48000);
  const track = readWav(file);
  close(pcmSeconds(track), 6, 0.03);
  // Louder than the quiet tone it was made from, and silent where no words are.
  let peak = 0;
  for (const sample of track.samples) peak = Math.max(peak, Math.abs(sample));
  assert.ok(peak > 3000, `peak ${peak}`);
  assert.ok(peak < 32767 * 0.9, "true peak kept under -1.5 dBTP, about");
  assert.equal(await buildVoiceTrack([], 6, out, dir), false);
});
