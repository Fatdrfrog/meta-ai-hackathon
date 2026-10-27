import { buildCacheKey, cache } from "@/lib/cache";
import { NextResponse } from "next/server";
import { processTelegramUpdateWithDedupe } from "./dedupe-update";

function uniqueScope(label: string): string {
  return `${label}-${Date.now()}-${Math.random()}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Telegram update dedupe lifecycle", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("acknowledges a completed update without dispatching it twice", async () => {
    const scope = uniqueScope("completed");
    const process = jest.fn(async () => NextResponse.json({ ok: true }));

    const first = await processTelegramUpdateWithDedupe({
      scope,
      updateId: 101,
      process,
    });
    const duplicate = await processTelegramUpdateWithDedupe({
      scope,
      updateId: 101,
      process,
    });

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      duplicate_update: true,
      dedupe_state: "completed",
    });
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("releases failed claims so Telegram retries can process them", async () => {
    const scope = uniqueScope("retry");
    const process = jest
      .fn<Promise<NextResponse>, []>()
      .mockRejectedValueOnce(new Error("handler failed"))
      .mockResolvedValueOnce(NextResponse.json({ ok: true }));

    await expect(
      processTelegramUpdateWithDedupe({ scope, updateId: 202, process })
    ).rejects.toThrow("handler failed");
    await expect(
      processTelegramUpdateWithDedupe({ scope, updateId: 202, process })
    ).resolves.toHaveProperty("status", 200);
  });

  it("returns 503 with Retry-After for an in-progress update without re-dispatching", async () => {
    const scope = uniqueScope("in-progress");
    const entered = deferred<void>();
    const release = deferred<NextResponse>();
    const firstProcess = jest.fn(async () => {
      entered.resolve();
      return release.promise;
    });
    const duplicateProcess = jest.fn(async () =>
      NextResponse.json({ ok: true })
    );

    const firstResponse = processTelegramUpdateWithDedupe({
      scope,
      updateId: 303,
      process: firstProcess,
    });
    await entered.promise;

    const contenderResponse = await processTelegramUpdateWithDedupe({
      scope,
      updateId: 303,
      process: duplicateProcess,
    });

    expect(contenderResponse.status).toBe(503);
    expect(contenderResponse.headers.get("retry-after")).toBe("1");
    await expect(contenderResponse.json()).resolves.toEqual({
      ok: false,
      dedupe_state: "in_progress",
    });
    expect(firstProcess).toHaveBeenCalledTimes(1);
    expect(duplicateProcess).not.toHaveBeenCalled();

    release.resolve(NextResponse.json({ ok: true }));
    await expect(firstResponse).resolves.toHaveProperty("status", 200);
  });

  it("does not let a stale failure release delete a newer claim", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const scope = uniqueScope("stale-release");
    const updateId = 404;
    const inProgressKey = buildCacheKey("telegram:update:in-progress:v2", [
      scope,
      updateId,
    ]);
    const newerToken = "newer-owner-token";
    const staleProcess = jest.fn(async () => {
      await cache.set(inProgressKey, newerToken, 60);
      throw new Error("handler failed after lock ownership changed");
    });

    await expect(
      processTelegramUpdateWithDedupe({
        scope,
        updateId,
        process: staleProcess,
      })
    ).rejects.toThrow("handler failed after lock ownership changed");
    await expect(cache.get(inProgressKey)).resolves.toBe(newerToken);

    const newerOwnerProcess = jest.fn(async () =>
      NextResponse.json({ ok: true })
    );
    const contenderResponse = await processTelegramUpdateWithDedupe({
      scope,
      updateId,
      process: newerOwnerProcess,
    });

    expect(contenderResponse.status).toBe(503);
    expect(contenderResponse.headers.get("retry-after")).toBe("1");
    expect(newerOwnerProcess).not.toHaveBeenCalled();
    await expect(
      cache.compareAndDelete(inProgressKey, newerToken)
    ).resolves.toBe(true);
  });

  it("processes updates without a finite id untracked", async () => {
    const process = jest.fn(async () => NextResponse.json({ ok: true }));

    await expect(
      processTelegramUpdateWithDedupe({
        scope: uniqueScope("untracked"),
        process,
      })
    ).resolves.toHaveProperty("status", 200);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("processes updates untracked when the dedupe backend is unavailable", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest
      .spyOn(cache, "claimCompletionLock")
      .mockResolvedValueOnce("unavailable");
    const process = jest.fn(async () => NextResponse.json({ ok: true }));

    await expect(
      processTelegramUpdateWithDedupe({
        scope: uniqueScope("cache-unavailable"),
        updateId: 404,
        process,
      })
    ).resolves.toHaveProperty("status", 200);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("does not trust markers written by the legacy pre-handler dedupe", async () => {
    const scope = uniqueScope("legacy-marker");
    await cache.set(buildCacheKey("telegram:update", [scope, 505]), "1", 60);
    const process = jest.fn(async () => NextResponse.json({ ok: true }));

    await expect(
      processTelegramUpdateWithDedupe({ scope, updateId: 505, process })
    ).resolves.toHaveProperty("status", 200);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge when durable completion is unavailable", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest
      .spyOn(cache, "finalizeCompletionLock")
      .mockResolvedValueOnce("unavailable");
    const process = jest.fn(async () => NextResponse.json({ ok: true }));
    const response = await processTelegramUpdateWithDedupe({
      scope: uniqueScope("completion-unavailable"),
      updateId: 606,
      process,
    });

    expect(process).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      dedupe_state: "completion_unavailable",
    });
  });
});
