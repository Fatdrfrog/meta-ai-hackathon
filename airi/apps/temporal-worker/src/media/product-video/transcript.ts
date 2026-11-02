// The owner's narration as Muse Spark reads it: one sentence per line, each
// with its start time, like "[12.3] Кукла Лол, бес мың теңге." A long
// sentence gets time marks inside it as well, at most MARK_EVERY_SECONDS
// apart: an edited promo shows several products during one sentence, and
// Muse needs to know which words were said over which of them. Sentences end
// at the full stops, question and exclamation marks of every script, and in
// a narration in an unspaced script without any, like Thai, at pauses.
//
// Muse Spark missed spoken prices in most test runs and Muse Voice Transcribe
// has no Kazakh or Russian, so ElevenLabs Scribe, which covers those and many
// other languages, listens and Meta's models take it from there as text.

type ScribeWord = {
  text: string;
  type: string;
  start: number;
  /** When the word ends, if Scribe says. */
  end?: number;
};

function scribeWords(payload: unknown): ScribeWord[] {
  if (!payload || typeof payload !== "object") return [];
  const words = (payload as { words?: unknown }).words;
  if (!Array.isArray(words)) return [];
  return words.flatMap((word): ScribeWord[] => {
    if (!word || typeof word !== "object") return [];
    const { text, type, start, end } = word as Record<string, unknown>;
    return typeof text === "string" &&
      typeof type === "string" &&
      typeof start === "number" &&
      Number.isFinite(start)
      ? [
          {
            text,
            type,
            start,
            ...(typeof end === "number" && Number.isFinite(end) && end >= start
              ? { end }
              : {}),
          },
        ]
      : [];
  });
}

// A word that ends a sentence, in any script: . ! ? 。！？ । ۔ ؟ ։ ። ။ ។ and
// the rest of Unicode's sentence terminals (not "…"), and a Greek question
// mark, which is ";" or U+037E after a Greek letter.
const SENTENCE_END = /(?:\p{Sentence_Terminal}|\p{Script=Greek}[;\u037e])$/u;
// Marks Scribe glued to the start of the next word instead ("。LOL", before
// a Latin word in Japanese). Only before a letter, so ".99" isn't one.
const GLUED_END = /^\p{Sentence_Terminal}+(?=\p{L})/u;
// In a narration without a single mark (Scribe writes none for Thai), a
// pause ends a sentence: one this long anywhere, or a shorter one where
// Scribe wrote a space, which in Thai it does only between clauses.
const PAUSE_SECONDS = 0.8;
const SPACED_PAUSE_SECONDS = 0.5;
// Only in an unspaced script, though: one with fewer spacing tokens than a
// quarter of its words (Scribe gave a Thai narration 2 for 73 words). Where a
// space follows every word, a narration without marks (an unpunctuated Kazakh
// reply) stays one sentence with time marks inside: a pause there may fall
// inside a price ("бес … мың теңге"), which a line break would cut in two.
const MAX_SPACING_PER_WORD = 1 / 4;

// Sentences this long get marks inside, at most this far apart.
const LONG_SENTENCE_SECONDS = 3;
const MARK_EVERY_SECONDS = 1.5;

/**
 * One sentence as a line: its start time, and marks inside when it runs long.
 * A mark after a space stands apart like a word ("бес [2.8] мың"); anywhere
 * else, as inside a word of an unspaced script, it is written in with no
 * space ("五十[3.7]元"), so a quote that drops just the mark reads as said.
 */
function sentenceLine(words: ScribeWord[]): string {
  const spoken = words.filter((word) => word.type === "word");
  const first = spoken[0]?.start ?? 0;
  const long =
    spoken.length > 0 && spoken.at(-1)!.start - first >= LONG_SENTENCE_SECONDS;
  let text = "";
  let marked = first;
  let previous: ScribeWord | undefined;
  for (const word of words) {
    if (
      long &&
      word.type === "word" &&
      word.start - marked >= MARK_EVERY_SECONDS
    ) {
      const gap = previous?.type === "spacing" ? " " : "";
      text += `[${word.start.toFixed(1)}]${gap}`;
      marked = word.start;
    }
    text += word.text;
    previous = word;
  }
  return `[${first.toFixed(1)}] ${text.trim()}`;
}

/** Lines from a Scribe response with word timestamps; its plain text when it has none. */
export function scribeTranscriptLines(payload: unknown): string {
  const words = scribeWords(payload);
  if (words.length === 0) {
    const text =
      payload && typeof payload === "object"
        ? (payload as { text?: unknown }).text
        : null;
    return typeof text === "string" ? text.trim() : "";
  }
  const unmarked = !words.some(
    (word) =>
      word.type === "word" &&
      (SENTENCE_END.test(word.text) || GLUED_END.test(word.text)),
  );
  const count = (type: string) =>
    words.filter((word) => word.type === type).length;
  const pausesEnd =
    unmarked && count("spacing") < count("word") * MAX_SPACING_PER_WORD;
  const lines: string[] = [];
  let sentence: ScribeWord[] = [];
  const endSentence = () => {
    lines.push(sentenceLine(sentence));
    sentence = [];
  };
  // When the last word ended, if Scribe said, and whether a space came since.
  let lastEnd: number | null = null;
  let spaced = false;
  for (const token of words) {
    if (token.type === "audio_event") continue;
    let word = token;
    const glued =
      word.type === "word" ? GLUED_END.exec(word.text)?.[0] : undefined;
    if (glued) {
      // The marks end the sentence before the word, if one is open. Scribe
      // times such a token from the marks, which can be seconds before the
      // word, so the word starts when the token ends.
      if (sentence.some((part) => part.type === "word")) {
        sentence.push({ ...word, text: glued, end: word.start });
        endSentence();
      }
      word = {
        ...word,
        text: word.text.slice(glued.length),
        start: word.end ?? word.start,
      };
    }
    if (
      pausesEnd &&
      word.type === "word" &&
      lastEnd !== null &&
      sentence.some((part) => part.type === "word")
    ) {
      const pause = word.start - lastEnd;
      if (pause >= PAUSE_SECONDS || (spaced && pause >= SPACED_PAUSE_SECONDS))
        endSentence();
    }
    sentence.push(word);
    if (word.type === "word") {
      lastEnd = word.end ?? null;
      spaced = false;
    } else if (word.type === "spacing") spaced = true;
    if (word.type === "word" && SENTENCE_END.test(word.text)) endSentence();
  }
  if (sentence.some((word) => word.text.trim()))
    lines.push(sentenceLine(sentence));
  return lines.join("\n");
}
