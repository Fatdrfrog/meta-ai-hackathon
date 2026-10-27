import {
  buildTelegramCompositeChatId,
  isTelegramPrivateChatId,
  normalizeTelegramChatId,
  parseTelegramCompositeChatId,
} from "./chat-id";

describe("Telegram chat id helpers", () => {
  it("round-trips composite source-scoped chat ids", () => {
    expect(buildTelegramCompositeChatId("12345", "source-1")).toBe(
      "tg_12345_source-1"
    );
    expect(parseTelegramCompositeChatId("tg_12345_source-1")).toBe("12345");
    expect(normalizeTelegramChatId(" tg_12345_source-1 ")).toBe("12345");
  });

  it("keeps private numeric chat ids separate from groups", () => {
    expect(isTelegramPrivateChatId("12345")).toBe(true);
    expect(isTelegramPrivateChatId("-10012345")).toBe(false);
    expect(normalizeTelegramChatId("tg_-10012345_source-1")).toBe("-10012345");
  });
});
