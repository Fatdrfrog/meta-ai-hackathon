import assert from "node:assert/strict";
import test from "node:test";

import { GENERATIVE_AI_CUSTOMER_REQUEST_LABEL } from "@icecore/scenario-contracts";
import {
  composeGenerativeAIExecutionPrompt,
  findGenerativeAIPromptIssue,
  MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS,
  resolveGenerativeAIAutoReplyAction,
  resolveGenerativeAICustomerCopy,
  resolveGenerativeAIAutoReplyActionAfterContext,
  type ActiveGenerativeAIExecution,
  type GenerativeAIAutoReplyRuntime,
} from "./generative-ai-auto-reply";

test("localizes generic terminal failure feedback", () => {
  assert.equal(
    resolveGenerativeAICustomerCopy("en", "failure"),
    "We couldn't create a video this time. Please try again.",
  );
  assert.notEqual(
    resolveGenerativeAICustomerCopy("ru", "failure"),
    resolveGenerativeAICustomerCopy("en", "failure"),
  );
});

const executionContext = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
};

const runtime: GenerativeAIAutoReplyRuntime = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "a".repeat(64),
  actionNodeId: "generate-1",
  config: {
    version: 1,
    mode: "text_to_video",
    prompt: "Cinematic product reveal",
  },
  input: {
    status: "compatible",
    input: {
      messageId: "message-1",
      kind: "text",
      textOrCaption: "summer collection",
      whatsappMediaId: null,
      declaredMimeType: null,
      fileName: null,
    },
  },
  successTransition: {
    nextActionNodeId: "success-1",
    completesScenario: false,
  },
  failureTransition: {
    nextActionNodeId: "failure-1",
    completesScenario: false,
  },
};

const activeExecution: ActiveGenerativeAIExecution = {
  version: 1,
  configVersion: 1,
  executionId: "execution-1",
  phase: "accepted",
  scenarioId: "scenario-1",
  scenarioRevisionFingerprint: "a".repeat(64),
  actionNodeId: "generate-1",
  inputMessageId: "message-1",
  expectedInputKind: "text",
  mode: "text_to_video",
  composedPrompt: "prompt",
  sourceMedia: null,
  successTransition: runtime.successTransition,
  failureTransition: runtime.failureTransition,
  scenarioWorkflowId: "scenario-generation:execution-1",
  acceptedAt: "2026-07-30T10:00:00.000Z",
};

test("image generation freezes merchant settings and honors excluding inbound text", async () => {
  const image = {
    provider: "google" as const,
    sourceId: "11111111-1111-4111-8111-111111111111",
    modelId: "gemini-3.1-flash-image",
    aspectRatio: "16:9" as const,
    referenceImages: [],
    includeInboundText: false,
  };
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime: {
      ...runtime,
      config: {
        version: 1,
        mode: "text_to_image",
        prompt: "Name: Аяла. Sport: gymnastics.",
        image,
      },
    },
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-09-17T12:00:00.000Z",
    targetLanguage: "en",
    claimExecution: async (execution) => ({ status: "claimed", execution }),
  });
  assert.equal(result.kind, "started");
  if (result.kind !== "started") return;
  assert.equal(
    result.execution.composedPrompt,
    "Name: Аяла. Sport: gymnastics.",
  );
  assert.equal(result.execution.expectedInputKind, "text");
  assert.deepEqual(result.execution.imageConfig, image);
  image.modelId = "changed-after-acceptance";
  assert.equal(result.execution.imageConfig?.modelId, "gemini-3.1-flash-image");
});

test("tells the customer when the day's limit is reached", async () => {
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime,
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-09-28T09:00:00.000Z",
    targetLanguage: "en",
    promptIssue: "daily_limit_reached",
    claimExecution: async () => {
      throw new Error("a limited turn must not claim");
    },
  });
  assert.deepEqual(result, {
    kind: "failure",
    content: "You've reached today's limit. Please try again tomorrow.",
    dispatchPolicy: "at_most_once",
  });
});

test("localizes image failure without changing legacy video copy", () => {
  assert.equal(
    resolveGenerativeAICustomerCopy("en", "failure", "text_to_image"),
    "We couldn't create an image this time. Please try again.",
  );
  for (const language of ["en", "ru", "kz", "uz"]) {
    assert.notEqual(
      resolveGenerativeAICustomerCopy(language, "failure", "text_to_image"),
      resolveGenerativeAICustomerCopy(language, "failure"),
    );
  }
});

test("compatible input claims once and starts silently with one command", async () => {
  let claims = 0;
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime,
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-07-30T10:00:00.000Z",
    targetLanguage: "en",
    claimExecution: async (execution) => {
      claims += 1;
      return { status: "claimed", execution };
    },
  });

  assert.equal(claims, 1);
  assert.equal(result.kind, "started");
  if (result.kind !== "started") return;
  assert.equal("content" in result, false);
  assert.equal("dispatchPolicy" in result, false);
  assert.equal(
    result.execution.composedPrompt,
    `Cinematic product reveal\n\n${GENERATIVE_AI_CUSTOMER_REQUEST_LABEL}\nsummer collection`,
  );
  assert.equal(result.deferredCommand.version, 1);
  assert.equal(result.deferredCommand.kind, "start_generative_ai_scenario");
  assert.equal(
    result.deferredCommand.workflowId,
    result.execution.scenarioWorkflowId,
  );
});

test("wrong input returns strict guidance without consuming the anchor", async () => {
  for (const [expectedInputKind, content] of [
    ["text", "Please send a text description to continue."],
    ["image", "Please send an image to continue."],
  ] as const) {
    const result = await resolveGenerativeAIAutoReplyAction({
      runtime: {
        ...runtime,
        input: { status: "wrong_type", expectedInputKind },
      },
      activeExecution: null,
      executionContext,
      acceptedAt: "2026-07-30T10:00:00.000Z",
      targetLanguage: "en",
      claimExecution: async () => {
        throw new Error("wrong input must not claim");
      },
    });

    assert.deepEqual(result, {
      kind: "guidance",
      content,
      dispatchPolicy: "at_most_once",
    });
  }
});

test("a synthetic turn waits silently without claim or outbound copy", async () => {
  let claims = 0;
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime: {
      ...runtime,
      input: {
        status: "waiting_for_compatible_input",
        expectedInputKind: "text",
      },
    },
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-07-30T10:00:00.000Z",
    targetLanguage: "en",
    claimExecution: async (execution) => {
      claims += 1;
      return { status: "claimed", execution };
    },
  });

  assert.deepEqual(result, { kind: "waiting" });
  assert.equal(claims, 0);
  assert.equal("content" in result, false);
});

test("an active owner waits silently and never claims a second execution", async () => {
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime,
    activeExecution: { ...activeExecution, phase: "generating" },
    executionContext,
    acceptedAt: "2026-07-30T10:00:00.000Z",
    targetLanguage: "en",
    claimExecution: async () => {
      throw new Error("active owner must not claim");
    },
  });

  assert.deepEqual(result, { kind: "waiting" });
});

test("an accepted owner restarts the same deferred command without re-claiming", async () => {
  const first = await resolveGenerativeAIAutoReplyAction({
    runtime,
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-07-30T10:00:00.000Z",
    targetLanguage: "en",
    claimExecution: async (execution) => ({
      status: "claimed",
      execution,
    }),
  });
  assert.equal(first.kind, "started");
  if (first.kind !== "started") return;

  const recovered = await resolveGenerativeAIAutoReplyAction({
    runtime: null,
    activeExecution: first.execution,
    executionContext,
    acceptedAt: "2026-07-30T10:01:00.000Z",
    targetLanguage: "en",
    claimExecution: async () => {
      throw new Error("accepted recovery must not re-claim");
    },
  });

  assert.equal(recovered.kind, "started");
  if (recovered.kind !== "started") return;
  assert.equal(recovered.execution.executionId, first.execution.executionId);
  assert.deepEqual(recovered.deferredCommand, first.deferredCommand);
});

test("uses the refreshed non-English language for customer copy", async () => {
  let targetLanguage = "en";
  const callOrder: string[] = [];
  const result = await resolveGenerativeAIAutoReplyActionAfterContext({
    runtime,
    activeExecution: null,
    promptIssue: "prompt_input_missing",
    executionContext,
    ensurePreRuntimeContext: async () => {
      callOrder.push("ensure");
      targetLanguage = "ru";
    },
    readTargetLanguage: () => {
      callOrder.push("read");
      return targetLanguage;
    },
    acceptedAt: "2026-07-30T10:01:00.000Z",
    claimExecution: async () => {
      throw new Error("a rejected prompt must not claim");
    },
  });

  assert.deepEqual(callOrder, ["ensure", "read"]);
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") {
    assert.equal(
      result.content,
      "Не удалось создать видео. Пожалуйста, попробуйте ещё раз.",
    );
  }
});

test("rejects an image prompt over the limit and an empty prompt before claiming", () => {
  const image = {
    provider: "google" as const,
    sourceId: "11111111-1111-4111-8111-111111111111",
    modelId: "gemini-3.1-flash-image",
    aspectRatio: "16:9" as const,
    referenceImages: [],
    includeInboundText: true,
  };
  const input = { textOrCaption: "Aya" };
  const imageConfig = (prompt: string) => ({
    version: 1 as const,
    mode: "text_to_image" as const,
    prompt,
    image,
  });
  // The appended customer text and its label count toward the shared
  // 16,000 limit.
  const appended = `\n\n${GENERATIVE_AI_CUSTOMER_REQUEST_LABEL}\nAya`.length;
  assert.equal(
    findGenerativeAIPromptIssue(
      imageConfig(
        "a".repeat(MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS - appended),
      ),
      input,
    ),
    null,
  );
  assert.equal(
    findGenerativeAIPromptIssue(
      imageConfig(
        "a".repeat(MAX_GENERATIVE_AI_IMAGE_PROMPT_CHARACTERS - appended + 1),
      ),
      input,
    ),
    "prompt_too_long",
  );
  assert.equal(
    findGenerativeAIPromptIssue(
      { ...imageConfig(" "), image: { ...image, includeInboundText: false } },
      input,
    ),
    "prompt_empty",
  );
  // Video length stays with the shared video compiler.
  assert.equal(
    findGenerativeAIPromptIssue(
      { version: 1, mode: "text_to_video", prompt: "a".repeat(20_000) },
      input,
    ),
    null,
  );
  assert.equal(
    composeGenerativeAIExecutionPrompt(imageConfig("Medal"), input),
    `Medal\n\n${GENERATIVE_AI_CUSTOMER_REQUEST_LABEL}\nAya`,
  );
});

test("a rejected prompt returns failure copy without claiming", async () => {
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime,
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-07-30T10:00:00.000Z",
    targetLanguage: "en",
    promptIssue: "prompt_input_missing",
    claimExecution: async () => {
      throw new Error("a rejected prompt must not claim");
    },
  });

  assert.deepEqual(result, {
    kind: "failure",
    content: "We couldn't create a video this time. Please try again.",
    dispatchPolicy: "at_most_once",
  });
});

test("a CAS loser waits silently without returning a paid command", async () => {
  const result = await resolveGenerativeAIAutoReplyAction({
    runtime,
    activeExecution: null,
    executionContext,
    acceptedAt: "2026-07-30T10:00:00.000Z",
    targetLanguage: "en",
    claimExecution: async (execution) => ({
      status: "existing",
      execution: { ...execution, executionId: "winner" },
    }),
  });

  assert.deepEqual(result, { kind: "waiting" });
});
