import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ingestionSources = [
  "whatsapp-message-processor.ts",
  "whatsapp-webhook-runtime.ts",
  "whatsapp-history-webhook-handler.ts",
  "whatsapp-echo-webhook-handler.ts",
];

test("canonical WhatsApp ingestion never applies commercial conversation limits", () => {
  for (const filename of ingestionSources) {
    const source = readFileSync(new URL(filename, import.meta.url), "utf8");
    assert.doesNotMatch(source, /ensureCompanyConversationCapacity/);
    assert.doesNotMatch(source, /bypassCompanyConversationLimit/);
    assert.doesNotMatch(source, /blockedByLimit/);
  }
});
