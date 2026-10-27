import assert from "node:assert/strict";
import test from "node:test";

import { getWhatsAppCallMediaReadiness } from "@icecore/shared/lib/whatsapp/calling-media-readiness";

test("enables media by default for Full Cloud Embedded Signup sources when Meta calls are enabled", () => {
  assert.deepEqual(
    getWhatsAppCallMediaReadiness({
      calls_enabled: true,
      coexistence_mode: false,
      embedded_signup_flow: "cloud_api",
    }),
    { enabled: true, reason: null },
  );
});

test("keeps media disabled for coexistence sources", () => {
  assert.deepEqual(
    getWhatsAppCallMediaReadiness({
      calls_enabled: true,
      coexistence_mode: true,
      embedded_signup_flow: "coexistence",
    }),
    { enabled: false, reason: "source_media_disabled" },
  );
});

test("respects an explicit source media disable override", () => {
  assert.deepEqual(
    getWhatsAppCallMediaReadiness({
      calls_enabled: true,
      coexistence_mode: false,
      embedded_signup_flow: "cloud_api",
      whatsapp_calls_media_enabled: false,
    }),
    { enabled: false, reason: "source_media_disabled" },
  );
});

test("keeps media disabled until Meta call defaults are enabled", () => {
  assert.deepEqual(
    getWhatsAppCallMediaReadiness({
      calls_enabled: false,
      coexistence_mode: false,
      embedded_signup_flow: "cloud_api",
    }),
    { enabled: false, reason: "source_calls_not_enabled" },
  );
});
