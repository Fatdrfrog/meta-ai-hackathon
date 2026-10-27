import { getAppVersion } from "./app-version";

describe("getAppVersion", () => {
  it("prefers an explicit public app version", () => {
    expect(
      getAppVersion({
        NEXT_PUBLIC_APP_VERSION: "release-2026-03-27",
        VERCEL_DEPLOYMENT_ID: "deployment-123",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      source: "next-public-app-version",
      version: "release-2026-03-27",
    });
  });

  it("falls back to the Vercel deployment id", () => {
    expect(
      getAppVersion({
        VERCEL_DEPLOYMENT_ID: "deployment-123",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      source: "vercel-deployment-id",
      version: "deployment-123",
    });
  });

  it("uses a shortened commit sha when needed", () => {
    expect(
      getAppVersion({
        VERCEL_GIT_COMMIT_SHA: "1234567890abcdef",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      source: "vercel-git-commit-sha",
      version: "1234567890ab",
    });
  });

  it("returns a stable dev version outside production", () => {
    expect(
      getAppVersion({
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      source: "development",
      version: "dev",
    });
  });

  it("returns an unknown fallback in production when no deployment marker exists", () => {
    expect(
      getAppVersion({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      source: "fallback",
      version: "unknown",
    });
  });
});
