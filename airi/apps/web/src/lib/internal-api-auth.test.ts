import { verifyTestApiAccess } from "./internal-api-auth";

const ORIGINAL_ENV = {
  E2E_TEST_API_ENABLED: process.env.E2E_TEST_API_ENABLED,
  NODE_ENV: process.env.NODE_ENV,
  TEST_API_SECRET: process.env.TEST_API_SECRET,
};

function setEnv(values: {
  E2E_TEST_API_ENABLED?: string;
  NODE_ENV?: string;
  TEST_API_SECRET?: string;
}) {
  const env = process.env as Record<string, string | undefined>;

  if (values.E2E_TEST_API_ENABLED === undefined) {
    delete env.E2E_TEST_API_ENABLED;
  } else {
    env.E2E_TEST_API_ENABLED = values.E2E_TEST_API_ENABLED;
  }

  if (values.NODE_ENV === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = values.NODE_ENV;
  }

  if (values.TEST_API_SECRET === undefined) {
    delete env.TEST_API_SECRET;
  } else {
    env.TEST_API_SECRET = values.TEST_API_SECRET;
  }
}

function restoreEnv() {
  setEnv(ORIGINAL_ENV);
}

describe("verifyTestApiAccess", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("allows loopback requests outside production when no secret is configured", () => {
    setEnv({ NODE_ENV: "test" });

    const denied = verifyTestApiAccess(
      new Request("http://localhost:3000/api/test/conversation")
    );

    expect(denied).toBeNull();
  });

  it("hides test APIs from external production requests by default", async () => {
    setEnv({ NODE_ENV: "production" });

    const denied = verifyTestApiAccess(
      new Request("https://www.airi.chat/api/test/conversation")
    );

    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(404);
    await expect(denied?.json()).resolves.toEqual({ error: "Not found" });
  });

  it("requires the configured secret when one is present", () => {
    setEnv({ NODE_ENV: "production", TEST_API_SECRET: "test-secret" });

    const denied = verifyTestApiAccess(
      new Request("https://www.airi.chat/api/test/conversation", {
        headers: { authorization: "Bearer wrong" },
      })
    );
    const allowed = verifyTestApiAccess(
      new Request("https://www.airi.chat/api/test/conversation", {
        headers: { authorization: "Bearer test-secret" },
      })
    );

    expect(denied?.status).toBe(404);
    expect(allowed).toBeNull();
  });
});
