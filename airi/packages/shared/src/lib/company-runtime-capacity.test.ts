import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireCompanyRuntimeCapacity,
  resolveRuntimeCompanyId,
  CompanyRuntimeCapacityDeferredError,
  isCompanyRuntimeCapacityDeferredError,
} from "./company-runtime-capacity";

test("capacity deferral has a stable contract across module copies", () => {
  const local = new CompanyRuntimeCapacityDeferredError("unavailable", 90_000);
  assert.equal(local.code, "COMPANY_RUNTIME_CAPACITY_DEFERRED");
  assert.equal(isCompanyRuntimeCapacityDeferredError(local), true);
  const foreign = Object.assign(new Error(local.message), {
    code: "COMPANY_RUNTIME_CAPACITY_DEFERRED",
    reason: "limited",
    retryAt: 90_000,
  });
  assert.equal(foreign instanceof CompanyRuntimeCapacityDeferredError, false);
  assert.equal(isCompanyRuntimeCapacityDeferredError(foreign), true);
  assert.equal(
    isCompanyRuntimeCapacityDeferredError({
      ...foreign,
      message: foreign.message,
    }),
    true,
  );
});

test("capacity deferral rejects lookalikes and invalid retry metadata", () => {
  const valid = {
    code: "COMPANY_RUNTIME_CAPACITY_DEFERRED",
    reason: "unavailable",
    retryAt: 90_000,
    message: "Company processing capacity unavailable",
  };
  for (const invalid of [
    null,
    undefined,
    new Error(valid.message),
    {
      name: "CompanyRuntimeCapacityDeferredError",
      reason: "unavailable",
      retryAt: 90_000,
    },
    { ...valid, code: "PROVIDER_FAILED" },
    { ...valid, reason: "outcome_unknown" },
    { ...valid, retryAt: "90000" },
    { ...valid, retryAt: NaN },
    { ...valid, retryAt: Infinity },
    { ...valid, retryAt: -1 },
    { ...valid, retryAt: 1e20 },
    { ...valid, message: null },
  ]) {
    assert.equal(isCompanyRuntimeCapacityDeferredError(invalid), false);
  }
});

test("company mapping transport failures defer before processing", async () => {
  await assert.rejects(
    resolveRuntimeCompanyId(
      {
        from: () => {
          throw new Error("network unavailable");
        },
      },
      "uncached-workspace",
    ),
    CompanyRuntimeCapacityDeferredError,
  );
});

test("company slots are shared across workspaces while another company and the live lane progress", async () => {
  const locks = new Map<string, string>();
  const deps = {
    acquireLock: async (key: string, token: string) => {
      if (locks.has(key)) return "contended" as const;
      locks.set(key, token);
      return "acquired" as const;
    },
    release: async (key: string, token: string) => {
      if (locks.get(key) !== token) return false;
      return locks.delete(key);
    },
    throughput: async () => ({
      status: "granted" as const,
      limit: 20,
      remaining: 19,
      reset: 1_000,
    }),
  };
  const first = await acquireCompanyRuntimeCapacity(
    { companyId: "company-a", lane: "history" },
    deps,
  );
  const second = await acquireCompanyRuntimeCapacity(
    { companyId: "company-a", lane: "history" },
    deps,
  );
  const other = await acquireCompanyRuntimeCapacity(
    { companyId: "company-b", lane: "history" },
    deps,
  );
  const live = await acquireCompanyRuntimeCapacity(
    { companyId: "company-a", lane: "conversation" },
    deps,
  );
  assert.equal(first.status, "granted");
  assert.equal(second.status, "limited");
  assert.equal(other.status, "granted");
  assert.equal(live.status, "granted");
  if (first.status !== "granted") throw new Error("expected grant");
  await first.release();
  const resumed = await acquireCompanyRuntimeCapacity(
    { companyId: "company-a", lane: "history" },
    deps,
  );
  assert.equal(resumed.status, "granted");
  await first.release();
  assert.equal(
    (
      await acquireCompanyRuntimeCapacity(
        { companyId: "company-a", lane: "history" },
        deps,
      )
    ).status,
    "limited",
  );
});

test("capacity outage and throughput exhaustion fail closed and release unused slots", async () => {
  let released = 0;
  const limited = await acquireCompanyRuntimeCapacity(
    { companyId: "company-a", lane: "history" },
    {
      acquireLock: async () => "acquired",
      release: async () => {
        released++;
        return true;
      },
      throughput: async () => ({
        status: "limited",
        reset: 5_000,
        remaining: 0,
        limit: 20,
      }),
    },
  );
  assert.equal(limited.status, "limited");
  assert.equal(released, 1);
  const unavailable = await acquireCompanyRuntimeCapacity(
    { companyId: "company-a", lane: "conversation" },
    {
      acquireLock: async () => "unavailable",
      release: async () => {
        throw new Error("no lease");
      },
      throughput: async () => {
        throw new Error("no admission");
      },
    },
  );
  assert.equal(unavailable.status, "unavailable");
});
