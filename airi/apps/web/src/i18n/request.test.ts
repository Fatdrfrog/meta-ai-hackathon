const mockCookies = jest.fn();

jest.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => mockCookies(...args),
}));

jest.mock("next-intl/server", () => ({
  getRequestConfig: (loader: unknown) => loader,
}));

import loadRequestConfig from "./request";

const resolveRequestConfig = () =>
  loadRequestConfig({} as Parameters<typeof loadRequestConfig>[0]);

describe("i18n request config", () => {
  beforeEach(() => {
    mockCookies.mockReset();
  });

  it("falls back to English when no locale cookie is set", async () => {
    mockCookies.mockResolvedValue({
      get: jest.fn(() => undefined),
    });

    await expect(resolveRequestConfig()).resolves.toMatchObject({
      locale: "en",
    });
  });

  it("uses a valid locale cookie when one is set", async () => {
    mockCookies.mockResolvedValue({
      get: jest.fn(() => ({ value: "kz" })),
    });

    await expect(resolveRequestConfig()).resolves.toMatchObject({
      locale: "kz",
    });
  });

  it("falls back to English when the locale cookie is unsupported", async () => {
    mockCookies.mockResolvedValue({
      get: jest.fn(() => ({ value: "de" })),
    });

    await expect(resolveRequestConfig()).resolves.toMatchObject({
      locale: "en",
    });
  });

  it("serves English to visitors whose cookie still names the removed Uzbek locale", async () => {
    mockCookies.mockResolvedValue({
      get: jest.fn(() => ({ value: "uz" })),
    });

    await expect(resolveRequestConfig()).resolves.toMatchObject({
      locale: "en",
    });
  });
});
