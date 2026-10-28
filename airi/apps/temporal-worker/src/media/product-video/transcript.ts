// The owner's narration as Muse Spark reads it: one sentence per line, each
// with its start time, like "[12.3] Кукла Лол, бес мың теңге." A long
// sentence gets time marks inside it as well, at most MARK_EVERY_SECONDS
// apart: an edited promo shows several products during one sentence, and
// Muse needs to know which words were said over which of them.
//
// Muse Spark missed spoken prices in most test runs and Muse Voice Transcribe
// has no Kazakh or Russian, so ElevenLabs Scribe listens and Meta's models
// take it from there as text.

type ScribeWord = {
  text: string;
  type: string;
  start: number;
};

function scribeWords(payload: unknown): ScribeWord[] {
  if (!payload || typeof payload !== "object") return [];
  const words = (payload as { words?: unknown }).words;
  if (!Array.isArray(words)) return [];
  return words.flatMap((word): ScribeWord[] => {
    if (!word || typeof word !== "object") return [];
    const { text, type, start } = word as Record<string, unknown>;
    return typeof text === "string" &&
      typeof type === "string" &&
      typeof start === "number" &&
      Number.isFinite(start)
      ? [{ text, type, start }]
      : [];
  });
}

// Sentences this long get marks inside, at most this far apart.
const LONG_SENTENCE_SECONDS = 3;
const MARK_EVERY_SECONDS = 1.5;

/** One sentence as a line: its start time, and marks inside when it runs long. */
function sentenceLine(words: ScribeWord[]): string {
  const spoken = words.filter((word) => word.type === "word");
  const first = spoken[0]?.start ?? 0;
  const long =
    spoken.length > 0 && spoken.at(-1)!.start - first >= LONG_SENTENCE_SECONDS;
  let text = "";
  let marked = first;
  for (const word of words) {
    if (
      long &&
      word.type === "word" &&
      word.start - marked >= MARK_EVERY_SECONDS
    ) {
      text += `[${word.start.toFixed(1)}] `;
      marked = word.start;
    }
    text += word.text;
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
  const lines: string[] = [];
  let sentence: ScribeWord[] = [];
  for (const word of words) {
    if (word.type === "audio_event") continue;
    sentence.push(word);
    if (word.type === "word" && /[.!?]$/.test(word.text)) {
      lines.push(sentenceLine(sentence));
      sentence = [];
    }
  }
  if (sentence.some((word) => word.text.trim()))
    lines.push(sentenceLine(sentence));
  return lines.join("\n");
}
