import assert from "node:assert/strict";
import test from "node:test";

import {
  WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
  WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES,
  WHATSAPP_OTP_DELIVERY_WORKFLOW,
  WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS,
  buildWhatsAppOtpDeliveryWorkflowId,
  isSupportedWhatsAppOtpDeliveryContractVersion,
} from "./contracts";

test("WhatsApp OTP delivery contract forbids code-bearing workflow ids", () => {
  assert.equal(WHATSAPP_OTP_DELIVERY_WORKFLOW, "whatsappOtpDeliveryWorkflow");
  assert.equal(
    WHATSAPP_OTP_DELIVER_CHALLENGE_ACTIVITY,
    "whatsappOtpDeliverChallengeActivity",
  );
  assert.equal(
    buildWhatsAppOtpDeliveryWorkflowId("challenge-1"),
    "whatsapp-otp:challenge-1",
  );
  assert.equal(WHATSAPP_OTP_DELIVERY_WORKFLOW_EXECUTION_TIMEOUT_MS, 600_000);
  assert.ok(
    WHATSAPP_OTP_DELIVERY_NON_RETRYABLE_ERROR_TYPES.includes(
      "WhatsAppOtpMissingTemplate",
    ),
  );
  assert.equal(isSupportedWhatsAppOtpDeliveryContractVersion(1), true);
  assert.equal(isSupportedWhatsAppOtpDeliveryContractVersion(2), false);
});
