const signInWithOtpMock = jest.fn();
const headersMock = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(async () => ({
    auth: {
      signInWithOtp: signInWithOtpMock,
    },
  })),
}));

jest.mock("next/headers", () => ({
  headers: (...args: unknown[]) => headersMock(...args),
}));

import { sendMagicLink } from "./actions";

describe("sendMagicLink", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    signInWithOtpMock.mockResolvedValue({ error: null });
    headersMock.mockResolvedValue({
      get: (name: string) => {
        const values: Record<string, string> = {
          host: "app.example.com",
          "x-forwarded-proto": "https",
        };
        return values[name] || null;
      },
    });
  });

  it("preserves a safe invite destination in the Supabase magic-link callback", async () => {
    await expect(
      sendMagicLink("client@example.com", "/auth/joined?token=invite_1")
    ).resolves.toEqual({ success: true });

    expect(signInWithOtpMock).toHaveBeenCalledWith({
      email: "client@example.com",
      options: {
        emailRedirectTo:
          "https://app.example.com/auth/callback?next=%2Fauth%2Fjoined%3Ftoken%3Dinvite_1",
        shouldCreateUser: false,
      },
    });
  });

  it("returns Supabase's per-address email cooldown so the form can count down", async () => {
    signInWithOtpMock.mockResolvedValue({
      error: {
        code: "over_email_send_rate_limit",
        status: 429,
        message:
          "For security purposes, you can only request this after 17 seconds.",
      },
    });

    await expect(
      sendMagicLink("client@example.com", "/auth/joined?token=invite_1")
    ).resolves.toEqual({
      success: false,
      error:
        "For security purposes, you can only request this after 17 seconds.",
      retryAfterSeconds: 17,
    });
  });

  it("drops unsafe callback destinations", async () => {
    await expect(
      sendMagicLink("client@example.com", "https://evil.example/phish")
    ).resolves.toEqual({ success: true });

    expect(signInWithOtpMock).toHaveBeenCalledWith({
      email: "client@example.com",
      options: {
        emailRedirectTo: "https://app.example.com/auth/callback",
        shouldCreateUser: false,
      },
    });
  });
});
