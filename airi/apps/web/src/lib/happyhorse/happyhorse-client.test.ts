/**
 * @jest-environment node
 */

// Provider request serialization is tested independently from the customer-source admission policy.
jest.mock("@/lib/google/creative-credentials", () => ({
  assertCreativeCustomerProviderSupported: jest.fn(),
}));

import { VideoProviderPromptValidationError } from "@/lib/creative-assets/video-generation-prompt";
import {
  prepareHappyHorseI2VContractV1,
  prepareHappyHorseR2VContractV1,
  prepareHappyHorseT2VContractV1,
  pollHappyHorseTask,
  submitHappyHorseI2VContractV1,
  submitHappyHorseR2VContractV1,
  submitHappyHorseT2V,
  submitHappyHorseT2VContractV1,
} from "./happyhorse-client";

describe("HappyHorse contract-v1 client", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      ALIBABA_API_KEY: "key-1",
      ALIBABA_API_HOST: "https://happyhorse.example.test",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("sends a strict contract-v1 prompt without slicing it", async () => {
    const prompt = "SENTINEL compiled prompt\nCamera: locked-off.";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ output: { task_id: "task-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await submitHappyHorseT2VContractV1({
      model: "t2v-model",
      prompt,
      resolution: "720P",
      ratio: "9:16",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.input.prompt).toBe(prompt);
  });

  it("freezes the strict request and credentials before the prepared POST is invoked", async () => {
    process.env.HAPPYHORSE_T2V_MODEL = "prepared-model";
    const post = prepareHappyHorseT2VContractV1({
      model: "prepared-model",
      prompt: "SENTINEL prepared prompt",
      resolution: "720P",
      ratio: "9:16",
    });
    delete process.env.ALIBABA_API_KEY;
    delete process.env.ALIBABA_API_HOST;
    process.env.HAPPYHORSE_T2V_MODEL = "changed-after-prepare";
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ output: { task_id: "task-prepared" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await post();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://happyhorse.example.test/api/v1/services/aigc/video-generation/video-synthesis",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer key-1" }),
      })
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "prepared-model",
      input: { prompt: "SENTINEL prepared prompt" },
    });
  });

  it("validates every strict mode while preparing, before a POST closure exists", () => {
    expect(() =>
      prepareHappyHorseT2VContractV1({
        model: " padded-model ",
        prompt: "Compiled prompt",
        resolution: "720P",
        ratio: "9:16",
      })
    ).toThrow(/model id is invalid/);
    expect(() =>
      prepareHappyHorseT2VContractV1({
        model: "t2v-model",
        prompt: " padded ",
        resolution: "720P",
        ratio: "9:16",
      })
    ).toThrow(expect.objectContaining({ code: "prompt_not_canonical" }));
    expect(() =>
      prepareHappyHorseI2VContractV1({
        model: "i2v-model",
        prompt: "Compiled prompt",
        imageUrl: "",
        resolution: "720P",
      })
    ).toThrow(/imageUrl is required/);
    expect(() =>
      prepareHappyHorseR2VContractV1({
        model: "r2v-model",
        prompt: "Compiled prompt",
        referenceImageUrls: [],
        resolution: "720P",
        ratio: "9:16",
      })
    ).toThrow(/reference images/);
  });

  it("sends exact strict image-to-video and reference-to-video prompts", async () => {
    const i2vPrompt = "SENTINEL I2V compiled prompt";
    const r2vPrompt = "SENTINEL R2V compiled prompt";
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { task_id: "task-i2v" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { task_id: "task-r2v" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    await submitHappyHorseI2VContractV1({
      model: "i2v-model",
      prompt: i2vPrompt,
      imageUrl: "https://storage.example.test/source.png",
      resolution: "720P",
    });
    await submitHappyHorseR2VContractV1({
      model: "r2v-model",
      prompt: r2vPrompt,
      referenceImageUrls: ["https://storage.example.test/reference.png"],
      resolution: "720P",
      ratio: "9:16",
    });

    expect(
      JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).input.prompt
    ).toBe(i2vPrompt);
    expect(
      JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).input.prompt
    ).toBe(r2vPrompt);
  });

  it("rejects oversized strict contract-v1 prompts before fetch", async () => {
    const fetchMock = jest.spyOn(global, "fetch");

    await expect(
      submitHappyHorseT2VContractV1({
        model: "t2v-model",
        prompt: "x".repeat(5001),
        resolution: "720P",
        ratio: "9:16",
      })
    ).rejects.toBeInstanceOf(VideoProviderPromptValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an oversized strict contract-v1 submit response", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: { task_id: "task-1" },
          padding: "x".repeat(1_100_000),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await expect(
      submitHappyHorseT2VContractV1({
        model: "t2v-model",
        prompt: "Compiled prompt",
        resolution: "720P",
        ratio: "9:16",
      })
    ).rejects.toMatchObject({ code: "provider_response_too_large" });

    const signal = fetchMock.mock.calls[0][1]?.signal as
      | AbortSignal
      | undefined;
    expect(signal?.aborted).toBe(true);
  });

  it("aborts a trickling poll response at its deadline", async () => {
    jest.useFakeTimers();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let streamCancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            new TextEncoder().encode(
              '{"output":{"task_id":"task-1","task_status":"RUNNING"}'
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
    const pending = pollHappyHorseTask("task-1");
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

  it.each([
    [
      "T2V",
      (prompt: string) =>
        submitHappyHorseT2VContractV1({
          model: "t2v-model",
          prompt,
          resolution: "720P",
          ratio: "9:16",
        }),
    ],
    [
      "I2V",
      (prompt: string) =>
        submitHappyHorseI2VContractV1({
          model: "i2v-model",
          prompt,
          imageUrl: "https://storage.example.test/source.png",
          resolution: "720P",
        }),
    ],
    [
      "R2V",
      (prompt: string) =>
        submitHappyHorseR2VContractV1({
          model: "r2v-model",
          prompt,
          referenceImageUrls: ["https://storage.example.test/reference.png"],
          resolution: "720P",
          ratio: "9:16",
        }),
    ],
  ])(
    "rejects padded and oversized strict %s prompts before fetch",
    async (_mode, submit) => {
      const fetchMock = jest.spyOn(global, "fetch");

      await expect(submit(" compiled prompt ")).rejects.toMatchObject({
        code: "prompt_not_canonical",
        message: "Video prompt must not include leading or trailing whitespace",
      });
      await expect(submit("x".repeat(5001))).rejects.toMatchObject({
        code: "prompt_too_long_for_provider",
        maxLength: 5000,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("retains legacy truncation for existing workflow callers", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ output: { task_id: "task-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await submitHappyHorseT2V({
      prompt: "x".repeat(5001),
      resolution: "720P",
      ratio: "9:16",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.input.prompt).toHaveLength(5000);
  });
});
