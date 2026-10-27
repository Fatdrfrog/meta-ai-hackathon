import {
  canCallGcpAIGateway,
  getRemoteAskDataContext,
  getRemoteDocumentEmbeddingResult,
  publishRemoteLlmAnalyticsEvents,
} from "./gcp-ai-gateway";

import { withWorkspaceTextAiAction } from "./workspace-ai-policy";

describe("GCP AI gateway client config", () => {
  const envKeys = [
    "GCP_AI_GATEWAY_URL",
    "VERCEL_OIDC_TOKEN",
    "VERCEL",
  ] as const;
  const previousEnv = Object.fromEntries(
    envKeys.map(key => [key, process.env[key]])
  ) as Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("treats a configured secured gateway as enabled but not locally callable without auth", () => {
    process.env.GCP_AI_GATEWAY_URL = "https://airi-ai-gateway.example.run.app";

    expect(canCallGcpAIGateway()).toBe(false);
  });

  it("allows secured gateway calls with an explicit local Vercel OIDC token", () => {
    process.env.GCP_AI_GATEWAY_URL = "https://airi-ai-gateway.example.run.app";
    process.env.VERCEL_OIDC_TOKEN = "token";

    expect(canCallGcpAIGateway()).toBe(true);
  });

  it("allows local gateway URLs for auth-disabled local gateway testing", () => {
    process.env.GCP_AI_GATEWAY_URL = "http://127.0.0.1:8787";

    expect(canCallGcpAIGateway()).toBe(true);
  });
});

describe("GCP AI gateway authenticated requests", () => {
  const previousGatewayUrl = process.env.GCP_AI_GATEWAY_URL;
  const previousOidcToken = process.env.VERCEL_OIDC_TOKEN;
  const originalFetch = global.fetch;

  beforeEach(() => {
    delete process.env.GCP_AI_GATEWAY_URL;
    process.env.VERCEL_OIDC_TOKEN = "test-oidc-token";
    global.fetch = jest.fn();
  });

  it("carries the trusted workspace and action to the remote embedding owner", async () => {
    process.env.GCP_AI_GATEWAY_URL = "https://gateway.example";
    global.fetch = jest.fn(async (_url, init) => {
      expect(JSON.parse(init?.body as string)).toEqual({
        text: "document",
        action: { workspaceId: "workspace", actionId: "publish:1" },
      });
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    });
    await withWorkspaceTextAiAction(
      { workspaceId: "workspace", actionId: "publish:1" },
      () => getRemoteDocumentEmbeddingResult({ text: "document" })
    );
  });

  it("aborts context HTTP work without putting the signal in its payload", async () => {
    process.env.GCP_AI_GATEWAY_URL = "https://gateway.example";
    const controller = new AbortController();
    const request = { workspaceId: "workspace", query: "question" };
    global.fetch = jest.fn(async (_url, init) => {
      expect(JSON.parse(init?.body as string)).toEqual(request);
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    await expect(
      getRemoteAskDataContext(request, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (previousGatewayUrl === undefined) {
      delete process.env.GCP_AI_GATEWAY_URL;
    } else {
      process.env.GCP_AI_GATEWAY_URL = previousGatewayUrl;
    }
    if (previousOidcToken === undefined) {
      delete process.env.VERCEL_OIDC_TOKEN;
    } else {
      process.env.VERCEL_OIDC_TOKEN = previousOidcToken;
    }
  });

  it("gives analytics publishing the standard gateway deadline", async () => {
    process.env.GCP_AI_GATEWAY_URL = "https://airi-ai-gateway.example.run.app";
    const timeoutSpy = jest.spyOn(AbortSignal, "timeout");
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1, published: 1 }), {
        status: 200,
      })
    );

    await publishRemoteLlmAnalyticsEvents([
      {
        event_id: "trace-1",
        event_kind: "llm_trace",
        event_ts: "2026-08-14T00:00:00.000Z",
        schema_version: 2,
        workspace_id: "workspace-1",
        operation: "chat",
        provider: "google",
        model: "gemini",
        status: "ok",
      },
    ]);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://airi-ai-gateway.example.run.app/v1/llm-events",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: "Bearer test-oidc-token",
        }),
      })
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
    timeoutSpy.mockRestore();
  });

  it("does not make an HTTP request for an empty analytics batch", async () => {
    await expect(publishRemoteLlmAnalyticsEvents([])).resolves.toEqual({
      accepted: 0,
      published: 0,
      skipped: false,
      topics: [],
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
