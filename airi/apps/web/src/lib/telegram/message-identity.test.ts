import {
  buildTelegramStoredMessageMeta,
  resolveTelegramSenderDisplayName,
} from "@/lib/telegram/message-identity";

describe("telegram message identity helpers", () => {
  it("prefers a real user full name before other Telegram sender fallbacks", () => {
    expect(
      resolveTelegramSenderDisplayName({
        author: {
          firstName: "Alice",
          lastName: "Johnson",
          username: "alice_support",
        },
        telegramMeta: {
          senderTag: "VIP",
          authorSignature: "Moderator",
          senderChatTitle: "Support Group",
        },
      })
    ).toBe("Alice Johnson");
  });

  it("falls back through username, sender tag, author signature, and sender chat title", () => {
    expect(
      resolveTelegramSenderDisplayName({
        author: { username: "bob" },
      })
    ).toBe("@bob");

    expect(
      resolveTelegramSenderDisplayName({
        telegramMeta: { senderTag: "Finance desk" },
      })
    ).toBe("Finance desk");

    expect(
      resolveTelegramSenderDisplayName({
        telegramMeta: { authorSignature: "Anonymous admin" },
      })
    ).toBe("Anonymous admin");

    expect(
      resolveTelegramSenderDisplayName({
        telegramMeta: { senderChatTitle: "Announcements" },
      })
    ).toBe("Announcements");
  });

  it("builds stored Telegram metadata with sender display, topic id, and reply preview", () => {
    const meta = buildTelegramStoredMessageMeta({
      message_id: 1001,
      chat: {
        id: -123,
        type: "supergroup",
        title: "Ops room",
      },
      sender_chat: {
        id: -123,
        type: "supergroup",
        title: "Ops room",
      },
      date: 1_700_000_000,
      message_thread_id: 42,
      is_topic_message: true,
      reply_to_message: {
        message_id: 55,
        text: "The database is back up",
      },
      text: "Thanks",
      author_signature: "Night shift",
    });

    expect(meta.senderDisplayName).toBe("Night shift");
    expect(meta.senderChatId).toBe("-123");
    expect(meta.messageThreadId).toBe(42);
    expect(meta.isTopicMessage).toBe(true);
    expect(meta.replyToTelegramMessageId).toBe("55");
    expect(meta.replyToTextPreview).toBe("The database is back up");
  });
});
