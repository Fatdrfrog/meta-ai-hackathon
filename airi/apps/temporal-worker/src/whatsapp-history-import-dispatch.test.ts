import assert from "node:assert/strict";
import test from "node:test";
import type { WhatsAppWebhookEventEnvelope } from "@icecore/airi-runtime/whatsapp-webhook-event-envelopes";
import { publishWhatsAppHistoryChildren } from "./whatsapp-history-import-dispatch";

test("a failed history wakeup leaves its durable receipt retryable and does not block siblings", async () => {
  const published: string[] = [];
  const marked: string[] = [];
  await publishWhatsAppHistoryChildren(
    [
      { dedupeKey: "one" },
      { dedupeKey: "two" },
    ] as WhatsAppWebhookEventEnvelope[],
    {
      findPending: async () =>
        ["one", "two"].map((id) => ({
          _id: id,
          dedupeKey: id,
          field: "history",
          itemKind: "history_message",
          orderingKey: "phone:history_message:chat",
          firstReceivedAt: new Date(),
        })),
      publish: async (message) => {
        published.push(message.eventId);
        if (message.eventId === "one")
          throw new Error("pubsub temporarily unavailable");
        return "published-two";
      },
      markPublished: async (id) => {
        marked.push(id);
      },
    },
  );
  assert.deepEqual(published, ["one", "two"]);
  assert.deepEqual(marked, ["two"]);
});

test("history publication yields remaining durable children to the drain after its time budget", async () => {
  let time = 0;
  const published: string[] = [];
  const children = Array.from({ length: 30 }, (_, i) => ({
    dedupeKey: String(i),
  })) as WhatsAppWebhookEventEnvelope[];
  await publishWhatsAppHistoryChildren(children, {
    now: () => time,
    findPending: async (keys) =>
      keys.map((id) => ({
        _id: id,
        dedupeKey: id,
        field: "history",
        itemKind: "history_message",
        orderingKey: id,
        firstReceivedAt: new Date(),
      })),
    publish: async (message) => {
      published.push(message.eventId);
      time = 10_001;
      return message.eventId;
    },
    markPublished: async () => undefined,
  });
  assert.equal(published.length, 10);
});
