/**
 * @jest-environment node
 */

import {
  assertElevenLabsImageUrl,
  describeElevenLabsImageApiError,
  ElevenLabsImageApiError,
  ElevenLabsImageGenerationFailedError,
  ElevenLabsImageStillRunningError,
  readElevenLabsImageFailureMessage,
  readElevenLabsImageRejectionMessage,
  submitElevenLabsImageGeneration,
  waitForElevenLabsImageGeneration,
} from "./image-generation";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A clock that moves only when the waiter sleeps. */
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

describe("ElevenLabs image generation client", () => {
  afterEach(() => jest.restoreAllMocks());

  it("submits the model, prompt, shape, 1K resolution and inline references", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(json({ id: "generation-1", status: "pending" }));
    const prompt = "Keep the medal holder. Name: «Әлия»";
    await expect(
      submitElevenLabsImageGeneration({
        apiKey: "customer-key",
        modelId: "gemini-3.1-flash-image",
        prompt,
        aspectRatio: "16:9",
        images: [{ data: "aGVsbG8=", mimeType: "image/jpeg" }],
      })
    ).resolves.toEqual({ generationId: "generation-1" });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/flows/image");
    expect(request?.headers).toMatchObject({ "xi-api-key": "customer-key" });
    expect(JSON.parse(String(request?.body))).toEqual({
      model_id: "gemini-3.1-flash-image",
      prompt,
      aspect_ratio: "16:9",
      resolution: "1K",
      images: [
        {
          type: "inline_base64",
          content_base64: "aGVsbG8=",
          mime_type: "image/jpeg",
        },
      ],
    });
  });

  it.each([
    { modelId: "gemini-2.5-flash-image" },
    { aspectRatio: "400:1" },
    { images: [{ data: "aGVsbG8=", mimeType: "image/webp" }] },
  ])("refuses an unsupported request before any charge: %j", async change => {
    const fetchMock = jest.spyOn(global, "fetch");
    await expect(
      submitElevenLabsImageGeneration({
        apiKey: "customer-key",
        modelId: "gemini-3.1-flash-image",
        prompt: "Medal",
        aspectRatio: "16:9",
        images: [],
        ...change,
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps ElevenLabs' refusal typed and without the key", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      json(
        {
          detail: {
            status: "paid_plan_required",
            message: "customer-key cannot use image generation",
          },
        },
        402
      )
    );
    const error = await submitElevenLabsImageGeneration({
      apiKey: "customer-key",
      modelId: "gpt-image-2.5-flare",
      prompt: "Medal",
      aspectRatio: "16:9",
      images: [],
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ElevenLabsImageApiError);
    expect(
      describeElevenLabsImageApiError(
        error as ElevenLabsImageApiError,
        "customer-key"
      )
    ).toEqual({
      httpStatus: 402,
      status: "paid_plan_required",
      message: "[redacted] cannot use image generation",
    });
    expect(
      readElevenLabsImageRejectionMessage(error as ElevenLabsImageApiError)
    ).toContain("Pro plan");
  });

  it("names only definite refusals as rejections", () => {
    const rejection = (status: number) =>
      readElevenLabsImageRejectionMessage(
        new ElevenLabsImageApiError(status, null)
      );
    expect(rejection(401)).toContain("key");
    expect(rejection(422)).toBe("ElevenLabs rejected the image request.");
    expect(rejection(429)).toContain("limiting");
    expect(rejection(408)).toBeNull();
    expect(rejection(500)).toBeNull();
    expect(readElevenLabsImageFailureMessage("moderated")).toContain(
      "content policy"
    );
    expect(readElevenLabsImageFailureMessage("charging_failed")).toContain(
      "credits"
    );
    expect(readElevenLabsImageFailureMessage("model_error")).toBe(
      "ElevenLabs could not generate the image this time."
    );
  });

  it("waits through pending and generating with backoff until completed", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(json({ id: "generation-1", status: "pending" }))
      .mockResolvedValueOnce(json({ id: "generation-1", status: "generating" }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ id: "generation-1", status: "generating" }))
      .mockResolvedValueOnce(
        json({
          id: "generation-1",
          status: "completed",
          content_url: "https://storage.googleapis.com/bucket/image.png?sig=1",
          content_mime_type: "image/png",
        })
      );
    const clock = fakeClock();
    await expect(
      waitForElevenLabsImageGeneration({
        apiKey: "customer-key",
        generationId: "generation-1",
        ...clock,
      })
    ).resolves.toEqual({
      contentUrl: "https://storage.googleapis.com/bucket/image.png?sig=1",
      mimeType: "image/png",
    });
    expect(clock.sleeps).toEqual([2000, 4000, 8000, 15000, 15000]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.elevenlabs.io/v1/flows/image/generation-1"
    );
  });

  it("reports a failed generation with its reason", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      json({
        id: "generation-1",
        status: "failed",
        failure_reason: "moderated",
      })
    );
    const error = await waitForElevenLabsImageGeneration({
      apiKey: "customer-key",
      generationId: "generation-1",
      ...fakeClock(),
    }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ElevenLabsImageGenerationFailedError);
    expect(error).toMatchObject({ failureReason: "moderated" });
  });

  it("stops at a definite read refusal and at the deadline", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(json({}, 404));
    await expect(
      waitForElevenLabsImageGeneration({
        apiKey: "customer-key",
        generationId: "generation-1",
        ...fakeClock(),
      })
    ).rejects.toMatchObject({ statusCode: 404 });

    jest
      .spyOn(global, "fetch")
      .mockImplementation(async () =>
        json({ id: "generation-1", status: "generating" })
      );
    await expect(
      waitForElevenLabsImageGeneration({
        apiKey: "customer-key",
        generationId: "generation-1",
        timeoutMs: 60_000,
        ...fakeClock(),
      })
    ).rejects.toBeInstanceOf(ElevenLabsImageStillRunningError);
  });

  it("downloads only over HTTPS from ElevenLabs' storage", () => {
    expect(
      assertElevenLabsImageUrl(
        "https://storage.googleapis.com/bucket/image.png?sig=1"
      ).hostname
    ).toBe("storage.googleapis.com");
    expect(() =>
      assertElevenLabsImageUrl("http://storage.googleapis.com/image.png")
    ).toThrow();
    expect(() =>
      assertElevenLabsImageUrl("https://storage.googleapis.com.evil.test/a")
    ).toThrow();
    expect(() =>
      assertElevenLabsImageUrl("https://169.254.169.254/")
    ).toThrow();
  });
});
