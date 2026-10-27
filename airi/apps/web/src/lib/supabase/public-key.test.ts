import { getSupabasePublicKey, validateSupabasePublicKey } from "./public-key";

jest.mock("next-intl/plugin", () => () => (config: unknown) => config);

function legacyKey(role: unknown, header = { alg: "HS256", typ: "JWT" }) {
  return [header, { iss: "supabase", role }]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .concat("test_signature")
    .join(".");
}

describe("Supabase public key validation", () => {
  it.each([
    ["publishable key", "sb_publishable_test_fixture_1234567890"],
    ["legacy anon JWT", legacyKey("anon")],
  ])("accepts a %s", (_label, key) => {
    expect(validateSupabasePublicKey(key)).toBe(key);
  });

  it.each([
    ["service JWT", legacyKey("service_role")],
    ["user JWT", legacyKey("authenticated")],
    ["secret key", "sb_secret_private_fixture"],
    ["missing value", undefined],
    ["blank value", ""],
    ["unknown key", "anon-key"],
    ["empty publishable token", "sb_publishable_"],
    ["publishable token with spaces", "sb_publishable_not public"],
    ["malformed JWT", "invalid.payload.signature"],
    ["unsigned JWT", legacyKey("anon").replace(/\.[^.]+$/, ".")],
    ["unexpected JWT issuer", Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ iss: "other", role: "anon" })).toString("base64url") + ".test_signature"],
    ["unexpected JWT algorithm", legacyKey("anon", { alg: "none", typ: "JWT" })],
  ])("rejects %s without exposing its value", (_label, key) => {
    expect(() => validateSupabasePublicKey(key)).toThrow(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY must be a Supabase publishable key or legacy anon JWT."
    );
    if (key) {
      try { validateSupabasePublicKey(key); } catch (error) {
        expect((error as Error).message).not.toContain(key);
      }
    }
  });

  it("validates the current public environment key before returning it", () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_fixture_1234567890";
      expect(getSupabasePublicKey()).toBe("sb_publishable_test_fixture_1234567890");
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = legacyKey("service_role");
      expect(() => getSupabasePublicKey()).toThrow("legacy anon JWT");
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      expect(() => getSupabasePublicKey()).toThrow("legacy anon JWT");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previous;
    }
  });

  it.each([
    ["service JWT", legacyKey("service_role")],
    ["secret key", "sb_secret_private_fixture"],
  ])("rejects a %s when loading the Next build configuration", async (_label, key) => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = key;
      await expect(jest.isolateModulesAsync(async () => {
        await import("../../../next.config");
      })).rejects.toThrow("legacy anon JWT");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previous;
    }
  });

  it("allows a public key when loading the Next build configuration", async () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    try {
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_test_fixture_1234567890";
      await expect(jest.isolateModulesAsync(async () => {
        await import("../../../next.config");
      })).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previous;
    }
  });

  it("allows early Next configuration loading before env files are loaded", async () => {
    const previous = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    try {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      await expect(jest.isolateModulesAsync(async () => {
        await import("../../../next.config");
      })).resolves.toBeUndefined();
      expect(() => getSupabasePublicKey()).toThrow("legacy anon JWT");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previous;
    }
  });
});
