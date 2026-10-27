import assert from "node:assert/strict";
import test from "node:test";

import { assertContractVersion } from "./contract-version";

test("assertContractVersion { max } accepts 1..max and names the label", () => {
  for (const value of [1, 2, 3]) {
    assert.doesNotThrow(() =>
      assertContractVersion(value, { max: 3 }, "bulk campaign workflow"),
    );
  }
  for (const value of [0, -1, 4, 1.5 + 2]) {
    assert.throws(
      () => assertContractVersion(value, { max: 3 }, "bulk campaign workflow"),
      {
        message: `Unsupported bulk campaign workflow contract version: ${value}`,
      },
    );
  }
});

test("assertContractVersion { max } keeps the old comparison for non-numbers", () => {
  // `value < 1 || value > max` is false for NaN and undefined, so the guards
  // this replaces let them through; keep that exactly.
  assert.doesNotThrow(() => assertContractVersion(Number.NaN, { max: 1 }, "x"));
  assert.doesNotThrow(() =>
    assertContractVersion(undefined as unknown as number, { max: 1 }, "x"),
  );
});

test("assertContractVersion { exact } accepts only that version", () => {
  assert.doesNotThrow(() =>
    assertContractVersion(1, { exact: 1 }, "WhatsApp webhook drain workflow"),
  );
  for (const value of [0, 2, Number.NaN, undefined as unknown as number]) {
    assert.throws(
      () =>
        assertContractVersion(
          value,
          { exact: 1 },
          "WhatsApp webhook drain workflow",
        ),
      {
        message: `Unsupported WhatsApp webhook drain workflow contract version: ${value}`,
      },
    );
  }
});
