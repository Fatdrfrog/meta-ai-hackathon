import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmbeddedSignupConnectionModePatch,
  wasWhatsAppCoexistenceConnection,
} from "./phone-registration-mode.js";

const NOW = "2026-10-17T09:00:00.000Z";

test("recognizes Business app connections from the stored flags", () => {
  assert.equal(
    wasWhatsAppCoexistenceConnection({ coexistence_mode: true }),
    true,
  );
  assert.equal(
    wasWhatsAppCoexistenceConnection({ partner_app_installed: true }),
    true,
  );
  assert.equal(
    wasWhatsAppCoexistenceConnection({ platform_type: "SMB_COEXISTENCE" }),
    true,
  );
  assert.equal(
    wasWhatsAppCoexistenceConnection({
      coexistence_mode: false,
      platform_type: "CLOUD_API",
    }),
    false,
  );
  assert.equal(wasWhatsAppCoexistenceConnection({}), false);
});

test("records the upgrade when a Business app number leaves coexistence", () => {
  assert.deepEqual(
    buildEmbeddedSignupConnectionModePatch({
      previousCredentials: { coexistence_mode: true },
      leavesCoexistence: true,
      upgradeIntent: false,
      now: NOW,
    }),
    {
      coexistence_mode: false,
      partner_app_installed: false,
      coexistence_upgraded_at: NOW,
      previous_coexistence: true,
    },
  );
});

test("an explicit upgrade clears coexistence even when Meta did not leave it", () => {
  assert.deepEqual(
    buildEmbeddedSignupConnectionModePatch({
      previousCredentials: { partner_app_installed: true },
      leavesCoexistence: false,
      upgradeIntent: true,
      now: NOW,
    }),
    {
      coexistence_mode: false,
      partner_app_installed: false,
      coexistence_upgraded_at: NOW,
      previous_coexistence: true,
    },
  );
});

test("a Cloud API connection without a Business app history records no upgrade", () => {
  assert.deepEqual(
    buildEmbeddedSignupConnectionModePatch({
      previousCredentials: {},
      leavesCoexistence: true,
      upgradeIntent: true,
      now: NOW,
    }),
    { coexistence_mode: false, partner_app_installed: false },
  );
});

test("leaves a coexistence connection alone without an upgrade", () => {
  assert.deepEqual(
    buildEmbeddedSignupConnectionModePatch({
      previousCredentials: { coexistence_mode: true },
      leavesCoexistence: false,
      upgradeIntent: false,
      now: NOW,
    }),
    {},
  );
  assert.deepEqual(
    buildEmbeddedSignupConnectionModePatch({
      previousCredentials: {},
      leavesCoexistence: false,
      upgradeIntent: true,
      now: NOW,
    }),
    {},
  );
});
