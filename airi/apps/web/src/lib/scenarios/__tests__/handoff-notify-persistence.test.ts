import { buildHandoffPanelUrl } from "@/lib/airi/handoff-panel-url";
import { normalizeScenarioNodesForPersistence } from "@/lib/scenarios/scenario-graph-persistence";

function firstNodeData(nodes: unknown[]): Record<string, unknown> {
  const n = nodes[0] as { data?: Record<string, unknown> };
  return (n?.data || {}) as Record<string, unknown>;
}

describe("assign_human handoff notify persistence", () => {
  it("preserves unfinished email drafts and normalizes valid WhatsApp digits", () => {
    const out = normalizeScenarioNodesForPersistence([
      {
        id: "a1",
        data: {
          kind: "action",
          actionType: "assign_human",
          actionInstruction: "Handoff note",
          actionHandoffNotifyEmail: "not-an-email",
          actionHandoffNotifyWhatsapp: "+7 (700) 123-45-67",
        },
      },
    ]);
    const d = firstNodeData(out);
    expect(d.actionHandoffNotifyEmail).toBe("not-an-email");
    expect(d.actionHandoffNotifyWhatsapp).toBe("77001234567");
    expect(d.actionInstruction).toBe("Handoff note");
  });

  it("persists valid notify email lowercased", () => {
    const out = normalizeScenarioNodesForPersistence([
      {
        id: "a2",
        data: {
          kind: "action",
          actionType: "assign_human",
          actionHandoffNotifyEmail: "  Owner@Example.COM  ",
        },
      },
    ]);
    const d = firstNodeData(out);
    expect(d.actionHandoffNotifyEmail).toBe("owner@example.com");
  });

  it("preserves unfinished WhatsApp drafts with too few digits", () => {
    const out = normalizeScenarioNodesForPersistence([
      {
        id: "a3",
        data: {
          kind: "action",
          actionType: "assign_human",
          actionHandoffNotifyWhatsapp: "12345",
        },
      },
    ]);
    const d = firstNodeData(out);
    expect(d.actionHandoffNotifyWhatsapp).toBe("12345");
  });

  it("removes notify fields from reply actions", () => {
    const out = normalizeScenarioNodesForPersistence([
      {
        id: "r1",
        data: {
          kind: "action",
          actionType: "reply",
          actionReplyMode: "fixed",
          actionReplyText: "Hi",
          actionHandoffNotifyEmail: "x@y.com",
          actionHandoffNotifyWhatsapp: "77001234567",
        },
      },
    ]);
    const d = firstNodeData(out);
    expect(d.actionHandoffNotifyEmail).toBeUndefined();
    expect(d.actionHandoffNotifyWhatsapp).toBeUndefined();
  });
});

describe("buildHandoffPanelUrl", () => {
  const prevUrl = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = prevUrl;
  });

  it("uses NEXT_PUBLIC_APP_URL and conversation query", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test/";
    expect(buildHandoffPanelUrl("ws_1", "conv_2")).toBe(
      "https://app.test/panel/w/ws_1/requests?conversation=conv_2"
    );
  });

  it("strips trailing slash on base", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
    expect(buildHandoffPanelUrl("w", "c")).toBe(
      "https://app.test/panel/w/w/requests?conversation=c"
    );
  });
});
