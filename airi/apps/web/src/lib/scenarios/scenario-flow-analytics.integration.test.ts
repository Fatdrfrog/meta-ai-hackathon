jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { ScenarioFlowEvent } from "@/models/scenario-flow-event";
import {
  trackScenarioFlowSent,
  trackScenarioFlowSubmitted,
} from "./scenario-flow-analytics";
const uri = process.env.AIRICHAT_ANALYTICS_QA_MONGODB_URI;
const workspaceId = `qa-flow-instance-${randomUUID()}`;
(uri ? describe : describe.skip)(
  "Flow source instance isolated replica integration",
  () => {
    beforeAll(async () => {
      if (
        !uri?.startsWith(
          "mongodb://127.0.0.1:27278/airi_analytics_qa_lifecycle_20261002?"
        )
      )
        throw new Error(
          "Flow integration requires the explicitly isolated local QA database"
        );
      await mongoose.connect(uri, { autoIndex: false });
      await ScenarioFlowEvent.createCollection();
      await ScenarioFlowEvent.createIndexes();
    }, 30000);
    afterAll(async () => {
      await ScenarioFlowEvent.deleteMany({ workspaceId });
      await mongoose.disconnect();
    });
    test("two sends sharing one token retain two submissions while replaying either instance remains idempotent", async () => {
      const common = {
        workspaceId,
        conversationId: "qa-conversation",
        flowId: "qa-flow",
        flowToken: "shared-token",
      };
      const firstAt = new Date("2026-10-02T00:00:00.500Z"),
        secondAt = new Date("2026-10-02T00:01:00.500Z");
      await trackScenarioFlowSent({
        ...common,
        outboundMessageId: "wamid.first-send",
        eventAt: firstAt,
      });
      await trackScenarioFlowSent({
        ...common,
        outboundMessageId: "wamid.second-send",
        eventAt: secondAt,
      });
      const first = {
        ...common,
        eventAt: new Date("2026-10-02T00:00:10Z"),
        responseJson: '{"choice":"first"}',
      };
      const second = {
        ...common,
        outboundMessageId: "wamid.second-send",
        eventAt: new Date("2026-10-02T00:01:00Z"),
        responseJson: '{"choice":"second"}',
      };
      await trackScenarioFlowSubmitted(first);
      await trackScenarioFlowSubmitted(second);
      await trackScenarioFlowSubmitted(first);
      await trackScenarioFlowSubmitted(second);
      const submissions = await ScenarioFlowEvent.find({
        workspaceId,
        eventType: "submitted",
      })
        .sort({ eventAt: 1 })
        .lean<{ outboundMessageId: string; responseJson: string }[]>();
      expect(submissions).toEqual([
        expect.objectContaining({
          outboundMessageId: "ws_wamid.first-send",
          responseJson: first.responseJson,
        }),
        expect.objectContaining({
          outboundMessageId: "ws_wamid.second-send",
          responseJson: second.responseJson,
        }),
      ]);
      expect(
        await ScenarioFlowEvent.countDocuments({
          workspaceId,
          eventType: "sent",
        })
      ).toBe(2);
    });
    test("unbound fallback remains one token submission and does not suppress a later bound instance", async () => {
      const params = {
        workspaceId,
        conversationId: "qa-unbound-conversation",
        flowToken: "unbound-token",
        flowIdHint: "qa-fallback-flow",
        eventAt: new Date("2026-10-02T00:00:00Z"),
      };
      await trackScenarioFlowSubmitted(params);
      await trackScenarioFlowSubmitted(params);
      await trackScenarioFlowSent({
        workspaceId,
        conversationId: params.conversationId,
        flowId: "qa-fallback-flow",
        flowToken: params.flowToken,
        outboundMessageId: "wamid.bound-send",
        eventAt: new Date("2026-10-02T00:01:00Z"),
      });

      await trackScenarioFlowSubmitted({
        ...params,
        outboundMessageId: "wamid.bound-send",
        eventAt: new Date("2026-10-02T00:01:05Z"),
      });
      expect(
        await ScenarioFlowEvent.countDocuments({
          workspaceId,
          conversationId: params.conversationId,
          eventType: "submitted",
        })
      ).toBe(2);
    });

    test("a bound replay remains one submission when send metadata arrives later", async () => {
      const params = {
        workspaceId,
        conversationId: "qa-delayed-send",
        flowToken: "late-token",
        outboundMessageId: "wamid.late-send",
        eventAt: new Date("2026-10-02T00:02:00Z"),
      };
      await trackScenarioFlowSubmitted(params);
      await trackScenarioFlowSent({
        ...params,
        flowId: "canonical-flow",
        eventAt: new Date("2026-10-02T00:01:00Z"),
      });
      await trackScenarioFlowSubmitted(params);
      expect(
        await ScenarioFlowEvent.countDocuments({
          workspaceId,
          conversationId: params.conversationId,
          eventType: "submitted",
        })
      ).toBe(1);
    });
  }
);
