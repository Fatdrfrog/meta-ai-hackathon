import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function readRepo(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function importLines(source: string): string {
  return source
    .split(/\r?\n/)
    .filter(line => /^\s*import\b/.test(line))
    .join("\n");
}

test("deliver outbound activity re-asserts GCS creative-asset read-URL port", () => {
  const autoReplySource = fs.readFileSync(
    path.join(here, "activities", "airi-auto-reply.ts"),
    "utf8"
  );

  assert.match(
    importLines(autoReplySource),
    /configureGcsCreativeAssetReadUrlPort/
  );
  // Other ports (voice reply storage) may be configured alongside it.
  assert.match(
    autoReplySource,
    /configureGcsCreativeAssetReadUrlPort\(\);\s*\n(?:\s*configure\w+\(\);\s*\n)*\s*try \{\s*\n\s*const result = await deliverAiriConversationOutbound/
  );
});

test("AI gateway and media-api entries do not wire worker GCS read-URL adapter", () => {
  assert.doesNotMatch(
    readRepo("apps/temporal-worker/src/gateway.ts"),
    /creative-asset-read-url-gcs-adapter|configureCreativeAssetReadUrlPort/
  );
  assert.doesNotMatch(
    readRepo("apps/temporal-worker/src/media-api.ts"),
    /creative-asset-read-url-gcs-adapter|configureCreativeAssetReadUrlPort/
  );
  assert.doesNotMatch(
    readRepo("apps/temporal-worker/src/realtime-gateway.ts"),
    /creative-asset-read-url-gcs-adapter|configureCreativeAssetReadUrlPort/
  );
});

test("outbound delivery orchestrates resolve-then-Meta; Meta dispatch stays clean", () => {
  const resolveSource = readRepo(
    "apps/web/src/lib/scenarios/scenario-asset-resolve.ts"
  );
  const storageSource = readRepo(
    "apps/web/src/lib/scenarios/scenario-asset-storage.ts"
  );
  const mediaPrepSource = readRepo(
    "apps/web/src/lib/airi/reply/delivery/whatsapp-service-message-media.ts"
  );
  const sendSource = readRepo(
    "apps/web/src/lib/airi/reply/delivery/whatsapp-service-message-send.ts"
  );
  const dispatchSource = readRepo(
    "apps/web/src/lib/airi/reply/delivery/whatsapp-service-message.ts"
  );
  const outboundSource = readRepo(
    "apps/web/src/lib/airi/reply/delivery/outbound-message.ts"
  );

  assert.doesNotMatch(
    importLines(resolveSource),
    /gcp-media-api|@\/lib\/google\//
  );
  assert.match(resolveSource, /createCreativeAssetReadUrl/);

  assert.match(storageSource, /from ["']@\/lib\/google\/gcp-media-api["']/);
  assert.match(storageSource, /storeScenarioAssetBuffer/);
  assert.doesNotMatch(storageSource, /export \{[^}]*resolveScenario/);

  assert.match(mediaPrepSource, /resolveWhatsAppServiceCommandMediaForSend/);
  assert.match(mediaPrepSource, /scenario-asset-resolve/);
  assert.doesNotMatch(importLines(mediaPrepSource), /gcp-media-api/);
  assert.doesNotMatch(
    mediaPrepSource,
    /ensureMediaApiCreativeAssetReadUrlPort/
  );

  assert.match(sendSource, /resolveWhatsAppServiceCommandMediaForSend/);
  assert.match(sendSource, /dispatchWhatsAppServiceMessage/);
  assert.match(sendSource, /sendWhatsAppServiceMessage/);

  assert.doesNotMatch(
    importLines(dispatchSource),
    /scenario-asset-resolve|scenario-asset-storage|whatsapp-service-message-media/
  );
  assert.match(dispatchSource, /assertMetaHttpsMediaLink|unresolved media URL/);

  assert.match(outboundSource, /whatsapp-service-message-send/);
  assert.match(outboundSource, /sendWhatsAppServiceMessage/);
  assert.doesNotMatch(
    outboundSource,
    /dispatchWhatsAppServiceMessage\s*\(/
  );
  assert.doesNotMatch(
    importLines(outboundSource),
    /scenario-asset-storage|gcp-media-api|creative-asset-read-url-media-api-adapter/
  );
  assert.doesNotMatch(
    outboundSource,
    /ensureMediaApiCreativeAssetReadUrlPort/
  );
});
