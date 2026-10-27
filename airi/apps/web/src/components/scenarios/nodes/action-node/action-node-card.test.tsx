/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";

const mockUpdateNodeInternals = jest.fn();
const mockToast = jest.fn();

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
jest.mock("sonner", () => ({
  toast: Object.assign((...args: unknown[]) => mockToast(...args), {
    error: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
  }),
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    id,
    type,
    className,
    title,
    style,
    role,
    tabIndex,
    onClick,
    onKeyDown,
    isConnectable,
    "aria-label": ariaLabel,
    "aria-hidden": ariaHidden,
    "data-testid": testId,
    "data-route-status": routeStatus,
    "data-route-required": routeRequired,
  }: {
    children?: ReactNode;
    isConnectable?: boolean;
    id?: string;
    type?: string;
    className?: string;
    title?: string;
    style?: CSSProperties;
    role?: string;
    tabIndex?: number;
    onClick?: MouseEventHandler<HTMLDivElement>;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
    "aria-label"?: string;
    "aria-hidden"?: boolean;
    "data-testid"?: string;
    "data-route-status"?: string;
    "data-route-required"?: string;
  }) => (
    <div
      className={className}
      data-handle-id={id}
      data-handle-type={type}
      data-route-status={routeStatus}
      data-route-required={routeRequired}
      data-connectable={
        isConnectable === undefined ? undefined : String(isConnectable)
      }
      data-testid={testId ?? "handle"}
      title={title}
      style={style}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      aria-hidden={ariaHidden}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  ),
  MarkerType: { ArrowClosed: "ArrowClosed" },
  NodeToolbar: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
  useUpdateNodeInternals: () => mockUpdateNodeInternals,
}));
jest.mock(
  "../../builders/whatsapp/service-message/service-message-resources",
  () => ({
    ...jest.requireActual(
      "../../builders/whatsapp/service-message/service-message-resources"
    ),
    useWhatsAppServiceMessageResources: () => ({
      loading: false,
      failed: false,
      retry: jest.fn(),
      signupLinks: [],
      callingReady: true,
      catalogs: [],
      products: [],
    }),
  })
);

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_PAYMENT_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  buildFlowBranchSourceHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  type ScenarioActionOutcomes,
} from "@icecore/scenario-contracts";
import { WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS } from "../../builders/whatsapp/service-message/service-message-labels";
import { sanitizeScenarioDestinationLabel } from "../../scenario-node-labels";
import type { TranslateFn } from "../../types";
import { ScenarioGraphUndoContext } from "../../view/graph/undo-context";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import { restoreScenarioNodeFocus } from "../../view/node-settings/restore-scenario-node-focus";
import { ActionNode } from "./index";
import { resolveActionNodePorts } from "./action-node-ports";
import { resolveActionNodeCardTitle } from "./action-node-state";
import {
  availableSourceHandlesFor,
  createActionEditorTestData,
  testCarouselCards,
  testChoiceHandle,
  testChoiceId,
  testFlowConfig,
  type ActionNodeTestData,
} from "./action-node-test-utils";

const t: TranslateFn = (key, values) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

const OUTCOMES: ScenarioActionOutcomes = {
  version: 1,
  anyReply: { enabled: true },
  noReply: { enabled: true, timeoutMinutes: 30 },
  answerMatches: [{ id: "yes", text: "Yes", mode: "exact" }],
  paymentDetected: { enabled: true },
};

beforeAll(() => {
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: () => boolean;
    releasePointerCapture?: () => void;
  };
  elementPrototype.hasPointerCapture ??= () => false;
  elementPrototype.releasePointerCapture ??= () => undefined;
  HTMLElement.prototype.scrollIntoView ??= jest.fn();
  // Tooltips measure their content once a trigger takes focus.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function panelData(data: ActionNodeTestData): ScenarioActionEditorNodeData {
  return createActionEditorTestData({
    uiUsesSettingsPanel: true,
    uiOnOpenSettings: jest.fn(),
    uiIsEditorExpanded: false,
    uiOnCreateNodeFromSourceHandle: jest.fn(),
    ...data,
  });
}

/** A large graph's unselected action while node settings are off. */
function compactData(data: ActionNodeTestData): ScenarioActionEditorNodeData {
  return createActionEditorTestData({
    uiUsesSettingsPanel: false,
    uiOnOpenSettings: jest.fn(),
    uiIsEditorExpanded: false,
    uiActionNodeCount: 12,
    uiOnCreateNodeFromSourceHandle: jest.fn(),
    ...data,
  });
}

function renderNode(
  data: ScenarioActionEditorNodeData,
  selected = false,
  wrap: (node: ReactNode) => ReactNode = node => node
) {
  const props = {
    id: "action-1",
    type: "actionNode" as const,
    selected,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    selectable: true,
    deletable: true,
    draggable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  const view = render(<>{wrap(<ActionNode {...props} data={data} />)}</>);
  return {
    ...view,
    rerenderWith: (next: ScenarioActionEditorNodeData) =>
      view.rerender(<>{wrap(<ActionNode {...props} data={next} />)}</>),
  };
}

function handleIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-handle-type='source']")
  ).map(handle => handle.dataset.handleId ?? "");
}

function rowHandleIds(): string[] {
  return screen
    .getAllByTestId("action-node-port")
    .map(
      row =>
        row.querySelector<HTMLElement>("[data-handle-id]")?.dataset.handleId ??
        ""
    );
}

function rowTitles(): Array<string | null> {
  return screen
    .getAllByTestId("action-node-port")
    .map(row => row.getAttribute("title"));
}

/** Row titles for the ports: "label · detail", then "→ next step". */
function portTitles(data: ScenarioActionEditorNodeData): string[] {
  return resolveActionNodePorts({
    id: "action-1",
    nodeData: data,
    t,
  }).ports.map(port => {
    const label = port.detail ? `${port.label} · ${port.detail}` : port.label;
    return port.destinationLabel
      ? `${label} → ${sanitizeScenarioDestinationLabel(port.destinationLabel)}`
      : label;
  });
}

/** A handle by id: choice ids hold escapes that CSS selectors mangle. */
function handleElement(
  root: ParentNode,
  handleId: string
): HTMLElement | undefined {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-handle-id]")
  ).find(handle => handle.dataset.handleId === handleId);
}

/** Every handle a connection accepts renders once. */
function expectEachAcceptedHandleOnce(
  container: HTMLElement,
  data: ActionNodeTestData
) {
  const ids = handleIds(container);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toEqual(expect.arrayContaining(availableSourceHandlesFor(data)));
}

describe("ActionNodeCard (node settings panel on)", () => {
  beforeEach(() => {
    mockUpdateNodeInternals.mockClear();
    mockToast.mockClear();
  });

  it("keeps the inline editors while node settings are off", async () => {
    renderNode(
      createActionEditorTestData({
        kind: "action",
        actionType: "reply",
        actionReplyMode: "ai",
        uiOnOpenSettings: jest.fn(),
      })
    );
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.queryByTestId("scenario-action-node-card")).toBeNull();
    expect(screen.getByTestId("action-source-controls")).toBeInTheDocument();
    expect(
      document.querySelector("[data-scenario-node-settings]")
    ).not.toBeInTheDocument();
  });

  it("renders a row and a port for every route while Outcomes are collapsed", () => {
    const data = panelData({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Thanks for your order",
      actionOutcomes: OUTCOMES,
      uiConnections: {
        sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID],
        destinationsBySourceHandle: new Map([
          ["right-source", { nodeId: "next", label: "Delivery details" }],
        ]),
      },
    });
    const { container } = renderNode(data);
    const card = screen.getByTestId("scenario-action-node-card");
    expect(within(card).getByTestId("action-node-title")).toHaveTextContent(
      resolveActionNodeCardTitle(data, t)
    );
    expect(
      within(card).getByTestId("action-node-card-preview")
    ).toHaveTextContent("Thanks for your order");
    // Read-only: no editors and no collapsible Outcomes on the card.
    expect(within(card).queryByRole("combobox")).toBeNull();
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(
      within(card).queryByRole("button", { name: "actionOutcomes" })
    ).toBeNull();

    const expectedRoutes = [
      "right-source",
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      buildScenarioActionAnswerOutcomeHandleId("yes"),
      ACTION_PAYMENT_OUTCOME_HANDLE_ID,
    ];
    expect(rowHandleIds()).toEqual(expectedRoutes);
    expect(handleIds(container).sort()).toEqual([...expectedRoutes].sort());
    expect(rowTitles()).toEqual(portTitles(data));

    const rows = screen.getAllByTestId("action-node-port");
    expect(rows.map(row => row.dataset.connected)).toEqual([
      "true",
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(rows[0]).toHaveTextContent("Delivery details");
    // Each row leads with its kind icon; the No reply wait sits apart.
    expect(rows[0].querySelector(".lucide-arrow-right")).not.toBeNull();
    expect(rows[2].querySelector(".lucide-clock")).not.toBeNull();
    expect(rows[4].querySelector(".lucide-credit-card")).not.toBeNull();
    expect(
      within(rows[2]).getByText("actionOutcomeNoReply")
    ).toBeInTheDocument();
    expect(rows[2].textContent).not.toContain(" · ");
    // Unlinked ports stay unlinked controls that open the step picker.
    const anyReply = container.querySelector<HTMLElement>(
      `[data-handle-id="${ACTION_ANY_REPLY_OUTCOME_HANDLE_ID}"]`
    )!;
    expect(anyReply).toHaveAttribute("data-route-status", "unlinked");
    expect(anyReply).toHaveAttribute("role", "button");
  });

  it("opens the step picker from an unlinked port", () => {
    const data = panelData({
      kind: "action",
      actionType: "reply",
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    });
    const { container } = renderNode(data);
    fireEvent.click(
      container.querySelector(
        `[data-handle-id="${ACTION_ANY_REPLY_OUTCOME_HANDLE_ID}"]`
      )!,
      { clientX: 10, clientY: 20 }
    );
    expect(data.uiOnCreateNodeFromSourceHandle).toHaveBeenCalledWith(
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      10,
      20
    );
  });

  it("keeps legacy outcomes from starting a drag until they are converted", () => {
    const { container } = renderNode(
      panelData({
        kind: "action",
        actionType: "reply",
        actionReplyText: "Hi",
        actionOutcomes: OUTCOMES,
        uiLegacyActionRouting: {
          actionOutcomesSource: {
            sourceNodeId: "legacy-wait",
            sourceKind: "post_action_condition",
          },
        } as ScenarioActionEditorNodeData["uiLegacyActionRouting"],
      })
    );
    for (const handleId of [
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      ACTION_PAYMENT_OUTCOME_HANDLE_ID,
    ]) {
      expect(handleElement(container, handleId)).toHaveAttribute(
        "data-connectable",
        "false"
      );
    }
    expect(handleElement(container, "right-source")).toHaveAttribute(
      "data-connectable",
      "true"
    );
  });

  it("shows the first eight routes and reveals the rest from “+N more”", async () => {
    const user = userEvent.setup();
    const answerMatches = Array.from({ length: 8 }, (_, index) => ({
      id: `answer_${index}`,
      text: `Answer ${index}`,
      mode: "exact" as const,
    }));
    const data = panelData({
      kind: "action",
      actionType: "reply",
      actionOutcomes: { ...OUTCOMES, answerMatches },
    });
    const onCanvasClick = jest.fn();
    const { container } = renderNode(data, false, node => (
      <div onClick={onCanvasClick}>{node}</div>
    ));
    expect(screen.getAllByTestId("action-node-port")).toHaveLength(8);
    const more = screen.getByTestId("action-node-ports-more");
    const toggle = within(more).getByRole("button", {
      name: 'actionPortsMoreLabel:{"count":4}',
    });
    expect(toggle).toHaveTextContent('actionPortsMore:{"count":4}');
    expect(more).not.toHaveAttribute("title");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveClass("nodrag", "nopan", "nokey");
    const controlled = document.getElementById(
      toggle.getAttribute("aria-controls") ?? ""
    );
    expect(controlled).not.toBeNull();
    const hiddenRouteIds = [
      buildScenarioActionAnswerOutcomeHandleId("answer_5"),
      buildScenarioActionAnswerOutcomeHandleId("answer_6"),
      buildScenarioActionAnswerOutcomeHandleId("answer_7"),
      ACTION_PAYMENT_OUTCOME_HANDLE_ID,
    ];
    // Hidden routes keep their edges on the "+N more" row.
    for (const handleId of hiddenRouteIds) {
      const anchor = handleElement(container, handleId);
      expect(anchor).toHaveAttribute("aria-hidden", "true");
      expect(anchor?.closest("[data-testid='action-node-ports-more']")).toBe(
        more
      );
    }
    // Every route keeps exactly one handle.
    expect(handleIds(container)).toHaveLength(12);
    expect(new Set(handleIds(container)).size).toBe(12);

    mockUpdateNodeInternals.mockClear();
    await user.click(toggle);
    expect(onCanvasClick).not.toHaveBeenCalled();
    expect(mockUpdateNodeInternals).toHaveBeenCalledWith("action-1");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("actionPortsLess");
    expect(screen.getAllByTestId("action-node-port")).toHaveLength(12);
    for (const handleId of hiddenRouteIds) {
      const dot = handleElement(container, handleId);
      expect(dot?.closest("[data-testid='action-node-port']")).not.toBeNull();
      expect(controlled?.contains(dot ?? null)).toBe(true);
    }
    expect(new Set(handleIds(container)).size).toBe(12);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByTestId("action-node-port")).toHaveLength(8);
  });

  describe("routes that need a next step", () => {
    const telegramButtons = (count: number, linked: number) => {
      const payloads = Array.from({ length: count }, (_, index) => `b${index}`);
      return panelData({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "telegram",
        actionReplyText: "Choose",
        actionTelegramQuickReplies: payloads.map(payload => [
          { text: `Button ${payload}`, payload },
        ]),
        uiConnections: {
          destinationsBySourceHandle: new Map(
            payloads
              .slice(0, linked)
              .map(payload => [
                buildTelegramBranchSourceHandleId(payload),
                { nodeId: `next-${payload}`, label: `Next ${payload}` },
              ])
          ),
        },
      });
    };

    it("brings them into the first eight rows, in route order", () => {
      renderNode(telegramButtons(10, 9));
      expect(rowHandleIds()).toEqual(
        ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b9"].map(
          buildTelegramBranchSourceHandleId
        )
      );
      const last = screen.getAllByTestId("action-node-port").at(-1)!;
      expect(last.querySelector("[data-route-required]")).toHaveAttribute(
        "data-route-required",
        "true"
      );
      expect(
        within(screen.getByTestId("action-node-ports-more")).getByRole(
          "button",
          { name: 'actionPortsMoreLabel:{"count":2}' }
        )
      ).toHaveTextContent('actionPortsMore:{"count":2}');
      expect(
        screen.queryByTestId("action-node-ports-hidden-required")
      ).toBeNull();
    });

    it("counts the ones past the rows next to “+N more”", async () => {
      const user = userEvent.setup();
      renderNode(telegramButtons(10, 0));
      expect(screen.getAllByTestId("action-node-port")).toHaveLength(8);
      expect(
        screen.getByTestId("action-node-ports-hidden-required")
      ).toHaveTextContent('actionPortsHiddenRequired:{"count":2}');

      const toggle = within(
        screen.getByTestId("action-node-ports-more")
      ).getByRole("button");
      await user.click(toggle);
      expect(toggle).toHaveAccessibleName("actionPortsLess");
      expect(
        screen.queryByTestId("action-node-ports-hidden-required")
      ).toBeNull();
    });
  });

  it.each<[string, ActionNodeTestData, string[]]>([
    [
      "a reply",
      { kind: "action", actionType: "reply", actionReplyMode: "ai" },
      ["right-source"],
    ],
    [
      "a handoff",
      { kind: "action", actionType: "assign_human", actionInstruction: "Hi" },
      ["right-source"],
    ],
    [
      "a Generative AI action",
      {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_image",
          prompt: "A poster",
        },
      },
      // Created and Not created rows; older default edges keep a hidden anchor.
      [
        GENERATIVE_AI_SUCCESS_HANDLE,
        GENERATIVE_AI_FAILURE_HANDLE,
        "right-source",
      ],
    ],
  ])(
    "renders each handle of %s once, with no duplicate default output",
    (_label, data, expected) => {
      const { container } = renderNode(panelData(data));
      const ids = handleIds(container);
      expect(ids.sort()).toEqual([...expected].sort());
      expect(ids.filter(id => id === "right-source")).toHaveLength(1);
    }
  );

  it("opens node settings from its icon-only Settings button", () => {
    const data = panelData({
      kind: "action",
      actionType: "assign_human",
      actionInstruction: "Take over",
    });
    const view = renderNode(data);
    const title = resolveActionNodeCardTitle(data, t);
    const settings = screen.getByRole("button", {
      name: `nodeSettingsOpenFor:${JSON.stringify({ label: title })}`,
    });
    expect(settings).toHaveTextContent("");
    expect(settings).toHaveClass("nodrag", "nopan", "nokey");
    expect(settings).toHaveAttribute("data-scenario-node-settings", "action-1");
    expect(settings).toHaveAttribute("aria-haspopup", "dialog");
    expect(settings).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(settings, { detail: 1 });
    expect(data.uiOnOpenSettings).toHaveBeenLastCalledWith({
      moveFocus: false,
    });
    fireEvent.click(settings, { detail: 0 });
    expect(data.uiOnOpenSettings).toHaveBeenLastCalledWith({ moveFocus: true });
    view.rerenderWith({ ...data, uiIsEditorExpanded: true });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(data.uiOnPatch).not.toHaveBeenCalled();
    expect(data.uiOnSelect).not.toHaveBeenCalled();
    // The settings panel returns focus to this button when it closes.
    act(() => {
      restoreScenarioNodeFocus("action-1");
    });
    expect(settings).toHaveFocus();
  });

  it("keeps the same card whether it is selected or the graph is large", () => {
    const base = panelData({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "A launch clip",
      },
    });
    const view = renderNode(base);
    const card = screen.getByTestId("scenario-action-node-card");
    for (const next of [
      { ...base, uiIsEditorExpanded: true },
      { ...base, uiActionNodeCount: 12 },
      { ...base, uiActionNodeCount: 12, uiIsEditorExpanded: true },
    ]) {
      view.rerenderWith(next);
      expect(screen.getByTestId("scenario-action-node-card")).toBe(card);
      expect(screen.queryByTestId("generative-ai-editor")).toBeNull();
    }
  });

  it("summarizes conditions and attachments as chips", () => {
    renderNode(
      panelData({
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "See attached",
        actionAttachments: [
          { url: "https://cdn.example.com/menu.pdf", mediaType: "document" },
          { url: "https://cdn.example.com/photo.png", mediaType: "image" },
        ],
        actionRunConditions: {
          version: 1,
          match: "all",
          conditions: [{ id: "gate-1", type: "has_purchase_history" }],
        },
        bulkRecipientCount: 120,
      })
    );
    const conditions = screen.getByText('actionCardRunIfCount:{"count":1}');
    expect(conditions.closest("[data-slot='badge']")).not.toBeNull();
    expect(
      conditions
        .closest("[data-slot='badge']")
        ?.querySelector(".lucide-list-filter")
    ).not.toBeNull();
    expect(
      screen.getByText('actionCardAttachmentCount:{"count":2}')
    ).toBeInTheDocument();
    expect(
      screen.getByText('columnSplitPathRecipientCount:{"count":120}')
    ).toBeInTheDocument();
  });

  it("names a Generative AI step by its title, with no mode chip", () => {
    const data = panelData({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_image",
        prompt: "A poster",
      },
    });
    renderNode(data);
    expect(screen.getByTestId("action-node-title")).toHaveTextContent(
      resolveActionNodeCardTitle(data, t)
    );
    expect(screen.queryByText("generativeAIModeImage")).toBeNull();
    expect(screen.queryByText(/T2V|I2V/)).toBeNull();
    const preview = screen.getByTestId("action-node-card-preview");
    expect(preview).toHaveTextContent("A poster");
    expect(preview).not.toHaveAttribute("title");
  });

  it.each<[string, ActionNodeTestData, string, "draft" | "runnable", boolean]>([
    [
      "a fixed reply with no text",
      { kind: "action", actionType: "reply", actionReplyMode: "fixed" },
      "actionPreviewEmpty",
      "runnable",
      true,
    ],
    [
      "a fixed reply with no text in a draft",
      { kind: "action", actionType: "reply", actionReplyMode: "fixed" },
      "actionPreviewEmpty",
      "draft",
      false,
    ],
    [
      "a handoff with no message",
      { kind: "action", actionType: "assign_human" },
      "handoffPreviewEmpty",
      "runnable",
      false,
    ],
    [
      "a template step with no template",
      { kind: "action", actionType: "whatsapp_template" },
      "templatePreviewEmpty",
      "runnable",
      true,
    ],
  ])(
    "shows the empty state of %s",
    (_label, data, text, uiValidationMode, warns) => {
      renderNode(panelData({ ...data, uiValidationMode }));
      const preview = screen.getByTestId("action-node-card-preview");
      expect(preview).toHaveTextContent(text);
      expect(preview).toHaveClass("italic");
      expect(Boolean(preview.querySelector(".lucide-triangle-alert"))).toBe(
        warns
      );
    }
  );

  it("names the choice that leads to the step once", () => {
    const view = renderNode(
      panelData({
        kind: "action",
        actionType: "reply",
        actionReplyText: "Prices",
        whatsAppSessionChoiceLabel: "Yes",
        uiIncomingRouteCount: 1,
      })
    );
    expect(screen.getByTestId("action-node-branch-context")).toHaveTextContent(
      'canvasAfterChoice:{"label":"Yes"}'
    );
    view.rerenderWith(
      panelData({
        kind: "action",
        actionType: "reply",
        actionReplyText: "Prices",
        whatsAppSessionChoiceLabel: "Yes",
        uiIncomingRouteCount: 3,
      })
    );
    expect(screen.queryByTestId("action-node-branch-context")).toBeNull();
  });

  it.each<[string, ActionNodeTestData, boolean]>([
    [
      "a WhatsApp chat message",
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: { kind: "text", body: { mode: "fixed", text: "Still?" } },
        },
      },
      true,
    ],
    [
      "a template",
      {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "follow_up",
      },
      false,
    ],
  ])(
    "warns when %s follows a No reply of a day or more: %s",
    (_label, data, warns) => {
      renderNode(panelData({ ...data, uiReachedAfterLongNoReply: true }));
      const notice = screen.queryByTestId("action-node-long-wait-notice");
      expect(Boolean(notice)).toBe(warns);
      if (notice) {
        expect(notice).toHaveTextContent("actionLongWaitNeedsTemplate");
        expect(notice).not.toHaveAttribute("role");
      }
    }
  );

  describe("a default route that a linked outcome keeps from running", () => {
    const noReplyOn = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 30 },
    };
    const serviceText: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
    };
    const linked = (...sourceHandleIds: string[]) => ({
      uiConnections: { sourceHandleIds },
    });
    const notice = () =>
      screen.queryByTestId("action-node-unreachable-route-notice");

    it("names the linked route and points to Any reply", () => {
      renderNode(
        panelData({
          ...serviceText,
          actionOutcomes: noReplyOn,
          ...linked(ACTION_NO_REPLY_OUTCOME_HANDLE_ID, "right-source"),
        })
      );
      expect(notice()).toHaveTextContent(
        `actionDefaultRouteCannotRun:${JSON.stringify({
          route: "serviceRouteNextMessage",
          anyReply: "actionOutcomeAnyReply",
          anyReplyLinked: "no",
        })}`
      );
      expect(notice()).not.toHaveAttribute("role");
      expect(notice()).toHaveAttribute("data-tone", "warning");
      // The route keeps its row, so its edge can be deleted.
      expect(rowHandleIds()).toContain("right-source");
    });

    it("says replies already go to a linked Any reply", () => {
      renderNode(
        panelData({
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "promo",
          actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Hi" }],
          actionOutcomes: { version: 1, anyReply: { enabled: true } },
          ...linked(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID, "right-source"),
        })
      );
      expect(notice()).toHaveTextContent(
        `actionDefaultRouteCannotRun:${JSON.stringify({
          route: "actionPortNextStep",
          anyReply: "actionOutcomeAnyReply",
          anyReplyLinked: "yes",
        })}`
      );
    });

    it.each<[string, ActionNodeTestData]>([
      [
        "a linked Form submitted",
        {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Open the form" },
              flowConfig: { ...testFlowConfig(), screens: [] },
            },
          },
          actionOutcomes: noReplyOn,
          ...linked(ACTION_NO_REPLY_OUTCOME_HANDLE_ID, "right-source"),
        },
      ],
      [
        "a linked Details collected",
        {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: { kind: "text", body: { mode: "fixed", text: "Name?" } },
            promptInputs: [{ key: "name", label: "Name", prompt: "Your name" }],
          },
          actionOutcomes: noReplyOn,
          ...linked(ACTION_NO_REPLY_OUTCOME_HANDLE_ID, "right-source"),
        },
      ],
      [
        "an unlinked Reply",
        {
          ...serviceText,
          actionOutcomes: noReplyOn,
          ...linked(ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
        },
      ],
      [
        "a linked Reply while no outcome is linked",
        {
          ...serviceText,
          actionOutcomes: noReplyOn,
          ...linked("right-source"),
        },
      ],
    ])("says nothing for %s", (_label, data) => {
      renderNode(panelData(data));
      expect(notice()).toBeNull();
    });

    it("drops the unlinked Reply row and keeps its anchor", () => {
      const { container } = renderNode(
        panelData({
          ...serviceText,
          actionOutcomes: noReplyOn,
          ...linked(ACTION_NO_REPLY_OUTCOME_HANDLE_ID),
        })
      );
      expect(rowHandleIds()).toEqual([ACTION_NO_REPLY_OUTCOME_HANDLE_ID]);
      expect(handleIds(container)).toContain("right-source");
      expect(screen.queryByText(/actionPortsMore/)).toBeNull();
    });
  });

  it("deletes the step from its menu and offers an undo", async () => {
    const user = userEvent.setup();
    const undo = jest.fn(() => true);
    const data = panelData({
      kind: "action",
      actionType: "reply",
      actionReplyText: "Hi",
    });
    renderNode(data, false, node => (
      <ScenarioGraphUndoContext.Provider
        value={{ undo, redo: jest.fn(), canUndo: true, canRedo: false }}
      >
        {node}
      </ScenarioGraphUndoContext.Provider>
    ));
    expect(screen.queryByRole("button", { name: "removeBlock" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "stepActions" }));
    await user.click(screen.getByRole("menuitem", { name: "removeBlock" }));
    expect(data.uiOnRemove).toHaveBeenCalledTimes(1);
    const [message, options] = mockToast.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("stepDeleted");
    expect(options.action.label).toBe("whatsappServiceUndo");
    options.action.onClick();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  describe("keyboard and pointer", () => {
    function renderOnCanvas(data: ScenarioActionEditorNodeData) {
      const onCanvasClick = jest.fn();
      const onCanvasKeyDown = jest.fn();
      const onCanvasPointerDown = jest.fn();
      const view = renderNode(data, false, node => (
        <div
          onClick={onCanvasClick}
          onKeyDown={onCanvasKeyDown}
          onPointerDown={onCanvasPointerDown}
        >
          {node}
        </div>
      ));
      return { ...view, onCanvasClick, onCanvasKeyDown, onCanvasPointerDown };
    }

    const busyData = () =>
      panelData({
        kind: "action",
        actionType: "reply",
        actionReplyChannel: "instagram",
        actionReplyMode: "ai",
        uiInstagramReplyDisabledReason: "Bulk campaigns cannot send it",
        actionOutcomes: {
          ...OUTCOMES,
          answerMatches: Array.from({ length: 8 }, (_, index) => ({
            id: `answer_${index}`,
            text: `Answer ${index}`,
            mode: "exact" as const,
          })),
        },
      });

    it("tabs through the info hint, settings, step menu, routes and “+N more”", async () => {
      const user = userEvent.setup();
      const data = busyData();
      renderOnCanvas(data);
      const card = screen.getByTestId("scenario-action-node-card");
      await user.tab();
      expect(document.activeElement).toBe(
        within(card).getByRole("button", {
          name: 'infoHintLabel:{"topic":"instagramReplyDisabledBadge"}',
        })
      );
      await user.tab();
      expect(document.activeElement).toHaveAttribute(
        "data-scenario-node-settings",
        "action-1"
      );
      await user.tab();
      expect(document.activeElement).toBe(
        within(card).getByRole("button", { name: "stepActions" })
      );
      await user.tab();
      expect(document.activeElement).toBe(
        within(screen.getAllByTestId("action-node-port")[0]).getByRole("button")
      );
      for (let index = 1; index < 8; index += 1) await user.tab();
      await user.tab();
      expect(document.activeElement).toHaveAttribute("aria-expanded", "false");
      expect(document.activeElement).toHaveTextContent(/actionPortsMore/);
    });

    it("keeps Enter, Space and Escape on card controls away from the node", async () => {
      const user = userEvent.setup();
      const data = busyData();
      const { onCanvasKeyDown } = renderOnCanvas(data);
      const card = screen.getByTestId("scenario-action-node-card");
      const controls = [
        within(card).getByRole("button", {
          name: 'infoHintLabel:{"topic":"instagramReplyDisabledBadge"}',
        }),
        within(card).getByRole("button", { name: "stepActions" }),
        within(screen.getByTestId("action-node-ports-more")).getByRole(
          "button"
        ),
      ];
      for (const control of controls) {
        for (const key of ["Enter", " ", "Escape"]) {
          fireEvent.keyDown(control, { key });
        }
      }
      expect(onCanvasKeyDown).not.toHaveBeenCalled();
      expect(data.uiOnOpenSettings).not.toHaveBeenCalled();
      expect(data.uiOnSelect).not.toHaveBeenCalled();

      await user.keyboard("{Escape}");
      expect(data.uiOnSelect).not.toHaveBeenCalled();
    });

    it("keeps clicks on the info hint and “+N more” from selecting the node", async () => {
      const user = userEvent.setup();
      const data = busyData();
      const { onCanvasClick, onCanvasPointerDown } = renderOnCanvas(data);
      const card = screen.getByTestId("scenario-action-node-card");
      await user.click(
        within(card).getByRole("button", {
          name: 'infoHintLabel:{"topic":"instagramReplyDisabledBadge"}',
        })
      );
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "Bulk campaigns cannot send it"
      );
      await user.click(
        within(screen.getByTestId("action-node-ports-more")).getByRole("button")
      );
      expect(onCanvasClick).not.toHaveBeenCalled();
      expect(onCanvasPointerDown).not.toHaveBeenCalled();
      expect(data.uiOnOpenSettings).not.toHaveBeenCalled();
    });
  });

  describe("builder actions", () => {
    const serviceMessage = (
      message: Record<string, unknown>
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message,
      } as ActionNodeTestData["actionWhatsAppServiceMessage"],
    });

    // Meta returns DemoShop's Flow id as a number.
    const formTemplate: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "demoshop_test",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Tell us about the athlete" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "Open form", flow_id: 1571793974235171 },
          ],
        },
      ],
    };

    const BUILDER_CASES: Array<{
      label: string;
      data: ActionNodeTestData;
      title: string;
      rows: string[];
      /** Option texts that name their own rows. */
      labels: string[];
    }> = [
      {
        label: "reply buttons with outcomes",
        data: {
          ...serviceMessage({
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose" },
            options: [
              { id: testChoiceId("one"), label: "One" },
              { id: testChoiceId("two"), label: "Two" },
              { id: testChoiceId("three"), label: "" },
            ],
          }),
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        },
        title: WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.reply_buttons,
        rows: [
          testChoiceHandle("one"),
          testChoiceHandle("two"),
          testChoiceHandle("three"),
          ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
          ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        ],
        labels: ["One", "Two"],
      },
      {
        label: "a list",
        data: serviceMessage({
          kind: "list",
          body: { mode: "fixed", text: "Pick a row" },
          buttonLabel: "Menu",
          sections: [
            {
              id: "main",
              title: "Main",
              rows: [
                { id: testChoiceId("r1"), title: "Delivery" },
                { id: testChoiceId("r2"), title: "Pickup" },
              ],
            },
          ],
        }),
        title: WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.list,
        rows: [testChoiceHandle("r1"), testChoiceHandle("r2")],
        labels: ["Delivery", "Pickup"],
      },
      {
        label: "a media carousel",
        data: serviceMessage({
          kind: "media_carousel",
          body: { mode: "fixed", text: "Pick a model" },
          cards: testCarouselCards(["c1", "c2"]),
        }),
        title: WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.media_carousel,
        rows: [
          testChoiceHandle("c1-buy"),
          testChoiceHandle("c1-info"),
          testChoiceHandle("c2-buy"),
          testChoiceHandle("c2-info"),
        ],
        labels: [],
      },
      {
        label: "a Flow with choices",
        data: serviceMessage({
          kind: "flow",
          body: { mode: "fixed", text: "Open the form" },
          flowConfig: testFlowConfig(),
        }),
        // An unnamed form is named by its kind, never by its provider ID.
        title: WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.flow,
        rows: [
          buildFlowBranchSourceHandleId("field_1", "opt_1"),
          buildFlowBranchSourceHandleId("field_1", "opt_2"),
        ],
        labels: [],
      },
      {
        label: "an appointment",
        data: serviceMessage({
          kind: "appointment",
          body: { mode: "fixed", text: "Book a call" },
          config: { enabled: true, maxSlots: 5, timeZone: "UTC" },
        }),
        title: WHATSAPP_SERVICE_MESSAGE_KIND_LABEL_KEYS.appointment,
        rows: ["right-source"],
        labels: [],
      },
      {
        label: "a template with quick replies",
        data: {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "order_update",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Hello" },
            {
              type: "BUTTONS",
              buttons: [
                { type: "QUICK_REPLY", text: "Track" },
                { type: "QUICK_REPLY", text: "Cancel" },
              ],
            },
          ],
        },
        title: "order_update",
        rows: [
          buildWhatsAppTemplateButtonSourceHandleId(0),
          buildWhatsAppTemplateButtonSourceHandleId(1),
          "right-source",
        ],
        labels: ["Track", "Cancel"],
      },
      {
        label: "a template with a form button",
        data: formTemplate,
        title: "demoshop_test",
        rows: [
          ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
          "right-source",
        ],
        labels: ["serviceRouteFlowSubmitted"],
      },
      {
        label: "a Telegram reply",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyText: "Choose",
          actionTelegramQuickReplies: [
            [
              { text: "Yes", payload: "yes" },
              { text: "No", payload: "no" },
            ],
            [{ text: "Later", payload: "later" }],
          ],
        },
        title: "presetActionTelegramBuilder",
        rows: [
          buildTelegramBranchSourceHandleId("yes"),
          buildTelegramBranchSourceHandleId("no"),
          buildTelegramBranchSourceHandleId("later"),
        ],
        labels: ["Yes", "No", "Later"],
      },
      {
        label: "an Instagram reply",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "instagram",
          actionReplyMode: "fixed",
          actionReplyText: "Hi",
          actionInstagramConfig: {
            kind: "quick_replies",
            quickReplies: [
              { title: "Pricing", payload: "pricing" },
              { title: "Support", payload: "support" },
            ],
          },
        },
        title: "presetActionInstagramReply",
        // Instagram options share one route.
        rows: [ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID],
        labels: ["Pricing, Support"],
      },
    ];

    it.each(BUILDER_CASES)(
      "renders $label as a read-only card with a port per unlinked route",
      ({ data, title, rows, labels }) => {
        const nodeData = panelData(data);
        const { container } = renderNode(nodeData);
        const card = screen.getByTestId("scenario-action-node-card");
        expect(within(card).getByTestId("action-node-title")).toHaveTextContent(
          title
        );
        expect(card).not.toHaveTextContent("flow-1");
        // Read-only: the builders edit in node settings.
        expect(within(card).queryByRole("textbox")).toBeNull();
        expect(within(card).queryByRole("combobox")).toBeNull();
        expect(screen.queryByTestId("action-source-controls")).toBeNull();

        expect(rowHandleIds()).toEqual(rows);
        expect(rowTitles()).toEqual(portTitles(nodeData));
        expect(rowTitles()).toEqual(expect.arrayContaining(labels));
        for (const handleId of rows) {
          const port = handleElement(container, handleId);
          expect(port?.closest("[data-testid='action-node-port']")).not.toBe(
            null
          );
          expect(port).toHaveAttribute("data-route-status", "unlinked");
          expect(port).toHaveAttribute("role", "button");
        }
        expectEachAcceptedHandleOnce(container, data);
      }
    );

    it("names a template's Form submitted dot and its next step", () => {
      const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
      const { rerenderWith } = renderNode(panelData(formTemplate));
      // The dot is named by its route, then by its status.
      const unlinked = screen.getByRole("button", {
        name: /^serviceRouteFlowSubmitted\. /,
      });
      expect(unlinked).toHaveAttribute("data-handle-id", FORM_SUBMITTED);
      const row = unlinked.closest<HTMLElement>(
        "[data-testid='action-node-port']"
      )!;
      // The row leads with the form button's icon.
      expect(row.querySelector(".lucide-clipboard-list")).not.toBeNull();

      rerenderWith(
        panelData({
          ...formTemplate,
          uiConnections: {
            sourceHandleIds: [FORM_SUBMITTED],
            destinationsBySourceHandle: new Map([
              [FORM_SUBMITTED, { nodeId: "carousel", label: "Carousel" }],
            ]),
          },
        })
      );
      const linked = handleElement(document.body, FORM_SUBMITTED)!;
      expect(linked).toHaveAttribute(
        "aria-label",
        expect.stringMatching(/^serviceRouteFlowSubmitted\. .*Carousel$/)
      );
      expect(linked).toHaveAttribute("data-route-status", "linked");
      expect(
        linked.closest("[data-testid='action-node-port']")
      ).toHaveTextContent("Carousel");
    });

    // A template that lost its form button but kept the route's edge. Mid
    // right edge, the anchor sat on the "Yes" dot, so the edge passed for
    // that button's route while its row said "Not connected".
    it.each([
      ["card", panelData],
      ["compact card", compactData],
    ])(
      "draws a stale Form submitted edge from the %s's top right corner and says why it can't run",
      (_label, toNodeData) => {
        const FORM_SUBMITTED =
          ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
        const data: ActionNodeTestData = {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "f4_quick_replies",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Pick one" },
            {
              type: "BUTTONS",
              buttons: [
                { type: "QUICK_REPLY", text: "Yes" },
                { type: "QUICK_REPLY", text: "No" },
              ],
            },
          ],
          uiConnections: {
            sourceHandleIds: [FORM_SUBMITTED],
            destinationsBySourceHandle: new Map([
              [FORM_SUBMITTED, { nodeId: "message", label: "Message" }],
            ]),
          },
        };
        const { container } = renderNode(toNodeData(data));
        const anchor = handleElement(container, FORM_SUBMITTED)!;
        expect(anchor).toHaveAttribute("aria-hidden", "true");
        expect(anchor.closest("[data-testid='action-node-port']")).toBeNull();
        expect(anchor.style.top).toBe("0px");
        expect(
          handleElement(container, buildWhatsAppTemplateButtonSourceHandleId(0))
        ).toHaveAttribute("data-route-status", "unlinked");
        expect(
          screen.getByTestId("action-node-anchored-route-notice")
        ).toHaveTextContent("whatsappTemplateFormRouteUnavailable");
        expectEachAcceptedHandleOnce(container, data);
      }
    );

    // DemoShop after linking the form's route and before deleting Then.
    it.each<[string, Partial<ActionNodeTestData>, string[]]>([
      ["without outcomes", {}, []],
      [
        "beside a linked No reply",
        {
          actionOutcomes: {
            version: 1,
            noReply: { enabled: true, timeoutMinutes: 30 },
          },
        },
        [ACTION_NO_REPLY_OUTCOME_HANDLE_ID],
      ],
    ])(
      "warns that Then can't run once Form submitted is linked, %s",
      (_label, extra, outcomeHandleIds) => {
        const FORM_SUBMITTED =
          ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
        const carousel = { nodeId: "carousel", label: "Carousel" };
        renderNode(
          panelData({
            ...formTemplate,
            ...extra,
            uiConnections: {
              sourceHandleIds: [
                FORM_SUBMITTED,
                "right-source",
                ...outcomeHandleIds,
              ],
              destinationsBySourceHandle: new Map([
                [FORM_SUBMITTED, carousel],
                ["right-source", carousel],
              ]),
            },
          })
        );
        const notice = screen.getByTestId(
          "action-node-unreachable-route-notice"
        );
        expect(notice).toHaveTextContent(
          `actionDefaultRouteCannotRunFormSubmitted:${JSON.stringify({
            route: "actionPortNextStep",
            formSubmitted: "serviceRouteFlowSubmitted",
          })}`
        );
        expect(notice).toHaveAttribute("data-tone", "warning");
        // Then keeps its row up front, so its edge can be deleted.
        expect(rowHandleIds().slice(0, 2)).toEqual([
          FORM_SUBMITTED,
          "right-source",
        ]);
        expect(screen.queryByTestId("action-node-ports-more")).toBeNull();
      }
    );

    it("names carousel choices by card and linked rows by destination", () => {
      renderNode(
        panelData({
          ...serviceMessage({
            kind: "media_carousel",
            body: { mode: "fixed", text: "Pick a model" },
            cards: testCarouselCards(["c1", "c2"]),
          }),
          uiConnections: {
            whatsAppChoicePayloads: [testChoiceId("c2-buy")],
            destinationsBySourceHandle: new Map([
              [
                testChoiceHandle("c2-buy"),
                { nodeId: "checkout", label: "Checkout" },
              ],
            ]),
          },
        })
      );
      const linked = screen
        .getAllByTestId("action-node-port")
        .find(row => row.dataset.connected === "true")!;
      expect(linked).toHaveTextContent(
        'whatsappTemplateBindingCard:{"index":2} · Buy'
      );
      expect(linked).toHaveTextContent("Checkout");
      expect(handleElement(linked, testChoiceHandle("c2-buy"))).toHaveAttribute(
        "data-route-status",
        "linked"
      );
    });

    const range = (count: number) =>
      Array.from({ length: count }, (_, index) => index);
    const answerRules = (count: number) =>
      range(count).map(index => ({
        id: `answer_${index}`,
        text: `Answer ${index}`,
        mode: "exact" as const,
      }));
    const body = { mode: "fixed", text: "Choose" };
    const OVERFLOW_CASES: Array<[string, ActionNodeTestData]> = [
      [
        "reply buttons with outcomes",
        {
          ...serviceMessage({
            kind: "reply_buttons",
            body,
            options: range(3).map(index => ({
              id: testChoiceId(`b${index}`),
              label: `Button ${index}`,
            })),
          }),
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
            noReply: { enabled: true, timeoutMinutes: 30 },
            answerMatches: answerRules(4),
            paymentDetected: { enabled: true },
          },
        },
      ],
      [
        "a list",
        serviceMessage({
          kind: "list",
          body,
          buttonLabel: "Menu",
          sections: [
            {
              id: "main",
              title: "Main",
              rows: range(10).map(index => ({
                id: testChoiceId(`r${index}`),
                title: `Row ${index}`,
              })),
            },
          ],
        }),
      ],
      [
        "a media carousel",
        serviceMessage({
          kind: "media_carousel",
          body,
          cards: testCarouselCards(range(5).map(index => `c${index}`)),
        }),
      ],
      [
        "a Flow with choices",
        serviceMessage({
          kind: "flow",
          body,
          flowConfig: testFlowConfig(
            range(10).map(index => ({
              id: `opt_${index}`,
              title: `Option ${index}`,
            }))
          ),
        }),
      ],
      [
        "a template with quick replies",
        {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "menu",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Hello" },
            {
              type: "BUTTONS",
              buttons: range(10).map(index => ({
                type: "QUICK_REPLY",
                text: `Reply ${index}`,
              })),
            },
          ],
        },
      ],
      [
        "a Telegram reply",
        {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyText: "Choose",
          actionTelegramQuickReplies: range(10).map(index => [
            { text: `Button ${index}`, payload: `b${index}` },
          ]),
        },
      ],
      [
        "an Instagram reply with outcomes",
        {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "instagram",
          actionReplyMode: "fixed",
          actionReplyText: "Hi",
          actionInstagramConfig: {
            kind: "quick_replies",
            quickReplies: [{ title: "Pricing", payload: "pricing" }],
          },
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
            noReply: { enabled: true, timeoutMinutes: 30 },
            answerMatches: answerRules(6),
            paymentDetected: { enabled: true },
          },
        },
      ],
    ];

    it.each(OVERFLOW_CASES)(
      "shows the first eight routes of %s and anchors the rest",
      async (_label, data) => {
        const user = userEvent.setup();
        const nodeData = panelData(data);
        const titles = portTitles(nodeData);
        const { container } = renderNode(nodeData);
        expect(screen.getAllByTestId("action-node-port")).toHaveLength(8);
        expect(rowTitles()).toEqual(titles.slice(0, 8));
        const more = screen.getByTestId("action-node-ports-more");
        expect(more).toHaveTextContent(
          `actionPortsMore:${JSON.stringify({ count: titles.length - 8 })}`
        );
        // Routes past the rows keep anchors on the "+N more" row.
        const rowIds = new Set(rowHandleIds());
        const anchors = availableSourceHandlesFor(data).filter(
          id => !rowIds.has(id)
        );
        for (const handleId of anchors) {
          const anchor = handleElement(container, handleId);
          expect(anchor).toHaveAttribute("aria-hidden", "true");
          expect(
            anchor?.closest("[data-testid='action-node-port']")
          ).toBeNull();
        }
        expectEachAcceptedHandleOnce(container, data);

        await user.click(within(more).getByRole("button"));
        expect(rowTitles()).toEqual(titles);
        expectEachAcceptedHandleOnce(container, data);
      }
    );

    it("flags a disabled Instagram reply and explains why on request", async () => {
      const user = userEvent.setup();
      renderNode(
        panelData({
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "instagram",
          actionReplyMode: "ai",
          uiInstagramReplyDisabledReason: "Bulk campaigns cannot send it",
        })
      );
      const card = screen.getByTestId("scenario-action-node-card");
      expect(
        within(card).getByText("instagramReplyDisabledBadge")
      ).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
      await user.click(
        within(card).getByRole("button", {
          name: 'infoHintLabel:{"topic":"instagramReplyDisabledBadge"}',
        })
      );
      expect(await screen.findByRole("dialog")).toHaveTextContent(
        "Bulk campaigns cannot send it"
      );
    });
  });

  describe("large graphs with node settings off", () => {
    it("lists linked routes and keeps unlinked ones behind “+N more”", async () => {
      const user = userEvent.setup();
      const data = compactData({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose packaging" },
            options: [
              { id: testChoiceId("packaging"), label: "Упаковка" },
              { id: testChoiceId("sizes"), label: "Размеры" },
            ],
          },
        },
        actionOutcomes: {
          version: 1,
          noReply: { enabled: true, timeoutMinutes: 30 },
        },
        uiConnections: {
          whatsAppChoicePayloads: [testChoiceId("sizes")],
          destinationsBySourceHandle: new Map([
            [
              testChoiceHandle("sizes"),
              { nodeId: "sizes", label: "Size chart {{model}}" },
            ],
          ]),
        },
      });
      const { container } = renderNode(data);
      const card = screen.getByTestId("scenario-action-node-card");
      expect(card).toHaveAttribute("data-compact", "true");
      // Settings open by selecting the card; the inline editor edits it.
      expect(
        document.querySelector("[data-scenario-node-settings]")
      ).toBeNull();
      expect(within(card).queryByRole("checkbox")).toBeNull();
      expect(card).not.toHaveTextContent(/branches|recipients|media/);

      const rows = screen.getAllByTestId("action-node-port");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("Размеры");
      expect(rows[0]).toHaveTextContent("Size chart …");
      expect(rows[0]).toHaveAttribute("data-connected", "true");
      const toggle = within(
        screen.getByTestId("action-node-ports-more")
      ).getByRole("button", { name: 'actionPortsMoreLabel:{"count":2}' });
      expectEachAcceptedHandleOnce(container, data);

      await user.click(toggle);
      const revealed = screen.getAllByTestId("action-node-port");
      expect(revealed).toHaveLength(3);
      expect(
        revealed
          .slice(1)
          .map(row =>
            row
              .querySelector("[data-route-status]")
              ?.getAttribute("data-route-status")
          )
      ).toEqual(["unlinked", "unlinked"]);
      expect(data.uiOnSelect).not.toHaveBeenCalled();
    });

    it("keeps Telegram buttons that need a next step in view", () => {
      renderNode(
        compactData({
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyText: "Choose",
          actionTelegramQuickReplies: [
            [
              { text: "Yes", payload: "yes" },
              { text: "No", payload: "no" },
            ],
            [{ text: "Later", payload: "later" }],
          ],
          uiConnections: {
            destinationsBySourceHandle: new Map([
              [
                buildTelegramBranchSourceHandleId("yes"),
                { nodeId: "yes-step", label: "Send price list" },
              ],
            ]),
          },
        })
      );
      expect(screen.getByTestId("scenario-action-node-card")).toHaveAttribute(
        "data-compact",
        "true"
      );
      expect(rowHandleIds()).toEqual(
        ["yes", "no", "later"].map(buildTelegramBranchSourceHandleId)
      );
      expect(
        screen
          .getAllByTestId("action-node-port")
          .slice(1)
          .map(row =>
            row
              .querySelector("[data-route-required]")
              ?.getAttribute("data-route-required")
          )
      ).toEqual(["true", "true"]);
      expect(screen.queryByTestId("action-node-ports-more")).toBeNull();
    });

    it("shows one row when no route is linked yet", () => {
      renderNode(
        compactData({
          kind: "action",
          actionType: "reply",
          actionReplyText: "Hello",
          actionOutcomes: {
            version: 1,
            anyReply: { enabled: true },
            noReply: { enabled: true, timeoutMinutes: 60 },
          },
        })
      );
      expect(screen.getAllByTestId("action-node-port")).toHaveLength(1);
      expect(screen.getByTestId("action-node-ports-more")).toBeInTheDocument();
    });

    it("keeps End scenario as its own terminal card", () => {
      renderNode(compactData({ kind: "action", actionType: "end_scenario" }));
      expect(screen.getByTestId("scenario-end-node")).toBeInTheDocument();
      expect(screen.queryByTestId("scenario-action-node-card")).toBeNull();
    });
  });

  it("renders End scenario as a terminal card without settings or routes", () => {
    const { container } = renderNode(
      panelData({ kind: "action", actionType: "end_scenario" }),
      true
    );
    const card = screen.getByTestId("scenario-end-node");
    expect(card).toHaveTextContent("actionEndScenarioSummary");
    expect(card.querySelector(".w-\\[300px\\]")).not.toBeNull();
    expect(
      document.querySelector("[data-scenario-node-settings]")
    ).not.toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "stepActions" })
    ).toBeInTheDocument();
    expect(handleIds(container)).toEqual([]);
  });

  it("refreshes node internals when its ports change, not on mount", () => {
    const data = panelData({ kind: "action", actionType: "reply" });
    mockUpdateNodeInternals.mockClear();
    const view = renderNode(data);
    // React Flow measures a newly mounted card and its handles itself.
    expect(mockUpdateNodeInternals).not.toHaveBeenCalled();
    view.rerenderWith({ ...data, actionReplyText: "Edited" });
    expect(mockUpdateNodeInternals).not.toHaveBeenCalled();
    view.rerenderWith({
      ...data,
      actionOutcomes: { version: 1, anyReply: { enabled: true } },
    });
    expect(mockUpdateNodeInternals).toHaveBeenCalledWith("action-1");
  });
});
