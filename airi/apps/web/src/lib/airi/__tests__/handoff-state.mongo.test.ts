jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/customers/service", () => ({
  syncCustomerForConversation: jest.fn(),
}));
jest.mock("@/lib/limits/company-usage-events", () => ({
  emitWorkspaceUsageDeltaBestEffort: jest.fn(),
}));
jest.mock("@/lib/airi/reply/runtime/human-outbound", () => ({
  hasHumanOutboundSince: jest.fn(async () => false),
}));
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { Conversation } from "@/models/conversation";
import {
  activateManualHandoff,
  maybeAutoResumeScenarioHandoff,
} from "@/lib/airi/reply/runtime/handoff-state";

// Opt-in, disposable local database only. Never inherit a production Mongo URI.
const uri = process.env.AIRICHAT_ANALYTICS_QA_MONGODB_URI;
const local = uri ? new URL(uri) : null;
if (
  local &&
  (local.hostname !== "127.0.0.1" ||
    !local.pathname.startsWith("/airi_analytics_qa_"))
)
  throw new Error("Handoff regression requires a disposable local QA database");
const workspaceId = `qa-handoff-race-${randomUUID()}`;

type LeanConversation = {
  status: string;
  airi_handoff_active?: boolean;
  airi_bot_enabled?: boolean;
  service_lifecycle_revision?: number;
};

// Lands a write between a query hook's pre-read and its fenced update, which is
// exactly the window where two lifecycle writes collide.
function interleaveAfterFirstPreRead(write: () => Promise<unknown>) {
  const findOne = Conversation.findOne.bind(Conversation) as (
    ...args: unknown[]
  ) => mongoose.Query<unknown, unknown>;
  let pending = true;
  return jest.spyOn(Conversation, "findOne").mockImplementation(((
    ...args: unknown[]
  ) => {
    const query = findOne(...args);
    if (!pending) return query;
    pending = false;
    const exec = query.exec.bind(query);
    query.exec = async () => {
      const result = await exec();
      await write();
      return result;
    };
    return query;
  }) as never);
}

(uri ? describe : describe.skip)("handoff writes against actual Mongo", () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, {
      autoIndex: false,
      serverSelectionTimeoutMS: 3000,
    });
    await Conversation.createCollection();
  }, 30000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Conversation.collection.deleteMany({ workspaceId });
    await mongoose.disconnect();
  });

  test("a manager handoff racing a reopen is retried and ends handed off", async () => {
    const created = await Conversation.create({
      workspaceId,
      channel: "whatsapp",
      status: "open",
      first_inbound_at: new Date(Date.now() - 60000),
    });
    const closing = await Conversation.findById(created._id);
    closing.status = "closed";
    closing.$locals.serviceResolutionKind = "manager";
    await closing.save();
    const closed = await Conversation.findById(created._id)
      .select("service_lifecycle_revision")
      .lean<LeanConversation>();

    const findOne = interleaveAfterFirstPreRead(() =>
      Conversation.updateOne({ _id: created._id }, { $set: { status: "open" } })
    );
    await expect(
      activateManualHandoff({ conversationId: String(created._id) })
    ).resolves.toBeUndefined();

    // First attempt read the closed state, lost the fence to the reopen,
    // then re-read and applied the handoff on top of it.
    expect(findOne.mock.calls.length).toBeGreaterThanOrEqual(3);
    const final = await Conversation.findById(created._id)
      .select(
        "status airi_handoff_active airi_bot_enabled service_lifecycle_revision"
      )
      .lean<LeanConversation>();
    expect(final).toMatchObject({
      status: "in_progress",
      airi_handoff_active: true,
      airi_bot_enabled: false,
      service_lifecycle_revision: (closed?.service_lifecycle_revision ?? 0) + 2,
    });
  });

  test("a scenario auto-resume racing a manager takeover keeps the manager's handoff", async () => {
    const startedAt = new Date(Date.now() - 60000);
    const created = await Conversation.create({
      workspaceId,
      channel: "whatsapp",
      status: "in_progress",
      airi_bot_enabled: false,
      airi_handoff_active: true,
      airi_handoff_source: "scenario_contains",
      airi_handoff_started_at: startedAt,
      first_inbound_at: startedAt,
    });

    interleaveAfterFirstPreRead(() =>
      activateManualHandoff({ conversationId: String(created._id) })
    );
    const result = await maybeAutoResumeScenarioHandoff({
      conversationId: String(created._id),
      snapshot: {
        airi_handoff_active: true,
        airi_handoff_source: "scenario_contains",
        airi_handoff_started_at: startedAt,
      },
      inboundAt: new Date(),
      hasSubstantiveInbound: true,
    });

    expect(result).toEqual({ resumed: false, blockedByHumanReply: false });
    const final = await Conversation.findById(created._id)
      .select("status airi_handoff_active airi_handoff_source airi_bot_enabled")
      .lean<LeanConversation & { airi_handoff_source?: string }>();
    expect(final).toMatchObject({
      status: "in_progress",
      airi_handoff_active: true,
      airi_handoff_source: "manual",
      airi_bot_enabled: false,
    });
  });
});
