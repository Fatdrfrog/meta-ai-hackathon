import {
  decodeWhatsAppOnboardingHealthResponse,
  fetchWhatsAppOnboardingHealth,
  resolveWhatsAppAccountHealth,
} from "./onboarding-health-response";

describe("resolveWhatsAppAccountHealth", () => {
  it("prefers the structured account_health payload", () => {
    const accountHealth = {
      state: "warning" as const,
      reasons: [
        {
          code: "phone_not_registered",
          title: "Phone registration incomplete",
          message: "Complete registration before sending.",
          source: "phone_registration",
        },
      ],
    };

    expect(
      resolveWhatsAppAccountHealth({ status: { account_health: accountHealth } })
    ).toEqual(accountHealth);
  });

  it("falls back to the flat waba_health fields", () => {
    expect(
      resolveWhatsAppAccountHealth({
        status: {
          waba_health_state: "disabled",
          waba_health_reasons: [
            {
              code: "waba_disabled",
              title: "WhatsApp account disabled",
              message: "Meta disabled this account.",
              source: "account_update",
            },
          ],
        },
      })
    ).toEqual(
      expect.objectContaining({
        state: "disabled",
        reasons: [expect.objectContaining({ code: "waba_disabled" })],
      })
    );
  });

  it("returns null when no health is present", () => {
    expect(resolveWhatsAppAccountHealth(undefined)).toBeNull();
    expect(resolveWhatsAppAccountHealth({ status: null })).toBeNull();
  });
});

describe("decodeWhatsAppOnboardingHealthResponse", () => {
  it("keeps the shared health contract and drops malformed top-level input", () => {
    expect(
      decodeWhatsAppOnboardingHealthResponse({
        connected: true,
        status: {
          waba_health_state: "healthy",
          waba_health_reasons: [
            {
              code: "ok",
              title: "Ready",
              message: "Ready",
              source: "meta",
            },
            { malformed: true },
          ],
        },
        meta_refresh: { outcome: "fresh", requested: false, performed: false },
      })
    ).toEqual({
      connected: true,
      status: {
        waba_health_state: "healthy",
        waba_health_reasons: [
          {
            code: "ok",
            title: "Ready",
            message: "Ready",
            source: "meta",
          },
        ],
      },
      meta_refresh: { outcome: "fresh", requested: false, performed: false },
    });
    expect(decodeWhatsAppOnboardingHealthResponse("invalid")).toBeNull();
  });

  it("sanitizes account_health before exposing it to UI consumers", () => {
    expect(
      decodeWhatsAppOnboardingHealthResponse({
        status: {
          account_health: {
            state: "warning",
            reasons: [
              {
                code: " payment_required ",
                title: " Payment required ",
                message: " Add a payment method ",
                source: " meta ",
              },
              { malformed: true },
            ],
            lastCheckedAt: "2026-08-05T09:00:00.000Z",
          },
        },
      })
    ).toEqual({
      status: {
        account_health: {
          state: "warning",
          reasons: [
            {
              code: "payment_required",
              title: "Payment required",
              message: "Add a payment method",
              source: "meta",
            },
          ],
          lastCheckedAt: "2026-08-05T09:00:00.000Z",
        },
      },
    });
  });

  it("drops malformed account_health while preserving the legacy fallback", () => {
    expect(
      decodeWhatsAppOnboardingHealthResponse({
        status: {
          account_health: {
            state: "healthy",
          },
          waba_health_state: "warning",
          waba_health_reasons: [],
          waba_health_last_checked_at: "2026-08-05T09:00:00.000Z",
        },
      })
    ).toEqual({
      status: {
        waba_health_state: "warning",
        waba_health_reasons: [],
        waba_health_last_checked_at: "2026-08-05T09:00:00.000Z",
      },
    });
  });

  it("preserves HTTP failures for SWR callers", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Meta is rate limited" }),
    } as Response);

    await expect(
      fetchWhatsAppOnboardingHealth("/api/whatsapp/onboarding")
    ).rejects.toThrow("Meta is rate limited");

    fetchMock.mockRestore();
  });

  it("checks the HTTP status before consuming the response body", async () => {
    const operations: string[] = [];
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      get ok() {
        operations.push("status");
        return true;
      },
      json: async () => {
        operations.push("body");
        return { connected: true };
      },
    } as Response);

    await fetchWhatsAppOnboardingHealth("/api/whatsapp/onboarding");

    expect(operations).toEqual(["status", "body"]);
    fetchMock.mockRestore();
  });
});
