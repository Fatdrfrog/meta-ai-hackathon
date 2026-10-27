import assert from "node:assert/strict";
import { test } from "node:test";
import { createRateLimiter } from "./rate-limit.ts";

test("a key gets its limit per window, and the window moves on", () => {
  let clock = 0;
  const limiter = createRateLimiter(2, 1000, () => clock);
  assert.deepEqual([limiter.allow("a"), limiter.allow("a"), limiter.allow("a"), limiter.allow("b")], [true, true, false, true]);
  clock = 1001;
  assert.equal(limiter.allow("a"), true);
});
