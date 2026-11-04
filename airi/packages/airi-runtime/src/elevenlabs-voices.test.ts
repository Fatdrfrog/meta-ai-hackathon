import assert from "node:assert/strict";
import test from "node:test";

import {
  ElevenLabsSttError,
  isElevenLabsSttAcceptedRequest,
  isElevenLabsSttRefusedRequest,
} from "./elevenlabs-stt";
import {
  createElevenLabsInstantVoice,
  deleteElevenLabsVoice,
  elevenLabsRequestFailure,
  findElevenLabsVoicesByName,
  isElevenLabsVoicesConfigured,
} from "./elevenlabs-voices";

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const SAMPLE = {
  audio: Buffer.from("RIFF....WAVE"),
  filename: "narration.wav",
  mimeType: "audio/wav",
};

test("a clone posts the name and the recording, and returns the voice id", async () => {
  const { calls, fetch } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({ voice_id: "voice123", requires_verification: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const result = await createElevenLabsInstantVoice(
    { name: "airi ws-1", samples: [SAMPLE], description: "Shop owner" },
    { apiKey: "test-key", fetch },
  );
  assert.deepEqual(result, {
    voiceId: "voice123",
    requiresVerification: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.elevenlabs.io/v1/voices/add");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(calls[0]!.init.headers, { "xi-api-key": "test-key" });
  const form = calls[0]!.init.body as FormData;
  assert.equal(form.get("name"), "airi ws-1");
  assert.equal(form.get("remove_background_noise"), "false");
  assert.equal(form.get("description"), "Shop owner");
  const file = form.get("files") as File;
  assert.equal(file.name, "narration.wav");
  assert.equal(file.type, "audio/wav");
});

test("a clone without a name, a recording or a key is refused before any call", async () => {
  const { calls, fetch } = fakeFetch(() => new Response("{}"));
  for (const [input, key] of [
    [{ name: " ", samples: [SAMPLE] }, "k"],
    [{ name: "x", samples: [{ ...SAMPLE, audio: Buffer.alloc(0) }] }, "k"],
    [{ name: "x", samples: [SAMPLE] }, ""],
  ] as const) {
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const error = await createElevenLabsInstantVoice(
        { ...input, samples: [...input.samples] },
        { apiKey: key, fetch },
      ).catch((e: unknown) => e);
      assert.ok(error instanceof ElevenLabsSttError);
      assert.equal(isElevenLabsSttRefusedRequest(error), true);
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
    }
  }
  assert.equal(calls.length, 0);
});

test("a refused clone (4xx) is not transient; an outage is, and a lost 2xx answer is accepted", async () => {
  const refused = await createElevenLabsInstantVoice(
    { name: "x", samples: [SAMPLE] },
    {
      apiKey: "k",
      fetch: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              detail: [{ msg: "too short", loc: [], type: "x" }],
            }),
            { status: 422 },
          ),
      ).fetch,
    },
  ).catch((e: unknown) => e);
  assert.ok(refused instanceof ElevenLabsSttError);
  assert.equal(refused.info.transient, false);
  assert.equal(refused.info.message, "too short");
  assert.equal(isElevenLabsSttRefusedRequest(refused), true);

  const outage = await createElevenLabsInstantVoice(
    { name: "x", samples: [SAMPLE] },
    {
      apiKey: "k",
      fetch: fakeFetch(() => new Response("", { status: 503 })).fetch,
    },
  ).catch((e: unknown) => e);
  assert.ok(outage instanceof ElevenLabsSttError);
  assert.equal(outage.info.transient, true);
  assert.equal(isElevenLabsSttRefusedRequest(outage), false);

  const lost = await createElevenLabsInstantVoice(
    { name: "x", samples: [SAMPLE] },
    {
      apiKey: "k",
      fetch: fakeFetch(() => new Response("{}", { status: 200 })).fetch,
    },
  ).catch((e: unknown) => e);
  assert.ok(lost instanceof ElevenLabsSttError);
  assert.equal(isElevenLabsSttAcceptedRequest(lost), true);
});

test("deleting a voice calls DELETE; one ElevenLabs no longer has counts as deleted", async () => {
  const ok = fakeFetch(() => new Response(JSON.stringify({ status: "ok" })));
  assert.deepEqual(
    await deleteElevenLabsVoice("voice123", { apiKey: "k", fetch: ok.fetch }),
    { deleted: true, found: true },
  );
  assert.equal(
    ok.calls[0]!.url,
    "https://api.elevenlabs.io/v1/voices/voice123",
  );
  assert.equal(ok.calls[0]!.init.method, "DELETE");

  const gone = fakeFetch(() => new Response("{}", { status: 404 }));
  assert.deepEqual(
    await deleteElevenLabsVoice("voice123", { apiKey: "k", fetch: gone.fetch }),
    { deleted: true, found: false },
  );

  // ElevenLabs' own answer to a second DELETE (paid gate, 2026-11-03).
  const deletedBefore = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          detail: {
            type: "not_found",
            code: "voice_not_found",
            message: "A voice with ID 'voice123' was not found.",
            status: "voice_does_not_exist",
          },
        }),
        { status: 400 },
      ),
  );
  assert.deepEqual(
    await deleteElevenLabsVoice("voice123", {
      apiKey: "k",
      fetch: deletedBefore.fetch,
    }),
    { deleted: true, found: false },
  );

  // Any other refusal is still a failure: the voice may still be there.
  const refused = fakeFetch(
    () =>
      new Response(JSON.stringify({ detail: "Invalid request" }), {
        status: 400,
      }),
  );
  await assert.rejects(
    deleteElevenLabsVoice("voice123", { apiKey: "k", fetch: refused.fetch }),
    ElevenLabsSttError,
  );

  const down = fakeFetch(() => new Response("", { status: 500 }));
  await assert.rejects(
    deleteElevenLabsVoice("voice123", { apiKey: "k", fetch: down.fetch }),
    ElevenLabsSttError,
  );
  await assert.rejects(
    deleteElevenLabsVoice("../x", { apiKey: "k", fetch: down.fetch }),
    ElevenLabsSttError,
  );
});

test("voices are found by their exact name among the account's own", async () => {
  const { calls, fetch } = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          voices: [
            { voice_id: "clone1", name: "airi products v1" },
            // The search matches parts of names too: only the exact one counts.
            { voice_id: "clone2", name: "airi products v10" },
            { voice_id: "clone3", name: "airi products v1" },
          ],
          has_more: false,
        }),
        { status: 200 },
      ),
  );
  assert.deepEqual(
    await findElevenLabsVoicesByName("airi products v1", {
      apiKey: "k",
      fetch,
    }),
    ["clone1", "clone3"],
  );
  const url = new URL(calls[0]!.url);
  assert.equal(
    url.origin + url.pathname,
    "https://api.elevenlabs.io/v2/voices",
  );
  assert.equal(url.searchParams.get("search"), "airi products v1");
  assert.equal(url.searchParams.get("voice_type"), "personal");
  assert.equal(calls[0]!.init.method, "GET");

  assert.deepEqual(
    await findElevenLabsVoicesByName("  ", { apiKey: "k", fetch }),
    [],
  );
  assert.equal(calls.length, 1);

  const down = fakeFetch(() => new Response("", { status: 503 }));
  await assert.rejects(
    findElevenLabsVoicesByName("airi products v1", {
      apiKey: "k",
      fetch: down.fetch,
    }),
    ElevenLabsSttError,
  );
});

test("a request cut by the caller's signal is a transient timeout", async () => {
  const controller = new AbortController();
  const fetch = (async (_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
      controller.abort();
    })) as unknown as typeof globalThis.fetch;
  const error = await deleteElevenLabsVoice("voice123", {
    apiKey: "k",
    fetch,
    signal: controller.signal,
  }).catch((e: unknown) => e);
  assert.ok(error instanceof ElevenLabsSttError);
  assert.equal(error.info.kind, "timeout");
  assert.equal(error.info.transient, true);
});

test("failures map by status, and the key is read from the environment", () => {
  assert.equal(elevenLabsRequestFailure(401, "").info.kind, "auth");
  assert.equal(elevenLabsRequestFailure(429, "").info.transient, true);
  assert.equal(elevenLabsRequestFailure(400, "").info.kind, "invalid_request");
  assert.equal(elevenLabsRequestFailure(502, "").info.kind, "server");
  const saved = process.env.ELEVENLABS_API_KEY;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    assert.equal(isElevenLabsVoicesConfigured(), false);
    assert.equal(isElevenLabsVoicesConfigured("k"), true);
    process.env.ELEVENLABS_API_KEY = "env-key";
    assert.equal(isElevenLabsVoicesConfigured(), true);
  } finally {
    if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = saved;
  }
});
