import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { sha256Hex } from "./sha256";

test("sha256Hex matches Node UTF-8 SHA-256 across padding boundaries and Unicode", () => {
  const values = [
    "",
    "abc",
    "Сәлем 🌍 — 你好",
    "\ud800",
    "\udc00",
    ...[55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4096].map((length) =>
      "a".repeat(length),
    ),
  ];

  for (const value of values) {
    assert.equal(
      sha256Hex(value),
      createHash("sha256").update(value, "utf8").digest("hex"),
    );
  }
});
