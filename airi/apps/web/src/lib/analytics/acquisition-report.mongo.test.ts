jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./customer-stage-consumer", () => ({
  readCustomerStageCoverage: async () => ({ state: "streaming" }),
}));
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import CustomerEvent from "@/models/customer-event";
import Message from "@/models/message";
import { ScenarioFlowEvent } from "@/models/scenario-flow-event";
import { getAcquisitionReport } from "./acquisition-report";

// Opt-in, disposable local analytics QA database only.
const uri = process.env.AIRICHAT_ANALYTICS_QA_MONGODB_URI;
const workspaceId = `qa-acquisition-flows-${randomUUID()}`;
const otherWorkspaceId = `${workspaceId}-other`;
(uri ? describe : describe.skip)(
  "acquisition flows against actual Mongo",
  () => {
    beforeAll(async () => {
      const local = new URL(uri!);
      if (
        local.hostname !== "127.0.0.1" ||
        !local.pathname.startsWith("/airi_analytics_qa_")
      )
        throw new Error(
          "Acquisition integration requires an isolated local QA database"
        );
      await mongoose.connect(uri!, {
        autoIndex: false,
        serverSelectionTimeoutMS: 3000,
      });
    });
    afterAll(async () => {
      for (const model of [Message, CustomerEvent, ScenarioFlowEvent])
        await model.collection.deleteMany({
          workspaceId: { $in: [workspaceId, otherWorkspaceId] },
        });
      await mongoose.disconnect();
    });

    test("flow delivery joins only an outbound message with the same provider id in the workspace", async () => {
      const conversation = new mongoose.Types.ObjectId();
      const sentAt = new Date("2026-09-10T10:00:00Z");
      const minutes = (count: number) =>
        new Date(sentAt.getTime() + count * 60_000);
      const outbound = {
        channel: "whatsapp",
        direction: "outbound",
        conversation,
        date: sentAt,
      };
      await Message.collection.insertMany([
        // A delivered message without a provider id must not satisfy a send without one.
        { ...outbound, workspaceId, delivery: { status: "delivered" } },
        {
          ...outbound,
          workspaceId,
          messageId: "wamid.flow-bound",
          delivery: { status: "read" },
        },
        {
          ...outbound,
          workspaceId: otherWorkspaceId,
          messageId: "wamid.flow-foreign",
          delivery: { status: "delivered" },
        },
      ]);
      const send = (flowId: string, outboundMessageId: string | null) => ({
        workspaceId,
        conversationId: conversation.toString(),
        flowId,
        flowToken: `${flowId}-token`,
        outboundMessageId,
        eventType: "sent",
        eventAt: sentAt,
      });
      await ScenarioFlowEvent.collection.insertMany([
        send("flow-unbound", null),
        send("flow-bound", "wamid.flow-bound"),
        send("flow-foreign", "wamid.flow-foreign"),
        {
          ...send("flow-bound", "wamid.flow-bound"),
          eventType: "submitted",
          eventAt: minutes(1),
        },
      ]);
      await CustomerEvent.collection.insertOne({
        workspaceId,
        customerId: "customer",
        type: "stage_changed",
        conversationId: conversation,
        occurredAt: minutes(2),
        payload: { stage: "qualified" },
      });
      const report = await getAcquisitionReport({
        workspaceId,
        start: new Date("2026-09-01T00:00:00Z"),
        end: new Date("2026-10-01T00:00:00Z"),
        observationDays: 30,
        now: new Date("2026-10-20T00:00:00Z"),
      });
      const byFlow = Object.fromEntries(
        report.flows.map(row => [row.flowId ?? "", row] as const)
      );
      expect(byFlow["flow-unbound"]).toMatchObject({ sent: 1, delivered: 0 });
      expect(byFlow["flow-foreign"]).toMatchObject({ sent: 1, delivered: 0 });
      expect(byFlow["flow-bound"]).toMatchObject({
        sent: 1,
        delivered: 1,
        submitted: 1,
        qualified: 1,
      });
    });
  }
);
