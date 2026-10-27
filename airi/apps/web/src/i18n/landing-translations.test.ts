import fs from "node:fs";
import path from "node:path";

type FlatMessages = Record<string, string>;
type JsonObject = Record<string, unknown>;

const smartChatPreviewKeys = [
  "title",
  "status",
  "prompt",
  "answer",
  "recipients",
  "template",
  "approval",
  "audienceLabel",
  "audience",
  "eligibility",
  "templateStatus",
  "showExclusions",
  "hideExclusions",
  "purchased",
  "unsubscribed",
] as const;

const voicePreviewKeys = ["title", "scriptLabel", "script", "note"] as const;

const featureCardIds = [
  "interactive",
  "knowledge",
  "followUp",
  "smartChat",
  "meta",
  "ads",
  "assets",
  "voice",
  "analytics",
] as const;

function countWords(value: string) {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function flattenMessages(value: unknown, prefix = "", out: FlatMessages = {}) {
  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flattenMessages(item, prefix ? `${prefix}.${index}` : String(index), out)
    );
    return out;
  }

  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      flattenMessages(item, prefix ? `${prefix}.${key}` : key, out)
    );
  }

  return out;
}

function readRootMessages(locale: string): JsonObject {
  const filePath = path.join(process.cwd(), "messages", `${locale}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
}

// Headline-level homepage copy: header, hero, FAQ, closing call and footer.
function pickLandingHomepageMessages(messages: JsonObject) {
  const landingDemo = messages.LandingDemo as JsonObject;

  return {
    header: landingDemo.header,
    hero: landingDemo.hero,
    faq: landingDemo.faq,
    cta: landingDemo.cta,
    footer: landingDemo.footer,
  };
}

// Everything the homepage renders, including the example sections.
function pickRenderedLandingMessages(messages: JsonObject) {
  const landingDemo = messages.LandingDemo as JsonObject;

  return {
    ...pickLandingHomepageMessages(messages),
    featureCards: landingDemo.featureCards,
    sources: landingDemo.sources,
    revenueWorkflows: landingDemo.revenueWorkflows,
    revenueReport: landingDemo.revenueReport,
  };
}

describe("landing translations", () => {
  it("does not contain replacement question-mark blocks in root landing namespaces", () => {
    const broken: string[] = [];

    for (const locale of ["ru", "kz"]) {
      const filePath = path.join(process.cwd(), "messages", `${locale}.json`);
      const messages = flattenMessages(
        JSON.parse(fs.readFileSync(filePath, "utf8"))
      );

      for (const [key, value] of Object.entries(messages)) {
        if (key.startsWith("Landing") && /[?]{3,}/.test(value)) {
          broken.push(`${locale}:${key}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it("uses the approved campaign conversation hero without stale buzzwords", () => {
    const english = readRootMessages("en");
    const landingDemo = english.LandingDemo as JsonObject;
    const hero = landingDemo.hero as JsonObject;
    const homepageMessages = flattenMessages(
      pickLandingHomepageMessages(english)
    );
    const homepageText = Object.values(homepageMessages).join(" ");
    const renderedText = Object.values(
      flattenMessages(pickRenderedLandingMessages(english))
    ).join(" ");

    expect(landingDemo.scenariosFlow).toBeUndefined();
    expect(`${hero.title} ${hero.titleAccent}`).toBe(
      "Good campaigns start a conversation."
    );
    expect(hero.subtitle).toBe(
      "Run targeted WhatsApp campaigns, answer customer questions, and track the sales that follow."
    );
    expect(renderedText).toMatch(/\bfollow[- ]?ups?\b/i);
    expect(homepageText).not.toMatch(
      /\ba AI\b|AI-first|campaigns to WhatsApp|do a purchase|Ideal customer profile|clear governance/i
    );
    expect(homepageText).not.toMatch(
      /scenario|airi creative studio|airi studio|support copilot|helpdesk analytics|support analytics|coaching/i
    );
  });

  // Regression: copy for removed homepage sections (stats strip, video, ICP,
  // docs pages) stayed in every locale and shipped to every public page.
  it.each(["en", "ru", "kz"])(
    "%s keeps no copy for removed homepage sections",
    locale => {
      const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;

      for (const removed of [
        "video",
        "icp",
        "carousel",
        "security",
        "bulkCampaigns",
        "stats",
        "docs",
      ]) {
        expect(landingDemo).not.toHaveProperty(removed);
      }
    }
  );

  it("keeps the complete split headline and proposition understandable in every locale", () => {
    const locales = ["en", "ru", "kz"] as const;

    for (const locale of locales) {
      const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;
      const hero = landingDemo.hero as JsonObject;
      expect(hero.title).toEqual(expect.any(String));
      expect(hero.titleAccent).toEqual(expect.any(String));
      expect(String(hero.titleAccent).trim()).not.toBe("");
      const heroText = `${String(hero.title)} ${String(hero.titleAccent)} ${String(hero.subtitle)}`;

      expect(heroText).toMatch(/Airi\.chat|WhatsApp|Instagram|кампан/i);
      expect(heroText).not.toMatch(
        /Airi\s+-\s+is|scenario\s+-\s+engage|LLM|высторить|легенд/i
      );
    }
  });

  it("removes the old scenario showcase namespace from all root locale files", () => {
    const locales = ["en", "ru", "kz"];

    for (const locale of locales) {
      const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;

      expect(landingDemo.scenariosFlow).toBeUndefined();
    }
  });

  it.each(["en", "ru", "kz"] as const)(
    "%s keeps every rendered feature card within the copy budget",
    locale => {
      const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;
      const featureCards = landingDemo.featureCards as JsonObject;
      const cards = featureCards.cards as JsonObject;
      const copyFailures: string[] = [];

      for (const cardId of featureCardIds) {
        const card = cards[cardId] as JsonObject;
        const { title, subtitle } = card;

        if (typeof title !== "string" || title.trim().length === 0) {
          copyFailures.push(`${cardId}.title=missing`);
        } else if (countWords(title) > 6) {
          copyFailures.push(`${cardId}.title=${countWords(title)}`);
        }

        if (typeof subtitle !== "string" || subtitle.trim().length === 0) {
          copyFailures.push(`${cardId}.subtitle=missing`);
        } else if (countWords(subtitle) > 12) {
          copyFailures.push(`${cardId}.subtitle=${countWords(subtitle)}`);
        }
      }

      expect(copyFailures).toEqual([]);
    }
  );

  it("positions the campaign example around audience selection and send review", () => {
    const messages = readRootMessages("en");
    const landingDemo = messages.LandingDemo as JsonObject;
    const featureCards = landingDemo.featureCards as JsonObject;
    const cards = featureCards.cards as JsonObject;
    const smartChat = cards.smartChat as JsonObject;

    expect(smartChat).toMatchObject({
      badge: "Campaigns",
      title: "Campaigns for your audience.",
      subtitle: "Pick the customers and check the text before it goes out.",
    });
    expect(String(smartChat.detail)).toMatch(
      /buyers and unsubscribed contacts are excluded/i
    );
  });

  it("describes WhatsApp eligibility and review without the removed copilot picker", () => {
    const catalog = flattenMessages(readRootMessages("en"));

    expect(
      catalog["LandingDemo.featureCards.previews.smartChat.eligibility"]
    ).toBe("WhatsApp opt-in · no purchase yet");
    expect(
      catalog["LandingDemo.featureCards.previews.smartChat.approval"]
    ).toBe("Your approval comes before sending");
  });

  it.each([
    [
      "ru",
      "Рассылки",
      "Рассылки для вашей аудитории.",
      "Выберите клиентов, проверьте число получателей и\u00a0текст.",
    ],
    [
      "kz",
      "Науқандар",
      "Өз аудиторияңызға хабарламалар.",
      "Клиенттерді таңдап, мәтінді жібермес бұрын тексеріңіз.",
    ],
  ] as const)(
    "%s uses reviewed localized campaign card copy",
    (locale, badge, title, subtitle) => {
      const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;
      const featureCards = landingDemo.featureCards as JsonObject;
      const cards = featureCards.cards as JsonObject;
      expect(cards.smartChat).toMatchObject({ badge, title, subtitle });
    }
  );

  it.each(["ru", "kz"] as const)(
    "%s keeps the campaign preview prose localized",
    locale => {
      const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;
      const featureCards = landingDemo.featureCards as JsonObject;
      const cards = featureCards.cards as JsonObject;
      const previews = featureCards.previews as JsonObject;
      const localizedSmartChatText = Object.values(
        flattenMessages({
          card: cards.smartChat,
          preview: previews.smartChat,
        })
      ).join(" ");

      expect(localizedSmartChatText).not.toMatch(
        /\b(?:Flows|follow-up|Workspace)\b/i
      );
    }
  );

  it.each(["en", "ru", "kz"])(
    "%s includes the rendered campaign messages, audience and exclusion controls",
    locale => {
      const catalog = flattenMessages(readRootMessages(locale));

      for (const key of smartChatPreviewKeys) {
        const value =
          catalog[`LandingDemo.featureCards.previews.smartChat.${key}`];
        expect(value).toEqual(expect.any(String));
        expect(value).not.toHaveLength(0);
      }

      expect(
        catalog["LandingDemo.featureCards.previews.smartChat.prompt"]
      ).toContain("Terra");

      expect(
        catalog[
          "LandingDemo.featureCards.previews.smartChat.picker.metaDescription"
        ]
      ).toBeUndefined();
      expect(
        catalog["LandingDemo.featureCards.previews.smartChat.receipt"]
      ).toBeUndefined();
    }
  );

  it.each(["en", "ru", "kz"] as const)(
    "%s includes the rendered voice script and review note",
    locale => {
      const catalog = flattenMessages(readRootMessages(locale));
      const prefix = "LandingDemo.featureCards.previews.voice";

      for (const key of voicePreviewKeys) {
        const value = catalog[`${prefix}.${key}`];
        expect(value).toEqual(expect.any(String));
        expect(value).not.toHaveLength(0);
      }

      expect(catalog[`${prefix}.script`]).toContain("Terra");
      expect(catalog[`${prefix}.script`]).toContain("26");
      expect(catalog[`${prefix}.generate`]).toBeUndefined();
      expect(catalog[`${prefix}.ready`]).toBeUndefined();
    }
  );

  it.each([
    ["ru", "Голосовые сообщения"],
    ["kz", "Дауыстық хабарламалар"],
  ] as const)("%s uses reviewed localized Voice UI copy", (locale, badge) => {
    const landingDemo = readRootMessages(locale).LandingDemo as JsonObject;
    const featureCards = landingDemo.featureCards as JsonObject;
    const cards = featureCards.cards as JsonObject;
    const previews = featureCards.previews as JsonObject;
    const localizedVoiceText = Object.values(
      flattenMessages({
        card: cards.voice,
        preview: previews.voice,
      })
    ).join(" ");

    expect((cards.voice as JsonObject).badge).toBe(badge);
    expect(localizedVoiceText).not.toMatch(
      /\b(?:Voice|Voiceover|sale|Text to speech|Brand voice|Script|Stability|Speed|Generate|Generating|Ready|History)\b/i
    );
  });
});
