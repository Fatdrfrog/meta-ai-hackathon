import assert from "node:assert/strict";
import test from "node:test";
import { parseHistoryImportCapacityArgs } from "./history-import-capacity-operator.js";

test("history capacity changes require explicit finite limits and default to preview", () => {
  const args = [
    "--company-id=tenant-a",
    "--max-messages=75000",
    "--max-bytes=536870912",
  ];
  assert.deepEqual(parseHistoryImportCapacityArgs(args), {
    companyId: "tenant-a",
    maxMessages: 75000,
    maxBytes: 536870912,
    execute: false,
  });
  assert.equal(
    parseHistoryImportCapacityArgs([...args, "--execute"]).execute,
    true,
  );
  assert.throws(() => parseHistoryImportCapacityArgs([]), /company|limits/i);
  assert.throws(
    () => parseHistoryImportCapacityArgs([...args, "--max-messages=Infinity"]),
    /finite/i,
  );
  assert.throws(
    () => parseHistoryImportCapacityArgs([...args, "--unexpected"]),
    /Unsupported/,
  );
});
