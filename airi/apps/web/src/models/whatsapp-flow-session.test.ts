/**
 * @jest-environment node
 */

import type { Schema } from "mongoose";

import { EncryptedStringSchema } from "./encrypted-string-schema";
import {
  WhatsAppFlowSession,
  WHATSAPP_FLOW_SESSION_INDEXES,
} from "./whatsapp-flow-session";

const VALID_ENCRYPTED_JTI = {
  iv: Buffer.alloc(12, 1).toString("base64"),
  tag: Buffer.alloc(16, 2).toString("base64"),
  ciphertext: Buffer.alloc(32, 3).toString("base64"),
};
const VALID_SESSION_INSERT = {
  sessionId: "session-1",
  issuanceKeyHash: "a".repeat(64),
  encryptedJti: VALID_ENCRYPTED_JTI,
  jtiHash: "b".repeat(64),
  signingKeyId: "signing-key-1",
  routingDigest: "c".repeat(64),
  endpointId: "endpoint-1",
  workspaceId: "workspace-1",
  sourceId: "source-1",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  flowId: "flow-1",
  status: "ACTIVE",
  issuedAt: new Date("2026-07-30T10:00:00.000Z"),
  expiresAt: new Date("2026-08-06T10:00:00.000Z"),
  cleanupAt: new Date("2026-09-06T10:00:00.000Z"),
};

function nestedSchema(schema: Schema, path: string): Schema {
  return (schema.path(path) as unknown as { schema: Schema }).schema;
}

function stubSessionCollectionWrites() {
  return {
    findOneAndUpdate: jest
      .spyOn(WhatsAppFlowSession.collection, "findOneAndUpdate")
      .mockResolvedValue(null as never),
    updateOne: jest
      .spyOn(WhatsAppFlowSession.collection, "updateOne")
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      } as never),
    updateMany: jest
      .spyOn(WhatsAppFlowSession.collection, "updateMany")
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      } as never),
    replaceOne: jest
      .spyOn(WhatsAppFlowSession.collection, "replaceOne")
      .mockResolvedValue({
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1,
        upsertedCount: 0,
        upsertedId: null,
      } as never),
  };
}

function buildSession(overrides: Record<string, unknown> = {}) {
  return new WhatsAppFlowSession({
    ...VALID_SESSION_INSERT,
    ...overrides,
  });
}

describe("WhatsAppFlowSession", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stores only bounded session bindings and encrypted JTI material", () => {
    expect(WhatsAppFlowSession.collection.collectionName).toBe(
      "whatsapp_flow_sessions"
    );
    expect(WhatsAppFlowSession.schema.get("versionKey")).toBe(false);
    expect(WhatsAppFlowSession.schema.get("strict")).toBe("throw");
    expect(WhatsAppFlowSession.schema.path("status")?.options.enum).toEqual([
      "ACTIVE",
      "COMPLETED",
      "REVOKED",
    ]);
    expect(nestedSchema(WhatsAppFlowSession.schema, "encryptedJti")).toBe(
      EncryptedStringSchema
    );

    for (const forbiddenPath of [
      "jti",
      "token",
      "compactJws",
      "flowToken",
      "topology",
      "routingGraph",
      "formData",
      "answers",
    ]) {
      expect(WhatsAppFlowSession.schema.path(forbiddenPath)).toBeUndefined();
    }
    expect(buildSession().validateSync()).toBeUndefined();
  });

  it("uses strict expiry for authorization and a later cleanup deadline", () => {
    expect(
      buildSession({
        expiresAt: new Date("2026-07-30T10:00:00.000Z"),
      }).validateSync()?.errors.expiresAt
    ).toBeDefined();
    expect(
      buildSession({
        cleanupAt: new Date("2026-08-06T10:00:00.000Z"),
      }).validateSync()?.errors.cleanupAt
    ).toBeDefined();
    expect(
      buildSession({
        status: "COMPLETED",
      }).validateSync()?.errors.terminalDigest
    ).toBeDefined();
    expect(
      buildSession({
        status: "COMPLETED",
        terminalDigest: "d".repeat(64),
        completedAt: new Date("2026-07-31T10:00:00.000Z"),
      }).validateSync()
    ).toBeUndefined();
    expect(
      buildSession({
        terminalDigest: "d".repeat(64),
      }).validateSync()?.errors.terminalDigest
    ).toBeDefined();
  });

  it("validates an atomic ACTIVE-to-COMPLETED CAS in query context", async () => {
    const query = WhatsAppFlowSession.findOneAndUpdate(
      {
        sessionId: "session-1",
        status: "ACTIVE",
        expiresAt: { $gt: new Date("2026-07-31T10:00:00.000Z") },
      },
      {
        $set: {
          status: "COMPLETED",
          terminalDigest: "d".repeat(64),
          completedAt: new Date("2026-07-31T10:00:00.000Z"),
        },
      },
      { runValidators: true, new: true }
    );

    const writes = stubSessionCollectionWrites();
    await expect(query.exec()).resolves.toBeNull();
    expect(writes.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(writes.updateOne).not.toHaveBeenCalled();
  });

  it("accepts a non-completed transition only with explicit terminal cleanup", async () => {
    const writes = stubSessionCollectionWrites();
    const query = WhatsAppFlowSession.findOneAndUpdate(
      { sessionId: "session-1", status: "COMPLETED" },
      {
        $set: { status: "REVOKED" },
        $unset: {
          terminalDigest: 1,
          completedAt: 1,
        },
      },
      { runValidators: true, new: true }
    );

    await expect(query.exec()).resolves.toBeNull();
    expect(writes.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("validates strict encrypted JTI material in an atomic session upsert", async () => {
    const writes = stubSessionCollectionWrites();
    const validQuery = WhatsAppFlowSession.updateOne(
      { issuanceKeyHash: "a".repeat(64) },
      {
        $setOnInsert: VALID_SESSION_INSERT,
      },
      {
        runValidators: true,
        setDefaultsOnInsert: false,
        upsert: true,
      }
    );
    await expect(validQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(writes.updateOne).toHaveBeenCalledTimes(1);
    writes.updateOne.mockClear();

    const malformedQuery = WhatsAppFlowSession.updateOne(
      { sessionId: "session-1" },
      {
        $set: {
          encryptedJti: {
            ...VALID_ENCRYPTED_JTI,
            plaintext: "must-not-be-stored",
          },
        },
      },
      { runValidators: true }
    );
    await expect(malformedQuery.exec()).rejects.toThrow(/encryptedJti/);
    expect(writes.updateOne).not.toHaveBeenCalled();
  });

  it("rejects incomplete session upserts when defaults are disabled", async () => {
    const writes = stubSessionCollectionWrites();
    const withoutStatus: Record<string, unknown> = {
      ...VALID_SESSION_INSERT,
    };
    delete withoutStatus.status;
    const invalidQueries = [
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        { $setOnInsert: withoutStatus },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        { $setOnInsert: withoutStatus },
        {
          runValidators: true,
          upsert: true,
        }
      ),
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        {
          $setOnInsert: {
            status: "ACTIVE",
            issuedAt: new Date("2026-07-30T10:00:00.000Z"),
            expiresAt: new Date("2026-08-06T10:00:00.000Z"),
            cleanupAt: new Date("2026-09-06T10:00:00.000Z"),
          },
        },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        {
          $setOnInsert: {
            ...VALID_SESSION_INSERT,
            sourceId: undefined,
          },
        },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(writes.updateOne).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed encrypted JTI writes without validators before Mongo", async () => {
    const writes = stubSessionCollectionWrites();
    const query = WhatsAppFlowSession.updateOne(
      { sessionId: "session-1" },
      {
        $set: {
          encryptedJti: {
            ...VALID_ENCRYPTED_JTI,
            iv: Buffer.alloc(11, 1).toString("base64"),
          },
        },
      }
    );

    await expect(query.exec()).rejects.toThrow();
    expect(writes.updateOne).not.toHaveBeenCalled();
  });

  it("rejects existing-row session binding and security mutations", async () => {
    const writes = stubSessionCollectionWrites();
    const mutations = [
      { sessionId: "session-2" },
      { issuanceKeyHash: "d".repeat(64) },
      { encryptedJti: VALID_ENCRYPTED_JTI },
      { jtiHash: "e".repeat(64) },
      { signingKeyId: "signing-key-2" },
      { routingDigest: "f".repeat(64) },
      { endpointId: "endpoint-2" },
      { workspaceId: "workspace-2" },
      { sourceId: "source-2" },
      { wabaId: "waba-2" },
      { phoneNumberId: "phone-2" },
      { flowId: "flow-2" },
    ];

    for (const mutation of mutations) {
      const query = WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        { $set: mutation },
        { runValidators: true }
      );
      await expect(query.exec()).rejects.toThrow();
      expect(writes.updateOne).not.toHaveBeenCalled();
    }
  });

  it("rejects incomplete or comparison-less atomic session updates", async () => {
    const writes = stubSessionCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowSession.findOneAndUpdate(
        { sessionId: "session-1", status: "ACTIVE" },
        {
          $set: {
            status: "COMPLETED",
            completedAt: new Date("2026-07-31T10:00:00.000Z"),
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        {
          $set: {
            terminalDigest: "d".repeat(64),
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        {
          $set: {
            cleanupAt: new Date("2026-09-07T10:00:00.000Z"),
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        {
          $set: {
            issuedAt: new Date("2026-07-30T10:00:00.000Z"),
            expiresAt: new Date("2026-07-30T10:00:00.000Z"),
          },
        },
        { runValidators: true }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(writes.findOneAndUpdate).not.toHaveBeenCalled();
      expect(writes.updateOne).not.toHaveBeenCalled();
    }
  });

  it("rejects invariant bypass operators and immutable issuance rewrites before Mongo", async () => {
    const writes = stubSessionCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowSession.findOneAndUpdate(
        { sessionId: "session-1", status: "COMPLETED" },
        { $set: { status: "REVOKED" } },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        {
          $set: { status: "ACTIVE" },
          $unset: {
            terminalDigest: 1,
            completedAt: 1,
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        { $set: { issuedAt: new Date("2026-07-31T10:00:00.000Z") } },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        {
          $setOnInsert: {
            issuedAt: new Date("2026-07-30T10:00:00.000Z"),
            expiresAt: new Date("2026-09-07T10:00:00.000Z"),
            cleanupAt: new Date("2026-09-06T10:00:00.000Z"),
          },
        },
        { runValidators: true, upsert: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        { $rename: { expiresAt: "legacyExpiresAt" } },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        { $rename: { legacyExpiresAt: "expiresAt" } },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        { $set: { "status.value": "COMPLETED" } },
        { runValidators: true }
      ),
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        {
          $set: { status: "COMPLETED" },
          $setOnInsert: {
            terminalDigest: "d".repeat(64),
            completedAt: new Date("2026-07-31T10:00:00.000Z"),
          },
        },
        { runValidators: true, upsert: true }
      ),
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1" },
        [{ $set: { status: "COMPLETED" } }] as never,
        { runValidators: true }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(writes.findOneAndUpdate).not.toHaveBeenCalled();
      expect(writes.updateOne).not.toHaveBeenCalled();
    }
  });

  it("requires validators and rejects bulk or replacement ledger writes", async () => {
    const writes = stubSessionCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowSession.updateOne(
        { sessionId: "session-1", status: "ACTIVE" },
        {
          $set: {
            status: "COMPLETED",
            terminalDigest: "d".repeat(64),
            completedAt: new Date("2026-07-31T10:00:00.000Z"),
          },
        }
      ),
      WhatsAppFlowSession.updateOne(
        { issuanceKeyHash: "a".repeat(64) },
        { $setOnInsert: VALID_SESSION_INSERT },
        { runValidators: true, upsert: true }
      ),
      WhatsAppFlowSession.updateMany(
        { status: "ACTIVE" },
        {
          $set: { status: "REVOKED" },
          $unset: {
            terminalDigest: 1,
            completedAt: 1,
          },
        },
        { runValidators: true }
      ),
      WhatsAppFlowSession.replaceOne(
        { sessionId: "session-1" },
        buildSession().toObject(),
        { runValidators: true }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(writes.updateOne).not.toHaveBeenCalled();
      expect(writes.updateMany).not.toHaveBeenCalled();
      expect(writes.replaceOne).not.toHaveBeenCalled();
    }
  });

  it("indexes unique issuance/replay identities and cleanup separately", () => {
    expect(WHATSAPP_FLOW_SESSION_INDEXES).toEqual([
      {
        key: { sessionId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_session_id_unique",
        },
      },
      {
        key: { issuanceKeyHash: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_session_issuance_key_hash_unique",
        },
      },
      {
        key: { jtiHash: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_session_jti_hash_unique",
        },
      },
      {
        key: { endpointId: 1, status: 1, expiresAt: 1 },
        options: {
          background: true,
          name: "whatsapp_flow_session_endpoint_status_expires",
        },
      },
      {
        key: { cleanupAt: 1 },
        options: {
          background: true,
          name: "whatsapp_flow_session_cleanup_ttl",
          expireAfterSeconds: 0,
        },
      },
    ]);

    expect(WhatsAppFlowSession.schema.indexes()).toEqual(
      WHATSAPP_FLOW_SESSION_INDEXES.map(index => [index.key, index.options])
    );
    expect(
      WhatsAppFlowSession.schema
        .indexes()
        .find(([key]) => "expiresAt" in key)?.[1].expireAfterSeconds
    ).toBeUndefined();
  });
});
