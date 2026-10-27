/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { AiriBuilderPatch } from "@/lib/airi-chats/builder-state";
import type { AiriWhatsAppTemplateDraft } from "@/lib/airi-chats/whatsapp-template-drafts";
import { scenarioEditorChunks } from "@/components/scenarios/scenario-editor-chunks";
import {
  AiriBuilderSidePanel,
  type AiriBuilderPendingPatchTarget,
} from "./airi-builder-side-panel";

const mockFetchWhatsAppFlowsList = jest.fn();
const mockFetchWhatsAppFlowDetails = jest.fn();
const mockParseFlowJsonToWhatsAppFlowConfig = jest.fn();
const mockFetch = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={String(props.alt || "")} />;
  },
}));

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

jest.mock("@/components/scenarios/builders/whatsapp/inline-editor", () => ({
  WhatsAppInlineEditor: ({
    value,
    onChange,
    onBlur,
    placeholder,
    multiline = true,
    className,
  }: {
    value: string;
    onChange: (value: string) => void;
    onBlur?: () => void;
    placeholder?: string;
    multiline?: boolean;
    className?: string;
  }) =>
    multiline ? (
      <textarea
        aria-label={placeholder || "editor"}
        className={className}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ) : (
      <input
        aria-label={placeholder || "editor"}
        className={className}
        value={value}
        onChange={event => onChange(event.target.value)}
        onBlur={onBlur}
      />
    ),
}));

jest.mock("@/components/whatsapp-templates/template-editor-form", () => ({
  TemplateEditorForm: () => <div data-testid="legacy-template-editor-form" />,
}));

jest.mock("@/components/scenarios/builders/whatsapp/field-editor", () => ({
  FieldEditor: ({
    flowConfig,
    onChange,
  }: {
    flowConfig: WhatsAppFlowConfig;
    onChange: (config: WhatsAppFlowConfig) => void;
  }) => (
    <button
      type="button"
      data-testid="flow-field-editor"
      onClick={() =>
        onChange({
          ...flowConfig,
          bodyText: "Edited while provider save is pending",
        })
      }
    />
  ),
  FlowFormEditorContent: () => <div data-testid="flow-form-editor" />,
}));

jest.mock("@/lib/whatsapp/flows/client", () => ({
  fetchWhatsAppFlowsList: (...args: unknown[]) =>
    mockFetchWhatsAppFlowsList(...args),
  fetchWhatsAppFlowDetails: (...args: unknown[]) =>
    mockFetchWhatsAppFlowDetails(...args),
}));

jest.mock("@/components/scenarios/builders/whatsapp/flow-json-parser", () => ({
  parseFlowJsonToWhatsAppFlowConfig: (...args: unknown[]) =>
    mockParseFlowJsonToWhatsAppFlowConfig(...args),
}));

const INITIAL_TEMPLATE_DRAFT: AiriWhatsAppTemplateDraft = {
  kind: "whatsapp_template" as const,
  name: "airi_template",
  language: "en",
  category: "MARKETING" as const,
  components: [
    {
      type: "BODY" as const,
      text: "Hi {{1}}, want help choosing a plan?",
    },
  ],
};

const FLOW_TEMPLATE_DRAFT: AiriWhatsAppTemplateDraft = {
  ...INITIAL_TEMPLATE_DRAFT,
  components: [
    ...INITIAL_TEMPLATE_DRAFT.components,
    {
      type: "BUTTONS" as const,
      buttons: [
        {
          type: "FLOW" as const,
          text: "Tell me more",
          flow_id: "flow-1",
          flow_action: "navigate" as const,
          navigate_screen: "LEAD_FORM",
        },
      ],
    },
  ],
};

const NEW_FLOW_BUTTON_TEMPLATE_DRAFT: AiriWhatsAppTemplateDraft = {
  ...INITIAL_TEMPLATE_DRAFT,
  components: [
    ...INITIAL_TEMPLATE_DRAFT.components,
    {
      type: "BUTTONS" as const,
      buttons: [
        {
          type: "FLOW" as const,
          text: "Build my plan",
          flow_id: "",
          flow_action: "navigate" as const,
        },
      ],
    },
  ],
};

const INITIAL_FLOW_CONFIG: WhatsAppFlowConfig = {
  templateId: "lead_generation",
  ctaText: "Start",
  bodyText: "Please complete this form.",
  flowUiLocale: "en",
  screens: [
    {
      id: "LEAD_FORM",
      title: "Lead Form",
      fields: [
        {
          id: "name",
          label: "Full Name",
          fieldType: "TextInput",
          required: true,
        },
      ],
    },
  ],
};

beforeAll(() => {
  if ("matchMedia" in window) return;

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

function renderFlowPanel(params?: {
  initialFlowConfig?: WhatsAppFlowConfig;
  onFlowConfigChange?: jest.Mock;
  onSaved?: jest.Mock;
}) {
  function Harness() {
    const [flowConfig, setFlowConfig] = useState(
      params?.initialFlowConfig || INITIAL_FLOW_CONFIG
    );

    return (
      <AiriBuilderSidePanel
        workspaceId="workspace-1"
        mode="whatsapp_flow"
        templateDraft={INITIAL_TEMPLATE_DRAFT}
        flowConfig={flowConfig}
        pendingPatch={null}
        onModeChange={jest.fn()}
        onTemplateDraftChange={jest.fn()}
        onFlowConfigChange={nextConfig => {
          setFlowConfig(nextConfig);
          params?.onFlowConfigChange?.(nextConfig);
        }}
        onApplyPendingPatch={jest.fn()}
        onDismissPendingPatch={jest.fn()}
        onSaved={params?.onSaved || jest.fn()}
        onClose={jest.fn()}
      />
    );
  }

  return render(<Harness />);
}

function renderTemplatePanel(params?: {
  templateDraft?: AiriWhatsAppTemplateDraft;
  templateArtifactId?: string | null;
  onTemplateDraftChange?: jest.Mock;
  onSaved?: jest.Mock;
  hasActiveThread?: boolean;
  pendingPatch?: AiriBuilderPatch | null;
  pendingPatchTarget?: AiriBuilderPendingPatchTarget;
  pendingPatchBusy?: boolean;
  pendingPatchBlocked?: boolean;
  onApplyPendingPatch?: jest.Mock;
}) {
  return render(
    <AiriBuilderSidePanel
      workspaceId="workspace-1"
      mode="whatsapp_template"
      templateArtifactId={params?.templateArtifactId ?? "artifact-1"}
      templateDraft={params?.templateDraft || INITIAL_TEMPLATE_DRAFT}
      flowConfig={INITIAL_FLOW_CONFIG}
      pendingPatch={params?.pendingPatch ?? null}
      pendingPatchTarget={params?.pendingPatchTarget}
      pendingPatchBusy={params?.pendingPatchBusy}
      pendingPatchBlocked={params?.pendingPatchBlocked}
      hasActiveThread={params?.hasActiveThread}
      onModeChange={jest.fn()}
      onTemplateDraftChange={params?.onTemplateDraftChange || jest.fn()}
      onFlowConfigChange={jest.fn()}
      onApplyPendingPatch={params?.onApplyPendingPatch || jest.fn()}
      onDismissPendingPatch={jest.fn()}
      onSaved={params?.onSaved || jest.fn()}
      onClose={jest.fn()}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch;
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ artifact: { id: "artifact-1" } }),
  } as Response);
  mockFetchWhatsAppFlowsList.mockResolvedValue({
    ok: true,
    data: {
      flows: [
        {
          id: "flow-1",
          name: "Existing Lead Flow",
          status: "DRAFT",
        },
      ],
    },
  });
  mockFetchWhatsAppFlowDetails.mockResolvedValue({
    ok: true,
    data: {
      flow: {
        id: "flow-1",
        name: "Existing Lead Flow",
        status: "DRAFT",
      },
      flowJson: { version: "7.1", screens: [] },
    },
  });
});

describe("AiriBuilderSidePanel template editor", () => {
  it("starts downloading the message editor when the builder opens", () => {
    const preload = jest.spyOn(
      scenarioEditorChunks.whatsAppInlineEditor,
      "preload"
    );
    try {
      const closed = renderTemplatePanel({ hasActiveThread: false });
      expect(preload).not.toHaveBeenCalled();
      closed.unmount();

      renderTemplatePanel();
      expect(preload).toHaveBeenCalled();
    } finally {
      preload.mockRestore();
    }
  });

  it("says when Airi's pending draft opens as a new artifact instead of updating this one", () => {
    const pendingPatch: AiriBuilderPatch = {
      kind: "whatsapp_template",
      baseRevision: 1,
      nextRevision: 2,
      summary: "Campaign template",
      snapshot: { templateDraft: INITIAL_TEMPLATE_DRAFT },
    };
    const onApplyPendingPatch = jest.fn();
    const view = renderTemplatePanel({
      pendingPatch,
      pendingPatchTarget: "new",
      onApplyPendingPatch,
    });

    expect(
      screen.getByText("pendingPatchNewTemplateTitle")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Airi has an update for this builder.")
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "pendingPatchOpenNew" })
    );
    expect(onApplyPendingPatch).toHaveBeenCalledTimes(1);
    view.unmount();

    renderTemplatePanel({ pendingPatch, pendingPatchTarget: "other" });
    expect(screen.getByText("pendingPatchOtherTitle")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "pendingPatchOpenOther" })
    ).toBeInTheDocument();
  });

  it("holds the switch to another draft while the open one saves or is in conflict", () => {
    const pendingPatch: AiriBuilderPatch = {
      kind: "whatsapp_template",
      baseRevision: 1,
      nextRevision: 2,
      summary: "Other template",
      snapshot: { templateDraft: INITIAL_TEMPLATE_DRAFT },
    };
    const onApplyPendingPatch = jest.fn();
    const blocked = renderTemplatePanel({
      pendingPatch,
      pendingPatchTarget: "other",
      pendingPatchBlocked: true,
      onApplyPendingPatch,
    });
    const open = screen.getByRole("button", { name: "pendingPatchOpenOther" });
    expect(open).toBeDisabled();
    expect(open).toHaveAccessibleDescription("pendingPatchResolveConflict");
    fireEvent.click(open);
    expect(onApplyPendingPatch).not.toHaveBeenCalled();
    blocked.unmount();

    renderTemplatePanel({
      pendingPatch,
      pendingPatchTarget: "other",
      pendingPatchBusy: true,
      onApplyPendingPatch,
    });
    const saving = screen.getByRole("button", {
      name: "pendingPatchOpenOther",
    });
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByText("pendingPatchResolveConflict")
    ).not.toBeInTheDocument();
  });

  it("renders nothing when no chat is selected", () => {
    const { container } = renderTemplatePanel({
      hasActiveThread: false,
    });

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Airi tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Quick actions")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Template body")).not.toBeInTheDocument();
  });

  it("opens Flow from the preview button instead of a top-level action", async () => {
    const parsedConfig: WhatsAppFlowConfig = {
      ...INITIAL_FLOW_CONFIG,
      metaFlowId: "flow-1",
      metaFlowName: "Existing Lead Flow",
      metaFlowStatus: "DRAFT",
    };
    mockParseFlowJsonToWhatsAppFlowConfig.mockReturnValue(parsedConfig);

    function Harness() {
      const [mode, setMode] = useState<"whatsapp_template" | "whatsapp_flow">(
        "whatsapp_template"
      );

      return (
        <AiriBuilderSidePanel
          workspaceId="workspace-1"
          mode={mode}
          templateDraft={FLOW_TEMPLATE_DRAFT}
          flowConfig={INITIAL_FLOW_CONFIG}
          pendingPatch={null}
          onModeChange={setMode}
          onTemplateDraftChange={jest.fn()}
          onFlowConfigChange={jest.fn()}
          onApplyPendingPatch={jest.fn()}
          onDismissPendingPatch={jest.fn()}
          onSaved={jest.fn()}
          onClose={jest.fn()}
        />
      );
    }

    render(<Harness />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open Flow builder" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "WhatsApp Flow builder" })
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Flow builder for button 1",
      })
    );

    const dialog = await screen.findByRole("dialog", {
      name: "WhatsApp Flow builder",
    });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "WhatsApp builder" })
    ).toContainElement(dialog);
    expect(screen.getByLabelText("Flow tools")).toBeInTheDocument();
    await waitFor(() =>
      expect(mockFetchWhatsAppFlowDetails).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        flowId: "flow-1",
        includeJson: true,
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Return to template builder" })
    );

    await waitFor(() => expect(dialog).toHaveAttribute("data-state", "closed"));
  });

  it("opens new Flow buttons with the default Flow config", async () => {
    const onFlowConfigChange = jest.fn();

    function Harness() {
      const [mode, setMode] = useState<"whatsapp_template" | "whatsapp_flow">(
        "whatsapp_template"
      );

      return (
        <AiriBuilderSidePanel
          workspaceId="workspace-1"
          mode={mode}
          templateDraft={NEW_FLOW_BUTTON_TEMPLATE_DRAFT}
          flowConfig={INITIAL_FLOW_CONFIG}
          pendingPatch={null}
          onModeChange={setMode}
          onTemplateDraftChange={jest.fn()}
          onFlowConfigChange={onFlowConfigChange}
          onApplyPendingPatch={jest.fn()}
          onDismissPendingPatch={jest.fn()}
          onSaved={jest.fn()}
          onClose={jest.fn()}
        />
      );
    }

    render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Flow builder for button 1",
      })
    );

    expect(
      await screen.findByRole("dialog", { name: "WhatsApp Flow builder" })
    ).toBeInTheDocument();
    expect(mockFetchWhatsAppFlowDetails).not.toHaveBeenCalled();
    expect(onFlowConfigChange).toHaveBeenCalledWith(
      expect.objectContaining({
        ctaText: "Build my plan",
        templateId: "lead_generation",
        screens: expect.arrayContaining([
          expect.objectContaining({ id: "LEAD_FORM" }),
        ]),
      })
    );
  });

  it("renders contract controls for Flow buttons instead of a raw Flow ID input", () => {
    const onTemplateDraftChange = jest.fn();

    renderTemplatePanel({
      templateDraft: FLOW_TEMPLATE_DRAFT,
      onTemplateDraftChange,
    });

    expect(screen.queryByLabelText("Button 1 Flow ID")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Build or edit Flow for button 1",
      })
    ).toHaveTextContent("Edit Flow");
    expect(screen.getByLabelText("Button 1 Flow action")).toHaveValue(
      "navigate"
    );
    expect(
      screen.getByLabelText("Button 1 Flow start screen")
    ).toHaveTextContent("LEAD_FORM");

    fireEvent.change(screen.getByLabelText("Button 1 Flow action"), {
      target: { value: "data_exchange" },
    });

    const lastDraft = onTemplateDraftChange.mock.calls.at(-1)?.[0];
    const buttonsComponent = lastDraft?.components.find(
      (component: { type: string }) => component.type === "BUTTONS"
    );
    const flowButton = buttonsComponent?.buttons?.[0];
    expect(flowButton).toEqual(
      expect.objectContaining({
        type: "FLOW",
        flow_action: "data_exchange",
      })
    );
    expect(flowButton).not.toHaveProperty("navigate_screen");
  });

  it("edits template body directly inside the phone preview", async () => {
    const onTemplateDraftChange = jest.fn();

    renderTemplatePanel({ onTemplateDraftChange });

    expect(
      screen.queryByTestId("legacy-template-editor-form")
    ).not.toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Template body"), {
      target: { value: "Updated WhatsApp body" },
    });

    expect(onTemplateDraftChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        components: expect.arrayContaining([
          expect.objectContaining({
            type: "BODY",
            text: "Updated WhatsApp body",
          }),
        ]),
      })
    );
  });

  it("renders the media drag-and-drop target inside the preview for media headers", () => {
    renderTemplatePanel({
      templateDraft: {
        ...INITIAL_TEMPLATE_DRAFT,
        components: [
          { type: "HEADER" as const, format: "IMAGE" as const },
          ...INITIAL_TEMPLATE_DRAFT.components,
        ],
      },
    });

    expect(
      screen.getByTestId("airi-template-media-dropzone")
    ).toHaveTextContent("Drop image here");
  });

  it("submits the inline draft through the artifact submit endpoint", async () => {
    const onSaved = jest.fn();

    renderTemplatePanel({ onSaved });

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/airi-artifacts/artifact-1/submit",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Template submitted.");
    expect(onSaved).toHaveBeenCalled();
  });
});

describe("AiriBuilderSidePanel Flow adapter", () => {
  it("loads and parses an existing Flow selection", async () => {
    const onFlowConfigChange = jest.fn();
    const parsedConfig: WhatsAppFlowConfig = {
      ...INITIAL_FLOW_CONFIG,
      metaFlowId: "flow-1",
      metaFlowName: "Existing Lead Flow",
      metaFlowStatus: "DRAFT",
    };
    mockParseFlowJsonToWhatsAppFlowConfig.mockReturnValue(parsedConfig);

    renderFlowPanel({ onFlowConfigChange });

    fireEvent.click(
      await screen.findByRole("button", { name: "flowChangeTemplate" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "flowChangeTemplateYes" })
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Existing Lead Flow/ })
    );

    await waitFor(() =>
      expect(mockFetchWhatsAppFlowDetails).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        flowId: "flow-1",
        includeJson: true,
      })
    );
    expect(mockParseFlowJsonToWhatsAppFlowConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        flowJson: { version: "7.1", screens: [] },
        flowId: "flow-1",
        flowName: "Existing Lead Flow",
        flowStatus: "DRAFT",
      })
    );
    expect(onFlowConfigChange).toHaveBeenLastCalledWith(parsedConfig);
  });

  it("keeps the standalone Flow editor draft-only until it is attached to a persisted scenario", async () => {
    renderFlowPanel();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh flows" })
      ).toBeEnabled()
    );

    expect(
      screen.queryByRole("button", { name: "flowSaveButton" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("flowManagedScenarioRequired")
    ).not.toBeInTheDocument();
  });
});
