const mockConversationLean = jest.fn();
const mockConversationFindByIdAndUpdate = jest.fn();
const mockMessageLean = jest.fn();
const mockLoggerError = jest.fn();

jest.mock("@icecore/shared/lib/logger", () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLoggerError(...args),
  }),
}));

jest.mock("@/lib/airi/language-detector-server", () => ({
  detectLanguageModelOnly: jest.fn().mockResolvedValue(null),
  detectLanguage: jest.fn().mockResolvedValue("en"),
}));

jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: () => ({
      select: () => ({
        lean: () => mockConversationLean(),
      }),
    }),
    findByIdAndUpdate: (...args: unknown[]) =>
      mockConversationFindByIdAndUpdate(...args),
  },
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    find: () => ({
      sort: () => ({
        limit: () => ({
          select: () => ({
            lean: () => mockMessageLean(),
          }),
        }),
      }),
    }),
  },
}));

import { detectLanguageModelOnly } from "@/lib/airi/language-detector-server";
import { detectAndUpdateConversationLanguageDecision } from "@/lib/airi/coach/coach-utils-server";

describe("detectAndUpdateConversationLanguageDecision", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationFindByIdAndUpdate.mockResolvedValue({ acknowledged: true });
    jest.mocked(detectLanguageModelOnly).mockResolvedValue(null);
  });

  it("inherits the recent strong language for ambiguous follow-ups without mutating durable state", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([
      { text: "Qazinnovation" },
      { text: "ok" },
    ]);

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-1",
      "Qazinnovation",
      {
        workspaceLanguageBias: "kz",
      }
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: null,
      currentTurnLanguageSource: null,
      activeLanguage: "ru",
      activeLanguageSource: "stored_recent",
      recentCustomerLanguage: "ru",
      conversationPreferredLanguage: "ru",
    });
    expect(mockConversationFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("persists confident Google Cloud detections when there is no conflicting durable language", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: null,
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([
      { text: "Здравствуйте, нужна помощь с заказом" },
    ]);
    jest.mocked(detectLanguageModelOnly).mockResolvedValue("ru");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-2",
      "Здравствуйте, нужна помощь с заказом",
      {
        workspaceLanguageBias: "kz",
      }
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: "ru",
      currentTurnLanguageSource: "confident",
      activeLanguage: "ru",
      activeLanguageSource: "current_turn",
      recentCustomerLanguage: "ru",
      conversationPreferredLanguage: "ru",
    });
    expect(mockConversationFindByIdAndUpdate).toHaveBeenCalledWith(
      "conversation-2",
      expect.objectContaining({
        airi_last_customer_language: "ru",
        airi_last_customer_language_source: "google_cloud",
        preferred_language: "ru",
      }),
      { new: true, runValidators: true }
    );
  });

  it("keeps unsupported provider languages ephemeral instead of persisting them", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: null,
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([
      { text: "Доброго дня, мені потрібна допомога з замовленням" },
    ]);
    jest.mocked(detectLanguageModelOnly).mockResolvedValue("uk");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-uk",
      "Доброго дня, мені потрібна допомога з замовленням"
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: "uk",
      activeLanguage: "uk",
      recentCustomerLanguage: null,
      conversationPreferredLanguage: "en",
    });
    expect(mockConversationFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("keeps unsupported dominant-history languages out of durable fields", async () => {
    const currentMessage = "Current customer question with enough text";
    const previousMessage = "Previous customer question with enough text";
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: null,
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([
      { text: currentMessage },
      { text: previousMessage },
    ]);
    jest
      .mocked(detectLanguageModelOnly)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("uk");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-uk-history",
      currentMessage
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: null,
      activeLanguage: "uk",
      activeLanguageSource: "dominant_recent",
      recentCustomerLanguage: null,
      conversationPreferredLanguage: "en",
    });
    expect(mockConversationFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("does not expose unsupported stored values as durable language decisions", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "uk",
      airi_last_customer_language: "uk",
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([]);

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-poisoned",
      "ok"
    );

    expect(decision).toMatchObject({
      recentCustomerLanguage: null,
      conversationPreferredLanguage: null,
    });
  });

  it("logs persistence failures without reporting an uncommitted language as durable", async () => {
    const persistenceError = new Error("language update failed");
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: null,
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([]);
    mockConversationFindByIdAndUpdate.mockRejectedValue(persistenceError);
    jest.mocked(detectLanguageModelOnly).mockResolvedValue("ru");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-write-failure",
      "A sufficiently long customer question"
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: "ru",
      activeLanguage: "ru",
      recentCustomerLanguage: null,
      conversationPreferredLanguage: "en",
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to resolve or persist conversation language",
      persistenceError,
      {
        conversationId: "conversation-write-failure",
        detectedLanguage: "ru",
      }
    );
  });

  it("does not report a language as durable when the conversation disappeared", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "en",
      airi_last_customer_language: null,
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([]);
    mockConversationFindByIdAndUpdate.mockResolvedValue(null);
    jest.mocked(detectLanguageModelOnly).mockResolvedValue("ru");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-deleted",
      "A sufficiently long customer question"
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: "ru",
      activeLanguage: "ru",
      recentCustomerLanguage: null,
      conversationPreferredLanguage: "en",
    });
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to resolve or persist conversation language",
      expect.objectContaining({
        message: "Conversation language update matched no document",
      }),
      {
        conversationId: "conversation-deleted",
        detectedLanguage: "ru",
      }
    );
  });

  it("does not re-detect recent inbound messages when the current turn matches durable language", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "ru",
      airi_last_customer_language: "ru",
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([
      { text: "Здравствуйте, нужна помощь" },
      { text: "Подскажите по ценам" },
    ]);
    jest.mocked(detectLanguageModelOnly).mockResolvedValue("ru");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-3",
      "Здравствуйте, нужна помощь с заказом",
      {
        workspaceLanguageBias: "kz",
      }
    );

    expect(decision.currentTurnLanguage).toBe("ru");
    expect(detectLanguageModelOnly).toHaveBeenCalledTimes(1);
    expect(detectLanguageModelOnly).toHaveBeenCalledWith(
      "Здравствуйте, нужна помощь с заказом"
    );
  });

  it("does not let a conflicting single-turn detection overwrite durable language", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "kz",
      airi_last_customer_language: "kz",
      workspaceId: "ws_1",
    });
    mockMessageLean.mockResolvedValue([
      {
        text: "Sonra, iyi, dursun biraz zirtba. nefes verme Roziza bahasi ya",
      },
      { text: "Сәлеметсіз бе, бағасын айтып бересіз бе" },
      { text: "Қай бөлімде көрсетіліп тұр?" },
    ]);
    jest
      .mocked(detectLanguageModelOnly)
      .mockResolvedValueOnce("tr")
      .mockResolvedValue("kz");

    const decision = await detectAndUpdateConversationLanguageDecision(
      "conversation-4",
      "Sonra, iyi, dursun biraz zirtba. nefes verme Roziza bahasi ya",
      {
        workspaceLanguageBias: "kz",
      }
    );

    expect(decision).toMatchObject({
      currentTurnLanguage: "tr",
      currentTurnLanguageSource: "confident",
      activeLanguage: "kz",
      activeLanguageSource: "dominant_recent",
      recentCustomerLanguage: "kz",
      conversationPreferredLanguage: "kz",
    });
    expect(mockConversationFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("detects independent recent-message languages concurrently", async () => {
    mockConversationLean.mockResolvedValue({
      preferred_language: "kz",
      airi_last_customer_language: "kz",
      workspaceId: "ws_1",
    });
    const currentMessage = "Current conflicting transcription";
    const firstHistory = "First recent customer message";
    const secondHistory = "Second recent customer message";
    mockMessageLean.mockResolvedValue([
      { text: currentMessage },
      { text: firstHistory },
      { text: secondHistory },
    ]);

    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const firstDetection = new Promise<string>(resolve => {
      resolveFirst = resolve;
    });
    const secondDetection = new Promise<string>(resolve => {
      resolveSecond = resolve;
    });
    jest
      .mocked(detectLanguageModelOnly)
      .mockImplementation((message: string) => {
        if (message === currentMessage) return Promise.resolve("tr");
        if (message === firstHistory) return firstDetection;
        if (message === secondHistory) return secondDetection;
        return Promise.resolve(null);
      });

    const decisionPromise = detectAndUpdateConversationLanguageDecision(
      "conversation-5",
      currentMessage
    );

    for (
      let attempt = 0;
      attempt < 20 &&
      jest.mocked(detectLanguageModelOnly).mock.calls.length < 3;
      attempt += 1
    ) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(detectLanguageModelOnly).toHaveBeenCalledTimes(3);

    resolveFirst("kz");
    resolveSecond("kz");
    await expect(decisionPromise).resolves.toMatchObject({
      activeLanguage: "kz",
      activeLanguageSource: "dominant_recent",
    });
  });
});
