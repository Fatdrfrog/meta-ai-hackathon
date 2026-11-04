/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { productTemplate } from "@/lib/products/templates";
import type {
  ProductAdCtwaRecord,
  ProductAdPostRecord,
  ProductAdRecord,
  ProductsMetaReadiness,
} from "@/lib/products/types";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import {
  ProductWorkbench,
  type ProductWorkbenchSubject,
} from "./product-workbench";

// The workbench: labelled by the tile it opened from, focused when it opens
// and closed by Escape; the result in its frame with picture rails whose
// free picks apply themselves (one PATCH, 1.5 s after the last) and whose
// paid ones take two taps; and its one Meta action, with the confirm only
// before something public (Post) or paid (Run), and every state of the
// states board.

const WS = "workspace-1";
const AD = "751f1f77bcf86cd799439031";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const API = `/api/workspaces/${WS}/products`;
const AD_URL = `${API}/ads/${AD}`;
const META_URL = `${API}/meta`;
const VOICE_URL = `${API}/voice`;
const PUBLISH_URL = `${AD_URL}/publish`;
const CTWA_URL = `${AD_URL}/ctwa`;
const PERMALINK = "https://www.instagram.com/reel/abc/";
const ADS_MANAGER = "https://adsmanager.facebook.com/adsmanager/manage/ads";

const still = (
  kind: "room" | "studio" | "collection",
  productId: string | null,
  colourway: "white" | "sand" | null = null
) => ({
  kind,
  format: "feed" as const,
  productId,
  colourway,
  url: `https://signed.test/${kind}-${productId ?? "all"}-${colourway ?? "x"}.jpg`,
});

function adRecord(overrides: Partial<ProductAdRecord> = {}): ProductAdRecord {
  return {
    id: AD,
    status: "ready",
    step: null,
    errorCode: null,
    createdAt: "2026-11-03T09:14:00.000Z",
    requestedAt: "2026-11-03T09:14:00.000Z",
    startedAt: "2026-11-03T09:14:04.000Z",
    readyAt: "2026-11-03T09:15:04.000Z",
    renderNo: 1,
    language: "Kazakh",
    timings: {},
    idea: { kind: "new", text: null },
    motion: "shelf",
    voice: "own",
    stockVoiceId: null,
    voiceResult: null,
    hasRecording: true,
    runKind: "make",
    lastRun: null,
    picturesLeft: 3,
    openings: [
      { kind: "news", text: "Жаңа тауарлар келді", gloss: "New things are in" },
      { kind: "question", text: "Сыйлық іздеп жүрсіз бе?", gloss: "Looking?" },
      { kind: "price", text: "Бағасы төмен", gloss: "Low price" },
    ] as ProductAdRecord["openings"],
    endings: [
      { kind: "order", text: "WhatsApp-қа жазыңыз", gloss: "Write" },
      { kind: "ask", text: "Дүкенге келіңіз", gloss: "Visit" },
    ] as ProductAdRecord["endings"],
    ending: { phone: null, shopName: "Airi.chat" },
    products: [
      {
        productId: DOLL,
        name: "Кукла Лол",
        englishName: "LOL doll",
        priceText: "5 000 ₸",
        imageUrl: "https://signed.test/doll.webp",
      },
      {
        productId: MUG,
        name: "Кружка",
        englishName: "Mug",
        priceText: "500 ₸",
        imageUrl: "https://signed.test/mug.webp",
      },
    ],
    script: {
      sticker: "Жаңа тауарлар келді",
      captions: [
        { productId: DOLL, caption: "Көк көйлекті қуыршақ" },
        { productId: MUG, caption: "Күнделікті кружка" },
      ],
      priceCardTitle: "Екеуі де сөреде",
      ending: "WhatsApp-қа жазыңыз",
    },
    scenes: [
      {
        productId: DOLL,
        method: "muse",
        imageUrl: "https://signed.test/scene-doll.png",
        checked: true,
        textZone: "auto",
        useExact: false,
        pictures: [
          {
            index: 0,
            url: "https://signed.test/p0.png",
            place: "Oak table",
            current: false,
          },
          {
            index: 1,
            url: "https://signed.test/p1.png",
            place: "Playroom shelf",
            current: true,
          },
        ],
        place: {
          setting: "playroom_shelf",
          words: null,
          englishPlace: null,
        },
        redo: null,
        textOverlap: null,
      },
      {
        productId: MUG,
        method: "exact",
        imageUrl: "https://signed.test/exact-mug.png",
        checked: false,
        textZone: "auto",
        useExact: false,
        pictures: [],
        place: null,
        redo: null,
        textOverlap: null,
      },
    ],
    video: {
      url: "https://signed.test/ad.mp4",
      bytes: 3_355_443,
      seconds: 14.2,
      posterUrl: "https://signed.test/poster.jpg",
      renderNo: 1,
    },
    stills: {
      statusUrl: "https://signed.test/status.jpg",
      feedUrl: "https://signed.test/feed.jpg",
      templates: [
        still("room", DOLL),
        still("room", MUG),
        still("studio", DOLL, "white"),
        still("studio", DOLL, "sand"),
        still("studio", MUG, "white"),
        still("collection", null),
      ],
    },
    post: { text: "Жаңа тауарлар келді! Кукла Лол 5 000 ₸" },
    ctwa: {
      headline: "Жаңа ойыншықтар",
      primaryText: "Кукла мен кружка сөреде.",
      greeting: "Сәлеметсіз бе! Қайсысы ұнады?",
      questions: ["Кукла бар ма?", "Жеткізу қанша?"],
    },
    presenter: null,
    costUsd: 0.079,
    ...overrides,
  };
}

function readiness(
  overrides: {
    instagram?: Partial<ProductsMetaReadiness["instagram"]>;
    ads?: Partial<ProductsMetaReadiness["ads"]>;
    ai?: ProductsMetaReadiness["ai"];
  } = {}
): ProductsMetaReadiness {
  return {
    instagram: {
      connected: true,
      username: "airi.chat__",
      canPublish: true,
      quotaLeft: 100,
      ...overrides.instagram,
    },
    ads: {
      connected: true,
      adAccountName: "Airi.chat ad account",
      currency: "USD",
      pageName: "Airi.chat",
      pageHasWhatsApp: true,
      instagramPlacements: false,
      runEnabled: false,
      runMaxDailyCents: 100,
      runMaxDays: 3,
      ...overrides.ads,
    },
    whatsapp: { connected: true },
    ai: overrides.ai ?? { blocked: null },
  };
}

const post = (overrides: Partial<ProductAdPostRecord> = {}) =>
  ({
    id: "post-1",
    destination: "reel",
    still: null,
    slides: [],
    renderNo: 1,
    motion: "shelf",
    state: "published",
    permalink: PERMALINK,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-11-03T10:00:00.000Z",
    publishedAt: "2026-11-03T10:01:00.000Z",
    ...overrides,
  }) satisfies ProductAdPostRecord;

const ctwa = (overrides: Partial<ProductAdCtwaRecord> = {}) =>
  ({
    attempt: 1,
    asset: "video",
    state: "paused",
    effectiveStatus: "PAUSED",
    adsManagerUrl: ADS_MANAGER,
    dailyBudgetCents: null,
    endsAt: null,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  }) satisfies ProductAdCtwaRecord;

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer =
  (body: unknown, status = 200) =>
  (): Answer => ({ ok: status < 400, status, json: async () => body });

let routes: Record<string, (init?: RequestInit) => Answer | Promise<Answer>>;

const callsTo = (method: string, url: string) =>
  (global.fetch as jest.Mock).mock.calls.filter(
    ([called, init]) => called === url && (init?.method ?? "GET") === method
  );
const bodyOf = (method: string, url: string, at = 0) =>
  JSON.parse(String(callsTo(method, url)[at]![1].body)) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  sessionStorage.clear();
  routes = {
    [`GET ${AD_URL}`]: answer({ ad: adRecord() }),
    [`GET ${META_URL}`]: answer({ meta: readiness() }),
    [`GET ${VOICE_URL}`]: answer({ voice: null }),
  };
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${init?.method} ${url}`);
    return route(init);
  }) as unknown as typeof fetch;
  window.matchMedia = jest.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => jest.useRealTimers());

function bench(
  templateId: Parameters<typeof productTemplate>[0],
  {
    subject = { kind: "ad", adId: AD },
    priceToCheck = false,
    onClose = jest.fn(),
    onRetryMake,
    onCheckPrice,
  }: {
    subject?: ProductWorkbenchSubject;
    priceToCheck?: boolean;
    onClose?: () => void;
    onRetryMake?: () => void;
    onCheckPrice?: () => void;
  } = {}
) {
  const template = productTemplate(templateId)!;
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <button id={`tile-${template.id}`} type="button">
        {template.label}
      </button>
      <ProductWorkbench
        workspaceId={WS}
        template={template}
        subject={subject}
        picks={[]}
        priceToCheck={priceToCheck}
        tileId={`tile-${template.id}`}
        onClose={onClose}
        onRetryMake={onRetryMake}
        onCheckPrice={onCheckPrice}
      />
    </SWRConfig>
  );
}

/** The footer's Meta action, once the ad and readiness are in. */
const action = (name: RegExp | string) => screen.findByRole("button", { name });

/** The footer's Meta action once it can be pressed. */
async function enabledAction(name: RegExp | string) {
  await waitFor(() =>
    expect(screen.getByRole("button", { name })).toBeEnabled()
  );
  return screen.getByRole("button", { name });
}

describe("the workbench", () => {
  it("keeps editable opening and ending controls outside the rendered video", async () => {
    bench("reel_shelf");
    const opening = await screen.findByRole("button", {
      name: /Opening 1 of 3/,
    });
    const ending = screen.getByRole("button", { name: /Ending 1 of 2/ });
    expect(opening.closest("[data-frame]")).toBeNull();
    expect(ending.closest("[data-frame]")).toBeNull();
  });
  it("offers the price check instead of retrying an invalid make", () => {
    const onCheckPrice = jest.fn();
    bench("chat_kit", {
      subject: { kind: "ad-pending", error: "price_to_check" },
      onCheckPrice,
      onRetryMake: jest.fn(),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Tap the red tag first"
    );
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check this price" }));
    expect(onCheckPrice).toHaveBeenCalledTimes(1);
  });

  it("reuses a lost publish intent after the workbench is reopened", async () => {
    routes[`POST ${PUBLISH_URL}`] = async () => {
      throw new TypeError("Lost response");
    };
    const first = bench("reel_shelf");
    fireEvent.click(await enabledAction("Post Reel"));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Post",
      })
    );
    await screen.findByText(
      "We couldn't confirm the result. Try again to check the same post."
    );
    const original = bodyOf("POST", PUBLISH_URL).requestId;
    first.unmount();
    routes[`POST ${PUBLISH_URL}`] = answer({ post: post() }, 202);
    bench("reel_shelf");
    fireEvent.click(await enabledAction("Post Reel"));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Post",
      })
    );
    await screen.findByRole("link", { name: "View post" });
    expect(bodyOf("POST", PUBLISH_URL, 1).requestId).toBe(original);
    expect(sessionStorage.length).toBe(0);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Shelf ad" })).toHaveFocus()
    );
  });

  it("does not offer or send a caption on a Story", async () => {
    routes[`POST ${PUBLISH_URL}`] = answer(
      { post: post({ destination: "story" }) },
      202
    );
    bench("story_video");
    fireEvent.click(await enabledAction("Post Story"));
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).queryByRole("button", { name: /^Edit the caption/ })
    ).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Post" }));
    await waitFor(() => expect(callsTo("POST", PUBLISH_URL)).toHaveLength(1));
    expect(bodyOf("POST", PUBLISH_URL)).not.toHaveProperty("caption");
  });

  it("allows another product's picture after the first product was posted", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [
            post({
              destination: "post",
              still: { kind: "studio", productId: DOLL, colourway: "white" },
            }),
          ],
          ctwa: null,
        },
      }),
    });
    bench("post_studio");
    await screen.findByRole("link", { name: "View post" });
    fireEvent.click(screen.getByRole("button", { name: "Shot 2: Кружка" }));
    expect(await enabledAction("Post")).toBeEnabled();
    expect(
      screen.queryByRole("link", { name: "View post" })
    ).not.toBeInTheDocument();
  });
  it("is labelled by its tile, takes focus, and closes on Escape", async () => {
    const onClose = jest.fn();
    bench("reel_shelf", { onClose });

    const workbench = screen.getByRole("region", { name: "Shelf ad" });
    expect(workbench).toHaveFocus();
    expect(screen.getByText("Post Reel")).toBeInTheDocument();

    fireEvent.keyDown(workbench, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.findByLabelText("Your video ad");
  });

  it("posts a Reel only after its confirm, and shows the receipt", async () => {
    routes[`POST ${PUBLISH_URL}`] = answer({ post: post() }, 202);
    bench("reel_shelf");
    const press = await enabledAction("Post Reel");
    expect(screen.getAllByText("@airi.chat__")[0]).toBeInTheDocument();
    fireEvent.click(press);

    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("Public. Everyone can see it.")
    ).toBeVisible();
    expect(callsTo("POST", PUBLISH_URL)).toHaveLength(0);
    // Enter in the sheet posts nothing.
    fireEvent.keyDown(sheet, { key: "Enter" });
    expect(callsTo("POST", PUBLISH_URL)).toHaveLength(0);

    fireEvent.click(within(sheet).getByRole("button", { name: "Post" }));
    await waitFor(() => expect(callsTo("POST", PUBLISH_URL)).toHaveLength(1));
    expect(bodyOf("POST", PUBLISH_URL)).toEqual({
      requestId: expect.any(String),
      destination: "reel",
    });
    expect(
      await screen.findByRole("link", { name: "View post" })
    ).toHaveAttribute("href", PERMALINK);
    expect(screen.getByText(/^On Instagram · /)).toBeInTheDocument();
  });

  it("sends an edited caption, and posts the shot's Studio colourway", async () => {
    routes[`POST ${PUBLISH_URL}`] = answer(
      { post: post({ destination: "post", state: "processing" }) },
      202
    );
    bench("post_studio");
    fireEvent.click(await screen.findByRole("button", { name: "Sand" }));
    const press = await enabledAction("Post");
    fireEvent.click(press);
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(
      within(sheet).getByRole("button", { name: /^Edit the caption/ })
    );
    fireEvent.change(within(sheet).getByRole("textbox"), {
      target: { value: "My own words" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Post" }));
    await waitFor(() => expect(callsTo("POST", PUBLISH_URL)).toHaveLength(1));
    expect(bodyOf("POST", PUBLISH_URL)).toEqual({
      requestId: expect.any(String),
      destination: "post",
      still: { kind: "studio", productId: DOLL, colourway: "sand" },
      caption: "My own words",
    });
    expect(
      await screen.findByText("Instagram is getting it ready…")
    ).toBeVisible();
  });

  it("keeps Post off while a pick has a price to check", async () => {
    bench("reel_shelf", { priceToCheck: true });
    await screen.findByLabelText("Your video ad");
    expect(await action("Post Reel")).toBeDisabled();
    expect(screen.getByText("Tap the red tag first")).toBeVisible();
  });

  it("turns Post into Connect Instagram when Instagram can't post", async () => {
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ instagram: { connected: false, username: null } }),
    });
    bench("reel_shelf");
    expect(
      await screen.findByRole("link", { name: "Connect Instagram" })
    ).toHaveAttribute(
      "href",
      `/panel/w/${WS}/settings/integrations?integration=instagram`
    );
  });

  it("says Instagram's daily limit is reached", async () => {
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ instagram: { quotaLeft: 0 } }),
    });
    bench("reel_shelf");
    expect(
      await screen.findByText("Instagram's daily limit is reached")
    ).toBeVisible();
    expect(await action("Post Reel")).toBeDisabled();
  });

  it("says why a post failed, that nothing was posted, and tries again", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [
            post({
              state: "failed",
              permalink: null,
              publishedAt: null,
              errorCode: "post_failed",
              errorMessage: "Instagram couldn't fetch the video.",
            }),
          ],
          ctwa: null,
        },
      }),
    });
    bench("reel_shelf");
    expect(
      await screen.findByText(
        "Instagram couldn't fetch the video. Nothing was posted."
      )
    ).toBeVisible();
    const again = await enabledAction("Try again");
    fireEvent.click(again);
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("says a post failed in one sentence when Instagram gave no reason", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [
            post({
              state: "failed",
              permalink: null,
              publishedAt: null,
              errorCode: "post_failed",
              errorMessage: null,
            }),
          ],
          ctwa: null,
        },
      }),
    });
    bench("reel_shelf");
    expect(
      await screen.findByText("Instagram refused it. Nothing was posted.")
    ).toBeVisible();
  });
});

describe("free changes apply themselves", () => {
  it("sends one PATCH 1.5 s after the last look picked", async () => {
    routes[`PATCH ${AD_URL}`] = answer(
      { ad: adRecord({ status: "making", runKind: "render", renderNo: 2 }) },
      202
    );
    bench("reel_shelf");
    const wall = await screen.findByRole("button", { name: /^Wall\./ });
    jest.useFakeTimers();
    fireEvent.click(wall);
    fireEvent.click(screen.getByRole("button", { name: /^Oak table\./ }));
    await act(async () => {
      jest.advanceTimersByTime(1499);
    });
    expect(callsTo("PATCH", AD_URL)).toHaveLength(0);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(callsTo("PATCH", AD_URL)).toHaveLength(1);
    expect(bodyOf("PATCH", AD_URL)).toEqual({
      scenes: [{ productId: DOLL, pictureIndex: 0 }],
    });
    expect(screen.getByText("Updating")).toBeVisible();
  });

  it("cycles the opening with a tap on its sticker", async () => {
    routes[`PATCH ${AD_URL}`] = answer(
      { ad: adRecord({ status: "making", runKind: "render", renderNo: 2 }) },
      202
    );
    bench("reel_shelf");
    const sticker = await screen.findByRole("button", {
      name: /Opening 1 of 3/,
    });
    jest.useFakeTimers();
    fireEvent.click(sticker);
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(bodyOf("PATCH", AD_URL)).toEqual({
      sticker: "Сыйлық іздеп жүрсіз бе?",
    });
  });

  it("makes the video again in the tile's motion", async () => {
    routes[`PATCH ${AD_URL}`] = answer(
      {
        ad: adRecord({
          status: "making",
          runKind: "render",
          renderNo: 2,
          motion: "filmed_sold",
        }),
      },
      202
    );
    bench("reel_filmed_sold");
    await waitFor(() => expect(callsTo("PATCH", AD_URL)).toHaveLength(1), {
      timeout: 3000,
    });
    expect(bodyOf("PATCH", AD_URL)).toEqual({ motion: "filmed_sold" });
  });

  it("starts a New place only on its second tap", async () => {
    const SCENE_URL = `${AD_URL}/scenes/${DOLL}`;
    routes[`POST ${SCENE_URL}`] = answer(
      { ad: adRecord({ status: "making", runKind: "scene", renderNo: 2 }) },
      202
    );
    bench("reel_shelf");
    const place = await screen.findByRole("button", { name: /^New place\./ });
    fireEvent.click(place);
    expect(callsTo("POST", SCENE_URL)).toHaveLength(0);
    expect(screen.getByText("Make · 1 picture")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Make · 1 picture/ }));
    await waitFor(() => expect(callsTo("POST", SCENE_URL)).toHaveLength(1));
    expect(bodyOf("POST", SCENE_URL)).toEqual({
      requestId: expect.any(String),
      setting: "gift_table",
    });
  });

  it("locks New place while AI is off for the company", async () => {
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ ai: { blocked: "ai_disabled" } }),
    });
    bench("reel_shelf");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^New place\./ })
      ).toBeDisabled()
    );
    expect(screen.getAllByText("AI is off for your company")[0]).toBeVisible();
  });

  it("plays an Airi voice on its first tap and applies it on the second", async () => {
    const SAMPLES = `${VOICE_URL}/samples?language=kk`;
    const VOICE_RUN = `${AD_URL}/voice`;
    routes[`GET ${SAMPLES}`] = answer({
      samples: [
        {
          voiceId: "cgSgspJ2msm6clMCkdW9",
          name: "Jessica",
          about: "Bright and warm",
          url: "https://signed.test/jessica.mp3",
        },
      ],
    });
    routes[`POST ${VOICE_RUN}`] = answer(
      { ad: adRecord({ status: "making", runKind: "voice", renderNo: 2 }) },
      202
    );
    const play = jest
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    bench("reel_shelf");
    const jessica = await screen.findByRole("button", { name: "Jessica" });
    await waitFor(() => expect(jessica).toBeEnabled());
    fireEvent.click(jessica);
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(callsTo("POST", VOICE_RUN)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Jessica: Make · $0.02" })
    );
    await waitFor(() => expect(callsTo("POST", VOICE_RUN)).toHaveLength(1));
    expect(bodyOf("POST", VOICE_RUN)).toEqual({
      requestId: expect.any(String),
      voice: "stock",
      stockVoiceId: "cgSgspJ2msm6clMCkdW9",
    });
    play.mockRestore();
  });
});

describe("the WhatsApp ad", () => {
  it.each(["paused", "failed"] as const)(
    "does not claim zero spend after a Run ended %s",
    async state => {
      const message =
        "The campaign was paused. Check Ads Manager for any delivery.";
      routes[`GET ${AD_URL}`] = answer({
        ad: adRecord({
          meta: {
            posts: [],
            ctwa: ctwa({
              state,
              effectiveStatus:
                state === "paused" ? "CAMPAIGN_PAUSED" : "DISAPPROVED",
              dailyBudgetCents: 100,
              errorMessage: message,
            }),
          },
        }),
      });
      bench("ctwa_video");
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByText(/nothing was spent/i)).not.toBeInTheDocument();
    }
  );
  it("previews the first product's Studio fallback rather than another product's room", async () => {
    const record = adRecord();
    record.stills = {
      statusUrl: null,
      feedUrl: null,
      templates: [still("room", MUG), still("studio", DOLL, "white")],
    };
    routes[`GET ${AD_URL}`] = answer({ ad: record });
    bench("ctwa_picture");
    expect(
      await screen.findByAltText(productTemplate("ctwa_picture")!.label)
    ).toHaveAttribute("src", still("studio", DOLL, "white").url);
    expect(await enabledAction("Create ad")).toBeEnabled();
  });
  it("creates a picture instead of showing the paused video's receipt", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({ meta: { posts: [], ctwa: ctwa() } }),
    });
    routes[`POST ${CTWA_URL}`] = answer(
      { ctwa: ctwa({ asset: "picture", attempt: 2 }) },
      202
    );
    bench("ctwa_picture");
    fireEvent.click(await enabledAction("Create ad"));
    await waitFor(() => expect(callsTo("POST", CTWA_URL)).toHaveLength(1));
    expect(bodyOf("POST", CTWA_URL).asset).toBe("picture");
    expect(
      await screen.findByRole("link", { name: "Ads Manager" })
    ).toBeVisible();
  });

  it("does not run or replace a different asset that is already running", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [],
          ctwa: ctwa({ state: "running", effectiveStatus: "ACTIVE" }),
        },
      }),
    });
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ ads: { runEnabled: true } }),
    });
    bench("ctwa_picture");
    expect(
      await screen.findByText(/The other WhatsApp ad format is running/)
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Run" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create ad" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });

  it("keeps an uncertain activation honest and polls until Meta confirms it", async () => {
    jest.useFakeTimers();
    const uncertain = ctwa({
      state: "running",
      effectiveStatus: null,
      errorMessage: "Meta has not confirmed whether the ad is active.",
    });
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({ meta: { posts: [], ctwa: uncertain } }),
    });
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ ads: { runEnabled: true } }),
    });
    routes[`GET ${CTWA_URL}`] = answer({
      ctwa: ctwa({ state: "running", effectiveStatus: "ACTIVE" }),
    });
    bench("ctwa_video");
    expect((await screen.findAllByText("Checking Meta"))[0]).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      uncertain.errorMessage!
    );
    expect(
      screen.queryByRole("button", { name: "Run" })
    ).not.toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    expect(callsTo("GET", CTWA_URL)).toHaveLength(1);
    expect(screen.getAllByText("Running")[0]).toBeVisible();
  });
  it("is created paused with no confirm, and shows Ads Manager", async () => {
    routes[`POST ${CTWA_URL}`] = answer({ ctwa: ctwa() }, 202);
    bench("ctwa_video");
    expect(
      await screen.findByText("Сәлеметсіз бе! Қайсысы ұнады?")
    ).toBeVisible();
    expect(
      screen.getByText(
        "Created paused. Meta may review the ad; it will not spend until you run it."
      )
    ).toBeVisible();
    const create = await enabledAction("Create ad");
    fireEvent.click(create);
    await waitFor(() => expect(callsTo("POST", CTWA_URL)).toHaveLength(1));
    expect(bodyOf("POST", CTWA_URL)).toEqual({
      requestId: expect.any(String),
      asset: "video",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(callsTo("POST", `${CTWA_URL}/run`)).toHaveLength(0);
    expect(
      await screen.findByRole("link", { name: "Ads Manager" })
    ).toHaveAttribute("href", ADS_MANAGER);
    expect(screen.getAllByText("Paused")[0]).toBeVisible();
  });

  it("waits for the WhatsApp number on the Page, with the fix", async () => {
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ ads: { pageHasWhatsApp: false } }),
    });
    bench("ctwa_video");
    expect(
      await screen.findByRole("link", { name: "Link in Business Suite" })
    ).toBeVisible();
    expect(await action("Create ad")).toBeDisabled();
    // Check again reads past the server's cache: once the number is
    // linked, the fix goes and Create ad can be pressed.
    routes[`GET ${META_URL}?fresh=1`] = answer({ meta: readiness() });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(callsTo("GET", `${META_URL}?fresh=1`)).toHaveLength(1)
    );
    expect(await enabledAction("Create ad")).toBeEnabled();
    expect(
      screen.queryByRole("link", { name: "Link in Business Suite" })
    ).not.toBeInTheDocument();
  });

  it("marks the step a failed ad stopped at, and resumes it with Try again", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [],
          ctwa: ctwa({
            state: "failed",
            effectiveStatus: null,
            adsManagerUrl: null,
            errorCode: "ctwa_failed",
            errorMessage: "Meta refused the ad set's budget.",
            failedStep: "adset",
          }),
        },
      }),
    });
    routes[`POST ${CTWA_URL}`] = answer(
      { ctwa: ctwa({ state: "adset", failedStep: null }) },
      202
    );
    routes[`GET ${CTWA_URL}`] = answer({
      ctwa: ctwa({ state: "adset", failedStep: null }),
    });
    bench("ctwa_video");
    expect(
      await screen.findByText(
        "Meta refused the ad set's budget. Nothing was spent."
      )
    ).toBeVisible();
    const steps = screen.getByRole("list", { name: "Made at Meta" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map(item => item.getAttribute("data-state"))).toEqual([
      "done",
      "done",
      "failed",
      "next",
      "next",
    ]);
    expect(items[2]).toHaveTextContent("Ad set, stopped here");
    fireEvent.click(await enabledAction("Try again"));
    await waitFor(() => expect(callsTo("POST", CTWA_URL)).toHaveLength(1));
  });

  it("offers Create again once Meta didn't approve the ad", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [],
          ctwa: ctwa({
            state: "failed",
            effectiveStatus: "DISAPPROVED",
            errorCode: "ctwa_failed",
            errorMessage: null,
            failedStep: null,
          }),
        },
      }),
    });
    bench("ctwa_video");
    expect(await enabledAction("Create again")).toBeEnabled();
    // Meta's reason is missing: one sentence, not a doubled one.
    expect(
      screen.getByText("Meta refused it. Nothing was spent.")
    ).toBeVisible();
    const items = within(
      screen.getByRole("list", { name: "Made at Meta" })
    ).getAllByRole("listitem");
    expect(items.every(item => item.dataset.state === "done")).toBe(true);
  });

  it("says why Meta refused a Run, and that the ad stays paused", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({
        meta: {
          posts: [],
          ctwa: ctwa({ errorMessage: "The ad account has no payment method." }),
        },
      }),
    });
    bench("ctwa_video");
    expect(
      await screen.findByText("The ad account has no payment method.")
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Ads Manager" })).toBeVisible();
  });

  it("reads readiness again when Create ad finds no WhatsApp on the Page", async () => {
    routes[`POST ${CTWA_URL}`] = () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: "WhatsApp is not linked",
        code: "page_whatsapp_missing",
      }),
    });
    routes[`GET ${META_URL}?fresh=1`] = answer({
      meta: readiness({ ads: { pageHasWhatsApp: false } }),
    });
    bench("ctwa_video");
    fireEvent.click(await enabledAction("Create ad"));
    expect(
      await screen.findByRole("link", { name: "Link in Business Suite" })
    ).toBeVisible();
    expect(callsTo("GET", `${META_URL}?fresh=1`)).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "WhatsApp isn't linked to your Facebook Page yet. Link it in Business Suite. Nothing was spent."
    );
  });

  it("turns Create ad into Connect Meta Ads", async () => {
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ ads: { connected: false } }),
    });
    bench("ctwa_video");
    expect(
      await screen.findByRole("link", { name: "Connect Meta Ads" })
    ).toHaveAttribute(
      "href",
      `/panel/w/${WS}/settings/integrations?integration=meta_ads`
    );
  });

  it("runs a paused ad only after its capped confirm", async () => {
    routes[`GET ${META_URL}`] = answer({
      meta: readiness({ ads: { runEnabled: true } }),
    });
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({ meta: { posts: [], ctwa: ctwa() } }),
    });
    routes[`POST ${CTWA_URL}/run`] = answer({
      ctwa: ctwa({
        state: "running",
        effectiveStatus: "PENDING_REVIEW",
        dailyBudgetCents: 100,
        endsAt: "2026-11-07T10:00:00.000Z",
      }),
    });
    bench("ctwa_video");
    fireEvent.click(await action("Run"));
    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText("At most $3 · Meta reviews it before it runs")
    ).toBeVisible();
    expect(
      within(sheet).getByRole("button", { name: "More a day" })
    ).toBeDisabled();
    expect(callsTo("POST", `${CTWA_URL}/run`)).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole("button", { name: "Run · $3" }));
    await waitFor(() =>
      expect(callsTo("POST", `${CTWA_URL}/run`)).toHaveLength(1)
    );
    expect(bodyOf("POST", `${CTWA_URL}/run`)).toEqual({
      dailyBudgetCents: 100,
      days: 3,
    });
    expect((await screen.findAllByText("In review"))[0]).toBeVisible();
  });
});

describe("before the ad, and the kit", () => {
  it("says why a make was refused, and tries again", () => {
    const onRetryMake = jest.fn();
    bench("reel_shelf", {
      subject: { kind: "ad-pending", error: "failed" },
      onRetryMake,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "That didn't work. Try again."
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryMake).toHaveBeenCalledTimes(1);
  });

  it("locks a make while AI is off for the company", () => {
    bench("reel_shelf", {
      subject: { kind: "ad-pending", error: "ai_disabled" },
      onRetryMake: jest.fn(),
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "AI is off for your company"
    );
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
  });

  it("shows the steps while the make is asked for", () => {
    bench("reel_shelf", { subject: { kind: "ad-pending", error: null } });
    expect(screen.getByText("Writing the words")).toBeVisible();
    expect(screen.getByText("You can keep picking.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Post Reel" })).toBeDisabled();
  });

  it("makes the carousel and the order form with Create on WhatsApp", async () => {
    const PLAN = `${API}/kits?products=${DOLL}%2C${MUG}`;
    const KITS = `${API}/kits`;
    routes[`GET ${PLAN}`] = answer({
      language: "kk",
      languageIsSpoken: true,
      products: [DOLL, MUG].map((id, index) => ({
        id,
        name: index === 0 ? "Кукла Лол" : "Кружка",
        price: index === 0 ? 5000 : 500,
        currency: "KZT",
        priceIsFrom: false,
        hasPhoto: true,
        hasCutout: true,
        imageUrl: `https://signed.test/${id}.webp`,
      })),
      whatsapp: { connected: true, displayPhone: null },
      latestKit: null,
    });
    routes[`POST ${KITS}`] = answer({
      kit: {
        id: "kit-1",
        createdAt: "2026-11-03T10:00:00.000Z",
        language: "kk",
        productIds: [DOLL, MUG],
        importId: null,
        parts: {
          carousel: {
            state: "submitted",
            templateId: "t1",
            templateName: "airi_products_1",
            cardCount: 2,
            metaStatus: "PENDING",
            metaReason: null,
            approvedAt: null,
            error: null,
            edited: false,
            earlier: [],
          },
          orderForm: {
            state: "ready",
            flowId: "f1",
            flowName: "Order form",
            productCount: 2,
            error: null,
            edited: false,
            version: 1,
            earlier: [],
          },
        },
        status: "waiting_for_meta",
        pricesChanged: false,
      },
    });
    routes[`GET ${API}/kits/kit-1`] = answer({ kit: null }, 404);
    bench("chat_kit", {
      subject: { kind: "kit", productIds: [DOLL, MUG], importId: null },
    });
    const create = await enabledAction("Create on WhatsApp");
    create.focus();
    expect(create).toHaveFocus();
    fireEvent.click(create);
    await waitFor(() => expect(callsTo("POST", KITS)).toHaveLength(1));
    expect(bodyOf("POST", KITS)).toMatchObject({
      productIds: [DOLL, MUG],
      make: { carousel: true, orderForm: true },
      language: "kk",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Create on WhatsApp" })
      ).not.toBeInTheDocument()
    );
    expect(
      screen.getByRole("region", { name: productTemplate("chat_kit")!.label })
    ).toHaveFocus();
  });
});
