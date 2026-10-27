import { GREETING_START_PATTERNS } from "@/lib/airi/shared/greeting-heuristics";

function isSelfIntroSentence(sentence: string): boolean {
  const t = sentence.trim();
  if (!t) return false;
  if (/^(?:я|это)\s+айри\b/i.test(t) && t.length <= 140) return true;
  if (/^i(?:'m|\s+am)\s+airi\b/i.test(t) && t.length <= 140) return true;
  if (
    /^(?:привет|здравствуйте|добрый день)/i.test(t) &&
    /айри|airi/i.test(t) &&
    t.length <= 240
  ) {
    return true;
  }
  return false;
}

/** After `Здравствуйте!`, remainder may start with `👋 Я Айри.` */
const LEAD_AIRI_TAG_RU = /^(?:я|это)\s+айри(?:\s*👋|\s*🌸)?\s*/iu;
const LEAD_EMOJI_AIRI_CLAUSE =
  /^(?:[👋🌸]\s+)?(?:я|это)\s+айри(?:\s*👋|\s*🌸)?\s*\.\s*/iu;
const LEAD_AIRI_TAG_EN = /^i(?:'m|\s+am)\s+airi(?:\s*👋|\s*🌸)?\s*/iu;

const SENTENCE_END_RE = /[.!?…]+(?=\s|$)/u;
const LEADING_SEPARATORS_RE = /^[\s,!.…:;—–-]+/u;
/** A greeting's name, as in "Здравствуйте, Айгерим!". */
const LONE_VOCATIVE_RE = /^\p{Lu}[\p{L}'’-]*$/u;

/** The first sentence and the untouched text after it. */
function splitFirstSentence(text: string): [string, string] {
  const end = text.match(SENTENCE_END_RE);
  if (!end || end.index === undefined) return [text, ""];
  const cut = end.index + end[0].length;
  return [text.slice(0, cut), text.slice(cut)];
}

/** A whole greeting word: "Приветствуем" is not "Привет". */
function matchGreetingLead(sentence: string): string | null {
  for (const pattern of GREETING_START_PATTERNS) {
    const match = sentence.match(pattern);
    if (!match) continue;
    if (/^\p{L}/u.test(sentence.slice(match[0].length))) continue;
    return match[0];
  }
  return null;
}

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/**
 * Drops one leading greeting or self-intro. A sentence goes only when the
 * greeting is all it says; otherwise just the greeting words go, so a price
 * or answer in the same sentence and the reply's own layout stay intact.
 */
function peelGreetingLead(text: string): string {
  const [sentence, after] = splitFirstSentence(text);
  const trimmed = sentence.trim();
  if (isSelfIntroSentence(trimmed)) return after.trimStart();

  const greeting = matchGreetingLead(trimmed);
  if (!greeting) return text;
  const rest = trimmed
    .slice(greeting.length)
    .replace(LEADING_SEPARATORS_RE, "");
  const remainder = rest.replace(/[\s!.…]+$/u, "");
  if (!remainder || LONE_VOCATIVE_RE.test(remainder)) return after.trimStart();
  return capitalizeFirst(rest) + after;
}

/**
 * When we already greeted today, strip leading greeting / self-intro clauses the model
 * may still emit (prompt compliance is not guaranteed).
 */
export function stripDuplicateGreetingLead(
  text: string,
  alreadyGreeted: boolean
): string {
  if (!alreadyGreeted) return text;
  const original = (text || "").trim();
  if (!original) return text;

  let rest = original;
  for (let peeled = 0; peeled < 6; peeled += 1) {
    const next = peelGreetingLead(rest);
    if (next === rest) break;
    rest = next;
  }

  for (let k = 0; k < 3; k++) {
    const before = rest;
    rest = rest.replace(LEAD_EMOJI_AIRI_CLAUSE, "").trim();
    rest = rest.replace(LEAD_AIRI_TAG_RU, "").trim();
    rest = rest.replace(LEAD_AIRI_TAG_EN, "").trim();
    if (rest === before) break;
  }

  return rest.length > 0 ? rest : original;
}
