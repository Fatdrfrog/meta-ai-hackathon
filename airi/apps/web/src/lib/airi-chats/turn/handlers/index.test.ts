const mockHandlers = {
  general: jest.fn(async () => ({ handler: "general" })),
  product: jest.fn(async () => ({ handler: "product" })),
  template: jest.fn(async () => ({ handler: "template" })),
  flow: jest.fn(async () => ({ handler: "flow" })),
  image: jest.fn(async () => ({ handler: "image" })),
  scan: jest.fn(async () => ({ handler: "scan" })),
  campaign: jest.fn(async () => ({ handler: "campaign" })),
  meta: jest.fn(async () => ({ handler: "meta" })),
};

jest.mock("./general", () => ({
  handleGeneralAnswerTurn: (...args: unknown[]) =>
    mockHandlers.general(...(args as [])),
}));
jest.mock("./product", () => ({
  handleProductCapabilityTurn: (...args: unknown[]) =>
    mockHandlers.product(...(args as [])),
}));
jest.mock("./whatsapp-template", () => ({
  handleWhatsAppTemplateTurn: (...args: unknown[]) =>
    mockHandlers.template(...(args as [])),
}));
jest.mock("./whatsapp-flow", () => ({
  handleWhatsAppFlowTurn: (...args: unknown[]) =>
    mockHandlers.flow(...(args as [])),
}));
jest.mock("./image", () => ({
  handleImageGenerationTurn: (...args: unknown[]) =>
    mockHandlers.image(...(args as [])),
}));
jest.mock("./opportunity-scan", () => ({
  handleOpportunityScanTurn: (...args: unknown[]) =>
    mockHandlers.scan(...(args as [])),
}));
jest.mock("./marketing-campaign", () => ({
  handleMarketingCampaignTurn: (...args: unknown[]) =>
    mockHandlers.campaign(...(args as [])),
}));
jest.mock("./meta-ads", () => ({
  handleMetaAdsTurn: (...args: unknown[]) => mockHandlers.meta(...(args as [])),
}));
// Retrieval's search legs are never called here; their modules pull in
// database and provider clients at import.
jest.mock("@/lib/ai/ask-data-search-local", () => ({
  searchAskDataContextLocal: jest.fn(),
}));
jest.mock("@/lib/ai/gcp-ai-gateway", () => ({
  canCallGcpAIGateway: () => false,
  getRemoteAskDataContext: jest.fn(),
}));

import type { AiriChatIntentKind } from "@/lib/airi-chats/intent-classifier";
import type { AiriTurnContext } from "../types";
import { AIRI_TURN_HANDLERS, dispatchAiriTurn } from "./index";

function buildContext(params: {
  intent: AiriChatIntentKind;
  userMessage?: string;
  conversations?: number;
  unavailable?: boolean;
  selectedSources?: number;
}): AiriTurnContext {
  return {
    params: { userMessage: params.userMessage ?? "Summarize this week" },
    intentClassification: {
      intent: params.intent,
      confidence: 0.9,
      reason: "test",
      provider: null,
      model: null,
      latencyMs: null,
      usage: null,
    },
    searchResult: {
      conversations: Array.from(
        { length: params.conversations ?? 1 },
        (_, index) => ({ id: `conversation-${index}` })
      ),
      kbArticles: [],
    },
    workspaceRetrieval: { unavailable: params.unavailable ?? false },
    normalizedSelectedSources: Array.from(
      { length: params.selectedSources ?? 0 },
      () => ({ kind: "chat_thread", threadId: "t", label: "t" })
    ),
  } as unknown as AiriTurnContext;
}

const PLATFORM_QUESTION = "How do I connect WhatsApp to airi.chat?";

describe("dispatchAiriTurn", () => {
  beforeEach(() => {
    Object.values(mockHandlers).forEach(handler => handler.mockClear());
  });

  it.each<[AiriChatIntentKind, keyof typeof mockHandlers]>([
    ["general_answer", "general"],
    ["product_capability", "product"],
    ["whatsapp_template", "template"],
    ["whatsapp_flow", "flow"],
    ["opportunity_scan", "scan"],
    ["marketing_campaign", "campaign"],
    ["image_generation", "image"],
    ["meta_ads_mcp", "meta"],
  ])("runs the %s handler", async (intent, handler) => {
    const context = buildContext({ intent });

    await expect(dispatchAiriTurn(context)).resolves.toEqual({ handler });

    expect(mockHandlers[handler]).toHaveBeenCalledTimes(1);
    expect(mockHandlers[handler]).toHaveBeenCalledWith(context);
    const others = Object.entries(mockHandlers).filter(
      ([name]) => name !== handler
    );
    others.forEach(([, other]) => expect(other).not.toHaveBeenCalled());
  });

  it("has a handler for every intent the classifier can return", () => {
    expect(Object.keys(AIRI_TURN_HANDLERS).sort()).toEqual(
      [
        "general_answer",
        "image_generation",
        "marketing_campaign",
        "meta_ads_mcp",
        "opportunity_scan",
        "product_capability",
        "whatsapp_flow",
        "whatsapp_template",
      ].sort()
    );
  });

  it("answers an empty tenant's platform question from the product KB", async () => {
    const context = buildContext({
      intent: "general_answer",
      userMessage: PLATFORM_QUESTION,
      conversations: 0,
    });

    await expect(dispatchAiriTurn(context)).resolves.toEqual({
      handler: "product",
    });

    expect(mockHandlers.product).toHaveBeenCalledWith(context, {
      fromIntent: "general_answer",
      reason: "empty_tenant_platform_safety_net",
    });
    expect(mockHandlers.general).not.toHaveBeenCalled();
  });

  it.each([
    ["the tenant has context", { conversations: 1 }],
    ["workspace context could not load", { unavailable: true }],
    ["the user attached sources", { selectedSources: 1 }],
  ])("keeps the classified intent when %s", async (_label, overrides) => {
    const context = buildContext({
      intent: "general_answer",
      userMessage: PLATFORM_QUESTION,
      conversations: 0,
      ...overrides,
    });

    await dispatchAiriTurn(context);

    expect(mockHandlers.general).toHaveBeenCalledTimes(1);
    expect(mockHandlers.product).not.toHaveBeenCalled();
  });

  it("never reroutes a Meta Ads turn on an empty tenant", async () => {
    const context = buildContext({
      intent: "meta_ads_mcp",
      userMessage: PLATFORM_QUESTION,
      conversations: 0,
    });

    await dispatchAiriTurn(context);

    expect(mockHandlers.meta).toHaveBeenCalledTimes(1);
    expect(mockHandlers.product).not.toHaveBeenCalled();
  });

  it("runs a product question without the safety-net marker", async () => {
    const context = buildContext({
      intent: "product_capability",
      userMessage: PLATFORM_QUESTION,
      conversations: 0,
    });

    await dispatchAiriTurn(context);

    expect(mockHandlers.product).toHaveBeenCalledWith(context);
  });

  it("falls back to the general answer for an unknown intent", async () => {
    const context = buildContext({
      intent: "unknown_intent" as AiriChatIntentKind,
    });

    await expect(dispatchAiriTurn(context)).resolves.toEqual({
      handler: "general",
    });
  });
});
