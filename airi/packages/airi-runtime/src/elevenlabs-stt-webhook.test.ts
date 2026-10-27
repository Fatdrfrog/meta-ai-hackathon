import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  parseElevenLabsSttWebhookPayload,
  verifyElevenLabsWebhookSignature,
} from "./elevenlabs-stt-webhook";

function signBody(body: string, secret: string, timestamp: number): string {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v0=${signature}`;
}

test("verifies ElevenLabs HMAC signatures within the configured tolerance", () => {
  const timestamp = 1_783_519_200;
  const rawBody = JSON.stringify({ type: "speech_to_text_transcription" });
  assert.equal(
    verifyElevenLabsWebhookSignature({
      rawBody,
      signatureHeader: signBody(rawBody, "webhook-secret", timestamp),
      secret: "webhook-secret",
      nowMs: timestamp * 1000,
    }),
    true,
  );
  assert.equal(
    verifyElevenLabsWebhookSignature({
      rawBody,
      signatureHeader: signBody(rawBody, "wrong-secret", timestamp),
      secret: "webhook-secret",
      nowMs: timestamp * 1000,
    }),
    false,
  );
});

test("normalizes conversation media transcription callbacks", () => {
  const normalized = parseElevenLabsSttWebhookPayload({
    type: "speech_to_text_transcription",
    data: {
      request_id: "stt_req_123",
      status: "completed",
      webhook_metadata: {
        workflowId:
          "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        mediaType: "voice",
      },
      transcription: {
        text: "Customer says the package arrived damaged.",
        language_code: "en",
      },
    },
  });

  assert.equal(normalized.kind, "conversation_media");
  if (normalized.kind !== "conversation_media") return;
  assert.equal(
    normalized.workflowId,
    "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
  );
  assert.equal(normalized.event.requestId, "stt_req_123");
  assert.equal(normalized.event.status, "completed");
  assert.equal(
    normalized.event.text,
    "Customer says the package arrived damaged.",
  );
  assert.equal(normalized.event.languageCode, "en");
});

test("normalizes creative asset transcription callbacks", () => {
  const normalized = parseElevenLabsSttWebhookPayload({
    type: "speech_to_text_transcription",
    data: {
      request_id: "stt_req_asset_1",
      status: "completed",
      webhook_metadata: JSON.stringify({
        workflowKind: "creative_asset_transcription",
        workspaceId: "workspace-1",
        assetId: "asset-1",
        sourceAssetId: "source-1",
        mode: "subtitles",
        mediaType: "video",
      }),
      transcription: {
        text: "Welcome to airi.chat.",
        words: [{ text: "Welcome", start: 0, end: 0.3 }],
      },
    },
  });

  assert.equal(normalized.kind, "creative_asset");
  if (normalized.kind !== "creative_asset") return;
  assert.equal(normalized.assetId, "asset-1");
  assert.equal(normalized.event.requestId, "stt_req_asset_1");
  assert.equal(normalized.event.mode, "subtitles");
  assert.equal(normalized.event.status, "completed");
});
