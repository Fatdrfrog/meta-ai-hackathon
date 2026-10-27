import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationFailure } from "@temporalio/activity";

import {
  classifyWhatsAppOtpDeliveryError,
  mapWhatsAppOtpDeliveryOutcome,
} from "./whatsapp-otp-delivery.js";

test("activity maps expired and missing challenges to non-retryable failures", () => {
  assert.throws(
    () =>
      mapWhatsAppOtpDeliveryOutcome({
        status: "expired",
        challengeId: "challenge-1",
      }),
    (error: unknown) =>
      error instanceof ApplicationFailure &&
      error.nonRetryable === true &&
      error.type === "WhatsAppOtpExpired",
  );
  assert.throws(
    () =>
      mapWhatsAppOtpDeliveryOutcome({
        status: "not_found",
        challengeId: "challenge-1",
      }),
    (error: unknown) =>
      error instanceof ApplicationFailure &&
      error.type === "WhatsAppOtpNotFound",
  );
});

test("already-sent and skipped outcomes succeed without a second send", () => {
  assert.deepEqual(
    mapWhatsAppOtpDeliveryOutcome({
      status: "already_sent",
      challengeId: "challenge-1",
      providerMessageId: "wamid.existing",
    }),
    {
      status: "already_sent",
      challengeId: "challenge-1",
      providerMessageId: "wamid.existing",
    },
  );
  assert.deepEqual(
    mapWhatsAppOtpDeliveryOutcome({
      status: "skipped",
      challengeId: "challenge-1",
    }),
    {
      status: "skipped",
      challengeId: "challenge-1",
    },
  );
});

test("missing template and credentials are permanent; Meta 500 stays retryable", () => {
  const templateError = classifyWhatsAppOtpDeliveryError(
    new Error("WhatsApp OTP template is no longer approved"),
  );
  assert.ok(templateError instanceof ApplicationFailure);
  assert.equal(templateError?.type, "WhatsAppOtpMissingTemplate");
  assert.equal(templateError?.nonRetryable, true);

  const credentialError = classifyWhatsAppOtpDeliveryError(
    new Error("WhatsApp credentials are incomplete"),
  );
  assert.equal(credentialError?.type, "WhatsAppOtpMissingCredentials");

  assert.equal(
    classifyWhatsAppOtpDeliveryError(new Error("Meta 500")),
    null,
  );
});
