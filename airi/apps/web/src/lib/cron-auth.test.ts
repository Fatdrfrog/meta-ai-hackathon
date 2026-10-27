import { verifyCronAuth } from "./cron-auth";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const mutableEnvironment = process.env as Record<string, string | undefined>;

function restoreEnvironment(): void {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;

  if (ORIGINAL_NODE_ENV === undefined) delete mutableEnvironment.NODE_ENV;
  else mutableEnvironment.NODE_ENV = ORIGINAL_NODE_ENV;
}

describe("verifyCronAuth", () => {
  afterEach(restoreEnvironment);

  it.each(["production", "staging", undefined])(
    "fails closed without CRON_SECRET in %s",
    environment => {
      delete process.env.CRON_SECRET;
      if (environment === undefined) delete mutableEnvironment.NODE_ENV;
      else mutableEnvironment.NODE_ENV = environment;

      const denied = verifyCronAuth(new Request("https://example.com/cron"));

      expect(denied?.status).toBe(401);
    }
  );

  it("treats a blank CRON_SECRET as missing", () => {
    mutableEnvironment.NODE_ENV = "production";
    process.env.CRON_SECRET = "   ";

    const denied = verifyCronAuth(new Request("https://example.com/cron"));

    expect(denied?.status).toBe(401);
  });

  it.each(["development", "test"])(
    "allows an omitted secret only in explicit %s mode",
    environment => {
      delete process.env.CRON_SECRET;
      mutableEnvironment.NODE_ENV = environment;

      expect(
        verifyCronAuth(new Request("https://example.com/cron"))
      ).toBeNull();
    }
  );

  it("accepts only the exact configured bearer credential", () => {
    mutableEnvironment.NODE_ENV = "production";
    process.env.CRON_SECRET = "cron-secret";

    expect(
      verifyCronAuth(
        new Request("https://example.com/cron", {
          headers: { authorization: "Bearer cron-secret" },
        })
      )
    ).toBeNull();
    expect(
      verifyCronAuth(
        new Request("https://example.com/cron", {
          headers: { authorization: "Bearer wrong-secret" },
        })
      )?.status
    ).toBe(401);
    expect(
      verifyCronAuth(new Request("https://example.com/cron"))?.status
    ).toBe(401);
  });

  it.each([
    ["a longer value with the secret as prefix", "Bearer cron-secretX"],
    ["a truncated secret", "Bearer cron-secre"],
    ["the secret without the Bearer scheme", "cron-secret"],
  ])("rejects %s", (_label, authorization) => {
    mutableEnvironment.NODE_ENV = "production";
    process.env.CRON_SECRET = "cron-secret";

    expect(
      verifyCronAuth(
        new Request("https://example.com/cron", { headers: { authorization } })
      )?.status
    ).toBe(401);
  });
});
