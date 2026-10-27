import enMessages from "../../../messages/en.json";
import kzMessages from "../../../messages/kz.json";
import ruMessages from "../../../messages/ru.json";

const locales = {
  en: enMessages,
  ru: ruMessages,
  kz: kzMessages,
};

function collectStrings(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) =>
      collectStrings(child, prefix ? `${prefix}.${key}` : key)
    )
  );
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).sort();
}

const localizedFacts = {
  en: {
    example: /example/i,
    noSending: /no messages are sent/i,
    reviewBeforeSending: /approval.*before sending/i,
    draft: /draft/i,
    sameDay: /\btoday\b/i,
    teamControl: /team.*controls/i,
    humanHandoff: /hand.*person/i,
  },
  ru: {
    example: /пример/i,
    noSending: /сообщения не отправляются/i,
    reviewBeforeSending: /перед отправкой.*одобрение/i,
    draft: /черновик/i,
    sameDay: /сегодня/i,
    teamControl: /команда.*решает/i,
    humanHandoff: /передавайте человеку/i,
  },
  kz: {
    example: /мысал/i,
    noSending: /хабарламалар жіберілмейді/i,
    reviewBeforeSending: /жібермес бұрын.*мақұлдауыңыз/i,
    draft: /жоба/i,
    sameDay: /бүгін/i,
    teamControl: /командаңыз басқарады/i,
    humanHandoff: /маманға тапсырыңыз/i,
  },
};

const analyticsFacts = {
  en: {
    conversations: /conversations/i,
    recorded: /recorded/,
    separate: /separate/,
    accepted: /accepted sends/,
    unanswered: /unanswered/,
  },
  ru: {
    conversations: /диалог/i,
    recorded: /зафиксированных/,
    separate: /отдельных/,
    accepted: /принятых отправок/,
    unanswered: /без ответа исключены/,
  },
  kz: {
    conversations: /диалог/i,
    recorded: /тіркеген/,
    separate: /бөлек/i,
    accepted: /қабылданған/,
    unanswered: /Жауапсыз диалогтар/,
  },
};

describe.each(Object.entries(locales))(
  "Landing workflow copy (%s)",
  (locale, messages) => {
    const { hero, featureCards } = messages.LandingDemo;
    const { cards, previews } = featureCards;
    const facts = localizedFacts[locale as keyof typeof localizedFacts];

    it("localizes every monthly comparison label and keeps the report-concept disclosure", () => {
      const expected = collectStrings(
        enMessages.LandingDemo.revenueReport.monthly
      );
      const actual = collectStrings(messages.LandingDemo.revenueReport.monthly);
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const [key, value] of Object.entries(actual)) {
        expect(value.trim()).not.toBe("");
        expect(placeholders(value)).toEqual(placeholders(expected[key]));
      }
      expect(actual["metrics.spend"]).toContain("USD");
      expect(actual["metrics.netRevenue"]).toContain("₸");
      expect(actual.concept).toMatch(/concept|концепт|тұжырымдамасы/i);
    });

    it("keeps every workflow, accessible control and interpolation localized", () => {
      const expected = collectStrings(enMessages.LandingDemo.featureCards);
      const actual = collectStrings(featureCards);

      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const [key, value] of Object.entries(actual)) {
        expect(value.trim()).not.toBe("");
        expect(placeholders(value)).toEqual(placeholders(expected[key]));
      }

      expect(Object.keys(cards).sort()).toEqual([
        "ads",
        "analytics",
        "assets",
        "followUp",
        "interactive",
        "knowledge",
        "meta",
        "smartChat",
        "voice",
      ]);
      for (const card of Object.values(cards)) {
        expect(Object.keys(card).sort()).toEqual([
          "badge",
          "detail",
          "subtitle",
          "title",
        ]);
      }
      expect(placeholders(featureCards.progress)).toEqual(["current", "total"]);
      expect(previews.carousel.previous).not.toBe(previews.carousel.next);
      expect(previews.common.conversationLabel).toContain("WhatsApp");
      expect(placeholders(previews.assets.selected)).toEqual(["placement"]);
      expect(hero.title.trim()).not.toBe("");
      expect(hero.titleAccent.trim()).not.toBe("");
      expect([hero.title, hero.titleAccent, hero.subtitle].join(" ")).toContain(
        "WhatsApp"
      );
    });

    it("uses distinct homeware products with consistent facts and imagery", () => {
      expect(previews.ads.badge).toBe(previews.common.shop);
      expect(previews.ads.cta).toContain("WhatsApp");
      expect(previews.ads.source).toContain("Instagram");
      expect(previews.ads.back).toContain("Instagram");
      expect(Object.keys(featureCards.imageAlts).sort()).toEqual([
        "campaign",
        "catalog",
        "display",
        "instagram",
        "story",
        "textile",
        "vase",
      ]);
      expect(previews.common.price.replace(/\D/g, "")).toBe("18000");
      expect(previews.common.shop).toBe("Forma Home");
      expect(previews.smartChat.answer.replace(/\D/g, "")).toBe("12500");
      expect(previews.knowledge.question).not.toMatch(facts.sameDay);
      expect(previews.knowledge.question).toContain("Lino");
      expect(previews.knowledge.answer).toMatch(/30\s°C/);
      expect(previews.carousel.question).toContain("Arc");
      expect(previews.smartChat.prompt).toContain("Terra");
      expect(cards.smartChat.detail).toContain("Terra");
      expect(featureCards.imageUnavailable).not.toMatch(/lamp|ламп|шам/i);
      expect(previews.ads.lead).toContain("Mora");
      expect(previews.voice.script).toContain("Terra");
      expect(previews.reminders.followUpBody).toMatch(/Sora.*60.*90/);
      expect(previews.ads.answer).toMatch(/30.*40/);
      expect(previews.voice.script).toContain("26");
      expect(
        new Set(Object.values(previews.products).map(product => product.name))
          .size
      ).toBe(4);
      expect(Object.values(collectStrings(featureCards)).join(" ")).not.toMatch(
        /linen|shirt|рубаш|көйлек|Linen & Co/i
      );
    });

    it("identifies examples and preserves team review and human handoff", () => {
      expect(featureCards.example).toMatch(facts.example);
      expect(featureCards.reviewNote).toMatch(facts.example);
      expect(featureCards.reviewNote).toMatch(facts.noSending);
      expect(previews.smartChat.status).toMatch(facts.draft);
      expect(previews.smartChat.approval).toMatch(facts.reviewBeforeSending);
      expect(cards.followUp.detail).toMatch(facts.teamControl);
      expect(cards.knowledge.detail).toMatch(facts.humanHandoff);
    });

    it("does not present invented live metrics or automatic quality protection", () => {
      const copy = Object.values(collectStrings(featureCards)).join("\n");

      expect(copy).not.toMatch(/\b(?:LIVE|CTWA|MCP|ghosted)\b|final_final/i);
      expect(copy).not.toMatch(/\d\s*%|\d\s*\/\s*\d|\bmsg\/s\b/i);
      expect(copy).not.toMatch(
        /auto[ -]?(?:pause|stop)|авто(?:пауза|останов)|автомат(?:ически|ты|ты түрде).*?(?:тоқта|приостан|останав)/i
      );
      expect(previews.meta).not.toHaveProperty("holdHint");
      expect(previews.meta).not.toHaveProperty("pacing");
      expect(previews.meta).not.toHaveProperty("replyRate");
      expect(previews.meta).not.toHaveProperty("accepted");
      expect(previews.voice).not.toHaveProperty("generate");
      expect(previews.voice).not.toHaveProperty("ready");
    });

    it("distinguishes conversation counts, recorded revenue and the separate report sources", () => {
      const facts = analyticsFacts[locale as keyof typeof analyticsFacts];
      const analytics = previews.analytics;
      const report = messages.LandingDemo.revenueReport;
      expect(analytics.trend.title).toMatch(facts.conversations);
      expect(analytics.trend.summary).toMatch(facts.conversations);
      expect(analytics.trend.unit).not.toContain("₸");
      expect(analytics.trend.summary).not.toContain("₸");
      expect(placeholders(analytics.trend.summary)).toEqual([
        "current",
        "previous",
      ]);
      expect(analytics.note).toMatch(facts.recorded);
      expect(analytics.source).not.toBe(analytics.trend.source);
      expect(report.description).toMatch(facts.separate);
      expect(report.details.demoNote).toMatch(facts.separate);
      expect(report.details.campaign.replyRate).toMatch(facts.accepted);
      expect(report.details.response.scope).toMatch(facts.unanswered);
      expect(report.details.ads.source).toContain("USD");
      expect(report).not.toHaveProperty("rows");
      expect(report).not.toHaveProperty("breakdown");
    });

    it("localizes both cookie choices and identifies their tracking purpose", () => {
      const consent = messages.LandingPage.cookieConsent;

      expect(Object.keys(consent).sort()).toEqual([
        "accept",
        "decline",
        "description",
      ]);
      expect(consent.description).toContain("airi.chat");
      expect(consent.description).toMatch(/cookie/i);
      expect(consent.accept.trim()).not.toBe("");
      expect(consent.decline.trim()).not.toBe("");
      expect(consent.accept).not.toBe(consent.decline);
    });
  }
);
