import { buildQueryFromConversation } from "@/lib/airi/conversation";
import { stripDuplicateGreetingLead } from "@/lib/airi/reply/generation/strip-duplicate-greeting-lead";

describe("buildQueryFromConversation", () => {
  const window = [
    "2026-03-25T13:58:00.000Z [CUSTOMER] Хочу узнать о документах",
    "2026-03-25T13:58:10.000Z [AGENT] Уточните, пожалуйста, для какого этапа?",
    "2026-03-25T14:07:00.000Z [CUSTOMER] для второго тура",
  ].join("\n");

  it("uses recent customer context in adaptive mode for short follow-ups", () => {
    expect(
      buildQueryFromConversation(window, "для второго тура", {
        mode: "adaptive",
      }).query
    ).toBe("Хочу узнать о документах. для второго тура");
  });

  it("keeps only the last message in last_message_only mode", () => {
    expect(
      buildQueryFromConversation(window, "для второго тура", {
        mode: "last_message_only",
      }).query
    ).toBe("для второго тура");
  });
});

describe("stripDuplicateGreetingLead", () => {
  it("returns unchanged when alreadyGreeted is false", () => {
    const t = "Привет! Я Айри. Далее текст.";
    expect(stripDuplicateGreetingLead(t, false)).toBe(t);
  });

  it("peels Russian greeting then Airi tag before substance", () => {
    const raw =
      "Привет! Я Айри 👋 Ваш b2b SaaS проект в Казахстане — это отличная возможность.";
    expect(stripDuplicateGreetingLead(raw, true)).toBe(
      "Ваш b2b SaaS проект в Казахстане — это отличная возможность."
    );
  });

  it("removes combined здравствуйте + Airi sentence in one peel", () => {
    const raw =
      "Здравствуйте! 👋 Я Айри. Да, мы с удовольствием помогаем с грантами!";
    expect(stripDuplicateGreetingLead(raw, true)).toBe(
      "Да, мы с удовольствием помогаем с грантами!"
    );
  });

  it("does not empty the reply when stripping would remove everything", () => {
    const raw = "Привет!";
    expect(stripDuplicateGreetingLead(raw, true)).toBe("Привет!");
  });
});

describe("stripDuplicateGreetingLead keeps the reply's content", () => {
  it("drops only the greeting words when the sentence carries an answer", () => {
    expect(
      stripDuplicateGreetingLead(
        "Добрый день, стоимость выезда 5000 ₸. Оплата на месте.",
        true
      )
    ).toBe("Стоимость выезда 5000 ₸. Оплата на месте.");
  });

  it("drops a greeting with the customer's name", () => {
    expect(
      stripDuplicateGreetingLead(
        "Здравствуйте, Айгерим! Доставка завтра с 10:00 до 18:00.",
        true
      )
    ).toBe("Доставка завтра с 10:00 до 18:00.");
  });

  it("keeps the reply's line breaks and lists", () => {
    expect(
      stripDuplicateGreetingLead(
        "Здравствуйте! Вот наши тарифы:\n\n1. Старт — 5000 ₸\n2. Про — 9900 ₸",
        true
      )
    ).toBe("Вот наши тарифы:\n\n1. Старт — 5000 ₸\n2. Про — 9900 ₸");
  });

  it("does not take a word that only starts like a greeting", () => {
    expect(
      stripDuplicateGreetingLead(
        "Приветствуем вас в нашем магазине. Доставка бесплатная.",
        true
      )
    ).toBe("Приветствуем вас в нашем магазине. Доставка бесплатная.");
  });
});
