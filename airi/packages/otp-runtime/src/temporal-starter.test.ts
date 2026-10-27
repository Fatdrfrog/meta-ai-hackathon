import assert from "node:assert/strict";
import test from "node:test";

import {
  AIRI_CONVERSATION_TASK_QUEUE,
  WHATSAPP_OTP_DELIVERY_WORKFLOW,
  WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS,
} from "@icecore/temporal";

import {
  buildWhatsAppOtpDeliveryWorkflowStartOptions,
  isWhatsAppOtpWorkflowAlreadyStartedError,
  startWhatsAppOtpDeliveryWorkflow,
} from "./temporal-starter";

const message = {
  workspaceId: "workspace-1",
  challengeId: "challenge-1",
  correlationId: "corr-1",
  queuedAt: new Date().toISOString(),
};

test("workflow start options stay identifier-only and bound to OTP expiry", () => {
  const previousQueue = process.env.TEMPORAL_TASK_QUEUE;
  delete process.env.TEMPORAL_TASK_QUEUE;
  const options = buildWhatsAppOtpDeliveryWorkflowStartOptions(message);
  if (previousQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
  else process.env.TEMPORAL_TASK_QUEUE = previousQueue;

  assert.equal(options.workflowId, "whatsapp-otp:challenge-1");
  assert.equal(options.taskQueue, AIRI_CONVERSATION_TASK_QUEUE);
  assert.equal(options.workflowIdReusePolicy, "ALLOW_DUPLICATE_FAILED_ONLY");
  assert.equal(
    options.workflowExecutionTimeout,
    WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS,
  );
  assert.deepEqual(options.args, [
    {
      contractVersion: 1,
      workspaceId: "workspace-1",
      challengeId: "challenge-1",
      correlationId: "corr-1",
    },
  ]);
  const serialized = JSON.stringify(options.args);
  assert.doesNotMatch(serialized, /encryptedCode|accessToken|plaintext|123456/);
});

test("duplicate workflow start is treated as success", async () => {
  const starts: unknown[] = [];
  const result = await startWhatsAppOtpDeliveryWorkflow(message, {
    startWorkflow: async (workflowName, options) => {
      starts.push({ workflowName, options });
      const error = new Error("workflow execution already started");
      error.name = "WorkflowExecutionAlreadyStartedError";
      throw error;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.messageId, "whatsapp-otp:challenge-1");
  assert.equal(starts.length, 1);
  assert.equal(
    (starts[0] as { workflowName: string }).workflowName,
    WHATSAPP_OTP_DELIVERY_WORKFLOW,
  );
  assert.equal(
    isWhatsAppOtpWorkflowAlreadyStartedError({
      name: "WorkflowExecutionAlreadyStartedError",
      message: "already started",
    }),
    false,
  );
  assert.equal(
    isWhatsAppOtpWorkflowAlreadyStartedError(
      Object.assign(new Error("already started"), {
        name: "WorkflowExecutionAlreadyStartedError",
      }),
    ),
    true,
  );
});
