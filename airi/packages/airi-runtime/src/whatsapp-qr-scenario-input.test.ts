import assert from "node:assert/strict";
import test from "node:test";

import { resolveWhatsAppQrScenarioTriggerText } from "./whatsapp-qr-scenario-input";

test("keeps the raw marker only when QR resolution has a concrete WhatsApp source", () => {
  assert.equal(
    resolveWhatsAppQrScenarioTriggerText({
      channel: "whatsapp",
      sourceId: "source-1",
      rawText: "Need help\n[Ref: ABCDE-FGHIJ]",
      effectiveText: "Need help",
    }),
    "Need help\n[Ref: ABCDE-FGHIJ]",
  );
});

test("uses marker-free text when the conversation has no source id", () => {
  assert.equal(
    resolveWhatsAppQrScenarioTriggerText({
      channel: "whatsapp",
      sourceId: undefined,
      rawText: "Need help\n[Ref: ABCDE-FGHIJ]",
      effectiveText: "Need help",
    }),
    "Need help",
  );
});

test("uses marker-free text for non-WhatsApp channels", () => {
  assert.equal(
    resolveWhatsAppQrScenarioTriggerText({
      channel: "telegram",
      sourceId: "source-1",
      rawText: "Need help\n[Ref: ABCDE-FGHIJ]",
      effectiveText: "Need help",
    }),
    "Need help",
  );
});
