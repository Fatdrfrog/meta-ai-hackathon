/**
 * Module mocks that every scenario-runtime auto-reply suite declares the same
 * way (pending-diagnostics, location-routes, form-answers, prompt-inputs).
 *
 * Import this module before anything else in the suite: its jest.mock calls
 * register when it is first required, so they must run before the code under
 * test is loaded. Mocks whose factories differ between suites (partial
 * requireActual mocks, inline jest.fn() doubles a suite reads back through
 * jest.requireMock) stay in each suite. The file name ends in "fixtures" so
 * Jest does not collect it as a suite.
 */

export const mockConversationFindById = jest.fn();
export const mockConversationUpdateOne = jest.fn();
export const mockScenarioFindOne = jest.fn();
export const mockResolveActiveScenarioRuntime = jest.fn();
export const mockPersistScenarioState = jest.fn();
export const mockFinalizeScenarioResolution = jest.fn();
export const mockCompleteScenarioAfterDispatch = jest.fn();
export const mockSendAndPersistOutbound = jest.fn();
export const mockRunIntentFastPath = jest.fn();
export const mockRunRagReplyFlow = jest.fn();

jest.mock("@/models/scenario", () => ({
  Scenario: { findOne: (...args: unknown[]) => mockScenarioFindOne(...args) },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
    updateOne: (...args: unknown[]) => mockConversationUpdateOne(...args),
  },
}));
jest.mock("@/models/airi-suggestion", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotRuntimeSettings: jest.fn().mockResolvedValue({
    defaultBotEnabled: false,
    defaultScenariosEnabled: true,
    defaultCoachEnabled: false,
    retrievalQueryMode: "message",
    includeRecentConversationInRetrievalContext: false,
    sendKbArticleLinksToUserChannels: false,
    languageBias: "auto",
    greetingBehavior: "off",
    escalationBehavior: "off",
    responseStyle: "balanced",
  }),
}));
jest.mock("@/lib/airi/reply/runtime/intent", () => ({
  runIntentFastPath: (...args: unknown[]) => mockRunIntentFastPath(...args),
}));
jest.mock("@/lib/airi/reply/runtime/rag", () => ({
  runRagReplyFlow: (...args: unknown[]) => mockRunRagReplyFlow(...args),
}));
jest.mock("@/lib/airi/reply/generation/reply-language", () => ({
  ensureReplyLanguage: jest.fn().mockImplementation(async ({ text }) => ({
    text,
    translationFallbackUsed: false,
  })),
  resolveCustomerReplyLanguageContext: jest.fn().mockReturnValue({
    inboundLanguage: "en",
    replyLanguage: "en",
  }),
}));
