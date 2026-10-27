import enList from "@/lib/profanity-lists/en.json";
import kzList from "@/lib/profanity-lists/kz.json";
import ruList from "@/lib/profanity-lists/ru.json";
import uzList from "@/lib/profanity-lists/uz.json";

function escapeRegexExceptStar(s: string) {
  return s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
}

function wrapUnicodeWordBoundaries(pattern: string) {
  return `(?:^|[^\\p{L}\\p{N}_])(?:${pattern})(?=$|[^\\p{L}\\p{N}_])`;
}

type InternalStarMode = "repeated-letter" | "word-span";

// English internal stars tolerate repeated spelling ("sh*i*t"). Kazakh list
// entries use the same marker for a variable word span ("жоғ* кет"). A
// trailing star remains an inflection stem in every language.
function expandStarSyntax(pattern: string, internalStarMode: InternalStarMode) {
  const hasTrailingStem = pattern.endsWith("*");
  const spellingPattern = hasTrailingStem ? pattern.slice(0, -1) : pattern;
  const expandedInternalStars = spellingPattern.replace(
    /\*/g,
    internalStarMode === "word-span" ? "[\\p{L}\\p{N}_]*" : "+"
  );
  return hasTrailingStem
    ? `${expandedInternalStars}[\\p{L}\\p{N}_]*`
    : expandedInternalStars;
}

function toRegexPattern(s: string, internalStarMode: InternalStarMode) {
  const trimmed = (s || "").trim();
  if (!trimmed) return null;
  const escaped = expandStarSyntax(
    escapeRegexExceptStar(trimmed).replace(/['’ʻʼ]/g, "['’ʻʼ]"),
    internalStarMode
  )
    .replace(/\s+/g, " ")
    .replace(/ /g, "\\s+");
  const isWordPattern = /^[\p{L}\p{N}*]+(?:[\s\-'’ʻʼ][\p{L}\p{N}*]+)*$/u.test(
    trimmed
  );
  const body = isWordPattern ? wrapUnicodeWordBoundaries(escaped) : escaped;
  try {
    return new RegExp(body, "iu");
  } catch {
    return null;
  }
}

type Pattern = { pattern: string; re: RegExp; universalScanSafe: boolean };
type ProfanityLanguage = "en" | "ru" | "kz" | "uz";

// These Uzbek terms are also common standalone words or abbreviations in
// multilingual copy. Less ambiguous short terms remain universal-scan safe;
// Unicode boundaries keep them from matching inside longer words.
const UNIVERSAL_SCAN_EXCLUSIONS = new Set([
  "uz:am",
  "uz:ami",
  "uz:mol",
  "uz:ram",
]);

function isUniversalScanSafe(
  language: ProfanityLanguage,
  pattern: string
): boolean {
  return !UNIVERSAL_SCAN_EXCLUSIONS.has(`${language}:${pattern}`);
}

function compilePatterns(
  language: ProfanityLanguage,
  list: string[]
): Pattern[] {
  const out: Pattern[] = [];
  const internalStarMode = language === "kz" ? "word-span" : "repeated-letter";
  for (const p of list || []) {
    const re = toRegexPattern(p, internalStarMode);
    if (re) {
      out.push({
        pattern: p,
        re,
        universalScanSafe: isUniversalScanSafe(language, p),
      });
    }
  }
  return out;
}

const patternLists = {
  en: enList,
  ru: ruList,
  kz: kzList,
  uz: uzList,
};

// Importing the reply UI must not compile every language's Unicode expressions.
// Keep the synchronous check, compiling each dictionary once when it is used.
const patternMap: Partial<Record<ProfanityLanguage, Pattern[]>> = {};

export function checkProfanity(
  lang: string,
  text: string
): { toxic: boolean; maxSeverity: number; categories: string[] } {
  const t = text || "";
  if (!t) return { toxic: false, maxSeverity: 0, categories: [] };
  let maxSeverity = 0;
  const matched = new Set<string>();
  const languagesToCheck: ProfanityLanguage[] = lang
    ? (Object.keys(patternLists) as ProfanityLanguage[]).includes(
        lang as ProfanityLanguage
      )
      ? [lang as ProfanityLanguage]
      : []
    : (Object.keys(patternLists) as ProfanityLanguage[]);

  for (const language of languagesToCheck) {
    const patterns = (patternMap[language] ??= compilePatterns(
      language,
      patternLists[language]
    ));
    for (const { pattern, re, universalScanSafe } of patterns) {
      if (!lang && !universalScanSafe) continue;
      if (re.test(t)) {
        matched.add(pattern);
        maxSeverity = 1;
      }
    }
  }

  const toxic = matched.size > 0;
  return { toxic, maxSeverity, categories: Array.from(matched).slice(0, 20) };
}
