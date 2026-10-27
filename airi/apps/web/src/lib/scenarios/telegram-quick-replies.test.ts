import { extractTelegramBranchOptions } from "@/lib/scenarios/telegram-quick-replies";
import {
  coerceTelegramQuickRepliesToRows,
  flattenTelegramQuickReplyRows,
  isTelegramQuickRepliesNestedRowShape,
  normalizeTelegramQuickReplies,
} from "@/lib/scenarios/normalization";

describe("Telegram quick-replies row shape", () => {
  it("detects nested row storage", () => {
    expect(isTelegramQuickRepliesNestedRowShape([])).toBe(false);
    expect(
      isTelegramQuickRepliesNestedRowShape([{ text: "A", payload: "a" }])
    ).toBe(false);
    expect(
      isTelegramQuickRepliesNestedRowShape([[{ text: "A", payload: "a" }]])
    ).toBe(true);
  });

  it("coerces legacy flat list to one button per row", () => {
    const rows = coerceTelegramQuickRepliesToRows([
      { text: "Yes", payload: "yes" },
      { text: "No", payload: "no" },
    ]);
    expect(rows).toEqual([
      [{ text: "Yes", payload: "yes" }],
      [{ text: "No", payload: "no" }],
    ]);
  });

  it("preserves multi-button rows", () => {
    const rows = coerceTelegramQuickRepliesToRows([
      [
        { text: "A", payload: "a" },
        { text: "B", payload: "b" },
      ],
      [{ text: "C", payload: "c" }],
    ]);
    expect(rows).toEqual([
      [
        { text: "A", payload: "a" },
        { text: "B", payload: "b" },
      ],
      [{ text: "C", payload: "c" }],
    ]);
  });

  it("flatten is row-major", () => {
    const rows = [
      [
        { text: "A", payload: "a" },
        { text: "B", payload: "b" },
      ],
      [{ text: "C", payload: "c" }],
    ];
    expect(flattenTelegramQuickReplyRows(rows).map(b => b.payload)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("normalizeTelegramQuickReplies returns undefined for empty", () => {
    expect(normalizeTelegramQuickReplies([])).toBeUndefined();
    expect(normalizeTelegramQuickReplies(null)).toBeUndefined();
  });

  it("extractTelegramBranchOptions follows row-major order", () => {
    const opts = extractTelegramBranchOptions([
      [
        { text: "A", payload: "a" },
        { text: "B", payload: "b" },
      ],
      [{ text: "C", payload: "c" }],
    ]);
    expect(opts.map(o => o.payload)).toEqual(["a", "b", "c"]);
  });
});
