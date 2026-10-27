/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockToast = jest.fn();

jest.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => mockToast(...args), {
    error: jest.fn(),
    success: jest.fn(),
  }),
}));
jest.mock("@/components/ui/popover", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Popover: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
    PopoverTrigger: ({
      children,
      asChild,
    }: {
      children?: React.ReactNode;
      asChild?: boolean;
    }) =>
      asChild && React.isValidElement(children) ? (
        children
      ) : (
        <button type="button">{children}</button>
      ),
    PopoverContent: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

jest.mock("../../view/scenario-variable-inserter", () => ({
  ScenarioVariableInserter: ({
    extraFields,
    onInsertToken,
  }: {
    extraFields?: Array<{ token: string; label: string }>;
    onInsertToken: (token: string) => void;
  }) => (
    <div data-testid="variables">
      {(extraFields ?? []).map(field => (
        <button
          key={field.token}
          type="button"
          onClick={() => onInsertToken(field.token)}
        >
          {field.label}
        </button>
      ))}
      <button type="button" onClick={() => onInsertToken("customer_name")}>
        customer_name
      </button>
    </div>
  ),
}));

import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
} from "@icecore/scenario-contracts";
import type { ScenarioNodeData, TranslateFn } from "../../types";
import { ScenarioGraphUndoContext } from "../../view/graph/undo-context";
import {
  ActionNodeAdvancedSettings,
  ActionNodeBranchContext,
  ActionNodeExpandedHeader,
  ActionNodeHeaderChrome,
  ActionNodePreview,
  ActionNodeSourceControls,
  ActionNodeUnreachableRouteNotice,
  FixedReplyEmptyWarning,
} from "./action-node-expanded-ui";
import type { ActionNodePort, ActionNodePorts } from "./action-node-ports";

const t: TranslateFn = (key, values) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

const REPLY_PORT: ActionNodePort = {
  handleId: "right-source",
  kind: "continue",
  label: "serviceRouteNextMessage",
  connected: true,
};

function portsOf(...ports: ActionNodePort[]): ActionNodePorts {
  return {
    ports,
    hiddenAnchorIds: [],
    cornerAnchorIds: [],
    terminal: false,
    signature: "",
  };
}

beforeAll(() => {
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: () => boolean;
    releasePointerCapture?: () => void;
  };
  elementPrototype.hasPointerCapture ??= () => false;
  elementPrototype.releasePointerCapture ??= () => undefined;
  HTMLElement.prototype.scrollIntoView ??= jest.fn();
});

beforeEach(() => {
  mockToast.mockClear();
});

describe("ActionNodeBranchContext", () => {
  it("names the choice that leads to the step", () => {
    render(
      <ActionNodeBranchContext
        incomingRouteCount={1}
        whatsAppSessionChoiceLabel=" Yes "
        t={t}
      />
    );
    expect(screen.getByTestId("action-node-branch-context")).toHaveTextContent(
      'canvasAfterChoice:{"label":"Yes"}'
    );
  });

  it("says nothing when several routes lead to the step", () => {
    render(
      <ActionNodeExpandedHeader
        leading="Title"
        attachmentCount={0}
        incomingRouteCount={2}
        whatsAppSessionChoiceLabel="Back"
        t={t}
      />
    );
    expect(screen.queryByTestId("action-node-branch-context")).toBeNull();
    expect(screen.queryByText(/canvasIncomingRoutes/)).toBeNull();
    expect(screen.queryByText(/Back/)).toBeNull();
  });
});

describe("ActionNodeExpandedHeader", () => {
  it("shows one attachments chip and the long-wait notice", () => {
    render(
      <ActionNodeExpandedHeader
        leading="Title"
        attachmentCount={3}
        longWaitNotice
        t={t}
      />
    );
    expect(
      screen.getByText('actionCardAttachmentCount:{"count":3}')
    ).toBeInTheDocument();
    expect(screen.queryByText("Uploaded")).toBeNull();
    expect(screen.queryByText("badgeAction")).toBeNull();
    const notice = screen.getByTestId("action-node-long-wait-notice");
    expect(notice).toHaveTextContent("actionLongWaitNeedsTemplate");
    expect(notice).not.toHaveAttribute("role");
  });

  it("shows the unreachable-route notice after the long-wait notice", () => {
    render(
      <ActionNodeExpandedHeader
        leading="Title"
        attachmentCount={0}
        longWaitNotice
        unreachableRouteNotice={
          <ActionNodeUnreachableRouteNotice
            ports={portsOf({ ...REPLY_PORT, cannotRun: "outcomes" })}
            nodeData={{ kind: "action", actionType: "reply" }}
            t={t}
          />
        }
        t={t}
      />
    );
    const longWait = screen.getByTestId("action-node-long-wait-notice");
    const unreachable = screen.getByTestId(
      "action-node-unreachable-route-notice"
    );
    expect(
      longWait.compareDocumentPosition(unreachable) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe("ActionNodeUnreachableRouteNotice", () => {
  const nodeData: ScenarioNodeData = { kind: "action", actionType: "reply" };

  it("renders nothing while every route can run", () => {
    const { container } = render(
      <ActionNodeUnreachableRouteNotice
        ports={portsOf(REPLY_PORT)}
        nodeData={nodeData}
        t={t}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [false, "no"],
    [true, "yes"],
  ])(
    "names the route and whether Any reply is linked (%s)",
    (anyReplyConnected, anyReplyLinked) => {
      render(
        <ActionNodeUnreachableRouteNotice
          ports={portsOf(
            { ...REPLY_PORT, cannotRun: "outcomes" },
            {
              handleId: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
              kind: "any_reply",
              label: "actionOutcomeAnyReply",
              connected: anyReplyConnected,
            }
          )}
          nodeData={nodeData}
          t={t}
        />
      );
      const notice = screen.getByTestId("action-node-unreachable-route-notice");
      expect(notice).toHaveTextContent(
        `actionDefaultRouteCannotRun:${JSON.stringify({
          route: "serviceRouteNextMessage",
          anyReply: "actionOutcomeAnyReply",
          anyReplyLinked,
        })}`
      );
      expect(notice).toHaveAttribute("data-tone", "warning");
      expect(notice).not.toHaveAttribute("role");
    }
  );

  it("points to Form submitted when the template's form holds the step", () => {
    render(
      <ActionNodeUnreachableRouteNotice
        ports={portsOf(
          {
            handleId: ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
            kind: "form_submitted",
            label: "serviceRouteFlowSubmitted",
            connected: true,
          },
          {
            ...REPLY_PORT,
            label: "actionPortNextStep",
            cannotRun: "form_submitted",
          }
        )}
        nodeData={{ kind: "action", actionType: "whatsapp_template" }}
        t={t}
      />
    );
    const notice = screen.getByTestId("action-node-unreachable-route-notice");
    expect(notice).toHaveTextContent(
      `actionDefaultRouteCannotRunFormSubmitted:${JSON.stringify({
        route: "actionPortNextStep",
        formSubmitted: "serviceRouteFlowSubmitted",
      })}`
    );
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(notice).not.toHaveAttribute("role");
  });

  it.each(["en", "ru", "kz"])(
    "warns about a linked route with no row in activation's words (%s)",
    locale => {
      const messages = jest.requireActual<{
        Scenarios: Record<string, string>;
      }>(`../../../../../messages/scenarios/${locale}/page.json`).Scenarios;
      const translate: TranslateFn = key => messages[key] ?? key;
      render(
        <ActionNodeUnreachableRouteNotice
          ports={{
            ...portsOf({ ...REPLY_PORT, cannotRun: "outcomes" }),
            anchoredRouteError: "whatsappTemplateFormRouteUnavailable",
          }}
          nodeData={{ kind: "action", actionType: "whatsapp_template" }}
          t={translate}
        />
      );
      const notice = screen.getByTestId("action-node-anchored-route-notice");
      expect(notice).toHaveTextContent(
        messages.whatsappTemplateFormRouteUnavailable
      );
      expect(notice).toHaveAttribute("data-tone", "warning");
      expect(notice).not.toHaveAttribute("role");
      // The default route's own warning still follows.
      expect(
        notice.compareDocumentPosition(
          screen.getByTestId("action-node-unreachable-route-notice")
        ) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
  );

  it.each([
    ["en", "After sending"],
    ["ru", "После отправки"],
    ["kz", "Жібергеннен кейін"],
  ])(
    "never blames “After sending” routes for the form's hold (%s)",
    (locale, afterSending) => {
      const messages = jest.requireActual<{
        Scenarios: Record<string, string>;
      }>(`../../../../../messages/scenarios/${locale}/page.json`).Scenarios;
      const translate: TranslateFn = (key, values) =>
        (messages[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) =>
          String(values?.[name] ?? "")
        );
      // The outcome notice does name them.
      expect(messages.actionDefaultRouteCannotRun).toContain(afterSending);

      render(
        <ActionNodeUnreachableRouteNotice
          ports={portsOf({
            ...REPLY_PORT,
            label: messages.actionPortNextStep,
            cannotRun: "form_submitted",
          })}
          nodeData={{ kind: "action", actionType: "whatsapp_template" }}
          t={translate}
        />
      );
      const notice = screen.getByTestId("action-node-unreachable-route-notice");
      expect(notice).toHaveTextContent(messages.actionPortNextStep);
      expect(notice).toHaveTextContent(messages.serviceRouteFlowSubmitted);
      expect(notice).not.toHaveTextContent(afterSending);
      expect(notice.textContent).not.toMatch(/[{}]/);
    }
  );
});

describe("ActionNodeHeaderChrome", () => {
  async function deleteFromStepMenu() {
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "stepActions" });
    expect(trigger).toHaveClass("nodrag", "nopan", "nokey");
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "removeBlock" }));
  }

  it("deletes the step from its menu and offers an undo", async () => {
    const onRemove = jest.fn();
    const undo = jest.fn(() => true);
    render(
      <ScenarioGraphUndoContext.Provider
        value={{ undo, redo: jest.fn(), canUndo: true, canRedo: false }}
      >
        <ActionNodeHeaderChrome leading="Title" onRemove={onRemove} t={t} />
      </ScenarioGraphUndoContext.Provider>
    );
    expect(screen.queryByRole("button", { name: "removeBlock" })).toBeNull();

    await deleteFromStepMenu();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      "stepDeleted",
      expect.objectContaining({
        action: expect.objectContaining({ label: "whatsappServiceUndo" }),
      })
    );
    const [, options] = mockToast.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    act(() => options.action.onClick());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("undoes through a function history as well", async () => {
    const undo = jest.fn(() => true);
    render(
      <ScenarioGraphUndoContext.Provider value={undo}>
        <ActionNodeHeaderChrome leading="Title" onRemove={jest.fn()} t={t} />
      </ScenarioGraphUndoContext.Provider>
    );
    await deleteFromStepMenu();
    const [, options] = mockToast.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("skips the undo toast when the graph keeps no history", async () => {
    const onRemove = jest.fn();
    render(
      <ActionNodeHeaderChrome leading="Title" onRemove={onRemove} t={t} />
    );
    await deleteFromStepMenu();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("keeps menu clicks away from the canvas node", () => {
    const onNodeClick = jest.fn();
    const onNodePointerDown = jest.fn();
    render(
      <div onClick={onNodeClick} onPointerDown={onNodePointerDown}>
        <ActionNodeHeaderChrome leading="Title" onRemove={jest.fn()} t={t} />
      </div>
    );
    const trigger = screen.getByRole("button", { name: "stepActions" });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onNodePointerDown).not.toHaveBeenCalled();
  });

  it("marks a step that won't send and explains why on request", () => {
    render(
      <ActionNodeHeaderChrome
        leading="Title"
        instagramReplyDisabledReason="Bulk sends can't use Instagram."
        t={t}
      />
    );
    expect(screen.getByText("instagramReplyDisabledBadge")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: 'infoHintLabel:{"topic":"instagramReplyDisabledBadge"}',
        description: "Bulk sends can't use Instagram.",
      })
    ).toBeInTheDocument();
  });
});

describe("ActionNodePreview", () => {
  it("marks a blocking empty preview outside draft validation", () => {
    const preview = {
      text: "actionPreviewEmpty",
      state: "blocking_empty" as const,
    };
    const view = render(
      <ActionNodePreview
        preview={preview}
        validationMode="runnable"
        testId="preview"
      />
    );
    const element = screen.getByTestId("preview");
    expect(element).toHaveClass("italic");
    expect(element.querySelector(".lucide-triangle-alert")).not.toBeNull();

    view.rerender(
      <ActionNodePreview
        preview={preview}
        validationMode="draft"
        testId="preview"
      />
    );
    expect(element.querySelector(".lucide-triangle-alert")).toBeNull();
  });

  it("shows an informational empty state muted, with no warning", () => {
    render(
      <ActionNodePreview
        preview={{ text: "handoffPreviewEmpty", state: "info_empty" }}
        validationMode="runnable"
        testId="preview"
      />
    );
    const element = screen.getByTestId("preview");
    expect(element).toHaveClass("italic");
    expect(element.querySelector("svg")).toBeNull();
  });

  it("shows content as plain text", () => {
    render(
      <ActionNodePreview
        preview={{ text: "Hello", state: "content" }}
        testId="preview"
      />
    );
    expect(screen.getByTestId("preview")).not.toHaveClass("italic");
  });
});

describe("FixedReplyEmptyWarning", () => {
  it("is a warning notice with no live role", () => {
    const { container } = render(
      <FixedReplyEmptyWarning message="fixedReplyEmptyWarning" />
    );
    expect(screen.getByText("fixedReplyEmptyWarning")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelector("[data-tone='warning']")).not.toBeNull();
  });
});

describe("ActionNodeSourceControls", () => {
  const baseProps = {
    actionSourceOptions: [
      { id: "whatsapp" as const, label: "actionSourceWhatsApp" },
      { id: "telegram" as const, label: "actionSourceTelegram" },
    ],
    t,
    whatsAppActionKindOptions: [
      {
        id: "whatsapp_service_message" as const,
        label: "whatsappActionKindServiceMessage",
      },
      { id: "whatsapp_template" as const, label: "whatsappActionKindTemplate" },
    ],
    whatsAppActionKindValue: "whatsapp_service_message" as const,
    onActionSourceChange: jest.fn(),
    onWhatsAppActionKindChange: jest.fn(),
  };

  it("reads Same chat until a channel is picked", () => {
    render(
      <ActionNodeSourceControls
        {...baseProps}
        showWhatsAppActionKindSelect={false}
      />
    );
    expect(
      screen.getByRole("combobox", { name: "actionSourceSelectLabel" })
    ).toHaveTextContent("actionSourceSameChat");
  });

  it("explains each WhatsApp message type in the list only", async () => {
    const user = userEvent.setup();
    render(
      <ActionNodeSourceControls
        {...baseProps}
        selectedActionSourceId="whatsapp"
        showWhatsAppActionKindSelect
      />
    );
    const kind = screen.getByRole("combobox", {
      name: "actionWhatsAppKindSelectLabel",
    });
    expect(kind).toHaveClass("[&_[data-select-description]]:hidden");

    await user.click(kind);
    expect(
      screen.getByRole("option", { name: /whatsappActionKindServiceMessage/ })
    ).toHaveTextContent("actionWhatsAppKindMessageHint");
    expect(
      screen.getByRole("option", { name: /whatsappActionKindTemplate/ })
    ).toHaveTextContent("actionWhatsAppKindTemplateHint");
    // The list names no group: the trigger's label already does.
    expect(screen.queryByText("actionWhatsAppKindSelectLabel")).toBeNull();
  });
});

describe("ActionNodeAdvancedSettings", () => {
  it("inserts a token from the shared variables picker", () => {
    const onInsertToken = jest.fn();

    render(
      <ActionNodeAdvancedSettings
        actionAssetsSection={null}
        showAdvanced
        showAdvancedActionAssets={false}
        showTokenControls
        t={t}
        onInsertToken={onInsertToken}
        onToggle={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "customer_name" }));

    expect(onInsertToken).toHaveBeenCalledWith("customer_name");
  });

  it("offers answers collected earlier in the fixed reply variables", () => {
    const onInsertToken = jest.fn();

    render(
      <ActionNodeAdvancedSettings
        actionAssetsSection={null}
        showAdvanced
        showAdvancedActionAssets={false}
        showTokenControls
        promptInputFields={[
          {
            token: "input.name",
            label: "Name",
            description: "Name on the holder",
          },
        ]}
        t={t}
        onInsertToken={onInsertToken}
        onToggle={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Name" }));

    expect(onInsertToken).toHaveBeenCalledWith("input.name");
  });

  it("keeps its fields mounted while closed and toggles from its header", () => {
    const onToggle = jest.fn();
    render(
      <ActionNodeAdvancedSettings
        actionAssetsSection={<input aria-label="Link" />}
        showAdvanced={false}
        showAdvancedActionAssets
        showTokenControls={false}
        t={t}
        onInsertToken={jest.fn()}
        onToggle={onToggle}
      />
    );
    const header = screen.getByRole("button", {
      name: "actionAdvancedSettings",
    });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Link")).not.toBeVisible();

    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without variables or attachments", () => {
    const { container } = render(
      <ActionNodeAdvancedSettings
        actionAssetsSection={null}
        showAdvanced={false}
        showAdvancedActionAssets={false}
        showTokenControls={false}
        t={t}
        onInsertToken={jest.fn()}
        onToggle={jest.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
