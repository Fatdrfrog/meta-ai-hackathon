/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactFlowProvider, useStoreApi } from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { isScenarioKeyboardControlTarget } from "../../scenario-keyboard-events";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import {
  testCarouselCards,
  testFlowConfig,
} from "../../nodes/action-node/action-node-test-utils";
import { ScenarioNodeSettingsButton } from "../../nodes/node-settings-button";
import type { ScenarioFlowNode, ScenarioNodeData } from "../../types";
import {
  ScenarioNodeEnrichmentProvider,
  type HandleBranchSyncForNode,
  type ScenarioDisplayNodeCallbacks,
  type ScenarioNodeEnrichmentResources,
} from "../scenario-node-enrichment-context";
import { useLatestRef } from "../use-latest-ref";
import { useScenarioDisplayNodes } from "../use-scenario-display-nodes";
import { supportsScenarioNodeSettings } from "./scenario-node-settings-content";
import {
  resolveScenarioNodeSettingsLayout,
  ScenarioNodeSettingsPanel,
  type ScenarioNodeSettingsLayout,
} from "./scenario-node-settings-panel";

const mockPanelCalls: string[] = [];
const mockPanelSizes = new Map<string, number>();
const mockPanelCollapseCallbacks = new Map<string, () => void>();

jest.mock("next-intl", () => ({
  useFormatter: () => ({
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en", options).format(value),
  }),
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
// react-resizable-panels ships ESM only. This stand-in keeps the imperative
// panel API the host drives and exposes the size it would have.
jest.mock("@/components/ui/resizable", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  function ResizablePanel({
    ref,
    id,
    minSize = 0,
    defaultSize = 0,
    onCollapse,
    children,
  }: {
    ref?: Ref<unknown>;
    id?: string;
    minSize?: number;
    defaultSize?: number;
    onCollapse?: () => void;
    children?: ReactNode;
  }) {
    // The imperative API reads the size synchronously; rendering reads state.
    const sizeRef = React.useRef(defaultSize);
    const [renderedSize, setRenderedSize] = React.useState(defaultSize);
    const setSize = (size: number) => {
      sizeRef.current = size;
      mockPanelSizes.set(String(id), size);
      setRenderedSize(size);
    };
    React.useEffect(() => {
      mockPanelSizes.set(String(id), sizeRef.current);
      // A user dragging the panel closed collapses it and reports onCollapse.
      mockPanelCollapseCallbacks.set(String(id), () => {
        setSize(0);
        onCollapse?.();
      });
    });
    React.useImperativeHandle(ref, () => ({
      collapse: () => {
        mockPanelCalls.push(`${id}:collapse`);
        setSize(0);
        onCollapse?.();
      },
      expand: () => {
        mockPanelCalls.push(`${id}:expand`);
        if (sizeRef.current === 0) setSize(minSize);
      },
      resize: (size: number) => {
        mockPanelCalls.push(`${id}:resize:${size.toFixed(1)}`);
        setSize(size);
      },
      getSize: () => sizeRef.current,
      isCollapsed: () => sizeRef.current === 0,
      isExpanded: () => sizeRef.current > 0,
    }));
    return (
      <div
        data-testid={`panel-${id}`}
        data-panel-size={renderedSize.toFixed(1)}
      >
        {children}
      </div>
    );
  }
  return {
    ResizablePanel,
    ResizableHandle: ({
      disabled,
      className,
      "aria-label": ariaLabel,
    }: {
      disabled?: boolean;
      className?: string;
      "aria-label"?: string;
    }) => (
      <div
        role="separator"
        aria-label={ariaLabel}
        data-disabled={String(Boolean(disabled))}
        className={className}
      />
    ),
  };
});
// Builder dialogs size themselves with matchMedia, which jsdom omits.
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
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
// The template creation drawer is lazy and closed in these tests.
jest.mock("@/components/whatsapp-templates/template-form-drawer", () => ({
  TemplateFormDrawer: () => null,
}));
jest.mock("../../nodes/trigger-node/message-trigger-editor", () => ({
  MessageTriggerEditor: ({
    triggerConfig,
    onChange,
  }: {
    triggerConfig: { keywordPattern?: string };
    onChange: (delta: { keywordPattern: string }) => void;
  }) => (
    <>
      <input
        aria-label="Message pattern"
        value={triggerConfig.keywordPattern ?? ""}
        onChange={event => onChange({ keywordPattern: event.target.value })}
      />
      <input
        aria-label="Commit on blur"
        defaultValue={triggerConfig.keywordPattern ?? ""}
        onBlur={event => onChange({ keywordPattern: event.target.value })}
      />
      <input aria-label="Local search" defaultValue="" />
    </>
  ),
}));

const mockSelectNodeById = jest.fn();
const mockUpdateTriggerConfigById = jest.fn();
const mockUpdateNodeById = jest.fn();

const DOCKED = resolveScenarioNodeSettingsLayout(1440);
const SHEET = resolveScenarioNodeSettingsLayout(390);

function triggerNode(id: string, keywordPattern: string): ScenarioFlowNode {
  return {
    id,
    type: "triggerNode",
    position: { x: 0, y: 0 },
    data: {
      kind: "trigger",
      triggerConfig: { messageMatchMode: "contains", keywordPattern },
    },
  };
}
function linkNode(id: string, data: Partial<ScenarioNodeData> = {}) {
  return {
    id,
    type: "scenarioLinkNode",
    position: { x: 0, y: 0 },
    data: { kind: "scenario_link", ...data },
  } as ScenarioFlowNode;
}
function actionNode(
  id: string,
  data: Omit<ScenarioNodeData, "kind">
): ScenarioFlowNode {
  return {
    id,
    type: "actionNode",
    position: { x: 0, y: 0 },
    data: { kind: "action", ...data },
  };
}
const first = triggerNode("first", "first order");
const second = triggerNode("second", "second order");
const link = linkNode("link", {
  linkedScenarioId: "renewal",
  linkedScenarioName: "Renewal follow-up",
});
const reply = actionNode("reply", {
  actionType: "reply",
  actionReplyMode: "ai",
  actionReplyInstruction: "Answer briefly",
  actionOutcomes: {
    version: 1,
    anyReply: { enabled: true },
    noReply: { enabled: true, timeoutMinutes: 30 },
    answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
    paymentDetected: { enabled: true },
  },
});
const handoff = actionNode("handoff", {
  actionType: "assign_human",
  actionInstruction: "Take over the order",
});
const generative = actionNode("generative", {
  actionType: "generative_ai",
  actionGenerativeAIConfig: {
    version: 1,
    mode: "text_to_video",
    prompt: "A launch clip",
  },
});
function serviceMessageNode(
  id: string,
  message: Record<string, unknown>,
  data: Omit<ScenarioNodeData, "kind"> = {}
) {
  return actionNode(id, {
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message,
    } as ScenarioNodeData["actionWhatsAppServiceMessage"],
    ...data,
  });
}
const buttons = serviceMessageNode(
  "buttons",
  {
    kind: "reply_buttons",
    body: { mode: "fixed", text: "Choose" },
    options: [
      { id: "wsc:buttons:one", label: "One" },
      { id: "wsc:buttons:two", label: "Two" },
    ],
  },
  {
    actionOutcomes: {
      version: 1,
      anyReply: { enabled: true },
      noReply: { enabled: true, timeoutMinutes: 30 },
      answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
      paymentDetected: { enabled: true },
    },
  }
);
const list = serviceMessageNode("list", {
  kind: "list",
  body: { mode: "fixed", text: "Pick a row" },
  buttonLabel: "Menu",
  sections: [
    {
      id: "main",
      title: "Main",
      rows: [
        { id: "wsc:list:r1", title: "Delivery", description: "Tomorrow" },
        { id: "wsc:list:r2", title: "Pickup" },
      ],
    },
  ],
});
const carousel = serviceMessageNode("carousel", {
  kind: "media_carousel",
  body: { mode: "fixed", text: "Pick a model" },
  cards: testCarouselCards(["c1", "c2"], "carousel").map(card => ({
    ...card,
    bodyText: `Model ${card.id}`,
  })),
});
const flowMessage = serviceMessageNode("flow", {
  kind: "flow",
  body: { mode: "fixed", text: "Open the form" },
  flowConfig: testFlowConfig(),
});
const detailsAsk = actionNode("details", {
  actionType: "reply",
  actionWhatsAppServiceMessage: {
    version: 1,
    message: {
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Pick one and tell us your name" },
      options: [{ id: "wsc:details:one", label: "One" }],
    },
    promptInputs: [{ key: "name", label: "Name", prompt: "the name" }],
  },
});
const template = actionNode("template", {
  actionType: "whatsapp_template",
  actionWhatsAppTemplateName: "order_update",
  actionWhatsAppTemplateLanguage: "en",
  actionWhatsAppTemplateComponents: [
    { type: "BODY", text: "Hello {{1}}" },
    {
      type: "BUTTONS",
      buttons: [
        { type: "QUICK_REPLY", text: "Track" },
        { type: "FLOW", text: "Open", flow_id: "flow-1" },
      ],
    },
  ] as ScenarioNodeData["actionWhatsAppTemplateComponents"],
  actionFlowConfig: testFlowConfig(),
});
const telegram = actionNode("telegram", {
  actionType: "reply",
  actionReplyChannel: "telegram",
  actionReplyText: "Choose",
  actionTelegramQuickReplies: [
    [
      { text: "Yes", payload: "yes" },
      { text: "No", payload: "no" },
    ],
  ],
});
const instagram = actionNode("instagram", {
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
});

const RESOURCES: ScenarioNodeEnrichmentResources = {
  activeScenarioId: "scenario-1",
  audienceOptions: {
    channels: [],
    customers: [],
    internalLabels: [],
    funnelStages: [],
    classificationCategories: [],
    metaReferralAds: [],
    metaReferralAdSets: [],
    metaReferralCampaigns: [],
    metaCampaignLabels: [],
  },
  contextItemsByOptionId: {},
  contextOptions: [],
  isCreatingSnippet: false,
  t: key => key,
  whatsAppFlows: [],
  whatsAppTemplates: [],
  workspaceId: "workspace-1",
  scenarioLinkOptions: [
    { id: "renewal", name: "Renewal follow-up" },
    { id: "win-back", name: "Win-back" },
  ],
  nodeSettingsPanelEnabled: true,
};

/** Cards expose the same Settings contract as the canvas cards. */
function Cards({
  nodes,
  withoutButton = [],
  iconOnly = false,
}: {
  nodes: ScenarioFlowNode[];
  withoutButton?: string[];
  /** The action card's header button: an icon with a tooltip. */
  iconOnly?: boolean;
}) {
  const displayNodes = useScenarioDisplayNodes(nodes);
  return (
    <>
      {displayNodes.map(node => (
        <div
          key={node.id}
          className="react-flow__node"
          data-id={node.id}
          tabIndex={0}
        >
          {node.data.uiOnOpenSettings && !withoutButton.includes(node.id) ? (
            <ScenarioNodeSettingsButton
              nodeId={node.id}
              label={`Settings ${node.id}`}
              expanded={
                "uiIsEditorExpanded" in node.data &&
                node.data.uiIsEditorExpanded === true
              }
              onOpen={node.data.uiOnOpenSettings}
              iconOnly={iconOnly}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}

type HarnessHandle = { select: (nodeId: string | null) => void };

const NO_BRANCH_SYNC: HandleBranchSyncForNode = () => {};

function Harness({
  handleRef,
  nodes,
  initialSelected,
  layout,
  ownerKey = "visit-1",
  withoutButton,
  iconOnlyButtons = false,
  resources = RESOURCES,
  onBranchSync = NO_BRANCH_SYNC,
  children,
}: {
  handleRef?: Ref<HarnessHandle>;
  nodes: ScenarioFlowNode[];
  initialSelected: string | null;
  layout: ScenarioNodeSettingsLayout;
  ownerKey?: string;
  withoutButton?: string[];
  iconOnlyButtons?: boolean;
  resources?: ScenarioNodeEnrichmentResources;
  /** Applies action type and branch changes, as the graph controller does. */
  onBranchSync?: HandleBranchSyncForNode;
  children?: ReactNode;
}) {
  const [selected, setSelected] = useState(initialSelected);
  useImperativeHandle(handleRef, () => ({ select: setSelected }));
  const handleBranchSyncForNodeRef = useLatestRef(onBranchSync);
  // The canvas starts at 72% and gives the dock the room it takes.
  const canvasPanelRef = useRef({
    getSize: () => 72 - (mockPanelSizes.get("scenario-node-settings") ?? 0),
  } as never);
  const nodeCallbacks = useMemo(
    () =>
      ({
        selectNodeById: (nodeId: string | null) => {
          mockSelectNodeById(nodeId);
          setSelected(nodeId);
        },
        updateTriggerConfigById: mockUpdateTriggerConfigById,
        updateNodeById: mockUpdateNodeById,
        removeNodeById: jest.fn(),
        // Builders load provider catalogs the way the canvas does.
        loadWhatsAppFlows: jest.fn(async () => {}),
        loadWhatsAppTemplates: jest.fn(async () => {}),
      }) as unknown as ScenarioDisplayNodeCallbacks,
    []
  );
  const nodeBridge = useMemo(
    () => ({
      nodeCallbacks,
      adoptGeneratedBulkServerUpdate: () => false,
      prepareScenarioBulkSend: async () => null,
      adoptScenarioActivation: () => false,
      onScenarioActivationBlocked: () => {},
      reconcileGeneratedJobServerUpdate: async () => ({
        status: "no_op" as const,
      }),
      prepareGeneratedJobRefresh: async () => true,
      submitGeneratedTemplateForNode: async () => true,
      submittingGeneratedTemplateNodeId: null,
      loadWhatsAppTemplateForm: async () => ({ status: "skipped" as const }),
      loadingTemplateFormNodeIds: new Set<string>(),
      publishManagedWhatsAppFlow: async () => null,
      scenarioSessionOwnerKey: ownerKey,
      publishingManagedFlowNodeId: null,
      selectExistingFlowForNodeRef: { current: jest.fn() as never },
      handleBranchSyncForNodeRef,
      openNodePickerFromHandle: jest.fn(),
    }),
    [handleBranchSyncForNodeRef, nodeCallbacks, ownerKey]
  );
  const graph = useMemo(
    () => ({ nodes, edges: [], selectedNodeId: selected }),
    [nodes, selected]
  );
  const selectedNode = nodes.find(node => node.id === selected);
  return (
    <ScenarioNodeEnrichmentProvider
      graph={graph}
      resources={resources}
      nodeBridge={nodeBridge}
      scenarioSettings={{}}
    >
      <Cards
        nodes={nodes}
        withoutButton={withoutButton}
        iconOnly={iconOnlyButtons}
      />
      <button type="button">Outside</button>
      <ScenarioNodeSettingsPanel
        nodes={nodes}
        nodeId={supportsScenarioNodeSettings(selectedNode) ? selected : null}
        layout={layout}
        canvasPanelRef={canvasPanelRef}
      />
      {children}
    </ScenarioNodeEnrichmentProvider>
  );
}

const CONNECTED_SOURCES: ScenarioNodeEnrichmentResources = {
  ...RESOURCES,
  connectedActionSources: ["whatsapp", "email"],
};
const mockBranchSync = jest.fn();

/** Nodes follow type and branch changes the way the graph controller does. */
function StatefulHarness({
  initialNodes,
  ...props
}: Omit<Parameters<typeof Harness>[0], "nodes" | "onBranchSync"> & {
  initialNodes: ScenarioFlowNode[];
}) {
  const [nodes, setNodes] = useState(initialNodes);
  const onBranchSync = useCallback<HandleBranchSyncForNode>(
    (nodeId, _descriptors, patch) => {
      mockBranchSync(nodeId, patch);
      setNodes(current =>
        current.map(node =>
          node.id === nodeId && patch
            ? ({
                ...node,
                data: { ...node.data, ...patch },
              } as ScenarioFlowNode)
            : node
        )
      );
    },
    []
  );
  return <Harness {...props} nodes={nodes} onBranchSync={onBranchSync} />;
}

/** Lets nested lazy builders (Instagram, the Flow editor) finish loading. */
async function flushNestedLazyEditors() {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function renderHost(props: Omit<Parameters<typeof Harness>[0], "handleRef">) {
  const handleRef = { current: null as HarnessHandle | null };
  const view = render(<Harness {...props} handleRef={handleRef} />);
  return {
    ...view,
    select: (nodeId: string | null) =>
      act(() => handleRef.current!.select(nodeId)),
    rerenderWith: (
      next: Partial<Omit<Parameters<typeof Harness>[0], "handleRef">>
    ) => view.rerender(<Harness {...props} {...next} handleRef={handleRef} />),
  };
}

// Editors load lazily in the app; load them up front so they render at once.
beforeAll(async () => {
  await Promise.all([
    scenarioEditorChunks.triggerNodeSettings.load(),
    scenarioEditorChunks.actionNodeSettings.load(),
    scenarioEditorChunks.whatsAppInlineEditor.load(),
    scenarioEditorChunks.whatsAppServiceMessageSection.load(),
    scenarioEditorChunks.whatsAppTemplateSection.load(),
    scenarioEditorChunks.generativeAISection.load(),
    scenarioEditorChunks.telegramReplyBuilder.load(),
  ]);
});

describe("ScenarioNodeSettingsPanel", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: unknown;
    releasePointerCapture?: unknown;
  };
  const originalPointerCapture = {
    hasPointerCapture: elementPrototype.hasPointerCapture,
    releasePointerCapture: elementPrototype.releasePointerCapture,
  };
  const rangePrototype = Range.prototype as Range & {
    getClientRects?: unknown;
    getBoundingClientRect?: unknown;
  };
  const originalRangeMethods = {
    getClientRects: rangePrototype.getClientRects,
    getBoundingClientRect: rangePrototype.getBoundingClientRect,
  };
  const originalResizeObserver = globalThis.ResizeObserver;
  beforeAll(() => {
    // Tooltips on icon-only buttons measure themselves once focused.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    // Radix Select uses pointer capture, which jsdom omits.
    HTMLElement.prototype.scrollIntoView = jest.fn();
    elementPrototype.hasPointerCapture = () => false;
    elementPrototype.releasePointerCapture = () => {};
    // Builder rich-text editors measure ranges, which jsdom cannot lay out.
    const emptyRect = () => new DOMRect(0, 0, 0, 0);
    rangePrototype.getBoundingClientRect = emptyRect;
    rangePrototype.getClientRects = () =>
      Object.assign([emptyRect()], { item: () => emptyRect() });
  });
  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    Object.assign(elementPrototype, originalPointerCapture);
    Object.assign(rangePrototype, originalRangeMethods);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockPanelCalls.length = 0;
  });

  describe("ported trigger editor behaviour (docked)", () => {
    it("edits the selected raw graph node through the trigger commands", () => {
      renderHost({
        nodes: [first, second],
        initialSelected: "first",
        layout: DOCKED,
      });
      expect(
        screen.getByRole("dialog", { name: "presetTriggerIncoming" })
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Message pattern")).toHaveValue(
        "first order"
      );
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Message pattern"), {
        target: { value: "updated order" },
      });
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
        keywordPattern: "updated order",
      });
    });

    it("offers business events without changing the trigger until chosen", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [first], initialSelected: "first", layout: DOCKED });
      screen.getByRole("combobox", { name: "triggerEditorEntryLabel" }).focus();
      await user.keyboard("{Enter}");
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("option", { name: "presetTriggerBusinessEvent" })
      );
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
        entryPointType: "business_event",
      });
    });

    it("reopens an unfinished business event without message controls", () => {
      const business = {
        ...first,
        data: {
          kind: "trigger",
          triggerConfig: { entryPointType: "business_event" },
        },
      } as ScenarioFlowNode;
      renderHost({
        nodes: [business],
        initialSelected: "first",
        layout: DOCKED,
      });
      expect(
        screen.getByRole("combobox", { name: "triggerEditorEntryLabel" })
      ).toHaveTextContent("presetTriggerBusinessEvent");
      expect(
        screen.queryByLabelText("Message pattern")
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("businessEventDraftDescription")
      ).toBeInTheDocument();
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    });

    it("switches with the selection and discards local state per node and document", () => {
      const view = renderHost({
        nodes: [first, second],
        initialSelected: "first",
        layout: DOCKED,
      });
      fireEvent.change(screen.getByLabelText("Local search"), {
        target: { value: "old search" },
      });
      view.select("second");
      expect(screen.getByLabelText("Message pattern")).toHaveValue(
        "second order"
      );
      expect(screen.getByLabelText("Local search")).toHaveValue("");
      fireEvent.change(screen.getByLabelText("Local search"), {
        target: { value: "another search" },
      });
      view.rerenderWith({ ownerKey: "visit-2" });
      expect(screen.getByLabelText("Local search")).toHaveValue("");
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });

    it("closes on Escape and returns focus to the card's Settings button", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [first], initialSelected: "first", layout: DOCKED });
      await user.click(screen.getByLabelText("Message pattern"));
      await user.keyboard("{Escape}");
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Settings first" })
        ).toHaveFocus()
      );
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    });

    it("returns focus to an icon-only Settings button on Escape", async () => {
      const user = userEvent.setup();
      renderHost({
        nodes: [first],
        initialSelected: "first",
        layout: DOCKED,
        iconOnlyButtons: true,
      });
      await user.click(screen.getByLabelText("Message pattern"));
      await user.keyboard("{Escape}");
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Settings first" })
        ).toHaveFocus()
      );
      expect(
        screen.getByRole("button", { name: "Settings first" })
      ).toHaveTextContent("");
    });

    it("falls back to the canvas node when the card has no Settings button", async () => {
      const user = userEvent.setup();
      renderHost({
        nodes: [first],
        initialSelected: "first",
        layout: DOCKED,
        withoutButton: ["first"],
      });
      await user.click(
        screen.getByRole("button", { name: "nodeSettingsClose" })
      );
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      await waitFor(() =>
        expect(
          document.querySelector('.react-flow__node[data-id="first"]')
        ).toHaveFocus()
      );
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    });

    it("lets a nested Select handle Escape first and guards canvas shortcuts", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [first], initialSelected: "first", layout: DOCKED });
      const selector = screen.getByRole("combobox", {
        name: "triggerEditorEntryLabel",
      });
      selector.focus();
      await user.keyboard("{Enter}");
      expect(
        screen.getByRole("option", { name: "presetTriggerCustomerBehavior" })
      ).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(mockSelectNodeById).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog");
      expect(isScenarioKeyboardControlTarget(dialog)).toBe(true);
      expect(
        isScenarioKeyboardControlTarget(
          screen.getByLabelText("Message pattern")
        )
      ).toBe(true);
      await user.keyboard("{Escape}");
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    });

    it("closes when the node disappears and skips QR and continuation entries", () => {
      const view = renderHost({
        nodes: [first],
        initialSelected: "first",
        layout: DOCKED,
      });
      view.rerenderWith({ nodes: [] });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      view.rerenderWith({
        nodes: [
          { ...first, data: { kind: "trigger", linkedConditionId: "p" } },
        ],
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      view.rerenderWith({
        nodes: [
          {
            ...first,
            data: {
              kind: "trigger",
              triggerConfig: { entryPointType: "whatsapp_qr" },
            },
          },
        ],
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
    });
  });

  describe("docked and mobile hosts", () => {
    it("docks a non-modal panel that expands to the default width and collapses on close", () => {
      const view = renderHost({
        nodes: [first],
        initialSelected: null,
        layout: DOCKED,
      });
      expect(
        screen.getByTestId("panel-scenario-node-settings")
      ).toHaveAttribute("data-panel-size", "0.0");
      expect(screen.getByRole("separator")).toHaveClass("hidden");
      view.select("first");
      const panel = screen.getByTestId("panel-scenario-node-settings");
      const dialog = screen.getByRole("dialog");
      expect(panel).toContainElement(dialog);
      expect(dialog).toHaveAttribute("id", "scenario-node-settings-panel");
      expect(dialog).not.toHaveAttribute("aria-modal");
      expect(document.querySelector("[data-slot=sheet-overlay]")).toBeNull();
      expect(mockPanelCalls).toEqual([
        "scenario-node-settings:expand",
        `scenario-node-settings:resize:${DOCKED.settingsDefaultSize.toFixed(1)}`,
      ]);
      expect(panel).toHaveAttribute(
        "data-panel-size",
        DOCKED.settingsDefaultSize.toFixed(1)
      );
      expect(screen.getByRole("separator")).not.toHaveClass("hidden");
      expect(screen.getByRole("separator")).toHaveAttribute(
        "aria-label",
        "nodeSettingsResize"
      );
      // Canvas controls outside the non-modal panel stay interactive.
      expect(
        screen.getByRole("button", { name: "Outside" })
      ).not.toHaveAttribute("aria-hidden");
      view.select(null);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockPanelCalls.at(-1)).toBe("scenario-node-settings:collapse");
      expect(mockSelectNodeById).not.toHaveBeenCalled();
      view.select("first");
      // Reopening restores the last width instead of resizing again.
      expect(mockPanelCalls.slice(-1)).toEqual([
        "scenario-node-settings:expand",
      ]);
    });

    it("takes the first width from the canvas without shrinking the scenario list", () => {
      // At 1024px the default 440px dock would push the canvas below 320px.
      const tight = resolveScenarioNodeSettingsLayout(1024);
      const view = renderHost({
        nodes: [first],
        initialSelected: null,
        layout: tight,
      });
      view.select("first");
      const settingsSize = mockPanelSizes.get("scenario-node-settings")!;
      expect(settingsSize).toBeLessThan(tight.settingsDefaultSize);
      expect(settingsSize).toBeGreaterThanOrEqual(tight.settingsMinSize);
      expect(72 - settingsSize).toBeCloseTo(tight.canvasMinSize, 5);
    });

    it("closes the settings when the dock is dragged closed", () => {
      renderHost({ nodes: [first], initialSelected: "first", layout: DOCKED });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      act(() => mockPanelCollapseCallbacks.get("scenario-node-settings")!());
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("uses the modal sheet on narrow layouts and keeps the dock collapsed", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [link], initialSelected: "link", layout: SHEET });
      const dialog = screen.getByRole("dialog", { name: "Renewal follow-up" });
      expect(
        screen.getByTestId("panel-scenario-node-settings")
      ).not.toContainElement(dialog);
      expect(dialog).toHaveAttribute("id", "scenario-node-settings-panel");
      expect(mockPanelCalls).toEqual([]);
      expect(screen.getByRole("separator", { hidden: true })).toHaveClass(
        "hidden"
      );
      await user.click(
        screen.getByRole("button", { name: "nodeSettingsClose" })
      );
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Settings link" })
        ).toHaveFocus()
      );
    });

    it("renders sub-scenario link settings through the link commands", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [link], initialSelected: "link", layout: DOCKED });
      expect(
        screen.getByRole("dialog", { name: "Renewal follow-up" })
      ).toHaveAccessibleDescription("nodeSettingsLinkDescription");
      await user.click(
        screen.getByRole("combobox", { name: "scenarioLinkSettingsLabel" })
      );
      await user.click(screen.getByRole("option", { name: "Win-back" }));
      expect(mockUpdateNodeById).toHaveBeenCalledWith("link", {
        linkedScenarioId: "win-back",
        linkedScenarioName: "Win-back",
      });
    });

    it("truncates a long node label and keeps it available as a title", () => {
      const longName = "A very long scenario name ".repeat(8).trim();
      renderHost({
        nodes: [linkNode("link", { linkedScenarioName: longName })],
        initialSelected: "link",
        layout: DOCKED,
      });
      const title = screen.getByRole("heading", { name: longName });
      expect(title).toHaveClass("truncate");
      expect(title).toHaveAttribute("title", longName);
    });
  });

  describe("focus", () => {
    it("leaves focus on the card when a pointer opens the panel", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [first], initialSelected: null, layout: DOCKED });
      const settings = screen.getByRole("button", { name: "Settings first" });
      await user.click(settings);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(settings).toHaveFocus();
      expect(settings).toHaveAttribute("aria-expanded", "true");
      expect(settings).toHaveAttribute(
        "aria-controls",
        "scenario-node-settings-panel"
      );
      expect(settings).toHaveAttribute("aria-haspopup", "dialog");
    });

    it("moves focus into the panel when the keyboard opens or re-targets it", async () => {
      const user = userEvent.setup();
      renderHost({
        nodes: [first, second],
        initialSelected: null,
        layout: DOCKED,
      });
      screen.getByRole("button", { name: "Settings first" }).focus();
      await user.keyboard("{Enter}");
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(dialog).toHaveFocus());
      // Keyboard activation of the open node's button returns into the panel.
      screen.getByRole("button", { name: "Settings first" }).focus();
      await user.keyboard("{Enter}");
      expect(dialog).toHaveFocus();
      // Switching from the keyboard moves focus into the replacement panel.
      screen.getByRole("button", { name: "Settings second" }).focus();
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(screen.getByRole("dialog")).toHaveAttribute(
          "data-scenario-node-settings-panel",
          "second"
        )
      );
      await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
    });

    it("ignores Escape outside the panel", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [first], initialSelected: "first", layout: DOCKED });
      screen.getByRole("button", { name: "Outside" }).focus();
      await user.keyboard("{Escape}");
      expect(mockSelectNodeById).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("does not pull focus to the card when closing without focus inside", async () => {
      const view = renderHost({
        nodes: [first],
        initialSelected: "first",
        layout: DOCKED,
      });
      const outside = screen.getByRole("button", { name: "Outside" });
      outside.focus();
      view.select(null);
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(outside).toHaveFocus();
    });
  });

  describe("commit-on-blur fields", () => {
    async function typeIntoCommitOnBlurField(text: string) {
      const user = userEvent.setup();
      const field = screen.getByLabelText("Commit on blur");
      await user.click(field);
      await user.clear(field);
      await user.type(field, text);
      expect(field).toHaveFocus();
      expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
      return user;
    }

    it("save to the closing node when a pane press closes the panel", async () => {
      const view = renderHost({
        nodes: [first, second],
        initialSelected: "first",
        layout: DOCKED,
      });
      await typeIntoCommitOnBlurField("typed before close");
      // The canvas keeps focus where it is on press (d3-zoom), then closes.
      fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
        keywordPattern: "typed before close",
      });
      view.select(null);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledTimes(1);
      // A pointer close leaves focus with the pointer, not on the card.
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(
        screen.getByRole("button", { name: "Settings first" })
      ).not.toHaveFocus();
    });

    it("save to the previous node when another card is pressed", async () => {
      const view = renderHost({
        nodes: [first, second],
        initialSelected: "first",
        layout: DOCKED,
      });
      await typeIntoCommitOnBlurField("first order edited");
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Settings second" })
      );
      view.select("second");
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledTimes(1);
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
        keywordPattern: "first order edited",
      });
      expect(screen.getByLabelText("Message pattern")).toHaveValue(
        "second order"
      );
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(screen.getByRole("dialog")).not.toHaveFocus();
    });

    it("save before Escape closes the panel and return focus to the card", async () => {
      const view = renderHost({
        nodes: [first],
        initialSelected: "first",
        layout: DOCKED,
      });
      const user = await typeIntoCommitOnBlurField("typed before escape");
      await user.keyboard("{Escape}");
      expect(mockUpdateTriggerConfigById).toHaveBeenCalledWith("first", {
        keywordPattern: "typed before escape",
      });
      expect(mockSelectNodeById).toHaveBeenCalledWith(null);
      expect(view.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Settings first" })
        ).toHaveFocus()
      );
    });
  });

  describe("programmatic selection changes", () => {
    it("return focus to the card when focused settings close", async () => {
      const user = userEvent.setup();
      const view = renderHost({
        nodes: [first],
        initialSelected: "first",
        layout: DOCKED,
      });
      await user.click(screen.getByLabelText("Message pattern"));
      view.select(null);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Settings first" })
        ).toHaveFocus()
      );
    });

    it("keep focus in the settings when focused settings switch nodes", async () => {
      const user = userEvent.setup();
      const view = renderHost({
        nodes: [first, second],
        initialSelected: "first",
        layout: DOCKED,
      });
      await user.click(screen.getByLabelText("Message pattern"));
      view.select("second");
      await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-scenario-node-settings-panel",
        "second"
      );
    });
  });

  describe("actions", () => {
    it.each([
      ["a plain reply", true, { actionType: "reply" }],
      [
        "an email reply",
        true,
        { actionType: "reply", actionReplyChannel: "email" },
      ],
      [
        "a web widget reply",
        true,
        { actionType: "reply", actionReplyChannel: "web_widget" },
      ],
      [
        "a WhatsApp reply without a service message",
        true,
        { actionType: "reply", actionReplyChannel: "whatsapp" },
      ],
      ["a handoff", true, { actionType: "assign_human" }],
      ["a Generative AI action", true, { actionType: "generative_ai" }],
      ["End scenario", false, { actionType: "end_scenario" }],
      [
        "a WhatsApp service message",
        true,
        {
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: { kind: "text", body: { mode: "fixed", text: "Hi" } },
          },
        },
      ],
      ["a WhatsApp template", true, { actionType: "whatsapp_template" }],
      [
        "a Telegram reply",
        true,
        { actionType: "reply", actionReplyChannel: "telegram" },
      ],
      [
        "an Instagram reply",
        true,
        { actionType: "reply", actionReplyChannel: "instagram" },
      ],
    ] as const)("%s opens settings: %s", (_label, expected, data) => {
      expect(
        supportsScenarioNodeSettings(
          actionNode("action", data as Omit<ScenarioNodeData, "kind">)
        )
      ).toBe(expected);
    });

    it("edits a reply through the node commands", async () => {
      const user = userEvent.setup();
      renderHost({ nodes: [reply], initialSelected: "reply", layout: DOCKED });
      const dialog = screen.getByRole("dialog", { name: "presetActionReply" });
      expect(dialog).toHaveAccessibleDescription(
        "nodeSettingsActionDescription"
      );
      fireEvent.change(
        screen.getByPlaceholderText("actionReplyInstructionPlaceholder"),
        { target: { value: "Answer in one line" } }
      );
      expect(mockUpdateNodeById).toHaveBeenLastCalledWith("reply", {
        actionReplyInstruction: "Answer in one line",
      });

      await user.click(screen.getByRole("radio", { name: "replyModeFixed" }));
      expect(mockUpdateNodeById).toHaveBeenLastCalledWith("reply", {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
      });

      // Outcomes are edited here; their ports stay on the canvas card. The
      // section opens by default because the step already has routes.
      await user.click(
        screen.getByRole("checkbox", { name: "actionOutcomePaymentToggle" })
      );
      expect(mockUpdateNodeById).toHaveBeenLastCalledWith("reply", {
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 30 },
          answerMatches: [{ id: "yes", text: "yes", mode: "exact" }],
        },
      });
      expect(within(dialog).getByDisplayValue("yes")).toBeInTheDocument();
      expect(mockSelectNodeById).not.toHaveBeenCalled();
    });

    it("heads action settings with the step's kind icon and a screen-reader description", () => {
      renderHost({
        nodes: [handoff],
        initialSelected: "handoff",
        layout: DOCKED,
      });
      const dialog = screen.getByRole("dialog", {
        name: "presetActionAssignHuman",
      });
      expect(
        dialog.querySelector("[data-kind-icon='assign_human']")
      ).not.toBeNull();
      expect(dialog.querySelector(".lucide-send")).toBeNull();
      expect(dialog).toHaveAccessibleDescription(
        "nodeSettingsActionDescription"
      );
      expect(
        within(dialog).getByText("nodeSettingsActionDescription")
      ).toHaveClass("sr-only");
    });

    it("edits handoff notifications and the Generative AI prompt", () => {
      const view = renderHost({
        nodes: [handoff, generative],
        initialSelected: "handoff",
        layout: DOCKED,
      });
      expect(
        screen.getByRole("dialog", { name: "presetActionAssignHuman" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "actionOutcomes" })
      ).not.toBeInTheDocument();
      fireEvent.change(
        screen.getByPlaceholderText("handoffNotifyEmailPlaceholder"),
        { target: { value: "team@example.com" } }
      );
      expect(mockUpdateNodeById).toHaveBeenLastCalledWith("handoff", {
        actionHandoffNotifyEmail: "team@example.com",
      });

      view.select("generative");
      expect(
        screen.getByRole("dialog", { name: "generativeAITitleVideo" })
      ).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("generativeAIPromptLabel"), {
        target: { value: "A teaser" },
      });
      expect(mockUpdateNodeById).toHaveBeenLastCalledWith("generative", {
        actionGenerativeAIConfig: {
          version: 1,
          mode: "text_to_video",
          prompt: "A teaser",
        },
      });
    });

    it("stays open when a reply switches to another simple reply", async () => {
      const user = userEvent.setup();
      render(
        <StatefulHarness
          initialNodes={[reply]}
          initialSelected="reply"
          layout={DOCKED}
          resources={CONNECTED_SOURCES}
        />
      );
      await user.click(
        screen.getByRole("combobox", { name: "actionSourceSelectLabel" })
      );
      await user.click(
        screen.getByRole("option", { name: "actionSourceEmail" })
      );
      expect(mockBranchSync).toHaveBeenCalledWith(
        "reply",
        expect.objectContaining({ actionReplyChannel: "email" })
      );
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-scenario-node-settings-panel",
        "reply"
      );
      expect(
        screen.getByRole("combobox", { name: "actionSourceSelectLabel" })
      ).toHaveTextContent("actionSourceEmail");
      expect(mockSelectNodeById).not.toHaveBeenCalled();
    });

    it("stays open when a reply becomes a WhatsApp message", async () => {
      const user = userEvent.setup();
      render(
        <StatefulHarness
          initialNodes={[reply]}
          initialSelected="reply"
          layout={DOCKED}
          resources={CONNECTED_SOURCES}
        />
      );
      const source = screen.getByRole("combobox", {
        name: "actionSourceSelectLabel",
      });
      source.focus();
      await user.keyboard("{Enter}");
      await user.click(
        screen.getByRole("option", { name: "actionSourceWhatsApp" })
      );
      expect(mockBranchSync).toHaveBeenCalledWith(
        "reply",
        expect.objectContaining({
          actionWhatsAppServiceMessage: expect.objectContaining({ version: 1 }),
        })
      );
      const dialog = screen.getByRole("dialog", {
        name: "whatsappServiceFormatText",
      });
      expect(dialog).toHaveAttribute(
        "data-scenario-node-settings-panel",
        "reply"
      );
      expect(
        within(dialog).getByTestId("whatsapp-service-message-builder")
      ).toBeInTheDocument();
      expect(mockPanelCalls).not.toContain("scenario-node-settings:collapse");
      expect(mockSelectNodeById).not.toHaveBeenCalled();
    });

    it("stays open when a WhatsApp message becomes a template", async () => {
      const user = userEvent.setup();
      render(
        <StatefulHarness
          initialNodes={[buttons]}
          initialSelected="buttons"
          layout={DOCKED}
          resources={CONNECTED_SOURCES}
        />
      );
      await user.click(
        screen.getByRole("combobox", { name: "actionWhatsAppKindSelectLabel" })
      );
      // Each message type explains itself under its name.
      const templateOption = screen.getByRole("option", {
        name: /^whatsappActionKindTemplate/,
      });
      expect(templateOption).toHaveTextContent(
        "actionWhatsAppKindTemplateHint"
      );
      await user.click(templateOption);
      expect(mockBranchSync).toHaveBeenLastCalledWith(
        "buttons",
        expect.objectContaining({ actionType: "whatsapp_template" })
      );
      const dialog = screen.getByRole("dialog", {
        name: "whatsappActionKindTemplate",
      });
      expect(dialog).toHaveAttribute(
        "data-scenario-node-settings-panel",
        "buttons"
      );
      expect(
        within(dialog).getByRole("combobox", {
          name: "whatsappTemplateSelectLabel",
        })
      ).toBeInTheDocument();
      expect(mockPanelCalls).not.toContain("scenario-node-settings:collapse");
      expect(mockSelectNodeById).not.toHaveBeenCalled();
    });

    it("closes when the action becomes End scenario, which has no settings", () => {
      const view = renderHost({
        nodes: [reply],
        initialSelected: "reply",
        layout: DOCKED,
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      view.rerenderWith({
        nodes: [actionNode("reply", { actionType: "end_scenario" })],
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(mockPanelCalls.at(-1)).toBe("scenario-node-settings:collapse");
      expect(mockSelectNodeById).not.toHaveBeenCalled();
    });
  });

  describe("builder actions", () => {
    function renderStateful(node: ScenarioFlowNode) {
      render(
        <StatefulHarness
          initialNodes={[node]}
          initialSelected={node.id}
          layout={DOCKED}
          resources={CONNECTED_SOURCES}
        />
      );
      return screen.getByRole("dialog");
    }
    /** The last service message a patch sent through the node commands. */
    function lastServiceMessage(nodeId: string) {
      const patch = mockBranchSync.mock.calls
        .filter(([id]) => id === nodeId)
        .at(-1)?.[1] as Partial<ScenarioNodeData> | undefined;
      return patch?.actionWhatsAppServiceMessage;
    }

    it("edits a reply button label through the node commands", () => {
      const dialog = renderStateful(buttons);
      expect(
        within(dialog).getByTestId("whatsapp-service-message-builder")
      ).toBeInTheDocument();
      fireEvent.change(within(dialog).getByDisplayValue("One"), {
        target: { value: "Uno" },
      });
      expect(lastServiceMessage("buttons")?.message).toEqual(
        expect.objectContaining({
          kind: "reply_buttons",
          options: [
            { id: "wsc:buttons:one", label: "Uno" },
            { id: "wsc:buttons:two", label: "Two" },
          ],
        })
      );
      expect(within(dialog).getByDisplayValue("Uno")).toBeInTheDocument();
      expect(mockSelectNodeById).not.toHaveBeenCalled();
    });

    it("edits a carousel card's text and choice through the node commands", () => {
      const dialog = renderStateful(carousel);
      fireEvent.change(
        within(dialog).getByLabelText(
          'whatsappServiceCarouselCardTextLabel:{"n":2}'
        ),
        { target: { value: "Model two, in red" } }
      );
      const cards = () => {
        const message = lastServiceMessage("carousel")?.message;
        if (message?.kind !== "media_carousel") {
          throw new Error("expected a carousel");
        }
        return message.cards;
      };
      expect(cards()[1]?.bodyText).toBe("Model two, in red");
      expect(cards()[0]?.bodyText).toBe("Model c1");
      fireEvent.change(
        within(dialog).getByLabelText(
          'whatsappServiceCarouselButtonAria:{"card":2,"n":1}'
        ),
        { target: { value: "Order" } }
      );
      expect(cards().map(card => card.interaction)).toMatchObject([
        { options: [{ label: "Buy" }, { label: "Info" }] },
        { options: [{ label: "Order" }, { label: "Info" }] },
      ]);
      expect(
        within(dialog).queryByTestId("carousel-option-handle-rail")
      ).toBeNull();
    });

    it("opens a template's Flow in the settings column", async () => {
      const user = userEvent.setup();
      const dialog = renderStateful(template);
      await user.click(
        within(dialog).getByRole("button", { name: "whatsappTemplateOpenFlow" })
      );
      await flushNestedLazyEditors();
      const flowDrawer = within(dialog).getByRole("dialog", {
        name: "flowBuilderLabel",
      });
      // An overlay could cover the fields above it in a scrolling column.
      expect(flowDrawer).not.toHaveClass("absolute");
      expect(dialog.querySelector(".react-flow__handle")).toBeNull();
    });
  });

  describe("React Flow isolation", () => {
    function CaptureReactFlowErrors({
      onError,
    }: {
      onError: (code: string, message: string) => void;
    }) {
      const store = useStoreApi();
      useEffect(() => {
        store.setState({ onError });
      }, [onError, store]);
      return null;
    }

    it.each([
      ["trigger", first],
      ["link", link],
      ["reply with outcomes", reply],
      ["handoff", handoff],
      ["Generative AI", generative],
      ["reply buttons with outcomes", buttons],
      ["list", list],
      ["media carousel", carousel],
      ["Flow message with choices", flowMessage],
      ["choice ask with details", detailsAsk],
      ["template with quick replies and a Flow", template],
      ["Telegram reply", telegram],
      ["Instagram reply", instagram],
    ] as const)(
      "renders %s settings without canvas handles or React Flow errors",
      async (_kind, node) => {
        const onError = jest.fn();
        const handleRef = { current: null as HarnessHandle | null };
        render(
          <ReactFlowProvider>
            <CaptureReactFlowErrors onError={onError} />
            <Harness
              handleRef={handleRef}
              nodes={[node]}
              initialSelected={null}
              layout={DOCKED}
            />
          </ReactFlowProvider>
        );
        // Open after the error spy is installed: a handle reports on render.
        act(() => handleRef.current!.select(node.id));
        await flushNestedLazyEditors();
        const dialog = screen.getAllByRole("dialog")[0]!;
        // Lazy builders have loaded, so their options have rendered too.
        expect(within(dialog).queryByText("loadingItems")).toBeNull();
        // Outcomes and Run if start collapsed; open them to render every editor.
        for (const section of within(dialog).queryAllByRole("button", {
          name: /^(actionOutcomes|actionRunIf)$/,
        })) {
          fireEvent.click(section);
        }
        expect(dialog.querySelector(".react-flow__handle")).toBeNull();
        expect(
          dialog.querySelector("[data-handleid], [data-handlepos]")
        ).toBeNull();
        expect(onError).not.toHaveBeenCalled();
      }
    );
  });
});
