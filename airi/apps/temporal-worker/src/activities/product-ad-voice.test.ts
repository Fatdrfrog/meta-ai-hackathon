import assert from "node:assert/strict";
import test from "node:test";
import {
  CLONE_CLAIM_MS,
  productAdVoiceOverPorts,
  voiceOverPortsFor,
} from "./product-ad-voice";

type Doc = Record<string, unknown>;

/** Enough of a Mongoose model for the ports: findOne(...).sort().select().lean() and updateOne. */
function fakeModel(docs: Doc[]) {
  const finds: Doc[] = [];
  const updates: Array<{ filter: Doc; update: Doc }> = [];
  let answer: { matchedCount: number; modifiedCount: number } = {
    matchedCount: 1,
    modifiedCount: 1,
  };
  const model = {
    findOne(filter: Doc) {
      finds.push(filter);
      const doc = docs.find((entry) =>
        Object.entries(filter).every(([key, value]) =>
          value === null
            ? entry[key] == null
            : typeof value === "object"
              ? true
              : entry[key] === value,
        ),
      );
      const chain = {
        sort: () => chain,
        select: () => chain,
        lean: async () => doc ?? null,
      };
      return chain;
    },
    async updateOne(filter: Doc, update: Doc) {
      updates.push({ filter, update });
      return answer;
    },
  };
  return {
    model,
    finds,
    updates,
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}

const INPUT = { workspaceId: "ws-1", adId: "ad-1", renderNo: 2 };
const now = new Date("2026-11-03T12:00:00Z");

function ports(
  voices: Doc[],
  imports: Doc[] = [],
  assertAiEnabled: (workspaceId: string) => Promise<void> = async () =>
    undefined,
) {
  const voice = fakeModel(voices);
  const source = fakeModel(imports);
  const value = voiceOverPortsFor(
    {
      ProductVoice: voice.model,
      ProductVideoImport: source.model,
      productImportSpend: { assertAiEnabled },
    } as never,
    INPUT,
    new AbortController().signal,
    () => now,
  );
  return { value, voice, source };
}

test("the company's AI switch is read through the web's spend, for this workspace", async () => {
  const asked: string[] = [];
  const on = ports([], [], async (workspaceId) => {
    asked.push(workspaceId);
  });
  await on.value.clone!.assertAiEnabled();
  assert.deepEqual(asked, ["ws-1"]);

  const off = ports([], [], async () => {
    throw Object.assign(new Error("AI is disabled for this company."), {
      code: "workspace_ai_disabled",
    });
  });
  await assert.rejects(off.value.clone!.assertAiEnabled(), {
    code: "workspace_ai_disabled",
  });
  // Nothing of the voice is touched by the check.
  assert.equal(off.voice.updates.length, 0);
});

test("a ready voice is read by its ElevenLabs id, only the workspace's live one", async () => {
  const { value, voice } = ports([
    {
      _id: "v1",
      workspaceId: "ws-1",
      state: "ready",
      elevenVoiceId: "clone123",
    },
  ]);
  assert.deepEqual(await value.workspaceVoice(), {
    state: "ready",
    voiceId: "clone123",
  });
  assert.deepEqual(voice.finds[0], {
    workspaceId: "ws-1",
    state: { $in: ["pending", "ready"] },
    removedAt: null,
  });
  assert.equal(await ports([]).value.workspaceVoice(), null);
});

test("a pending voice is claimed by one run, then made from its import's video", async () => {
  const { value, voice } = ports(
    [
      {
        _id: "v1",
        workspaceId: "ws-1",
        state: "pending",
        sourceImportId: "imp1",
      },
    ],
    [
      {
        _id: "imp1",
        workspaceId: "ws-1",
        transcript: "[1.0] Hi",
        video: { bucket: "b", path: "v.mp4" },
      },
    ],
  );
  assert.deepEqual(await value.workspaceVoice(), { state: "pending" });
  assert.equal(await value.clone!.claim(), true);
  const claim = voice.updates[0]!;
  assert.equal(claim.filter._id, "v1");
  assert.equal(claim.filter.state, "pending");
  // A retried attempt of the same run takes its own claim back.
  assert.deepEqual(claim.filter.$or, [
    { claimedAt: null },
    { claimedAt: { $lt: new Date(now.getTime() - CLONE_CLAIM_MS) } },
    { claimedBy: "ad-1:2" },
  ]);
  assert.deepEqual(claim.update, {
    $set: { claimedAt: now, claimedBy: "ad-1:2" },
  });
  assert.deepEqual(await value.clone!.source(), {
    video: { bucket: "b", path: "v.mp4" },
    transcript: "[1.0] Hi",
  });

  voice.answer({ matchedCount: 0, modifiedCount: 0 });
  assert.equal(await value.clone!.claim(), false);
});

test("a run lets only its own claim go, leaving the voice pending", async () => {
  const { value, voice } = ports([
    { _id: "v1", workspaceId: "ws-1", state: "pending", sourceImportId: "i" },
  ]);
  await value.workspaceVoice();
  await value.clone!.release();
  assert.deepEqual(voice.updates[0], {
    filter: {
      _id: "v1",
      workspaceId: "ws-1",
      state: "pending",
      claimedBy: "ad-1:2",
    },
    update: { $set: { claimedAt: null, claimedBy: null } },
  });
});

test("a clone left at ElevenLabs under the voice's name is found and deleted; one that can't be is kept on the voice", async () => {
  const savedKey = process.env.ELEVENLABS_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.ELEVENLABS_API_KEY = "test-key";
  const requests: Array<{ url: string; method: string }> = [];
  let deleteStatus = 200;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), method: init.method ?? "GET" });
    if (init.method === "GET")
      return new Response(
        JSON.stringify({
          voices: [
            { voice_id: "lost1", name: "airi products v1" },
            { voice_id: "held1", name: "airi products v1" },
            { voice_id: "other", name: "airi products v12" },
          ],
        }),
        { status: 200 },
      );
    return new Response("{}", { status: deleteStatus });
  }) as typeof fetch;
  try {
    const { value, voice } = ports([
      {
        _id: "v1",
        workspaceId: "ws-1",
        state: "pending",
        sourceImportId: "i",
        elevenVoiceId: "held1",
      },
    ]);
    await value.workspaceVoice();
    await value.clone!.sweep();
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "DELETE"],
    );
    assert.match(requests[1]!.url, /\/v1\/voices\/lost1$/);
    assert.equal(voice.updates.length, 0);

    // ElevenLabs down: the clone's id is kept for "Remove my voice".
    deleteStatus = 503;
    await assert.rejects(value.clone!.remove("lost1"));
    assert.deepEqual(voice.updates.at(-1), {
      filter: { _id: "v1", workspaceId: "ws-1" },
      update: { $addToSet: { orphanVoiceIds: "lost1" } },
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
  }
});

test("the clone a voice holds is read back", async () => {
  const held = ports([
    {
      _id: "v1",
      workspaceId: "ws-1",
      state: "pending",
      sourceImportId: "i",
      elevenVoiceId: "clone123",
      removedAt: null,
    },
  ]);
  await held.value.workspaceVoice();
  assert.equal(await held.value.clone!.savedVoiceId(), "clone123");
});

test("a run that didn't read a pending voice claims nothing", async () => {
  const { value, voice } = ports([]);
  assert.equal(await value.clone!.claim(), false);
  assert.equal(voice.updates.length, 0);
});

test("the outcome is saved only on a voice still pending and not removed", async () => {
  const { value, voice } = ports([
    {
      _id: "v1",
      workspaceId: "ws-1",
      state: "pending",
      sourceImportId: "imp1",
    },
  ]);
  await value.workspaceVoice();
  assert.equal(
    await value.clone!.finish({
      state: "ready",
      elevenVoiceId: "clone123",
      speechSeconds: 31.2,
      costMicros: 90_000,
    }),
    true,
  );
  assert.deepEqual(voice.updates[0]!.filter, {
    _id: "v1",
    workspaceId: "ws-1",
    state: "pending",
    removedAt: null,
  });
  assert.deepEqual(voice.updates[0]!.update, {
    $set: {
      state: "ready",
      elevenVoiceId: "clone123",
      speechSeconds: 31.2,
      costMicros: 90_000,
      errorCode: null,
      errorMessage: null,
      claimedAt: null,
    },
  });
  await value.clone!.finish({
    state: "failed",
    errorCode: "too_little_speech",
    errorMessage: "12 s",
    speechSeconds: 12,
    costMicros: 0,
  });
  assert.equal((voice.updates[1]!.update.$set as Doc).live, false);
  voice.answer({ matchedCount: 0, modifiedCount: 0 });
  assert.equal(
    await value.clone!.finish({
      state: "ready",
      elevenVoiceId: "x",
      speechSeconds: 30,
      costMicros: 0,
    }),
    false,
  );
});

test("without airi's ElevenLabs key there are no ports", async () => {
  const saved = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  try {
    assert.equal(
      await productAdVoiceOverPorts(
        {
          workspaceId: "ws",
          adId: "ad",
          renderNo: 1,
          mode: "make",
          workflowId: "w",
          contractVersion: 1,
        } as never,
        new AbortController().signal,
      ),
      null,
    );
  } finally {
    if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
  }
});
