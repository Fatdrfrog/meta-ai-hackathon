const mockPublishWake = jest.fn();
const mockReconcileStaleEffects = jest.fn();

jest.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => null }));
jest.mock("@/lib/mongo", () => ({ ensureIndexes: async () => undefined }));
jest.mock("@/lib/classifier/classification-pubsub", () => ({
  publishConversationClassificationWake: (...args: unknown[]) =>
    mockPublishWake(...args),
}));
jest.mock("@/lib/classifier/conversation-classification-store", () => ({
  ...jest.requireActual("@/lib/classifier/conversation-classification-store"),
  reconcileSupersededConversationAnalysisEffects: (...args: unknown[]) =>
    mockReconcileStaleEffects(...args),
}));

import mongoose from "mongoose";

import { ConversationAnalysisRevision } from "@/models/conversation-analysis-revision";
import { Conversation } from "@/models/conversation";
import { GET } from "@/app/api/cron/classify/route";

const mongoUri = process.env.CLASSIFICATION_CONTRACT_TEST_MONGODB_URI;
const describeMongo = mongoUri ? describe : describe.skip;

const ENABLE_ENV = "CONVERSATION_CLASSIFICATION_RECONCILIATION_ENABLED";
const T0 = new Date("2026-08-10T06:00:00.000Z");

async function reconcile() {
  const response = await GET(new Request("http://localhost/api/cron/classify"));
  return { status: response.status, body: await response.json() };
}

// Real MongoDB projections: these rows store `lease: null`, as production does.
describeMongo("classification reconciliation against MongoDB", () => {
  const originalEnable = process.env[ENABLE_ENV];

  beforeAll(async () => {
    await mongoose.connect(mongoUri as string, {
      serverSelectionTimeoutMS: 5000,
    });
  });

  beforeEach(async () => {
    process.env[ENABLE_ENV] = "true";
    mockPublishWake.mockReset();
    mockReconcileStaleEffects.mockReset();
    await Promise.all([
      Conversation.createIndexes(),
      ConversationAnalysisRevision.createIndexes(),
    ]);
  });

  afterEach(async () => {
    await mongoose.connection.db?.dropDatabase();
  });

  afterAll(async () => {
    if (originalEnable === undefined) delete process.env[ENABLE_ENV];
    else process.env[ENABLE_ENV] = originalEnable;
    await mongoose.disconnect();
  });

  it("publishes a due pending classification whose lease is null", async () => {
    const _id = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({
      _id,
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      messages: [],
      classification_revision: 3,
      is_classified: false,
      classification_state: {
        contractVersion: 2,
        status: "pending",
        requestedRevision: 3,
        processingRevision: null,
        appliedRevision: null,
        generation: 3,
        attemptRevision: 3,
        attemptCount: 0,
        fence: 0,
        requestedAt: T0,
        nextAttemptAt: T0,
        lastEnqueuedAt: null,
        completedAt: null,
        lease: null,
        error: null,
        review: null,
        blocked: null,
      },
      createdAt: T0,
      updatedAt: T0,
    });
    mockPublishWake.mockResolvedValue({
      status: "published_marked",
      eventId: "event-1",
      messageId: "message-1",
    });

    await expect(reconcile()).resolves.toMatchObject({
      status: 200,
      body: { status: "ok", attempted: 1, transportPublished: 1 },
    });
    expect(mockPublishWake).toHaveBeenCalledWith({
      conversationId: String(_id),
      requestedRevision: 3,
      generation: 3,
      requestedAt: T0,
      marker: { kind: "classification" },
    });
  });

  it("publishes due pending rows even when a full batch of blocked rows is due", async () => {
    const dueRow = (status: "pending" | "blocked", nextAttemptAt: Date) => ({
      _id: new mongoose.Types.ObjectId(),
      workspaceId: "workspace-integration",
      channel: "whatsapp",
      messages: [],
      classification_revision: 1,
      is_classified: false,
      classification_state: {
        contractVersion: 2,
        status,
        requestedRevision: 1,
        processingRevision: null,
        appliedRevision: null,
        generation: 1,
        attemptRevision: 1,
        attemptCount: 0,
        fence: 0,
        requestedAt: T0,
        nextAttemptAt,
        lastEnqueuedAt: null,
        completedAt: null,
        lease: null,
        error: null,
        review: null,
        blocked:
          status === "blocked"
            ? { code: "company_classification_limit_exceeded" }
            : null,
      },
      createdAt: T0,
      updatedAt: T0,
    });
    // Blocked plan-limit rechecks keep coming due and sort before pending rows.
    const blocked = Array.from({ length: 101 }, () => dueRow("blocked", T0));
    const pending = dueRow("pending", T0);
    await Conversation.collection.insertMany([...blocked, pending]);
    mockPublishWake.mockResolvedValue({
      status: "published_marked",
      eventId: "event",
      messageId: "message",
    });

    await expect(reconcile()).resolves.toMatchObject({
      status: 200,
      body: { status: "ok" },
    });
    expect(mockPublishWake).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: String(pending._id) })
    );
  });

  it("reconciles due analysis effects whose lease is null", async () => {
    await ConversationAnalysisRevision.collection.insertOne({
      _id: "analysis-integration-1",
      conversationId: new mongoose.Types.ObjectId(),
      sourceRevision: 1,
      completedAt: T0,
      effects: {
        status: "pending",
        fence: 0,
        nextAttemptAt: T0,
        lease: null,
      },
    } as never);
    mockReconcileStaleEffects.mockResolvedValue("superseded");

    await expect(reconcile()).resolves.toMatchObject({
      status: 200,
      body: { status: "ok", staleEffects: { superseded: 1 } },
    });
    expect(mockReconcileStaleEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisRevisionId: "analysis-integration-1",
        observed: { status: "pending", nextAttemptAt: T0, fence: 0 },
      })
    );
  });
});
