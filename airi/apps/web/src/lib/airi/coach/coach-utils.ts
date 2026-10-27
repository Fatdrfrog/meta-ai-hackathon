import { getLanguageDisplayName } from "@/lib/airi/language-detector";
import { checkProfanity } from "@/lib/profanity";

export { checkProfanity };

export type Tip = {
  title: string;
  suggestion: string;
  type: "tone" | "clarity" | "policy" | "empathy" | "urgency" | "other";
  confidence: number;
  reasoning?: string;
};

export type ConversationContext = {
  stage: "opening" | "middle" | "closing" | "follow-up";
  priority: "low" | "normal" | "high" | "urgent";
  customerSentiment: "positive" | "neutral" | "frustrated" | "angry";
  riskLevel: number; // 0-3
  interactionCount: number;
};

function applyCoachTagsForLanguage(
  lang: "en" | "ru" | "kz" | "uz",
  text: string,
  tags: Set<string>
): void {
  const addIf = (re: RegExp, tag: string) => {
    if (re.test(text)) tags.add(tag);
  };

  if (lang === "en") {
    addIf(/refund|chargeback|compens|money back|reimburs/i, "billing");
    addIf(/bug|error|issue|crash|broken|not working|fail/i, "bug");
    addIf(/delay|late|slow|waiting|hold on|queue/i, "delay");
    addIf(
      /[!]{2,}|\b(terrible|awful|angry|upset|frustrated|furious)\b/i,
      "angry"
    );
    addIf(/cancel|churn|leave|switch provider/i, "churn-risk");
    addIf(/trial|first time|new user|onboarding/i, "first-response");
    addIf(/vip|priority|enterprise|exec/i, "vip");
    addIf(/escalat(e|ion)|manager|supervisor/i, "escalation");
    addIf(/outage|downtime|service down|maintenance/i, "outage");
    addIf(/payment|invoice|credit card|card declined|billing/i, "payment");
    addIf(/ship|delivery|logistics|tracking|courier/i, "shipping");
    addIf(/account|login|password|2fa|mfa|access/i, "account");
    addIf(/privacy|gdpr|data|security|breach/i, "privacy");
    addIf(/urgent|asap|immediately|deadline/i, "urgency");
    addIf(/price|pricing|discount|quote|cost/i, "pricing");
    addIf(/feature|request|roadmap|suggest/i, "feature-request");
    addIf(/bug\s*fix|patch|hotfix/i, "engineering");
  } else if (lang === "ru") {
    addIf(/возврат|чарджбек|компенсац|деньг|перевод|оплат|списан/i, "billing");
    addIf(/баг|ошибк|проблем|сломал|не работ|сбой|глюч/i, "bug");
    addIf(/задержк|поздно|медлен|очеред|ждать/i, "delay");
    addIf(
      /[!]{2,}|\b(ужас|кошмар|злюсь|недоволен|расстроен|возмут)\b/i,
      "angry"
    );
    addIf(/отмен|уйду|перейду к другому|сменю/i, "churn-risk");
    addIf(/триал|впервые|новый пользователь|онбординг/i, "first-response");
    addIf(/vip|приоритет|enterprise|директор|руковод/i, "vip");
    addIf(/эскалац|менеджер|supervisor/i, "escalation");
    addIf(/авария|простой|недоступн|обслуживан/i, "outage");
    addIf(/оплат|счет|карта|платеж|списан/i, "payment");
    addIf(/доставк|трек|курьер|логистик/i, "shipping");
    addIf(/аккаунт|вход|парол|2fa|mfa|доступ/i, "account");
    addIf(/приватност|gdpr|данн|безопасност|утечк/i, "privacy");
    addIf(/срочно|asap|немедленно|дедлайн/i, "urgency");
    addIf(/цена|стоимост|скидк|квот|прайс/i, "pricing");
    addIf(/фич|функц|запрос|добавь|предлож/i, "feature-request");
    addIf(/исправлени|патч|горячая правк/i, "engineering");
  } else if (lang === "kz") {
    addIf(/қайтару|өтемақы|ақшаны қайтару/i, "billing");
    addIf(/қате|ақау|мәселе|бұзылды|істемейді|жұмыс істемейді/i, "bug");
    addIf(/кешігу|баяу|күту|кезек/i, "delay");
    addIf(/[!]{2,}|\b(сұмдық|жаман|ашулы|ызалы|ренжідім)\b/i, "angry");
    addIf(/бас тарту|кету|ауыстыру/i, "churn-risk");
    addIf(/сынақ|бірінші рет|жаңа пайдаланушы|онбординг/i, "first-response");
    addIf(/vip|басымдық|enterprise|басшы/i, "vip");
    addIf(/эскалация|менеджер|басшы/i, "escalation");
    addIf(/апат|тоқтап қалу|қолжетімсіз|техникалық қызмет/i, "outage");
    addIf(/төлем|шот|карта|есептен шығару/i, "payment");
    addIf(/жеткізу|логистика|трекинг|курьер/i, "shipping");
    addIf(/аккаунт|кіру|құпия сөз|пароль|2fa|mfa|қол жеткізу/i, "account");
    addIf(/құпиялылық|gdpr|деректер|қауіпсіздік/i, "privacy");
    addIf(/шұғыл|тез арада|дереу/i, "urgency");
    addIf(/баға|құны|жеңілдік|ұсыныс/i, "pricing");
    addIf(/функция|мүмкіндік|сұраныс|ұсыныс|қосу/i, "feature-request");
    addIf(/түзету|патч/i, "engineering");
  } else if (lang === "uz") {
    addIf(/qaytarish|kompensatsiya|pulni qaytarish/i, "billing");
    addIf(/xato|muammo|nosozlik|buzildi|ishlamayapti/i, "bug");
    addIf(/kechikish|sekin|kutish|navbat/i, "delay");
    addIf(
      /[!]{2,}|\b(daxshat|yomon|jahlim|g'azablandim|xafa bo'ldim)\b/i,
      "angry"
    );
    addIf(/bekor qilish|ketish|boshqasiga o'tish/i, "churn-risk");
    addIf(
      /sinov|birinchi marta|yangi foydalanuvchi|onbording/i,
      "first-response"
    );
    addIf(/vip|ustuvor|enterprise|rahbar/i, "vip");
    addIf(/eskalatsiya|menejer|rahbar/i, "escalation");
    addIf(/avariya|uzilish|mavjud emas|texnik xizmat/i, "outage");
    addIf(/to'lov|hisob-faktura|karta|yechib olish/i, "payment");
    addIf(/yetkazib berish|logistika|kuzatuv|kurer/i, "shipping");
    addIf(/akkaunt|kirish|parol|2fa|mfa|ruxsat/i, "account");
    addIf(/maxfiylik|gdpr|ma'lumotlar|xavfsizlik/i, "privacy");
    addIf(/shoshilinch|zudlik bilan|darhol/i, "urgency");
    addIf(/narx|qiymat|chegirma|taklif/i, "pricing");
    addIf(/funksiya|so'rov|taklif|qo'shish/i, "feature-request");
    addIf(/tuzatish|patch/i, "engineering");
  }
}

export function computeCoachTags(text: string): string[] {
  const tags = new Set<string>();
  applyCoachTagsForLanguage("en", text || "", tags);
  applyCoachTagsForLanguage("ru", text || "", tags);
  applyCoachTagsForLanguage("kz", text || "", tags);
  applyCoachTagsForLanguage("uz", text || "", tags);
  return Array.from(tags);
}

/**
 * Detect customer sentiment from text
 */
export function detectSentiment(
  text: string
): ConversationContext["customerSentiment"] {
  const t = text.toLowerCase();

  // Angry indicators (strongest signal)
  const angry =
    /terrible|awful|worst|hate|angry|furious|ridiculous|unacceptable|disgust|pathetic|ужас|кошмар|злюсь|недоволен|возмут|daxshat|jahlim|g'azablandim|сұмдық|ашулы|ызалы/i;
  if (angry.test(t)) return "angry";

  // Frustrated indicators
  const frustrated =
    /frustrat|annoyed|disappoint|upset|unhappy|dissatisf|concern|worry|расстроен|недовол|ренжідім|g'amgin|xafa/i;
  if (frustrated.test(t)) return "frustrated";

  // Positive indicators
  const positive =
    /thank|appreciate|great|excellent|perfect|love|happy|pleased|helpful|благодар|спасибо|отличн|хорош|рақмет|rahmat|керемет|zo'r/i;
  if (positive.test(t)) return "positive";

  return "neutral";
}

/**
 * Analyze conversation context for better coaching
 */
export function analyzeConversationContext(
  messages: Array<{ text: string; direction: string; date?: Date }>
): ConversationContext {
  const messageCount = messages.length;
  const customerMessages = messages.filter(m => m.direction === "inbound");
  const recentCustomerText = customerMessages
    .slice(-3)
    .map(m => m.text || "")
    .join(" ");

  // Determine stage
  let stage: ConversationContext["stage"] = "middle";
  if (messageCount <= 2) {
    stage = "opening";
  } else if (messageCount > 10) {
    stage = "closing";
  }

  // Analyze sentiment
  const sentiment = detectSentiment(recentCustomerText);

  // Calculate priority based on keywords + sentiment
  const urgentKeywords =
    /urgent|asap|immediately|critical|emergency|now|asap|срочн|немедленн|дедлайн|шұғыл|тез арада|shoshilinch|zudlik/i;
  const hasUrgent = urgentKeywords.test(recentCustomerText);

  let priority: ConversationContext["priority"] = "normal";
  if (hasUrgent || sentiment === "angry") {
    priority = "urgent";
  } else if (sentiment === "frustrated") {
    priority = "high";
  }

  // Risk detection (profanity, escalation requests)
  const { maxSeverity } = checkProfanity("", recentCustomerText);
  const hasEscalation =
    /escalat|manager|supervisor|complaint|refund|lawsuit|legal|эскалац|менеджер|жалоб|возврат|эскалация|басшы|shikoyat|sud/i.test(
      recentCustomerText
    );
  const riskLevel = Math.max(maxSeverity, hasEscalation ? 2 : 0);

  return {
    stage,
    priority,
    customerSentiment: sentiment,
    riskLevel,
    interactionCount: messageCount,
  };
}

/**
 * Check if text has actionable next steps
 */
function hasActionableNext(text: string, lang: string): boolean {
  const patterns: Record<string, RegExp> = {
    en: /\b(will|would|can|should|please|next|follow|check|update|let you know|get back)\b/i,
    ru: /\b(буду|могу|должен|проверю|обновлю|сообщу|следующ|дальше|свяжусь)\b/i,
    kz: /\b(боламын|тексеремін|жаңартамын|хабарлаймын|келесі|байланыс)\b/i,
    uz: /\b(bo'laman|tekshiraman|yangilayaman|xabar beraman|keyingi|aloqa)\b/i,
  };
  return patterns[lang]?.test(text) || false;
}

export function buildHeuristicTips(
  text: string,
  lang: string,
  context?: ConversationContext,
  agentDraftLang?: string
): Tip[] {
  const tips: Tip[] = [];
  const t = (text || "").trim();

  // Language-specific tip messages (expanded)
  const tipMessages = {
    en: {
      languageMismatch: {
        title: "Language mismatch",
        suggestion:
          "Customer is writing in a different language. Reply in their language for better understanding.",
      },
      escalationRisk: {
        title: "Escalation risk",
        suggestion: "Acknowledge the concern and provide specific next steps.",
      },
      empathy: {
        title: "Add empathy",
        suggestion:
          'Start with "I understand how frustrating this must be" or similar.',
      },
      properIntroduction: {
        title: "Professional greeting",
        suggestion: "Add a brief introduction to set a helpful tone.",
      },
      nextSteps: {
        title: "Clarify next steps",
        suggestion: "Tell the customer exactly what will happen next and when.",
      },
      beSpecific: {
        title: "Be specific",
        suggestion: "Add more context so the customer knows what to expect.",
      },
      endPunctuation: {
        title: "End with punctuation",
        suggestion: "Finish your sentence with a period for professionalism.",
      },
    },
    ru: {
      languageMismatch: {
        title: "Несовпадение языка",
        suggestion:
          "Клиент пишет на другом языке. Ответьте на его языке для лучшего понимания.",
      },
      escalationRisk: {
        title: "Риск эскалации",
        suggestion: "Признайте проблему и укажите конкретные следующие шаги.",
      },
      empathy: {
        title: "Добавьте эмпатию",
        suggestion: 'Начните с "Я понимаю, как это расстраивает" или похожего.',
      },
      properIntroduction: {
        title: "Профессиональное приветствие",
        suggestion:
          "Добавьте краткое приветствие для задания позитивного тона.",
      },
      nextSteps: {
        title: "Уточните следующие шаги",
        suggestion: "Скажите клиенту, что именно произойдёт дальше и когда.",
      },
      beSpecific: {
        title: "Будьте конкретнее",
        suggestion:
          "Добавьте больше контекста, чтобы клиент знал, чего ожидать.",
      },
      endPunctuation: {
        title: "Завершите предложение",
        suggestion: "Закончите предложение точкой для профессионализма.",
      },
    },
    kz: {
      languageMismatch: {
        title: "Тіл сәйкессіздігі",
        suggestion:
          "Клиент басқа тілде жазады. Жақсы түсіну үшін оның тілінде жауап беріңіз.",
      },
      escalationRisk: {
        title: "Эскалация қаупі",
        suggestion: "Мәселені мойындап, нақты келесі қадамдарды көрсетіңіз.",
      },
      empathy: {
        title: "Эмпатия қосыңыз",
        suggestion: '"Мұның қаншалықты қиын екенін түсінемін" деп бастаңыз.',
      },
      properIntroduction: {
        title: "Кәсіби сәлемдесу",
        suggestion: "Жағымды тон үшін қысқаша сәлемдесу қосыңыз.",
      },
      nextSteps: {
        title: "Келесі қадамдарды нақтылаңыз",
        suggestion: "Клиентке нақты не болатынын және қашан болатынын айтыңыз.",
      },
      beSpecific: {
        title: "Нақты болыңыз",
        suggestion: "Клиент не күтетінін білу үшін контекст қосыңыз.",
      },
      endPunctuation: {
        title: "Сөйлемді аяқтаңыз",
        suggestion: "Кәсібилік үшін сөйлемді нүктемен аяқтаңыз.",
      },
    },
    uz: {
      languageMismatch: {
        title: "Til mos kelmaydi",
        suggestion:
          "Mijoz boshqa tilda yozmoqda. Yaxshiroq tushunish uchun uning tilida javob bering.",
      },
      escalationRisk: {
        title: "Eskalatsiya xavfi",
        suggestion: "Muammoni tan oling va aniq keyingi qadamlarni ko'rsating.",
      },
      empathy: {
        title: "Empatiya qo'shing",
        suggestion: '"Bu qanchalik qiyin ekanini tushunaman" deb boshlang.',
      },
      properIntroduction: {
        title: "Professional salom",
        suggestion: "Ijobiy ohang yaratish uchun qisqacha salom qo'shing.",
      },
      nextSteps: {
        title: "Keyingi qadamlarni aniqlang",
        suggestion: "Mijozga aniq nima bo'lishini va qachon bo'lishini ayting.",
      },
      beSpecific: {
        title: "Aniq bo'ling",
        suggestion: "Mijoz nima kutishini bilishi uchun kontekst qo'shing.",
      },
      endPunctuation: {
        title: "Jumlani tugating",
        suggestion: "Professionallik uchun jumlani nuqta bilan tugating.",
      },
    },
  };

  const messages =
    (tipMessages as Record<string, typeof tipMessages.en>)[lang] ||
    tipMessages.en;

  // PRIORITY 0: Language mismatch (HIGHEST - agent replying in wrong language)
  if (agentDraftLang && agentDraftLang !== lang && t.length > 5) {
    tips.push({
      title: messages.languageMismatch.title,
      suggestion: `${messages.languageMismatch.suggestion} (Customer: ${getLanguageDisplayName(lang)}, Your draft: ${getLanguageDisplayName(agentDraftLang)})`,
      type: "clarity",
      confidence: 0.95,
      reasoning: `Language mismatch detected. Customer writes in ${getLanguageDisplayName(lang)}, but you're replying in ${getLanguageDisplayName(agentDraftLang)}. Always reply in the customer's language.`,
    });
  }

  // PRIORITY 1: High-risk situations (escalation, angry customer)
  if (context && context.riskLevel >= 2) {
    tips.push({
      title: messages.escalationRisk.title,
      suggestion: messages.escalationRisk.suggestion,
      type: "policy",
      confidence: 0.9,
      reasoning:
        "Customer shows signs of frustration or escalation intent. De-escalate first.",
    });
  }

  // PRIORITY 2: Missing empathy in negative situations
  const empathyRegex: Record<string, RegExp> = {
    en: /\b(sorry|apologize|apologies|understand|appreciate your|i see|hear you)\b/i,
    ru: /\b(извините|простите|понимаю|сожалею|благодарю|вижу)\b/i,
    kz: /\b(кешіріңіз|ғафу етіңіз|түсінемін|өкінемін|рақмет)\b/i,
    uz: /\b(uzr|kechirasiz|tushunaman|afsusdaman|rahmat)\b/i,
  };

  if (
    context &&
    (context.customerSentiment === "frustrated" ||
      context.customerSentiment === "angry")
  ) {
    // Only check if we have regex for this language
    if (empathyRegex[lang] && !empathyRegex[lang].test(t)) {
      tips.push({
        title: messages.empathy.title,
        suggestion: `${messages.empathy.suggestion}`,
        type: "empathy",
        confidence: 0.85,
        reasoning: `Customer sentiment is ${context.customerSentiment}. Empathy helps de-escalate.`,
      });
    }
  }

  // PRIORITY 3: Opening stage - proper introduction
  if (context && context.stage === "opening" && t.length > 0 && t.length < 20) {
    tips.push({
      title: messages.properIntroduction.title,
      suggestion: messages.properIntroduction.suggestion,
      type: "tone",
      confidence: 0.75,
      reasoning:
        "First interaction - set professional and helpful tone from the start.",
    });
  }

  // PRIORITY 4: Missing clear next steps
  if (t.length > 10 && !hasActionableNext(t, lang)) {
    tips.push({
      title: messages.nextSteps.title,
      suggestion: messages.nextSteps.suggestion,
      type: "clarity",
      confidence: 0.7,
      reasoning:
        "Response lacks clear action plan. Customers appreciate knowing what happens next.",
    });
  }

  // PRIORITY 5: Too short - needs more context
  if (t.length > 0 && t.length < 15 && (!context || tips.length === 0)) {
    tips.push({
      title: messages.beSpecific.title,
      suggestion: messages.beSpecific.suggestion,
      type: "clarity",
      confidence: 0.6,
      reasoning:
        "Very short replies can feel dismissive. Add more helpful detail.",
    });
  }

  // PRIORITY 6: Style issues (only if no higher priority tips)
  if (t.length > 30 && !/[.!?]$/.test(t) && tips.length < 2) {
    tips.push({
      title: messages.endPunctuation.title,
      suggestion: messages.endPunctuation.suggestion,
      type: "tone",
      confidence: 0.5,
      reasoning: "Professional communication standard.",
    });
  }

  // Return top 3 by confidence
  return tips.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

export function redactPII(text: string): {
  redacted: string;
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  let redacted = text || "";
  let idx = 0;
  // **IMPROVEMENT**: Slightly more robust email regex
  redacted = redacted.replace(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/g, m => {
    const k = `__EMAIL_${idx++}__`;
    map.set(k, m);
    return k;
  });
  redacted = redacted.replace(/\+?\d[\d\s()-]{6,}\d/g, m => {
    const k = `__PHONE_${idx++}__`;
    map.set(k, m);
    return k;
  });
  return { redacted, map };
}

export function unredact(text: string, map: Map<string, string>): string {
  let out = text || "";
  for (const [k, v] of map.entries()) {
    out = out.replace(new RegExp(k, "g"), v);
  }
  return out;
}
