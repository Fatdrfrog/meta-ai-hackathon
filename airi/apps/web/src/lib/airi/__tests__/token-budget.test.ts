import {
  estimateTokenCount,
  truncateTranscriptToCharBudget,
  truncateTranscriptToTokenBudget,
} from "@/lib/airi/shared/token-budget";

// Measured with Anthropic count_tokens on claude-sonnet-5-5, 2026-10-23.
const CLAUDE_COUNTS = [
  {
    name: "Russian reply text",
    tokens: 201,
    text: "Отлично! Вот варианты новинок, выберите один из них. Если не найдется варианта для вас, то напишите нам об этом, отправим вам еще партию каталога. Желаете приехать к нам в магазин или отправить футболку к вам на примерку? Отправьте свою локацию, запланируем поездку к вам. Напиши свой вопрос прямо здесь — менеджер ответит в этом чате. Начните с ввода названия вашей компании. Вам необходимо максимально подробно описать, чем именно занимается ваша компания, а также включить краткое описание продуктов и услуг.",
  },
  {
    name: "Kazakh reply text",
    tokens: 163,
    text: "Сәлеметсіз бе! Біздің дүкенге келуді қалайсыз ба, әлде футболканы сізге жіберейік пе? Орналасқан жеріңізді жіберіңіз, біз сізге баруды жоспарлаймыз. Сұрағыңызды осында жазыңыз, менеджер осы чатта жауап береді. Компанияңыздың атауын енгізуден бастаңыз және қызметіңізді толық сипаттаңыз.",
  },
  {
    name: "English reply text",
    tokens: 99,
    text: "Great! Here are the new options, pick one of them. If none fits you, write to us and we will send you another batch of the catalog. Would you like to visit our store or have the T-shirt sent to you for a fitting? Send your location and we will plan a trip to you. Write your question right here and a manager will answer in this chat.",
  },
  {
    name: "rendered conversation tail",
    tokens: 252,
    text: [
      "2026-10-23T14:07:07.338Z [AGENT] Отлично! Вот варианты новинок, выберите один из них.",
      "2026-10-23T14:07:51.000Z [CUSTOMER] Примерить",
      "2026-10-23T14:08:00.207Z [AGENT] Отличный выбор! Желаете приехать к нам в магазин или отправить футболку к вам на примерку?",
      "2026-10-23T14:08:04.000Z [CUSTOMER] Отправить футболку",
      "2026-10-23T14:08:09.409Z [AGENT] Отправьте свою локацию, запланируем поездку к вам",
      "2026-10-23T14:08:15.000Z [CUSTOMER] [Location] 51.105938, 71.396126",
    ].join("\n"),
  },
];

describe("token budget", () => {
  it.each(CLAUDE_COUNTS)(
    "estimates $name within Claude's measured count",
    ({ text, tokens }) => {
      const estimate = estimateTokenCount(text);
      // Undercounting lets prompts overflow; a little over is the safe side.
      expect(estimate).toBeGreaterThanOrEqual(Math.floor(tokens * 0.88));
      expect(estimate).toBeLessThanOrEqual(Math.ceil(tokens * 1.3));
    }
  );

  it("drops the oldest transcript lines first", () => {
    const transcript = ["oldest line", "middle line", "latest line"].join("\n");
    expect(truncateTranscriptToCharBudget(transcript, 24)).toBe(
      "middle line\nlatest line"
    );
    expect(truncateTranscriptToCharBudget(transcript, 12)).toBe("latest line");
    expect(
      truncateTranscriptToTokenBudget(
        transcript,
        estimateTokenCount("latest line")
      )
    ).toBe("latest line");
  });

  it("keeps the start of a latest line that alone exceeds the budget", () => {
    const transcript = ["older", "latest message that is far too long"].join(
      "\n"
    );
    expect(truncateTranscriptToCharBudget(transcript, 14)).toBe(
      "latest message"
    );
  });
});
