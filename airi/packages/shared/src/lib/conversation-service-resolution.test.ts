import assert from "node:assert/strict";
import test from "node:test";

import { customerCsatResolutionFields } from "./conversation-service-resolution";

test("customer CSAT writes resolve as a customer rating, never a timeout", () => {
  assert.deepEqual(customerCsatResolutionFields(), {
    service_resolution_kind: "customer_csat",
    csat_timeout_closed: false,
  });
});

test("each call returns a fresh object that callers can spread safely", () => {
  assert.notEqual(
    customerCsatResolutionFields(),
    customerCsatResolutionFields(),
  );
});
