import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Since 2026-10-18 a locked workspace stops saving WhatsApp intake, so the
// plan banners must say what is not saved, in every locale.
const INTAKE_COPY = {
  en: {
    trialExpired:
      "New WhatsApp messages and new chats aren't saved until you upgrade.",
    conversationLimit: "New chats aren't saved until you upgrade.",
  },
  ru: {
    trialExpired:
      "Новые сообщения WhatsApp и новые диалоги не сохраняются, пока вы не перейдёте на платный тариф.",
    conversationLimit:
      "Новые диалоги не сохраняются, пока вы не перейдёте на платный тариф.",
  },
  kz: {
    trialExpired:
      "Ақылы тарифке өткенше жаңа WhatsApp хабарламалары мен жаңа диалогтар сақталмайды.",
    conversationLimit: "Ақылы тарифке өткенше жаңа диалогтар сақталмайды.",
  },
} as const;

// A plan-limited history import must say what was not imported and must not
// promise that an upgrade alone restores skipped chats.
const HISTORY_COPY = {
  en: {
    pausedPlanDescription:
      "History import is paused by your plan. History that hasn't been imported yet resumes automatically within about an hour after you upgrade.",
    planSkippedTitle: "Some chats weren't imported",
    planSkippedDescription:
      "Your plan's limits stopped some chats from being imported. Upgrade, then contact support to import them.",
  },
  ru: {
    pausedPlanDescription:
      "Импорт истории приостановлен из-за вашего тарифа. Ещё не импортированная история продолжит загружаться автоматически примерно в течение часа после перехода на платный тариф.",
    planSkippedTitle: "Часть диалогов не импортирована",
    planSkippedDescription:
      "Из-за ограничений тарифа часть диалогов не импортирована. Перейдите на платный тариф и напишите в поддержку, чтобы импортировать их.",
  },
  kz: {
    pausedPlanDescription:
      "Тарихты импорттау тарифіңізге байланысты тоқтатылды. Әлі импортталмаған тарих ақылы тарифке өткеннен кейін шамамен бір сағат ішінде автоматты түрде жүктеле бастайды.",
    planSkippedTitle: "Кейбір диалогтар импортталмады",
    planSkippedDescription:
      "Тариф шектеулеріне байланысты кейбір диалогтар импортталмады. Оларды импорттау үшін ақылы тарифке өтіп, қолдау қызметіне жазыңыз.",
  },
} as const;

function readHistoryCatalog(locale: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "messages", `${locale}.json`),
      "utf8"
    )
  ).WhatsAppHistorySync;
}

// next-intl is ESM-only; run its real formatter outside Jest's CJS loader.
function formatWithNextIntl(
  cases: Array<{
    locale: string;
    message: string;
    values: Record<string, number>;
  }>
): string[] {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { readFileSync } from "node:fs";
        import { createTranslator } from "next-intl";
        const cases = JSON.parse(readFileSync(0, "utf8"));
        process.stdout.write(JSON.stringify(cases.map(({ locale, message, values }) =>
          createTranslator({ locale, messages: { message } })("message", values))));
        `,
      ],
      {
        cwd: path.resolve(__dirname, "../.."),
        input: JSON.stringify(cases),
        encoding: "utf8",
        windowsHide: true,
      }
    )
  );
}

function readCatalog(feature: string, locale: string) {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "messages", feature, locale, "page.json"),
      "utf8"
    )
  );
}

describe("plan gate intake translations", () => {
  it.each(Object.keys(INTAKE_COPY) as Array<keyof typeof INTAKE_COPY>)(
    "states which new %s data is not saved",
    locale => {
      const copy = INTAKE_COPY[locale];
      const banner = readCatalog("conversations", locale).DialogListPanel;
      const dialog = readCatalog("panel", locale).PlanUpgradeDialog;

      expect(banner.planGateTrialExpiredIntake).toBe(copy.trialExpired);
      expect(banner.planGateConversationLimitIntake).toBe(
        copy.conversationLimit
      );
      expect(banner.planGateTrialEnded).toContain("14");
      expect(banner.planGateHiddenConversations).toContain("hiddenCount");
      expect(banner.planGateUpgrade.length).toBeGreaterThan(0);

      expect(dialog.gateConversationLimit).toContain("hiddenCount");
      expect(dialog.gateConversationLimit).toContain(copy.conversationLimit);
      expect(dialog.gateTrialExpired).toContain("14");
      expect(dialog.gateFeatureLimit).toContain("{featureLabel}");
      expect(dialog.gateDefault.length).toBeGreaterThan(0);
      // At the cap nothing is hidden yet, but new chats are already refused.
      expect(dialog.gateConversationLimitReached).toBe(
        `${dialog.gateDefault} ${copy.conversationLimit}`
      );
    }
  );

  it.each([
    ["en", /support/i],
    ["ru", /поддержк/i],
    ["kz", /қолдау/i],
  ] as const)(
    "explains a plan-paused %s history import without sending users to support",
    (locale, supportWord) => {
      const history = JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), "messages", `${locale}.json`),
          "utf8"
        )
      ).WhatsAppHistorySync;
      // The allowance copy asks for support; the plan copy must not.
      expect(history.pausedDescription).toMatch(supportWord);
      expect(history.pausedPlanDescription).toEqual(expect.any(String));
      expect(history.pausedPlanDescription).not.toMatch(supportWord);
    }
  );

  it.each(Object.keys(HISTORY_COPY) as Array<keyof typeof HISTORY_COPY>)(
    "says which %s history the plan kept out without over-promising",
    locale => {
      const history = readHistoryCatalog(locale);
      expect(history.pausedPlanDescription).toBe(
        HISTORY_COPY[locale].pausedPlanDescription
      );
      expect(history.planSkippedTitle).toBe(
        HISTORY_COPY[locale].planSkippedTitle
      );
      expect(history.planSkippedDescription).toBe(
        HISTORY_COPY[locale].planSkippedDescription
      );
      expect(history.planSkippedCount).toContain("{count");
    }
  );

  it("formats the plan counts with plurals in every locale", () => {
    const locales = ["en", "ru", "kz"] as const;
    const counts = [1, 2, 5];
    const cases = locales.flatMap(locale => {
      const banner = readCatalog("conversations", locale).DialogListPanel
        .planGateHiddenConversations;
      const dialog = readCatalog("panel", locale).PlanUpgradeDialog
        .gateConversationLimit;
      const history = readHistoryCatalog(locale).planSkippedCount;
      return counts.flatMap(count => [
        { locale, message: banner, values: { hiddenCount: count } },
        { locale, message: dialog, values: { hiddenCount: count } },
        { locale, message: history, values: { count } },
      ]);
    });
    const formatted = formatWithNextIntl(cases);

    expect(formatted.slice(0, 6)).toEqual([
      "1 conversation is hidden by your plan.",
      "1 conversation is hidden by your current plan. New chats aren't saved until you upgrade.",
      "1 message not imported because of your plan",
      "2 conversations are hidden by your plan.",
      "2 conversations are hidden by your current plan. New chats aren't saved until you upgrade.",
      "2 messages not imported because of your plan",
    ]);
    expect(formatted[9]).toBe("1 диалог скрыт из-за вашего тарифа.");
    expect(formatted[15]).toBe("5 диалогов скрыто из-за вашего тарифа.");
    formatted.forEach((text, index) => {
      expect(text).toContain(String(Object.values(cases[index].values)[0]));
      expect(text).not.toMatch(/[{}#]/);
    });
  });

  it("no longer claims that new inbound data is still being collected", () => {
    for (const file of [
      "src/components/requests/dialog-list-panel.tsx",
      "src/components/billing/plan-upgrade-dialog.tsx",
    ]) {
      expect(
        fs.readFileSync(path.join(process.cwd(), file), "utf8")
      ).not.toContain("still being collected");
    }
  });
});
