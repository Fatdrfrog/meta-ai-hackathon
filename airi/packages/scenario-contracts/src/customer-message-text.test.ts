import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isDeletedMessagePlaceholderText,
  isMeaningfulMessageText,
  isMediaPlaceholderText,
  isNonLinguisticPlaceholderText,
  listCustomerMessageTextParts,
  readMeaningfulMessageText,
} from "./customer-message-text.ts";

describe("customer message text", () => {
  it("recognizes stored media placeholders", () => {
    for (const text of [
      "[image attachment]",
      " [Round video] ",
      "[voice message]",
      "[attachment]",
      "[AUDIO]",
    ]) {
      assert.equal(isMediaPlaceholderText(text), true, text);
      assert.equal(isNonLinguisticPlaceholderText(text), true, text);
      assert.equal(isMeaningfulMessageText(text), false, text);
    }
  });

  it("recognizes a deleted message", () => {
    assert.equal(isDeletedMessagePlaceholderText("[Message deleted]"), true);
    assert.equal(isNonLinguisticPlaceholderText("[message deleted]"), true);
    assert.equal(isMeaningfulMessageText(" [Message deleted] "), false);
  });

  it("keeps words the customer wrote, including bracketed text", () => {
    for (const text of ["Aya, judo", "[urgent] call me", "image attachment"]) {
      assert.equal(isMeaningfulMessageText(text), true, text);
    }
    for (const value of ["", "   ", null, undefined, 42]) {
      assert.equal(isMeaningfulMessageText(value), false);
    }
  });

  it("reads one field as trimmed words, or empty for a placeholder", () => {
    assert.equal(readMeaningfulMessageText("  Aya,\njudo  "), "Aya,\njudo");
    for (const value of ["[voice message]", " [Message deleted] ", "  ", 7]) {
      assert.equal(readMeaningfulMessageText(value), "");
    }
  });

  it("lists what the customer said in reading order, skipping placeholders", () => {
    assert.deepEqual(
      listCustomerMessageTextParts({
        text: "[video attachment]",
        audioAnalysis: " Aya ",
        videoAnalysis: "A medal sketch",
      }),
      [
        { source: "audio_analysis", text: "Aya" },
        { source: "video_analysis", text: "A medal sketch" },
      ],
    );
    assert.deepEqual(
      listCustomerMessageTextParts({ text: "Hi", videoAnalysis: null }),
      [{ source: "text", text: "Hi" }],
    );
    assert.deepEqual(listCustomerMessageTextParts({}), []);
  });
});
