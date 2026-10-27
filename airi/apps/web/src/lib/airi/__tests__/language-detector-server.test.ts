const mockDetectTextLanguageWithGoogle = jest.fn();

jest.mock("@/lib/google/language-detection", () => ({
  detectTextLanguageWithGoogle: (...args: unknown[]) =>
    mockDetectTextLanguageWithGoogle(...args),
}));

import {
  detectLanguage,
  detectLanguageModelOnly,
} from "@/lib/airi/language-detector-server";

describe("language-detector-server", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns confident Google Cloud detections for supported languages", async () => {
    mockDetectTextLanguageWithGoogle.mockResolvedValue({
      language: "ru",
      confidence: 0.98,
      isReliable: true,
    });

    await expect(
      detectLanguageModelOnly("Программа стипендий имени Ержана Татишева")
    ).resolves.toBe("ru");
  });

  it("returns null when Google Cloud detection is not confident", async () => {
    mockDetectTextLanguageWithGoogle.mockResolvedValue({
      language: "en",
      confidence: 0.2,
      isReliable: false,
    });

    await expect(detectLanguageModelOnly("ok")).resolves.toBeNull();
  });

  it("falls back to raw Google Cloud language for detectLanguage", async () => {
    mockDetectTextLanguageWithGoogle.mockResolvedValueOnce({
      language: "ru",
      confidence: 0.4,
      isReliable: false,
    });

    await expect(detectLanguage("help")).resolves.toBe("ru");
    expect(mockDetectTextLanguageWithGoogle).toHaveBeenCalledTimes(1);
  });

  it("defaults to English after one failed Google Cloud detection", async () => {
    mockDetectTextLanguageWithGoogle.mockResolvedValueOnce(null);

    await expect(detectLanguage("help")).resolves.toBe("en");
    expect(mockDetectTextLanguageWithGoogle).toHaveBeenCalledTimes(1);
  });

  it.each([detectLanguage, detectLanguageModelOnly])(
    "forwards the caller deadline and cancellation to Google detection",
    async detect => {
      const controller = new AbortController();
      const options = { signal: controller.signal, timeoutMs: 500 };
      mockDetectTextLanguageWithGoogle.mockResolvedValueOnce({
        language: "kz",
        confidence: 0.99,
        isReliable: false,
      });
      await expect(detect("language sample", options)).resolves.toBe("kz");
      expect(mockDetectTextLanguageWithGoogle).toHaveBeenCalledWith(
        "language sample",
        options
      );
    }
  );

  it.each([detectLanguage, detectLanguageModelOnly])(
    "preserves caller abort instead of applying language fallbacks",
    async detect => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        detect("language sample", { signal: controller.signal })
      ).rejects.toBe(controller.signal.reason);
      expect(mockDetectTextLanguageWithGoogle).not.toHaveBeenCalled();
    }
  );
});
