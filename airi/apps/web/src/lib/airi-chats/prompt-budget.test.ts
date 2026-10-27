import {
  AIRI_CHAT_INPUT_CHAR_LIMIT,
  AIRI_CHAT_INPUT_TOKEN_LIMIT,
  buildBoundedAiriChatPrompt,
} from "./prompt-budget";
import { estimateTokenCount } from "@/lib/airi/shared/token-budget";

it("reserves the complete allowed Cyrillic request before allocating context", () => {
  const userMessage = "Я".repeat(3900) + " FINAL_CONSTRAINT_42";
  const prompt = buildBoundedAiriChatPrompt({
    header: "Workspace assistant",
    instructions: "Respect every constraint.",
    stableSections: [
      { label: "KNOWLEDGE", content: "Large context ".repeat(10000) },
    ],
    history: "User: Earlier history " + "старый контекст ".repeat(10000),
    userMessage,
  });
  expect(prompt).toContain(userMessage);
  expect(prompt.endsWith(`USER MESSAGE: "${userMessage}"`)).toBe(true);
  expect(prompt.length).toBeLessThanOrEqual(AIRI_CHAT_INPUT_CHAR_LIMIT);
  expect(estimateTokenCount(prompt)).toBeLessThanOrEqual(
    AIRI_CHAT_INPUT_TOKEN_LIMIT
  );
});

it("deduplicates equal context blocks while retaining instructions and selected content", () => {
  const prompt = buildBoundedAiriChatPrompt({
    header: "Workspace assistant",
    instructions: "Use this tenant's evidence only.",
    stableSections: [
      { label: "SELECTED SOURCE", content: "Refunds within thirty days." },
      { label: "AUTOMATIC SOURCE", content: "Refunds within thirty days." },
    ],
    history: "User: Earlier question",
    userMessage: "Latest request",
  });
  expect(prompt.match(/Refunds within thirty days\./g)).toHaveLength(1);
  expect(prompt).toContain("SELECTED SOURCE");
  expect(prompt).toContain("Latest request");
  expect(prompt.indexOf("SELECTED SOURCE")).toBeLessThan(
    prompt.indexOf("THREAD HISTORY")
  );
});

function russianSentence(index: number): string {
  return `Предложение номер ${index} про запись клиентов и напоминания. `;
}

function russianText(chars: number, marker: string): string {
  let text = `${marker} `;
  let index = 1;
  while (text.length < chars - marker.length - 1) {
    text += russianSentence(index);
    index += 1;
  }
  return `${text.slice(0, chars - marker.length - 1).trimEnd()} ${marker}`;
}

const generalSections = [
  {
    label: "ATTACHED SOURCES",
    content: "No explicit sources attached. Use automatic workspace context.",
  },
  { label: "ATTACHED FILES", content: [] },
  { label: "WORKSPACE KNOWLEDGE", content: "No relevant KB articles found." },
  {
    label: "RECENT CUSTOMER CONTEXT",
    content: "No relevant conversations found.",
  },
];

it("keeps the latest reply of a Russian 12-message thread intact and drops the duplicated request", () => {
  const latestReply = russianText(1064, "LATEST_REPLY_END");
  const userMessage = "А что делать с клиентами, которые не ответили?";
  const lines: string[] = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    lines.push(`User: Вопрос ${turn}: как настроить напоминания?`);
    lines.push(`Airi: ${russianText(600, `REPLY_${turn}`)}`);
  }
  lines.push(`Airi: ${latestReply}`);
  // The thread read includes the message being answered.
  lines.push(`User: ${userMessage}`);
  expect(lines).toHaveLength(12);

  const prompt = buildBoundedAiriChatPrompt({
    header: "Workspace assistant",
    instructions: "Answer directly.",
    stableSections: generalSections,
    history: lines.join("\n"),
    userMessage,
  });

  expect(prompt).toContain(`Airi: ${latestReply}`);
  for (let turn = 1; turn <= 5; turn += 1) {
    expect(prompt).toContain(`REPLY_${turn} `);
    expect(prompt).toContain(` REPLY_${turn}`);
  }
  expect(prompt.split(userMessage)).toHaveLength(2);
  expect(prompt.endsWith(`USER MESSAGE: "${userMessage}"`)).toBe(true);
});

it("does not cut a 1.5k product reply on the first follow-up beside the product sections", () => {
  const reply = `Airi: ${russianText(1500, "PRODUCT_REPLY")}`;
  const userMessage = "А дальше что?";
  const prompt = buildBoundedAiriChatPrompt({
    header: "Workspace assistant",
    // About the size of the real product-capability instructions.
    instructions:
      "- Answer platform how-to questions from the product sections.\n".repeat(
        25
      ),
    stableSections: [
      {
        label: "AIRI.CHAT PRODUCT CAPABILITIES",
        content: "Capability line. ".repeat(3000),
      },
      { label: "WORKSPACE READINESS", content: "WhatsApp: not connected." },
      {
        label: "PUBLISHED AIRI.CHAT PRODUCT KB",
        content: "Help article. ".repeat(800),
      },
      ...generalSections,
    ],
    history: [
      "User: Как подключить WhatsApp?",
      reply,
      `User: ${userMessage}`,
    ].join("\n"),
    userMessage,
  });
  expect(prompt).toContain(reply);
  expect(prompt.length).toBeLessThanOrEqual(AIRI_CHAT_INPUT_CHAR_LIMIT);
  expect(estimateTokenCount(prompt)).toBeLessThanOrEqual(
    AIRI_CHAT_INPUT_TOKEN_LIMIT
  );
});

it("drops the oldest messages first and keeps the last four whole when history overflows", () => {
  const lines = Array.from({ length: 12 }, (_, index) =>
    index % 2 === 0
      ? `User: ${russianText(3000, `MSG_${index}`)}`
      : `Airi: ${russianText(3000, `MSG_${index}`)}`
  );
  const prompt = buildBoundedAiriChatPrompt({
    header: "Workspace assistant",
    instructions: "Answer directly.",
    stableSections: generalSections,
    history: lines.join("\n"),
    userMessage: "Итог?",
  });

  for (const line of lines.slice(-4)) expect(prompt).toContain(line);
  expect(prompt).not.toContain("MSG_0 ");
  expect(prompt).toMatch(/\[\d+ earlier messages omitted\]/);
  expect(prompt.length).toBeLessThanOrEqual(AIRI_CHAT_INPUT_CHAR_LIMIT);
  expect(estimateTokenCount(prompt)).toBeLessThanOrEqual(
    AIRI_CHAT_INPUT_TOKEN_LIMIT
  );
});

it("gives budget that small sections leave unused to a large knowledge section", () => {
  const knowledge = "Refund policy detail sentence. ".repeat(1500);
  const prompt = buildBoundedAiriChatPrompt({
    header: "Workspace assistant",
    instructions: "Answer directly.",
    stableSections: [
      ...generalSections.filter(
        section => section.label !== "WORKSPACE KNOWLEDGE"
      ),
      { label: "WORKSPACE KNOWLEDGE", content: knowledge },
    ],
    history: "User: Earlier question",
    userMessage: "Latest request",
  });
  const knowledgeStart = prompt.indexOf("WORKSPACE KNOWLEDGE:\n");
  const knowledgeText = prompt.slice(
    knowledgeStart,
    prompt.indexOf("\n\nRECENT CUSTOMER CONTEXT", knowledgeStart) === -1
      ? prompt.indexOf("\n\nTHREAD HISTORY")
      : prompt.indexOf("\n\nRECENT CUSTOMER CONTEXT", knowledgeStart)
  );
  // An even five-way split would cap it near a fifth of the budget.
  expect(knowledgeText.length).toBeGreaterThan(AIRI_CHAT_INPUT_CHAR_LIMIT / 2);
  expect(prompt).toContain("User: Earlier question");
  expect(prompt.length).toBeLessThanOrEqual(AIRI_CHAT_INPUT_CHAR_LIMIT);
  expect(estimateTokenCount(prompt)).toBeLessThanOrEqual(
    AIRI_CHAT_INPUT_TOKEN_LIMIT
  );
});
