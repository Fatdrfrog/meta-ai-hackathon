import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";

import { AI_GATEWAY_PATHS } from "@icecore/airi-runtime/ai-gateway";

import { routeGatewayRequest, warmAIGatewayRuntime } from "./gateway.js";
import type { VercelOidcAuthConfig } from "./http-service.js";

const AUTH_DISABLED: VercelOidcAuthConfig = {
  allowedSubjects: [],
  audience: null,
  authDisabled: true,
  issuerUrl: null,
  jwks: null,
};

const AUTH_REQUIRED: VercelOidcAuthConfig = {
  ...AUTH_DISABLED,
  authDisabled: false,
};

test("retired observability endpoint returns not found", async () => {
  const capture = createResponseCapture();

  await routeGatewayRequest(
    createRequest("POST", "/v1/observability/datadog-llmobs/canary"),
    capture.response,
    AUTH_DISABLED,
  );

  assert.equal(capture.status(), 404);
  assert.deepEqual(capture.body(), { error: "Not found" });
});

function createRequest(method: string, path: string): http.IncomingMessage {
  return {
    headers: {},
    method,
    url: path,
    async *[Symbol.asyncIterator]() {},
  } as unknown as http.IncomingMessage;
}

function createResponseCapture(): {
  body(): Record<string, unknown>;
  response: http.ServerResponse;
  status(): number;
} {
  let body = "";
  let statusCode = 200;
  const response = {
    end: (chunk?: string) => {
      body = chunk || "";
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader: () => undefined,
  } as unknown as http.ServerResponse;

  return {
    body: () => JSON.parse(body) as Record<string, unknown>,
    response,
    status: () => statusCode,
  };
}

test("public gateway health does not require authorization", async () => {
  const capture = createResponseCapture();

  await routeGatewayRequest(
    createRequest("GET", AI_GATEWAY_PATHS.health),
    capture.response,
    AUTH_REQUIRED,
  );

  assert.equal(capture.status(), 200);
  assert.deepEqual(capture.body(), { ok: true });
});

test("gateway rejects non-POST methods for application endpoints", async () => {
  const capture = createResponseCapture();

  await routeGatewayRequest(
    createRequest("GET", AI_GATEWAY_PATHS.queryEmbedding),
    capture.response,
    AUTH_DISABLED,
  );

  assert.equal(capture.status(), 405);
  assert.deepEqual(capture.body(), { error: "Method not allowed" });
});

test("gateway authorizes before handling application requests", async () => {
  const capture = createResponseCapture();

  await assert.rejects(
    routeGatewayRequest(
      createRequest("POST", AI_GATEWAY_PATHS.queryEmbedding),
      capture.response,
      AUTH_REQUIRED,
    ),
    /Missing bearer token/,
  );
});

test("gateway warm-up loads modules before returning and then connects Mongo", async () => {
  const calls: string[] = [];
  let connected!: () => void;
  const warming = warmAIGatewayRuntime({
    loadModules: () => {
      calls.push("modules");
    },
    connect: () => {
      calls.push("connect");
      return new Promise<void>((resolve) => {
        connected = resolve;
      });
    },
  });
  // The synchronous module load has already happened.
  assert.deepEqual(calls, ["modules"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["modules", "connect"]);
  connected();
  await warming;
});

test("gateway warm-up never fails startup", async () => {
  let connectCalls = 0;
  await warmAIGatewayRuntime({
    loadModules: () => {
      throw new Error("Cannot find module");
    },
    connect: async () => {
      connectCalls += 1;
    },
  });
  assert.equal(connectCalls, 0);

  await warmAIGatewayRuntime({
    loadModules: () => undefined,
    connect: async () => {
      throw new Error("MONGODB_URI is not set");
    },
  });
});
