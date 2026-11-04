import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ElevenLabsSttError } from "@icecore/airi-runtime/elevenlabs-stt";
import { VOICE_SAMPLE_RATE, writeWav, type Pcm } from "./audio";
import type { PaidCall } from "./spend";
import {
  CLONE_SOURCE_SECONDS,
  cloneWindow,
  makeVoiceClone,
  type CloneOutcome,
  type VoiceClonePorts,
} from "./voice-clone";

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

/** Speech-like sound for `speech` seconds: bursts of a tone with short gaps. */
function narration(speech: number): Pcm {
  const seconds = speech * 1.25 + 1;
  const samples = new Int16Array(Math.round(seconds * VOICE_SAMPLE_RATE));
  for (let at = 0.5; at < 0.5 + speech * 1.25; at += 1.25)
    for (
      let i = Math.round(at * VOICE_SAMPLE_RATE);
      i < Math.round((at + 1) * VOICE_SAMPLE_RATE);
      i++
    )
      samples[i] = Math.round(
        9000 * Math.sin((2 * Math.PI * 220 * i) / VOICE_SAMPLE_RATE),
      );
  return { samples, sampleRate: VOICE_SAMPLE_RATE };
}

async function workDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "voice-clone-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function ports(overrides: Partial<VoiceClonePorts> = {}) {
  const finished: CloneOutcome[] = [];
  const created: number[] = [];
  const removed: string[] = [];
  const calls = { release: 0, sweep: 0, claim: 0, assertAiEnabled: 0 };
  const value: VoiceClonePorts = {
    assertAiEnabled: async () => {
      calls.assertAiEnabled += 1;
    },
    claim: async () => {
      calls.claim += 1;
      return true;
    },
    release: async () => {
      calls.release += 1;
    },
    sweep: async () => {
      calls.sweep += 1;
    },
    savedVoiceId: async () => null,
    source: async () => ({
      video: { bucket: "b", path: "import.wav" },
      transcript: "[0.4] Сәлеметсіз бе.",
    }),
    isolate: null,
    isolationCostMicros: (seconds) => Math.ceil(seconds * 2000),
    create: async (sample) => {
      created.push(sample.audio.length);
      return "clone123";
    },
    remove: async (voiceId) => {
      removed.push(voiceId);
    },
    finish: async (outcome) => {
      finished.push(outcome);
      return true;
    },
    ...overrides,
  };
  return { value, finished, created, removed, calls };
}

const free: PaidCall = async (_operation, _provider, _max, step) =>
  (await step(() => undefined)).value;

function run(
  t: TestContext,
  dir: string,
  clonePorts: VoiceClonePorts,
  sourceFile: string | null | Error,
  signal?: AbortSignal,
) {
  return makeVoiceClone({
    ports: clonePorts,
    signal,
    storage: {
      download: async (_ref, destination) => {
        if (sourceFile instanceof Error) throw sourceFile;
        if (!sourceFile)
          throw Object.assign(new Error("No such object"), { code: 404 });
        await copyFile(sourceFile, destination);
      },
      save: async () => ({ bucket: "b", path: "p" }),
      loadVoice: async () => false,
      saveVoice: async () => undefined,
    },
    paid: free,
    workDir: dir,
    pulse: () => undefined,
  });
}

test("the narration is cut from its first words for a little over a minute", () => {
  assert.deepEqual(cloneWindow("[12.3] Кукла.\n[15.0] Бес мың."), {
    fromSeconds: 12,
    toSeconds: 12 + CLONE_SOURCE_SECONDS,
  });
  assert.deepEqual(cloneWindow(null), {
    fromSeconds: 0,
    toSeconds: CLONE_SOURCE_SECONDS,
  });
});

test("another run making the voice, or a video that's gone, makes nothing", async (t) => {
  const dir = await workDir(t);
  const busy = ports({ claim: async () => false });
  assert.deepEqual(await run(t, dir, busy.value, null), {
    ok: false,
    reason: "busy",
  });
  assert.equal(busy.finished.length, 0);

  const gone = ports();
  assert.deepEqual(await run(t, dir, gone.value, null), {
    ok: false,
    reason: "no_source",
  });
  assert.equal(gone.finished[0]!.state, "failed");
  assert.equal(gone.created.length, 0);

  const noVideo = ports({ source: async () => null });
  assert.deepEqual(await run(t, dir, noVideo.value, null), {
    ok: false,
    reason: "no_source",
  });
});

test("ffmpeg: half a minute of speech makes the voice; ten seconds is too little", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg isn't installed");
  const dir = await workDir(t);
  const long = join(dir, "long.wav");
  await writeFile(long, writeWav(narration(30)));
  const made = ports();
  assert.deepEqual(await run(t, dir, made.value, long), {
    ok: true,
    voiceId: "clone123",
  });
  assert.equal(made.created.length, 1);
  // Asked before the claim, and again right before the narration is sent.
  assert.equal(made.calls.assertAiEnabled, 2);
  const outcome = made.finished[0]!;
  assert.equal(outcome.state, "ready");
  assert.ok(
    outcome.state === "ready" && outcome.speechSeconds >= 20,
    JSON.stringify(outcome),
  );

  const short = join(dir, "short.wav");
  await writeFile(short, writeWav(narration(10)));
  const little = ports();
  assert.deepEqual(await run(t, dir, little.value, short), {
    ok: false,
    reason: "too_little_speech",
  });
  assert.equal(little.created.length, 0);
  assert.equal(
    little.finished[0]!.state === "failed" && little.finished[0]!.errorCode,
    "too_little_speech",
  );
});

test("ffmpeg: a voice removed while it was made is deleted at ElevenLabs at once", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg isn't installed");
  const dir = await workDir(t);
  const long = join(dir, "long.wav");
  await writeFile(long, writeWav(narration(25)));
  const removed = ports({ finish: async () => false });
  assert.deepEqual(await run(t, dir, removed.value, long), {
    ok: false,
    reason: "removed",
  });
  assert.deepEqual(removed.removed, ["clone123"]);
});

test("ffmpeg: ElevenLabs refusing the clone saves clone_failed", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg isn't installed");
  const dir = await workDir(t);
  const long = join(dir, "long.wav");
  await writeFile(long, writeWav(narration(25)));
  const refused = ports({
    create: async () => {
      throw new ElevenLabsSttError({
        kind: "invalid_request",
        transient: false,
        status: 400,
        message: "voice limit reached",
      });
    },
  });
  assert.deepEqual(await run(t, dir, refused.value, long), {
    ok: false,
    reason: "clone_failed",
  });
  const outcome = refused.finished[0]!;
  assert.ok(
    outcome.state === "failed" &&
      outcome.errorMessage === "voice limit reached",
  );
  assert.equal(refused.calls.release, 0);
});

test("a storage blip or a cancelled run lets the voice go untouched, for a later run", async (t) => {
  const dir = await workDir(t);
  const blip = ports();
  const reset = Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
  });
  assert.deepEqual(await run(t, dir, blip.value, reset), {
    ok: false,
    reason: "busy",
  });
  assert.equal(blip.finished.length, 0);
  assert.equal(blip.calls.release, 1);

  const cancelled = ports();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run(t, dir, cancelled.value, reset, controller.signal),
    /socket hang up/,
  );
  assert.equal(cancelled.finished.length, 0);
  assert.equal(cancelled.calls.release, 1);

  // A video that's gone still ends the voice, with why.
  const gone = ports();
  assert.deepEqual(await run(t, dir, gone.value, null), {
    ok: false,
    reason: "no_source",
  });
  assert.equal(gone.calls.release, 0);
});

test("ffmpeg: a clone whose answer was lost is looked for and deleted, and the voice goes back", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg isn't installed");
  const dir = await workDir(t);
  const long = join(dir, "long.wav");
  await writeFile(long, writeWav(narration(25)));
  const lost = ports({
    create: async () => {
      throw new ElevenLabsSttError({
        kind: "timeout",
        transient: true,
        message: "The operation was aborted",
      });
    },
  });
  assert.deepEqual(await run(t, dir, lost.value, long), {
    ok: false,
    reason: "busy",
  });
  // Once before the create (a stopped run's clone), once after it.
  assert.equal(lost.calls.sweep, 2);
  assert.equal(lost.calls.release, 1);
  assert.equal(lost.finished.length, 0);
});

test("ffmpeg: a clone that couldn't be saved is deleted at ElevenLabs, unless the voice holds it", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg isn't installed");
  const dir = await workDir(t);
  const long = join(dir, "long.wav");
  await writeFile(long, writeWav(narration(25)));
  const blip = new Error("connection pool closed");
  const unsaved = ports({
    finish: async () => {
      throw blip;
    },
  });
  await assert.rejects(run(t, dir, unsaved.value, long), /pool closed/);
  assert.deepEqual(unsaved.removed, ["clone123"]);

  // The save went through before its answer was lost: the clone stays.
  const saved = ports({
    finish: async () => {
      throw blip;
    },
    savedVoiceId: async () => "clone123",
  });
  await assert.rejects(run(t, dir, saved.value, long), /pool closed/);
  assert.deepEqual(saved.removed, []);
});

const aiDisabled = () =>
  Object.assign(new Error("AI is disabled for this company."), {
    code: "workspace_ai_disabled",
  });

test("a company that turned AI off sends nothing: the voice isn't even claimed", async (t) => {
  const dir = await workDir(t);
  const off = ports({
    assertAiEnabled: async () => {
      throw aiDisabled();
    },
  });
  await assert.rejects(run(t, dir, off.value, null), {
    code: "workspace_ai_disabled",
  });
  assert.equal(off.calls.claim, 0);
  assert.equal(off.calls.release, 0);
  assert.equal(off.calls.sweep, 0);
  assert.equal(off.created.length, 0);
  assert.equal(off.finished.length, 0);
});

test("ffmpeg: AI turned off while the narration was cleaned: nothing reaches ElevenLabs, and the voice goes back pending", async (t) => {
  if (!hasFfmpeg()) return t.skip("ffmpeg isn't installed");
  const dir = await workDir(t);
  const long = join(dir, "long.wav");
  await writeFile(long, writeWav(narration(25)));
  let asked = 0;
  const off = ports({
    assertAiEnabled: async () => {
      asked += 1;
      if (asked > 1) throw aiDisabled();
    },
  });
  await assert.rejects(run(t, dir, off.value, long), {
    code: "workspace_ai_disabled",
  });
  assert.equal(asked, 2);
  assert.equal(off.created.length, 0);
  assert.equal(off.calls.sweep, 0);
  // Let go untouched, its consent kept, and no outcome saved on it.
  assert.equal(off.calls.release, 1);
  assert.equal(off.finished.length, 0);
});
