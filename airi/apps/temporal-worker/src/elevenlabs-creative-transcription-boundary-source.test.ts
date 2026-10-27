import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

test("creative transcript STT is started and completed by Temporal, with provider ingress owned by the media gateway", () => {
  const generateRoute = read(
    "apps/web/src/app/api/workspaces/[workspaceId]/assets/generate/elevenlabs/route.ts",
  );
  const mediaApi = read("apps/temporal-worker/src/media-api.ts");
  const webhookContract = read(
    "packages/airi-runtime/src/elevenlabs-stt-webhook.ts",
  );
  const worker = read("apps/temporal-worker/src/worker.ts");

  assert.doesNotMatch(
    generateRoute,
    /submitElevenLabsMediaTranscriptionFromUrl/,
  );
  assert.match(generateRoute, /startElevenLabsCreativeTranscriptionWorkflow/);
  assert.doesNotMatch(mediaApi, /completeElevenLabsCreativeTranscriptionAsset/);
  assert.match(mediaApi, /ELEVENLABS_CREATIVE_TRANSCRIPTION_COMPLETED_SIGNAL/);
  assert.match(webhookContract, /creative_asset_transcription/);
  assert.match(worker, /elevenLabsCreativeTranscriptionSubmitActivity/);
  assert.match(worker, /elevenLabsCreativeTranscriptionCompleteActivity/);
});
