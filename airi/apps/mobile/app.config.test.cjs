const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const buildConfig = require("./app.config.js");

const publicKeyNames = [
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
];
const publishableKey = "sb_publishable_mobile_fixture";

function legacyKey(role) {
  return [
    { alg: "HS256", typ: "JWT" },
    { iss: "supabase", role },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .concat("fixture_signature")
    .join(".");
}

function resolveConfig(context, env = {}, localEnv = "") {
  const previous = publicKeyNames.map((name) => [name, process.env[name]]);
  for (const name of publicKeyNames) {
    delete process.env[name];
    if (Object.hasOwn(env, name)) process.env[name] = env[name];
  }
  context.mock.method(fs, "existsSync", (file) =>
    Boolean(
      localEnv && String(file).endsWith(path.join("mobile", ".env.local")),
    ),
  );
  context.mock.method(fs, "readFileSync", () => localEnv);
  try {
    return buildConfig({ config: { extra: { existing: "preserved" } } });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("mobile config accepts the selected Expo publishable key", (context) => {
  const config = resolveConfig(context, {
    EXPO_PUBLIC_SUPABASE_ANON_KEY: publishableKey,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_unused_lower_priority_fixture",
  });
  assert.equal(config.extra.mobile.supabaseAnonKey, publishableKey);
  assert.equal(config.extra.existing, "preserved");
});

test("mobile config accepts the web public-key fallback", (context) => {
  const config = resolveConfig(context, {
    NEXT_PUBLIC_SUPABASE_ANON_KEY: publishableKey,
  });
  assert.equal(config.extra.mobile.supabaseAnonKey, publishableKey);
});

test("mobile config accepts legacy anon credentials", (context) => {
  const key = legacyKey("anon");
  assert.equal(
    resolveConfig(context, {
      EXPO_PUBLIC_SUPABASE_ANON_KEY: key,
    }).extra.mobile.supabaseAnonKey,
    key,
  );
});

for (const name of publicKeyNames) {
  for (const [type, key] of [
    ["service-role JWT", legacyKey("service_role")],
    ["secret key", "sb_secret_mobile_private_fixture"],
  ]) {
    test(`mobile config rejects ${type} in ${name} without exposing it`, (context) => {
      assert.throws(
        () => resolveConfig(context, { [name]: key }),
        (error) => {
          assert.match(
            error.message,
            /must be a Supabase publishable key or legacy anon JWT/,
          );
          assert.equal(error.message.includes(key), false);
          return true;
        },
      );
    });
  }
}

test("mobile config rejects a privileged key from its local fallback file", (context) => {
  const key = legacyKey("service_role");
  assert.throws(
    () => resolveConfig(context, {}, `NEXT_PUBLIC_SUPABASE_ANON_KEY=${key}\n`),
    (error) => {
      assert.match(
        error.message,
        /must be a Supabase publishable key or legacy anon JWT/,
      );
      assert.equal(error.message.includes(key), false);
      return true;
    },
  );
});

test("mobile config remains inspectable without configured Supabase credentials", (context) => {
  const config = resolveConfig(context);
  assert.equal(config.extra.mobile.supabaseAnonKey, "");
  assert.equal(config.extra.existing, "preserved");
});
