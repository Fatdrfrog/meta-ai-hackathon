/**
 * @jest-environment jsdom
 */

const mockTranslate = jest.fn((key: string) => key);

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
  useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
}));

jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    error: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
  }),
}));

type MockBatchPlanHookResult = {
  preview: BulkCampaignBatchPlanPreviewResponse | null;
  error: Error | undefined;
  isLoading: boolean;
};

const mockUseBulkCampaignBatchPlanPreview = jest.fn<
  MockBatchPlanHookResult,
  [unknown]
>(() => ({
  preview: null,
  error: undefined,
  isLoading: false,
}));

jest.mock("@/lib/campaign/useBulkCampaignBatchPlan", () => ({
  useBulkCampaignBatchPlanPreview: (params: unknown) =>
    mockUseBulkCampaignBatchPlanPreview(params),
}));

const initialCompanyLimits = {
  subscriptionType: "free" as const,
  bulkRecipientLimit: 500,
  bulkRecipientCount: 0,
  bulkRecipientsRemaining: 500,
  bulkRecipientExhausted: false,
  conversationLimit: 500,
  conversationCount: 0,
  conversationExhausted: false,
  trialExpired: false,
};
let mockCompanyLimits = { ...initialCompanyLimits };

jest.mock("@/hooks/use-company-limits", () => ({
  useCompanyLimits: () => ({ data: mockCompanyLimits }),
}));

const mockCampaignDispatchLiveStatus = jest.fn(
  (props: {
    campaignId?: string | null;
    initialStatus?: string | null;
    onLifecycleChange?: (
      status: string,
      operation: {
        totalRecipients: number;
        progress: {
          notAttempted: number;
          successful: number;
          failed: number;
        };
      }
    ) => void;
  }) => (
    <div
      data-testid="campaign-dispatch-live-status"
      data-campaign-id={props.campaignId}
      data-status={props.initialStatus}
    >
      <button
        type="button"
        onClick={() =>
          props.onLifecycleChange?.("completed", {
            totalRecipients: 1,
            progress: {
              notAttempted: 0,
              successful: 1,
              failed: 0,
            },
          })
        }
      >
        complete-live-dispatch
      </button>
    </div>
  )
);

jest.mock("@/components/campaigns/campaign-dispatch-live-status", () => ({
  CampaignDispatchLiveStatus: (props: {
    campaignId?: string | null;
    initialStatus?: string | null;
    onLifecycleChange?: (
      status: string,
      operation: {
        totalRecipients: number;
        progress: {
          notAttempted: number;
          successful: number;
          failed: number;
        };
      }
    ) => void;
  }) => mockCampaignDispatchLiveStatus(props),
}));

let mockCsvUploadPayload: Array<{
  phone?: string;
  chatId?: string;
  name?: string;
  birthday?: string;
  fields?: Record<string, string>;
  variables?: Record<string, string>;
}> = [];
let mockCsvUploadEvidence: {
  originalFilename: string;
  selectedAt: string;
} | null = null;
let mockCsvOnRecipientsLoaded:
  | ((recipients: typeof mockCsvUploadPayload) => void)
  | undefined;

jest.mock("@/components/campaigns/csv-upload", () => ({
  CsvUpload: ({
    onRecipientsLoaded,
    recipientLimit,
    requireBirthdayColumn,
    disabled,
    onUploadedAudienceChange,
  }: {
    onRecipientsLoaded: (
      recipients: Array<{
        phone?: string;
        chatId?: string;
        name?: string;
        birthday?: string;
        fields?: Record<string, string>;
        variables?: Record<string, string>;
      }>
    ) => void;
    recipientLimit?: number;
    requireBirthdayColumn?: boolean;
    disabled?: boolean;
    onUploadedAudienceChange?: (audience: {
      recipients: typeof mockCsvUploadPayload;
      uploadEvidence: NonNullable<typeof mockCsvUploadEvidence>;
    }) => void;
  }) => {
    mockCsvOnRecipientsLoaded = onRecipientsLoaded;
    return (
      <div>
        <div>dropzoneTitle</div>
        <div data-testid="csv-upload-limit">{recipientLimit ?? "none"}</div>
        <div data-testid="csv-upload-require-birthday">
          {requireBirthdayColumn ? "true" : "false"}
        </div>
        <div data-testid="csv-upload-disabled">
          {disabled ? "true" : "false"}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (onUploadedAudienceChange && mockCsvUploadEvidence) {
              onUploadedAudienceChange({
                recipients: mockCsvUploadPayload,
                uploadEvidence: mockCsvUploadEvidence,
              });
              return;
            }
            onRecipientsLoaded(mockCsvUploadPayload);
          }}
        >
          mockCsvUpload
        </button>
      </div>
    );
  },
}));

jest.mock("@xyflow/react", () => ({
  Handle: ({
    id,
    type,
    position,
    className,
    onClick,
    role,
    "data-testid": dataTestId,
  }: {
    id?: string;
    type?: string;
    position?: string;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLDivElement>;
    role?: string;
    "data-testid"?: string;
  }) => (
    <div
      data-testid={dataTestId || "handle"}
      data-handle-id={id}
      data-handle-type={type}
      data-handle-position={position}
      className={className}
      role={role}
      onClick={onClick}
    />
  ),
  MarkerType: { ArrowClosed: "ArrowClosed" },
  Position: { Left: "left", Right: "right", Top: "top" },
  useStore: (
    selector: (state: { transform: [number, number, number] }) => unknown
  ) => selector({ transform: [0, 0, 1] }),
}));

const BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID = "right-source";

const mockUpdateNodeById = jest.fn();
const mockLoadWhatsAppTemplates = jest.fn(async () => undefined);
const mockAdoptGeneratedBulkServerUpdate = jest.fn();
const mockAdoptScenarioActivation = jest.fn();
const mockOnScenarioActivationBlocked = jest.fn();
const mockReconcileGeneratedJobServerUpdate = jest.fn();
const mockOpenNodePickerFromHandle = jest.fn();
let mockRegisteredBusinessPhonesAudience: {
  enabled?: boolean;
  total: number;
  preview?: Array<{ phone: string; name?: string | null }>;
} | null = null;
const mockWhatsAppTemplates: Array<{
  id?: string;
  name: string;
  language: string;
  status?: string;
  components?: Array<{ type: string; text?: string }>;
}> = [
  {
    id: "tpl-launch-offer",
    name: "launch_offer",
    language: "en",
    status: "APPROVED",
    components: [{ type: "BODY", text: "Hi {{name}}, offer is ready" }],
  },
];
const mockGraphIndex: {
  bulkActionByRootId: Map<string, ScenarioBulkConnectedAction>;
  bulkColumnSplitRoutingByRootId: Map<string, never>;
  actionVariableConfigsByNodeId: Record<string, never>;
  instagramReplyActionIdsBlockedByBulkRoot: Set<string>;
} = {
  bulkActionByRootId: new Map([
    [
      "bulk-1",
      createMockBulkConnectedAction("action-1", {
        kind: "action",
        actionType: "whatsapp_template",
        actionWhatsAppTemplateName: "launch_offer",
        actionWhatsAppTemplateLanguage: "en",
        actionWhatsAppTemplateComponents: [
          { type: "BODY", text: "Hi {{name}}, offer is ready" },
        ],
      }),
    ],
  ]),
  bulkColumnSplitRoutingByRootId: new Map<string, never>(),
  actionVariableConfigsByNodeId: {},
  instagramReplyActionIdsBlockedByBulkRoot: new Set<string>(),
};

const createMockScenarioNodeEnrichment = () => ({
  activeScenarioId: "scenario-1",
  workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
  callbacksRef: {
    current: {
      updateNodeById: mockUpdateNodeById,
      removeNodeById: jest.fn(),
      loadWhatsAppTemplates: mockLoadWhatsAppTemplates,
    },
  },
  adoptGeneratedBulkServerUpdate: mockAdoptGeneratedBulkServerUpdate,
  prepareScenarioBulkSend: jest.fn(async () => () => undefined),
  adoptScenarioActivation: mockAdoptScenarioActivation,
  onScenarioActivationBlocked: mockOnScenarioActivationBlocked,
  prepareGeneratedJobRefresh: jest.fn().mockResolvedValue(true),
  reconcileGeneratedJobServerUpdate: mockReconcileGeneratedJobServerUpdate,
  openNodePickerFromHandle: mockOpenNodePickerFromHandle,
  graphIndex: mockGraphIndex,
  registeredBusinessPhonesAudience: mockRegisteredBusinessPhonesAudience,
  whatsAppTemplates: mockWhatsAppTemplates,
  t: (key: string) => key,
});

let mockHasLoadedWhatsAppTemplates = true;
let mockWhatsAppTemplatesError: {
  retryAt: string | null;
  code?: string;
} | null = null;

jest.mock("../view/graph/resources-context", () => ({
  useScenarioGraphResources: () => ({
    whatsAppTemplatesLoading: false,
    whatsAppTemplatesRefreshing: false,
    hasLoadedWhatsAppTemplates: mockHasLoadedWhatsAppTemplates,
    whatsAppTemplatesError: mockWhatsAppTemplatesError,
    whatsAppFlowsLoading: false,
    whatsAppFlowsRefreshing: false,
    contextItemsLoading: false,
  }),
}));

import type {
  BulkCampaignBatchPlanPreviewResponse,
  BulkCampaignSendResponse,
  GeneratedBulkSendScenarioUpdate,
} from "@/lib/campaign/bulk-campaign-contracts";
import {
  SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
  SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
  SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
} from "@icecore/scenario-contracts";
import type { NodeProps } from "@xyflow/react";
import type { ScenarioBulkConnectedAction, ScenarioNodeData } from "../types";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { cloneElement } from "react";
import { renderToString } from "react-dom/server";
import { BulkRootNode as ActualBulkRootNode } from "./bulk-root-node";
import { LazyBulkRootNode as ActualLazyBulkRootNode } from "./lazy-bulk-root-node";
import { enrichBulkRootNodeData } from "../view/node-enrichment/bulk";
import { resolveBulkConnectedActionFromNode } from "@/lib/scenarios/bulk-column-split-routing";
import type {
  ScenarioBulkEditorNodeProps,
  ScenarioPersistedNodeDataOfKind,
} from "../view/node-enrichment/types";

function createMockBulkConnectedAction(
  nodeId: string,
  data: ScenarioNodeData
): ScenarioBulkConnectedAction {
  const action = resolveBulkConnectedActionFromNode({
    actionNodeId: nodeId,
    actionData: data,
    whatsAppTemplates: mockWhatsAppTemplates as never,
  });
  if (!action) throw new Error(`Expected connected bulk action ${nodeId}`);
  return action;
}

function BulkRootNode(props: NodeProps) {
  const data = enrichBulkRootNodeData(
    props.id,
    props.data as ScenarioPersistedNodeDataOfKind<"bulk">,
    createMockScenarioNodeEnrichment() as never
  );
  return (
    <ActualBulkRootNode
      {...({ ...props, data } as unknown as ScenarioBulkEditorNodeProps)}
    />
  );
}

function LazyBulkRootNode(props: NodeProps) {
  const data = enrichBulkRootNodeData(
    props.id,
    props.data as ScenarioPersistedNodeDataOfKind<"bulk">,
    createMockScenarioNodeEnrichment() as never
  );
  return (
    <ActualLazyBulkRootNode
      {...({ ...props, data } as unknown as ScenarioBulkEditorNodeProps)}
    />
  );
}

function bulkRootElement(
  data: NodeProps["data"],
  id = "bulk-1",
  Node: typeof BulkRootNode = BulkRootNode
) {
  return (
    <Node
      id={id}
      selected={false}
      type="bulkNode"
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

// A WhatsApp bulk root: by default with one uploaded recipient, so it can
// send; `uploaded: false` leaves the audience (and its revision) unset.
function bulkRoot(
  configPatch: Partial<NonNullable<ScenarioNodeData["bulkRootConfig"]>> = {},
  {
    uploaded = true,
    Node = BulkRootNode,
  }: { uploaded?: boolean; Node?: typeof BulkRootNode } = {}
) {
  return bulkRootElement(
    {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        campaignName: "Bulk campaign",
        recipientSourceSummary: uploaded
          ? "Uploaded audience"
          : "No generated recipients yet",
        generationStatus: "idle",
        ...(uploaded
          ? {
              uploadedRecipients: [{ phone: "+77001234567", name: "Aibek" }],
              audienceRevision: 1,
            }
          : {}),
        ...configPatch,
      },
    },
    "bulk-1",
    Node
  );
}

function describeHandles(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-handle-id]")).map(
    handle => ({
      id: handle.getAttribute("data-handle-id"),
      type: handle.getAttribute("data-handle-type"),
      position: handle.getAttribute("data-handle-position"),
    })
  );
}

function getPriorFailureSwitch() {
  const trigger = screen.getByRole("button", { name: /recipientFilters/ });
  if (trigger.getAttribute("aria-expanded") === "false")
    fireEvent.click(trigger);
  return screen.getByRole("switch", {
    name: "excludePriorFailedBulkSendsLabel",
  });
}

describe("BulkRootNode", () => {
  const originalFetch = global.fetch;
  type GeneratedChild = NonNullable<
    BulkCampaignSendResponse["children"]
  >[number];
  type GeneratedChildFixture = Omit<
    GeneratedChild,
    | "batchPlan"
    | "temporalDispatchStaging"
    | "audience"
    | "audienceConfirmation"
  > &
    Partial<
      Pick<
        GeneratedChild,
        | "batchPlan"
        | "temporalDispatchStaging"
        | "audience"
        | "audienceConfirmation"
      >
    >;

  const createGeneratedScenarioUpdate = ({
    generatedRecipientCount = 6,
    queued = 5,
    skipped = 1,
    revision = "generation-job-1",
    operationId = "operation-1",
    scenarioUpdatedAt = "2026-07-27T10:01:00.000Z",
  }: {
    generatedRecipientCount?: number;
    queued?: number;
    skipped?: number;
    revision?: string;
    operationId?: string;
    scenarioUpdatedAt?: string;
  } = {}): GeneratedBulkSendScenarioUpdate => ({
    nodeId: "bulk-1",
    bulkRootConfigPatch: {
      generatedRecipientCount,
      sendStatus: {
        total: generatedRecipientCount,
        queued,
        sent: 0,
        skipped,
        failed: 0,
        lastSendAttemptAt: "2026-07-27T10:00:00.000Z",
      },
      generatedSendState: {
        revision,
        operationId,
        state: "completed",
        requestedAt: "2026-07-27T10:00:00.000Z",
        completedAt: scenarioUpdatedAt,
      },
    },
    scenarioUpdatedAt,
  });

  const createGeneratedSendResponse = ({
    generatedRecipientCount = 6,
    queued = true,
    queuedCount = queued ? generatedRecipientCount : 0,
    skipped = generatedRecipientCount - queuedCount,
    scheduled = false,
    children: childFixtures = [],
    scenarioUpdate = createGeneratedScenarioUpdate({
      generatedRecipientCount,
      queued: queuedCount,
      skipped,
    }),
  }: {
    generatedRecipientCount?: number;
    queued?: boolean;
    queuedCount?: number;
    skipped?: number;
    scheduled?: boolean;
    children?: GeneratedChildFixture[];
    scenarioUpdate?: GeneratedBulkSendScenarioUpdate;
  } = {}): BulkCampaignSendResponse => {
    const children: GeneratedChild[] = childFixtures.map((child, index) => {
      const fingerprint = String(index + 1).repeat(64);
      return {
        ...child,
        batchPlan: child.batchPlan ?? {
          batchSize: Math.max(1, child.total),
          delayMs: 0,
          ratePerSecond: 50,
          rateSource: "test",
        },
        temporalDispatchStaging: child.temporalDispatchStaging ?? "inline",
        audience: child.audience ?? {
          fingerprint,
          requestedTotal: child.total + child.skippedRecipientCount,
          queuedTotal: child.total,
          skippedOptIn: child.skippedRecipientCount,
        },
        audienceConfirmation: child.audienceConfirmation ?? {
          required: false,
          confirmed: false,
          fingerprint,
        },
      };
    });

    return {
      operationDisposition: "completed",
      queued,
      scheduled,
      total: queuedCount,
      requestedTotal: generatedRecipientCount,
      skippedRecipientCount: skipped,
      children,
      childrenTotal: children.length,
      childrenTruncated: false,
      scenarioStatus: "active",
      scenarioUpdate,
    };
  };

  beforeEach(() => {
    mockCompanyLimits = { ...initialCompanyLimits };
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    mockUpdateNodeById.mockClear();
    mockLoadWhatsAppTemplates.mockClear();
    mockAdoptGeneratedBulkServerUpdate.mockClear();
    mockAdoptGeneratedBulkServerUpdate.mockReturnValue(true);
    mockAdoptScenarioActivation.mockReset();
    mockAdoptScenarioActivation.mockReturnValue(true);
    mockOnScenarioActivationBlocked.mockClear();
    mockTranslate.mockClear();
    mockReconcileGeneratedJobServerUpdate.mockReset();
    mockReconcileGeneratedJobServerUpdate.mockResolvedValue({
      status: "applied",
    });
    mockOpenNodePickerFromHandle.mockClear();
    mockUseBulkCampaignBatchPlanPreview.mockReset();
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: null,
      error: undefined,
      isLoading: false,
    });
    mockCampaignDispatchLiveStatus.mockClear();
    const { toast } = jest.requireMock("sonner") as {
      toast: jest.Mock & {
        error: jest.Mock;
        success: jest.Mock;
        warning: jest.Mock;
      };
    };
    toast.mockClear();
    toast.error.mockClear();
    toast.success.mockClear();
    toast.warning.mockClear();
    mockCsvUploadPayload = [];
    mockCsvUploadEvidence = null;
    mockRegisteredBusinessPhonesAudience = null;
    mockHasLoadedWhatsAppTemplates = true;
    mockWhatsAppTemplatesError = null;
    mockGraphIndex.bulkActionByRootId = new Map([
      [
        "bulk-1",
        createMockBulkConnectedAction("action-1", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "launch_offer",
          actionWhatsAppTemplateLanguage: "en",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Hi {{name}}, offer is ready" },
          ],
        }),
      ],
    ]);
    mockGraphIndex.bulkColumnSplitRoutingByRootId = new Map<string, never>();
    mockGraphIndex.actionVariableConfigsByNodeId = {};
    mockGraphIndex.instagramReplyActionIdsBlockedByBulkRoot = new Set<string>();
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length, {
      id: "tpl-launch-offer",
      name: "launch_offer",
      language: "en",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hi {{name}}, offer is ready" }],
    });
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url =
        typeof request === "string"
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url;
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      });
    }) as jest.Mock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows remaining bulk campaign quota before sending", () => {
    render(bulkRoot({}, { uploaded: false }));

    expect(screen.getByText("bulkLimit.freeRemaining")).toBeTruthy();
  });

  describe("unified sending status", () => {
    it.each([
      [
        "campaign limit",
        { bulkRecipientExhausted: true, bulkRecipientCount: 125, bulkRecipientsRemaining: 0 },
      ],
      [
        "conversation limit",
        { conversationExhausted: true, conversationCount: 8049 },
      ],
      ["expired trial", { trialExpired: true }],
    ] as const)(
      "blocks sending for %s even before provider checks finish",
      async (_reason, limit) => {
        mockCompanyLimits = { ...initialCompanyLimits, ...limit };
        global.fetch = jest.fn(() => new Promise(() => undefined)) as jest.Mock;

        render(bulkRoot());

        const send = screen.getByRole("button", {
          name: "sendUnavailable",
        }) as HTMLButtonElement;
        expect(send.disabled).toBe(true);
        expect(send.getAttribute("data-variant")).toBe("secondary");
        expect(
          screen.getByTestId("campaign-readiness").getAttribute("data-readiness-state")
        ).toBe("plan_blocked");
        expect(
          document.getElementById(send.getAttribute("aria-describedby") || "")
        ).not.toBeNull();
        expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
        fireEvent.click(send);
        expect(
          (global.fetch as jest.Mock).mock.calls.some(([url]) => url === "/api/campaigns/bulk-send")
        ).toBe(false);
      }
    );

    it("shows a plan restriction for generated sends without a client live plan", () => {
      mockCompanyLimits = { ...initialCompanyLimits, conversationExhausted: true };
      mockGraphIndex.bulkActionByRootId = new Map();
      render(
        bulkRoot({
          generationStatus: "complete",
          generationJobId: "generation-plan-blocked",
          generatedRecipientCount: 6,
          uploadedRecipients: [],
        })
      );

      expect(
        (screen.getByRole("button", { name: "sendUnavailable" }) as HTMLButtonElement).disabled
      ).toBe(true);
      expect(
        screen.getByTestId("campaign-readiness").getAttribute("data-readiness-state")
      ).toBe("plan_blocked");
    });

    it("blocks scheduled sends without locking the saved schedule editor", () => {
      mockCompanyLimits = { ...initialCompanyLimits, conversationExhausted: true };
      render(bulkRoot());
      fireEvent.click(
        screen.getByRole("button", { name: "bulkNodeScheduleOption" })
      );

      expect((screen.getByLabelText("sendAt") as HTMLInputElement).disabled).toBe(false);
      expect(
        (screen.getByRole("button", { name: "sendUnavailable" }) as HTMLButtonElement).disabled
      ).toBe(true);
      expect(
        screen.getByTestId("campaign-readiness").getAttribute("data-readiness-state")
      ).toBe("plan_blocked");
    });

    it("shows the same restriction for Telegram when WhatsApp checks do not apply", () => {
      mockCompanyLimits = { ...initialCompanyLimits, trialExpired: true };
      mockGraphIndex.bulkActionByRootId = new Map([
        [
          "bulk-1",
          createMockBulkConnectedAction("telegram-action", {
            kind: "action",
            actionType: "reply",
            actionReplyChannel: "telegram",
            actionReplyText: "Hello",
          }),
        ],
      ]);
      render(
        bulkRoot({
          channels: ["telegram"],
          uploadedRecipients: [{ chatId: "123", name: "Aibek" }],
        })
      );

      expect(
        (screen.getByRole("button", { name: "sendUnavailable" }) as HTMLButtonElement).disabled
      ).toBe(true);
      expect(
        screen.getByTestId("campaign-readiness").getAttribute("data-readiness-state")
      ).toBe("plan_blocked");
    });

    it("keeps recurring birthday configuration editable while explaining its plan restriction", () => {
      mockCompanyLimits = { ...initialCompanyLimits, conversationExhausted: true };
      render(
        bulkRoot({
          recipientAudienceSource: SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
          scheduleConfig: {
            version: 2,
            mode: "recurring",
            timezone: "UTC",
            recurrence: { kind: "daily", time: "09:00" },
          },
        })
      );

      expect(
        screen.getByTestId("campaign-readiness").getAttribute("data-readiness-state")
      ).toBe("plan_blocked");
      const campaignName = screen.getByLabelText(
        "bulkNodeCampaignName"
      ) as HTMLInputElement;
      expect(campaignName.disabled).toBe(false);
      fireEvent.change(campaignName, {
        target: { value: "Updated birthday campaign" },
      });
      expect(mockUpdateNodeById).toHaveBeenCalledWith("bulk-1", {
        bulkRootConfig: expect.objectContaining({
          campaignName: "Updated birthday campaign",
        }),
      });
    });
  });

  it("sends a persisted generated revision before manual audience and action gates", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    const scenarioUpdate = createGeneratedScenarioUpdate();
    const children: GeneratedChildFixture[] = [
      {
        partitionKey: "email:source-1",
        channel: "email",
        sourceId: "source-1",
        campaignId: "campaign-email",
        dispatchId: "campaign-email",
        workflowId: "bulk-campaign-campaign-email",
        status: "queued",
        total: 3,
        skippedRecipientCount: 0,
      },
      {
        partitionKey: "whatsapp:source-2",
        channel: "whatsapp",
        sourceId: "source-2",
        campaignId: "campaign-whatsapp",
        dispatchId: "campaign-whatsapp",
        workflowId: "bulk-campaign-campaign-whatsapp",
        status: "queued",
        total: 2,
        skippedRecipientCount: 1,
      },
    ];
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({
        ok: true,
        json: async () =>
          createGeneratedSendResponse({
            queuedCount: 5,
            skipped: 1,
            children,
            scenarioUpdate,
          }),
      });
    }) as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
      })
    );

    const sendButton = screen.getByRole("button", {
      name: "bulkNodeSendNow",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
    fireEvent.click(sendButton);

    await waitFor(() =>
      expect(mockAdoptGeneratedBulkServerUpdate).toHaveBeenCalledWith(
        scenarioUpdate,
        "active"
      )
    );
    const generatedRequest = (global.fetch as jest.Mock).mock.calls.find(
      ([request]) => String(request).includes("/scenario-generator/send")
    );
    expect(generatedRequest).toBeTruthy();
    expect(JSON.parse(generatedRequest?.[1]?.body)).toMatchObject({
      scenarioId: "scenario-1",
      idempotencyKey: expect.any(String),
    });
    expect(mockUpdateNodeById).not.toHaveBeenCalled();
    expect(screen.queryByText("dropzoneTitle")).toBeNull();
    expect(screen.getByText("bulkNodeGeneratedRecipientMessages")).toBeTruthy();
  });

  it("fails closed when a generated revision has no authoritative recipient count", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    global.fetch = jest.fn() as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: undefined,
        recipientAudienceSource:
          SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
        uploadedRecipients: [{ phone: "+77001234567" }],
      })
    );

    expect(
      screen.getAllByText("bulkNodeGeneratedRecipientCountUnavailable")
    ).toHaveLength(2);
    const sendButton = screen.getByRole("button", {
      name: "bulkNodeSendNow",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    // The alert explains it; the line under Send names it for the button.
    expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
      "bulkNodeGeneratedRecipientCountUnavailable"
    );
    expect(sendButton.getAttribute("aria-describedby")).toBe(
      screen.getByTestId("bulk-send-blocked-reason").id
    );
    expect(
      screen.getByRole("button", { name: "bulkNodeRefreshMedia" })
    ).toBeTruthy();
    expect(screen.getByText("bulkNodeSendTiming")).toBeTruthy();
    expect(screen.queryByText("dropzoneTitle")).toBeNull();

    await waitFor(() => expect(mockUpdateNodeById).not.toHaveBeenCalled());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not run stale manual Telegram audience effects for a generated revision", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    global.fetch = jest.fn() as jest.Mock;

    render(
      bulkRoot({
        channels: ["telegram"],
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 3,
        recipientAudienceSource:
          SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
        telegramSubscriberSourceId: "telegram-source-1",
        uploadedRecipients: [{ chatId: "12345" }],
      })
    );

    expect(screen.getByText("bulkNodeSendTiming")).toBeTruthy();
    expect(screen.queryByText("bulkNodeTelegramKnownAudience")).toBeNull();
    await waitFor(() => expect(mockUpdateNodeById).not.toHaveBeenCalled());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps one generated attempt key through partial, in-progress, and confirmation recovery", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    const fingerprint = "f".repeat(64);
    const responses = [
      {
        ok: false,
        status: 503,
        body: {
          operationDisposition: "in_progress",
          code: "generated_bulk_send_retryable_failure",
          error: "Second partition is temporarily unavailable",
          partial: true,
          retryable: true,
          total: 2,
          requestedTotal: 6,
          skippedRecipientCount: 1,
          childrenTotal: 1,
          campaignId: "campaign-email",
          dispatchId: "campaign-email",
          workflowId: "bulk-campaign-campaign-email",
          status: "queued",
          children: [
            {
              partitionKey: "email:source-1",
              channel: "email",
              sourceId: "source-1",
              campaignId: "campaign-email",
              dispatchId: "campaign-email",
              workflowId: "bulk-campaign-campaign-email",
              status: "queued",
              total: 2,
              skippedRecipientCount: 0,
              batchPlan: { batchSize: 2, delayMs: 0, ratePerSecond: 50 },
              temporalDispatchStaging: "inline",
              audience: {
                fingerprint: "a".repeat(64),
                requestedTotal: 2,
                queuedTotal: 2,
                skippedOptIn: 0,
              },
              audienceConfirmation: {
                required: false,
                confirmed: false,
                fingerprint: "a".repeat(64),
              },
            },
          ],
        },
      },
      {
        ok: false,
        status: 409,
        body: {
          operationDisposition: "in_progress",
          code: "generated_bulk_send_in_progress",
          error: "This generated send is still being processed",
          retryable: true,
        },
      },
      {
        ok: false,
        status: 409,
        body: {
          operationDisposition: "in_progress",
          code: "bulk_campaign_recent_audience_confirmation_required",
          error: "Confirm recent audience reuse",
          retryable: true,
          audience: {
            fingerprint,
            overlap: {
              kind: "exact",
              intersectionCount: 6,
              candidateCount: 6,
              ratio: 1,
            },
          },
          audienceConfirmation: {
            required: true,
            confirmed: false,
            fingerprint,
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          ...createGeneratedSendResponse({
            queuedCount: 2,
            skipped: 4,
            children: [
              {
                partitionKey: "email:source-1",
                channel: "email",
                sourceId: "source-1",
                campaignId: "campaign-email",
                dispatchId: "campaign-email",
                workflowId: "bulk-campaign-campaign-email",
                status: "queued",
                total: 2,
                skippedRecipientCount: 0,
              },
            ],
            scenarioUpdate: createGeneratedScenarioUpdate({
              queued: 2,
              skipped: 4,
              scenarioUpdatedAt: "2026-07-27T10:02:00.000Z",
            }),
          }),
          queued: true,
          campaignId: "campaign-email",
          dispatchId: "campaign-email",
          workflowId: "bulk-campaign-campaign-email",
          status: "queued",
        },
      },
    ];
    let generatedCall = 0;
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      const next = responses[generatedCall++]!;
      return Promise.resolve({
        ok: next.ok,
        status: next.status,
        json: async () => next.body,
      });
    }) as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
      })
    );

    const getSendButton = () =>
      screen
        .getAllByRole("button")
        .find(button =>
          ["bulkNodeSendNow", "bulkNodeSendAgain"].includes(
            button.textContent || ""
          )
        ) as HTMLButtonElement;
    const clickSend = async () => {
      const expectedCallCount = generatedCall + 1;
      fireEvent.click(getSendButton());
      await waitFor(() => expect(generatedCall).toBe(expectedCallCount));
      await waitFor(() => expect(getSendButton().disabled).toBe(false));
    };
    await clickSend();
    expect(
      screen
        .getByTestId("campaign-dispatch-live-status")
        .getAttribute("data-campaign-id")
    ).toBe("campaign-email");
    await clickSend();
    await clickSend();
    await clickSend();

    const generatedBodies = (global.fetch as jest.Mock).mock.calls
      .filter(([request]) =>
        String(request).includes("/scenario-generator/send")
      )
      .map(([, init]) => JSON.parse(init.body));
    expect(generatedBodies).toHaveLength(4);
    expect(new Set(generatedBodies.map(body => body.idempotencyKey)).size).toBe(
      1
    );
    expect(generatedBodies[3]).toMatchObject({
      audienceConfirmationFingerprint: fingerprint,
    });
  });

  it("keeps the generated attempt schedule through network and unknown responses", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    const { toast } = jest.requireMock("sonner") as {
      toast: { success: jest.Mock };
    };
    const responses: Array<
      | { kind: "network" }
      | {
          kind: "http";
          ok: boolean;
          status: number;
          body: BulkCampaignSendResponse;
        }
    > = [
      { kind: "network" },
      {
        kind: "http",
        ok: false,
        status: 500,
        body: {
          code: "generated_bulk_send_unknown",
          error: "The server outcome is not known yet",
        },
      },
      {
        kind: "http",
        ok: true,
        status: 200,
        body: createGeneratedSendResponse({ scheduled: false }),
      },
    ];
    let generatedCall = 0;
    global.fetch = jest.fn((_request: RequestInfo | URL) => {
      const response = responses[generatedCall++]!;
      if (response.kind === "network") {
        return Promise.reject(new TypeError("Network connection lost"));
      }
      return Promise.resolve({
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      });
    }) as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
      })
    );

    fireEvent.click(
      screen.getByRole("button", { name: /bulkNodeScheduleOption/i })
    );
    fireEvent.change(screen.getByLabelText("sendAt"), {
      target: { value: "2099-05-15T10:00" },
    });
    const send = async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /bulkNodeScheduleSend/i })
      );
      await waitFor(() => expect(generatedCall).toBeGreaterThan(0));
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: /bulkNodeScheduleSend/i,
            }) as HTMLButtonElement
          ).disabled
        ).toBe(false)
      );
    };

    await send();
    expect(screen.getByText("bulkNodeGeneratedTimingLocked")).toBeTruthy();
    expect(
      (
        screen
          .getByText("bulkNodeSendTiming")
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled
    ).toBe(true);
    await send();
    await send();

    const bodies = (global.fetch as jest.Mock).mock.calls.map(([, init]) =>
      JSON.parse(init.body)
    );
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies.map(body => body.idempotencyKey)).size).toBe(1);
    expect(new Set(bodies.map(body => body.scheduledAt)).size).toBe(1);
    expect(new Date(bodies[0].scheduledAt).getTime()).toBe(
      new Date("2099-05-15T10:00").getTime()
    );
    expect(toast.success).toHaveBeenCalledWith("bulkNodeQueuedToast");
    expect(toast.success).not.toHaveBeenCalledWith("bulkNodeScheduledToast");
  });

  it("clears partial feedback when the same generated revision completes authoritatively", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        operationDisposition: "in_progress",
        code: "generated_bulk_send_retryable_failure",
        error: "One partition is still recovering",
        partial: true,
        retryable: true,
        total: 2,
        requestedTotal: 6,
        skippedRecipientCount: 1,
        childrenTotal: 1,
      }),
    }) as jest.Mock;
    const { rerender } = render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));
    await waitFor(() =>
      expect(screen.getByText("bulkNodePartialSendResult")).toBeTruthy()
    );

    rerender(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        generatedSendState: {
          revision: "generation-job-1",
          operationId: "operation-1",
          state: "completed",
          requestedAt: "2026-07-27T10:00:00.000Z",
          completedAt: "2026-07-27T10:01:00.000Z",
        },
        sendStatus: {
          total: 6,
          queued: 5,
          sent: 0,
          skipped: 1,
          failed: 0,
        },
      })
    );

    await waitFor(() =>
      expect(screen.queryByText("bulkNodePartialSendResult")).toBeNull()
    );
  });

  it("uses a fresh generated attempt key after a terminal no-admission failure", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    let generatedCallCount = 0;
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      generatedCallCount += 1;
      return Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({
          operationDisposition: "not_started",
          code: "generated_bulk_send_not_admitted",
          error: "No generated send operation was admitted",
          retryable: false,
        }),
      });
    }) as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
      })
    );

    const sendButton = screen.getByRole("button", {
      name: "bulkNodeSendNow",
    });
    fireEvent.click(sendButton);
    await waitFor(() => expect(generatedCallCount).toBe(1));
    await waitFor(() =>
      expect((sendButton as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(sendButton);
    await waitFor(() => expect(generatedCallCount).toBe(2));

    const generatedBodies = (global.fetch as jest.Mock).mock.calls
      .filter(([request]) =>
        String(request).includes("/scenario-generator/send")
      )
      .map(([, init]) => JSON.parse(init.body));
    expect(generatedBodies).toHaveLength(2);
    expect(generatedBodies[0].idempotencyKey).not.toBe(
      generatedBodies[1].idempotencyKey
    );
  });

  it("disables a completed generated revision instead of offering an accidental send again", () => {
    mockCompanyLimits = {
      ...initialCompanyLimits,
      conversationExhausted: true,
      bulkRecipientExhausted: true,
      bulkRecipientCount: 125,
      bulkRecipientsRemaining: 0,
    };
    mockGraphIndex.bulkActionByRootId = new Map();
    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        generatedSendState: {
          revision: "generation-job-1",
          operationId: "operation-1",
          state: "completed",
          requestedAt: "2026-07-27T10:00:00.000Z",
          completedAt: "2026-07-27T10:01:00.000Z",
        },
      })
    );

    const sendButton = screen.getByRole("button", {
      name: "bulkNodeGeneratedRevisionSent",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(screen.queryByText("planRestriction.title")).toBeNull();
    expect(screen.queryByRole("button", { name: "bulkLimit.upgrade" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "bulkNodeRefreshMedia" })
    ).toBeNull();
    fireEvent.click(sendButton);
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([request]) =>
        String(request).includes("/scenario-generator/send")
      )
    ).toBe(false);
  });

  it.each(["queued", "generating_media"] as const)(
    "keeps generated send disabled while media generation is %s",
    generationStatus => {
      mockGraphIndex.bulkActionByRootId = new Map();
      render(
        bulkRoot({
          generationStatus,
          generationJobId: "generation-job-1",
          generatedRecipientCount: 6,
          uploadedRecipients: [],
        })
      );

      const sendButton = screen.getByRole("button", {
        name: "bulkNodeSendNow",
      }) as HTMLButtonElement;
      expect(sendButton.disabled).toBe(true);
      fireEvent.click(sendButton);
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([request]) =>
          String(request).includes("/scenario-generator/send")
        )
      ).toBe(false);
    }
  );

  it.each(["conflict", "failed"] as const)(
    "does not report generated media refresh success for a %s outcome",
    async status => {
      mockGraphIndex.bulkActionByRootId = new Map();
      mockReconcileGeneratedJobServerUpdate.mockResolvedValue({ status });
      const { toast } = jest.requireMock("sonner") as {
        toast: { success: jest.Mock };
      };
      render(
        bulkRoot({
          generationStatus: "queued",
          generationJobId: "generation-job-1",
          generatedRecipientCount: 6,
          uploadedRecipients: [],
        })
      );

      fireEvent.click(
        screen.getByRole("button", { name: "bulkNodeRefreshMedia" })
      );

      await waitFor(() =>
        expect(mockReconcileGeneratedJobServerUpdate).toHaveBeenCalledTimes(1)
      );
      expect(toast.success).not.toHaveBeenCalledWith(
        "bulkNodeGenerationRefreshed"
      );
    }
  );

  it("requires explicit acknowledgement before sending a generated revision with terminal media failures", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({
        ok: true,
        json: async () =>
          createGeneratedSendResponse({
            generatedRecipientCount: 2,
            queued: false,
            skipped: 2,
          }),
      });
    }) as jest.Mock;
    render(
      bulkRoot({
        generationStatus: "failed",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 2,
        uploadedRecipients: [],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));
    expect(
      screen.getByText("bulkNodeMediaFailureAcknowledgeTitle")
    ).toBeTruthy();
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([request]) =>
        String(request).includes("/scenario-generator/send")
      )
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "bulkNodeMediaFailureAcknowledgeConfirm",
      })
    );

    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([request]) =>
          String(request).includes("/scenario-generator/send")
        )
      ).toBe(true)
    );
    const generatedRequest = (global.fetch as jest.Mock).mock.calls.find(
      ([request]) => String(request).includes("/scenario-generator/send")
    );
    expect(JSON.parse(generatedRequest?.[1]?.body)).toMatchObject({
      acknowledgeMediaFailures: true,
    });
  });

  it("shows an all-skipped generated completion as no eligible recipients instead of queued", async () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    const { toast } = jest.requireMock("sonner") as {
      toast: { success: jest.Mock; warning: jest.Mock };
    };
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({
        ok: true,
        json: async () =>
          createGeneratedSendResponse({
            generatedRecipientCount: 3,
            queued: false,
            skipped: 3,
          }),
      });
    }) as jest.Mock;
    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 3,
        uploadedRecipients: [],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

    await waitFor(() =>
      expect(screen.getByText("bulkNodeNoEligibleRecipients")).toBeTruthy()
    );
    expect(toast.warning).toHaveBeenCalledWith(
      "bulkNodeNoEligibleRecipientsToast"
    );
    expect(toast.success).not.toHaveBeenCalledWith("bulkNodeQueuedToast");
  });

  it("shows the attached primary template inside the bulk campaign node", () => {
    render(bulkRoot({}, { uploaded: false }));

    expect(screen.getByText("campaignAudienceNodeTitle")).toBeTruthy();
    expect(screen.queryByText("Bulk campaign root")).toBeNull();
    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    expect(screen.getByText("bulkNodeAttachedAction")).toBeTruthy();
    expect(screen.getByText("launch_offer (en)")).toBeTruthy();
    expect(screen.getByText("Hi {{name}}, offer is ready")).toBeTruthy();
    expect(screen.getByText("bulkNodeVariables")).toBeTruthy();
    expect(screen.getAllByText("{{name}}").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "bulkNodeSendNow" })
    ).toBeTruthy();
    expect(screen.queryByText("Status")).toBeNull();
    expect(screen.queryByText("Trigger")).toBeNull();
  });

  it("uses a stable canvas width for the nested bulk controls", () => {
    const { container } = render(bulkRoot({}, { uploaded: false }));

    expect(container.firstElementChild?.className).toContain(
      "w-[min(440px,calc(100vw-2rem))]"
    );
    expect(container.firstElementChild?.className).toContain("max-w-[440px]");
  });

  it("does not clip the right-side source handle", () => {
    const { container } = render(bulkRoot({}, { uploaded: false }));

    expect(container.firstElementChild?.className).toContain(
      "overflow-visible"
    );
  });

  it("keeps file upload and contacts exclusive on the canvas node", async () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_throughput",
          throughputLevel: "STANDARD",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
        whatsappMeta: {
          sourceId: "source-1",
          phoneNumberId: "phone-1",
          detailsSource: "meta_phone_details",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(bulkRoot({}, { uploaded: false }));

    expect(screen.getByText("dropzoneTitle")).toBeTruthy();
    expect(screen.queryByText("recipient.contactsTitle")).toBeNull();
    expect(screen.queryByLabelText("recipient.quickAddLabel")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "bulkNodeFromContacts" })
    );

    expect(screen.queryByText("dropzoneTitle")).toBeNull();
    expect(await screen.findByText("recipient.contactsTitle")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "bulkNodeFromFile" })
    ).toBeTruthy();
  });

  it("renders only the right-side bulk source handle", () => {
    render(bulkRoot({}, { uploaded: false }));

    expect(
      screen.queryByTestId("source-handle-top-source-bulk-action")
    ).toBeNull();
    expect(
      screen
        .getByTestId(
          `source-handle-${BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID}`
        )
        .getAttribute("data-handle-position")
    ).toBe("right");
  });

  it("opens the node picker from the right bulk source handle", () => {
    render(bulkRoot({}, { uploaded: false }));

    fireEvent.click(
      screen.getByTestId(
        `source-handle-${BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID}`
      )
    );

    expect(mockOpenNodePickerFromHandle).toHaveBeenNthCalledWith(
      1,
      "bulk-1",
      BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("does not render helper alerts when the right-side campaign template is missing", () => {
    mockGraphIndex.bulkActionByRootId = new Map();

    render(bulkRoot({}, { uploaded: false }));

    expect(screen.queryByText("bulkNodePrimaryActionMissingTitle")).toBeNull();
    expect(
      screen.queryByText("bulkNodePrimaryActionMissingDescription")
    ).toBeNull();
    expect(screen.queryByText("bulkNodeFollowUpHint")).toBeNull();
  });

  it("keeps send disabled after upload when the primary campaign template is missing", () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    mockCsvUploadPayload = [
      { phone: "+77001234567", name: "Aibek", fields: { name: "Aibek" } },
    ];

    render(bulkRoot({}, { uploaded: false }));

    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("keeps send disabled when the connected WhatsApp template is stale", () => {
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    mockGraphIndex.bulkActionByRootId = new Map([
      [
        "bulk-1",
        createMockBulkConnectedAction("action-1", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "launch_offer",
          actionWhatsAppTemplateLanguage: "en",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Hi {{name}}, offer is ready" },
          ],
        }),
      ],
    ]);
    mockCsvUploadPayload = [
      { phone: "+77001234567", name: "Aibek", fields: { name: "Aibek" } },
    ];

    render(bulkRoot({}, { uploaded: false }));

    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));

    expect(
      screen.getAllByText("bulkNodeTemplateSendBlockedStale")
    ).toHaveLength(2);
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
      "bulkNodeTemplateSendBlockedStale"
    );
  });

  it("waits for the template catalog before calling the connected template missing", () => {
    mockHasLoadedWhatsAppTemplates = false;
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    mockGraphIndex.bulkActionByRootId = new Map([
      [
        "bulk-1",
        createMockBulkConnectedAction("action-1", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "launch_offer",
          actionWhatsAppTemplateLanguage: "en",
        }),
      ],
    ]);

    const element = bulkRoot();
    const { rerender } = render(element);

    expect(screen.queryByText("bulkNodeTemplateSendBlockedStale")).toBeNull();
    expect(
      screen.getAllByText("bulkNodeTemplateSendBlockedLoading")
    ).toHaveLength(2);
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    // Nothing else loads the catalog for an unselected node, and its
    // disabled Send can't select it.
    expect(element.props.selected).toBe(false);
    expect(mockLoadWhatsAppTemplates).toHaveBeenCalledTimes(1);
    rerender(cloneElement(element));
    expect(mockLoadWhatsAppTemplates).toHaveBeenCalledTimes(1);
  });

  it("leaves the template catalog alone once it has loaded", () => {
    render(bulkRoot());

    expect(mockLoadWhatsAppTemplates).not.toHaveBeenCalled();
  });

  function connectTemplateAgainstCurrentCatalog() {
    mockGraphIndex.bulkActionByRootId = new Map([
      [
        "bulk-1",
        createMockBulkConnectedAction("action-1", {
          kind: "action",
          actionType: "whatsapp_template",
          actionWhatsAppTemplateName: "launch_offer",
          actionWhatsAppTemplateLanguage: "en",
          actionWhatsAppTemplateComponents: [
            { type: "BODY", text: "Hi {{name}}, offer is ready" },
          ],
        }),
      ],
    ]);
  }

  /**
   * The template card shows `message`; the line above Send says it without
   * a retry time (`sendReason`), so the time appears once.
   */
  function expectTemplateSendBlocked(message: string, sendReason = message) {
    expect(screen.queryByText("bulkNodeTemplateSendBlockedLoading")).toBeNull();
    expect(screen.queryByText("bulkNodeTemplateSendBlockedStale")).toBeNull();
    if (sendReason === message) {
      expect(screen.getAllByText(message)).toHaveLength(2);
    } else {
      expect(screen.getAllByText(message)).toHaveLength(1);
      expect(screen.getAllByText(sendReason)).toHaveLength(1);
    }
    expect(
      screen.queryAllByText(/readiness\.cooldownUntil/).length
    ).toBeLessThan(2);
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
      sendReason
    );
  }

  function cooldownTimes() {
    return mockTranslate.mock.calls
      .filter(([key]) => key === "readiness.cooldownUntil")
      .map(call => (call as unknown[])[1] as { time: string })
      .map(values => values.time);
  }

  it("says the catalog is unavailable instead of checking approval forever or calling the template missing", () => {
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    mockHasLoadedWhatsAppTemplates = false;
    mockWhatsAppTemplatesError = { retryAt };
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    connectTemplateAgainstCurrentCatalog();

    render(bulkRoot());

    // A failure that isn't Meta's limit isn't called a limit.
    expectTemplateSendBlocked(
      "templateCatalog.unavailable readiness.cooldownUntil",
      "templateCatalog.unavailable"
    );
    expect(mockTranslate).not.toHaveBeenCalledWith(
      "templateCatalog.rateLimited"
    );
    // The readiness notice's formatter: the date, the time and the zone.
    expect(cooldownTimes()).not.toHaveLength(0);
    for (const time of cooldownTimes()) {
      expect(time.startsWith(`${retryAt} (`)).toBe(true);
    }
  });

  it("calls Meta's own template limit a limit", () => {
    mockHasLoadedWhatsAppTemplates = false;
    mockWhatsAppTemplatesError = {
      retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
    };
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    connectTemplateAgainstCurrentCatalog();

    render(bulkRoot());

    expectTemplateSendBlocked(
      "templateCatalog.rateLimited readiness.cooldownUntil",
      "templateCatalog.rateLimited"
    );
  });

  it("drops the cooldown time once the catalog's retry time has passed", () => {
    mockHasLoadedWhatsAppTemplates = false;
    mockWhatsAppTemplatesError = {
      retryAt: new Date(Date.now() - 1_000).toISOString(),
    };
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    connectTemplateAgainstCurrentCatalog();

    render(bulkRoot());

    expectTemplateSendBlocked("templateCatalog.unavailable");
  });

  it("keeps a known approved template sendable from a saved catalog Meta couldn't refresh", () => {
    mockWhatsAppTemplatesError = {
      retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    connectTemplateAgainstCurrentCatalog();

    render(bulkRoot());

    expect(screen.queryByText(/^bulkNodeTemplateSendBlocked/)).toBeNull();
    expect(screen.queryByText(/^templateCatalog\./)).toBeNull();
    expect(
      screen.queryByTestId("bulk-send-blocked-reason")?.textContent ?? ""
    ).not.toMatch(/bulkNodeTemplateSendBlocked|templateCatalog\./);
  });

  it("doesn't call a template missing when only a saved catalog Meta couldn't refresh lacks it", () => {
    mockWhatsAppTemplatesError = { retryAt: null };
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    connectTemplateAgainstCurrentCatalog();

    render(bulkRoot());

    expectTemplateSendBlocked("templateCatalog.unavailable");
  });

  it("still calls a template missing from a catalog that refreshed", () => {
    mockWhatsAppTemplates.splice(0, mockWhatsAppTemplates.length);
    connectTemplateAgainstCurrentCatalog();

    render(bulkRoot());

    expect(screen.queryByText(/^templateCatalog\./)).toBeNull();
    expect(
      screen.getAllByText("bulkNodeTemplateSendBlockedStale")
    ).toHaveLength(2);
  });

  it("saves the cleared recipients and record back from the undo toast", () => {
    const savedRecipients = [
      { phone: "+77001234567", name: "Aibek" },
      { phone: "+77007654321", name: "Dana" },
    ];
    const savedEvidence = {
      replacementHistory: [
        {
          action: "cleared" as const,
          replacedAt: "2026-07-23T08:00:00.000Z",
          previousFilename: "earlier.csv",
        },
      ],
    };
    render(
      bulkRoot({
        uploadedRecipients: savedRecipients,
        audienceUploadEvidence: savedEvidence,
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "recipient.clearAll" }));
    expect(mockUpdateNodeById).toHaveBeenLastCalledWith("bulk-1", {
      bulkRootConfig: expect.objectContaining({ uploadedRecipients: [] }),
    });
    const { toast } = jest.requireMock("sonner") as { toast: jest.Mock };
    const [message, options] = toast.mock.calls.at(-1) as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("recipient.clearedToast");
    expect(options.action.label).toBe("recipient.undoClear");

    act(() => options.action.onClick());

    expect(mockUpdateNodeById).toHaveBeenLastCalledWith("bulk-1", {
      bulkRootConfig: expect.objectContaining({
        uploadedRecipients: savedRecipients,
        audienceUploadEvidence: savedEvidence,
      }),
    });
  });

  it("disables send-now until recipients have been uploaded or restored", () => {
    render(bulkRoot({}, { uploaded: false }));

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("renders the shared outcome summary from a persisted lastOutcome", () => {
    render(
      bulkRoot({
        sendStatus: {
          total: 4,
          queued: 1,
          sent: 0,
          skipped: 3,
          failed: 0,
          campaignId: "campaign-outcome",
          dispatchId: "dispatch-outcome",
          lifecycleStatus: "queued",
          lastOutcome: {
            disposition: "queued",
            evaluatedAt: "2026-08-24T12:00:00.000Z",
            lifecycleStatus: "queued",
            requestedTotal: 4,
            acceptedTotal: 1,
            queuedTotal: 1,
            uniqueRecipients: { requested: 4, accepted: 1, queued: 1 },
            skippedByReason: {
              marketing_opt_out: 2,
              prior_failure: 1,
            },
            warnings: { missingMarketingConsent: 4 },
            campaignId: "campaign-outcome",
            dispatchId: "dispatch-outcome",
          },
        },
      })
    );

    const summary = screen.getByTestId("bulk-campaign-outcome-summary");
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain("outcome.marketingOptOut");
    expect(summary.textContent).toContain("2");
    expect(summary.textContent).toContain("outcome.priorFailure");
    expect(summary.textContent).toContain("1");
    expect(summary.textContent).toContain("outcome.missingMarketingConsent");
    expect(summary.textContent).toContain("4");
    expect(screen.queryByText("bulkNodeSkippedCount")).toBeNull();
  });

  it("renders the shared outcome summary when live dispatch status is unavailable", () => {
    render(
      bulkRoot({
        sendStatus: {
          total: 4,
          queued: 1,
          sent: 0,
          skipped: 3,
          failed: 0,
          lastOutcome: {
            disposition: "queued",
            evaluatedAt: "2026-08-24T12:00:00.000Z",
            lifecycleStatus: "queued",
            requestedTotal: 4,
            acceptedTotal: 1,
            queuedTotal: 1,
            uniqueRecipients: { requested: 4, accepted: 1, queued: 1 },
            skippedByReason: {
              marketing_opt_out: 2,
              prior_failure: 1,
            },
            warnings: { missingMarketingConsent: 4 },
            campaignId: "campaign-outcome",
            dispatchId: "dispatch-outcome",
          },
        },
      })
    );

    expect(screen.queryByTestId("campaign-dispatch-live-status")).toBeNull();
    expect(screen.getByTestId("bulk-campaign-outcome-summary")).toBeTruthy();
    expect(screen.getByText("bulkNodeQueuedCount")).toBeTruthy();
  });

  it("keeps sending disabled while active and persists a terminal lifecycle transition", () => {
    mockCompanyLimits = { ...initialCompanyLimits, conversationExhausted: true };
    render(
      bulkRoot({
        sendStatus: {
          total: 1,
          queued: 1,
          sent: 0,
          skipped: 0,
          failed: 0,
          campaignId: "campaign-active",
          dispatchId: "dispatch-active",
          lifecycleStatus: "running",
          audienceRevision: 1,
        },
      })
    );

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    expect(mockCampaignDispatchLiveStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        campaignId: "campaign-active",
        initialStatus: "running",
      })
    );
    expect(screen.queryByText("planRestriction.title")).toBeNull();
    fireEvent.click(screen.getByText("complete-live-dispatch"));

    expect(mockUpdateNodeById).toHaveBeenLastCalledWith(
      "bulk-1",
      expect.objectContaining({
        bulkRootConfig: expect.objectContaining({
          sendStatus: expect.objectContaining({
            lifecycleStatus: "completed",
            queued: 0,
            sent: 1,
            failed: 0,
          }),
        }),
      })
    );
  });

  it("labels an unchanged terminal audience as an explicit send again action", () => {
    render(
      bulkRoot({
        sendStatus: {
          total: 1,
          queued: 0,
          sent: 1,
          skipped: 0,
          failed: 0,
          campaignId: "campaign-complete",
          dispatchId: "dispatch-complete",
          lifecycleStatus: "completed",
          audienceRevision: 1,
        },
      })
    );

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendAgain",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("uses the normal send label after a terminal dispatch audience changes", () => {
    render(
      bulkRoot({
        audienceRevision: 2,
        sendStatus: {
          total: 1,
          queued: 0,
          sent: 1,
          skipped: 0,
          failed: 0,
          campaignId: "campaign-complete",
          dispatchId: "dispatch-complete",
          lifecycleStatus: "completed",
          audienceRevision: 1,
        },
      })
    );

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("requires a second explicit action for recent overlap and invalidates it on audience revision", async () => {
    const firstFingerprint = "a".repeat(64);
    const revisedFingerprint = "b".repeat(64);
    let sendAttempts = 0;
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      if (url === "/api/campaigns/bulk-send") {
        sendAttempts += 1;
        if (sendAttempts <= 2) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({
              error: "Confirm recent audience reuse",
              code: "bulk_campaign_recent_audience_confirmation_required",
              audience: {
                fingerprint:
                  sendAttempts === 1 ? firstFingerprint : revisedFingerprint,
                overlap: {
                  kind: "high",
                  intersectionCount: 8,
                  candidateCount: 10,
                  ratio: 0.8,
                },
              },
              audienceConfirmation: { required: true, confirmed: false },
            }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      });
    }) as jest.Mock;

    const { rerender } = render(bulkRoot());
    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

    expect(
      await screen.findByText("bulkNodeRecentAudienceOverlap")
    ).toBeTruthy();
    expect(sendAttempts).toBe(1);

    rerender(bulkRoot({ audienceRevision: 2 }));
    expect(screen.queryByText("bulkNodeRecentAudienceOverlap")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));
    await waitFor(() => expect(sendAttempts).toBe(2));
    expect(
      await screen.findByText("bulkNodeRecentAudienceOverlap")
    ).toBeTruthy();
    const revisedAudienceBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls.filter(
        ([url]) => url === "/api/campaigns/bulk-send"
      )[1][1].body
    );
    expect(revisedAudienceBody.audienceConfirmationFingerprint).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendAgain" }));
    await waitFor(() => expect(sendAttempts).toBe(3));
    const confirmedBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls.filter(
        ([url]) => url === "/api/campaigns/bulk-send"
      )[2][1].body
    );
    expect(confirmedBody.audienceConfirmationFingerprint).toBe(
      revisedFingerprint
    );
  });

  describe("scenario activation on send", () => {
    const readToast = () =>
      (
        jest.requireMock("sonner") as {
          toast: { error: jest.Mock; success: jest.Mock };
        }
      ).toast;

    const mockBulkSendResponse = (
      status: number,
      payload: Record<string, unknown>
    ) => {
      global.fetch = jest.fn((request: RequestInfo | URL) => {
        const url = String(request);
        if (url.includes("/api/campaigns/birthday-protection")) {
          return new Promise(() => undefined);
        }
        if (url === "/api/campaigns/bulk-send") {
          return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => payload,
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ queued: true, total: 1 }),
        });
      }) as jest.Mock;
    };

    const activatedSendResponse = (disposition: "queued" | "scheduled") => ({
      ok: true,
      outcome: {
        disposition,
        evaluatedAt: "2026-09-30T12:00:00.000Z",
        lifecycleStatus: disposition,
        requestedTotal: 1,
        acceptedTotal: 1,
        queuedTotal: 1,
        uniqueRecipients: { requested: 1, accepted: 1, queued: 1 },
        skippedByReason: {},
        warnings: { missingMarketingConsent: 0 },
        campaignId: "campaign-1",
        dispatchId: "campaign-1",
        workflowId: "workflow-1",
      },
      scenarioActivated: true,
      scenarioStatus: "active",
      scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
      previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
    });

    it("says the send also activated the scenario and adopts its revision", async () => {
      mockBulkSendResponse(200, activatedSendResponse("queued"));
      render(bulkRoot());

      fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

      await waitFor(() =>
        expect(readToast().success).toHaveBeenCalledWith(
          "bulkNodeQueuedActivatedToast"
        )
      );
      expect(mockAdoptScenarioActivation).toHaveBeenCalledWith({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
    });

    it("adopts the activation when the recent audience still needs confirming", async () => {
      mockBulkSendResponse(409, {
        code: "bulk_campaign_recent_audience_confirmation_required",
        error: "Confirm sending to this recent audience again.",
        audience: {
          fingerprint: "a".repeat(64),
          overlap: {
            kind: "high",
            intersectionCount: 8,
            candidateCount: 10,
            ratio: 0.8,
          },
        },
        audienceConfirmation: { required: true, confirmed: false },
        scenarioActivated: true,
        scenarioStatus: "active",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
      render(bulkRoot());

      fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

      expect(
        await screen.findByText("bulkNodeRecentAudienceOverlap")
      ).toBeTruthy();
      expect(mockAdoptScenarioActivation).toHaveBeenCalledWith({
        scenarioId: "scenario-1",
        scenarioUpdatedAt: "2026-09-30T12:00:00.000Z",
        previousScenarioUpdatedAt: "2026-09-30T10:00:00.000Z",
      });
      expect(readToast().error).not.toHaveBeenCalled();
    });

    it("says a scheduled send also activated the scenario", async () => {
      mockBulkSendResponse(200, {
        ...activatedSendResponse("scheduled"),
        scheduledAt: "2099-05-15T10:00:00.000Z",
      });
      render(bulkRoot());

      fireEvent.click(
        screen.getByRole("button", { name: /bulkNodeScheduleOption/i })
      );
      fireEvent.change(screen.getByLabelText("sendAt"), {
        target: { value: "2099-05-15T10:00" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: /bulkNodeScheduleSend/i })
      );

      await waitFor(() =>
        expect(readToast().success).toHaveBeenCalledWith(
          "bulkNodeScheduledActivatedToast"
        )
      );
    });

    it.each([
      ["scenario_activation_required", "bulkNodeActivateScenarioFirst"],
      [
        "whatsapp_qr_activation_requires_scenario_route",
        "bulkNodeActivateQrScenarioFirst",
      ],
      ["scenario_activation_conflict", "bulkNodeActivationConflict"],
    ])("shows %s as its translated message", async (code, messageKey) => {
      mockBulkSendResponse(409, { code, error: "Raw English server text" });
      render(bulkRoot());

      fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

      await waitFor(() =>
        expect(readToast().error).toHaveBeenCalledWith(messageKey)
      );
      expect(readToast().error).not.toHaveBeenCalledWith(
        "Raw English server text"
      );
      expect(mockOnScenarioActivationBlocked).not.toHaveBeenCalled();
    });

    it.each(["meta_rate_limited", "template_lookup_unavailable"])(
      "shows a send-time %s as its translated readiness message",
      async code => {
        mockBulkSendResponse(503, {
          ok: false,
          disposition: "blocked",
          code,
          message: `Bulk campaign eligibility failed: ${code}`,
        });
        render(bulkRoot());

        fireEvent.click(
          screen.getByRole("button", { name: "bulkNodeSendNow" })
        );

        await waitFor(() =>
          expect(readToast().error).toHaveBeenCalledWith(
            `readiness.errors.${code}`
          )
        );
        expect(readToast().error).not.toHaveBeenCalledWith(
          `Bulk campaign eligibility failed: ${code}`
        );
      }
    );

    it.each([
      ["whatsappServiceMessageInvalid", "whatsappServiceMessageInvalid"],
      ["birthday_conflict", "activationImpactBlockingIssueGeneric"],
    ])(
      "explains a %s activation block and reveals the blocking step",
      async (reasonCode, reasonKey) => {
        mockBulkSendResponse(409, {
          code: "scenario_activation_blocked",
          error: "Raw English server text",
          reasonCode,
          nodeIds: ["service-1"],
        });
        render(bulkRoot());

        fireEvent.click(
          screen.getByRole("button", { name: "bulkNodeSendNow" })
        );

        await waitFor(() =>
          expect(readToast().error).toHaveBeenCalledWith(
            "bulkNodeActivationBlocked"
          )
        );
        expect(mockTranslate).toHaveBeenCalledWith(
          "bulkNodeActivationBlocked",
          { reason: reasonKey }
        );
        expect(readToast().error).not.toHaveBeenCalledWith(
          "Raw English server text"
        );
        expect(mockOnScenarioActivationBlocked).toHaveBeenCalledWith([
          "service-1",
        ]);
      }
    );
  });

  it("can send the Airi registered business phone audience without uploaded recipients", async () => {
    mockRegisteredBusinessPhonesAudience = {
      enabled: true,
      total: 12,
      preview: [{ phone: "77012345678", name: "Founder" }],
    };

    render(
      bulkRootElement({
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Bulk campaign",
          recipientSourceSummary: "Registered businesses",
          recipientAudienceSource:
            SCENARIO_BULK_REGISTERED_BUSINESS_PHONES_AUDIENCE_SOURCE,
          generationStatus: "idle",
        },
      })
    );

    const sendButton = screen.getByRole("button", {
      name: "bulkNodeSendNow",
    }) as HTMLButtonElement;
    expect(
      screen.getAllByText("bulkNodeRegisteredBusinessPhones").length
    ).toBeGreaterThan(0);
    expect(sendButton.disabled).toBe(false);

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(
        (global.fetch as jest.Mock).mock.calls.some(
          ([url]) => url === "/api/campaigns/bulk-send"
        )
      ).toBe(true);
    });
    const sendCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url]) => url === "/api/campaigns/bulk-send"
    );
    const body = JSON.parse(sendCall?.[1]?.body);
    expect(body).toMatchObject({
      channel: "whatsapp",
      audience: {
        kind: "registered_business_phones",
      },
    });
  });

  it("shows compact Telegram subscriber audience controls", async () => {
    mockGraphIndex.bulkActionByRootId = new Map([
      [
        "bulk-telegram",
        createMockBulkConnectedAction("action-telegram", {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyText: "Hello subscribers",
        }),
      ],
    ]);
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/api/workspaces/")) {
        return {
          ok: true,
          json: async () => ({
            sources: [
              {
                id: "telegram-source-1",
                type: "telegram",
                name: "Telegram main",
                credentials: { bot_username: "airi_bot" },
              },
            ],
          }),
        } as Response;
      }
      if (url.includes("/api/sources/telegram/telegram-source-1/subscribers")) {
        return {
          ok: true,
          json: async () => ({ total: 3 }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ queued: true, total: 3 }),
      } as Response;
    }) as jest.Mock;

    render(
      bulkRootElement(
        {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["telegram"],
            campaignName: "Telegram bulk",
            recipientSourceSummary: "No generated recipients yet",
            generationStatus: "idle",
          },
        },
        "bulk-telegram"
      )
    );

    expect(await screen.findByText("bulkNodeTelegramKnownCount")).toBeTruthy();
    expect(screen.queryByText(/ known$/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "bulkNodeUploadedAudience" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "bulkNodeFromFile" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "bulkNodeFromContacts" })
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "bulkNodeTelegramKnownAudience" })
    ).toBeTruthy();
    expect(screen.getByText("bulkNodeTelegramBot")).toBeTruthy();
    expect(screen.queryByText("Known subscribers")).toBeNull();

    const knownAudienceButton = screen.getByRole("button", {
      name: "bulkNodeTelegramKnownAudience",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(knownAudienceButton.disabled).toBe(false);
    });
    fireEvent.click(knownAudienceButton);

    await waitFor(() => {
      expect(mockUpdateNodeById).toHaveBeenCalledWith("bulk-telegram", {
        bulkRootConfig: expect.objectContaining({
          recipientAudienceSource:
            SCENARIO_BULK_TELEGRAM_SUBSCRIBERS_AUDIENCE_SOURCE,
        }),
      });
    });
  });

  it("imports Telegram birthday rows for the selected bot", async () => {
    mockGraphIndex.bulkActionByRootId = new Map([
      [
        "bulk-telegram-birthday",
        createMockBulkConnectedAction("action-telegram", {
          kind: "action",
          actionType: "reply",
          actionReplyChannel: "telegram",
          actionReplyMode: "fixed",
          actionReplyText: "Happy birthday {{name}}",
        }),
      ],
    ]);
    mockCsvUploadPayload = [
      {
        chatId: "123456",
        name: "Aibek",
        birthday: "23.07.1992",
        fields: { birthday: "23.07.1992" },
      },
    ];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/workspaces/")) {
        return {
          ok: true,
          json: async () => ({
            sources: [
              {
                id: "telegram-source-1",
                type: "telegram",
                name: "Telegram main",
              },
            ],
          }),
        } as Response;
      }
      if (url.includes("/subscribers")) {
        return {
          ok: true,
          json: async () => ({ total: 3 }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          total: 1,
          imported: 1,
          updated: 0,
          skippedMissingPhone: 0,
          skippedMissingChatId: 0,
          skippedIneligibleTelegramSubscriber: 0,
          skippedMissingBirthday: 0,
          skippedInvalidBirthday: 0,
        }),
      } as Response;
    }) as jest.Mock;

    render(
      bulkRootElement(
        {
          kind: "bulk",
          bulkRootConfig: {
            workflowKind: "bulk_campaign",
            sendMode: "immediate",
            channels: ["telegram"],
            campaignName: "Telegram birthdays",
            recipientSourceSummary: "Birthday upload",
            generationStatus: "idle",
            recipientAudienceSource:
              SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
            telegramSubscriberSourceId: "telegram-source-1",
            uploadedRecipients: [],
          },
        },
        "bulk-telegram-birthday"
      )
    );

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeBirthdayAudience",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    expect(screen.getByTestId("csv-upload-require-birthday").textContent).toBe(
      "true"
    );
    expect(
      screen.queryByRole("button", { name: "bulkNodeUploadedAudience" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "bulkNodeTelegramKnownAudience",
      })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));

    await waitFor(() => {
      expect(
        (global.fetch as jest.Mock).mock.calls.some(
          ([url]) => url === "/api/campaigns/birthday-import"
        )
      ).toBe(true);
    });
    const importCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url]) => url === "/api/campaigns/birthday-import"
    );
    expect(JSON.parse(importCall?.[1]?.body)).toMatchObject({
      channel: "telegram",
      sourceId: "telegram-source-1",
      recipients: [
        expect.objectContaining({
          chatId: "123456",
          birthday: "23.07.1992",
        }),
      ],
    });
  });

  function renderBirthdayImportNode() {
    return render(
      bulkRootElement({
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Birthdays",
          recipientSourceSummary: "Birthday upload",
          generationStatus: "idle",
          recipientAudienceSource:
            SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
          uploadedRecipients: [],
        },
      })
    );
  }

  const birthdayImportCounts = {
    total: 2,
    imported: 1,
    updated: 0,
    skippedMissingPhone: 0,
    skippedMissingChatId: 0,
    skippedIneligibleTelegramSubscriber: 0,
    skippedMissingBirthday: 0,
    skippedInvalidBirthday: 1,
  };

  it("preserves an unfinished timezone draft and commits it after validation", () => {
    renderBirthdayImportNode();
    const input = screen.getByLabelText(
      "bulkNodeBirthdayTimezone"
    ) as HTMLInputElement;
    mockUpdateNodeById.mockClear();
    fireEvent.change(input, { target: { value: "Asia/" } });
    expect(input.value).toBe("Asia/");
    expect(mockUpdateNodeById).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Asia/Almaty" } });
    fireEvent.blur(input);
    expect(mockUpdateNodeById).toHaveBeenCalledWith("bulk-1", {
      bulkRootConfig: expect.objectContaining({
        scheduleConfig: expect.objectContaining({ timezone: "Asia/Almaty" }),
      }),
    });
  });

  it("rejects an invalid timezone without silently changing the saved timezone", () => {
    renderBirthdayImportNode();
    const input = screen.getByLabelText(
      "bulkNodeBirthdayTimezone"
    ) as HTMLInputElement;
    const original = input.value;
    mockUpdateNodeById.mockClear();
    fireEvent.change(input, { target: { value: "Invalid/Zone" } });
    fireEvent.blur(input);
    expect(input.value).toBe(original);
    expect(mockUpdateNodeById).not.toHaveBeenCalled();
    expect(jest.requireMock("sonner").toast.error).toHaveBeenCalledWith(
      "birthdayScheduleInvalid"
    );
  });

  it("warns with saved and rejected birthday row counts", async () => {
    mockCsvUploadPayload = [
      { phone: "+77001234567", birthday: "17.04" },
      { phone: "+77007654321", birthday: "31.02" },
    ];
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ ok: true, ...birthdayImportCounts }),
        }) as Response
    );
    renderBirthdayImportNode();
    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));
    const { toast } = jest.requireMock("sonner");
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "bulkNodeBirthdayImportPartial"
      )
    );
    expect(mockTranslate).toHaveBeenCalledWith(
      "bulkNodeBirthdayImportPartial",
      { saved: 1, skipped: 1, total: 2 }
    );
    expect(toast.success).not.toHaveBeenCalledWith(
      "bulkNodeBirthdayImportDone"
    );
  });

  it("reports fully rejected birthday uploads without a success toast", async () => {
    mockCsvUploadPayload = [{ phone: "+77001234567", birthday: "31.02" }];
    global.fetch = jest.fn(
      async () =>
        ({
          ok: false,
          json: async () => ({
            error: "No valid birthdays",
            ...birthdayImportCounts,
            total: 1,
            imported: 0,
          }),
        }) as Response
    );
    renderBirthdayImportNode();
    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));
    const { toast } = jest.requireMock("sonner");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("bulkNodeBirthdayImportRejected")
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("serializes replacement birthday imports without dropping the latest upload", async () => {
    let resolveFirst!: (value: Response) => void;
    const requests: string[] = [];
    const success = {
      ok: true,
      json: async () => ({
        ok: true,
        ...birthdayImportCounts,
        total: 1,
        skippedInvalidBirthday: 0,
      }),
    } as Response;
    global.fetch = jest.fn((input, options) => {
      if (String(input) === "/api/campaigns/birthday-import") {
        requests.push(options?.body as string);
        return requests.length === 1
          ? new Promise<Response>(resolve => {
              resolveFirst = resolve;
            })
          : Promise.resolve(success);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });
    renderBirthdayImportNode();
    act(() =>
      mockCsvOnRecipientsLoaded?.([
        { phone: "+77001234567", birthday: "17.04" },
      ])
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() =>
      mockCsvOnRecipientsLoaded?.([
        { phone: "+77007654321", birthday: "18.04" },
      ])
    );
    expect(requests).toHaveLength(1);
    await act(async () => {
      resolveFirst(success);
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(JSON.parse(requests[1]).recipients).toEqual([
      { phone: "+77007654321", birthday: "18.04" },
    ]);
  });

  it("persists uploaded recipients on the node even when they exceed the daily send cap", () => {
    mockCsvUploadPayload = [
      { phone: "+77001234567", name: "Aibek", fields: { name: "Aibek" } },
      { phone: "+77007654321", name: "Dana", fields: { name: "Dana" } },
    ];
    mockCsvUploadEvidence = {
      originalFilename: "new-audience.csv",
      selectedAt: "2026-07-24T08:00:00.000Z",
    };

    render(
      bulkRootElement({
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Bulk campaign",
          recipientSourceSummary: "No generated recipients yet",
          generationStatus: "idle",
          audienceRevision: 7,
          audienceUploadEvidence: {
            originalFilename: "old-audience.csv",
            selectedAt: "2026-07-23T08:00:00.000Z",
          },
          recipientLimit: {
            maxRecipients: 1,
            rawLimit: "1",
            source: "cached_meta",
          },
        },
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));

    expect(mockUpdateNodeById).toHaveBeenCalledWith("bulk-1", {
      bulkRootConfig: expect.objectContaining({
        uploadedRecipients: [
          { phone: "+77001234567", name: "Aibek", fields: { name: "Aibek" } },
          { phone: "+77007654321", name: "Dana", fields: { name: "Dana" } },
        ],
        audienceRevision: 8,
        audienceUploadEvidence: {
          originalFilename: "new-audience.csv",
          selectedAt: "2026-07-24T08:00:00.000Z",
          replacementHistory: [
            {
              action: "replaced",
              replacedAt: "2026-07-24T08:00:00.000Z",
              previousFilename: "old-audience.csv",
              nextFilename: "new-audience.csv",
            },
          ],
        },
      }),
    });
  });

  it("attaches recipients using the hard cap instead of the daily send limit", async () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_throughput",
          throughputLevel: "STANDARD",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(bulkRoot({}, { uploaded: false }));

    await waitFor(() => {
      expect(screen.getByTestId("csv-upload-limit").textContent).toBe("50000");
    });
  });

  it("uses uploaded birthday rows as the birthday source instead of capping the file at the daily send limit", async () => {
    render(
      bulkRootElement({
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Birthday campaign",
          recipientSourceSummary: "No generated recipients yet",
          generationStatus: "idle",
          recipientAudienceSource:
            SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
          uploadedRecipients: [
            {
              phone: "+77001234567",
              name: "Aibek",
              fields: { birthday: "12.05" },
            },
          ],
          recipientLimit: {
            maxRecipients: 250,
            rawLimit: "250",
            source: "live_meta",
          },
        },
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId("csv-upload-limit").textContent).toBe("10000");
    });
    expect(screen.getByTestId("csv-upload-require-birthday").textContent).toBe(
      "true"
    );
    expect(
      screen.queryByRole("button", { name: "bulkNodeFromContacts" })
    ).toBeNull();
    expect(screen.getByText("bulkNodeBirthdaySelected")).toBeTruthy();
    expect(screen.getByText("bulkNodeBirthdayValidRows")).toBeTruthy();
    expect(screen.getByText("bulkNodeBirthdayToday")).toBeTruthy();
  });

  it("reduces the regular upload limit when an active birthday campaign protects today's capacity", async () => {
    (global.fetch as jest.Mock).mockImplementation(async request => {
      if (String(request).includes("/api/campaigns/birthday-protection")) {
        return {
          ok: true,
          json: async () => ({
            active: true,
            protectedTodayCount: 75,
            availableRecipientLimit: 175,
            dailyLimit: 250,
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      };
    });

    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_throughput",
          throughputLevel: "STANDARD",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(bulkRoot({}, { uploaded: false }));

    await waitFor(() => {
      expect(screen.getByText("bulkNodeBirthdayProtectedToday")).toBeTruthy();
      expect(screen.getByTestId("csv-upload-limit").textContent).toBe("50000");
    });
  });

  it("keeps send controls visible without the technical batch plan", () => {
    render(
      bulkRootElement({
        kind: "bulk",
        bulkRootConfig: {
          workflowKind: "bulk_campaign",
          sendMode: "immediate",
          channels: ["whatsapp"],
          campaignName: "Bulk campaign",
          recipientSourceSummary: "No generated recipients yet",
          generationStatus: "idle",
          batchPlan: {
            batchSize: 20,
            delayMs: 250,
            ratePerSecond: 80,
            rateSource: "meta_throughput",
            throughputLevel: "STANDARD",
          },
          recipientLimit: {
            maxRecipients: 250,
            rawLimit: "250",
            source: "live_meta",
          },
        },
      })
    );

    expect(screen.queryByText("bulkNodeBatchPlan")).toBeNull();
    expect(screen.queryByText("bulkNodeBatchPlanSummary")).toBeNull();
    expect(
      screen.getByRole("button", { name: "bulkNodeSendNow" })
    ).toBeTruthy();
  });

  it("lets the sender switch from send now to a scheduled date", async () => {
    mockCsvUploadPayload = [
      { phone: "+77001234567", name: "Aibek", fields: { name: "Aibek" } },
    ];

    render(bulkRoot({}, { uploaded: false }));

    fireEvent.click(screen.getByRole("button", { name: "mockCsvUpload" }));
    fireEvent.click(
      screen.getByRole("button", { name: /bulkNodeScheduleOption/i })
    );
    fireEvent.change(screen.getByLabelText("sendAt"), {
      target: { value: "2099-05-15T10:00" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /bulkNodeScheduleSend/i })
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/campaigns/bulk-send",
        expect.any(Object)
      );
    });
    const sendCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url]) => url === "/api/campaigns/bulk-send"
    );
    const body = JSON.parse(sendCall?.[1]?.body);
    expect(new Date(body.scheduledAt).getTime()).toBe(
      new Date("2099-05-15T10:00").getTime()
    );
  });

  it("displays a missing persisted policy as off on the shared control", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(bulkRoot());

    expect(
      screen.getByTestId("prior-failed-recipient-exclusion-control")
    ).toBeTruthy();
    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("writes the canonical enabled policy through the existing root update callback", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(bulkRoot());
    fireEvent.click(getPriorFailureSwitch());

    expect(mockUpdateNodeById).toHaveBeenCalledWith(
      "bulk-1",
      expect.objectContaining({
        bulkRootConfig: expect.objectContaining({
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: true,
          },
        }),
      })
    );
  });

  it("restores a persisted enabled policy when the node reopens", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(
      bulkRoot({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    expect(getPriorFailureSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("clears and persists a disabled policy when the last eligible WhatsApp template is removed", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    const { rerender } = render(
      bulkRoot({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );
    mockGraphIndex.bulkActionByRootId = new Map();
    rerender(
      bulkRoot({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    expect(mockUpdateNodeById).toHaveBeenCalledWith(
      "bulk-1",
      expect.objectContaining({
        bulkRootConfig: expect.objectContaining({
          recipientPolicy: {
            version: 1,
            excludePriorFailedBulkSends: false,
          },
        }),
      })
    );
    expect(
      screen.queryByTestId("prior-failed-recipient-exclusion-control")
    ).toBeNull();
  });

  it("normalizes a saved config once, however often the node's commands are rebuilt", () => {
    mockGraphIndex.bulkActionByRootId = new Map();
    const element = bulkRoot({
      recipientPolicy: { version: 1, excludePriorFailedBulkSends: true },
    });
    const { rerender } = render(element);
    // Each render enriches the node again, with new command functions.
    rerender(cloneElement(element));
    rerender(cloneElement(element));

    expect(mockUpdateNodeById).toHaveBeenCalledTimes(1);
  });

  it("does not serialize the uploaded recipients on every render", () => {
    const stringify = jest.spyOn(JSON, "stringify");
    try {
      const element = bulkRoot();
      const { rerender } = render(element);
      rerender(cloneElement(element));
      const uploadedRecipients =
        element.props.data.bulkRootConfig?.uploadedRecipients;

      expect(
        stringify.mock.calls.filter(([value]) => value === uploadedRecipients)
      ).toEqual([]);
    } finally {
      stringify.mockRestore();
    }
  });

  it("shows the saved recipients in its first render, before any effect", () => {
    // Server rendering runs no effect, so it shows the first render only.
    const html = renderToString(
      bulkRoot({
        scheduleConfig: {
          version: 2,
          mode: "once",
          timezone: "UTC",
          startAt: "2031-10-01T10:00:00.000Z",
        },
      })
    );

    expect(html).toContain("recipient.attachedCount");
    expect(html).not.toContain("Uploaded audience");
  });

  it("blocks run-now when the live plan is missing or an enabled preview is loading", async () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: null,
      error: undefined,
      isLoading: false,
    });
    global.fetch = jest.fn(() => new Promise(() => undefined)) as jest.Mock;

    render(
      bulkRoot({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    expect(screen.getByTestId("csv-upload-limit").textContent).toBe("50000");
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
      "bulkNodeLivePlanRequired"
    );
    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url]) => url === "/api/campaigns/bulk-send"
      )
    ).toBe(false);
  });

  it("explains why send stays disabled when no message action is connected", () => {
    mockGraphIndex.bulkActionByRootId = new Map();

    render(bulkRoot());

    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
      "bulkNodeSendRequiresAction"
    );
  });

  describe("when the recipient check fails", () => {
    const livePlan: BulkCampaignBatchPlanPreviewResponse = {
      configured: true,
      channel: "whatsapp",
      batchPlan: {
        batchSize: 20,
        delayMs: 250,
        ratePerSecond: 80,
        rateSource: "meta_throughput",
      },
      recipientLimit: {
        maxRecipients: 250,
        rawLimit: "250",
        source: "live_meta",
      },
      whatsappMeta: {
        sourceId: "source-1",
        phoneNumberId: "phone-1",
        detailsSource: "meta_phone_details",
      },
    };

    function mockEligibilityResponses(...responses: Array<Promise<unknown>>) {
      const eligibilityCalls: unknown[] = [];
      global.fetch = jest.fn((request: RequestInfo | URL) => {
        const url = String(request);
        if (url.includes("/api/campaigns/recipient-eligibility")) {
          eligibilityCalls.push(request);
          return (
            responses[eligibilityCalls.length - 1] ??
            new Promise(() => undefined)
          );
        }
        if (url.includes("/api/campaigns/birthday-protection")) {
          return new Promise(() => undefined);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }) as jest.Mock;
      return eligibilityCalls;
    }

    function failedCheck(body: Record<string, unknown>) {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({ state: "blocked", ...body }),
      });
    }

    beforeEach(() => {
      mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
        preview: livePlan,
        error: undefined,
        isLoading: false,
      });
    });

    it("keeps a plan restriction primary while a failed check waits to retry", async () => {
      mockCompanyLimits = {
        ...initialCompanyLimits,
        bulkRecipientExhausted: true,
        bulkRecipientCount: 125,
        bulkRecipientsRemaining: 0,
      };
      mockEligibilityResponses(
        failedCheck({
          error: { code: "meta_rate_limited" },
          retryAfterSeconds: 60,
        })
      );
      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230618", name: "Aibek" }],
        })
      );

      const failedCheckReason = await screen.findByText(
        "readiness.errors.meta_rate_limited"
      );
      const notice = screen.getByTestId("campaign-readiness");
      expect(notice.getAttribute("data-readiness-state")).toBe("plan_blocked");
      expect(notice.contains(failedCheckReason)).toBe(true);
      expect(screen.getAllByText("planRestriction.title")).toHaveLength(1);
      expect(screen.queryByText("readiness.rateLimited")).toBeNull();
      expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
      expect(
        (screen.getByRole("button", { name: "readiness.refresh" }) as HTMLButtonElement).disabled
      ).toBe(true);
      const send = screen.getByRole("button", { name: "sendUnavailable" }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(send.getAttribute("aria-describedby")).toBe(notice.id);
      fireEvent.click(send);
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([url]) => url === "/api/campaigns/bulk-send")
      ).toBe(false);
    });

    it("says WhatsApp is throttling and keeps Refresh disabled until the retry time", async () => {
      const eligibilityCalls = mockEligibilityResponses(
        failedCheck({
          error: { code: "meta_rate_limited" },
          retryAfterSeconds: 60,
        })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230601", name: "Aibek" }],
        })
      );

      expect(
        await screen.findByText("readiness.errors.meta_rate_limited")
      ).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "readiness.refresh",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: "bulkNodeSendNow",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      expect(eligibilityCalls).toHaveLength(1);
    });

    it("re-checks exactly once from Refresh and keeps the button while checking", async () => {
      const eligibilityCalls = mockEligibilityResponses(
        failedCheck({ error: { code: "template_lookup_unavailable" } })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230602", name: "Aibek" }],
        })
      );

      expect(
        await screen.findByText("readiness.errors.template_lookup_unavailable")
      ).toBeTruthy();
      const refresh = screen.getByRole("button", {
        name: "readiness.refresh",
      }) as HTMLButtonElement;
      expect(refresh.disabled).toBe(false);
      fireEvent.click(refresh);

      await waitFor(() =>
        expect(
          screen
            .getByTestId("campaign-readiness")
            .getAttribute("data-readiness-state")
        ).toBe("checking")
      );
      expect(
        (
          screen.getByRole("button", {
            name: "readiness.refresh",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      expect(eligibilityCalls).toHaveLength(2);
    });

    it("asks for a failed template catalog again from Refresh", async () => {
      mockHasLoadedWhatsAppTemplates = false;
      mockWhatsAppTemplatesError = { retryAt: null };
      const eligibilityCalls = mockEligibilityResponses(
        failedCheck({ error: { code: "template_lookup_unavailable" } })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230615", name: "Aibek" }],
        })
      );

      expect(
        await screen.findByText("readiness.errors.template_lookup_unavailable")
      ).toBeTruthy();
      // Once on mount, as before.
      expect(mockLoadWhatsAppTemplates).toHaveBeenCalledTimes(1);
      fireEvent.click(
        screen.getByRole("button", { name: "readiness.refresh" })
      );

      expect(mockLoadWhatsAppTemplates).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(eligibilityCalls).toHaveLength(2));
    });

    it("shows one retry time when both the check and the template catalog wait", async () => {
      const catalogRetryAt = new Date(Date.now() + 5 * 60_000).toISOString();
      mockHasLoadedWhatsAppTemplates = false;
      mockWhatsAppTemplatesError = { retryAt: catalogRetryAt };
      mockEligibilityResponses(
        failedCheck({
          error: { code: "meta_rate_limited" },
          retryAfterSeconds: 60,
        })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230616", name: "Aibek" }],
        })
      );

      expect(
        await screen.findByText("readiness.errors.meta_rate_limited")
      ).toBeTruthy();
      // The notice says when, once; the template line doesn't repeat it.
      expect(screen.getAllByText("readiness.cooldownUntil")).toHaveLength(1);
      expect(screen.getAllByText("templateCatalog.unavailable")).toHaveLength(
        1
      );
      // Send waits for the later of the two, the catalog's.
      const times = mockTranslate.mock.calls
        .filter(([key]) => key === "readiness.cooldownUntil")
        .map(call => ((call as unknown[])[1] as { time: string }).time);
      expect(times.at(-1)?.startsWith(`${catalogRetryAt} (`)).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: "readiness.refresh",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
    });

    it("explains the disabled Send next to the button", async () => {
      mockEligibilityResponses(
        failedCheck({
          error: { code: "meta_rate_limited" },
          retryAfterSeconds: 60,
        })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230603", name: "Aibek" }],
        })
      );

      await screen.findByText("readiness.errors.meta_rate_limited");
      const reason = screen.getByTestId("campaign-readiness");
      expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
      const send = screen.getByRole("button", {
        name: "bulkNodeSendNow",
      }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(send.getAttribute("aria-describedby")).toBe(reason.id);
      // The status and the button sit together, below the timing choice.
      const notice = screen.getByTestId("campaign-readiness");
      const timing = screen.getByText("bulkNodeSendTiming");
      expect(
        timing.compareDocumentPosition(notice) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        notice.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("offers one retry when the prior-failure filter is on", async () => {
      mockEligibilityResponses(
        failedCheck({ error: { code: "template_lookup_unavailable" } })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230604", name: "Aibek" }],
          recipientPolicy: { version: 1, excludePriorFailedBulkSends: true },
        })
      );

      expect(
        await screen.findByText("readiness.errors.template_lookup_unavailable")
      ).toBeTruthy();
      expect(
        screen.queryByText("priorFailedBulkSendsLookupUnavailable")
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "priorFailedBulkSendsRetry" })
      ).toBeNull();
      expect(
        screen.getAllByRole("button", { name: "readiness.refresh" })
      ).toHaveLength(1);
    });

    it("says there is no one to send to instead of ready when everyone is skipped", async () => {
      mockEligibilityResponses(
        Promise.resolve({
          ok: true,
          json: async () => ({
            state: "ready",
            evaluatedAt: "2026-10-05T12:00:00.000Z",
            requestedTotal: 1,
            acceptedTotal: 0,
            uniqueRecipients: { requested: 1, accepted: 0 },
            skippedByReason: { marketing_opt_out: 1 },
            warnings: { missingMarketingConsent: 0 },
            allExcluded: true,
            readiness: {
              state: "ready",
              checkedAt: "2026-10-05T12:00:00.000Z",
              remainingCapacity: null,
              reasons: [],
            },
          }),
        })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230605", name: "Aibek" }],
        })
      );

      await waitFor(() =>
        expect(
          screen
            .getByTestId("campaign-readiness")
            .getAttribute("data-readiness-state")
        ).toBe("noRecipients")
      );
      expect(screen.getByText("readiness.noRecipients")).toBeTruthy();
      expect(screen.queryByText("readiness.ready")).toBeNull();
      expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
      const send = screen.getByRole("button", { name: "bulkNodeSendNow" }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(send.getAttribute("aria-describedby")).toBe(screen.getByTestId("campaign-readiness").id);
      // The filter is off, so its "nothing left after filtering" line stays hidden.
      expect(screen.queryByText("priorFailedBulkSendsAllExcluded")).toBeNull();
    });

    it("doesn't call a passing check ready while the template catalog holds Send", async () => {
      mockHasLoadedWhatsAppTemplates = false;
      mockWhatsAppTemplatesError = {
        retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      mockEligibilityResponses(
        Promise.resolve({
          ok: true,
          json: async () => ({
            state: "ready",
            evaluatedAt: "2026-10-05T12:00:00.000Z",
            requestedTotal: 1,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 1, accepted: 1 },
            skippedByReason: {},
            warnings: { missingMarketingConsent: 0 },
            allExcluded: false,
            readiness: {
              state: "ready",
              checkedAt: "2026-10-05T12:00:00.000Z",
              remainingCapacity: null,
              reasons: [],
            },
          }),
        })
      );

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230617", name: "Aibek" }],
        })
      );

      await waitFor(() =>
        expect(
          screen
            .getByTestId("campaign-readiness")
            .getAttribute("data-readiness-state")
        ).toBe("blocked")
      );
      expect(screen.queryByText("readiness.ready")).toBeNull();
      expect(screen.getByTestId("campaign-readiness").textContent).toContain(
        "templateCatalog.unavailable"
      );
      expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
    });

    it("hides the stale check and locks the campaign name while a send is in flight", async () => {
      global.fetch = jest.fn((request: RequestInfo | URL) => {
        const url = String(request);
        if (url.includes("/api/campaigns/recipient-eligibility")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              state: "ready",
              evaluatedAt: "2026-10-05T12:00:00.000Z",
              requestedTotal: 1,
              acceptedTotal: 1,
              uniqueRecipients: { requested: 1, accepted: 1 },
              skippedByReason: {},
              warnings: { missingMarketingConsent: 0 },
              allExcluded: false,
              readiness: {
                state: "ready",
                checkedAt: "2026-10-05T12:00:00.000Z",
                remainingCapacity: null,
                reasons: [],
              },
            }),
          });
        }
        if (url === "/api/campaigns/bulk-send") {
          return new Promise(() => undefined);
        }
        if (url.includes("/api/campaigns/birthday-protection")) {
          return new Promise(() => undefined);
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }) as jest.Mock;

      render(
        bulkRoot({
          uploadedRecipients: [{ phone: "+77001230609", name: "Aibek" }],
        })
      );

      await waitFor(() =>
        expect(
          screen
            .getByTestId("campaign-readiness")
            .getAttribute("data-readiness-state")
        ).toBe("ready")
      );
      const refresh = () =>
        screen.getByRole("button", {
          name: "readiness.recheck",
        }) as HTMLButtonElement;
      const campaignName = () =>
        screen.getByLabelText("bulkNodeCampaignName") as HTMLInputElement;
      expect(refresh().disabled).toBe(false);
      expect(campaignName().disabled).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

      const sending = await screen.findByRole("button", { name: "bulkNodeSending" });
      expect(screen.queryByRole("button", { name: "readiness.refresh" })).toBeNull();
      expect(screen.queryByRole("button", { name: "readiness.recheck" })).toBeNull();
      expect(screen.queryByTestId("campaign-readiness")).toBeNull();
      expect(sending.getAttribute("aria-describedby")).toBeNull();
      expect(campaignName().disabled).toBe(true);
    });

    it("shows the filter's excluded count from the recipient check", async () => {
      mockEligibilityResponses(
        Promise.resolve({
          ok: true,
          json: async () => ({
            state: "ready",
            evaluatedAt: "2026-10-05T12:00:00.000Z",
            requestedTotal: 3,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 3, accepted: 1 },
            skippedByReason: { prior_failure: 2 },
            warnings: { missingMarketingConsent: 0 },
            allExcluded: false,
            readiness: {
              state: "ready",
              checkedAt: "2026-10-05T12:00:00.000Z",
              remainingCapacity: null,
              reasons: [],
            },
          }),
        })
      );

      render(
        bulkRoot({
          uploadedRecipients: [
            { phone: "+77001230606", name: "Aibek" },
            { phone: "+77001230607", name: "Dana" },
            { phone: "+77001230608", name: "Erlan" },
          ],
          recipientPolicy: { version: 1, excludePriorFailedBulkSends: true },
        })
      );

      expect(
        await screen.findByText("priorFailedBulkSendsExcludedInline")
      ).toBeTruthy();
      expect(mockTranslate).toHaveBeenCalledWith(
        "priorFailedBulkSendsExcludedInline",
        { count: 2 }
      );
      expect(mockTranslate).toHaveBeenCalledWith("recipientFiltersExcluded", {
        count: 2,
      });
    });
  });

  describe("when the WhatsApp number isn't resolved", () => {
    it("shows the check as running while the number loads", () => {
      mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
        preview: null,
        error: undefined,
        isLoading: true,
      });
      render(bulkRoot());

      expect(
        screen
          .getByTestId("campaign-readiness")
          .getAttribute("data-readiness-state")
      ).toBe("checking");
      expect(
        (
          screen.getByRole("button", {
            name: "bulkNodeSendNow",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
      expect(screen.getByText("readiness.checking")).toBeTruthy();
      expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
    });

    const recipientPolicies = [
      ["off", { version: 1 as const, excludePriorFailedBulkSends: false }],
      ["on", { version: 1 as const, excludePriorFailedBulkSends: true }],
    ] as const;

    it.each(recipientPolicies)(
      "blocks Send and says once that the number is not set up (prior-failure filter %s)",
      (_filter, recipientPolicy) => {
        mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
          preview: {
            configured: false,
            channel: "whatsapp",
            error: "WhatsApp credentials are incomplete for this workspace.",
          },
          error: undefined,
          isLoading: false,
        });
        render(bulkRoot({ recipientPolicy }));

        const notice = screen.getByTestId("campaign-readiness");
        expect(notice.getAttribute("data-readiness-state")).toBe("unavailable");
        // Retrying won't help, so the title doesn't ask for it.
        expect(screen.getByText("readiness.blocked")).toBeTruthy();
        expect(screen.getByText("readiness.errors.plan_unavailable")).toBeTruthy();
        const send = screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement;
        expect(send.disabled).toBe(true);
        expect(send.getAttribute("aria-describedby")).toBe(notice.id);
        expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
        expect(screen.queryByText("bulkNodeLivePlanRequired")).toBeNull();
        // The picker hides its own limit alert, so the node says uploads are off.
        expect(
          screen.getByText("bulkNodeRecipientLimitUnavailable")
        ).toBeTruthy();
        expect(
          screen.queryByText(
            "WhatsApp credentials are incomplete for this workspace."
          )
        ).toBeNull();
      }
    );

    it.each(recipientPolicies)(
      "calls a failed number lookup a failed check, not a missing number (prior-failure filter %s)",
      (_filter, recipientPolicy) => {
        // The hook reports a fetch failure as an unconfigured preview too.
        mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
          preview: {
            configured: false,
            channel: "whatsapp",
            error: "Unauthorized",
          },
          error: new Error("Unauthorized"),
          isLoading: false,
        });
        render(bulkRoot({ recipientPolicy }));

        expect(
          screen
            .getByTestId("campaign-readiness")
            .getAttribute("data-readiness-state")
        ).toBe("unavailable");
        expect(
          screen.getByText("readiness.unavailableDescription")
        ).toBeTruthy();
        expect(
          screen.queryByText("readiness.errors.plan_unavailable")
        ).toBeNull();
        expect(
          (
            screen.getByRole("button", {
              name: "bulkNodeSendNow",
            }) as HTMLButtonElement
          ).disabled
        ).toBe(true);
        expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
        expect(screen.getByRole("button", { name: "bulkNodeSendNow" }).getAttribute("aria-describedby")).toBe(
          screen.getByTestId("campaign-readiness").id
        );
        expect(screen.queryByText("Unauthorized")).toBeNull();
      }
    );
  });

  describe("with column-split routing", () => {
    const columnSplitRouting = {
      splitNodeId: "split-1",
      config: {
        version: 1,
        paths: [
          {
            id: "almaty",
            label: "Almaty",
            rules: [
              { id: "r1", column: "city", op: "equals", value: "Almaty" },
            ],
          },
        ],
      },
      routes: [
        {
          pathId: "almaty",
          handleId: "almaty",
          label: "Almaty",
          actionNodeId: "action-2",
          action: {
            nodeId: "action-2",
            actionType: "whatsapp_template",
            templateName: "vip_offer",
            templateLanguage: "en",
            templateCategory: "MARKETING",
            templateComponents: [{ type: "BODY", text: "Hi" }],
          },
        },
      ],
      elseRoute: {
        pathId: "else",
        handleId: "else",
        label: "Else",
        actionNodeId: null,
        action: null,
      },
    };
    const splitRecipients = [
      { phone: "+77001230611", name: "Aibek", fields: { city: "Almaty" } },
      { phone: "+77001230612", name: "Dana", fields: { city: "Almaty" } },
    ];

    beforeEach(() => {
      mockGraphIndex.bulkActionByRootId = new Map();
      mockGraphIndex.bulkColumnSplitRoutingByRootId = new Map([
        ["bulk-1", columnSplitRouting as never],
      ]);
    });

    it("blocks Send while its WhatsApp number isn't set up", () => {
      mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
        preview: {
          configured: false,
          channel: "whatsapp",
          error: "WhatsApp credentials are incomplete for this workspace.",
        },
        error: undefined,
        isLoading: false,
      });
      render(bulkRoot({ uploadedRecipients: splitRecipients }));

      expect(
        screen
          .getByTestId("campaign-readiness")
          .getAttribute("data-readiness-state")
      ).toBe("unavailable");
      expect(
        screen.getByText("readiness.errors.plan_unavailable")
      ).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "bulkNodeSendNow",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
    });

    it("doesn't ask for recipients that are already attached", () => {
      mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
        preview: {
          configured: true,
          channel: "whatsapp",
          whatsappMeta: {
            sourceId: "source-1",
            phoneNumberId: "phone-1",
            detailsSource: "meta_phone_details",
          },
        },
        error: undefined,
        isLoading: false,
      });
      render(bulkRoot({ uploadedRecipients: splitRecipients }));

      // A single-template recipient check can't run for split routes.
      expect(screen.queryByTestId("campaign-readiness")).toBeNull();
      expect(screen.queryByText("readiness.awaitingRecipients")).toBeNull();
    });

    function mockResolvedWhatsAppNumber() {
      mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
        preview: {
          configured: true,
          channel: "whatsapp",
          whatsappMeta: {
            sourceId: "source-1",
            phoneNumberId: "phone-1",
            detailsSource: "meta_phone_details",
          },
        },
        error: undefined,
        isLoading: false,
      });
    }

    // Before the catalog loads, or when it fails, every template is missing
    // from it, so the routing calls each one stale.
    function routeTemplatesMissingFromCatalog() {
      mockGraphIndex.bulkColumnSplitRoutingByRootId = new Map([
        [
          "bulk-1",
          {
            ...columnSplitRouting,
            routes: columnSplitRouting.routes.map(route => ({
              ...route,
              action: { ...route.action, templateSendBlockReason: "stale" },
            })),
          } as never,
        ],
      ]);
    }

    function expectSendDisabled() {
      expect(
        (
          screen.getByRole("button", {
            name: "bulkNodeSendNow",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true);
    }

    it("waits for the template catalog instead of calling route templates stale", () => {
      mockResolvedWhatsAppNumber();
      mockHasLoadedWhatsAppTemplates = false;
      routeTemplatesMissingFromCatalog();

      const element = bulkRoot({
        uploadedRecipients: splitRecipients,
      });
      const { rerender } = render(element);

      expect(screen.queryByText("columnSplitTemplateBlocked")).toBeNull();
      expect(screen.queryByText(/bulkNodeTemplateSendBlockedStale/)).toBeNull();
      expect(
        screen.getAllByText("bulkNodeTemplateSendBlockedLoading")
      ).toHaveLength(2);
      expectSendDisabled();
      // Nothing else loads the catalog for an unselected node.
      expect(mockLoadWhatsAppTemplates).toHaveBeenCalledTimes(1);

      // Once the catalog has loaded, a template it lacks is missing.
      mockHasLoadedWhatsAppTemplates = true;
      rerender(cloneElement(element));
      // The route summary and the line above Send both name it.
      expect(screen.getAllByText("columnSplitTemplateBlocked")).toHaveLength(2);
      expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
        "columnSplitTemplateBlocked"
      );
      expect(
        screen.getByText("Almaty: bulkNodeTemplateSendBlockedStale")
      ).toBeTruthy();
      expect(
        screen.queryByText("bulkNodeTemplateSendBlockedLoading")
      ).toBeNull();
      expectSendDisabled();
    });

    it("says the template catalog is limited instead of blocking route templates", () => {
      mockResolvedWhatsAppNumber();
      mockHasLoadedWhatsAppTemplates = false;
      mockWhatsAppTemplatesError = {
        retryAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      };
      routeTemplatesMissingFromCatalog();

      render(bulkRoot({ uploadedRecipients: splitRecipients }));

      // The route summary says when; the line above Send doesn't repeat it.
      expect(screen.queryByText("columnSplitTemplateBlocked")).toBeNull();
      expect(screen.queryByText(/bulkNodeTemplateSendBlockedStale/)).toBeNull();
      expect(
        screen.getAllByText(
          "templateCatalog.rateLimited readiness.cooldownUntil"
        )
      ).toHaveLength(1);
      expect(screen.getAllByText(/readiness\.cooldownUntil/)).toHaveLength(1);
      expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
        "templateCatalog.rateLimited"
      );
      expectSendDisabled();
    });

    it("names the split's own problem above Send instead of asking for an action", () => {
      mockResolvedWhatsAppNumber();
      mockGraphIndex.bulkColumnSplitRoutingByRootId = new Map([
        [
          "bulk-1",
          {
            ...columnSplitRouting,
            elseRoute: {
              ...columnSplitRouting.elseRoute,
              actionNodeId: "reply-1",
              connectsNonTemplateStep: true,
            },
          } as never,
        ],
      ]);

      render(bulkRoot({ uploadedRecipients: splitRecipients }));

      expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
        "bulkNodeUploadedRequiresTemplate"
      );
      expect(screen.queryByText("bulkNodeSendRequiresAction")).toBeNull();
      expectSendDisabled();
    });

    it("names a blocked template on a route no row takes", () => {
      mockResolvedWhatsAppNumber();
      mockGraphIndex.bulkColumnSplitRoutingByRootId = new Map([
        [
          "bulk-1",
          {
            ...columnSplitRouting,
            elseRoute: {
              ...columnSplitRouting.elseRoute,
              actionNodeId: "action-3",
              action: {
                nodeId: "action-3",
                actionType: "whatsapp_template",
                templateName: "fallback_offer",
                templateLanguage: "en",
                templateSendBlockReason: "rejected",
              },
            },
          } as never,
        ],
      ]);

      // Every row matches Almaty, so Else has none.
      render(bulkRoot({ uploadedRecipients: splitRecipients }));

      // The route summary and the line above Send both name it.
      expect(screen.getAllByText("columnSplitTemplateBlocked")).toHaveLength(2);
      expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
        "columnSplitTemplateBlocked"
      );
      expect(
        screen.getByText("Else: bulkNodeTemplateSendBlockedRejected")
      ).toBeTruthy();
      expectSendDisabled();
    });
  });

  it("asks for a file or contacts while the uploaded list is empty", () => {
    render(bulkRoot({ uploadedRecipients: [] }));

    expect(screen.getByText("readiness.awaitingRecipients")).toBeTruthy();
    expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
    expect(screen.getByRole("button", { name: "bulkNodeSendNow" }).getAttribute("aria-describedby")).toBe(
      screen.getByTestId("campaign-readiness").id
    );
    expect(screen.queryByText("bulkNodeRecipients")).toBeNull();
    expect(screen.queryByText("Uploaded audience")).toBeNull();
    expect(screen.queryByText("bulkNodeGeneratedRecipientMessages")).toBeNull();
    expect(screen.getByText("readiness.awaitingRecipients")).toBeTruthy();
  });

  it("shows the uploaded count once without a zero generated-messages line", () => {
    render(bulkRoot());

    // The picker's attached row (or file card) is the only count.
    expect(screen.getAllByText("recipient.attachedCount")).toHaveLength(1);
    expect(screen.queryByText("bulkNodeRecipients")).toBeNull();
    expect(screen.queryByText("bulkNodeGeneratedRecipientMessages")).toBeNull();
  });

  it("locks the audience and timing while a send is in flight", async () => {
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/campaigns/bulk-send")
        return new Promise(() => undefined);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }) as jest.Mock;
    render(bulkRoot());

    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));

    const sending = await screen.findByRole("button", {
      name: "bulkNodeSending",
    });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("csv-upload-disabled").textContent).toBe("true");
    expect(
      (
        screen
          .getByText("bulkNodeSendTiming")
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled
    ).toBe(true);
    expect(screen.queryByTestId("bulk-send-blocked-reason")).toBeNull();
  });

  it("hides the readiness notice while a send is running and names the status in words", () => {
    render(
      bulkRoot({
        sendStatus: {
          total: 1,
          queued: 1,
          sent: 0,
          skipped: 0,
          failed: 0,
          lifecycleStatus: "queued",
          audienceRevision: 1,
        },
      })
    );

    expect(screen.queryByTestId("campaign-readiness")).toBeNull();
    expect(screen.getByTestId("bulk-send-blocked-reason").textContent).toBe(
      "bulkNodeSendBlockedActiveDispatch"
    );
    expect(mockTranslate).toHaveBeenCalledWith("lifecycleStatus", {
      status: "queued",
    });
    expect(mockTranslate).toHaveBeenCalledWith("bulkNodeLifecycleStatus", {
      status: "lifecycleStatus",
    });
  });

  it("marks the selected segment of each choice for assistive tech", () => {
    render(bulkRoot());

    expect(
      screen
        .getByRole("button", { name: "bulkNodeSendNowOption" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "bulkNodeScheduleOption" })
        .getAttribute("aria-pressed")
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "bulkNodeRegularAudience" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "bulkNodeBirthdayAudience" })
        .getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("checks birthday protection once, with the live daily limit", () => {
    const protectionUrls = () =>
      (global.fetch as jest.Mock).mock.calls
        .map(([request]) => String(request))
        .filter(url => url.includes("/api/campaigns/birthday-protection"));
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: null,
      error: undefined,
      isLoading: true,
    });
    const { rerender } = render(bulkRoot());
    expect(protectionUrls()).toEqual([]);

    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "meta_throughput",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
        whatsappMeta: {
          sourceId: "source-1",
          phoneNumberId: "phone-1",
          detailsSource: "meta_phone_details",
        },
      },
      error: undefined,
      isLoading: false,
    });
    rerender(bulkRoot());

    expect(protectionUrls()).toHaveLength(1);
    expect(protectionUrls()[0]).toContain("dailyLimit=250");
  });

  it("associates the campaign name field with its visible label", () => {
    render(bulkRoot());

    expect(
      (screen.getByLabelText("bulkNodeCampaignName") as HTMLInputElement).value
    ).toBe("Bulk campaign");
  });

  it("lets recurring birthday save with deferred each-run copy", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(
      bulkRoot({
        recipientAudienceSource:
          SCENARIO_BULK_CUSTOMER_BIRTHDAYS_AUDIENCE_SOURCE,
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
        scheduleConfig: {
          version: 2,
          mode: "recurring",
          timezone: "UTC",
          recurrence: { kind: "daily", time: "09:00" },
        },
      })
    );

    expect(screen.queryByText("eligibilityEvaluatedEachRun")).toBeNull();
    expect(getPriorFailureSwitch()).toBeTruthy();
    expect(screen.getByText("eligibilityEvaluatedEachRun")).toBeTruthy();
  });

  it("states that fixed-schedule eligibility is frozen at admission", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });

    render(
      bulkRoot({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );
    fireEvent.click(
      screen.getByRole("button", { name: /bulkNodeScheduleOption/i })
    );

    expect(screen.queryByText("eligibilityFrozenAtAdmission")).toBeNull();
    expect(screen.getByLabelText("sendAt")).toBeTruthy();
    getPriorFailureSwitch();
    expect(screen.getByText("eligibilityFrozenAtAdmission")).toBeTruthy();
  });

  it("posts generated preview with scenarioId and revision only", async () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      if (url.includes("/bulk-recipient-eligibility")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            state: "ready",
            evaluatedAt: "2026-08-24T12:00:00.000Z",
            requestedTotal: 2,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 2, accepted: 1 },
            skippedByReason: { prior_failure: 1 },
            warnings: { missingMarketingConsent: 0 },
            allExcluded: false,
            readiness: {
              state: "ready",
              checkedAt: "2026-09-16T10:00:00.000Z",
              remainingCapacity: null,
              reasons: [],
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      });
    }) as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([request]) =>
          String(request).includes(
            "/api/scenarios/scenario-1/bulk-recipient-eligibility"
          )
        )
      ).toBe(true)
    );
    const previewCall = (global.fetch as jest.Mock).mock.calls.find(
      ([request]) => String(request).includes("/bulk-recipient-eligibility")
    );
    expect(JSON.parse(previewCall?.[1]?.body)).toEqual({
      workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
    });
  });

  it("disables generated run-now while an enabled identifier-only preview is loading or errored", async () => {
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      if (url.includes("/bulk-recipient-eligibility")) {
        return new Promise(() => undefined);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      });
    }) as jest.Mock;

    const { rerender } = render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-preview-loading",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    expect(mockUseBulkCampaignBatchPlanPreview).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      if (url.includes("/bulk-recipient-eligibility")) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({
            error: "Previous delivery failures could not be checked",
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      });
    }) as jest.Mock;

    rerender(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-preview-loading",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "bulkNodeSendNow",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(true)
    );
  });

  it("enables generated run-now after identifier-only preview is ready without a client live plan", async () => {
    global.fetch = jest.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.includes("/api/campaigns/birthday-protection")) {
        return new Promise(() => undefined);
      }
      if (url.includes("/bulk-recipient-eligibility")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            state: "ready",
            evaluatedAt: "2026-08-24T12:00:00.000Z",
            requestedTotal: 2,
            acceptedTotal: 1,
            uniqueRecipients: { requested: 2, accepted: 1 },
            skippedByReason: { prior_failure: 1 },
            warnings: { missingMarketingConsent: 0 },
            allExcluded: false,
            readiness: {
              state: "ready",
              checkedAt: "2026-09-16T10:00:00.000Z",
              remainingCapacity: null,
              reasons: [],
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ queued: true, total: 1 }),
      });
    }) as jest.Mock;

    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
      })
    );

    expect(mockUseBulkCampaignBatchPlanPreview).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(
      mockUseBulkCampaignBatchPlanPreview.mock.results.at(-1)?.value
    ).toEqual(expect.objectContaining({ preview: null }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "bulkNodeSendNow",
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
  });

  it("keeps generated run-now disabled until readiness is checked even with prior-failure policy off", () => {
    render(
      bulkRoot({
        generationStatus: "complete",
        generationJobId: "generation-job-1",
        generatedRecipientCount: 6,
        uploadedRecipients: [],
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: false,
        },
      })
    );

    expect(mockUseBulkCampaignBatchPlanPreview).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false })
    );
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("lets recurring save while the enabled preview stays deferred", () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 250,
          rawLimit: "250",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });
    global.fetch = jest.fn(() => new Promise(() => undefined)) as jest.Mock;

    render(
      bulkRoot({
        recipientPolicy: {
          version: 1,
          excludePriorFailedBulkSends: true,
        },
        scheduleConfig: {
          version: 2,
          mode: "recurring",
          timezone: "UTC",
          recurrence: { kind: "daily", time: "09:00" },
        },
      })
    );

    expect(screen.queryByText("eligibilityEvaluatedEachRun")).toBeNull();
    getPriorFailureSwitch();
    expect(screen.getByText("eligibilityEvaluatedEachRun")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "bulkNodeSendNow",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("asks to queue leftover recipients when the attached list exceeds the daily cap", async () => {
    mockUseBulkCampaignBatchPlanPreview.mockReturnValue({
      preview: {
        configured: true,
        channel: "whatsapp",
        batchPlan: {
          batchSize: 20,
          delayMs: 250,
          ratePerSecond: 80,
          rateSource: "live_meta",
        },
        recipientLimit: {
          maxRecipients: 1,
          rawLimit: "1",
          source: "live_meta",
        },
      },
      error: undefined,
      isLoading: false,
    });
    global.fetch = jest.fn(async (request: RequestInfo | URL) => {
      if (String(request).includes("/api/campaigns/birthday-protection")) {
        return {
          ok: true,
          json: async () => ({ active: false }),
        };
      }
      return {
        ok: true,
        json: async () => ({ queued: true, total: 2 }),
      };
    }) as jest.Mock;

    render(
      bulkRoot({
        uploadedRecipients: [
          { phone: "+77001234567", name: "Aibek" },
          { phone: "+77007654321", name: "Dana" },
        ],
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "bulkNodeSendNow" }));
    expect(await screen.findByText("overflowQueue.title")).toBeTruthy();
    expect(mockTranslate).toHaveBeenCalledWith(
      "overflowQueue.description",
      expect.objectContaining({
        recipientCount: 2,
        dailyLimit: 1,
        firstWaveCount: 1,
        queuedCount: 1,
      })
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.some(
        ([url]) => url === "/api/campaigns/bulk-send"
      )
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "overflowQueue.confirm" })
    );
    await waitFor(() => {
      expect(
        (global.fetch as jest.Mock).mock.calls.some(
          ([url]) => url === "/api/campaigns/bulk-send"
        )
      ).toBe(true);
    });
    const sendCall = (global.fetch as jest.Mock).mock.calls.find(
      ([url]) => url === "/api/campaigns/bulk-send"
    );
    expect(JSON.parse(sendCall?.[1]?.body).overflowQueueConfirmed).toBe(true);
  });

  describe("LazyBulkRootNode", () => {
    it("keeps the block's handles and width while its editor loads", async () => {
      const view = render(
        bulkRoot({}, { uploaded: false, Node: LazyBulkRootNode })
      );

      // The editor has not loaded yet: edges attach to the same handles.
      expect(screen.getByRole("status").textContent).toContain("loadingItems");
      const loadingCardClassName = (
        view.container.firstElementChild as HTMLElement
      ).className;
      const loadingHandles = describeHandles(view.container);
      expect(loadingHandles).toContainEqual({
        id: BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
        type: "source",
        position: "right",
      });

      // The cold editor module is large; under a busy test run its first
      // import can take longer than the default one second.
      expect(
        await screen.findByText("bulkNodeBadge", {}, { timeout: 10_000 })
      ).toBeTruthy();
      expect(screen.queryByText("loadingItems")).toBeNull();
      expect(describeHandles(view.container)).toEqual(loadingHandles);
      expect((view.container.firstElementChild as HTMLElement).className).toBe(
        loadingCardClassName
      );
    }, 15_000);
  });
});
