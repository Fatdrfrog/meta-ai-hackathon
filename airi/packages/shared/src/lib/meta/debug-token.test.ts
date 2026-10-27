import assert from "node:assert/strict";
import test from "node:test";

import { getWhatsAppGraphClient } from "./api";

import {
  debugMetaAccessToken,
  evaluateMetaAccessToken,
  MetaDebugTokenConfigurationError,
} from "./debug-token";

const nowMs = Date.UTC(2026, 8, 6);
const nowSeconds = nowMs / 1000;

test("rejects invalid, unverified, expired, and wrong-app tokens", () => {
  for (const data of [
    { is_valid: false, app_id: "app-1", expires_at: 0 },
    { app_id: "app-1" },
    { is_valid: true, app_id: "app-other" },
    { is_valid: true },
    { is_valid: true, app_id: "app-1", expires_at: nowSeconds },
    {
      is_valid: true,
      app_id: "app-1",
      expires_at: 0,
      data_access_expires_at: nowSeconds - 1,
    },
  ]) {
    assert.equal(
      evaluateMetaAccessToken(data, { appId: "app-1", nowMs }).valid,
      false,
    );
  }
});

test("respects explicit non-expiry instead of the OAuth fallback", () => {
  const result = evaluateMetaAccessToken(
    { is_valid: true, expires_at: 0 },
    {
      nowMs,
      expiresIn: 5184000,
    },
  );
  assert.equal(result.valid, true);
  assert.equal(result.neverExpires, true);
  assert.equal(result.expiresAt, undefined);
  assert.equal(result.daysUntilExpiry, undefined);
});

test("keeps missing expiry unknown instead of inventing a lifetime", () => {
  for (const expiresIn of [undefined, 0, -1, NaN, Infinity]) {
    const result = evaluateMetaAccessToken(
      { is_valid: true },
      { nowMs, expiresIn },
    );
    assert.equal(result.valid, true);
    assert.equal(result.neverExpires, false);
    assert.equal(result.expiresAt, undefined);
  }
});

test("uses provider expiry before OAuth duration and honors earlier data-access expiry", () => {
  const result = evaluateMetaAccessToken(
    {
      is_valid: true,
      expires_at: nowSeconds + 86400 * 30,
      data_access_expires_at: nowSeconds + 86400 * 7,
    },
    { nowMs, expiresIn: 60 },
  );
  assert.equal(result.expiresAt?.getTime(), nowMs + 86400 * 7 * 1000);
  assert.equal(result.daysUntilExpiry, 7);
  assert.equal(result.neverExpires, false);
});

test("uses an actual OAuth duration only when debug-token expiry is absent", () => {
  const result = evaluateMetaAccessToken(
    { is_valid: true },
    { nowMs, expiresIn: 3600 },
  );
  assert.equal(result.expiresAt?.getTime(), nowMs + 3600 * 1000);
  assert.equal(result.neverExpires, false);
});

test("uses the app access token and unwraps debug_token data", async () => {
  const calls: unknown[] = [];
  const client = {
    getJson: async <T>(path: string, options: unknown): Promise<T> => {
      calls.push([path, options]);
      return {
        data: { app_id: "app-1", business_id: "business-1" },
      } as T;
    },
  };

  await assert.doesNotReject(async () => {
    const result = await debugMetaAccessToken("customer-token", {
      appAccessToken: "app-1|secret-1",
      client,
    });
    assert.deepEqual(result, {
      app_id: "app-1",
      business_id: "business-1",
    });
  });
  assert.deepEqual(calls, [
    [
      "debug_token",
      {
        token: "app-1|secret-1",
        query: {
          input_token: "customer-token",
          access_token: "app-1|secret-1",
        },
      },
    ],
  ]);
});

test("supports explicit input-token fallback", async () => {
  const client = {
    getJson: async <T>(): Promise<T> =>
      ({ data: { business_id: "business-1" } }) as T,
  };

  await assert.doesNotReject(async () => {
    const result = await debugMetaAccessToken("customer-token", {
      appAccessToken: null,
      allowInputTokenFallback: true,
      client,
    });
    assert.equal(result.business_id, "business-1");
  });
});

test("passes cancellation through the Graph client to fetch and propagates abort", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const abortReason = new DOMException("Inspection timed out", "TimeoutError");
  let fetchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    assert.equal(init?.signal, controller.signal);
    return new Promise<Response>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
  };

  try {
    const request = debugMetaAccessToken("customer-token", {
      appAccessToken: "app-1|secret-1",
      client: getWhatsAppGraphClient(),
      signal: controller.signal,
    });
    controller.abort(abortReason);

    await assert.rejects(request, error => error === abortReason);
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails without app credentials when fallback is not allowed", async () => {
  const client = {
    getJson: async <T>(): Promise<T> => ({ data: {} }) as T,
  };

  await assert.rejects(
    debugMetaAccessToken("customer-token", {
      appAccessToken: null,
      client,
    }),
    MetaDebugTokenConfigurationError,
  );
});

test("rejects a successful debug_token response without data", async () => {
  const client = {
    getJson: async <T>(): Promise<T> => ({}) as T,
  };

  await assert.rejects(
    debugMetaAccessToken("customer-token", {
      appAccessToken: "app-1|secret-1",
      client,
    }),
    /Meta debug_token response did not include data/,
  );
});
