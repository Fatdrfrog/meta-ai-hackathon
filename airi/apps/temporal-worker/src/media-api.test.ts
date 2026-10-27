import assert from "node:assert/strict";
import test from "node:test";

import { signalElevenLabsSttWebhookEvent } from "./media-api.js";

test("routes conversation transcripts to their deterministic workflow", async () => {
  const calls: Array<{ workflowId: string; args: unknown[] }> = [];
  const client = {
    workflow: {
      getHandle: (workflowId: string) => ({
        signal: async (...args: unknown[]) => {
          calls.push({ workflowId, args });
        },
      }),
    },
  };

  await signalElevenLabsSttWebhookEvent(client, {
    kind: "conversation_media",
    workflowId:
      "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
    event: {
      requestId: "stt-1",
      status: "completed",
      text: "Hello",
    },
  });

  assert.deepEqual(calls, [
    {
      workflowId:
        "conversation-media-analysis:workspace-1:conversation-1:message-1:voice",
      args: [
        "conversationMediaTranscriptionCompleted",
        {
          requestId: "stt-1",
          status: "completed",
          text: "Hello",
        },
      ],
    },
  ]);
});

test("routes creative transcripts by deterministic asset workflow id", async () => {
  const calls: Array<{ workflowId: string; args: unknown[] }> = [];
  const client = {
    workflow: {
      getHandle: (workflowId: string) => ({
        signal: async (...args: unknown[]) => {
          calls.push({ workflowId, args });
        },
      }),
    },
  };

  await signalElevenLabsSttWebhookEvent(client, {
    kind: "creative_asset",
    assetId: "asset-1",
    event: {
      requestId: "stt-2",
      status: "completed",
      mode: "subtitles",
      webhookType: "speech_to_text_transcription",
      data: { text: "Hello" },
    },
  });

  assert.deepEqual(calls, [
    {
      workflowId: "elevenlabs-creative-transcription:asset-1",
      args: [
        "elevenLabsCreativeTranscriptionCompleted",
        {
          requestId: "stt-2",
          status: "completed",
          mode: "subtitles",
          webhookType: "speech_to_text_transcription",
          data: { text: "Hello" },
        },
      ],
    },
  ]);
});

test("acknowledges a retried webhook after its workflow completed", async () => {
  const client = {
    workflow: {
      getHandle: () => ({
        signal: async () => {
          throw new Error("Workflow execution already completed");
        },
        describe: async () => ({ status: { name: "COMPLETED" } }),
        result: async () => ({ status: "completed" }),
      }),
    },
  };

  await assert.doesNotReject(
    signalElevenLabsSttWebhookEvent(client, {
      kind: "conversation_media",
      workflowId: "conversation-media-analysis:completed",
      event: {
        requestId: "stt-completed",
        status: "completed",
        text: "Already stored",
      },
    }),
  );
});

test("rejects a retried webhook when its workflow did not complete", async () => {
  const client = {
    workflow: {
      getHandle: () => ({
        signal: async () => {
          throw new Error("Workflow execution already completed");
        },
        describe: async () => ({ status: { name: "COMPLETED" } }),
        result: async () => ({ status: "failed" }),
      }),
    },
  };

  await assert.rejects(
    signalElevenLabsSttWebhookEvent(client, {
      kind: "conversation_media",
      workflowId: "conversation-media-analysis:failed",
      event: {
        requestId: "stt-failed",
        status: "completed",
        text: "Needs recovery",
      },
    }),
    /already completed/,
  );
});
