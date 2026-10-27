/**
 * @jest-environment node
 */

import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
  readBodyBytesWithinLimit,
  readJsonBodyWithinLimit,
} from "./json-body";

function makeStreamingRequest(chunks: Uint8Array[]): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });

  return new Request("https://airi.chat/webhook", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readBodyBytesWithinLimit", () => {
  it("returns the exact UTF-8 bytes", async () => {
    const expected = new TextEncoder().encode('{"message":"Сәлем 👋"}');
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: expected,
    });

    await expect(
      readBodyBytesWithinLimit(request, expected.byteLength)
    ).resolves.toEqual(expected);
  });

  it("returns an empty byte array for an empty body", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
    });

    await expect(readBodyBytesWithinLimit(request, 1)).resolves.toEqual(
      new Uint8Array()
    );
  });

  it("rejects a declared oversized body before reading the stream", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      headers: { "Content-Length": "9" },
      body: "small",
    });

    await expect(readBodyBytesWithinLimit(request, 8)).rejects.toEqual(
      expect.objectContaining({
        name: "JsonBodyTooLargeError",
        maxBytes: 8,
      })
    );
    expect(request.bodyUsed).toBe(false);
  });

  it("rejects a streaming body as soon as it exceeds the limit", async () => {
    const request = makeStreamingRequest([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4]),
    ]);

    await expect(readBodyBytesWithinLimit(request, 3)).rejects.toBeInstanceOf(
      JsonBodyTooLargeError
    );
  });

  it("enforces limits at the multibyte UTF-8 boundary", async () => {
    const encoded = new TextEncoder().encode("€");
    const exactRequest = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: encoded,
    });
    const oversizedRequest = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: encoded,
    });

    await expect(readBodyBytesWithinLimit(exactRequest, 3)).resolves.toEqual(
      encoded
    );
    await expect(
      readBodyBytesWithinLimit(oversizedRequest, 2)
    ).rejects.toBeInstanceOf(JsonBodyTooLargeError);
  });

  it("consumes the request body only once", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: "once",
    });

    await readBodyBytesWithinLimit(request, 4);

    expect(request.bodyUsed).toBe(true);
    await expect(readBodyBytesWithinLimit(request, 4)).rejects.toThrow();
  });

  describe("fetched responses", () => {
    function trackedStream(
      source: UnderlyingDefaultSource<Uint8Array>,
      highWaterMark = 1
    ) {
      const state = { pulls: 0, cancelReason: undefined as unknown };
      const stream = new ReadableStream<Uint8Array>(
        {
          ...source,
          pull(controller) {
            state.pulls += 1;
            return source.pull?.(controller);
          },
          cancel(reason) {
            state.cancelReason = reason ?? "cancelled";
          },
        },
        { highWaterMark }
      );
      return { stream, state };
    }

    it("returns the whole body when it fits, with a live signal", async () => {
      const response = new Response(new Uint8Array([1, 2, 3]));

      await expect(
        readBodyBytesWithinLimit(response, 3, {
          signal: new AbortController().signal,
        })
      ).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    });

    it("rejects a larger Content-Length without pulling the body", async () => {
      const { stream, state } = trackedStream({}, 0);
      const response = new Response(stream, {
        headers: { "content-length": "11" },
      });

      await expect(
        readBodyBytesWithinLimit(response, 10)
      ).rejects.toBeInstanceOf(JsonBodyTooLargeError);
      expect(state.pulls).toBe(0);
      expect(response.bodyUsed).toBe(false);
    });

    it("cancels the stream as soon as it passes the limit", async () => {
      const { stream, state } = trackedStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(4));
        },
      });

      await expect(
        readBodyBytesWithinLimit(new Response(stream), 10)
      ).rejects.toBeInstanceOf(JsonBodyTooLargeError);
      expect(state.cancelReason).toBeDefined();
      expect(state.pulls).toBeLessThanOrEqual(4);
    });

    it("rejects a stalled read with the abort reason and cancels the stream", async () => {
      const { stream, state } = trackedStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      });
      const controller = new AbortController();
      const deadline = new Error("deadline");

      const read = readBodyBytesWithinLimit(new Response(stream), 10, {
        signal: controller.signal,
      });
      await new Promise(resolve => setImmediate(resolve));
      controller.abort(deadline);

      await expect(read).rejects.toBe(deadline);
      expect(state.cancelReason).toBe(deadline);
    });

    it("does not read when the signal is already aborted", async () => {
      const { stream, state } = trackedStream({}, 0);
      const controller = new AbortController();
      const deadline = new Error("deadline");
      controller.abort(deadline);

      await expect(
        readBodyBytesWithinLimit(new Response(stream), 10, {
          signal: controller.signal,
        })
      ).rejects.toBe(deadline);
      expect(state.pulls).toBe(0);
    });
  });
});

describe("readJsonBodyWithinLimit", () => {
  it("parses a JSON body within the byte limit", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: JSON.stringify({ status: "completed" }),
    });

    await expect(readJsonBodyWithinLimit(request, 256)).resolves.toEqual({
      status: "completed",
    });
  });

  it("rejects a declared oversized body before reading the stream", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      headers: { "Content-Length": "257" },
      body: "{}",
    });

    await expect(readJsonBodyWithinLimit(request, 256)).rejects.toEqual(
      expect.objectContaining({
        name: "JsonBodyTooLargeError",
        maxBytes: 256,
      })
    );
    expect(request.bodyUsed).toBe(false);
  });

  it("enforces the actual UTF-8 byte count without a content-length header", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: JSON.stringify({ value: "🎬".repeat(80) }),
    });
    expect(request.headers.has("content-length")).toBe(false);

    await expect(readJsonBodyWithinLimit(request, 256)).rejects.toBeInstanceOf(
      JsonBodyTooLargeError
    );
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: "{",
    });

    await expect(readJsonBodyWithinLimit(request, 256)).rejects.toBeInstanceOf(
      InvalidJsonBodyError
    );
  });

  it("keeps the existing empty-body and invalid-limit errors", async () => {
    const emptyRequest = new Request("https://airi.chat/webhook", {
      method: "POST",
    });
    const invalidLimitRequest = new Request("https://airi.chat/webhook", {
      method: "POST",
      body: "{}",
    });

    await expect(readJsonBodyWithinLimit(emptyRequest, 256)).rejects.toEqual(
      expect.objectContaining({
        name: "InvalidJsonBodyError",
        message: "Invalid JSON body",
      })
    );
    await expect(
      readJsonBodyWithinLimit(invalidLimitRequest, 0)
    ).rejects.toThrow("JSON body byte limit must be a positive integer");
  });
});
