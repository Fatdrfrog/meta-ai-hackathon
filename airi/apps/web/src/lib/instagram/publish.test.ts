/** @jest-environment node */

// Instagram publishing through the Graph API, with fetch mocked: the
// connected account and its grants, each container, statuses, publishing,
// permalinks, the publishing limit and the account's newest media.

const mockSource = jest.fn();

jest.mock("@/lib/sources/utils", () => ({
  fetchSourceWithCredentials: (...args: unknown[]) => mockSource(...args),
}));

import {
  GraphApiError,
  containerParams,
  containerStatus,
  createContainer,
  createContainerForAccount,
  grantedPermissions,
  instagramPublishAccount,
  isGraphMediaNotReadyError,
  isGraphQuotaError,
  isGraphTokenError,
  isGraphTransientError,
  loadInstagramPublishAccount,
  permalinkOf,
  publishContainer,
  publishContainerForAccount,
  publishingQuota,
  recentMedia,
  toGraphApiError,
  waitForContainerReady,
} from "./publish";

const BASE = "https://graph.instagram.com/v25.0";
// Not a real token.
const access = { graphBase: BASE, accessToken: "token-1" };

type Call = { url: string; method: string; body: URLSearchParams | null };
const calls: Call[] = [];
let answers: Array<{ status: number; json: unknown } | Error> = [];

function answer(json: unknown, status = 200) {
  answers.push({ status, json });
}

beforeEach(() => {
  calls.length = 0;
  answers = [];
  mockSource.mockReset();
  global.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string" ? new URLSearchParams(init.body) : null,
    });
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.json), { status: next.status });
  }) as typeof fetch;
});

const graphError = (code: number, message: string, subcode?: number) => ({
  error: { code, message, error_subcode: subcode, fbtrace_id: "trace" },
});

describe("the grants a connection was given", () => {
  it("reads Meta's comma string, a JSON array and its text, lower-cased", () => {
    const expected = new Set([
      "instagram_business_basic",
      "instagram_business_content_publish",
    ]);
    expect(
      grantedPermissions(
        "instagram_business_basic,Instagram_Business_Content_Publish"
      )
    ).toEqual(expected);
    expect(
      grantedPermissions([
        "instagram_business_basic",
        "instagram_business_content_publish",
      ])
    ).toEqual(expected);
    expect(
      grantedPermissions(
        '["instagram_business_basic","instagram_business_content_publish"]'
      )
    ).toEqual(expected);
  });

  it("is empty when it can't tell", () => {
    expect(grantedPermissions(undefined).size).toBe(0);
    expect(grantedPermissions("").size).toBe(0);
    expect(grantedPermissions("[not json").size).toBe(0);
    expect(grantedPermissions({ scope: "x" }).size).toBe(0);
    expect(grantedPermissions([1, null]).size).toBe(0);
  });
});

describe("the connected account", () => {
  const credentials = {
    auth_method: "instagram_business_login",
    page_access_token: "token-1",
    instagram_business_account_id: "1784",
    instagram_scoped_id: "2001",
    username: "@airi.chat__",
  };

  it("can publish with the publishing grant in a JSON array", () => {
    const account = instagramPublishAccount({
      ...credentials,
      granted_permissions: [
        "instagram_business_basic",
        "instagram_business_content_publish",
      ],
    });
    expect(account).toMatchObject({
      connected: true,
      canPublish: true,
      username: "airi.chat__",
      requiredPermission: "instagram_business_content_publish",
      access: { graphBase: BASE, accessToken: "token-1" },
      accountIds: ["1784", "2001"],
    });
  });

  it("can't publish when an array of grants lacks publishing", () => {
    const account = instagramPublishAccount({
      ...credentials,
      granted_permissions: ["instagram_business_basic"],
    });
    expect(account).toMatchObject({ connected: true, canPublish: false });
  });

  it("trusts a connection whose grants weren't recorded", () => {
    expect(instagramPublishAccount(credentials)?.canPublish).toBe(true);
  });

  it("isn't connected without a token or an account id", () => {
    expect(
      instagramPublishAccount({ ...credentials, page_access_token: "" })
    ).toMatchObject({ connected: false, canPublish: false });
    expect(
      instagramPublishAccount({
        page_access_token: "token-1",
        auth_method: "instagram_business_login",
      })
    ).toMatchObject({ connected: false, canPublish: false, username: null });
    expect(instagramPublishAccount(null)).toBeNull();
  });

  it("uses graph.facebook.com for Facebook Login", () => {
    expect(
      instagramPublishAccount({ ...credentials, auth_method: "facebook" })
        ?.access.graphBase
    ).toBe("https://graph.facebook.com/v25.0");
  });

  it("reads the workspace's Instagram source", async () => {
    mockSource.mockResolvedValue({
      workspace_id: "workspace-1",
      credentials,
    });
    expect((await loadInstagramPublishAccount("workspace-1"))?.connected).toBe(
      true
    );
    expect(mockSource).toHaveBeenCalledWith(undefined, "instagram", {
      workspace_id: "workspace-1",
    });
    mockSource.mockResolvedValue(null);
    expect(await loadInstagramPublishAccount("workspace-1")).toBeNull();
  });
});

describe("containers", () => {
  it("builds each kind's parameters", () => {
    const read = (params: URLSearchParams) => Object.fromEntries(params);
    expect(
      read(
        containerParams({ kind: "image", imageUrl: "https://i", caption: "Hi" })
      )
    ).toEqual({ caption: "Hi", image_url: "https://i" });
    expect(
      read(
        containerParams({
          kind: "reel",
          videoUrl: "https://v",
          caption: "Hi",
          coverUrl: "https://c",
        })
      )
    ).toEqual({
      caption: "Hi",
      media_type: "REELS",
      video_url: "https://v",
      share_to_feed: "true",
      cover_url: "https://c",
    });
    expect(
      read(containerParams({ kind: "story", videoUrl: "https://v" }))
    ).toEqual({ media_type: "STORIES", video_url: "https://v" });
    expect(
      read(containerParams({ kind: "story", imageUrl: "https://i" }))
    ).toEqual({ media_type: "STORIES", image_url: "https://i" });
    expect(
      read(containerParams({ kind: "carousel_item", imageUrl: "https://i" }))
    ).toEqual({ image_url: "https://i", is_carousel_item: "true" });
    expect(
      read(
        containerParams({
          kind: "carousel",
          children: ["11", "12"],
          caption: "Hi",
        })
      )
    ).toEqual({ caption: "Hi", media_type: "CAROUSEL", children: "11,12" });
  });

  it("creates one with the token in the body", async () => {
    answer({ id: "c-1" });
    expect(
      await createContainer(access, "1784", {
        kind: "image",
        imageUrl: "https://i",
      })
    ).toBe("c-1");
    expect(calls[0].url).toBe(`${BASE}/1784/media`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body?.get("access_token")).toBe("token-1");
  });

  it("skips account ids Meta says aren't available", async () => {
    answer(
      graphError(
        100,
        "Unsupported post request. Object with ID '1784' does not exist"
      ),
      400
    );
    answer({ id: "c-2" });
    expect(
      await createContainerForAccount(access, ["1784", "2001"], {
        kind: "story",
        imageUrl: "https://i",
      })
    ).toEqual({ accountId: "2001", containerId: "c-2" });
  });

  it("throws other refusals at once", async () => {
    answer(graphError(190, "Error validating access token"), 400);
    const error = await createContainerForAccount(access, ["1784", "2001"], {
      kind: "image",
      imageUrl: "https://i",
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(GraphApiError);
    expect(isGraphTokenError(error)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("reads a container's status", async () => {
    answer({
      status_code: "error",
      status: "Error: Media upload has failed with error code 2207026",
    });
    expect(await containerStatus(access, "c-1")).toEqual({
      code: "ERROR",
      message: "Error: Media upload has failed with error code 2207026",
    });
    expect(calls[0].url).toContain(`${BASE}/c-1?fields=status_code%2Cstatus`);
  });

  it("waits for a video container, and fails an expired one", async () => {
    answer({ status_code: "IN_PROGRESS" });
    answer({ status_code: "FINISHED" });
    await waitForContainerReady(access, "c-1", { delayMs: 1 });
    expect(calls).toHaveLength(2);

    answer({ status_code: "EXPIRED" });
    await expect(
      waitForContainerReady(access, "c-1", { delayMs: 1 })
    ).rejects.toThrow("Instagram video processing failed with status: EXPIRED");
  });
});

describe("publishing", () => {
  it("publishes a container and reads the permalink", async () => {
    answer({ id: "m-1" });
    answer({ id: "m-1", permalink: "https://www.instagram.com/reel/abc/" });
    expect(await publishContainer(access, "1784", "c-1")).toEqual({
      mediaId: "m-1",
      response: { id: "m-1" },
    });
    expect(calls[0].url).toBe(`${BASE}/1784/media_publish`);
    expect(calls[0].body?.get("creation_id")).toBe("c-1");
    expect(await permalinkOf(access, "m-1")).toBe(
      "https://www.instagram.com/reel/abc/"
    );
  });

  it("publishes from the account id that takes it", async () => {
    answer(
      graphError(
        100,
        "Unsupported post request. Object with ID '1784' does not exist"
      ),
      400
    );
    answer({ id: "m-3" });
    expect(
      await publishContainerForAccount(access, ["1784", "2001"], "c-1")
    ).toEqual({ accountId: "2001", mediaId: "m-3" });
    expect(calls[1].url).toBe(`${BASE}/2001/media_publish`);
  });

  it("gives no permalink when it can't be read", async () => {
    answers.push(new Error("network down"));
    expect(await permalinkOf(access, "m-1")).toBeNull();
  });

  it("reads the publishing limit", async () => {
    answer({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] });
    expect(await publishingQuota(access, "1784")).toEqual({
      used: 3,
      total: 100,
    });
    expect(calls[0].url).toContain(`${BASE}/1784/content_publishing_limit`);
    answer({ data: [] });
    expect(await publishingQuota(access, "1784")).toBeNull();
    answer(graphError(10, "Permission denied"), 403);
    expect(await publishingQuota(access, "1784")).toBeNull();
  });

  it("lists the newest media with Graph's timestamps read", async () => {
    answer({
      data: [
        {
          id: "m-2",
          timestamp: "2026-11-04T05:50:12+0000",
          permalink: "https://www.instagram.com/p/x/",
          media_type: "video",
          media_product_type: "STORY",
        },
        { id: "m-1", timestamp: "garbage" },
        { timestamp: "2026-11-04T05:00:00+0000" },
      ],
    });
    expect(await recentMedia(access, "1784", "stories")).toEqual([
      {
        id: "m-2",
        publishedAt: new Date("2026-11-04T05:50:12.000Z"),
        permalink: "https://www.instagram.com/p/x/",
        mediaType: "VIDEO",
        productType: "STORY",
      },
      {
        id: "m-1",
        publishedAt: null,
        permalink: null,
        mediaType: null,
        productType: null,
      },
    ]);
    expect(calls[0].url).toContain(`${BASE}/1784/stories?`);
  });
});

describe("Graph refusals", () => {
  const refusal = (code: number, message: string, subcode?: number) =>
    toGraphApiError(400, graphError(code, message, subcode), "fallback");

  it("keeps Meta's codes and its message for the person", () => {
    const error = toGraphApiError(
      400,
      {
        error: {
          code: "100",
          error_subcode: "2207026",
          message: "Invalid parameter",
          error_user_msg: "The video format is not supported.",
        },
      },
      "fallback"
    );
    expect(error).toMatchObject({
      status: 400,
      graphCode: 100,
      graphSubcode: 2207026,
      message: "Invalid parameter",
      userMessage: "The video format is not supported.",
    });
    expect(toGraphApiError(500, {}, "fallback").message).toBe("fallback");
  });

  it("tells the limit, media not ready, and what may pass later", () => {
    expect(
      isGraphQuotaError(
        refusal(9, "Application request limit reached", 2207042)
      )
    ).toBe(true);
    expect(isGraphQuotaError(refusal(100, "Invalid parameter"))).toBe(false);
    expect(
      isGraphMediaNotReadyError(refusal(9007, "Media ID is not available"))
    ).toBe(true);
    expect(isGraphTransientError(refusal(4, "Too many calls"))).toBe(true);
    expect(isGraphTransientError(new Error("timeout"))).toBe(true);
    expect(isGraphTransientError(toGraphApiError(503, {}, "fallback"))).toBe(
      true
    );
    expect(isGraphTransientError(refusal(100, "Invalid parameter"))).toBe(
      false
    );
  });
});
