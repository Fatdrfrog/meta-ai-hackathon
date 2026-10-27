/**
 * @jest-environment jsdom
 */

import type {
  CSSProperties,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";
import { useState } from "react";
import { deserialize, serialize } from "node:v8";
import { normalizeScenarioTriggerConfig } from "@/lib/scenarios/trigger-utils";
import type { ScenarioTriggerConfig } from "../../types";
import userEvent from "@testing-library/user-event";

const mockRemoveNodeById = jest.fn();
const mockOpenNodePickerFromHandle = jest.fn();
const mockUpdateNodeById = jest.fn();
const mockUpdateTriggerConfigById = jest.fn();
const mockSelectNodeById = jest.fn();

const mockTranslate = (
  key: string,
  values?: Record<string, string | number | Date>
) => {
  if (typeof values?.text === "string") {
    return `${key}: ${values.text}`;
  }
  if (typeof values?.minutes === "number") {
    return `${key}: ${values.minutes}`;
  }
  return key;
};

const mockScenarioNodeEnrichment = {
  selectedNodeId: null as string | null,
  callbacksRef: {
    current: {
      removeNodeById: mockRemoveNodeById,
      selectNodeById: mockSelectNodeById,
      updateNodeById: mockUpdateNodeById,
      updateTriggerConfigById: mockUpdateTriggerConfigById,
    },
  },
  openNodePickerFromHandle: mockOpenNodePickerFromHandle,
  audienceOptions: {
    channels: [],
    classificationCategories: [],
    customers: [],
    funnelStages: [],
    internalLabels: [],
    metaReferralAds: [],
    metaReferralAdSets: [],
    metaCampaignLabels: [],
    metaReferralCampaigns: [],
  },
  sourceCapabilities: {
    hasMetaAds: false,
    hasWhatsApp: false,
    hasWhatsAppCoexistence: false,
  },
  t: mockTranslate,
};

jest.mock("next-intl", () => ({
  useLocale: () => "en-US",
  useTranslations: () => mockTranslate,
}));

jest.mock("./whatsapp-qr-trigger-picker", () => ({
  WhatsAppQrTriggerPicker: ({
    selected,
  }: {
    selected: { placementName: string } | null;
  }) => (
    <div data-testid="whatsapp-qr-trigger-picker">
      {selected?.placementName}
    </div>
  ),
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({
    "aria-label": ariaLabel,
    children,
    className,
    id,
    onClick,
    onKeyDown,
    role,
    style,
    tabIndex,
    title,
    type,
  }: {
    "aria-label"?: string;
    children?: ReactNode;
    className?: string;
    id?: string;
    onClick?: MouseEventHandler<HTMLDivElement>;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
    role?: string;
    style?: CSSProperties;
    tabIndex?: number;
    title?: string;
    type?: string;
  }) => (
    <div
      aria-label={ariaLabel}
      className={className}
      data-handle-id={id}
      data-handle-type={type}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={role}
      style={style}
      tabIndex={tabIndex}
      title={title}
    >
      {children}
    </div>
  ),
  MarkerType: {
    ArrowClosed: "ArrowClosed",
  },
  Position: {
    Left: "left",
    Right: "right",
    Top: "top",
  },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
}));

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { NodeProps } from "@xyflow/react";
import { TriggerNode as ActualTriggerNode } from ".";
import { BehaviorTriggerEditor } from "./behavior-trigger-editor";
import { TriggerEditorPanel } from "../../view/scenario-trigger-editor-panel";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import type {
  ScenarioPersistedNodeDataOfKind,
  ScenarioTriggerEditorNodeData,
  ScenarioTriggerEditorNodeProps,
  ScenarioTriggerNodeEnrichment,
} from "../../view/node-enrichment/types";

function TriggerNode(props: NodeProps) {
  const rawData = props.data as ScenarioPersistedNodeDataOfKind<"trigger"> &
    Partial<ScenarioTriggerNodeEnrichment>;
  const data: ScenarioTriggerEditorNodeData = {
    ...rawData,
    uiOnSelect: () => mockSelectNodeById(props.id),
    uiOnPatch: patch => mockUpdateNodeById(props.id, patch),
    uiOnRemove: () => mockRemoveNodeById(props.id),
    uiOnCreateNodeFromSourceHandle: (sourceHandleId, clientX, clientY) =>
      mockOpenNodePickerFromHandle(props.id, sourceHandleId, clientX, clientY),
    uiNodeLabel: rawData.uiNodeLabel ?? "presetTriggerIncoming",
    uiAudienceOptions: mockScenarioNodeEnrichment.audienceOptions,
    uiTriggerConfig: rawData.uiTriggerConfig ?? rawData.triggerConfig ?? {},
    uiOnTriggerConfigChange:
      rawData.uiOnTriggerConfigChange ??
      (patch => mockUpdateTriggerConfigById(props.id, patch)),
    uiIsEditorExpanded: mockScenarioNodeEnrichment.selectedNodeId === props.id,
    uiHasMetaAdsConnection:
      mockScenarioNodeEnrichment.sourceCapabilities.hasMetaAds,
  };
  return (
    <>
      <ActualTriggerNode
        {...({ ...props, data } as unknown as ScenarioTriggerEditorNodeProps)}
      />
      {data.uiIsEditorExpanded &&
      !data.linkedConditionId &&
      data.uiTriggerConfig.entryPointType !== "whatsapp_qr" ? (
        <TriggerEditorPanel
          nodeId={props.id}
          data={data}
          onClose={() => mockSelectNodeById(null)}
        />
      ) : null}
    </>
  );
}

const triggerNodeProps = {
  id: "trigger-1",
  selected: false,
  type: "trigger",
  dragging: false,
  zIndex: 0,
  isConnectable: true,
  selectable: true,
  deletable: true,
  draggable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

function renderTriggerNode(
  data: ScenarioPersistedNodeDataOfKind<"trigger"> &
    Partial<ScenarioTriggerNodeEnrichment>
) {
  return render(<TriggerNode {...triggerNodeProps} data={data} />);
}

function SwitchingTriggerNode({
  initialConfig,
}: {
  initialConfig: ScenarioTriggerConfig;
}) {
  const [config, setConfig] = useState(initialConfig);
  return (
    <>
      <TriggerNode
        {...triggerNodeProps}
        data={{
          kind: "trigger",
          triggerConfig: config,
          uiOnTriggerConfigChange: (patch: Partial<ScenarioTriggerConfig>) => {
            mockUpdateTriggerConfigById("trigger-1", patch);
            setConfig(currentConfig =>
              normalizeScenarioTriggerConfig({
                nodeData: {
                  kind: "trigger",
                  triggerConfig: { ...currentConfig, ...patch },
                },
              })
            );
          },
        }}
      />
      <output data-testid="trigger-config">{JSON.stringify(config)}</output>
    </>
  );
}

async function selectEntryKind(label: string) {
  const selector = screen.getByRole("combobox", {
    name: "triggerEditorEntryLabel",
  });
  act(() => selector.focus());
  await userEvent.keyboard("{Enter}");
  act(() => screen.getByRole("option", { name: label }).focus());
  await userEvent.keyboard("{Enter}");
}

// Editors load lazily in the app; load them up front so they render at once.
beforeAll(async () => {
  await Promise.all([scenarioEditorChunks.triggerNodeSettings.load()]);
});

describe("TriggerNode density", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalStructuredClone = globalThis.structuredClone;
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = jest.fn();
    globalThis.structuredClone = value => deserialize(serialize(value));
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    globalThis.structuredClone = originalStructuredClone;
  });
  it("defers incomplete behavior segment diagnostics until runnable validation", () => {
    const onChange = jest.fn();
    const value = {
      preset: "purchase_completed" as const,
      delayMinutes: 0,
      purchaseSegment: { minNetSpend: 10 },
    };
    const view = render(
      <BehaviorTriggerEditor
        value={value}
        onChange={onChange}
        validationMode="draft"
      />
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("currency"), {
      target: { value: "K" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...value,
      purchaseSegment: { minNetSpend: 10, currency: "K" },
    });
    view.rerender(
      <BehaviorTriggerEditor
        value={value}
        onChange={onChange}
        validationMode="runnable"
      />
    );
    expect(screen.getByRole("alert").textContent).toBe("invalidConfig");
  });
  beforeEach(() => {
    mockScenarioNodeEnrichment.selectedNodeId = null;
    mockRemoveNodeById.mockClear();
    mockOpenNodePickerFromHandle.mockClear();
    mockUpdateNodeById.mockClear();
    mockUpdateTriggerConfigById.mockClear();
    mockSelectNodeById.mockClear();
  });

  it("summarizes an unselected trigger without mounting its full editor", async () => {
    renderTriggerNode({
      kind: "trigger",
      triggerConfig: {
        channelFilter: ["whatsapp"],
        keywordPattern: "dormant refund pattern",
        messageMatchMode: "any",
        onlyNewCustomers: true,
      },
    });

    const compactNode = screen.getByTestId("scenario-trigger-node-compact");
    expect(compactNode.textContent).toContain("presetTriggerIncoming");
    expect(compactNode.textContent).toContain("triggerMatchAny");
    expect(compactNode.textContent).toContain("triggerOnlyNewCustomers");
    expect(compactNode.textContent).toContain("actionSourceWhatsApp");
    expect(compactNode.textContent).not.toContain("dormant refund pattern");
    expect(screen.queryByText("triggerMessageMatchMode")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();

    const card = compactNode.querySelector("[data-slot=card]");
    expect(card?.className).toContain("overflow-visible");
    expect(card?.className).not.toContain("overflow-hidden");
    expect(
      compactNode.querySelector("[data-handle-id='right-source']")?.className
    ).toContain("!z-20");

    fireEvent.click(screen.getByRole("button", { name: "addBlock" }), {
      clientX: 48,
      clientY: 24,
    });
    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "trigger-1",
      "right-source",
      48,
      24
    );

    fireEvent.click(screen.getByRole("button", { name: "removeBlock" }));
    expect(mockRemoveNodeById).toHaveBeenCalledWith("trigger-1");
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();

    const settingsButton = screen.getByRole("button", {
      name: "triggerEditorTitle",
    });
    settingsButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(mockSelectNodeById).toHaveBeenCalledWith("trigger-1");
  });

  it("shows the active exact-message pattern in compact mode", () => {
    renderTriggerNode({
      kind: "trigger",
      triggerConfig: {
        keywordPattern: "cancel my subscription",
        messageMatchMode: "exact",
      },
    });

    const compactNode = screen.getByTestId("scenario-trigger-node-compact");
    expect(compactNode.textContent).toContain("cancel my subscription");
  });

  it("summarizes the canonical enriched message config instead of raw node input", () => {
    renderTriggerNode({
      kind: "trigger",
      triggerConfig: {
        messageMatchMode: "exact",
        keywordPattern: "raw pattern",
      },
      uiTriggerConfig: {
        messageMatchMode: "exact",
        keywordPattern: "canonical pattern",
      },
    });
    const compact = screen.getByTestId("scenario-trigger-node-compact");
    expect(compact.textContent).toContain("canonical pattern");
    expect(compact.textContent).not.toContain("raw pattern");
  });

  it("summarizes behavior from canonical enrichment without mounting message controls", () => {
    renderTriggerNode({
      kind: "trigger",
      triggerConfig: {
        messageMatchMode: "exact",
        keywordPattern: "raw pattern",
      },
      uiTriggerConfig: {
        entryPointType: "customer_behavior",
        behavior: { preset: "win_back", delayMinutes: 1440 },
      },
    });
    const compact = screen.getByTestId("scenario-trigger-node-compact");
    expect(compact.dataset.entryPointType).toBe("customer_behavior");
    expect(compact.textContent).toContain("presets.win_back");
    expect(compact.textContent).not.toContain("raw pattern");
    expect(screen.queryByText("triggerMessageMatchMode")).toBeNull();
  });

  it("preserves message filters through normalized behavior and message transitions", async () => {
    mockScenarioNodeEnrichment.selectedNodeId = "trigger-1";
    const messageConfig: ScenarioTriggerConfig = {
      entryPointType: "message",
      keywordPattern: "refund request",
      keywordMatchMode: "regex",
      messageMatchMode: "contains",
      channelFilter: ["whatsapp"],
      onlyNewCustomers: true,
      metaReferralCampaignIds: ["saved-campaign"],
    };
    render(<SwitchingTriggerNode initialConfig={messageConfig} />);
    await selectEntryKind("presetTriggerCustomerBehavior");
    expect(screen.queryByText("triggerMessageMatchMode")).toBeNull();
    expect(screen.queryByText("channels")).toBeNull();
    expect(screen.getByLabelText("delay")).toBeTruthy();
    expect(mockUpdateTriggerConfigById).toHaveBeenLastCalledWith("trigger-1", {
      entryPointType: "customer_behavior",
      behavior: { preset: "purchase_completed", delayMinutes: 0 },
    });
    fireEvent.change(screen.getByLabelText("delay"), {
      target: { value: "2" },
    });
    expect(
      JSON.parse(screen.getByTestId("trigger-config").textContent || "{}")
        .behavior.delayMinutes
    ).toBe(120);
    await selectEntryKind("presetTriggerIncoming");
    expect(screen.getByDisplayValue("refund request")).toBeTruthy();
    expect(mockUpdateTriggerConfigById).toHaveBeenLastCalledWith("trigger-1", {
      entryPointType: "message",
    });
    const normalizedConfig = JSON.parse(
      screen.getByTestId("trigger-config").textContent || "{}"
    );
    expect(normalizedConfig).toMatchObject(messageConfig);
    expect(normalizedConfig.behavior).toBeUndefined();
    await selectEntryKind("presetTriggerCustomerBehavior");
    expect(mockUpdateTriggerConfigById).toHaveBeenLastCalledWith("trigger-1", {
      entryPointType: "customer_behavior",
      behavior: { preset: "purchase_completed", delayMinutes: 0 },
    });
  });

  it("reuses an existing behavior value when selecting the behavior entry", async () => {
    mockScenarioNodeEnrichment.selectedNodeId = "trigger-1";
    const behavior = { preset: "win_back" as const, delayMinutes: 1440 };
    render(
      <SwitchingTriggerNode
        initialConfig={{ entryPointType: "message", behavior }}
      />
    );
    await selectEntryKind("presetTriggerCustomerBehavior");
    expect(mockUpdateTriggerConfigById).toHaveBeenLastCalledWith("trigger-1", {
      entryPointType: "customer_behavior",
      behavior,
    });
    expect(
      within(screen.getByRole("dialog")).getByText("presets.win_back")
    ).toBeTruthy();
    expect(screen.queryByText("triggerMessageMatchMode")).toBeNull();
  });

  it("renders the label supplied by trigger enrichment in compact mode", () => {
    renderTriggerNode({
      kind: "trigger",
      uiNodeLabel: "Localized client message",
      triggerConfig: {
        messageMatchMode: "any",
      },
    });

    expect(
      screen.getByTestId("scenario-trigger-node-compact").textContent
    ).toContain("Localized client message");
  });

  it("keeps the selected node compact beside the focused message editor", () => {
    mockScenarioNodeEnrichment.selectedNodeId = "trigger-1";

    renderTriggerNode({
      kind: "trigger",
      triggerConfig: {
        keywordPattern: "refund request",
        messageMatchMode: "contains",
      },
    });

    expect(screen.getByTestId("scenario-trigger-node-compact")).toBeTruthy();
    const editor = within(
      screen.getByRole("dialog", { name: "triggerEditorTitle" })
    );
    expect(
      editor.getByText("presetTriggerIncoming").closest('[role="combobox"]')
    ).not.toBeNull();
    expect(screen.getByText("triggerMessageMatchMode")).toBeTruthy();
    expect(screen.getByDisplayValue("refund request")).toBeTruthy();
    expect(screen.queryByText("presetTriggerPaymentDetected")).toBeNull();
    expect(screen.queryByText("presetTriggerFollowup")).toBeNull();
    expect(screen.queryByText("presetTriggerClassification")).toBeNull();
    expect(screen.queryByText("presetTriggerBusinessHours")).toBeNull();
    expect(screen.queryByText("presetTriggerUserInactive")).toBeNull();
    expect(mockUpdateTriggerConfigById).not.toHaveBeenCalled();
  });

  it("keeps a selected linked entry compact without opening a root editor", () => {
    mockScenarioNodeEnrichment.selectedNodeId = "trigger-1";

    renderTriggerNode({
      kind: "trigger",
      linkedConditionId: "condition-1",
      triggerConfig: {
        channelFilter: ["whatsapp"],
        keywordPattern: "must stay hidden",
        messageMatchMode: "contains",
        onlyNewCustomers: true,
        metaReferralSourceIds: ["ad-1"],
      },
    });

    expect(screen.getByText("triggerLinkedEntryTitle")).toBeTruthy();
    expect(screen.getByText("triggerLinkedEntryDescription")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("triggerMessageMatchMode")).toBeNull();
    expect(screen.queryByText("channels")).toBeNull();
    expect(screen.queryByDisplayValue("must stay hidden")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("summarizes a compact linked entry as a continuation, not a message root", () => {
    renderTriggerNode({
      kind: "trigger",
      linkedConditionId: "condition-1",
      triggerConfig: {
        channelFilter: ["whatsapp"],
        keywordPattern: "must stay hidden",
        messageMatchMode: "exact",
      },
    });

    const compactNode = screen.getByTestId("scenario-trigger-node-compact");
    expect(compactNode.textContent).toContain("triggerLinkedEntryTitle");
    expect(compactNode.textContent).toContain("triggerLinkedEntryDescription");
    expect(compactNode.textContent).not.toContain("triggerMatchExact");
    expect(compactNode.textContent).not.toContain("must stay hidden");
    expect(compactNode.textContent).not.toContain("Whatsapp");
  });

  it("keeps whatsapp_qr compact and renders the existing QR picker", () => {
    mockScenarioNodeEnrichment.selectedNodeId = "trigger-1";

    render(
      <ActualTriggerNode
        id="trigger-1"
        selected
        type="triggerNode"
        dragging={false}
        zIndex={0}
        isConnectable
        selectable
        deletable
        draggable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          kind: "trigger",
          triggerConfig: { entryPointType: "message", enabled: true },
          uiOnSelect: () => mockSelectNodeById("trigger-1"),
          uiOnPatch: patch => mockUpdateNodeById("trigger-1", patch),
          uiOnRemove: () => mockRemoveNodeById("trigger-1"),
          uiNodeLabel: "presetTriggerWhatsAppQr",
          uiAudienceOptions: mockScenarioNodeEnrichment.audienceOptions,
          uiTriggerConfig: { entryPointType: "whatsapp_qr", enabled: true },
          uiOnTriggerConfigChange: patch =>
            mockUpdateTriggerConfigById("trigger-1", patch),
          uiIsEditorExpanded: true,
          uiHasMetaAdsConnection: false,
          uiWhatsAppQrPicker: {
            selected: {
              entryPointId: "ep-1",
              placementName: "Front door",
              sourceId: "source-1",
              status: "DRAFT",
              hasCurrentCode: false,
              readiness: "draft",
              reconcilePending: false,
              version: 0,
            },
            selectedEntryPointId: "ep-1",
            selectionResolved: true,
            targetScenarioId: "scenario-1",
            targetNodeId: "trigger-1",
            targetScenarioName: "Scenario",
            managerHref: "/panel/w/workspace-1/messengers/whatsapp-qr",
            sourceLabels: { "source-1": "WhatsApp" },
            loading: false,
            error: null,
            busy: false,
            loadOptions: jest.fn().mockResolvedValue({
              items: [],
              nextCursor: null,
            }),
            onAssign: jest.fn().mockResolvedValue(undefined),
            onUnassign: jest.fn().mockResolvedValue(undefined),
            onRefresh: jest.fn().mockResolvedValue(undefined),
            onOpenScenario: jest.fn(),
          },
        }}
      />
    );

    const compactNode = screen.getByTestId("scenario-trigger-node-compact");
    expect(screen.queryByText("triggerMessageMatchMode")).toBeNull();
    expect(compactNode.textContent).toContain("Front door");
    expect(
      within(compactNode).queryByTestId("scenario-trigger-node-settings")
    ).toBeNull();
    expect(
      within(compactNode).queryByRole("button", { name: "triggerEditorTitle" })
    ).toBeNull();
    expect(mockSelectNodeById).not.toHaveBeenCalled();
  });
});
