import {
  MONGO_INDEX_COST_CANDIDATES,
  parseMongoIndexCostOperatorArgs,
  findProtectedMongoIndexCandidates,
  runMongoIndexCostOperation,
  type MongoIndexCostAdapter,
  type MongoIndexMetadata,
} from "./mongo-index-cost-operator";

const candidateName = "workspaceId_1_text_1";
const replacementName = "workspaceId_1_text_1_conversation_1";
const now = new Date("2026-10-02T12:00:00.000Z");

function fixture() {
  const collections: Record<string, MongoIndexMetadata[]> = {
    messages: [
      { name: candidateName, key: { workspaceId: 1, text: 1 } },
      {
        name: replacementName,
        key: { workspaceId: 1, text: 1, conversation: 1 },
      },
      { name: "conversation_1_date_1", key: { conversation: 1, date: 1 } },
      {
        name: "conversation_1_date_1__id_1",
        key: { conversation: 1, date: 1, _id: 1 },
      },
      {
        name: "workspaceId_1_channel_1_date_-1",
        key: { workspaceId: 1, channel: 1, date: -1 },
      },
      {
        name: "workspaceId_1_channel_1_date_-1_conversation_1",
        key: { workspaceId: 1, channel: 1, date: -1, conversation: 1 },
      },
      { name: "conversation_1", key: { conversation: 1 } },
      { name: "workspaceId_1", key: { workspaceId: 1 } },
      { name: "workspaceId_1__id_1", key: { workspaceId: 1, _id: 1 } },
      { name: "direction_1", key: { direction: 1 } },
      { name: "direction_1_date_-1", key: { direction: 1, date: -1 } },
      { name: "channel_1", key: { channel: 1 } },
    ],
    scenariotriggerlogs: [
      { name: "evaluationId_1", key: { evaluationId: 1 } },
      {
        name: "scenario_trigger_logs_workspace_evaluation_id",
        key: { workspaceId: 1, evaluationId: 1 },
        background: true,
        partialFilterExpression: { evaluationId: { $type: "string" } },
      },
    ],
    conversations: [
      { name: "workspaceId_1", key: { workspaceId: 1 } },
      { name: "workspaceId_1__id_1", key: { workspaceId: 1, _id: 1 } },
    ],
    whatsappwebhookevents: [
      { name: "phoneNumberId_1", key: { phoneNumberId: 1 } },
      {
        name: "phoneNumberId_1_field_1_createdAt_-1",
        key: { phoneNumberId: 1, field: 1, createdAt: -1 },
      },
      { name: "wabaId_1", key: { wabaId: 1 } },
      {
        name: "wabaId_1_field_1_createdAt_-1",
        key: { wabaId: 1, field: 1, createdAt: -1 },
      },
      { name: "messagingAccountId_1", key: { messagingAccountId: 1 } },
      {
        name: "messagingAccountId_1_field_1_createdAt_-1",
        key: { messagingAccountId: 1, field: 1, createdAt: -1 },
      },
    ],
  };
  const mutations: unknown[] = [];
  const reads: Array<{ operation: string; collection: string }> = [];
  const adapter: MongoIndexCostAdapter = {
    readIndexes: async collection => {
      reads.push({ operation: "indexes", collection });
      return structuredClone(collections[collection] || []);
    },
    readIndexSizes: async collection => {
      reads.push({ operation: "sizes", collection });
      return collection === "messages"
        ? { [candidateName]: 24_416_256, workspaceId_1: 1_867_776 }
        : collection === "conversations"
          ? { workspaceId_1: 184_320 }
          : { phoneNumberId_1: 1_818_624 };
    },
    readUsage: async collection => {
      reads.push({ operation: "usage", collection });
      throw Object.assign(new Error("Unauthorized"), { code: 13 });
    },
    setHidden: async (collection, name, hidden) => {
      mutations.push({ collection, name, hidden });
      collections[collection] = collections[collection].map(index =>
        index.name === name ? { ...index, hidden } : index
      );
    },
    dropIndex: async (collection, name) => {
      mutations.push({ collection, name, drop: true });
      collections[collection] = collections[collection].filter(
        index => index.name !== name
      );
    },
  };
  return {
    adapter,
    mutations,
    reads,
    read: (collection = "messages") => collections[collection],
    change: (
      change: (indexes: MongoIndexMetadata[]) => MongoIndexMetadata[],
      collection = "messages"
    ) => {
      collections[collection] = change(collections[collection]);
    },
  };
}

function operation(operation: string, extra: string[] = []) {
  return parseMongoIndexCostOperatorArgs([
    `--operation=${operation}`,
    "--collection=messages",
    `--index=${candidateName}`,
    ...extra,
  ]);
}

describe("Mongo index cost operator", () => {
  it("reads metadata once per collection and keeps same-named index sizes and usage separate", async () => {
    const db = fixture();
    db.adapter.readUsage = async collection => {
      db.reads.push({ operation: "usage", collection });
      if (collection === "whatsappwebhookevents")
        throw Object.assign(new Error("Unauthorized"), { code: 13 });
      return [
        {
          name: "workspaceId_1",
          accesses: { ops: collection === "messages" ? 17 : 29 },
        },
      ];
    };
    const result = await runMongoIndexCostOperation(
      db.adapter,
      parseMongoIndexCostOperatorArgs([]),
      { now }
    );
    expect(
      result.candidates.filter(item => item.index === "workspaceId_1")
    ).toMatchObject([
      {
        collection: "messages",
        bytes: 1_867_776,
        usage: { status: "observed", samples: [{ accesses: { ops: 17 } }] },
      },
      {
        collection: "conversations",
        bytes: 184_320,
        usage: { status: "observed", samples: [{ accesses: { ops: 29 } }] },
      },
    ]);
    expect(
      result.candidates.find(item => item.index === "phoneNumberId_1")
    ).toMatchObject({
      collection: "whatsappwebhookevents",
      bytes: 1_818_624,
      usage: { status: "unknown", reason: "unauthorized" },
    });
    for (const collection of [
      "messages",
      "conversations",
      "whatsappwebhookevents",
    ])
      expect(
        db.reads
          .filter(read => read.collection === collection)
          .map(read => read.operation)
          .sort()
      ).toEqual(["indexes", "sizes", "usage"]);
    expect(db.mutations).toEqual([]);
  });

  it.each([
    ["messages", "conversation_1"],
    ["messages", "workspaceId_1"],
    ["messages", "direction_1"],
    ["conversations", "workspaceId_1"],
    ["whatsappwebhookevents", "phoneNumberId_1"],
    ["whatsappwebhookevents", "wabaId_1"],
    ["messages", "channel_1"],
    ["scenariotriggerlogs", "scenario_trigger_logs_workspace_evaluation_id"],
  ])(
    "hides only the selected vetted %s.%s with collection-correct rollback",
    async (collection, index) => {
      const db = fixture();
      const result = await runMongoIndexCostOperation(
        db.adapter,
        parseMongoIndexCostOperatorArgs([
          "--operation=hide",
          `--collection=${collection}`,
          `--index=${index}`,
          "--apply",
        ]),
        { now }
      );
      expect(db.mutations).toEqual([{ collection, name: index, hidden: true }]);
      expect(
        db.read(collection).find(item => item.name === index)?.hidden
      ).toBe(true);
      expect(db.reads.every(read => read.collection === collection)).toBe(true);
      expect(result.candidates[0].rollbackCommand).toContain(
        `--collection=${collection} --index=${index}`
      );
      if (collection === "conversations")
        expect(
          db.read("messages").find(item => item.name === index)?.hidden
        ).toBeUndefined();
    }
  );

  it("does not use a replacement from another collection", async () => {
    const db = fixture();
    db.change(
      indexes => indexes.filter(index => index.name !== "workspaceId_1__id_1"),
      "conversations"
    );
    await expect(
      runMongoIndexCostOperation(
        db.adapter,
        parseMongoIndexCostOperatorArgs([
          "--operation=hide",
          "--collection=conversations",
          "--index=workspaceId_1",
          "--apply",
        ]),
        { now }
      )
    ).rejects.toThrow("replacement_unavailable");
    expect(db.mutations).toEqual([]);
  });

  it("provides recreation for the selected collection after an observed drop", async () => {
    const db = fixture();
    db.change(
      indexes =>
        indexes.map(index =>
          index.name === "workspaceId_1" ? { ...index, hidden: true } : index
        ),
      "conversations"
    );
    const result = await runMongoIndexCostOperation(
      db.adapter,
      parseMongoIndexCostOperatorArgs([
        "--operation=drop",
        "--collection=conversations",
        "--index=workspaceId_1",
        "--apply",
        "--observed-since=2026-09-30T12:00:00.000Z",
      ]),
      { now }
    );
    expect(result.candidates[0].rollbackCommand).toBe(
      'db.getCollection("conversations").createIndex({"workspaceId":1},{"name":"workspaceId_1"})'
    );
    expect(
      db.read("messages").some(index => index.name === "workspaceId_1")
    ).toBe(true);
    expect(
      db.read("conversations").some(index => index.name === "workspaceId_1")
    ).toBe(false);
  });

  it("qualifies ambiguous source hints for every potentially affected collection", () => {
    expect(
      findProtectedMongoIndexCandidates(['query.hint("workspaceId_1");'])
    ).toEqual(["messages.workspaceId_1", "conversations.workspaceId_1"]);
    expect(
      findProtectedMongoIndexCandidates(["query.hint({ workspaceId: 1 });"])
    ).toEqual(["messages.workspaceId_1", "conversations.workspaceId_1"]);
  });

  it("keeps a qualified hint scoped to its collection", async () => {
    const db = fixture();
    const args = parseMongoIndexCostOperatorArgs([
      "--operation=hide",
      "--collection=conversations",
      "--index=workspaceId_1",
      "--apply",
    ]);
    await expect(
      runMongoIndexCostOperation(db.adapter, args, {
        now,
        hintedIndexes: ["conversations.workspaceId_1"],
      })
    ).rejects.toThrow("candidate_is_hinted");
    expect(db.mutations).toEqual([]);
    await runMongoIndexCostOperation(db.adapter, args, {
      now,
      hintedIndexes: ["messages.workspaceId_1"],
    });
    expect(db.mutations).toEqual([
      { collection: "conversations", name: "workspaceId_1", hidden: true },
    ]);
  });

  it("protects both key-pattern hints and named index references in application sources", () => {
    expect(
      findProtectedMongoIndexCandidates([
        "query.hint({ workspaceId: 1, text: 1 });",
        'export const LEGACY_THREAD_INDEX = "conversation_1_date_1";',
      ])
    ).toEqual([`messages.${candidateName}`, "messages.conversation_1_date_1"]);
    expect(
      findProtectedMongoIndexCandidates([
        "query.hint({ conversation: 1, date: 1, _id: 1 });",
      ])
    ).toEqual([]);
  });

  it("never fabricates a zero usage sample when stats return no matching index", async () => {
    const db = fixture();
    db.adapter.readUsage = async () => [];
    const result = await runMongoIndexCostOperation(
      db.adapter,
      parseMongoIndexCostOperatorArgs([]),
      { now }
    );
    expect(result.candidates[0].usage).toEqual({
      status: "observed",
      samples: [],
    });
  });

  it("fails verification when the server did not persist the requested hide", async () => {
    const db = fixture();
    db.adapter.setHidden = async () => undefined;
    await expect(
      runMongoIndexCostOperation(db.adapter, operation("hide", ["--apply"]), {
        now,
      })
    ).rejects.toThrow("mutation_verification_failed");
  });

  it("reports every vetted candidate without mutating or turning denied usage into zero", async () => {
    const db = fixture();
    const result = await runMongoIndexCostOperation(
      db.adapter,
      parseMongoIndexCostOperatorArgs([]),
      { now }
    );
    expect(result.mode).toBe("report");
    expect(result.candidates).toHaveLength(52);
    expect(result.candidates[0]).toMatchObject({
      collection: "messages",
      index: candidateName,
      replacement: replacementName,
      bytes: 24_416_256,
      usage: { status: "unknown", reason: "unauthorized" },
      eligible: true,
    });
    expect(result.candidates[0].rollbackCommand).toContain(
      "--operation=unhide"
    );
    expect(db.mutations).toEqual([]);
  });

  it("keeps an explicitly selected hide dry-run until apply is supplied", async () => {
    const db = fixture();
    const result = await runMongoIndexCostOperation(
      db.adapter,
      operation("hide"),
      { now }
    );
    expect(result.status).toBe("dry_run");
    expect(db.read()[0].hidden).toBeUndefined();
    expect(db.mutations).toEqual([]);
  });

  it("hides only the exact selected ordinary prefix while retaining its visible replacement", async () => {
    const db = fixture();
    const result = await runMongoIndexCostOperation(
      db.adapter,
      operation("hide", ["--apply"]),
      { now }
    );
    expect(result.status).toBe("applied");
    expect(db.read().find(index => index.name === candidateName)?.hidden).toBe(
      true
    );
    expect(
      db.read().find(index => index.name === replacementName)?.hidden
    ).toBeUndefined();
    expect(db.mutations).toEqual([
      { collection: "messages", name: candidateName, hidden: true },
    ]);
  });

  it.each([
    ["unique", true],
    ["sparse", true],
    ["partialFilterExpression", { text: { $type: "string" } }],
    ["expireAfterSeconds", 3600],
    ["collation", { locale: "en" }],
    ["wildcardProjection", { text: 1 }],
  ])(
    "refuses candidate %s semantics that were not vetted",
    async (option, value) => {
      const db = fixture();
      db.change(indexes =>
        indexes.map(index =>
          index.name === candidateName ? { ...index, [option]: value } : index
        )
      );
      await expect(
        runMongoIndexCostOperation(db.adapter, operation("hide", ["--apply"]), {
          now,
        })
      ).rejects.toThrow("candidate_metadata_changed");
      expect(db.mutations).toEqual([]);
    }
  );

  it.each(["missing", "hidden", "unique", "reordered"])(
    "refuses a %s replacement",
    async state => {
      const db = fixture();
      db.change(indexes =>
        state === "missing"
          ? indexes.filter(index => index.name !== replacementName)
          : indexes.map(index =>
              index.name !== replacementName
                ? index
                : state === "hidden"
                  ? { ...index, hidden: true }
                  : state === "unique"
                    ? { ...index, unique: true }
                    : {
                        ...index,
                        key: { text: 1, workspaceId: 1, conversation: 1 },
                      }
            )
      );
      await expect(
        runMongoIndexCostOperation(db.adapter, operation("hide", ["--apply"]), {
          now,
        })
      ).rejects.toThrow("replacement_unavailable");
      expect(db.mutations).toEqual([]);
    }
  );

  it("refuses candidates protected by application hints", async () => {
    const db = fixture();
    await expect(
      runMongoIndexCostOperation(db.adapter, operation("hide", ["--apply"]), {
        now,
        hintedIndexes: [candidateName],
      })
    ).rejects.toThrow("candidate_is_hinted");
    expect(db.mutations).toEqual([]);
  });

  it("rechecks metadata immediately before apply and rejects a changed index", async () => {
    const db = fixture();
    const read = db.adapter.readIndexes;
    let reads = 0;
    db.adapter.readIndexes = async collection => {
      reads++;
      if (reads === 2)
        db.change(indexes =>
          indexes.map(index =>
            index.name === candidateName ? { ...index, unique: true } : index
          )
        );
      return read(collection);
    };
    await expect(
      runMongoIndexCostOperation(db.adapter, operation("hide", ["--apply"]), {
        now,
      })
    ).rejects.toThrow("candidate_metadata_changed");
    expect(db.mutations).toEqual([]);
  });

  it("allows unhide rollback when the replacement is unavailable", async () => {
    const db = fixture();
    db.change(indexes =>
      indexes
        .filter(index => index.name !== replacementName)
        .map(index =>
          index.name === candidateName ? { ...index, hidden: true } : index
        )
    );
    await runMongoIndexCostOperation(
      db.adapter,
      operation("unhide", ["--apply"]),
      { now }
    );
    expect(db.read().find(index => index.name === candidateName)?.hidden).toBe(
      false
    );
  });

  it("rejects drop before a hidden observation period even with apply", async () => {
    const db = fixture();
    await expect(
      runMongoIndexCostOperation(
        db.adapter,
        operation("drop", [
          "--apply",
          "--observed-since=2026-09-30T12:00:00.000Z",
        ]),
        { now }
      )
    ).rejects.toThrow("candidate_must_be_hidden");
    expect(db.mutations).toEqual([]);
  });

  it.each([
    undefined,
    "not-a-date",
    "2026-10-02T11:00:00.000Z",
    "2026-10-03T12:00:00.000Z",
  ])(
    "rejects an absent or insufficient drop observation: %s",
    async observed => {
      const db = fixture();
      db.change(indexes =>
        indexes.map(index =>
          index.name === candidateName ? { ...index, hidden: true } : index
        )
      );
      const flags = [
        "--apply",
        ...(observed ? [`--observed-since=${observed}`] : []),
      ];
      await expect(
        runMongoIndexCostOperation(db.adapter, operation("drop", flags), {
          now,
        })
      ).rejects.toThrow("drop_observation_required");
      expect(db.mutations).toEqual([]);
    }
  );

  it("drops only the hidden vetted index after explicit observation and supplies its recreation spec", async () => {
    const db = fixture();
    db.change(indexes =>
      indexes.map(index =>
        index.name === candidateName ? { ...index, hidden: true } : index
      )
    );
    const result = await runMongoIndexCostOperation(
      db.adapter,
      operation("drop", [
        "--apply",
        "--observed-since=2026-09-30T12:00:00.000Z",
      ]),
      { now }
    );
    expect(db.read().some(index => index.name === candidateName)).toBe(false);
    expect(db.read().some(index => index.name === replacementName)).toBe(true);
    expect(result.candidates[0].recreate).toEqual({
      key: { workspaceId: 1, text: 1 },
      options: { name: candidateName },
    });
    expect(result.candidates[0].rollbackCommand).toBe(
      'db.getCollection("messages").createIndex({"workspaceId":1,"text":1},{"name":"workspaceId_1_text_1"})'
    );
    expect(result.candidates[0].exists).toBe(false);
  });

  it("keeps the used shorter indexes out of the retirement list", () => {
    const names = MONGO_INDEX_COST_CANDIDATES.map(
      candidate => `${candidate.collection}.${candidate.index}`
    );
    expect(names).not.toContain("messages.workspaceId_1_channel_1_date_-1");
    expect(names).not.toContain("messages.direction_1_date_-1");
    expect(names).not.toContain("whatsappwebhookevents.messagingAccountId_1");
    for (const kept of [
      "workspaceId_1_is_read_by_manager_1_lastMessageAt_-1",
      "workspaceId_1_status_1_lastMessageAt_-1",
      "workspaceId_1_customerId_1_lastMessageAt_-1",
      "workspaceId_1_channel_1_last_inbound_at_-1",
      "conversations_offline_eval_created_v1",
      "conversations_workspace_scenario_pending_wait_v2",
      "conversations_workspace_channel_source_group_updated_desc",
      "conversations_workspace_first_inbound_first_response",
    ])
      expect(names).not.toContain(`conversations.${kept}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("retires conversation indexes only as vetted unused candidates with their exact options", () => {
    const retired = MONGO_INDEX_COST_CANDIDATES.filter(
      candidate =>
        candidate.collection === "conversations" &&
        candidate.index !== "workspaceId_1"
    );
    expect(retired).toHaveLength(21);
    for (const candidate of retired) {
      expect(candidate.replacement).toBeNull();
      expect(
        candidate.replacement === null && candidate.evidence.length
      ).toBeGreaterThan(20);
    }
    expect(
      retired
        .filter(
          candidate => candidate.replacement === null && candidate.options
        )
        .map(candidate => [
          candidate.index,
          candidate.replacement === null ? candidate.options : null,
        ])
    ).toEqual([
      [
        "workspaceId_1_rename_1",
        { partialFilterExpression: { rename: { $type: "string" } } },
      ],
      [
        "workspaceId_1_whatsappReferral.ctwaClid_1",
        {
          partialFilterExpression: {
            "whatsappReferral.ctwaClid": { $type: "string" },
          },
        },
      ],
    ]);
  });

  it("hides a vetted unused index without a replacement and reports the longer drop window", async () => {
    const db = fixture();
    const result = await runMongoIndexCostOperation(
      db.adapter,
      parseMongoIndexCostOperatorArgs([
        "--operation=hide",
        "--collection=messages",
        "--index=channel_1",
        "--apply",
      ]),
      { now }
    );
    expect(result.status).toBe("applied");
    expect(result.candidates[0]).toMatchObject({
      replacement: null,
      dropAfterHiddenHours: 168,
      hidden: true,
    });
    expect(db.mutations).toEqual([
      { collection: "messages", name: "channel_1", hidden: true },
    ]);
  });

  it("requires seven hidden days before dropping an unused index", async () => {
    const db = fixture();
    db.change(indexes =>
      indexes.map(index =>
        index.name === "channel_1" ? { ...index, hidden: true } : index
      )
    );
    const drop = (observedSince: string) =>
      runMongoIndexCostOperation(
        db.adapter,
        parseMongoIndexCostOperatorArgs([
          "--operation=drop",
          "--collection=messages",
          "--index=channel_1",
          "--apply",
          `--observed-since=${observedSince}`,
        ]),
        { now }
      );
    await expect(drop("2026-09-26T12:00:00.001Z")).rejects.toThrow(
      "drop_observation_required"
    );
    expect(db.mutations).toEqual([]);
    await drop("2026-09-25T12:00:00.000Z");
    expect(db.read().some(index => index.name === "channel_1")).toBe(false);
  });

  it("drops a vetted partial index and recreates it with its filter", async () => {
    const db = fixture();
    const index = "scenario_trigger_logs_workspace_evaluation_id";
    db.change(
      indexes =>
        indexes.map(item =>
          item.name === index ? { ...item, hidden: true } : item
        ),
      "scenariotriggerlogs"
    );
    const result = await runMongoIndexCostOperation(
      db.adapter,
      parseMongoIndexCostOperatorArgs([
        "--operation=drop",
        "--collection=scenariotriggerlogs",
        `--index=${index}`,
        "--apply",
        "--observed-since=2026-09-20T12:00:00.000Z",
      ]),
      { now }
    );
    expect(result.candidates[0].recreate).toEqual({
      key: { workspaceId: 1, evaluationId: 1 },
      options: {
        name: index,
        partialFilterExpression: { evaluationId: { $type: "string" } },
      },
    });
    expect(result.candidates[0].rollbackCommand).toBe(
      'db.getCollection("scenariotriggerlogs").createIndex({"workspaceId":1,"evaluationId":1},{"name":"scenario_trigger_logs_workspace_evaluation_id","partialFilterExpression":{"evaluationId":{"$type":"string"}}})'
    );
    expect(
      db.read("scenariotriggerlogs").some(item => item.name === index)
    ).toBe(false);
  });

  it.each([
    [
      "changed filter",
      { partialFilterExpression: { evaluationId: { $exists: true } } },
    ],
    ["missing filter", { partialFilterExpression: undefined }],
    ["unique", { unique: true }],
  ])(
    "refuses an unused partial index whose %s differs from the vetted one",
    async (_case, override) => {
      const db = fixture();
      db.change(
        indexes =>
          indexes.map(item =>
            item.name === "scenario_trigger_logs_workspace_evaluation_id"
              ? { ...item, ...override }
              : item
          ),
        "scenariotriggerlogs"
      );
      await expect(
        runMongoIndexCostOperation(
          db.adapter,
          parseMongoIndexCostOperatorArgs([
            "--operation=hide",
            "--collection=scenariotriggerlogs",
            "--index=scenario_trigger_logs_workspace_evaluation_id",
            "--apply",
          ]),
          { now }
        )
      ).rejects.toThrow("candidate_metadata_changed");
      expect(db.mutations).toEqual([]);
    }
  );

  const invalidArgumentCases: string[][] = [
    ["--apply"],
    ["--operation=hide"],
    ["--operation=hide", "--collection=messages", "--index=_id_", "--apply"],
    [
      "--operation=hide",
      "--collection=conversations",
      `--index=${candidateName}`,
      "--apply",
    ],
    [
      "--operation=hide",
      "--collection=messages",
      `--index=${candidateName}`,
      "--apply",
      "--dry-run",
    ],
    [
      "--operation=hide",
      "--operation=drop",
      "--collection=messages",
      `--index=${candidateName}`,
    ],
    ["--unknown"],
  ];
  it.each(invalidArgumentCases.map(args => ({ args })))(
    "rejects invalid, conflicting or non-allowlisted arguments: $args",
    ({ args }) => {
      expect(() => parseMongoIndexCostOperatorArgs(args)).toThrow(
        "invalid_arguments"
      );
    }
  );
});
