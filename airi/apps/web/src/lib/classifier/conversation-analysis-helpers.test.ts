import mongoose from "mongoose";

import {
  calculateInteractionMetrics,
  formatMessage,
  mapKeyMoments,
  prepareTextForAnalysis,
} from "@/lib/classifier/conversation-analysis-helpers";
import type { PopulatedMessage } from "@/types/models";

function message(
  input: Partial<PopulatedMessage> & Pick<PopulatedMessage, "text" | "direction">
): PopulatedMessage {
  return {
    _id: new mongoose.Types.ObjectId(),
    date: new Date("2026-08-10T00:00:00.000Z"),
    author: { firstName: "Customer", isBot: false },
    ...input,
  } as unknown as PopulatedMessage;
}

describe("conversation analysis helpers", () => {
  it("keeps automated replies out of human response time while preserving customer wait", () => {
    const messages = [
      message({ text: "Price?", direction: "inbound" }),
      message({ text: "Checking", direction: "outbound", date: new Date("2026-08-10T00:00:05Z"), origin: { kind: "airi" } }),
      message({ text: "The price is 100", direction: "outbound", date: new Date("2026-08-10T00:02:00Z"), origin: { kind: "manager" } }),
    ];
    expect(calculateInteractionMetrics(messages).agent_response_time_avg_sec).toBe(120);
  });

  it("returns unknown human response time for a bot-only or unanswered exchange", () => {
    expect(calculateInteractionMetrics([
      message({ text: "Help?", direction: "inbound" }),
      message({ text: "Hello", direction: "outbound", origin: { kind: "scenario" } }),
    ]).agent_response_time_avg_sec).toBeNull();
    expect(calculateInteractionMetrics([message({ text: "Help?", direction: "inbound" })]).agent_response_time_avg_sec).toBeNull();
  });

  it("measures zero-second human response rather than treating it as missing", () => {
    expect(calculateInteractionMetrics([
      message({ text: "Hi", direction: "inbound" }),
      message({ text: "Hello", direction: "outbound", origin: { kind: "manager" } }),
    ]).agent_response_time_avg_sec).toBe(0);
  });

  it("calculates agent share, response time, and customer questions", () => {
    const messages = [
      message({
        text: "Can you help?",
        direction: "inbound",
        date: new Date("2026-08-10T00:00:00.000Z"),
      }),
      message({
        text: "Yes.",
        direction: "outbound",
        date: new Date("2026-08-10T00:00:30.000Z"),
      }),
      message({
        text: "Thanks",
        direction: "inbound",
        date: new Date("2026-08-10T00:01:00.000Z"),
      }),
    ];

    expect(calculateInteractionMetrics(messages)).toEqual({
      talk_ratio: 0.33,
      agent_response_time_avg_sec: 30,
      customer_question_count: 1,
    });
  });

  it("formats messages through the canonical transcript formatter", () => {
    expect(
      formatMessage(
        message({
          text: "Invoice please",
          direction: "outbound",
          author: {
            firstName: "Aida",
            isBot: false,
          } as unknown as PopulatedMessage["author"],
        })
      )
    ).toBe("[Human] Aida: Invoice please");
  });

  it("uses the summary plus the last ten numbered messages", () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      message({ text: `text-${index}`, direction: "inbound" })
    );

    const prepared = prepareTextForAnalysis(messages, "Existing summary", null);

    expect(prepared.messagesOffset).toBe(2);
    expect(prepared.text).toContain("History Summary:\nExisting summary");
    expect(prepared.text).toContain("Message 0: [Human] Customer: text-2");
    expect(prepared.text).toContain("Message 9: [Human] Customer: text-11");
    expect(prepared.text).not.toContain("text-1\n");
  });

  it("keeps a bounded recent numbered window without a summary", () => {
    const messages = Array.from({ length: 35 }, (_, index) =>
      message({ text: `text-${index}`, direction: "inbound" })
    );

    const prepared = prepareTextForAnalysis(messages, undefined, null);

    expect(prepared.messagesOffset).toBe(5);
    expect(prepared.text).toContain("[Earlier conversation - 5 messages]");
    expect(prepared.text).toContain("Message 0: [Human] Customer: text-5");
    expect(prepared.text).toContain("Message 29: [Human] Customer: text-34");
  });

  it("expands only three recent incoming payment candidates in the numbered window", () => {
    const messages = Array.from({ length: 4 }, (_, index) =>
      message({
        text: "",
        direction: "inbound",
        imageAnalysis: `Receipt. ${"Visible detail. ".repeat(30)}Amount: ${index + 1}000 KZT. Status: failed.`,
      })
    );
    messages.push(
      message({
        text: `Ordinary conversation. ${"detail ".repeat(70)}ORDINARY_END`,
        direction: "inbound",
      }),
      message({
        text: `Payment request. ${"detail ".repeat(70)}OUTBOUND_END`,
        direction: "outbound",
      })
    );

    const { text } = prepareTextForAnalysis(messages, undefined, null);

    expect(text).not.toContain("Amount: 1000 KZT");
    expect(text).toContain("Amount: 2000 KZT. Status: failed.");
    expect(text).toContain("Amount: 3000 KZT. Status: failed.");
    expect(text).toContain("Amount: 4000 KZT. Status: failed.");
    expect(text).not.toContain("ORDINARY_END");
    expect(text).not.toContain("OUTBOUND_END");
  });

  it("maps only valid presented key moments to stored message ids", () => {
    const messages = [
      message({ text: "one", direction: "inbound" }),
      message({ text: "two", direction: "outbound" }),
      message({ text: "three", direction: "inbound" }),
    ];

    expect(
      mapKeyMoments(
        [
          { type: "objection", message_index: 0 },
          { type: "positive_feedback", message_index: 1 },
          { type: "upsell_attempt", message_index: 4 },
        ],
        messages,
        1
      )
    ).toEqual([
      { type: "objection", message_ref: messages[1]._id },
      { type: "positive_feedback", message_ref: messages[2]._id },
    ]);
  });
});
