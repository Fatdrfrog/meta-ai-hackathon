const mockScenarioCollectionFindOne = jest.fn();
const mockConversationCollectionFind = jest.fn();
const mockLinkedConditionCollectionFind = jest.fn();
const mockConversationListIndexes = jest.fn();

const pendingWaitIndexName = "conversations_workspace_scenario_pending_wait_v2";
const pendingWaitIndexKeys = {
  workspaceId: 1,
  "airi_scenario_state.lockedScenarioId": 1,
  "airi_scenario_state.pendingConditionNodeId": 1,
  "airi_scenario_state.pendingSourceActionNodeId": 1,
};
const pendingWaitPartialFilter = {
  "airi_scenario_state.lockedScenarioId": { $type: "string" },
  "airi_scenario_state.pendingConditionNodeId": { $type: "string" },
};

jest.mock("@/models/scenario", () => ({
  Scenario: {
    collection: {
      findOne: (...args: unknown[]) => mockScenarioCollectionFindOne(...args),
    },
  },
}));

jest.mock("@/models/conversation", () => ({
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS: {
    workspaceId: 1,
    "airi_scenario_state.lockedScenarioId": 1,
    "airi_scenario_state.pendingConditionNodeId": 1,
    "airi_scenario_state.pendingSourceActionNodeId": 1,
  },
  CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME:
    "conversations_workspace_scenario_pending_wait_v2",
  CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER: {
    "airi_scenario_state.lockedScenarioId": { $type: "string" },
    "airi_scenario_state.pendingConditionNodeId": { $type: "string" },
  },
  Conversation: {
    collection: {
      find: (...args: unknown[]) => mockConversationCollectionFind(...args),
      listIndexes: (...args: unknown[]) => mockConversationListIndexes(...args),
    },
  },
}));

jest.mock("@/models/scenario-linked-condition", () => ({
  __esModule: true,
  default: {
    collection: {
      find: (...args: unknown[]) => mockLinkedConditionCollectionFind(...args),
    },
  },
}));

import {
  buildLegacyRoutingMigrationPreimage,
  classifyLegacyRoutingMigrationExternalState,
  loadLegacyRoutingMigrationState,
} from "./legacy-routing-migration-preimage";
import mongoose, { Types } from "mongoose";

const workspaceId = "workspace-1";
const scenarioId = "65f000000000000000000001";
const updatedAt = new Date("2026-08-05T12:00:00.000Z");

async function loadPreimageForTest(
  params: Parameters<typeof loadLegacyRoutingMigrationState>[0]
) {
  return (await loadLegacyRoutingMigrationState(params))?.preimage ?? null;
}

const pairs = [
  { sourceActionNodeId: "action-beta", sourceNodeId: "condition-beta" },
  { sourceActionNodeId: "action-alpha", sourceNodeId: "condition-alpha" },
];

function rawSnapshot(): Parameters<
  typeof buildLegacyRoutingMigrationPreimage
>[0] {
  return {
    target: { workspaceId, scenarioId, candidatePairs: pairs },
    scenario: {
      _id: { toHexString: () => scenarioId },
      workspaceId,
      graphSchemaVersion: 7,
      nodes: [{ id: "action-alpha", data: { kind: "action" } }],
      edges: [{ id: "edge-1", source: "action-alpha", target: "target" }],
      status: "draft",
      updatedBy: "operator-1",
      updatedAt,
      __v: 4,
    },
    pendingConversations: [
      {
        _id: { toHexString: () => "conversation-beta" },
        workspaceId,
        airi_scenario_state: {
          lockedScenarioId: scenarioId,
          pendingConditionNodeId: "condition-beta",
          pendingSourceActionNodeId: "action-beta",
          pendingStartedAt: new Date("2026-08-05T11:00:00.000Z"),
        },
        updatedAt: new Date("2026-08-05T11:30:00.000Z"),
        __v: undefined,
      },
      {
        _id: "conversation-alpha",
        workspaceId,
        airi_scenario_state: {
          lockedScenarioId: scenarioId,
          pendingConditionNodeId: "condition-alpha",
          pendingSourceActionNodeId: "action-alpha",
        },
        updatedAt: new Date("2026-08-05T11:20:00.000Z"),
        __v: 2,
      },
    ],
    linkedConditions: [
      {
        _id: "linked-beta",
        workspaceId,
        parentRefs: [
          {
            parentScenarioId: scenarioId,
            conditionNodeId: "condition-beta",
            branchType: "no_reply_timeout",
            sourceActionNodeId: "action-beta",
            scenarioLinkNodeId: "link-beta",
          },
          {
            parentScenarioId: "another-scenario",
            conditionNodeId: "another-condition",
            branchType: "user_replied",
            sourceActionNodeId: "another-action",
            scenarioLinkNodeId: "another-link",
          },
        ],
        updatedAt: new Date("2026-08-05T10:00:00.000Z"),
        __v: 8,
      },
    ],
  };
}

describe("buildLegacyRoutingMigrationPreimage", () => {
  it("captures the exact restorable scenario, conversations, linked refs, and sorted target", () => {
    const preimage = buildLegacyRoutingMigrationPreimage(rawSnapshot());

    const expectedPayload = {
      version: 1,
      target: {
        workspaceId,
        scenarioId,
        candidatePairs: [
          {
            sourceActionNodeId: "action-alpha",
            sourceNodeId: "condition-alpha",
          },
          {
            sourceActionNodeId: "action-beta",
            sourceNodeId: "condition-beta",
          },
        ],
      },
      scenario: {
        _id: scenarioId,
        workspaceId,
        graphSchemaVersion: 7,
        nodes: [{ id: "action-alpha", data: { kind: "action" } }],
        edges: [{ id: "edge-1", source: "action-alpha", target: "target" }],
        status: "draft",
        updatedBy: "operator-1",
        updatedAt: "2026-08-05T12:00:00.000Z",
        __v: 4,
      },
      pendingConversations: [
        {
          _id: "conversation-alpha",
          workspaceId,
          airi_scenario_state: {
            lockedScenarioId: scenarioId,
            pendingConditionNodeId: "condition-alpha",
            pendingSourceActionNodeId: "action-alpha",
          },
          updatedAt: "2026-08-05T11:20:00.000Z",
          __v: 2,
        },
        {
          _id: "conversation-beta",
          workspaceId,
          airi_scenario_state: {
            lockedScenarioId: scenarioId,
            pendingConditionNodeId: "condition-beta",
            pendingSourceActionNodeId: "action-beta",
            pendingStartedAt: {
              $airiBson: {
                type: "Date",
                value: { $date: { $numberLong: "1785927600000" } },
              },
            },
          },
          updatedAt: "2026-08-05T11:30:00.000Z",
          __v: null,
        },
      ],
      linkedConditions: [
        {
          _id: "linked-beta",
          workspaceId,
          parentRefs: [
            {
              parentScenarioId: scenarioId,
              conditionNodeId: "condition-beta",
              branchType: "no_reply_timeout",
              sourceActionNodeId: "action-beta",
              scenarioLinkNodeId: "link-beta",
            },
            {
              parentScenarioId: "another-scenario",
              conditionNodeId: "another-condition",
              branchType: "user_replied",
              sourceActionNodeId: "another-action",
              scenarioLinkNodeId: "another-link",
            },
          ],
          updatedAt: "2026-08-05T10:00:00.000Z",
          __v: 8,
        },
      ],
    };
    expect(preimage).toEqual({
      ...expectedPayload,
      preimageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("hashes an explicit empty external-state set and missing versions deterministically", () => {
    const input = rawSnapshot();
    input.scenario.__v = undefined;
    input.pendingConversations = [];
    input.linkedConditions = [];

    const first = buildLegacyRoutingMigrationPreimage(input);
    const second = buildLegacyRoutingMigrationPreimage({
      ...input,
      target: { ...input.target, candidatePairs: [...pairs].reverse() },
    });

    expect(first).toEqual(second);
    expect(first.scenario.__v).toBeNull();
    expect(first.pendingConversations).toEqual([]);
    expect(first.linkedConditions).toEqual([]);
    expect(first.preimageSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    [
      "added conversation",
      (input: ReturnType<typeof rawSnapshot>) => {
        input.pendingConversations.push({
          ...input.pendingConversations[0],
          _id: "conversation-added",
        });
      },
    ],
    [
      "removed conversation",
      (input: ReturnType<typeof rawSnapshot>) => {
        input.pendingConversations.pop();
      },
    ],
    [
      "conversation version",
      (input: ReturnType<typeof rawSnapshot>) => {
        input.pendingConversations[0].__v = 99;
      },
    ],
    [
      "linked record version",
      (input: ReturnType<typeof rawSnapshot>) => {
        input.linkedConditions[0].__v = 99;
      },
    ],
  ])("changes the digest when the %s changes", (_label, mutate) => {
    const before = buildLegacyRoutingMigrationPreimage(rawSnapshot());
    const changed = rawSnapshot();
    mutate(changed);

    expect(
      buildLegacyRoutingMigrationPreimage(changed).preimageSha256
    ).not.toBe(before.preimageSha256);
  });

  it("hashes a valid graph larger than the shared serializer limit", () => {
    const input = rawSnapshot();
    input.scenario.nodes = [
      {
        id: "large-node",
        data: { forwardCompatiblePayload: "x".repeat(1_250_000) },
      },
    ];

    const first = buildLegacyRoutingMigrationPreimage(input);
    const second = buildLegacyRoutingMigrationPreimage(input);

    expect(first.preimageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.preimageSha256).toBe(first.preimageSha256);
  });

  it("keeps BSON Date and ObjectId evidence distinct from equal-looking strings", () => {
    const date = new Date("2026-08-05T08:00:00.000Z");
    const objectId = new Types.ObjectId("64b000000000000000000001");
    const bsonInput = rawSnapshot();
    bsonInput.scenario.nodes = [{ id: "typed-node", data: { date, objectId } }];
    const stringInput = rawSnapshot();
    stringInput.scenario.nodes = [
      {
        id: "typed-node",
        data: {
          date: "2026-08-05T08:00:00.000Z",
          objectId: "64b000000000000000000001",
        },
      },
    ];

    const bsonPreimage = buildLegacyRoutingMigrationPreimage(bsonInput);
    const stringPreimage = buildLegacyRoutingMigrationPreimage(stringInput);

    expect(bsonPreimage.preimageSha256).not.toBe(stringPreimage.preimageSha256);
    expect(
      (
        (bsonPreimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).date
    ).toEqual({
      $airiBson: {
        type: "Date",
        value: { $date: { $numberLong: "1785916800000" } },
      },
    });
    expect(
      (
        (bsonPreimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).objectId
    ).toEqual({
      $airiBson: {
        type: "ObjectId",
        value: { $oid: "64b000000000000000000001" },
      },
    });
  });

  it("tags UUID as binary evidence that the BSON decoder can round-trip", () => {
    const uuid = new mongoose.mongo.UUID(
      "00112233-4455-6677-8899-aabbccddeeff"
    );
    const input = rawSnapshot();
    input.scenario.nodes = [{ id: "uuid-node", data: { uuid } }];

    const preimage = buildLegacyRoutingMigrationPreimage(input);
    const encoded = (
      (
        (preimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).uuid as Record<string, Record<string, unknown>>
    ).$airiBson;

    expect(encoded).toEqual({
      type: "Binary",
      value: {
        $binary: {
          base64: "ABEiM0RVZneImaq7zN3u/w==",
          subType: "04",
        },
      },
    });
    const decoded = mongoose.mongo.BSON.EJSON.deserialize(
      encoded.value as Parameters<
        typeof mongoose.mongo.BSON.EJSON.deserialize
      >[0],
      { relaxed: false }
    ) as InstanceType<typeof mongoose.mongo.Binary>;
    expect(decoded._bsontype).toBe("Binary");
    expect(decoded.sub_type).toBe(mongoose.mongo.Binary.SUBTYPE_UUID);
    expect(Buffer.from(decoded.buffer)).toEqual(Buffer.from(uuid.buffer));
  });

  it("escapes literal documents shaped like the reserved BSON tag", () => {
    const dateInput = rawSnapshot();
    dateInput.scenario.nodes = [
      {
        id: "tag-node",
        data: { value: new Date("2026-08-05T08:00:00.000Z") },
      },
    ];
    const literalInput = rawSnapshot();
    literalInput.scenario.nodes = [
      {
        id: "tag-node",
        data: {
          value: {
            $airiBson: {
              type: "Date",
              value: { $date: { $numberLong: "1785916800000" } },
            },
          },
        },
      },
    ];

    const datePreimage = buildLegacyRoutingMigrationPreimage(dateInput);
    const literalPreimage = buildLegacyRoutingMigrationPreimage(literalInput);

    expect(datePreimage.preimageSha256).not.toBe(
      literalPreimage.preimageSha256
    );
    expect(
      (
        (literalPreimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).value
    ).toEqual({
      $airiBson: {
        type: "Document",
        value: [
          [
            "$airiBson",
            {
              type: "Date",
              value: { $date: { $numberLong: "1785916800000" } },
            },
          ],
        ],
      },
    });
  });

  it("keeps a plain document with a driver-like type field as a document", () => {
    const input = rawSnapshot();
    input.scenario.nodes = [
      {
        id: "plain-node",
        data: {
          value: { _bsontype: "customer-metadata", content: "preserved" },
        },
      },
    ];

    const preimage = buildLegacyRoutingMigrationPreimage(input);

    expect(
      (
        (preimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).value
    ).toEqual({ _bsontype: "customer-metadata", content: "preserved" });
  });

  it("classifies missing and wrong source actions without omitting reviewed rows", () => {
    const input = rawSnapshot();
    input.pendingConversations = [
      {
        _id: "conversation-missing-source",
        workspaceId,
        airi_scenario_state: {
          lockedScenarioId: scenarioId,
          pendingConditionNodeId: "condition-alpha",
        },
      },
      {
        _id: "conversation-wrong-source",
        workspaceId,
        airi_scenario_state: {
          lockedScenarioId: scenarioId,
          pendingConditionNodeId: "condition-beta",
          pendingSourceActionNodeId: "action-wrong",
        },
      },
    ];
    input.linkedConditions = [
      {
        _id: "linked-near-misses",
        workspaceId,
        parentRefs: [
          {
            parentScenarioId: scenarioId,
            conditionNodeId: "condition-alpha",
            branchType: "no_reply_timeout",
            scenarioLinkNodeId: "link-missing-source",
          },
          {
            parentScenarioId: scenarioId,
            conditionNodeId: "condition-beta",
            branchType: "no_reply_timeout",
            sourceActionNodeId: "action-wrong",
            scenarioLinkNodeId: "link-wrong-source",
          },
        ],
      },
    ];

    const preimage = buildLegacyRoutingMigrationPreimage(input);

    expect(preimage.pendingConversations.map(row => row._id)).toEqual([
      "conversation-missing-source",
      "conversation-wrong-source",
    ]);
    expect(preimage.linkedConditions.map(row => row._id)).toEqual([
      "linked-near-misses",
    ]);
    expect(classifyLegacyRoutingMigrationExternalState(preimage)).toEqual([
      expect.objectContaining({
        kind: "pending_conversation",
        recordId: "conversation-missing-source",
        reason: "missing_source_action",
      }),
      expect.objectContaining({
        kind: "pending_conversation",
        recordId: "conversation-wrong-source",
        reason: "wrong_source_action",
      }),
      expect.objectContaining({
        kind: "linked_condition_parent_ref",
        recordId: "linked-near-misses",
        parentRefIndex: 0,
        reason: "missing_source_action",
      }),
      expect.objectContaining({
        kind: "linked_condition_parent_ref",
        recordId: "linked-near-misses",
        parentRefIndex: 1,
        reason: "wrong_source_action",
      }),
    ]);
  });
});

function cursorReturning(value: unknown[]) {
  return { toArray: jest.fn().mockResolvedValue(value) };
}

function mockPendingWaitIndexes(indexes: Array<Record<string, unknown>>): void {
  mockConversationListIndexes.mockReturnValue({
    toArray: jest.fn().mockResolvedValue(indexes),
  });
}

function validPendingWaitIndex(): Record<string, unknown> {
  return {
    name: pendingWaitIndexName,
    key: pendingWaitIndexKeys,
    partialFilterExpression: pendingWaitPartialFilter,
  };
}

describe("loadLegacyRoutingMigrationState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPendingWaitIndexes([validPendingWaitIndex()]);
  });

  it("loads the exact candidate rows through session-bound shared predicates", async () => {
    const raw = rawSnapshot();
    const conversationCursor = cursorReturning(raw.pendingConversations);
    const linkedCursor = cursorReturning(raw.linkedConditions);
    mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);
    mockConversationCollectionFind.mockReturnValue(conversationCursor);
    mockLinkedConditionCollectionFind.mockReturnValue(linkedCursor);
    const session = { id: "session-1" } as never;

    const preimage = await loadPreimageForTest({
      workspaceId,
      scenarioId,
      candidatePairs: pairs,
      session,
    });

    expect(preimage?.target.candidatePairs).toEqual([
      {
        sourceActionNodeId: "action-alpha",
        sourceNodeId: "condition-alpha",
      },
      {
        sourceActionNodeId: "action-beta",
        sourceNodeId: "condition-beta",
      },
    ]);
    expect(mockConversationCollectionFind).toHaveBeenCalledWith(
      {
        workspaceId,
        "airi_scenario_state.lockedScenarioId": scenarioId,
        "airi_scenario_state.pendingConditionNodeId": {
          $in: ["condition-alpha", "condition-beta"],
        },
      },
      expect.objectContaining({
        hint: pendingWaitIndexName,
        promoteValues: false,
        session,
      })
    );
    expect(mockLinkedConditionCollectionFind).toHaveBeenCalledWith(
      {
        workspaceId,
        parentRefs: {
          $elemMatch: {
            parentScenarioId: scenarioId,
            conditionNodeId: {
              $in: ["condition-alpha", "condition-beta"],
            },
          },
        },
      },
      expect.objectContaining({ promoteValues: false, session })
    );
    expect(mockConversationListIndexes).toHaveBeenCalledTimes(1);
    expect(mockScenarioCollectionFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, deletedAt: null }),
      expect.objectContaining({ promoteValues: false, session })
    );
  });

  it("returns explicit empty external sets without issuing invalid empty-or queries", async () => {
    const raw = rawSnapshot();
    mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);

    const preimage = await loadPreimageForTest({
      workspaceId,
      scenarioId,
      candidatePairs: [],
    });

    expect(preimage).toMatchObject({
      target: { workspaceId, scenarioId, candidatePairs: [] },
      pendingConversations: [],
      linkedConditions: [],
    });
    expect(mockConversationCollectionFind).not.toHaveBeenCalled();
    expect(mockLinkedConditionCollectionFind).not.toHaveBeenCalled();
  });

  it("fails closed before a pending-wait scan when the rollout index is absent", async () => {
    const raw = rawSnapshot();
    mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);
    mockPendingWaitIndexes([]);
    mockConversationCollectionFind.mockReturnValue(cursorReturning([]));
    mockLinkedConditionCollectionFind.mockReturnValue(cursorReturning([]));

    await expect(
      loadPreimageForTest({
        workspaceId,
        scenarioId,
        candidatePairs: pairs,
      })
    ).rejects.toMatchObject({
      code: "legacy_routing_pending_wait_index_missing",
    });

    expect(mockConversationCollectionFind).not.toHaveBeenCalled();
    expect(mockLinkedConditionCollectionFind).not.toHaveBeenCalled();
  });

  it.each([
    [
      "ordered key pattern",
      {
        name: pendingWaitIndexName,
        key: {
          workspaceId: 1,
          "airi_scenario_state.lockedScenarioId": 1,
          "airi_scenario_state.pendingSourceActionNodeId": 1,
          "airi_scenario_state.pendingConditionNodeId": 1,
        },
        partialFilterExpression: pendingWaitPartialFilter,
      },
    ],
    [
      "partial filter",
      {
        name: pendingWaitIndexName,
        key: pendingWaitIndexKeys,
        partialFilterExpression: {
          ...pendingWaitPartialFilter,
          "airi_scenario_state.pendingSourceActionNodeId": {
            $type: "string",
          },
        },
      },
    ],
  ])(
    "fails closed when the v2 index has the wrong %s",
    async (_label, index) => {
      const raw = rawSnapshot();
      mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);
      mockPendingWaitIndexes([index]);
      mockConversationCollectionFind.mockReturnValue(cursorReturning([]));
      mockLinkedConditionCollectionFind.mockReturnValue(cursorReturning([]));

      await expect(
        loadPreimageForTest({
          workspaceId,
          scenarioId,
          candidatePairs: pairs,
        })
      ).rejects.toMatchObject({
        code: "legacy_routing_pending_wait_index_mismatch",
      });

      expect(mockConversationCollectionFind).not.toHaveBeenCalled();
      expect(mockLinkedConditionCollectionFind).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the v2 index definition cannot be inspected", async () => {
    const raw = rawSnapshot();
    mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);
    mockConversationListIndexes.mockReturnValue({
      toArray: jest.fn().mockRejectedValue(new Error("listIndexes denied")),
    });
    mockConversationCollectionFind.mockReturnValue(cursorReturning([]));
    mockLinkedConditionCollectionFind.mockReturnValue(cursorReturning([]));

    await expect(
      loadPreimageForTest({
        workspaceId,
        scenarioId,
        candidatePairs: pairs,
      })
    ).rejects.toMatchObject({
      code: "legacy_routing_pending_wait_index_check_failed",
    });

    expect(mockConversationCollectionFind).not.toHaveBeenCalled();
    expect(mockLinkedConditionCollectionFind).not.toHaveBeenCalled();
  });

  it("classifies a stale or unusable query hint instead of scanning without it", async () => {
    const raw = rawSnapshot();
    mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);
    const toArray = jest.fn().mockRejectedValue({
      code: 2,
      codeName: "BadValue",
      message: "hint provided does not correspond to an existing index",
    });
    mockConversationCollectionFind.mockReturnValue({ toArray });

    await expect(
      loadPreimageForTest({
        workspaceId,
        scenarioId,
        candidatePairs: pairs,
      })
    ).rejects.toMatchObject({
      code: "legacy_routing_pending_wait_index_hint_failed",
    });

    expect(mockConversationCollectionFind).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ hint: pendingWaitIndexName })
    );
    expect(mockLinkedConditionCollectionFind).not.toHaveBeenCalled();
  });

  it("keeps raw BSON state separate from normalized backup evidence", async () => {
    const raw = rawSnapshot();
    const rawNodePayload = {
      preservedDate: new Date("2026-08-05T08:00:00.000Z"),
      nested: { futureValue: [1, 2, 3] },
    };
    raw.scenario.nodes = [{ id: "raw-node", data: rawNodePayload }];
    const rawParentRefs = raw.linkedConditions[0].parentRefs;
    mockScenarioCollectionFindOne.mockResolvedValue(raw.scenario);
    mockConversationCollectionFind.mockReturnValue(
      cursorReturning(raw.pendingConversations)
    );
    mockLinkedConditionCollectionFind.mockReturnValue(
      cursorReturning(raw.linkedConditions)
    );

    const loaded = await loadLegacyRoutingMigrationState({
      workspaceId,
      scenarioId,
      candidatePairs: pairs,
    });

    expect(loaded?.raw.scenario.nodes).toBe(raw.scenario.nodes);
    expect(loaded?.raw.linkedConditions[0].parentRefs).toBe(rawParentRefs);
    expect(
      (
        (loaded?.raw.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).preservedDate
    ).toBe(rawNodePayload.preservedDate);
    expect(
      (
        (loaded?.preimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).preservedDate
    ).toEqual({
      $airiBson: {
        type: "Date",
        value: { $date: { $numberLong: "1785916800000" } },
      },
    });
  });

  it("hashes stored Int32, Double, and Long values distinctly after loading", async () => {
    const variants = [
      new mongoose.mongo.Int32(1),
      new mongoose.mongo.Double(1),
      mongoose.mongo.Long.fromNumber(1),
    ];
    const hashes: string[] = [];

    for (const storedValue of variants) {
      const raw = rawSnapshot();
      raw.scenario.nodes = [{ id: "typed-number-node", data: { storedValue } }];
      const serialized = mongoose.mongo.BSON.serialize(raw.scenario);
      mockScenarioCollectionFindOne.mockImplementation(
        async (_filter: unknown, options: Record<string, unknown>) =>
          mongoose.mongo.BSON.deserialize(serialized, options)
      );

      const loaded = await loadLegacyRoutingMigrationState({
        workspaceId,
        scenarioId,
        candidatePairs: [],
      });
      if (!loaded) throw new Error("preimage fixture was not loaded");
      const preimage = loaded.preimage;
      const rawValue = (
        (loaded.raw.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).storedValue;
      const semanticValue = (
        (loaded.semantic.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).storedValue;
      expect(rawValue).toBeInstanceOf(storedValue.constructor);
      expect(semanticValue).toBe(1);
      expect(preimage.scenario.graphSchemaVersion).toBe(7);
      expect(preimage.scenario.__v).toBe(4);
      hashes.push(preimage.preimageSha256);
    }

    expect(new Set(hashes).size).toBe(3);
    expect(mockScenarioCollectionFindOne).toHaveBeenCalledTimes(3);
    for (const [, options] of mockScenarioCollectionFindOne.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          promoteValues: false,
          promoteLongs: false,
          promoteBuffers: false,
        })
      );
    }
  });

  it("keeps BSON regular-expression patterns and options exact after loading", async () => {
    const raw = rawSnapshot();
    const storedExpression = new mongoose.mongo.BSONRegExp("a/b", "imxs");
    raw.scenario.nodes = [{ id: "regex-node", data: { storedExpression } }];
    const serialized = mongoose.mongo.BSON.serialize(raw.scenario);
    mockScenarioCollectionFindOne.mockImplementation(
      async (_filter: unknown, options: Record<string, unknown>) =>
        mongoose.mongo.BSON.deserialize(serialized, options)
    );

    const loaded = await loadLegacyRoutingMigrationState({
      workspaceId,
      scenarioId,
      candidatePairs: [],
    });

    if (!loaded) throw new Error("preimage fixture was not loaded");
    const rawExpression = (
      (loaded.raw.scenario.nodes as Array<Record<string, unknown>>)[0]
        .data as Record<string, unknown>
    ).storedExpression as mongoose.mongo.BSONRegExp;
    expect(rawExpression).toBeInstanceOf(mongoose.mongo.BSONRegExp);
    expect(rawExpression.pattern).toBe(storedExpression.pattern);
    expect(rawExpression.options).toBe(storedExpression.options);
    expect(
      (
        (loaded.preimage.scenario.nodes as Array<Record<string, unknown>>)[0]
          .data as Record<string, unknown>
      ).storedExpression
    ).toEqual({
      $airiBson: {
        type: "BSONRegExp",
        value: {
          $regularExpression: {
            pattern: storedExpression.pattern,
            options: storedExpression.options,
          },
        },
      },
    });
    expect(mockScenarioCollectionFindOne).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ bsonRegExp: true })
    );
  });
});
