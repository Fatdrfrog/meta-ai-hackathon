import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readCollectedPromptInputs,
  type ScenarioPromptInputExtraction,
  type ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";
import {
  claimPromptInputChoiceNudge,
  closePromptInputAskForNoReply,
  planServiceMessagePromptInputChoice,
  planServiceMessagePromptInputResend,
  planServiceMessagePromptInputTurn,
  readKeptPromptInputWait,
  resolvePromptInputChoiceNudge,
  returnToPromptInputAskAfterReminder,
} from "./scenario-prompt-input-turn";
import type {
  AiriScenarioRuntimeConfig,
  ScenarioDispatchTransition,
} from "./scenario-runtime-types";

const config: ScenarioWhatsAppServiceMessage = {
  version: 1,
  message: {
    kind: "text",
    body: { mode: "fixed", text: "Tell me your name and sport." },
    previewUrl: false,
  },
  promptInputs: [
    { key: "name", label: "Name", prompt: "customer name" },
    { key: "sport", label: "Sport", prompt: "sport they play" },
  ],
};

function runtime(
  patch: Partial<AiriScenarioRuntimeConfig> = {},
): AiriScenarioRuntimeConfig {
  return {
    scenarioId: "scenario-1",
    scenarioName: "Medal",
    actionType: "reply",
    selectedActionNodeId: "ask",
    nextActionNodeId: "generate",
    selectedPathNodeIds: ["start", "ask"],
    actionWhatsAppServiceMessage: config,
    includeConversationTimeline: false,
    includeConversationSummaries: false,
    includeSnippets: false,
    includeKBArticles: false,
    includeIndexedUrls: false,
    includeQuickReplies: false,
    includeCustomerProfile: false,
    includePurchaseHistory: false,
    includeActiveSubscriptions: false,
    includeDynamicBusinessTags: false,
    ...patch,
  };
}

/** What the model read from a reply that names no option. */
const read = (
  values: ScenarioPromptInputExtraction["values"],
): ScenarioPromptInputExtraction => ({ values, choiceOptionId: null });

const now = new Date("2026-09-28T09:00:00.000Z");
const expiresAt = "2026-09-29T09:00:00.000Z";

const waiting = {
  collectedPromptInputs: {
    scenarioId: "scenario-1",
    sourceActionNodeId: "ask",
    awaitingReply: true,
    resumeActionNodeId: "generate",
    sourcePathNodeIds: ["start", "ask"],
    values: {},
  },
};

describe("planServiceMessagePromptInputTurn", () => {
  it("sends the merchant message once and ignores the trigger text", async () => {
    let extracted = false;
    const plan = await planServiceMessagePromptInputTurn({
      runtime: runtime(),
      scenarioState: null,
      sourceText: "Amina plays judo",
      triggerEventKind: "inbound_message",
      extract: async () => {
        extracted = true;
        return read({ name: "Amina", sport: "judo" });
      },
    });
    assert.equal(extracted, false);
    assert.equal(plan.type, "wait");
    if (plan.type !== "wait") return;
    assert.equal(plan.runtime.nextActionNodeId, "ask");
    assert.equal(plan.runtime.completesScenario, false);
    assert.equal(
      (plan.scenarioState.collectedPromptInputs as { awaitingReply: boolean })
        .awaitingReply,
      true,
    );
  });

  it("continues on the default edge when every detail is present", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: runtime(),
      scenarioState: waiting,
      sourceText: "Audio:\nI am Amina and I play judo",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: "Amina", sport: "judo" }),
    });
    assert.equal(plan.type, "resume");
    if (plan.type !== "resume") return;
    assert.equal(plan.scenarioState.currentActionNodeId, "generate");
    // This reply completed the ask, so the resumed action receives it.
    assert.equal(plan.answered, true);
    assert.deepEqual(
      (
        plan.scenarioState.collectedPromptInputs as {
          values: Record<string, string>;
        }
      ).values,
      { name: "Amina", sport: "judo" },
    );
  });

  // A text ask whose own No reply reminder holds its dispatch on it.
  const heldByReminder = (
    metTransition: ScenarioDispatchTransition = {
      nextActionNodeId: "generate",
      completesScenario: false,
    },
  ) =>
    runtime({
      nextActionNodeId: "ask",
      completesScenario: false,
      pendingConditionNodeId: "__system:action-outcomes:ask",
      pendingSourceActionNodeId: "ask",
      actionPromptInputsMetTransition: metTransition,
    });

  it("remembers the collected route when a reminder holds the ask", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: heldByReminder(),
      scenarioState: null,
      sourceText: "trigger text",
      triggerEventKind: "inbound_message",
    });
    assert.equal(plan.type, "wait");
    if (plan.type !== "wait") return;
    assert.equal(
      plan.runtime.pendingConditionNodeId,
      "__system:action-outcomes:ask",
    );
    assert.equal(
      readCollectedPromptInputs(plan.scenarioState)?.resumeActionNodeId,
      "generate",
    );
  });

  it("continues on the collected route, not the reminder's hold", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: heldByReminder(),
      scenarioState: {
        collectedPromptInputs: {
          ...waiting.collectedPromptInputs,
          resumeActionNodeId: null,
        },
      },
      sourceText: "Amina, judo",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: "Amina", sport: "judo" }),
    });
    assert.equal(plan.type, "resume");
    if (plan.type !== "resume") return;
    assert.equal(plan.scenarioState.currentActionNodeId, "generate");
  });

  it("ends the reminder with the scenario when complete details lead nowhere", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: heldByReminder({
        nextActionNodeId: null,
        completesScenario: true,
      }),
      scenarioState: {
        collectedPromptInputs: {
          ...waiting.collectedPromptInputs,
          resumeActionNodeId: null,
        },
      },
      sourceText: "Amina, judo",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: "Amina", sport: "judo" }),
    });
    assert.equal(plan.type, "stored");
    if (plan.type !== "stored") return;
    assert.equal(plan.runtime.completesScenario, true);
    assert.equal(plan.runtime.pendingConditionNodeId, null);
    assert.equal(plan.runtime.pendingSourceActionNodeId, null);
  });

  it("follows the unmet edge without sending another question from this node", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: runtime({
        actionPromptInputsUnmetTransition: {
          nextActionNodeId: "repeat",
          completesScenario: false,
        },
      }),
      scenarioState: waiting,
      sourceText: "Text:\nAmina",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: "Amina", sport: null }),
    });
    assert.equal(plan.type, "resume");
    if (plan.type !== "resume") return;
    assert.equal(plan.scenarioState.currentActionNodeId, "repeat");
    assert.equal(plan.answered, false);
    assert.equal(
      (
        plan.scenarioState.collectedPromptInputs as {
          awaitingReply: boolean;
          values: Record<string, string>;
        }
      ).awaitingReply,
      false,
    );
  });

  it("keeps the reply and does not end the scenario when the unmet edge is open", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: runtime({
        actionPromptInputsUnmetTransition: {
          nextActionNodeId: null,
          completesScenario: false,
        },
      }),
      scenarioState: waiting,
      sourceText: "Audio:\nhello there",
      triggerEventKind: "inbound_message",
      extract: async () => {
        throw new Error("model unavailable");
      },
    });
    assert.equal(plan.type, "hold");
    if (plan.type !== "hold") return;
    assert.equal(plan.runtime.nextActionNodeId, "ask");
    assert.equal(plan.runtime.completesScenario, false);
    assert.equal(
      (plan.scenarioState.collectedPromptInputs as { awaitingReply: boolean })
        .awaitingReply,
      true,
    );
  });
});

describe("a buttons, list or carousel message that asks for details", () => {
  const choiceConfig: ScenarioWhatsAppServiceMessage = {
    version: 1,
    message: {
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Pick a frame, then send your name." },
      options: [
        { id: "wsc:ask:gold", label: "Gold" },
        { id: "wsc:ask:silver", label: "Silver" },
      ],
    },
    promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
  };
  const waitingForChoice = (
    values: Record<string, string> = {},
    patch: Record<string, unknown> = {},
  ) => ({
    lockedScenarioId: "scenario-1",
    currentActionNodeId: "ask",
    collectedPromptInputs: {
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      awaitingReply: true,
      resumeActionNodeId: null,
      sourcePathNodeIds: ["start", "ask"],
      values,
      followsChoice: true,
      choiceOptionId: null,
      ...patch,
    },
  });
  // The tap routed to the gold branch; the runtime describes that branch.
  const tapped = runtime({
    selectedActionNodeId: "gold-frame",
    selectedPathNodeIds: ["start", "ask", "gold-frame"],
    nextActionNodeId: "gold-frame",
    actionType: "generative_ai",
    actionWhatsAppServiceMessage: undefined,
    scenarioRevisionFingerprint: "a".repeat(64),
    pendingConditionNodeId: "__system:action-outcomes:gold-frame",
    choicePromptInputSource: {
      actionNodeId: "ask",
      optionId: "wsc:ask:gold",
      config: choiceConfig,
    },
  });

  it("holds the tap on the asking message until the customer's words arrive", () => {
    const plan = planServiceMessagePromptInputChoice({
      runtime: tapped,
      scenarioState: waitingForChoice(),
      now,
    });
    assert.equal(plan.type, "hold");
    if (plan.type !== "hold") return;
    assert.equal(plan.runtime.selectedActionNodeId, "ask");
    assert.deepEqual(plan.runtime.selectedPathNodeIds, ["start", "ask"]);
    assert.equal(plan.runtime.nextActionNodeId, "ask");
    assert.equal(plan.runtime.actionType, "reply");
    assert.equal(plan.runtime.pendingConditionNodeId, null);
    assert.equal(plan.runtime.actionGenerativeAI, undefined);
    assert.equal(plan.runtime.scenarioRevisionFingerprint, undefined);
    assert.deepEqual(plan.scenarioState.collectedPromptInputs, {
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      awaitingReply: true,
      resumeActionNodeId: "gold-frame",
      sourcePathNodeIds: ["start", "ask", "gold-frame"],
      values: {},
      followsChoice: true,
      choiceOptionId: "wsc:ask:gold",
      expiresAt,
      nudged: false,
    });
  });

  // The message's own No reply reminder, armed when it was delivered.
  const reminderWait = {
    pendingConditionNodeId: "__system:action-outcomes:ask",
    pendingSourceActionNodeId: "ask",
    pendingStartedAt: "2026-09-27T10:00:00.000Z",
    pendingLastOutboundMessageId: "outbound-ask",
  };

  it("keeps the message's No reply reminder armed while the details are pending", () => {
    const plan = planServiceMessagePromptInputChoice({
      runtime: tapped,
      scenarioState: { ...waitingForChoice(), ...reminderWait },
    });
    assert.equal(plan.type, "hold");
    if (plan.type !== "hold") return;
    // The reminder of the message that asked, not a wait of the tapped branch.
    assert.equal(
      plan.runtime.pendingConditionNodeId,
      "__system:action-outcomes:ask",
    );
    assert.equal(plan.runtime.pendingSourceActionNodeId, "ask");
    assert.deepEqual(
      readKeptPromptInputWait(plan.scenarioState, plan.runtime),
      {
        startedAt: new Date("2026-09-27T10:00:00.000Z"),
        lastOutboundMessageId: "outbound-ask",
      },
    );
  });

  it("keeps no wait that was never anchored on a delivered message", () => {
    const state = {
      ...waitingForChoice(),
      ...reminderWait,
      pendingLastOutboundMessageId: null,
    };
    const plan = planServiceMessagePromptInputChoice({
      runtime: tapped,
      scenarioState: state,
    });
    assert.equal(plan.type, "hold");
    if (plan.type !== "hold") return;
    assert.equal(
      readKeptPromptInputWait(plan.scenarioState, plan.runtime),
      null,
    );
  });

  it("keeps no wait armed for another condition", () => {
    assert.equal(
      readKeptPromptInputWait(
        { ...waitingForChoice(), ...reminderWait },
        runtime({ pendingConditionNodeId: "__system:action-outcomes:other" }),
      ),
      null,
    );
  });

  it("closes the ask for a reminder whose route goes on, keeping the answers", () => {
    const tappedState = waitingForChoice(
      { name: "Aya" },
      { choiceOptionId: "wsc:ask:gold" },
    );
    const closed = closePromptInputAskForNoReply(tappedState, "ask") as {
      collectedPromptInputs: Record<string, unknown>;
    };
    assert.equal(closed.collectedPromptInputs.awaitingReply, false);
    assert.equal(closed.collectedPromptInputs.choiceOptionId, null);
    assert.deepEqual(closed.collectedPromptInputs.values, { name: "Aya" });
    // Another message's wait leaves this ask alone.
    assert.equal(
      closePromptInputAskForNoReply(tappedState, "other-message"),
      tappedState,
    );
  });

  it("lets the tap continue when the words came first", () => {
    const plan = planServiceMessagePromptInputChoice({
      runtime: tapped,
      scenarioState: waitingForChoice({ name: "Aya" }),
    });
    assert.equal(plan.type, "continue");
    if (plan.type !== "continue") return;
    assert.equal(
      (plan.scenarioState.collectedPromptInputs as { awaitingReply: boolean })
        .awaitingReply,
      false,
    );
  });

  it("leaves other taps to ordinary routing", () => {
    assert.deepEqual(
      planServiceMessagePromptInputChoice({
        runtime: { ...tapped, choicePromptInputSource: undefined },
        scenarioState: waitingForChoice(),
      }),
      { type: "none" },
    );
  });

  it("replays the tap once the customer's words complete the ask", async () => {
    const state = waitingForChoice();
    const plan = await planServiceMessagePromptInputTurn({
      runtime: runtime({
        actionWhatsAppServiceMessage: choiceConfig,
        nextActionNodeId: "ask",
      }),
      scenarioState: {
        ...state,
        collectedPromptInputs: {
          ...state.collectedPromptInputs,
          resumeActionNodeId: "gold-frame",
          choiceOptionId: "wsc:ask:gold",
        },
      },
      sourceText: "Text:\nAya",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: "Aya" }),
    });
    assert.equal(plan.type, "resume");
    if (plan.type !== "resume") return;
    assert.equal(plan.replayChoiceOptionId, "wsc:ask:gold");
    assert.equal(plan.answered, true);
    // The replayed tap starts from the asking message, as a fresh tap would.
    assert.equal(plan.scenarioState.currentActionNodeId, "ask");
  });

  it("waits for the tap when the words arrive first", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: runtime({
        actionWhatsAppServiceMessage: choiceConfig,
        nextActionNodeId: "ask",
      }),
      scenarioState: waitingForChoice(),
      sourceText: "Text:\nAya",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: "Aya" }),
    });
    assert.equal(plan.type, "hold");
    if (plan.type !== "hold") return;
    assert.equal(plan.runtime.nextActionNodeId, "ask");
    assert.equal(plan.untapped, "answered");
    assert.deepEqual(
      (plan.scenarioState.collectedPromptInputs as { values: object }).values,
      { name: "Aya" },
    );
  });

  const askRuntime = runtime({
    actionWhatsAppServiceMessage: choiceConfig,
    nextActionNodeId: "ask",
  });

  it("offers the options to the reading and replays the one named in words", async () => {
    let offered: string[] = [];
    const plan = await planServiceMessagePromptInputTurn({
      runtime: askRuntime,
      scenarioState: waitingForChoice(),
      sourceText: "Text:\nAya, the silver one",
      triggerEventKind: "inbound_message",
      extract: async ({ choices }) => {
        offered = choices.map((choice) => choice.label);
        return { values: { name: "Aya" }, choiceOptionId: "wsc:ask:silver" };
      },
      now,
    });
    assert.deepEqual(offered, ["Gold", "Silver"]);
    assert.equal(plan.type, "resume");
    if (plan.type !== "resume") return;
    assert.equal(plan.replayChoiceOptionId, "wsc:ask:silver");
    // Recorded as the pick a tap would record, for {{picked.*}} and the card.
    assert.deepEqual(plan.scenarioState.pickedOptions, {
      scenarioId: "scenario-1",
      picks: [
        {
          sourceActionNodeId: "ask",
          optionId: "wsc:ask:silver",
          label: "Silver",
          pickedAt: now.toISOString(),
        },
      ],
    });
  });

  it("keeps an option named before the details and waits for them", async () => {
    const plan = await planServiceMessagePromptInputTurn({
      runtime: askRuntime,
      scenarioState: waitingForChoice(),
      sourceText: "Text:\ngold please",
      triggerEventKind: "inbound_message",
      extract: async () => ({
        values: { name: null },
        choiceOptionId: "wsc:ask:gold",
      }),
      now,
    });
    assert.equal(plan.type, "hold");
    if (plan.type !== "hold") return;
    assert.equal(plan.untapped, undefined);
    assert.equal(
      readCollectedPromptInputs(plan.scenarioState)?.choiceOptionId,
      "wsc:ask:gold",
    );
    assert.equal(
      (plan.scenarioState.pickedOptions as { picks: unknown[] }).picks.length,
      1,
    );
  });

  it("marks words that answer nothing", async () => {
    const unrelated = await planServiceMessagePromptInputTurn({
      runtime: askRuntime,
      scenarioState: waitingForChoice(),
      sourceText: "Text:\nhow much is it?",
      triggerEventKind: "inbound_message",
      extract: async () => read({ name: null }),
    });
    assert.equal(unrelated.type, "hold");
    if (unrelated.type !== "hold") return;
    assert.equal(unrelated.untapped, "unrelated");
  });

  it("offers no options after a tap", async () => {
    let offered: unknown[] | null = null;
    await planServiceMessagePromptInputTurn({
      runtime: askRuntime,
      scenarioState: waitingForChoice(
        {},
        { choiceOptionId: "wsc:ask:gold", resumeActionNodeId: "gold-frame" },
      ),
      sourceText: "Text:\nAya",
      triggerEventKind: "inbound_message",
      extract: async ({ choices }) => {
        offered = choices;
        return read({ name: "Aya" });
      },
    });
    assert.deepEqual(offered, []);
  });

  it("sends the message again for a fresh tap when the tapped option is gone", () => {
    const resend = planServiceMessagePromptInputResend({
      runtime: askRuntime,
      scenarioState: waitingForChoice(
        { name: "Aya" },
        {
          awaitingReply: false,
          choiceOptionId: "wsc:ask:bronze",
          resumeActionNodeId: "bronze-frame",
        },
      ),
      now,
    });
    assert.ok(resend);
    assert.equal(resend.runtime.nextActionNodeId, "ask");
    assert.equal(resend.runtime.completesScenario, false);
    // The tapped branch is forgotten with the tap.
    assert.deepEqual(resend.scenarioState.collectedPromptInputs, {
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      awaitingReply: true,
      resumeActionNodeId: null,
      sourcePathNodeIds: ["start", "ask"],
      values: { name: "Aya" },
      followsChoice: true,
      choiceOptionId: null,
      expiresAt,
      nudged: false,
    });
    // A text ask has no tap to take again.
    assert.equal(
      planServiceMessagePromptInputResend({
        runtime: runtime(),
        scenarioState: waiting,
      }),
      null,
    );
  });

  it("claims the one nudge to tap only while the ask awaits its tap", () => {
    const claimed = claimPromptInputChoiceNudge({
      runtime: askRuntime,
      scenarioState: waitingForChoice(),
    });
    assert.equal(readCollectedPromptInputs(claimed)?.nudged, true);
    assert.equal(
      claimPromptInputChoiceNudge({
        runtime: askRuntime,
        scenarioState: claimed,
      }),
      null,
    );
    for (const [label, input] of [
      [
        "after the tap",
        {
          runtime: askRuntime,
          scenarioState: waitingForChoice(
            {},
            { choiceOptionId: "wsc:ask:gold" },
          ),
        },
      ],
      [
        "with nudges off",
        {
          runtime: runtime({
            actionWhatsAppServiceMessage: {
              ...choiceConfig,
              promptInputBehavior: { nudgeOnce: false },
            },
          }),
          scenarioState: waitingForChoice(),
        },
      ],
      ["on a text ask", { runtime: runtime(), scenarioState: waiting }],
    ] as const) {
      assert.equal(claimPromptInputChoiceNudge(input), null, label);
    }
  });

  it("words the nudge in the customer's language", () => {
    assert.equal(
      resolvePromptInputChoiceNudge("en-US"),
      "Please choose one of the options above to continue.",
    );
    assert.notEqual(
      resolvePromptInputChoiceNudge("ru"),
      resolvePromptInputChoiceNudge("en"),
    );
  });
});

describe("a No reply reminder on an ask", () => {
  const reminder = runtime({
    selectedActionNodeId: "reminder",
    selectedPathNodeIds: ["start", "ask", "reminder"],
    nextActionNodeId: null,
    completesScenario: true,
    actionWhatsAppServiceMessage: undefined,
  });

  it("hands the conversation back to the ask when its route ends there", () => {
    const returned = returnToPromptInputAskAfterReminder(reminder, "ask");
    assert.equal(returned?.selectedActionNodeId, "reminder");
    assert.equal(returned?.nextActionNodeId, "ask");
    assert.equal(returned?.completesScenario, false);
  });

  it("leaves the ask behind when the route goes on, waits or hands off", () => {
    for (const [label, patch] of [
      ["goes on", { nextActionNodeId: "offer", completesScenario: false }],
      [
        "waits",
        { pendingConditionNodeId: "__system:action-outcomes:reminder" },
      ],
      ["hands off", { actionType: "assign_human" }],
      ["asks again", { actionWhatsAppServiceMessage: config }],
    ] as const) {
      assert.equal(
        returnToPromptInputAskAfterReminder({ ...reminder, ...patch }, "ask"),
        null,
        label,
      );
    }
    assert.equal(returnToPromptInputAskAfterReminder(null, "ask"), null);
  });
});
