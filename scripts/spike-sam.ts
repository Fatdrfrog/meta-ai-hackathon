// Spike: does SAM 3.1 track each product through a real shop video as one object, with a
// usable cut-out? Run: pnpm spike:sam <video> "<concept>" [--file-id=<id from spike:video>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMetaClient, loadConfig, openSpendLedger, samVideoCostUsd, segmentVideo, summarizeTracks } from "@vitrina/meta";
import { countFrames, extractCrop, normalizeVideo } from "@vitrina/catalog";

const SPIKE_DIR = ".data/spikes";

const args = process.argv.slice(2);
const [videoPath, concept] = args.filter((arg) => !arg.startsWith("--"));
const fileIdArg = args.find((arg) => arg.startsWith("--file-id="))?.slice("--file-id=".length);
if (!videoPath || !concept) {
  console.error('Usage: pnpm spike:sam <shop-video.mp4|.mov> "<concept>" [--file-id=<id>]');
  process.exit(1);
}

const config = loadConfig();
const client = createMetaClient(config, openSpendLedger(config.ledgerPath, config.budgetUsd));

// Same normalization as spike:video, so a reused file id points at identical frames.
const mp4 = await normalizeVideo(videoPath, SPIKE_DIR);
const frames = await countFrames(mp4);
console.log(`${frames} frames, SAM estimate $${samVideoCostUsd(frames).toFixed(4)}`);

const fileId = fileIdArg ?? (await client.uploadFile(mp4, "video/mp4")).id;
const result = await segmentVideo(client, { fileId, concept, frameCount: frames });
if (result.outcome.status !== "completed") console.warn("Segmentation ended early:", result.outcome);
for (const d of result.diagnostics) console.warn(`${d.severity} ${d.code} on line ${d.line}: ${d.message}`);

const tracks = summarizeTracks(result.records);
const runDir = join(SPIKE_DIR, `${Date.now()}-sam-${concept.replaceAll(/\W+/g, "-")}`);
mkdirSync(runDir, { recursive: true });
for (const track of tracks) {
  await extractCrop(mp4, track.bestFrame, track.bestBox, join(runDir, `track-${track.objectId}.png`));
}
writeFileSync(
  join(runDir, "result.json"),
  `${JSON.stringify({ fileId, concept, frames, outcome: result.outcome, tracks, rawOutput: result.rawOutput }, null, 2)}\n`,
);

console.log(`"${concept}": ${tracks.length} tracked objects`);
console.table(
  tracks.map((t) => ({
    id: t.objectId,
    frames: t.frames,
    from: t.firstFrame,
    to: t.lastFrame,
    best: t.bestFrame,
    confidence: t.maxConfidence?.toFixed(2) ?? "-",
  })),
);
console.log(`Crops of each object's best frame are in ${runDir}`);
console.log(`Estimated spend so far: $${client.ledger.totalUsd().toFixed(4)} of $${client.ledger.limitUsd}`);
