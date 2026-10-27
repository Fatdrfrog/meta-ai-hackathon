const mockConversationFindOne = jest.fn();
const mockTriggerConversationReopened = jest.fn();

jest.mock("@/lib/airi/workspace-bot-default", () => ({
  getWorkspaceBotDefault: jest.fn(async () => true),
  getWorkspaceCoachDefault: jest.fn(async () => true),
  getWorkspaceScenariosDefault: jest.fn(async () => true),
}));
jest.mock("@/lib/cache", () => ({
  invalidateConversationCache: jest.fn(),
  invalidateRequestsForWorkspace: jest.fn(),
}));
jest.mock("@/lib/conversation-messages", () => ({
  appendMessageToConversationById: jest.fn(),
}));
jest.mock("@/lib/limits/company-limits", () => ({
  COMPANY_CONVERSATION_LIMIT_EXCEEDED_CODE:
    "company_conversation_limit_exceeded",
  ensureCompanyConversationCapacity: jest.fn(async () => ({ allowed: true })),
}));
jest.mock("@/lib/media/conversation-media-analysis-jobs", () => ({
  enqueueConversationMediaAnalysis: jest.fn(),
}));
jest.mock("@/lib/realtime/server", () => ({
  realtime: { trigger: jest.fn() },
}));
jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/telegram", () => ({}));
jest.mock("@/models/chat", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findOne: (...args: unknown[]) => mockConversationFindOne(...args),
  },
}));
jest.mock("@/models/message", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/user", () => ({ __esModule: true, default: {} }));
jest.mock("./handleBusinessConnectionUpdate", () => ({
  linkBusinessConnectionToSource: jest.fn(),
}));
jest.mock("@/lib/webhook-events", () => ({
  triggerConversationReopened: (...args: unknown[]) =>
    mockTriggerConversationReopened(...args),
}));

import {
  NON_READY_CLASSIFICATION_CASES,
  readyClassificationFields,
} from "@/lib/classifier/classified-conversation-test-utils";
import { ensureConversation } from "./helpers";

const EXISTING_CLASSIFICATION = {
  category: "Sales",
  priority: "medium",
  sentiment: "positive",
  summary: "Customer asked about pricing",
  action: "Send quote",
  tags: ["lead"],
  confidence: {
    category: 0.92,
    priority: 0.78,
    sentiment: 0.85,
  },
};

function buildClosedConversation() {
  return {
    _id: "conversation-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    channel: "telegram",
    status: "closed",
    user: "customer-1",
    createdAt: new Date("2026-08-09T10:00:00.000Z"),
    ...readyClassificationFields(9),
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
  mutate: (conversation: ReturnType<typeof buildClosedConversation>) => void;
}> = [
  ...NON_READY_CLASSIFICATION_CASES,
  {
    name: "revision mismatch",
    mutate: conversation => {
      conversation.classification_meta.source_revision = 8;
    },
  },
  {
    name: "blank analysis id",
    mutate: conversation => {
      conversation.classification_meta.analysis_revision_id = " ";
    },
  },
  {
    name: "partial root",
    mutate: conversation => {
      delete (conversation as Partial<typeof conversation>).classification_meta;
    },
  },
];

async function reopenConversation(
  conversation: ReturnType<typeof buildClosedConversation>
) {
  mockConversationFindOne.mockResolvedValue(conversation);
  return ensureConversation(
    { _id: "chat-1" } as Parameters<typeof ensureConversation>[0],
    12345,
    "workspace-1",
    "source-1"
  );
}

describe("Telegram ensureConversation classification freshness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTriggerConversationReopened.mockResolvedValue(undefined);
  });

  it("keeps the complete classification for an exact current-ready reopen", async () => {
    const conversation = buildClosedConversation();

    await expect(reopenConversation(conversation)).resolves.toEqual({
      conversation,
      isNew: false,
    });

    expect(conversation.status).toBe("open");
    expect(mockTriggerConversationReopened.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        conversation_id: "conversation-1",
        status: "open",
        previous_status: "closed",
        channel: "telegram",
        customer_phone: "customer-1",
        classification: EXISTING_CLASSIFICATION,
        created_at: "2026-08-09T10:00:00.000Z",
      })
    );
  });

  it.each(NON_CURRENT_CLASSIFICATION_CASES)(
    "omits the classification own property for a $name reopen root",
    async ({ mutate }) => {
      const conversation = buildClosedConversation();
      mutate(conversation);

      await reopenConversation(conversation);

      const payload = mockTriggerConversationReopened.mock.calls[0]?.[1];
      expect(payload).toEqual(
        expect.objectContaining({
          conversation_id: "conversation-1",
          status: "open",
          previous_status: "closed",
          channel: "telegram",
          customer_phone: "customer-1",
          created_at: "2026-08-09T10:00:00.000Z",
        })
      );
      expect(Object.hasOwn(payload, "classification")).toBe(false);
    }
  );

  it("does not await the best-effort reopened webhook", async () => {
    mockTriggerConversationReopened.mockReturnValue(
      new Promise<never>(() => undefined)
    );

    await expect(
      reopenConversation(buildClosedConversation())
    ).resolves.toEqual(expect.objectContaining({ isNew: false }));
  });
});
