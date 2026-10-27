import assert from "node:assert/strict";
import test from "node:test";
import { buildWhatsAppBusinessAppConnectionPatch } from "./phone-registration-mode.js";

const NOW = "2026-10-16T12:00:00.000Z";

test("marks a live Business app number as a connected coexistence source", () => {
  assert.deepEqual(
    buildWhatsAppBusinessAppConnectionPatch({
      isOnBizApp: true,
      platformType: "CLOUD_API",
      now: NOW,
    }),
    {
      is_on_biz_app: true,
      coexistence_mode: true,
      partner_app_installed: true,
      partner_app_installed_at: NOW,
    },
  );
});

test("does not mark a suspended coexistence source connected again", () => {
  assert.deepEqual(
    buildWhatsAppBusinessAppConnectionPatch({
      isOnBizApp: true,
      coexistenceMode: true,
      partnerAppInstalled: false,
      platformType: "CLOUD_API",
      cloudApiMessagingSuspended: true,
      now: NOW,
    }),
    {
      is_on_biz_app: true,
      coexistence_mode: true,
    },
  );
});

test("leaves plain Cloud API numbers untouched", () => {
  assert.deepEqual(
    buildWhatsAppBusinessAppConnectionPatch({
      embeddedSignupFlow: "cloud_api",
      isOnBizApp: false,
      platformType: "CLOUD_API",
      now: NOW,
    }),
    { is_on_biz_app: false },
  );
});
