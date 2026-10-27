/**
 * Heading-level FAQ detection for chunking.
 *
 * A section whose heading matches one of these patterns is treated as a FAQ
 * block and sub-split into one chunk per Q/A pair by `splitFaqBody` below.
 * Patterns are deliberately conservative (word-boundary, case-insensitive, unicode)
 * to avoid false positives on phrases like "more questions" or "question time".
 */

const FAQ_HEADING_PATTERNS: RegExp[] = [
  // English
  /\bfaq\b/i,
  /\bf\.?a\.?q\.?\b/i,
  /\bfrequently\s+asked\s+questions?\b/i,
  /\bcommon\s+questions?\b/i,
  // Russian — "Часто задаваемые вопросы", "ЧаВо", "Вопросы и ответы"
  /часто\s+задаваем(?:ые|ых|ыми)\s+вопрос/iu,
  /\bча?во\b/iu,
  /\bвопрос(?:ы|ов)?\s+и\s+ответ/iu,
  // Kazakh — "Жиі қойылатын сұрақтар"
  /жи[іi]\s+қойылатын\s+сұрақ/iu,
  // Uzbek — "Tez-tez beriladigan savollar"
  /\btez[-\s]tez\s+beriladigan\s+savollar\b/iu,
  // Spanish — "Preguntas frecuentes"
  /\bpreguntas\s+frecuentes\b/iu,
  // Portuguese — "Perguntas frequentes"
  /\bperguntas\s+frequentes\b/iu,
  // French — "Questions fréquentes" / "Foire aux questions"
  /\bquestions\s+fr[ée]quentes\b/iu,
  /\bfoire\s+aux\s+questions\b/iu,
  // German — "Häufig gestellte Fragen"
  /\bh[aä]ufig\s+gestellte\s+fragen\b/iu,
  // Turkish — "Sık sorulan sorular"
  /\bs[ıi]k\s+sorulan\s+sorular\b/iu,
];

export function isFaqHeading(heading: string | null | undefined): boolean {
  if (!heading) return false;
  const normalized = heading.trim();
  if (!normalized) return false;
  return FAQ_HEADING_PATTERNS.some(re => re.test(normalized));
}
