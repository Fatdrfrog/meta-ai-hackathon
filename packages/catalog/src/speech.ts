// Speech-to-text from non-Meta providers. Muse Spark ignored or misheard Kazakh narration in most
// runs (docs/findings.md) and Muse Voice Transcribe has no Kazakh or Russian, so speech comes
// from a dedicated model and Meta's models take it from there as text.
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { ApiError, type SpendLedger } from "@vitrina/meta";

// USD per minute of audio. OpenAI's is its list price; ElevenLabs' is a cautious upper bound
// until we read the bill.
const USD_PER_MINUTE = { openai: 0.006, elevenlabs: 0.01 } as const;

export type SpeechProvider = keyof typeof USD_PER_MINUTE;

async function postForm(provider: string, url: string, headers: Record<string, string>, form: FormData): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers, body: form });
  if (!res.ok) throw new ApiError(provider, new URL(url).pathname, res.status, await res.text());
  return res.json();
}

interface ScribeWord {
  readonly text: string;
  readonly type: "word" | "spacing" | "audio_event";
  readonly start: number;
}

// Rebuild sentences from Scribe's words so each line carries its start time, like "[12.3] ...".
export function scribeLines(words: readonly ScribeWord[]): string {
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
  if (current.trim()) lines.push(`[${(start ?? 0).toFixed(1)}] ${current.trim()}`);
  return lines.join("\n");
}

export async function transcribe(
  provider: SpeechProvider,
  audioPath: string,
  durationS: number,
  ledger: SpendLedger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const usd = (durationS / 60) * USD_PER_MINUTE[provider];
  ledger.assertCanSpend(usd, provider);
  const file = await openAsBlob(audioPath, { type: "audio/mpeg" });
  const form = new FormData();
  form.set("file", file, basename(audioPath));

  let text: string;
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
    form.set("model", "gpt-4o-transcribe");
    form.set("response_format", "json");
    const json = (await postForm("OpenAI", "https://api.openai.com/v1/audio/transcriptions", { authorization: `Bearer ${apiKey}` }, form)) as { text: string };
    text = json.text;
  } else {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set.");
    form.set("model_id", "scribe_v2");
    form.set("timestamps_granularity", "word");
    form.set("tag_audio_events", "false");
    const json = (await postForm("ElevenLabs", "https://api.elevenlabs.io/v1/speech-to-text", { "xi-api-key": apiKey }, form)) as {
      text: string;
      words?: ScribeWord[];
    };
    text = json.words?.length ? scribeLines(json.words) : json.text;
  }
  ledger.record({ model: provider, usd, note: "speech to text" });
  return text;
}
