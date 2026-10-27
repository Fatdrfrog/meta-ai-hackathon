const mockGetGoogleCloudPlatformAccessToken = jest.fn();
const mockGetGoogleCloudProjectId = jest.fn();
const mockGetVertexPlatformAccessToken = jest.fn();

jest.mock("@/lib/google/gcp-auth", () => ({
  getGoogleCloudPlatformAccessToken: (...args: unknown[]) =>
    mockGetGoogleCloudPlatformAccessToken(...args),
  getGoogleCloudProjectId: (...args: unknown[]) =>
    mockGetGoogleCloudProjectId(...args),
}));

jest.mock("@/lib/ai/vertex-auth", () => ({
  getVertexPlatformAccessToken: (...args: unknown[]) =>
    mockGetVertexPlatformAccessToken(...args),
  resolveVertexEmbeddingProjectId: jest.fn(() => Promise.resolve("icecore-ai")),
}));

import { detectTextLanguageWithGoogle } from "./language-detection";
import { useCleanEnv } from "@/test-support/env-test-utils";

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

describe("detectTextLanguageWithGoogle", () => {
  useCleanEnv([
    "GOOGLE_TRANSLATE_API_KEY",
    "GOOGLE_CLOUD_TRANSLATION_API_KEY",
    "CLOUD_TRANSLATION_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ]);
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock.mockReset();
    mockGetGoogleCloudProjectId.mockReturnValue("icecore-ai");
    mockGetGoogleCloudPlatformAccessToken.mockResolvedValue("oauth-token");
    mockGetVertexPlatformAccessToken.mockRejectedValue(
      new Error(
        "Vertex platform REST APIs require Application Default Credentials"
      )
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it("uses Cloud Translation v3 with Google Cloud OAuth credentials", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          languages: [{ languageCode: "ru", confidence: 0.97 }],
        })
      )
    );

    await expect(
      detectTextLanguageWithGoogle("language sample")
    ).resolves.toEqual({
      language: "ru",
      confidence: 0.97,
      isReliable: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://translate.googleapis.com/v3/projects/icecore-ai/locations/global:detectLanguage"
    );
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer oauth-token" })
    );
    expect(JSON.parse(init.body as string)).toEqual({
      content: "language sample",
      mimeType: "text/plain",
    });
    expect(mockGetVertexPlatformAccessToken).not.toHaveBeenCalled();
  });

  it("does not fall back to API keys when OAuth is unavailable", async () => {
    process.env.GOOGLE_TRANSLATE_API_KEY = "translate-key";
    mockGetGoogleCloudPlatformAccessToken.mockRejectedValueOnce(
      new Error("ADC unavailable")
    );

    await expect(
      detectTextLanguageWithGoogle("language sample")
    ).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[Language Detection] Google Cloud detect failed:",
      expect.stringContaining("v3 OAuth: ADC unavailable")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[Language Detection] Google Cloud detect failed:",
      expect.not.stringContaining("v2 API key")
    );
    expect(mockGetVertexPlatformAccessToken).not.toHaveBeenCalled();
  });

  it("bounds OAuth waiting and never fetches after a late shared token resolves", async () => {
    jest.useFakeTimers();
    let resolveToken!: (token: string) => void;
    mockGetGoogleCloudPlatformAccessToken.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveToken = resolve;
      })
    );
    let settled = false;
    const detection = detectTextLanguageWithGoogle("language sample").then(
      result => {
        settled = true;
        return result;
      }
    );

    await jest.advanceTimersByTimeAsync(3_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(detection).resolves.toBeNull();
    resolveToken("late-shared-token");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("gives fetch and body only the deadline remaining after OAuth", async () => {
    jest.useFakeTimers();
    let resolveToken!: (token: string) => void;
    mockGetGoogleCloudPlatformAccessToken.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveToken = resolve;
      })
    );
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    let settled = false;
    const detection = detectTextLanguageWithGoogle("language sample").then(
      result => {
        settled = true;
        return result;
      }
    );
    await jest.advanceTimersByTimeAsync(3_000);
    resolveToken("shared-token");
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(detection).resolves.toBeNull();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("cancels a stalled body at the shared deadline", async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValueOnce(new Response(body));
    let settled = false;
    const detection = detectTextLanguageWithGoogle("language sample").then(
      result => {
        settled = true;
        return result;
      }
    );
    await jest.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(true);
    await expect(detection).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(["oauth", "fetch", "body"])(
    "preserves caller cancellation during %s instead of returning a language fallback",
    async stage => {
      jest.useFakeTimers();
      const controller = new AbortController();
      const reason = new DOMException("caller cancelled", "AbortError");
      const cancel = jest.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      if (stage === "oauth") {
        mockGetGoogleCloudPlatformAccessToken.mockReturnValueOnce(
          new Promise(() => {})
        );
      } else if (stage === "fetch") {
        fetchMock.mockReturnValueOnce(new Promise(() => {}));
      } else {
        fetchMock.mockResolvedValueOnce(new Response(body));
      }
      let rejection: unknown;
      const detection = detectTextLanguageWithGoogle("language sample", {
        signal: controller.signal,
      }).catch(error => {
        rejection = error;
      });
      await jest.advanceTimersByTimeAsync(0);
      controller.abort(reason);
      await jest.advanceTimersByTimeAsync(0);
      expect(rejection).toBe(reason);
      await detection;
      expect(warnSpy).not.toHaveBeenCalled();
      if (stage === "oauth") expect(fetchMock).not.toHaveBeenCalled();
      if (stage === "body") {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
      }
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it("keeps successful language mapping and clears the deadline timer", async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          languages: [{ languageCode: "kk-KZ", confidence: 0.99 }],
        })
      )
    );
    await expect(
      detectTextLanguageWithGoogle("language sample")
    ).resolves.toEqual({
      language: "kz",
      confidence: 0.99,
      isReliable: false,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rejects an oversized detection body through the existing unavailable fallback", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          languages: [{ languageCode: "ru", confidence: 0.99 }],
          padding: "x".repeat(16 * 1024),
        })
      )
    );
    await expect(
      detectTextLanguageWithGoogle("language sample")
    ).resolves.toBeNull();
  });

  it("honors a shorter caller budget and caps longer requested budgets", async () => {
    jest.useFakeTimers();
    mockGetGoogleCloudPlatformAccessToken.mockImplementation(
      () => new Promise(() => {})
    );
    let settled = false;
    const shorter = detectTextLanguageWithGoogle("language sample", {
      timeoutMs: 50,
    }).then(result => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(shorter).resolves.toBeNull();

    settled = false;
    const longer = detectTextLanguageWithGoogle("language sample", {
      timeoutMs: 30_000,
    }).then(result => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(true);
    await expect(longer).resolves.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does no auth or fetch work for an already cancelled caller", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectTextLanguageWithGoogle("language sample", {
        signal: controller.signal,
      })
    ).rejects.toBe(controller.signal.reason);
    expect(mockGetGoogleCloudPlatformAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not restart an exhausted caller deadline", async () => {
    await expect(
      detectTextLanguageWithGoogle("language sample", { timeoutMs: 0 })
    ).resolves.toBeNull();
    expect(mockGetGoogleCloudPlatformAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the unavailable fallback for Google HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Not available" } }), {
        status: 503,
      })
    );
    await expect(
      detectTextLanguageWithGoogle("language sample")
    ).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "[Language Detection] Google Cloud detect failed:",
      expect.stringContaining(
        "Cloud Translation v3 detect failed: Not available"
      )
    );
  });
});
