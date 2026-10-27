import { notFound, redirect } from "next/navigation";
import CompanyPublicHomePage from "./page";

const mockGetPublicKBWorkspaceIds = jest.fn();
const mockGetLocaleFromCookie = jest.fn();

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: jest.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

jest.mock("@/lib/kb/public-kb", () => ({
  getPublicKBWorkspaceIds: (...args: unknown[]) =>
    mockGetPublicKBWorkspaceIds(...args),
}));

jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: () => mockGetLocaleFromCookie(),
}));

describe("CompanyPublicHomePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLocaleFromCookie.mockResolvedValue("en");
  });

  it("redirects known company slugs to the public KB", async () => {
    mockGetPublicKBWorkspaceIds.mockResolvedValue(["workspace-1"]);

    await expect(
      CompanyPublicHomePage({
        params: Promise.resolve({ companySlug: "airichat" }),
        searchParams: Promise.resolve({ locale: "ru" }),
      })
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirect).toHaveBeenCalledWith("/airichat/kb?locale=ru");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("404s unknown company slugs", async () => {
    mockGetPublicKBWorkspaceIds.mockResolvedValue([]);

    await expect(
      CompanyPublicHomePage({
        params: Promise.resolve({ companySlug: "missing-co" }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFound).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
