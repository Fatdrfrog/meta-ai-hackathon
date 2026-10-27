/**
 * @jest-environment node
 */

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}));

import connectDB from "@/lib/mongoose";
import {
  generateWhatsAppFlowKeySet,
  loadWhatsAppFlowKeySet,
} from "@/lib/whatsapp/flows/endpoint-crypto";
import {
  acquireEndpointSecurityMutationLease,
  applyEndpointSecurityFencedMutation,
  assertEndpointSecurityFence,
  EndpointSecurityBindingConflictError,
  EndpointSecurityMutationConflictError,
  EndpointSecurityRecordCorruptionError,
  findWhatsAppFlowEndpointSecurity,
  findWhatsAppFlowEndpointSecurityByEndpointId,
  loadOrCreateWhatsAppFlowEndpointSecurity,
  releaseEndpointSecurityMutationLease,
  renewEndpointSecurityMutationLease,
  type EndpointSecurityFencedMutation,
  type EndpointSecurityMutationLease,
} from "@/lib/whatsapp/flows/endpoint-security-store";
import {
  WhatsAppFlowEndpointSecurity,
  type WhatsAppFlowEndpointSecurityRecord,
  type WhatsAppFlowKeySet,
} from "@/models/whatsapp-flow-endpoint-security";

const TEST_ENCRYPTION_SECRET = "task-7-endpoint-security-store-secret";
const NOW = new Date("2026-07-30T10:00:00.000Z");
const LATER = new Date("2026-07-30T10:05:00.000Z");

type RecordOverrides = Omit<
  Partial<WhatsAppFlowEndpointSecurityRecord>,
  "keyProvisioning" | "mutation"
> & {
  keyProvisioning?: Partial<
    WhatsAppFlowEndpointSecurityRecord["keyProvisioning"]
  >;
  mutation?: Partial<WhatsAppFlowEndpointSecurityRecord["mutation"]>;
};

type QueryResult<T> = T | Error;

let activeKeySet: WhatsAppFlowKeySet;
let secondKeySet: WhatsAppFlowKeySet;

function endpointSecurityRecord(
  overrides: RecordOverrides = {}
): WhatsAppFlowEndpointSecurityRecord {
  const base: WhatsAppFlowEndpointSecurityRecord = {
    workspaceId: "workspace-1",
    wabaId: "waba-1",
    endpointId: "endpoint-1",
    applicationId: "application-1",
    activeKeySet,
    previousKeySets: [],
    phones: [],
    keyProvisioning: { status: "NOT_STARTED" },
    mutation: { status: "IDLE", fence: 0 },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    ...base,
    ...overrides,
    keyProvisioning: {
      ...base.keyProvisioning,
      ...overrides.keyProvisioning,
    },
    mutation: { ...base.mutation, ...overrides.mutation },
  };
}

function mutationLease(
  overrides: Partial<EndpointSecurityMutationLease> = {}
): EndpointSecurityMutationLease {
  return {
    wabaId: "waba-1",
    kind: "ROTATE",
    semanticOperationId: "rotate-operation-1",
    generationId: secondKeySet.generationId,
    ownerToken: "owner-1",
    fence: 4,
    leaseExpiresAt: LATER,
    ...overrides,
  };
}

function leanQuery<T>(result: QueryResult<T>) {
  return {
    lean: jest
      .fn()
      .mockImplementation(() =>
        result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result)
      ),
  };
}

function mockFindOne(...results: Array<QueryResult<unknown>>) {
  let call = 0;
  return jest
    .spyOn(WhatsAppFlowEndpointSecurity, "findOne")
    .mockImplementation(() => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return leanQuery(result) as never;
    });
}

function mockFindOneAndUpdate(...results: Array<QueryResult<unknown>>) {
  let call = 0;
  return jest
    .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
    .mockImplementation(() => {
      const result = results[Math.min(call, results.length - 1)];
      call += 1;
      return leanQuery(result) as never;
    });
}

function duplicateKeyError(): Error & { code: number } {
  return Object.assign(new Error("duplicate key"), { code: 11000 });
}

describe("WhatsApp Flow endpoint security store", () => {
  const originalEncryptionSecret = process.env.ENCRYPTION_SECRET;

  beforeAll(() => {
    process.env.ENCRYPTION_SECRET = TEST_ENCRYPTION_SECRET;
    activeKeySet = generateWhatsAppFlowKeySet({
      randomBytes: (() =>
        Buffer.alloc(32, 0x11)) as typeof import("node:crypto").randomBytes,
      now: () => NOW,
    });
    secondKeySet = generateWhatsAppFlowKeySet({
      randomBytes: (() =>
        Buffer.alloc(32, 0x22)) as typeof import("node:crypto").randomBytes,
      now: () => new Date("2026-07-30T10:01:00.000Z"),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (connectDB as jest.Mock).mockClear();
  });

  afterAll(() => {
    if (originalEncryptionSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = originalEncryptionSecret;
    }
  });

  it("loads one validated security record by its opaque endpoint id", async () => {
    const record = endpointSecurityRecord();
    const find = mockFindOne(record);

    await expect(
      findWhatsAppFlowEndpointSecurityByEndpointId(" endpoint-1 ")
    ).resolves.toBe(record);
    expect(find).toHaveBeenCalledWith({ endpointId: "endpoint-1" });
  });

  it("creates with one complete guarded setOnInsert and no decrypted material", async () => {
    const winner = endpointSecurityRecord();
    const update = mockFindOneAndUpdate(winner);

    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: " workspace-1 ",
        wabaId: " waba-1 ",
        applicationId: " application-1 ",
        initialActiveKeySet: activeKeySet,
      })
    ).resolves.toBe(winner);

    expect(update).toHaveBeenCalledTimes(1);
    const [filter, body, options] = update.mock.calls[0]!;
    expect(filter).toEqual({ wabaId: "waba-1" });
    expect(body).toEqual({
      $setOnInsert: {
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        endpointId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        applicationId: "application-1",
        activeKeySet,
        previousKeySets: [],
        phones: [],
        keyProvisioning: { status: "NOT_STARTED" },
        mutation: { status: "IDLE", fence: 0 },
      },
    });
    expect(options).toEqual({
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: false,
    });
    const serializedWrite = JSON.stringify(update.mock.calls);
    const loaded = loadWhatsAppFlowKeySet(activeKeySet);
    expect(serializedWrite).not.toContain("BEGIN PRIVATE KEY");
    expect(serializedWrite).not.toContain(loaded.signingKey.toString("base64"));
    expect(serializedWrite).not.toContain("sourceId");
  });

  it("requires exact identities and a valid policy-selected initial key before database access", async () => {
    const tamperedKeySet = {
      ...activeKeySet,
      generationId: "gen_tampered",
    };
    const loadWithoutInitialKey =
      loadOrCreateWhatsAppFlowEndpointSecurity as unknown as (params: {
        workspaceId: string;
        wabaId: string;
        applicationId: string;
      }) => Promise<WhatsAppFlowEndpointSecurityRecord>;

    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: " ",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: activeKeySet,
      })
    ).rejects.toThrow("Workspace id is required");
    await expect(
      loadWithoutInitialKey({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
      })
    ).rejects.toThrow("Initial active key set is required");
    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: tamperedKeySet,
      })
    ).rejects.toThrow("Stored WhatsApp Flow key material is invalid");
    expect(connectDB).not.toHaveBeenCalled();
  });

  it("provides a read-only exact-bound lookup for status routes", async () => {
    const winner = endpointSecurityRecord();
    const find = mockFindOne(winner, null, {
      ...winner,
      workspaceId: "workspace-2",
    });
    const update = jest
      .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("unexpected endpoint-security write");
      });

    await expect(
      findWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
      })
    ).resolves.toBe(winner);
    await expect(
      findWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-2",
        applicationId: "application-1",
      })
    ).resolves.toBeNull();
    await expect(
      findWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
      })
    ).rejects.toBeInstanceOf(EndpointSecurityBindingConflictError);

    expect(find).toHaveBeenCalledTimes(3);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns the durable same-WABA winner after duplicate-key races and ignores concurrent key candidates", async () => {
    const winner = endpointSecurityRecord();
    const update = mockFindOneAndUpdate(duplicateKeyError());
    const find = mockFindOne(winner);

    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: secondKeySet,
      })
    ).resolves.toBe(winner);

    expect(update).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ wabaId: "waba-1" });
    expect(winner.activeKeySet).toBe(activeKeySet);
  });

  it("rejects an active-less existing winner with a safe typed corruption error", async () => {
    mockFindOneAndUpdate(endpointSecurityRecord({ activeKeySet: undefined }));

    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: secondKeySet,
      })
    ).rejects.toBeInstanceOf(EndpointSecurityRecordCorruptionError);
  });

  it("rejects corrupt active material from a duplicate-key race winner", async () => {
    const corruptWinner = endpointSecurityRecord({
      activeKeySet: { ...activeKeySet, generationId: "gen_tampered" },
    });
    mockFindOneAndUpdate(duplicateKeyError());
    mockFindOne(corruptWinner);

    let failure: Error | undefined;
    try {
      await loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: secondKeySet,
      });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(EndpointSecurityRecordCorruptionError);
    expect(failure?.message).not.toContain("gen_tampered");
    expect(failure?.message).not.toContain(
      activeKeySet.encryptedPrivateKey.ciphertext
    );
  });

  it("retries only endpoint-id collisions and bounds retry exhaustion", async () => {
    const winner = endpointSecurityRecord({ endpointId: "endpoint-winner" });
    const update = mockFindOneAndUpdate(
      duplicateKeyError(),
      winner,
      duplicateKeyError(),
      duplicateKeyError(),
      duplicateKeyError()
    );
    const find = mockFindOne(null, null, null, null);

    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: activeKeySet,
      })
    ).resolves.toBe(winner);
    const firstEndpointId = (
      update.mock.calls[0]![1] as {
        $setOnInsert: { endpointId: string };
      }
    ).$setOnInsert.endpointId;
    const secondEndpointId = (
      update.mock.calls[1]![1] as {
        $setOnInsert: { endpointId: string };
      }
    ).$setOnInsert.endpointId;
    expect(secondEndpointId).not.toBe(firstEndpointId);

    update.mockClear();
    find.mockClear();
    const exhaustedUpdate = mockFindOneAndUpdate(
      duplicateKeyError(),
      duplicateKeyError(),
      duplicateKeyError()
    );
    const exhaustedFind = mockFindOne(null, null, null);
    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: activeKeySet,
      })
    ).rejects.toBeInstanceOf(EndpointSecurityMutationConflictError);
    expect(exhaustedUpdate).toHaveBeenCalledTimes(3);
    expect(exhaustedFind).toHaveBeenCalledTimes(3);
  });

  it.each([
    { workspaceId: "workspace-2", applicationId: "application-1" },
    { workspaceId: "workspace-1", applicationId: "application-2" },
  ])("rejects a cross-bound WABA winner %#", async binding => {
    mockFindOneAndUpdate(endpointSecurityRecord(binding));

    await expect(
      loadOrCreateWhatsAppFlowEndpointSecurity({
        workspaceId: "workspace-1",
        wabaId: "waba-1",
        applicationId: "application-1",
        initialActiveKeySet: activeKeySet,
      })
    ).rejects.toBeInstanceOf(EndpointSecurityBindingConflictError);
  });

  it("atomically installs the first ROTATE pending key with the lease and one fence increment", async () => {
    const acquired = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        ownerToken: "owner-1",
        fence: 1,
        leaseExpiresAt: LATER,
      },
    });
    mockFindOne(endpointSecurityRecord());
    const update = mockFindOneAndUpdate(acquired);

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: secondKeySet,
        ownerToken: "owner-1",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toEqual({
      wabaId: "waba-1",
      kind: "ROTATE",
      semanticOperationId: "rotate-operation-1",
      generationId: secondKeySet.generationId,
      ownerToken: "owner-1",
      fence: 1,
      leaseExpiresAt: LATER,
    });

    const [filter, body, options] = update.mock.calls[0]!;
    expect(filter).toMatchObject({
      wabaId: "waba-1",
      "mutation.status": "IDLE",
      "mutation.fence": 0,
      pendingKeySet: { $exists: false },
    });
    expect(body).toEqual({
      $set: expect.objectContaining({
        pendingKeySet: secondKeySet,
        "mutation.kind": "ROTATE",
        "mutation.status": "RUNNING",
        "mutation.semanticOperationId": "rotate-operation-1",
        "mutation.generationId": secondKeySet.generationId,
        "mutation.ownerToken": "owner-1",
        "mutation.leaseExpiresAt": LATER,
        "mutation.updatedAt": NOW,
      }),
      $unset: { "mutation.lastError": 1 },
      $inc: { "mutation.fence": 1 },
    });
    expect(options).toEqual({ new: true, runValidators: true });
  });

  it("reuses the exact durable pending key after a crash instead of a new ROTATE candidate", async () => {
    const crashed = endpointSecurityRecord({
      pendingKeySet: activeKeySet,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate-operation-1",
        generationId: activeKeySet.generationId,
        ownerToken: "crashed-owner",
        fence: 7,
        leaseExpiresAt: NOW,
      },
    });
    const takenOver = endpointSecurityRecord({
      pendingKeySet: activeKeySet,
      mutation: {
        ...crashed.mutation,
        ownerToken: "owner-2",
        fence: 8,
        leaseExpiresAt: LATER,
      },
    });
    mockFindOne(crashed);
    const update = mockFindOneAndUpdate(takenOver);

    const lease = await acquireEndpointSecurityMutationLease({
      wabaId: "waba-1",
      kind: "ROTATE",
      semanticOperationId: "rotate-operation-1",
      candidateKeySet: secondKeySet,
      ownerToken: "owner-2",
      now: NOW,
      leaseExpiresAt: LATER,
    });

    expect(lease?.generationId).toBe(activeKeySet.generationId);
    const body = update.mock.calls[0]![1] as { $set: Record<string, unknown> };
    expect(body.$set).not.toHaveProperty("pendingKeySet");
    expect(body.$set["mutation.generationId"]).toBe(activeKeySet.generationId);
    expect(update.mock.calls[0]![0]).toMatchObject({
      "pendingKeySet.generationId": activeKeySet.generationId,
      "mutation.leaseExpiresAt": { $lte: NOW },
    });
  });

  it("does not overwrite a live pending winner with a concurrent ROTATE candidate", async () => {
    const live = endpointSecurityRecord({
      pendingKeySet: activeKeySet,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate-operation-1",
        generationId: activeKeySet.generationId,
        ownerToken: "other-owner",
        fence: 2,
        leaseExpiresAt: LATER,
      },
    });
    mockFindOne(live);
    const update = jest
      .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("unexpected endpoint-security write");
      });

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: secondKeySet,
        ownerToken: "owner-2",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("lets the same owner advance the fence but never abandons a resumable operation", async () => {
    const live = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        ownerToken: "owner-1",
        fence: 4,
        leaseExpiresAt: LATER,
      },
    });
    const advanced = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: { ...live.mutation, fence: 5 },
    });
    mockFindOne(live, {
      ...live,
      mutation: {
        ...live.mutation,
        semanticOperationId: "other-operation",
        leaseExpiresAt: NOW,
      },
    });
    const update = mockFindOneAndUpdate(advanced);

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: activeKeySet,
        ownerToken: "owner-1",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toMatchObject({ fence: 5 });
    expect(update.mock.calls[0]![1]).toMatchObject({
      $inc: { "mutation.fence": 1 },
    });

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: activeKeySet,
        ownerToken: "owner-1",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("binds ENSURE only to active material while no pending rotation exists", async () => {
    const initial = endpointSecurityRecord();
    const acquired = endpointSecurityRecord({
      mutation: {
        kind: "ENSURE",
        status: "RUNNING",
        semanticOperationId: "ensure-operation-1",
        generationId: activeKeySet.generationId,
        ownerToken: "owner-1",
        fence: 1,
        leaseExpiresAt: LATER,
      },
    });
    mockFindOne(initial, initial);
    const update = mockFindOneAndUpdate(acquired);

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ENSURE",
        semanticOperationId: "ensure-operation-1",
        candidateGenerationId: activeKeySet.generationId,
        ownerToken: "owner-1",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toMatchObject({ generationId: activeKeySet.generationId });
    expect(
      (update.mock.calls[0]![1] as { $set: Record<string, unknown> }).$set
    ).not.toHaveProperty("pendingKeySet");
    expect(update.mock.calls[0]![0]).toMatchObject({
      "activeKeySet.generationId": activeKeySet.generationId,
      pendingKeySet: { $exists: false },
    });

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ENSURE",
        semanticOperationId: "ensure-operation-2",
        candidateGenerationId: "unknown-generation",
        ownerToken: "owner-2",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).rejects.toBeInstanceOf(EndpointSecurityMutationConflictError);
  });

  it("cannot overwrite a pending rotation that wins between ENSURE read and CAS", async () => {
    const initial = endpointSecurityRecord();
    const failedRotation = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "FAILED",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        fence: 4,
        updatedAt: NOW,
      },
    });
    const overwritten = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ENSURE",
        status: "RUNNING",
        semanticOperationId: "ensure-operation-1",
        generationId: activeKeySet.generationId,
        ownerToken: "owner-1",
        fence: 5,
        leaseExpiresAt: LATER,
        updatedAt: NOW,
      },
    });
    mockFindOne(initial, failedRotation);
    const update = mockFindOneAndUpdate(null, overwritten);

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ENSURE",
        semanticOperationId: "ensure-operation-1",
        candidateGenerationId: activeKeySet.generationId,
        ownerToken: "owner-1",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toBeNull();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      "activeKeySet.generationId": activeKeySet.generationId,
      pendingKeySet: { $exists: false },
    });
  });

  it("validates lease times before database access", async () => {
    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: secondKeySet,
        ownerToken: "owner-1",
        now: NOW,
        leaseExpiresAt: NOW,
      })
    ).rejects.toThrow("Lease expiry must be after now");
    await expect(
      renewEndpointSecurityMutationLease({
        lease: mutationLease(),
        now: NOW,
        leaseExpiresAt: NOW,
      })
    ).rejects.toThrow("Lease expiry must be after now");
    expect(connectDB).not.toHaveBeenCalled();
  });

  it("renews without shortening, asserts explicit-time fences, and releases only the exact owner", async () => {
    const lease = mutationLease();
    const renewedRecord = endpointSecurityRecord({
      mutation: {
        kind: lease.kind,
        status: "RUNNING",
        semanticOperationId: lease.semanticOperationId,
        generationId: lease.generationId,
        ownerToken: lease.ownerToken,
        fence: lease.fence,
        leaseExpiresAt: new Date("2026-07-30T10:10:00.000Z"),
      },
    });
    const update = mockFindOneAndUpdate(renewedRecord, null, renewedRecord);
    mockFindOne(renewedRecord, null);

    await expect(
      renewEndpointSecurityMutationLease({
        lease,
        now: NOW,
        leaseExpiresAt: new Date("2026-07-30T10:10:00.000Z"),
      })
    ).resolves.toBe(true);
    expect(update.mock.calls[0]![0]).toMatchObject({
      wabaId: lease.wabaId,
      "mutation.kind": lease.kind,
      "mutation.semanticOperationId": lease.semanticOperationId,
      "mutation.generationId": lease.generationId,
      "mutation.ownerToken": lease.ownerToken,
      "mutation.fence": lease.fence,
      "mutation.status": "RUNNING",
      "mutation.leaseExpiresAt": {
        $gt: NOW,
        $lte: new Date("2026-07-30T10:10:00.000Z"),
      },
    });

    await expect(
      renewEndpointSecurityMutationLease({
        lease,
        now: NOW,
        leaseExpiresAt: new Date("2026-07-30T10:04:00.000Z"),
      })
    ).resolves.toBe(false);

    await expect(
      assertEndpointSecurityFence({ lease, now: NOW })
    ).resolves.toBeUndefined();
    await expect(
      assertEndpointSecurityFence({ lease, now: NOW })
    ).rejects.toBeInstanceOf(EndpointSecurityMutationConflictError);

    await expect(releaseEndpointSecurityMutationLease(lease)).resolves.toBe(
      true
    );
    expect(update.mock.calls[2]![0]).toEqual({
      wabaId: lease.wabaId,
      "mutation.kind": lease.kind,
      "mutation.semanticOperationId": lease.semanticOperationId,
      "mutation.generationId": lease.generationId,
      "mutation.ownerToken": lease.ownerToken,
      "mutation.fence": lease.fence,
    });
    expect(update.mock.calls[2]![1]).toEqual({
      $unset: {
        "mutation.ownerToken": 1,
        "mutation.leaseExpiresAt": 1,
      },
    });
    expect(update.mock.calls[2]![2]).toEqual({
      new: true,
      runValidators: true,
    });
  });

  const phoneState = {
    phoneNumberId: "phone-1",
    generationId: "placeholder",
    publicKeyFingerprint: "a".repeat(64),
    signatureStatus: "VALID" as const,
    stage: "READY" as const,
    verifiedAt: NOW,
    updatedAt: NOW,
  };
  const failure = {
    code: "PROVIDER_REJECTED",
    message: "Provider rejected the public key",
    stage: "VERIFYING",
    retryable: true,
    at: NOW,
  };

  const FENCED_MUTATION_LABELS = [
    "replace phones",
    "set provisioning",
    "promote pending",
    "complete",
    "fail",
  ] as const;

  function fencedMutationFor(
    label: (typeof FENCED_MUTATION_LABELS)[number]
  ): EndpointSecurityFencedMutation {
    switch (label) {
      case "replace phones":
        return {
          type: "replace-phones",
          phones: [{ ...phoneState, generationId: secondKeySet.generationId }],
        };
      case "set provisioning":
        return {
          type: "set-provisioning",
          state: {
            status: "IN_PROGRESS",
            generationId: secondKeySet.generationId,
            updatedAt: NOW,
          },
        };
      case "promote pending":
        return {
          type: "promote-pending",
          activeKeySet: secondKeySet,
          expectedActiveGenerationId: activeKeySet.generationId,
          previousKeySets: [{ ...activeKeySet, retireAt: LATER }],
          phones: [{ ...phoneState, generationId: secondKeySet.generationId }],
          completedAt: NOW,
        };
      case "complete":
        return { type: "complete", completedAt: NOW };
      case "fail":
        return { type: "fail", error: failure };
    }
  }

  function leaseForMutation(
    mutation: EndpointSecurityFencedMutation
  ): EndpointSecurityMutationLease {
    return mutation.type === "complete"
      ? mutationLease({
          kind: "ENSURE",
          semanticOperationId: "ensure-operation-1",
          generationId: activeKeySet.generationId,
        })
      : mutationLease();
  }

  it.each(FENCED_MUTATION_LABELS)(
    "applies %s with the complete live lease identity in one guarded CAS",
    async label => {
      const mutation = fencedMutationFor(label);
      const lease = leaseForMutation(mutation);
      const winner = endpointSecurityRecord({
        pendingKeySet: secondKeySet,
        mutation: {
          kind: lease.kind,
          status: "RUNNING",
          semanticOperationId: lease.semanticOperationId,
          generationId: lease.generationId,
          ownerToken: lease.ownerToken,
          fence: lease.fence,
          leaseExpiresAt: lease.leaseExpiresAt,
        },
      });
      const update = mockFindOneAndUpdate(winner);

      await expect(
        applyEndpointSecurityFencedMutation({ lease, now: NOW, mutation })
      ).resolves.toBe(winner);

      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]![0]).toMatchObject({
        wabaId: lease.wabaId,
        "mutation.status": "RUNNING",
        "mutation.kind": lease.kind,
        "mutation.semanticOperationId": lease.semanticOperationId,
        "mutation.generationId": lease.generationId,
        "mutation.ownerToken": lease.ownerToken,
        "mutation.fence": lease.fence,
        "mutation.leaseExpiresAt": { $gt: NOW },
      });
      expect(update.mock.calls[0]![2]).toEqual({
        new: true,
        runValidators: true,
      });
      if (mutation.type === "promote-pending") {
        expect(update.mock.calls[0]![0]).toMatchObject({
          "pendingKeySet.generationId": lease.generationId,
          "activeKeySet.generationId": activeKeySet.generationId,
        });
        expect(update.mock.calls[0]![1]).toMatchObject({
          $set: {
            activeKeySet: {
              ...mutation.activeKeySet,
              activatedAt: NOW,
            },
            previousKeySets: mutation.previousKeySets,
            phones: mutation.phones,
            keyProvisioning: {
              status: "READY",
              generationId: lease.generationId,
              updatedAt: NOW,
            },
            "mutation.status": "COMPLETED",
            "mutation.updatedAt": NOW,
          },
          $unset: {
            pendingKeySet: 1,
            "mutation.lastError": 1,
          },
        });
      }
    }
  );

  it.each(FENCED_MUTATION_LABELS)(
    "rejects a stale owner before %s without an unfenced retry",
    async label => {
      const mutation = fencedMutationFor(label);
      const update = mockFindOneAndUpdate(null);

      await expect(
        applyEndpointSecurityFencedMutation({
          lease: leaseForMutation(mutation),
          now: NOW,
          mutation,
        })
      ).rejects.toBeInstanceOf(EndpointSecurityMutationConflictError);
      expect(update).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects generation-mismatched material and unbounded promotion history before Mongo", async () => {
    const update = jest
      .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("unexpected endpoint-security write");
      });
    const lease = mutationLease();

    await expect(
      applyEndpointSecurityFencedMutation({
        lease,
        now: NOW,
        mutation: {
          type: "replace-phones",
          phones: [{ ...phoneState, generationId: activeKeySet.generationId }],
        },
      })
    ).rejects.toThrow("Phone generation must match the mutation lease");
    await expect(
      applyEndpointSecurityFencedMutation({
        lease,
        now: NOW,
        mutation: {
          type: "set-provisioning",
          state: {
            status: "IN_PROGRESS",
            generationId: activeKeySet.generationId,
            updatedAt: NOW,
          },
        },
      })
    ).rejects.toThrow("Provisioning generation must match the mutation lease");
    await expect(
      applyEndpointSecurityFencedMutation({
        lease,
        now: NOW,
        mutation: {
          type: "promote-pending",
          activeKeySet: secondKeySet,
          expectedActiveGenerationId: activeKeySet.generationId,
          previousKeySets: [
            { ...activeKeySet, retireAt: LATER },
            { ...activeKeySet, retireAt: LATER },
            { ...activeKeySet, retireAt: LATER },
          ],
          phones: [],
          completedAt: NOW,
        },
      })
    ).rejects.toThrow("At most two previous WhatsApp Flow key sets");
    expect(update).not.toHaveBeenCalled();
  });

  type PromotionContinuityCase = {
    label: string;
    previousKeySets: Array<{
      kind: "incoming" | "outgoing";
      retireAt?: Date;
    }>;
    expectedActiveGenerationId: "active" | "incoming";
    expectedError: string;
  };

  const promotionContinuityCases: PromotionContinuityCase[] = [
    {
      label: "missing outgoing generation",
      previousKeySets: [],
      expectedActiveGenerationId: "active",
      expectedError:
        "Promotion history must contain the outgoing active generation exactly once",
    },
    {
      label: "missing retirement time",
      previousKeySets: [{ kind: "outgoing" }],
      expectedActiveGenerationId: "active",
      expectedError: "Previous key retirement must be after promotion",
    },
    {
      label: "retirement at the promotion boundary",
      previousKeySets: [{ kind: "outgoing", retireAt: NOW }],
      expectedActiveGenerationId: "active",
      expectedError: "Previous key retirement must be after promotion",
    },
    {
      label: "duplicate outgoing generations",
      previousKeySets: [
        { kind: "outgoing", retireAt: LATER },
        { kind: "outgoing", retireAt: LATER },
      ],
      expectedActiveGenerationId: "active",
      expectedError: "Promotion history generations must be unique",
    },
    {
      label: "incoming generation in history",
      previousKeySets: [
        { kind: "outgoing", retireAt: LATER },
        { kind: "incoming", retireAt: LATER },
      ],
      expectedActiveGenerationId: "active",
      expectedError:
        "Promotion history cannot contain the incoming active generation",
    },
    {
      label: "incoming generation named as outgoing",
      previousKeySets: [{ kind: "incoming", retireAt: LATER }],
      expectedActiveGenerationId: "incoming",
      expectedError: "Outgoing active generation must differ from incoming",
    },
  ];

  it.each(promotionContinuityCases)(
    "rejects promotion continuity violation: $label",
    async testCase => {
      const update = jest
        .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
        .mockImplementation(() => {
          throw new Error("unexpected endpoint-security write");
        });
      const previousKeySets = testCase.previousKeySets.map(entry => ({
        ...(entry.kind === "incoming" ? secondKeySet : activeKeySet),
        ...(entry.retireAt ? { retireAt: entry.retireAt } : {}),
      }));

      await expect(
        applyEndpointSecurityFencedMutation({
          lease: mutationLease(),
          now: NOW,
          mutation: {
            type: "promote-pending",
            activeKeySet: secondKeySet,
            expectedActiveGenerationId:
              testCase.expectedActiveGenerationId === "incoming"
                ? secondKeySet.generationId
                : activeKeySet.generationId,
            previousKeySets,
            phones: [],
            completedAt: NOW,
          },
        })
      ).rejects.toThrow(testCase.expectedError);
      expect(update).not.toHaveBeenCalled();
    }
  );

  it("does not restart the same semantic rotation after its terminal promotion", async () => {
    const completed = endpointSecurityRecord({
      activeKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "COMPLETED",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        fence: 5,
        updatedAt: NOW,
      },
      keyProvisioning: {
        status: "READY",
        generationId: secondKeySet.generationId,
        updatedAt: NOW,
      },
    });
    mockFindOne(completed);
    const update = jest
      .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("unexpected endpoint-security write");
      });

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: activeKeySet,
        ownerToken: "owner-2",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("allows only the same semantic operation to resume a failed durable pending rotation", async () => {
    const failed = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "FAILED",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        fence: 5,
        lastError: failure,
        updatedAt: NOW,
      },
    });
    mockFindOne(failed);
    const update = jest
      .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("unexpected endpoint-security write");
      });

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-2",
        candidateKeySet: activeKeySet,
        ownerToken: "owner-2",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("resumes a failed rotation with the same semantic operation and durable pending key", async () => {
    const failed = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "FAILED",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        fence: 5,
        lastError: failure,
        updatedAt: NOW,
      },
    });
    const acquired = endpointSecurityRecord({
      pendingKeySet: secondKeySet,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate-operation-1",
        generationId: secondKeySet.generationId,
        ownerToken: "owner-2",
        fence: 6,
        leaseExpiresAt: LATER,
        updatedAt: NOW,
      },
    });
    mockFindOne(failed);
    const update = mockFindOneAndUpdate(acquired);

    await expect(
      acquireEndpointSecurityMutationLease({
        wabaId: "waba-1",
        kind: "ROTATE",
        semanticOperationId: "rotate-operation-1",
        candidateKeySet: activeKeySet,
        ownerToken: "owner-2",
        now: NOW,
        leaseExpiresAt: LATER,
      })
    ).resolves.toMatchObject({
      generationId: secondKeySet.generationId,
      fence: 6,
    });
    expect(
      (update.mock.calls[0]![1] as { $set: Record<string, unknown> }).$set
    ).not.toHaveProperty("pendingKeySet");
  });

  it("requires ROTATE to complete through the atomic promotion transition", async () => {
    const update = jest
      .spyOn(WhatsAppFlowEndpointSecurity, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("unexpected endpoint-security write");
      });

    await expect(
      applyEndpointSecurityFencedMutation({
        lease: mutationLease(),
        now: NOW,
        mutation: { type: "complete", completedAt: NOW },
      })
    ).rejects.toThrow("Rotation must complete through pending-key promotion");
    expect(update).not.toHaveBeenCalled();
  });
});
