jest.mock("@/lib/ai", () => {
  // The real error and classifier; only the model tier is stubbed.
  const providerErrors = jest.requireActual<
    typeof import("@/lib/ai/provider-errors")
  >("@/lib/ai/provider-errors");
  return {
    AIChatProviderAggregateError: providerErrors.AIChatProviderAggregateError,
    isRetryableAIProviderError: providerErrors.isRetryableAIProviderError,
    getHeavyTextModel: () => "heavy-text-model",
  };
});

import { AIChatProviderAggregateError } from "@/lib/ai";
import type { TextModelProvider } from "@/lib/ai/text-models";
import type { AiriChatRunEvent } from "@/lib/airi-chats/run-events";
import { AiriTurnDeadlineExceededError } from "./deadline";
import {
  AIRI_TURN_LOCALIZED_FAILURE_CODES,
  AiriTurnError,
  buildAiriChatFailureReply,
  createAiriTurnStepRecovery,
  getAiriTurnFailureMessage,
  mapAiriTurnFailure,
} from "./failure";
import { createProgressRecorder } from "./progress";

function providerFailure(
  provider: TextModelProvider,
  retryable: boolean,
  httpStatus: number
) {
  return {
    provider,
    model: `${provider}-model`,
    attempt: 1,
    fallbackIndex: provider === "anthropic" ? 0 : 1,
    retryable,
    finishReason: null,
    promptBlockReason: null,
    httpStatus,
  };
}

const overloaded = () =>
  new AIChatProviderAggregateError([
    providerFailure("anthropic", true, 529),
    providerFailure("vertex", true, 429),
  ]);
const rejected = () =>
  new AIChatProviderAggregateError([providerFailure("anthropic", false, 400)]);
const sourceRequired = () =>
  Object.assign(new Error("Connect an AI source"), {
    code: "own_ai_source_required",
  });

describe("mapAiriTurnFailure", () => {
  it("maps a retryable provider failure inside a step to the busy code", () => {
    expect(mapAiriTurnFailure(overloaded(), "step")).toEqual({
      code: "provider_resource_exhausted",
      retryable: true,
      diagnostics: {
        errorClass: "ai_chat_provider_failed",
        provider: "vertex",
        httpStatus: 429,
      },
    });
  });

  it("keeps the generic failure code at the turn boundary", () => {
    expect(mapAiriTurnFailure(overloaded(), "turn")).toMatchObject({
      code: "airi_generation_failed",
      retryable: false,
    });
  });

  it("never treats a provider rejection as retryable", () => {
    expect(mapAiriTurnFailure(rejected(), "step")).toMatchObject({
      code: "airi_generation_failed",
      retryable: false,
      diagnostics: { provider: "anthropic", httpStatus: 400 },
    });
  });

  it("maps a missing AI source to its own code", () => {
    expect(mapAiriTurnFailure(sourceRequired(), "turn").code).toBe(
      "own_ai_source_required"
    );
  });

  it.each([
    "meta_ads_requires_claude",
    "airi_run_cancelled",
    "airi_run_interrupted",
    "artifact_validation_failed",
  ] as const)("keeps the typed code %s from an AiriTurnError", code => {
    expect(mapAiriTurnFailure(new AiriTurnError(code), "step")).toMatchObject({
      code,
      retryable: false,
      diagnostics: { errorClass: code },
    });
  });

  it.each(["step", "turn"] as const)(
    "records a turn that ran out of time as a generation failure (%s)",
    at => {
      expect(
        mapAiriTurnFailure(new AiriTurnDeadlineExceededError(), at)
      ).toEqual({
        code: "airi_generation_failed",
        retryable: false,
        diagnostics: {
          errorClass: "airi_turn_deadline_exceeded",
          provider: null,
          httpStatus: null,
        },
      });
    }
  );
});

describe("getAiriTurnFailureMessage", () => {
  it.each([
    ["en", "Meta Ads answers need Claude"],
    ["ru", "Для ответов по Meta Ads нужен Claude"],
    ["kz", "Meta Ads бойынша жауап беру үшін Claude қажет"],
    ["uz", "Meta Ads answers need Claude"],
  ])("localizes the Claude-only Meta Ads failure (%s)", (language, text) => {
    expect(
      getAiriTurnFailureMessage({
        code: "meta_ads_requires_claude",
        language,
        workspaceId: "workspace-1",
      })
    ).toContain(text);
  });

  it("localizes the stopped and interrupted run notes", () => {
    const message = (
      code: "airi_run_cancelled" | "airi_run_interrupted",
      language: string
    ) => getAiriTurnFailureMessage({ code, language, workspaceId: "w" });
    expect(message("airi_run_cancelled", "en")).toBe("Stopped.");
    expect(message("airi_run_cancelled", "ru")).toBe("Остановлено.");
    expect(message("airi_run_cancelled", "kz")).toBe("Тоқтатылды.");
    expect(message("airi_run_interrupted", "ru")).toContain("прервался");
  });

  it("keeps the busy, generic and connect-a-source texts", () => {
    expect(
      getAiriTurnFailureMessage({
        code: "provider_resource_exhausted",
        workspaceId: "w",
      })
    ).toBe(
      "Airi is temporarily busy. Please try sending the request again in a minute."
    );
    expect(
      getAiriTurnFailureMessage({
        code: "airi_generation_failed",
        language: "ru",
        workspaceId: "w",
      })
    ).toMatch(/^I saved your request, but I could not finish the answer\./);
    expect(
      getAiriTurnFailureMessage({
        code: "own_ai_source_required",
        workspaceId: "workspace 1",
      })
    ).toContain(
      "/panel/w/workspace%201/settings/integrations?integration=google_ai"
    );
  });

  it("lists every code with localized text", () => {
    expect(Array.from(AIRI_TURN_LOCALIZED_FAILURE_CODES).sort()).toEqual([
      "airi_run_cancelled",
      "airi_run_interrupted",
      "artifact_validation_failed",
      "meta_ads_requires_claude",
      "provider_resource_exhausted",
    ]);
  });
});

describe("buildAiriChatFailureReply", () => {
  it("saves a typed failure with its code and localized text", () => {
    const reply = buildAiriChatFailureReply({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userMessageId: "message-1",
      startedAt: Date.now(),
      progress: createProgressRecorder(),
      error: new AiriTurnError("meta_ads_requires_claude"),
      language: "kz",
    });

    expect(reply.content).toContain("Claude қажет");
    expect(reply.metadata).toMatchObject({
      failed: true,
      errorCode: "meta_ads_requires_claude",
      errorClass: "meta_ads_requires_claude",
      traceId: "airi-chat:workspace-1:thread-1:message-1:failure",
    });
  });

  it("saves the generic failure for an untyped error", () => {
    const reply = buildAiriChatFailureReply({
      workspaceId: "workspace-1",
      threadId: "thread-1",
      startedAt: Date.now(),
      progress: createProgressRecorder(),
      error: overloaded(),
    });

    expect(reply.metadata).toMatchObject({
      failed: true,
      errorCode: "airi_generation_failed",
    });
    expect(reply.metadata.retryable).toBeUndefined();
  });
});

describe("createAiriTurnStepRecovery", () => {
  function prepare() {
    const events: AiriChatRunEvent[] = [];
    const progress = createProgressRecorder(async event => {
      events.push(event);
    });
    const recover = createAiriTurnStepRecovery({
      airiLanguage: "ru",
      selectedContext: null,
      selectedSourceLabels: [],
      resourceItems: [],
      sourceContext: {
        sourceIds: ["kb:1"],
        conversationSourceIds: [],
        kbSourceIds: ["kb:1"],
        retrievalPath: "kb",
      },
      searchResult: { conversations: [], kbArticles: [] },
      pendingActions: [],
      traceId: "trace-1",
      progress,
      startedAt: Date.now(),
    });
    return { events, recover };
  }

  it("answers a retryable step failure with the localized busy reply", async () => {
    const { events, recover } = prepare();

    const reply = await recover(overloaded(), {
      id: "generation",
      label: "Generating answer",
    });

    expect(reply.content).toContain("Airi");
    expect(reply.content).not.toContain("temporarily busy");
    expect(reply.metadata).toMatchObject({
      retryable: true,
      errorCode: "provider_resource_exhausted",
      provider: "vertex",
      model: "vertex-model",
      sourceIds: ["kb:1"],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "stage",
        id: "generation",
        status: "error",
        detail:
          "Provider unavailable: ai_chat_provider_failed (vertex HTTP 429)",
      })
    );
  });

  it("rethrows a non-retryable failure to the turn's failure reply", async () => {
    const { recover } = prepare();
    const error = rejected();

    await expect(
      recover(error, { id: "template_draft", label: "Drafting" })
    ).rejects.toBe(error);
  });

  it("rethrows cancellation and AI source errors unchanged", async () => {
    const { events, recover } = prepare();
    const abort = new DOMException("stopped", "AbortError");
    const required = sourceRequired();

    await expect(recover(abort, { id: "a", label: "A" })).rejects.toBe(abort);
    await expect(recover(required, { id: "b", label: "B" })).rejects.toBe(
      required
    );
    expect(events).toEqual([]);
  });
});
