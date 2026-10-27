import {
  normalizeClientMessageTriggerConfig,
  type ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import { normalizeScenarioGraphForPersistence } from "./scenario-graph-persistence";
import { serializeScenario } from "./scenario-serialization";
import {
  validateScenarioGraph,
  resolveScenarioGraphBlockingNodeIds,
} from "./graph-validation";
import {
  projectActiveClientMessageFilters,
  isClientMessageCatchAll,
  isClientMessageCriteriaMatchable,
} from "./client-message-trigger-criteria";
import {
  compileScenarioCandidate,
  selectMatchingTrigger,
} from "../airi/scenario/scenario-candidate-selection";
import { projectScenarioIngressContext } from "./incoming-message-trigger-matcher";

const config = {
  entryPointType: "business_event",
  enabled: true,
  businessEvent: {
    integrationId: "forte-market",
    integrationName: "Forte Market",
    eventId: "order.status_changed",
    eventName: "Order status changed",
    filters: [{ field: "status", operator: "equals", value: "shipped" }],
  },
} as ScenarioTriggerConfig;
const nodes = [
  {
    id: "order-event",
    data: { kind: "trigger" as const, triggerConfig: config },
  },
  {
    id: "notify",
    data: {
      kind: "action" as const,
      actionType: "reply" as const,
      actionReplyMode: "fixed" as const,
      actionReplyText: "Order shipped",
    },
  },
];
const edges = [{ source: "order-event", target: "notify" }];

describe("business event UI drafts", () => {
  it("round-trips configured and unfinished drafts through graph persistence and serialization", () => {
    const normalized = normalizeScenarioGraphForPersistence({ nodes, edges });
    const reloaded = serializeScenario({
      _id: "scenario-1",
      workspaceId: "workspace-1",
      name: "Orders",
      status: "draft",
      ...normalized,
    });
    expect(reloaded.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "order-event",
          data: expect.objectContaining({
            triggerConfig: expect.objectContaining(config),
          }),
        }),
      ])
    );
    expect(
      normalizeClientMessageTriggerConfig({
        entryPointType: "business_event",
        businessEvent: {
          filters: [{ field: "", operator: "equals", value: "" }],
        },
      })
    ).toMatchObject({
      entryPointType: "business_event",
      businessEvent: {
        filters: [{ field: "", operator: "equals", value: "" }],
      },
    });
  });

  it("allows draft saves and blocks runnable activation with the actual trigger identified", () => {
    expect(validateScenarioGraph(nodes, edges, { mode: "draft" })).toBeNull();
    expect(validateScenarioGraph(nodes, edges, { mode: "runnable" })).toBe(
      "businessEventIntegrationPending"
    );
    expect(
      resolveScenarioGraphBlockingNodeIds(
        nodes,
        edges,
        "businessEventIntegrationPending"
      )
    ).toEqual(["order-event"]);
  });

  it("never matches ordinary or explicitly selected message ingress, including incomplete drafts", () => {
    for (const triggerConfig of [
      config,
      { entryPointType: "business_event" } as ScenarioTriggerConfig,
    ]) {
      const criteria = projectActiveClientMessageFilters(triggerConfig);
      expect(isClientMessageCatchAll(criteria)).toBe(false);
      expect(isClientMessageCriteriaMatchable(criteria)).toBe(false);
      const candidate = compileScenarioCandidate({
        _id: "scenario-1",
        entryPolicy: "repeatable",
        nodes: [
          { ...nodes[0], data: { kind: "trigger", triggerConfig } },
          nodes[1],
        ],
        edges,
      });
      expect(candidate.triggerCandidates).toHaveLength(0);
      expect(
        selectMatchingTrigger(
          candidate,
          projectScenarioIngressContext({
            eventKind: "inbound_message",
            channel: "whatsapp",
            messageText: "hello",
          }),
          "order-event"
        )
      ).toBeNull();
    }
  });
});
