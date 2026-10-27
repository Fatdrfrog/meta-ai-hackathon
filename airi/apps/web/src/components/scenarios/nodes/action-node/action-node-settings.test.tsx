/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import { resolveActionNodePorts } from "./action-node-ports";
import {
  ActionNodeSettings,
  ActionNodeSettingsRoutes,
} from "./action-node-settings";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";
import { installMatchMedia } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const t = (key: string, values?: Record<string, string | number | Date>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

const OUTCOMES: ScenarioActionOutcomes = {
  version: 1,
  anyReply: { enabled: true },
  noReply: { enabled: true, timeoutMinutes: 30 },
};

const replyWithOutcomes: ActionNodeTestData = {
  kind: "action",
  actionType: "reply",
  actionReplyMode: "fixed",
  actionReplyText: "Hi",
  actionOutcomes: OUTCOMES,
  uiConnections: {
    sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID],
    destinationsBySourceHandle: new Map([
      [
        ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        { nodeId: "follow-up", label: "Send price list" },
      ],
    ]),
  },
};

describe("ActionNodeSettingsRoutes", () => {
  it("lists every route with its next step or status", () => {
    const data = createActionEditorTestData(replyWithOutcomes);
    const { ports } = resolveActionNodePorts({
      id: "action-1",
      nodeData: data,
      t,
    });
    render(<ActionNodeSettingsRoutes nodeId="action-1" data={data} t={t} />);

    const section = screen.getByTestId("action-node-settings-routes");
    expect(
      within(section).getByRole("button", {
        name: new RegExp(`^actionPanelRoutes`),
      })
    ).toHaveAttribute("aria-expanded", "true");
    const rows = within(section).getAllByTestId("scenario-route-summary-row");
    expect(rows).toHaveLength(ports.length);
    expect(ports.map(port => port.handleId)).toEqual(
      expect.arrayContaining([
        ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
        ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      ])
    );

    const linkedIndex = ports.findIndex(
      port => port.handleId === ACTION_NO_REPLY_OUTCOME_HANDLE_ID
    );
    expect(rows[linkedIndex]).toHaveAttribute("data-route-status", "linked");
    expect(within(rows[linkedIndex]).getByText("Send price list")).toBeTruthy();
    const anyReplyIndex = ports.findIndex(
      port => port.handleId === ACTION_ANY_REPLY_OUTCOME_HANDLE_ID
    );
    expect(rows[anyReplyIndex]).toHaveAttribute(
      "data-route-status",
      "unlinked"
    );
    expect(
      within(rows[anyReplyIndex]).getByText("sourceHandleStatusUnlinked")
    ).toBeTruthy();
  });

  it("summarizes the routes while closed", () => {
    const data = createActionEditorTestData(replyWithOutcomes);
    const { ports } = resolveActionNodePorts({
      id: "action-1",
      nodeData: data,
      t,
    });
    render(<ActionNodeSettingsRoutes nodeId="action-1" data={data} t={t} />);

    const summary = `actionPanelRoutesSummary:${JSON.stringify({
      connected: ports.filter(port => port.connected).length,
      total: ports.length,
    })}`;
    expect(screen.queryByText(summary)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`^actionPanelRoutes`) })
    );

    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.queryByTestId("scenario-route-summary-row")).toBeNull();
    expect(
      screen.getByText(`routeCount:${JSON.stringify({ count: ports.length })}`)
    ).toHaveClass("sr-only");
  });

  it("renders nothing for a step without routes", () => {
    const { container } = render(
      <ActionNodeSettingsRoutes
        nodeId="action-1"
        data={createActionEditorTestData({
          kind: "action",
          actionType: "end_scenario",
        })}
        t={t}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("ActionNodeSettings", () => {
  it("groups the channel and the message, then lists routes", () => {
    render(
      <ActionNodeSettings
        nodeId="action-1"
        data={createActionEditorTestData({
          kind: "action",
          actionType: "reply",
          actionReplyMode: "ai",
          actionReplyInstruction: "Answer briefly",
        })}
      />
    );

    const channel = screen.getByRole("group", { name: "actionPanelChannel" });
    expect(channel).toBeInTheDocument();
    const message = screen.getByRole("group", { name: "actionPanelMessage" });
    expect(
      within(message).getByRole("radio", { name: "replyModeAi" })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(message).getByLabelText("whatsappServiceAiInstructions")
    ).toHaveValue("Answer briefly");
    expect(
      channel.compareDocumentPosition(message) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByTestId("action-node-settings-routes")).toBeTruthy();
  });

  it("lists a template's Form submitted route without drawing its dot", async () => {
    const formSubmitted = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    // The template editor reads the viewport size.
    installMatchMedia();
    await scenarioEditorChunks.whatsAppInlineEditor.load();
    render(
      <ActionNodeSettings
        nodeId="action-1"
        data={createActionEditorTestData({
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "medal_pick",
          actionWhatsAppTemplateLanguage: "en",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Pick a medal" },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "FLOW",
                  text: "Open form",
                  flow_id: "1571793974235171",
                  flow_action: "data_exchange",
                },
              ],
            },
          ],
          uiConnections: {
            sourceHandleIds: [formSubmitted],
            destinationsBySourceHandle: new Map([
              [formSubmitted, { nodeId: "carousel", label: "Medal carousel" }],
            ]),
          },
        })}
      />
    );

    // The form button shows, but the drawer draws no route dot or hint on it.
    expect(await screen.findByDisplayValue("Open form")).toBeInTheDocument();
    expect(
      document.querySelector(`[data-handleid="${formSubmitted}"]`)
    ).toBeNull();
    expect(
      screen.queryByTestId("whatsapp-template-button-unsaved-route")
    ).toBeNull();
    const routes = within(
      screen.getByTestId("action-node-settings-routes")
    ).getAllByTestId("scenario-route-summary-row");
    expect(
      routes.find(row => row.textContent?.includes("serviceRouteFlowSubmitted"))
    ).toHaveTextContent("Medal carousel");
  });

  it("keeps the channel choice for handoff steps", () => {
    render(
      <ActionNodeSettings
        nodeId="action-1"
        data={createActionEditorTestData({
          kind: "action",
          actionType: "assign_human",
        })}
      />
    );

    expect(
      screen.getByRole("group", { name: "actionPanelChannel" })
    ).toBeInTheDocument();
    // The handoff fields name their own parts, so no "Message" legend wraps them.
    expect(
      screen.queryByRole("group", { name: "actionPanelMessage" })
    ).toBeNull();
    const handoff = screen.getByTestId("action-node-settings-handoff");
    expect(
      within(handoff).getByLabelText("handoffMessageLabel")
    ).toBeInTheDocument();
    expect(
      within(handoff).getByRole("group", { name: "handoffNotifyLegend" })
    ).toBeInTheDocument();
  });
});
