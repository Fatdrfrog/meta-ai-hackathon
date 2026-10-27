import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createVercelOidcAuthConfig,
  getHttpErrorStatus,
  getHeaderString,
  HttpRequestBodyTooLargeError,
  HttpRequestValidationError,
  parseEnabledFlag,
  readJsonBody,
} from "./http-service";

const OIDC_ENV_KEYS = [
  "AI_GATEWAY_VERCEL_OIDC_ISSUER_URL",
  "AI_GATEWAY_VERCEL_OIDC_AUDIENCE",
  "AI_GATEWAY_VERCEL_OIDC_SUBJECTS",
] as const;

function snapshotEnv(): Record<
  (typeof OIDC_ENV_KEYS)[number],
  string | undefined
> {
  return Object.fromEntries(
    OIDC_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof OIDC_ENV_KEYS)[number], string | undefined>;
}

function restoreEnv(
  snapshot: Record<(typeof OIDC_ENV_KEYS)[number], string | undefined>,
) {
  for (const key of OIDC_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function requestLike(
  body: string,
  headers: Record<string, string | string[]> = {},
) {
  const request = Readable.from([body]) as Readable & {
    headers: Record<string, string | string[]>;
  };
  request.headers = headers;
  return request;
}

test("parses explicit enabled and disabled flag values with a fallback", () => {
  assert.equal(parseEnabledFlag(undefined, true), true);
  assert.equal(parseEnabledFlag("yes"), true);
  assert.equal(parseEnabledFlag("off", true), false);
  assert.equal(parseEnabledFlag("unexpected", true), true);
});

test("reads request headers consistently from string or array values", () => {
  assert.equal(
    getHeaderString(
      requestLike("", { "x-airi-api-key": "  key-1  " }),
      "x-airi-api-key",
    ),
    "key-1",
  );
  assert.equal(
    getHeaderString(
      requestLike("", { "idempotency-key": ["  first  ", "second"] }),
      "idempotency-key",
    ),
    "first",
  );
});

test("reads JSON bodies and maps invalid JSON to a clear runtime error", async () => {
  await assert.rejects(
    () => readJsonBody(requestLike("{bad json")),
    /Invalid JSON body/,
  );
  assert.deepEqual(
    await readJsonBody<{ ok: boolean }>(requestLike('{"ok":true}')),
    {
      ok: true,
    },
  );
});

test("maps permanent request failures separately from auth and server failures", () => {
  assert.equal(
    getHttpErrorStatus(new HttpRequestValidationError("invalid batch")),
    400,
  );
  assert.equal(getHttpErrorStatus(new HttpRequestBodyTooLargeError(1)), 413);
  assert.equal(getHttpErrorStatus(new Error("database unavailable")), 500);
});

test("builds reusable Vercel OIDC auth config from existing gateway env vars", () => {
  const env = snapshotEnv();
  try {
    process.env.AI_GATEWAY_VERCEL_OIDC_ISSUER_URL = "https://oidc.vercel.com";
    process.env.AI_GATEWAY_VERCEL_OIDC_AUDIENCE = "airi-gateway";
    process.env.AI_GATEWAY_VERCEL_OIDC_SUBJECTS =
      " owner/project , another/project ";

    const config = createVercelOidcAuthConfig({
      authDisabled: false,
      serviceName: "OTP API",
    });

    assert.equal(config.authDisabled, false);
    assert.equal(config.issuerUrl, "https://oidc.vercel.com");
    assert.equal(config.audience, "airi-gateway");
    assert.deepEqual(config.allowedSubjects, [
      "owner/project",
      "another/project",
    ]);
    assert.ok(config.jwks);
  } finally {
    restoreEnv(env);
  }
});
