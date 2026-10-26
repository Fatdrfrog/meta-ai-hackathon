// Spike: which model hears spoken prices reliably? Transcribes a video's narration several times
// per model, then scores each transcript against the true prices.
// Run: pnpm spike:speech <video> --expect=<prices.json> [--runs=3] [--models=spark,open,openai,elevenlabs]
// Models: spark (Muse Spark), open (Muse Spark Open on Baseten), openai (gpt-4o-transcribe),
// elevenlabs (Scribe v2). By default, every model whose API key is set.
//
// prices.json: { "items": [{ "item": "rooster figurine", "price": 500, "confirmed": true }, ...] }
// in the order the owner presents them; "confirmed" marks prices the owner has checked.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBasetenClient,
  createMetaClient,
  loadBasetenConfig,
  loadConfig,
  messageText,
  openSpendLedger,
  outputText,
} from "@vitrina/meta";
import { durationSeconds, extractAudio, normalizeVideo, transcribe as transcribeWith } from "@vitrina/catalog";

const SPIKE_DIR = ".data/spikes";

const args = process.argv.slice(2);
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const [videoPath] = args.filter((arg) => !arg.startsWith("--"));
const expectPath = option("expect");
if (!videoPath || !expectPath) {
  console.error("Usage: pnpm spike:speech <video> --expect=<prices.json> [--runs=3] [--models=spark,open]");
  process.exit(1);
}
const runs = Number(option("runs") ?? "3");
const expected = (JSON.parse(readFileSync(expectPath, "utf8")) as { items: { item: string; price: number | null; confirmed: boolean }[] }).items;

const TRANSCRIBE = `Transcribe this recording word for word in the language actually spoken (Kazakh or Russian, often mixed).
Write numbers exactly as spoken, in words. Do not translate, summarize or guess.
One sentence per line, prefixed with its start time in seconds like [12.3]. If there is no speech, answer NO SPEECH.`;

const config = loadConfig();
const ledger = openSpendLedger(config.ledgerPath, config.budgetUsd);
const meta = createMetaClient(config, ledger);
const available = [
  "spark",
  ...(process.env.BASETEN_API_KEY ? ["open"] : []),
  ...(process.env.OPENAI_API_KEY ? ["openai"] : []),
  ...(process.env.ELEVENLABS_API_KEY ? ["elevenlabs"] : []),
];
const models = (option("models") ?? available.join(",")).split(",");
const baseten = models.includes("open") ? createBasetenClient(loadBasetenConfig(), ledger) : undefined;

const audioPath = await extractAudio(await normalizeVideo(videoPath, SPIKE_DIR), SPIKE_DIR);
const audioSeconds = await durationSeconds(audioPath);
const audio = readFileSync(audioPath).toString("base64");

async function transcribe(model: string): Promise<string> {
  if (model === "spark") {
    const response = await meta.createResponse({
      model: config.models.spark,
      reasoning: { effort: "low" },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: audio, format: "mp3" } },
            { type: "input_text", text: TRANSCRIBE },
          ],
        },
      ],
      max_output_tokens: 6000,
    });
    return outputText(response);
  }
  if (model === "open" && baseten) {
    const completion = await baseten.chatCompletion({
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: audio, format: "mp3" } },
            { type: "text", text: TRANSCRIBE },
          ],
        },
      ],
      max_tokens: 6000,
    });
    return messageText(completion);
  }
  if (model === "openai" || model === "elevenlabs") return transcribeWith(model, audioPath, audioSeconds, ledger);
  throw new Error(`Unknown model "${model}". Use spark, open, openai or elevenlabs.`);
}

// Reading prices out of a transcript is a text task Muse Spark does reliably; hearing them is the test.
async function pricesIn(transcript: string): Promise<(number | null)[]> {
  const response = await meta.createResponse({
    model: config.models.spark,
    reasoning: { effort: "low" },
    input: `A shop owner presented these items, in this order:\n${expected.map((e, i) => `${i + 1}. ${e.item}`).join("\n")}\n\nTranscript of what they said:\n${transcript}\n\nFor each item, give the price in tenge said for it as a number (for example "бес мың" is 5000), or null if none was said. Same order, one entry per item.`,
    text: {
      format: {
        type: "json_schema",
        name: "prices",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["prices"],
          properties: { prices: { type: "array", items: { type: ["number", "null"] } } },
        },
      },
    },
    max_output_tokens: 3000,
  });
  return (JSON.parse(outputText(response)) as { prices: (number | null)[] }).prices;
}

const heard = (text: string) => text.trim() !== "" && !/NO SPEECH|can't hear|cannot hear|не (вижу|слышу)/i.test(text);

const rows = [];
for (const model of models) {
  for (let run = 1; run <= runs; run++) {
    const spentBefore = ledger.totalUsd();
    const started = Date.now();
    let transcript = "";
    let error: string | undefined;
    try {
      transcript = await transcribe(model);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const seconds = (Date.now() - started) / 1000;
    const didHear = !error && heard(transcript);
    let prices: (number | null)[] = expected.map(() => null);
    if (didHear) {
      try {
        prices = await pricesIn(transcript);
      } catch (e) {
        error = `scoring failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const right = expected.map((e, i) => e.price !== null && prices[i] === e.price);
    rows.push({
      model,
      run,
      seconds: Number(seconds.toFixed(1)),
      heard: didHear,
      confirmedRight: `${right.filter((ok, i) => ok && expected[i]!.confirmed).length}/${expected.filter((e) => e.confirmed).length}`,
      allRight: `${right.filter(Boolean).length}/${expected.filter((e) => e.price !== null).length}`,
      prices,
      usd: Number((ledger.totalUsd() - spentBefore).toFixed(4)),
      transcript: error ? `ERROR ${error}\n${transcript}` : transcript,
    });
    console.log(`${model} run ${run}: ${error ? `error: ${error.slice(0, 200)}` : `${seconds.toFixed(1)}s, prices ${JSON.stringify(prices)}`}`);
  }
}

const outPath = join(SPIKE_DIR, `${Date.now()}-speech.json`);
writeFileSync(outPath, `${JSON.stringify({ expected, rows }, null, 2)}\n`);
console.table(rows.map(({ transcript: _t, prices: _p, ...row }) => row));
console.log(`Expected prices: ${JSON.stringify(expected.map((e) => e.price))}`);
console.log(`Transcripts saved to ${outPath}. Estimated spend so far: $${ledger.totalUsd().toFixed(4)} of $${ledger.limitUsd}`);
