import {
  getOrCreateVideoGenerationIdempotencyKey,
  retireVideoGenerationIdempotencyKey,
} from "./video-generation-idempotency";

describe("video generation idempotency keys", () => {
  it("reuses a key for the same endpoint and serialized body until retired", () => {
    const keys = new Map<string, string>();
    const createKey = jest
      .fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const endpoint = "/api/workspaces/workspace-1/assets/generate/higgsfield";
    const body = JSON.stringify({ mode: "image_to_video", prompt: "Orbit" });

    expect(
      getOrCreateVideoGenerationIdempotencyKey(keys, endpoint, body, createKey)
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(
      getOrCreateVideoGenerationIdempotencyKey(keys, endpoint, body, createKey)
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(createKey).toHaveBeenCalledTimes(1);

    retireVideoGenerationIdempotencyKey(keys, endpoint, body);

    expect(
      getOrCreateVideoGenerationIdempotencyKey(keys, endpoint, body, createKey)
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("keeps different request recipes isolated", () => {
    const keys = new Map<string, string>();
    const createKey = jest
      .fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

    const first = getOrCreateVideoGenerationIdempotencyKey(
      keys,
      "/generate/higgsfield",
      JSON.stringify({ prompt: "First" }),
      createKey
    );
    const second = getOrCreateVideoGenerationIdempotencyKey(
      keys,
      "/generate/higgsfield",
      JSON.stringify({ prompt: "Second" }),
      createKey
    );

    expect(first).not.toBe(second);
  });
});
