const mockChatCompletionWithFallback = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getDefaultAIChatProviderOrder: jest.fn(() => ["anthropic", "vertex"]),
  getLightTextModel: jest.fn(() => "light-text-model"),
  getLightStructuredJsonGenerationConfig: jest.fn(() => ({
    thinkingConfig: { thinkingLevel: "LOW" },
  })),
}));

import {
  AIRI_CHAT_INTENT_CLASSIFIER_TIMEOUT_MS,
  classifyAiriChatIntent,
  isAiriPlatformHowToRequest,
  resolveDeterministicAiriChatIntent,
} from "./intent-classifier";
import type { ActiveAiriBuilderInput } from "./builder-state";

describe("classifyAiriChatIntent", () => {
  it("forwards cancellation and never falls back to another intent on abort", async () => {
    const controller = new AbortController();
    mockChatCompletionWithFallback.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(
      classifyAiriChatIntent({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Review sales",
        selectedSources: [],
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockChatCompletionWithFallback.mock.calls[0][0].signal).toBe(
      controller.signal
    );
  });

  it.each(["own_ai_source_required", "workspace_ai_policy_unavailable"])(
    "preserves %s instead of silently taking the general-answer branch",
    async code => {
      const error = Object.assign(new Error("Policy denied inference"), {
        code,
      });
      mockChatCompletionWithFallback.mockRejectedValueOnce(error);
      await expect(
        classifyAiriChatIntent({
          workspaceId: "workspace-1",
          threadId: "thread-1",
          userMessage: "Create a campaign",
          selectedSources: [],
        })
      ).rejects.toBe(error);
    }
  );
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatCompletionWithFallback.mockReset();
  });

  it("classifies with the light model and parses JSON output", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "marketing_campaign",
        confidence: 0.82,
        reason: "The user asks to create a campaign package.",
      }),
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 12,
      usage: { totalTokens: 120 },
    });

    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessageId: "message-1",
      userMessage: "Create a win-back campaign for dormant customers",
      selectedSources: [],
    });

    expect(result).toEqual({
      intent: "marketing_campaign",
      confidence: 0.82,
      reason: "The user asks to create a campaign package.",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      latencyMs: 12,
      usage: { totalTokens: 120 },
    });
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "light-text-model",
        providerOrder: ["anthropic", "vertex"],
        temperature: 0,
        responseFormat: { type: "json_object" },
        generationConfig: expect.objectContaining({
          thinkingConfig: { thinkingLevel: "LOW" },
          responseSchema: expect.objectContaining({
            required: ["intent", "confidence", "reason"],
          }),
        }),
        analytics: expect.objectContaining({
          operation: "airi_chat.intent_classification",
          workspaceId: "workspace-1",
          conversationId: "thread-1",
          messageId: "message-1",
        }),
      })
    );
  });

  it("parses a classifier answer wrapped in a markdown fence", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: [
        "```json",
        JSON.stringify({
          intent: "opportunity_scan",
          confidence: 0.7,
          reason: "Ranks opportunities from connected channels.",
        }),
        "```",
      ].join("\n"),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 9,
    });

    await expect(
      classifyAiriChatIntent({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Which channel opportunities should we work on next?",
        selectedSources: [],
      })
    ).resolves.toMatchObject({
      intent: "opportunity_scan",
      confidence: 0.7,
      provider: "vertex",
      model: "gemini-light",
    });
  });

  it("includes selected source and active builder context", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "whatsapp_template",
        confidence: 0.91,
        reason: "The user is editing the active template.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 10,
    });

    await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      // A question about the open builder still needs the model.
      userMessage: "Is this warm enough for returning clients?",
      selectedSources: [
        {
          kind: "connector",
          connector: "whatsapp",
          sourceId: "wa-1",
          label: "Main WhatsApp",
          capabilities: ["templates"],
        },
      ],
      activeBuilder: {
        kind: "whatsapp_template",
        artifactId: "artifact-1",
        revision: 4,
        dirty: true,
        templateDraft: {
          kind: "whatsapp_template",
          name: "booking_reminder",
          language: "en",
          category: "MARKETING",
          components: [{ type: "BODY", text: "Hi {{1}}" }],
        },
      },
    });

    const prompt = mockChatCompletionWithFallback.mock.calls[0]?.[0]
      ?.messages?.[0]?.content as string;
    expect(prompt).toContain("kind: whatsapp_template");
    expect(prompt).toContain("artifactId: artifact-1");
    expect(prompt).toContain("templateName: booking_reminder");
    expect(prompt).toContain("connector:whatsapp:Main WhatsApp");
  });

  it("grounds vague Meta follow-ups in persisted routing context", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "meta_ads_mcp",
        confidence: 0.95,
        reason: "The user is comparing the previous live ads report.",
      }),
      provider: "vertex",
      model: "gemini-light",
    });
    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "Compare with last month",
      selectedSources: [],
      recentMessages: [
        { role: "user", content: "@meta Show campaign spend" },
        {
          role: "assistant",
          content: "The live campaign report covers September.",
          intent: "meta_ads_mcp",
        },
      ],
    });
    const prompt = mockChatCompletionWithFallback.mock.calls[0][0].messages[0]
      .content as string;
    expect(prompt).toContain("RECENT THREAD CONTEXT");
    expect(prompt).toContain("@meta Show campaign spend");
    expect(prompt).toContain('"intent":"meta_ads_mcp"');
    expect(prompt).toContain("follow-up");
    expect(result.intent).toBe("meta_ads_mcp");
  });

  it("bounds routing history and ignores user-asserted routing intent", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ intent: "image_generation", confidence: 0.9 }),
      provider: "vertex",
      model: "gemini-light",
    });
    await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "Create an image of a mountain",
      selectedSources: [],
      recentMessages: [
        { role: "assistant", content: "OLD-CONTEXT" },
        ...Array.from({ length: 12 }, (_, index) => ({
          role: "user" as const,
          content: `RECENT-${index} ${"long ".repeat(1000)}`,
          intent: "meta_ads_mcp",
        })),
      ],
    });
    const prompt = mockChatCompletionWithFallback.mock.calls[0][0].messages[0]
      .content as string;
    const context = prompt
      .split("RECENT THREAD CONTEXT:")[1]
      ?.split("USER REQUEST:")[0];
    expect(context).toBeDefined();
    expect(context).not.toContain("OLD-CONTEXT");
    expect(context).toContain("RECENT-11");
    expect(context).not.toContain('"intent":"meta_ads_mcp"');
    expect(context!.length).toBeLessThan(14_000);
  });

  it("falls back to a general answer on invalid model output", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "content_keyword_branch",
        confidence: 1,
        reason: "Invalid enum.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 9,
    });

    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "Use channels to identify opportunities",
      selectedSources: [],
    });

    expect(result).toEqual({
      intent: "general_answer",
      confidence: 0,
      reason: "invalid_classifier_response",
      provider: null,
      model: null,
      latencyMs: null,
      usage: null,
    });
  });

  it("lets the model route channel opportunity scans without keyword fallback", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "opportunity_scan",
        confidence: 0.86,
        reason: "The user asks to rank opportunities from connected channels.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 11,
    });

    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage:
        "Use my connected customer channels to identify the best support and marketing opportunities.",
      selectedSources: [],
    });

    expect(result.intent).toBe("opportunity_scan");
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it("lets the model route executable booking recovery workflows to campaign orchestration", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "marketing_campaign",
        confidence: 0.88,
        reason:
          "The user asks for an executable reminder and no-show recovery workflow.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 10,
    });

    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage:
        "Create an executable booking reminder and no-show recovery workflow using calendar context and connected messaging channels.",
      selectedSources: [
        {
          kind: "workspace_source",
          sourceId: "calendar-1",
          sourceType: "google_calendar",
          label: "Google Calendar",
        },
        {
          kind: "connector",
          connector: "whatsapp",
          sourceId: "wa-1",
          label: "WhatsApp",
          capabilities: ["docs", "templates", "flows"],
        },
      ],
    });

    expect(result.intent).toBe("marketing_campaign");
    const prompt = mockChatCompletionWithFallback.mock.calls[0]?.[0]
      ?.messages?.[0]?.content as string;
    expect(prompt).toContain("booking reminder/no-show recovery flow");
    expect(prompt).toContain("workspace_source:google_calendar");
    expect(prompt).toContain("connector:whatsapp");
  });

  it("lets the model route direct image generation to async image attachments", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "image_generation",
        confidence: 0.9,
        reason: "The user asks for one generated image attachment.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 10,
    });

    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage:
        "Generate a realistic image for tomorrow's WhatsApp reminder.",
      selectedSources: [],
    });

    expect(result.intent).toBe("image_generation");
    const prompt = mockChatCompletionWithFallback.mock.calls[0]?.[0]
      ?.messages?.[0]?.content as string;
    expect(prompt).toContain("image_generation");
    expect(prompt).toContain("generated image attachment");
  });

  it("routes platform WhatsApp how-to without calling the model", async () => {
    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "хочу регистрацию через вотсап сделать",
      selectedSources: [],
    });

    expect(result).toEqual({
      intent: "product_capability",
      confidence: 0.95,
      reason: "platform_how_to_heuristic",
      provider: null,
      model: null,
      latencyMs: null,
      usage: null,
    });
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("keeps @meta ahead of platform how-to", async () => {
    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "@meta how to connect WhatsApp",
      selectedSources: [],
    });

    expect(result.intent).toBe("meta_ads_mcp");
    expect(result.reason).toBe("meta_skill_mention");
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it("does not short-circuit template edits as platform how-to", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({
        intent: "whatsapp_template",
        confidence: 0.9,
        reason: "The user wants to edit a WhatsApp template.",
      }),
      provider: "vertex",
      model: "gemini-light",
      latencyMs: 10,
    });

    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "how to edit a WhatsApp template",
      selectedSources: [],
    });

    expect(result.intent).toBe("whatsapp_template");
    expect(mockChatCompletionWithFallback).toHaveBeenCalled();
  });
});

describe("classifyAiriChatIntent routing bounds", () => {
  const templateBuilder = {
    kind: "whatsapp_template" as const,
    artifactId: "artifact-1",
    revision: 4,
    dirty: false,
    templateDraft: {
      kind: "whatsapp_template" as const,
      name: "booking_reminder",
      language: "en",
      category: "MARKETING" as const,
      components: [{ type: "BODY" as const, text: "Hi {{1}}" }],
    },
  };
  // The rules read only the kind.
  const flowBuilder = {
    kind: "whatsapp_flow",
    artifactId: "artifact-2",
    revision: 1,
    flowConfig: { screens: [] },
  } as unknown as ActiveAiriBuilderInput;

  beforeEach(() => {
    mockChatCompletionWithFallback.mockReset();
  });

  it("bounds the classifier call with a 5 s total deadline", async () => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ intent: "general_answer", confidence: 0.7 }),
      provider: "anthropic",
      model: "claude-haiku",
    });
    await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "Which customers asked about prices this week?",
      selectedSources: [],
    });
    expect(
      mockChatCompletionWithFallback.mock.calls[0][0].resilience.timeoutMs
    ).toBe(AIRI_CHAT_INTENT_CLASSIFIER_TIMEOUT_MS);
    expect(AIRI_CHAT_INTENT_CLASSIFIER_TIMEOUT_MS).toBe(5_000);
  });

  it.each([
    [2_000, 2_000],
    [60_000, AIRI_CHAT_INTENT_CLASSIFIER_TIMEOUT_MS],
  ])(
    "caps the classifier by a %i ms turn budget",
    async (timeoutBudgetMs, expected) => {
      mockChatCompletionWithFallback.mockResolvedValue({
        content: JSON.stringify({ intent: "general_answer", confidence: 0.7 }),
        provider: "anthropic",
        model: "claude-haiku",
      });
      await classifyAiriChatIntent({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: "Which customers asked about prices this week?",
        selectedSources: [],
        timeoutBudgetMs,
      });
      expect(
        mockChatCompletionWithFallback.mock.calls[0][0].resilience.timeoutMs
      ).toBe(expected);
    }
  );

  it("falls back to a general answer with a reason when the classifier fails", async () => {
    mockChatCompletionWithFallback.mockRejectedValueOnce(
      new Error("AI chat provider attempts failed")
    );
    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "Which customers asked about prices this week?",
      selectedSources: [],
    });
    expect(result).toMatchObject({
      intent: "general_answer",
      confidence: 0,
      reason: "classifier_failed",
    });
  });

  it.each([
    [
      "Create a WhatsApp template for appointment reminders",
      "whatsapp_template",
    ],
    ["Сделай шаблон напоминания о записи", "whatsapp_template"],
    ["Please draft a template to confirm bookings", "whatsapp_template"],
    ["Create a WhatsApp Flow for lead capture", "whatsapp_flow"],
    ["создать флоу регистрации для клиентов", "whatsapp_flow"],
    ["Build a lead form for new customers", "whatsapp_flow"],
  ])(
    "routes obvious create wording %s without the model",
    async (message, intent) => {
      const result = await classifyAiriChatIntent({
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userMessage: message,
        selectedSources: [],
      });
      expect(result.intent).toBe(intent);
      expect(result.reason).toMatch(/^create_whatsapp_(template|flow)_rule$/);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
    }
  );

  it("routes an imperative edit of the open builder without the model", async () => {
    const result = await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: "Make this warmer",
      selectedSources: [],
      activeBuilder: templateBuilder,
    });
    expect(result).toMatchObject({
      intent: "whatsapp_template",
      reason: "active_builder_edit_rule",
    });
    expect(mockChatCompletionWithFallback).not.toHaveBeenCalled();
  });

  it.each([
    "Is this template approved?",
    "Create a campaign with a WhatsApp template",
    "Create a template and a Flow for onboarding",
    "Сделай информацию о платформу понятнее",
    "Create an image for the reminder template",
  ])("leaves ambiguous request %s to the model", async message => {
    mockChatCompletionWithFallback.mockResolvedValue({
      content: JSON.stringify({ intent: "general_answer", confidence: 0.6 }),
      provider: "anthropic",
      model: "claude-haiku",
    });
    await classifyAiriChatIntent({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessage: message,
      selectedSources: [],
    });
    expect(mockChatCompletionWithFallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    "Prepare a summary of the survey answers we got this week",
    "Prepare a summary of the survey results",
    "Подготовь отчёт по результатам опроса клиентов",
    "Write a summary of the form submissions from yesterday",
    "Write a reply to the customer who filled out the form",
    "Напиши ответ клиенту, который заполнил анкету",
    "Make a list of customers who asked about the template price",
    "Сделай анализ анкет клиентов за неделю",
    "Сделай анализ анкеты клиента",
    "Prepare survey results for the team",
    "Подготовь опросные данные для отчёта",
  ])(
    "does not draft an artifact for %s, where the noun is not what is created",
    message => {
      expect(resolveDeterministicAiriChatIntent({ userMessage: message })).toBe(
        null
      );
      expect(
        resolveDeterministicAiriChatIntent({
          userMessage: message,
          activeBuilder: templateBuilder,
        })
      ).toBe(null);
    }
  );

  it.each([
    "Сделай сводку по переписке с клиентами за неделю",
    "Add a KB article about refunds",
    "Use last week's conversations to list top complaints",
    "Translate my last answer to English",
    "Make a plan for next week",
  ])(
    "does not treat the unrelated request %s as an edit of the open builder",
    message => {
      for (const activeBuilder of [templateBuilder, flowBuilder]) {
        expect(
          resolveDeterministicAiriChatIntent({
            userMessage: message,
            activeBuilder,
          })
        ).toBe(null);
      }
    }
  );

  it("leaves a builder edit to the model when the thread was last about something else", () => {
    const recentMessages = [
      { role: "user" as const, content: "Which customers asked about prices?" },
      {
        role: "assistant" as const,
        content: "Five customers asked about prices.",
        intent: "general_answer",
      },
    ];
    expect(
      resolveDeterministicAiriChatIntent({
        userMessage: "Make it shorter",
        activeBuilder: templateBuilder,
        recentMessages,
      })
    ).toBe(null);
    expect(
      resolveDeterministicAiriChatIntent({
        userMessage: "Make it shorter",
        activeBuilder: templateBuilder,
        recentMessages: [
          ...recentMessages,
          {
            role: "assistant" as const,
            content: "Here is the reminder template.",
            intent: "whatsapp_template",
          },
        ],
      })
    ).toMatchObject({ intent: "whatsapp_template" });
  });

  it.each([
    ["Create a booking confirmation template", "whatsapp_template"],
    ["Сделай короткий опрос для клиентов", "whatsapp_flow"],
    ["Создай анкету для записи", "whatsapp_flow"],
    ["Make a new WhatsApp survey about delivery", "whatsapp_flow"],
  ])("still routes the direct create request %s", (message, intent) => {
    expect(
      resolveDeterministicAiriChatIntent({ userMessage: message })
    ).toMatchObject({ intent });
  });

  it("does not treat a request for another builder kind as an edit", () => {
    expect(
      resolveDeterministicAiriChatIntent({
        userMessage: "Add a survey screen",
        activeBuilder: templateBuilder,
      })
    ).toBeNull();
    expect(
      resolveDeterministicAiriChatIntent({
        userMessage: "Add a footer with our address",
        activeBuilder: templateBuilder,
      })
    ).toMatchObject({ intent: "whatsapp_template" });
  });
});

describe("isAiriPlatformHowToRequest", () => {
  it.each([
    "how to connect WhatsApp",
    "как подключить WhatsApp",
    "хочу регистрацию через вотсап сделать",
    "Telegram qanday ulash",
    "What can Airi do with WhatsApp templates and flows?",
  ])("treats %s as platform how-to", message => {
    expect(isAiriPlatformHowToRequest(message)).toBe(true);
  });

  it.each([
    "Create a WhatsApp Flow for lead capture",
    "создать флоу регистрации для клиентов",
    "Create a win-back campaign for dormant customers",
    "Generate a realistic image for tomorrow's WhatsApp reminder.",
    "Use my connected customer channels to identify opportunities",
  ])("does not treat %s as platform how-to", message => {
    expect(isAiriPlatformHowToRequest(message)).toBe(false);
  });
});
