import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
  WHATSAPP_OTP_DELIVER_CHALLENGE_SCHEDULE_TO_CLOSE_TIMEOUT,
  WHATSAPP_OTP_DELIVER_CHALLENGE_START_TO_CLOSE_TIMEOUT,
  WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES,
  WHATSAPP_OTP_DELIVERY_WORKFLOW,
  WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS,
  buildWhatsAppOtpDeliveryWorkflowId,
} from "@icecore/temporal";

import { whatsappOtpDeliveryWorkflow } from "./workflows/whatsapp-otp-delivery.js";

test("OTP workflow id is challenge-scoped and input has no code fields", async () => {
  assert.equal(
    buildWhatsAppOtpDeliveryWorkflowId("challenge-1"),
    "whatsapp-otp:challenge-1",
  );
  assert.equal(WHATSAPP_OTP_DELIVERY_WORKFLOW, "whatsappOtpDeliveryWorkflow");
  assert.equal(
    WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
    "whatsappOtpDeliverChallengeActivity",
  );
  const source = await readFile(
    new URL("./workflows/whatsapp-otp-delivery.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /encryptedCode|accessToken|plaintext/);
  assert.match(source, /scheduleToCloseTimeout/);
  assert.match(source, /WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES/);
  assert.doesNotMatch(whatsappOtpDeliveryWorkflow.toString(), /encryptedCode/);
  assert.equal(WHATSAPP_OTP_DELIVER_CHALLENGE_START_TO_CLOSE_TIMEOUT, "30s");
  assert.equal(
    WHATSAPP_OTP_DELIVER_CHALLENGE_SCHEDULE_TO_CLOSE_TIMEOUT,
    "10m",
  );
  assert.equal(WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS, 600_000);
  assert.deepEqual(
    [...WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES],
    [
      "WhatsAppOtpExpired",
      "WhatsAppOtpNotFound",
      "WhatsAppOtpMissingCredentials",
      "WhatsAppOtpMissingTemplate",
      "WhatsAppOtpMissingCode",
    ],
  );
});
