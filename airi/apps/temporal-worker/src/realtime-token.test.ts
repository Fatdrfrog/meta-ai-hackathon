import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  getScopeFromClaims,
  type RealtimeTokenClaims,
  verifyRealtimeToken,
} from "./realtime-token.js";

const secret = "test-secret";
const dashboardParitySecret = "task-17-dashboard-parity-secret";
const dashboardWorkspaceParityToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJraW5kIjoid29ya3NwYWNlIiwid29ya3NwYWNlSWQiOiJ3b3Jrc3BhY2VfcHJvYmUiLCJzb3VyY2UiOiJkYXNoYm9hcmQiLCJ1c2VySWQiOiJ1c2VyX3Byb2JlIiwiY2xpZW50Q29udHJhY3QiOiJkYXNoYm9hcmQtdjEiLCJhdWQiOiJhaXJpLXJlYWx0aW1lIiwiaWF0IjoxOTAwMDAwMDAwLCJleHAiOjE5MDAwMDM2MDB9.a7b4oLDJi3w0cYbdKwv21D4UE6PRPn1plFX5oYgaHsY";
const dashboardConversationParityToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJraW5kIjoiY29udmVyc2F0aW9uIiwid29ya3NwYWNlSWQiOiJ3b3Jrc3BhY2VfcHJvYmUiLCJjb252ZXJzYXRpb25JZCI6IjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2NyIsInNvdXJjZSI6ImRhc2hib2FyZCIsInVzZXJJZCI6InVzZXJfcHJvYmUiLCJjbGllbnRDb250cmFjdCI6ImRhc2hib2FyZC12MSIsImF1ZCI6ImFpcmktcmVhbHRpbWUiLCJpYXQiOjE5MDAwMDAwMDAsImV4cCI6MTkwMDAwMDMwMH0.ZTSTRnKMGqdt2xRKSZYSgUquxTNO33obD8HNN6Lewso";

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(payload: Record<string, unknown>) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const input = `${header}.${encodedPayload}`;
  const signature = createHmac("sha256", secret)
    .update(input)
    .digest("base64url");
  return `${input}.${signature}`;
}

test("verifies the flat token shape issued by the web runtime", () => {
  const token = sign({
    aud: "airi-realtime",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    kind: "workspace",
    workspaceId: "workspace_probe",
    source: "dashboard",
  });

  const claims = verifyRealtimeToken(token, { secret, now: 1_900_000_001 });

  assert.equal(claims.kind, "workspace");
  assert.equal(claims.workspaceId, "workspace_probe");
  assert.deepEqual(getScopeFromClaims(claims), {
    kind: "workspace",
    workspaceId: "workspace_probe",
  });
});

test("keeps accepting the older nested scope token shape", () => {
  const token = sign({
    aud: "airi-realtime",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    scope: {
      kind: "conversation",
      workspaceId: "workspace_probe",
      conversationId: "0123456789abcdef01234567",
    },
  });

  const claims = verifyRealtimeToken(token, { secret, now: 1_900_000_001 });

  assert.equal(claims.kind, "conversation");
  assert.equal(claims.workspaceId, "workspace_probe");
  assert.equal(claims.conversationId, "0123456789abcdef01234567");
  assert.deepEqual(getScopeFromClaims(claims), {
    kind: "conversation",
    workspaceId: "workspace_probe",
    conversationId: "0123456789abcdef01234567",
  });
});

test("verifies the fixed web dashboard-v1 workspace parity vector", () => {
  const claims = verifyRealtimeToken(dashboardWorkspaceParityToken, {
    secret: dashboardParitySecret,
    now: 1_900_000_001,
  });

  assert.deepEqual(claims, {
    kind: "workspace",
    workspaceId: "workspace_probe",
    source: "dashboard",
    userId: "user_probe",
    clientContract: "dashboard-v1",
    aud: "airi-realtime",
    iat: 1_900_000_000,
    exp: 1_900_003_600,
  });
  assert.deepEqual(getScopeFromClaims(claims), {
    kind: "workspace",
    workspaceId: "workspace_probe",
  });
});

test("verifies the fixed web dashboard-v1 exact-conversation vector", () => {
  const claims = verifyRealtimeToken(dashboardConversationParityToken, {
    secret: dashboardParitySecret,
    now: 1_900_000_001,
  });

  assert.deepEqual(claims, {
    kind: "conversation",
    workspaceId: "workspace_probe",
    conversationId: "0123456789abcdef01234567",
    source: "dashboard",
    userId: "user_probe",
    clientContract: "dashboard-v1",
    aud: "airi-realtime",
    iat: 1_900_000_000,
    exp: 1_900_000_300,
  });
  assert.deepEqual(getScopeFromClaims(claims), {
    kind: "conversation",
    workspaceId: "workspace_probe",
    conversationId: "0123456789abcdef01234567",
  });
});

test("accepts an unknown passive legacy label without changing authorization", () => {
  const claims = verifyRealtimeToken(
    sign({
      aud: "airi-realtime",
      exp: 2_000_000_000,
      iat: 1_900_000_000,
      kind: "workspace",
      workspaceId: "workspace_probe",
      source: "dashboard",
      clientContract: "future-dashboard-v2",
    }),
    { secret, now: 1_900_000_001 },
  );

  assert.equal(claims.kind, "workspace");
  assert.equal(claims.clientContract, "future-dashboard-v2");
  assert.deepEqual(getScopeFromClaims(claims), {
    kind: "workspace",
    workspaceId: "workspace_probe",
  });
});

test("rejects a retired Requests claim instead of unwrapping its nested scope", () => {
  const downgradeAttempt = sign({
    aud: "airi-realtime",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    kind: "requests",
    workspaceId: "123e4567-e89b-12d3-a456-426614174000",
    conversationIds: ["65f000000000000000000001"],
    grantId: "11111111111111111111111111111111",
    userId: "987e6543-e21b-12d3-a456-426614174999",
    source: "dashboard",
    clientContract: "requests-v1",
    scope: {
      kind: "workspace",
      workspaceId: "workspace-bypass",
    },
  });

  assert.throws(
    () => verifyRealtimeToken(downgradeAttempt, { secret, now: 1_900_000_001 }),
    /claims|scope/i,
  );
});
