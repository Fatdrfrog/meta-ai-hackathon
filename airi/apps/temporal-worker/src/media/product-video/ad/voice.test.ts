import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ElevenLabsSttError } from "@icecore/airi-runtime/elevenlabs-stt";
import type { ElevenLabsSpeech } from "@icecore/airi-runtime/elevenlabs-tts";
import {
  PRODUCT_AD_STOCK_VOICES,
  type ProductAdFileRef,
  type ProductAdScript,
  type ProductAdVoiceOver,
} from "@icecore/temporal";
import type { AdRecord } from "./ad-job";
import { VOICE_SAMPLE_RATE, type Pcm } from "./audio";
import { AdSpendRefusal, type PaidCall } from "./spend";
import {
  fitVoiceLines,
  MAX_TEMPO,
  newWordsVoices,
  planVoiceLines,
  trimToWords,
  voiceOverKey,
  voiceRooms,
  type NewWordsRun,
  type VoiceAudio,
  type VoiceOverPorts,
} from "./voice";

const NBSP = " ";
const STOCK = PRODUCT_AD_STOCK_VOICES[0]!.id;
const silence = (seconds: number): Pcm => ({
  samples: new Int16Array(Math.round(seconds * VOICE_SAMPLE_RATE)).fill(3000),
  sampleRate: VOICE_SAMPLE_RATE,
});

function adRecord(overrides: Partial<AdRecord> = {}): AdRecord {
  const product = (productId: string, name: string, priceText: string) => ({
    productId,
    importId: null,
    name,
    englishName: null,
    priceText,
    priceQuote: null,
    cutout: null,
    original: null,
    clip: null,
    samPhrase: "",
    description: "",
  });
  return {
    status: "making",
    renderNo: 2,
    language: "Kazakh",
    wordsCode: "kk",
    idea: { kind: "new", text: null },
    voice: "stock",
    stockVoiceId: STOCK,
    voiceOver: null,
    presenter: null,
    ending: { phone: null, shopName: "Qazoner" },
    products: [
      product("p1", "Қуыршақ", `5${NBSP}000${NBSP}₸`),
      product("p2", "Шенжіре", `15${NBSP}500${NBSP}₸ бастап`),
    ],
    script: null,
    scenes: [],
    stills: { status: null, feed: null },
    costMicros: 80_000,
    ...overrides,
  };
}

const SCRIPT: ProductAdScript = {
  sticker: "Жаңа",
  scenes: [
    {
      productId: "p1",
      caption: "c",
      setting: "oak_table_window",
      spoken: "Жұмсақ қуыршақ",
    },
    {
      productId: "p2",
      caption: "c",
      setting: "oak_table_window",
      spoken: "Небары бес мың теңге!",
    },
  ],
  priceCardTitle: "t",
  ending: "e",
  postIntro: "p",
  ctwa: { headline: "h", primaryText: "p", greeting: "g", questions: ["q"] },
  edited: false,
};

type Spoken = {
  voiceId: string;
  text: string;
  modelId: string;
  languageCode: string | null;
};

function fakeAudio(
  lengths: (name: string) => number = () => 2,
): VoiceAudio & { tempos: number[] } {
  const tempos: number[] = [];
  return {
    tempos,
    decode: async (_audio, name) => silence(lengths(name)),
    tempo: async (voice, factor) => {
      tempos.push(factor);
      return silence(voice.samples.length / VOICE_SAMPLE_RATE / factor);
    },
    flac: async () => Buffer.from("fLaC"),
  };
}

function setup(
  t: TestContext,
  options: {
    ad?: Partial<AdRecord>;
    speak?: (input: Spoken) => Promise<ElevenLabsSpeech>;
    audio?: VoiceAudio;
    mode?: "make" | "render";
    paid?: PaidCall;
    ports?: Partial<VoiceOverPorts> | null;
  } = {},
) {
  const spoken: Spoken[] = [];
  const operations: Array<{
    operation: string;
    provider: string;
    max: number;
  }> = [];
  const saved: Array<{ fileName: string; kind: string }> = [];
  const downloads: ProductAdFileRef[] = [];
  const paid: PaidCall =
    options.paid ??
    (async (operation, provider, max, step) => {
      operations.push({ operation, provider, max });
      return (await step(() => undefined)).value;
    });
  const ports: VoiceOverPorts | null =
    options.ports === null
      ? null
      : {
          speak:
            options.speak ??
            (async (input) => {
              spoken.push(input);
              return {
                audio: Buffer.from("ID3"),
                mimeType: "audio/mpeg",
                alignment: null,
                modelId: input.modelId,
                characters: input.text.length,
              };
            }),
          speechCostMicros: (characters) => characters * 80,
          workspaceVoice: async () => ({ state: "ready", voiceId: "clone123" }),
          clone: null,
          audio: options.audio ?? fakeAudio(),
          ...options.ports,
        };
  let dir = "";
  const run = async (): Promise<ReturnType<typeof newWordsVoices>> => {
    dir ||= await mkdtemp(join(tmpdir(), "voice-over-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const request: NewWordsRun = {
      ad: adRecord(options.ad),
      script: SCRIPT,
      ports,
      storage: {
        download: async (ref, destination) => {
          downloads.push(ref);
          await writeFile(destination, "fLaC");
        },
        save: async (file) => {
          saved.push({ fileName: file.fileName, kind: file.kind });
          return { bucket: "b", path: `saved/${file.fileName}` };
        },
        loadVoice: async () => false,
        saveVoice: async () => undefined,
      },
      paid,
      mode: options.mode ?? "make",
      workDir: dir,
      pulse: () => undefined,
    };
    return newWordsVoices(request);
  };
  return { run, spoken, operations, saved, downloads };
}

test("each scene says Muse Spark's line and code's price; a line with a number is the product's name", () => {
  const planned = planVoiceLines(adRecord(), SCRIPT, "kk");
  assert.deepEqual(planned, [
    {
      productId: "p1",
      line: "Жұмсақ қуыршақ",
      price: "Бағасы — бес мың теңге.",
    },
    {
      productId: "p2",
      line: "Шенжіре.",
      price: "Бағасы — он бес мың бес жүз теңгеден бастап.",
    },
  ]);
  // Another language gets no spoken price.
  const uzbek = planVoiceLines(
    adRecord({ language: "Uzbek", wordsCode: "en" }),
    SCRIPT,
    null,
  );
  assert.ok(uzbek !== "price_unchecked");
  assert.deepEqual(
    uzbek.map((line) => line.price),
    [null, null],
  );
  // …and says only the product's name: code has no number words to check
  // the model's line for a price in it.
  const uzbekScript: ProductAdScript = {
    ...SCRIPT,
    scenes: [
      {
        ...SCRIPT.scenes[0]!,
        spoken: "Yumshoq qo'g'irchoq, atigi besh ming so'm!",
      },
      { ...SCRIPT.scenes[1]!, spoken: "Chiroyli shajara taxtasi" },
    ],
  };
  assert.deepEqual(
    planVoiceLines(
      adRecord({ language: "Uzbek", wordsCode: "en" }),
      uzbekScript,
      null,
    ),
    [
      { productId: "p1", line: "Қуыршақ.", price: null },
      { productId: "p2", line: "Шенжіре.", price: null },
    ],
  );
});

test("a line ElevenLabs answered but whose audio was lost is still booked", async (t) => {
  const settled: Array<{ operation: string; usd: number | null }> = [];
  // The ledger's own way: the step's cost, or what onCost said before it threw.
  const paid: PaidCall = async (operation, _provider, _max, step) => {
    let reported: number | null = null;
    try {
      const done = await step((usd) => {
        reported = usd;
      });
      settled.push({ operation, usd: (done.costMicros ?? 0) / 1_000_000 });
      return done.value;
    } catch (error) {
      settled.push({ operation, usd: reported });
      throw error;
    }
  };
  const lost = setup(t, {
    paid,
    speak: async () => {
      throw new ElevenLabsSttError({
        kind: "unknown",
        transient: true,
        status: 200,
        message: "ElevenLabs returned no audio",
      });
    },
  });
  const result = await lost.run();
  assert.deepEqual(result, { ok: false, fallback: "unavailable" });
  assert.equal(settled.length, 2);
  for (const entry of settled) assert.ok((entry.usd ?? 0) > 0, entry.operation);

  // A refusal (4xx) cost nothing.
  settled.length = 0;
  const refused = setup(t, {
    paid,
    speak: async () => {
      throw new ElevenLabsSttError({
        kind: "invalid_request",
        transient: false,
        status: 400,
        message: "Bad request",
      });
    },
  });
  await refused.run();
  assert.ok(settled.every((entry) => entry.usd === null));
});

test("lines that fit keep the words and the price; a long one says the price alone", () => {
  const fitted = fitVoiceLines(
    [
      {
        productId: "p1",
        line: "Жұмсақ қуыршақ",
        price: "Бағасы — бес мың теңге.",
      },
      {
        productId: "p2",
        line: "Қолдан жасалған, ағаштан ойылған, әр үйге жарасатын, атадан балаға қалатын керемет шежіре тақтасы",
        price: "Бағасы — он бес мың бес жүз теңгеден бастап.",
      },
    ],
    "kk",
  );
  assert.equal(fitted[0]!.text, "Жұмсақ қуыршақ. Бағасы — бес мың теңге.");
  assert.equal(fitted[1]!.text, "Бағасы — он бес мың бес жүз теңгеден бастап.");
  // Words without a price are said as they are.
  assert.deepEqual(
    fitVoiceLines([{ productId: "p", line: "Soft doll.", price: null }], "en"),
    [{ productId: "p", text: "Soft doll." }],
  );
});

test("the room each scene gives its words follows the timeline", () => {
  const [one] = voiceRooms([3]);
  assert.ok(one! >= 3, String(one));
  const three = voiceRooms([10, 10, 10]);
  assert.ok(
    three.every((room) => room > 4 && room < 5),
    three.join(),
  );
  assert.deepEqual(
    voiceRooms([0, 2]).map((room) => room > 0),
    [false, true],
  );
});

test("Airi voices read each scene, booked one line at a time in the ad's action, and keep the lines", async (t) => {
  const { run, spoken, operations, saved } = setup(t);
  const result = await run();
  assert.ok(result.ok);
  assert.deepEqual(
    spoken.map((entry) => [entry.voiceId, entry.modelId, entry.languageCode]),
    [
      [STOCK, "eleven_v4", "kk"],
      [STOCK, "eleven_v4", "kk"],
    ],
  );
  assert.equal(spoken[0]!.text, "Жұмсақ қуыршақ. Бағасы — бес мың теңге.");
  assert.deepEqual(
    operations.map((entry) => [entry.operation, entry.provider, entry.max]),
    spoken.map((entry, index) => [
      `tts:p${index + 1}`,
      "elevenlabs",
      entry.text.length * 80,
    ]),
  );
  assert.deepEqual([...result.voices.keys()], ["p1", "p2"]);
  assert.equal(result.voiceOver.mode, "stock");
  assert.equal(result.voiceOver.voiceId, STOCK);
  assert.equal(result.voiceOver.modelId, "eleven_v4");
  assert.equal(
    result.voiceOver.costMicros,
    spoken.reduce((sum, entry) => sum + entry.text.length * 80, 0),
  );
  assert.deepEqual(
    result.voiceOver.lines.map((line) => [
      line.productId,
      line.text,
      line.audio.path,
    ]),
    [
      ["p1", spoken[0]!.text, "saved/voice-over-p1.flac"],
      ["p2", spoken[1]!.text, "saved/voice-over-p2.flac"],
    ],
  );
  assert.deepEqual(
    saved.map((file) => file.kind),
    ["audio", "audio"],
  );
  assert.match(result.voiceOver.key, /^[0-9a-f]{64}$/);
});

test("the owner's clone reads the ad when it's ready; without one the ad falls back", async (t) => {
  const ready = setup(t, { ad: { voice: "clone", stockVoiceId: null } });
  const result = await ready.run();
  assert.ok(result.ok);
  assert.equal(ready.spoken[0]!.voiceId, "clone123");
  assert.equal(result.voiceOver.mode, "clone");

  const none = setup(t, {
    ad: { voice: "clone", stockVoiceId: null },
    ports: { workspaceVoice: async () => null },
  });
  assert.deepEqual(await none.run(), { ok: false, fallback: "no_voice" });
  assert.equal(none.operations.length, 0);

  // A pending voice is made only in a run that may pay.
  const pending = setup(t, {
    ad: { voice: "clone", stockVoiceId: null },
    mode: "render",
    ports: { workspaceVoice: async () => ({ state: "pending" }) },
  });
  assert.deepEqual(await pending.run(), { ok: false, fallback: "unavailable" });
});

test("an unknown Airi voice, or ElevenLabs not set up, falls back without paying", async (t) => {
  const unknown = setup(t, { ad: { stockVoiceId: "someone" } });
  assert.deepEqual(await unknown.run(), { ok: false, fallback: "no_voice" });
  const off = setup(t, { ports: null });
  assert.deepEqual(await off.run(), { ok: false, fallback: "unavailable" });
  assert.equal(unknown.operations.length + off.operations.length, 0);
});

test("a render reuses the kept lines when the voice and words are the same, and never pays", async (t) => {
  const first = setup(t);
  const made = await first.run();
  assert.ok(made.ok);
  const again = setup(t, { ad: { voiceOver: made.voiceOver }, mode: "render" });
  const reused = await again.run();
  assert.ok(reused.ok);
  assert.equal(reused.voiceOver, made.voiceOver);
  assert.equal(again.operations.length, 0);
  assert.deepEqual(
    again.downloads.map((ref) => ref.path),
    ["saved/voice-over-p1.flac", "saved/voice-over-p2.flac"],
  );
  // Another voice in a render: nothing kept fits, and a render doesn't pay.
  const other = setup(t, {
    ad: {
      voiceOver: made.voiceOver,
      stockVoiceId: PRODUCT_AD_STOCK_VOICES[1]!.id,
    },
    mode: "render",
  });
  assert.deepEqual(await other.run(), { ok: false, fallback: "unavailable" });
  assert.equal(other.operations.length, 0);
});

test("the key changes with the voice and the words", () => {
  const lines = [{ productId: "p1", text: "a" }];
  const key = (voiceId: string, text: string) =>
    voiceOverKey({
      mode: "stock",
      voiceId,
      modelId: "eleven_v4",
      languageCode: "kk",
      lines: [{ ...lines[0]!, text }],
    });
  assert.equal(key("v", "a"), key("v", "a"));
  assert.notEqual(key("v", "a"), key("w", "a"));
  assert.notEqual(key("v", "a"), key("v", "b"));
});

test("the ledger refusing the reading falls back as spend_refused", async (t) => {
  const { run } = setup(t, {
    paid: async () => {
      throw new AdSpendRefusal("workspace_ai_spend_limit");
    },
  });
  assert.deepEqual(await run(), { ok: false, fallback: "spend_refused" });
});

test("a clone ElevenLabs no longer has falls back as no_voice; an outage as unavailable", async (t) => {
  const gone = setup(t, {
    speak: async () => {
      throw new ElevenLabsSttError({
        kind: "invalid_request",
        transient: false,
        status: 400,
        message: "A voice with the voice_id clone123 was not found.",
      });
    },
  });
  assert.deepEqual(await gone.run(), { ok: false, fallback: "no_voice" });
  const down = setup(t, {
    speak: async () => {
      throw new ElevenLabsSttError({
        kind: "server",
        transient: true,
        status: 503,
        message: "down",
      });
    },
  });
  assert.deepEqual(await down.run(), { ok: false, fallback: "unavailable" });
});

test("a model ElevenLabs refuses is read again with the fallback model, booked apart", async (t) => {
  const models: string[] = [];
  const { run, operations } = setup(t, {
    speak: async (input) => {
      models.push(input.modelId);
      if (input.modelId === "eleven_v4")
        throw new ElevenLabsSttError({
          kind: "invalid_request",
          transient: false,
          status: 422,
          message: "model unsupported",
        });
      return {
        audio: Buffer.from("ID3"),
        mimeType: "audio/mpeg",
        alignment: null,
        modelId: input.modelId,
        characters: 1,
      };
    },
  });
  const result = await run();
  assert.ok(result.ok);
  assert.equal(result.voiceOver.modelId, "eleven_v3");
  assert.deepEqual(operations.map((entry) => entry.operation).sort(), [
    "tts:p1",
    "tts:p1:m2",
    "tts:p2",
    "tts:p2:m2",
  ]);
  assert.deepEqual([...new Set(models)], ["eleven_v4", "eleven_v3"]);
});

test("a line a little long for its scene is said faster; one far too long is left out", async (t) => {
  const audio = fakeAudio((name) => (name === "line-0" ? 5.6 : 2));
  const slightly = setup(t, { audio });
  const result = await slightly.run();
  assert.ok(result.ok);
  assert.equal(audio.tempos.length, 1);
  assert.ok(
    audio.tempos[0]! > 1 && audio.tempos[0]! <= MAX_TEMPO,
    String(audio.tempos[0]),
  );

  const far = setup(t, { audio: fakeAudio(() => 9) });
  assert.deepEqual(await far.run(), { ok: false, fallback: "too_long" });
});

test("the read audio is cut to its words by the timestamps", () => {
  const voice = silence(3);
  const cut = trimToWords(voice, { start: 0.5, end: 2 });
  const seconds = cut.samples.length / VOICE_SAMPLE_RATE;
  assert.ok(Math.abs(seconds - (2 + 0.15 - 0.45)) < 0.01, String(seconds));
  assert.equal(trimToWords(voice, null).samples.length > 0, true);
});

test("a fault that isn't ElevenLabs' or the ledger's is thrown on", async (t) => {
  const { run } = setup(t, {
    speak: async () => {
      throw new TypeError("bug");
    },
  });
  await assert.rejects(run(), TypeError);
});

test("a kept voice-over whose lines are gone is read again in a make run", async (t) => {
  const kept: ProductAdVoiceOver = {
    mode: "stock",
    voiceId: STOCK,
    modelId: "eleven_v4",
    lines: [],
    key: "x",
    costMicros: 0,
    madeAt: new Date(),
  };
  const { run, operations } = setup(t, { ad: { voiceOver: kept } });
  assert.ok((await run()).ok);
  assert.equal(operations.length, 2);
});
