/** @jest-environment node */

// Click-to-WhatsApp ads through the Marketing API: each request's shape (as
// the account's live CTWA ad sets have it, and as the one validate_only call
// on the real account accepted), creating everything PAUSED, finding a lost
// answer by its name, and what each kind of Graph failure means. Graph is a
// mocked fetch: nothing here reaches Meta.

import {
  adAccountInfo,
  adReview,
  adSetBody,
  adVideoStatus,
  adsManagerAdUrl,
  campaignBody,
  createAd,
  createAdCreative,
  createAdSet,
  createCampaign,
  creativeBody,
  ctwaWelcomeMessage,
  findAdVideoByName,
  findByName,
  MetaAdsGraphError,
  pageWhatsAppLinked,
  promotablePages,
  setAdSetBudget,
  setObjectStatus,
  toMetaAdsGraphError,
  uploadAdImage,
  uploadAdVideo,
  validateAdSet,
} from "./ctwa";

const auth = { accessToken: "ads-token", adAccountId: "act_42" };

type Call = { url: URL; method: string; body: unknown; auth: string | null };
let calls: Call[] = [];
let answers: Array<{ status: number; body: unknown }> = [];

function answer(body: unknown, status = 200) {
  answers.push({ status, body });
}

const graphError = (error: Record<string, unknown>, status = 400) =>
  answer({ error: { type: "OAuthException", ...error } }, status);

beforeEach(() => {
  calls = [];
  answers = [];
  global.fetch = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        auth: headers.get("Authorization"),
      });
      const next = answers.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    }
  ) as typeof fetch;
});

const start = new Date("2026-11-04T05:00:00.000Z");
const end = new Date("2026-11-07T05:00:00.000Z");
const adSet = {
  name: "airi-products-ad1-1-adset",
  campaignId: "c1",
  pageId: "page-1",
  dailyBudgetCents: 100,
  startTime: start,
  endTime: end,
};

describe("the requests", () => {
  it("make a campaign for messages, its budget on the ad set, PAUSED", async () => {
    answer({ id: "c1" });
    expect(
      await createCampaign(auth, { name: "airi-products-ad1-1-campaign" })
    ).toBe("c1");
    expect(calls[0]).toMatchObject({
      method: "POST",
      auth: "Bearer ads-token",
    });
    expect(calls[0].url.pathname).toBe("/v25.0/act_42/campaigns");
    expect(calls[0].body).toEqual({
      name: "airi-products-ad1-1-campaign",
      objective: "OUTCOME_ENGAGEMENT",
      special_ad_categories: [],
      buying_type: "AUCTION",
      is_adset_budget_sharing_enabled: false,
      status: "PAUSED",
    });
    // The token never rides in the URL.
    expect(calls[0].url.search).not.toContain("ads-token");
  });

  it("make the ad set in the live CTWA shape: WhatsApp, KZ, Facebook only, $1 a day, PAUSED", async () => {
    answer({ id: "s1" });
    expect(await createAdSet(auth, adSet)).toBe("s1");
    expect(calls[0].url.pathname).toBe("/v25.0/act_42/adsets");
    expect(calls[0].body).toEqual({
      name: "airi-products-ad1-1-adset",
      campaign_id: "c1",
      destination_type: "WHATSAPP",
      optimization_goal: "CONVERSATIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      promoted_object: { page_id: "page-1" },
      targeting: {
        geo_locations: { countries: ["KZ"] },
        age_min: 18,
        age_max: 65,
        publisher_platforms: ["facebook"],
        targeting_automation: { advantage_audience: 1 },
      },
      daily_budget: 100,
      start_time: "2026-11-04T05:00:00.000Z",
      end_time: "2026-11-07T05:00:00.000Z",
      status: "PAUSED",
    });
    expect(adSetBody(adSet)).toEqual(calls[0].body);
  });

  it("checks an ad set with validate_only, creating nothing", async () => {
    answer({ success: true });
    await validateAdSet(auth, adSet);
    expect(calls[0].body).toEqual({
      ...adSetBody(adSet),
      execution_options: ["validate_only"],
    });
  });

  it("make the video creative with its poster, words and WhatsApp button", async () => {
    answer({ id: "cr1" });
    const params = {
      name: "airi-products-ad1-1-creative",
      pageId: "page-1",
      message: "  Жаңа кеселер  ",
      headline: "Кеселер",
      media: {
        kind: "video" as const,
        videoId: "v1",
        posterUrl: "https://storage.test/poster.jpg",
      },
    };
    expect(await createAdCreative(auth, params)).toBe("cr1");
    expect(calls[0].url.pathname).toBe("/v25.0/act_42/adcreatives");
    expect(calls[0].body).toEqual({
      name: "airi-products-ad1-1-creative",
      object_story_spec: {
        page_id: "page-1",
        video_data: {
          video_id: "v1",
          image_url: "https://storage.test/poster.jpg",
          message: "Жаңа кеселер",
          title: "Кеселер",
          call_to_action: {
            type: "WHATSAPP_MESSAGE",
            value: {
              app_destination: "WHATSAPP",
              link: "https://api.whatsapp.com/send",
            },
          },
        },
      },
    });
  });

  it("make the picture creative from the image hash, leaving out empty words", () => {
    expect(
      creativeBody({
        name: "n",
        pageId: "page-1",
        message: " ",
        headline: "",
        media: { kind: "picture", imageHash: "h1" },
      })
    ).toEqual({
      name: "n",
      object_story_spec: {
        page_id: "page-1",
        link_data: {
          image_hash: "h1",
          link: "https://api.whatsapp.com/send",
          call_to_action: {
            type: "WHATSAPP_MESSAGE",
            value: {
              app_destination: "WHATSAPP",
              link: "https://api.whatsapp.com/send",
            },
          },
        },
      },
    });
  });

  it("put the greeting and the buyer's pre-filled message in the creative, as Meta stores it", () => {
    const welcome = { greeting: " Сәлем! ", buyerMessage: "Жеткізу бар ма?" };
    const video = creativeBody({
      name: "n",
      pageId: "page-1",
      message: "m",
      headline: "h",
      media: { kind: "video", videoId: "v1", posterUrl: "https://p" },
      welcome,
    });
    const stored = video.object_story_spec.video_data?.page_welcome_message;
    expect(typeof stored).toBe("string");
    expect(JSON.parse(String(stored))).toEqual({
      type: "VISUAL_EDITOR",
      version: 2,
      landing_screen_type: "welcome_message",
      media_type: "text",
      text_format: {
        customer_action_type: "autofill_message",
        message: {
          text: "Сәлем!",
          autofill_message: { content: "Жеткізу бар ма?" },
        },
      },
      user_edit: false,
      surface: "visual_editor_new",
    });
    expect(stored).toBe(
      ctwaWelcomeMessage({
        greeting: "Сәлем!",
        buyerMessage: "Жеткізу бар ма?",
      })
    );
    const picture = creativeBody({
      name: "n",
      pageId: "page-1",
      message: "m",
      headline: "h",
      media: { kind: "picture", imageHash: "h1" },
      welcome,
    });
    expect(picture.object_story_spec.link_data?.page_welcome_message).toBe(
      stored
    );
    for (const missing of [null, { greeting: "Сәлем!", buyerMessage: " " }]) {
      const body = creativeBody({
        name: "n",
        pageId: "page-1",
        message: "m",
        headline: "h",
        media: { kind: "video", videoId: "v1", posterUrl: "https://p" },
        welcome: missing,
      });
      expect(body.object_story_spec.video_data).not.toHaveProperty(
        "page_welcome_message"
      );
    }
  });

  it("make the ad PAUSED from the ad set and the creative", async () => {
    answer({ id: "a1" });
    expect(
      await createAd(auth, {
        name: "airi-products-ad1-1-ad",
        adSetId: "s1",
        creativeId: "cr1",
      })
    ).toBe("a1");
    expect(calls[0].body).toEqual({
      name: "airi-products-ad1-1-ad",
      adset_id: "s1",
      creative: { creative_id: "cr1" },
      status: "PAUSED",
    });
    expect(campaignBody({ name: "x" }).status).toBe("PAUSED");
  });

  it("upload the video from its signed link, and the picture as base64 bytes", async () => {
    answer({ id: "v1" });
    expect(
      await uploadAdVideo(auth, {
        fileUrl: "https://storage.test/ad.mp4",
        name: "airi-products-ad1-1-video",
      })
    ).toBe("v1");
    expect(calls[0].url.pathname).toBe("/v25.0/act_42/advideos");
    expect(calls[0].body).toEqual({
      file_url: "https://storage.test/ad.mp4",
      name: "airi-products-ad1-1-video",
      title: "airi-products-ad1-1-video",
    });

    answer({ images: { "pic.jpg": { hash: "hash-1", url: "https://x" } } });
    expect(
      await uploadAdImage(auth, {
        bytes: new Uint8Array([1, 2, 3]),
        name: "pic.jpg",
      })
    ).toBe("hash-1");
    expect(calls[1].body).toEqual({ bytes: "AQID", name: "pic.jpg" });
  });

  it("read the video's processing", async () => {
    answer({ status: { video_status: "processing" } });
    expect(await adVideoStatus(auth, "v1")).toEqual({
      state: "processing",
      reason: null,
    });
    answer({ status: { video_status: "ready" } });
    expect((await adVideoStatus(auth, "v1")).state).toBe("ready");
    answer({
      status: {
        video_status: "error",
        processing_phase: {
          status: "error",
          errors: [{ code: 1, message: "Bad codec" }],
        },
      },
    });
    expect(await adVideoStatus(auth, "v1")).toEqual({
      state: "error",
      reason: "Bad codec",
    });
    expect(calls[0].url.searchParams.get("fields")).toBe("status");
  });

  it("refuse to call an answer without an id a success", async () => {
    answer({});
    await expect(createCampaign(auth, { name: "x" })).rejects.toMatchObject({
      kind: "transient",
    });
  });
});

describe("running it and reading Meta's review", () => {
  it("set the ad set's budget and end, then switch objects on", async () => {
    answer({ success: true });
    await setAdSetBudget(auth, "s1", { dailyBudgetCents: 100, endTime: end });
    expect(calls[0].url.pathname).toBe("/v25.0/s1");
    expect(calls[0].body).toEqual({
      daily_budget: 100,
      end_time: "2026-11-07T05:00:00.000Z",
    });
    answer({ success: true });
    await setObjectStatus(auth, "c1", "ACTIVE");
    expect(calls[1].body).toEqual({ status: "ACTIVE" });
  });

  it("read the review state, and Meta's reasons when it didn't approve", async () => {
    answer({ effective_status: "PENDING_REVIEW", id: "a1" });
    expect(await adReview(auth, "a1")).toEqual({
      effectiveStatus: "PENDING_REVIEW",
      feedback: null,
    });
    answer({
      effective_status: "DISAPPROVED",
      ad_review_feedback: {
        global: { "Misleading claims": "The ad promises a result." },
      },
    });
    expect(await adReview(auth, "a1")).toEqual({
      effectiveStatus: "DISAPPROVED",
      feedback: "The ad promises a result.",
    });
  });

  it("link the ad in Ads Manager by its bare account id", () => {
    expect(adsManagerAdUrl("act_42", "a1")).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads?act=42&selected_ad_ids=a1"
    );
  });
});

describe("the account, its Page and its WhatsApp link", () => {
  it("read the account's name and currency", async () => {
    answer({
      name: "Airi.chat",
      currency: "USD",
      account_status: 1,
      id: "act_42",
    });
    expect(await adAccountInfo(auth)).toEqual({
      name: "Airi.chat",
      currency: "USD",
    });
  });

  it("list the Pages the account can promote", async () => {
    answer({ data: [{ id: "page-1", name: "Airi.chat" }, { name: "no id" }] });
    expect(await promotablePages(auth)).toEqual([
      { id: "page-1", name: "Airi.chat" },
    ]);
    expect(calls[0].url.pathname).toBe("/v25.0/act_42/promote_pages");
  });

  it("answer whether the Page has WhatsApp with its own token, never the number", async () => {
    answer({
      data: [
        { id: "other", access_token: "x" },
        { id: "page-1", access_token: "page-token" },
      ],
    });
    answer({ whatsapp_number: "77000000000", id: "page-1" });
    expect(await pageWhatsAppLinked("ads-token", "page-1")).toBe(true);
    expect(calls[1].auth).toBe("Bearer page-token");
    expect(calls[1].url.searchParams.get("fields")).toBe(
      "whatsapp_number,has_whatsapp_number"
    );

    answer({ data: [{ id: "page-1", access_token: "page-token" }] });
    answer({ id: "page-1" });
    expect(await pageWhatsAppLinked("ads-token", "page-1")).toBe(false);

    answer({ data: [] });
    expect(await pageWhatsAppLinked("ads-token", "page-1")).toBeNull();
  });
});

describe("finding a lost answer by its name", () => {
  it("filter campaigns, ad sets and ads by the exact name", async () => {
    answer({ data: [{ id: "c9", name: "airi-products-ad1-1-campaign" }] });
    expect(
      await findByName(auth, "campaigns", "airi-products-ad1-1-campaign")
    ).toBe("c9");
    expect(
      JSON.parse(calls[0].url.searchParams.get("filtering") ?? "null")
    ).toEqual([
      {
        field: "name",
        operator: "EQUAL",
        value: "airi-products-ad1-1-campaign",
      },
    ]);
    answer({ data: [{ id: "x", name: "airi-products-ad1-1-campaign-old" }] });
    expect(await findByName(auth, "ads", "airi-products-ad1-1-ad")).toBeNull();
  });

  it("scan the newest creatives and videos by name", async () => {
    answer({
      data: [
        { id: "cr2", name: "other" },
        { id: "cr1", name: "airi-products-ad1-1-creative" },
      ],
    });
    expect(
      await findByName(auth, "adcreatives", "airi-products-ad1-1-creative")
    ).toBe("cr1");
    expect(calls[0].url.searchParams.get("filtering")).toBeNull();
    answer({ data: [{ id: "v7", title: "airi-products-ad1-1-video" }] });
    expect(await findAdVideoByName(auth, "airi-products-ad1-1-video")).toBe(
      "v7"
    );
  });
});

describe("a name filter rejected by Meta", () => {
  it("falls back to bounded paging and finds an object on a later page", async () => {
    graphError({ code: 100, message: "Filtering field name is not supported" });
    answer({
      data: [{ id: "other", name: "unrelated" }],
      paging: {
        cursors: { after: "page-2" },
        next: "https://graph.facebook.com/next",
      },
    });
    answer({ data: [{ id: "c9", name: "airi-products-ad1-1-campaign" }] });
    expect(
      await findByName(auth, "campaigns", "airi-products-ad1-1-campaign")
    ).toBe("c9");
    expect(calls).toHaveLength(3);
    expect(calls[0].url.searchParams.get("filtering")).not.toBeNull();
    expect(calls[1].url.searchParams.get("filtering")).toBeNull();
    expect(calls[2].url.searchParams.get("after")).toBe("page-2");
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });

  it("returns absence only when the fallback reached the end", async () => {
    graphError({ code: 100, message: "Invalid filtering parameter" });
    answer({ data: [{ id: "other", name: "not-the-requested-name" }] });
    expect(await findByName(auth, "ads", "wanted")).toBeNull();
  });

  it("treats a bounded fallback with pages remaining as incomplete, not absent", async () => {
    graphError({ code: 100, message: "Invalid filtering parameter" });
    for (let page = 0; page < 5; page++)
      answer({
        data: [{ id: `other-${page}`, name: "unrelated" }],
        paging: {
          cursors: { after: `page-${page + 1}` },
          next: "https://graph.facebook.com/next",
        },
      });
    await expect(findByName(auth, "adsets", "wanted")).rejects.toMatchObject({
      kind: "transient",
      userMessage: expect.stringContaining("lookup did not finish"),
    });
    expect(calls).toHaveLength(6);
  });

  it("does not replace an auth or unrelated refusal with an unfiltered scan", async () => {
    graphError({ code: 190, message: "Invalid token for filtering" });
    await expect(findByName(auth, "ads", "wanted")).rejects.toMatchObject({
      kind: "auth",
    });
    expect(calls).toHaveLength(1);
    graphError({ code: 100, message: "Invalid ad account" });
    await expect(findByName(auth, "ads", "wanted")).rejects.toMatchObject({
      kind: "refused",
    });
    expect(calls).toHaveLength(2);
  });
});

describe("what a failure means", () => {
  it("is auth for an expired or invalid token", async () => {
    graphError({ code: 190, message: "Error validating access token" }, 400);
    await expect(createCampaign(auth, { name: "x" })).rejects.toMatchObject({
      kind: "auth",
      code: 190,
    });
  });

  it("is transient for Meta's temporary errors, rate limits and the network", async () => {
    graphError(
      {
        code: 2,
        message: "Service temporarily unavailable",
        is_transient: true,
      },
      500
    );
    await expect(createCampaign(auth, { name: "x" })).rejects.toMatchObject({
      kind: "transient",
    });
    graphError({ code: 80004, message: "Too many calls to this ad-account" });
    await expect(createCampaign(auth, { name: "x" })).rejects.toMatchObject({
      kind: "transient",
    });
    expect(toMetaAdsGraphError(new Error("socket hang up")).kind).toBe(
      "transient"
    );
  });

  it("is whatsapp when Meta's words are about the WhatsApp number, with its words for the owner", async () => {
    graphError({
      code: 100,
      error_subcode: 2446885,
      message: "Invalid parameter",
      error_user_title: "No WhatsApp number",
      error_user_msg:
        "Connect a WhatsApp account to your Page to use this destination.",
    });
    const failure = await createAdSet(auth, adSet).catch(error => error);
    expect(failure).toBeInstanceOf(MetaAdsGraphError);
    expect(failure).toMatchObject({
      kind: "whatsapp",
      code: 100,
      subcode: 2446885,
      userMessage:
        "Connect a WhatsApp account to your Page to use this destination.",
    });
    expect(String(failure.message)).not.toContain("ads-token");
  });

  it("is refused for anything else, in Meta's words", async () => {
    graphError({
      code: 100,
      message: "Invalid parameter",
      error_user_msg: "The daily budget is too low.",
    });
    await expect(createAdSet(auth, adSet)).rejects.toMatchObject({
      kind: "refused",
      userMessage: "The daily budget is too low.",
    });
  });

  it("keeps a WhatsApp greeting validation error eligible for the no-greeting fallback", async () => {
    graphError({
      code: 100,
      message: "Invalid page_welcome_message for WhatsApp destination",
      error_user_msg: "This WhatsApp welcome greeting is not supported.",
    });
    await expect(createAdSet(auth, adSet)).rejects.toMatchObject({
      kind: "refused",
      userMessage: "This WhatsApp welcome greeting is not supported.",
    });
  });
});
