import { encryptString } from "@/lib/crypto";
import {
  GoogleAiConnectionError,
  normalizeGoogleAiApiKey,
  resolveGoogleAiCredentialsForWorkspace,
  toPublicGoogleAiCredentials,
  validateGoogleAiApiKey,
} from "./google-ai-source";

const apiKey = "auth-key-for-customer-1234";
const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Google AI source connection", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("validates by reading every model page without generating or exposing the key in URLs", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init: init ?? {} });
      return url.searchParams.has("pageToken")
        ? jsonResponse({
            models: [
              {
                name: "models/embedding",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          })
        : jsonResponse({
            models: [
              {
                name: "models/text",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
            nextPageToken: "next+page",
          });
    });

    await expect(validateGoogleAiApiKey(`  ${apiKey}  `)).resolves.toEqual({
      modelCount: 2,
    });
    expect(requests).toHaveLength(2);
    for (const { url, init } of requests) {
      expect(url.origin + url.pathname).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models"
      );
      expect(url.toString()).not.toContain(apiKey);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { "x-goog-api-key": apiKey },
      });
      expect(init.body).toBeUndefined();
    }
    expect(requests[1].url.searchParams.get("pageToken")).toBe("next+page");
    expect(requests[1].url.searchParams.get("pageSize")).toBe(
      requests[0].url.searchParams.get("pageSize")
    );
  });

  it.each([{}, { models: [] }])(
    "accepts a valid empty catalog %p",
    async payload => {
      jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(payload));
      await expect(validateGoogleAiApiKey(apiKey)).resolves.toEqual({
        modelCount: 0,
      });
    }
  );

  it.each([
    "",
    " ",
    "contains space",
    "contains\nnewline",
    "contains\u0000null",
    "x".repeat(4097),
  ])("rejects malformed local keys without a request", async key => {
    const fetchMock = jest.spyOn(global, "fetch");
    await expect(validateGoogleAiApiKey(key)).rejects.toMatchObject({
      code: "INVALID_API_KEY",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes unknown form values before persistence without assuming a key prefix", () => {
    expect(normalizeGoogleAiApiKey("  new-auth-key-format  ")).toBe(
      "new-auth-key-format"
    );
    for (const value of [null, undefined, {}, 123, "key\u0085control"]) {
      expect(() => normalizeGoogleAiApiKey(value)).toThrow(
        expect.objectContaining({ code: "INVALID_API_KEY" })
      );
    }
  });

  it.each([
    [400, "INVALID_API_KEY"],
    [401, "INVALID_API_KEY"],
    [403, "GOOGLE_AI_ACCESS_DENIED"],
    [429, "GOOGLE_AI_RATE_LIMITED"],
    [503, "GOOGLE_AI_UNAVAILABLE"],
  ])("sanitizes provider HTTP %i errors", async (status, code) => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        jsonResponse(
          { error: { message: `provider echoed ${apiKey}` } },
          status as number
        )
      );
    const error = await validateGoogleAiApiKey(apiKey).catch(error => error);
    expect(error).toBeInstanceOf(GoogleAiConnectionError);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(apiKey);
    expect(error.cause).toBeUndefined();
  });

  it("distinguishes denied billing prerequisites from an invalid key", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        jsonResponse({ error: { status: "FAILED_PRECONDITION" } }, 400)
      );
    await expect(validateGoogleAiApiKey(apiKey)).rejects.toMatchObject({
      code: "GOOGLE_AI_ACCESS_DENIED",
    });
  });

  it.each([
    null,
    [],
    { models: null },
    { models: {} },
    { models: [null] },
    { models: [{ name: "" }] },
    {
      models: [
        { name: "models/a", supportedGenerationMethods: "generateContent" },
      ],
    },
    { nextPageToken: 4 },
    { error: { message: "unexpected successful error" } },
  ])("rejects malformed successful catalog %p", async payload => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse(payload));
    await expect(validateGoogleAiApiKey(apiKey)).rejects.toMatchObject({
      code: "GOOGLE_AI_INVALID_RESPONSE",
    });
  });

  it("rejects duplicate models across pages instead of claiming a complete catalog", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          models: [{ name: "models/same" }],
          nextPageToken: "second",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: "models/same" }] })
      );
    await expect(validateGoogleAiApiKey(apiKey)).rejects.toMatchObject({
      code: "GOOGLE_AI_INVALID_RESPONSE",
    });
  });

  it("rejects a repeated page token instead of looping", async () => {
    let page = 0;
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () =>
        jsonResponse({
          models: [{ name: `models/${page++}` }],
          nextPageToken: "same",
        })
      );
    await expect(validateGoogleAiApiKey(apiKey)).rejects.toMatchObject({
      code: "GOOGLE_AI_INVALID_RESPONSE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds endlessly changing pagination", async () => {
    let page = 0;
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () =>
        jsonResponse({ models: [], nextPageToken: `page-${++page}` })
      );
    await expect(validateGoogleAiApiKey(apiKey)).rejects.toMatchObject({
      code: "GOOGLE_AI_INVALID_RESPONSE",
    });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("rejects oversized responses", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response("{}", { headers: { "content-length": "10485760" } })
      );
    await expect(validateGoogleAiApiKey(apiKey)).rejects.toMatchObject({
      code: "GOOGLE_AI_INVALID_RESPONSE",
    });
  });

  it("enforces one overall deadline across model pages", async () => {
    jest.useFakeTimers();
    let page = 0;
    jest.spyOn(global, "fetch").mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 6_000));
      return jsonResponse({ models: [], nextPageToken: `page-${++page}` });
    });
    const result = validateGoogleAiApiKey(apiKey).catch(error => error);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ code: "GOOGLE_AI_UNAVAILABLE" });
  });

  it("sanitizes network errors", async () => {
    jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new Error(`socket rejected ${apiKey}`));
    const error = await validateGoogleAiApiKey(apiKey).catch(error => error);
    expect(error).toMatchObject({ code: "GOOGLE_AI_UNAVAILABLE" });
    expect(error.message).not.toContain(apiKey);
  });
});

describe("Google AI credential isolation", () => {
  const originalSecret = process.env.ENCRYPTION_SECRET;
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = "google-ai-test-secret";
  });
  afterAll(() => {
    if (originalSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = originalSecret;
  });

  function sourceClient(
    credentials: unknown,
    options: { workspaceId?: string; type?: string; error?: unknown } = {}
  ) {
    const row = {
      id: "google-source",
      workspace_id: options.workspaceId ?? "workspace-a",
      type: options.type ?? "google_ai",
      credentials,
    };
    const filters: Record<string, unknown> = {};
    const query = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: jest.fn(async () => ({
        data: Object.entries(filters).every(
          ([field, value]) => row[field as keyof typeof row] === value
        )
          ? row
          : null,
        error: options.error ?? null,
      })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockImplementation((field: string, value: unknown) => {
      filters[field] = value;
      return query;
    });
    const client = { from: jest.fn(() => query) };
    return {
      client: client as unknown as Parameters<
        typeof resolveGoogleAiCredentialsForWorkspace
      >[0]["supabase"],
      from: client.from,
      query,
    };
  }

  it("projects only safe metadata without decrypting or echoing extra fields", () => {
    const encrypted = encryptString(apiKey);
    delete process.env.ENCRYPTION_SECRET;
    expect(
      toPublicGoogleAiCredentials({
        api_key: encrypted,
        key_label: "****1234",
        connected_at: "2026-09-17T10:00:00.000Z",
        validated_at: "2026-09-17T10:00:01.000Z",
        model_count: 2,
        secret: apiKey,
      })
    ).toEqual({
      has_api_key: true,
      key_label: "****1234",
      connected_at: "2026-09-17T10:00:00.000Z",
      validated_at: "2026-09-17T10:00:01.000Z",
      model_count: 2,
    });
  });

  it("does not project unmasked labels, plaintext keys, malformed dates or counts", () => {
    expect(
      toPublicGoogleAiCredentials({
        api_key: apiKey,
        key_label: apiKey,
        connected_at: apiKey,
        validated_at: {},
        model_count: -1,
      })
    ).toEqual({
      has_api_key: false,
      key_label: null,
      connected_at: null,
      validated_at: null,
      model_count: null,
    });
  });

  it("resolves only explicitly selected encrypted credentials in the same workspace", async () => {
    const { client } = sourceClient({ api_key: encryptString(apiKey) });
    await expect(
      resolveGoogleAiCredentialsForWorkspace({
        supabase: client,
        workspaceId: "workspace-a",
        sourceId: "google-source",
      })
    ).resolves.toEqual({ sourceId: "google-source", apiKey });
    await expect(
      resolveGoogleAiCredentialsForWorkspace({
        supabase: client,
        workspaceId: "workspace-b",
        sourceId: "google-source",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_AI_ACCESS_DENIED" });
    await expect(
      resolveGoogleAiCredentialsForWorkspace({
        supabase: client,
        workspaceId: "workspace-a",
        sourceId: "another-source",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_AI_ACCESS_DENIED" });
  });

  it("rejects a source of another provider", async () => {
    const { client } = sourceClient(
      { api_key: encryptString(apiKey) },
      { type: "higgsfield" }
    );
    await expect(
      resolveGoogleAiCredentialsForWorkspace({
        supabase: client,
        workspaceId: "workspace-a",
        sourceId: "google-source",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_AI_ACCESS_DENIED" });
  });

  it.each(["", " "])(
    "requires both workspace and source before querying",
    async blank => {
      const { client, from } = sourceClient({ api_key: encryptString(apiKey) });
      await expect(
        resolveGoogleAiCredentialsForWorkspace({
          supabase: client,
          workspaceId: "workspace-a",
          sourceId: blank,
        })
      ).rejects.toMatchObject({ code: "GOOGLE_AI_ACCESS_DENIED" });
      await expect(
        resolveGoogleAiCredentialsForWorkspace({
          supabase: client,
          workspaceId: blank,
          sourceId: "google-source",
        })
      ).rejects.toMatchObject({ code: "GOOGLE_AI_ACCESS_DENIED" });
      expect(from).not.toHaveBeenCalled();
    }
  );

  it.each([
    apiKey,
    JSON.stringify({ iv: "iv", tag: "tag", ciphertext: "ciphertext" }),
    { iv: 2, tag: "tag", ciphertext: "ciphertext" },
  ])("refuses legacy plaintext or malformed credentials", async storedKey => {
    const { client } = sourceClient({ api_key: storedKey });
    await expect(
      resolveGoogleAiCredentialsForWorkspace({
        supabase: client,
        workspaceId: "workspace-a",
        sourceId: "google-source",
      })
    ).rejects.toMatchObject({ code: "INVALID_API_KEY" });
  });

  it("sanitizes database failures instead of returning a key", async () => {
    const { client } = sourceClient(
      { api_key: encryptString(apiKey) },
      { error: { message: apiKey } }
    );
    const error = await resolveGoogleAiCredentialsForWorkspace({
      supabase: client,
      workspaceId: "workspace-a",
      sourceId: "google-source",
    }).catch(error => error);
    expect(error).toMatchObject({ code: "GOOGLE_AI_UNAVAILABLE" });
    expect(error.message).not.toContain(apiKey);
  });

  it("does not substitute a platform key when the selected workspace source is missing", async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "platform-secret";
    try {
      const { client } = sourceClient({ api_key: encryptString(apiKey) });
      await expect(
        resolveGoogleAiCredentialsForWorkspace({
          supabase: client,
          workspaceId: "workspace-a",
          sourceId: "missing",
        })
      ).rejects.toMatchObject({ code: "GOOGLE_AI_ACCESS_DENIED" });
    } finally {
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("sanitizes encryption failures", async () => {
    const encrypted = encryptString(apiKey);
    process.env.ENCRYPTION_SECRET = "different-encryption-secret";
    const { client } = sourceClient({ api_key: encrypted });
    await expect(
      resolveGoogleAiCredentialsForWorkspace({
        supabase: client,
        workspaceId: "workspace-a",
        sourceId: "google-source",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_AI_UNAVAILABLE" });
  });
});
