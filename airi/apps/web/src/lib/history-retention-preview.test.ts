import { buildHistoryRetentionPreview } from "./history-retention-preview";

const now = new Date("2026-10-10T00:00:00Z");
const old = new Date("2025-01-01T00:00:00Z");
const conversation = {
  _id: "conversation-1",
  workspaceId: "workspace-1",
  status: "closed",
  updatedAt: old,
  lastMessageAt: old,
  service_closed_at: old,
};
const message = {
  _id: "message-1",
  workspaceId: "workspace-1",
  conversation: "conversation-1",
  date: old,
  fileSize: 100,
};

it("includes old closed history and labels bytes as an estimate, without authorizing deletion", () => {
  const result = buildHistoryRetentionPreview({
    companyId: "company-1",
    workspaceId: "workspace-1",
    retentionDays: 180,
    now,
    conversations: [
      { conversation, messages: [message], messagesComplete: true },
    ],
  });
  expect(result.candidates).toEqual([
    {
      conversationId: "conversation-1",
      messageIds: ["message-1"],
      messageCount: 1,
      declaredMediaBytes: 100,
    },
  ]);
  expect(result.deletionAuthorized).toBe(false);
});

it.each([
  { status: "open" },
  { lastMessageAt: now },
  { updatedAt: now },
  { airi_scenario_state: { scenarioId: "scenario-1" } },
  { airi_pending_generative_execution: { executionId: "run-1" } },
  { classification_state: { status: "processing" } },
  { workspaceId: "another-workspace" },
])("excludes active, incomplete or foreign history: %j", patch => {
  const result = buildHistoryRetentionPreview({
    companyId: "company-1",
    workspaceId: "workspace-1",
    retentionDays: 180,
    now,
    conversations: [
      {
        conversation: { ...conversation, ...patch },
        messages: [message],
        messagesComplete: true,
      },
    ],
  });
  expect(result.candidates).toEqual([]);
});

it.each([
  { mediaAnalysis: { status: "submitted" } },
  { mediaAnalysis: { status: "failed" } },
  { rawSourcePayload: { payload: { message: { type: "unsupported" } } } },
  {
    rawSourcePayload: {
      payload: {
        entry: { changes: [{ value: { messages: [{ type: "errors" }] } }] },
      },
    },
  },
  { temporalDispatch: { state: "outcome_unknown" } },
  { date: now },
  { workspaceId: "another-workspace" },
])(
  "excludes a conversation containing pending recovery or recent messages: %j",
  patch => {
    const result = buildHistoryRetentionPreview({
      companyId: "company-1",
      workspaceId: "workspace-1",
      retentionDays: 180,
      now,
      conversations: [
        {
          conversation,
          messages: [{ ...message, ...patch }],
          messagesComplete: true,
        },
      ],
    });
    expect(result.candidates).toEqual([]);
  }
);

it.each(["ready", "not_applicable"])(
  "accepts terminal classification status %s",
  status => {
    const result = buildHistoryRetentionPreview({
      companyId: "company-1",
      workspaceId: "workspace-1",
      retentionDays: 180,
      now,
      conversations: [
        {
          conversation: { ...conversation, classification_state: { status } },
          messages: [message],
          messagesComplete: true,
        },
      ],
    });
    expect(result.candidates).toHaveLength(1);
  }
);

it("never treats a truncated message page as an eligible complete export", () => {
  const result = buildHistoryRetentionPreview({
    companyId: "company-1",
    workspaceId: "workspace-1",
    retentionDays: 180,
    now,
    conversations: [
      { conversation, messages: [message], messagesComplete: false },
    ],
  });
  expect(result.candidates).toEqual([]);
  expect(result.excluded[0].reason).toBe("message_page_incomplete");
});
