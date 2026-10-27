import {
  isLikelyIncompleteAssistantReply,
  shouldPreferRetriedAssistantReply,
} from "@/lib/airi/reply/generation/reply-completeness";

describe("airi reply completeness", () => {
  it("flags clearly truncated grounded replies", () => {
    expect(
      isLikelyIncompleteAssistantReply(
        "Для подачи заявки, пожалуйста, уточните, на какую именно программу вы хотите подать.\n\nЕсли речь идет о программе «БесТірек», то дедлайн подачи заявки — 30 апреля 2"
      )
    ).toBe(true);

    expect(
      isLikelyIncompleteAssistantReply(
        "Сәлеметсіз бе!\n\n«БесТірек» бағдарламасына өтінім беру туралы сұрағыңызды түсіндім. Өтінім берудің нақты әдісі"
      )
    ).toBe(true);
  });

  it("keeps complete replies untouched", () => {
    expect(
      isLikelyIncompleteAssistantReply(
        "Для участия в программе заполните Google Form до 30 апреля 2026 года и загрузите все обязательные документы."
      )
    ).toBe(false);

    expect(isLikelyIncompleteAssistantReply("Да, конечно")).toBe(false);
  });

  it("prefers repaired replies when they restore completeness", () => {
    const original =
      "Если речь идет о программе «БесТірек», то дедлайн подачи заявки — 30 апреля 2";
    const repaired =
      "Если речь идет о программе «БесТірек», дедлайн подачи заявки — до 17:00 30 апреля 2026 года. Нужно заполнить Google Form и загрузить документы.";

    expect(shouldPreferRetriedAssistantReply(original, repaired)).toBe(true);
    expect(
      shouldPreferRetriedAssistantReply(
        repaired,
        "Если речь идет о программе «БесТірек», дедлайн подачи заявки — до 17:00"
      )
    ).toBe(false);
  });

  it.each([
    "Спасибо! Получили вашу локацию, менеджер свяжется для доставки 😊",
    "Спасибо! Получили вашу локацию, менеджер свяжется с вами",
    "Отлично, локацию получили. Курьер приедет завтра с 10:00 до 18:00",
    "Спасибо! Стоимость доставки — 5000 ₸",
    "Отлично! Записали вас на примерку.\n\n- Курьер привезёт 3 размера\n- Оплата после примерки",
    "Менеджер ответит прямо в этом чате 🙌",
  ])("accepts a chat reply the model ended itself: %s", reply => {
    expect(isLikelyIncompleteAssistantReply(reply, "end_turn")).toBe(false);
  });

  it("still flags a reply cut on a comma or a dangling word after a natural stop", () => {
    expect(
      isLikelyIncompleteAssistantReply(
        "Доставка бесплатная, курьер привезёт размеры и",
        "end_turn"
      )
    ).toBe(true);
    expect(
      isLikelyIncompleteAssistantReply(
        "Доставка бесплатная, позвоним вам,",
        "stop"
      )
    ).toBe(true);
  });

  it("treats a closing emoji as an ending even without a finish reason", () => {
    expect(
      isLikelyIncompleteAssistantReply(
        "Спасибо! Получили вашу локацию, менеджер свяжется для доставки 😊"
      )
    ).toBe(false);
  });

  it("keeps a finished draft over a recovery that is longer but cut off", () => {
    expect(
      shouldPreferRetriedAssistantReply(
        "Спасибо! Менеджер свяжется с вами",
        "Спасибо! Менеджер свяжется с вами, а пока напишите",
        { original: "end_turn", candidate: "max_tokens" }
      )
    ).toBe(false);
  });
});
