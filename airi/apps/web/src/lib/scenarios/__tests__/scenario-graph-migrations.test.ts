import {
  CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
  migratePersistedScenarioGraph,
} from "@/lib/scenarios/scenario-graph-migrations";

describe("migratePersistedScenarioGraph", () => {
  it("migrates an unversioned legacy trigger graph to the current schema", () => {
    expect(
      migratePersistedScenarioGraph({
        nodes: [
          {
            id: "trigger-1",
            type: "trigger",
            position: { x: 12, y: 34 },
            data: {
              kind: "trigger",
              label: "Refunds",
              triggerType: "customer_message_contains",
              triggerConfig: {
                enabled: true,
                channelFilter: [" whatsapp ", "whatsapp"],
                keywordPattern: "refund",
              },
            },
          },
        ],
        edges: [{ id: "edge-1", source: "trigger-1", target: "action-1" }],
      }),
    ).toEqual({
      graphSchemaVersion: 1,
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          position: { x: 12, y: 34 },
          data: {
            kind: "trigger",
            label: "Refunds",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "contains",
              keywordMatchMode: "contains",
              channelFilter: ["whatsapp"],
              keywordPattern: "refund",
            },
          },
        },
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "action-1" }],
    });
  });

  it("canonicalizes current-version graphs instead of trusting their version", () => {
    expect(
      migratePersistedScenarioGraph({
        graphSchemaVersion: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerType: "incoming_customer_message",
              triggerConfig: {
                enabled: true,
                messageMatchMode: "exact",
                channelFilter: [" whatsapp ", "whatsapp"],
              },
            },
          },
        ],
        edges: [],
      }),
    ).toEqual({
      graphSchemaVersion: 1,
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "exact",
              keywordMatchMode: "contains",
              channelFilter: ["whatsapp"],
            },
          },
        },
      ],
      edges: [],
    });
  });

  it.each(["payment_detected", "future_unknown_trigger"])(
    "fails closed for retired or unknown trigger type %s",
    triggerType => {
      const migrated = migratePersistedScenarioGraph({
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              triggerType,
              triggerConfig: { enabled: true },
            },
          },
        ],
      });

      expect(migrated.nodes).toEqual([
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: {
              enabled: false,
              messageMatchMode: "any",
              keywordMatchMode: "contains",
            },
          },
        },
      ]);
    },
  );

  it("preserves non-trigger nodes and edges", () => {
    const actionNode = {
      id: "action-1",
      data: {
        kind: "action",
        label: "Reply",
        futurePayload: { untouched: true },
      },
    };
    const edge = {
      id: "edge-1",
      source: "trigger-1",
      target: "action-1",
      futurePayload: { untouched: true },
    };

    expect(
      migratePersistedScenarioGraph({
        graphSchemaVersion: 99,
        nodes: [actionNode],
        edges: [edge],
      }),
    ).toEqual({
      graphSchemaVersion: 1,
      nodes: [actionNode],
      edges: [edge],
    });
  });

  it("does not mutate caller input and returns fresh arrays, nodes, and node data", () => {
    const input = {
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerType: "channel_is",
            triggerConfig: { channelFilter: [" whatsapp "] },
          },
        },
        {
          id: "action-1",
          data: { kind: "action", nested: { preserved: true } },
        },
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "action-1" }],
    };
    const original = structuredClone(input);

    const migrated = migratePersistedScenarioGraph(input);

    expect(input).toEqual(original);
    expect(migrated.nodes).not.toBe(input.nodes);
    expect(migrated.edges).not.toBe(input.edges);
    expect(migrated.nodes[0]).not.toBe(input.nodes[0]);
    expect(migrated.nodes[1]).not.toBe(input.nodes[1]);
    expect(
      (migrated.nodes[0] as { data: unknown }).data,
    ).not.toBe(input.nodes[0].data);
    expect(
      (migrated.nodes[1] as { data: unknown }).data,
    ).not.toBe(input.nodes[1].data);
  });

  it("is exactly idempotent", () => {
    const once = migratePersistedScenarioGraph({
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerType: "telegram_quick_reply",
            triggerConfig: {
              channelFilter: [" whatsapp "],
              metaReferralSourceIds: [" source-1 "],
            },
          },
        },
      ],
      edges: [{ id: "edge-1", source: "trigger-1", target: "action-1" }],
    });

    expect(migratePersistedScenarioGraph(once)).toEqual(once);
  });
});
