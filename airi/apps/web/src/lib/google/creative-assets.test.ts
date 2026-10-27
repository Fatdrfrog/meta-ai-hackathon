/**
 * @jest-environment node
 */

import {
  assertGoogleMediaUrl,
  describeGoogleCreativeApiError,
  submitGoogleImageGeneration,
  downloadGoogleVideoResult,
  getGoogleMediaHostAllowlist,
  GoogleCreativeApiError,
  GoogleCreativeProtocolError,
  pollGoogleVideoOperation,
  pollGoogleVideoOperationContractV1,
  prepareGoogleVideoGenerationContractV1,
} from "./creative-assets";

const startGoogleVideoGenerationContractV1 = async (
  input: Parameters<typeof prepareGoogleVideoGenerationContractV1>[0]
) => prepareGoogleVideoGenerationContractV1(input)();

describe("Google creative-assets contract-v1 video client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, GEMINI_API_KEY: "google-key" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("requires a customer key for new submissions even with a platform key", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}"));
    await expect(
      submitGoogleImageGeneration({ prompt: "A mountain" })
    ).rejects.toMatchObject({ code: "own_ai_source_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the customer key for image submission, polling and download", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_image: { data: "aGVsbG8=", mime_type: "image/png" },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ name: "operations/customer", done: false })
        )
      )
      .mockResolvedValueOnce(new Response("video"));
    await submitGoogleImageGeneration({
      prompt: "A mountain",
      apiKey: "customer-key",
    });
    await pollGoogleVideoOperationContractV1(
      "operations/customer",
      "customer-key"
    );
    await downloadGoogleVideoResult(
      {
        uri: "https://generativelanguage.googleapis.com/video",
        mimeType: "video/mp4",
      },
      "customer-key"
    );
    for (const [, request] of fetchMock.mock.calls) {
      expect(request?.headers).toEqual(
        expect.objectContaining({ "x-goog-api-key": "customer-key" })
      );
    }
  });

  it("sends the selected image model and ordered references without rewriting the prompt", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "interaction-1",
          output_image: { data: "aGVsbG8=", mime_type: "image/png" },
        })
      )
    );
    const prompt = "  Keep the medal holder shape.\nName: Айя  ";
    const result = await submitGoogleImageGeneration({
      apiKey: "customer-key",
      prompt,
      modelId: "gemini-3-pro-image",
      aspectRatio: "16:9",
      images: [
        { data: "b25l", mimeType: "image/jpeg" },
        { data: "dHdv", mimeType: "image/png" },
      ],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model: "gemini-3-pro-image",
      input: [
        { type: "text", text: prompt },
        { type: "image", data: "b25l", mime_type: "image/jpeg" },
        { type: "image", data: "dHdv", mime_type: "image/png" },
      ],
      response_format: { aspect_ratio: "16:9" },
    });
    expect(result.raw).toEqual({ id: "interaction-1" });
  });

  // The REST body has no top-level output_image: Google's SDKs derive it from
  // the steps (@google/genai addOutputProperties).
  it("reads the generated image from the interaction steps the REST API returns", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "interaction-2",
          steps: [
            {
              type: "thought",
              summary: [
                { type: "image", data: "ZHJhZnQ=", mime_type: "image/png" },
              ],
            },
            {
              type: "model_output",
              content: [
                { type: "text", text: "Here is the medal holder." },
                { type: "image", data: "aGVsbG8=", mime_type: "image/jpeg" },
              ],
            },
          ],
        })
      )
    );
    const result = await submitGoogleImageGeneration({
      apiKey: "customer-key",
      prompt: "Medal holder",
    });
    expect(result.buffer.toString()).toBe("hello");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.fileName).toBe("google-generated-image.jpg");
    expect(result.raw).toEqual({ id: "interaction-2" });
  });

  it("does not return an image from before the latest user input", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          steps: [
            {
              type: "model_output",
              content: [
                { type: "image", data: "b2xk", mime_type: "image/png" },
              ],
            },
            { type: "user_input", content: [{ type: "text", text: "Again" }] },
            {
              type: "model_output",
              content: [{ type: "text", text: "I can't draw that." }],
            },
          ],
        })
      )
    );
    await expect(
      submitGoogleImageGeneration({ apiKey: "customer-key", prompt: "Again" })
    ).rejects.toThrow("Google image generation did not return image data");
  });

  it.each([
    { modelId: "unapproved-model" },
    { aspectRatio: "400:1" },
    {
      images: Array.from({ length: 4 }, () => ({
        data: "b25l",
        mimeType: "image/png",
      })),
    },
    { images: [{ data: "b25l", mimeType: "image/svg+xml" }] },
    // Scenario references are PNG or JPEG only; WebP is outside the shared rule.
    { images: [{ data: "b25l", mimeType: "image/webp" }] },
    { images: [{ data: "not-base64!!", mimeType: "image/png" }] },
  ])(
    "rejects unsupported image configuration before provider submission: %j",
    async configuration => {
      const fetchMock = jest
        .spyOn(global, "fetch")
        .mockRejectedValue(new Error("Unexpected provider call"));
      await expect(
        submitGoogleImageGeneration({
          apiKey: "customer-key",
          prompt: "Test",
          ...configuration,
        })
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("keeps Google's image rejection without key material", async () => {
    const leakedKey = `AIza${"x".repeat(35)}`;
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: `Requests from this key are blocked: ${leakedKey}`,
            status: "PERMISSION_DENIED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_SERVICE_BLOCKED",
              },
            ],
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      )
    );

    const error = await submitGoogleImageGeneration({
      apiKey: "customer-key",
      prompt: "Test",
    }).catch(value => value);

    expect(error).toBeInstanceOf(GoogleCreativeApiError);
    expect(error.message).toBe("Google image generation failed: HTTP 403");
    expect(describeGoogleCreativeApiError(error)).toEqual({
      httpStatus: 403,
      status: "PERMISSION_DENIED",
      reason: "API_KEY_SERVICE_BLOCKED",
      message: "Requests from this key are blocked: [redacted]",
    });
  });

  it("bounds image provider response size", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", {
        headers: { "content-length": String(32 * 1024 * 1024) },
      })
    );
    await expect(
      submitGoogleImageGeneration({
        apiKey: "customer-key",
        prompt: "Test",
      })
    ).rejects.toMatchObject({ code: "provider_response_too_large" });
  });

  it.each(["4:5", "5:4"])(
    "preserves supported banner aspect ratio %s",
    async aspectRatio => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_image: { data: "aGVsbG8=", mime_type: "image/png" },
          })
        )
      );
      await submitGoogleImageGeneration({
        apiKey: "customer-key",
        prompt: "Banner",
        aspectRatio,
      });
      expect(
        JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      ).toMatchObject({ response_format: { aspect_ratio: aspectRatio } });
    }
  );

  it("sends the compiled prompt exactly", async () => {
    const prompt = "SENTINEL compiled prompt\nCamera: locked-off.";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "operations/video-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await startGoogleVideoGenerationContractV1({
      apiKey: "google-key",
      modelId: "veo-frozen",
      prompt,
      aspectRatio: "9:16",
      durationSeconds: 6,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.instances[0].prompt).toBe(prompt);
  });

  it("freezes key, model, and exact body before the prepared POST is invoked", async () => {
    process.env.GOOGLE_VIDEO_GENERATION_MODEL = "veo-prepared";
    const post = prepareGoogleVideoGenerationContractV1({
      apiKey: "google-key",
      modelId: "veo-prepared",
      prompt: "SENTINEL prepared prompt",
      aspectRatio: "9:16",
      durationSeconds: 6,
    });
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_VIDEO_GENERATION_MODEL = "veo-changed";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ name: "operations/video-prepared" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await post();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/models/veo-prepared:predictLongRunning"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-goog-api-key": "google-key" }),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      instances: [{ prompt: "SENTINEL prepared prompt" }],
    });
  });

  it("validates the strict prompt during preparation", () => {
    expect(() =>
      prepareGoogleVideoGenerationContractV1({
        apiKey: "google-key",
        modelId: "veo-frozen",
        prompt: " padded ",
        aspectRatio: "9:16",
        durationSeconds: 6,
      })
    ).toThrow(expect.objectContaining({ code: "prompt_not_canonical" }));
  });

  it("rejects padded and oversized strict prompts before fetch", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error("Unexpected provider call"));
    const submit = (prompt: string) =>
      startGoogleVideoGenerationContractV1({
        apiKey: "google-key",
        modelId: "veo-frozen",
        prompt,
        aspectRatio: "9:16",
        durationSeconds: 6,
      });

    await expect(submit(" compiled prompt ")).rejects.toMatchObject({
      code: "prompt_not_canonical",
      message: "Video prompt must not include leading or trailing whitespace",
    });
    await expect(submit("x".repeat(1201))).rejects.toMatchObject({
      code: "prompt_too_long_for_provider",
      maxLength: 1200,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an oversized strict contract-v1 submit response", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "operations/video-1",
          padding: "x".repeat(1_100_000),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      startGoogleVideoGenerationContractV1({
        apiKey: "google-key",
        modelId: "veo-frozen",
        prompt: "Compiled prompt",
        aspectRatio: "9:16",
        durationSeconds: 6,
      })
    ).rejects.toMatchObject({ code: "provider_response_too_large" });

    const signal = fetchMock.mock.calls[0][1]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a trickling strict contract-v1 poll response at its deadline", async () => {
    jest.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            new TextEncoder().encode(
              '{"name":"operations/video-1","done":false'
            )
          );
        },
        cancel() {
          streamCancelled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(response);
    const pending = pollGoogleVideoOperationContractV1("operations/video-1");
    let settled = false;
    let caught: unknown;
    void pending.then(
      () => {
        settled = true;
      },
      error => {
        settled = true;
        caught = error;
      }
    );

    await jest.advanceTimersByTimeAsync(60_001);
    try {
      expect(settled).toBe(true);
      expect(caught).toMatchObject({ code: "provider_response_timeout" });
      const signal = fetchMock.mock.calls[0][1]?.signal as
        | AbortSignal
        | undefined;
      expect(signal?.aborted).toBe(true);
      expect(streamCancelled).toBe(true);
    } finally {
      if (!settled) {
        streamController.error(new Error("test cleanup"));
        await pending.catch(() => undefined);
      }
    }
  });

  it.each([400, 422, 500, 503])(
    "preserves HTTP %s and JSON diagnostics in a typed video submit error",
    async statusCode => {
      jest.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: statusCode, message: "provider diagnostic" },
          }),
          {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      const error = await startGoogleVideoGenerationContractV1({
        apiKey: "google-key",
        modelId: "veo-frozen",
        prompt: "Compiled prompt",
        aspectRatio: "9:16",
        durationSeconds: 6,
      }).catch(value => value);

      expect(error).toBeInstanceOf(GoogleCreativeApiError);
      expect(error).toMatchObject({
        statusCode,
        payload: {
          error: { code: statusCode, message: "provider diagnostic" },
        },
      });
    }
  );

  it("rejects malformed successful operation polls only on the strict-v1 seam", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    await expect(
      pollGoogleVideoOperationContractV1("operations/video-1")
    ).rejects.toBeInstanceOf(GoogleCreativeProtocolError);
    await expect(
      pollGoogleVideoOperation("operations/video-1")
    ).resolves.toMatchObject({
      name: "operations/video-1",
      done: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps strict poll HTTP diagnostics typed without changing the legacy error", async () => {
    const payload = {
      error: { code: 503, message: "provider temporarily unavailable" },
    };
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      );

    await expect(
      pollGoogleVideoOperationContractV1("operations/video-1")
    ).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
      payload,
    });

    const legacyError = await pollGoogleVideoOperation(
      "operations/video-1"
    ).catch(error => error);
    expect(legacyError).toBeInstanceOf(Error);
    expect(legacyError).not.toBeInstanceOf(GoogleCreativeApiError);
    expect(legacyError.message).toContain("provider temporarily unavailable");
  });

  it("preserves legacy submit error behavior while strict-v1 keeps typed diagnostics", async () => {
    const payload = {
      error: { code: 422, message: "legacy provider diagnostic" },
    };
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        })
      );

    await expect(
      startGoogleVideoGenerationContractV1({
        apiKey: "google-key",
        modelId: "veo-frozen",
        prompt: "Compiled prompt",
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      payload,
    });
  });

  it("exports the canonical Google media host policy for worker finalization", () => {
    expect(getGoogleMediaHostAllowlist()).toContain(
      "generativelanguage.googleapis.com"
    );
    expect(
      assertGoogleMediaUrl(
        "https://generativelanguage.googleapis.com/v1beta/files/video-1?alt=media"
      ).hostname
    ).toBe("generativelanguage.googleapis.com");
    expect(() =>
      assertGoogleMediaUrl("https://attacker.example/video.mp4")
    ).toThrow(/not allowed/i);
  });
});
it("does not expose a provider response body in customer image errors", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: { message: "Echo customer-secret-key private prompt" },
        }),
        { status: 403 }
      )
  ) as typeof fetch;
  try {
    await expect(
      submitGoogleImageGeneration({
        apiKey: "customer-secret-key",
        prompt: "private prompt",
      })
    ).rejects.toThrow("Google image generation failed: HTTP 403");
  } finally {
    global.fetch = originalFetch;
  }
});
