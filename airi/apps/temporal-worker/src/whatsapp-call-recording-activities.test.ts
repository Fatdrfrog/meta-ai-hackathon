import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhatsAppCallGoogleSpeechBatchRecognizeRequest,
  buildWhatsAppCallGoogleSpeechOperationGetRequest,
  buildWhatsAppCallLiveKitEgressStartRequest,
  buildWhatsAppCallLiveKitEgressStopRequest,
  buildWhatsAppCallRecordingMetadata,
  buildWhatsAppCallRecordingPipelineRequest,
  buildWhatsAppCallTranscriptionDrainFilter,
  normalizeWhatsAppCallTranscriptionDrainLimit,
  parseWhatsAppCallGoogleSpeechOperation,
} from "./activities/whatsapp-calls/recording-activities";

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  assert.ok(payload, "token payload should be present");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

test("builds durable recording metadata and analytics row ids for completed calls", () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
      WHATSAPP_CALL_RECORDING_RETENTION_DAYS: "30",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "terminated",
      direction: "inbound",
      durationSeconds: 120,
      firstSeenAt: "2026-06-19T10:00:00.000Z",
      answeredAt: "2026-06-19T10:00:08.000Z",
      endedAt: "2026-06-19T10:02:00.000Z",
      latestStatus: "completed",
      errorCode: null,
      errorMessage: null,
    },
  });

  assert.equal(
    metadata.recordingObjectPath,
    "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.webm",
  );
  assert.equal(metadata.transcriptStatus, "pending");
  assert.equal(
    metadata.transcriptTextPath,
    "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.transcript.json",
  );
  assert.equal(metadata.retentionExpiresAt, "2026-07-19T10:05:00.000Z");
  assert.equal(metadata.answerLatencyMs, 8000);
  assert.equal(metadata.analyticsEvent.rowId.length, 64);
  assert.deepEqual(metadata.analyticsEvent, {
    rowId: metadata.analyticsEvent.rowId,
    workspaceId: "workspace-1",
    sourceId: "source-1",
    callId: "wacid.1",
    callSessionId: "session-1",
    conversationId: "conversation-1",
    phoneNumberId: "phone-1",
    direction: "inbound",
    state: "terminated",
    durationSeconds: 120,
    answerLatencyMs: 8000,
    terminationReason: "completed",
    errorCode: null,
    errorMessage: null,
    finalizedAt: "2026-06-19T10:05:00.000Z",
  });
});

test("keeps recording metadata extension aligned with configured egress file type", () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
      WHATSAPP_CALL_RECORDING_FILE_TYPE: "OGG",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      callId: "wacid.1",
      phoneNumberId: "phone-1",
      state: "active",
    },
  });

  assert.equal(
    metadata.recordingObjectPath,
    "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.ogg",
  );
});

test("builds a recording pipeline request for LiveKit egress and call transcription", () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
      WHATSAPP_CALL_RECORDING_RETENTION_DAYS: "30",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "terminated",
      direction: "inbound",
      durationSeconds: 120,
      firstSeenAt: "2026-06-19T10:00:00.000Z",
      answeredAt: "2026-06-19T10:00:08.000Z",
      endedAt: "2026-06-19T10:02:00.000Z",
      latestStatus: "completed",
    },
  });

  const request = buildWhatsAppCallRecordingPipelineRequest({
    metadata,
    env: {
      WHATSAPP_CALL_RECORDING_PIPELINE_URL:
        "https://recording-pipeline.example.com/recordings/whatsapp/finalize",
      NEXT_PUBLIC_APP_URL: "https://www.airi.chat",
      WHATSAPP_CALL_RECORDING_PIPELINE_ENABLED: "true",
      WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODE: "kk-KZ",
    },
  });

  assert.deepEqual(request, {
    endpoint:
      "https://recording-pipeline.example.com/recordings/whatsapp/finalize",
    body: {
      schemaVersion: 1,
      provider: "whatsapp",
      idempotencyKey: metadata.analyticsEvent.rowId,
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callSessionId: "session-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      roomName: "wa-call-3bb7b5b5431c2a19dd91ad1855112268",
      recordingObjectPath:
        "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.webm",
      transcriptTextPath:
        "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.transcript.json",
      callbackUrl: "https://www.airi.chat/api/webhooks/whatsapp/call-recording",
      languageCode: "kk-KZ",
      finalizedAt: "2026-06-19T10:05:00.000Z",
      retentionExpiresAt: "2026-07-19T10:05:00.000Z",
      analyticsRowId: metadata.analyticsEvent.rowId,
      durationSeconds: 120,
    },
  });
});

test("builds a LiveKit room-composite egress request for call recording", async () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
      WHATSAPP_CALL_RECORDING_RETENTION_DAYS: "30",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "active",
      direction: "inbound",
    },
  });

  const request = await buildWhatsAppCallLiveKitEgressStartRequest({
    metadata,
    nowSeconds: 1_782_987_000,
    env: {
      LIVEKIT_URL: "wss://livekit.example.com/",
      LIVEKIT_API_KEY: "livekit-key",
      LIVEKIT_API_SECRET: "livekit-secret",
      LIVEKIT_EGRESS_GCP_CREDENTIALS_JSON:
        '{"type":"service_account","project_id":"airi-prod"}',
      WHATSAPP_CALL_RECORDING_EGRESS_ENABLED: "true",
      WHATSAPP_CALL_RECORDING_FILE_TYPE: "OGG",
    },
  });

  assert.ok(request);
  assert.equal(
    request.endpoint,
    "https://livekit.example.com/twirp/livekit.Egress/StartRoomCompositeEgress",
  );
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.match(request.headers.Authorization, /^Bearer /);
  assert.deepEqual(request.body, {
    room_name: "wa-call-3bb7b5b5431c2a19dd91ad1855112268",
    audio_only: true,
    file_outputs: [
      {
        file_type: "OGG",
        filepath: "whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.ogg",
        gcp: {
          bucket: "airi-call-recordings",
          credentials: '{"type":"service_account","project_id":"airi-prod"}',
        },
      },
    ],
  });

  const token = request.headers.Authorization.replace(/^Bearer /, "");
  assert.deepEqual(decodeJwtPayload(token), {
    iss: "livekit-key",
    nbf: 1_782_987_000,
    exp: 1_782_987_600,
    video: { roomRecord: true },
  });
});

test("does not build a LiveKit egress request until egress and credentials are configured", async () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      callId: "wacid.1",
      state: "active",
    },
  });

  assert.equal(
    await buildWhatsAppCallLiveKitEgressStartRequest({
      metadata,
      env: {
        LIVEKIT_URL: "wss://livekit.example.com/",
        LIVEKIT_API_KEY: "livekit-key",
        LIVEKIT_API_SECRET: "livekit-secret",
        WHATSAPP_CALL_RECORDING_EGRESS_ENABLED: "false",
      },
    }),
    null,
  );
  assert.equal(
    await buildWhatsAppCallLiveKitEgressStartRequest({
      metadata,
      env: {
        LIVEKIT_URL: "wss://livekit.example.com/",
        LIVEKIT_API_KEY: "livekit-key",
        LIVEKIT_API_SECRET: "livekit-secret",
        WHATSAPP_CALL_RECORDING_EGRESS_ENABLED: "true",
      },
    }),
    null,
  );
});

test("builds a LiveKit stop egress request with a room-record grant", async () => {
  const request = await buildWhatsAppCallLiveKitEgressStopRequest({
    egressId: "EG_123",
    nowSeconds: 1_782_987_000,
    env: {
      LIVEKIT_URL: "wss://livekit.example.com/",
      LIVEKIT_API_KEY: "livekit-key",
      LIVEKIT_API_SECRET: "livekit-secret",
    },
  });

  assert.ok(request);
  assert.equal(
    request.endpoint,
    "https://livekit.example.com/twirp/livekit.Egress/StopEgress",
  );
  assert.deepEqual(request.body, { egress_id: "EG_123" });
  const token = request.headers.Authorization.replace(/^Bearer /, "");
  assert.deepEqual(decodeJwtPayload(token), {
    iss: "livekit-key",
    nbf: 1_782_987_000,
    exp: 1_782_987_600,
    video: { roomRecord: true },
  });
});

test("builds a Google Speech batch recognize request for the recorded call", () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
      WHATSAPP_CALL_RECORDING_FILE_TYPE: "OGG",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      callId: "wacid.1",
      conversationId: "conversation-1",
      phoneNumberId: "phone-1",
      state: "terminated",
    },
  });

  const request = buildWhatsAppCallGoogleSpeechBatchRecognizeRequest({
    accessToken: "ya29.access-token",
    metadata,
    env: {
      WHATSAPP_CALL_TRANSCRIPTION_ENABLED: "true",
      WHATSAPP_CALL_TRANSCRIPTION_PROJECT_ID: "airi-prod",
      WHATSAPP_CALL_TRANSCRIPTION_LOCATION: "us-central1",
      WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODES: "kk-KZ, en-US",
      WHATSAPP_CALL_TRANSCRIPTION_MODEL: "long",
    },
  });

  assert.ok(request);
  assert.equal(
    request.endpoint,
    "https://speech.googleapis.com/v2/projects/airi-prod/locations/us-central1/recognizers/_:batchRecognize",
  );
  assert.deepEqual(request.headers, {
    Authorization: "Bearer ya29.access-token",
    "Content-Type": "application/json",
  });
  assert.deepEqual(request.body, {
    config: {
      autoDecodingConfig: {},
      languageCodes: ["kk-KZ", "en-US"],
      model: "long",
      features: {
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true,
      },
    },
    files: [
      {
        uri: "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.ogg",
      },
    ],
    recognitionOutputConfig: {
      gcsOutputConfig: {
        uri: "gs://airi-call-recordings/whatsapp-calls/workspace-1/phone-1/wacid.1/session-1.transcript.json",
      },
    },
    processingStrategy: "DYNAMIC_BATCHING",
  });
});

test("does not build a Google Speech request without explicit enablement and language codes", () => {
  const metadata = buildWhatsAppCallRecordingMetadata({
    finalizedAt: "2026-06-19T10:05:00.000Z",
    env: {
      WHATSAPP_CALL_RECORDING_BUCKET: "airi-call-recordings",
    },
    session: {
      _id: "session-1",
      workspaceId: "workspace-1",
      callId: "wacid.1",
      state: "terminated",
    },
  });

  assert.equal(
    buildWhatsAppCallGoogleSpeechBatchRecognizeRequest({
      accessToken: "ya29.access-token",
      metadata,
      env: {
        WHATSAPP_CALL_TRANSCRIPTION_ENABLED: "false",
        WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODES: "kk-KZ",
      },
    }),
    null,
  );
  assert.equal(
    buildWhatsAppCallGoogleSpeechBatchRecognizeRequest({
      accessToken: "ya29.access-token",
      metadata,
      env: {
        WHATSAPP_CALL_TRANSCRIPTION_ENABLED: "true",
        WHATSAPP_CALL_TRANSCRIPTION_LANGUAGE_CODE: "und",
      },
    }),
    null,
  );
});

test("builds a Google Speech operation polling request", () => {
  const request = buildWhatsAppCallGoogleSpeechOperationGetRequest({
    accessToken: "ya29.access-token",
    operationName:
      "projects/airi-prod/locations/us-central1/operations/operation-1",
  });

  assert.deepEqual(request, {
    endpoint:
      "https://speech.googleapis.com/v2/projects/airi-prod/locations/us-central1/operations/operation-1",
    headers: {
      Authorization: "Bearer ya29.access-token",
      "Content-Type": "application/json",
    },
  });
});

test("parses an incomplete Google Speech operation as processing", () => {
  const result = parseWhatsAppCallGoogleSpeechOperation({
    operation: {
      name: "projects/airi-prod/locations/us-central1/operations/operation-1",
      done: false,
      metadata: { progressPercent: 42 },
    },
    recordingObjectPath: "gs://bucket/calls/session-1.ogg",
    fallbackTranscriptTextPath: "gs://bucket/calls/session-1.transcript.json",
  });

  assert.deepEqual(result, {
    status: "processing",
    operationName:
      "projects/airi-prod/locations/us-central1/operations/operation-1",
    transcriptTextPath: null,
    errorMessage: null,
    progressPercent: 42,
  });
});

test("parses a completed Google Speech operation with the native GCS transcript uri", () => {
  const result = parseWhatsAppCallGoogleSpeechOperation({
    operation: {
      name: "projects/airi-prod/locations/us-central1/operations/operation-1",
      done: true,
      response: {
        "@type":
          "type.googleapis.com/google.cloud.speech.v2.BatchRecognizeResponse",
        results: {
          "gs://bucket/calls/session-1.ogg": {
            cloudStorageResult: {
              nativeFormatUri: "gs://bucket/calls/session-1.results.json",
            },
          },
        },
      },
    },
    recordingObjectPath: "gs://bucket/calls/session-1.ogg",
    fallbackTranscriptTextPath: "gs://bucket/calls/session-1.transcript.json",
  });

  assert.deepEqual(result, {
    status: "completed",
    operationName:
      "projects/airi-prod/locations/us-central1/operations/operation-1",
    transcriptTextPath: "gs://bucket/calls/session-1.results.json",
    errorMessage: null,
    progressPercent: 100,
  });
});

test("parses a failed Google Speech operation with provider error details", () => {
  const result = parseWhatsAppCallGoogleSpeechOperation({
    operation: {
      name: "projects/airi-prod/locations/us-central1/operations/operation-1",
      done: true,
      error: {
        code: 3,
        message: "Audio format is not supported",
      },
    },
    recordingObjectPath: "gs://bucket/calls/session-1.ogg",
    fallbackTranscriptTextPath: "gs://bucket/calls/session-1.transcript.json",
  });

  assert.deepEqual(result, {
    status: "failed",
    operationName:
      "projects/airi-prod/locations/us-central1/operations/operation-1",
    transcriptTextPath: null,
    errorMessage:
      "Google Speech operation failed: 3 Audio format is not supported",
    progressPercent: 100,
  });
});

test("builds a bounded stale-processing filter for batched transcription polling", () => {
  const now = new Date("2026-06-19T12:00:00.000Z");

  assert.equal(normalizeWhatsAppCallTranscriptionDrainLimit(0), 50);
  assert.equal(normalizeWhatsAppCallTranscriptionDrainLimit(2.8), 2);
  assert.equal(normalizeWhatsAppCallTranscriptionDrainLimit(5_000), 500);
  assert.deepEqual(buildWhatsAppCallTranscriptionDrainFilter(now), {
    transcriptStatus: "processing",
    transcriptionRequestId: { $nin: [null, ""] },
    updatedAt: { $lte: new Date("2026-06-19T11:50:00.000Z") },
  });
});
