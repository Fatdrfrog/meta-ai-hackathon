import type { TikTokPlatformCredentialSafeRecord } from "./platform-credential";
import {
  markTikTokPlatformCredentialFailureAndPublish,
  markTikTokPlatformCredentialValidatedAndPublish,
  publishTikTokPlatformCredentialCoordinate,
  replaceTikTokPlatformCredentialAndPublish,
  resolveTikTokPlatformCredentialCoordinate,
} from "./platform-credential-coordinate";

const validSafeRecord: TikTokPlatformCredentialSafeRecord = {
  generation: "c".repeat(32),
  advertiserId: "123456789",
  authorizedAdvertiserCount: 1,
  grantedScopes: ["18000000"],
  connectedByUserId: "user-1",
  connectedAt: new Date("2026-08-13T00:00:00.000Z"),
  lastValidatedAt: null,
  status: "connected",
  lastErrorCode: null,
};

function coordinateFixture() {
  const cacheClient = {
    readWithStatus: jest.fn().mockResolvedValue({ status: "miss" }),
    acquireLock: jest.fn().mockResolvedValue("acquired"),
    consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
    publishIfLockOwned: jest.fn().mockResolvedValue("published"),
  };
  const store = {
    readStatus: jest.fn().mockResolvedValue(validSafeRecord),
  };
  return { cacheClient, store };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function replacementInput(accessToken: string) {
  return {
    accessToken,
    selectedAdvertiserId: "123456789",
    authorizedAdvertiserCount: 1,
    grantedScopes: ["18000000"],
    connectedByUserId: "user-1",
    now: new Date("2026-08-13T00:00:00.000Z"),
  };
}

describe("TikTok platform credential coordinate", () => {
  it("publishes a token-free coordinate only while it owns the lock", async () => {
    const { cacheClient, store } = coordinateFixture();

    await expect(
      resolveTikTokPlatformCredentialCoordinate({ cacheClient, store })
    ).resolves.toEqual({
      status: "connected",
      generation: "c".repeat(32),
      advertiserId: "123456789",
    });
    const ownerToken = cacheClient.acquireLock.mock.calls[0][1];
    expect(ownerToken).toMatch(/^[a-f0-9]{32}$/);
    expect(cacheClient.acquireLock).toHaveBeenCalledWith(
      "icecore:tiktok:credential-publication-lock:v1:primary",
      ownerToken,
      240
    );
    expect(cacheClient.publishIfLockOwned).toHaveBeenCalledWith({
      lockKey: "icecore:tiktok:credential-publication-lock:v1:primary",
      ownerToken,
      valueKey: "icecore:tiktok:credential-coordinate:v1:primary",
      value: {
        status: "connected",
        generation: "c".repeat(32),
        advertiserId: "123456789",
      },
      ttlSeconds: 300,
    });
    expect(
      JSON.stringify(cacheClient.publishIfLockOwned.mock.calls)
    ).not.toContain("accessToken");
    expect(cacheClient.consumeIfMatches).not.toHaveBeenCalled();
  });

  it.each([
    ["hit", "unused", 0, 0],
    ["unavailable", "unused", 0, 0],
    ["miss", "contended", 0, 0],
    ["miss", "acquired", 1, 1],
  ] as const)(
    "cache=%s lock=%s",
    async (readStatus, lockStatus, mongoReads, publications) => {
      const { cacheClient, store } = coordinateFixture();
      cacheClient.readWithStatus.mockResolvedValue(
        readStatus === "hit"
          ? { status: "hit", value: { status: "unavailable" } }
          : { status: readStatus }
      );
      cacheClient.acquireLock.mockResolvedValue(lockStatus);
      store.readStatus.mockResolvedValue(null);

      await resolveTikTokPlatformCredentialCoordinate({ cacheClient, store });

      expect(store.readStatus).toHaveBeenCalledTimes(mongoReads);
      expect(cacheClient.publishIfLockOwned).toHaveBeenCalledTimes(
        publications
      );
    }
  );

  it.each(["published", "lost", "unavailable"] as const)(
    "maps missing-credential publication=%s without a separate release",
    async publishResult => {
      const { cacheClient, store } = coordinateFixture();
      store.readStatus.mockResolvedValue(null);
      cacheClient.publishIfLockOwned.mockResolvedValue(publishResult);

      const result = await resolveTikTokPlatformCredentialCoordinate({
        cacheClient,
        store,
      });

      expect(result).toEqual(
        publishResult === "published"
          ? { status: "unavailable" }
          : { status: "infrastructure_unavailable" }
      );
      expect(cacheClient.publishIfLockOwned).toHaveBeenCalledWith(
        expect.objectContaining({
          valueKey: "icecore:tiktok:credential-coordinate:v1:primary",
          value: { status: "unavailable" },
          ttlSeconds: 300,
        })
      );
      expect(cacheClient.consumeIfMatches).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the coordinate owner loses its lease before publish", async () => {
    const { cacheClient, store } = coordinateFixture();
    cacheClient.publishIfLockOwned.mockResolvedValue("lost");

    await expect(
      resolveTikTokPlatformCredentialCoordinate({ cacheClient, store })
    ).resolves.toEqual({ status: "infrastructure_unavailable" });
    expect(cacheClient.publishIfLockOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerToken: expect.any(String),
        value: expect.objectContaining({ generation: "c".repeat(32) }),
      })
    );
  });

  it("delegates coordinate commit to the atomic owner-checked cache primitive", async () => {
    const publishIfLockOwned = jest.fn().mockResolvedValue("published");

    await expect(
      publishTikTokPlatformCredentialCoordinate(
        {
          coordinate: {
            status: "connected",
            generation: "c".repeat(32),
            advertiserId: "123456789",
          },
          lockKey: "icecore:tiktok:credential-publication-lock:v1:primary",
          ownerToken: "owner-c",
        },
        { cacheClient: { publishIfLockOwned } }
      )
    ).resolves.toBe("published");
    expect(publishIfLockOwned).toHaveBeenCalledWith({
      lockKey: "icecore:tiktok:credential-publication-lock:v1:primary",
      ownerToken: "owner-c",
      valueKey: "icecore:tiktok:credential-coordinate:v1:primary",
      value: {
        status: "connected",
        generation: "c".repeat(32),
        advertiserId: "123456789",
      },
      ttlSeconds: 300,
    });
  });

  it("serializes credential replacement and coordinate publication", async () => {
    const firstReplace = deferred<TikTokPlatformCredentialSafeRecord>();
    const publicationCache = {
      acquireLock: jest
        .fn()
        .mockResolvedValueOnce("acquired")
        .mockResolvedValueOnce("contended"),
      consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
      publishIfLockOwned: jest.fn().mockResolvedValue("published"),
    };
    const replaceCredential = jest
      .fn()
      .mockReturnValueOnce(firstReplace.promise)
      .mockResolvedValueOnce({
        ...validSafeRecord,
        generation: "b".repeat(32),
      });
    const publishCoordinate = jest.fn().mockResolvedValue("published");
    const deps = {
      cacheClient: publicationCache,
      replaceCredential,
      publishCoordinate,
    };
    const first = replaceTikTokPlatformCredentialAndPublish(
      replacementInput("token-a"),
      deps
    );
    await Promise.resolve();

    await expect(
      replaceTikTokPlatformCredentialAndPublish(
        replacementInput("token-b"),
        deps
      )
    ).resolves.toEqual({ status: "coordination_unavailable", record: null });
    expect(replaceCredential).toHaveBeenCalledTimes(1);
    expect(publishCoordinate).not.toHaveBeenCalled();

    firstReplace.resolve({ ...validSafeRecord, generation: "a".repeat(32) });
    await expect(first).resolves.toMatchObject({
      status: "published",
      record: { generation: "a".repeat(32) },
    });
    expect(publishCoordinate).toHaveBeenCalledWith({
      coordinate: {
        status: "connected",
        generation: "a".repeat(32),
        advertiserId: validSafeRecord.advertiserId,
      },
      lockKey: "icecore:tiktok:credential-publication-lock:v1:primary",
      ownerToken: expect.any(String),
    });
    expect(publicationCache.consumeIfMatches).not.toHaveBeenCalled();
  });

  it("prevents a cache-miss resolver from overwriting a newer replacement", async () => {
    const readStarted = deferred<void>();
    const finishRead = deferred<TikTokPlatformCredentialSafeRecord | null>();
    const publicationCache = {
      readWithStatus: jest.fn().mockResolvedValue({ status: "miss" }),
      acquireLock: jest
        .fn()
        .mockResolvedValueOnce("acquired")
        .mockResolvedValueOnce("contended"),
      consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
      publishIfLockOwned: jest.fn().mockResolvedValue("published"),
    };
    const store = {
      readStatus: jest.fn(async () => {
        readStarted.resolve();
        return finishRead.promise;
      }),
    };
    const resolving = resolveTikTokPlatformCredentialCoordinate({
      cacheClient: publicationCache,
      store,
    });
    await readStarted.promise;

    await expect(
      replaceTikTokPlatformCredentialAndPublish(replacementInput("token-b"), {
        cacheClient: publicationCache,
        replaceCredential: jest.fn(),
        publishCoordinate: jest.fn(),
      })
    ).resolves.toEqual({ status: "coordination_unavailable", record: null });
    finishRead.resolve({ ...validSafeRecord, generation: "a".repeat(32) });
    await expect(resolving).resolves.toMatchObject({
      status: "connected",
      generation: "a".repeat(32),
    });
    expect(publicationCache.publishIfLockOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        value: expect.objectContaining({ generation: "a".repeat(32) }),
      })
    );

    publicationCache.acquireLock.mockResolvedValueOnce("acquired");
    const publishCoordinate = jest.fn().mockResolvedValue("published");
    await expect(
      replaceTikTokPlatformCredentialAndPublish(replacementInput("token-b"), {
        cacheClient: publicationCache,
        replaceCredential: jest.fn().mockResolvedValue({
          ...validSafeRecord,
          generation: "b".repeat(32),
        }),
        publishCoordinate,
      })
    ).resolves.toMatchObject({ status: "published" });
    expect(publishCoordinate).toHaveBeenLastCalledWith({
      coordinate: expect.objectContaining({ generation: "b".repeat(32) }),
      lockKey: "icecore:tiktok:credential-publication-lock:v1:primary",
      ownerToken: expect.any(String),
    });
  });

  it.each(["published", "lost", "unavailable"] as const)(
    "maps replacement owner-checked publication=%s",
    async publishResult => {
      const publicationCache = {
        acquireLock: jest.fn().mockResolvedValue("acquired"),
        consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
        publishIfLockOwned: jest.fn().mockResolvedValue("published"),
      };
      const publishCoordinate = jest.fn().mockResolvedValue(publishResult);

      const result = await replaceTikTokPlatformCredentialAndPublish(
        replacementInput("token-a"),
        {
          cacheClient: publicationCache,
          replaceCredential: jest.fn().mockResolvedValue(validSafeRecord),
          publishCoordinate,
        }
      );

      expect(result.status).toBe(
        publishResult === "published" ? "published" : "coordination_unavailable"
      );
      expect(publicationCache.consumeIfMatches).not.toHaveBeenCalled();
    }
  );

  it.each([true, false] as const)(
    "publishes a fenced validation only when Mongo matched=%s",
    async matched => {
      const publicationCache = {
        acquireLock: jest.fn().mockResolvedValue("acquired"),
        consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
        publishIfLockOwned: jest.fn().mockResolvedValue("published"),
      };
      const publishCoordinate = jest.fn().mockResolvedValue("published");

      await expect(
        markTikTokPlatformCredentialValidatedAndPublish(
          {
            generation: "a".repeat(32),
            validatedAt: new Date("2026-08-13T12:00:00.000Z"),
          },
          {
            cacheClient: publicationCache,
            markValidated: jest.fn().mockResolvedValue(matched),
            readStatus: jest.fn().mockResolvedValue({
              ...validSafeRecord,
              generation: "a".repeat(32),
            }),
            publishCoordinate,
          }
        )
      ).resolves.toBe(matched ? "published" : "changed");
      expect(publishCoordinate).toHaveBeenCalledTimes(matched ? 1 : 0);
      expect(publicationCache.consumeIfMatches).toHaveBeenCalledTimes(
        matched ? 0 : 1
      );
    }
  );

  it("returns changed without publishing when a matched validation rereads no credential", async () => {
    const publicationCache = {
      acquireLock: jest.fn().mockResolvedValue("acquired"),
      consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
      publishIfLockOwned: jest.fn().mockResolvedValue("published"),
    };
    const markValidated = jest.fn().mockResolvedValue(true);
    const readStatus = jest.fn().mockResolvedValue(null);
    const publishCoordinate = jest.fn().mockResolvedValue("published");

    await expect(
      markTikTokPlatformCredentialValidatedAndPublish(
        {
          generation: "a".repeat(32),
          validatedAt: new Date("2026-08-13T12:00:00.000Z"),
        },
        {
          cacheClient: publicationCache,
          markValidated,
          readStatus,
          publishCoordinate,
        }
      )
    ).resolves.toBe("changed");
    expect(markValidated).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(publishCoordinate).not.toHaveBeenCalled();
    expect(publicationCache.publishIfLockOwned).not.toHaveBeenCalled();
  });

  it("returns changed without publishing when a matched failure rereads another generation", async () => {
    const publicationCache = {
      acquireLock: jest.fn().mockResolvedValue("acquired"),
      consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
      publishIfLockOwned: jest.fn().mockResolvedValue("published"),
    };
    const markFailure = jest.fn().mockResolvedValue(true);
    const readStatus = jest.fn().mockResolvedValue({
      ...validSafeRecord,
      generation: "b".repeat(32),
      status: "reconnect_required",
    });
    const publishCoordinate = jest.fn().mockResolvedValue("published");

    await expect(
      markTikTokPlatformCredentialFailureAndPublish(
        {
          generation: "a".repeat(32),
          status: "reconnect_required",
          errorCode: "reconnect_required",
        },
        {
          cacheClient: publicationCache,
          markFailure,
          readStatus,
          publishCoordinate,
        }
      )
    ).resolves.toBe("changed");
    expect(markFailure).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledTimes(1);
    expect(publishCoordinate).not.toHaveBeenCalled();
    expect(publicationCache.publishIfLockOwned).not.toHaveBeenCalled();
  });

  it("fails closed when a no-match mutation cannot release its owner lock", async () => {
    const publicationCache = {
      acquireLock: jest.fn().mockResolvedValue("acquired"),
      consumeIfMatches: jest.fn().mockResolvedValue("unavailable"),
      publishIfLockOwned: jest.fn().mockResolvedValue("published"),
    };

    await expect(
      markTikTokPlatformCredentialValidatedAndPublish(
        {
          generation: "a".repeat(32),
          validatedAt: new Date("2026-08-13T12:00:00.000Z"),
        },
        {
          cacheClient: publicationCache,
          markValidated: jest.fn().mockResolvedValue(false),
        }
      )
    ).resolves.toBe("coordination_unavailable");
  });

  it("publishes reconnect-required through the same serialized mutation path", async () => {
    const publicationCache = {
      acquireLock: jest.fn().mockResolvedValue("acquired"),
      consumeIfMatches: jest.fn().mockResolvedValue("consumed"),
      publishIfLockOwned: jest.fn().mockResolvedValue("published"),
    };
    const markFailure = jest.fn().mockResolvedValue(true);
    const publishCoordinate = jest.fn().mockResolvedValue("published");

    await expect(
      markTikTokPlatformCredentialFailureAndPublish(
        {
          generation: "a".repeat(32),
          status: "reconnect_required",
          errorCode: "reconnect_required",
        },
        {
          cacheClient: publicationCache,
          markFailure,
          readStatus: jest.fn().mockResolvedValue({
            ...validSafeRecord,
            generation: "a".repeat(32),
            status: "reconnect_required",
          }),
          publishCoordinate,
        }
      )
    ).resolves.toBe("published");
    expect(markFailure.mock.invocationCallOrder[0]).toBeLessThan(
      publishCoordinate.mock.invocationCallOrder[0]
    );
    expect(publishCoordinate).toHaveBeenCalledWith({
      coordinate: {
        status: "reconnect_required",
        generation: "a".repeat(32),
        advertiserId: validSafeRecord.advertiserId,
      },
      lockKey: "icecore:tiktok:credential-publication-lock:v1:primary",
      ownerToken: expect.any(String),
    });
  });
});
