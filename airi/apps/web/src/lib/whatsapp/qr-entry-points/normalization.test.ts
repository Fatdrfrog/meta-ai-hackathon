/**
 * @jest-environment node
 */

import {
  normalizeWhatsAppQrEntryPointUuid,
  normalizeWhatsAppQrPlacementNameSearch,
  unicodePrefixSuccessor,
  WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH,
} from "./normalization";

describe("WhatsApp QR entry-point normalization", () => {
  it("normalizes placement search keys with NFKC, Unicode whitespace folding, and locale-independent lowercase", () => {
    expect(
      normalizeWhatsAppQrPlacementNameSearch("  Ｓtore\u00a0  FRONT  ")
    ).toBe("store front");
    expect(normalizeWhatsAppQrPlacementNameSearch("STRAẞE")).toBe("straße");
  });

  it("rejects empty or oversized normalized placement search keys without truncating", () => {
    expect(() =>
      normalizeWhatsAppQrPlacementNameSearch("\u2003\u00a0")
    ).toThrow(/required/i);
    expect(
      normalizeWhatsAppQrPlacementNameSearch(
        "x".repeat(WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH)
      )
    ).toHaveLength(512);
    expect(() =>
      normalizeWhatsAppQrPlacementNameSearch(
        "x".repeat(WHATSAPP_QR_PLACEMENT_NAME_SEARCH_MAX_LENGTH + 1)
      )
    ).toThrow(/too long/i);
  });

  it("computes a Unicode-scalar upper bound for simple-collation prefix scans", () => {
    expect(unicodePrefixSuccessor("store\uffff")).toBe("store𐀀");
    expect("store😀" < unicodePrefixSuccessor("store")!).toBe(true);
    expect(
      unicodePrefixSuccessor(`store${String.fromCodePoint(0x10ffff)}`)
    ).toBe("storf");
    expect(
      unicodePrefixSuccessor(String.fromCodePoint(0x10ffff))
    ).toBeUndefined();
  });

  it("canonicalizes UUID v1-v5 resource identifiers and rejects generic safe segments", () => {
    for (const value of [
      "6BA7B810-9DAD-11D1-80B4-00C04FD430C8",
      "6ba7b811-9dad-21d1-80b4-00c04fd430c8",
      "6ba7b812-9dad-31d1-80b4-00c04fd430c8",
      "6ba7b813-9dad-41d1-80b4-00c04fd430c8",
      "6ba7b814-9dad-51d1-80b4-00c04fd430c8",
    ]) {
      expect(normalizeWhatsAppQrEntryPointUuid(value)).toBe(
        value.toLowerCase()
      );
    }

    for (const value of [
      "entry-1",
      "6ba7b810-9dad-61d1-80b4-00c04fd430c8",
      "6ba7b810-9dad-11d1-70b4-00c04fd430c8",
      " 6ba7b810-9dad-11d1-80b4-00c04fd430c8 ",
      null,
    ]) {
      expect(normalizeWhatsAppQrEntryPointUuid(value)).toBeUndefined();
    }
  });
});
