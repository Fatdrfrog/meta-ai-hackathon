import { finalizeReplyText } from "@/lib/airi/reply/generation/reply-finalize";

export type SafeIntentReplyType =
  | "greeting"
  | "thanks"
  | "farewell"
  | "acknowledgment"
  | "chit_chat"
  | "data_sharing"
  | "impatience"
  | "presence_check"
  | "meta_question";

export type SafeIntentReplyParams = {
  type: SafeIntentReplyType;
  language: string;
  alreadyGreetedToday?: boolean;
};

type SafeReplyLocale = "en" | "ru" | "kk" | "uz";
type TemplateValue = string | ((greeted: boolean) => string);

function resolveSafeReplyLocale(language: string): SafeReplyLocale {
  const code = String(language || "")
    .trim()
    .toLowerCase();
  if (code === "ru" || code.startsWith("ru-")) return "ru";
  if (code === "kk" || code === "kz" || code.startsWith("kk-")) return "kk";
  if (code === "uz" || code.startsWith("uz-")) return "uz";
  return "en";
}

const SAFE_REPLY_TEMPLATES: Record<
  SafeReplyLocale,
  Partial<Record<SafeIntentReplyType, TemplateValue>>
> = {
  en: {
    greeting: (greeted: boolean) =>
      greeted ? "I am here and ready to help." : "Hi, how can I help?",
    thanks: "You are welcome.",
    farewell: "Thank you, I am here if you need anything else.",
    chit_chat: "I am here to help whenever you are ready.",
    data_sharing: "Noted, thank you.",
    impatience: "Thank you for waiting. What can I help with now?",
  },
  ru: {
    greeting: (greeted: boolean) =>
      greeted ? "Я на связи и готов помочь." : "Здравствуйте, чем могу помочь?",
    thanks: "Пожалуйста.",
    farewell: "Спасибо, я на связи, если понадобится помощь.",
    chit_chat: "Я на связи и помогу, когда будете готовы.",
    data_sharing: "Зафиксировал, спасибо.",
    impatience: "Спасибо за ожидание. Чем помочь сейчас?",
  },
  kk: {
    greeting: (greeted: boolean) =>
      greeted
        ? "Мен байланыстамын, көмектесуге дайынмын."
        : "Сәлеметсіз бе, қалай көмектесе аламын?",
    thanks: "Оқасы жоқ.",
    farewell: "Рақмет, тағы көмек керек болса, мен байланыстамын.",
    chit_chat: "Дайын болғанда көмектесемін.",
    data_sharing: "Белгілеп алдым, рақмет.",
    impatience: "Күткеніңізге рақмет. Қазір немен көмектесейін?",
  },
  uz: {
    greeting: (greeted: boolean) =>
      greeted
        ? "Men aloqadaman va yordam berishga tayyorman."
        : "Assalomu alaykum, qanday yordam bera olaman?",
    thanks: "Marhamat.",
    farewell: "Rahmat, yana yordam kerak bo'lsa, men aloqadaman.",
    chit_chat: "Tayyor bo'lganingizda yordam beraman.",
    data_sharing: "Qayd qildim, rahmat.",
    impatience: "Kutganingiz uchun rahmat. Hozir nima bilan yordam beray?",
  },
};

function resolveTemplate(params: SafeIntentReplyParams): TemplateValue | null {
  const locale = resolveSafeReplyLocale(params.language);
  const localeTemplates =
    SAFE_REPLY_TEMPLATES[locale] || SAFE_REPLY_TEMPLATES.en;
  const defaultTemplates = SAFE_REPLY_TEMPLATES.en;

  const directTemplate =
    localeTemplates[params.type] || defaultTemplates[params.type];
  if (directTemplate) return directTemplate;

  if (params.type === "presence_check" || params.type === "meta_question") {
    return localeTemplates.greeting || defaultTemplates.greeting || null;
  }

  return null;
}

export function generateSafeIntentReply(params: SafeIntentReplyParams): string {
  const template = resolveTemplate(params);
  if (!template) return "";

  const raw =
    typeof template === "function"
      ? template(Boolean(params.alreadyGreetedToday))
      : template;

  return finalizeReplyText(raw, {
    alreadyGreetedToday: params.alreadyGreetedToday,
  });
}
