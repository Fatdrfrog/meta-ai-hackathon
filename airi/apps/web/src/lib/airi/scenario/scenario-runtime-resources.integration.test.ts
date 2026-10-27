import mongoose from "mongoose";
import { Scenario } from "@/models/scenario";
import {
  fetchActiveScenarioById,
  fetchActiveScenariosForWorkspace,
} from "./scenario-runtime-resources";

const integration = process.env.RUNTIME_SCENARIO_TEST_MONGO ? test : test.skip;
integration(
  "Mongo trigger projection reduces graph transfer and rejects a changed revision",
  async () => {
    const uri = process.env.RUNTIME_SCENARIO_TEST_MONGO!;
    expect(uri).toMatch(
      /^mongodb:\/\/127\.0\.0\.1:27278\/airi_scenario_cost_test\?/
    );
    await mongoose.connect(uri);
    try {
      const _id = new mongoose.Types.ObjectId();
      const updatedAt = new Date("2026-10-10T00:00:00Z");
      const source = {
        _id,
        workspaceId: "ws",
        name: "large",
        status: "active",
        mode: "live",
        deletedAt: null,
        updatedAt,
        nodes: [
          {
            id: "trigger",
            data: {
              kind: "trigger",
              triggerConfig: { enabled: true, messageMatchMode: "any" },
            },
          },
          ...Array.from({ length: 50 }, (_, index) => ({
            id: `action-${index}`,
            data: {
              kind: "action",
              actionType: "reply",
              actionReplyText: "x".repeat(10_000),
            },
          })),
        ],
        edges: [{ source: "trigger", target: "action-0" }],
      };
      await Scenario.collection.insertOne(source);
      const candidates = await fetchActiveScenariosForWorkspace({
        workspaceId: "ws",
        triggerProjection: true,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].graphProjection).toBe("triggers");
      expect(candidates[0].nodes).toHaveLength(1);
      expect(candidates[0].edges).toBeUndefined();
      expect(JSON.stringify(candidates).length).toBeLessThan(
        JSON.stringify(source).length / 100
      );
      expect(
        await fetchActiveScenarioById({
          workspaceId: "ws",
          scenarioId: String(_id),
          expectedUpdatedAt: updatedAt,
        })
      ).not.toBeNull();
      await Scenario.collection.updateOne(
        { _id },
        { $set: { updatedAt: new Date("2026-10-10T00:00:01Z") } }
      );
      expect(
        await fetchActiveScenarioById({
          workspaceId: "ws",
          scenarioId: String(_id),
          expectedUpdatedAt: updatedAt,
        })
      ).toBeNull();
    } finally {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  },
  30_000
);
