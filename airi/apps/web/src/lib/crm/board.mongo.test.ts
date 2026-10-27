jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/lib/customers/service", () => ({
  recordCustomerEvent: jest.fn(),
}));
jest.mock("./board-realtime", () => ({ notifyCrmBoardChanged: jest.fn() }));
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import Customer from "@/models/customer";
import CustomerEvent from "@/models/customer-event";
import { loadStageEnteredAtByCustomer, moveCustomerToCrmStage } from "./board";

// Opt-in, disposable local database only. Never inherit a production Mongo URI.
const uri = process.env.AIRICHAT_ANALYTICS_QA_MONGODB_URI;
const local = uri ? new URL(uri) : null;
if (
  local &&
  (local.hostname !== "127.0.0.1" ||
    !local.pathname.startsWith("/airi_analytics_qa_"))
)
  throw new Error(
    "CRM board regression requires a disposable local QA database"
  );
const workspaceId = `qa-crm-stage-age-${randomUUID()}`;

// No persisted pipeline: the board falls back to the default stages.
const supabase = {
  from: () => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return query;
  },
};

(uri ? describe : describe.skip)(
  "CRM board stage age against actual Mongo",
  () => {
    beforeAll(async () => {
      await mongoose.connect(uri!, {
        autoIndex: false,
        serverSelectionTimeoutMS: 3000,
      });
      await Promise.all([
        Customer.createCollection(),
        CustomerEvent.createCollection(),
      ]);
      await CustomerEvent.createIndexes();
    }, 30000);
    afterAll(async () => {
      await Promise.all([
        Customer.collection.deleteMany({ workspaceId }),
        CustomerEvent.collection.deleteMany({ workspaceId }),
      ]);
      await mongoose.disconnect();
    });

    test("moving a card out of no stage ages it from the move, not from creation", async () => {
      const createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const customerId = new mongoose.Types.ObjectId();
      await Customer.collection.insertOne({
        _id: customerId,
        workspaceId,
        status: "active",
        currentFunnelStage: null,
        crm_stage_revision: 0,
        crm_stage_event: null,
        conversationIds: [],
        createdAt,
        updatedAt: createdAt,
      });

      const movedFrom = Date.now();
      await moveCustomerToCrmStage({
        supabase: supabase as never,
        workspaceId,
        customerId: customerId.toString(),
        stageKey: "qualified",
        expectedStageKey: null,
        actor: { type: "manager", userId: "qa-manager" },
      });
      const movedTo = Date.now();

      const enteredAt = (
        await loadStageEnteredAtByCustomer(workspaceId, [customerId.toString()])
      ).get(customerId.toString());
      expect(enteredAt?.getTime()).toBeGreaterThanOrEqual(movedFrom);
      expect(enteredAt?.getTime()).toBeLessThanOrEqual(movedTo);

      const history = await CustomerEvent.find({ workspaceId, customerId })
        .select("type payload.stage payload.captureEvidence")
        .lean<
          {
            type: string;
            payload: { stage: string; captureEvidence: string };
          }[]
        >();
      expect(history).toEqual([
        expect.objectContaining({
          type: "stage_snapshot",
          payload: { stage: "qualified", captureEvidence: "source_write" },
        }),
      ]);
    });

    test("legacy stage snapshots without a stage event stay out of stage age", async () => {
      const customerId = new mongoose.Types.ObjectId();
      await CustomerEvent.collection.insertOne({
        workspaceId,
        customerId,
        type: "stage_snapshot",
        occurredAt: new Date(),
        payload: { stage: "new", previousStage: null },
        idempotencyKey: `legacy:${customerId.toString()}`,
      });

      expect(
        (
          await loadStageEnteredAtByCustomer(workspaceId, [
            customerId.toString(),
          ])
        ).has(customerId.toString())
      ).toBe(false);
    });
  }
);
