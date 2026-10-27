/**
 * @jest-environment jsdom
 */

import type {
  ComponentType,
  KeyboardEventHandler,
  MouseEventHandler,
  ReactNode,
} from "react";

type MockWithChildrenProps = {
  children?: ReactNode;
};

type MockHandleProps = {
  children?: ReactNode;
  id?: string;
  type?: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  role?: string;
  tabIndex?: number;
};

type TelegramQuickReplyButton = {
  text: string;
  payload: string;
};

const mockUpdateNodeInternals = jest.fn();
const mockToastError = jest.fn();

const mockTranslation = {
  withValues: false,
};

jest.mock("next-intl", () => ({
  useFormatter: () => ({
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en", options).format(value),
  }),
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    mockTranslation.withValues && values
      ? `${key}:${JSON.stringify(values)}`
      : key,
}));

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
  }),
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({
    children,
    id,
    type,
    className,
    title,
    "aria-label": ariaLabel,
    onClick,
    onKeyDown,
    role,
    tabIndex,
  }: MockHandleProps) => (
    <div
      data-testid="handle"
      data-handle-id={id}
      data-handle-type={type}
      className={className}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role={role}
      tabIndex={tabIndex}
    >
      {children}
    </div>
  ),
  MarkerType: { ArrowClosed: "ArrowClosed" },
  NodeToolbar: ({
    children,
    isVisible,
  }: {
    children: React.ReactNode;
    isVisible?: boolean;
  }) => (isVisible ? <div data-testid="node-tooltip">{children}</div> : null),
  Position: { Left: "left", Right: "right", Top: "top" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
  useUpdateNodeInternals: () => mockUpdateNodeInternals,
}));

jest.mock("@/components/ui/tooltip", () => {
  const Passthrough = ({ children }: MockWithChildrenProps) => <>{children}</>;
  return {
    Tooltip: Passthrough,
    TooltipProvider: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: ({ children }: MockWithChildrenProps) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
  };
});

jest.mock("@/components/ui/drawer", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  type MockDrawerContext = {
    open: boolean;
    modal: boolean;
    onOpenChange: ((open: boolean) => void) | undefined;
  };
  type MockDrawerProps = MockWithChildrenProps & {
    open?: boolean;
    modal?: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  type MockDrawerContentProps = MockWithChildrenProps & {
    className?: string;
    overlayClassName?: string;
  };

  const DrawerContext = React.createContext<MockDrawerContext>({
    open: false,
    modal: true,
    onOpenChange: undefined,
  });

  function Drawer({
    open = false,
    modal = true,
    onOpenChange,
    children,
  }: MockDrawerProps) {
    React.useEffect(() => {
      const handleOutsideClick = () => {
        if (open && modal !== false) {
          onOpenChange?.(false);
        }
      };

      window.addEventListener("mock-drawer-outside-click", handleOutsideClick);
      const handleOutsidePointerDown = (event: Event) => {
        if (open) {
          event.preventDefault();
        }
      };

      window.addEventListener(
        "mock-drawer-outside-pointer-down",
        handleOutsidePointerDown
      );
      return () => {
        window.removeEventListener(
          "mock-drawer-outside-click",
          handleOutsideClick
        );
        window.removeEventListener(
          "mock-drawer-outside-pointer-down",
          handleOutsidePointerDown
        );
      };
    }, [open, modal, onOpenChange]);

    return (
      <DrawerContext.Provider value={{ open, modal, onOpenChange }}>
        <div
          data-testid="drawer-root"
          data-open={String(open)}
          data-modal={String(modal)}
        >
          {children}
        </div>
      </DrawerContext.Provider>
    );
  }

  function DrawerContent({
    children,
    className,
    overlayClassName,
  }: MockDrawerContentProps) {
    const { open } = React.use(DrawerContext);
    if (!open) return null;
    return (
      <>
        <div data-testid="drawer-overlay" className={overlayClassName} />
        <div role="dialog" data-testid="drawer-content" className={className}>
          {children}
        </div>
      </>
    );
  }

  const createDrawerSlot = (
    slot: string
  ): ComponentType<MockWithChildrenProps> =>
    function DrawerSlot({ children }: MockWithChildrenProps) {
      return <div data-slot={slot}>{children}</div>;
    };

  return {
    Drawer,
    DrawerContent,
    DrawerDescription: createDrawerSlot("drawer-description"),
    DrawerHeader: createDrawerSlot("drawer-header"),
    DrawerTitle: createDrawerSlot("drawer-title"),
  };
});

const mockRemoveNodeById = jest.fn();
const mockOpenNodePickerFromHandle = jest.fn();
const mockScenarioNodeEnrichment = {
  selectedNodeId: null as string | null,
  graphIndex: {
    actionNodeCount: 0,
  },
  callbacksRef: {
    current: {
      removeNodeById: mockRemoveNodeById,
    },
  },
  openNodePickerFromHandle: mockOpenNodePickerFromHandle,
  sourceCapabilities: {
    hasWhatsApp: false,
    hasWhatsAppCoexistence: false,
    hasMetaAds: false,
  },
  t: (key: string) => key,
};

jest.mock("../../view/graph/resources-context", () => ({
  useScenarioGraphResources: () => ({
    whatsAppTemplatesLoading: false,
    whatsAppTemplatesRefreshing: false,
    whatsAppFlowsLoading: false,
    whatsAppFlowsRefreshing: false,
  }),
}));

const mockPatchNode = jest.fn();
const mockActionTemplateOptionsOpen = jest.fn();
const mockActionTemplateSelect = jest.fn();
const mockActionTemplateCreated = jest.fn();
const mockFetch = jest.fn();
const mockEnrichActionNodeData = jest.fn(
  (_id: string, data: ActionNodeTestData, _ctx?: unknown) =>
    createActionEditorTestData({
      ...data,
      uiOnSelect: jest.fn(),
      uiOnPatch: mockPatchNode,
      uiOnRemove: () => mockRemoveNodeById(_id),
      uiActionSourceOptions: data.uiActionSourceOptions ?? [
        { id: "whatsapp", label: "WhatsApp" },
        { id: "instagram", label: "Instagram" },
      ],
      uiOnCreateNodeFromSourceHandle:
        data.uiOnCreateNodeFromSourceHandle ??
        ((sourceHandleId: string, clientX: number, clientY: number) =>
          mockOpenNodePickerFromHandle(_id, sourceHandleId, clientX, clientY)),
      uiWorkspaceId: data.uiWorkspaceId ?? "workspace-1",
      uiActiveScenarioId: null,
      uiActionNodeCount: mockScenarioNodeEnrichment.graphIndex.actionNodeCount,
      uiIsEditorExpanded: mockScenarioNodeEnrichment.selectedNodeId === _id,
      uiSourceCapabilities: mockScenarioNodeEnrichment.sourceCapabilities,
      uiWhatsAppTemplates: {
        submittingGenerated:
          data.uiWhatsAppTemplates?.submittingGenerated ?? false,
        submitGenerated:
          data.uiWhatsAppTemplates?.submitGenerated ??
          jest.fn(async () => true),
        options: [
          {
            id: "meta-template-1",
            name: "template_1",
            language: "kk",
            category: "UTILITY",
          },
        ],
        selectedValue:
          data.uiWhatsAppTemplates?.selectedValue ?? "template_1::kk",
        onOpenChange: mockActionTemplateOptionsOpen,
        select: mockActionTemplateSelect,
        refresh: mockActionTemplateCreated,
        preview: {
          bodyText: "Template body",
          buttons: [],
        },
      },
      uiWhatsAppFlows: data.uiWhatsAppFlows,
    })
);

jest.mock("../../builders/telegram", () => ({
  TelegramReplyBuilder: ({
    quickReplies,
    renderButtonBranchHandle,
  }: {
    quickReplies?: TelegramQuickReplyButton[] | TelegramQuickReplyButton[][];
    renderButtonBranchHandle?: (params: {
      button: TelegramQuickReplyButton;
      rowIndex: number;
      buttonIndex: number;
    }) => ReactNode;
  }) => {
    const rows: TelegramQuickReplyButton[][] =
      Array.isArray(quickReplies) && quickReplies.length > 0
        ? Array.isArray(quickReplies[0])
          ? (quickReplies as TelegramQuickReplyButton[][])
          : [quickReplies as TelegramQuickReplyButton[]]
        : [];

    return (
      <div data-testid="telegram-builder">
        {rows.map((row, rowIndex) =>
          row.map((button, buttonIndex) => (
            <div key={button.payload} data-testid="telegram-builder-button">
              {button.text}
              {renderButtonBranchHandle?.({ button, rowIndex, buttonIndex })}
            </div>
          ))
        )}
      </div>
    );
  },
}));

jest.mock("../../builders/instagram", () => ({
  InstagramReplyBuilder: ({ disabled }: { disabled?: boolean }) => (
    <div
      data-disabled={String(Boolean(disabled))}
      data-testid="instagram-builder"
    />
  ),
}));

jest.mock("../../builders/whatsapp/flow-builder", () => ({
  FlowBuilder: ({
    flowConfig,
    renderFlowBranchHandle,
  }: {
    flowConfig?: {
      screens?: Array<{
        fields?: Array<{
          id: string;
          fieldType: string;
          options?: Array<{ id: string; title: string }>;
        }>;
      }>;
    } | null;
    renderFlowBranchHandle?: (params: {
      fieldId: string;
      optionId: string;
      optionTitle: string;
      branchId: string;
      handleId: string;
    }) => ReactNode;
  }) => {
    const radioFields = (flowConfig?.screens ?? [])
      .flatMap(screen => screen.fields ?? [])
      .filter(field => field.fieldType === "RadioButtonsGroup");
    const options = radioFields.flatMap(field =>
      (field.options ?? []).map(option => ({ field, option }))
    );
    const branchOptions =
      options.length > 0
        ? options
        : [
            {
              field: { id: "field_1" },
              option: { id: "opt_1", title: "Yes" },
            },
          ];

    return (
      <div data-testid="template-flow-builder">
        {branchOptions.map(({ field, option }) => {
          const branchId = JSON.stringify([field.id, option.id]);
          return (
            <div key={`${field.id}:${option.id}`}>
              {renderFlowBranchHandle?.({
                fieldId: field.id,
                optionId: option.id,
                optionTitle: option.title,
                branchId,
                handleId: `right-source-flow-branch::${field.id}::${option.id}`,
              })}
            </div>
          );
        })}
      </div>
    );
  },
}));

jest.mock("@/lib/scenarios/client", () => ({
  ...jest.requireActual<typeof import("@/lib/scenarios/client")>(
    "@/lib/scenarios/client"
  ),
  fetchScenarioWhatsAppFlowDetails: jest.fn(),
}));

jest.mock("@/components/whatsapp-templates/template-form-drawer", () => ({
  TemplateFormDrawer: ({
    open,
    workspaceId,
    onSuccess,
  }: {
    open: boolean;
    workspaceId: string;
    onSuccess: () => void;
  }) =>
    open ? (
      <div
        data-testid="scenario-template-create-drawer"
        data-workspace-id={workspaceId}
      >
        <button type="button" onClick={onSuccess}>
          finish template create
        </button>
      </div>
    ) : null,
}));

jest.mock("../../builders/whatsapp/inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    onChange,
    onBlur,
    placeholder,
    multiline = true,
  }: {
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    multiline?: boolean;
  }) =>
    multiline ? (
      <textarea
        aria-label={placeholder || "editor"}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ) : (
      <input
        aria-label={placeholder || "editor"}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ),
}));

import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  GENERATIVE_AI_FAILURE_HANDLE,
  GENERATIVE_AI_SUCCESS_HANDLE,
  buildFlowBranchOptionKey,
  buildFlowBranchSourceHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
  buildTelegramBranchSourceHandleId,
  buildWhatsAppSessionChoicePayload,
  buildWhatsAppSessionChoiceSourceHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
} from "@icecore/scenario-contracts";
import type { NodeProps } from "@xyflow/react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionNode as ActualActionNode } from ".";
import { ScenarioEditorDraftProvider } from "../../view/editor-drafts";
import type { ScenarioActionEditorNodeProps } from "../../view/node-enrichment/types";
import { resolveActionNodeCardTitle } from "./action-node-state";
import { scenarioEditorChunks } from "../../scenario-editor-chunks";
import {
  createActionEditorTestData,
  type ActionNodeTestData,
} from "./action-node-test-utils";

function ActionNode(props: NodeProps) {
  const data = mockEnrichActionNodeData(
    props.id,
    props.data as ActionNodeTestData
  );
  return (
    <ActualActionNode
      {...({ ...props, data } as unknown as ScenarioActionEditorNodeProps)}
    />
  );
}

beforeAll(async () => {
  Object.defineProperty(global, "fetch", {
    writable: true,
    value: mockFetch,
  });
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: () => boolean;
    releasePointerCapture?: () => void;
  };
  elementPrototype.hasPointerCapture ??= () => false;
  elementPrototype.releasePointerCapture ??= () => undefined;
  HTMLElement.prototype.scrollIntoView ??= jest.fn();
  // Popovers measure their content once they open.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

function renderActionNode(
  data: ActionNodeTestData,
  { compact = false }: { compact?: boolean } = {}
) {
  mockScenarioNodeEnrichment.graphIndex.actionNodeCount = compact ? 12 : 0;
  return render(createActionNodeElement("action-1", data));
}

function serviceTextMessage(text: string): ActionNodeTestData {
  return {
    kind: "action",
    actionType: "reply",
    actionWhatsAppServiceMessage: {
      version: 1,
      message: {
        kind: "text",
        body: { mode: "fixed", text },
        previewUrl: false,
      },
    },
  };
}

function createActionNodeElement(
  id: string,
  data: ActionNodeTestData,
  selected = false
) {
  return (
    <ActionNode
      id={id}
      selected={selected}
      type="action"
      dragging={false}
      zIndex={0}
      isConnectable
      selectable
      deletable
      draggable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      data={data}
    />
  );
}

function sourceHandles(handleId: string) {
  return screen
    .getAllByTestId("handle")
    .filter(handle => handle.getAttribute("data-handle-id") === handleId);
}

function findHandle(handleId: string) {
  return screen
    .getAllByTestId("handle")
    .find(handle => handle.getAttribute("data-handle-id") === handleId);
}

function handlesOfType(type: "source" | "target") {
  return screen
    .getAllByTestId("handle")
    .filter(handle => handle.getAttribute("data-handle-type") === type);
}

// The Meta Flow these tests pick by id; it is stored without a local
// templateId, which the typed test data would otherwise require.
function registrationFlowConfig() {
  return {
    metaFlowId: "flow-1",
    metaFlowName: "Registration",
    ctaText: "Open flow",
    screens: [],
  } as unknown as NonNullable<ActionNodeTestData["actionFlowConfig"]>;
}

// Editors load lazily in the app; load them up front so they render at once.
beforeAll(async () => {
  await Promise.all([
    scenarioEditorChunks.whatsAppInlineEditor.load(),
    scenarioEditorChunks.whatsAppServiceMessageSection.load(),
    scenarioEditorChunks.whatsAppTemplateSection.load(),
    scenarioEditorChunks.generativeAISection.load(),
    scenarioEditorChunks.telegramReplyBuilder.load(),
  ]);
});

describe("ActionNode WhatsApp editor", () => {
  it.each([false, true])(
    "shows a terminal End scenario node in compact=%s mode",
    compact => {
      renderActionNode(
        { kind: "action", actionType: "end_scenario" },
        { compact }
      );
      expect(screen.getByText("actionTypeEndScenario")).toBeTruthy();
      expect(screen.getByText("actionEndScenarioSummary")).toBeTruthy();
      expect(screen.queryByText("badgeAction")).toBeNull();
      expect(document.querySelector(".lucide-send")).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(handlesOfType("source")).toHaveLength(0);
      expect(handlesOfType("target")).toHaveLength(1);
    }
  );

  it.each<ActionNodeTestData>([
    {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Hello" } },
      },
    },
    { kind: "action", actionType: "whatsapp_template" },
  ])(
    "edits selected WhatsApp $actionType nodes directly without a floating launcher",
    data => {
      mockScenarioNodeEnrichment.selectedNodeId = "action-1";
      render(createActionNodeElement("action-1", data, true));

      expect(
        screen.queryByRole("button", { name: "whatsappOpenEditor" })
      ).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
      expect(screen.queryByTestId("scenario-action-node-compact")).toBeNull();
    }
  );

  it.each([
    {
      actionType: "reply" as const,
      placeholder: "actionReplyInstructionPlaceholder",
      field: "actionReplyInstruction",
    },
    {
      actionType: "assign_human" as const,
      placeholder: "actionInstructionPlaceholder",
      field: "actionInstruction",
    },
    {
      actionType: "assign_human" as const,
      placeholder: "handoffNotifyEmailPlaceholder",
      field: "actionHandoffNotifyEmail",
    },
    {
      actionType: "assign_human" as const,
      placeholder: "handoffNotifyWhatsappPlaceholder",
      field: "actionHandoffNotifyWhatsapp",
    },
  ])(
    "updates $field in the graph before blur",
    ({ actionType, placeholder, field }) => {
      renderActionNode({ kind: "action", actionType, actionReplyMode: "ai" });
      const input = screen.getByPlaceholderText(placeholder);
      input.focus();
      fireEvent.change(input, { target: { value: "Unfinished text" } });

      expect(mockPatchNode).toHaveBeenLastCalledWith({
        [field]: "Unfinished text",
      });
      expect(document.activeElement).toBe(input);
    }
  );

  it("warns about an empty fixed reply from the start and defers the generative prompt error until runnable validation", () => {
    const reply: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      uiValidationMode: "draft",
    };
    const view = renderActionNode(reply);
    // The gentle hint shows on drafts so a first scenario is not refused later.
    expect(screen.getByText("fixedReplyEmptyWarning")).toBeTruthy();
    view.rerender(
      createActionNodeElement("action-1", {
        ...reply,
        uiValidationMode: "runnable",
      })
    );
    expect(screen.getByText("fixedReplyEmptyWarning")).toBeTruthy();

    const generative: ActionNodeTestData = {
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "",
      },
      uiValidationMode: "draft",
    };
    view.rerender(createActionNodeElement("action-1", generative));
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(
      createActionNodeElement("action-1", {
        ...generative,
        uiValidationMode: "runnable",
      })
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "generativeAIPromptRequired"
    );
  });

  it.each<[string, ActionNodeTestData, ActionNodeTestData]>([
    [
      "fixed reply",
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Hi {{customer.firstName}}",
      },
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Hi {{customer.firstname}}",
      },
    ],
    [
      "handoff message",
      {
        kind: "action",
        actionType: "assign_human",
        actionInstruction: "Call {{first_name}}",
      },
      {
        kind: "action",
        actionType: "assign_human",
        actionInstruction: "Call {{First_name}}",
      },
    ],
    [
      "service message body",
      serviceTextMessage("Hello {{input.name}}"),
      serviceTextMessage("Hello {{input.Name}}"),
    ],
  ])(
    "flags a %s variable the runtime renders empty (B4)",
    (_label, supported, wronglyCased) => {
      const view = renderActionNode(supported);
      expect(screen.queryByText("variablesUnsupported")).toBeNull();
      view.unmount();

      renderActionNode(wronglyCased);
      expect(screen.getByText("variablesUnsupported")).toBeTruthy();
    }
  );

  it("keeps a pending shared-template update locked after reopening its editor", async () => {
    let finish!: (response: unknown) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionReplyText: "Template body",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
      ],
    };
    const tree = (open: boolean) => (
      <ScenarioEditorDraftProvider>
        {open ? createActionNodeElement("action-1", data) : null}
      </ScenarioEditorDraftProvider>
    );
    const { rerender } = render(tree(true));
    fireEvent.change(await screen.findByDisplayValue("Template body"), {
      target: { value: "Pending draft" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateUpdateShared" })
    );
    // Saving a shared template asks first.
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    rerender(tree(false));
    rerender(tree(true));
    expect(
      (
        screen.getByRole("button", {
          name: "whatsappTemplateUpdateShared",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    finish({ ok: true, json: async () => ({ success: true }) });
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "whatsappTemplateUpdateShared",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
    expect(mockPatchNode).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Pending draft")).toBeTruthy();
  });
  it("keeps edits typed while a template update is pending", async () => {
    let finish!: (response: unknown) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionReplyText: "Template body",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
      ],
    });
    fireEvent.change(await screen.findByDisplayValue("Template body"), {
      target: { value: "Submitted text" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateUpdateShared" })
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue("Submitted text"), {
      target: { value: "Newer draft" },
    });
    finish({ ok: true, json: async () => ({ success: true }) });
    await waitFor(() =>
      expect(mockPatchNode).toHaveBeenCalledWith(
        expect.objectContaining({ actionReplyText: "Submitted text" })
      )
    );
    expect(screen.getByDisplayValue("Newer draft")).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "whatsappTemplateUpdateShared",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
  });
  it("restores template draft inputs after their canvas editor unmounts", async () => {
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Shop", url: "https://example.com" }],
        },
      ],
    };
    const tree = (show: boolean, id = "action-1") => (
      <ScenarioEditorDraftProvider>
        {show ? createActionNodeElement(id, data) : null}
      </ScenarioEditorDraftProvider>
    );
    const { rerender } = render(tree(true));
    fireEvent.change(screen.getByDisplayValue("Shop"), {
      target: { value: "Draft shop" },
    });
    rerender(tree(false));
    rerender(tree(true, "action-2"));
    expect(screen.getByDisplayValue("Shop")).toBeTruthy();
    rerender(tree(false));
    rerender(tree(true));
    await waitFor(() =>
      expect(screen.getByDisplayValue("Draft shop")).toBeTruthy()
    );
    expect(
      (
        screen.getByRole("button", {
          name: "whatsappTemplateUpdateShared",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateDiscardDraft" })
    );
    expect(screen.getByDisplayValue("Shop")).toBeTruthy();
  });
  beforeEach(() => {
    mockScenarioNodeEnrichment.graphIndex.actionNodeCount = 0;
    mockScenarioNodeEnrichment.selectedNodeId = null;
    mockUpdateNodeInternals.mockClear();
    mockPatchNode.mockClear();
    mockActionTemplateOptionsOpen.mockClear();
    mockActionTemplateSelect.mockClear();
    mockActionTemplateCreated.mockClear();
    mockRemoveNodeById.mockClear();
    mockOpenNodePickerFromHandle.mockClear();
    mockEnrichActionNodeData.mockClear();
    mockToastError.mockClear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        message: "Template updated successfully. It will be reviewed by Meta.",
      }),
    });
  });

  it("renders a compact preview for unselected action nodes in large graphs", async () => {
    renderActionNode(
      {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "template_1",
        actionWhatsAppTemplateLanguage: "kk",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Template body" },
        ],
        actionPreviewText: "Template body",
      },
      { compact: true }
    );

    const card = await screen.findByTestId("scenario-action-node-card");
    expect(card.getAttribute("data-compact")).toBe("true");
    expect(screen.queryByTestId("whatsapp-action-renderer")).toBeNull();
    expect(screen.getByTestId("action-node-title").textContent).toBe(
      "template_1"
    );
    expect(screen.getByText("Template body")).toBeTruthy();
    expect(screen.queryByText("whatsappActionKindTemplate")).toBeNull();
    // Settings open by selecting the card, so it has no Settings button.
    expect(document.querySelector("[data-scenario-node-settings]")).toBeNull();
    expect(screen.queryByLabelText("removeBlock")).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "stepActions" }));
    await user.click(screen.getByRole("menuitem", { name: "removeBlock" }));
    expect(mockRemoveNodeById).toHaveBeenCalledWith("action-1");
  });

  it("refreshes compact service route geometry when a hidden branch connects", () => {
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [
            { id: "pricing", label: "Pricing" },
            { id: "delivery", label: "Delivery" },
          ],
        },
      },
    };
    const view = renderActionNode(data, { compact: true });
    mockUpdateNodeInternals.mockClear();

    // Delivery leaves the "+N more" row for a row of its own.
    view.rerender(
      createActionNodeElement("action-1", {
        ...data,
        uiConnections: { whatsAppChoicePayloads: ["delivery"] },
      })
    );

    expect(mockUpdateNodeInternals).toHaveBeenCalledWith("action-1");
    expect(screen.getAllByTestId("action-node-port")).toHaveLength(1);
    expect(screen.getByTestId("action-node-port").textContent).toContain(
      "Delivery"
    );
  });

  it("refreshes expanded handle geometry when an aggregate branch becomes connected", () => {
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "instagram",
      actionInstagramConfig: {
        kind: "quick_replies",
        quickReplies: [{ title: "Pricing", payload: "pricing" }],
      },
    };
    const view = renderActionNode(data);
    mockUpdateNodeInternals.mockClear();

    view.rerender(
      createActionNodeElement("action-1", {
        ...data,
        uiConnections: { instagramPayloads: ["pricing"] },
      })
    );

    expect(mockUpdateNodeInternals).toHaveBeenCalledWith("action-1");
  });

  it("leaves a new inline editor's first measurement to React Flow and refreshes after it resizes", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const resizeCallbacks: (() => void)[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const view = renderActionNode({ kind: "action", actionType: "reply" });
      // Rendering again with the same handles changes nothing either.
      view.rerender(
        createActionNodeElement("action-1", {
          kind: "action",
          actionType: "reply",
          actionReplyText: "Edited",
        })
      );
      act(() => resizeCallbacks.forEach(callback => callback()));
      await act(
        () => new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      );
      expect(mockUpdateNodeInternals).not.toHaveBeenCalled();

      act(() => resizeCallbacks.forEach(callback => callback()));
      await act(
        () => new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      );
      expect(mockUpdateNodeInternals).toHaveBeenCalledWith("action-1");
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("shows selectable video modes while disabled modes stay keyboard-inert", async () => {
    renderActionNode({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a launch clip",
      },
    });

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "generativeAIModeLabel" }),
      { key: "ArrowDown" }
    );

    expect(
      screen
        .getByTestId("generative-ai-mode-text_to_video")
        .getAttribute("aria-disabled")
    ).not.toBe("true");
    expect(
      screen
        .getByTestId("generative-ai-mode-image_to_video")
        .getAttribute("aria-disabled")
    ).not.toBe("true");
    for (const mode of ["audio", "avatar", "text"]) {
      const option = screen.getByTestId(`generative-ai-mode-${mode}`);
      expect(option.getAttribute("aria-disabled")).toBe("true");
      fireEvent.keyDown(option, { key: "Enter" });
    }
    expect(mockPatchNode).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("generative-ai-mode-image_to_video"), {
      key: "Enter",
    });
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionGenerativeAIConfig: {
        version: 1,
        mode: "image_to_video",
        prompt: "Create a launch clip",
      },
    });
  });

  it("persists prompt edits and keeps only fixed Generative AI outcomes", async () => {
    renderActionNode({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "",
      },
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
    });

    expect(screen.getByText("generativeAIPromptRequired")).toBeTruthy();
    expect(screen.queryByTestId("action-source-controls")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^actionOutcomes/ })
    ).toBeNull();

    const handleIds = screen
      .getAllByRole("button")
      .map(button => button.closest("[data-handle-id]"))
      .filter((handle): handle is Element => Boolean(handle))
      .map(handle => handle.getAttribute("data-handle-id"));
    expect(handleIds).toContain(GENERATIVE_AI_SUCCESS_HANDLE);
    expect(handleIds).toContain(GENERATIVE_AI_FAILURE_HANDLE);
    expect(handleIds).not.toContain("right-source");

    fireEvent.change(screen.getByLabelText("generativeAIPromptLabel"), {
      target: { value: "Create a cinematic launch clip" },
    });
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_video",
        prompt: "Create a cinematic launch clip",
      },
    });
  });

  it.each([
    ["text_to_video", "T2V", "generativeAIWaitingForText"],
    ["image_to_video", "I2V", "generativeAIWaitingForImage"],
    ["text_to_image", "generativeAIModeImage", "generativeAIImageInputHint"],
  ] as const)(
    "renders a compact %s card named by its title, with no mode badge or input hint",
    async (mode, badge, expectation) => {
      const data: ActionNodeTestData = {
        kind: "action",
        actionType: "generative_ai",
        actionGenerativeAIConfig: {
          version: 1,
          mode,
          prompt:
            "A very long product launch prompt that must stay inside the compact action card",
        },
      };
      renderActionNode(data, { compact: true });

      await screen.findByTestId("scenario-action-node-card");
      expect(screen.getByTestId("action-node-title").textContent).toBe(
        resolveActionNodeCardTitle(createActionEditorTestData(data), key => key)
      );
      expect(screen.queryByText(badge)).toBeNull();
      expect(screen.queryByText(expectation)).toBeNull();
      expect(screen.queryByText(/branches/)).toBeNull();
      const prompt = screen.getByTestId("action-node-card-preview");
      expect(prompt.textContent).toBe(
        "A very long product launch prompt that must stay inside the compact action card"
      );
      expect(prompt.innerHTML).toContain("line-clamp-2");
    }
  );

  it("hydrates an existing Generative AI node without mutating its config", () => {
    renderActionNode({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "image_to_video",
        prompt: "Animate this exact product photo",
      },
    });

    expect(
      screen.getByRole("combobox", { name: "generativeAIModeLabel" })
        .textContent
    ).toContain("generativeAIModeImageToVideo");
    expect(
      (screen.getByLabelText("generativeAIPromptLabel") as HTMLTextAreaElement)
        .value
    ).toBe("Animate this exact product photo");
    expect(mockPatchNode).not.toHaveBeenCalled();
  });

  it("gives each expanded Generative AI prompt local label and validation ownership", () => {
    render(
      <>
        {createActionNodeElement("action-1", {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_video",
            prompt: "",
          },
        })}
        {createActionNodeElement("action-2", {
          kind: "action",
          actionType: "generative_ai",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "image_to_video",
            prompt: "",
          },
        })}
      </>
    );

    const ownership = screen
      .getAllByTestId("generative-ai-editor")
      .map(editor => {
        const label = Array.from(
          editor.querySelectorAll<HTMLLabelElement>("label[for]")
        ).find(item => item.textContent === "generativeAIPromptLabel");
        const prompt = editor.querySelector<HTMLTextAreaElement>("textarea");
        const error = editor.querySelector<HTMLElement>('[role="alert"]');

        expect(label).toBeDefined();
        expect(prompt).not.toBeNull();
        expect(error).not.toBeNull();
        expect(label!.htmlFor).toBe(prompt!.id);
        expect(prompt!.getAttribute("aria-describedby")).toBe(error!.id);

        return { promptId: prompt!.id, errorId: error!.id };
      });

    expect(new Set(ownership.map(item => item.promptId)).size).toBe(2);
    expect(new Set(ownership.map(item => item.errorId)).size).toBe(2);
  });

  it("patches any-reply and no-reply outcomes on the action", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
    });

    fireEvent.click(screen.getByRole("button", { name: "actionOutcomes" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "actionOutcomeAnyReply" })
    );
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
    });

    fireEvent.click(
      screen.getByRole("checkbox", { name: "actionOutcomeNoReply" })
    );
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });
  });

  it("keeps a connected expanded action outcome anchored without offering another node", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
      },
      uiConnections: { sourceHandleIds: [ACTION_ANY_REPLY_OUTCOME_HANDLE_ID] },
    });

    const outcomeHandle = findHandle(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID);

    expect(outcomeHandle).toBeTruthy();
    expect(outcomeHandle?.querySelector('[role="button"]')).toBeNull();
    fireEvent.click(outcomeHandle!, { clientX: 123, clientY: 456 });
    expect(mockOpenNodePickerFromHandle).not.toHaveBeenCalled();
  });

  it("keeps a connected answer-match outcome anchored without offering another node", () => {
    const answerHandleId = buildScenarioActionAnswerOutcomeHandleId("yes");
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: "yes", mode: "exact", text: "Yes" }],
      },
      uiConnections: { sourceHandleIds: [answerHandleId] },
    });

    const outcomeHandle = findHandle(answerHandleId);

    expect(outcomeHandle).toBeTruthy();
    expect(outcomeHandle?.querySelector('[role="button"]')).toBeNull();
    fireEvent.click(outcomeHandle!, { clientX: 123, clientY: 456 });
    expect(mockOpenNodePickerFromHandle).not.toHaveBeenCalled();
  });

  it("patches the no-reply timeout without touching other action fields", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 30 },
      },
    });

    const timeout = screen.getByLabelText("noReplyTimeoutAmount");
    fireEvent.change(timeout, { target: { value: "45" } });
    fireEvent.blur(timeout);

    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        anyReply: { enabled: true },
        noReply: { enabled: true, timeoutMinutes: 45 },
      },
    });
  });

  it("patches no-reply cancellation phrases on the owning action", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
      actionOutcomes: {
        version: 1,
        noReply: {
          enabled: true,
          timeoutMinutes: 30,
          cancelIfPhrases: ["stop"],
        },
      },
    });

    // Cancel words sit in a closed section under No reply.
    fireEvent.click(
      screen.getByRole("button", { name: /^actionNoReplyCancelTitle/ })
    );
    const phrases = screen.getByRole("textbox", {
      name: "actionNoReplyCancelTitle",
    });
    fireEvent.change(phrases, { target: { value: "stop\ncancel" } });
    fireEvent.blur(phrases);

    expect(mockPatchNode).toHaveBeenLastCalledWith({
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

  it("patches answer text and mode while preserving the rule id", () => {
    const ruleId = "answer-stable";
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: ruleId, mode: "exact", text: "Yes" }],
      },
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "postActionAnswerMatchInputLabel" }),
      { target: { value: "Definitely" } }
    );
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: ruleId, mode: "exact", text: "Definitely" }],
      },
    });

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "postActionAnswerMatchModeLabel" }),
      { key: "ArrowDown" }
    );
    fireEvent.keyDown(
      screen.getByRole("option", { name: /postActionAnswerMatchIntent/ }),
      { key: "Enter" }
    );
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionOutcomes: {
        version: 1,
        answerMatches: [{ id: ruleId, mode: "intent", text: "Yes" }],
      },
    });
  });

  it("patches run conditions while preserving the condition id", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [
          { id: "condition-stable", type: "last_seen_days", minimumDays: 30 },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /^actionRunIf/ }));
    const minimumDays = screen.getByLabelText("runIfInactiveDaysLabel");
    fireEvent.change(minimumDays, { target: { value: "60" } });
    fireEvent.blur(minimumDays);

    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [
          { id: "condition-stable", type: "last_seen_days", minimumDays: 60 },
        ],
      },
    });
  });

  it("keeps Run if available for human handoff without exposing outcomes", () => {
    renderActionNode({
      kind: "action",
      actionType: "assign_human",
      actionInstruction: "Hand off",
      actionRunConditions: {
        version: 1,
        match: "all",
        conditions: [{ id: "vip", type: "internal_label", label: "vip" }],
      },
    });

    expect(screen.getByRole("button", { name: /^actionRunIf/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^actionOutcomes/ })
    ).toBeNull();
  });

  it("keeps unlinked compact routes behind “+N more” without warnings", async () => {
    renderActionNode(
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText:
          "A very long reply preview that stays inside the compact action node",
        actionRunConditions: {
          version: 1,
          match: "all",
          conditions: [{ id: "condition-1", type: "has_purchase_history" }],
        },
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
          noReply: { enabled: true, timeoutMinutes: 120 },
          answerMatches: [
            {
              id: "answer-long",
              mode: "intent",
              text: "A very long interested answer label that must truncate",
            },
          ],
        },
      },
      { compact: true }
    );

    const compactNode = screen.getByTestId("scenario-action-node-card");
    const card = compactNode.firstElementChild;
    expect(card?.className).toContain("w-[300px]");
    expect(card?.className).toContain("max-w-[300px]");
    expect(screen.getByText("actionCardRunIfCount")).toBeTruthy();
    expect(screen.queryByText("actionRunIf 1")).toBeNull();
    // Nothing is linked yet: one row shows, the rest wait behind the toggle.
    expect(screen.getAllByTestId("action-node-port")).toHaveLength(1);
    const expectedHandleIds = [
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      buildScenarioActionAnswerOutcomeHandleId("answer-long"),
    ];
    const outcomeHandles = () =>
      screen
        .getAllByTestId("handle")
        .filter(handle =>
          expectedHandleIds.includes(
            handle.getAttribute("data-handle-id") ?? ""
          )
        );
    expect(outcomeHandles()).toHaveLength(3);
    expect(screen.queryByText(/unconnected/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "actionPortsMoreLabel" })
    );
    expect(
      outcomeHandles().map(handle => handle.getAttribute("data-handle-id"))
    ).toEqual(expectedHandleIds);
    expect(
      outcomeHandles().every(
        handle => handle.closest("[data-testid='action-node-port']") !== null
      )
    ).toBe(true);
  });

  it("opens the node picker from a compact action outcome handle", async () => {
    renderActionNode(
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Reply",
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
        },
      },
      { compact: true }
    );

    // The step's Then route shows first; Any reply waits behind the toggle.
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "actionPortsMoreLabel" }));
    const outcomeHandle = findHandle(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID);
    expect(outcomeHandle).toBeTruthy();

    fireEvent.click(outcomeHandle!, {
      clientX: 123,
      clientY: 456,
    });

    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      123,
      456
    );
  });

  it("shows a connected compact action outcome as a linked route that can change its next step", () => {
    renderActionNode(
      {
        kind: "action",
        actionType: "reply",
        actionReplyMode: "fixed",
        actionReplyText: "Reply",
        actionOutcomes: {
          version: 1,
          anyReply: { enabled: true },
        },
        uiConnections: {
          sourceHandleIds: [ACTION_ANY_REPLY_OUTCOME_HANDLE_ID],
        },
      },
      { compact: true }
    );

    const outcomeHandle = findHandle(ACTION_ANY_REPLY_OUTCOME_HANDLE_ID);
    // Linked routes are listed up front, like the settings-panel card.
    expect(
      outcomeHandle?.closest("[data-testid='action-node-port']")
    ).not.toBeNull();
    expect(outcomeHandle?.className).toContain(
      "scenario-source-handle-button--linked"
    );

    fireEvent.click(outcomeHandle!, { clientX: 123, clientY: 456 });
    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
      123,
      456
    );
  });

  it("does not author a legacy no-reply source handle on compact template quick-reply nodes", () => {
    renderActionNode(
      {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "template_1",
        actionWhatsAppTemplateLanguage: "kk",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Choose language" },
          {
            type: "BUTTONS",
            buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
          },
        ],
        actionPreviewText: "Choose language",
      },
      { compact: true }
    );

    const noReplyHandles = sourceHandles(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(noReplyHandles).toHaveLength(0);
  });

  it("renders the template editor inline (no dialog)", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
      ],
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("actionAdvancedSettings")).toBeNull();
    expect(await screen.findByTestId("whatsapp-action-renderer")).toBeTruthy();
    expect(screen.getByText("whatsappTemplateSelectLabel")).toBeTruthy();
    // The save bar appears only once the template has edits.
    expect(
      screen.queryByRole("button", { name: /whatsappTemplateUpdateShared/i })
    ).toBeNull();
    expect(await screen.findByDisplayValue("Template body")).toBeTruthy();
  });

  it("shows the workspace source picker before WhatsApp action choices", () => {
    const { container } = renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
      ],
    });

    expect(
      screen.getByRole("combobox", { name: "actionSourceSelectLabel" })
        .textContent
    ).toContain("WhatsApp");
    expect(
      screen
        .getByRole("combobox", { name: "actionSourceSelectLabel" })
        .querySelectorAll("img").length
    ).toBe(1);
    expect(container.textContent).not.toContain("Team");
    const sourceControls = screen.getByTestId("action-source-controls");
    const sourcePicker = screen.getByRole("combobox", {
      name: "actionSourceSelectLabel",
    });
    const actionKindPicker = screen.getByRole("combobox", {
      name: "actionWhatsAppKindSelectLabel",
    });
    expect(
      Array.from(sourceControls.querySelectorAll('[role="combobox"]'))
    ).toEqual([sourcePicker, actionKindPicker]);
    expect(
      screen.getByRole("combobox", { name: "actionWhatsAppKindSelectLabel" })
        .textContent
    ).toContain("whatsappActionKindTemplate");
  });

  it("allows rejected generated drafts to retry and projects canonical pending state", async () => {
    const submitGenerated = jest.fn(async () => true);
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
      ],
      generatedTemplateDraft: {
        id: "draft-1",
        name: "template_1",
        language: "kk",
        status: "rejected",
      },
      uiWhatsAppTemplates: { submitGenerated, submittingGenerated: false },
    };
    const { rerender } = renderActionNode(data);
    const retry = screen.getByRole("button", {
      name: "whatsappTemplateSendForReview",
    });
    expect(retry).toHaveProperty("disabled", false);
    fireEvent.click(retry);
    await waitFor(() => expect(submitGenerated).toHaveBeenCalledTimes(1));
    rerender(
      createActionNodeElement("action-1", {
        ...data,
        uiWhatsAppTemplates: { submitGenerated, submittingGenerated: true },
      })
    );
    const pending = screen.getByRole("button", {
      name: "whatsappTemplateSendForReview",
    });
    expect(pending).toHaveProperty("disabled", true);
    fireEvent.click(pending);
    expect(submitGenerated).toHaveBeenCalledTimes(1);
  });

  it("opens the WhatsApp template creation drawer from the builder", async () => {
    render(
      <ActionNode
        id="action-1"
        selected={false}
        type="action"
        dragging={false}
        zIndex={1}
        isConnectable
        selectable
        deletable
        draggable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        data={{
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "template_1",
          actionWhatsAppTemplateLanguage: "kk",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Template body" },
          ],
        }}
      />
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
    );
    fireEvent.click(
      screen.getByRole("option", { name: "whatsappTemplateCreateNew" })
    );

    const drawer = await screen.findByTestId("scenario-template-create-drawer");
    expect(drawer.getAttribute("data-workspace-id")).toBe("workspace-1");

    fireEvent.click(
      screen.getByRole("button", { name: "finish template create" })
    );

    await waitFor(() => {
      expect(mockActionTemplateCreated).toHaveBeenCalledTimes(1);
    });
  });

  it("saves template form edits only after react-hook-form marks it dirty", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
      ],
    });

    expect(
      screen.queryByRole("button", { name: /whatsappTemplateUpdateShared/i })
    ).toBeNull();

    fireEvent.change(screen.getByDisplayValue("Template body"), {
      target: { value: "Updated template body" },
    });

    const saveButton = await screen.findByRole("button", {
      name: /whatsappTemplateUpdateShared/i,
    });
    fireEvent.click(saveButton);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );

    await waitFor(() => {
      expect(mockPatchNode).toHaveBeenCalledWith(
        expect.objectContaining({
          actionReplyText: "Updated template body",
          actionWhatsAppTemplateComponents: expect.arrayContaining([
            expect.objectContaining({
              type: "BODY",
              text: "Updated template body",
            }),
          ]),
        })
      );
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/whatsapp/templates",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"templateId":"meta-template-1"'),
      })
    );
  });

  it("edits WhatsApp template quick-reply button text inline", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
        },
      ],
    });

    expect(screen.getAllByDisplayValue("Kazakh")).toHaveLength(1);
    fireEvent.change(screen.getByDisplayValue("Kazakh"), {
      target: { value: "Kazakh tili" },
    });

    const saveButton = await screen.findByRole("button", {
      name: /whatsappTemplateUpdateShared/i,
    });
    fireEvent.click(saveButton);
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "whatsappTemplateUpdateShared",
      })
    );

    await waitFor(() => {
      expect(mockPatchNode).toHaveBeenCalledWith(
        expect.objectContaining({
          actionWhatsAppTemplateComponents: expect.arrayContaining([
            expect.objectContaining({
              type: "BUTTONS",
              buttons: expect.arrayContaining([
                expect.objectContaining({
                  type: "QUICK_REPLY",
                  text: "Kazakh tili",
                }),
              ]),
            }),
          ]),
        })
      );
    });
  });

  it("renders the reply continuation and branch handles for saved WhatsApp template quick-reply buttons", () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Kazakh" },
            { type: "URL", text: "Website", url: "https://example.com" },
            {
              type: "PHONE_NUMBER",
              text: "Call",
              phone_number: "77001234567",
            },
            { type: "QUICK_REPLY", text: "Russian" },
          ],
        },
      ],
    });

    const handleIds = screen
      .getAllByTestId("handle")
      .map(handle => handle.getAttribute("data-handle-id"));

    expect(handleIds).toContain("right-source");
    expect(handleIds).toContain(buildWhatsAppTemplateButtonSourceHandleId(0));
    expect(handleIds).toContain(buildWhatsAppTemplateButtonSourceHandleId(3));
    expect(handleIds).not.toContain(
      buildWhatsAppTemplateButtonSourceHandleId(1)
    );
    expect(handleIds).not.toContain(
      buildWhatsAppTemplateButtonSourceHandleId(2)
    );
    expect(findHandle("right-source")?.getAttribute("title")).toBe(
      "sourceHandleAnyUserReply"
    );
    expect(findHandle("right-source")?.getAttribute("aria-label")).toBe(
      "sourceHandleAnyUserReply"
    );
    expect(
      findHandle(buildWhatsAppTemplateButtonSourceHandleId(0))?.getAttribute(
        "title"
      )
    ).toBe("sourceHandleTemplateQuickReply");
  });

  it("opens the node picker from the normal reply continuation on WhatsApp templates with quick replies", () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
        },
      ],
    });

    const sourceHandle = screen
      .getAllByTestId("handle")
      .find(
        handle =>
          handle.getAttribute("data-handle-type") === "source" &&
          handle.getAttribute("data-handle-id") === "right-source"
      );

    expect(sourceHandle).toBeTruthy();
    fireEvent.click(sourceHandle!, { clientX: 320, clientY: 240 });

    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      "right-source",
      320,
      240
    );
  });

  it("requires clearing conversation bindings before a primary bulk template can use campaign mappings", () => {
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [{ type: "BODY", text: "Order {{1}}" }],
      actionWhatsAppTemplateBindings: {
        version: 1,
        parameters: { "body:1": { source: "literal", value: "A123" } },
      },
      actionCampaignVariableConfigs: {
        "1": { mode: "csv_column", csvColumn: "order_number" },
      },
      uiBulkPrimaryAction: true,
    };
    const { rerender } = renderActionNode(data);
    expect(
      screen.getByText("whatsappTemplateBindingsBulkConflict")
    ).toBeTruthy();
    expect(screen.queryByTestId("template-bindings-action-1")).toBeNull();
    mockPatchNode.mockClear();
    fireEvent.click(
      screen.getByRole("button", {
        name: "whatsappTemplateBindingsUseCampaign",
      })
    );
    expect(mockPatchNode).toHaveBeenCalledTimes(1);
    expect(mockPatchNode).toHaveBeenCalledWith({
      actionWhatsAppTemplateBindings: undefined,
    });

    rerender(
      createActionNodeElement("action-1", {
        ...data,
        actionWhatsAppTemplateBindings: undefined,
      })
    );
    expect(
      screen.queryByText("whatsappTemplateBindingsBulkConflict")
    ).toBeNull();
    rerender(
      createActionNodeElement("action-1", {
        ...data,
        uiBulkPrimaryAction: false,
      })
    );
    expect(
      screen.queryByText("whatsappTemplateBindingsBulkConflict")
    ).toBeNull();
    expect(screen.getByTestId("template-bindings-action-1")).toBeTruthy();
  });

  it("shows bulk follow-up guidance on primary bulk template actions with quick replies", () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      uiBulkPrimaryAction: true,
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Pricing" },
            { type: "URL", text: "Website", url: "https://example.com" },
          ],
        },
      ],
    });

    expect(screen.getByText("bulkTemplateFollowUpHint")).toBeTruthy();
    // The quick reply keeps its own route; there is no separate branch list.
    expect(screen.getByDisplayValue("Pricing")).toBeTruthy();
    expect(
      screen
        .getAllByTestId("handle")
        .map(handle => handle.getAttribute("data-handle-id"))
    ).toContain(buildWhatsAppTemplateButtonSourceHandleId(0));
  });

  describe("a template's Form submitted route", () => {
    const FORM_SUBMITTED = ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID;
    const formButton = {
      type: "FLOW",
      text: "Open form",
      flow_id: "1571793974235171",
      flow_action: "data_exchange",
    };
    const template = (
      buttons: Record<string, string>[],
      extra: Partial<ActionNodeTestData> = {}
    ): ActionNodeTestData => ({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        { type: "BUTTONS", buttons },
      ] as ActionNodeTestData["actionWhatsAppTemplateComponents"],
      uiConnections: { sourceHandleIds: [FORM_SUBMITTED] },
      ...extra,
    });
    const formHandles = () =>
      screen
        .queryAllByTestId("handle")
        .filter(
          handle => handle.getAttribute("data-handle-id") === FORM_SUBMITTED
        );
    const renderTemplateNode = async (data: ActionNodeTestData) => {
      renderActionNode(data);
      // The form's health read answers after render.
      await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    };

    it.each<[string, boolean, ActionNodeTestData]>([
      ["its FLOW row", true, template([formButton])],
      [
        "a bulk send's anchor",
        false,
        template([formButton], { uiBulkPrimaryWhatsAppTemplate: true }),
      ],
      [
        "the anchor of a route the template no longer offers",
        false,
        template([{ type: "QUICK_REPLY", text: "Yes" }]),
      ],
    ])("draws a linked route once, on %s", async (_label, onRow, data) => {
      await renderTemplateNode(data);

      expect(formHandles()).toHaveLength(1);
      // A row's dot is a route control; an anchor only keeps the edge drawn.
      expect(formHandles()[0].getAttribute("role") === "button").toBe(onRow);
    });

    it("opens the node picker from the FLOW row's dot with the keyboard", async () => {
      await renderTemplateNode(template([formButton], { uiConnections: {} }));
      const [dot] = formHandles();
      expect(dot.getAttribute("aria-label")).toMatch(
        /^serviceRouteFlowSubmitted/
      );

      dot.focus();
      expect(document.activeElement).toBe(dot);
      fireEvent.keyDown(dot, { key: "Enter" });

      expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
        "action-1",
        FORM_SUBMITTED,
        expect.any(Number),
        expect.any(Number)
      );
    });
  });

  it("opens the node picker from a WhatsApp template quick-reply branch handle", () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "Kazakh" }],
        },
      ],
    });

    const handleId = buildWhatsAppTemplateButtonSourceHandleId(0);
    const branchHandle = findHandle(handleId);

    expect(branchHandle).toBeTruthy();
    fireEvent.click(branchHandle!, { clientX: 360, clientY: 260 });

    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      handleId,
      360,
      260
    );
  });

  it("renders canonical WhatsApp choices through the service builder", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick an option" },
          options: [
            {
              id: "wsc:action-1:pricing",
              label: "Pricing",
            },
          ],
        },
      },
    });

    expect(
      await screen.findByTestId("whatsapp-service-message-builder")
    ).toBeTruthy();
    expect(screen.queryByTestId("whatsapp-session-builder")).toBeNull();
    expect(screen.getByDisplayValue("Pricing")).toBeTruthy();

    fireEvent.change(await screen.findByDisplayValue("Pick an option"), {
      target: { value: "Choose a department" },
    });

    expect(mockPatchNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionReplyText: undefined,
        actionWhatsAppServiceMessage: {
          version: 1,
          message: expect.objectContaining({
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose a department" },
          }),
        },
      })
    );
  });

  it("labels a WhatsApp reply button handle as a tap", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick an option" },
          options: [{ id: "wsc:action-1:pricing", label: "Pricing" }],
        },
      },
    });

    await screen.findByTestId("whatsapp-service-message-builder");
    const branchHandleId = buildWhatsAppSessionChoiceSourceHandleId(
      "wsc:action-1:pricing"
    );
    const branchHandle = findHandle(branchHandleId);

    expect(branchHandle?.getAttribute("aria-label")).toBe(
      "sourceHandleWhatsAppButton. sourceHandleStatusUnlinked"
    );
    expect(branchHandle?.className).toContain(
      "scenario-source-handle-button--route"
    );
    expect(branchHandle?.className).toContain(
      "scenario-source-handle-button--unlinked"
    );
    // An unlinked optional route shows a Plus on its amber dot.
    expect(branchHandle?.querySelector(".lucide-plus")).not.toBeNull();
    expect(branchHandle?.querySelector(".lucide-arrow-right")).toBeNull();
  });

  it("labels a WhatsApp list row handle as a pick", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "list",
          body: { mode: "fixed", text: "Pick an option" },
          buttonLabel: "Options",
          sections: [
            {
              id: "section",
              rows: [{ id: "wsc:action-1:pricing", title: "Pricing" }],
            },
          ],
        },
      },
    });

    await screen.findByTestId("whatsapp-service-message-builder");
    const branchHandleId = buildWhatsAppSessionChoiceSourceHandleId(
      "wsc:action-1:pricing"
    );
    const branchHandle = findHandle(branchHandleId);

    expect(branchHandle?.getAttribute("aria-label")).toBe(
      "sourceHandleWhatsAppChoice. sourceHandleStatusUnlinked"
    );
  });

  it("renders only connected compact choice titles as linked branches", () => {
    const branchHandleId = buildWhatsAppSessionChoiceSourceHandleId(
      "wsc:action-1:packaging"
    );
    renderActionNode(
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose packaging" },
            options: [
              { id: "wsc:action-1:packaging", label: "Упаковка" },
              { id: "wsc:action-1:sizes", label: "Размеры" },
            ],
          },
        },
        uiConnections: {
          whatsAppChoicePayloads: ["wsc:action-1:sizes"],
          destinationsBySourceHandle: new Map([
            [
              buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:sizes"),
              { nodeId: "sizes", label: "Size chart {{model}}" },
            ],
          ]),
        },
      },
      { compact: true }
    );

    const compactNode = screen.getByTestId("scenario-action-node-card");
    const rows = screen.getAllByTestId("action-node-port");
    expect(rows).toHaveLength(1);
    expect(screen.queryByText("Упаковка")).toBeNull();
    expect(screen.getByText("Размеры")).toBeTruthy();
    expect(screen.queryByText("serviceRouteChooseNext")).toBeNull();
    expect(screen.queryByText("Choose next")).toBeNull();
    expect(rows[0]?.getAttribute("data-connected")).toBe("true");
    expect(screen.getByText("Size chart …")).toBeTruthy();
    expect(screen.queryByText("Size chart {{model}}")).toBeNull();
    expect(compactNode.textContent).not.toMatch(/branches/);

    const packagingHandle = findHandle(branchHandleId);
    const sizesHandle = findHandle(
      buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:sizes")
    );
    // The unlinked choice keeps an anchor on the "+N more" row.
    expect(
      packagingHandle?.closest("[data-testid='action-node-ports-more']")
    ).not.toBeNull();
    expect(sizesHandle?.className).toContain(
      "scenario-source-handle-button--linked"
    );
    expect(sizesHandle?.className).toContain("!bg-primary");
    // The read-only card edits no routes; the inline editor does.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps unlinked compact carousel replies behind “+N more”", () => {
    const cards = ["one", "two", "three", "four"].map(choiceId => ({
      id: choiceId,
      media: {
        url: `https://cdn.test/${choiceId}.jpg`,
        mediaType: "image" as const,
      },
      interaction: {
        kind: "quick_replies" as const,
        options: [
          {
            id: buildWhatsAppSessionChoicePayload({
              actionNodeId: "action-1",
              choiceId,
            }),
            label: "Интересует",
          },
        ],
      },
    }));

    renderActionNode(
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: { mode: "fixed", text: "Choose a model" },
            cards,
          },
        },
      },
      { compact: true }
    );

    // Nothing is linked: one row shows and three wait behind the toggle.
    expect(screen.getAllByTestId("action-node-port")).toHaveLength(1);
    expect(screen.queryByText(/branches/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "actionPortsMoreLabel" })
    ).toBeTruthy();
    const choiceHandleIds = new Set(
      cards.map(card =>
        buildWhatsAppSessionChoiceSourceHandleId(card.interaction.options[0].id)
      )
    );
    const choiceHandles = screen
      .getAllByTestId("handle")
      .filter(handle =>
        choiceHandleIds.has(handle.getAttribute("data-handle-id") ?? "")
      );
    expect(choiceHandles).toHaveLength(4);
    expect(
      choiceHandles.filter(
        handle =>
          handle.closest("[data-testid='action-node-ports-more']") !== null
      )
    ).toHaveLength(3);
  });

  it("shows a compact carousel reply only after expanded already wired it", () => {
    const unlinkedId = buildWhatsAppSessionChoicePayload({
      actionNodeId: "action-1",
      choiceId: "one",
    });
    const connectedId = buildWhatsAppSessionChoicePayload({
      actionNodeId: "action-1",
      choiceId: "two",
    });
    const connectedHandleId =
      buildWhatsAppSessionChoiceSourceHandleId(connectedId);

    renderActionNode(
      {
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "media_carousel",
            body: { mode: "fixed", text: "Choose a model" },
            cards: [
              {
                id: "one",
                media: {
                  url: "https://cdn.test/one.jpg",
                  mediaType: "image",
                },
                interaction: {
                  kind: "quick_replies",
                  options: [{ id: unlinkedId, label: "Интересует" }],
                },
              },
              {
                id: "two",
                media: {
                  url: "https://cdn.test/two.jpg",
                  mediaType: "image",
                },
                interaction: {
                  kind: "quick_replies",
                  options: [{ id: connectedId, label: "Интересует" }],
                },
              },
            ],
          },
        },
        uiConnections: {
          whatsAppChoicePayloads: [connectedId],
          destinationsBySourceHandle: new Map([
            [connectedHandleId, { nodeId: "offer", label: "Offer details" }],
          ]),
        },
      },
      { compact: true }
    );

    const rows = screen.getAllByTestId("action-node-port");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Интересует");
    expect(rows[0]?.getAttribute("data-connected")).toBe("true");
    expect(screen.getByText("Offer details")).toBeTruthy();
    expect(screen.queryByText(/branches/)).toBeNull();

    const unlinkedHandle = findHandle(
      buildWhatsAppSessionChoiceSourceHandleId(unlinkedId)
    );
    const connectedHandle = findHandle(connectedHandleId);
    // The unlinked reply waits behind "+N more", anchored on that row.
    expect(
      unlinkedHandle?.closest("[data-testid='action-node-ports-more']")
    ).not.toBeNull();
    expect(connectedHandle?.className).toContain(
      "scenario-source-handle-button--linked"
    );
  });

  it("renders canonical appointment data through the service builder", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "appointment",
          body: { mode: "fixed", text: "Choose a call time" },
          config: {
            enabled: true,
            dateRangeMode: "custom_days",
            durationMinutes: 30,
            minNoticeMinutes: 120,
            horizonDays: 5,
            maxSlots: 5,
            timeZone: "UTC",
            eventTitle: "Demo call",
            createMeetLink: true,
          },
        },
      },
    });

    expect(
      await screen.findByTestId("whatsapp-service-message-builder")
    ).toBeTruthy();
    expect(screen.getByDisplayValue("Choose a call time")).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "whatsappBookCallDurationLabel"
        ) as HTMLInputElement
      ).value
    ).toBe("30");
    expect(
      (
        screen.getByLabelText(
          "whatsappBookCallMaxSlotsLabel"
        ) as HTMLInputElement
      ).value
    ).toBe("5");
    expect(
      (
        screen.getByLabelText(
          "whatsappBookCallTimeZoneLabel"
        ) as HTMLInputElement
      ).value
    ).toBe("UTC");
  });

  it("keeps unsupported canonical service messages read-only", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 99,
        message: { kind: "future-provider-message" },
      } as never,
    });

    expect(
      screen.getByText("whatsappServiceMessageUnsupportedEditor")
    ).toBeTruthy();
    expect(screen.queryByTestId("whatsapp-service-message-builder")).toBeNull();
    expect(mockPatchNode).not.toHaveBeenCalled();
  });

  it("uploads one dropped or selected media file without legacy persistence", async () => {
    const mockUploadActionImage = jest
      .fn()
      .mockImplementation(async (file: File) => ({
        url: `https://cdn.example/${file.name}`,
        fileName: file.name,
        mediaType: file.type === "application/pdf" ? "document" : "image",
      }));
    const { container } = renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "media",
          attachment: { url: "", mediaType: "image" },
          body: { mode: "fixed", text: "See this" },
        },
      },
      uiMedia: { upload: mockUploadActionImage },
    });

    const pdf = new File(["pdf"], "menu.pdf", { type: "application/pdf" });
    const image = new File(["image"], "photo.png", { type: "image/png" });

    fireEvent.drop(screen.getByTestId("whatsapp-service-media-dropzone"), {
      dataTransfer: { files: [pdf] },
    });

    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [image] },
    });

    await waitFor(() => {
      expect(mockUploadActionImage).toHaveBeenCalledWith(pdf, {
        persist: false,
      });
      expect(mockUploadActionImage).toHaveBeenCalledWith(image, {
        persist: false,
      });
    });
  });

  it("uploads selected files before clearing the live file input", async () => {
    const mockUploadActionImage = jest.fn().mockResolvedValue({
      url: "https://cdn.example/photo.png",
      fileName: "photo.png",
      mediaType: "image",
    });
    const { container } = renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "media",
          attachment: { url: "", mediaType: "image" },
          body: { mode: "fixed", text: "See this" },
        },
      },
      uiMedia: { upload: mockUploadActionImage },
    });
    const image = new File(["image"], "photo.png", { type: "image/png" });
    let selectedFiles = [image];
    const liveFiles = {
      get length() {
        return selectedFiles.length;
      },
      item(index: number) {
        return selectedFiles[index] ?? null;
      },
      *[Symbol.iterator]() {
        yield* selectedFiles;
      },
    };
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;

    Object.defineProperty(fileInput, "files", {
      configurable: true,
      get: () => liveFiles,
    });
    Object.defineProperty(fileInput, "value", {
      configurable: true,
      get: () => "",
      set: (value: string) => {
        if (value === "") selectedFiles = [];
      },
    });

    fireEvent.change(fileInput);

    await waitFor(() => {
      expect(mockUploadActionImage).toHaveBeenCalledWith(image, {
        persist: false,
      });
    });
  });

  it("updates the canonical service message when a quick reply is deleted", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose one" },
          options: [
            { id: "wsc:action-1:one", label: "One" },
            { id: "wsc:action-1:two", label: "Two" },
          ],
        },
      },
    });

    expect(
      await screen.findByTestId("whatsapp-service-message-builder")
    ).toBeTruthy();
    expect(screen.getByDisplayValue("One")).toBeTruthy();
    expect(screen.getByDisplayValue("Two")).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("button", { name: "whatsappServiceDeleteButton" })[0]!
    );

    expect(mockPatchNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "reply_buttons",
            body: { mode: "fixed", text: "Choose one" },
            options: [{ id: "wsc:action-1:two", label: "Two" }],
          },
        },
      })
    );
  });

  it("returns to a text service message when the final choice is removed", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose one" },
          options: [{ id: "wsc:action-1:only", label: "Only" }],
        },
      },
    });

    expect(
      await screen.findByTestId("whatsapp-service-message-builder")
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceRemoveAction" })
    );
    fireEvent.click(screen.getByRole("button", { name: "delete" }));

    expect(mockPatchNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Choose one" },
            previewUrl: true,
          },
        },
      })
    );
  });

  it("keeps stable branch ids after converting reply buttons to a list", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose one" },
          options: [
            { id: "wsc:action-1:one", label: "One" },
            { id: "wsc:action-1:two", label: "Two" },
            { id: "wsc:action-1:three", label: "Three" },
          ],
        },
      },
    });

    expect(
      await screen.findByTestId("whatsapp-service-message-builder")
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappServiceAddReplyButton" })
    );

    fireEvent.click(screen.getByRole("button", { name: "continue" }));
    expect(mockPatchNode).toHaveBeenLastCalledWith(
      expect.objectContaining({
        actionWhatsAppServiceMessage: {
          version: 1,
          message: expect.objectContaining({
            kind: "list",
            sections: [
              expect.objectContaining({
                rows: [
                  { id: "wsc:action-1:one", title: "One" },
                  { id: "wsc:action-1:two", title: "Two" },
                  { id: "wsc:action-1:three", title: "Three" },
                  {
                    id: expect.stringMatching(/^wsc:action-1:/),
                    title: "",
                  },
                ],
              }),
            ],
          }),
        },
      })
    );
  });

  it("keeps template nodes compact when a flow button is picked", () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      uiWhatsAppFlows: { options: [{ id: "flow-1", name: "Flow 1" }] },
    });

    const card = screen
      .getByTestId("whatsapp-action-renderer")
      .closest('[class*="border-2"]');

    expect(card?.className).toContain("w-[384px]");
    expect(card?.className).not.toContain("48rem");
  });

  it("keeps wheel gestures inside a canonical WhatsApp Flow action node", async () => {
    const parentWheel = jest.fn();

    render(
      <div onWheel={parentWheel}>
        {createActionNodeElement("action-1", {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "flow",
              body: { mode: "fixed", text: "Open the form" },
              flowConfig: {
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
                        options: [
                          { id: "opt_1", title: "Yes" },
                          { id: "opt_2", title: "No" },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        })}
      </div>
    );

    fireEvent.wheel(await screen.findByTestId("template-flow-builder"), {
      deltaX: 120,
      deltaY: 0,
    });

    expect(parentWheel).not.toHaveBeenCalled();
  });

  it("renders a connected WhatsApp Flow option with its exact branch identity", async () => {
    const branchId = buildFlowBranchOptionKey("field_1", "opt_1");
    const handleId = buildFlowBranchSourceHandleId("field_1", "opt_1");
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open the form" },
          flowConfig: {
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
                    options: [{ id: "opt_1", title: "Yes" }],
                  },
                ],
              },
            ],
          },
        },
      },
      uiConnections: {
        flowBranchIds: [branchId],
        destinationsBySourceHandle: new Map([
          [handleId, { nodeId: "details", label: "Delivery details" }],
        ]),
      },
    });

    await screen.findByTestId("template-flow-builder");
    const flowHandle = findHandle(handleId);
    expect(flowHandle).toBeTruthy();
    const routeButton = screen.getByRole("button", {
      name: "sourceHandleFlowOption. sourceHandleStatusLinked Delivery details",
    });
    fireEvent.click(routeButton, { clientX: 123, clientY: 456 });
    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      handleId,
      123,
      456
    );
  });

  it("marks every connected WhatsApp Flow radio option as connected", async () => {
    const firstHandleId = buildFlowBranchSourceHandleId("field_1", "opt_1");
    const secondHandleId = buildFlowBranchSourceHandleId("field_1", "opt_2");

    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "flow",
          body: { mode: "fixed", text: "Open the form" },
          flowConfig: {
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
                    options: [
                      { id: "opt_1", title: "Yes" },
                      { id: "opt_2", title: "No" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      uiConnections: {
        flowBranchIds: [
          buildFlowBranchOptionKey("field_1", "opt_1"),
          buildFlowBranchOptionKey("field_1", "opt_2"),
        ],
      },
    });

    await screen.findByTestId("template-flow-builder");

    for (const handleId of [firstHandleId, secondHandleId]) {
      const flowHandle = findHandle(handleId);
      expect(flowHandle).toBeTruthy();
      expect(flowHandle?.querySelector(".lucide-plus")).toBeNull();
      expect(flowHandle?.getAttribute("role")).toBe("button");
    }
  });

  it("opens the create-node picker when a route control is clicked", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyMode: "fixed",
      actionReplyText: "Reply",
    });

    const sourceHandle = screen
      .getAllByTestId("handle")
      .find(
        handle =>
          handle.getAttribute("data-handle-type") === "source" &&
          handle.getAttribute("data-handle-id") === "right-source"
      );

    expect(sourceHandle).toBeTruthy();
    fireEvent.click(sourceHandle!, { clientX: 320, clientY: 240 });

    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      "right-source",
      320,
      240
    );
  });

  it("updates fixed reply text before blur and does not replay it on unmount", async () => {
    mockScenarioNodeEnrichment.selectedNodeId = "action-1";
    const { unmount } = render(
      createActionNodeElement(
        "action-1",
        {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Initial reply",
        },
        true
      )
    );

    const user = userEvent.setup();
    const replyEditor = screen.getByRole("textbox");
    await user.clear(replyEditor);
    await user.type(replyEditor, "Draft reply");
    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionReplyText: "Draft reply",
    });
    expect(document.activeElement).toBe(replyEditor);
    mockPatchNode.mockClear();

    unmount();

    expect(mockPatchNode).not.toHaveBeenCalled();
  });

  it("keeps the inline template flow drawer open after a canvas click", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      actionFlowConfig: registrationFlowConfig(),
      uiWhatsAppFlows: {
        options: [{ id: "flow-1", name: "Registration" }],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );

    expect(await screen.findByTestId("template-flow-builder")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "flowBuilderLabel" })
    ).toBeTruthy();
    expect(screen.queryByTestId("drawer-overlay")).toBeNull();

    fireEvent(window, new Event("mock-drawer-outside-click"));

    expect(
      screen.getByRole("dialog", { name: "flowBuilderLabel" })
    ).toBeTruthy();
    expect(screen.getByTestId("template-flow-builder")).toBeTruthy();
  });

  it("surfaces a lossless-import failure without opening the inline Flow editor", async () => {
    const selectExistingFlow = jest
      .fn()
      .mockRejectedValue(new Error("This Flow cannot be imported losslessly"));

    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      uiWhatsAppFlows: {
        options: [{ id: "flow-1", name: "Registration" }],
        select: selectExistingFlow,
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("flowExistingLoadFailed")
    );
    expect(screen.queryByTestId("template-flow-builder")).toBeNull();
  });

  it("keeps wheel gestures inside the inline template flow drawer", async () => {
    const parentWheel = jest.fn();

    render(
      <div onWheel={parentWheel}>
        {createActionNodeElement("action-1", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "template_1",
          actionWhatsAppTemplateLanguage: "kk",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Template body" },
            {
              type: "BUTTONS",
              buttons: [
                {
                  type: "FLOW",
                  text: "Open flow",
                  flow_id: "flow-1",
                  flow_action: "navigate",
                },
              ],
            },
          ],
          actionFlowConfig: registrationFlowConfig(),
          uiWhatsAppFlows: {
            options: [{ id: "flow-1", name: "Registration" }],
          },
        })}
      </div>
    );

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );

    const builder = await screen.findByTestId("template-flow-builder");

    fireEvent.wheel(builder, { deltaX: 120, deltaY: 0 });

    expect(parentWheel).not.toHaveBeenCalled();
  });

  it("renders the inline template flow builder flush with the drawer body", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      actionFlowConfig: registrationFlowConfig(),
      uiWhatsAppFlows: {
        options: [{ id: "flow-1", name: "Registration" }],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );

    const builder = await screen.findByTestId("template-flow-builder");
    const drawerBody = builder.parentElement;
    const drawerPanel = screen.getByRole("dialog", {
      name: "flowBuilderLabel",
    });
    const clippingLayer = drawerPanel.parentElement;

    expect(drawerBody?.className).toContain("p-0");
    expect(drawerBody?.className).not.toContain("px-4");
    expect(drawerBody?.className).not.toContain("pb-4");
    expect(drawerPanel.className).toContain("overflow-hidden");
    expect(clippingLayer?.className).toContain("rounded-[inherit]");
  });

  it("does not prevent outside pointer events while the inline template flow drawer is open", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      actionFlowConfig: registrationFlowConfig(),
      uiWhatsAppFlows: {
        options: [{ id: "flow-1", name: "Registration" }],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );

    expect(await screen.findByTestId("template-flow-builder")).toBeTruthy();

    const outsidePointerDown = new Event("mock-drawer-outside-pointer-down", {
      cancelable: true,
    });
    fireEvent(window, outsidePointerDown);

    expect(outsidePointerDown.defaultPrevented).toBe(false);
  });

  it("keeps the legacy interactive source anchored without a visible control", async () => {
    renderActionNode({
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateName: "template_1",
      actionWhatsAppTemplateLanguage: "kk",
      actionWhatsAppTemplateComponents: [
        { type: "BODY", text: "Template body" },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "FLOW",
              text: "Open flow",
              flow_id: "flow-1",
              flow_action: "navigate",
            },
          ],
        },
      ],
      actionFlowConfig: {
        templateId: "customer_feedback",
        metaFlowId: "flow-1",
        metaFlowName: "Registration",
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
                options: [
                  { id: "one", title: "One" },
                  { id: "two", title: "Two" },
                ],
              },
            ],
          },
        ],
      },
      uiWhatsAppFlows: {
        options: [{ id: "flow-1", name: "Registration" }],
      },
      uiConnections: {
        sourceHandleIds: [ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID],
      },
    });

    expect(screen.getByTestId("flow-branch-preview")).toBeTruthy();
    expect(screen.queryByText("flowDirectReplyBranch")).toBeNull();
    const closedDirectReplyHandles = sourceHandles(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(closedDirectReplyHandles).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "whatsappTemplateOpenFlow" })
    );

    expect(await screen.findByTestId("template-flow-builder")).toBeTruthy();
    expect(screen.queryByTestId("flow-branch-preview")).toBeNull();
    const openDirectReplyHandles = sourceHandles(
      ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
    );
    expect(openDirectReplyHandles).toHaveLength(1);
    expect(screen.queryByLabelText("legacy interactive no reply")).toBeNull();
  });

  it("renders Telegram Builder when that action selector is selected", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionReplyMode: "fixed",
      actionReplyText: "Telegram text",
      actionTelegramQuickReplies: [],
    });

    expect(await screen.findByTestId("telegram-builder")).toBeTruthy();
    expect(screen.queryByText("loadingItems")).toBeNull();
  });

  it("renders dedicated Telegram branch handles for each quick-reply button", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionReplyMode: "fixed",
      actionReplyText: "Telegram text",
      actionTelegramQuickReplies: [
        [
          { text: "Yes", payload: "yes" },
          { text: "No", payload: "no" },
        ],
      ],
    });

    await screen.findByTestId("telegram-builder");
    const handleIds = screen
      .getAllByTestId("handle")
      .map(handle => handle.getAttribute("data-handle-id"));

    expect(handleIds).toContain(buildTelegramBranchSourceHandleId("yes"));
    expect(handleIds).toContain(buildTelegramBranchSourceHandleId("no"));
  });

  it("opens the node picker from a Telegram quick-reply branch handle", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionReplyMode: "fixed",
      actionReplyText: "Telegram text",
      actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
    });

    await screen.findByTestId("telegram-builder");
    const handleId = buildTelegramBranchSourceHandleId("yes");
    const branchHandle = findHandle(handleId);

    expect(branchHandle).toBeTruthy();
    expect(branchHandle?.getAttribute("aria-label")).toBe(
      "sourceHandleTelegramButton. sourceHandleStatusUnlinked"
    );
    fireEvent.click(branchHandle!, { clientX: 310, clientY: 240 });

    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      handleId,
      310,
      240
    );
  });

  it("lets a connected Telegram branch rewire from its route handle", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionReplyMode: "fixed",
      actionReplyText: "Telegram text",
      actionTelegramQuickReplies: [[{ text: "Yes", payload: "yes" }]],
      uiConnections: { telegramPayloads: ["yes"] },
    });

    await screen.findByTestId("telegram-builder");
    const handleId = buildTelegramBranchSourceHandleId("yes");
    const branchHandle = findHandle(handleId);

    expect(branchHandle).toBeTruthy();
    expect(branchHandle?.getAttribute("role")).toBe("button");
    fireEvent.click(branchHandle!, { clientX: 310, clientY: 240 });
    expect(mockOpenNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      handleId,
      310,
      240
    );
  });

  it("renders Instagram Reply with the native Instagram builder", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "instagram",
      actionReplyMode: "fixed",
      actionReplyText: "Instagram text",
    });

    expect(await screen.findByTestId("instagram-builder")).toBeTruthy();
    expect(screen.queryByTestId("telegram-builder")).toBeNull();
  });

  it("disables Instagram Reply when attached to a bulk campaign path", async () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "instagram",
      actionReplyMode: "fixed",
      actionReplyText: "Instagram text",
      uiInstagramReplyDisabledReason: "Instagram disabled for bulk",
    });

    expect(
      (await screen.findByTestId("instagram-builder")).getAttribute(
        "data-disabled"
      )
    ).toBe("true");
    expect(screen.getByText("instagramReplyDisabledBadge")).toBeTruthy();
    // The editor's own notice says why; the header hint repeats it on
    // request and describes its button for screen readers.
    expect(screen.getAllByText("Instagram disabled for bulk")).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "infoHintLabel",
        description: "Instagram disabled for bulk",
      })
    ).toBeTruthy();
    expect(screen.queryByTestId("node-tooltip")).toBeNull();

    fireEvent.pointerEnter(screen.getByText("instagramReplyDisabledBadge"));
    expect(screen.queryByTestId("node-tooltip")).toBeNull();

    const badge = screen.getByText("instagramReplyDisabledBadge");
    await userEvent.setup().click(
      within(badge.parentElement!).getByRole("button", {
        name: "infoHintLabel",
      })
    );
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Instagram disabled for bulk"
    );
  });

  it("shows collected and unmet handles for a text service message that asks for details", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: {
            mode: "fixed",
            text: "Write your name and sport, or send a voice note.",
          },
          previewUrl: false,
        },
        promptInputs: [
          { key: "name", label: "Name", prompt: "customer name" },
          { key: "sport", label: "", prompt: "sport they play" },
        ],
      },
    });

    const handles = screen.getAllByTestId("handle");
    const handleIds = handles.map(handle =>
      handle.getAttribute("data-handle-id")
    );
    expect(handleIds.filter(id => id === "right-source")).toHaveLength(1);
    expect(
      handleIds.filter(id => id === "right-source-prompt-inputs::unmet")
    ).toHaveLength(1);
    // Both outputs are labelled rows at the bottom of the card.
    const rows = screen.getAllByTestId("action-node-fixed-output");
    expect(
      rows.map(row =>
        row.querySelector("[data-handle-id]")?.getAttribute("data-handle-id")
      )
    ).toEqual(["right-source", "right-source-prompt-inputs::unmet"]);
    expect(rows[0].textContent).toContain("whatsappServicePromptInputsMet");
    expect(rows[1].textContent).toContain("whatsappServicePromptInputsUnmet");
    expect(
      handles
        .find(
          handle => handle.getAttribute("data-handle-id") === "right-source"
        )
        ?.getAttribute("aria-label")
    ).toMatch(/^whatsappServicePromptInputsMet/);
    expect(
      handles
        .find(
          handle =>
            handle.getAttribute("data-handle-id") ===
            "right-source-prompt-inputs::unmet"
        )
        ?.getAttribute("aria-label")
    ).toMatch(/^whatsappServicePromptInputsUnmet/);
  });

  it("shows only the unmet handle beside the options of a buttons message that asks for details", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: {
            mode: "fixed",
            text: "Pick a frame, then send the name.",
          },
          options: [{ id: "wsc:action-1:gold", label: "Gold" }],
        },
        promptInputs: [{ key: "name", label: "Name", prompt: "customer name" }],
      },
    });

    const handles = screen.getAllByTestId("handle");
    const handleIds = handles.map(handle =>
      handle.getAttribute("data-handle-id")
    );
    expect(handleIds).toContain("right-source-prompt-inputs::unmet");
    expect(
      handles
        .find(
          handle => handle.getAttribute("data-handle-id") === "right-source"
        )
        ?.getAttribute("aria-label")
    ).not.toBe("whatsappServicePromptInputsMet");
  });

  const collectedName = [
    { key: "name", label: "Name", prompt: "Name on the holder" },
  ];

  it("offers collected answers in a fixed reply's variables", () => {
    mockScenarioNodeEnrichment.selectedNodeId = "action-1";
    render(
      createActionNodeElement(
        "action-1",
        {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Hello",
          uiScenarioPromptInputs: collectedName,
        },
        true
      )
    );

    fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));
    fireEvent.click(screen.getByTestId("service-message-variable-input.name"));

    expect(mockPatchNode).toHaveBeenLastCalledWith({
      actionReplyText: "Hello {{input.name}}",
    });
  });

  it("offers collected answers in a service message body's variables", () => {
    mockScenarioNodeEnrichment.selectedNodeId = "action-1";
    render(
      createActionNodeElement(
        "action-1",
        {
          kind: "action",
          actionType: "reply",
          actionWhatsAppServiceMessage: {
            version: 1,
            message: {
              kind: "text",
              body: { mode: "fixed", text: "Hello" },
              previewUrl: false,
            },
          },
          uiScenarioPromptInputs: collectedName,
        },
        true
      )
    );

    fireEvent.click(screen.getByTestId("whatsapp-service-message-variables"));

    expect(
      screen.getByTestId("service-message-variable-input.name")
    ).toBeTruthy();
  });
});

describe("ActionNode inline card chrome", () => {
  beforeEach(() => {
    mockScenarioNodeEnrichment.graphIndex.actionNodeCount = 0;
    mockScenarioNodeEnrichment.selectedNodeId = null;
    mockTranslation.withValues = false;
    mockOpenNodePickerFromHandle.mockClear();
    mockRemoveNodeById.mockClear();
  });
  afterEach(() => {
    mockTranslation.withValues = false;
  });

  it("names the step in its header, with a step menu instead of a trash button", () => {
    const data: ActionNodeTestData = {
      kind: "action",
      actionType: "assign_human",
      actionInstruction: "A manager will reply soon",
    };
    renderActionNode(data);
    expect(screen.getByTestId("action-node-title").textContent).toBe(
      resolveActionNodeCardTitle(createActionEditorTestData(data), key => key)
    );
    expect(document.querySelector("[data-kind-icon='assign_human']")).not.toBe(
      null
    );
    expect(screen.queryByText("badgeAction")).toBeNull();
    expect(document.querySelector(".lucide-send")).toBeNull();
    expect(screen.queryByLabelText("removeBlock")).toBeNull();
    expect(screen.getByRole("button", { name: "stepActions" })).toBeTruthy();
  });

  it("labels AI results as rows at the bottom, each handle rendered once", () => {
    renderActionNode({
      kind: "action",
      actionType: "generative_ai",
      actionGenerativeAIConfig: {
        version: 1,
        mode: "text_to_image",
        prompt: "A poster",
      },
    });
    const rows = screen.getAllByTestId("action-node-fixed-output");
    expect(
      rows.map(row =>
        row.querySelector("[data-handle-id]")?.getAttribute("data-handle-id")
      )
    ).toEqual([GENERATIVE_AI_SUCCESS_HANDLE, GENERATIVE_AI_FAILURE_HANDLE]);
    expect(rows[0].textContent).toContain("generativeAISuccess");
    expect(rows[1].textContent).toContain("generativeAIFailure");
    for (const handleId of [
      GENERATIVE_AI_SUCCESS_HANDLE,
      GENERATIVE_AI_FAILURE_HANDLE,
    ]) {
      const handles = sourceHandles(handleId);
      expect(handles).toHaveLength(1);
      // No unlabelled floating handle on the node edge any more.
      expect(
        handles[0].closest("[data-testid='action-node-fixed-output']")
      ).not.toBeNull();
    }
  });

  it("labels an Instagram shared route as a row at the bottom", () => {
    renderActionNode({
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
    });
    const handles = sourceHandles(ACTION_INSTAGRAM_BRANCH_OUTPUT_HANDLE_ID);
    expect(handles).toHaveLength(1);
    const row = handles[0].closest("[data-testid='action-node-fixed-output']");
    expect(row?.textContent).toContain("Pricing, Support");
  });

  it("warns on a WhatsApp chat message reached after a long No reply", () => {
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: { kind: "text", body: { mode: "fixed", text: "Still?" } },
      },
      uiReachedAfterLongNoReply: true,
    });
    expect(
      screen.getByTestId("action-node-long-wait-notice").textContent
    ).toContain("actionLongWaitNeedsTemplate");
  });

  describe("a Reply route that a linked No reply keeps from running", () => {
    const noReplyOn = {
      version: 1 as const,
      noReply: { enabled: true, timeoutMinutes: 30 },
    };
    const isHiddenAnchor = (handle: HTMLElement) =>
      handle.className.includes("!pointer-events-none");

    it("warns in the header and keeps the linked route's dot", () => {
      mockTranslation.withValues = true;
      renderActionNode({
        ...serviceTextMessage("Still?"),
        actionOutcomes: noReplyOn,
        uiConnections: {
          sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID, "right-source"],
        },
      });
      expect(
        screen.getByTestId("action-node-unreachable-route-notice").textContent
      ).toBe(
        `actionDefaultRouteCannotRun:${JSON.stringify({
          route: "serviceRouteNextMessage",
          anyReply: "actionOutcomeAnyReply",
          anyReplyLinked: "no",
        })}`
      );
      const handles = sourceHandles("right-source");
      expect(handles).toHaveLength(1);
      expect(isHiddenAnchor(handles[0])).toBe(false);
    });

    it("keeps only an invisible anchor while the route is unlinked", () => {
      renderActionNode({
        ...serviceTextMessage("Still?"),
        actionOutcomes: noReplyOn,
        uiConnections: { sourceHandleIds: [ACTION_NO_REPLY_OUTCOME_HANDLE_ID] },
      });
      expect(
        screen.queryByTestId("action-node-unreachable-route-notice")
      ).toBeNull();
      const handles = sourceHandles("right-source");
      expect(handles).toHaveLength(1);
      expect(isHiddenAnchor(handles[0])).toBe(true);
    });
  });

  it("names unnamed Telegram buttons and reply buttons as untitled buttons", async () => {
    mockTranslation.withValues = true;
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "telegram",
      actionReplyText: "Choose",
      actionTelegramQuickReplies: [[{ text: " ", payload: "blank" }]],
    });
    const telegramHandle = sourceHandles(
      buildTelegramBranchSourceHandleId("blank")
    )[0];
    expect(telegramHandle?.getAttribute("aria-label")).toContain(
      "untitledButton"
    );
    expect(telegramHandle?.getAttribute("aria-label")).not.toContain(
      "telegramBuilderButtonTextPlaceholder"
    );
  });

  it("names an unnamed WhatsApp reply button as an untitled button", async () => {
    mockTranslation.withValues = true;
    renderActionNode({
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Pick one" },
          options: [{ id: "wsc:action-1:blank", label: "" }],
        },
      },
    });
    await screen.findByTestId("whatsapp-service-message-builder");
    const handle = sourceHandles(
      buildWhatsAppSessionChoiceSourceHandleId("wsc:action-1:blank")
    )[0];
    expect(handle?.getAttribute("aria-label")).toContain("untitledButton");
    expect(handle?.getAttribute("aria-label")).not.toContain(
      "whatsAppSessionChoiceFallbackLabel"
    );
  });
});
