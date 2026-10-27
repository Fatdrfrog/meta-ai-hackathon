import {
  configureWhatsAppVoiceReplyStorage,
  prepareWhatsAppVoiceReply,
} from "./whatsapp-voice-reply";

const mockAccess = jest.fn();
const mockSpeech = jest.fn();
const mockCapture = jest.fn();
const mockAdmission = jest.fn();

jest.mock("@/lib/airi/voice-reply-access", () => ({
  resolveWorkspaceVoiceReplyAccess: (...args: unknown[]) => mockAccess(...args),
}));
jest.mock("@/lib/elevenlabs/creative-assets", () => ({
  submitElevenLabsTextToSpeech: (...args: unknown[]) => mockSpeech(...args),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogClient: () => ({ capture: mockCapture }),
}));
jest.mock("@/lib/creative-assets/creative-generation-admission", () => ({
  withWorkspaceCreativeGenerationAdmission: (...args: unknown[]) =>
    mockAdmission(...args),
}));
jest.mock("@/lib/airi/reply/runtime/reply-logging", () => ({
  airiReplyLogger: { warn: jest.fn(), info: jest.fn() },
}));

const attachment = {
  url: "gcs://bucket/workspaces/w/creative-assets/audio/voice/reply.ogg",
  mediaType: "audio" as const,
  mimeType: "audio/ogg",
  fileName: "reply.ogg",
};
const input = {
  workspaceId: "w",
  text: "Your order is ready.",
  deliveryKey: "turn:1",
  language: "en",
};
const opus = Buffer.concat([
  Buffer.from("OggS"),
  Buffer.alloc(24),
  Buffer.from("OpusHead"),
  Buffer.from([1, 1]),
  Buffer.alloc(16),
]);
const find = jest.fn();
const store = jest.fn();

describe("paid WhatsApp voice reply preparation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAccess.mockResolvedValue({
      available: true,
      reason: null,
      apiKey: "secret",
      defaultVoiceId: "voice",
    });
    mockSpeech.mockResolvedValue({
      buffer: opus,
      mimeType: "audio/ogg",
      modelId: "eleven_multilingual_v2",
    });
    find.mockResolvedValue(null);
    store.mockResolvedValue(attachment);
    mockAdmission.mockImplementation((_workspace, run) => run());
    configureWhatsAppVoiceReplyStorage({ find, store });
  });
  afterEach(() => configureWhatsAppVoiceReplyStorage(null));

  it("uses the connected paid account and stores one bounded OPUS voice note", async () => {
    await expect(prepareWhatsAppVoiceReply(input)).resolves.toEqual(attachment);
    expect(mockSpeech).toHaveBeenCalledWith({
      apiKey: "secret",
      voiceId: "voice",
      text: input.text,
      language: "en",
      outputFormat: "opus_48000_64",
      timeoutMs: 10000,
    });
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w",
        assetId: expect.stringMatching(/^airi-voice-[a-f0-9]{64}$/),
        buffer: opus,
      })
    );
    const captured = JSON.stringify(mockCapture.mock.calls);
    expect(captured).not.toContain("secret");
    expect(captured).not.toContain(input.text);
  });

  it("reuses durable audio on the same delivery instead of charging another synthesis", async () => {
    find.mockResolvedValue(attachment);
    await expect(prepareWhatsAppVoiceReply(input)).resolves.toEqual(attachment);
    expect(mockAccess).toHaveBeenCalledTimes(1);
    expect(mockSpeech).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("checks entitlement again even when audio is cached", async () => {
    find.mockResolvedValue(attachment);
    mockAccess.mockResolvedValue({
      available: false,
      reason: "subscription_required",
      apiKey: null,
    });
    await expect(prepareWhatsAppVoiceReply(input)).resolves.toBeNull();
    expect(find).not.toHaveBeenCalled();
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "a".repeat(601),
    "Pay at https://shop.example/pay",
    "Open HTTPS://shop.example",
    "Open WWW.shop.example",
    "[Pay](https://shop.example)",
    "[Pay](/checkout)",
    "Email [us](mailto:sales@example.com)",
    "<b>Ready</b>",
    "```private code```",
  ])(
    "keeps unsupported or long content in text without provider work: %s",
    async text => {
      await expect(
        prepareWhatsAppVoiceReply({ ...input, text })
      ).resolves.toBeNull();
      expect(mockAccess).not.toHaveBeenCalled();
      expect(mockSpeech).not.toHaveBeenCalled();
    }
  );

  it("coalesces overlapping attempts for the same delivery and holds existing admission", async () => {
    let finish: (result: unknown) => void = () => {};
    mockSpeech.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const first = prepareWhatsAppVoiceReply(input);
    const second = prepareWhatsAppVoiceReply(input);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(mockSpeech).toHaveBeenCalledTimes(1);
    expect(mockAdmission).toHaveBeenCalledTimes(1);
    finish({ buffer: opus, mimeType: "audio/ogg" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      attachment,
      attachment,
    ]);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("rechecks persisted audio after admission to avoid another host's completed synthesis", async () => {
    find.mockResolvedValueOnce(null).mockResolvedValueOnce(attachment);
    await expect(prepareWhatsAppVoiceReply(input)).resolves.toEqual(attachment);
    expect(mockAdmission).toHaveBeenCalledWith("w", expect.any(Function));
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  it("never truncates a long answer or its conditions to fit a voice note", async () => {
    await expect(
      prepareWhatsAppVoiceReply({
        ...input,
        text: "a".repeat(600) + " unless cancelled.",
      })
    ).resolves.toBeNull();
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  it("uses formatting-free speech while preserving prices and qualifiers", async () => {
    await prepareWhatsAppVoiceReply({
      ...input,
      text: "**Total:** 12,500 ₸, *if available*.",
    });
    expect(mockSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Total: 12,500 ₸, if available." })
    );
  });

  it("uses separate stable storage identities for different turns, language, voice, and text", async () => {
    await prepareWhatsAppVoiceReply(input);
    await prepareWhatsAppVoiceReply({ ...input, deliveryKey: "turn:2" });
    await prepareWhatsAppVoiceReply({ ...input, language: "kz" });
    await prepareWhatsAppVoiceReply({
      ...input,
      text: "Your appointment is ready.",
    });
    mockAccess.mockResolvedValue({
      available: true,
      apiKey: "secret",
      defaultVoiceId: "another-voice",
    });
    await prepareWhatsAppVoiceReply(input);
    expect(new Set(find.mock.calls.map(([ref]) => ref.assetId)).size).toBe(5);
  });

  it("falls back before synthesis when storage is unavailable", async () => {
    configureWhatsAppVoiceReplyStorage(null);
    await expect(prepareWhatsAppVoiceReply(input)).resolves.toBeNull();
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  it.each(["access", "read", "speech", "store"])(
    "keeps text delivery available on %s failure",
    async step => {
      const error = new Error("provider secret body");
      if (step === "access") mockAccess.mockRejectedValue(error);
      if (step === "read") find.mockRejectedValue(error);
      if (step === "speech") mockSpeech.mockRejectedValue(error);
      if (step === "store") store.mockRejectedValue(error);
      await expect(prepareWhatsAppVoiceReply(input)).resolves.toBeNull();
      expect(JSON.stringify(mockCapture.mock.calls)).not.toContain(
        error.message
      );
    }
  );

  it.each([
    { buffer: Buffer.alloc(0), mimeType: "audio/ogg" },
    { buffer: Buffer.from("mp3"), mimeType: "audio/ogg" },
    { buffer: opus, mimeType: "audio/mpeg" },
    {
      buffer: Buffer.concat([
        opus.subarray(0, 37),
        Buffer.from([2]),
        opus.subarray(38),
      ]),
      mimeType: "audio/ogg",
    },
  ])("rejects unusable audio before storing or dispatching", async audio => {
    mockSpeech.mockResolvedValue(audio);
    await expect(prepareWhatsAppVoiceReply(input)).resolves.toBeNull();
    expect(store).not.toHaveBeenCalled();
  });
});
