const mockConnectDB = jest.fn();
const mockConversationFindById = jest.fn();
const mockRealtimeTrigger = jest.fn();
const mockResolveAuthorizedWidgetSource = jest.fn();
const mockTriggerConversationResolved = jest.fn();
const mockTriggerCsatSubmitted = jest.fn();
const mockWidgetLoggerError = jest.fn();

jest.mock("@/lib/logger", () => ({
  widgetLogger: {
    error: (...args: unknown[]) => mockWidgetLoggerError(...args),
  },
}));
jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: {
    trigger: (...args: unknown[]) => mockRealtimeTrigger(...args),
  },
}));
jest.mock("@/lib/webhook-events", () => ({
  triggerConversationResolved: (...args: unknown[]) =>
    mockTriggerConversationResolved(...args),
  triggerCsatSubmitted: (...args: unknown[]) =>
    mockTriggerCsatSubmitted(...args),
}));
jest.mock("@/lib/widget/cors", () => ({
  handleCorsOptions: jest.fn(() => new Response(null, { status: 204 })),
  jsonWithCors: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
jest.mock("@/lib/widget/source-context", () => ({
  resolveAuthorizedWidgetSource: (...args: unknown[]) =>
    mockResolveAuthorizedWidgetSource(...args),
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...args: unknown[]) => mockConversationFindById(...args),
  },
}));

import {
  NON_READY_CLASSIFICATION_CASES,
  readyClassificationFields,
} from "@/lib/classifier/classified-conversation-test-utils";
import { POST } from "./route";

const NOW = new Date("2026-08-11T14:00:00.000Z");
const EXISTING_CLASSIFICATION = {
  category: "Support",
  priority: "medium",
  sentiment: "positive",
  summary: "Issue was resolved",
  action: "Ask for feedback",
  tags: ["resolved"],
  confidence: {
    category: 0.91,
    priority: 0.79,
    sentiment: 0.87,
  },
};

function buildConversation() {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    channel: "web_widget",
    status: "in_progress",
    awaiting_csat: true,
    customer_satisfaction_score: null as number | null,
    customer_satisfaction_comment: undefined as string | undefined,
    user: "customer-1",
    createdAt: new Date("2026-08-11T13:00:00.000Z"),
    updatedAt: new Date("2026-08-11T13:30:00.000Z"),
    ...readyClassificationFields(15),
    classification: {
      ...EXISTING_CLASSIFICATION,
      tags: [...EXISTING_CLASSIFICATION.tags],
      confidence: { ...EXISTING_CLASSIFICATION.confidence },
    },
    save: jest.fn().mockResolvedValue(undefined),
  };
}

const NON_CURRENT_CLASSIFICATION_CASES: ReadonlyArray<{
  name: string;
  mutate: (conversation: ReturnType<typeof buildConversation>) => void;
}> = [
  ...NON_READY_CLASSIFICATION_CASES,
  {
    name: "revision mismatch",
    mutate: conversation => {
      conversation.classification_meta.source_revision = 14;
    },
  },
  {
    name: "blank analysis id",
    mutate: conversation => {
      conversation.classification_meta.analysis_revision_id = "";
    },
  },
  {
    name: "partial root",
    mutate: conversation => {
      delete (conversation as Partial<typeof conversation>)
        .classification_state;
    },
  },
];

async function submitCsat(conversation: ReturnType<typeof buildConversation>) {
  mockConversationFindById.mockResolvedValue(conversation);
  const request = new Request(
    "http://localhost/api/widget/conversations/conversation-1/csat",
    {
      method: "POST",
      body: JSON.stringify({
        score: 5,
        comment: "Great support",
        client_key: "key-1",
      }),
    }
  );

  const response = await POST(request as Parameters<typeof POST>[0], {
    params: Promise.resolve({ id: "conversation-1" }),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ success: true });
}

describe("widget CSAT route classification freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockConnectDB.mockResolvedValue(undefined);
    mockResolveAuthorizedWidgetSource.mockResolvedValue({
      ok: true,
      source: { workspace_id: "workspace-1" },
    });
    mockTriggerConversationResolved.mockResolvedValue(undefined);
    mockTriggerCsatSubmitted.mockResolvedValue(undefined);
    mockRealtimeTrigger.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps the complete classification and resolved payload for an exact current-ready root", async () => {
    const conversation = buildConversation();
    await submitCsat(conversation);

    expect(conversation.save).toHaveBeenCalledTimes(1);
    expect(mockTriggerConversationResolved).toHaveBeenCalledWith(
      "workspace-1",
      {
        conversation_id: "conversation-1",
        status: "closed",
        previous_status: "in_progress",
        channel: "web_widget",
        customer_phone: "customer-1",
        classification: EXISTING_CLASSIFICATION,
        resolution_kind: "customer_csat",
        resolution_time_seconds: undefined,
        created_at: "2026-08-11T13:00:00.000Z",
        updated_at: NOW.toISOString(),
      }
    );
    expect(mockTriggerCsatSubmitted).toHaveBeenCalledWith("workspace-1", {
      conversation_id: "conversation-1",
      score: 5,
      channel: "web_widget",
      submitted_at: NOW.toISOString(),
    });
    expect(mockRealtimeTrigger).toHaveBeenCalledWith(
      "private-conversation-conversation-1",
      "conversation-updated",
      {
        workspaceId: "workspace-1",
        status: "closed",
        awaiting_csat: false,
        customer_satisfaction_score: 5,
      }
    );
  });

  it.each(NON_CURRENT_CLASSIFICATION_CASES)(
    "omits the classification own property for a $name resolved root",
    async ({ mutate }) => {
      const conversation = buildConversation();
      mutate(conversation);

      await submitCsat(conversation);

      const payload = mockTriggerConversationResolved.mock.calls[0]?.[1];
      expect(payload).toEqual({
        conversation_id: "conversation-1",
        status: "closed",
        previous_status: "in_progress",
        channel: "web_widget",
        customer_phone: "customer-1",
        resolution_kind: "customer_csat",
        resolution_time_seconds: undefined,
        created_at: "2026-08-11T13:00:00.000Z",
        updated_at: NOW.toISOString(),
      });
      expect(Object.hasOwn(payload, "classification")).toBe(false);
    }
  );

  it("reports measured customer-rated service time in whole seconds", async () => {
    const conversation = buildConversation();
    // The model hook stamps service truth on save; mirror it for the route.
    conversation.save.mockImplementation(async () => {
      Object.assign(conversation, {
        service_episode_started_at: new Date(NOW.getTime() - 42_400),
        service_resolved_at: NOW,
        service_resolution_kind: "customer_csat",
      });
    });

    await submitCsat(conversation);

    expect(mockTriggerConversationResolved.mock.calls[0]?.[1]).toMatchObject({
      resolution_kind: "customer_csat",
      resolution_time_seconds: 42,
    });
  });

  it("a late rating on a timeout-closed chat sends no second resolved event", async () => {
    // State left by the 24 h CSAT timeout close, which already sent
    // conversation.resolved with resolution_kind "timeout".
    const conversation = Object.assign(buildConversation(), {
      status: "closed",
      awaiting_csat: false,
      csat_timeout_closed: true,
      service_resolution_kind: "timeout",
    });

    await submitCsat(conversation);

    expect(conversation.save).toHaveBeenCalledTimes(1);
    expect(conversation.customer_satisfaction_score).toBe(5);
    expect(conversation.customer_satisfaction_comment).toBe("Great support");
    expect(conversation.status).toBe("closed");
    expect(conversation.csat_timeout_closed).toBe(true);
    expect(conversation.service_resolution_kind).toBe("timeout");
    expect(
      (conversation as { $locals?: Record<string, unknown> }).$locals
        ?.serviceResolutionKind
    ).toBeUndefined();
    expect(mockTriggerConversationResolved).not.toHaveBeenCalled();
    expect(mockTriggerCsatSubmitted).toHaveBeenCalledTimes(1);
    expect(mockTriggerCsatSubmitted).toHaveBeenCalledWith("workspace-1", {
      conversation_id: "conversation-1",
      score: 5,
      channel: "web_widget",
      submitted_at: NOW.toISOString(),
    });
  });

  it("does not await the best-effort resolved webhook", async () => {
    mockTriggerConversationResolved.mockReturnValue(
      new Promise<never>(() => undefined)
    );

    await expect(submitCsat(buildConversation())).resolves.toBeUndefined();
  });
});
