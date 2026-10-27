import assert from "node:assert/strict";
import test from "node:test";

import { analyzeSubscribedFields, buildRequiredFields } from "./webhookFields";

test("requires the calls webhook field for Full Cloud call handling", () => {
  const fields = buildRequiredFields({ coexistenceMode: false });

  assert.ok(fields.includes("calls"));
});

test("requires Meta's documented coexistence fields without requiring generic message echoes", () => {
  const fields = buildRequiredFields({ coexistenceMode: true });

  for (const field of ["history", "smb_app_state_sync", "smb_message_echoes"]) {
    assert.ok(fields.includes(field));
  }
  assert.equal(fields.includes("message_echoes"), false);
});

test("does not report generic message echoes as missing optional coverage", () => {
  const coverage = analyzeSubscribedFields([
    "messages",
    "account_update",
    "calls",
  ]);

  assert.equal(coverage.optionalFields.includes("message_echoes"), false);
  assert.equal(
    coverage.missingOptionalFields.includes("message_echoes"),
    false,
  );
});

test("tracks the business username lifecycle field as optional coverage", () => {
  const fields = buildRequiredFields();
  const coverage = analyzeSubscribedFields([
    "messages",
    "account_update",
    "calls",
    "group_lifecycle_update",
    "group_participants_update",
    "group_settings_update",
    "group_status_update",
    "flows",
    "account_alerts",
    "business_capability_update",
    "message_template_status_update",
    "message_template_quality_update",
    "message_template_components_update",
    "template_category_update",
    "template_correct_category_detection",
    "tracking_events",
    "partner_solutions",
    "payment_configuration_update",
    "security",
    "user_preferences",
  ]);

  assert.equal(fields.includes("business_username_updates"), false);
  assert.equal(
    coverage.requiredFields.includes("business_username_updates"),
    false,
  );
  assert.ok(coverage.optionalFields.includes("business_username_updates"));
  assert.ok(
    coverage.missingOptionalFields.includes("business_username_updates"),
  );
  assert.equal(coverage.coverageOk, true);
});

test("does not require the legacy phone-number username webhook field", () => {
  const fields = buildRequiredFields();

  assert.equal(fields.includes("phone_number_username_update"), false);
});

test("requires business capability updates because source limits are persisted from that webhook", () => {
  const fields = buildRequiredFields();

  assert.ok(fields.includes("business_capability_update"));
});

test("accepts coexistence webhook coverage when only business username updates are missing", () => {
  const coverage = analyzeSubscribedFields(
    [
      "messages",
      "account_update",
      "calls",
      "group_lifecycle_update",
      "group_participants_update",
      "group_settings_update",
      "group_status_update",
      "flows",
      "account_alerts",
      "business_capability_update",
      "message_template_status_update",
      "message_template_quality_update",
      "message_template_components_update",
      "template_category_update",
      "template_correct_category_detection",
      "tracking_events",
      "partner_solutions",
      "payment_configuration_update",
      "security",
      "user_preferences",
      "history",
      "smb_app_state_sync",
      "smb_message_echoes",
    ],
    { coexistenceMode: true },
  );

  assert.deepEqual(coverage.missingRequiredFields, []);
  assert.ok(
    coverage.missingOptionalFields.includes("business_username_updates"),
  );
  assert.equal(coverage.coverageOk, true);
});
