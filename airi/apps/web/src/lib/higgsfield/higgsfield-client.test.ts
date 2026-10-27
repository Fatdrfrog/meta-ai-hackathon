import {
  buildHiggsfieldGenerationRequest,
  extractHiggsfieldResultUrl,
  fetchHiggsfieldRequestStatus,
  fetchHiggsfieldRequestStatusContractV1,
  getHiggsfieldAuthHeader,
  getHiggsfieldImageModel,
  getHiggsfieldImageToVideoModel,
  HiggsfieldApiError,
  isPermanentHiggsfieldApiError,
  normalizeHiggsfieldStartResponse,
  normalizeHiggsfieldProviderStatus,
  normalizeHiggsfieldStartResponseContractV1,
  prepareHiggsfieldGenerationContractV1,
  submitHiggsfieldGeneration,
} from "./higgsfield-client";

const submitHiggsfieldGenerationContractV1 = async (
  input: Parameters<typeof prepareHiggsfieldGenerationContractV1>[0]
) => prepareHiggsfieldGenerationContractV1(input)();

describe("Higgsfield client helpers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.HIGGSFIELD_KEY;
    delete process.env.HIGGSFIELD_API_KEY;
    delete process.env.HIGGSFIELD_API_SECRET;
    delete process.env.HIGGSFIELD_IMAGE_MODEL;
    delete process.env.HIGGSFIELD_IMAGE_TO_VIDEO_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("uses default official model ids and supports platform credentials", () => {
    process.env.HIGGSFIELD_API_KEY = "key-1";
    process.env.HIGGSFIELD_API_SECRET = "secret-1";

    expect(getHiggsfieldAuthHeader()).toBe("Key key-1:secret-1");
    expect(getHiggsfieldImageModel()).toBe("higgsfield-ai/soul/standard");
    expect(getHiggsfieldImageToVideoModel()).toBe("higgsfield-ai/dop/standard");
  });

  it("builds text-to-image and image-to-video request payloads", () => {
    expect(
      buildHiggsfieldGenerationRequest({
        mode: "text_to_image",
        prompt: "Premium soup product photo",
        aspectRatio: "9:16",
        resolution: "720p",
      })
    ).toEqual({
      modelId: "higgsfield-ai/soul/standard",
      body: {
        prompt: "Premium soup product photo",
        aspect_ratio: "9:16",
        resolution: "720p",
      },
    });

    expect(
      buildHiggsfieldGenerationRequest({
        mode: "image_to_video",
        prompt: "Slow camera push and steam movement",
        imageUrl: "https://cdn.example.com/soup.png",
        duration: 5,
      })
    ).toEqual({
      modelId: "higgsfield-ai/dop/standard",
      body: {
        image_url: "https://cdn.example.com/soup.png",
        prompt: "Slow camera push and steam movement",
        duration: 5,
      },
    });
  });

  it("normalizes queued responses and extracts final media URLs", () => {
    expect(
      normalizeHiggsfieldStartResponse({
        status: "queued",
        request_id: "request-1",
        status_url: "https://platform.higgsfield.ai/requests/request-1/status",
        cancel_url: "https://platform.higgsfield.ai/requests/request-1/cancel",
      })
    ).toEqual({
      status: "queued",
      requestId: "request-1",
      statusUrl: "https://platform.higgsfield.ai/requests/request-1/status",
      cancelUrl: "https://platform.higgsfield.ai/requests/request-1/cancel",
    });

    expect(
      extractHiggsfieldResultUrl(
        {
          status: "completed",
          request_id: "request-1",
          images: [{ url: "https://images.example.com/out.jpg" }],
        },
        "image"
      )
    ).toBe("https://images.example.com/out.jpg");

    expect(
      extractHiggsfieldResultUrl(
        {
          status: "completed",
          request_id: "request-2",
          video: { url: "https://videos.example.com/out.mp4" },
        },
        "video"
      )
    ).toBe("https://videos.example.com/out.mp4");
  });

  it("rejects unknown statuses in contract-v1 while retaining legacy queued fallback", () => {
    expect(normalizeHiggsfieldProviderStatus("future_status")).toBe("queued");
    expect(() =>
      normalizeHiggsfieldStartResponseContractV1({
        status: "future_status",
        request_id: "request-1",
      })
    ).toThrow(expect.objectContaining({ code: "unknown_provider_status" }));
  });

  it("sends the strict contract-v1 prompt exactly", async () => {
    process.env.HIGGSFIELD_KEY = "key-1";
    const prompt = "SENTINEL compiled prompt\nCamera: locked-off.";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "queued", request_id: "request-1" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    await submitHiggsfieldGenerationContractV1({
      mode: "image_to_video",
      modelId: "higgsfield-ai/frozen/model",
      prompt,
      imageUrl: "https://storage.example.com/source.jpg",
      webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.prompt).toBe(prompt);
    fetchMock.mockRestore();
  });

  it("freezes auth and the exact strict request before the prepared POST is invoked", async () => {
    process.env.HIGGSFIELD_KEY = "prepared-key";
    process.env.HIGGSFIELD_IMAGE_TO_VIDEO_MODEL =
      "higgsfield-ai/prepared/model";
    const post = prepareHiggsfieldGenerationContractV1({
      mode: "image_to_video",
      modelId: "higgsfield-ai/prepared/model",
      prompt: "SENTINEL prepared prompt",
      imageUrl: "https://storage.example.com/source.jpg",
      webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
      duration: 5,
    });
    delete process.env.HIGGSFIELD_KEY;
    process.env.HIGGSFIELD_IMAGE_TO_VIDEO_MODEL = "higgsfield-ai/changed/model";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "queued", request_id: "request-1" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await post();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/higgsfield-ai/prepared/model?"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Key prepared-key" }),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      image_url: "https://storage.example.com/source.jpg",
      prompt: "SENTINEL prepared prompt",
      duration: 5,
    });
  });

  it("validates a strict request during preparation", () => {
    process.env.HIGGSFIELD_KEY = "key-1";
    expect(() =>
      prepareHiggsfieldGenerationContractV1({
        mode: "image_to_video",
        modelId: "higgsfield-ai/frozen/model",
        prompt: " padded ",
        imageUrl: "https://storage.example.com/source.jpg",
        webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
      })
    ).toThrow(expect.objectContaining({ code: "prompt_not_canonical" }));
    expect(() =>
      prepareHiggsfieldGenerationContractV1({
        mode: "image_to_video",
        modelId: "higgsfield-ai/frozen/model",
        prompt: "Compiled prompt",
        imageUrl: "",
        webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
      })
    ).toThrow(/Source image URL is required/);
  });

  it("rejects padded and oversized strict contract-v1 prompts before fetch", async () => {
    process.env.HIGGSFIELD_KEY = "key-1";
    const fetchMock = jest.spyOn(global, "fetch");
    const submit = (prompt: string) =>
      submitHiggsfieldGenerationContractV1({
        mode: "image_to_video",
        modelId: "higgsfield-ai/frozen/model",
        prompt,
        imageUrl: "https://storage.example.com/source.jpg",
        webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
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
    process.env.HIGGSFIELD_KEY = "key-1";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "queued",
          request_id: "request-1",
          padding: "x".repeat(1_100_000),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      submitHiggsfieldGenerationContractV1({
        mode: "image_to_video",
        modelId: "higgsfield-ai/frozen/model",
        prompt: "Compiled prompt",
        imageUrl: "https://storage.example.com/source.jpg",
        webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
      })
    ).rejects.toMatchObject({ code: "provider_response_too_large" });

    const signal = fetchMock.mock.calls[0][1]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a trickling strict contract-v1 status response at its deadline", async () => {
    process.env.HIGGSFIELD_KEY = "key-1";
    jest.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            new TextEncoder().encode(
              '{"status":"in_progress","request_id":"request-1"'
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
    const pending = fetchHiggsfieldRequestStatusContractV1({
      requestId: "request-1",
    });
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

  it("fetches request status using the stored provider status URL", async () => {
    process.env.HIGGSFIELD_API_KEY = "key-1";
    process.env.HIGGSFIELD_API_SECRET = "secret-1";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "completed",
          request_id: "request-1",
          images: [{ url: "https://images.example.com/out.jpg" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      fetchHiggsfieldRequestStatus({
        statusUrl: "https://platform.higgsfield.ai/requests/request-1/status",
      })
    ).resolves.toEqual({
      status: "completed",
      request_id: "request-1",
      images: [{ url: "https://images.example.com/out.jpg" }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.higgsfield.ai/requests/request-1/status",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Key key-1:secret-1",
        }),
      })
    );

    fetchMock.mockRestore();
  });

  it("keeps strict poll HTTP diagnostics structured without changing the legacy error", async () => {
    process.env.HIGGSFIELD_API_KEY = "key-1";
    process.env.HIGGSFIELD_API_SECRET = "secret-1";
    const payload = {
      token: "leaked-secret",
      error: "request access denied",
    };
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(payload), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      );

    const strictError = await fetchHiggsfieldRequestStatusContractV1({
      requestId: "request-1",
    }).catch(error => error);
    expect(strictError).toBeInstanceOf(HiggsfieldApiError);
    expect(strictError).toMatchObject({
      statusCode: 401,
      retryable: false,
      payload,
    });

    const legacyError = await fetchHiggsfieldRequestStatus({
      requestId: "request-1",
    }).catch(error => error);
    expect(legacyError).toBeInstanceOf(Error);
    expect(legacyError).not.toBeInstanceOf(HiggsfieldApiError);
    expect(legacyError.message).toContain("leaked-secret");
  });

  it("uses explicit source credentials instead of platform env credentials", async () => {
    process.env.HIGGSFIELD_API_KEY = "platform-key";
    process.env.HIGGSFIELD_API_SECRET = "platform-secret";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "queued",
          request_id: "request-1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await submitHiggsfieldGeneration({
      mode: "text_to_image",
      prompt: "Premium soup product photo",
      webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
      authKey: "workspace-key:workspace-secret",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://platform.higgsfield.ai/"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Key workspace-key:workspace-secret",
        }),
      })
    );

    fetchMock.mockRestore();
  });

  it("rejects status URLs outside the Higgsfield platform origin", async () => {
    process.env.HIGGSFIELD_API_KEY = "key-1";
    process.env.HIGGSFIELD_API_SECRET = "secret-1";
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(
      fetchHiggsfieldRequestStatus({
        statusUrl: "https://evil.example.com/requests/request-1/status",
      })
    ).rejects.toThrow(/Higgsfield status URL/);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("classifies exhausted Higgsfield credits as a permanent submit failure", async () => {
    process.env.HIGGSFIELD_API_KEY = "key-1";
    process.env.HIGGSFIELD_API_SECRET = "secret-1";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "not_enough_credits" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
    );

    let caught: unknown;
    try {
      await submitHiggsfieldGeneration({
        mode: "image_to_video",
        prompt: "Handheld lifestyle movement",
        imageUrl: "https://storage.example.com/source.jpg",
        webhookUrl: "https://www.airi.chat/api/webhooks/higgsfield",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(isPermanentHiggsfieldApiError(caught)).toBe(true);
    expect((caught as Error).message).toBe(
      "Higgsfield account has no generation credits. Add credits in Higgsfield and try again."
    );

    fetchMock.mockRestore();
  });
});
