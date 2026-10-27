import {
  boundedMultilineText,
  boundedText,
  boundedTextList,
  maskConversationPhone,
  maskPhoneDigits,
} from "../redaction";
import type { AiriMcpConversationBundle } from "../types";

describe("maskPhoneDigits", () => {
  it.each([
    ["77011234567", "+7****67"], // Kazakhstan / Russia
    ["12025550123", "+1****23"], // NANP
    ["998901234567", "+99****67"], // Uzbekistan: two-digit visible prefix
    ["4915123456789", "+49****89"],
    ["49151234", "****34"], // too short to show a prefix
    ["123456", "****56"],
  ])("masks %s as %s", (digits, masked) => {
    expect(maskPhoneDigits(digits)).toBe(masked);
  });

  it.each(["", "12345", "1234567890123456", "+77011234567", "77O11234567"])(
    "rejects non-canonical input %j",
    digits => {
      expect(maskPhoneDigits(digits)).toBeNull();
    }
  );

  it("never reveals more than three of the number's digits", () => {
    const masked = maskPhoneDigits("77011234567") ?? "";
    expect(masked.replace(/\D/gu, "")).toHaveLength(3);
  });
});

function bundle(
  overrides: Partial<AiriMcpConversationBundle["conversation"]>,
  profiles: Partial<Omit<AiriMcpConversationBundle, "conversation">> = {}
): AiriMcpConversationBundle {
  return {
    conversation: { _id: "c1", channel: "whatsapp", ...overrides },
    user: null,
    chat: null,
    ...profiles,
  };
}

describe("maskConversationPhone", () => {
  it("prefers the stored WhatsApp profile like outbound sends do", () => {
    expect(
      maskConversationPhone(
        bundle(
          { user: "bsuid-opaque" },
          { user: { _id: "u1", whatsapp: { waId: "77011234567" } } }
        )
      )
    ).toBe("+7****67");
  });

  it("canonicalizes the legacy national 8-prefix before masking", () => {
    expect(maskConversationPhone(bundle({ user: "wa_87011234567" }))).toBe(
      "+7****67"
    );
  });

  it("does not treat business-scoped user ids as phone numbers", () => {
    expect(
      maskConversationPhone(
        bundle(
          { user: "KZ.1234567890abcdef" },
          { user: { _id: "u1", whatsapp: { userId: "KZ.1234567890abcdef" } } }
        )
      )
    ).toBeNull();
  });

  it.each(["telegram", "instagram", "web_widget", "email"])(
    "returns null for %s conversations even when ids look numeric",
    channel => {
      expect(
        maskConversationPhone(bundle({ channel, user: 77011234567 }))
      ).toBeNull();
    }
  );
});

describe("bounded text", () => {
  it("collapses whitespace and cuts by code point", () => {
    expect(boundedText("  a \n b  ", 10)).toBe("a b");
    expect(boundedText("😀😀😀😀", 3)).toBe("😀😀…");
    expect(boundedText(42, 10)).toBeNull();
    expect(boundedText("   ", 10)).toBeNull();
  });

  it("keeps line breaks for template bodies", () => {
    expect(boundedMultilineText(" Hi {{1}},\nbye ", 50)).toBe("Hi {{1}},\nbye");
  });

  it("bounds, trims and de-duplicates lists", () => {
    expect(boundedTextList(["a", " a ", "", 3, "b", "c"], 2, 5)).toEqual([
      "a",
      "b",
    ]);
    expect(boundedTextList("not a list", 2, 5)).toEqual([]);
  });
});
