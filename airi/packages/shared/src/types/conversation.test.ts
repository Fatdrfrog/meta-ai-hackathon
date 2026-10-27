import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_CUSTOMER_LANGUAGE_SOURCES,
  normalizeConversationPreferredLanguage,
} from "./conversation";

test("customer-language source values have one shared contract", () => {
  assert.deepEqual(CONVERSATION_CUSTOMER_LANGUAGE_SOURCES, [
    "explicit",
    "heuristic",
    "workspace_bias",
    "dominant_recent",
    "google_cloud",
  ]);
});

test("normalizeConversationPreferredLanguage normalizes supported locale variants", () => {
  assert.equal(normalizeConversationPreferredLanguage(" RU-ru "), "ru");
  assert.equal(normalizeConversationPreferredLanguage("uz_Latn_UZ"), "uz");
  assert.equal(normalizeConversationPreferredLanguage("en-US"), "en");
  assert.equal(normalizeConversationPreferredLanguage("kz-KZ"), "kz");
});

test("normalizeConversationPreferredLanguage maps the Kazakh locale alias to kz", () => {
  assert.equal(normalizeConversationPreferredLanguage("kk"), "kz");
  assert.equal(normalizeConversationPreferredLanguage("kk-Cyrl-KZ"), "kz");
});

test("normalizeConversationPreferredLanguage rejects unsupported provider codes", () => {
  assert.equal(normalizeConversationPreferredLanguage("uk"), null);
  assert.equal(normalizeConversationPreferredLanguage("tr-TR"), null);
  assert.equal(normalizeConversationPreferredLanguage(""), null);
  assert.equal(normalizeConversationPreferredLanguage(null), null);
});
