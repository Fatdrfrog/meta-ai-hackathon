/** @jest-environment node */

// The workspace's cloned voice and airi's voices on the web: the consent
// saves a pending voice from the video with the most speech, "Remove my
// voice" deletes at ElevenLabs first, samples are made once and kept, and an
// ad is read again in another voice as a "voice" run.

type Doc = Record<string, unknown>;

const mockVoiceFindOne = jest.fn();
const mockVoiceFind = jest.fn();
const mockVoiceCreate = jest.fn();
const mockVoiceUpdateOne = jest.fn();
const mockVoiceExists = jest.fn();
const mockImportFindOne = jest.fn();
const mockImportFind = jest.fn();
const mockProductFind = jest.fn();
const mockAdFindOne = jest.fn();
const mockAdFindOneAndUpdate = jest.fn();
const mockAdUpdateOne = jest.fn();
const mockSampleFindOne = jest.fn();
const mockSampleUpdateOne = jest.fn();
const mockDelete = jest.fn();
const mockSpeak = jest.fn();
const mockConfigured = jest.fn();
const mockAdmission = jest.fn();
const mockStart = jest.fn();
const mockLoadAd = jest.fn();
const mockLoggerError = jest.fn();
const mockAssertAiEnabled = jest.fn();

type MockQuery = {
  select: jest.Mock;
  sort: jest.Mock;
  lean: jest.Mock;
  then: (resolve: (value: unknown) => unknown) => unknown;
};

function mockQuery(result: unknown): MockQuery {
  const query: MockQuery = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    lean: jest.fn(async () => result),
    then: (resolve: (value: unknown) => unknown) => resolve(result),
  };
  return query;
}

jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));
jest.mock("@icecore/airi-runtime/elevenlabs-voices", () => ({
  deleteElevenLabsVoice: (...args: unknown[]) => mockDelete(...args),
  isElevenLabsVoicesConfigured: () => mockConfigured(),
}));
jest.mock("@icecore/airi-runtime/elevenlabs-tts", () => ({
  elevenLabsAdSpeechModels: () => ({
    modelId: "eleven_v4",
    fallbackModelId: "eleven_v3",
  }),
  speakElevenLabsWithTimestamps: (...args: unknown[]) => mockSpeak(...args),
}));
jest.mock("@/lib/products/ads", () => ({
  adAdmissionStop: (...args: unknown[]) => mockAdmission(...args),
  loadProductAdRecord: (...args: unknown[]) => mockLoadAd(...args),
  startAdRun: (...args: unknown[]) => mockStart(...args),
}));
jest.mock("@/lib/products/import-spend", () => ({
  productImportSpend: {
    assertAiEnabled: (...args: unknown[]) => mockAssertAiEnabled(...args),
  },
}));
jest.mock("@/models/product-voice", () => ({
  ProductVoice: {
    findOne: (...args: unknown[]) => mockVoiceFindOne(...args),
    find: (...args: unknown[]) => mockVoiceFind(...args),
    create: (...args: unknown[]) => mockVoiceCreate(...args),
    updateOne: (...args: unknown[]) => mockVoiceUpdateOne(...args),
    exists: (...args: unknown[]) => mockVoiceExists(...args),
  },
}));
jest.mock("@/models/product-video-import", () => ({
  ProductVideoImport: {
    findOne: (...args: unknown[]) => mockImportFindOne(...args),
    find: (...args: unknown[]) => mockImportFind(...args),
  },
}));
jest.mock("@/models/workspace-product", () => ({
  WorkspaceProduct: { find: (...args: unknown[]) => mockProductFind(...args) },
}));
jest.mock("@/models/product-ad", () => ({
  ProductAd: {
    findOne: (...args: unknown[]) => mockAdFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockAdFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockAdUpdateOne(...args),
  },
}));
jest.mock("@/models/product-voice-sample", () => ({
  ProductVoiceSample: {
    findOne: (...args: unknown[]) => mockSampleFindOne(...args),
    updateOne: (...args: unknown[]) => mockSampleUpdateOne(...args),
  },
}));

import { PRODUCT_AD_STOCK_VOICES } from "@/lib/products/types";
import {
  changeProductAdVoice,
  createProductVoice,
  loadProductVoice,
  narrationSpeechSeconds,
  productVoiceSampleAudio,
  productVoiceSamples,
  productVoiceSource,
  removeProductVoice,
} from "./voices";

const WS = "workspace-1";
const AD = "751f1f77bcf86cd799439031";
const IMPORT = "551f1f77bcf86cd799439021";
const OTHER = "551f1f77bcf86cd799439022";
const now = new Date("2026-11-03T12:00:00Z");
const videoDay = new Date("2026-11-01T08:00:00Z");

/** A narration of `lines` sentences of about 3 s each. */
const narration = (lines: number) =>
  Array.from(
    { length: lines },
    (_, index) =>
      `[${index * 3}.0] Мына қуыршақ өте жұмсақ, балаларға арналған сыйлық.`
  ).join("\n");

const voiceDoc = (overrides: Doc = {}): Doc => ({
  _id: "v1",
  workspaceId: WS,
  state: "pending",
  sourceImportId: IMPORT,
  speechSeconds: 42,
  errorCode: null,
  consentAt: now,
  createdAt: now,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertAiEnabled.mockReset().mockResolvedValue(undefined);
  mockConfigured.mockReturnValue(true);
  mockImportFindOne.mockImplementation(() =>
    mockQuery({ createdAt: videoDay })
  );
  mockVoiceFindOne.mockImplementation(() => mockQuery(null));
  mockVoiceFind.mockImplementation(() => mockQuery([]));
  mockProductFind.mockImplementation(() => mockQuery([]));
  mockImportFind.mockImplementation(() => mockQuery([]));
  mockVoiceCreate.mockImplementation(async (doc: Doc) => ({
    toObject: () => ({ ...doc, _id: "v-new", createdAt: now }),
  }));
});

describe("how much speech a narration holds", () => {
  it("counts each line until the next, at most as long as its words take", () => {
    expect(narrationSpeechSeconds(narration(10))).toBeGreaterThan(25);
    expect(
      narrationSpeechSeconds("[0.0] Бес мың.\n[20.0] Бітті.")
    ).toBeLessThan(3);
    expect(narrationSpeechSeconds(null)).toBe(0);
    expect(narrationSpeechSeconds("no times here")).toBe(0);
  });
});

describe("the owner's consent", () => {
  it("saves a pending voice from the products' video with the most speech", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([{ importId: IMPORT }, { importId: OTHER }, { importId: null }])
    );
    mockImportFind.mockImplementation(() =>
      mockQuery([
        {
          _id: OTHER,
          transcript: narration(3),
          video: { bucket: "b", path: "o" },
        },
        {
          _id: IMPORT,
          transcript: narration(12),
          video: { bucket: "b", path: "i" },
        },
      ])
    );
    const result = await createProductVoice({
      workspaceId: WS,
      userId: "user-1",
      request: { consent: true, productIds: ["651f1f77bcf86cd799439011"] },
      now,
    });
    expect(mockVoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        state: "pending",
        live: true,
        sourceImportId: IMPORT,
        consentBy: "user-1",
        consentAt: now,
        errorCode: null,
      })
    );
    expect(result).toEqual({
      created: true,
      voice: expect.objectContaining({
        state: "pending",
        sourceImportId: IMPORT,
        sourceVideoAt: videoDay.toISOString(),
        consentAt: now.toISOString(),
      }),
    });
  });

  it("names the video a copy would be made from, before the consent, with its products", async () => {
    mockProductFind.mockImplementation(() =>
      mockQuery([
        { importId: IMPORT, name: "Кукла Лол" },
        { importId: OTHER, name: "Кружка" },
        { importId: IMPORT, name: "Шежіре" },
      ])
    );
    mockImportFind.mockImplementation(() =>
      mockQuery([
        {
          _id: OTHER,
          transcript: narration(3),
          video: { bucket: "b", path: "o" },
          createdAt: now,
        },
        {
          _id: IMPORT,
          transcript: narration(12),
          video: { bucket: "b", path: "i" },
          createdAt: videoDay,
        },
      ])
    );
    expect(await productVoiceSource(WS, ["651f1f77bcf86cd799439011"])).toEqual({
      importId: IMPORT,
      sourceVideoAt: videoDay.toISOString(),
      speechSeconds: narrationSpeechSeconds(narration(12)),
      productNames: ["Кукла Лол", "Шежіре"],
    });
    mockProductFind.mockImplementation(() => mockQuery([{ importId: null }]));
    expect(await productVoiceSource(WS, ["651f1f77bcf86cd799439011"])).toBe(
      null
    );
  });

  it("answers the workspace's live voice instead of making a second", async () => {
    mockVoiceFindOne.mockImplementation(() =>
      mockQuery(voiceDoc({ state: "ready" }))
    );
    const result = await createProductVoice({
      workspaceId: WS,
      userId: "user-1",
      request: { consent: true, importId: IMPORT },
    });
    expect(result).toEqual({
      created: false,
      voice: expect.objectContaining({ state: "ready" }),
    });
    expect(mockVoiceCreate).not.toHaveBeenCalled();
  });

  it("saves a failed voice saying why when the video has too little speech", async () => {
    mockImportFind.mockImplementation(() =>
      mockQuery([
        {
          _id: IMPORT,
          transcript: narration(2),
          video: { bucket: "b", path: "i" },
        },
      ])
    );
    const result = await createProductVoice({
      workspaceId: WS,
      userId: "user-1",
      request: { consent: true, importId: IMPORT },
    });
    expect(mockVoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "failed",
        live: false,
        errorCode: "too_little_speech",
      })
    );
    expect(result).toEqual({
      created: true,
      voice: expect.objectContaining({
        state: "failed",
        errorCode: "too_little_speech",
      }),
    });
  });

  it("refuses without a video of the workspace's, or without ElevenLabs", async () => {
    expect(
      await createProductVoice({
        workspaceId: WS,
        userId: "u",
        request: { consent: true, importId: IMPORT },
      })
    ).toEqual({ refused: "import_not_found" });
    mockConfigured.mockReturnValue(false);
    expect(
      await createProductVoice({
        workspaceId: WS,
        userId: "u",
        request: { consent: true, importId: IMPORT },
      })
    ).toEqual({ refused: "voice_unavailable" });
  });

  it("two presses at once keep the first voice", async () => {
    mockImportFind.mockImplementation(() =>
      mockQuery([
        {
          _id: IMPORT,
          transcript: narration(12),
          video: { bucket: "b", path: "i" },
        },
      ])
    );
    mockVoiceFindOne
      .mockImplementationOnce(() => mockQuery(null))
      .mockImplementation(() => mockQuery(voiceDoc()));
    mockVoiceCreate.mockRejectedValue(
      Object.assign(new Error("E11000"), { code: 11000 })
    );
    const result = await createProductVoice({
      workspaceId: WS,
      userId: "u",
      request: { consent: true, importId: IMPORT },
    });
    expect(result).toEqual({
      created: false,
      voice: expect.objectContaining({ state: "pending" }),
    });
  });

  it("reads the workspace's newest voice, never a removed one", async () => {
    expect(await loadProductVoice(WS)).toBeNull();
    mockVoiceFindOne.mockImplementation(() =>
      mockQuery(voiceDoc({ state: "failed", errorCode: "clone_failed" }))
    );
    expect(await loadProductVoice(WS)).toEqual(
      expect.objectContaining({ state: "failed", errorCode: "clone_failed" })
    );
    expect(mockVoiceFindOne).toHaveBeenLastCalledWith({
      workspaceId: WS,
      removedAt: null,
      state: { $ne: "removed" },
    });
  });
});

describe("Remove my voice", () => {
  beforeEach(() => {
    mockDelete.mockReset().mockResolvedValue({ deleted: true, found: true });
    mockVoiceUpdateOne
      .mockReset()
      .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  const removedSet = {
    $set: {
      state: "removed",
      live: false,
      elevenVoiceId: null,
      removedAt: now,
      claimedAt: null,
    },
    $pullAll: { orphanVoiceIds: [] },
  };

  it("deletes the voice at ElevenLabs first, then marks it removed", async () => {
    mockVoiceFind.mockImplementation(() =>
      mockQuery([{ _id: "v1", elevenVoiceId: "clone123" }])
    );
    expect(await removeProductVoice({ workspaceId: WS, now })).toEqual({
      removed: true,
    });
    expect(mockDelete).toHaveBeenCalledWith("clone123");
    expect(mockVoiceFind).toHaveBeenCalledWith({
      workspaceId: WS,
      $or: [
        { removedAt: null, state: { $ne: "removed" } },
        { "orphanVoiceIds.0": { $exists: true } },
      ],
    });
    // Marked only while it holds the clone just deleted.
    expect(mockVoiceUpdateOne).toHaveBeenCalledWith(
      { _id: "v1", workspaceId: WS, elevenVoiceId: "clone123" },
      removedSet
    );
  });

  it("changes nothing when ElevenLabs can't delete it", async () => {
    mockVoiceFind.mockImplementation(() =>
      mockQuery([{ _id: "v1", elevenVoiceId: "clone123" }])
    );
    mockDelete.mockRejectedValue(new Error("down"));
    expect(await removeProductVoice({ workspaceId: WS })).toEqual({
      refused: "voice_unavailable",
    });
    expect(mockVoiceUpdateOne).not.toHaveBeenCalled();
  });

  it("deletes a clone the worker saves while Remove runs, before marking the voice removed", async () => {
    // Read while still being made; the worker saves its clone before the mark.
    mockVoiceFind
      .mockImplementationOnce(() =>
        mockQuery([{ _id: "v1", elevenVoiceId: null }])
      )
      .mockImplementationOnce(() =>
        mockQuery([{ _id: "v1", elevenVoiceId: "clone123" }])
      );
    mockVoiceUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    expect(await removeProductVoice({ workspaceId: WS, now })).toEqual({
      removed: true,
    });
    expect(mockDelete).toHaveBeenCalledWith("clone123");
    expect(mockVoiceUpdateOne).toHaveBeenNthCalledWith(
      1,
      { _id: "v1", workspaceId: WS, elevenVoiceId: null },
      removedSet
    );
    expect(mockVoiceUpdateOne).toHaveBeenLastCalledWith(
      { _id: "v1", workspaceId: WS, elevenVoiceId: "clone123" },
      removedSet
    );
  });

  it("deletes the clones a run couldn't, even on a voice removed before", async () => {
    const removedAt = new Date("2026-11-02T12:00:00Z");
    mockVoiceFind.mockImplementation(() =>
      mockQuery([
        {
          _id: "v0",
          elevenVoiceId: null,
          orphanVoiceIds: ["lost1"],
          removedAt,
        },
      ])
    );
    expect(await removeProductVoice({ workspaceId: WS, now })).toEqual({
      removed: true,
    });
    expect(mockDelete).toHaveBeenCalledWith("lost1");
    expect(mockVoiceUpdateOne).toHaveBeenCalledWith(
      { _id: "v0", workspaceId: WS, elevenVoiceId: null },
      {
        $set: { ...removedSet.$set, removedAt },
        $pullAll: { orphanVoiceIds: ["lost1"] },
      }
    );
  });

  it("gives up, saying so, when a run keeps saving clones under it", async () => {
    mockVoiceFind.mockImplementation(() =>
      mockQuery([{ _id: "v1", elevenVoiceId: null }])
    );
    mockVoiceUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    expect(await removeProductVoice({ workspaceId: WS })).toEqual({
      refused: "voice_unavailable",
    });
    expect(mockVoiceFind).toHaveBeenCalledTimes(3);
  });

  it("removes a voice not made yet without calling ElevenLabs, and answers a workspace without one", async () => {
    mockVoiceFind.mockImplementation(() =>
      mockQuery([{ _id: "v1", elevenVoiceId: null }])
    );
    expect(await removeProductVoice({ workspaceId: WS })).toEqual({
      removed: true,
    });
    expect(mockDelete).not.toHaveBeenCalled();
    mockVoiceFind.mockImplementation(() => mockQuery([]));
    expect(await removeProductVoice({ workspaceId: WS })).toEqual({
      removed: false,
    });
  });
});

describe("airi's voices' samples", () => {
  it("lists each voice with its sample's link in the language", () => {
    const { language, samples } = productVoiceSamples(WS, "kk");
    expect(language).toBe("kk");
    expect(samples).toHaveLength(PRODUCT_AD_STOCK_VOICES.length);
    expect(samples[0]).toEqual({
      voiceId: PRODUCT_AD_STOCK_VOICES[0]!.id,
      name: PRODUCT_AD_STOCK_VOICES[0]!.name,
      about: PRODUCT_AD_STOCK_VOICES[0]!.about,
      url: `/api/workspaces/${WS}/products/voice/samples/${PRODUCT_AD_STOCK_VOICES[0]!.id}?language=kk`,
    });
  });

  it("plays a kept sample without calling ElevenLabs", async () => {
    mockSampleFindOne.mockReturnValue({
      select: async () => ({
        audio: Buffer.from("ID3 kept"),
        mimeType: "audio/mpeg",
      }),
    });
    // A kept sample is a stored file: it plays even with AI turned off.
    mockAssertAiEnabled.mockRejectedValue(
      Object.assign(new Error("AI is disabled for this company."), {
        code: "workspace_ai_disabled",
      })
    );
    const sample = await productVoiceSampleAudio(
      WS,
      PRODUCT_AD_STOCK_VOICES[0]!.id,
      "ru"
    );
    expect(sample?.audio.toString()).toBe("ID3 kept");
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockAssertAiEnabled).not.toHaveBeenCalled();
  });

  it("makes no sample for a company that turned AI off", async () => {
    mockSampleFindOne.mockReturnValue({ select: async () => null });
    mockAssertAiEnabled.mockRejectedValue(
      Object.assign(new Error("AI is disabled for this company."), {
        code: "workspace_ai_disabled",
      })
    );
    await expect(
      productVoiceSampleAudio(WS, PRODUCT_AD_STOCK_VOICES[1]!.id, "kk")
    ).rejects.toMatchObject({ code: "workspace_ai_disabled" });
    expect(mockAssertAiEnabled).toHaveBeenCalledWith(WS);
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(mockSampleUpdateOne).not.toHaveBeenCalled();
  });

  it("makes a missing sample once, in the language's model, and keeps it", async () => {
    mockSampleFindOne.mockReturnValue({ select: async () => null });
    mockSpeak.mockResolvedValue({
      audio: Buffer.from("ID3 new"),
      mimeType: "audio/mpeg",
      characters: 70,
    });
    mockSampleUpdateOne.mockResolvedValue({});
    const voiceId = PRODUCT_AD_STOCK_VOICES[1]!.id;
    const sample = await productVoiceSampleAudio(WS, voiceId, "kk");
    expect(sample?.audio.toString()).toBe("ID3 new");
    expect(mockAssertAiEnabled).toHaveBeenCalledWith(WS);
    expect(mockSpeak).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceId,
        modelId: "eleven_v4",
        languageCode: "kk",
        outputFormat: "mp3_22050_32",
      }),
      expect.anything()
    );
    expect(mockSampleUpdateOne).toHaveBeenCalledWith(
      { voiceId, language: "kk", version: 1 },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ mimeType: "audio/mpeg" }),
      }),
      { upsert: true }
    );
  });

  it("has no sample for a voice that isn't airi's", async () => {
    expect(await productVoiceSampleAudio(WS, "someone-else", "en")).toBeNull();
    expect(mockSpeak).not.toHaveBeenCalled();
  });
});

describe("reading an ad in another voice", () => {
  const ready = (overrides: Doc = {}): Doc => ({
    _id: AD,
    workspaceId: WS,
    status: "ready",
    renderNo: 3,
    voice: "own",
    stockVoiceId: null,
    voiceResult: null,
    runKind: "render",
    render: { renderNo: 3 },
    script: { sticker: "s" },
    costMicros: 80_000,
    requestedAt: now,
    startedAt: now,
    createdAt: now,
    ...overrides,
  });
  const stock = PRODUCT_AD_STOCK_VOICES[0]!.id;

  beforeEach(() => {
    mockAdFindOne.mockImplementation(() => mockQuery(ready()));
    mockAdFindOneAndUpdate.mockImplementation(() =>
      mockQuery({ ...ready(), status: "making" })
    );
    mockAdmission.mockResolvedValue(null);
    mockStart.mockResolvedValue("wf");
    mockLoadAd.mockResolvedValue({ id: AD, status: "making" });
  });

  it("starts a voice run on the ad's next render, admitted as the action it already is", async () => {
    const result = await changeProductAdVoice({
      workspaceId: WS,
      adId: AD,
      request: { voice: "stock", stockVoiceId: stock },
      now,
    });
    expect(result).toEqual({ ad: { id: AD, status: "making" }, started: true });
    expect(mockAdmission).toHaveBeenCalledWith(WS, { admitted: true });
    expect(mockAdFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: AD, workspaceId: WS, status: "ready", renderNo: 3 },
      {
        $set: {
          voice: "stock",
          stockVoiceId: stock,
          voiceResult: null,
          runKind: "voice",
          status: "making",
          step: "video",
          renderNo: 4,
          requestedAt: now,
          startedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      },
      { new: true }
    );
    expect(mockStart).toHaveBeenCalledWith(WS, AD, 4, "make");
  });

  it("asks nothing of the ledger for the recording or no voice", async () => {
    await changeProductAdVoice({
      workspaceId: WS,
      adId: AD,
      request: { voice: "none" },
    });
    expect(mockAdmission).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it("starts nothing for the voice the video already has, or a press repeated while its run goes", async () => {
    mockLoadAd.mockResolvedValue({ id: AD, status: "ready" });
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "own" },
      })
    ).toEqual({ ad: { id: AD, status: "ready" }, started: false });
    mockAdFindOne.mockImplementation(() =>
      mockQuery(
        ready({
          status: "making",
          runKind: "voice",
          voice: "stock",
          stockVoiceId: stock,
        })
      )
    );
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "stock", stockVoiceId: stock },
      })
    ).toEqual(expect.objectContaining({ started: false }));
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("reads the same voice again when the video fell back", async () => {
    mockAdFindOne.mockImplementation(() =>
      mockQuery(
        ready({
          voice: "stock",
          stockVoiceId: stock,
          voiceResult: { used: "own", fallback: "unavailable" },
        })
      )
    );
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "stock", stockVoiceId: stock },
      })
    ).toEqual(expect.objectContaining({ started: true }));
  });

  it("reads the same voice again after its voice run failed and the ad fell back to ready", async () => {
    // The worker's edit-run fallback: ready again with the earlier video, the
    // asked-for voice stored, and lastRun saying the voice run failed.
    mockAdFindOne.mockImplementation(() =>
      mockQuery(
        ready({
          voice: "stock",
          stockVoiceId: stock,
          runKind: "voice",
          renderNo: 4,
          lastRun: {
            renderNo: 4,
            kind: "voice",
            outcome: "failed",
            errorCode: "failed",
            message: "x",
            at: now,
          },
        })
      )
    );
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "stock", stockVoiceId: stock },
      })
    ).toEqual(expect.objectContaining({ started: true }));
    expect(mockStart).toHaveBeenCalledWith(WS, AD, 5, "make");
  });

  it("refuses an ad that isn't ready, a clone without a voice, and a workspace that can't pay", async () => {
    mockAdFindOne.mockImplementationOnce(() =>
      mockQuery(ready({ status: "making", runKind: "scene" }))
    );
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "none" },
      })
    ).toEqual({ refused: "ad_not_ready" });
    mockVoiceExists.mockResolvedValue(null);
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "clone" },
      })
    ).toEqual({ refused: "voice_not_found" });
    mockAdmission.mockResolvedValue("spend_limit");
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "stock", stockVoiceId: stock },
      })
    ).toEqual({ refused: "spend_limit" });
    // The company turned AI off: refused as such, nothing started.
    mockAdmission.mockResolvedValue("ai_disabled");
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "stock", stockVoiceId: stock },
      })
    ).toEqual({ refused: "ai_disabled" });
    mockAdFindOne.mockImplementationOnce(() => mockQuery(null));
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "none" },
      })
    ).toEqual({ refused: "ad_not_found" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("clears the old voice's fallback on a press, so the recording asked for isn't still called a fallback", async () => {
    mockAdFindOne.mockImplementation(() =>
      mockQuery(
        ready({
          voice: "clone",
          voiceResult: { used: "own", fallback: "no_voice" },
        })
      )
    );
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "own" },
      })
    ).toEqual(expect.objectContaining({ started: true }));
    expect(mockAdFindOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: expect.objectContaining({ voice: "own", voiceResult: null }) },
      { new: true }
    );
    // The recording, kept from the fallback, costs nothing to go back to.
    expect(mockAdmission).not.toHaveBeenCalled();

    // Once its run is done, the same press starts nothing.
    mockAdFindOneAndUpdate.mockClear();
    mockAdFindOne.mockImplementation(() =>
      mockQuery(ready({ voice: "own", voiceResult: null }))
    );
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "own" },
      })
    ).toEqual(expect.objectContaining({ started: false }));
    expect(mockAdFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("asks the ledger before the recording is cleaned up on an ad never read in it", async () => {
    mockAdFindOne.mockImplementation(() =>
      mockQuery(
        ready({
          voice: "stock",
          stockVoiceId: stock,
          voiceResult: { used: "stock", fallback: null },
        })
      )
    );
    mockAdmission.mockResolvedValue("ai_actions_used");
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "own" },
      })
    ).toEqual({ refused: "ai_actions_used" });
    expect(mockAdmission).toHaveBeenCalledWith(WS, { admitted: true });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("puts back the old voice's fallback when the run can't start", async () => {
    const fellBack = { used: "own", fallback: "unavailable" };
    mockAdFindOne.mockImplementation(() =>
      mockQuery(
        ready({ voice: "stock", stockVoiceId: stock, voiceResult: fellBack })
      )
    );
    mockStart.mockRejectedValue(new Error("Temporal down"));
    await expect(
      changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "none" },
      })
    ).rejects.toThrow("Temporal down");
    expect(mockAdUpdateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: expect.objectContaining({ voiceResult: fellBack }),
    });
  });

  it("loses to another change that got there first", async () => {
    mockAdFindOneAndUpdate.mockImplementation(() => mockQuery(null));
    expect(
      await changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "none" },
      })
    ).toEqual({ refused: "ad_not_ready" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("puts the ad back as it was when the run can't start", async () => {
    mockStart.mockRejectedValue(new Error("Temporal down"));
    await expect(
      changeProductAdVoice({
        workspaceId: WS,
        adId: AD,
        request: { voice: "none" },
      })
    ).rejects.toThrow("Temporal down");
    expect(mockAdUpdateOne).toHaveBeenCalledWith(
      { _id: AD, workspaceId: WS, renderNo: 4 },
      {
        $set: {
          voice: "own",
          stockVoiceId: null,
          voiceResult: null,
          runKind: "render",
          status: "ready",
          step: null,
          renderNo: 3,
          requestedAt: now,
          startedAt: now,
        },
      }
    );
  });
});
