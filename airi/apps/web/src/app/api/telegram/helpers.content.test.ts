import type { TelegramMessage } from "@/types/telegram";
import { hasTelegramPersistableContent } from "./message-content";

const baseMessage: TelegramMessage = {
  message_id: 1,
  chat: { id: 123, type: "private" },
  date: 1_700_000_000,
};

describe("hasTelegramPersistableContent", () => {
  it("returns true for plain text messages", () => {
    expect(
      hasTelegramPersistableContent({
        ...baseMessage,
        text: "hello",
      })
    ).toBe(true);
  });

  it("returns true for photo messages", () => {
    expect(
      hasTelegramPersistableContent({
        ...baseMessage,
        photo: [
          {
            file_id: "photo-1",
            file_unique_id: "photo-uniq-1",
            width: 800,
            height: 600,
          },
        ],
      })
    ).toBe(true);
  });

  it("returns true for non-photo media messages", () => {
    expect(
      hasTelegramPersistableContent({
        ...baseMessage,
        document: {
          file_id: "doc-1",
          file_unique_id: "doc-uniq-1",
          mime_type: "application/pdf",
          file_name: "invoice.pdf",
        },
      })
    ).toBe(true);
  });

  it("returns true for caption-only payloads", () => {
    expect(
      hasTelegramPersistableContent({
        ...baseMessage,
        caption: "voice memo",
      })
    ).toBe(true);
  });

  it("returns false for payloads without text, caption or supported media", () => {
    expect(
      hasTelegramPersistableContent({
        ...baseMessage,
        entities: [{ offset: 0, length: 1, type: "bold" }],
      })
    ).toBe(false);
  });
});
