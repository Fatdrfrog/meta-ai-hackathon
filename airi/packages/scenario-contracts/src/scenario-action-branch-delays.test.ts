import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
  MAX_SCENARIO_ACTION_BRANCH_DELAYS,
  MAX_SCENARIO_ACTION_NO_REPLY_MINUTES,
  buildFlowBranchSourceHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  getConfiguredScenarioActionOutcomeHandleIds,
  getScenarioActionBranchDelay,
  getScenarioActionBranchDelayVirtualNodeId,
  isScenarioActionBranchDelaySourceHandle,
  isScenarioActionBranchDelayVirtualNodeId,
  listWhatsAppTemplateQuickReplyButtons,
  normalizeScenarioActionOutcomes,
  lowerScenarioRoutingGraph,
  parseScenarioActionBranchDelayVirtualNodeId,
  rekeyWhatsAppTemplateButtonIds,
  retainScenarioActionBranchDelays,
  withScenarioActionBranchDelay,
  type ScenarioActionOutcomes,
} from "./index.ts";

const buttonHandle = buildWhatsAppTemplateButtonSourceHandleId(0);
const secondButtonHandle = buildWhatsAppTemplateButtonSourceHandleId(1);
const choiceHandle = buildWhatsAppSessionChoiceSourceHandleId("wsc:menu:help");

function normalizeDelays(branchDelays: unknown) {
  const normalized = normalizeScenarioActionOutcomes({
    version: 1,
    branchDelays,
  });
  assert.equal(normalized.status, "supported");
  return normalized.value?.branchDelays;
}

describe("action branch delay normalization", () => {
  it("keeps trimmed handles, whole minutes and no-reply stop phrase rules", () => {
    assert.deepEqual(
      normalizeDelays([
        {
          sourceHandle: `  ${buttonHandle} `,
          delayMinutes: 15,
          cancelIfPhrases: [" Order   accepted ", "", "Order accepted", 7],
          ignored: true,
        },
        { sourceHandle: choiceHandle, delayMinutes: 1, cancelIfPhrases: [] },
      ]),
      [
        {
          sourceHandle: buttonHandle,
          delayMinutes: 15,
          cancelIfPhrases: ["Order accepted"],
        },
        { sourceHandle: choiceHandle, delayMinutes: 1 },
      ],
    );
  });

  it("bounds stop phrases exactly like the no-reply outcome", () => {
    const cancelIfPhrases = Array.from(
      { length: 25 },
      (_, index) => `phrase ${index}`,
    );
    const outcomes = normalizeScenarioActionOutcomes({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 5, cancelIfPhrases },
      branchDelays: [
        { sourceHandle: buttonHandle, delayMinutes: 5, cancelIfPhrases },
      ],
    });

    assert.deepEqual(
      outcomes.value?.branchDelays?.[0]?.cancelIfPhrases,
      outcomes.value?.noReply?.cancelIfPhrases,
    );
    assert.equal(
      outcomes.value?.branchDelays?.[0]?.cancelIfPhrases?.length,
      20,
    );
  });

  it("drops malformed handles and minutes outside the no-reply range", () => {
    const longHandle = `${ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID}::${"x".repeat(240)}`;
    const maxLengthHandle = "h".repeat(240);

    assert.deepEqual(
      normalizeDelays([
        null,
        "delay",
        { delayMinutes: 5 },
        { sourceHandle: "   ", delayMinutes: 5 },
        { sourceHandle: "right-source whatsapp", delayMinutes: 5 },
        { sourceHandle: longHandle, delayMinutes: 5 },
        { sourceHandle: buttonHandle, delayMinutes: 0 },
        { sourceHandle: buttonHandle, delayMinutes: 1.5 },
        { sourceHandle: buttonHandle, delayMinutes: "5" },
        {
          sourceHandle: buttonHandle,
          delayMinutes: MAX_SCENARIO_ACTION_NO_REPLY_MINUTES + 1,
        },
        { sourceHandle: maxLengthHandle, delayMinutes: 5 },
        {
          sourceHandle: choiceHandle,
          delayMinutes: MAX_SCENARIO_ACTION_NO_REPLY_MINUTES,
        },
      ]),
      [
        { sourceHandle: maxLengthHandle, delayMinutes: 5 },
        {
          sourceHandle: choiceHandle,
          delayMinutes: MAX_SCENARIO_ACTION_NO_REPLY_MINUTES,
        },
      ],
    );
  });

  it("keeps the first valid delay for each handle and caps the list", () => {
    assert.deepEqual(
      normalizeDelays([
        { sourceHandle: buttonHandle, delayMinutes: 0 },
        { sourceHandle: buttonHandle, delayMinutes: 10 },
        { sourceHandle: ` ${buttonHandle}`, delayMinutes: 20 },
      ]),
      [{ sourceHandle: buttonHandle, delayMinutes: 10 }],
    );

    const delays = Array.from({ length: 25 }, (_, index) => ({
      sourceHandle: buildWhatsAppTemplateButtonSourceHandleId(index),
      delayMinutes: index + 1,
    }));
    const normalized = normalizeDelays(delays);
    assert.equal(normalized?.length, MAX_SCENARIO_ACTION_BRANCH_DELAYS);
    assert.deepEqual(normalized, delays.slice(0, 20));
  });

  it("omits the key when no delay survives", () => {
    for (const branchDelays of [undefined, [], [{ sourceHandle: "" }], {}]) {
      const normalized = normalizeScenarioActionOutcomes({
        version: 1,
        paymentDetected: { enabled: true },
        branchDelays,
      });
      assert.deepEqual(normalized.value, {
        version: 1,
        paymentDetected: { enabled: true },
      });
    }
  });

  it("reuses CTA handles instead of adding outcome handles", () => {
    assert.deepEqual(
      getConfiguredScenarioActionOutcomeHandleIds({
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
        branchDelays: [{ sourceHandle: buttonHandle, delayMinutes: 5 }],
      }),
      [ACTION_NO_REPLY_OUTCOME_HANDLE_ID],
    );
  });
});

describe("action branch delay source handles", () => {
  it("accepts only a specific template button or session choice", () => {
    for (const handle of [
      buttonHandle,
      buildWhatsAppTemplateButtonSourceHandleId(3),
      choiceHandle,
    ]) {
      assert.equal(isScenarioActionBranchDelaySourceHandle(handle), true);
    }
    for (const handle of [
      ACTION_WHATSAPP_TEMPLATE_BUTTON_BRANCH_OUTPUT_HANDLE_ID,
      ACTION_WHATSAPP_SESSION_CHOICE_BRANCH_OUTPUT_HANDLE_ID,
      ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
      buildFlowBranchSourceHandleId("plan", "one"),
      buildTelegramBranchSourceHandleId("yes"),
      ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
      ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      "right-source",
      "",
      null,
      undefined,
    ]) {
      assert.equal(
        isScenarioActionBranchDelaySourceHandle(handle),
        false,
        String(handle),
      );
    }
  });

  it("lists labeled template quick replies by button position", () => {
    assert.deepEqual(
      listWhatsAppTemplateQuickReplyButtons([
        { type: "BODY", text: "Choose" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "URL", text: "Site", url: "https://example.com" },
            { type: "QUICK_REPLY", text: " Yes " },
            { type: "QUICK_REPLY", text: "  " },
            null,
            { type: "QUICK_REPLY", text: "No" },
          ],
        },
        { type: "BUTTONS" },
        null,
      ]),
      [
        { index: 1, label: "Yes" },
        { index: 4, label: "No" },
      ],
    );
    assert.deepEqual(listWhatsAppTemplateQuickReplyButtons(undefined), []);
  });
});

describe("action branch delay virtual nodes", () => {
  it("round-trips the action and handle through a reserved id", () => {
    const nodeId = getScenarioActionBranchDelayVirtualNodeId(
      " action:1 ",
      choiceHandle,
    );

    assert.equal(
      nodeId,
      `__system:action-branch-delay:action%3A1:${encodeURIComponent(choiceHandle)}`,
    );
    assert.deepEqual(parseScenarioActionBranchDelayVirtualNodeId(nodeId), {
      actionNodeId: "action:1",
      sourceHandle: choiceHandle,
    });
    assert.equal(isScenarioActionBranchDelayVirtualNodeId(nodeId), true);
  });

  it("rejects other and malformed ids", () => {
    for (const nodeId of [
      "__system:action-outcomes:action-1",
      "__system:action-branch-delay:action-1",
      "__system:action-branch-delay:action-1:a:b",
      "__system:action-branch-delay::handle",
      "__system:action-branch-delay:%E0%A4%A:handle",
      "__system:action-branch-delay:action 1:handle",
      "action-1",
      null,
    ]) {
      assert.equal(
        isScenarioActionBranchDelayVirtualNodeId(nodeId),
        false,
        String(nodeId),
      );
    }
  });
});

describe("action branch delay edit helpers", () => {
  const outcomes: ScenarioActionOutcomes = {
    version: 1,
    noReply: { enabled: true, timeoutMinutes: 30 },
    branchDelays: [
      { sourceHandle: buttonHandle, delayMinutes: 10 },
      { sourceHandle: choiceHandle, delayMinutes: 20 },
    ],
  };

  it("reads one CTA's delay", () => {
    assert.deepEqual(
      getScenarioActionBranchDelay(outcomes, ` ${choiceHandle}`),
      {
        sourceHandle: choiceHandle,
        delayMinutes: 20,
      },
    );
    assert.equal(
      getScenarioActionBranchDelay(outcomes, secondButtonHandle),
      null,
    );
    assert.equal(getScenarioActionBranchDelay(null, buttonHandle), null);
    assert.equal(getScenarioActionBranchDelay(outcomes, " "), null);
  });

  it("replaces in place, appends and removes without mutating", () => {
    const snapshot = structuredClone(outcomes);

    assert.deepEqual(
      withScenarioActionBranchDelay(outcomes, buttonHandle, {
        delayMinutes: 45,
        cancelIfPhrases: [" Paid "],
      }).branchDelays,
      [
        {
          sourceHandle: buttonHandle,
          delayMinutes: 45,
          cancelIfPhrases: ["Paid"],
        },
        { sourceHandle: choiceHandle, delayMinutes: 20 },
      ],
    );
    assert.deepEqual(
      withScenarioActionBranchDelay(outcomes, secondButtonHandle, {
        delayMinutes: 5,
      }).branchDelays,
      [
        { sourceHandle: buttonHandle, delayMinutes: 10 },
        { sourceHandle: choiceHandle, delayMinutes: 20 },
        { sourceHandle: secondButtonHandle, delayMinutes: 5 },
      ],
    );
    assert.deepEqual(
      withScenarioActionBranchDelay(
        withScenarioActionBranchDelay(outcomes, buttonHandle, null),
        choiceHandle,
        null,
      ),
      { version: 1, noReply: { enabled: true, timeoutMinutes: 30 } },
    );
    assert.equal(
      withScenarioActionBranchDelay(outcomes, "bad handle", {
        delayMinutes: 5,
      }),
      outcomes,
    );
    assert.deepEqual(outcomes, snapshot);
  });

  it("drops an invalid delay like persistence would", () => {
    assert.deepEqual(
      withScenarioActionBranchDelay(outcomes, buttonHandle, {
        delayMinutes: 0,
      }).branchDelays,
      [{ sourceHandle: choiceHandle, delayMinutes: 20 }],
    );
  });

  it("retains only the delays of CTAs the action still offers", () => {
    assert.deepEqual(
      retainScenarioActionBranchDelays(outcomes, [choiceHandle, "other"])
        .branchDelays,
      [{ sourceHandle: choiceHandle, delayMinutes: 20 }],
    );
    assert.deepEqual(retainScenarioActionBranchDelays(outcomes, []), {
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30 },
    });
    const withoutDelays: ScenarioActionOutcomes = { version: 1 };
    assert.equal(
      retainScenarioActionBranchDelays(withoutDelays, []),
      withoutDelays,
    );
  });
});

describe("delays on template buttons with ids", () => {
  const BASIC_PREMIUM = [
    { type: "BODY", text: "Which plan do you want?" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Basic" },
        { type: "QUICK_REPLY", text: "Premium" },
      ],
    },
  ];
  const PREMIUM_ONLY = [
    BASIC_PREMIUM[0],
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Premium" }] },
  ];
  const premiumAfterBasicDeleted = rekeyWhatsAppTemplateButtonIds({
    previous: { components: BASIC_PREMIUM, buttonIds: undefined },
    components: PREMIUM_ONLY,
    match: { origins: [1] },
  });

  function lowerMenu(params: {
    components: unknown;
    buttonIds?: unknown;
    delayedHandles: string[];
    routes: Array<[handle: string, target: string]>;
  }) {
    return lowerScenarioRoutingGraph({
      nodes: [
        {
          id: "menu",
          data: {
            kind: "action",
            actionType: "whatsapp_template",
            actionWhatsAppTemplateComponents: params.components,
            ...(params.buttonIds === undefined
              ? {}
              : { actionWhatsAppTemplateButtonIds: params.buttonIds }),
            actionOutcomes: {
              version: 1,
              branchDelays: params.delayedHandles.map((sourceHandle) => ({
                sourceHandle,
                delayMinutes: 30,
              })),
            },
          },
        },
        ...params.routes.map(([, target]) => ({
          id: target,
          data: { kind: "action", actionType: "reply" },
        })),
      ],
      edges: params.routes.map(([sourceHandle, target]) => ({
        id: `menu:${target}`,
        source: "menu",
        target,
        sourceHandle,
      })),
    });
  }

  function followUpOfWait(
    result: ReturnType<typeof lowerScenarioRoutingGraph>,
    waitId: string,
  ) {
    return result.edges.find((edge) => edge.source === waitId)?.target ?? null;
  }

  it("lowers an unedited step exactly as positions did", () => {
    const result = lowerMenu({
      components: BASIC_PREMIUM,
      delayedHandles: [buttonHandle, secondButtonHandle],
      routes: [
        [buttonHandle, "basic-follow-up"],
        [secondButtonHandle, "premium-follow-up"],
      ],
    });

    assert.deepEqual(result.diagnostics, []);
    assert.equal(
      followUpOfWait(
        result,
        getScenarioActionBranchDelayVirtualNodeId("menu", buttonHandle),
      ),
      "basic-follow-up",
    );
    assert.equal(
      followUpOfWait(
        result,
        getScenarioActionBranchDelayVirtualNodeId("menu", secondButtonHandle),
      ),
      "premium-follow-up",
    );
  });

  it("keeps Premium's wait id and follow-up after Basic is deleted", () => {
    const premiumWaitId = getScenarioActionBranchDelayVirtualNodeId(
      "menu",
      secondButtonHandle,
    );
    const before = lowerMenu({
      components: BASIC_PREMIUM,
      delayedHandles: [secondButtonHandle],
      routes: [[secondButtonHandle, "premium-follow-up"]],
    });
    const after = lowerMenu({
      components: PREMIUM_ONLY,
      buttonIds: premiumAfterBasicDeleted,
      delayedHandles: [secondButtonHandle],
      routes: [[secondButtonHandle, "premium-follow-up"]],
    });

    assert.deepEqual(after.diagnostics, []);
    const waits = (result: typeof before) =>
      result.nodes.filter((node) =>
        isScenarioActionBranchDelayVirtualNodeId(node.id),
      );
    assert.deepEqual(waits(after), waits(before));
    assert.deepEqual(after.edges, before.edges);
    assert.equal(followUpOfWait(after, premiumWaitId), "premium-follow-up");
  });

  it("ignores a delay on a deleted button whose route is gone", () => {
    const result = lowerMenu({
      components: PREMIUM_ONLY,
      buttonIds: premiumAfterBasicDeleted,
      delayedHandles: [buttonHandle],
      routes: [[secondButtonHandle, "premium-follow-up"]],
    });

    assert.deepEqual(result.diagnostics, []);
    assert.equal(
      result.nodes.some((node) =>
        isScenarioActionBranchDelayVirtualNodeId(node.id),
      ),
      false,
    );
  });

  it("owns the delay of a minted button only while the map gives its id", () => {
    const withGold = rekeyWhatsAppTemplateButtonIds({
      previous: {
        components: PREMIUM_ONLY,
        buttonIds: premiumAfterBasicDeleted,
      },
      components: [
        BASIC_PREMIUM[0],
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Premium" },
            { type: "QUICK_REPLY", text: "Gold" },
          ],
        },
      ],
      match: { origins: [1, null] },
    });
    const goldHandle = buildWhatsAppTemplateButtonSourceHandleId(10);
    const lowerGold = (buttonIds: unknown) =>
      lowerMenu({
        components: [
          BASIC_PREMIUM[0],
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Premium" },
              { type: "QUICK_REPLY", text: "Gold" },
            ],
          },
        ],
        buttonIds,
        delayedHandles: [goldHandle],
        routes: [[goldHandle, "gold-follow-up"]],
      });

    const owned = lowerGold(withGold);
    assert.deepEqual(owned.diagnostics, []);
    assert.equal(
      followUpOfWait(
        owned,
        getScenarioActionBranchDelayVirtualNodeId("menu", goldHandle),
      ),
      "gold-follow-up",
    );
    for (const buttonIds of [undefined, { version: 2 }]) {
      assert.deepEqual(
        lowerGold(buttonIds).diagnostics.map((diagnostic) => diagnostic.code),
        ["unsupported_action_branch_delay_handle"],
      );
    }
  });
});
