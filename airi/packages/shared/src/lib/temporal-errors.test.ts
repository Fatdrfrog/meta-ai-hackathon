import assert from "node:assert/strict";
import test from "node:test";

import { isWorkflowAlreadyStartedError } from "./temporal-errors";

function namedError(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

test("isWorkflowAlreadyStartedError matches plain Errors by SDK name", () => {
  assert.equal(
    isWorkflowAlreadyStartedError(
      namedError("WorkflowExecutionAlreadyStartedError"),
    ),
    true,
  );
});

test("isWorkflowAlreadyStartedError matches already-started messages", () => {
  for (const message of [
    "Workflow execution already started",
    "workflow ALREADY EXISTS",
    "WorkflowExecutionAlreadyStarted: wf-1",
  ]) {
    assert.equal(isWorkflowAlreadyStartedError(new Error(message)), true);
  }
});

test("isWorkflowAlreadyStartedError rejects other errors and non-Errors", () => {
  assert.equal(isWorkflowAlreadyStartedError(new Error("timeout")), false);
  assert.equal(
    isWorkflowAlreadyStartedError(namedError("WorkflowNotFoundError")),
    false,
  );
  assert.equal(
    isWorkflowAlreadyStartedError({
      name: "WorkflowExecutionAlreadyStartedError",
      message: "already started",
    }),
    false,
  );
  assert.equal(isWorkflowAlreadyStartedError("already started"), false);
  assert.equal(isWorkflowAlreadyStartedError(null), false);
});
