import type { KBArticleResult } from "@/lib/airi/rag/kb/kb-types";
import type { ThreadMessage } from "@/lib/airi/reply/thread/thread-context";

function inbound(id: string, text: string, date: string): ThreadMessage {
  return {
    id,
    text,
    direction: "inbound",
    date,
  };
}

function outbound(id: string, text: string, date: string): ThreadMessage {
  return {
    id,
    text,
    direction: "outbound",
    date,
  };
}

export const march30WhatsAppKbContext: KBArticleResult[] = [
  {
    id: "kb-whatsapp-integration",
    title: "Интеграция с WhatsApp for Business",
    fullContent:
      "Airi.chat позволяет подключить WhatsApp Business и вести переписку с клиентами из единой панели. Можно объединять WhatsApp, Telegram и виджет сайта в одной системе поддержки.",
    similarity: 0.93,
    locale: "ru",
    sourceType: "kb_article",
    allowAutoLinkEmbedding: true,
  },
];

export const march30GreetingOnlyReplay = {
  language: "ru",
  latestInboundText: "Здравствуйте",
  messages: [
    inbound("m-1", "Здравствуйте", "2026-03-30T13:56:00.000Z"),
  ] satisfies ThreadMessage[],
};

export const march30GreetingPlusWhatsAppReplay = {
  language: "ru",
  latestInboundText: "Здравствуйте! Хочу узнать об Airi.chat и WhatsApp",
  messages: [
    ...march30GreetingOnlyReplay.messages,
    outbound(
      "m-2",
      "Airi: Пожалуйста, уточните ваш вопрос чуть точнее, и я постараюсь ответить без ошибки.",
      "2026-03-30T13:57:00.000Z"
    ),
    inbound(
      "m-3",
      "Здравствуйте! Хочу узнать об Airi.chat и WhatsApp",
      "2026-03-30T13:58:00.000Z"
    ),
  ] satisfies ThreadMessage[],
  kbContext: march30WhatsAppKbContext,
};

export const unresolvedDocumentsFollowupReplay = {
  language: "ru",
  latestInboundText: "Я жду",
  messages: [
    inbound(
      "d-1",
      "Мне нужны документы для второго этапа",
      "2026-03-27T11:26:00.000Z"
    ),
    outbound(
      "d-2",
      "Airi: Уточните, пожалуйста, для какого именно этапа нужны документы?",
      "2026-03-27T11:27:00.000Z"
    ),
    inbound("d-3", "Я жду", "2026-03-27T11:28:00.000Z"),
  ] satisfies ThreadMessage[],
};

export const lowConfidenceWhatsAppReplay = {
  language: "ru",
  latestInboundText: "мм",
  messages: [
    inbound(
      "l-1",
      "Хочу узнать про Airi.chat и WhatsApp",
      "2026-03-30T14:00:00.000Z"
    ),
    outbound(
      "l-2",
      "Airi: Что именно вас интересует в Airi.chat и WhatsApp?",
      "2026-03-30T14:01:00.000Z"
    ),
    inbound("l-3", "мм", "2026-03-30T14:02:00.000Z"),
  ] satisfies ThreadMessage[],
  kbContext: march30WhatsAppKbContext,
};
