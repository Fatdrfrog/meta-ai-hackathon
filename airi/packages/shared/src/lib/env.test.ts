import assert from "node:assert/strict";
import test from "node:test";

import {
  firstEnv,
  parseEnvFlag,
  readEnv,
  readEnvFlag,
  readEnvOrEmpty,
  readIntegerEnv,
} from "./env";

const NAME = "ICECORE_SHARED_ENV_TEST";
const OTHER = "ICECORE_SHARED_ENV_TEST_OTHER";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("readEnv and readEnvOrEmpty trim and treat unset or blank values as missing", () => {
  for (const [raw, expected] of [
    [undefined, null],
    ["", null],
    ["   ", null],
    ["  value  ", "value"],
    ["value", "value"],
  ] as const) {
    withEnv({ [NAME]: raw }, () => {
      assert.equal(readEnv(NAME), expected);
      assert.equal(readEnvOrEmpty(NAME), expected ?? "");
    });
  }
});

test("firstEnv returns the first non-blank value in name order", () => {
  withEnv({ [NAME]: " first ", [OTHER]: "second" }, () => {
    assert.equal(firstEnv(NAME, OTHER), "first");
  });
  withEnv({ [NAME]: "  ", [OTHER]: " second " }, () => {
    assert.equal(firstEnv(NAME, OTHER), "second");
  });
  withEnv({ [NAME]: undefined, [OTHER]: undefined }, () => {
    assert.equal(firstEnv(NAME, OTHER), null);
  });
});

test("parseEnvFlag and readEnvFlag accept the 1/true/yes/on and 0/false/no/off sets", () => {
  for (const value of ["1", "true", "YES", " on "]) {
    assert.equal(parseEnvFlag(value, false), true);
  }
  for (const value of ["0", "False", "no", " OFF "]) {
    assert.equal(parseEnvFlag(value, true), false);
  }
  for (const value of [undefined, "", "  ", "enabled", "2"]) {
    assert.equal(parseEnvFlag(value, true), true);
    assert.equal(parseEnvFlag(value, false), false);
    assert.equal(parseEnvFlag(value), false);
  }

  withEnv({ [NAME]: " yes " }, () => {
    assert.equal(readEnvFlag(NAME), true);
  });
  withEnv({ [NAME]: undefined }, () => {
    assert.equal(readEnvFlag(NAME), false);
    assert.equal(readEnvFlag(NAME, true), true);
  });
});

test("readIntegerEnv falls back for unset, blank, unparsable and negative values", () => {
  for (const value of [undefined, "", "   ", "abc", "-3"]) {
    withEnv({ [NAME]: value }, () => {
      assert.equal(readIntegerEnv(NAME, 7, { min: 1, max: 10 }), 7);
    });
  }
});

test("readIntegerEnv reads and clamps integers", () => {
  withEnv({ [NAME]: " 12 " }, () => {
    assert.equal(readIntegerEnv(NAME, 3), 12);
    assert.equal(readIntegerEnv(NAME, 3, { max: 10 }), 10);
  });
  withEnv({ [NAME]: "0" }, () => {
    assert.equal(readIntegerEnv(NAME, 3, { min: 1 }), 1);
    assert.equal(readIntegerEnv(NAME, 3), 0);
  });
});
