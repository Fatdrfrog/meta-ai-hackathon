/**
 * Draft handlers on structured outputs: a valid answer is saved, and an
 * answer that is not a valid draft (truncated, not JSON, rejected by the
 * validator) saves nothing, keeps the open draft and returns a localized
 * degraded reply with metadata.fallbackUsed.
 */

const mockChatCompletionWithFallback = jest.fn();
const mockCreateAiriArtifact = jest.fn();
const mockUpdateAiriArtifact = jest.fn();

jest.mock("@/lib/ai", () => {
  const providerErrors = jest.requireActual<
    typeof import("@/lib/ai/provider-errors")
  >("@/lib/ai/provider-errors");
  return {
    AIChatProviderAggregateError: providerErrors.AIChatProviderAggregateError,
    chatCompletionWithFallback: (...args: unknown[]) =>
      mockChatCompletionWithFallback(...args),
    getHeavyTextModel: jest.fn(() => "heavy-text-model"),
    isRetryableAIProviderError: jest.fn(
      providerErrors.isRetryableAIProviderError
    ),
  };
});

jest.mock("@/lib/airi-artifacts/service", () => {
  class AiriArtifactConflictError extends Error {}
  class AiriArtifactValidationError extends Error {}
  return {
    AiriArtifactConflictError,
    AiriArtifactValidationError,
    createAiriArtifact: (...args: unknown[]) => mockCreateAiriArtifact(...args),
    updateAiriArtifact: (...args: unknown[]) => mockUpdateAiriArtifact(...args),
  };
});

jest.mock("@/lib/airi-chats/generated-image-generation", () => ({
  createQueuedAiriImageGeneration: jest.fn(async () => null),
  startQueuedAiriImageGeneration: jest.fn(),
  updateQueuedAiriImageGenerationTarget: jest.fn(),
}));

jest.mock("@/lib/airi-chats/sources", () => ({
  formatAiriChatConversationContextLine: jest.fn(() => ""),
}));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

import type { AiriLanguage } from "@/lib/airi/shared/language-policy";
import type { ActiveAiriBuilderInput } from "@/lib/airi-chats/builder-state";
import { AIRI_FLOW_DRAFT_RESPONSE_SCHEMA } from "@/lib/airi-chats/builder-state";
import { isAiriChatReplyFailed } from "@/lib/airi-chats/errors";
import { createQueuedAiriImageGeneration } from "@/lib/airi-chats/generated-image-generation";
import type { AiriMarketingToolAccess } from "@/lib/airi-chats/marketing-package";
import { AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA } from "@/lib/airi-chats/marketing-package";
import { AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA } from "@/lib/airi-chats/opportunity-scan";
import { AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA } from "@/lib/airi-chats/whatsapp-template-drafts";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import { createAiriTurnDeadline } from "../deadline";
import { AIRI_DRAFT_FALLBACK_MESSAGES } from "../draft-fallback";
import { createAiriTurnStepRecovery } from "../failure";
import { createProgressRecorder } from "../progress";
import type { AiriTurnContext } from "../types";
import { handleMarketingCampaignTurn } from "./marketing-campaign";
import { handleOpportunityScanTurn } from "./opportunity-scan";
import { handleWhatsAppFlowTurn } from "./whatsapp-flow";
import { handleWhatsAppTemplateTurn } from "./whatsapp-template";

const TOOL_ACCESS: AiriMarketingToolAccess = {
  whatsapp: { available: true, label: "WhatsApp" },
  scenarios: { available: true, label: "Scenarios" },
  bulkCampaigns: { available: true, label: "Bulk campaigns" },
  canva: { available: false, label: "Canva" },
  visualGeneration: { available: false, label: "Visual generation" },
  audioGeneration: { available: false, label: "Audio generation" },
  metaAds: { available: false, label: "Meta Ads" },
};

const ACTIVE_TEMPLATE: ActiveAiriBuilderInput = {
  kind: "whatsapp_template",
  artifactId: "template-artifact-1",
  revision: 4,
  templateDraft: {
    kind: "whatsapp_template",
    name: "spring_offer",
    language: "en",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Hi {{1}}, spring prices are here." }],
  },
};

const ACTIVE_FLOW_CONFIG: WhatsAppFlowConfig = {
  templateId: "lead_generation",
  ctaText: "Open",
  bodyText: "Tell us about your visit.",
  flowUiLocale: "en",
  metaFlowId: "meta-flow-1",
  metaFlowName: "visit_form",
  screenRoutes: { CONTACT: ["DETAILS"] },
  screens: [
    {
      id: "CONTACT",
      title: "Contact",
      fields: [
        { id: "name", label: "Name", fieldType: "TextInput", required: true },
      ],
    },
    {
      id: "DETAILS",
      title: "Details",
      fields: [{ id: "notes", label: "Notes", fieldType: "TextArea" }],
    },
  ],
};

const ACTIVE_FLOW: ActiveAiriBuilderInput = {
  kind: "whatsapp_flow",
  artifactId: "flow-artifact-1",
  revision: 2,
  flowConfig: ACTIVE_FLOW_CONFIG,
};

function buildContext(
  overrides: {
    activeBuilder?: ActiveAiriBuilderInput | null;
    airiLanguage?: AiriLanguage;
  } = {}
): AiriTurnContext {
  const progress = createProgressRecorder();
  const base = {
    airiLanguage: overrides.airiLanguage ?? ("en" as AiriLanguage),
    selectedContext: null,
    selectedSourceLabels: [],
    resourceItems: [],
    sourceContext: {
      sourceIds: [],
      conversationSourceIds: [],
      kbSourceIds: [],
      retrievalPath: "none" as const,
    },
    searchResult: { conversations: [], kbArticles: [] },
    pendingActions: [],
    traceId: "trace-1",
    progress,
    startedAt: Date.now(),
  };
  return {
    ...base,
    params: {
      workspaceId: "workspace-1",
      userId: "user-1",
      threadId: "thread-1",
      userMessageId: "user-message-1",
      userMessage: "Draft it",
    },
    deadline: createAiriTurnDeadline(),
    activeBuilder: overrides.activeBuilder ?? null,
    historyContext: "",
    kbContext: "",
    conversationContext: "",
    attachedSourceContext: "No attached sources.",
    attachedFileContext: "No attached files.",
    getToolAccess: async () => TOOL_ACCESS,
    recoverFromGeneratorFailure: createAiriTurnStepRecovery(base),
  } as unknown as AiriTurnContext;
}

function modelAnswer(value: unknown, finishReason = "end_turn") {
  return {
    content: typeof value === "string" ? value : JSON.stringify(value),
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    latencyMs: 120,
    finishReason,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

const VALID_TEMPLATE = {
  name: "spring_offer",
  language: "en",
  category: "MARKETING",
  components: [
    { type: "BODY", text: "Hi {{1}}, our spring menu is ready." },
    {
      type: "BUTTONS",
      buttons: [{ type: "QUICK_REPLY", text: "Show me" }],
    },
  ],
  rationale: "Seasonal re-engagement.",
  missingDetails: [],
};

const VALID_SCAN = {
  title: "Booking leaks",
  summary: "Customers ask about prices and never book.",
  opportunities: [
    {
      id: "price-follow-up",
      title: "Follow up price questions",
      priority: "high",
      problem: "Price questions go unanswered after hours.",
      customerSignal: "12 chats asked for prices last week.",
      recommendedAction: "Send a price list template with a booking button.",
      evidence: ["12 price questions without a booking."],
      recommendedArtifacts: ["whatsapp_template", "scenario"],
      missingInputs: [],
    },
  ],
  nextAction: "Draft the price list template.",
};

const VALID_PACKAGE = {
  title: "Spring win-back",
  goal: "Book 20 returning clients in April.",
  audience: "Clients without a visit in 90 days",
  angle: "Seasonal menu with one reply action",
  evidence: ["Returning clients ask about the spring menu."],
  steps: [
    {
      id: "whatsapp-template",
      kind: "whatsapp_template",
      title: "Draft WhatsApp template",
      description: "A seasonal re-engagement template.",
      status: "ready",
      tool: "whatsapp",
      blockers: [],
    },
  ],
  checks: [
    {
      label: "WhatsApp policy",
      status: "pending",
      detail: "Review before submit",
    },
  ],
  nextAction: "Review the template.",
};

function lastCall(): Record<string, unknown> {
  const calls = mockChatCompletionWithFallback.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

function expectDegraded(
  metadata: Record<string, unknown>,
  kind: string,
  reason: string
) {
  expect(metadata).toEqual(
    expect.objectContaining({
      fallbackUsed: true,
      errorCode: "artifact_validation_failed",
      draftFallback: { kind, reason },
    })
  );
  expect(metadata).not.toHaveProperty("airiBuilderPatch");
  expect(metadata).not.toHaveProperty("airiArtifact");
  expect(metadata).not.toHaveProperty("whatsappTemplateDraft");
  expect(isAiriChatReplyFailed(metadata)).toBe(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateAiriArtifact.mockImplementation(
    async (params: { kind: string }) => ({
      id: `${params.kind}-artifact-new`,
      kind: params.kind,
      revision: 0,
      status: "draft",
      validation: { status: "valid", issues: [] },
    })
  );
  mockUpdateAiriArtifact.mockImplementation(
    async (params: { artifactId: string; baseRevision: number }) => ({
      id: params.artifactId,
      kind: params.artifactId.startsWith("flow")
        ? "whatsapp_flow"
        : "whatsapp_template",
      revision: params.baseRevision + 1,
      status: "draft",
      validation: { status: "valid", issues: [] },
    })
  );
});

describe("WhatsApp template drafts", () => {
  it("asks for structured output and saves a valid draft", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer(VALID_TEMPLATE)
    );

    const reply = await handleWhatsAppTemplateTurn(buildContext());

    expect(lastCall()).toEqual(
      expect.objectContaining({
        responseFormat: { type: "json_object" },
        generationConfig: {
          responseSchema: AIRI_TEMPLATE_DRAFT_RESPONSE_SCHEMA,
        },
      })
    );
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "whatsapp_template",
        snapshot: {
          templateDraft: expect.objectContaining({
            name: "spring_offer",
            components: expect.arrayContaining([
              expect.objectContaining({
                type: "BODY",
                text: "Hi {{1}}, our spring menu is ready.",
              }),
            ]),
          }),
        },
      })
    );
    expect(reply.metadata).toEqual(
      expect.objectContaining({
        whatsappTemplateDraft: expect.objectContaining({
          name: "spring_offer",
        }),
        airiBuilderPatch: expect.objectContaining({
          kind: "whatsapp_template",
        }),
        airiArtifact: expect.objectContaining({
          id: "whatsapp_template-artifact-new",
        }),
      })
    );
    expect(reply.metadata).not.toHaveProperty("fallbackUsed");
    expect(isAiriChatReplyFailed(reply.metadata)).toBe(false);
  });

  it("keeps the open template when the answer has no body (no canned body is saved)", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer({
        ...VALID_TEMPLATE,
        components: [
          { type: "FOOTER", text: "Reply STOP to opt out" },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
        ],
      })
    );
    const context = buildContext({ activeBuilder: ACTIVE_TEMPLATE });

    const reply = await handleWhatsAppTemplateTurn(context);

    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expect(mockUpdateAiriArtifact).not.toHaveBeenCalled();
    expectDegraded(reply.metadata, "whatsapp_template", "invalid");
    expect(reply.content).toBe(
      AIRI_DRAFT_FALLBACK_MESSAGES.whatsapp_template.kept?.en
    );
    expect(reply.content).not.toMatch(/thanks for your interest/i);
    expect(context.progress.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "template_draft", status: "error" }),
      ])
    );
    expect(reply.metadata).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      })
    );
  });

  it("never repairs a truncated answer into a partial draft", async () => {
    const partial = JSON.stringify(VALID_TEMPLATE).slice(0, 120);
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer(`${partial}"}]}`, "max_tokens")
    );

    const reply = await handleWhatsAppTemplateTurn(buildContext());

    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expectDegraded(reply.metadata, "whatsapp_template", "truncated");
    expect(reply.content).toBe(
      AIRI_DRAFT_FALLBACK_MESSAGES.whatsapp_template.created.en
    );
  });

  function activeTemplateWithHeader(
    format: "IMAGE" | "VIDEO",
    handle: string
  ): ActiveAiriBuilderInput {
    return {
      ...ACTIVE_TEMPLATE,
      templateDraft: {
        ...(ACTIVE_TEMPLATE.kind === "whatsapp_template"
          ? ACTIVE_TEMPLATE.templateDraft
          : ({} as never)),
        components: [
          { type: "HEADER", format, example: { header_handle: [handle] } },
          { type: "BODY", text: "Hi {{1}}, spring prices are here." },
        ],
      },
    };
  }

  /** What the draft schema allows for a body-only edit: no header handle. */
  function bodyEditAnswer(headerFormat: string) {
    return modelAnswer({
      ...VALID_TEMPLATE,
      components: [
        { type: "HEADER", format: headerFormat },
        { type: "BODY", text: "Hi {{1}}, spring prices." },
      ],
    });
  }

  function savedHeader(reply: { metadata: Record<string, unknown> }) {
    const draft = reply.metadata.whatsappTemplateDraft as {
      components: Array<Record<string, unknown>>;
    };
    const patch = reply.metadata.airiBuilderPatch as {
      snapshot: { templateDraft: { components: Array<{ type: string }> } };
    };
    expect(
      patch.snapshot.templateDraft.components.find(c => c.type === "HEADER")
    ).toEqual(draft.components.find(c => c.type === "HEADER"));
    return draft.components.find(component => component.type === "HEADER");
  }

  it.each(["IMAGE", "VIDEO"] as const)(
    "keeps an open template's %s header media through an edit",
    async format => {
      const handle = "airi://creative-assets/user-upload-1";
      mockChatCompletionWithFallback.mockResolvedValueOnce(
        bodyEditAnswer(format)
      );

      const reply = await handleWhatsAppTemplateTurn(
        buildContext({
          activeBuilder: activeTemplateWithHeader(format, handle),
        })
      );

      expect(savedHeader(reply)).toEqual({
        type: "HEADER",
        format,
        example: { header_handle: [handle] },
      });
      expect(mockUpdateAiriArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: {
            templateDraft: expect.objectContaining({
              components: expect.arrayContaining([
                expect.objectContaining({
                  type: "HEADER",
                  example: { header_handle: [handle] },
                }),
              ]),
            }),
          },
        })
      );
      // No paid regeneration of the user's header image.
      expect(createQueuedAiriImageGeneration).not.toHaveBeenCalled();
    }
  );

  it("carries no media handle into a header whose format changed", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      bodyEditAnswer("IMAGE")
    );

    const reply = await handleWhatsAppTemplateTurn(
      buildContext({
        activeBuilder: activeTemplateWithHeader(
          "VIDEO",
          "airi://creative-assets/video-1"
        ),
      })
    );

    expect(savedHeader(reply)).not.toHaveProperty("example");
    // The new IMAGE header still gets its generated image.
    expect(createQueuedAiriImageGeneration).toHaveBeenCalledTimes(1);
  });

  it.each(["ru", "kz"] as const)(
    "answers a degraded template turn in %s",
    async language => {
      mockChatCompletionWithFallback.mockResolvedValueOnce(
        modelAnswer("I cannot produce JSON for this.")
      );

      const reply = await handleWhatsAppTemplateTurn(
        buildContext({
          activeBuilder: ACTIVE_TEMPLATE,
          airiLanguage: language,
        })
      );

      expectDegraded(reply.metadata, "whatsapp_template", "unparseable");
      expect(reply.content).toBe(
        AIRI_DRAFT_FALLBACK_MESSAGES.whatsapp_template.kept?.[language]
      );
      expect(reply.content).toMatch(/[А-Яа-яӘәҒғҚқҢңӨөҰұҮүҺһІі]/);
    }
  );
});

describe("WhatsApp Flow drafts", () => {
  it("saves an edit and keeps what the schema cannot express", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer({
        templateId: "lead_generation",
        ctaText: "Book a visit",
        bodyText: "Tell us about your visit.",
        flowUiLocale: "en",
        screens: [
          {
            id: "CONTACT",
            title: "Your contact",
            fields: [
              {
                id: "name",
                label: "Full name",
                fieldType: "TextInput",
                required: true,
              },
            ],
          },
          {
            id: "DETAILS",
            title: "Details",
            fields: [
              {
                id: "notes",
                label: "Notes",
                fieldType: "TextArea",
                required: false,
              },
            ],
          },
        ],
      })
    );

    const reply = await handleWhatsAppFlowTurn(
      buildContext({ activeBuilder: ACTIVE_FLOW })
    );

    expect(lastCall()).toEqual(
      expect.objectContaining({
        responseFormat: { type: "json_object" },
        generationConfig: { responseSchema: AIRI_FLOW_DRAFT_RESPONSE_SCHEMA },
      })
    );
    expect(mockUpdateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "flow-artifact-1",
        baseRevision: 2,
        snapshot: {
          flowConfig: expect.objectContaining({
            ctaText: "Book a visit",
            metaFlowId: "meta-flow-1",
            metaFlowName: "visit_form",
            screenRoutes: { CONTACT: ["DETAILS"] },
            screens: [
              expect.objectContaining({ id: "CONTACT", title: "Your contact" }),
              expect.objectContaining({ id: "DETAILS" }),
            ],
          }),
        },
      })
    );
    expect(reply.metadata).not.toHaveProperty("fallbackUsed");
    expect(reply.metadata.airiBuilderPatch).toEqual(
      expect.objectContaining({ kind: "whatsapp_flow", baseRevision: 2 })
    );
  });

  it("keeps the open Flow unchanged when the answer is not JSON", async () => {
    // Before structured outputs this saved the unchanged open Flow as a new
    // revision and reported it as an update.
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer("Here is your Flow: two screens, contact and details.")
    );

    const reply = await handleWhatsAppFlowTurn(
      buildContext({ activeBuilder: ACTIVE_FLOW })
    );

    expect(mockUpdateAiriArtifact).not.toHaveBeenCalled();
    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expectDegraded(reply.metadata, "whatsapp_flow", "unparseable");
    expect(reply.content).toBe(
      AIRI_DRAFT_FALLBACK_MESSAGES.whatsapp_flow.kept?.en
    );
  });

  it("creates no canned lead form when the answer has no usable screens", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer({
        templateId: "lead_generation",
        ctaText: "Open",
        bodyText: "Fill this in.",
        flowUiLocale: "ru",
        screens: [],
      })
    );

    const reply = await handleWhatsAppFlowTurn(
      buildContext({ airiLanguage: "ru" })
    );

    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expectDegraded(reply.metadata, "whatsapp_flow", "invalid");
    expect(reply.content).toBe(
      AIRI_DRAFT_FALLBACK_MESSAGES.whatsapp_flow.created.ru
    );
  });
});

describe("Opportunity scans", () => {
  it("saves a valid scan and answers in the workspace language", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer(VALID_SCAN)
    );

    const reply = await handleOpportunityScanTurn(
      buildContext({ airiLanguage: "ru" })
    );

    expect(lastCall()).toEqual(
      expect.objectContaining({
        generationConfig: {
          responseSchema: AIRI_OPPORTUNITY_SCAN_RESPONSE_SCHEMA,
        },
      })
    );
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "opportunity_scan",
        snapshot: {
          opportunityScan: expect.objectContaining({ title: "Booking leaks" }),
        },
      })
    );
    expect(reply.metadata).not.toHaveProperty("fallbackUsed");
    // The ru reply used to be English.
    expect(reply.content).toContain("Я подготовила **Booking leaks**");
  });

  it("saves no canned scan when the answer fails the validator", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer({
        ...VALID_SCAN,
        opportunities: [{ ...VALID_SCAN.opportunities[0], evidence: [] }],
      })
    );

    const reply = await handleOpportunityScanTurn(
      buildContext({ airiLanguage: "kz" })
    );

    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expectDegraded(reply.metadata, "opportunity_scan", "invalid");
    expect(reply.metadata).not.toHaveProperty("airiOpportunityScan");
    expect(reply.content).toBe(
      AIRI_DRAFT_FALLBACK_MESSAGES.opportunity_scan.created.kz
    );
  });
});

describe("Campaign packages", () => {
  it("saves no canned package when the package answer is invalid", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce(
      modelAnswer({ ...VALID_PACKAGE, steps: [] })
    );

    const reply = await handleMarketingCampaignTurn(buildContext());

    expect(lastCall()).toEqual(
      expect.objectContaining({
        generationConfig: {
          responseSchema: AIRI_CAMPAIGN_PACKAGE_RESPONSE_SCHEMA,
        },
      })
    );
    // No template call follows a package that was not made.
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
    expect(mockCreateAiriArtifact).not.toHaveBeenCalled();
    expectDegraded(reply.metadata, "campaign_package", "invalid");
    expect(reply.metadata).not.toHaveProperty("airiCampaignPackage");
  });

  it("keeps a valid package when its template answer is not a valid draft", async () => {
    mockChatCompletionWithFallback
      .mockResolvedValueOnce(modelAnswer(VALID_PACKAGE))
      .mockResolvedValueOnce(
        modelAnswer({ ...VALID_TEMPLATE, components: [] })
      );

    const reply = await handleMarketingCampaignTurn(
      buildContext({ airiLanguage: "kz" })
    );

    expect(mockCreateAiriArtifact).toHaveBeenCalledTimes(1);
    expect(mockCreateAiriArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "marketing_campaign",
        snapshot: expect.objectContaining({
          campaignPackage: expect.objectContaining({
            title: "Spring win-back",
            tools: TOOL_ACCESS,
          }),
        }),
      })
    );
    expect(reply.metadata).toEqual(
      expect.objectContaining({
        airiCampaignTemplateDraftFailure: expect.objectContaining({
          errorClass: "artifact_validation_failed",
        }),
      })
    );
    expect(reply.metadata).not.toHaveProperty("whatsappTemplateDraft");
    expect(reply.metadata).not.toHaveProperty("fallbackUsed");
    expect(reply.content).toContain("Spring win-back");
    expect(reply.content).toContain("үлгісін жасау мүмкін болмады");
  });
});
