import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyScenarioPromptInputExtraction,
  buildFlowPromptInputInboundText,
  buildScenarioPromptInputAnswerText,
  buildScenarioPromptInputSourceText,
  captureFlowTextPromptInputs,
  listInsertableScenarioPromptInputs,
  listRunnableScenarioPromptInputs,
  listScenarioFlowTextPromptInputs,
  MAX_SCENARIO_PROMPT_INPUT_SOURCE_CHARACTERS,
  mergePromptInputAnswersIntoScenarioState,
  listScenarioPromptInputTypedChoices,
  normalizeCollectedPromptInputs,
  readCollectedPromptInputValues,
  readFlowTextPromptInputAnswers,
  readAwaitingScenarioPromptInputAsk,
  readExpiredScenarioPromptInputAsk,
  readScenarioPromptInputAnswer,
  readScenarioPromptInputBehavior,
  resolveServiceMessagePromptInputChoice,
  resolveServiceMessagePromptInputDispatch,
  scenarioPromptInputToken,
  validateScenarioPromptInputs,
  type CollectedPromptInputs,
  type ScenarioPromptInputField,
} from "./scenario-prompt-inputs.ts";
import { listScenarioPromptInputReferences } from "./scenario-template-tokens.ts";
import {
  normalizeScenarioWhatsAppServiceMessage,
  validateScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessage,
} from "./whatsapp-service-message.ts";

const nameField: ScenarioPromptInputField = {
  key: "name",
  label: "Name",
  prompt: "What is your name?",
};
const sportField: ScenarioPromptInputField = {
  key: "sport",
  label: "",
  prompt: "Which sport?",
};

function textConfig(
  fields: ScenarioPromptInputField[],
  intro = "We can design a medal for you.",
): ScenarioWhatsAppServiceMessage {
  return {
    version: 1,
    message: {
      kind: "text",
      body: { mode: "fixed", text: intro },
      previewUrl: true,
    },
    promptInputs: fields,
  };
}

const now = new Date("2026-09-28T09:00:00.000Z");
const hoursLater = (hours: number) =>
  new Date(now.getTime() + hours * 60 * 60 * 1000);

describe("scenario prompt inputs", () => {
  it("keeps explicit template answers within the selected scenario", () => {
    const state = {
      collectedPromptInputs: {
        scenarioId: "previous-order-scenario",
        sourceActionNodeId: "ask-order",
        awaitingReply: false,
        resumeActionNodeId: null,
        sourcePathNodeIds: ["ask-order"],
        values: { order_id: "ORDER-42" },
      },
    };
    assert.deepEqual(
      readCollectedPromptInputValues(state, "current-order-scenario"),
      {},
    );
    assert.deepEqual(
      readCollectedPromptInputValues(state, "previous-order-scenario"),
      { order_id: "ORDER-42" },
    );
    // Without a running scenario there is no scope, so no answer is offered.
    assert.deepEqual(readCollectedPromptInputValues(state, null), {});
    assert.deepEqual(readCollectedPromptInputValues(state, undefined), {});
    assert.deepEqual(readCollectedPromptInputValues(state, ""), {});
  });

  it("keeps an in-progress row and reports why it is not runnable", () => {
    const draft = textConfig([
      { key: "Name", label: "x".repeat(41), prompt: "" },
    ]);
    const normalized = normalizeScenarioWhatsAppServiceMessage(draft);
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") return;
    assert.deepEqual(normalized.value.promptInputs, draft.promptInputs);
    assert.equal(listRunnableScenarioPromptInputs(normalized.value), null);
    assert.deepEqual(
      validateScenarioWhatsAppServiceMessage(draft).map((item) => item.code),
      [
        "prompt_input_key_invalid",
        "prompt_input_prompt_required",
        "prompt_input_label_too_long",
      ],
    );
  });

  it("keeps prompt inputs on buttons, lists and carousels only", () => {
    const buttons = normalizeScenarioWhatsAppServiceMessage({
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose one and send your name" },
        options: [{ id: "a", label: "A" }],
      },
      promptInputs: [nameField],
    });
    assert.equal(buttons.status, "supported");
    if (buttons.status !== "supported") return;
    assert.deepEqual(buttons.value.promptInputs, [nameField]);
    assert.deepEqual(validateScenarioWhatsAppServiceMessage(buttons.value), []);
    assert.deepEqual(listRunnableScenarioPromptInputs(buttons.value), [
      nameField,
    ]);

    const location = normalizeScenarioWhatsAppServiceMessage({
      version: 1,
      message: {
        kind: "location_request",
        body: { mode: "fixed", text: "Where are you?" },
      },
      promptInputs: [nameField],
    });
    assert.equal(location.status, "supported");
    if (location.status !== "supported") return;
    assert.equal(location.value.promptInputs, undefined);
  });

  it("asks nothing on a carousel whose cards offer no quick replies", () => {
    const config = {
      version: 1 as const,
      message: {
        kind: "media_carousel" as const,
        body: { mode: "fixed" as const, text: "Our frames" },
        cards: [0, 1].map((index) => ({
          id: `card-${index}`,
          media: {
            url: `gcs://media/workspaces/ws/creative-assets/image/${index}.jpg`,
            mediaType: "image" as const,
          },
          interaction: {
            kind: "url" as const,
            buttonLabel: "Open",
            url: "https://example.test",
          },
        })),
      },
      promptInputs: [nameField],
    };
    assert.deepEqual(
      validateScenarioPromptInputs({
        fields: config.promptInputs,
        message: config.message,
      }).map((item) => item.code),
      ["prompt_inputs_kind_unsupported"],
    );
    assert.equal(listRunnableScenarioPromptInputs(config), null);
  });

  it("waits once and does not treat the trigger text as the answer", () => {
    const dispatch = resolveServiceMessagePromptInputDispatch({
      config: textConfig([nameField, sportField]),
      collection: null,
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "generate",
      sourcePathNodeIds: ["start", "ask"],
      consumeInbound: true,
      extractedValues: { name: "Amina", sport: "judo" },
    });
    assert.equal(dispatch.type, "wait");
    if (dispatch.type !== "wait") return;
    assert.equal(dispatch.collection.awaitingReply, true);
    assert.equal(dispatch.collection.resumeActionNodeId, "generate");
    assert.deepEqual(dispatch.collection.values, {});
  });

  it("keeps waiting without another question when this turn is not a reply", () => {
    const dispatch = resolveServiceMessagePromptInputDispatch({
      config: textConfig([nameField, sportField]),
      collection: {
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
        awaitingReply: true,
        resumeActionNodeId: "generate",
        sourcePathNodeIds: ["start", "ask"],
        values: {},
      },
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "ask",
      sourcePathNodeIds: ["start", "ask"],
      consumeInbound: false,
      extractedValues: { name: "Amina", sport: "judo" },
    });
    assert.equal(dispatch.type, "hold");
    if (dispatch.type !== "hold") return;
    assert.equal(dispatch.collection.awaitingReply, true);
    assert.deepEqual(dispatch.collection.values, {});
  });

  it("marks the ask unmet when a required detail is missing", () => {
    const dispatch = resolveServiceMessagePromptInputDispatch({
      config: textConfig([nameField, sportField]),
      collection: {
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
        awaitingReply: true,
        resumeActionNodeId: "generate",
        sourcePathNodeIds: ["start", "ask"],
        values: {},
      },
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "generate",
      sourcePathNodeIds: ["start", "ask"],
      consumeInbound: true,
      extractedValues: { name: "Amina", sport: null },
    });
    assert.equal(dispatch.type, "unmet");
    if (dispatch.type !== "unmet") return;
    assert.deepEqual(dispatch.collection.values, { name: "Amina" });
    assert.equal(dispatch.collection.awaitingReply, false);
  });

  it("resumes the next action when every detail was read", () => {
    const dispatch = resolveServiceMessagePromptInputDispatch({
      config: textConfig([nameField, sportField]),
      collection: {
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
        awaitingReply: true,
        resumeActionNodeId: "generate",
        sourcePathNodeIds: ["start", "ask"],
        values: { name: "Amina" },
      },
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "generate",
      sourcePathNodeIds: ["start", "ask"],
      consumeInbound: true,
      extractedValues: { sport: "  judo  " },
    });
    assert.equal(dispatch.type, "met");
    if (dispatch.type !== "met") return;
    assert.equal(dispatch.resumeActionNodeId, "generate");
    assert.deepEqual(dispatch.collection.values, {
      name: "Amina",
      sport: "judo",
    });
    assert.equal(dispatch.collection.awaitingReply, false);
    assert.equal(scenarioPromptInputToken("name"), "input.name");
  });

  it("carries earlier answers into a later ask in the same scenario", () => {
    const dispatch = resolveServiceMessagePromptInputDispatch({
      config: textConfig([sportField]),
      collection: {
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
        awaitingReply: false,
        resumeActionNodeId: "generate",
        sourcePathNodeIds: ["start", "ask"],
        values: { name: "Amina" },
      },
      scenarioId: "scenario-1",
      sourceActionNodeId: "repeat",
      resumeActionNodeId: "generate",
      sourcePathNodeIds: ["ask", "repeat"],
      consumeInbound: true,
    });
    assert.equal(dispatch.type, "wait");
    if (dispatch.type !== "wait") return;
    assert.equal(dispatch.collection.sourceActionNodeId, "repeat");
    assert.deepEqual(dispatch.collection.values, { name: "Amina" });
  });

  it("stores answers when the question is the last node", () => {
    const dispatch = resolveServiceMessagePromptInputDispatch({
      config: textConfig([nameField]),
      collection: {
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
        awaitingReply: true,
        resumeActionNodeId: null,
        sourcePathNodeIds: ["ask"],
        values: {},
      },
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: null,
      sourcePathNodeIds: ["ask"],
      consumeInbound: true,
      extractedValues: { name: "Amina" },
    });
    assert.equal(dispatch.type, "stored");
    if (dispatch.type !== "stored") return;
    assert.deepEqual(
      readCollectedPromptInputValues(
        { collectedPromptInputs: dispatch.collection },
        "scenario-1",
      ),
      { name: "Amina" },
    );
  });

  it("reads text, audio, and video and ignores media placeholders", () => {
    assert.equal(
      buildScenarioPromptInputSourceText({
        text: "[audio message]",
        audioAnalysis: "My name is Amina and I play judo",
        videoAnalysis: "A medal sketch",
      }),
      "Audio:\nMy name is Amina and I play judo\n\nVideo:\nA medal sketch",
    );
    assert.deepEqual(
      applyScenarioPromptInputExtraction({
        fields: [nameField, sportField],
        priorValues: {},
        extracted: { name: "Amina", sport: "", extra: "no" },
      }),
      { values: { name: "Amina" }, met: false, supplied: true },
    );
    assert.equal(
      normalizeCollectedPromptInputs({
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
        pendingFieldKey: "name",
        values: {},
      })?.awaitingReply,
      true,
    );
  });

  it("captures text answers from a Flow attached to a template action", () => {
    const flowConfig = {
      screens: [
        {
          fields: [
            { id: "name", label: "Name", fieldType: "TextInput" },
            {
              id: "pick",
              label: "Pick",
              fieldType: "RadioButtonsGroup",
              options: [{ id: "a", title: "A" }],
            },
          ],
        },
      ],
    };
    const template = {
      id: "template",
      data: {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "details",
        actionFlowConfig: flowConfig,
      },
    };
    assert.deepEqual(
      listScenarioFlowTextPromptInputs(template.data).map((field) => field.key),
      ["name"],
    );
    assert.deepEqual(
      captureFlowTextPromptInputs({
        pathNodes: [{ id: "trigger" }, template, { id: "generate" }],
        selectedActionNodeId: "generate",
        responseJson: JSON.stringify({ name: " Aya ", pick: "a" }),
      }),
      { sourceActionNodeId: "template", values: { name: "Aya" } },
    );
    // Only a template action owns actionFlowConfig; a service message owns
    // its node's Flow even when it is not a Flow message.
    assert.deepEqual(
      listScenarioFlowTextPromptInputs({
        ...template.data,
        actionType: "reply",
      }),
      [],
    );
    assert.deepEqual(
      listScenarioFlowTextPromptInputs({
        ...template.data,
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
        },
      }),
      [],
    );
  });

  it("lists the answers a template references, in either token syntax", () => {
    assert.deepEqual(
      listScenarioPromptInputReferences(
        "Medal for {{ input.name }} ({input.sport}); again {{input.name}}",
      ),
      ["name", "sport"],
    );
    // Invalid keys render empty rather than failing, so they are not references.
    assert.deepEqual(
      listScenarioPromptInputReferences(
        "{{input.Name}} {{input.name.first}} {{customer.name}} {input}",
      ),
      [],
    );
  });

  it("gives the resumed action the same words the collector read", () => {
    const voice = {
      text: "[audio attachment]",
      audioAnalysis: " Aya,\r\nrhythmic gymnastics ",
    };
    assert.equal(
      buildScenarioPromptInputSourceText(voice),
      "Audio:\nAya,\nrhythmic gymnastics",
    );
    assert.equal(
      buildScenarioPromptInputAnswerText(voice),
      "Aya,\nrhythmic gymnastics",
    );
    assert.equal(
      buildScenarioPromptInputAnswerText({
        text: "Aya, judo",
        videoAnalysis: "A medal sketch",
      }),
      "Aya, judo\n\nA medal sketch",
    );
    for (const text of ["[Round video]", "[Message deleted]", "  "]) {
      assert.equal(buildScenarioPromptInputAnswerText({ text }), "");
    }
  });

  it("reads every part in order, normalized and bounded per part", () => {
    const long = `${"a".repeat(MAX_SCENARIO_PROMPT_INPUT_SOURCE_CHARACTERS)}tail`;
    assert.equal(
      buildScenarioPromptInputSourceText({
        text: " \r\nAya\rjudo\r\n ",
        audioAnalysis: "[voice message]",
        videoAnalysis: long,
      }),
      `Text:\nAya\njudo\n\nVideo:\n${"a".repeat(MAX_SCENARIO_PROMPT_INPUT_SOURCE_CHARACTERS)}`,
    );
    assert.equal(
      buildScenarioPromptInputAnswerText({
        text: null,
        audioAnalysis: " [Message deleted] ",
        videoAnalysis: "  A medal\r\nsketch ",
      }),
      "A medal\nsketch",
    );
    assert.equal(buildScenarioPromptInputSourceText({}), "");
  });

  it("requires the customer-facing message to be fixed text", () => {
    const aiMessage = {
      version: 1 as const,
      message: {
        kind: "text" as const,
        body: { mode: "ai" as const, instruction: "Ask for a name" },
      },
      promptInputs: [nameField],
    };
    assert.equal(listRunnableScenarioPromptInputs(aiMessage), null);
    assert.ok(
      validateScenarioWhatsAppServiceMessage(aiMessage).some(
        (item) => item.code === "prompt_inputs_require_fixed_body",
      ),
    );
  });

  it("reads text fields from a flow and ignores choices", () => {
    const flowNode = {
      data: {
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "flow",
            body: { mode: "fixed", text: "Tell us about you" },
            flowConfig: {
              templateId: "details",
              ctaText: "Open",
              screens: [
                {
                  id: "FORM",
                  title: "Details",
                  fields: [
                    { id: "name", label: "Name", fieldType: "TextInput" },
                    { id: "sport", label: "Sport", fieldType: "TextArea" },
                    {
                      id: "plan",
                      label: "Plan",
                      fieldType: "RadioButtonsGroup",
                      options: [{ id: "pro", title: "Pro" }],
                    },
                    { id: "Bad-Name", label: "Skip", fieldType: "TextInput" },
                    {
                      id: "flow_token",
                      label: "Token",
                      fieldType: "TextInput",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    };
    const fields = listScenarioFlowTextPromptInputs(flowNode.data);
    assert.deepEqual(
      fields.map((field) => field.key),
      ["name", "sport"],
    );
    assert.deepEqual(
      readFlowTextPromptInputAnswers({
        fields,
        responseJson: JSON.stringify({
          flow_token: "flow_1",
          name: " Amina ",
          sport: "tennis",
          plan: "pro",
          values: { sport: "football" },
        }),
      }),
      { name: "Amina", sport: "football" },
    );
    assert.equal(
      buildFlowPromptInputInboundText({
        fields,
        values: { name: "Amina", sport: "football" },
      }),
      "Name: Amina\nSport: football",
    );
    assert.deepEqual(
      captureFlowTextPromptInputs({
        pathNodes: [
          { id: "flow", data: flowNode.data },
          { id: "generate", data: { kind: "action" } },
        ],
        selectedActionNodeId: "generate",
        responseJson: JSON.stringify({ name: "Amina", sport: "tennis" }),
      }),
      {
        sourceActionNodeId: "flow",
        values: { name: "Amina", sport: "tennis" },
      },
    );
    const merged = mergePromptInputAnswersIntoScenarioState({
      state: {
        collectedPromptInputs: {
          scenarioId: "scenario-1",
          sourceActionNodeId: "ask",
          awaitingReply: true,
          resumeActionNodeId: "later",
          sourcePathNodeIds: ["ask"],
          values: { city: "Almaty" },
        },
      },
      scenarioId: "scenario-1",
      sourceActionNodeId: "flow",
      sourcePathNodeIds: ["flow"],
      values: { name: "Amina" },
    });
    assert.equal(
      (merged?.collectedPromptInputs as { awaitingReply: boolean })
        .awaitingReply,
      true,
    );
    assert.deepEqual(
      (merged?.collectedPromptInputs as { values: Record<string, string> })
        .values,
      { city: "Almaty", name: "Amina" },
    );
  });

  it("lists insertable keys from text service messages", () => {
    assert.deepEqual(
      listInsertableScenarioPromptInputs([
        {
          data: {
            actionWhatsAppServiceMessage: textConfig([nameField, sportField]),
          },
        },
        {
          data: {
            actionWhatsAppServiceMessage: textConfig([
              { key: "name", label: "Other", prompt: "" },
              { key: "city", label: "", prompt: "" },
            ]),
          },
        },
      ]).map((field) => field.key),
      ["name", "sport", "city"],
    );
  });
});

describe("details asked by a buttons, list or carousel message", () => {
  const ask: ScenarioWhatsAppServiceMessage = {
    version: 1,
    message: {
      kind: "reply_buttons",
      body: {
        mode: "fixed",
        text: "Pick a frame and send your name and sport",
      },
      options: [
        { id: "wsc:ask:gold", label: "Gold" },
        { id: "wsc:ask:silver", label: "Silver" },
      ],
    },
    promptInputs: [nameField, sportField],
  };
  // The default wait period: a day after the latest reply.
  const expiresAt = hoursLater(24).toISOString();
  const waiting = (overrides: Partial<CollectedPromptInputs> = {}) =>
    ({
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      awaitingReply: true,
      resumeActionNodeId: null,
      sourcePathNodeIds: ["start", "ask"],
      values: {},
      followsChoice: true,
      choiceOptionId: null,
      expiresAt,
      nudged: false,
      ...overrides,
    }) satisfies CollectedPromptInputs;
  const reply = (
    collection: CollectedPromptInputs | null,
    extractedValues: Record<string, string | null> | null,
    typedChoiceOptionId?: string | null,
    config: ScenarioWhatsAppServiceMessage = ask,
  ) =>
    resolveServiceMessagePromptInputDispatch({
      config,
      collection,
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "ask",
      sourcePathNodeIds: ["start", "ask"],
      consumeInbound: true,
      extractedValues,
      typedChoiceOptionId,
      now,
    });
  const tap = (collection: CollectedPromptInputs | null, optionId: string) =>
    resolveServiceMessagePromptInputChoice({
      config: ask,
      collection,
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      optionId,
      resumeActionNodeId: `branch-${optionId.split(":").at(-1)}`,
      sourcePathNodeIds: ["start", "ask", "branch"],
      now,
    });
  // The message is sent again: nothing the customer said is read.
  const resend = (collection: CollectedPromptInputs) =>
    resolveServiceMessagePromptInputDispatch({
      config: ask,
      collection,
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "ask",
      sourcePathNodeIds: ["start", "ask"],
      consumeInbound: false,
      now,
    });

  it("waits for a tap as well as the words, with no branch yet", () => {
    const dispatch = reply(null, null);
    assert.equal(dispatch.type, "wait");
    if (dispatch.type !== "wait") return;
    assert.deepEqual(dispatch.collection, waiting());
  });

  it("keeps words sent before the tap and waits for the tap", () => {
    for (const extracted of [
      { name: "Aya", sport: "judo" },
      { name: "Aya", sport: null },
    ]) {
      const dispatch = reply(waiting(), extracted);
      assert.equal(dispatch.type, "hold");
      if (dispatch.type !== "hold") return;
      assert.equal(dispatch.untapped, "answered");
      assert.equal(dispatch.collection.awaitingReply, true);
      assert.equal(dispatch.collection.choiceOptionId, null);
      assert.equal(dispatch.collection.values.name, "Aya");
    }
  });

  it("tells words that answer nothing apart from an unavailable reading", () => {
    const unrelated = reply(waiting({ values: { name: "Aya" } }), {
      name: null,
      sport: null,
    });
    assert.equal(unrelated.type, "hold");
    if (unrelated.type !== "hold") return;
    assert.equal(unrelated.untapped, "unrelated");
    assert.deepEqual(unrelated.collection.values, { name: "Aya" });

    // Without a reading nothing is known about the words.
    const unread = reply(waiting(), null);
    assert.equal(unread.type, "hold");
    if (unread.type !== "hold") return;
    assert.equal(unread.untapped, undefined);
  });

  it("reads an option named in words as the tap", () => {
    // Every detail known: the ask continues by replaying the named option.
    const met = reply(
      waiting({ values: { name: "Aya" } }),
      { name: null, sport: "judo" },
      "wsc:ask:silver",
    );
    assert.equal(met.type, "met");
    if (met.type !== "met") return;
    assert.equal(met.collection.choiceOptionId, "wsc:ask:silver");
    assert.equal(met.collection.awaitingReply, false);
    assert.equal(met.resumeActionNodeId, "ask");

    // Details still missing: the named option is kept and the ask waits on.
    const partial = reply(
      waiting(),
      { name: "Aya", sport: null },
      "wsc:ask:gold",
    );
    assert.deepEqual(partial, {
      type: "hold",
      collection: waiting({
        values: { name: "Aya" },
        choiceOptionId: "wsc:ask:gold",
      }),
    });
  });

  it("ignores a named option the message does not offer or does not read", () => {
    const unknown = reply(
      waiting(),
      { name: "Aya", sport: "judo" },
      "wsc:ask:bronze",
    );
    assert.equal(unknown.type, "hold");
    if (unknown.type !== "hold") return;
    assert.equal(unknown.collection.choiceOptionId, null);

    const off = reply(
      waiting(),
      { name: "Aya", sport: "judo" },
      "wsc:ask:gold",
      {
        ...ask,
        promptInputBehavior: { typedChoice: false },
      },
    );
    assert.equal(off.type, "hold");
    if (off.type !== "hold") return;
    assert.equal(off.collection.choiceOptionId, null);
  });

  it("lists the options a customer may name only while the tap is awaited", () => {
    const params = {
      config: ask,
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
    };
    assert.deepEqual(
      listScenarioPromptInputTypedChoices({
        ...params,
        collection: waiting(),
      }).map((option) => option.label),
      ["Gold", "Silver"],
    );
    for (const collection of [
      null,
      waiting({ choiceOptionId: "wsc:ask:gold" }),
      waiting({ awaitingReply: false }),
      waiting({ sourceActionNodeId: "other" }),
    ]) {
      assert.deepEqual(
        listScenarioPromptInputTypedChoices({ ...params, collection }),
        [],
      );
    }
    assert.deepEqual(
      listScenarioPromptInputTypedChoices({
        ...params,
        config: { ...ask, promptInputBehavior: { typedChoice: false } },
        collection: waiting(),
      }),
      [],
    );
    assert.deepEqual(
      listScenarioPromptInputTypedChoices({
        ...params,
        config: textConfig([nameField]),
        collection: waiting({ followsChoice: false }),
      }),
      [],
    );
  });

  it("keeps the nudge mark for the ask it was sent for", () => {
    const held = reply(waiting({ nudged: true }), { name: null, sport: null });
    assert.equal(held.type, "hold");
    if (held.type !== "hold") return;
    assert.equal(held.collection.nudged, true);

    const tapped = tap(waiting({ nudged: true }), "wsc:ask:gold");
    assert.equal(tapped.type, "hold");
    if (tapped.type !== "hold") return;
    assert.equal(tapped.collection.nudged, true);

    const fresh = resend(waiting({ awaitingReply: false, nudged: true }));
    assert.equal(fresh.type, "wait");
    if (fresh.type !== "wait") return;
    assert.equal(fresh.collection.nudged, false);
  });

  it("records the tapped branch and waits for the words it still needs", () => {
    const decision = tap(waiting({ values: { name: "Aya" } }), "wsc:ask:gold");
    assert.deepEqual(decision, {
      type: "hold",
      collection: waiting({
        values: { name: "Aya" },
        choiceOptionId: "wsc:ask:gold",
        resumeActionNodeId: "branch-gold",
        sourcePathNodeIds: ["start", "ask", "branch"],
      }),
    });
  });

  it("continues on the tapped branch at once when the words came first", () => {
    const decision = tap(
      waiting({ values: { name: "Aya", sport: "judo" } }),
      "wsc:ask:silver",
    );
    assert.equal(decision.type, "continue");
    if (decision.type !== "continue") return;
    assert.equal(decision.collection.awaitingReply, false);
    assert.equal(decision.collection.choiceOptionId, "wsc:ask:silver");
    assert.equal(decision.collection.resumeActionNodeId, "branch-silver");
  });

  it("starts a fresh ask for a tap on a message it no longer waits on", () => {
    for (const collection of [
      null,
      waiting({ scenarioId: "scenario-2", values: { name: "Old" } }),
      waiting({ sourceActionNodeId: "other", values: { name: "Old" } }),
    ]) {
      const decision = tap(collection, "wsc:ask:gold");
      assert.equal(decision.type, "hold");
      if (decision.type !== "hold") return;
      assert.deepEqual(decision.collection.values, {});
    }
  });

  it("resumes on the tapped branch once the words complete the ask", () => {
    const tapped = waiting({
      values: { name: "Aya" },
      choiceOptionId: "wsc:ask:gold",
      resumeActionNodeId: "branch-gold",
    });
    const met = reply(tapped, { sport: "judo" });
    assert.equal(met.type, "met");
    if (met.type !== "met") return;
    assert.equal(met.resumeActionNodeId, "branch-gold");
    assert.equal(met.collection.choiceOptionId, "wsc:ask:gold");
    assert.equal(met.collection.awaitingReply, false);

    const unmet = reply(tapped, { sport: null });
    assert.equal(unmet.type, "unmet");
  });

  it("forgets an earlier tap when the message is sent again", () => {
    const dispatch = resend(
      waiting({
        awaitingReply: false,
        choiceOptionId: "wsc:ask:gold",
        resumeActionNodeId: "branch-gold",
      }),
    );
    assert.equal(dispatch.type, "wait");
    if (dispatch.type !== "wait") return;
    assert.equal(dispatch.collection.choiceOptionId, null);
    assert.equal(dispatch.collection.followsChoice, true);
  });

  it("leaves a text ask and an ask without details to ordinary routing", () => {
    for (const config of [
      textConfig([nameField]),
      { ...ask, promptInputs: [] },
    ]) {
      assert.deepEqual(
        resolveServiceMessagePromptInputChoice({
          config,
          collection: waiting(),
          scenarioId: "scenario-1",
          sourceActionNodeId: "ask",
          optionId: "wsc:ask:gold",
          resumeActionNodeId: "branch-gold",
          sourcePathNodeIds: [],
        }),
        { type: "none" },
      );
    }
  });

  it("anchors a customer's words on the ask that waits for them", () => {
    const state = {
      lockedScenarioId: "scenario-1",
      currentActionNodeId: "ask",
      collectedPromptInputs: waiting(),
    };
    assert.deepEqual(readAwaitingScenarioPromptInputAsk(state, now), {
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      followsChoice: true,
    });
    for (const other of [
      { ...state, currentActionNodeId: "next" },
      { ...state, lockedScenarioId: "scenario-2" },
      { ...state, collectedPromptInputs: waiting({ awaitingReply: false }) },
    ]) {
      assert.equal(readAwaitingScenarioPromptInputAsk(other, now), null);
    }
  });
});

describe("how long an ask waits for the customer's words", () => {
  const ask = textConfig([nameField]);
  const state = (collection: Record<string, unknown>) => ({
    lockedScenarioId: "scenario-1",
    currentActionNodeId: "ask",
    collectedPromptInputs: {
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      awaitingReply: true,
      resumeActionNodeId: "next",
      sourcePathNodeIds: ["ask"],
      values: {},
      ...collection,
    },
  });
  const dispatch = (
    collection: CollectedPromptInputs | null,
    consumeInbound: boolean,
    config: ScenarioWhatsAppServiceMessage = ask,
  ) =>
    resolveServiceMessagePromptInputDispatch({
      config,
      collection,
      scenarioId: "scenario-1",
      sourceActionNodeId: "ask",
      resumeActionNodeId: "next",
      sourcePathNodeIds: ["ask"],
      consumeInbound,
      extractedValues: null,
      now,
    });

  it("waits a day after the ask and after each reply by default", () => {
    const asked = dispatch(null, true);
    assert.equal(asked.type, "wait");
    if (asked.type !== "wait") return;
    assert.equal(asked.collection.expiresAt, hoursLater(24).toISOString());

    const replied = dispatch(
      { ...asked.collection, expiresAt: hoursLater(1).toISOString() },
      true,
    );
    assert.equal(replied.type, "hold");
    if (replied.type !== "hold") return;
    assert.equal(replied.collection.expiresAt, hoursLater(24).toISOString());
  });

  it("keeps the wait period on a turn that reads no reply", () => {
    const asked = dispatch(null, true);
    assert.equal(asked.type, "wait");
    if (asked.type !== "wait") return;
    const collection = {
      ...asked.collection,
      expiresAt: hoursLater(2).toISOString(),
    };
    const timer = dispatch(collection, false);
    assert.equal(timer.type, "hold");
    if (timer.type !== "hold") return;
    assert.equal(timer.collection.expiresAt, hoursLater(2).toISOString());
  });

  it("uses the wait period the ask sets", () => {
    for (const waitHours of [1, 168] as const) {
      const asked = dispatch(null, true, {
        ...ask,
        promptInputBehavior: { waitHours },
      });
      assert.equal(asked.type, "wait");
      if (asked.type !== "wait") return;
      assert.equal(
        asked.collection.expiresAt,
        hoursLater(waitHours).toISOString(),
      );
    }
  });

  it("stops anchoring the customer's words once the period passes", () => {
    const waiting = state({ expiresAt: hoursLater(24).toISOString() });
    assert.equal(
      readAwaitingScenarioPromptInputAsk(waiting, hoursLater(23))
        ?.sourceActionNodeId,
      "ask",
    );
    assert.equal(
      readAwaitingScenarioPromptInputAsk(waiting, hoursLater(24)),
      null,
    );
    // Until the customer's next message releases it.
    assert.equal(
      readExpiredScenarioPromptInputAsk(waiting, hoursLater(23)),
      null,
    );
    assert.deepEqual(
      readExpiredScenarioPromptInputAsk(waiting, hoursLater(24)),
      {
        scenarioId: "scenario-1",
        sourceActionNodeId: "ask",
      },
    );
    assert.equal(
      readExpiredScenarioPromptInputAsk(
        { ...waiting, currentActionNodeId: "next" },
        hoursLater(24),
      ),
      null,
    );
    // An ask stored before asks expired waits until its next reply.
    assert.equal(
      readAwaitingScenarioPromptInputAsk(state({}), hoursLater(24 * 30))
        ?.sourceActionNodeId,
      "ask",
    );
  });

  it("reads a stored expiry as a date or an ISO string", () => {
    const at = hoursLater(24);
    for (const expiresAt of [at, at.toISOString()]) {
      assert.equal(
        normalizeCollectedPromptInputs(
          state({ expiresAt }).collectedPromptInputs,
        )?.expiresAt,
        at.toISOString(),
      );
    }
    assert.equal(
      normalizeCollectedPromptInputs(
        state({ expiresAt: "not a date" }).collectedPromptInputs,
      )?.expiresAt,
      null,
    );
  });
});

describe("an ask's reply rules", () => {
  const ask = textConfig([nameField]);

  it("keeps only the rules it knows, and only on an ask", () => {
    const normalized = normalizeScenarioWhatsAppServiceMessage({
      ...ask,
      promptInputBehavior: {
        waitHours: 5,
        typedChoice: false,
        nudgeOnce: "yes",
        extra: true,
      },
    });
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") return;
    assert.deepEqual(normalized.value.promptInputBehavior, {
      typedChoice: false,
    });
    assert.deepEqual(readScenarioPromptInputBehavior(normalized.value), {
      waitHours: 24,
      typedChoice: false,
      nudgeOnce: true,
    });

    const withoutDetails = normalizeScenarioWhatsAppServiceMessage({
      ...ask,
      promptInputs: undefined,
      promptInputBehavior: { waitHours: 1 },
    });
    assert.equal(withoutDetails.status, "supported");
    if (withoutDetails.status !== "supported") return;
    assert.equal(withoutDetails.value.promptInputBehavior, undefined);
  });
});

describe("the answers a detail accepts", () => {
  it("accepts names in any script and rejects anything else", () => {
    const name = { format: "name" as const };
    for (const answer of [
      "Aya",
      "Jean-Luc",
      "O'Brien",
      "Мария Иванова",
      "Әлия",
      "J. R.",
    ]) {
      assert.equal(readScenarioPromptInputAnswer(name, answer), answer);
    }
    for (const answer of [
      "Aya 2",
      "<b>Aya</b>",
      "Aya: draw a logo",
      "Aya 😀",
      "-Aya",
      "a".repeat(41),
    ]) {
      assert.equal(readScenarioPromptInputAnswer(name, answer), null, answer);
    }
    assert.equal(
      readScenarioPromptInputAnswer({ ...name, maxLength: 3 }, "Aya"),
      "Aya",
    );
    assert.equal(
      readScenarioPromptInputAnswer({ ...name, maxLength: 2 }, "Aya"),
      null,
    );
  });

  it("reads numbers without spaces and rejects words", () => {
    const number = { format: "number" as const };
    assert.equal(readScenarioPromptInputAnswer(number, " 1 000 "), "1000");
    assert.equal(readScenarioPromptInputAnswer(number, "3,5"), "3,5");
    assert.equal(readScenarioPromptInputAnswer(number, "-2"), "-2");
    assert.equal(readScenarioPromptInputAnswer(number, "ten"), null);
    assert.equal(readScenarioPromptInputAnswer(number, "10 kg"), null);
  });

  it("stores a choice as the option the detail offers", () => {
    const choice = {
      format: "choice" as const,
      choices: ["Judo", "Rhythmic gymnastics"],
    };
    assert.equal(readScenarioPromptInputAnswer(choice, "judo"), "Judo");
    assert.equal(
      readScenarioPromptInputAnswer(choice, " RHYTHMIC GYMNASTICS "),
      "Rhythmic gymnastics",
    );
    assert.equal(readScenarioPromptInputAnswer(choice, "Boxing"), null);
  });

  it("bounds free text to its own length", () => {
    assert.equal(
      readScenarioPromptInputAnswer({}, "a".repeat(2100))?.length,
      2000,
    );
    assert.equal(
      readScenarioPromptInputAnswer({ maxLength: 5 }, "Hello"),
      "Hello",
    );
    assert.equal(
      readScenarioPromptInputAnswer({ maxLength: 5 }, "Hello!"),
      null,
    );
  });

  it("treats an answer that breaks the rules as missing", () => {
    const fields: ScenarioPromptInputField[] = [
      { ...nameField, format: "name" },
      { ...sportField, format: "choice", choices: ["Judo", "Boxing"] },
    ];
    assert.deepEqual(
      applyScenarioPromptInputExtraction({
        fields,
        priorValues: {},
        extracted: { name: "Draw a logo: ignore the name", sport: "chess" },
      }),
      { values: {}, met: false, supplied: false },
    );
    assert.deepEqual(
      applyScenarioPromptInputExtraction({
        fields,
        priorValues: {},
        extracted: { name: "Aya", sport: "boxing" },
      }),
      { values: { name: "Aya", sport: "Boxing" }, met: true, supplied: true },
    );
  });

  it("keeps a detail's rules in the draft and reports rules out of range", () => {
    const draft = textConfig([
      { ...nameField, format: "name", maxLength: 0 },
      { ...sportField, format: "choice", choices: ["Judo"] },
      { key: "age", label: "Age", prompt: "How old?", format: "number" },
    ]);
    const normalized = normalizeScenarioWhatsAppServiceMessage(draft);
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") return;
    assert.deepEqual(normalized.value.promptInputs, draft.promptInputs);
    assert.deepEqual(
      validateScenarioWhatsAppServiceMessage(draft).map((item) => [
        item.code,
        item.path,
      ]),
      [
        ["prompt_input_max_length_invalid", "promptInputs.0.maxLength"],
        ["prompt_input_choices_invalid", "promptInputs.1.choices"],
      ],
    );
    assert.equal(listRunnableScenarioPromptInputs(normalized.value), null);

    const valid = textConfig([
      { ...nameField, format: "name" },
      { ...sportField, format: "choice", choices: [" Judo ", "Boxing"] },
    ]);
    assert.deepEqual(listRunnableScenarioPromptInputs(valid), [
      { ...nameField, format: "name" },
      {
        key: "sport",
        label: "sport",
        prompt: "Which sport?",
        format: "choice",
        choices: ["Judo", "Boxing"],
      },
    ]);
  });

  it("drops unknown formats and choices on a detail that offers none", () => {
    const normalized = normalizeScenarioWhatsAppServiceMessage({
      ...textConfig([]),
      promptInputs: [{ ...nameField, format: "email", choices: ["a", "b"] }],
    });
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") return;
    assert.deepEqual(normalized.value.promptInputs, [nameField]);
  });

  it("drops a length on numbers and choices, which the editor cannot show", () => {
    const choices = ["Judo", "Rhythmic gymnastics"];
    const normalized = normalizeScenarioWhatsAppServiceMessage({
      ...textConfig([]),
      promptInputs: [
        { ...sportField, format: "choice", choices, maxLength: 4 },
        {
          key: "age",
          label: "Age",
          prompt: "How old?",
          format: "number",
          maxLength: 0,
        },
      ],
    });
    assert.equal(normalized.status, "supported");
    if (normalized.status !== "supported") return;
    assert.deepEqual(normalized.value.promptInputs, [
      { ...sportField, format: "choice", choices },
      { key: "age", label: "Age", prompt: "How old?", format: "number" },
    ]);
    const [sport] = listRunnableScenarioPromptInputs(normalized.value) ?? [];
    assert.equal(
      sport && readScenarioPromptInputAnswer(sport, "rhythmic gymnastics"),
      "Rhythmic gymnastics",
    );
  });
});
