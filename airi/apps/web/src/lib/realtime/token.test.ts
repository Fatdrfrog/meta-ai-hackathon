import { createHmac } from "node:crypto";

import {
  REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS,
  signRealtimeToken,
  verifyRealtimeToken,
} from "./token";

const SECRET = "task-12-token-parity-secret";
const ISSUED_AT_SECONDS = 1_900_000_000;
const DASHBOARD_PARITY_SECRET = "task-17-dashboard-parity-secret";
const DASHBOARD_WORKSPACE_PARITY_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJraW5kIjoid29ya3NwYWNlIiwid29ya3NwYWNlSWQiOiJ3b3Jrc3BhY2VfcHJvYmUiLCJzb3VyY2UiOiJkYXNoYm9hcmQiLCJ1c2VySWQiOiJ1c2VyX3Byb2JlIiwiY2xpZW50Q29udHJhY3QiOiJkYXNoYm9hcmQtdjEiLCJhdWQiOiJhaXJpLXJlYWx0aW1lIiwiaWF0IjoxOTAwMDAwMDAwLCJleHAiOjE5MDAwMDM2MDB9.a7b4oLDJi3w0cYbdKwv21D4UE6PRPn1plFX5oYgaHsY";
const DASHBOARD_CONVERSATION_PARITY_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJraW5kIjoiY29udmVyc2F0aW9uIiwid29ya3NwYWNlSWQiOiJ3b3Jrc3BhY2VfcHJvYmUiLCJjb252ZXJzYXRpb25JZCI6IjAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2NyIsInNvdXJjZSI6ImRhc2hib2FyZCIsInVzZXJJZCI6InVzZXJfcHJvYmUiLCJjbGllbnRDb250cmFjdCI6ImRhc2hib2FyZC12MSIsImF1ZCI6ImFpcmktcmVhbHRpbWUiLCJpYXQiOjE5MDAwMDAwMDAsImV4cCI6MTkwMDAwMDMwMH0.ZTSTRnKMGqdt2xRKSZYSgUquxTNO33obD8HNN6Lewso";

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")
  ) as Record<string, unknown>;
}

function signPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signingInput = `${header}.${encodedPayload}`;
  const signature = createHmac("sha256", SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("realtime token", () => {
  it("round-trips workspace token scopes with HS256", async () => {
    const token = await signRealtimeToken(
      {
        kind: "workspace",
        workspaceId: "workspace_1",
        source: "dashboard",
        userId: "user_1",
      },
      {
        secret: "test-secret-with-enough-length",
        expiresInSeconds: 60,
      }
    );

    const claims = await verifyRealtimeToken(token, {
      secret: "test-secret-with-enough-length",
    });

    expect(claims).toMatchObject({
      kind: "workspace",
      workspaceId: "workspace_1",
      source: "dashboard",
      userId: "user_1",
    });
  });

  it("rejects tokens signed with a different secret", async () => {
    const token = await signRealtimeToken(
      {
        kind: "conversation",
        workspaceId: "workspace_1",
        conversationId: "507f1f77bcf86cd799439011",
        source: "widget",
      },
      {
        secret: "test-secret-with-enough-length",
        expiresInSeconds: 60,
      }
    );

    await expect(
      verifyRealtimeToken(token, {
        secret: "different-secret-with-enough-length",
      })
    ).rejects.toThrow();
  });

  it("signs and verifies the fixed dashboard-v1 workspace parity vector", async () => {
    const scope = {
      kind: "workspace" as const,
      workspaceId: "workspace_probe",
      source: "dashboard" as const,
      userId: "user_probe",
      clientContract: "dashboard-v1",
    };
    const token = await signRealtimeToken(scope, {
      secret: DASHBOARD_PARITY_SECRET,
      expiresInSeconds: 3_600,
      nowSeconds: ISSUED_AT_SECONDS,
    });

    expect(token).toBe(DASHBOARD_WORKSPACE_PARITY_TOKEN);
    await expect(
      verifyRealtimeToken(token, {
        secret: DASHBOARD_PARITY_SECRET,
        nowSeconds: ISSUED_AT_SECONDS + 1,
      })
    ).resolves.toMatchObject(scope);
  });

  it("preserves exact conversation scope in the fixed dashboard-v1 vector", async () => {
    const scope = {
      kind: "conversation" as const,
      workspaceId: "workspace_probe",
      conversationId: "0123456789abcdef01234567",
      source: "dashboard" as const,
      userId: "user_probe",
      clientContract: "dashboard-v1",
    };
    const token = await signRealtimeToken(scope, {
      secret: DASHBOARD_PARITY_SECRET,
      expiresInSeconds: 3_600,
      nowSeconds: ISSUED_AT_SECONDS,
    });

    expect(token).toBe(DASHBOARD_CONVERSATION_PARITY_TOKEN);
    await expect(
      verifyRealtimeToken(token, {
        secret: DASHBOARD_PARITY_SECRET,
        nowSeconds: ISSUED_AT_SECONDS + 1,
      })
    ).resolves.toMatchObject(scope);
  });

  it("accepts a future passive legacy label without widening its scope", async () => {
    const token = signPayload({
      kind: "workspace",
      workspaceId: "workspace_probe",
      source: "dashboard",
      userId: "user_probe",
      clientContract: "future-dashboard-v2",
      aud: "airi-realtime",
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + 3_600,
    });

    await expect(
      verifyRealtimeToken(token, {
        secret: SECRET,
        nowSeconds: ISSUED_AT_SECONDS + 1,
      })
    ).resolves.toMatchObject({
      kind: "workspace",
      workspaceId: "workspace_probe",
      clientContract: "future-dashboard-v2",
    });
  });

  it.each(["dashboard", "mobile"] as const)(
    "caps %s exact-conversation tokens to five minutes",
    async source => {
      const token = await signRealtimeToken(
        {
          kind: "conversation",
          workspaceId: "workspace_1",
          conversationId: "507f1f77bcf86cd799439011",
          source,
          userId: "user_1",
        },
        {
          secret: SECRET,
          expiresInSeconds: 3_600,
          nowSeconds: ISSUED_AT_SECONDS,
        }
      );

      expect(decodePayload(token)).toMatchObject({
        iat: ISSUED_AT_SECONDS,
        exp: ISSUED_AT_SECONDS + REALTIME_BOUNDED_TOKEN_MAX_TTL_SECONDS,
      });
    }
  );

  it.each(["dashboard", "mobile"] as const)(
    "keeps a shorter %s exact-conversation lifetime",
    async source => {
      const token = await signRealtimeToken(
        {
          kind: "conversation",
          workspaceId: "workspace_1",
          conversationId: "507f1f77bcf86cd799439011",
          source,
          userId: "user_1",
        },
        {
          secret: SECRET,
          expiresInSeconds: 120,
          nowSeconds: ISSUED_AT_SECONDS,
        }
      );

      expect(decodePayload(token)).toMatchObject({
        iat: ISSUED_AT_SECONDS,
        exp: ISSUED_AT_SECONDS + 120,
      });
    }
  );

  it("preserves one-hour workspace and widget token issuance", async () => {
    const workspaceToken = await signRealtimeToken(
      {
        kind: "workspace",
        workspaceId: "workspace_1",
        source: "dashboard",
        userId: "user_1",
      },
      {
        secret: SECRET,
        expiresInSeconds: 3_600,
        nowSeconds: ISSUED_AT_SECONDS,
      }
    );
    const widgetToken = await signRealtimeToken(
      {
        kind: "conversation",
        workspaceId: "workspace_1",
        conversationId: "507f1f77bcf86cd799439011",
        source: "widget",
      },
      {
        secret: SECRET,
        expiresInSeconds: 3_600,
        nowSeconds: ISSUED_AT_SECONDS,
      }
    );

    expect(decodePayload(workspaceToken)).toMatchObject({
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + 3_600,
    });
    expect(decodePayload(widgetToken)).toMatchObject({
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + 3_600,
    });
    await expect(
      verifyRealtimeToken(widgetToken, {
        secret: SECRET,
        nowSeconds: ISSUED_AT_SECONDS + 1,
      })
    ).resolves.toMatchObject({
      kind: "conversation",
      workspaceId: "workspace_1",
      conversationId: "507f1f77bcf86cd799439011",
      source: "widget",
    });
  });

  it("rejects a token whose scope kind is not workspace or conversation", async () => {
    const token = signPayload({
      kind: "requests",
      workspaceId: "workspace_1",
      aud: "airi-realtime",
      iat: ISSUED_AT_SECONDS,
      exp: ISSUED_AT_SECONDS + 300,
    });

    await expect(
      verifyRealtimeToken(token, {
        secret: SECRET,
        nowSeconds: ISSUED_AT_SECONDS + 1,
      })
    ).rejects.toThrow("Invalid realtime token scope.");
  });

  it("rejects an expired workspace token", async () => {
    const token = await signRealtimeToken(
      {
        kind: "workspace",
        workspaceId: "workspace_1",
        source: "dashboard",
        userId: "user_1",
      },
      { secret: SECRET, expiresInSeconds: 60, nowSeconds: ISSUED_AT_SECONDS }
    );

    await expect(
      verifyRealtimeToken(token, {
        secret: SECRET,
        nowSeconds: ISSUED_AT_SECONDS + 60,
      })
    ).rejects.toThrow(/expired/i);
  });
});
