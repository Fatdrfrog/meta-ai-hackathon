import {
  createLlmAnalyticsFormatters,
  LLM_ENUM_MESSAGE_KEYS,
  LLM_OPERATION_MESSAGE_KEYS,
  optionalNumberField,
  presentLlmEnum,
  presentLlmOperation,
  resolveLlmIntlLocale,
  type LlmAnalyticsTranslator,
} from "./llm-analytics-presentation";

const russianMessages: Record<string, string> = {
  "common.unknownValue": "Неизвестное значение ({value})",
  "common.notAvailable": "Нет данных",
  "units.milliseconds": "{value} мс",
  "units.seconds": "{value} с",
  "units.perSecond": "{value}/с",
  "units.scoreOutOf100": "{value} из 100",
  "operations.items.genericChatCompletion": "Обычная генерация в чате",
  "operations.items.airiChatReply": "Ответ в чате Airi",
  "operations.details.generic":
    "Общие вызовы помощника без отдельного ключа сценария.",
  "operations.details.airiChat":
    "Вызовы помощника Airi, сгруппированные по действию продукта.",
  "operations.details.unknown":
    "Трассированные вызовы модели с неизвестным ключом операции.",
  "enums.fallbackAction.groundedRecovery": "Восстановление из контекста",
  "enums.retrievalPath.knowledgeBase": "База знаний",
};

const t: LlmAnalyticsTranslator = (key, values) => {
  const message = russianMessages[key] ?? key;
  return Object.entries(values ?? {}).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, String(value)),
    message
  );
};

describe("LLM analytics presentation", () => {
  it("keeps blank or invalid numeric fields unavailable while preserving measured zero", () => {
    for (const value of [
      "",
      " \t\n",
      null,
      undefined,
      NaN,
      Infinity,
      "invalid",
    ]) {
      expect(optionalNumberField({ metric: value }, "metric")).toBeNull();
    }
    expect(optionalNumberField(null, "metric")).toBeNull();
    expect(optionalNumberField({}, "metric")).toBeNull();
    expect(optionalNumberField({ metric: 0 }, "metric")).toBe(0);
    expect(optionalNumberField({ metric: "0" }, "metric")).toBe(0);
    expect(optionalNumberField({ metric: " 12.5 " }, "metric")).toBe(12.5);
  });

  it("translates known operation identifiers through the typed key map", () => {
    expect(LLM_OPERATION_MESSAGE_KEYS["airi_chat.reply"]).toBe(
      "operations.items.airiChatReply"
    );
    expect(presentLlmOperation("airi_chat.reply", t)).toEqual({
      label: "Ответ в чате Airi",
      detail: "Вызовы помощника Airi, сгруппированные по действию продукта.",
    });
    expect(presentLlmOperation("ai.chat_completion", t)).toEqual({
      label: "Обычная генерация в чате",
      detail: "Общие вызовы помощника без отдельного ключа сценария.",
    });
  });

  it("keeps an unknown operation raw beside the localized unknown label", () => {
    expect(presentLlmOperation("vendor.future_operation", t)).toEqual({
      label: "Неизвестное значение (vendor.future_operation)",
      detail: "Трассированные вызовы модели с неизвестным ключом операции.",
    });
  });

  it("translates known enums and preserves unknown enum codes", () => {
    expect(LLM_ENUM_MESSAGE_KEYS.fallbackAction.grounded_recovery).toBe(
      "enums.fallbackAction.groundedRecovery"
    );
    expect(presentLlmEnum("fallbackAction", "grounded_recovery", t)).toBe(
      "Восстановление из контекста"
    );
    expect(presentLlmEnum("retrievalPath", "kb", t)).toBe("База знаний");
    expect(presentLlmEnum("resultType", "future_result", t)).toBe(
      "Неизвестное значение (future_result)"
    );
  });

  it("maps product kz only at Intl boundaries and formats with the locale", () => {
    expect(resolveLlmIntlLocale("kz")).toBe("kk-KZ");
    expect(resolveLlmIntlLocale("ru")).toBe("ru-RU");

    const formatters = createLlmAnalyticsFormatters("ru", t);

    expect(formatters.number(12_345)).toBe("12 345");
    expect(formatters.percent(12.5)).toBe("12,5 %");
    expect(formatters.currency(12.5)).toContain("12,50");
    expect(formatters.milliseconds(250)).toBe("250 мс");
    expect(formatters.milliseconds(1_500)).toBe("1,5 с");
    expect(formatters.perSecond(3.5)).toBe("3,5/с");
    expect(formatters.score(87.25)).toBe("87,3 из 100");
    expect(formatters.shortDate("2026-07-31")).not.toContain("2026-07-31");
    expect(formatters.shortDate("not-a-date")).toBeNull();
    expect(formatters.dateTime("2026-07-31T12:00:00.000Z")).not.toContain(
      "Jul"
    );
  });

  it("reuses Intl formatter instances for the same normalized locale", () => {
    const numberFormatSpy = jest.spyOn(Intl, "NumberFormat");
    const dateTimeFormatSpy = jest.spyOn(Intl, "DateTimeFormat");

    try {
      const first = createLlmAnalyticsFormatters("de-DE", t);
      first.currency(25);
      first.currency(0.005);

      const numberFormatterCount = numberFormatSpy.mock.calls.length;
      const dateFormatterCount = dateTimeFormatSpy.mock.calls.length;

      const second = createLlmAnalyticsFormatters("de-DE", t);
      second.currency(50);
      second.currency(0.001);

      expect(numberFormatSpy).toHaveBeenCalledTimes(numberFormatterCount);
      expect(dateTimeFormatSpy).toHaveBeenCalledTimes(dateFormatterCount);
    } finally {
      numberFormatSpy.mockRestore();
      dateTimeFormatSpy.mockRestore();
    }
  });
});
