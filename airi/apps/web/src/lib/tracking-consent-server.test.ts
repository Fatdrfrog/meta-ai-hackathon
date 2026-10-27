const mockCookies = jest.fn();

jest.mock("next/headers", () => ({
  cookies: () => mockCookies(),
}));

import { readServerTrackingConsent } from "./tracking-consent-server";

describe("readServerTrackingConsent", () => {
  beforeEach(() => {
    mockCookies.mockReset();
  });

  it.each(["granted", "denied"])("reads a %s choice", async value => {
    mockCookies.mockResolvedValue({
      get: (name: string) =>
        name === "airi_tracking_consent" ? { value } : undefined,
    });
    await expect(readServerTrackingConsent()).resolves.toBe(value);
  });

  it("treats a missing cookie as pending", async () => {
    mockCookies.mockResolvedValue({ get: () => undefined });
    await expect(readServerTrackingConsent()).resolves.toBe("pending");
  });

  it("returns unknown outside a request", async () => {
    mockCookies.mockImplementation(() => {
      throw new Error("cookies was called outside a request scope");
    });
    await expect(readServerTrackingConsent()).resolves.toBe("unknown");
  });
});
