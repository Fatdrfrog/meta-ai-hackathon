/**
 * @jest-environment node
 */

import type { Schema } from "mongoose";

import { EncryptedStringSchema } from "./encrypted-string-schema";
import {
  WhatsAppFlowEndpointSecurity,
  MAX_PREVIOUS_FLOW_KEY_SETS,
  WHATSAPP_FLOW_ENDPOINT_SECURITY_INDEXES,
} from "./whatsapp-flow-endpoint-security";
import { WhatsAppFlowSession } from "./whatsapp-flow-session";

const VALID_ENCRYPTED_STRING = {
  iv: Buffer.alloc(12, 1).toString("base64"),
  tag: Buffer.alloc(16, 2).toString("base64"),
  ciphertext: Buffer.from("secret", "utf8").toString("base64"),
};

const VALID_KEY_SET = {
  generationId: "generation-1",
  origin: "WABA_GENERATED",
  rsaKeyId: "rsa-key-1",
  encryptedPrivateKey: VALID_ENCRYPTED_STRING,
  publicKeyFingerprint: "a".repeat(64),
  signingKeyId: "signing-key-1",
  encryptedSigningKey: {
    ...VALID_ENCRYPTED_STRING,
    ciphertext: Buffer.alloc(32, 3).toString("base64"),
  },
  createdAt: new Date("2026-07-30T10:00:00.000Z"),
  activatedAt: new Date("2026-07-30T10:01:00.000Z"),
};
const VALID_ENDPOINT_SECURITY_INSERT = {
  workspaceId: "workspace-1",
  wabaId: "waba-1",
  endpointId: "endpoint-1",
  applicationId: "application-1",
  activeKeySet: VALID_KEY_SET,
  previousKeySets: [],
  phones: [],
  keyProvisioning: {
    status: "NOT_STARTED",
  },
  mutation: {
    status: "IDLE",
    fence: 0,
  },
};

function nestedSchema(schema: Schema, path: string): Schema {
  return (schema.path(path) as unknown as { schema: Schema }).schema;
}

function buildSecurityRecord() {
  return new WhatsAppFlowEndpointSecurity({
    workspaceId: "workspace-1",
    wabaId: "waba-1",
    endpointId: "endpoint-1",
    applicationId: "application-1",
    activeKeySet: VALID_KEY_SET,
    previousKeySets: [],
    phones: [
      {
        phoneNumberId: "phone-1",
        generationId: "generation-1",
        publicKeyFingerprint: "a".repeat(64),
        signatureStatus: "VALID",
        stage: "READY",
        verifiedAt: new Date("2026-07-30T10:02:00.000Z"),
        updatedAt: new Date("2026-07-30T10:02:00.000Z"),
      },
    ],
    keyProvisioning: {
      status: "READY",
      generationId: "generation-1",
      updatedAt: new Date("2026-07-30T10:02:00.000Z"),
    },
    mutation: {
      kind: "ENSURE",
      status: "COMPLETED",
      semanticOperationId: "ensure:generation-1",
      fence: 1,
      updatedAt: new Date("2026-07-30T10:02:00.000Z"),
    },
  });
}

function stubEndpointSecurityCollectionWrites() {
  return jest
    .spyOn(WhatsAppFlowEndpointSecurity.collection, "updateOne")
    .mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    } as never);
}

describe("WhatsAppFlowEndpointSecurity", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("uses an explicit strict collection contract and bounded enums", () => {
    expect(WhatsAppFlowEndpointSecurity.collection.collectionName).toBe(
      "whatsapp_flow_endpoint_security"
    );
    expect(WhatsAppFlowEndpointSecurity.schema.get("versionKey")).toBe(false);
    expect(WhatsAppFlowEndpointSecurity.schema.get("strict")).toBe("throw");

    const keySetSchema = nestedSchema(
      WhatsAppFlowEndpointSecurity.schema,
      "activeKeySet"
    );
    const phoneSchema = nestedSchema(
      WhatsAppFlowEndpointSecurity.schema,
      "phones"
    );
    const provisioningSchema = nestedSchema(
      WhatsAppFlowEndpointSecurity.schema,
      "keyProvisioning"
    );
    const mutationSchema = nestedSchema(
      WhatsAppFlowEndpointSecurity.schema,
      "mutation"
    );

    expect(keySetSchema.path("origin")?.options.enum).toEqual([
      "LEGACY_IMPORTED",
      "WABA_GENERATED",
    ]);
    expect(phoneSchema.path("signatureStatus")?.options.enum).toEqual([
      "UNKNOWN",
      "VALID",
      "INVALID",
    ]);
    expect(phoneSchema.path("stage")?.options.enum).toEqual([
      "DISCOVERED",
      "UPLOADING",
      "VERIFYING",
      "READY",
      "FAILED",
    ]);
    expect(provisioningSchema.path("status")?.options.enum).toEqual([
      "NOT_STARTED",
      "IN_PROGRESS",
      "READY",
      "FAILED",
    ]);
    expect(mutationSchema.path("kind")?.options.enum).toEqual([
      "ENSURE",
      "ROTATE",
      "LEGACY_IMPORT",
    ]);
    expect(mutationSchema.path("status")?.options.enum).toEqual([
      "IDLE",
      "RUNNING",
      "FAILED",
      "COMPLETED",
    ]);

    expect(
      WhatsAppFlowEndpointSecurity.schema.path("sourceId")
    ).toBeUndefined();
    expect(keySetSchema.path("privateKey")).toBeUndefined();
    expect(keySetSchema.path("signingKey")).toBeUndefined();
  });

  it("reuses one strict encrypted-string schema without string coercion", () => {
    const keySetSchema = nestedSchema(
      WhatsAppFlowEndpointSecurity.schema,
      "activeKeySet"
    );

    expect(nestedSchema(keySetSchema, "encryptedPrivateKey")).toBe(
      EncryptedStringSchema
    );
    expect(nestedSchema(keySetSchema, "encryptedSigningKey")).toBe(
      EncryptedStringSchema
    );
    expect(nestedSchema(WhatsAppFlowSession.schema, "encryptedJti")).toBe(
      EncryptedStringSchema
    );
    expect(EncryptedStringSchema.get("strict")).toBe("throw");
    expect(Object.keys(EncryptedStringSchema.paths).sort()).toEqual([
      "ciphertext",
      "iv",
      "tag",
    ]);

    expect(buildSecurityRecord().validateSync()).toBeUndefined();

    const malformedValues = [
      {
        ...VALID_ENCRYPTED_STRING,
        iv: Buffer.alloc(11, 1).toString("base64"),
      },
      {
        ...VALID_ENCRYPTED_STRING,
        tag: Buffer.alloc(15, 2).toString("base64"),
      },
      { ...VALID_ENCRYPTED_STRING, ciphertext: "" },
      {
        ...VALID_ENCRYPTED_STRING,
        ciphertext: Buffer.alloc(16_385, 3).toString("base64"),
      },
      { ...VALID_ENCRYPTED_STRING, iv: `${VALID_ENCRYPTED_STRING.iv}=` },
      { ...VALID_ENCRYPTED_STRING, tag: "not/base64!" },
    ];

    for (const encryptedPrivateKey of malformedValues) {
      const record = buildSecurityRecord();
      record.set("activeKeySet.encryptedPrivateKey", encryptedPrivateKey);
      expect(record.validateSync()).toBeDefined();
    }

    const stringRecord = buildSecurityRecord();
    stringRecord.set(
      "activeKeySet.encryptedPrivateKey",
      JSON.stringify(VALID_ENCRYPTED_STRING)
    );
    expect(stringRecord.validateSync()).toBeDefined();

    const extraKeyRecord = new WhatsAppFlowEndpointSecurity({
      ...buildSecurityRecord().toObject(),
      activeKeySet: {
        ...VALID_KEY_SET,
        encryptedPrivateKey: {
          ...VALID_ENCRYPTED_STRING,
          plaintext: "must-not-be-stored",
        },
      },
    });
    expect(
      extraKeyRecord.validateSync()?.errors["activeKeySet.encryptedPrivateKey"]
    ).toBeDefined();
  });

  it("rejects null key/phone arrays and bounds previous generations", () => {
    expect(MAX_PREVIOUS_FLOW_KEY_SETS).toBe(2);
    expect(buildSecurityRecord().validateSync()).toBeUndefined();

    const twoPrevious = buildSecurityRecord();
    twoPrevious.set(
      "previousKeySets",
      Array.from({ length: 2 }, (_, index) => ({
        ...VALID_KEY_SET,
        generationId: `previous-${index}`,
        retireAt: new Date("2026-08-01T10:00:00.000Z"),
      }))
    );
    expect(twoPrevious.validateSync()).toBeUndefined();

    const invalidArrays = [
      { previousKeySets: null },
      { previousKeySets: [null] },
      { previousKeySets: [undefined] },
      {
        previousKeySets: Array.from({ length: 3 }, (_, index) => ({
          ...VALID_KEY_SET,
          generationId: `previous-${index}`,
          retireAt: new Date("2026-08-01T10:00:00.000Z"),
        })),
      },
      { phones: null },
      { phones: [null] },
      { phones: [undefined] },
    ];

    for (const fields of invalidArrays) {
      const record = buildSecurityRecord();
      for (const [path, value] of Object.entries(fields)) {
        record.set(path, value);
      }
      expect(record.validateSync()).toBeDefined();
    }
  });

  it("requires an active key on every new record and a retirement time on previous keys", async () => {
    const missingActive = buildSecurityRecord();
    missingActive.set("activeKeySet", undefined);
    expect(missingActive.validateSync()?.errors.activeKeySet).toBeDefined();

    const missingRetirement = buildSecurityRecord();
    missingRetirement.set("previousKeySets", [
      { ...VALID_KEY_SET, generationId: "previous-without-retirement" },
    ]);
    expect(missingRetirement.validateSync()).toBeDefined();

    const updateOne = stubEndpointSecurityCollectionWrites();
    const incompleteInsert = {
      workspaceId: VALID_ENDPOINT_SECURITY_INSERT.workspaceId,
      wabaId: VALID_ENDPOINT_SECURITY_INSERT.wabaId,
      endpointId: VALID_ENDPOINT_SECURITY_INSERT.endpointId,
      applicationId: VALID_ENDPOINT_SECURITY_INSERT.applicationId,
      previousKeySets: [],
      phones: [],
      keyProvisioning: { status: "NOT_STARTED" },
      mutation: { status: "IDLE", fence: 0 },
    };
    await expect(
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        { $setOnInsert: incompleteInsert },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ).exec()
    ).rejects.toThrow();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("accepts one complete explicit endpoint-security upsert", async () => {
    const updateOne = stubEndpointSecurityCollectionWrites();
    const query = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      {
        $setOnInsert: VALID_ENDPOINT_SECURITY_INSERT,
      },
      {
        runValidators: true,
        setDefaultsOnInsert: false,
        upsert: true,
      }
    );

    await expect(query.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete endpoint-security upserts before Mongo", async () => {
    const updateOne = stubEndpointSecurityCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $setOnInsert: {
            workspaceId: "workspace-1",
            wabaId: "waba-1",
            endpointId: "endpoint-1",
            applicationId: "application-1",
          },
        },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $setOnInsert: {
            workspaceId: "workspace-1",
            wabaId: "waba-1",
            endpointId: "endpoint-1",
            applicationId: "application-1",
          },
        },
        {
          runValidators: true,
          upsert: true,
        }
      ),
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $setOnInsert: {
            ...VALID_ENDPOINT_SECURITY_INSERT,
            applicationId: undefined,
          },
        },
        {
          runValidators: true,
          setDefaultsOnInsert: false,
          upsert: true,
        }
      ),
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $setOnInsert: {
            ...VALID_ENDPOINT_SECURITY_INSERT,
            keyProvisioning: {
              status: "NOT_STARTED",
              generationId: "unexpected-generation",
            },
            mutation: {
              status: "IDLE",
              fence: 0,
              ownerToken: "unexpected-owner",
            },
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
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("rejects unvalidated endpoint key and array material before Mongo", async () => {
    const updateOne = stubEndpointSecurityCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $set: {
            pendingKeySet: {
              ...VALID_KEY_SET,
              encryptedPrivateKey: {
                ...VALID_ENCRYPTED_STRING,
                iv: Buffer.alloc(11, 1).toString("base64"),
              },
            },
          },
        }
      ),
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $set: {
            previousKeySets: [undefined],
          },
        }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      label: "invalid key-provisioning status",
      update: { $set: { "keyProvisioning.status": "BOGUS" } },
    },
    {
      label: "invalid mutation status",
      update: { $set: { "mutation.status": "BOGUS" } },
    },
    {
      label: "negative mutation fence assignment",
      update: { $set: { "mutation.fence": -1 } },
      options: { runValidators: true },
    },
    {
      label: "non-monotonic mutation fence assignment",
      update: { $set: { "mutation.fence": 2 } },
      options: { runValidators: true },
    },
    {
      label: "whole mutation replacement that can overwrite its fence",
      update: {
        $set: {
          mutation: {
            status: "RUNNING",
            ownerToken: "worker-1",
            fence: 1,
          },
        },
      },
      options: { runValidators: true },
    },
    {
      label: "negative mutation fence increment",
      update: { $inc: { "mutation.fence": -1 } },
    },
    {
      label: "zero mutation fence increment",
      update: { $inc: { "mutation.fence": 0 } },
    },
    {
      label: "multi-step mutation fence increment",
      update: { $inc: { "mutation.fence": 2 } },
    },
    {
      label: "nonnumeric mutation fence increment",
      update: { $inc: { "mutation.fence": "1" } },
    },
    {
      label: "increment under another mutation path",
      update: { $inc: { "mutation.lastError.providerCode": 1 } },
    },
    {
      label: "unsupported mutation operator",
      update: { $mul: { "mutation.fence": 2 } },
    },
    {
      label: "valid mutation state without validators",
      update: { $set: { "mutation.status": "RUNNING" } },
    },
  ])("rejects $label before Mongo", async ({ update, options }) => {
    const updateOne = stubEndpointSecurityCollectionWrites();
    const query = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      update as never,
      options
    );

    await expect(query.exec()).rejects.toThrow();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it("validates whole endpoint key and array writes while preserving mutation fencing", async () => {
    const updateOne = stubEndpointSecurityCollectionWrites();
    const guardedQuery = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      {
        $set: {
          pendingKeySet: VALID_KEY_SET,
          previousKeySets: [
            {
              ...VALID_KEY_SET,
              retireAt: new Date("2026-08-01T10:00:00.000Z"),
            },
          ],
          phones: [
            {
              phoneNumberId: "phone-1",
              signatureStatus: "UNKNOWN",
              stage: "DISCOVERED",
              updatedAt: new Date("2026-07-30T10:02:00.000Z"),
            },
          ],
        },
      },
      { runValidators: true }
    );
    await expect(guardedQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const clearPendingQuery = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      { $unset: { pendingKeySet: 1 } },
      { runValidators: true }
    );
    await expect(clearPendingQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const leaseQuery = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      {
        $set: {
          keyProvisioning: {
            status: "IN_PROGRESS",
            generationId: "generation-1",
            updatedAt: new Date("2026-07-30T10:02:00.000Z"),
          },
          "mutation.kind": "ENSURE",
          "mutation.status": "RUNNING",
          "mutation.semanticOperationId": "ensure-generation-1",
          "mutation.generationId": "generation-1",
          "mutation.ownerToken": "worker-1",
          "mutation.leaseExpiresAt": new Date("2026-07-30T10:05:00.000Z"),
          "mutation.updatedAt": new Date("2026-07-30T10:02:00.000Z"),
        },
        $unset: { "mutation.lastError": 1 },
        $inc: { "mutation.fence": 1 },
      },
      { runValidators: true }
    );
    await expect(leaseQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const releaseLeaseQuery = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      {
        $unset: {
          "mutation.ownerToken": 1,
          "mutation.leaseExpiresAt": 1,
        },
      },
      { runValidators: true }
    );
    await expect(releaseLeaseQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
    updateOne.mockClear();

    const renewLeaseQuery = WhatsAppFlowEndpointSecurity.updateOne(
      { wabaId: "waba-1" },
      {
        $set: {
          "mutation.leaseExpiresAt": new Date("2026-07-30T10:10:00.000Z"),
        },
      },
      { runValidators: true }
    );
    await expect(renewLeaseQuery.exec()).resolves.toMatchObject({
      acknowledged: true,
    });
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it("rejects endpoint identity and nested key-material mutations", async () => {
    const updateOne = stubEndpointSecurityCollectionWrites();
    const invalidQueries = [
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        { $set: { applicationId: "application-2" } },
        { runValidators: true }
      ),
      WhatsAppFlowEndpointSecurity.updateOne(
        { wabaId: "waba-1" },
        {
          $set: {
            "pendingKeySet.encryptedPrivateKey": VALID_ENCRYPTED_STRING,
          },
        },
        { runValidators: true }
      ),
    ];

    for (const query of invalidQueries) {
      await expect(query.exec()).rejects.toThrow();
      expect(updateOne).not.toHaveBeenCalled();
    }
  });

  it("declares every WABA endpoint-security index exactly once", () => {
    expect(WHATSAPP_FLOW_ENDPOINT_SECURITY_INDEXES).toEqual([
      {
        key: { wabaId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_endpoint_security_waba_unique",
        },
      },
      {
        key: { endpointId: 1 },
        options: {
          background: true,
          unique: true,
          name: "whatsapp_flow_endpoint_security_endpoint_unique",
        },
      },
      {
        key: { workspaceId: 1, updatedAt: -1 },
        options: {
          background: true,
          name: "whatsapp_flow_endpoint_security_workspace_updated",
        },
      },
      {
        key: { "mutation.leaseExpiresAt": 1 },
        options: {
          background: true,
          name: "whatsapp_flow_endpoint_security_mutation_lease",
        },
      },
    ]);

    expect(WhatsAppFlowEndpointSecurity.schema.indexes()).toEqual(
      WHATSAPP_FLOW_ENDPOINT_SECURITY_INDEXES.map(index => [
        index.key,
        index.options,
      ])
    );
  });
});
