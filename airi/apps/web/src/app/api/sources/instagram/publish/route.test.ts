/** @jest-environment node */

// The Integrations page's "publish to Instagram", after its Graph helpers
// moved to lib/instagram/publish.ts: the same requests to Meta and the same
// answers, and the publishing grant now checked when Meta's grants are a
// JSON array.

const mockGetUser = jest.fn();
const mockWorkspaceAccess = jest.fn();
const mockSource = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: () => mockGetUser() } }),
}));
jest.mock("@/lib/supabase/queries", () => ({
  checkUserWorkspaceAccess: (...args: unknown[]) =>
    mockWorkspaceAccess(...args),
}));
jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) => mockSource(...args),
}));

import type { NextRequest } from "next/server";
import { POST } from "./route";

const BASE = "https://graph.instagram.com/v25.0";
const calls: Array<{ url: string; body: Record<string, string> | null }> = [];
let answers: unknown[] = [];

const source = (credentials: Record<string, unknown> = {}) => ({
  workspace_id: "workspace-1",
  credentials: {
    auth_method: "instagram_business_login",
    // Not a real token.
    page_access_token: "token-1",
    instagram_business_account_id: "1784",
    ...credentials,
  },
});

const publish = (body: Record<string, unknown>) =>
  POST(
    new Request("https://local.test/api/sources/instagram/publish", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "workspace-1", ...body }),
    }) as unknown as NextRequest
  );

beforeEach(() => {
  calls.length = 0;
  answers = [];
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mockWorkspaceAccess.mockResolvedValue(true);
  mockSource.mockResolvedValue(source());
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body:
        typeof init?.body === "string"
          ? Object.fromEntries(new URLSearchParams(init.body))
          : null,
    });
    return new Response(JSON.stringify(answers.shift() ?? {}), {
      status: 200,
    });
  }) as typeof fetch;
});

describe("publishing from Integrations", () => {
  it("publishes a picture and answers as before", async () => {
    answers = [
      { id: "c-1" },
      { id: "m-1" },
      { id: "m-1", permalink: "https://www.instagram.com/p/abc/" },
    ];

    const response = await publish({
      mediaType: "image",
      mediaUrl: "https://cdn.test/p.jpg",
      caption: " Hi ",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mediaType: "image",
      requestedMediaType: "image",
      instagramAccountId: "1784",
      creationId: "c-1",
      publishedMediaId: "m-1",
      permalink: "https://www.instagram.com/p/abc/",
      requiredPermission: "instagram_business_content_publish",
      authMethod: "instagram_business_login",
    });
    expect(calls[0]).toEqual({
      url: `${BASE}/1784/media`,
      body: {
        access_token: "token-1",
        caption: "Hi",
        image_url: "https://cdn.test/p.jpg",
      },
    });
    expect(calls[1]).toEqual({
      url: `${BASE}/1784/media_publish`,
      body: { access_token: "token-1", creation_id: "c-1" },
    });
  });

  it("publishes a video as a Reel once Instagram has processed it", async () => {
    answers = [{ id: "c-2" }, { status_code: "FINISHED" }, { id: "m-2" }, {}];

    const response = await publish({
      mediaType: "video",
      mediaUrl: "https://cdn.test/v.mp4",
    });

    expect(await response.json()).toMatchObject({
      ok: true,
      mediaType: "reels",
      requestedMediaType: "video",
      publishedMediaId: "m-2",
    });
    expect(calls[0].body).toEqual({
      access_token: "token-1",
      caption: "",
      media_type: "REELS",
      video_url: "https://cdn.test/v.mp4",
      share_to_feed: "true",
    });
    expect(calls[1].url).toContain(`${BASE}/c-2?fields=status_code%2Cstatus`);
  });

  it("refuses with 403 when a JSON array of grants lacks publishing", async () => {
    mockSource.mockResolvedValue(
      source({ granted_permissions: ["instagram_business_basic"] })
    );

    const response = await publish({
      mediaType: "image",
      mediaUrl: "https://cdn.test/p.jpg",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      requiredPermission: "instagram_business_content_publish",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps an expired token to 401 as before", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 190, message: "Error validating access token" },
          }),
          { status: 400 }
        )
    ) as typeof fetch;

    const response = await publish({
      mediaType: "image",
      mediaUrl: "https://cdn.test/p.jpg",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error:
        "Instagram access token is invalid or expired. Reconnect Instagram and try again.",
      graphCode: 190,
    });
  });
});
