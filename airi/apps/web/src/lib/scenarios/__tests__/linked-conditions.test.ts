const mockScenarioFind = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioFindById = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockScenarioStartSession = jest.fn();
const mockLinkedConditionFind = jest.fn();
const mockLinkedConditionFindOne = jest.fn();
const mockLinkedConditionUpdateOne = jest.fn();
const mockLinkedConditionUpdateMany = jest.fn();
const mockLinkedConditionDeleteOne = jest.fn();
const mockLinkedConditionDeleteMany = jest.fn();

jest.mock("@/models/scenario", () => ({
  Scenario: {
    find: (...args: unknown[]) => mockScenarioFind(...args),
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    findById: (...args: unknown[]) => mockScenarioFindById(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
    startSession: (...args: unknown[]) => mockScenarioStartSession(...args),
  },
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: {
    find: (...args: unknown[]) => mockLinkedConditionFind(...args),
    findOne: (...args: unknown[]) => mockLinkedConditionFindOne(...args),
    updateOne: (...args: unknown[]) => mockLinkedConditionUpdateOne(...args),
    updateMany: (...args: unknown[]) => mockLinkedConditionUpdateMany(...args),
    deleteOne: (...args: unknown[]) => mockLinkedConditionDeleteOne(...args),
    deleteMany: (...args: unknown[]) => mockLinkedConditionDeleteMany(...args),
  },
}));

import {
  areConditionDefinitionsEqual,
  dedupeParentRefs,
  isLinkedConditionRevisionConflict,
  LinkedConditionRevisionConflictError,
  normalizeParentRefs,
  type LinkedConditionParentRef,
} from "../linked-conditions-types";
import {
  projectLinkedConditionToParentGraph,
  buildLinkedChildTriggerData,
} from "../linked-condition-graph-projection";
import {
  ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
  ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
  getScenarioActionOutcomeVirtualNodeId,
} from "@icecore/scenario-contracts";
import {
  applyLinkedConditionToChildScenario,
  clearLinkedConditionFromChildScenario,
  detachScenarioLinkedConditionsForScenarioDeletion,
  syncParentScenariosForRecord,
  syncScenarioLinkedConditions,
} from "../linked-condition-reconciler";
import {
  loadScenarioForLinkedConditionSync,
  updateLinkedConditionDefinition,
} from "../linked-condition-repository";
import { CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION } from "../scenario-graph-migrations";

function selectedLeanQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  query.session.mockReturnValue(query);
  return query;
}

function leanQuery<T>(value: T) {
  const query = {
    session: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.session.mockReturnValue(query);
  return query;
}

function expectCanonicalGraphWrites() {
  expect(mockScenarioUpdateOne).toHaveBeenCalled();
  for (const [, update] of mockScenarioUpdateOne.mock.calls) {
    expect(update).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          graphSchemaVersion: CURRENT_SCENARIO_GRAPH_SCHEMA_VERSION,
          nodes: expect.any(Array),
          updatedAt: expect.any(Date),
        }),
      })
    );
  }
}

describe("linked-conditions types", () => {
  it("classifies graph and parent revision conflicts through one typed contract", () => {
    const graphConflict = new LinkedConditionRevisionConflictError("graph");
    const parentConflict = new LinkedConditionRevisionConflictError("parent");

    expect(isLinkedConditionRevisionConflict(graphConflict)).toBe(true);
    expect(isLinkedConditionRevisionConflict(parentConflict)).toBe(true);
    expect(
      isLinkedConditionRevisionConflict(
        new Error("linked_condition_revision_conflict")
      )
    ).toBe(true);
    expect(graphConflict.scope).toBe("graph");
    expect(parentConflict.scope).toBe("parent");
    expect(isLinkedConditionRevisionConflict(new Error("other"))).toBe(false);
  });

  it("keeps condition ownership out of the child trigger", () => {
    expect(
      buildLinkedChildTriggerData({
        linkedConditionId: "condition-1",
        data: {
          kind: "trigger",
          triggerConfig: {
            enabled: false,
            messageMatchMode: "contains",
            keywordPattern: "legacy",
          },
        },
      })
    ).toEqual({
      kind: "trigger",
      linkedConditionId: "condition-1",
      triggerConfig: {
        enabled: true,
        messageMatchMode: "any",
        keywordMatchMode: "contains",
      },
    });
  });

  describe("areConditionDefinitionsEqual", () => {
    it("returns true for matching user_replied definitions", () => {
      expect(
        areConditionDefinitionsEqual({
          leftType: "user_replied",
          leftConfig: {},
          rightType: "user_replied",
          rightConfig: {},
        })
      ).toBe(true);
    });

    it("returns true for matching no_reply_timeout definitions with normalized config", () => {
      expect(
        areConditionDefinitionsEqual({
          leftType: "no_reply_timeout",
          leftConfig: { timeoutMinutes: 30 },
          rightType: "no_reply_timeout",
          rightConfig: { timeoutMinutes: 30, missingTextPhrases: [] },
        })
      ).toBe(true);
    });

    it("returns false when condition types differ", () => {
      expect(
        areConditionDefinitionsEqual({
          leftType: "user_replied",
          leftConfig: {},
          rightType: "payment_detected",
          rightConfig: {},
        })
      ).toBe(false);
    });

    it("returns false when timeout minutes differ", () => {
      expect(
        areConditionDefinitionsEqual({
          leftType: "no_reply_timeout",
          leftConfig: { timeoutMinutes: 30 },
          rightType: "no_reply_timeout",
          rightConfig: { timeoutMinutes: 60 },
        })
      ).toBe(false);
    });

    it("returns false when missing text phrases differ", () => {
      expect(
        areConditionDefinitionsEqual({
          leftType: "no_reply_timeout",
          leftConfig: { timeoutMinutes: 30, missingTextPhrases: ["hello"] },
          rightType: "no_reply_timeout",
          rightConfig: { timeoutMinutes: 30, missingTextPhrases: ["bye"] },
        })
      ).toBe(false);
    });
  });

  describe("normalizeParentRefs", () => {
    it("parses valid parent refs and trims strings", () => {
      const refs = normalizeParentRefs([
        {
          parentScenarioId: " parent-1 ",
          conditionNodeId: "cond-1",
          branchType: "user_replied",
          sourceActionNodeId: "action-1",
          scenarioLinkNodeId: "link-1",
        },
      ]);

      expect(refs).toEqual([
        {
          parentScenarioId: "parent-1",
          conditionNodeId: "cond-1",
          branchType: "user_replied",
          sourceActionNodeId: "action-1",
          scenarioLinkNodeId: "link-1",
        },
      ]);
    });

    it("drops refs with missing or invalid fields", () => {
      expect(
        normalizeParentRefs([
          {
            parentScenarioId: "parent-1",
            conditionNodeId: "",
            branchType: "user_replied",
            sourceActionNodeId: "action-1",
            scenarioLinkNodeId: "link-1",
          },
          {
            parentScenarioId: "parent-2",
            conditionNodeId: "cond-2",
            branchType: "invalid_type",
            sourceActionNodeId: "action-2",
            scenarioLinkNodeId: "link-2",
          },
        ])
      ).toEqual([]);
    });

    it("returns empty array for non-array input", () => {
      expect(normalizeParentRefs(undefined)).toEqual([]);
    });
  });

  describe("dedupeParentRefs", () => {
    const baseRef: LinkedConditionParentRef = {
      parentScenarioId: "parent-1",
      conditionNodeId: "cond-1",
      branchType: "user_replied",
      sourceActionNodeId: "action-1",
      scenarioLinkNodeId: "link-1",
    };

    it("removes duplicate parent refs", () => {
      expect(dedupeParentRefs([baseRef, { ...baseRef }])).toEqual([baseRef]);
    });

    it("preserves distinct refs", () => {
      const otherRef: LinkedConditionParentRef = {
        ...baseRef,
        scenarioLinkNodeId: "link-2",
      };

      expect(dedupeParentRefs([baseRef, otherRef])).toEqual([
        baseRef,
        otherRef,
      ]);
    });

    it("preserves distinct refs whose IDs contain delimiter characters", () => {
      const sourceContainsColon: LinkedConditionParentRef = {
        ...baseRef,
        sourceActionNodeId: "action:variant",
        scenarioLinkNodeId: "link",
      };
      const linkContainsColon: LinkedConditionParentRef = {
        ...baseRef,
        sourceActionNodeId: "action",
        scenarioLinkNodeId: "variant:link",
      };

      expect(
        dedupeParentRefs([sourceContainsColon, linkContainsColon])
      ).toEqual([sourceContainsColon, linkContainsColon]);
    });

    it("keeps first occurrence order", () => {
      const secondRef: LinkedConditionParentRef = {
        ...baseRef,
        conditionNodeId: "cond-2",
      };

      expect(dedupeParentRefs([baseRef, secondRef, baseRef])).toEqual([
        baseRef,
        secondRef,
      ]);
    });
  });
});

describe("action-owned linked conditions", () => {
  it("writes linked no-reply metadata and canonical edges on the action", () => {
    const result = projectLinkedConditionToParentGraph({
      scenario: {
        _id: "parent",
        nodes: [
          {
            id: "action-1",
            data: {
              kind: "action",
              actionOutcomes: {
                version: 1,
                noReply: { enabled: true, timeoutMinutes: 30 },
              },
            },
          },
          {
            id: "link-1",
            data: { kind: "scenario_link", linkedScenarioId: "child" },
          },
        ],
        edges: [
          {
            id: "edge-1",
            source: "action-1",
            sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
            target: "link-1",
          },
        ],
      },
      recordId: "record-1",
      childScenarioId: "child",
      conditionType: "no_reply_timeout",
      conditionConfig: {
        timeoutMinutes: 90,
        missingTextPhrases: ["stop"],
      },
      parentRefs: [
        {
          parentScenarioId: "parent",
          conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action-1"),
          branchType: "no_reply_timeout",
          sourceActionNodeId: "action-1",
          scenarioLinkNodeId: "link-1",
        },
      ],
    });

    expect(result.changed).toBe(true);
    expect(result.nodes[0]?.data).toMatchObject({
      actionOutcomes: {
        noReply: {
          enabled: true,
          timeoutMinutes: 90,
          cancelIfPhrases: ["stop"],
          linkedConditionId: "record-1",
        },
      },
    });
    expect(result.edges[0]).toMatchObject({
      source: "action-1",
      sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
      target: "link-1",
    });
  });
});

describe("linked-condition repository and reconciliation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScenarioUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockLinkedConditionUpdateOne.mockResolvedValue({});
    mockLinkedConditionUpdateMany.mockResolvedValue({});
    mockLinkedConditionDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockLinkedConditionDeleteMany.mockResolvedValue({});
    mockScenarioStartSession.mockResolvedValue({
      withTransaction: jest.fn(async callback => callback()),
      endSession: jest.fn().mockResolvedValue(undefined),
    });
  });

  it("does not write an already-canonical child projection", async () => {
    const childScenario = {
      _id: "child-1",
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            linkedConditionId: "record-1",
            triggerConfig: {
              enabled: true,
              messageMatchMode: "any",
              keywordMatchMode: "contains",
            },
          },
        },
      ],
      edges: [],
    };
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(childScenario));

    await applyLinkedConditionToChildScenario({
      workspaceId: "workspace-1",
      childScenario,
      recordId: "record-1",
    });

    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("writes changed child graphs through the canonical graph boundary", async () => {
    const childScenario = {
      _id: "child-1",
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: {
              messageMatchMode: "contains",
              keywordPattern: "legacy",
            },
          },
        },
      ],
      edges: [],
    };
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(childScenario));

    await applyLinkedConditionToChildScenario({
      workspaceId: "workspace-1",
      childScenario,
      recordId: "record-1",
    });

    expectCanonicalGraphWrites();
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      {
        _id: "child-1",
        workspaceId: "workspace-1",
        deletedAt: null,
        status: "draft",
        updatedAt: childScenario.updatedAt,
      },
      {
        $set: expect.objectContaining({
          nodes: [
            expect.objectContaining({
              data: expect.objectContaining({
                kind: "trigger",
                linkedConditionId: "record-1",
                triggerConfig: {
                  enabled: true,
                  messageMatchMode: "any",
                  keywordMatchMode: "contains",
                },
              }),
            }),
          ],
        }),
      },
      { timestamps: false }
    );
  });

  it("reprojects a child linkage after a concurrent graph edit", async () => {
    const initialRevision = new Date("2026-07-30T10:00:00.000Z");
    const concurrentRevision = new Date("2026-07-30T10:01:00.000Z");
    const initialChild = {
      _id: "child-1",
      nodes: [
        {
          id: "trigger-1",
          data: {
            kind: "trigger",
            triggerConfig: {
              messageMatchMode: "contains",
              keywordPattern: "legacy",
            },
          },
        },
        {
          id: "action-1",
          data: { kind: "action", actionReplyText: "before" },
        },
      ],
      edges: [],
      updatedAt: initialRevision,
    };
    const concurrentChild = {
      ...initialChild,
      nodes: initialChild.nodes.map(node =>
        node.id === "action-1"
          ? {
              ...node,
              data: {
                ...node.data,
                actionReplyText: "concurrent",
              },
            }
          : node
      ),
      updatedAt: concurrentRevision,
    };
    mockScenarioFindOne
      .mockReturnValueOnce(selectedLeanQuery(initialChild))
      .mockReturnValueOnce(selectedLeanQuery(concurrentChild));
    mockScenarioUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });

    await applyLinkedConditionToChildScenario({
      workspaceId: "workspace-1",
      childScenario: initialChild,
      recordId: "record-1",
    });

    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne.mock.calls[1]?.[0]).toEqual({
      _id: "child-1",
      workspaceId: "workspace-1",
      deletedAt: null,
      status: "draft",
      updatedAt: concurrentRevision,
    });
    expect(mockScenarioUpdateOne.mock.calls[1]?.[1]?.$set?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "trigger-1",
          data: expect.objectContaining({
            linkedConditionId: "record-1",
          }),
        }),
        expect.objectContaining({
          id: "action-1",
          data: expect.objectContaining({
            actionReplyText: "concurrent",
          }),
        }),
      ])
    );
  });

  it("scopes direct linked-record definition updates to the workspace", async () => {
    await updateLinkedConditionDefinition({
      workspaceId: "workspace-1",
      recordId: "record-1",
      childTriggerNodeId: "trigger-1",
      conditionType: "user_replied",
      conditionConfig: {},
    });
    expect(mockLinkedConditionUpdateOne.mock.calls[0]?.[0]).toEqual({
      _id: "record-1",
      workspaceId: "workspace-1",
    });
    expect(mockLinkedConditionUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("excludes deleted and foreign-workspace scenarios from linked-condition reads", async () => {
    mockScenarioFindOne.mockReturnValue(selectedLeanQuery(null));

    await loadScenarioForLinkedConditionSync({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
    });

    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: "scenario-1",
      workspaceId: "workspace-1",
      deletedAt: null,
    });
  });

  it("scopes parent reads to the workspace and versions parent graph writes", async () => {
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "parent-1",
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        nodes: [
          {
            id: "action-1",
            data: {
              kind: "action",
              actionOutcomes: {
                version: 1,
                noReply: { enabled: true, timeoutMinutes: 30 },
              },
            },
          },
          {
            id: "link-1",
            data: { kind: "scenario_link", linkedScenarioId: "child-1" },
          },
        ],
        edges: [
          {
            id: "edge-1",
            source: "action-1",
            sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
            target: "link-1",
          },
        ],
      })
    );

    await syncParentScenariosForRecord({
      workspaceId: "workspace-1",
      record: {
        _id: "record-1",
        childScenarioId: "child-1",
        childTriggerNodeId: "trigger-1",
        conditionType: "no_reply_timeout",
        conditionConfig: { timeoutMinutes: 90 },
        parentRefs: [
          {
            parentScenarioId: "parent-1",
            conditionNodeId: getScenarioActionOutcomeVirtualNodeId("action-1"),
            branchType: "no_reply_timeout",
            sourceActionNodeId: "action-1",
            scenarioLinkNodeId: "link-1",
          },
        ],
      },
    });

    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: "parent-1",
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    expectCanonicalGraphWrites();
    expect(mockScenarioUpdateOne.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          edges: [
            expect.objectContaining({
              sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
            }),
          ],
        }),
      })
    );
  });

  it("clears child linkage only when present and uses the graph boundary", async () => {
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "child-1",
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              linkedConditionId: "record-1",
              triggerConfig: {
                enabled: true,
                messageMatchMode: "any",
                keywordMatchMode: "contains",
              },
            },
          },
        ],
      })
    );

    await clearLinkedConditionFromChildScenario({
      workspaceId: "workspace-1",
      childScenarioId: "child-1",
      linkedConditionId: "record-1",
    });

    expect(mockScenarioFindOne).toHaveBeenCalledWith({
      _id: "child-1",
      workspaceId: "workspace-1",
      deletedAt: null,
    });
    expectCanonicalGraphWrites();
    expect(
      mockScenarioUpdateOne.mock.calls[0]?.[1]?.$set?.nodes?.[0]?.data
    ).not.toHaveProperty("linkedConditionId");
  });

  it("rejects conflicting child reuse without writing records", async () => {
    const revision = new Date("2026-07-30T10:00:00.000Z");
    const existingRecord = {
      _id: "record-1",
      __v: 2,
      workspaceId: "workspace-1",
      childScenarioId: "child-1",
      childTriggerNodeId: "trigger-1",
      conditionType: "user_replied",
      conditionConfig: {},
      parentRefs: [
        {
          parentScenarioId: "other-parent",
          conditionNodeId:
            getScenarioActionOutcomeVirtualNodeId("other-action"),
          branchType: "user_replied",
          sourceActionNodeId: "other-action",
          scenarioLinkNodeId: "other-link",
        },
      ],
    };
    mockLinkedConditionFind
      .mockReturnValueOnce(leanQuery([]))
      .mockReturnValueOnce(leanQuery([]))
      .mockReturnValueOnce(leanQuery([existingRecord]))
      .mockReturnValueOnce(leanQuery([existingRecord]));
    mockScenarioFind
      .mockReturnValueOnce(
        selectedLeanQuery([
          {
            _id: "child-1",
            nodes: [{ id: "trigger-1", data: { kind: "trigger" } }],
          },
        ])
      )
      .mockReturnValueOnce(
        selectedLeanQuery([
          {
            _id: "child-1",
            __v: 2,
            updatedAt: revision,
            nodes: [{ id: "trigger-1", data: { kind: "trigger" } }],
            edges: [],
          },
          {
            _id: "parent-1",
            __v: 4,
            updatedAt: revision,
            nodes: [
              {
                id: "action-1",
                data: {
                  kind: "action",
                  actionOutcomes: {
                    version: 1,
                    noReply: { enabled: true, timeoutMinutes: 30 },
                  },
                },
              },
              {
                id: "link-1",
                data: { kind: "scenario_link", linkedScenarioId: "child-1" },
              },
            ],
            edges: [
              {
                id: "edge-1",
                source: "action-1",
                sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
                target: "link-1",
              },
            ],
          },
          {
            _id: "other-parent",
            __v: 1,
            updatedAt: revision,
            nodes: [
              {
                id: "other-action",
                data: {
                  kind: "action",
                  actionOutcomes: {
                    version: 1,
                    anyReply: { enabled: true },
                  },
                },
              },
              {
                id: "other-link",
                data: { kind: "scenario_link", linkedScenarioId: "child-1" },
              },
            ],
            edges: [
              {
                id: "other-edge",
                source: "other-action",
                sourceHandle: ACTION_ANY_REPLY_OUTCOME_HANDLE_ID,
                target: "other-link",
              },
            ],
          },
        ])
      );

    await expect(
      syncScenarioLinkedConditions({
        workspaceId: "workspace-1",
        scenarioId: "parent-1",
        scenario: {
          _id: "parent-1",
          __v: 4,
          updatedAt: revision,
          nodes: [
            {
              id: "action-1",
              data: {
                kind: "action",
                actionOutcomes: {
                  version: 1,
                  noReply: { enabled: true, timeoutMinutes: 30 },
                },
              },
            },
            {
              id: "link-1",
              data: { kind: "scenario_link", linkedScenarioId: "child-1" },
            },
          ],
          edges: [
            {
              id: "edge-1",
              source: "action-1",
              sourceHandle: ACTION_NO_REPLY_OUTCOME_HANDLE_ID,
              target: "link-1",
            },
          ],
        },
      })
    ).rejects.toThrow("linked_condition_conflicting_child_reuse");

    expect(mockLinkedConditionUpdateOne).not.toHaveBeenCalled();
    expect(mockScenarioFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      _id: { $in: ["child-1"] },
      deletedAt: null,
    });
  });

  it("deletes detached records and clears the surviving child graph", async () => {
    const deletedAt = new Date("2026-07-30T10:02:00.000Z");
    mockLinkedConditionFindOne.mockReturnValue(leanQuery(null));
    mockLinkedConditionFind.mockReturnValue(
      leanQuery([
        {
          _id: "record-1",
          __v: 2,
          childScenarioId: "child-1",
          childTriggerNodeId: "trigger-1",
          conditionType: "user_replied",
          conditionConfig: {},
          parentRefs: [
            {
              parentScenarioId: "parent-1",
              conditionNodeId: "condition-1",
              branchType: "user_replied",
              sourceActionNodeId: "action-1",
              scenarioLinkNodeId: "link-1",
            },
          ],
        },
      ])
    );
    mockScenarioFind.mockReturnValue(
      selectedLeanQuery([
        {
          _id: "child-1",
          __v: 3,
          updatedAt: new Date("2026-07-30T10:00:00.000Z"),
          nodes: [
            {
              id: "trigger-1",
              data: {
                kind: "trigger",
                linkedConditionId: "record-1",
              },
            },
          ],
          edges: [],
        },
        {
          _id: "parent-1",
          __v: 6,
          updatedAt: deletedAt,
          deletedAt,
          nodes: [],
          edges: [],
        },
      ])
    );
    mockScenarioFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "child-1",
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        nodes: [
          {
            id: "trigger-1",
            data: {
              kind: "trigger",
              linkedConditionId: "record-1",
              triggerConfig: {
                enabled: true,
                messageMatchMode: "any",
                keywordMatchMode: "contains",
              },
            },
          },
        ],
      })
    );

    await detachScenarioLinkedConditionsForScenarioDeletion({
      workspaceId: "workspace-1",
      scenarioId: "parent-1",
      expectedUpdatedAt: deletedAt,
    });

    expect(mockLinkedConditionFindOne).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      childScenarioId: "parent-1",
    });
    expect(mockLinkedConditionFind).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      "parentRefs.parentScenarioId": "parent-1",
    });
    expect(mockLinkedConditionDeleteOne).toHaveBeenCalledWith(
      {
        _id: "record-1",
        workspaceId: "workspace-1",
        __v: 2,
      },
      { session: expect.any(Object) }
    );
    const childGraphWrite = mockScenarioUpdateOne.mock.calls.find(
      ([filter, update]) =>
        filter?._id === "child-1" && Array.isArray(update?.$set?.nodes)
    );
    expect(childGraphWrite).toBeDefined();
    expect(childGraphWrite?.[1]?.$set?.nodes?.[0]?.data).not.toHaveProperty(
      "linkedConditionId"
    );
  });
});
