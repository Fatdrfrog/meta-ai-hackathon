import {
  ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
  ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  buildFlowBranchSourceHandleId,
  buildScenarioActionAnswerOutcomeHandleId,
} from "@icecore/scenario-contracts";
import mongoose from "mongoose";

import { createDemoShopInteractiveNoReplyFixture } from "../../../test-fixtures/scenarios/demoshop-interactive-no-reply";
import {
  buildInteractiveNoReplyMigrationErrorEvent,
  parseInteractiveNoReplyMigrationArgs,
  planInteractiveNoReplyAssignmentMigration,
  runInteractiveNoReplyMigrationOperator,
  type InteractiveNoReplyMigrationEvent,
} from "./interactive-no-reply-migration";
import { buildLegacyRoutingMigrationPreimage } from "./legacy-routing-migration-preimage";
import type { LegacyActionRoutingGraph } from "./legacy-action-routing";
import { getPostActionAnswerMatchHandleId } from "@icecore/scenario-contracts";

const assertTimerReplanIngressReady = jest.fn();

const workspaceId = "workspace-fixture";
const scenarioId = "scenario-fixture";
const updatedAt = "2026-08-05T12:00:00.000Z";
const beforeSha256 =
  "3adfc2fe45a3c910db573e3cb68edaa87b416181f1bbd0eb5cb267fbba514ef4";
const afterSha256 =
  "58e0d3eea296be14f85f18a670c3078813e5b69876f9a4d3b8944c4ee9ff361c";
const preimageSha256 = "b".repeat(64);
const outputPath = "C:\\temp\\migration-preimage.json";

function guardedApplyArgs(
  expectedPreimageSha256 = canonicalPreimage().preimageSha256
) {
  return {
    apply: true as const,
    workspaceId,
    scenarioId,
    expectedCount: 2,
    expectedRevision: updatedAt,
    expectedBeforeSha256: beforeSha256,
    expectedPreimageSha256,
    outputPath,
  };
}

function scenarioSnapshot() {
  return {
    _id: scenarioId,
    workspaceId,
    updatedAt,
    name: "Migration fixture",
    ...createDemoShopInteractiveNoReplyFixture(),
  };
}

function canonicalPreimage(params?: {
  pendingConversations?: Array<Record<string, unknown>>;
  linkedConditions?: Array<Record<string, unknown>>;
  remainingPendingConversations?: Array<Record<string, unknown>>;
  remainingLinkedConditions?: Array<Record<string, unknown>>;
  verificationError?: Error;
}) {
  return buildLegacyRoutingMigrationPreimage({
    target: {
      workspaceId,
      scenarioId,
      candidatePairs: [
        {
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        },
        {
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
        },
      ],
    },
    scenario: scenarioSnapshot(),
    pendingConversations: params?.pendingConversations || [],
    linkedConditions: params?.linkedConditions || [],
  });
}

function loadedState(params: {
  preimage: ReturnType<typeof buildLegacyRoutingMigrationPreimage>;
  scenario: ReturnType<typeof scenarioSnapshot>;
  pendingConversations?: Array<Record<string, unknown>>;
  linkedConditions?: Array<Record<string, unknown>>;
}) {
  return {
    preimage: params.preimage,
    raw: {
      scenario: params.scenario,
      pendingConversations: params.pendingConversations || [],
      linkedConditions: params.linkedConditions || [],
    },
    semantic: {
      scenario: mongoose.mongo.BSON.deserialize(
        mongoose.mongo.BSON.serialize(params.scenario)
      ) as Record<string, unknown>,
    },
  };
}

function createOperatorPreimageFixture(params?: {
  scenario?: ReturnType<typeof scenarioSnapshot>;
  pendingConversations?: Array<Record<string, unknown>>;
  linkedConditions?: Array<Record<string, unknown>>;
  remainingPendingConversations?: Array<Record<string, unknown>>;
  remainingLinkedConditions?: Array<Record<string, unknown>>;
  verificationError?: Error;
}) {
  const scenario = params?.scenario || scenarioSnapshot();
  const plan = planInteractiveNoReplyAssignmentMigration({
    nodes: scenario.nodes,
    edges: scenario.edges,
  });
  const targetPairs = plan.candidates.map(candidate => ({
    sourceActionNodeId: candidate.sourceActionNodeId,
    sourceNodeId: candidate.sourceNodeId,
  }));
  const discovery = buildLegacyRoutingMigrationPreimage({
    target: { workspaceId, scenarioId, candidatePairs: [] },
    scenario,
    pendingConversations: [],
    linkedConditions: [],
  });
  const exact = buildLegacyRoutingMigrationPreimage({
    target: { workspaceId, scenarioId, candidatePairs: targetPairs },
    scenario,
    pendingConversations: params?.pendingConversations || [],
    linkedConditions: params?.linkedConditions || [],
  });
  const verification = buildLegacyRoutingMigrationPreimage({
    target: { workspaceId, scenarioId, candidatePairs: targetPairs },
    scenario,
    pendingConversations: params?.remainingPendingConversations || [],
    linkedConditions: params?.remainingLinkedConditions || [],
  });
  const discoveryState = loadedState({
    preimage: discovery,
    scenario,
  });
  const exactState = loadedState({
    preimage: exact,
    scenario,
    pendingConversations: params?.pendingConversations,
    linkedConditions: params?.linkedConditions,
  });
  const verificationState = loadedState({
    preimage: verification,
    scenario,
    pendingConversations: params?.remainingPendingConversations,
    linkedConditions: params?.remainingLinkedConditions,
  });
  let exactReads = 0;
  return {
    discovery,
    exact,
    loadState: jest.fn(
      async ({ candidatePairs }: { candidatePairs: unknown[] }) => {
        if (candidatePairs.length === 0) return discoveryState;
        exactReads += 1;
        if (exactReads === 1) return exactState;
        if (params?.verificationError) throw params.verificationError;
        return verificationState;
      }
    ),
  };
}

function pendingPreimageRow(params: {
  conversationId: string;
  sourceActionNodeId: string;
  sourceNodeId: string;
  airiScenarioState?: unknown;
}) {
  return {
    _id: params.conversationId,
    workspaceId,
    airi_scenario_state: params.airiScenarioState || {
      lockedScenarioId: scenarioId,
      pendingConditionNodeId: params.sourceNodeId,
      pendingSourceActionNodeId: params.sourceActionNodeId,
    },
    updatedAt,
    __v: 0,
  };
}

function createMinimalDedicatedAssignmentGraph(params?: {
  genericCondition?: boolean;
  duplicateAssignment?: boolean;
  legacyFlowAlias?: boolean;
}): LegacyActionRoutingGraph {
  return {
    nodes: [
      {
        id: "action-minimal",
        data: {
          kind: "action",
          actionType: "reply",
          ...(params?.legacyFlowAlias
            ? {
                actionWhatsAppServiceMessage: {
                  version: 1,
                  message: {
                    kind: "flow",
                    body: { mode: "fixed", text: "Choose" },
                    flowConfig: {
                      templateId: "flow-1",
                      ctaText: "Open",
                      screens: [
                        {
                          id: "screen-1",
                          title: "Choose",
                          fields: [
                            {
                              id: "plan",
                              label: "Plan",
                              fieldType: "RadioButtonsGroup",
                              options: [{ id: "one", title: "One" }],
                            },
                          ],
                        },
                      ],
                    },
                  },
                },
              }
            : {}),
        },
      },
      {
        id: "condition-minimal",
        data: {
          kind: "logic",
          logicType: "post_action_condition",
          ...(params?.genericCondition
            ? {}
            : { postActionConditionVariant: "interactive_no_reply" }),
          conditionBranches: [
            {
              id: "no_reply_timeout",
              type: "no_reply_timeout",
              timeoutMinutes: 30,
            },
          ],
        },
      },
      {
        id: "follow-up-minimal",
        data: { kind: "action", actionType: "reply" },
      },
    ],
    edges: [
      {
        id: "dedicated-minimal",
        source: "action-minimal",
        sourceHandle: params?.legacyFlowAlias
          ? ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID
          : ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        target: "condition-minimal",
      },
      ...(params?.legacyFlowAlias
        ? [
            {
              id: "specific-flow-option",
              source: "action-minimal",
              sourceHandle: buildFlowBranchSourceHandleId("plan", "one"),
              target: "condition-minimal",
            },
          ]
        : []),
      ...(params?.duplicateAssignment
        ? [
            {
              id: "dedicated-minimal-duplicate",
              source: "action-minimal",
              sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
              target: "condition-minimal",
            },
          ]
        : []),
      {
        id: "timeout-minimal",
        source: "condition-minimal",
        sourceHandle: "right-source-condition-no_reply_timeout",
        target: "follow-up-minimal",
      },
    ],
  };
}

describe("planInteractiveNoReplyAssignmentMigration", () => {
  it("plans and hashes a Mongo-valid graph larger than one megabyte", () => {
    const graph = createDemoShopInteractiveNoReplyFixture();
    graph.nodes[0] = {
      ...graph.nodes[0],
      data: {
        ...graph.nodes[0].data,
        forwardCompatiblePayload: "x".repeat(1_250_000),
      } as (typeof graph.nodes)[number]["data"],
    };

    const plan = planInteractiveNoReplyAssignmentMigration(graph);

    expect(plan.candidates).toHaveLength(2);
    expect(plan.hashes.beforeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.hashes.afterSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("converts exactly the dedicated assignments and preserves shared Flow branch targets", () => {
    const graph = createDemoShopInteractiveNoReplyFixture();
    const original = structuredClone(graph);

    const plan = planInteractiveNoReplyAssignmentMigration(graph);

    expect(plan.candidates).toEqual([
      {
        assignmentEdgeId: "dedicated-alpha",
        sourceActionNodeId: "action-alpha",
        sourceNodeId: "legacy-alpha",
        sourceKind: "post_action_condition",
        virtualConditionNodeId: "__system:action-outcomes:action-alpha",
      },
      {
        assignmentEdgeId: "dedicated-beta",
        sourceActionNodeId: "action-beta",
        sourceNodeId: "legacy-beta",
        sourceKind: "post_action_condition",
        virtualConditionNodeId: "__system:action-outcomes:action-beta",
      },
    ]);
    expect(plan.skips).toEqual([]);
    expect(plan.dedicatedAssignmentCount).toBe(2);
    expect(graph).toEqual(original);
    expect(
      plan.convertedGraph.edges.filter(edge =>
        ["flow-alpha", "flow-beta", "flow-shared-subtree"].includes(
          edge.id ?? ""
        )
      )
    ).toEqual(
      original.edges.filter(edge =>
        ["flow-alpha", "flow-beta", "flow-shared-subtree"].includes(
          edge.id ?? ""
        )
      )
    );
    expect(
      plan.convertedGraph.edges.some(
        edge =>
          edge.sourceHandle === ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID
      )
    ).toBe(false);
    expect(
      plan.convertedGraph.nodes.find(node => node.id === "action-alpha")?.data
        .actionOutcomes
    ).toEqual({
      version: 1,
      noReply: {
        enabled: true,
        timeoutMinutes: 45,
        cancelIfPhrases: ["cancel"],
      },
    });
    expect(
      plan.convertedGraph.nodes.find(node => node.id === "action-beta")?.data
        .actionOutcomes
    ).toEqual({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 90 },
      answerMatches: [
        { id: "accept", mode: "exact", text: "Accept" },
        { id: "decline", mode: "exact", text: "Decline" },
      ],
    });
    expect(
      plan.convertedGraph.edges
        .filter(edge =>
          [
            "timeout-alpha",
            "timeout-beta",
            "accept-beta",
            "decline-beta",
          ].includes(edge.id ?? "")
        )
        .map(edge => ({
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: edge.target,
        }))
    ).toEqual([
      {
        id: "timeout-alpha",
        source: "action-alpha",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        target: "timeout-target-alpha",
      },
      {
        id: "timeout-beta",
        source: "action-beta",
        sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
        target: "timeout-target-beta",
      },
      {
        id: "accept-beta",
        source: "action-beta",
        sourceHandle: buildScenarioActionAnswerOutcomeHandleId("accept"),
        target: "accept-target-beta",
      },
      {
        id: "decline-beta",
        source: "action-beta",
        sourceHandle: buildScenarioActionAnswerOutcomeHandleId("decline"),
        target: "decline-target-beta",
      },
    ]);
  });

  it("discovers and converts a legacy generic Flow alias", () => {
    const graph = createMinimalDedicatedAssignmentGraph({
      legacyFlowAlias: true,
    });

    const plan = planInteractiveNoReplyAssignmentMigration(graph);

    expect(plan.dedicatedAssignmentCount).toBe(1);
    expect(plan.skips).toEqual([]);
    expect(plan.candidates).toEqual([
      expect.objectContaining({
        assignmentEdgeId: "dedicated-minimal",
        sourceActionNodeId: "action-minimal",
        sourceNodeId: "condition-minimal",
      }),
    ]);
    expect(
      plan.convertedGraph.nodes.find(node => node.id === "action-minimal")?.data
        .actionOutcomes
    ).toEqual({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 30 },
    });
    expect(
      plan.convertedGraph.edges.some(edge =>
        [
          ACTION_FLOW_BRANCH_OUTPUT_HANDLE_ID,
          ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
        ].includes(edge.sourceHandle ?? "")
      )
    ).toBe(false);
  });

  it("produces stable semantic hashes and ordering when graph arrays are reordered", () => {
    const graph = createDemoShopInteractiveNoReplyFixture();
    const reordered = {
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };

    const first = planInteractiveNoReplyAssignmentMigration(graph);
    const second = planInteractiveNoReplyAssignmentMigration(reordered);

    expect(first.candidates).toEqual(second.candidates);
    expect(first.hashes).toEqual(second.hashes);
    expect(first.hashes.beforeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hashes.afterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.hashes.beforeSha256).not.toBe(first.hashes.afterSha256);
  });

  it("reports an unsafe dedicated assignment instead of partially converting it", () => {
    const graph = createDemoShopInteractiveNoReplyFixture();
    graph.edges.push({
      id: "dedicated-missing",
      source: "missing-action",
      sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
      target: "missing-condition",
    });

    const plan = planInteractiveNoReplyAssignmentMigration(graph);

    expect(plan.candidates).toHaveLength(2);
    expect(plan.skips).toEqual([
      {
        assignmentEdgeId: "dedicated-missing",
        sourceActionNodeId: "missing-action",
        sourceNodeId: "missing-condition",
        reason: "legacy_action_routing_not_dedicated_assignment",
      },
    ]);
    expect(plan.dedicatedAssignmentCount).toBe(3);
  });

  it("skips a dedicated handle that targets an ordinary condition", () => {
    const graph = createMinimalDedicatedAssignmentGraph({
      genericCondition: true,
    });

    const plan = planInteractiveNoReplyAssignmentMigration(graph);

    expect(plan.candidates).toEqual([]);
    expect(plan.skips).toEqual([
      {
        assignmentEdgeId: "dedicated-minimal",
        sourceActionNodeId: "action-minimal",
        sourceNodeId: "condition-minimal",
        reason: "legacy_action_routing_not_dedicated_assignment",
      },
    ]);
    expect(plan.convertedGraph).toEqual(graph);
  });

  it("skips every duplicate dedicated assignment edge", () => {
    const graph = createMinimalDedicatedAssignmentGraph({
      duplicateAssignment: true,
    });

    const plan = planInteractiveNoReplyAssignmentMigration(graph);

    expect(plan.candidates).toEqual([]);
    expect(plan.skips).toEqual([
      {
        assignmentEdgeId: "dedicated-minimal",
        sourceActionNodeId: "action-minimal",
        sourceNodeId: "condition-minimal",
        reason: "legacy_action_routing_not_dedicated_assignment",
      },
      {
        assignmentEdgeId: "dedicated-minimal-duplicate",
        sourceActionNodeId: "action-minimal",
        sourceNodeId: "condition-minimal",
        reason: "legacy_action_routing_not_dedicated_assignment",
      },
    ]);
    expect(plan.convertedGraph).toEqual(graph);
  });
});

describe("parseInteractiveNoReplyMigrationArgs", () => {
  it("accepts pnpm's conventional argument separator", () => {
    expect(
      parseInteractiveNoReplyMigrationArgs([
        "--",
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
      ])
    ).toEqual({ apply: false, workspaceId, scenarioId });
  });

  it("parses an explicit apply invocation with a guarded count and absolute preimage path", () => {
    expect(
      parseInteractiveNoReplyMigrationArgs([
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
        "--expected-count=2",
        `--expected-revision=${updatedAt}`,
        `--expected-before-sha256=${beforeSha256}`,
        `--expected-preimage-sha256=${preimageSha256}`,
        `--output=${outputPath}`,
        "--apply",
      ])
    ).toEqual({
      apply: true,
      workspaceId,
      scenarioId,
      expectedCount: 2,
      expectedRevision: updatedAt,
      expectedBeforeSha256: beforeSha256,
      expectedPreimageSha256: preimageSha256,
      outputPath,
    });
  });

  it.each([
    "--expected-count=",
    "--output=",
    "--expected-revision=",
    "--expected-before-sha256=",
    "--expected-preimage-sha256=",
  ])("rejects an explicitly empty %s value", argument => {
    expect(() =>
      parseInteractiveNoReplyMigrationArgs([
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
        argument,
      ])
    ).toThrow("must not be empty");
  });

  it.each([
    [
      "output",
      [
        `--expected-revision=${updatedAt}`,
        `--expected-before-sha256=${beforeSha256}`,
      ],
    ],
    [
      "expected revision",
      [`--output=${outputPath}`, `--expected-before-sha256=${beforeSha256}`],
    ],
    [
      "expected graph hash",
      [
        `--output=${outputPath}`,
        `--expected-revision=${updatedAt}`,
        `--expected-preimage-sha256=${preimageSha256}`,
      ],
    ],
    [
      "expected preimage hash",
      [
        `--output=${outputPath}`,
        `--expected-revision=${updatedAt}`,
        `--expected-before-sha256=${beforeSha256}`,
      ],
    ],
  ])("requires %s for apply", (_label, guardedArguments) => {
    expect(() =>
      parseInteractiveNoReplyMigrationArgs([
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
        ...guardedArguments,
        "--apply",
      ])
    ).toThrow("Apply requires");
  });

  it("defaults to dry-run and rejects incomplete or ambiguous targets", () => {
    expect(
      parseInteractiveNoReplyMigrationArgs([
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
      ])
    ).toEqual({ apply: false, workspaceId, scenarioId });
    expect(() =>
      parseInteractiveNoReplyMigrationArgs([`--workspace-id=${workspaceId}`])
    ).toThrow("workspace and scenario IDs are required");
    expect(() =>
      parseInteractiveNoReplyMigrationArgs([
        `--workspace-id=${workspaceId}`,
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
      ])
    ).toThrow("may be provided only once");
    expect(() =>
      parseInteractiveNoReplyMigrationArgs([
        `--workspace-id=${workspaceId}`,
        `--scenario-id=${scenarioId}`,
        "--output=relative.json",
      ])
    ).toThrow("output path must be absolute");
  });
});

describe("runInteractiveNoReplyMigrationOperator", () => {
  beforeEach(() => {
    assertTimerReplanIngressReady.mockReset().mockResolvedValue(undefined);
  });

  it("hard-stops before reading a dry-run target when durable timer ingress indexes are unavailable", async () => {
    const indexError = Object.assign(
      new Error("required indexes are missing"),
      {
        code: "timer_replan_ingress_indexes_missing",
      }
    );
    const loadState = jest.fn();
    assertTimerReplanIngressReady.mockRejectedValueOnce(indexError);

    await expect(
      runInteractiveNoReplyMigrationOperator(
        { apply: false, workspaceId, scenarioId },
        {
          assertTimerReplanIngressReady,
          loadState,
          applyMigration: jest.fn(),
          writePreimage: jest.fn(),
        }
      )
    ).rejects.toBe(indexError);

    expect(loadState).not.toHaveBeenCalled();
  });

  it("completes a dry run for a graph larger than one megabyte", async () => {
    const scenario = scenarioSnapshot();
    scenario.nodes[0] = {
      ...scenario.nodes[0],
      data: {
        ...scenario.nodes[0].data,
        forwardCompatiblePayload: "x".repeat(1_250_000),
      } as (typeof scenario.nodes)[number]["data"],
    };
    const fixture = createOperatorPreimageFixture({ scenario });

    const result = await runInteractiveNoReplyMigrationOperator(
      {
        apply: false,
        workspaceId,
        scenarioId,
        expectedCount: 2,
      },
      {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration: jest.fn(),
        writePreimage: jest.fn(),
      }
    );

    expect(result).toMatchObject({
      mode: "dry_run",
      candidateCount: 2,
      applied: false,
    });
  });

  it("writes reviewed near-miss evidence and hard-stops before apply", async () => {
    const fixture = createOperatorPreimageFixture({
      pendingConversations: [
        pendingPreimageRow({
          conversationId: "conversation-wrong-source",
          sourceActionNodeId: "action-wrong",
          sourceNodeId: "legacy-alpha",
        }),
      ],
    });
    const writePreimage = jest.fn().mockResolvedValue(undefined);
    const applyMigration = jest.fn();

    await expect(
      runInteractiveNoReplyMigrationOperator(
        {
          apply: false,
          workspaceId,
          scenarioId,
          expectedCount: 2,
          outputPath,
        },
        {
          assertTimerReplanIngressReady,
          loadState: fixture.loadState,
          applyMigration,
          writePreimage,
        }
      )
    ).rejects.toMatchObject({
      code: "interactive_no_reply_external_state_invalid",
    });

    expect(writePreimage).toHaveBeenCalledWith(outputPath, fixture.exact);
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("writes the canonical full preimage and emits its reviewed digest", async () => {
    const preimage = canonicalPreimage({
      pendingConversations: [
        {
          _id: "conversation-alpha",
          workspaceId,
          airi_scenario_state: {
            lockedScenarioId: scenarioId,
            pendingConditionNodeId: "legacy-alpha",
            pendingSourceActionNodeId: "action-alpha",
          },
          updatedAt,
          __v: 3,
        },
      ],
      linkedConditions: [
        {
          _id: "linked-alpha",
          workspaceId,
          parentRefs: [
            {
              parentScenarioId: scenarioId,
              conditionNodeId: "legacy-alpha",
              branchType: "no_reply_timeout",
              sourceActionNodeId: "action-alpha",
              scenarioLinkNodeId: "link-alpha",
            },
          ],
          updatedAt,
          __v: 1,
        },
      ],
    });
    const writePreimage = jest.fn().mockResolvedValue(undefined);
    const events: InteractiveNoReplyMigrationEvent[] = [];
    const dependencies = {
      assertTimerReplanIngressReady,
      loadState: jest
        .fn()
        .mockResolvedValue(
          loadedState({ preimage, scenario: scenarioSnapshot() })
        ),
      applyMigration: jest.fn(),
      writePreimage,
      emit: (event: InteractiveNoReplyMigrationEvent) => events.push(event),
    };

    await runInteractiveNoReplyMigrationOperator(
      { apply: false, workspaceId, scenarioId, outputPath },
      dependencies
    );

    expect(writePreimage).toHaveBeenCalledWith(outputPath, preimage);
    expect(events[0]).toMatchObject({
      type: "migration_plan",
      preimageSha256: preimage.preimageSha256,
      linkedConditionCount: 1,
      pendingConversationCount: 1,
    });
  });

  it("keeps dry-run read-only and emits deterministic JSONL-ready records", async () => {
    const scenario = scenarioSnapshot();
    const original = structuredClone(scenario);
    const applyMigration = jest.fn();
    const writePreimage = jest.fn();
    const events: InteractiveNoReplyMigrationEvent[] = [];
    const fixture = createOperatorPreimageFixture({
      scenario,
      pendingConversations: [
        pendingPreimageRow({
          conversationId: "conversation-alpha",
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        }),
        pendingPreimageRow({
          conversationId: "conversation-beta",
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
        }),
      ],
    });

    const result = await runInteractiveNoReplyMigrationOperator(
      { apply: false, workspaceId, scenarioId, expectedCount: 2 },
      {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration,
        writePreimage,
        emit: event => events.push(event),
      }
    );

    expect(result).toMatchObject({
      mode: "dry_run",
      candidateCount: 2,
      pendingConversationCount: 2,
      applied: false,
    });
    expect(applyMigration).not.toHaveBeenCalled();
    expect(writePreimage).not.toHaveBeenCalled();
    expect(fixture.loadState).toHaveBeenCalledTimes(2);
    expect(scenario).toEqual(original);
    expect(events.map(event => event.type)).toEqual([
      "migration_plan",
      "migration_candidate",
      "migration_candidate",
      "migration_pending_conversation",
      "migration_pending_conversation",
      "migration_complete",
    ]);
    expect(events[0]).toMatchObject({
      type: "migration_plan",
      scenarioRevision: updatedAt,
      hashes: { beforeSha256, afterSha256 },
    });
    for (const event of events) {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      expect(JSON.stringify(event)).not.toContain("\n");
    }
  });

  it("plans from semantic BSON values while retaining typed preimage evidence", async () => {
    const scenario = scenarioSnapshot();
    const legacyBeta = scenario.nodes.find(node => node.id === "legacy-beta");
    if (!legacyBeta) throw new Error("fixture is missing legacy-beta");
    const branches = legacyBeta.data.conditionBranches as Array<
      Record<string, unknown>
    >;
    branches[0].timeoutMinutes = new mongoose.mongo.Int32(120);
    branches[0].answerMatchRules = [
      { id: new mongoose.mongo.Int32(1), mode: "exact", text: "Accept" },
      { id: "decline", mode: "exact", text: "Decline" },
    ];
    const acceptEdge = scenario.edges.find(edge => edge.id === "accept-beta");
    if (!acceptEdge) throw new Error("fixture is missing accept-beta");
    acceptEdge.sourceHandle = getPostActionAnswerMatchHandleId("1");
    const semanticScenario = mongoose.mongo.BSON.deserialize(
      mongoose.mongo.BSON.serialize(scenario)
    ) as ReturnType<typeof scenarioSnapshot>;
    const semanticPlan = planInteractiveNoReplyAssignmentMigration({
      nodes: semanticScenario.nodes,
      edges: semanticScenario.edges,
    });
    const targetPairs = semanticPlan.candidates.map(candidate => ({
      sourceActionNodeId: candidate.sourceActionNodeId,
      sourceNodeId: candidate.sourceNodeId,
    }));
    const discovery = buildLegacyRoutingMigrationPreimage({
      target: { workspaceId, scenarioId, candidatePairs: [] },
      scenario,
      pendingConversations: [],
      linkedConditions: [],
    });
    const exact = buildLegacyRoutingMigrationPreimage({
      target: { workspaceId, scenarioId, candidatePairs: targetPairs },
      scenario,
      pendingConversations: [],
      linkedConditions: [],
    });
    const loadState = jest
      .fn()
      .mockResolvedValueOnce(loadedState({ preimage: discovery, scenario }))
      .mockResolvedValueOnce(loadedState({ preimage: exact, scenario }));

    const result = await runInteractiveNoReplyMigrationOperator(
      { apply: false, workspaceId, scenarioId, expectedCount: 2 },
      {
        assertTimerReplanIngressReady,
        loadState,
        applyMigration: jest.fn(),
        writePreimage: jest.fn(),
      }
    );

    expect(
      result.plan.convertedGraph.nodes.find(node => node.id === "action-beta")
        ?.data.actionOutcomes
    ).toEqual({
      version: 1,
      noReply: { enabled: true, timeoutMinutes: 120 },
      answerMatches: [
        { id: "1", mode: "exact", text: "Accept" },
        { id: "decline", mode: "exact", text: "Decline" },
      ],
    });
    expect(exact.preimageSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hard-stops a count mismatch before a preimage or database write", async () => {
    const applyMigration = jest.fn();
    const writePreimage = jest.fn();
    const fixture = createOperatorPreimageFixture();

    await expect(
      runInteractiveNoReplyMigrationOperator(
        { ...guardedApplyArgs(), expectedCount: 3 },
        {
          assertTimerReplanIngressReady,
          loadState: fixture.loadState,
          applyMigration,
          writePreimage,
        }
      )
    ).rejects.toMatchObject({
      code: "interactive_no_reply_candidate_count_mismatch",
    });
    expect(writePreimage).not.toHaveBeenCalled();
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("writes an explicitly requested dry-run preimage without applying", async () => {
    const scenario = scenarioSnapshot();
    const fixture = createOperatorPreimageFixture({
      scenario,
      pendingConversations: [
        pendingPreimageRow({
          conversationId: "conversation-alpha",
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        }),
      ],
    });
    const applyMigration = jest.fn();
    const writePreimage = jest.fn().mockResolvedValue(undefined);
    const outputPath = "C:\\temp\\migration-preimage.json";

    const result = await runInteractiveNoReplyMigrationOperator(
      {
        apply: false,
        workspaceId,
        scenarioId,
        expectedCount: 2,
        outputPath,
      },
      {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration,
        writePreimage,
      }
    );

    expect(writePreimage).toHaveBeenCalledWith(outputPath, fixture.exact);
    expect(applyMigration).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: "dry_run", applied: false });
  });

  it("refuses an unsafe partial apply even without an expected count", async () => {
    const scenario = scenarioSnapshot();
    scenario.edges.push({
      id: "dedicated-missing",
      source: "missing-action",
      sourceHandle: ACTION_INTERACTIVE_NO_REPLY_OUTPUT_HANDLE_ID,
      target: "missing-condition",
    });
    const applyMigration = jest.fn();
    const writePreimage = jest.fn();
    const currentBeforeSha256 = planInteractiveNoReplyAssignmentMigration({
      nodes: scenario.nodes,
      edges: scenario.edges,
    }).hashes.beforeSha256;
    const fixture = createOperatorPreimageFixture({ scenario });

    await expect(
      runInteractiveNoReplyMigrationOperator(
        {
          ...guardedApplyArgs(),
          expectedCount: undefined,
          expectedBeforeSha256: currentBeforeSha256,
        },
        {
          assertTimerReplanIngressReady,
          loadState: fixture.loadState,
          applyMigration,
          writePreimage,
        }
      )
    ).rejects.toMatchObject({
      code: "interactive_no_reply_unsafe_assignments",
    });
    expect(writePreimage).not.toHaveBeenCalled();
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("hard-stops apply when a dedicated handle targets an ordinary condition", async () => {
    const graph = createMinimalDedicatedAssignmentGraph({
      genericCondition: true,
    });
    const scenario = {
      ...scenarioSnapshot(),
      nodes: graph.nodes,
      edges: graph.edges,
    };
    const plan = planInteractiveNoReplyAssignmentMigration(graph);
    const fixture = createOperatorPreimageFixture({ scenario });
    const applyMigration = jest.fn();
    const writePreimage = jest.fn();

    await expect(
      runInteractiveNoReplyMigrationOperator(
        {
          ...guardedApplyArgs(),
          expectedCount: undefined,
          expectedBeforeSha256: plan.hashes.beforeSha256,
        },
        {
          assertTimerReplanIngressReady,
          loadState: fixture.loadState,
          applyMigration,
          writePreimage,
        }
      )
    ).rejects.toMatchObject({
      code: "interactive_no_reply_unsafe_assignments",
    });
    expect(writePreimage).not.toHaveBeenCalled();
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("writes the requested exact preimage and delegates apply to the transaction service once", async () => {
    const scenario = scenarioSnapshot();
    const fixture = createOperatorPreimageFixture({
      scenario,
      pendingConversations: [
        pendingPreimageRow({
          conversationId: "conversation-alpha",
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        }),
      ],
    });
    const applyResult = {
      beforeRevision: updatedAt,
      afterRevision: "2026-08-05T12:01:00.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: ["conversation-alpha"],
      timerReplanResults: [],
      scenario: {},
    };
    const applyMigration = jest.fn().mockResolvedValue(applyResult);
    const writePreimage = jest.fn().mockResolvedValue(undefined);

    const result = await runInteractiveNoReplyMigrationOperator(
      guardedApplyArgs(fixture.exact.preimageSha256),
      {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration,
        writePreimage,
      }
    );

    expect(writePreimage).toHaveBeenCalledWith(outputPath, fixture.exact);
    expect(applyMigration).toHaveBeenCalledTimes(1);
    expect(fixture.loadState).toHaveBeenNthCalledWith(3, {
      workspaceId,
      scenarioId,
      candidatePairs: [
        {
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        },
        {
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
        },
      ],
    });
    expect(applyMigration).toHaveBeenCalledWith({
      scenarioId,
      workspaceId,
      updatedBy: "migration:interactive-no-reply",
      expectedUpdatedAt: updatedAt,
      expectedDedicatedAssignmentCount: 2,
      expectedPreimageSha256: fixture.exact.preimageSha256,
      conversions: [
        {
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
          sourceKind: "post_action_condition",
        },
        {
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
          sourceKind: "post_action_condition",
        },
      ],
    });
    expect(result).toMatchObject({
      mode: "apply",
      candidateCount: 2,
      pendingConversationCount: 1,
      applied: true,
      applyResult,
    });
  });

  it.each([
    [
      "revision",
      { expectedRevision: "2026-08-05T11:59:00.000Z" },
      "interactive_no_reply_revision_mismatch",
    ],
    [
      "graph hash",
      { expectedBeforeSha256: "a".repeat(64) },
      "interactive_no_reply_before_hash_mismatch",
    ],
  ])(
    "hard-stops an apply when the reviewed %s changed before pending reads",
    async (_label, override, code) => {
      const applyMigration = jest.fn();
      const writePreimage = jest.fn();
      const fixture = createOperatorPreimageFixture();

      await expect(
        runInteractiveNoReplyMigrationOperator(
          { ...guardedApplyArgs(), ...override },
          {
            assertTimerReplanIngressReady,
            loadState: fixture.loadState,
            applyMigration,
            writePreimage,
          }
        )
      ).rejects.toMatchObject({ code });

      expect(fixture.loadState).toHaveBeenCalledTimes(1);
      expect(writePreimage).not.toHaveBeenCalled();
      expect(applyMigration).not.toHaveBeenCalled();
    }
  );

  it("hard-stops an apply when the exact external-state preimage differs from the reviewed digest", async () => {
    const applyMigration = jest.fn();
    const writePreimage = jest.fn();
    const fixture = createOperatorPreimageFixture();

    await expect(
      runInteractiveNoReplyMigrationOperator(guardedApplyArgs("a".repeat(64)), {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration,
        writePreimage,
      })
    ).rejects.toMatchObject({
      code: "interactive_no_reply_preimage_hash_mismatch",
    });

    expect(fixture.loadState).toHaveBeenCalledTimes(2);
    expect(writePreimage).not.toHaveBeenCalled();
    expect(applyMigration).not.toHaveBeenCalled();
  });

  it("emits the committed transaction result before surfacing a timer-replan error", async () => {
    const postCommitWarnings = [
      {
        code: "legacy_action_routing_timer_replan_failed" as const,
        message: "Timer recovery is pending.",
        affectedConversationIds: ["conversation-beta"],
        recoveryStatus: "pending" as const,
        retryable: true,
      },
      {
        code: "legacy_action_routing_session_cleanup_failed" as const,
        message: "Session cleanup failed.",
        affectedConversationIds: [],
      },
    ];
    const committedResult = {
      beforeRevision: updatedAt,
      afterRevision: "2026-08-05T12:01:00.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: ["conversation-alpha", "conversation-beta"],
      timerReplanResults: [
        {
          conversationId: "conversation-alpha",
          status: "replanned" as const,
          conditionNodeId: "__system:action-outcomes:action-alpha",
          sourceActionNodeId: "action-alpha",
        },
      ],
      postCommitWarnings,
      scenario: {},
    };
    const timerFailure = {
      conversationId: "conversation-beta",
      status: "rejected" as const,
      reason: "temporal unavailable",
    };
    const serviceError = Object.assign(
      new Error("Legacy routing committed, but timer replanning failed."),
      {
        code: "legacy_action_routing_timer_replan_failed",
        committed: true,
        committedResult,
        timerReplanFailures: [timerFailure],
      }
    );
    const events: InteractiveNoReplyMigrationEvent[] = [];
    const fixture = createOperatorPreimageFixture();

    await expect(
      runInteractiveNoReplyMigrationOperator(guardedApplyArgs(), {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration: jest.fn().mockRejectedValue(serviceError),
        writePreimage: jest.fn().mockResolvedValue(undefined),
        emit: event => events.push(event),
      })
    ).rejects.toBe(serviceError);

    expect(
      events.find(event => event.type === "migration_apply_result")
    ).toEqual({
      type: "migration_apply_result",
      beforeRevision: updatedAt,
      afterRevision: "2026-08-05T12:01:00.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: ["conversation-alpha", "conversation-beta"],
      timerReplanResults: committedResult.timerReplanResults,
      postCommitWarnings,
    });
    expect(fixture.loadState).toHaveBeenCalledTimes(3);
    expect(events.at(-1)).toEqual({
      type: "migration_post_commit_wait_verification",
      candidatePairs: [
        {
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        },
        {
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
        },
      ],
      remainingConversationIds: [],
      remainingLinkedConditionIds: [],
      passed: true,
    });
    expect(buildInteractiveNoReplyMigrationErrorEvent(serviceError)).toEqual({
      type: "migration_error",
      code: "legacy_action_routing_timer_replan_failed",
      message: "Legacy routing committed, but timer replanning failed.",
      committed: true,
      timerReplanFailures: [timerFailure],
      postCommitWarnings,
    });
  });

  it.each([
    ["finds remaining waits", "remaining" as const],
    ["cannot complete the verification query", "throws" as const],
  ])(
    "preserves timer-replan failures when post-commit verification %s",
    async (_label, verificationFailure) => {
      const committedResult = {
        beforeRevision: updatedAt,
        afterRevision: "2026-08-05T12:01:00.000Z",
        convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
        convertedActionNodeIds: ["action-alpha", "action-beta"],
        remappedConversationIds: ["conversation-alpha"],
        timerReplanResults: [],
        scenario: {},
      };
      const timerFailure = {
        conversationId: "conversation-beta",
        status: "rejected" as const,
        reason: "temporal unavailable",
      };
      const serviceError = Object.assign(
        new Error("Legacy routing committed, but timer replanning failed."),
        {
          code: "legacy_action_routing_timer_replan_failed",
          committed: true,
          committedResult,
          timerReplanFailures: [timerFailure],
        }
      );
      const remaining = [
        {
          conversationId: "conversation-late",
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        },
      ];
      const fixture = createOperatorPreimageFixture({
        ...(verificationFailure === "remaining"
          ? {
              remainingPendingConversations: [pendingPreimageRow(remaining[0])],
            }
          : {
              verificationError: new Error("verification read unavailable"),
            }),
      });
      let terminalError: unknown;

      try {
        await runInteractiveNoReplyMigrationOperator(guardedApplyArgs(), {
          assertTimerReplanIngressReady,
          loadState: fixture.loadState,
          applyMigration: jest.fn().mockRejectedValue(serviceError),
          writePreimage: jest.fn().mockResolvedValue(undefined),
        });
      } catch (error) {
        terminalError = error;
      }

      expect(terminalError).toMatchObject({
        code:
          verificationFailure === "remaining"
            ? "interactive_no_reply_post_commit_waits_remaining"
            : "interactive_no_reply_post_commit_verification_failed",
        committed: true,
        timerReplanFailures: [timerFailure],
        priorCommittedError: {
          code: "legacy_action_routing_timer_replan_failed",
          message: "Legacy routing committed, but timer replanning failed.",
        },
      });
      expect(
        buildInteractiveNoReplyMigrationErrorEvent(terminalError)
      ).toMatchObject({
        type: "migration_error",
        committed: true,
        timerReplanFailures: [timerFailure],
        priorCommittedError: {
          code: "legacy_action_routing_timer_replan_failed",
          message: "Legacy routing committed, but timer replanning failed.",
        },
      });
    }
  );

  it("preserves a committed timer failure when an old linked parent ref remains", async () => {
    const committedResult = {
      beforeRevision: updatedAt,
      afterRevision: "2026-08-05T12:01:00.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: [],
      timerReplanResults: [],
      scenario: {},
    };
    const timerFailure = {
      conversationId: "conversation-beta",
      status: "rejected" as const,
      reason: "temporal unavailable",
    };
    const serviceError = Object.assign(new Error("timer replanning failed"), {
      code: "legacy_action_routing_timer_replan_failed",
      committed: true,
      committedResult,
      timerReplanFailures: [timerFailure],
    });
    const fixture = createOperatorPreimageFixture({
      remainingLinkedConditions: [
        {
          _id: "linked-stale",
          workspaceId,
          parentRefs: [
            {
              parentScenarioId: scenarioId,
              conditionNodeId: "legacy-alpha",
              branchType: "no_reply_timeout",
              sourceActionNodeId: "action-alpha",
              scenarioLinkNodeId: "link-alpha",
            },
          ],
          updatedAt,
          __v: 4,
        },
      ],
    });
    const events: InteractiveNoReplyMigrationEvent[] = [];

    const run = runInteractiveNoReplyMigrationOperator(guardedApplyArgs(), {
      assertTimerReplanIngressReady,
      loadState: fixture.loadState,
      applyMigration: jest.fn().mockRejectedValue(serviceError),
      writePreimage: jest.fn().mockResolvedValue(undefined),
      emit: event => events.push(event),
    });

    await expect(run).rejects.toMatchObject({
      code: "interactive_no_reply_post_commit_linked_conditions_remaining",
      committed: true,
      timerReplanFailures: [timerFailure],
      priorCommittedError: {
        code: "legacy_action_routing_timer_replan_failed",
        message: "timer replanning failed",
      },
      remainingLinkedConditionIds: ["linked-stale"],
    });
    expect(events.at(-1)).toEqual({
      type: "migration_post_commit_wait_verification",
      candidatePairs: [
        {
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        },
        {
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
        },
      ],
      remainingConversationIds: [],
      remainingLinkedConditionIds: ["linked-stale"],
      passed: false,
    });
  });

  it("hard-fails and audits when an original pending wait remains after commit", async () => {
    const applyResult = {
      beforeRevision: updatedAt,
      afterRevision: "2026-08-05T12:01:00.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: ["conversation-alpha"],
      timerReplanResults: [],
      scenario: {},
    };
    const remaining = [
      {
        conversationId: "conversation-late",
        sourceActionNodeId: "action-alpha",
        sourceNodeId: "legacy-alpha",
      },
    ];
    const events: InteractiveNoReplyMigrationEvent[] = [];
    const fixture = createOperatorPreimageFixture({
      remainingPendingConversations: [pendingPreimageRow(remaining[0])],
    });

    const run = runInteractiveNoReplyMigrationOperator(guardedApplyArgs(), {
      assertTimerReplanIngressReady,
      loadState: fixture.loadState,
      applyMigration: jest.fn().mockResolvedValue(applyResult),
      writePreimage: jest.fn().mockResolvedValue(undefined),
      emit: event => events.push(event),
    });

    await expect(run).rejects.toMatchObject({
      code: "interactive_no_reply_post_commit_waits_remaining",
      committed: true,
      committedResult: applyResult,
      remainingPendingConversations: remaining,
    });
    expect(events.at(-1)).toEqual({
      type: "migration_post_commit_wait_verification",
      candidatePairs: [
        {
          sourceActionNodeId: "action-alpha",
          sourceNodeId: "legacy-alpha",
        },
        {
          sourceActionNodeId: "action-beta",
          sourceNodeId: "legacy-beta",
        },
      ],
      remainingConversationIds: ["conversation-late"],
      remainingLinkedConditionIds: [],
      passed: false,
    });
  });

  it("hard-fails post-commit verification for a wrong-source wait on a deleted condition", async () => {
    const applyResult = {
      beforeRevision: updatedAt,
      afterRevision: "2026-08-05T12:01:00.000Z",
      convertedConditionNodeIds: ["legacy-alpha", "legacy-beta"],
      convertedActionNodeIds: ["action-alpha", "action-beta"],
      remappedConversationIds: [],
      timerReplanResults: [],
      scenario: {},
    };
    const fixture = createOperatorPreimageFixture({
      remainingPendingConversations: [
        pendingPreimageRow({
          conversationId: "conversation-wrong-source",
          sourceActionNodeId: "action-wrong",
          sourceNodeId: "legacy-alpha",
        }),
      ],
    });

    await expect(
      runInteractiveNoReplyMigrationOperator(guardedApplyArgs(), {
        assertTimerReplanIngressReady,
        loadState: fixture.loadState,
        applyMigration: jest.fn().mockResolvedValue(applyResult),
        writePreimage: jest.fn().mockResolvedValue(undefined),
      })
    ).rejects.toMatchObject({
      code: "interactive_no_reply_post_commit_waits_remaining",
      committed: true,
      remainingPendingConversations: [
        expect.objectContaining({
          conversationId: "conversation-wrong-source",
          sourceActionNodeId: "action-wrong",
          sourceNodeId: "legacy-alpha",
        }),
      ],
    });
  });
});
