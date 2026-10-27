import { TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS } from "@/lib/telegram/bot-api-inline-keyboard";
import {
  isStorageEquivalentToRows,
  normalizeButtonText,
  normalizeQuickReplyRows,
} from "./utils";

describe("normalizeQuickReplyRows", () => {
  it("preserves row boundaries while normalizing payloads", () => {
    const rows = normalizeQuickReplyRows([
      [
        { text: "Yes", payload: "yes" },
        { text: "Yep", payload: "yes" },
      ],
      [{ text: "No", payload: "no" }],
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(1);
    expect(rows[0]?.[0]?.payload).toBe("yes");
    expect(rows[0]?.[1]?.payload).toBe("yes_2");
    expect(rows[1]?.[0]?.payload).toBe("no");
  });
});

describe("normalizeButtonText", () => {
  it("clamps button labels to the Telegram inline button text limit", () => {
    const oversized = "x".repeat(TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS + 12);

    expect(normalizeButtonText(oversized)).toHaveLength(
      TELEGRAM_INLINE_BUTTON_TEXT_MAX_CHARS
    );
  });
});

describe("isStorageEquivalentToRows", () => {
  it("accepts persisted nested rows when text and payloads already match", () => {
    const rows = [[{ text: "A", payload: "a" }], [{ text: "B", payload: "b" }]];

    expect(isStorageEquivalentToRows(rows, rows)).toBe(true);
  });

  it("rejects legacy flat storage when normalized rows require nested persistence", () => {
    const stored = [
      { text: "A", payload: "a" },
      { text: "B", payload: "b" },
    ];
    const normalizedRows = [
      [
        { text: "A", payload: "a" },
        { text: "B", payload: "b" },
      ],
    ];

    expect(isStorageEquivalentToRows(stored, normalizedRows)).toBe(false);
  });
});
