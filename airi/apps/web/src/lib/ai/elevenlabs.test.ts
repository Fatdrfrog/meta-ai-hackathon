import {
  createConversationToken,
  createScribeRealtimeToken,
} from "./elevenlabs";

describe("ElevenLabs realtime Scribe token", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_STT_ENABLED: "true",
    };
    global.fetch = mockFetch as never;
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("creates realtime Scribe tokens through the documented single-use token endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "sutkn_test" }),
    });

    const result = await createScribeRealtimeToken("customer-key");

    expect(result.token).toBe("sutkn_test");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      expect.objectContaining({
        method: "POST",
        headers: { "xi-api-key": "customer-key" },
      })
    );
  });
});

describe("ElevenLabs HTTP deadlines", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_TIMEOUT_MS: "100",
    };
    global.fetch = mockFetch as never;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    [
      "conversation token",
      () => createConversationToken("agent-test", "customer-key"),
    ],
    ["Scribe token", () => createScribeRealtimeToken("customer-key")],
  ] as const)(
    "times out stalled %s bodies after headers arrive",
    async (_name, run) => {
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init.signal!.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        });
        return new Response(body, { status: 200 });
      });

      const result = run().catch(error => error);
      await jest.advanceTimersByTimeAsync(100);
      expect(jest.mocked(mockFetch).mock.calls[0][1].signal.aborted).toBe(true);
      await expect(result).resolves.toMatchObject({
        info: { kind: "timeout", transient: true },
      });
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it("cleans up the conversation token timer when fetch rejects", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      createConversationToken("agent-test", "customer-key")
    ).rejects.toThrow("fetch failed");
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ["conversation token", () => createConversationToken("agent-test", "   ")],
    ["Scribe token", () => createScribeRealtimeToken("   ")],
  ] as const)(
    "rejects whitespace API keys before requesting %s",
    async (_name, run) => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ token: "token" }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });

      await expect(run()).rejects.toMatchObject({
        info: { kind: "config", transient: false },
      });
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );
});
