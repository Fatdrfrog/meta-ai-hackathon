/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import type { FunnelTemplateDefinition } from "@/lib/scenario-generator/templates/funnel";
import { AiriCreateDialog } from ".";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const mockPlanScenarioGeneratorRequest = jest.fn();
const mockSearchCanvaBrandTemplatesRequest = jest.fn();
const mockUploadScenarioActionImage = jest.fn();
const mockFetchElevenLabsScribeToken = jest.fn();
const mockScribeConnect = jest.fn();
const mockScribeDisconnect = jest.fn();
const mockScribeCommit = jest.fn();
let mockScribeOptions: Record<string, unknown> | null = null;
let mockScribeState: {
  status: string;
  isConnected: boolean;
  isTranscribing: boolean;
  partialTranscript: string;
  committedTranscripts: unknown[];
  error: string | null;
} = {
  status: "disconnected",
  isConnected: false,
  isTranscribing: false,
  partialTranscript: "",
  committedTranscripts: [],
  error: null,
};

jest.mock("next-intl", () =>
  jest
    .requireActual("@/test-support/next-intl-test-utils")
    .createCatalogNextIntlMock(
      jest.requireActual("../../../../../messages/scenarios/en/page.json")
    )
);

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("@/components/assets/creative-asset-picker-dialog", () => ({
  CreativeAssetPickerDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (asset: {
      id: string;
      kind: "image" | "video";
      source: "uploaded" | "higgsfield";
      status: "complete";
      url: string;
      mimeType: string;
      fileName: string;
      bucket: string;
      path: string;
    }) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSelect({
            id: "creative-asset-1",
            kind: "image",
            source: "higgsfield",
            status: "complete",
            url: "https://storage.example.com/higgsfield/promo.jpg",
            mimeType: "image/jpeg",
            fileName: "promo.jpg",
            bucket: "creative-assets",
            path: "workspace-1/promo.jpg",
          })
        }
      >
        Use Higgsfield asset
      </button>
    ) : null,
}));

jest.mock("@elevenlabs/react", () => ({
  CommitStrategy: {
    VAD: "vad",
  },
  useScribe: (options: Record<string, unknown>) => {
    mockScribeOptions = options;
    return {
      ...mockScribeState,
      connect: mockScribeConnect,
      disconnect: mockScribeDisconnect,
      commit: mockScribeCommit,
      sendAudio: jest.fn(),
      clearTranscripts: jest.fn(),
      getConnection: jest.fn(() => null),
    };
  },
}));

jest.mock("@/lib/elevenlabs/scribe-microphone", () => ({
  createScribeMicrophone: () => ({
    prepare: async () => ({ audioFormat: "pcm_16000", sampleRate: 16000 }),
    close: jest.fn(),
    sendAudioTo: jest.fn(),
  }),
}));

jest.mock("@/components/ui/tabs", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const TabsContext = React.createContext({
    value: "",
    onValueChange: (_value: string) => {},
  });

  return {
    Tabs: ({
      value,
      onValueChange,
      children,
      className,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
      className?: string;
    }) => (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div className={className}>{children}</div>
      </TabsContext.Provider>
    ),
    TabsList: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
    }) => (
      <div role="tablist" className={className}>
        {children}
      </div>
    ),
    TabsTrigger: ({
      value,
      children,
      className,
    }: {
      value: string;
      children: React.ReactNode;
      className?: string;
    }) => {
      const context = React.use(TabsContext);
      return (
        <button
          type="button"
          role="tab"
          aria-selected={context.value === value}
          className={className}
          onClick={() => context.onValueChange(value)}
        >
          {children}
        </button>
      );
    },
    TabsContent: ({
      value,
      children,
      className,
    }: {
      value: string;
      children: React.ReactNode;
      className?: string;
    }) => {
      const context = React.use(TabsContext);
      if (context.value !== value) return null;
      return (
        <div role="tabpanel" className={className}>
          {children}
        </div>
      );
    },
  };
});

jest.mock("@/components/ui/conversation", () => ({
  Conversation: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  ConversationContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  ConversationScrollButton: () => null,
}));

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

jest.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
}));

jest.mock("@/lib/scenarios/client", () => {
  const actual = jest.requireActual(
    "@/lib/scenarios/client"
  ) as typeof import("@/lib/scenarios/client");
  return {
    ...actual,
    fetchElevenLabsScribeToken: (...args: unknown[]) =>
      mockFetchElevenLabsScribeToken(...args),
    planScenarioGeneratorRequest: (...args: unknown[]) =>
      mockPlanScenarioGeneratorRequest(...args),
    searchCanvaBrandTemplatesRequest: (...args: unknown[]) =>
      mockSearchCanvaBrandTemplatesRequest(...args),
    uploadScenarioActionImage: (...args: unknown[]) =>
      mockUploadScenarioActionImage(...args),
  };
});

describe("AiriCreateDialog Canva template step", () => {
  beforeAll(() => {
    installMatchMedia();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockScribeOptions = null;
    mockScribeState = {
      status: "disconnected",
      isConnected: false,
      isTranscribing: false,
      partialTranscript: "",
      committedTranscripts: [],
      error: null,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "scribe-token" }),
    }) as jest.Mock;
    mockFetchElevenLabsScribeToken.mockResolvedValue({
      token: "scribe-token",
    });
    mockUploadScenarioActionImage.mockResolvedValue({
      url: "https://storage.example.com/offer.pdf",
      bucket: "scenario-assets",
      path: "workspace-1/offer.pdf",
      mimeType: "application/pdf",
      fileName: "offer.pdf",
    });
    mockPlanScenarioGeneratorRequest.mockResolvedValue({
      status: "ready",
      templateSearchQuery: "VIP Reactivation reactivation campaign",
      blueprint: {
        summary: "Generate a VIP reactivation campaign.",
        campaignName: "VIP Reactivation",
        workflowKind: "follow_up_workflow",
        sendMode: "trigger",
        channels: ["whatsapp"],
        recipientSourceSummary: "Triggered audience",
        cohorts: [],
      },
    });
    mockSearchCanvaBrandTemplatesRequest.mockResolvedValue({
      status: "ok",
      query: "VIP Reactivation reactivation campaign",
      continuation: "next-page",
      items: [
        {
          id: "brand-template-1",
          title: "VIP Reel",
          thumbnailUrl: "https://cdn.canva.com/vip.png",
          createUrl: "https://www.canva.com/create/1",
          source: "canva_brand_template",
        },
      ],
    });
  });

  async function openAiTab() {
    return screen.findByLabelText("What should this scenario achieve?");
  }

  const templateSeed: FunnelTemplateDefinition = {
    id: "lead_generation",
    kind: "lifecycle_segment",
    segmentKey: "lead_generation",
    segmentLabel: "Lead Generation",
    title: "Lead Generation Sequence",
    description: "Capture new inbound leads and qualify them.",
    mainScenarioName: "Lead Generation",
    recoveryScenarioName: "Lead Recovery",
    noReplyTimeoutMinutes: 1440,
    recoveryDelayMinutes: 4320,
  };

  it("keeps Airi Create focused on trigger workflows instead of bulk sends", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const input = await openAiTab();
    changePrompt(input, "Create a follow-up flow for warm pricing leads.");
    await selectInlineSourceMention(input, "WhatsApp");

    expect(
      screen.queryByRole("button", { name: "Bulk" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Now" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Choose recipients" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No recipients selected")
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Trigger option")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    await waitFor(() => {
      expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          recipientSourceSummary: "Triggered audience",
          recipients: [],
        })
      );
    });
    expect(
      mockPlanScenarioGeneratorRequest.mock.calls[0]?.[0]
    ).not.toHaveProperty("triggerStrategy");
  });

  function changePrompt(
    input: HTMLElement,
    value: string,
    cursor = value.length
  ) {
    fireEvent.change(input, {
      target: {
        value,
        selectionStart: cursor,
        selectionEnd: cursor,
      },
    });
  }

  async function selectInlineSourceMention(input: HTMLElement, label: string) {
    const textarea = input as HTMLTextAreaElement;
    const currentValue = textarea.value;
    const promptWithTrigger =
      currentValue.length > 0 && !/\s$/.test(currentValue)
        ? `${currentValue} @`
        : `${currentValue}@`;
    changePrompt(input, promptWithTrigger);
    fireEvent.click(
      await screen.findByRole("option", {
        name: new RegExp(label),
      })
    );
  }

  it("renders workflow templates in Airi Create and sends the selected seed with generation", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[templateSeed]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const input = await openAiTab();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Use Lead Generation Sequence template",
      })
    );
    expect((input as HTMLTextAreaElement).value).toContain(
      "Lead Generation Sequence"
    );
    expect(
      screen.getByRole("button", { name: "Clear selected template" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate scenario" }));
    expect(mockPlanScenarioGeneratorRequest).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: "Create scenario" })
    );
    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          presetSeed: expect.objectContaining({
            title: "Lead Generation Sequence",
            segmentLabel: "Lead Generation",
          }),
        })
      );
    });
  });

  it("runs an Airi chat scenario draft in the background", async () => {
    let resolvePlan!: (value: {
      status: "ready";
      templateSearchQuery: string;
      blueprint: {
        summary: string;
        campaignName: string;
        workflowKind: "follow_up_workflow";
        sendMode: "trigger";
        channels: ["whatsapp"];
        recipientSourceSummary: string;
        cohorts: [];
      };
    }) => void;
    mockPlanScenarioGeneratorRequest.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePlan = resolve;
      })
    );

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
        initialDraft={{
          id: "airi-campaign:pricing-leads",
          workspaceId: "workspace-1",
          title: "Pricing lead win-back",
          summary: "Recover pricing leads.",
          prompt:
            "@WhatsApp Build a follow-up workflow for pricing leads.\nGoal: recover warm leads.",
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          channels: ["whatsapp"],
          recipientSourceSummary: "Warm WhatsApp leads",
          sourceIds: ["wa-1"],
        }}
      />
    );

    expect(
      screen.queryByLabelText("What should this scenario achieve?")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/chat handoff prompt is hidden/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Using the plan from your Airi chat/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/using the transferred chat plan in the background/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Close Airi Create" })
    ).toHaveLength(1);

    await waitFor(() => {
      expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace-1",
          prompt: expect.stringContaining("Build a follow-up workflow"),
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          channels: ["whatsapp"],
          recipientSourceSummary: "Triggered audience",
          sourceIds: ["wa-1"],
        })
      );
    });
    expect(
      mockPlanScenarioGeneratorRequest.mock.calls[0]?.[0]
    ).not.toHaveProperty("triggerStrategy");

    await act(async () => {
      resolvePlan({
        status: "ready",
        templateSearchQuery: "Pricing lead win-back",
        blueprint: {
          summary: "Recover pricing leads.",
          campaignName: "Pricing lead win-back",
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          channels: ["whatsapp"],
          recipientSourceSummary: "Triggered audience",
          cohorts: [],
        },
      });
    });

    expect(await screen.findByText("Review scenario plan")).toBeInTheDocument();
  });

  it("lets users clear a selected workflow template before generation", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[templateSeed]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    await openAiTab();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Use Lead Generation Sequence template",
      })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear selected template" })
    );

    expect(
      screen.queryByText("Use Lead Generation Sequence template")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Generate scenario" }));

    await waitFor(() => {
      expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Create scenario" })
    );

    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledTimes(1);
    });
    expect(
      onCreateGeneratedScenario.mock.calls[0][0].presetSeed
    ).toBeUndefined();
  });

  it("shows the reason when a context document upload fails", async () => {
    mockUploadScenarioActionImage.mockRejectedValueOnce(
      new Error("Storage bucket is not configured")
    );

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    await openAiTab();
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [
          new File(["context"], "offer.pdf", { type: "application/pdf" }),
        ],
      },
    });

    expect(await screen.findByText("Attachment failed")).toBeInTheDocument();
    expect(
      screen.getByText("offer.pdf: Storage bucket is not configured")
    ).toBeInTheDocument();
  });

  it("offers connected source chips and hides raw generator status text", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp", "higgsfield"]}
      />
    );

    const promptInput = await openAiTab();

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText("idle")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Add WhatsApp source" })
    );

    expect(promptInput).toHaveValue("@WhatsApp ");
    expect(
      document.querySelector(
        '[data-source-mention-context="composer"][data-source-mention-chip="whatsapp"]'
      )
    ).toBeInTheDocument();
  });

  it("lets Airi Create scope a delivery source mention to concrete source instances", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
        connectedSourceOptions={[
          {
            id: "source-main",
            type: "whatsapp",
            label: "Main WhatsApp",
          },
          {
            id: "source-support",
            type: "whatsapp",
            label: "Support WhatsApp",
          },
        ]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(promptInput, "Generate a retention campaign.");
    await selectInlineSourceMention(promptInput, "WhatsApp");

    expect(screen.getByText("Main WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("Support WhatsApp")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Exclude Support WhatsApp from WhatsApp source scope",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    await waitFor(() => {
      expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIds: ["source-main"],
        })
      );
    });
  });

  it("shows unavailable Higgsfield with the exact reason instead of hiding it", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
        higgsfieldUnavailableReason="Temporal worker is not configured"
      />
    );

    await openAiTab();

    expect(
      screen.getByRole("button", {
        name: "Higgsfield unavailable: Temporal worker is not configured",
      })
    ).toBeDisabled();
    expect(
      screen.getByText("Temporal worker is not configured")
    ).toBeInTheDocument();
  });

  it("keeps the dialog open for a scenario plan review before creating", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);
    const onOpenChange = jest.fn();

    render(
      <AiriCreateDialog
        open
        onOpenChange={onOpenChange}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(promptInput, "Generate a retention campaign.");
    await selectInlineSourceMention(promptInput, "WhatsApp");
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    expect(await screen.findByText("Review scenario plan")).toBeInTheDocument();
    expect(screen.getByText("VIP Reactivation")).toBeInTheDocument();
    expect(onCreateGeneratedScenario).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Create scenario" }));

    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          campaignName: "VIP Reactivation",
        })
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("creates from the planner workflow shape and includes connected calendar context", async () => {
    mockPlanScenarioGeneratorRequest.mockResolvedValueOnce({
      status: "ready",
      templateSearchQuery: "creative assets launch",
      blueprint: {
        summary: "Launch the new product to WhatsApp customers.",
        campaignName: "Creative Assets Launch",
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        recipientSourceSummary: "WhatsApp launch audience",
        cohorts: [],
      },
    });
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp"]}
        connectedSourceOptions={[
          {
            id: "source-main",
            type: "whatsapp",
            label: "Main WhatsApp",
          },
        ]}
        hasGoogleCalendar
      />
    );

    const promptInput = await openAiTab();
    changePrompt(
      promptInput,
      'Help me create a WhatsApp campaign for product "creative assets".'
    );
    await selectInlineSourceMention(promptInput, "WhatsApp");
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    expect(await screen.findByText("Review scenario plan")).toBeInTheDocument();
    expect(screen.getByText("Immediate")).toBeInTheDocument();
    expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIds: ["source-main"],
        sourceContext: expect.arrayContaining([
          expect.objectContaining({
            type: "whatsapp",
            id: "source-main",
            role: "delivery",
          }),
          expect.objectContaining({
            type: "google_calendar",
            label: "Google Calendar",
            role: "context",
          }),
        ]),
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Create scenario" }));

    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          campaignName: "Creative Assets Launch",
          recipientSourceSummary: "WhatsApp launch audience",
          sourceContext: expect.arrayContaining([
            expect.objectContaining({ type: "google_calendar" }),
          ]),
        })
      );
    });
  });

  it("creates a trigger scenario without recipient selection", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(promptInput, "Generate a retention campaign.");
    await selectInlineSourceMention(promptInput, "WhatsApp");
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    expect(await screen.findByText("Review scenario plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create scenario" }));

    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          recipients: [],
        })
      );
    });
  });

  it("guides Higgsfield users to choose media and explains delivery-source requirements", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["higgsfield"]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(promptInput, "Generate a product video for launch.");
    fireEvent.click(
      screen.getByRole("button", { name: "Add Higgsfield source" })
    );

    expect(
      screen.getByRole("button", { name: "Choose a Higgsfield asset" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    expect(toast.error).toHaveBeenCalledWith(
      "Add WhatsApp or Email for delivery. Higgsfield and Canva only provide creative context."
    );
    expect(mockPlanScenarioGeneratorRequest).not.toHaveBeenCalled();
  });

  it("opens an inline source picker from @ typing and renders the picked source as a mention", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const promptInput = await openAiTab();
    const promptText = "How do I create a follow-up workflow here?";
    changePrompt(promptInput, `${promptText} @`);

    const sourcePicker = await screen.findByRole("listbox", {
      name: "Connected source mentions",
    });
    fireEvent.click(
      within(sourcePicker).getByRole("option", { name: /WhatsApp/ })
    );

    expect(promptInput).toHaveValue(`${promptText} @WhatsApp `);
    expect(
      document.querySelector(
        '[data-source-mention-context="composer"][data-source-mention-chip="whatsapp"]'
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    await waitFor(() => {
      expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: ["whatsapp"],
          prompt: promptText,
        })
      );
    });
    expect(
      document.querySelector(
        '[data-source-mention-context="message"][data-source-mention-chip="whatsapp"]'
      )
    ).toBeInTheDocument();
  });

  it("passes selected Higgsfield assets into Airi Create generation", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp", "higgsfield"]}
      />
    );

    const promptInput = await openAiTab();
    const promptText = "Generate a visual WhatsApp offer.";
    changePrompt(promptInput, promptText);
    await selectInlineSourceMention(promptInput, "WhatsApp");
    await selectInlineSourceMention(promptInput, "Higgsfield");

    fireEvent.click(
      screen.getByRole("button", { name: "Choose a Higgsfield asset" })
    );
    fireEvent.click(await screen.findByText("Use Higgsfield asset"));
    expect(screen.getByText("promo.jpg")).toBeInTheDocument();
    expect(screen.getByAltText("Preview promo.jpg")).toHaveAttribute(
      "src",
      "https://storage.example.com/higgsfield/promo.jpg"
    );
    const assetChip = screen
      .getByText("promo.jpg")
      .closest("[data-attachment-chip='true']");
    expect(assetChip).toHaveAttribute("data-asset-kind", "image");
    expect(
      within(assetChip as HTMLElement).getByText("Higgsfield")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    await waitFor(() => {
      expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: ["whatsapp"],
          prompt: promptText,
          assetRefs: [
            expect.objectContaining({
              id: "creative-asset-1",
              kind: "image",
              source: "higgsfield",
              url: "https://storage.example.com/higgsfield/promo.jpg",
            }),
          ],
        })
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Create scenario" }));
    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          assetRefs: [
            expect.objectContaining({
              source: "higgsfield",
              url: "https://storage.example.com/higgsfield/promo.jpg",
            }),
          ],
        })
      );
    });
  });

  it.each([false, true])(
    "uses Alibaba image generation before scenario planning (StrictMode=%s)",
    async reactStrictMode => {
      const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);
      let resolveGeneration:
        | ((response: {
            ok: boolean;
            json: () => Promise<Record<string, unknown>>;
          }) => void)
        | undefined;
      global.fetch = jest
        .fn()
        .mockReturnValueOnce(
          new Promise(resolve => {
            resolveGeneration = resolve;
          })
        )
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            asset: {
              id: "asset-auto",
              workspaceId: "workspace-1",
              kind: "image",
              source: "alibaba",
              status: "complete",
              prompt: "Generate a visual WhatsApp offer.",
              url: "https://storage.example.com/alibaba/auto.jpg",
              fileName: "auto.jpg",
              mimeType: "image/jpeg",
              bucket: "creative-assets",
              path: "workspace-1/auto.jpg",
            },
          }),
        }) as jest.Mock;

      render(
        <AiriCreateDialog
          open
          onOpenChange={jest.fn()}
          templates={[]}
          isCreating={false}
          workspaceId="workspace-1"
          onCreateGeneratedScenario={onCreateGeneratedScenario}
          connectedSourceMentions={["whatsapp", "higgsfield"]}
        />,
        { reactStrictMode }
      );

      const promptInput = await openAiTab();
      const promptText = "Generate a visual WhatsApp offer.";
      changePrompt(promptInput, promptText);
      await selectInlineSourceMention(promptInput, "WhatsApp");
      await selectInlineSourceMention(promptInput, "Higgsfield");

      fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

      expect(
        await screen.findByText("Generating Higgsfield media...")
      ).toBeInTheDocument();
      await act(async () => {
        resolveGeneration?.({
          ok: true,
          json: async () => ({
            success: true,
            asset: {
              id: "asset-auto",
              workspaceId: "workspace-1",
              kind: "image",
              source: "alibaba",
              status: "queued",
              prompt: "Generate a visual WhatsApp offer.",
              url: null,
              fileName: null,
              mimeType: null,
              bucket: null,
              path: null,
            },
          }),
        });
      });
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/workspaces/workspace-1/assets/generate/alibaba",
          expect.objectContaining({
            method: "POST",
          })
        );
      });
      await waitFor(() => {
        expect(mockPlanScenarioGeneratorRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: promptText,
            assetRefs: [
              expect.objectContaining({
                id: "asset-auto",
                source: "uploaded",
                url: "https://storage.example.com/alibaba/auto.jpg",
              }),
            ],
          })
        );
      });
    }
  );

  it("uploads selected context documents without empty-selection errors", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    await openAiTab();
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    const file = new File(["context"], "offer.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [file],
      },
    });

    await waitFor(() => {
      expect(mockUploadScenarioActionImage).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        file,
      });
    });
    expect(await screen.findByText("offer.pdf")).toBeInTheDocument();
    expect(screen.getAllByRole("tooltip")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          textContent:
            "offer.pdf will be attached, but only metadata is used for planning in this version.",
        }),
      ])
    );
    expect(
      screen.getByText("offer.pdf").closest("[data-attachment-chip='true']")
    ).toHaveAttribute("data-warning-state", "warning");
    expect(
      screen.queryByText("No files were selected for attachment.")
    ).not.toBeInTheDocument();
  });

  it("uses ElevenLabs Scribe dictation to fill the prompt", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const promptInput = await openAiTab();
    fireEvent.click(
      screen.getByRole("button", { name: "Start voice dictation" })
    );

    await waitFor(() => {
      expect(mockScribeConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "scribe-token",
          audioFormat: "pcm_16000",
          sampleRate: 16000,
        })
      );
    });

    await act(async () => {
      (
        mockScribeOptions?.onCommittedTranscript as
          | ((data: { text: string }) => void)
          | undefined
      )?.({
        text: "Generate a voice dictated WhatsApp campaign.",
      });
    });

    expect(promptInput).toHaveValue(
      "Generate a voice dictated WhatsApp campaign."
    );
  });

  it("does not echo composer text live and shows the submitted prompt after setup", async () => {
    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp"]}
      />
    );

    const promptInput = await openAiTab();
    const promptText = "Generate a loyalty campaign for high value customers.";
    changePrompt(promptInput, promptText);
    await selectInlineSourceMention(promptInput, "WhatsApp");

    const liveEchoes = screen
      .queryAllByText(promptText)
      .filter(
        element =>
          element.tagName.toLowerCase() !== "textarea" &&
          !element.closest("[data-scenario-generator-composer='true']")
      );
    expect(liveEchoes).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    const setup = screen.getByText("Scenario setup");
    let submittedPrompt: HTMLElement | null = null;
    await waitFor(() => {
      const chip = document.querySelector(
        '[data-source-mention-context="message"][data-source-mention-chip="whatsapp"]'
      );
      submittedPrompt = chip?.closest(
        '[data-slot="message-content"]'
      ) as HTMLElement | null;
      expect(submittedPrompt).toHaveTextContent(promptText);
    });
    if (!submittedPrompt) {
      throw new Error("Submitted prompt was not rendered");
    }
    expect(
      setup.compareDocumentPosition(submittedPrompt) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows Airi generation as assistant chat after submit", async () => {
    let resolvePlan:
      | ((
          value: Awaited<ReturnType<typeof mockPlanScenarioGeneratorRequest>>
        ) => void)
      | undefined;
    mockPlanScenarioGeneratorRequest.mockReturnValueOnce(
      new Promise(resolve => {
        resolvePlan = resolve;
      })
    );

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={jest.fn()}
        connectedSourceMentions={["whatsapp", "canva"]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(promptInput, "Build a promo campaign for loyal customers.");
    await selectInlineSourceMention(promptInput, "WhatsApp");
    await selectInlineSourceMention(promptInput, "Canva");
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    const submittedPrompt = (
      await screen.findAllByText((_content, element) =>
        Boolean(
          element?.textContent?.includes(
            "Build a promo campaign for loyal customers."
          ) &&
            element.querySelector(
              '[data-source-mention-context="message"][data-source-mention-chip="whatsapp"]'
            )
        )
      )
    ).find(
      element =>
        element.tagName.toLowerCase() !== "textarea" &&
        !element.closest("[data-scenario-generator-composer='true']")
    );
    expect(submittedPrompt).toBeDefined();
    const workingReply = await screen.findByText("Building scenario plan");
    expect(
      (submittedPrompt as HTMLElement).compareDocumentPosition(workingReply) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await act(async () => {
      resolvePlan?.({
        status: "ready",
        templateSearchQuery: "promo campaign",
        blueprint: {
          summary: "Draft a loyalty promo with one clear CTA.",
          campaignName: "Loyalty Promo",
          workflowKind: "follow_up_workflow",
          sendMode: "trigger",
          channels: ["whatsapp"],
          recipientSourceSummary: "Triggered audience",
          cohorts: [],
        },
      });
    });

    expect(
      await screen.findByText("Here's the scenario plan I drafted.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Draft a loyalty promo with one clear CTA.")
    ).toBeInTheDocument();
  });

  it("shows Canva templates after planning and does not create immediately", async () => {
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp", "canva"]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(
      promptInput,
      "Generate a reactivation campaign for VIP users who asked about pricing. Drive them to book a demo."
    );
    await selectInlineSourceMention(promptInput, "WhatsApp");
    await selectInlineSourceMention(promptInput, "Canva");
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    expect(onCreateGeneratedScenario).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Choose Canva brand templates")
    ).toBeInTheDocument();
    expect(screen.getByText("VIP Reel")).toBeInTheDocument();
    expect(onCreateGeneratedScenario).not.toHaveBeenCalled();
  });

  it("keeps selected templates while fetching the next page", async () => {
    mockSearchCanvaBrandTemplatesRequest
      .mockResolvedValueOnce({
        status: "ok",
        query: "VIP Reactivation reactivation campaign",
        continuation: "next-page",
        items: [
          {
            id: "brand-template-1",
            title: "VIP Reel",
            thumbnailUrl: null,
            createUrl: null,
            source: "canva_brand_template",
          },
        ],
      })
      .mockResolvedValueOnce({
        status: "ok",
        query: "VIP Reactivation reactivation campaign",
        continuation: null,
        items: [
          {
            id: "brand-template-2",
            title: "Demo CTA",
            thumbnailUrl: null,
            createUrl: null,
            source: "canva_brand_template",
          },
        ],
      });
    const onCreateGeneratedScenario = jest.fn().mockResolvedValue(true);

    render(
      <AiriCreateDialog
        open
        onOpenChange={jest.fn()}
        templates={[]}
        isCreating={false}
        workspaceId="workspace-1"
        onCreateGeneratedScenario={onCreateGeneratedScenario}
        connectedSourceMentions={["whatsapp", "canva"]}
      />
    );

    const promptInput = await openAiTab();
    changePrompt(
      promptInput,
      "Generate a reactivation campaign for VIP users who asked about pricing. Drive them to book a demo."
    );
    await selectInlineSourceMention(promptInput, "WhatsApp");
    await selectInlineSourceMention(promptInput, "Canva");
    fireEvent.click(screen.getByRole("button", { name: /Generate/i }));

    await screen.findByText("VIP Reel");
    fireEvent.click(screen.getByRole("button", { name: "VIP Reel" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Demo CTA")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    await waitFor(() => {
      expect(onCreateGeneratedScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedCanvaTemplates: [
            expect.objectContaining({
              id: "brand-template-1",
              title: "VIP Reel",
            }),
          ],
        })
      );
    });
  });
});
