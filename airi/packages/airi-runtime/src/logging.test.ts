import assert from "node:assert/strict";
import test from "node:test";

import { describeLogError } from "./logging";

test("error causes keep their identity but never echo secrets", () => {
  const error = Object.assign(
    new Error(
      "connect failed mongodb+srv://user:p4ss@cluster0.example.net/test?retryWrites=true " +
        "Authorization: Bearer abc.def-ghi token=EAAGm0PX4ZCpsBAKZB7ZC " +
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl " +
        "opaque EAAGm0PX4ZCpsBAKZB7ZCZAZBZB3ZCs2xyz0123456789",
    ),
    { name: "MongoServerSelectionError", code: 13, codeName: "Unauthorized" },
  );
  const summary = describeLogError(error);
  assert.equal(summary.name, "MongoServerSelectionError");
  assert.equal(summary.code, 13);
  assert.equal(summary.codeName, "Unauthorized");
  assert.match(summary.message ?? "", /^connect failed \[url\]/);
  for (const secret of [
    "p4ss",
    "cluster0",
    "abc.def-ghi",
    "EAAGm0PX4ZCpsBAKZB7ZC",
    "eyJhbGciOiJIUzI1NiJ9",
  ]) {
    assert.equal(summary.message?.includes(secret), false, secret);
  }
});

test("error causes are bounded and accept provider error objects", () => {
  assert.equal(
    describeLogError(new Error("x".repeat(20) + " y".repeat(300))).message
      ?.length,
    200,
  );
  assert.deepEqual(
    describeLogError({ code: "PGRST202", message: "function not found" }),
    { name: "Error", code: "PGRST202", message: "function not found" },
  );
  assert.deepEqual(describeLogError("timeout"), {
    name: "string",
    message: "timeout",
  });
  assert.deepEqual(describeLogError(undefined), {
    name: "undefined",
    message: null,
  });
});

test("key/value secrets are redacted with any separator, quoting or key prefix", () => {
  const cases: Array<[string, string]> = [
    ["password: hunter2xyz", "hunter2xyz"],
    ['{"password":"hunter2xyz"}', "hunter2xyz"],
    ["client_secret=shhh123", "shhh123"],
    ["x-api-key: abc123short", "abc123short"],
    ["Authorization: Token abcdef123456", "abcdef123456"],
    ["password = s3cr3t", "s3cr3t"],
    ["passwd=letmein9", "letmein9"],
    ["{'access_token': 'EAAshort1'}", "EAAshort1"],
    ["request signature=deadbeef01", "deadbeef01"],
    ["api key: plainkey77", "plainkey77"],
  ];
  for (const [input, secret] of cases) {
    const message = describeLogError(new Error(`failed ${input}`)).message;
    assert.equal(message?.includes(secret), false, `${input} -> ${message}`);
    assert.match(message ?? "", /\[redacted\]/, input);
  }
  assert.equal(
    describeLogError(new Error('bad {"password":"hunter2xyz","user":"ann"}'))
      .message,
    'bad {"password":"[redacted]","user":"ann"}',
  );
  for (const [input, secret] of [
    ['body {\\"password\\":\\"hunter2xyz\\"}', "hunter2xyz"],
    ['{\\"client_secret\\":\\"shhh123\\"}', "shhh123"],
    ["password      =      s3cr3t", "s3cr3t"],
    ["password\n:\tpad5word", "pad5word"],
    ["form password%3Dhunter2xyz&next=1", "hunter2xyz"],
  ] as const) {
    const message = describeLogError(new Error(input)).message;
    assert.equal(message?.includes(secret), false, `${input} -> ${message}`);
  }
});

test("identifiers that only end in Key stay readable", () => {
  assert.equal(
    describeLogError(
      new Error(
        'E11000 duplicate key error dup key: { idempotencyKey: "send-42" }',
      ),
    ).message,
    'E11000 duplicate key error dup key: { idempotencyKey: "send-42" }',
  );
});

test("credentials in scheme-less DSNs and prefixed API keys are redacted", () => {
  assert.equal(
    describeLogError(
      new Error("auth failed for user:pa55word@cluster0.mongodb.net"),
    ).message,
    "auth failed for [credential]@cluster0.mongodb.net",
  );
  for (const key of [
    "sk-proj-AbC123-dEf456_gHi789",
    "sk_live_51HxyzABCdef",
    "pk_test_abcdefgh1234",
  ]) {
    assert.equal(
      describeLogError(new Error(`invalid key ${key} given`)).message,
      "invalid key [token] given",
      key,
    );
  }
  // Ids that are not credentials stay readable.
  assert.equal(
    describeLogError(
      new Error("workspace 00000000-0000-4000-8000-000000000001 missing"),
    ).message,
    "workspace 00000000-0000-4000-8000-000000000001 missing",
  );
});

test("name, code and codeName are redacted like the message", () => {
  assert.deepEqual(
    describeLogError({
      name: "Leak password=abc",
      code: "token=abcdef",
      codeName: "Bearer abcdef",
      message: "boom",
    }),
    {
      name: "Leak password=[redacted]",
      code: "token=[redacted]",
      codeName: "[credential]",
      message: "boom",
    },
  );
});

test("an error whose properties throw still yields a safe summary", () => {
  const hostile = {
    get message(): string {
      throw new Error("getter exploded");
    },
  };
  assert.deepEqual(describeLogError(hostile), {
    name: "Error",
    message: null,
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(describeLogError(revoked.proxy), {
    name: "Error",
    message: null,
  });
});

test("large or adversarial messages are bounded before any pattern runs", () => {
  const size = 100 * 1024;
  for (const input of [
    "a.".repeat(size / 2),
    "a:".repeat(size / 2),
    "eyJ-".repeat(size / 4),
    "token ".repeat(Math.floor(size / 6)),
    "x".repeat(size),
    `${"y ".repeat(999)}secretvalue${"z".repeat(size)}`,
  ]) {
    const started = performance.now();
    const summary = describeLogError(new Error(input));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${input.slice(0, 8)}... took ${elapsed} ms`);
    assert.ok((summary.message?.length ?? 0) <= 200);
  }
  // A token cut by the input bound is dropped, not logged as a short piece
  // that no longer looks like a token.
  const token = "EAAGm0PX4ZCpsBAKZB7ZCZAZBZB3ZCs2xyz0123";
  assert.equal(
    describeLogError(
      new Error(`https://h.example/${"p".repeat(1957)} ${token} tail`),
    ).message,
    "[url]",
  );
  // The same holds without whitespace: the bound cuts back to the delimiter
  // before the token, so its first 20 characters are never logged.
  const cut = describeLogError(
    new Error(`${"p".repeat(1979)},${token}`),
  ).message;
  assert.equal(cut?.includes(token.slice(0, 10)), false, cut ?? "");
});
