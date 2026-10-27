import {
  joinNameParts,
  markTaskCompleted,
  markTaskSkipped,
  normalizeString,
  sanitizeInstructionSnippet,
} from "@/lib/scenarios/task-utils";
import { resolveTtlSeconds } from "@/lib/scenarios/ttl-utils";
import {
  normalizeActionType,
  normalizeScenarioPriority,
} from "@/lib/scenarios/normalization";
import {
  compileScenarioGraph,
  parseNodes,
} from "@icecore/airi-runtime/scenario-graph";

describe("scenario shared primitives", () => {
  it("keeps string and retry helpers behavior", () => {
    expect(normalizeString("  hi  ")).toBe("hi");
    expect(normalizeString(42)).toBe("42");
    expect(joinNameParts("Ada", "Lovelace")).toBe("Ada Lovelace");
    expect(sanitizeInstructionSnippet("a  b\nc")).toBe("a b c");
  });

  it("applies TTL fallback and env override", () => {
    const original = process.env.AIRI_TEST_TTL_DAYS;
    try {
      delete process.env.AIRI_TEST_TTL_DAYS;
      expect(
        resolveTtlSeconds({
          envVar: "AIRI_TEST_TTL_DAYS",
          defaultDays: 7,
        })
      ).toBe(7 * 24 * 60 * 60);

      process.env.AIRI_TEST_TTL_DAYS = "14";
      expect(
        resolveTtlSeconds({
          envVar: "AIRI_TEST_TTL_DAYS",
          defaultDays: 7,
        })
      ).toBe(14 * 24 * 60 * 60);
    } finally {
      if (original === undefined) {
        delete process.env.AIRI_TEST_TTL_DAYS;
      } else {
        process.env.AIRI_TEST_TTL_DAYS = original;
      }
    }
  });

  it("normalizes canonical actions without legacy Flow inference and parses graphs", () => {
    expect(
      normalizeActionType({
        kind: "action",
        source: "airi",
      } as never)
    ).toBe("reply");
    expect(normalizeScenarioPriority("12")).toBe(12);
    expect(
      normalizeActionType({
        kind: "action",
        actionType: "reply",
        actionWhatsAppServiceMessage: {
          version: 1,
          message: {
            kind: "text",
            body: { mode: "fixed", text: "Canonical" },
          },
        },
        actionFlowConfig: {
          templateId: "stale-flow",
          screens: [{ id: "screen-1", title: "Stale", fields: [] }],
          ctaText: "Open",
        },
      } as never)
    ).toBe("reply");
    expect(
      normalizeActionType({
        kind: "action",
        actionType: "reply",
        actionFlowConfig: {
          templateId: "orphan-flow",
          screens: [{ id: "screen-1", title: "Orphan", fields: [] }],
          ctaText: "Open",
        },
      } as never)
    ).toBe("reply");

    const nodes = parseNodes([
      { id: "trigger-1", data: { kind: "trigger" } },
      { id: "action-1", data: { kind: "action", source: "airi" } },
      { id: "  ", data: { kind: "action", source: "team" } },
      { id: "missing-kind", data: {} },
    ]);
    expect(nodes).toHaveLength(2);

    const graph = compileScenarioGraph(nodes, [
      { source: "trigger-1", target: "action-1" },
    ]);
    expect(graph.triggerNodeIds).toEqual(["trigger-1"]);
    expect(graph.runtimeActionNodes.map(node => node.id)).toEqual(["action-1"]);
    expect(graph.adjacency.get("trigger-1")).toEqual(["action-1"]);
  });

  it("keeps task status mutations stable", async () => {
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const model = { updateOne };

    await expect(markTaskCompleted(model, "task-1", "lease-1")).resolves.toBe(
      true
    );
    expect(updateOne).toHaveBeenNthCalledWith(
      1,
      { _id: "task-1", status: "processing", processingLeaseId: "lease-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "completed",
          processingLeaseId: null,
        }),
      })
    );

    await expect(
      markTaskSkipped(model, "task-1", "lease-1", "window_expired", "boom")
    ).resolves.toBe(true);
    expect(updateOne).toHaveBeenNthCalledWith(
      2,
      { _id: "task-1", status: "processing", processingLeaseId: "lease-1" },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: "skipped",
          skipReason: "window_expired",
          lastError: "boom",
        }),
      })
    );
  });
});
