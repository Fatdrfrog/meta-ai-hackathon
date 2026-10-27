/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type {
  ScenarioWhatsAppServiceMessage,
  WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { ActionNodeWhatsAppServiceMessageSection } from "./action-node-whatsapp-service-message-section";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";

jest.mock("next-intl", () => ({
  // Values follow the key so formatted durations can be checked.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
// The builders have their own tests; this file covers what the section adds.
jest.mock("@/components/scenarios/builders/whatsapp/service-message", () => ({
  WhatsAppServiceMessageBuilder: ({
    onOpenFlowEditor,
  }: {
    onOpenFlowEditor?: () => void;
  }) => (
    <button type="button" onClick={onOpenFlowEditor}>
      openFlowEditor
    </button>
  ),
}));
const mockFlowBuilderProps = jest.fn();
jest.mock("./action-node-whatsapp-flow-section", () => ({
  ActionNodeWhatsAppFlowBuilder: ({
    onFlowConfigChange,
    onInlineClose,
    ...props
  }: {
    onFlowConfigChange: (config: WhatsAppFlowConfig) => void;
    onInlineClose?: () => void;
  }) => (
    <>
      {mockFlowBuilderProps(props)}
      <button type="button" onClick={onInlineClose}>
        closeFlowEditor
      </button>
      <button
        type="button"
        onClick={() => onFlowConfigChange(mockTwoOptionFlowConfig)}
      >
        addFlowOption
      </button>
    </>
  ),
}));

function flowConfigWithOptions(
  options: Array<{ id: string; title: string }>
): WhatsAppFlowConfig {
  return {
    templateId: "customer_feedback",
    metaFlowId: "flow-1",
    ctaText: "Open flow",
    screens: [
      {
        id: "screen_1",
        title: "Customer Feedback",
        fields: [
          {
            id: "field_1",
            label: "Pick one",
            fieldType: "RadioButtonsGroup",
            options,
          },
        ],
      },
    ],
  };
}

const mockTwoOptionFlowConfig = flowConfigWithOptions([
  { id: "opt_1", title: "Yes" },
  { id: "opt_2", title: "No" },
]);

const FLOW: ScenarioWhatsAppServiceMessage = {
  version: 1,
  message: {
    kind: "flow",
    body: { mode: "fixed", text: "Open the form" },
    flowConfig: flowConfigWithOptions([{ id: "opt_1", title: "Yes" }]),
  },
};

const ASK: ScenarioWhatsAppServiceMessage = {
  version: 1,
  message: {
    kind: "reply_buttons",
    body: { mode: "fixed", text: "Pick a frame, then send the name." },
    options: [{ id: "wsc:ask:gold", label: "Gold" }],
  },
  promptInputs: [{ key: "name", label: "", prompt: "Name to engrave" }],
};

function renderSection(
  data: Partial<ActionNodeTestData>,
  onLayoutChange?: () => void
) {
  const patchNode = jest.fn();
  render(
    <ActionNodeWhatsAppServiceMessageSection
      id="ask"
      nodeData={createActionEditorTestData({
        kind: "action",
        actionType: "reply",
        ...data,
      })}
      patchNode={patchNode}
      whatsAppFlowsLoading={false}
      whatsAppFlowsRefreshing={false}
      connectedOptionIds={new Set()}
      onLayoutChange={onLayoutChange}
      hasWhatsAppCoexistence={false}
    />
  );
  return patchNode;
}

describe("a message that asks for details without a No reply reminder", () => {
  it("warns and adds a 30-minute reminder in one click, keeping other outcomes", () => {
    const patchNode = renderSection({
      actionWhatsAppServiceMessage: ASK,
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    });

    const notice = screen.getByTestId(
      "whatsapp-service-prompt-inputs-no-reminder"
    );
    expect(notice).toHaveTextContent("whatsappServicePromptInputsNoReminder");
    expect(notice).toHaveAttribute("role", "status");
    // The button says what it adds, with the delay in words.
    const addReminder = screen.getByRole("button", {
      name: /^whatsappServicePromptInputsAddReminder/,
    });
    expect(addReminder).toHaveTextContent(
      'whatsappServicePromptInputsAddReminder:{"duration":"noReplyDuration:{\\"unit\\":\\"minutes\\",\\"count\\":30}"}'
    );
    fireEvent.click(addReminder);
    expect(patchNode).toHaveBeenCalledWith({
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
  });

  it("adds the reminder to a message with no outcomes yet", () => {
    const patchNode = renderSection({ actionWhatsAppServiceMessage: ASK });
    fireEvent.click(
      screen.getByRole("button", {
        name: /^whatsappServicePromptInputsAddReminder/,
      })
    );
    expect(patchNode).toHaveBeenCalledWith({
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
  });

  it.each<[string, Partial<ActionNodeTestData>]>([
    [
      "once a reminder is set",
      {
        actionWhatsAppServiceMessage: ASK,
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes: 30 },
        },
      },
    ],
    [
      "when nothing is asked",
      { actionWhatsAppServiceMessage: { ...ASK, promptInputs: undefined } },
    ],
  ])("says nothing %s", (_label, data) => {
    renderSection(data);
    expect(
      screen.queryByTestId("whatsapp-service-prompt-inputs-no-reminder")
    ).toBeNull();
  });
});

describe("a Flow message on the canvas", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
  });

  it("re-measures branch handles each time the Flow editor closes or opens", () => {
    const onLayoutChange = jest.fn();
    renderSection({ actionWhatsAppServiceMessage: FLOW }, onLayoutChange);
    onLayoutChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "closeFlowEditor" }));
    expect(screen.queryByTestId("whatsapp-service-flow-drawer")).toBeNull();
    expect(screen.getByTestId("flow-branch-preview")).toBeInTheDocument();
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "openFlowEditor" }));
    const drawer = screen.getByTestId("whatsapp-service-flow-drawer");
    expect(drawer).toBeInTheDocument();
    // Named by its title only; no hidden description repeats it.
    expect(drawer).not.toHaveAttribute("aria-describedby");
    expect(onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it("edits the form with every form's key, so its own stays unique", () => {
    const formKeys = new Map([["other-form", "lead_generation"]]);
    renderSection({
      actionWhatsAppServiceMessage: FLOW,
      uiScenarioFormKeys: formKeys,
    });
    expect(mockFlowBuilderProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodeId: "ask", formKeysByNodeId: formKeys })
    );
  });

  it("re-measures branch handles after a Flow edit changes its options", () => {
    const onLayoutChange = jest.fn();
    const patchNode = renderSection(
      { actionWhatsAppServiceMessage: FLOW },
      onLayoutChange
    );
    onLayoutChange.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "addFlowOption" }));
    expect(patchNode).toHaveBeenCalledTimes(1);
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
  });
});
