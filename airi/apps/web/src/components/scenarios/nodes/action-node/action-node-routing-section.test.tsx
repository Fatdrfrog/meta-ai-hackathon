/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ActionNodeRoutingSection } from "./action-node-routing-section";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  buildScenarioActionAnswerOutcomeHandleId,
  buildWhatsAppSessionChoiceSourceHandleId,
  MAX_SCENARIO_ACTION_RUN_CONDITIONS,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";

jest.mock("../../source-handle-button", () => ({
  ScenarioSourceHandleButton: ({
    "aria-label": label,
    connectable,
  }: {
    "aria-label": string;
    connectable?: boolean;
  }) => (
    <button
      aria-label={label}
      data-testid="route-handle"
      data-connectable={String(connectable ?? true)}
    />
  ),
}));

const t = (key: string) => key;

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = jest.fn();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const SERVICE_TEXT: ActionNodeTestData = {
  kind: "action",
  actionType: "reply",
  actionReplyChannel: "whatsapp",
  actionWhatsAppServiceMessage: {
    version: 1,
    message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
  },
};

function renderRouting(
  data: ActionNodeTestData,
  props: Partial<Parameters<typeof ActionNodeRoutingSection>[0]> = {}
) {
  const onPatch = jest.fn();
  render(
    <ActionNodeRoutingSection
      nodeId="message"
      nodeData={createActionEditorTestData(data)}
      t={t}
      onPatch={onPatch}
      onHandlesChanged={jest.fn()}
      {...props}
    />
  );
  return onPatch;
}

function renderServiceRouting(actionOutcomes: ScenarioActionOutcomes) {
  return renderRouting({ ...SERVICE_TEXT, actionOutcomes });
}

const sectionTrigger = (title: string) =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });

describe("service-message routing", () => {
  it("opens After sending to show ordinary message and inactivity paths before enabling any outcome", () => {
    const onPatch = renderRouting(SERVICE_TEXT);
    // Closed while it holds no route.
    expect(sectionTrigger("actionOutcomes").getAttribute("aria-expanded")).toBe(
      "false"
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(sectionTrigger("actionOutcomes"));
    expect(
      screen
        .getByRole("checkbox", { name: "actionOutcomeAnyReply" })
        .getAttribute("aria-checked")
    ).toBe("false");
    expect(
      screen
        .getByRole("checkbox", { name: "actionOutcomeNoReply" })
        .getAttribute("aria-checked")
    ).toBe("false");
    expect(
      screen.queryByRole("button", { name: "serviceRouteNextMessage" })
    ).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("turns an outcome on from its visible label", () => {
    const onPatch = renderRouting(SERVICE_TEXT);
    fireEvent.click(sectionTrigger("actionOutcomes"));
    fireEvent.click(screen.getByText("actionOutcomeNoReply"));
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
  });

  it.each([
    { ownedWaitConnected: false, expectedVisible: true },
    { ownedWaitConnected: true, expectedVisible: false },
  ])(
    "shows a saved default route only when no owned wait is connected (connected=$ownedWaitConnected)",
    ({ ownedWaitConnected, expectedVisible }) => {
      renderRouting({
        ...SERVICE_TEXT,
        actionOutcomes: { version: 1, anyReply: { enabled: true } },
        uiConnections: {
          sourceHandleIds: [
            "right-source",
            ...(ownedWaitConnected ? [ACTION_ANY_REPLY_OUTCOME_HANDLE_ID] : []),
          ],
        },
      });
      // Beside Any reply the default output reads Then, never Reply.
      expect(
        Boolean(screen.queryByRole("button", { name: "actionPortNextStep" }))
      ).toBe(expectedVisible);
      expect(
        screen.queryByRole("button", { name: "serviceRouteNextMessage" })
      ).toBeNull();
      expect(
        screen.getByRole("checkbox", { name: "actionOutcomeAnyReply" })
      ).toBeTruthy();
    }
  );

  it("edits inactivity inline without discarding cancellation, answer or payment rules", () => {
    const outcomes = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 30, cancelIfPhrases: ["stop"] },
      answerMatches: [{ id: "yes", text: "yes", mode: "exact" as const }],
      paymentDetected: { enabled: true },
    };
    const onPatch = renderServiceRouting(outcomes);
    const duration = screen.getByRole("spinbutton", {
      name: "noReplyTimeoutAmount",
    });
    fireEvent.change(duration, { target: { value: "15" } });
    fireEvent.blur(duration);
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        ...outcomes,
        noReply: { ...outcomes.noReply, timeoutMinutes: 15 },
      },
    });
    fireEvent.change(screen.getByLabelText("noReplyTimeoutUnit"), {
      target: { value: "hours" },
    });
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        ...outcomes,
        noReply: { ...outcomes.noReply, timeoutMinutes: 900 },
      },
    });
    // Answers and payment opens by default because it holds routes.
    expect(
      sectionTrigger("serviceRouteMoreOptions").getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getByDisplayValue("yes")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "sourceHandleConditionAnswerMatch" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "actionOutcomePayment" })
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "actionOutcomePaymentToggle" })
    ).toBeTruthy();
  });

  it("keeps answer and Paid handles while Answers and payment is closed", () => {
    renderServiceRouting({
      version: 1,
      answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
      paymentDetected: { enabled: true },
    });
    fireEvent.click(sectionTrigger("serviceRouteMoreOptions"));
    expect(screen.queryByDisplayValue("yes")).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "actionOutcomePaymentToggle" })
    ).toBeNull();
    const rows = screen.getByTestId("action-node-outcome-route-rows");
    expect(
      within(rows).getByRole("button", { name: "actionOutcomePayment" })
    ).toBeTruthy();
    expect(
      within(rows)
        .getAllByTestId("route-handle")
        .map(handle => handle.getAttribute("aria-label"))
    ).toEqual(["sourceHandleConditionAnswerMatch", "actionOutcomePayment"]);
  });

  it("keeps cancel phrases under No reply and patches them on blur", () => {
    const onPatch = renderServiceRouting({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30 },
    });
    expect(
      screen.queryByRole("textbox", { name: "actionNoReplyCancelTitle" })
    ).toBeNull();
    fireEvent.click(sectionTrigger("actionNoReplyCancelTitle"));
    const phrases = screen.getByRole("textbox", {
      name: "actionNoReplyCancelTitle",
    });
    fireEvent.change(phrases, { target: { value: "stop\ncancel" } });
    fireEvent.blur(phrases);
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        noReply: {
          enabled: true,
          timeoutMinutes: 30,
          cancelIfPhrases: ["stop", "cancel"],
        },
      },
    });
  });

  it("clears saved cancel phrases", () => {
    const onPatch = renderServiceRouting({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30, cancelIfPhrases: ["stop"] },
    });
    // The count shows saved phrases while the section is closed.
    expect(sectionTrigger("actionNoReplyCancelTitle").textContent).toContain(
      "1"
    );
    fireEvent.click(sectionTrigger("actionNoReplyCancelTitle"));
    const phrases = screen.getByDisplayValue("stop");
    fireEvent.change(phrases, { target: { value: "" } });
    fireEvent.blur(phrases);
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        noReply: {
          enabled: true,
          timeoutMinutes: 30,
          cancelIfPhrases: undefined,
        },
      },
    });
  });

  it("does not patch when the inactivity amount is left without an edit", () => {
    const onPatch = renderServiceRouting({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 1440 },
    });
    const duration = screen.getByRole("spinbutton", {
      name: "noReplyTimeoutAmount",
    });
    fireEvent.focus(duration);
    fireEvent.blur(duration);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("keeps every outcome handle while After sending is closed", () => {
    renderServiceRouting({
      version: 1,
      anyReply: { enabled: true },
      noReply: { enabled: true, timeoutMinutes: 30 },
    });
    fireEvent.click(sectionTrigger("actionOutcomes"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen
        .getAllByTestId("route-handle")
        .map(handle => handle.getAttribute("aria-label"))
    ).toEqual([
      "actionOutcomeAnyReply",
      "actionOutcomeNoReply · noReplyDuration",
    ]);
  });

  it("hides unlinked compact choice routes and keeps connected ones", () => {
    const linkedId = "wsc:action-1:sizes";
    renderRouting(
      {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: "wsc:action-1:packaging", label: "Упаковка" },
              { id: linkedId, label: "Размеры" },
            ],
          },
        },
        uiConnections: {
          whatsAppChoicePayloads: [linkedId],
        },
      },
      { showMessageBranches: true, messageBranchesMode: "connected" }
    );

    expect(screen.queryByText("Упаковка")).toBeNull();
    expect(screen.getByText("Размеры")).toBeTruthy();
    expect(
      screen.getByTestId("scenario-route-row").getAttribute("data-connected")
    ).toBe("true");
  });

  it("renders no route rows without ports", () => {
    const linkedId = "wsc:action-1:sizes";
    renderRouting(
      {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [{ id: linkedId, label: "Размеры" }],
          },
        },
        actionOutcomes: { version: 1, anyReply: { enabled: true } },
        uiConnections: { whatsAppChoicePayloads: [linkedId] },
      },
      { showMessageBranches: true, showPorts: false }
    );
    expect(screen.queryByTestId("scenario-route-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Размеры" })).toBeNull();
    // Buttons take their taps first, so the reply outcome is Other reply.
    expect(
      screen.getByRole("checkbox", { name: "actionOutcomeOtherReply" })
    ).toBeTruthy();
    expect(screen.queryByTestId("route-handle")).toBeNull();
    fireEvent.click(sectionTrigger("actionOutcomes"));
    expect(screen.queryByTestId("route-handle")).toBeNull();
  });

  it("treats a canvas source handle as a connected compact branch", () => {
    const linkedId = "wsc:action-1:sizes";
    renderRouting(
      {
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "whatsapp",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: "wsc:action-1:packaging", label: "Упаковка" },
              { id: linkedId, label: "Размеры" },
            ],
          },
        },
        uiConnections: {
          sourceHandleIds: [buildWhatsAppSessionChoiceSourceHandleId(linkedId)],
        },
      },
      { showMessageBranches: true, messageBranchesMode: "connected" }
    );

    expect(screen.queryByText("Упаковка")).toBeNull();
    expect(screen.getByText("Размеры")).toBeTruthy();
  });
});

describe("After sending on a plain reply", () => {
  const YES_HANDLE = buildScenarioActionAnswerOutcomeHandleId("yes");

  it("keeps connected No reply and answer edges on their handles while closed", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 60 },
        answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
      },
      uiConnections: {
        sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID, YES_HANDLE],
      },
    });
    const trigger = sectionTrigger("actionOutcomes");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.textContent).toContain("routeCount");
    fireEvent.click(trigger);
    expect(screen.queryByDisplayValue("yes")).toBeNull();
    const rows = screen.getAllByTestId("scenario-route-row");
    expect(
      rows.map(row => [
        row.getAttribute("data-connected"),
        within(row).getByTestId("route-handle").getAttribute("aria-label"),
      ])
    ).toEqual([
      ["true", "actionOutcomeNoReply · noReplyDuration"],
      ["true", "sourceHandleConditionAnswerMatch"],
    ]);
  });

  it("shows cancel phrases under No reply outside WhatsApp too", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
    expect(sectionTrigger("actionNoReplyCancelTitle")).toBeTruthy();
    expect(screen.queryByText("triggerNoReplyStopTitle")).toBeNull();
    fireEvent.click(
      within(screen.getByTestId("action-node-no-reply-cancel")).getByRole(
        "button",
        { name: "infoHintLabel" }
      )
    );
    expect(screen.getByRole("dialog").textContent).toBe(
      "actionNoReplyCancelInfo"
    );
  });

  it("edits an answer rule with a labelled input, a mode menu and a named delete", () => {
    const onPatch = renderRouting({
      kind: "action",
      actionType: "reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
      },
    });
    expect(
      screen.getByRole("textbox", { name: "postActionAnswerMatchInputLabel" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "postActionAnswerMatchDelete" })
    ).toBeTruthy();
    const mode = screen.getByRole("combobox", {
      name: "postActionAnswerMatchModeLabel",
    });
    expect(mode.textContent).toContain("postActionAnswerMatchExactShort");
    fireEvent.keyDown(mode, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: /postActionAnswerMatchIntentHint/ })
    ).toBeTruthy();
    fireEvent.keyDown(
      screen.getByRole("option", { name: /postActionAnswerMatchIntent/ }),
      { key: "Enter" }
    );
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "yes", text: "yes", mode: "intent" }],
      },
    });
  });

  it("explains a confirmed payment behind an info button", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 1, paymentDetected: { enabled: true } },
    });
    const paymentRow = screen.getByRole("checkbox", {
      name: "actionOutcomePaymentToggle",
    }).parentElement!;
    fireEvent.click(
      within(paymentRow).getByRole("button", { name: "infoHintLabel" })
    );
    expect(screen.getByRole("dialog").textContent).toBe(
      "actionOutcomePaymentInfo"
    );
  });

  it("keeps legacy-owned outcome handles from starting a drag", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
      uiLegacyActionRouting: {
        actionOutcomesSource: {
          sourceNodeId: "condition",
          sourceKind: "post_action_condition",
        },
      },
    });
    fireEvent.click(sectionTrigger("actionOutcomes"));
    expect(
      screen.getByTestId("route-handle").getAttribute("data-connectable")
    ).toBe("false");
  });
});

describe("Only if", () => {
  it("explains the rule while empty and states the skip once a condition exists", () => {
    renderRouting({ kind: "action", actionType: "reply" });
    expect(screen.getByRole("button", { name: "infoHintLabel" })).toBeTruthy();
    fireEvent.click(sectionTrigger("actionRunIf"));
    expect(screen.queryByTestId("action-routing-run-if-skip-note")).toBeNull();
    expect(
      screen.getByRole("button", { name: "actionRunIfAddCondition" })
    ).toBeTruthy();
  });

  it("shows the skip note under a condition list", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [{ id: "c1", type: "has_purchase_history" }],
      },
    });
    const trigger = sectionTrigger("actionRunIf");
    expect(trigger.textContent).toContain("actionCardRunIfCount");
    expect(screen.queryByRole("button", { name: "infoHintLabel" })).toBeNull();
    fireEvent.click(trigger);
    expect(
      screen.getByTestId("action-routing-run-if-skip-note").textContent
    ).toBe("actionRunIfSkipNote");
    expect(screen.getByText("runIfHasPurchaseHistory")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "actionRunIfRemoveCondition" })
    ).toBeTruthy();
  });

  it("replaces the add button with the limit once every condition slot is used", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: Array.from(
          { length: MAX_SCENARIO_ACTION_RUN_CONDITIONS },
          (_, index) => ({
            id: `c${index}`,
            type: "has_purchase_history" as const,
          })
        ),
      },
    });
    fireEvent.click(sectionTrigger("actionRunIf"));
    expect(
      screen.queryByRole("button", { name: "actionRunIfAddCondition" })
    ).toBeNull();
    expect(screen.getByTestId("action-run-conditions-limit").textContent).toBe(
      "actionRunIfMax"
    );
  });

  const removedLabelData = (internalLabels: string[]): ActionNodeTestData => ({
    kind: "action",
    actionType: "reply",
    actionRunConditions: {
      version: 1,
      match: "all",
      conditions: [{ id: "c1", type: "internal_label", label: "Old" }],
    },
    uiAudienceOptions: {
      channels: [],
      classificationCategories: [],
      funnelStages: [],
      internalLabels,
      customers: [],
      metaReferralAds: [],
      metaReferralCampaigns: [],
      metaReferralAdSets: [],
      metaCampaignLabels: [],
    },
  });

  it("marks a saved value that is no longer offered as removed", () => {
    renderRouting(removedLabelData(["VIP"]));
    // The section opens on its own to show the problem.
    const select = screen.getByRole("combobox", { name: "runIfInternalLabel" });
    expect(select.textContent).toContain("Old");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("runIfValueRemoved")).toBeTruthy();
    expect(screen.getByText("runIfValueRemovedError")).toBeTruthy();
  });

  it("counts removed values on the header and opens once options load", () => {
    const props = {
      nodeId: "message",
      t,
      onPatch: jest.fn(),
      onHandlesChanged: jest.fn(),
    };
    const { rerender } = render(
      <ActionNodeRoutingSection
        {...props}
        nodeData={createActionEditorTestData(removedLabelData([]))}
      />
    );
    // Empty options may still be loading, so nothing is flagged yet.
    const section = screen.getByTestId("action-routing-run-if");
    expect(section).toHaveAttribute("data-state", "closed");
    expect(
      within(section).queryByTestId("scenario-collapsible-error-count")
    ).toBeNull();

    rerender(
      <ActionNodeRoutingSection
        {...props}
        nodeData={createActionEditorTestData(removedLabelData(["VIP"]))}
      />
    );
    expect(section).toHaveAttribute("data-state", "open");
    expect(screen.getByText("runIfValueRemovedError")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /^actionRunIf/, expanded: true })
    );
    expect(section).toHaveAttribute("data-state", "closed");
    expect(screen.queryByText("runIfValueRemovedError")).toBeNull();
    const count = within(section).getByTestId(
      "scenario-collapsible-error-count"
    );
    expect(count).toHaveTextContent("1");
    expect(count).toHaveTextContent("whatsappServiceValidationIssueCount");
  });

  it("creates a condition from its menu without an Any option", () => {
    const onPatch = renderRouting({
      kind: "action",
      actionType: "reply",
      uiAudienceOptions: {
        channels: [],
        classificationCategories: [],
        funnelStages: [],
        internalLabels: [],
        customers: [],
        metaReferralAds: [],
        metaReferralCampaigns: [],
        metaReferralAdSets: [],
        metaCampaignLabels: [],
      },
    });
    fireEvent.click(sectionTrigger("actionRunIf"));
    const add = screen.getByRole("button", { name: "actionRunIfAddCondition" });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "runIfInternalLabel" })
    );
    const select = screen.getByRole("combobox", { name: "runIfInternalLabel" });
    expect(select.textContent).toContain("runIfChoose");
    fireEvent.keyDown(select, { key: "ArrowDown" });
    const empty = screen.getByRole("option", { name: "runIfNoOptions" });
    expect(empty.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("option", { name: /any/i })).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });
});

describe("read-only routing", () => {
  it("disables every control and says why once", () => {
    renderRouting({
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 99 } as never,
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [{ id: "c1", type: "last_seen_days", minimumDays: 30 }],
      },
    });
    expect(screen.getAllByTestId("action-routing-read-only")).toHaveLength(1);
    expect(screen.getByText("actionRoutingReadOnly")).toBeTruthy();
    fireEvent.click(sectionTrigger("actionRunIf"));
    fireEvent.click(sectionTrigger("actionOutcomes"));
    expect(
      screen
        .getAllByRole("checkbox")
        .every(checkbox => checkbox.hasAttribute("disabled"))
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "actionRunIfRemoveCondition" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen
        .getByRole("spinbutton", { name: "runIfInactiveDaysLabel" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "actionRunIfAddCondition" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "actionOutcomeAddAnswer" })
        .hasAttribute("disabled")
    ).toBe(true);
  });
});

describe("routing in node settings", () => {
  it("edits outcomes and answer rules without their handles", () => {
    const outcomes = {
      version: 1 as const,
      anyReply: { enabled: true },
      answerMatches: [{ id: "yes", text: "yes", mode: "exact" as const }],
      paymentDetected: { enabled: true },
    };
    const onPatch = renderRouting(
      { kind: "action", actionType: "reply", actionOutcomes: outcomes },
      { nodeId: "reply", showPorts: false, onHandlesChanged: undefined }
    );
    // Open by default: the section holds routes.
    expect(
      screen.getByRole("checkbox", { name: "actionOutcomeOtherReply" })
    ).toBeTruthy();
    expect(screen.getByDisplayValue("yes")).toBeTruthy();
    expect(screen.queryByTestId("route-handle")).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "actionOutcomePaymentToggle" })
    );
    expect(onPatch).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        answerMatches: outcomes.answerMatches,
      },
    });
  });
});
