import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allocateWhatsAppQrReferenceCode,
  extractWhatsAppQrReference,
  formatWhatsAppQrReference,
  formatWhatsAppQrReferenceMessage,
  parseWhatsAppQrReferenceLine,
  WHATSAPP_QR_FINAL_MESSAGE_MAX_LENGTH,
} from "./whatsapp-qr-reference.ts";

describe("WhatsApp QR references", () => {
  it("formats and parses exactly ten Crockford Base32 characters as a standalone line", () => {
    assert.equal(formatWhatsAppQrReference("01234abcde"), "[Ref: 01234-ABCDE]");
    assert.equal(
      parseWhatsAppQrReferenceLine("[Ref: 01234-ABCDE]"),
      "01234ABCDE",
    );
    for (const invalidLine of [
      "before [Ref: 01234-ABCDE]",
      "[Ref: 01234-ABCDE] after",
      " [Ref: 01234-ABCDE]",
      "[Ref: 01234-ABCDE] ",
      "[Ref: 01234-ABCDI]",
      "[Ref: 0123-4ABCDE]",
    ]) {
      assert.equal(parseWhatsAppQrReferenceLine(invalidLine), undefined);
    }
  });

  it("preserves raw inbound text and removes only an exact marker line from effective text", () => {
    assert.deepEqual(
      extractWhatsAppQrReference("Hello\n[Ref: 01234-ABCDE]\nNeed help"),
      {
        rawText: "Hello\n[Ref: 01234-ABCDE]\nNeed help",
        effectiveText: "Hello\nNeed help",
        referenceCode: "01234ABCDE",
      },
    );
    assert.deepEqual(
      extractWhatsAppQrReference("Hello [Ref: 01234-ABCDE]"),
      {
        rawText: "Hello [Ref: 01234-ABCDE]",
        effectiveText: "Hello [Ref: 01234-ABCDE]",
      },
    );
  });

  it("adds one visible reference line and rejects final messages over 140 characters", () => {
    assert.equal(
      formatWhatsAppQrReferenceMessage("Welcome", "01234ABCDE"),
      "Welcome\n[Ref: 01234-ABCDE]",
    );
    assert.equal(
      formatWhatsAppQrReferenceMessage("x".repeat(120), "01234ABCDE").length,
      139,
    );
    assert.throws(
      () => formatWhatsAppQrReferenceMessage("x".repeat(121), "01234ABCDE"),
      RangeError,
    );
  });

  it("retries collisions only through its bounded allocation budget", async () => {
    const candidates = ["01234ABCDE", "FGHJKMNPQR", "STVWXYZ012"];
    let nextCandidate = 0;
    const attempted: string[] = [];
    const allocated = await allocateWhatsAppQrReferenceCode({
      generate: () => candidates[nextCandidate++]!,
      isAvailable: async code => {
        attempted.push(code);
        return code === "FGHJKMNPQR";
      },
      maxAttempts: 2,
    });
    assert.equal(allocated, "FGHJKMNPQR");
    assert.deepEqual(attempted, ["01234ABCDE", "FGHJKMNPQR"]);

    await assert.rejects(
      allocateWhatsAppQrReferenceCode({
        generate: () => "01234ABCDE",
        isAvailable: async () => false,
        maxAttempts: 2,
      }),
      /allocation exhausted/,
    );
  });
});
