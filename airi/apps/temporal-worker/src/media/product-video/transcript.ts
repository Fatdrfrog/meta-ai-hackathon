// The owner's narration as Muse Spark reads it: one sentence per line, each
// with its start time, like "[12.3] Кукла Лол, бес мың теңге."
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
  let current = "";
  let start: number | undefined;
  for (const word of words) {
    if (word.type === "audio_event") continue;
    if (start === undefined && word.type === "word") start = word.start;
    current += word.text;
    if (word.type === "word" && /[.!?]$/.test(word.text)) {
      lines.push(`[${(start ?? 0).toFixed(1)}] ${current.trim()}`);
      current = "";
      start = undefined;
    }
  }
  if (current.trim())
    lines.push(`[${(start ?? 0).toFixed(1)}] ${current.trim()}`);
  return lines.join("\n");
}
