import {
  buildReplyQuotePreviewIndex,
  resolveReplyQuotePreviewText,
} from "./reply-quote-preview";

describe("reply-quote-preview", () => {
  const phoneParentId =
    "ws_wamid.HBgLNzc3NzM4NTk4MzAVAgASGBQyQTVGMkMxQUE0NzI3NTQzRjgzQQA=";
  const bsuidReplyContext =
    "wamid.HBgTS1ouMTY5MjA3NDMzNTMzNzM3OBUUABIYFDJBNUYyQzFBQTQ3Mjc1NDNGODNBAA==";

  it("prefers stored preview text", () => {
    const index = buildReplyQuotePreviewIndex([
      { messageId: phoneParentId, text: "parent in thread" },
    ]);

    expect(
      resolveReplyQuotePreviewText({
        storedPreview: "  stored quote  ",
        replyToMessageId: phoneParentId,
        index,
      })
    ).toBe("stored quote");
  });

  it("resolves WhatsApp parent text from loaded thread via BSUID twin", () => {
    const index = buildReplyQuotePreviewIndex([
      {
        messageId: phoneParentId,
        text: "140560. Один человек. AP TREID",
      },
    ]);

    expect(
      resolveReplyQuotePreviewText({
        storedPreview: null,
        replyToMessageId: bsuidReplyContext,
        index,
      })
    ).toBe("140560. Один человек. AP TREID");
  });

  it("resolves media placeholder when parent has no text", () => {
    const index = buildReplyQuotePreviewIndex([
      { messageId: phoneParentId, text: " ", mediaType: "image" },
    ]);

    expect(
      resolveReplyQuotePreviewText({
        storedPreview: null,
        replyToMessageId: phoneParentId,
        index,
      })
    ).toBe("[image attachment]");
  });

  it("returns missing-preview fallback when parent is off-page", () => {
    const index = buildReplyQuotePreviewIndex([
      { messageId: "ws_wamid.other", text: "unrelated" },
    ]);

    expect(
      resolveReplyQuotePreviewText({
        storedPreview: null,
        replyToMessageId: phoneParentId,
        index,
        missingPreviewFallback: "Earlier message",
      })
    ).toBe("Earlier message");
  });
});
