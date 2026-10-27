const mockChatCompletionWithFallback = jest.fn();
const mockRecordCreativeStudioChat = jest.fn();

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) =>
    mockChatCompletionWithFallback(...args),
  getHeavyTextModel: () => "heavy-text-model",
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const query = (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({
          data:
            table === "company_users"
              ? { workspace_id: "workspace-1" }
              : { id: "source-1" },
        }),
      };
      return chain;
    };
    return {
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: query,
    };
  },
}));

jest.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

jest.mock("@/lib/workspace-feature-flags", () => ({
  isWorkspaceFeatureEnabled: async () => true,
}));

jest.mock("@/lib/limits/company-limits", () => ({
  ensureCompanyStudioChatCapacity: async () => ({ allowed: true, limit: {} }),
  recordCreativeStudioChat: (...args: unknown[]) =>
    mockRecordCreativeStudioChat(...args),
  buildCompanyStudioChatLimitExceededResponse: () =>
    Response.json({ error: "locked" }, { status: 402 }),
}));

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: async () => null,
}));

jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => value,
}));

import { POST } from "./route";

function generate(body: Record<string, unknown>) {
  return POST(
    new Request(
      "http://localhost/api/workspaces/workspace-1/studio/instagram/generate",
      { method: "POST", body: JSON.stringify(body) }
    ) as never,
    { params: Promise.resolve({ workspaceId: "workspace-1" }) }
  );
}

describe("POST /api/workspaces/[workspaceId]/studio/instagram/generate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordCreativeStudioChat.mockResolvedValue(undefined);
  });

  it("generates captions on the heavy text tier and reads a fenced JSON reply", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: [
        "```json",
        JSON.stringify({
          variants: [
            {
              title: "Launch",
              hook: "New season, new look.",
              caption: "Our autumn line is here.",
              hashtags: ["#autumn", "style"],
              creativeBrief: "Model in a coat outdoors.",
            },
          ],
        }),
        "```",
      ].join("\n"),
    });

    const response = await generate({
      action: "captions",
      topic: "Autumn collection",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "captions",
      variants: [
        {
          title: "Launch",
          hook: "New season, new look.",
          caption: "Our autumn line is here.",
          hashtags: ["#autumn", "#style"],
          creativeBrief: "Model in a coat outdoors.",
        },
      ],
    });
    expect(mockChatCompletionWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "heavy-text-model",
        responseFormat: { type: "json_object" },
      })
    );
    expect(mockRecordCreativeStudioChat).toHaveBeenCalledWith(
      "workspace-1",
      "instagram_generate"
    );
  });

  it("falls back to a draft caption when the reply holds no JSON object", async () => {
    mockChatCompletionWithFallback.mockResolvedValueOnce({
      content: "I can't produce that right now.",
    });

    const response = await generate({
      action: "captions",
      topic: "Autumn collection",
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.variants).toHaveLength(1);
    expect(payload.variants[0].caption).toBe(
      'Here is a first draft for "Autumn collection".'
    );
  });
});
