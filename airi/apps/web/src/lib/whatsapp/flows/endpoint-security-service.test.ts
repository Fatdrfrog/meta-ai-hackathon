/**
 * @jest-environment node
 */

import {
  createWhatsAppFlowEndpointSecurityService,
  EndpointSecurityServiceError,
  type ResolvedEndpointSecurityContext,
} from "@/lib/whatsapp/flows/endpoint-security-service";
import type { ManagedFlowReleasePolicy } from "@/lib/whatsapp/flows/managed-flow-release-policy";
import type {
  WhatsAppFlowEndpointSecurityRecord,
  WhatsAppFlowKeySet,
} from "@/models/whatsapp-flow-endpoint-security";

const NOW = new Date("2026-07-30T10:00:00.000Z");
const CONTEXT: ResolvedEndpointSecurityContext = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  wabaId: "waba-1",
  applicationId: "application-1",
  accessToken: "access-token-secret",
};

const ACTIVE_KEY: WhatsAppFlowKeySet = {
  generationId: "generation-active",
  origin: "WABA_GENERATED",
  rsaKeyId: "rsa-active",
  encryptedPrivateKey: {
    iv: "private-iv-secret",
    tag: "private-tag-secret",
    ciphertext: "private-ciphertext-secret",
  },
  publicKeyFingerprint: "a".repeat(64),
  signingKeyId: "sign-active",
  encryptedSigningKey: {
    iv: "signing-iv-secret",
    tag: "signing-tag-secret",
    ciphertext: "signing-ciphertext-secret",
  },
  createdAt: new Date("2026-07-29T10:00:00.000Z"),
  activatedAt: new Date("2026-07-29T11:00:00.000Z"),
};
const LEGACY_KEY: WhatsAppFlowKeySet = {
  ...ACTIVE_KEY,
  generationId: "generation-legacy",
  origin: "LEGACY_IMPORTED",
  rsaKeyId: "rsa-legacy",
  publicKeyFingerprint: "b".repeat(64),
  signingKeyId: "sign-legacy",
};
const GENERATED_KEY: WhatsAppFlowKeySet = {
  ...ACTIVE_KEY,
  generationId: "generation-generated",
  origin: "WABA_GENERATED",
  rsaKeyId: "rsa-generated",
  publicKeyFingerprint: "c".repeat(64),
  signingKeyId: "sign-generated",
  createdAt: NOW,
  activatedAt: undefined,
};
const WINNER_KEY: WhatsAppFlowKeySet = {
  ...GENERATED_KEY,
  generationId: "generation-winner",
  rsaKeyId: "rsa-winner",
  publicKeyFingerprint: "e".repeat(64),
  signingKeyId: "sign-winner",
};
const PREVIOUS_KEY: WhatsAppFlowKeySet = {
  ...ACTIVE_KEY,
  generationId: "generation-previous",
  rsaKeyId: "rsa-previous",
  publicKeyFingerprint: "f".repeat(64),
  signingKeyId: "sign-previous",
  retireAt: new Date("2026-08-01T10:00:00.000Z"),
};
const PHONE_1 = {
  id: "phone-1",
  display_phone_number: "+77010000001",
};
const ACTIVE_KEY_READY_STATUS = {
  configured: true as const,
  businessPublicKey: "public-key-pem-generation-active",
  signatureStatus: "VALID" as const,
};
const GENERATED_KEY_READY_STATUS = {
  configured: true as const,
  businessPublicKey: "public-key-pem-generation-generated",
  signatureStatus: "VALID" as const,
};

function lease(
  overrides: Partial<{
    kind: "ENSURE" | "ROTATE";
    semanticOperationId: string;
    generationId: string;
  }> = {}
) {
  return {
    wabaId: "waba-1",
    kind: "ENSURE" as const,
    semanticOperationId: "ensure:waba-1:generation-active:0",
    generationId: ACTIVE_KEY.generationId,
    ownerToken: "owner-token",
    fence: 1,
    leaseExpiresAt: new Date("2026-07-30T10:02:00.000Z"),
    ...overrides,
  };
}

function securityRecord(
  overrides: Partial<WhatsAppFlowEndpointSecurityRecord> = {}
): WhatsAppFlowEndpointSecurityRecord {
  return {
    workspaceId: "workspace-1",
    wabaId: "waba-1",
    endpointId: "endpoint-1",
    applicationId: "application-1",
    activeKeySet: ACTIVE_KEY,
    previousKeySets: [],
    phones: [],
    keyProvisioning: { status: "NOT_STARTED" },
    mutation: { status: "IDLE", fence: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createDependencies(
  releasePolicy: ManagedFlowReleasePolicy = {
    state: "dark",
    activatedAt: null,
    legacyCutoffAt: null,
  }
) {
  return {
    releasePolicy,
    now: jest.fn(() => NOW),
    createOwnerToken: jest.fn(() => "owner-token"),
    findSecurity: jest.fn().mockResolvedValue(null),
    findSecurityByEndpointId: jest.fn().mockResolvedValue(null),
    loadOrCreateSecurity: jest.fn(),
    acquireLease: jest.fn(),
    renewLease: jest.fn(),
    assertFence: jest.fn(),
    releaseLease: jest.fn(),
    applyMutation: jest.fn(),
    listPhones: jest.fn(),
    getEncryptionStatus: jest.fn(),
    uploadPublicKey: jest.fn(),
    getMaxActiveSessionExpiry: jest.fn(),
    generateKeySet: jest.fn(),
    importLegacyKeySet: jest.fn(),
    loadLegacyPrivateKey: jest.fn(),
    loadKeySet: jest.fn((keySet: WhatsAppFlowKeySet) => ({
      generationId: keySet.generationId,
      rsaKeyId: keySet.rsaKeyId,
      privateKeyPem: "private-key-pem",
      publicKeyPem: `public-key-pem-${keySet.generationId}`,
      publicKeyFingerprint: keySet.publicKeyFingerprint,
      signingKeyId: keySet.signingKeyId,
      signingKey: Buffer.alloc(32),
    })),
    computePublicKeyFingerprint: jest.fn((publicKeyPem: string) => {
      if (publicKeyPem === "foreign-public-key-pem") return "d".repeat(64);
      const generationId = publicKeyPem.replace("public-key-pem-", "");
      if (generationId === ACTIVE_KEY.generationId) {
        return ACTIVE_KEY.publicKeyFingerprint;
      }
      if (generationId === GENERATED_KEY.generationId) {
        return GENERATED_KEY.publicKeyFingerprint;
      }
      if (generationId === LEGACY_KEY.generationId) {
        return LEGACY_KEY.publicKeyFingerprint;
      }
      throw new Error("unexpected public key fixture");
    }),
    resolveEndpointUri: jest.fn(
      (endpointId: string) => `https://flows.example.test/${endpointId}`
    ),
  };
}

describe("WhatsApp Flow endpoint-security orchestration", () => {
  it("resolves active, pending, and live previous runtime keys in decryption order while release remains dark", async () => {
    const dependencies = createDependencies();
    const expiredPreviousKey: WhatsAppFlowKeySet = {
      ...PREVIOUS_KEY,
      generationId: "generation-expired",
      rsaKeyId: "rsa-expired",
      signingKeyId: "sign-expired",
      retireAt: new Date("2026-07-30T09:59:59.999Z"),
    };
    dependencies.findSecurityByEndpointId.mockResolvedValue(
      securityRecord({
        pendingKeySet: GENERATED_KEY,
        previousKeySets: [PREVIOUS_KEY, expiredPreviousKey],
      })
    );
    dependencies.loadKeySet.mockImplementation(
      (keySet: WhatsAppFlowKeySet) => ({
        generationId: keySet.generationId,
        rsaKeyId: keySet.rsaKeyId,
        privateKeyPem: `private-${keySet.generationId}`,
        publicKeyPem: `public-${keySet.generationId}`,
        publicKeyFingerprint: keySet.publicKeyFingerprint,
        signingKeyId: keySet.signingKeyId,
        signingKey: Buffer.alloc(32),
      })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.resolveRuntimeKeyCandidates("endpoint-1", NOW)
    ).resolves.toEqual({
      endpointId: "endpoint-1",
      keyCandidates: [
        {
          generationId: ACTIVE_KEY.generationId,
          privateKeyPem: `private-${ACTIVE_KEY.generationId}`,
        },
        {
          generationId: GENERATED_KEY.generationId,
          privateKeyPem: `private-${GENERATED_KEY.generationId}`,
        },
        {
          generationId: PREVIOUS_KEY.generationId,
          privateKeyPem: `private-${PREVIOUS_KEY.generationId}`,
        },
      ],
    });
    expect(dependencies.findSecurityByEndpointId).toHaveBeenCalledWith(
      "endpoint-1"
    );
    expect(dependencies.loadKeySet).toHaveBeenCalledTimes(3);
  });

  it("does not disclose an unknown managed endpoint through runtime key resolution", async () => {
    const dependencies = createDependencies();
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.resolveRuntimeKeyCandidates("unknown-endpoint", NOW)
    ).resolves.toBeNull();
  });

  it("returns a stable absent status without any create, key, lease, inventory, session, or provider work", async () => {
    const dependencies = createDependencies();
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.getStatus(CONTEXT, NOW)).resolves.toEqual({
      configured: false,
      endpointUri: null,
      release: {
        stage: "DARK",
        managedFlowEnabled: false,
        legacyFlowAllowed: true,
        legacyCutoffAt: null,
      },
      activeKey: null,
      pendingKey: null,
      previousKeys: [],
      provisioning: { status: "NOT_STARTED" },
      phones: [],
    });

    expect(dependencies.findSecurity).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      wabaId: "waba-1",
      applicationId: "application-1",
    });
    for (const forbidden of [
      dependencies.loadOrCreateSecurity,
      dependencies.acquireLease,
      dependencies.applyMutation,
      dependencies.listPhones,
      dependencies.getEncryptionStatus,
      dependencies.uploadPublicKey,
      dependencies.getMaxActiveSessionExpiry,
      dependencies.generateKeySet,
      dependencies.importLegacyKeySet,
      dependencies.loadLegacyPrivateKey,
    ]) {
      expect(forbidden).not.toHaveBeenCalled();
    }
  });

  it("imports and persists the legacy active key during pre-cutoff identity resolution without phone work", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-24T10:00:00.000Z",
      legacyCutoffAt: "2026-07-31T10:00:00.000Z",
    });
    dependencies.loadLegacyPrivateKey.mockReturnValue("legacy-private-key-pem");
    dependencies.importLegacyKeySet.mockReturnValue(LEGACY_KEY);
    dependencies.loadOrCreateSecurity.mockResolvedValue(
      securityRecord({ activeKeySet: LEGACY_KEY })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.resolveIdentity(CONTEXT, NOW)).resolves.toMatchObject({
      configured: true,
      endpointUri: "https://flows.example.test/endpoint-1",
      expectedGenerationId: "generation-legacy",
      activeKey: {
        generationId: "generation-legacy",
        origin: "LEGACY_IMPORTED",
      },
      pendingKey: null,
    });

    expect(dependencies.importLegacyKeySet).toHaveBeenCalledWith({
      privateKeyPem: "legacy-private-key-pem",
      now: expect.any(Function),
    });
    expect(dependencies.loadKeySet).toHaveBeenCalledWith(LEGACY_KEY);
    expect(dependencies.loadOrCreateSecurity).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      wabaId: "waba-1",
      applicationId: "application-1",
      initialActiveKeySet: LEGACY_KEY,
    });
    expect(dependencies.generateKeySet).not.toHaveBeenCalled();
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("keeps endpoint identity internal while preserving the existing safe resolver", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    const safeIdentity = await service.resolveIdentity(CONTEXT, NOW);
    const managedIdentity = await service.resolveManagedIdentity(CONTEXT, NOW);

    expect(safeIdentity).not.toHaveProperty("endpointId");
    expect(managedIdentity).toMatchObject({
      endpointId: "endpoint-1",
      endpointUri: "https://flows.example.test/endpoint-1",
      expectedGenerationId: ACTIVE_KEY.generationId,
    });
    const serialized = JSON.stringify(managedIdentity);
    for (const secret of [
      "private-ciphertext-secret",
      "signing-ciphertext-secret",
      "access-token-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("creates one generated active key at the cutoff identity boundary", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.generateKeySet.mockReturnValue(GENERATED_KEY);
    dependencies.loadOrCreateSecurity.mockResolvedValue(
      securityRecord({ activeKeySet: GENERATED_KEY })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.resolveIdentity(CONTEXT, NOW)).resolves.toMatchObject({
      expectedGenerationId: "generation-generated",
      activeKey: {
        generationId: "generation-generated",
        origin: "WABA_GENERATED",
      },
    });

    expect(dependencies.generateKeySet).toHaveBeenCalledWith({
      now: expect.any(Function),
    });
    expect(dependencies.importLegacyKeySet).not.toHaveBeenCalled();
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
  });

  it("durably establishes and releases one generated pending key for post-cutoff legacy identity", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const legacyRecord = securityRecord({ activeKeySet: LEGACY_KEY });
    const pendingRecord = securityRecord({
      activeKeySet: LEGACY_KEY,
      pendingKeySet: GENERATED_KEY,
    });
    dependencies.findSecurity
      .mockResolvedValueOnce(legacyRecord)
      .mockResolvedValueOnce(pendingRecord);
    dependencies.generateKeySet.mockReturnValue(GENERATED_KEY);
    const lease = {
      wabaId: "waba-1",
      kind: "ROTATE" as const,
      semanticOperationId: "rotate:waba-1:generation-legacy",
      generationId: "generation-generated",
      ownerToken: "owner-token",
      fence: 1,
      leaseExpiresAt: new Date("2026-07-30T10:02:00.000Z"),
    };
    dependencies.acquireLease.mockResolvedValue(lease);
    dependencies.releaseLease.mockResolvedValue(true);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.resolveIdentity(CONTEXT, NOW)).resolves.toMatchObject({
      expectedGenerationId: "generation-generated",
      activeKey: { generationId: "generation-legacy" },
      pendingKey: {
        generationId: "generation-generated",
        origin: "WABA_GENERATED",
      },
    });

    expect(dependencies.acquireLease).toHaveBeenCalledWith({
      wabaId: "waba-1",
      kind: "ROTATE",
      semanticOperationId: "rotate:waba-1:generation-legacy",
      candidateKeySet: GENERATED_KEY,
      ownerToken: "owner-token",
      now: NOW,
      leaseExpiresAt: new Date("2026-07-30T10:02:00.000Z"),
    });
    expect(dependencies.releaseLease).toHaveBeenCalledWith(lease);
    expect(dependencies.findSecurity).toHaveBeenCalledTimes(2);
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("joins a concurrent rotation winner through the stable outgoing-active semantic epoch", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity
      .mockResolvedValueOnce(securityRecord({ activeKeySet: LEGACY_KEY }))
      .mockResolvedValueOnce(
        securityRecord({
          activeKeySet: LEGACY_KEY,
          pendingKeySet: WINNER_KEY,
        })
      );
    dependencies.generateKeySet.mockReturnValue(GENERATED_KEY);
    dependencies.acquireLease.mockResolvedValue(null);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.resolveIdentity(CONTEXT, NOW)).resolves.toMatchObject({
      expectedGenerationId: "generation-winner",
      pendingKey: { generationId: "generation-winner" },
    });

    expect(dependencies.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        semanticOperationId: "rotate:waba-1:generation-legacy",
        candidateKeySet: GENERATED_KEY,
      })
    );
    expect(
      dependencies.acquireLease.mock.calls[0]![0].semanticOperationId
    ).not.toContain(GENERATED_KEY.generationId);
    expect(dependencies.releaseLease).not.toHaveBeenCalled();
  });

  it("fails identity resolution when its bootstrap lease cannot be released", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(
      securityRecord({ activeKeySet: LEGACY_KEY })
    );
    dependencies.generateKeySet.mockReturnValue(GENERATED_KEY);
    dependencies.acquireLease.mockResolvedValue(
      lease({
        kind: "ROTATE",
        semanticOperationId: "rotate:waba-1:generation-legacy",
        generationId: GENERATED_KEY.generationId,
      })
    );
    dependencies.releaseLease.mockResolvedValue(false);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.resolveIdentity(CONTEXT, NOW)).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    });
    expect(dependencies.findSecurity).toHaveBeenCalledTimes(1);
    expect(dependencies.listPhones).not.toHaveBeenCalled();
  });

  it("preflights the complete WABA inventory and hard-stops a foreign key before every upload even for an internal subset", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const record = securityRecord();
    dependencies.findSecurity.mockResolvedValue(record);
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-2", display_phone_number: "+77010000002" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "foreign-public-key-pem",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockResolvedValue(record);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    let failure: unknown;
    try {
      await service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        phoneNumberIds: ["phone-1"],
        now: NOW,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EndpointSecurityServiceError);
    expect(failure).toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_FOREIGN_KEY",
    });
    expect(dependencies.listPhones).toHaveBeenCalledWith({
      wabaId: "waba-1",
      accessToken: "access-token-secret",
      beforePage: expect.any(Function),
    });
    expect(dependencies.getEncryptionStatus).toHaveBeenCalledTimes(2);
    expect(dependencies.getEncryptionStatus).toHaveBeenNthCalledWith(1, {
      phoneNumberId: "phone-1",
      accessToken: "access-token-secret",
    });
    expect(dependencies.getEncryptionStatus).toHaveBeenNthCalledWith(2, {
      phoneNumberId: "phone-2",
      accessToken: "access-token-secret",
    });
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
    expect(dependencies.releaseLease).toHaveBeenCalledWith(lease());
  });

  it("reuploads an expected but invalid key, verifies readback, and completes readiness", async () => {
    const events: string[] = [];
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const readyRecord = securityRecord({
      keyProvisioning: {
        status: "READY",
        generationId: ACTIVE_KEY.generationId,
        updatedAt: NOW,
      },
      phones: [
        {
          phoneNumberId: "phone-1",
          generationId: ACTIVE_KEY.generationId,
          publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
          signatureStatus: "VALID",
          stage: "READY",
          verifiedAt: NOW,
          updatedAt: NOW,
        },
        {
          phoneNumberId: "phone-2",
          generationId: ACTIVE_KEY.generationId,
          publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
          signatureStatus: "VALID",
          stage: "READY",
          verifiedAt: NOW,
          updatedAt: NOW,
        },
      ],
      mutation: {
        kind: "ENSURE",
        status: "COMPLETED",
        semanticOperationId: "ensure:waba-1:generation-active:0",
        generationId: ACTIVE_KEY.generationId,
        fence: 1,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.renewLease.mockImplementation(async () => {
      events.push("renew");
      return true;
    });
    dependencies.assertFence.mockImplementation(async () => {
      events.push("assert");
    });
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-2", display_phone_number: "+77010000002" },
    ]);
    const providerStatuses = [
      {
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "INVALID",
      } as const,
      { configured: false } as const,
      {
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      } as const,
      {
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      } as const,
    ];
    let providerStatusIndex = 0;
    dependencies.getEncryptionStatus.mockImplementation(
      async ({ phoneNumberId }: { phoneNumberId: string }) => {
        const phase = providerStatusIndex < 2 ? "preflight" : "readback";
        events.push(`get:${phoneNumberId}:${phase}`);
        return providerStatuses[providerStatusIndex++]!;
      }
    );
    dependencies.uploadPublicKey.mockImplementation(
      async ({ phoneNumberId }: { phoneNumberId: string }) => {
        events.push(`post:${phoneNumberId}`);
      }
    );
    dependencies.applyMutation.mockImplementation(
      async ({ mutation }: { mutation: { type: string } }) => {
        events.push(`db:${mutation.type}`);
        return readyRecord;
      }
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).resolves.toMatchObject({
      configured: true,
      provisioning: {
        status: "READY",
        generationId: "generation-active",
      },
      phones: [
        { phoneNumberId: "phone-1", stage: "READY" },
        { phoneNumberId: "phone-2", stage: "READY" },
      ],
    });

    expect(dependencies.getEncryptionStatus).toHaveBeenCalledTimes(4);
    expect(dependencies.renewLease).toHaveBeenCalledTimes(2);
    expect(dependencies.assertFence).toHaveBeenCalledTimes(2);
    expect(dependencies.uploadPublicKey).toHaveBeenNthCalledWith(1, {
      phoneNumberId: "phone-1",
      businessPublicKey: "public-key-pem-generation-active",
      accessToken: "access-token-secret",
    });
    expect(dependencies.uploadPublicKey).toHaveBeenNthCalledWith(2, {
      phoneNumberId: "phone-2",
      businessPublicKey: "public-key-pem-generation-active",
      accessToken: "access-token-secret",
    });
    const firstPost = events.indexOf("post:phone-1");
    const secondPost = events.indexOf("post:phone-2");
    expect(events.indexOf("get:phone-1:preflight")).toBeLessThan(firstPost);
    expect(events.indexOf("get:phone-2:preflight")).toBeLessThan(firstPost);
    expect(events.slice(firstPost - 2, firstPost)).toEqual(["renew", "assert"]);
    expect(events.slice(secondPost - 2, secondPost)).toEqual([
      "renew",
      "assert",
    ]);
    const firstReadback = events.indexOf("get:phone-1:readback");
    const secondReadback = events.indexOf("get:phone-2:readback");
    expect(firstReadback).toBeGreaterThan(firstPost);
    expect(events[firstPost + 1]).toBe("db:replace-phones");
    expect(firstPost + 1).toBeLessThan(firstReadback);
    expect(events[firstReadback + 1]).toBe("db:replace-phones");
    expect(firstReadback + 1).toBeLessThan(secondPost);
    expect(secondReadback).toBeGreaterThan(secondPost);
    expect(events[secondPost + 1]).toBe("db:replace-phones");
    expect(secondPost + 1).toBeLessThan(secondReadback);
    expect(events[secondReadback + 1]).toBe("db:replace-phones");
    expect(dependencies.applyMutation).toHaveBeenCalledWith({
      lease: lease(),
      now: NOW,
      mutation: { type: "complete", completedAt: NOW },
    });
    expect(dependencies.releaseLease).toHaveBeenCalledWith(lease());
  });

  it("uses a fresh dependency clock for every lease and fenced-write boundary", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    let tick = 0;
    dependencies.now.mockImplementation(
      () => new Date(NOW.getTime() + ++tick * 1_000)
    );
    const readyRecord = securityRecord({
      keyProvisioning: {
        status: "READY",
        generationId: ACTIVE_KEY.generationId,
        updatedAt: NOW,
      },
      phones: [
        {
          phoneNumberId: "phone-1",
          generationId: ACTIVE_KEY.generationId,
          publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
          signatureStatus: "VALID",
          stage: "READY",
          verifiedAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockResolvedValue(readyRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await service.ensurePhoneKeyReadiness({
      context: CONTEXT,
      expectedGenerationId: ACTIVE_KEY.generationId,
      now: NOW,
    });

    const acquireNow = dependencies.acquireLease.mock.calls[0]![0].now;
    const writeTimes = dependencies.applyMutation.mock.calls.map(
      ([call]) => call.now as Date
    );
    const renewNow = dependencies.renewLease.mock.calls[0]![0].now;
    const assertNow = dependencies.assertFence.mock.calls[0]![0].now;
    const everyBoundary = [acquireNow, ...writeTimes, renewNow, assertNow];
    expect(new Set(everyBoundary.map(value => value.getTime())).size).toBe(
      everyBoundary.length
    );
    expect(renewNow.getTime()).toBeLessThan(assertNow.getTime());
    expect(
      dependencies.renewLease.mock.calls[0]![0].leaseExpiresAt.getTime()
    ).toBe(renewNow.getTime() + 2 * 60 * 1_000);
    expect(dependencies.now).toHaveBeenCalledTimes(everyBoundary.length + 1);
  });

  it("renews the lease during a slow full-inventory preflight before it can expire", async () => {
    let clockMs = NOW.getTime();
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const readyRecord = securityRecord({
      keyProvisioning: {
        status: "READY",
        generationId: ACTIVE_KEY.generationId,
        updatedAt: new Date(clockMs),
      },
      mutation: {
        kind: "ENSURE",
        status: "COMPLETED",
        semanticOperationId: "ensure:waba-1:generation-active:0",
        generationId: ACTIVE_KEY.generationId,
        fence: 1,
        updatedAt: new Date(clockMs),
      },
    });
    dependencies.now.mockImplementation(() => new Date(clockMs));
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.listPhones.mockImplementation(
      async (params: { beforePage?: () => Promise<void> }) => {
        await params.beforePage?.();
        clockMs += 70_000;
        return [
          { id: "phone-1", display_phone_number: "+77010000001" },
          { id: "phone-2", display_phone_number: "+77010000002" },
        ];
      }
    );
    dependencies.getEncryptionStatus.mockImplementation(async () => {
      clockMs += 70_000;
      return {
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      } as const;
    });
    dependencies.applyMutation.mockResolvedValue(readyRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).resolves.toMatchObject({ provisioning: { status: "READY" } });

    expect(dependencies.renewLease).toHaveBeenCalledTimes(2);
    expect(
      dependencies.renewLease.mock.calls.map(([call]) => call.now)
    ).toEqual([
      new Date(NOW.getTime() + 70_000),
      new Date(NOW.getTime() + 140_000),
    ]);
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("stops before provider status or POST when a preflight lease renewal is lost", async () => {
    let clockMs = NOW.getTime();
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.now.mockImplementation(() => new Date(clockMs));
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.renewLease.mockResolvedValue(false);
    dependencies.listPhones.mockImplementation(
      async (params: { beforePage?: () => Promise<void> }) => {
        await params.beforePage?.();
        clockMs += 70_000;
        return [{ id: "phone-1", display_phone_number: "+77010000001" }];
      }
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    });

    expect(dependencies.renewLease).toHaveBeenCalledTimes(1);
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("persists VERIFYING immediately after a provider write before a failing readback", async () => {
    const events: string[] = [];
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockImplementationOnce(async () => {
        events.push("readback");
        throw new Error("provider response secret");
      });
    dependencies.uploadPublicKey.mockImplementation(async () => {
      events.push("post");
    });
    dependencies.applyMutation.mockImplementation(async ({ mutation }) => {
      if (mutation.type === "replace-phones") {
        events.push(`db:${mutation.phones[0]?.stage ?? "empty"}`);
      }
      return securityRecord();
    });
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
      message: "WhatsApp could not verify the Flow endpoint public key",
    });

    const postIndex = events.indexOf("post");
    const verifyingIndex = events.indexOf("db:VERIFYING");
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(verifyingIndex).toBe(postIndex + 1);
    expect(events.indexOf("readback")).toBe(verifyingIndex + 1);
    expect(JSON.stringify(dependencies.applyMutation.mock.calls)).not.toContain(
      "provider response secret"
    );
  });

  it("keeps global provisioning IN_PROGRESS and omits an absent non-target phone for a partial subset", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const partialRecord = securityRecord({
      keyProvisioning: {
        status: "IN_PROGRESS",
        generationId: ACTIVE_KEY.generationId,
        updatedAt: NOW,
      },
      phones: [
        {
          phoneNumberId: "phone-1",
          generationId: ACTIVE_KEY.generationId,
          publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
          signatureStatus: "VALID",
          stage: "READY",
          verifiedAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-2", display_phone_number: "+77010000002" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockResolvedValue(partialRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        phoneNumberIds: ["phone-1"],
        now: NOW,
      })
    ).resolves.toMatchObject({
      provisioning: {
        status: "IN_PROGRESS",
        generationId: ACTIVE_KEY.generationId,
      },
      phones: [{ phoneNumberId: "phone-1", stage: "READY" }],
    });

    expect(dependencies.uploadPublicKey).toHaveBeenCalledTimes(1);
    expect(dependencies.uploadPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "phone-1" })
    );
    expect(dependencies.applyMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({
          type: "set-provisioning",
          state: expect.objectContaining({ status: "READY" }),
        }),
      })
    );
    for (const [call] of dependencies.applyMutation.mock.calls) {
      if (call.mutation.type !== "replace-phones") continue;
      expect(call.mutation.phones).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phoneNumberId: "phone-2",
            generationId: ACTIVE_KEY.generationId,
            publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
          }),
        ])
      );
    }
  });

  it("rejects an explicitly empty internal phone subset before mutation or provider work", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        phoneNumberIds: [],
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
    });

    expect(dependencies.findSecurity).not.toHaveBeenCalled();
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
  });

  it("maps a fenced storage write failure to a fixed storage error without leaking details", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([PHONE_1]);
    dependencies.getEncryptionStatus.mockResolvedValue(ACTIVE_KEY_READY_STATUS);
    dependencies.applyMutation.mockRejectedValue(
      new Error("mongo connection string secret")
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toEqual(
      expect.objectContaining({
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
        message: "WhatsApp Flow endpoint security storage failed",
      })
    );
    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.not.toHaveProperty("message", "mongo connection string secret");
  });

  it("sanitizes storage failures from status and identity reads at the service boundary", async () => {
    const policy: ManagedFlowReleasePolicy = {
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    };
    const statusDependencies = createDependencies(policy);
    statusDependencies.findSecurity.mockRejectedValue(
      new Error("mongodb credential secret")
    );
    const identityDependencies = createDependencies(policy);
    identityDependencies.findSecurity.mockResolvedValue(securityRecord());
    identityDependencies.loadKeySet.mockImplementation(() => {
      throw new Error("encrypted key material secret");
    });

    const failures = await Promise.all([
      createWhatsAppFlowEndpointSecurityService(statusDependencies)
        .getStatus(CONTEXT, NOW)
        .catch(error => error),
      createWhatsAppFlowEndpointSecurityService(identityDependencies)
        .resolveIdentity(CONTEXT, NOW)
        .catch(error => error),
    ]);

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(EndpointSecurityServiceError);
      expect(failure).toMatchObject({
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
        message: "WhatsApp Flow endpoint security storage failed",
      });
      expect(JSON.stringify(failure)).not.toMatch(/credential|key material/i);
    }
  });

  it("sanitizes a lease-release storage failure after otherwise successful readiness", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const readyRecord = securityRecord({
      keyProvisioning: {
        status: "READY",
        generationId: ACTIVE_KEY.generationId,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.listPhones.mockResolvedValue([PHONE_1]);
    dependencies.getEncryptionStatus.mockResolvedValue(ACTIVE_KEY_READY_STATUS);
    dependencies.applyMutation.mockResolvedValue(readyRecord);
    dependencies.releaseLease.mockRejectedValue(
      new Error("replica-set secret")
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_STORAGE_FAILED",
      message: "WhatsApp Flow endpoint security storage failed",
    });
  });

  it("fails closed when the complete WABA phone inventory is empty", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const readyRecord = securityRecord({
      keyProvisioning: {
        status: "READY",
        generationId: ACTIVE_KEY.generationId,
        updatedAt: NOW,
      },
      mutation: {
        kind: "ENSURE",
        status: "COMPLETED",
        semanticOperationId: "ensure:waba-1:generation-active:0",
        generationId: ACTIVE_KEY.generationId,
        fence: 1,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([]);
    dependencies.applyMutation.mockResolvedValue(readyRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED",
    });

    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
    expect(dependencies.applyMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({
          type: "set-provisioning",
          state: expect.objectContaining({ status: "READY" }),
        }),
      })
    );
    expect(dependencies.applyMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ type: "complete" }),
      })
    );
  });

  it("persists a sanitized FAILED provisioning state without partial overall readiness when a later upload fails", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-2", display_phone_number: "+77010000002" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      });
    dependencies.uploadPublicKey
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("graph token secret"));
    dependencies.applyMutation.mockResolvedValue(securityRecord());
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    const failure = await service
      .ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
      .catch(error => error);

    expect(failure).toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
      message: "WhatsApp could not verify the Flow endpoint public key",
    });
    expect(dependencies.uploadPublicKey).toHaveBeenCalledTimes(2);
    const mutations = dependencies.applyMutation.mock.calls.map(
      ([call]) => call.mutation
    );
    expect(mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "replace-phones",
          phones: expect.arrayContaining([
            expect.objectContaining({
              phoneNumberId: "phone-1",
              stage: "READY",
            }),
            expect.objectContaining({
              phoneNumberId: "phone-2",
              stage: "FAILED",
              lastError: expect.objectContaining({
                code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
                message:
                  "WhatsApp could not verify the Flow endpoint public key",
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          type: "set-provisioning",
          state: expect.objectContaining({
            status: "FAILED",
            lastError: expect.objectContaining({
              code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
              message: "WhatsApp could not verify the Flow endpoint public key",
            }),
          }),
        }),
        expect.objectContaining({ type: "fail" }),
      ])
    );
    expect(mutations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "set-provisioning",
          state: expect.objectContaining({ status: "READY" }),
        }),
      ])
    );
    expect(mutations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "complete" })])
    );
    expect(JSON.stringify(mutations)).not.toContain("graph token secret");
  });

  it("persists the first verified phone and stops before a second POST when the fence cannot renew", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    dependencies.acquireLease.mockResolvedValue(lease());
    dependencies.renewLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-2", display_phone_number: "+77010000002" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      });
    dependencies.uploadPublicKey.mockResolvedValue(undefined);
    dependencies.applyMutation.mockResolvedValue(securityRecord());
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    });

    expect(dependencies.uploadPublicKey).toHaveBeenCalledTimes(1);
    expect(dependencies.uploadPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "phone-1" })
    );
    expect(dependencies.applyMutation.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            mutation: expect.objectContaining({
              type: "replace-phones",
              phones: expect.arrayContaining([
                expect.objectContaining({
                  phoneNumberId: "phone-1",
                  stage: "READY",
                }),
              ]),
            }),
          }),
        ],
      ])
    );
  });

  it("uses a new semantic ensure epoch to provision a phone rediscovered after a completed inventory", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const completedRecord = securityRecord({
      phones: [
        {
          phoneNumberId: "phone-1",
          generationId: ACTIVE_KEY.generationId,
          publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
          signatureStatus: "VALID",
          stage: "READY",
          verifiedAt: NOW,
          updatedAt: NOW,
        },
      ],
      mutation: {
        kind: "ENSURE",
        status: "COMPLETED",
        semanticOperationId: "ensure:waba-1:generation-active:0",
        generationId: ACTIVE_KEY.generationId,
        fence: 1,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(completedRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({ semanticOperationId: "ensure:waba-1:generation-active:1" })
    );
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-new", display_phone_number: "+77010000003" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      })
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockResolvedValue(completedRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await service.ensurePhoneKeyReadiness({
      context: CONTEXT,
      expectedGenerationId: ACTIVE_KEY.generationId,
      now: NOW,
    });

    expect(dependencies.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ENSURE",
        semanticOperationId: "ensure:waba-1:generation-active:1",
        candidateGenerationId: ACTIVE_KEY.generationId,
      })
    );
    expect(dependencies.uploadPublicKey).toHaveBeenCalledTimes(1);
    expect(dependencies.uploadPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: "phone-new" })
    );
  });

  it("atomically promotes a ready pending key and recomputes the outgoing retirement bound immediately before promotion", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const pendingRecord = securityRecord({
      activeKeySet: LEGACY_KEY,
      pendingKeySet: GENERATED_KEY,
      previousKeySets: [PREVIOUS_KEY],
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate:waba-1:generation-legacy",
        generationId: GENERATED_KEY.generationId,
        fence: 3,
        updatedAt: NOW,
      },
    });
    const promotedRecord = securityRecord({
      activeKeySet: { ...GENERATED_KEY, activatedAt: NOW },
      previousKeySets: [
        PREVIOUS_KEY,
        {
          ...LEGACY_KEY,
          retireAt: new Date("2026-08-10T10:00:00.000Z"),
        },
      ],
      keyProvisioning: {
        status: "READY",
        generationId: GENERATED_KEY.generationId,
        updatedAt: NOW,
      },
      mutation: {
        kind: "ROTATE",
        status: "COMPLETED",
        semanticOperationId: "rotate:waba-1:generation-legacy",
        generationId: GENERATED_KEY.generationId,
        fence: 4,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(pendingRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({
        kind: "ROTATE",
        semanticOperationId: "rotate:waba-1:generation-legacy",
        generationId: GENERATED_KEY.generationId,
      })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.getMaxActiveSessionExpiry
      .mockResolvedValueOnce(new Date("2026-08-08T10:00:00.000Z"))
      .mockResolvedValueOnce(new Date("2026-08-10T10:00:00.000Z"));
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus.mockResolvedValue({
      configured: true,
      businessPublicKey: "public-key-pem-generation-generated",
      signatureStatus: "VALID",
    });
    dependencies.applyMutation.mockImplementation(async ({ mutation }) =>
      mutation.type === "promote-pending" ? promotedRecord : pendingRecord
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: GENERATED_KEY.generationId,
        now: NOW,
      })
    ).resolves.toMatchObject({
      activeKey: { generationId: GENERATED_KEY.generationId },
      pendingKey: null,
      provisioning: { status: "READY" },
    });

    expect(dependencies.getMaxActiveSessionExpiry).toHaveBeenCalledTimes(2);
    expect(dependencies.getMaxActiveSessionExpiry).toHaveBeenCalledWith(
      "endpoint-1"
    );
    const promotionCalls = dependencies.applyMutation.mock.calls.filter(
      ([call]) => call.mutation.type === "promote-pending"
    );
    expect(promotionCalls).toHaveLength(1);
    expect(promotionCalls[0]![0].mutation).toEqual({
      type: "promote-pending",
      activeKeySet: GENERATED_KEY,
      expectedActiveGenerationId: LEGACY_KEY.generationId,
      previousKeySets: [
        PREVIOUS_KEY,
        {
          ...LEGACY_KEY,
          retireAt: new Date("2026-08-10T10:00:00.000Z"),
        },
      ],
      phones: [
        expect.objectContaining({
          phoneNumberId: "phone-1",
          generationId: GENERATED_KEY.generationId,
          stage: "READY",
        }),
      ],
      completedAt: expect.any(Date),
    });
    expect(dependencies.applyMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        mutation: expect.objectContaining({ type: "complete" }),
      })
    );
  });

  it("uses the canonical seven-day plus skew floor when it exceeds live session expiry", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const pendingRecord = securityRecord({
      activeKeySet: LEGACY_KEY,
      pendingKeySet: GENERATED_KEY,
    });
    dependencies.findSecurity.mockResolvedValue(pendingRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({ kind: "ROTATE", generationId: GENERATED_KEY.generationId })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(
      new Date("2026-07-31T10:00:00.000Z")
    );
    dependencies.listPhones.mockResolvedValue([PHONE_1]);
    dependencies.getEncryptionStatus.mockResolvedValue(
      GENERATED_KEY_READY_STATUS
    );
    dependencies.applyMutation.mockResolvedValue(
      securityRecord({ activeKeySet: GENERATED_KEY })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await service.ensurePhoneKeyReadiness({
      context: CONTEXT,
      expectedGenerationId: GENERATED_KEY.generationId,
      now: NOW,
    });

    const promotion = dependencies.applyMutation.mock.calls.find(
      ([call]) => call.mutation.type === "promote-pending"
    )![0].mutation;
    expect(promotion).toMatchObject({
      previousKeySets: [
        expect.objectContaining({
          generationId: LEGACY_KEY.generationId,
          retireAt: new Date("2026-08-06T10:01:00.000Z"),
        }),
      ],
    });
  });

  it("refuses rotation before inventory or provider access when two live history slots are already occupied", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const secondPrevious = {
      ...PREVIOUS_KEY,
      generationId: "generation-previous-2",
      rsaKeyId: "rsa-previous-2",
      signingKeyId: "sign-previous-2",
      publicKeyFingerprint: "9".repeat(64),
    };
    dependencies.findSecurity.mockResolvedValue(
      securityRecord({
        activeKeySet: LEGACY_KEY,
        pendingKeySet: GENERATED_KEY,
        previousKeySets: [PREVIOUS_KEY, secondPrevious],
      })
    );
    dependencies.acquireLease.mockResolvedValue(
      lease({ kind: "ROTATE", generationId: GENERATED_KEY.generationId })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(null);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: GENERATED_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_HISTORY_CAPACITY",
    });

    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("filters expired history without evicting the remaining live key during promotion", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const expiredPrevious = {
      ...PREVIOUS_KEY,
      generationId: "generation-expired",
      rsaKeyId: "rsa-expired",
      signingKeyId: "sign-expired",
      publicKeyFingerprint: "8".repeat(64),
      retireAt: new Date("2026-07-30T09:59:59.000Z"),
    };
    dependencies.findSecurity.mockResolvedValue(
      securityRecord({
        activeKeySet: LEGACY_KEY,
        pendingKeySet: GENERATED_KEY,
        previousKeySets: [expiredPrevious, PREVIOUS_KEY],
      })
    );
    dependencies.acquireLease.mockResolvedValue(
      lease({ kind: "ROTATE", generationId: GENERATED_KEY.generationId })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(null);
    dependencies.listPhones.mockResolvedValue([PHONE_1]);
    dependencies.getEncryptionStatus.mockResolvedValue(
      GENERATED_KEY_READY_STATUS
    );
    dependencies.applyMutation.mockResolvedValue(
      securityRecord({ activeKeySet: GENERATED_KEY })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await service.ensurePhoneKeyReadiness({
      context: CONTEXT,
      expectedGenerationId: GENERATED_KEY.generationId,
      now: NOW,
    });

    const promotion = dependencies.applyMutation.mock.calls.find(
      ([call]) => call.mutation.type === "promote-pending"
    )![0].mutation;
    expect(promotion).toMatchObject({
      previousKeySets: [
        expect.objectContaining({
          generationId: PREVIOUS_KEY.generationId,
          retireAt: PREVIOUS_KEY.retireAt,
        }),
        expect.objectContaining({ generationId: LEGACY_KEY.generationId }),
      ],
    });
    expect(JSON.stringify(promotion)).not.toContain("generation-expired");
  });

  it("composes post-cutoff legacy identity into exact pending-key readiness and atomic promotion", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const legacyRecord = securityRecord({ activeKeySet: LEGACY_KEY });
    const pendingRecord = securityRecord({
      activeKeySet: LEGACY_KEY,
      pendingKeySet: GENERATED_KEY,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate:waba-1:generation-legacy",
        generationId: GENERATED_KEY.generationId,
        fence: 1,
        updatedAt: NOW,
      },
    });
    const promotedRecord = securityRecord({
      activeKeySet: { ...GENERATED_KEY, activatedAt: NOW },
      previousKeySets: [
        {
          ...LEGACY_KEY,
          retireAt: new Date("2026-08-06T10:01:00.000Z"),
        },
      ],
      keyProvisioning: {
        status: "READY",
        generationId: GENERATED_KEY.generationId,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity
      .mockResolvedValueOnce(legacyRecord)
      .mockResolvedValueOnce(pendingRecord)
      .mockResolvedValueOnce(pendingRecord);
    dependencies.generateKeySet.mockReturnValue(GENERATED_KEY);
    dependencies.acquireLease
      .mockResolvedValueOnce(
        lease({
          kind: "ROTATE",
          semanticOperationId: "rotate:waba-1:generation-legacy",
          generationId: GENERATED_KEY.generationId,
        })
      )
      .mockResolvedValueOnce(
        lease({
          kind: "ROTATE",
          semanticOperationId: "rotate:waba-1:generation-legacy",
          generationId: GENERATED_KEY.generationId,
        })
      );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(null);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-legacy",
        signatureStatus: "VALID",
      })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-generated",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockImplementation(async ({ mutation }) =>
      mutation.type === "promote-pending" ? promotedRecord : pendingRecord
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.ensure(CONTEXT, NOW)).resolves.toMatchObject({
      activeKey: { generationId: GENERATED_KEY.generationId },
      pendingKey: null,
      provisioning: { status: "READY" },
    });

    expect(dependencies.acquireLease).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "ROTATE",
        candidateKeySet: GENERATED_KEY,
        semanticOperationId: "rotate:waba-1:generation-legacy",
      })
    );
    expect(dependencies.acquireLease).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "ROTATE",
        candidateKeySet: GENERATED_KEY,
        semanticOperationId: "rotate:waba-1:generation-legacy",
      })
    );
    expect(dependencies.uploadPublicKey).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      businessPublicKey: "public-key-pem-generation-generated",
      accessToken: "access-token-secret",
    });
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalledWith(
      expect.objectContaining({
        businessPublicKey: "public-key-pem-generation-legacy",
      })
    );
  });

  it("imports and installs the legacy key through manager ensure during the compatibility window", async () => {
    const beforeCutoff = new Date("2026-07-29T10:00:00.000Z");
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const legacyRecord = securityRecord({ activeKeySet: LEGACY_KEY });
    const readyRecord = securityRecord({
      activeKeySet: LEGACY_KEY,
      keyProvisioning: {
        status: "READY",
        generationId: LEGACY_KEY.generationId,
        updatedAt: beforeCutoff,
      },
    });
    dependencies.findSecurity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyRecord);
    dependencies.loadLegacyPrivateKey.mockReturnValue("legacy-private-pem");
    dependencies.importLegacyKeySet.mockReturnValue(LEGACY_KEY);
    dependencies.loadOrCreateSecurity.mockResolvedValue(legacyRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({
        semanticOperationId: "ensure:waba-1:generation-legacy:0",
        generationId: LEGACY_KEY.generationId,
      })
    );
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-legacy",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockResolvedValue(readyRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.ensure(CONTEXT, beforeCutoff)).resolves.toMatchObject({
      activeKey: {
        generationId: LEGACY_KEY.generationId,
        origin: "LEGACY_IMPORTED",
      },
      provisioning: { status: "READY" },
    });

    expect(dependencies.uploadPublicKey).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      businessPublicKey: "public-key-pem-generation-legacy",
      accessToken: "access-token-secret",
    });
    expect(dependencies.generateKeySet).not.toHaveBeenCalled();
  });

  it("hard-stops a foreign provider key with zero POSTs during legacy bootstrap ensure", async () => {
    const beforeCutoff = new Date("2026-07-29T10:00:00.000Z");
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const legacyRecord = securityRecord({ activeKeySet: LEGACY_KEY });
    dependencies.findSecurity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyRecord);
    dependencies.loadLegacyPrivateKey.mockReturnValue("legacy-private-pem");
    dependencies.importLegacyKeySet.mockReturnValue(LEGACY_KEY);
    dependencies.loadOrCreateSecurity.mockResolvedValue(legacyRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({ generationId: LEGACY_KEY.generationId })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus.mockResolvedValue({
      configured: true,
      businessPublicKey: "foreign-public-key-pem",
      signatureStatus: "VALID",
    });
    dependencies.applyMutation.mockResolvedValue(legacyRecord);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.ensure(CONTEXT, beforeCutoff)).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_FOREIGN_KEY",
    });
    expect(dependencies.getEncryptionStatus).toHaveBeenCalledTimes(1);
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("blocks dedicated rotate during the legacy window before record, generation, lease, session, or provider work", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const beforeCutoff = new Date("2026-07-30T09:59:59.999Z");
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.rotate(CONTEXT, beforeCutoff)).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
    });

    for (const forbidden of [
      dependencies.findSecurity,
      dependencies.generateKeySet,
      dependencies.acquireLease,
      dependencies.getMaxActiveSessionExpiry,
      dependencies.listPhones,
      dependencies.getEncryptionStatus,
      dependencies.uploadPublicKey,
    ]) {
      expect(forbidden).not.toHaveBeenCalled();
    }
  });

  it("directs an absent managed record to ensure without generating a throwaway active key", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(null);
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.rotate(CONTEXT, NOW)).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_NOT_CONFIGURED",
    });

    expect(dependencies.generateKeySet).not.toHaveBeenCalled();
    expect(dependencies.loadOrCreateSecurity).not.toHaveBeenCalled();
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("creates one immutable pending key for dedicated rotate and provisions that exact generation", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const activeRecord = securityRecord();
    const pendingRecord = securityRecord({
      pendingKeySet: GENERATED_KEY,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate:waba-1:generation-active",
        generationId: GENERATED_KEY.generationId,
        fence: 1,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity
      .mockResolvedValueOnce(activeRecord)
      .mockResolvedValueOnce(pendingRecord)
      .mockResolvedValueOnce(pendingRecord);
    dependencies.generateKeySet.mockReturnValue(GENERATED_KEY);
    dependencies.acquireLease
      .mockResolvedValueOnce(
        lease({
          kind: "ROTATE",
          semanticOperationId: "rotate:waba-1:generation-active",
          generationId: GENERATED_KEY.generationId,
        })
      )
      .mockResolvedValueOnce(
        lease({
          kind: "ROTATE",
          semanticOperationId: "rotate:waba-1:generation-active",
          generationId: GENERATED_KEY.generationId,
        })
      );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(null);
    dependencies.listPhones.mockResolvedValue([PHONE_1]);
    dependencies.getEncryptionStatus.mockResolvedValue(
      GENERATED_KEY_READY_STATUS
    );
    dependencies.applyMutation.mockImplementation(async ({ mutation }) =>
      mutation.type === "promote-pending"
        ? securityRecord({ activeKeySet: GENERATED_KEY })
        : pendingRecord
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await service.rotate(CONTEXT, NOW);

    expect(dependencies.generateKeySet).toHaveBeenCalledTimes(1);
    expect(dependencies.acquireLease).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        semanticOperationId: "rotate:waba-1:generation-active",
        candidateKeySet: GENERATED_KEY,
      })
    );
    expect(dependencies.acquireLease).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        semanticOperationId: "rotate:waba-1:generation-active",
        candidateKeySet: GENERATED_KEY,
      })
    );
  });

  it("replaces the legitimate outgoing active key during rotation instead of treating it as foreign", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const pendingRecord = securityRecord({
      pendingKeySet: GENERATED_KEY,
      mutation: {
        kind: "ROTATE",
        status: "RUNNING",
        semanticOperationId: "rotate:waba-1:generation-active",
        generationId: GENERATED_KEY.generationId,
        fence: 1,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(pendingRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({
        kind: "ROTATE",
        semanticOperationId: "rotate:waba-1:generation-active",
        generationId: GENERATED_KEY.generationId,
      })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(null);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-active",
        signatureStatus: "VALID",
      })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-generated",
        signatureStatus: "VALID",
      });
    dependencies.applyMutation.mockImplementation(async ({ mutation }) =>
      mutation.type === "promote-pending"
        ? securityRecord({ activeKeySet: GENERATED_KEY })
        : pendingRecord
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: GENERATED_KEY.generationId,
        now: NOW,
      })
    ).resolves.toMatchObject({
      activeKey: { generationId: GENERATED_KEY.generationId },
    });

    expect(dependencies.uploadPublicKey).toHaveBeenCalledTimes(1);
    expect(dependencies.uploadPublicKey).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      businessPublicKey: "public-key-pem-generation-generated",
      accessToken: "access-token-secret",
    });
  });

  it("resumes the same decryptable pending key after partial failure without generating a second candidate", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const pendingRecord = securityRecord({
      pendingKeySet: GENERATED_KEY,
      mutation: {
        kind: "ROTATE",
        status: "FAILED",
        semanticOperationId: "rotate:waba-1:generation-active",
        generationId: GENERATED_KEY.generationId,
        fence: 7,
        updatedAt: NOW,
      },
    });
    dependencies.findSecurity.mockResolvedValue(pendingRecord);
    dependencies.acquireLease.mockResolvedValue(
      lease({
        kind: "ROTATE",
        semanticOperationId: "rotate:waba-1:generation-active",
        generationId: GENERATED_KEY.generationId,
      })
    );
    dependencies.releaseLease.mockResolvedValue(true);
    dependencies.renewLease.mockResolvedValue(true);
    dependencies.assertFence.mockResolvedValue(undefined);
    dependencies.getMaxActiveSessionExpiry.mockResolvedValue(null);
    dependencies.listPhones.mockResolvedValue([
      { id: "phone-1", display_phone_number: "+77010000001" },
      { id: "phone-2", display_phone_number: "+77010000002" },
    ]);
    dependencies.getEncryptionStatus
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-generated",
        signatureStatus: "VALID",
      })
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-generated",
        signatureStatus: "VALID",
      })
      .mockResolvedValueOnce({
        configured: true,
        businessPublicKey: "public-key-pem-generation-generated",
        signatureStatus: "VALID",
      });
    dependencies.uploadPublicKey.mockRejectedValueOnce(
      new Error("uncertain transport")
    );
    dependencies.applyMutation.mockImplementation(async ({ mutation }) =>
      mutation.type === "promote-pending"
        ? securityRecord({ activeKeySet: GENERATED_KEY })
        : pendingRecord
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(service.rotate(CONTEXT, NOW)).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_PROVIDER_FAILED",
    });
    await expect(service.rotate(CONTEXT, NOW)).resolves.toMatchObject({
      activeKey: { generationId: GENERATED_KEY.generationId },
    });

    expect(dependencies.generateKeySet).not.toHaveBeenCalled();
    expect(dependencies.loadKeySet).toHaveBeenCalledWith(GENERATED_KEY);
    expect(
      dependencies.loadKeySet.mock.calls.filter(
        ([key]) => key === GENERATED_KEY
      )
    ).toHaveLength(4);
    expect(dependencies.acquireLease).toHaveBeenCalledTimes(2);
    for (const [call] of dependencies.acquireLease.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          semanticOperationId: "rotate:waba-1:generation-active",
          candidateKeySet: GENERATED_KEY,
        })
      );
    }
  });

  it.each([
    {
      label: "unknown",
      phoneNumberIds: ["phone-missing"],
    },
    {
      label: "duplicate",
      phoneNumberIds: ["phone-1", "phone-1"],
    },
  ])(
    "rejects an $label internal phone subset after inventory discovery and before provider status",
    async testCase => {
      const dependencies = createDependencies({
        state: "active",
        activatedAt: "2026-07-23T10:00:00.000Z",
        legacyCutoffAt: "2026-07-30T10:00:00.000Z",
      });
      dependencies.findSecurity.mockResolvedValue(securityRecord());
      dependencies.acquireLease.mockResolvedValue(lease());
      dependencies.releaseLease.mockResolvedValue(true);
      dependencies.listPhones.mockResolvedValue([
        { id: "phone-1", display_phone_number: "+77010000001" },
        { id: "phone-2", display_phone_number: "+77010000002" },
      ]);
      dependencies.applyMutation.mockResolvedValue(securityRecord());
      const service = createWhatsAppFlowEndpointSecurityService(dependencies);

      await expect(
        service.ensurePhoneKeyReadiness({
          context: CONTEXT,
          expectedGenerationId: ACTIVE_KEY.generationId,
          phoneNumberIds: testCase.phoneNumberIds,
          now: NOW,
        })
      ).rejects.toMatchObject({
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_INVALID_INPUT",
      });

      expect(dependencies.listPhones).toHaveBeenCalledTimes(1);
      expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
      expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
    }
  );

  it("rejects stale active readiness when an immutable pending rotation exists", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(
      securityRecord({
        pendingKeySet: GENERATED_KEY,
        mutation: {
          kind: "ROTATE",
          status: "FAILED",
          semanticOperationId: "rotate:waba-1:generation-active",
          generationId: GENERATED_KEY.generationId,
          fence: 7,
          updatedAt: NOW,
        },
      })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: ACTIVE_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    });

    expect(dependencies.loadKeySet).not.toHaveBeenCalled();
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("rejects stale legacy readiness after the managed cutoff before lease or provider work", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(
      securityRecord({ activeKeySet: LEGACY_KEY })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: LEGACY_KEY.generationId,
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    });

    expect(dependencies.loadKeySet).not.toHaveBeenCalled();
    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("rejects an expected generation absent from active and pending material before lease or provider work", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(securityRecord());
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.ensurePhoneKeyReadiness({
        context: CONTEXT,
        expectedGenerationId: "generation-missing",
        now: NOW,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_MUTATION_CONFLICT",
    });

    expect(dependencies.acquireLease).not.toHaveBeenCalled();
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
    expect(dependencies.uploadPublicKey).not.toHaveBeenCalled();
  });

  it("serializes a configured record without encrypted material or lease internals", async () => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    dependencies.findSecurity.mockResolvedValue(
      securityRecord({
        keyProvisioning: {
          status: "READY",
          generationId: ACTIVE_KEY.generationId,
          updatedAt: NOW,
        },
        phones: [
          {
            phoneNumberId: "phone-1",
            generationId: ACTIVE_KEY.generationId,
            publicKeyFingerprint: ACTIVE_KEY.publicKeyFingerprint,
            signatureStatus: "VALID",
            stage: "READY",
            verifiedAt: NOW,
            updatedAt: NOW,
          },
        ],
        mutation: {
          kind: "ENSURE",
          status: "COMPLETED",
          semanticOperationId: "semantic-secret",
          generationId: ACTIVE_KEY.generationId,
          ownerToken: "owner-secret",
          fence: 7,
          leaseExpiresAt: new Date("2026-07-30T10:05:00.000Z"),
        },
      })
    );
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    const result = await service.getStatus(CONTEXT, NOW);

    expect(result).toEqual({
      configured: true,
      endpointUri: "https://flows.example.test/endpoint-1",
      release: {
        stage: "MANAGED",
        managedFlowEnabled: true,
        legacyFlowAllowed: false,
        legacyCutoffAt: "2026-07-30T10:00:00.000Z",
      },
      activeKey: {
        generationId: "generation-active",
        origin: "WABA_GENERATED",
        rsaKeyId: "rsa-active",
        publicKeyFingerprint: "a".repeat(64),
        signingKeyId: "sign-active",
        createdAt: "2026-07-29T10:00:00.000Z",
        activatedAt: "2026-07-29T11:00:00.000Z",
      },
      pendingKey: null,
      previousKeys: [],
      provisioning: {
        status: "READY",
        generationId: "generation-active",
        updatedAt: "2026-07-30T10:00:00.000Z",
      },
      phones: [
        {
          phoneNumberId: "phone-1",
          generationId: "generation-active",
          publicKeyFingerprint: "a".repeat(64),
          signatureStatus: "VALID",
          stage: "READY",
          verifiedAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
        },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "private-ciphertext-secret",
      "signing-ciphertext-secret",
      "owner-secret",
      "semantic-secret",
      "access-token-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(dependencies.resolveEndpointUri).toHaveBeenCalledWith("endpoint-1");
    expect(dependencies.listPhones).not.toHaveBeenCalled();
    expect(dependencies.getEncryptionStatus).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "activation boundary",
      now: new Date("2026-07-23T10:00:00.000Z"),
      stage: "LEGACY_WINDOW",
    },
    {
      label: "cutoff boundary",
      now: new Date("2026-07-30T10:00:00.000Z"),
      stage: "MANAGED",
    },
  ])("reports the exact $label release stage", async testCase => {
    const dependencies = createDependencies({
      state: "active",
      activatedAt: "2026-07-23T10:00:00.000Z",
      legacyCutoffAt: "2026-07-30T10:00:00.000Z",
    });
    const service = createWhatsAppFlowEndpointSecurityService(dependencies);

    await expect(
      service.getStatus(CONTEXT, testCase.now)
    ).resolves.toMatchObject({
      release: { stage: testCase.stage },
    });
  });

  it.each([
    {
      label: "ensure",
      invoke: (
        service: ReturnType<typeof createWhatsAppFlowEndpointSecurityService>
      ) => service.ensure(CONTEXT, NOW),
    },
    {
      label: "rotate",
      invoke: (
        service: ReturnType<typeof createWhatsAppFlowEndpointSecurityService>
      ) => service.rotate(CONTEXT, NOW),
    },
  ])(
    "rejects $label while dark before all mutation dependencies",
    async testCase => {
      const dependencies = createDependencies();
      const service = createWhatsAppFlowEndpointSecurityService(dependencies);

      let failure: unknown;
      try {
        await testCase.invoke(service);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(EndpointSecurityServiceError);
      expect(failure).toMatchObject({
        code: "WHATSAPP_FLOW_ENDPOINT_SECURITY_POLICY_DISABLED",
      });
      for (const forbidden of [
        dependencies.findSecurity,
        dependencies.loadOrCreateSecurity,
        dependencies.acquireLease,
        dependencies.applyMutation,
        dependencies.listPhones,
        dependencies.getEncryptionStatus,
        dependencies.uploadPublicKey,
        dependencies.getMaxActiveSessionExpiry,
        dependencies.generateKeySet,
        dependencies.importLegacyKeySet,
        dependencies.loadLegacyPrivateKey,
      ]) {
        expect(forbidden).not.toHaveBeenCalled();
      }
    }
  );
});
