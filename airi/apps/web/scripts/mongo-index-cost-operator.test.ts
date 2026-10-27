import { runMongoIndexCostOperator } from "./mongo-index-cost-operator";
import type {
  MongoIndexCostAdapter,
  MongoIndexMetadata,
} from "../src/lib/mongo-index-cost-operator";

function fixture() {
  let indexes: MongoIndexMetadata[] = [
    { name: "workspaceId_1_text_1", key: { workspaceId: 1, text: 1 } },
    {
      name: "workspaceId_1_text_1_conversation_1",
      key: { workspaceId: 1, text: 1, conversation: 1 },
    },
  ];
  const writes: unknown[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const adapter: MongoIndexCostAdapter = {
    readIndexes: async () => structuredClone(indexes),
    readIndexSizes: async () => ({}),
    readUsage: async () => {
      throw Object.assign(new Error("Unauthorized"), { code: 13 });
    },
    setHidden: async (collection, name, hidden) => {
      writes.push({ collection, name, hidden });
      indexes = indexes.map(index =>
        index.name === name ? { ...index, hidden } : index
      );
    },
    dropIndex: async (collection, name) => {
      writes.push({ collection, name });
      indexes = indexes.filter(index => index.name !== name);
    },
  };
  return {
    adapter,
    writes,
    output,
    errors,
    dependencies: {
      adapter,
      sources: [],
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    },
  };
}

describe("Mongo index cost CLI", () => {
  it("defaults to a read-only JSON report despite denied usage statistics", async () => {
    const db = fixture();
    expect(await runMongoIndexCostOperator([], db.dependencies)).toBe(0);
    expect(JSON.parse(db.output[0])).toMatchObject({
      mode: "report",
      status: "reported",
    });
    expect(db.writes).toEqual([]);
    expect(db.errors).toEqual([]);
  });

  it("prints usage without opening or touching a database", async () => {
    const db = fixture();
    db.adapter.readIndexes = async () => {
      throw new Error("should_not_connect");
    };
    expect(await runMongoIndexCostOperator(["--help"], db.dependencies)).toBe(
      0
    );
    expect(JSON.parse(db.output[0]).command).toBe("operator:mongo-index-costs");
    expect(JSON.parse(db.output[0]).flags).toContain(
      "--collection=messages|conversations|whatsappwebhookevents|scenariotriggerlogs"
    );
    expect(JSON.parse(db.output[0]).default).toBe(
      "Report 52 vetted candidates across 4 collections; no writes."
    );
    expect(db.writes).toEqual([]);
  });

  it("reports and protects a non-message candidate through the CLI", async () => {
    const db = fixture();
    db.adapter.readIndexes = async collection =>
      collection === "conversations"
        ? [
            { name: "workspaceId_1", key: { workspaceId: 1 } },
            { name: "workspaceId_1__id_1", key: { workspaceId: 1, _id: 1 } },
          ]
        : [];
    const args = [
      "--operation=hide",
      "--collection=conversations",
      "--index=workspaceId_1",
    ];
    expect(await runMongoIndexCostOperator(args, db.dependencies)).toBe(0);
    expect(JSON.parse(db.output[0])).toMatchObject({
      status: "dry_run",
      candidates: [{ collection: "conversations", eligible: true }],
    });
    expect(
      await runMongoIndexCostOperator([...args, "--apply"], {
        ...db.dependencies,
        sources: ['query.hint("workspaceId_1");'],
      })
    ).toBe(1);
    expect(JSON.parse(db.errors[0]).reason).toBe("candidate_is_hinted");
    expect(db.writes).toEqual([]);
  });

  it("applies only an explicitly selected hide", async () => {
    const db = fixture();
    expect(
      await runMongoIndexCostOperator(
        [
          "--operation=hide",
          "--collection=messages",
          "--index=workspaceId_1_text_1",
          "--apply",
        ],
        db.dependencies
      )
    ).toBe(0);
    expect(db.writes).toEqual([
      { collection: "messages", name: "workspaceId_1_text_1", hidden: true },
    ]);
    expect(JSON.parse(db.output[0]).status).toBe("applied");
  });

  it("blocks a repository hint before any hide", async () => {
    const db = fixture();
    expect(
      await runMongoIndexCostOperator(
        [
          "--operation=hide",
          "--collection=messages",
          "--index=workspaceId_1_text_1",
          "--apply",
        ],
        {
          ...db.dependencies,
          sources: ["query.hint({ workspaceId: 1, text: 1 });"],
        }
      )
    ).toBe(1);
    expect(JSON.parse(db.errors[0]).reason).toBe("candidate_is_hinted");
    expect(db.writes).toEqual([]);
  });

  it("rejects invalid targeting before reading the database", async () => {
    const db = fixture();
    db.adapter.readIndexes = async () => {
      throw new Error("unexpected_database_read");
    };
    expect(await runMongoIndexCostOperator(["--apply"], db.dependencies)).toBe(
      1
    );
    expect(JSON.parse(db.errors[0]).reason).toBe("invalid_arguments");
    expect(db.writes).toEqual([]);
  });

  it("redacts a driver error that includes connection credentials", async () => {
    const db = fixture();
    db.adapter.readIndexes = async () => {
      throw new Error("mongodb://user:secret@host/test failed");
    };
    expect(await runMongoIndexCostOperator([], db.dependencies)).toBe(1);
    expect(db.errors).toEqual([
      '{"status":"error","reason":"mongo_index_cost_operator_failed"}',
    ]);
    expect(db.output).toEqual([]);
  });

  it.each([
    { metadata: { code: 13 }, reason: "mongo_permission_denied" },
    {
      metadata: { codeName: "Unauthorized" },
      reason: "mongo_permission_denied",
    },
    { metadata: { code: 85 }, reason: "mongo_index_definition_conflict" },
    { metadata: { code: 86 }, reason: "mongo_index_definition_conflict" },
    {
      metadata: { codeName: "IndexOptionsConflict" },
      reason: "mongo_index_definition_conflict",
    },
    {
      metadata: { codeName: "IndexKeySpecsConflict" },
      reason: "mongo_index_definition_conflict",
    },
  ])(
    "reports safe mutation diagnostics for $metadata",
    async ({ metadata, reason }) => {
      const db = fixture();
      db.adapter.setHidden = async () => {
        throw Object.assign(
          new Error("mongodb://user:secret@host/test failed"),
          metadata
        );
      };
      expect(
        await runMongoIndexCostOperator(
          [
            "--operation=hide",
            "--collection=messages",
            "--index=workspaceId_1_text_1",
            "--apply",
          ],
          db.dependencies
        )
      ).toBe(1);
      expect(db.errors).toEqual([JSON.stringify({ status: "error", reason })]);
      expect(db.output).toEqual([]);
      expect(db.writes).toEqual([]);
    }
  );

  it("redacts identifier-shaped driver messages instead of treating them as safe reasons", async () => {
    const db = fixture();
    db.adapter.readIndexes = async () => {
      throw new Error("secret_password_value");
    };
    expect(await runMongoIndexCostOperator([], db.dependencies)).toBe(1);
    expect(db.errors).toEqual([
      '{"status":"error","reason":"mongo_index_cost_operator_failed"}',
    ]);
    expect(db.output).toEqual([]);
  });
});
