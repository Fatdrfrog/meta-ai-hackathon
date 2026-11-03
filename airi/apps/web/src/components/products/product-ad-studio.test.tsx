/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ProductAdBrief, ProductAdRecord } from "@/lib/products/types";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { AdStudio, type AdStudioView } from "./product-ad-studio";

// The video ad studio: the brief and its consent gate, the honest making
// list, the finished ad with its downloads and copy, a failed one, and the
// phone's bar with the one main action.

const WS = "workspace-1";
const DOLL = "651f1f77bcf86cd799439011";
const MUG = "651f1f77bcf86cd799439012";
const AD = "751f1f77bcf86cd799439031";
const API = `/api/workspaces/${WS}/products`;
const BRIEF_URL = `${API}/ads/brief?products=${DOLL},${MUG}`;
const ADS_URL = `${API}/ads`;
const AD_URL = `${API}/ads/${AD}`;
const NBSP = " ";
// Not a real number: the ad shows whatever Meta displays.
const SHOP_NUMBER = "shop-number";

const brief = (overrides: Partial<ProductAdBrief> = {}): ProductAdBrief => ({
  products: [
    {
      productId: DOLL,
      name: "Кукла Лол",
      englishName: "LOL doll",
      priceText: `5${NBSP}000${NBSP}₸`,
      imageUrl: "https://signed.test/doll.webp",
      problem: null,
      hasVoice: true,
    },
    {
      productId: MUG,
      name: "Кружка Web UMN",
      englishName: "Web UMN mug",
      priceText: `500${NBSP}₸`,
      imageUrl: "https://signed.test/mug.webp",
      problem: null,
      hasVoice: false,
    },
  ],
  missing: 0,
  language: "Kazakh",
  wordsCode: "kk",
  presenter: { imageUrl: "https://signed.test/presenter.webp" },
  ending: { phone: SHOP_NUMBER, shopName: "QazOner Group" },
  blocked: null,
  ...overrides,
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function adRecord(overrides: Partial<ProductAdRecord> = {}): ProductAdRecord {
  return {
    id: AD,
    status: "ready",
    step: null,
    errorCode: null,
    createdAt: "2026-11-02T09:14:00.000Z",
    requestedAt: "2026-11-02T09:14:00.000Z",
    startedAt: "2026-11-02T09:14:04.000Z",
    readyAt: "2026-11-02T09:15:04.000Z",
    renderNo: 1,
    language: "Kazakh",
    timings: {
      script: {
        startedAt: "2026-11-02T09:14:04.000Z",
        finishedAt: "2026-11-02T09:14:11.000Z",
      },
      video: {
        startedAt: "2026-11-02T09:14:30.000Z",
        finishedAt: "2026-11-02T09:15:02.000Z",
      },
    },
    idea: { kind: "new", text: null },
    voice: "own",
    ending: { phone: SHOP_NUMBER, shopName: "QazOner Group" },
    products: [
      {
        productId: DOLL,
        name: "Кукла Лол",
        englishName: "LOL doll",
        priceText: `5${NBSP}000${NBSP}₸`,
        imageUrl: "https://signed.test/doll.webp",
      },
      {
        productId: MUG,
        name: "Кружка Web UMN",
        englishName: "Web UMN mug",
        priceText: `500${NBSP}₸`,
        imageUrl: "https://signed.test/mug.webp",
      },
    ],
    script: {
      sticker: "Сөреде жаңа тауарлар",
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
      },
      {
        productId: MUG,
        method: "exact",
        imageUrl: "https://signed.test/exact-mug.png",
        checked: false,
      },
    ],
    video: {
      url: "https://signed.test/ad.mp4",
      bytes: 3_355_443,
      seconds: 14.2,
      posterUrl: "https://signed.test/poster.jpg",
    },
    stills: {
      statusUrl: "https://signed.test/status.jpg",
      feedUrl: "https://signed.test/feed.jpg",
    },
    post: {
      text: `Сөремізге жаңа тауарлар келді!\n\nКукла Лол — 5${NBSP}000${NBSP}₸`,
    },
    ctwa: {
      headline: "Жаңа ойыншықтар",
      primaryText: "Кукла мен кружка сөреде күтіп тұр.",
      greeting: "Сәлеметсіз бе! Қайсысы ұнады?",
      questions: ["Кукла бар ма?", "Жеткізу қанша?", "Тапсырыс беремін"],
    },
    presenter: null,
    costUsd: 0.052,
    ...overrides,
  };
}

const making = (overrides: Partial<ProductAdRecord> = {}) =>
  adRecord({
    status: "making",
    step: "pictures",
    requestedAt: ago(38_000),
    startedAt: ago(36_000),
    readyAt: null,
    timings: {
      script: { startedAt: ago(36_000), finishedAt: ago(29_000) },
      pictures: { startedAt: ago(29_000), finishedAt: null },
    },
    video: null,
    stills: { statusUrl: "https://signed.test/status.jpg", feedUrl: null },
    post: null,
    ctwa: null,
    ...overrides,
  });

type Answer = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  blob?: () => Promise<Blob>;
};
const answer =
  (body: unknown, status = 200) =>
  (): Answer => ({ ok: status < 400, status, json: async () => body });

let routes: Record<string, (init?: RequestInit) => Answer | Promise<Answer>>;

const callsTo = (method: string, url: string) =>
  (global.fetch as jest.Mock).mock.calls.filter(
    ([called, init]) => called === url && (init?.method ?? "GET") === method
  );
const bodyOf = (method: string, url: string) =>
  JSON.parse(String(callsTo(method, url)[0]![1].body)) as Record<
    string,
    unknown
  >;

const writeText = jest.fn();

beforeEach(() => {
  routes = {
    [`GET ${BRIEF_URL}`]: answer({ brief: brief() }),
    [`POST ${ADS_URL}`]: answer({ ad: making() }, 201),
    [`GET ${AD_URL}`]: answer({ ad: adRecord() }),
  };
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${init?.method} ${url}`);
    return route(init);
  }) as unknown as typeof fetch;
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const props = {
  onCreated: jest.fn(),
  onChangeProducts: jest.fn(),
  onClose: jest.fn(),
};

function open(view: AdStudioView) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AdStudio workspaceId={WS} view={view} {...props} />
    </SWRConfig>
  );
}

const openBrief = () => open({ kind: "new", productIds: [DOLL, MUG] });

const makeButton = () => screen.getByRole("button", { name: "Make the ad" });

describe("the brief", () => {
  beforeEach(() => jest.clearAllMocks());

  it("starts filled in: locked prices, new on the shelf, your voice, nobody shown, the cost before spending", async () => {
    openBrief();

    expect(
      await screen.findByRole("button", { name: "Make the ad" })
    ).toBeEnabled();
    expect(screen.getAllByTitle("Кукла Лол")).toHaveLength(1);
    expect(callsTo("GET", BRIEF_URL)).toHaveLength(1);
    expect(
      screen.getAllByText("Price from your shelf:", {
        exact: false,
      })
    ).toHaveLength(2);
    expect(
      screen.getByText("Prices come from your shelf.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "New on the shelf" })
    ).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Your voice, from the video" })
    ).toBeChecked();
    // One of two products has a clip of the owner saying its price.
    expect(
      screen.getByText(
        /A product without a clip of you saying its price stays silent\./
      )
    ).toBeInTheDocument();
    // Honest about the clean-up: a music bed under the words stays audible.
    expect(
      screen.getByText(/background noise turned down/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/music taken out/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Show them at the end of the ad" })
    ).not.toBeChecked();
    expect(
      screen.getByText("Cut out of your video by SAM 3.1")
    ).toBeInTheDocument();
    expect(
      screen.getByText(`“Write to us on WhatsApp” with ${SHOP_NUMBER}`)
    ).toBeInTheDocument();
    expect(
      screen.getByText("Kazakh, the language you spoke")
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 AI action · about a minute · you can leave this page")
    ).toBeInTheDocument();
    expect(makeButton()).toBeEnabled();
  });

  it("makes the ad from the brief and hands its id to the page", async () => {
    openBrief();
    fireEvent.click(await screen.findByRole("button", { name: "Make the ad" }));

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(AD));
    expect(bodyOf("POST", ADS_URL)).toEqual({
      requestId: expect.any(String),
      productIds: [DOLL, MUG],
      idea: { kind: "new" },
      voice: "own",
      presenter: { use: false, consent: false },
    });
  });

  it("shows the person from the video only with the owner's word that they agreed", async () => {
    openBrief();
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Show them at the end of the ad",
      })
    );

    expect(makeButton()).toBeDisabled();
    expect(
      screen.getByText("Tick that they agreed, or leave them out.")
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "This is me, or they agreed to appear in ads.",
      })
    );
    expect(makeButton()).toBeEnabled();
    fireEvent.click(makeButton());

    await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
    expect(bodyOf("POST", ADS_URL).presenter).toEqual({
      use: true,
      consent: true,
    });
  });

  it("offers no person when the video has nobody cut out", async () => {
    routes[`GET ${BRIEF_URL}`] = answer({ brief: brief({ presenter: null }) });
    openBrief();
    await screen.findByText("Prices come from your shelf.");
    expect(
      screen.queryByRole("checkbox", { name: "Show them at the end of the ad" })
    ).not.toBeInTheDocument();
  });

  it("takes the owner's own words, and waits for them", async () => {
    openBrief();
    fireEvent.click(
      await screen.findByRole("radio", { name: "Your own words" })
    );

    const words = screen.getByRole("textbox", {
      name: "Your idea, in a few words",
    });
    expect(words).toHaveFocus();
    expect(words).toHaveAttribute("maxLength", "120");
    expect(makeButton()).toBeDisabled();
    expect(
      screen.getByText("Write your idea, or pick another one.")
    ).toBeInTheDocument();

    fireEvent.change(words, { target: { value: "  Алматы бойынша жеткізу " } });
    expect(screen.getByText("25/120")).toBeInTheDocument();
    fireEvent.click(makeButton());

    await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
    expect(bodyOf("POST", ADS_URL).idea).toEqual({
      kind: "own",
      text: "Алматы бойынша жеткізу",
    });
  });

  it("makes a silent ad when the video has no clip of the owner saying a price", async () => {
    routes[`GET ${BRIEF_URL}`] = answer({
      brief: brief({
        products: brief().products.map(product => ({
          ...product,
          hasVoice: false,
        })),
      }),
    });
    openBrief();

    expect(
      await screen.findByText(
        "No voice: the video has no clip of you saying these products' prices."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "Your voice, from the video" })
    ).toBeNull();
    fireEvent.click(makeButton());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
    expect(bodyOf("POST", ADS_URL).voice).toBe("none");
  });

  it("lets the owner choose no voice", async () => {
    openBrief();
    fireEvent.click(await screen.findByRole("radio", { name: "No voice" }));
    expect(
      screen.getByText("Words on screen only, with no sound.")
    ).toBeInTheDocument();
    fireEvent.click(makeButton());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
    expect(bodyOf("POST", ADS_URL).voice).toBe("none");
  });

  it("can't make an ad of letters its fonts lack", async () => {
    routes[`GET ${BRIEF_URL}`] = answer({
      brief: brief({
        products: [{ ...brief().products[0]!, name: "東京タワー" }],
      }),
    });
    openBrief();

    expect(
      await screen.findByText(
        "“東京タワー” has letters the video can't draw yet."
      )
    ).toBeInTheDocument();
    expect(makeButton()).toBeDisabled();
    expect(
      screen.getByText("Video ads support Latin and Cyrillic letters for now.")
    ).toBeInTheDocument();
  });

  it("makes an ad for a shop whose name its fonts lack, leaving the name off the ending", async () => {
    // The worker leaves out a name it can't draw, number or not; the owner
    // can't rename the workspace from Products, so it doesn't stop the ad.
    routes[`GET ${BRIEF_URL}`] = answer({
      brief: brief({ ending: { phone: null, shopName: "Цветы 🌸" } }),
    });
    openBrief();

    expect(
      await screen.findByText("“Write to us on WhatsApp”")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Цветы/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Video ads support Latin and Cyrillic letters for now."
      )
    ).not.toBeInTheDocument();
    expect(makeButton()).toBeEnabled();
  });

  it("can't make an ad of a product without a photo or price", async () => {
    routes[`GET ${BRIEF_URL}`] = answer({
      brief: brief({
        products: [
          brief().products[0]!,
          { ...brief().products[1]!, priceText: null, problem: "no_price" },
        ],
      }),
    });
    openBrief();

    expect(await screen.findByText("No price yet")).toBeInTheDocument();
    expect(makeButton()).toBeDisabled();
    expect(
      screen.getAllByText(
        "A video ad takes 1 to 3 products with photos and prices."
      )
    ).not.toHaveLength(0);
  });

  it("says what stops the workspace paying before anything is spent", async () => {
    routes[`GET ${BRIEF_URL}`] = answer({
      brief: brief({ blocked: "trial_ended" }),
    });
    openBrief();

    expect(
      await screen.findByText(
        "Your free trial has ended, so an ad can't be made."
      )
    ).toBeInTheDocument();
    expect(makeButton()).toBeDisabled();
  });

  it("explains a refusal, in the import's own words", async () => {
    routes[`POST ${ADS_URL}`] = answer(
      { error: "used up", code: "ai_actions_used" },
      409
    );
    openBrief();
    fireEvent.click(await screen.findByRole("button", { name: "Make the ad" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your plan's included AI actions are used up, so an ad can't be made."
    );
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(makeButton()).toBeEnabled();
  });

  it("sends the same press again after a lost answer, and a new one after a refusal", async () => {
    let lost = true;
    routes[`POST ${ADS_URL}`] = () => {
      if (lost) {
        lost = false;
        throw new Error("network");
      }
      return answer({ error: "x", code: "spend_limit" }, 409)();
    };
    openBrief();
    fireEvent.click(await screen.findByRole("button", { name: "Make the ad" }));
    await screen.findByText("That didn't work. Try again.");
    fireEvent.click(makeButton());
    await screen.findByText(
      "Your company's AI spending limit has been reached, so an ad can't be made."
    );
    fireEvent.click(makeButton());
    await waitFor(() => expect(callsTo("POST", ADS_URL)).toHaveLength(3));

    const ids = callsTo("POST", ADS_URL).map(
      ([, init]) => JSON.parse(String(init.body)).requestId
    );
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it("keeps the press after the ad was written but its run didn't start, so pressing again starts that ad", async () => {
    // 503 ad_unavailable: the ad exists; the same request id replays it, and
    // the server starts it (200: it was made by the first press).
    let first = true;
    routes[`POST ${ADS_URL}`] = () => {
      if (first) {
        first = false;
        return answer({ error: "x", code: "ad_unavailable" }, 503)();
      }
      return answer({ ad: making() }, 200)();
    };
    openBrief();
    fireEvent.click(await screen.findByRole("button", { name: "Make the ad" }));
    await screen.findByText("The ad couldn't be started. Try again.");
    fireEvent.click(makeButton());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(AD));

    const ids = callsTo("POST", ADS_URL).map(
      ([, init]) => JSON.parse(String(init.body)).requestId
    );
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("makes a brief changed after its ad couldn't start a new press, so the ad is made of the latest choices", async () => {
    // Sent again under the first press's id, the server would answer with
    // the ad that press saved: the owner's voice, and the person shown.
    let first = true;
    routes[`POST ${ADS_URL}`] = () => {
      if (first) {
        first = false;
        return answer({ error: "x", code: "ad_unavailable" }, 503)();
      }
      return answer({ ad: making() }, 201)();
    };
    openBrief();
    const showThem = await screen.findByRole("checkbox", {
      name: "Show them at the end of the ad",
    });
    fireEvent.click(showThem);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "This is me, or they agreed to appear in ads.",
      })
    );
    fireEvent.click(makeButton());
    await screen.findByText("The ad couldn't be started. Try again.");

    // The owner leaves the person out and takes the voice off, then presses.
    fireEvent.click(showThem);
    fireEvent.click(screen.getByRole("radio", { name: "No voice" }));
    fireEvent.click(makeButton());
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(AD));

    const [sent, resent] = callsTo("POST", ADS_URL).map(
      ([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>
    );
    expect(sent).toMatchObject({
      voice: "own",
      presenter: { use: true, consent: true },
    });
    expect(resent).toMatchObject({
      voice: "none",
      presenter: { use: false, consent: false },
    });
    expect(resent!.requestId).not.toBe(sent!.requestId);
  });

  it("doesn't hand the page an ad that started after the brief was left", async () => {
    let answerPost: () => void = () => {};
    routes[`POST ${ADS_URL}`] = () =>
      new Promise<Answer>(resolve => {
        answerPost = () => resolve(answer({ ad: making() }, 201)());
      });
    const config = { provider: () => new Map(), dedupingInterval: 0 };
    const { rerender } = render(
      <SWRConfig value={config}>
        <AdStudio
          workspaceId={WS}
          view={{ kind: "new", productIds: [DOLL, MUG] }}
          {...props}
        />
      </SWRConfig>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Make the ad" }));
    await screen.findByRole("button", { name: "Starting…" });

    // The owner goes back to the shelf while it starts; the page stays.
    rerender(
      <SWRConfig value={config}>
        <p>The shelf</p>
      </SWRConfig>
    );
    answerPost();
    await waitFor(() => expect(callsTo("POST", ADS_URL)).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it("opens the shelf's Choose mode with the products to change them", async () => {
    openBrief();
    fireEvent.click(
      await screen.findByRole("button", { name: "Change the products" })
    );
    expect(props.onChangeProducts).toHaveBeenCalledWith([DOLL, MUG]);
  });

  it("asks for 1 to 3 products when the address has none or more", async () => {
    open({ kind: "new", productIds: [] });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "A video ad takes 1 to 3 products with photos and prices."
    );
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Choose products" }));
    expect(props.onChangeProducts).toHaveBeenCalledWith([]);
  });

  it("says when the brief can't be loaded, and asks again", async () => {
    routes[`GET ${BRIEF_URL}`] = answer(
      { error: "x", code: "load_failed" },
      503
    );
    openBrief();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The brief couldn't be loaded."
    );
    routes[`GET ${BRIEF_URL}`] = answer({ brief: brief() });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Make the ad" })
    ).toBeEnabled();
  });
});

describe("while the ad is made", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists the honest steps with their models and seconds, and one bar", async () => {
    routes[`GET ${AD_URL}`] = answer({ ad: making() });
    open({ kind: "ad", adId: AD });

    expect(await screen.findByText("Making your video")).toBeInTheDocument();
    expect(screen.getByText(/^Making · 0:3\d$/)).toBeInTheDocument();
    expect(screen.getByText("Writing the words")).toBeInTheDocument();
    expect(screen.getByText("Muse Spark 1.3")).toBeInTheDocument();
    expect(screen.getByText("7 s")).toBeInTheDocument();
    expect(screen.getByText("Pictures 1 of 2")).toBeInTheDocument();
    expect(
      screen.getByText("Muse Image 1.0, checked by Muse Spark")
    ).toBeInTheDocument();
    expect(screen.getByText("SAM 3.1")).toBeInTheDocument();
    expect(screen.getByText("1080 × 1920")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "38"
    );
    expect(
      screen.getByText(
        "You can leave this page. It carries on, and you'll find it under Made from your shelf."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for a free slot/)).toBeNull();
  });

  it("fills in the scenes: Muse Image's once checked, the exact photo until then", async () => {
    routes[`GET ${AD_URL}`] = answer({ ad: making() });
    open({ kind: "ad", adId: AD });

    expect(
      await screen.findByText(
        "Picture by Muse Image · Still your LOL doll: checked by Muse Spark"
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Your exact photo for now")).toBeInTheDocument();
  });

  it("lets the Status picture be downloaded as soon as it exists", async () => {
    routes[`GET ${AD_URL}`] = answer({ ad: making() });
    open({ kind: "ad", adId: AD });

    expect(
      await screen.findByRole("link", { name: "Status picture" })
    ).toHaveAttribute("href", "https://signed.test/status.jpg");
    expect(screen.getByRole("img", { name: "Status picture" })).toHaveAttribute(
      "src",
      "https://signed.test/status.jpg"
    );
  });

  it("says it's waiting for a free slot when no step started after 10 s", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: making({
        step: null,
        startedAt: null,
        requestedAt: ago(11_000),
        timings: {},
        scenes: [],
        stills: { statusUrl: null, feedUrl: null },
      }),
    });
    open({ kind: "ad", adId: AD });

    expect(
      await screen.findByText(
        "Waiting for a free slot. It starts as soon as one opens."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    // Before any picture, the first scene is sketched from the cut-out.
    expect(screen.queryByRole("img", { name: "Status picture" })).toBeNull();
  });
});

describe("the finished ad", () => {
  beforeEach(() => jest.clearAllMocks());

  it("plays in a 9:16 player and says how it was made", async () => {
    open({ kind: "ad", adId: AD });

    const player = await screen.findByLabelText("Your video ad");
    expect(player.tagName).toBe("VIDEO");
    expect(player).toHaveAttribute("src", "https://signed.test/ad.mp4");
    expect(player).toHaveAttribute("poster", "https://signed.test/poster.jpg");
    expect(player).toHaveAttribute("controls");
    expect(
      screen.getByText("Кукла Лол and Кружка Web UMN · 14 s · in Kazakh")
    ).toBeInTheDocument();
    expect(screen.getByText("Ready · made in 1 min 4 s")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Picture by Muse Image · Still your LOL doll: checked by Muse Spark"
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Your exact photo")).toBeInTheDocument();
    expect(
      screen.getByText("The video is 3.2 MB, under WhatsApp's 16 MB.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Meta may label the AI pictures as made with AI.")
    ).toBeInTheDocument();
    expect(screen.getByText("1 AI action · $0.05")).toBeInTheDocument();
    expect(screen.getByText("Took words 7 s · video 32 s")).toBeInTheDocument();
  });

  it("lays Meta's safe zones over the video, and turns the sound off", async () => {
    open({ kind: "ad", adId: AD });
    const player = (await screen.findByLabelText(
      "Your video ad"
    )) as HTMLVideoElement;

    expect(screen.queryByText("Top 14% · Reels header")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reels safe zones" }));
    expect(screen.getByText("Top 14% · Reels header")).toBeInTheDocument();
    expect(
      screen.getByText("Bottom 35% · caption and buttons")
    ).toBeInTheDocument();

    expect(player.muted).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Sound" }));
    expect(player.muted).toBe(true);
  });

  it("downloads the video, the Status picture and the 4:5 picture", async () => {
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const createObjectURL = jest.fn(() => "blob:ad");
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
    routes["GET https://signed.test/ad.mp4"] = () => ({
      ok: true,
      status: 200,
      json: async () => null,
      blob: async () => new Blob(["mp4"], { type: "video/mp4" }),
    });
    open({ kind: "ad", adId: AD });

    const download = await screen.findByRole("link", {
      name: "Download video · 3.2 MB",
    });
    expect(download).toHaveAttribute("href", "https://signed.test/ad.mp4");
    expect(
      screen.getByRole("link", { name: "Status picture" })
    ).toHaveAttribute("href", "https://signed.test/status.jpg");
    expect(
      screen.getByRole("link", { name: "Ad picture 4:5" })
    ).toHaveAttribute("href", "https://signed.test/feed.jpg");

    fireEvent.click(download);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    const saved = click.mock.instances.at(-1) as unknown as HTMLAnchorElement;
    expect(saved.download).toBe("video-ad-2026-11-02.mp4");
    click.mockRestore();
  });

  it("opens a file it can't fetch in a new tab instead", async () => {
    const openTab = jest.spyOn(window, "open").mockReturnValue(null);
    open({ kind: "ad", adId: AD });

    fireEvent.click(
      await screen.findByRole("link", { name: "Ad picture 4:5" })
    );

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith(
        "https://signed.test/feed.jpg",
        "_blank",
        "noopener,noreferrer"
      )
    );
    openTab.mockRestore();
  });

  it("copies the post text and the Click-to-WhatsApp copy", async () => {
    open({ kind: "ad", adId: AD });

    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(adRecord().post!.text)
    );
    expect(await screen.findAllByText("Copied")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        [
          "Headline: Жаңа ойыншықтар",
          "Primary text: Кукла мен кружка сөреде күтіп тұр.",
          "Greeting: Сәлеметсіз бе! Қайсысы ұнады?",
          "Quick questions:",
          "- Кукла бар ма?",
          "- Жеткізу қанша?",
          "- Тапсырыс беремін",
        ].join("\n")
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy the headline" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("Жаңа ойыншықтар")
    );
    expect(
      screen.getByRole("link", { name: "Open Ads Manager" })
    ).toHaveAttribute("href", "https://adsmanager.facebook.com/");
  });

  it("says when copying didn't work", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    open({ kind: "ad", adId: AD });
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(
      await screen.findAllByText("Couldn't copy. Select the text and copy it.")
    ).not.toHaveLength(0);
  });

  it("checks edited words like the script before they're saved", async () => {
    open({ kind: "ad", adId: AD });

    const sticker = await screen.findByRole("textbox", {
      name: "Sticker on the first scene",
    });
    fireEvent.change(sticker, { target: { value: "5000 ₸ ғана" } });

    expect(
      screen.getByText("No numbers here: Airi adds the prices from your shelf.")
    ).toBeInTheDocument();
    expect(sticker).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("button", { name: "Save and remake the video" })
    ).toBeDisabled();

    fireEvent.change(sticker, {
      target: { value: "Өте ұзын стикер мәтіні мұнда" },
    });
    expect(
      screen.getByText("Too long: it has to fit one line of 26 letters.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));
    expect(sticker).toHaveValue("Сөреде жаңа тауарлар");
    expect(
      screen.queryByRole("button", { name: "Save and remake the video" })
    ).toBeNull();
  });

  it("says when a shelf price changed since it was made, and how to make a new one", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({ pricesChanged: true }),
    });
    open({ kind: "ad", adId: AD });

    expect(
      await screen.findByText(
        "Prices changed on your shelf since this ad was made, so it still shows the old ones."
      )
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose them for a new ad" })
    );
    expect(props.onChangeProducts).toHaveBeenCalledWith([DOLL, MUG]);
  });

  it("says nothing about prices while they're the shelf's", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: adRecord({ pricesChanged: false }),
    });
    open({ kind: "ad", adId: AD });
    await screen.findByLabelText("Your video ad");
    expect(screen.queryByText(/Prices changed/)).toBeNull();
  });

  it("doesn't count spacing as an edit", async () => {
    const spaced = adRecord();
    spaced.script = { ...spaced.script!, sticker: "Сөреде  жаңа тауарлар " };
    routes[`GET ${AD_URL}`] = answer({ ad: spaced });
    open({ kind: "ad", adId: AD });

    const sticker = await screen.findByRole("textbox", {
      name: "Sticker on the first scene",
    });
    expect(
      screen.queryByRole("button", { name: "Save and remake the video" })
    ).toBeNull();
    fireEvent.change(sticker, { target: { value: "Сөреде жаңа тауарлар" } });
    expect(
      screen.queryByRole("button", { name: "Save and remake the video" })
    ).toBeNull();
  });

  it("saves edited words and makes the video again, with no AI action", async () => {
    routes[`PATCH ${AD_URL}`] = answer(
      {
        ad: making({
          step: "video",
          renderNo: 2,
          timings: adRecord().timings,
          requestedAt: ago(1_000),
          startedAt: null,
        }),
      },
      202
    );
    open({ kind: "ad", adId: AD });

    const caption = await screen.findByRole("textbox", {
      name: "Caption for Кукла Лол",
    });
    fireEvent.change(caption, { target: { value: "Жаңа  қуыршақ" } });
    expect(
      screen.getByText("It costs no AI action and takes about 40 seconds.")
    ).toBeInTheDocument();
    // While edits wait, saving them is the one main action.
    expect(
      screen.getByRole("link", { name: "Download video · 3.2 MB" })
    ).toHaveAttribute("data-variant", "outline");
    fireEvent.click(
      screen.getByRole("button", { name: "Save and remake the video" })
    );

    expect(
      await screen.findByText("Making your video again")
    ).toBeInTheDocument();
    expect(bodyOf("PATCH", AD_URL)).toEqual({
      captions: [{ productId: DOLL, caption: "Жаңа қуыршақ" }],
    });
  });

  it("keeps the edits and says why when they can't be saved", async () => {
    routes[`PATCH ${AD_URL}`] = answer(
      { error: "x", code: "ad_not_ready" },
      409
    );
    open({ kind: "ad", adId: AD });

    fireEvent.change(await screen.findByRole("textbox", { name: "Ending" }), {
      target: { value: "Бізге жазыңыз" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save and remake the video" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The ad is being made right now. Try again once it's ready."
    );
    expect(screen.getByRole("textbox", { name: "Ending" })).toHaveValue(
      "Бізге жазыңыз"
    );
  });
});

describe("an ad that couldn't be made", () => {
  beforeEach(() => jest.clearAllMocks());

  const failed = (overrides: Partial<ProductAdRecord> = {}) =>
    adRecord({
      status: "failed",
      errorCode: "too_big",
      readyAt: null,
      video: null,
      ...overrides,
    });

  it("says why, and tries again from where it stopped", async () => {
    routes[`GET ${AD_URL}`] = answer({ ad: failed() });
    routes[`POST ${AD_URL}/retry`] = answer(
      { ad: making({ renderNo: 2, requestedAt: ago(500), startedAt: null }) },
      202
    );
    open({ kind: "ad", adId: AD });

    expect(
      await screen.findByText(
        "The ad couldn't be made: the video stayed over WhatsApp's 16 MB, even made smaller."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "It picks up where it stopped and reuses the pictures already made."
      )
    ).toBeInTheDocument();
    // What was made stays: the Status picture.
    expect(
      screen.getByRole("link", { name: "Status picture" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Making your video")).toBeInTheDocument();
    expect(callsTo("POST", `${AD_URL}/retry`)).toHaveLength(1);
  });

  it.each([
    ["trial_ended", "your free trial has ended"],
    ["spend_limit", "your company's AI spending limit has been reached"],
    ["ai_actions_used", "your plan's included AI actions are used up"],
    ["photo_missing", "a product's photo is no longer in your media storage"],
    ["failed", "something went wrong while making it"],
  ] as const)("explains %s in the owner's terms", async (errorCode, reason) => {
    routes[`GET ${AD_URL}`] = answer({ ad: failed({ errorCode }) });
    open({ kind: "ad", adId: AD });
    expect(
      await screen.findByText(`The ad couldn't be made: ${reason}.`)
    ).toBeInTheDocument();
  });

  it("says when trying again is refused", async () => {
    routes[`GET ${AD_URL}`] = answer({ ad: failed() });
    routes[`POST ${AD_URL}/retry`] = answer(
      { error: "x", code: "trial_ended" },
      409
    );
    open({ kind: "ad", adId: AD });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your free trial has ended, so it can't be made again."
    );
  });

  it("keeps the last video when an edit's remake failed", async () => {
    routes[`GET ${AD_URL}`] = answer({
      ad: failed({ errorCode: "failed", video: adRecord().video }),
    });
    open({ kind: "ad", adId: AD });

    expect(
      await screen.findByText("Your last video is still here.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your video ad")).toHaveAttribute(
      "src",
      "https://signed.test/ad.mp4"
    );
  });
});

describe("opening an ad", () => {
  beforeEach(() => jest.clearAllMocks());

  it("says when the ad isn't there, with the way back", async () => {
    routes[`GET ${AD_URL}`] = answer(
      { error: "That ad wasn't found", code: "ad_not_found" },
      404
    );
    open({ kind: "ad", adId: AD });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That ad wasn't found."
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to products" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("asks again when it couldn't be loaded", async () => {
    routes[`GET ${AD_URL}`] = answer({ error: "x", code: "load_failed" }, 503);
    open({ kind: "ad", adId: AD });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The ad couldn't be loaded."
    );
    routes[`GET ${AD_URL}`] = answer({ ad: adRecord() });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Your video ad")).toBeInTheDocument();
  });

  it("shows a still outline while it loads", async () => {
    routes[`GET ${AD_URL}`] = () => new Promise<Answer>(() => undefined);
    open({ kind: "ad", adId: AD });
    expect(screen.getByRole("status")).toHaveTextContent("Loading the ad…");
  });
});

describe("on a phone", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.matchMedia = jest.fn((query: string) => ({
      matches: query === "(max-width: 899px)",
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })) as unknown as typeof window.matchMedia;
  });

  it("keeps the brief's one main action in the bar at the bottom", async () => {
    const { container } = openBrief();

    const make = await screen.findByRole("button", { name: "Make the ad" });
    expect(screen.getAllByRole("button", { name: "Make the ad" })).toHaveLength(
      1
    );
    expect(make.closest(".bar")).not.toBeNull();
    // The sketch shows first, above the fields.
    expect(container.querySelector(".pictureFirst")).not.toBeNull();
  });

  it("keeps the finished ad's download in the bar", async () => {
    open({ kind: "ad", adId: AD });

    const download = await screen.findByRole("link", {
      name: "Download video · 3.2 MB",
    });
    expect(
      screen.getAllByRole("link", { name: "Download video · 3.2 MB" })
    ).toHaveLength(1);
    expect(download.closest(".bar")).not.toBeNull();
    expect(
      within(download.closest(".bar") as HTMLElement).queryByRole("link", {
        name: "Status picture",
      })
    ).toBeNull();
  });

  it("puts saving the edits in the bar while they wait", async () => {
    open({ kind: "ad", adId: AD });
    fireEvent.change(await screen.findByRole("textbox", { name: "Ending" }), {
      target: { value: "Бізге жазыңыз" },
    });
    const save = screen.getByRole("button", {
      name: "Save and remake the video",
    });
    expect(save.closest(".bar")).not.toBeNull();
  });
});
