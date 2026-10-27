import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workerSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "activities",
    "conversation-media-analysis.ts",
  ),
  "utf8",
);

const mediaOwnerSource = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../apps/web/src/lib/classifier/conversation-media-analysis.ts",
  ),
  "utf8",
);

test("conversation media STT submission is owned by the Temporal worker runtime", () => {
  assert.match(workerSource, /@icecore\/airi-runtime\/elevenlabs-stt/);
  assert.match(workerSource, /transcriptionSubmitter/);
  assert.match(workerSource, /@\/lib\/classifier\/conversation-media-analysis/);
  assert.match(
    workerSource,
    /@\/lib\/classifier\/conversation-analysis-context/,
  );
  assert.doesNotMatch(workerSource, /@\/app\/api\/cron\/classify/);
  assert.doesNotMatch(
    mediaOwnerSource,
    /submit(Audio|Video)TranscriptionFromUrl/,
  );
  assert.doesNotMatch(mediaOwnerSource, /@\/lib\/ai\/elevenlabs/);
});
