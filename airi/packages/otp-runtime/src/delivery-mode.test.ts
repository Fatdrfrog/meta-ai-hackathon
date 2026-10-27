import assert from "node:assert/strict";
import test from "node:test";

import {
  getWhatsAppOtpDeliveryMode,
  shouldUseTemporalWhatsAppOtpDelivery,
} from "./delivery-mode";

const envKeys = [
  "WHATSAPP_OTP_DELIVERY_MODE",
  "WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST",
] as const;

const previous = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]])
) as Record<(typeof envKeys)[number], string | undefined>;

function restoreEnv() {
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("defaults OTP delivery to pubsub", () => {
  delete process.env.WHATSAPP_OTP_DELIVERY_MODE;
  delete process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST;
  assert.equal(getWhatsAppOtpDeliveryMode(), "pubsub");
  assert.equal(shouldUseTemporalWhatsAppOtpDelivery("workspace-1"), false);
  restoreEnv();
});

test("temporal mode without allowlist uses Temporal for every workspace", () => {
  process.env.WHATSAPP_OTP_DELIVERY_MODE = "temporal";
  delete process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST;
  assert.equal(shouldUseTemporalWhatsAppOtpDelivery("workspace-1"), true);
  restoreEnv();
});

test("temporal mode with allowlist only starts Temporal for listed workspaces", () => {
  process.env.WHATSAPP_OTP_DELIVERY_MODE = "temporal";
  process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST =
    "workspace-canary, workspace-2";
  assert.equal(shouldUseTemporalWhatsAppOtpDelivery("workspace-canary"), true);
  assert.equal(shouldUseTemporalWhatsAppOtpDelivery("workspace-other"), false);
  restoreEnv();
});

test("pubsub mode ignores a Temporal allowlist", () => {
  process.env.WHATSAPP_OTP_DELIVERY_MODE = "pubsub";
  process.env.WHATSAPP_OTP_TEMPORAL_WORKSPACE_ALLOWLIST = "workspace-1";
  assert.equal(getWhatsAppOtpDeliveryMode(), "pubsub");
  assert.equal(shouldUseTemporalWhatsAppOtpDelivery("workspace-1"), false);
  restoreEnv();
});

test("unknown delivery mode fails closed to pubsub", () => {
  process.env.WHATSAPP_OTP_DELIVERY_MODE = "both";
  assert.equal(getWhatsAppOtpDeliveryMode(), "pubsub");
  assert.equal(shouldUseTemporalWhatsAppOtpDelivery("workspace-1"), false);
  restoreEnv();
});
