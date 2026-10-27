const mockCaptureFunnelEvent = jest.fn();

jest.mock("@/lib/funnel-analytics", () => ({
  captureFunnelEvent: (...args: unknown[]) => mockCaptureFunnelEvent(...args),
}));

import {
  captureAuthCallbackFunnelEvent,
  classifyAuthCallbackFunnelEvent,
  type AuthFunnelUser,
} from "./auth-funnel-events";

const NOW = new Date("2026-10-18T10:00:00.000Z");

function user(overrides: Partial<AuthFunnelUser>): AuthFunnelUser {
  return {
    id: "user-1",
    app_metadata: { provider: "email" },
    created_at: "2026-10-18T09:50:00.000Z",
    last_sign_in_at: "2026-10-18T09:59:59.000Z",
    email_confirmed_at: "2026-10-18T09:59:58.000Z",
    ...overrides,
  };
}

describe("auth callback funnel events", () => {
  beforeEach(() => {
    mockCaptureFunnelEvent.mockReset();
  });

  it("counts a fresh email confirmation", () => {
    expect(classifyAuthCallbackFunnelEvent(user({}), NOW)).toBe(
      "email_confirmed"
    );
  });

  it("ignores an email user who confirmed long ago", () => {
    expect(
      classifyAuthCallbackFunnelEvent(
        user({ email_confirmed_at: "2026-10-17T09:00:00.000Z" }),
        NOW
      )
    ).toBeNull();
  });

  it("counts a brand-new Google user as an account created", () => {
    expect(
      classifyAuthCallbackFunnelEvent(
        user({
          app_metadata: { provider: "google" },
          created_at: "2026-10-18T09:59:58.000Z",
          last_sign_in_at: "2026-10-18T09:59:58.500Z",
        }),
        NOW
      )
    ).toBe("account_created");
  });

  it("ignores a returning Google user who abandoned setup", () => {
    expect(
      classifyAuthCallbackFunnelEvent(
        user({
          app_metadata: { provider: "google" },
          created_at: "2026-10-10T08:00:00.000Z",
          last_sign_in_at: "2026-10-18T09:59:58.000Z",
        }),
        NOW
      )
    ).toBeNull();
  });

  it("captures once per user with a stable insert id", async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    try {
      await captureAuthCallbackFunnelEvent(user({}), "pkce");
    } finally {
      jest.useRealTimers();
    }
    expect(mockCaptureFunnelEvent).toHaveBeenCalledWith({
      event: "email_confirmed",
      userId: "user-1",
      properties: { branch: "pkce" },
      insertId: "email_confirmed:user-1",
    });
  });
});
