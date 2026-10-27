import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationTranscriptionSubmitter,
  prepareConversationTranscription,
} from "./conversation-transcription";

const metadata = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  workflowId: "workflow-1",
  mediaType: "audio" as const,
};

function fixture() {
  const calls: string[] = [];
  let claimed = false;
  const deps = {
    claimSubmission: async (..._args: unknown[]) => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    resolveAccess: async () => ({
      apiKey: "platform-key",
      credentialSource: "platform" as "platform" | "workspace_source",
    }),
    prepare: async () => ({
      fileBuffer: Buffer.from("audio"),
      durationSeconds: 60,
    }),
    reserve: async (input: { actionId: string }) => {
      calls.push(`reserve:${input.actionId}`);
      return {
        workspaceId: "workspace-1",
        actionId: input.actionId,
        operationId: "transcription-submit",
        maxCostMicros: 100000,
      };
    },
    settle: async () => {
      calls.push("settle");
    },
    submitAudio: async (..._args: unknown[]) => {
      calls.push("provider");
      return { requestId: "request-1" } as never;
    },
    submitVideo: async (..._args: unknown[]) =>
      ({ requestId: "request-1" }) as never,
  };
  return { calls, deps };
}

test("reserves the semantic media action before calling paid STT", async () => {
  const { calls, deps } = fixture();
  await createConversationTranscriptionSubmitter(deps).submitAudio(
    "https://media.example/audio",
    "audio/ogg",
    metadata,
  );
  assert.deepEqual(calls, [
    "reserve:media-analysis:message-1",
    "provider",
    "settle",
  ]);
});

test("quota rejection prevents provider submission and media preparation", async () => {
  const { calls, deps } = fixture();
  deps.reserve = async () => {
    throw new Error("own_ai_source_required");
  };
  deps.prepare = async () => {
    calls.push("prepare");
    return { fileBuffer: Buffer.from("audio"), durationSeconds: 60 };
  };
  await assert.rejects(
    createConversationTranscriptionSubmitter(deps).submitAudio(
      "https://media.example/audio",
      "audio/ogg",
      metadata,
    ),
    /own_ai_source_required/,
  );
  // Download and ffmpeg used to run first for every refused voice note.
  assert.deepEqual(calls, []);
});

test("customer ElevenLabs credentials bypass platform spending only", async () => {
  const { calls, deps } = fixture();
  deps.resolveAccess = async () => ({
    apiKey: "customer-key",
    credentialSource: "workspace_source",
  });
  await createConversationTranscriptionSubmitter(deps).submitAudio(
    "https://media.example/audio",
    "audio/ogg",
    metadata,
  );
  assert.deepEqual(calls, ["provider"]);
});

test("an uncertain customer submission cannot retry under a different payer", async () => {
  const { calls, deps } = fixture();
  deps.resolveAccess = async () => ({
    apiKey: "customer-key",
    credentialSource: "workspace_source",
  });
  deps.submitAudio = async () => {
    calls.push("provider");
    throw new Error("timeout");
  };
  const submitter = createConversationTranscriptionSubmitter(deps);
  await assert.rejects(
    submitter.submitAudio("https://media.example/audio", "audio/ogg", metadata),
    /timeout/,
  );
  deps.resolveAccess = async () => ({
    apiKey: "platform-key",
    credentialSource: "platform",
  });
  await assert.rejects(
    submitter.submitAudio("https://media.example/audio", "audio/ogg", metadata),
    /already submitted/,
  );
  assert.equal(calls.filter((call) => call === "provider").length, 1);
});

test("overlong or oversized media cannot incur provider spend", async () => {
  for (const prepared of [
    { fileBuffer: Buffer.from("audio"), durationSeconds: 601 },
    { fileBuffer: Buffer.alloc(20 * 1024 * 1024 + 1), durationSeconds: 60 },
  ]) {
    const { calls, deps } = fixture();
    deps.prepare = async () => prepared;
    await assert.rejects(
      createConversationTranscriptionSubmitter(deps).submitAudio(
        "https://media.example/audio",
        "audio/ogg",
        metadata,
      ),
      /limit/,
    );
    // The reservation taken before preparation is released at zero.
    assert.deepEqual(calls, ["reserve:media-analysis:message-1", "settle"]);
  }
});

test("a failed download releases its reservation", async () => {
  const { calls, deps } = fixture();
  deps.prepare = async () => {
    throw new Error("download failed");
  };
  await assert.rejects(
    createConversationTranscriptionSubmitter(deps).submitAudio(
      "https://media.example/audio",
      "audio/ogg",
      metadata,
    ),
    /download failed/,
  );
  assert.deepEqual(calls, ["reserve:media-analysis:message-1", "settle"]);
});

test("unknown provider outcome does not release its reservation", async () => {
  const { calls, deps } = fixture();
  deps.submitAudio = async () => {
    calls.push("provider");
    throw new Error("timeout");
  };
  await assert.rejects(
    createConversationTranscriptionSubmitter(deps).submitAudio(
      "https://media.example/audio",
      "audio/ogg",
      metadata,
    ),
    /timeout/,
  );
  assert.deepEqual(calls, ["reserve:media-analysis:message-1", "provider"]);
});

function pcmWav(seconds: number) {
  const bytes = seconds * 16000 * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(bytes, 40);
  return buffer;
}

test("decodes and measures the exact audio sent to the provider", async () => {
  const prepared = await prepareConversationTranscription(
    "https://unused.example/audio",
    { fileBuffer: pcmWav(2) },
  );
  assert.equal(prepared.durationSeconds, 2);
  assert.equal(prepared.fileBuffer.toString("ascii", 0, 4), "RIFF");
});

test("rejects actual overlong audio after bounded decoding", async () => {
  await assert.rejects(
    prepareConversationTranscription("https://unused.example/audio", {
      fileBuffer: pcmWav(602),
    }),
    /10 minute/,
  );
});
