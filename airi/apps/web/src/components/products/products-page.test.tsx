/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { SWRConfig, useSWRConfig } from "swr";
import { ProductShelf } from "./product-shelf";
import {
  addressPicks,
  adForPicks,
  ProductsPage,
  productsViewIn,
  templateOfAd,
  templateStamps,
} from "./products-page";

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ channel: null, isConnected: false }),
}));

// The page's address, as Next gives it; null outside the app router.
let mockSearch: URLSearchParams | null = null;
jest.mock("next/navigation", () => ({ useSearchParams: () => mockSearch }));

// The parts other streams build are mounted here by their agreed props: each
// stand-in shows what it was given and offers its ways out.
jest.mock("./product-workbench", () => {
  const { useEffect, useRef } = jest.requireActual("react");
  return {
    ProductWorkbench: (props: {
      template: { id: string };
      subject:
        | { kind: "ad-pending"; error: string | null }
        | { kind: "ad"; adId: string }
        | { kind: "kit"; productIds: string[]; importId: string | null };
      picks: Array<{ id: string }>;
      priceToCheck: boolean;
      tileId: string;
      onClose: () => void;
      onRetryMake?: () => void;
      onCheckOneByOne?: (importId: string) => void;
      onCheckPrice?: () => void;
    }) => {
      const ref = useRef(null);
      useEffect(() => ref.current?.focus(), []);
      const subject =
        props.subject.kind === "ad"
          ? `ad ${props.subject.adId}`
          : props.subject.kind === "kit"
            ? `kit ${props.subject.productIds.join(",")} from ${props.subject.importId}`
            : `pending ${props.subject.error ?? "-"}`;
      return (
        <section
          ref={ref}
          tabIndex={-1}
          aria-label="Workbench"
          aria-labelledby={props.tileId}
          onKeyDown={event => {
            if (event.key === "Escape") props.onClose();
          }}
        >
          <p>{`${props.template.id}: ${subject}`}</p>
          <p>{`picks ${props.picks.map(pick => pick.id).join(",")}`}</p>
          {props.priceToCheck ? <p>price to check</p> : null}
          {props.priceToCheck && props.onCheckPrice ? (
            <button onClick={props.onCheckPrice}>Fix the flagged price</button>
          ) : null}
          <button onClick={props.onClose}>Close the workbench</button>
          {props.onRetryMake ? (
            <button onClick={props.onRetryMake}>Try the make again</button>
          ) : null}
        </section>
      );
    },
  };
});
jest.mock("./product-made-list", () => ({
  MadeList: (props: {
    workspaceId: string;
    onOpenAd: (adId: string, templateId: string | null) => void;
    onMakeAd?: (ids: string[]) => void;
    onOpenKit?: (kit: {
      productIds: string[];
      importId: string | null;
    }) => void;
  }) => (
    <section aria-label="Out on Meta">
      <button onClick={() => props.onOpenAd(AD_ID, null)}>Open the ad</button>
      <button onClick={() => props.onOpenAd(AD_ID, "ctwa_video")}>
        Open the WhatsApp ad
      </button>
      <button
        onClick={() =>
          props.onOpenKit?.({ productIds: [P2, P1], importId: null })
        }
      >
        Open the kit
      </button>
    </section>
  ),
}));
// The review is its own part; here only how the page opens and closes it.
jest.mock("./product-review", () => ({
  ProductReview: (props: {
    importId: string;
    initialProductId?: string;
    onClose: () => void;
    onChangeProducts: (ids: string[]) => void;
  }) => (
    <section aria-label="Review">
      <p>{`review ${props.importId}`}</p>
      {props.initialProductId ? (
        <p>{`first ${props.initialProductId}`}</p>
      ) : null}
      <button onClick={props.onClose}>Leave the review</button>
      <button onClick={() => props.onChangeProducts([P3, P2])}>
        Back with these picked
      </button>
    </section>
  ),
}));

const P1 = "651f1f77bcf86cd799439001";
const P2 = "651f1f77bcf86cd799439002";
const P3 = "651f1f77bcf86cd799439003";
const P4 = "651f1f77bcf86cd799439004";
const D1 = "651f1f77bcf86cd7994390d1";
const D2 = "651f1f77bcf86cd7994390d2";
const AD_ID = "651f1f77bcf86cd7994390ad";
const IMPORT_OLD = "651f1f77bcf86cd7994390a1";
const IMPORT_NEW = "651f1f77bcf86cd7994390a2";
const PAGE = "/panel/w/workspace-1/products";
const BASE = "/api/workspaces/workspace-1/products";

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const record = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  name,
  price: 5000,
  currency: "KZT",
  priceIsFrom: false,
  imageUrl: `https://storage.test/${id}.webp`,
  // A product with a photo has it cut out, unless a test says otherwise.
  hasCutout: overrides.imageUrl !== null,
  updatedAt: null,
  importId: null,
  ...overrides,
});

// A shelf of four from no listed video; the fourth has no photo.
const SHELF = [
  record(P1, "Кукла Лол"),
  record(P2, "Кружка Web UMN", { price: 500 }),
  record(P3, "Шежіре", { price: 15500, priceIsFrom: true }),
  record(P4, "Петух", { imageUrl: null }),
];

const importRecord = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "ready",
  stage: null,
  productTotal: 2,
  photoTotal: 2,
  photoDone: 2,
  errorCode: null,
  photosStopped: null,
  draftsLeft: false,
  presenter: null,
  createdAt: "2026-11-03T09:00:00.000Z",
  finishedAt: "2026-11-03T09:01:00.000Z",
  ...overrides,
});

const detailProduct = (
  id: string,
  name: string,
  status: "draft" | "published" | "rejected",
  overrides: Record<string, unknown> = {}
) => ({
  ...record(id, name),
  status,
  englishName: null,
  nameSource: "spoken",
  priceQuote: null,
  priceSource: "spoken",
  doubts: [],
  options: [
    {
      description: `${name} as filmed`,
      photoMethod: "restored",
      imageUrl: `https://storage.test/${id}.webp`,
      photoUrl: null,
      originalUrl: `https://storage.test/${id}-filmed.jpg`,
      videoMomentSeconds: 3,
      straightenedDegrees: 0,
      notes: [],
    },
  ],
  featuredOption: 0,
  clipUrl: null,
  ...overrides,
});

const adRecord = (overrides: Record<string, unknown> = {}) => ({
  id: AD_ID,
  status: "ready",
  motion: "shelf",
  products: [P1, P2, P3].map(id => ({
    productId: id,
    name: id,
    englishName: null,
    priceText: "5 000 ₸",
    imageUrl: null,
  })),
  video: {
    url: "https://signed.test/ad.mp4",
    bytes: 1,
    seconds: 14,
    posterUrl: "https://signed.test/poster.jpg",
  },
  stills: { statusUrl: null, feedUrl: null },
  ...overrides,
});

type Route = (init?: RequestInit) => unknown | Promise<unknown>;
let routes: Record<string, Route>;
const calls: Array<{ url: string; method: string; body: unknown }> = [];

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
    </SWRConfig>
  );
}

function serveShelf(products: unknown[] = SHELF) {
  routes[`GET ${BASE}`] = () => respond(200, { products });
}

beforeEach(() => {
  calls.length = 0;
  mockSearch = null;
  window.history.replaceState(null, "", PAGE);
  window.localStorage.clear();
  routes = {
    [`GET ${BASE}`]: () => respond(200, { products: SHELF }),
    [`GET ${BASE}/imports`]: () => respond(200, { imports: [] }),
    [`GET ${BASE}/made`]: () =>
      respond(200, {
        kits: [],
        ads: [],
        whatsapp: { connected: false, displayPhone: null },
      }),
    [`GET ${BASE}/meta`]: () =>
      respond(200, {
        meta: {
          instagram: {},
          ads: {},
          whatsapp: { connected: true },
          ai: { blocked: null },
        },
      }),
  };
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${method} ${url.split("?")[0]}`;
    const route = routes[key];
    if (!route) return respond(404, { code: "load_failed" });
    return route(init);
  }) as unknown as typeof fetch;
});

/** Opens the page straight at an address, as a link would. */
function visit(search: string) {
  mockSearch = new URLSearchParams(search);
  window.history.replaceState(null, "", `${PAGE}?${search}`);
}

const bay = (name: string | RegExp) =>
  screen.getByRole("button", {
    name: typeof name === "string" ? new RegExp(`^${name},`) : name,
  });
/** The picked products, in pick order (the number each bay is named by). */
const pressed = () =>
  screen
    .queryAllByRole("button", { pressed: true })
    .map(button => ({
      id: button.getAttribute("data-product"),
      pick: Number(
        /pick (\d+)/.exec(button.getAttribute("aria-label") ?? "")?.[1]
      ),
    }))
    .sort((a, b) => a.pick - b.pick)
    .map(entry => entry.id);
/** The workbench stand-in, once it shows this line. */
const workbench = async (line: string | RegExp) =>
  (await screen.findByText(line)).closest("section") as HTMLElement;
const tile = (id: string) =>
  document.querySelector(`[data-template="${id}"]`) as HTMLElement;
const sent = (method: string, path: string) =>
  calls.filter(
    call => call.method === method && call.url.split("?")[0] === path
  );

/** The page with the shelf in, and the tiles under it. */
async function ready() {
  renderPage();
  await screen.findByRole("region", { name: "Templates" });
}

// ------------------------------------------------------------------ page

test("asks the workspace's Products API", async () => {
  serveShelf([]);
  renderPage();
  await waitFor(() => expect(sent("GET", BASE)).toHaveLength(1));
});

test("heads the page with its title, what's on the shelf and that it's new", async () => {
  renderPage();
  const title = screen.getByRole("heading", { level: 1, name: /^Products/ });
  expect(title).toHaveClass("displayXl");
  await waitFor(() => expect(title).toHaveTextContent("4 on your shelf"));
  expect(
    screen.getByText("New · built at the Meta AI Hackathon 2026")
  ).toBeInTheDocument();
  // No upload buttons in the head: the shelf's "+" bay is the way in.
  expect(
    screen.getAllByRole("button", { name: PRODUCTS_COPY.uploadVideo })
  ).toHaveLength(1);
});

test("shows a still loading shelf, then the empty shelf with its own way in", async () => {
  serveShelf([]);
  renderPage();
  expect(
    screen.getByRole("status", { name: "Loading products…" })
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("heading", {
      level: 2,
      name: "Your products will appear here",
    })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Upload a video" })
  ).toHaveAttribute("data-variant", "default");
  // Nothing to make from, nothing out on Meta.
  expect(
    screen.queryByRole("region", { name: "Templates" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Out on Meta" })
  ).not.toBeInTheDocument();
});

test("shows an error on the wall with a retry that loads again", async () => {
  routes[`GET ${BASE}`] = () => respond(503, { code: "load_failed" });
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Products couldn't be loaded."
  );
  serveShelf([]);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
});

test("keeps the shelf when a refresh fails", async () => {
  function Refresh() {
    const { mutate } = useSWRConfig();
    return <button onClick={() => void mutate(BASE)}>refresh</button>;
  }
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
      <Refresh />
    </SWRConfig>
  );
  await screen.findByRole("button", { name: /^Кукла Лол,/ });
  routes[`GET ${BASE}`] = () => respond(503, { code: "load_failed" });
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(sent("GET", BASE)).toHaveLength(2));
  expect(bay("Кукла Лол")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

// ------------------------------------------------------------------ shelf

test("stands each video's products on its own row, newest first, with its print and drafts", async () => {
  routes[`GET ${BASE}/imports`] = () =>
    respond(200, {
      imports: [
        importRecord(IMPORT_OLD, { createdAt: "2026-11-01T09:00:00.000Z" }),
        importRecord(IMPORT_NEW, {
          draftsLeft: true,
          presenter: {
            imageUrl: null,
            photoUrl: null,
            originalUrl: "https://storage.test/presenter-frame.jpg",
          },
        }),
      ],
    });
  routes[`GET ${BASE}/imports/${IMPORT_OLD}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_OLD),
      products: [
        detailProduct(P2, "Кружка Web UMN", "published"),
        detailProduct(P1, "Кукла Лол", "published"),
      ],
    });
  routes[`GET ${BASE}/imports/${IMPORT_NEW}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_NEW, { draftsLeft: true }),
      products: [
        detailProduct(D1, "Динозавр", "draft"),
        detailProduct(P3, "Шежіре", "published"),
        detailProduct(D2, "Отклонён", "rejected"),
      ],
    });
  serveShelf([
    record(P1, "Кукла Лол", { importId: IMPORT_OLD }),
    record(P2, "Кружка Web UMN", { importId: IMPORT_OLD }),
    record(P3, "Шежіре", { importId: IMPORT_NEW }),
    record(P4, "Петух", { imageUrl: null }),
  ]);
  const { container } = renderPage();
  await waitFor(() =>
    expect(container.querySelectorAll("[data-row]")).toHaveLength(3)
  );
  const rows = Array.from(container.querySelectorAll("[data-row]"));
  expect(rows.map(row => row.getAttribute("data-row"))).toEqual([
    IMPORT_NEW,
    IMPORT_OLD,
    "shelf",
  ]);
  const productsOf = (row: Element) =>
    Array.from(row.querySelectorAll("[data-product]")).map(button =>
      button.getAttribute("data-product")
    );
  // In the order the owner named them; a skipped product isn't shown.
  await waitFor(() => expect(productsOf(rows[0]!)).toEqual([D1, P3]));
  expect(productsOf(rows[1]!)).toEqual([P2, P1]);
  expect(productsOf(rows[2]!)).toEqual([P4]);
  // A draft says it isn't on the shelf yet; its row's print is the frame
  // the presenter was filmed in, and its ⋯ offers the check one by one.
  expect(bay("Динозавр")).toHaveAccessibleName(
    /found in your video, not on your shelf yet/
  );
  expect(rows[0]!.querySelector("figure img")).toHaveAttribute(
    "src",
    "https://storage.test/presenter-frame.jpg"
  );
  expect(
    within(rows[0] as HTMLElement).getByRole("button", {
      name: "More for this video",
    })
  ).toBeInTheDocument();
  expect(
    within(rows[1] as HTMLElement).queryByRole("button", {
      name: "More for this video",
    })
  ).not.toBeInTheDocument();
  // The products of no listed video stand on a plain last row.
  expect(rows[2]).toHaveAccessibleName("Products on your shelf");
});

test("a video whose products were all checked keeps its row, read from the video itself", async () => {
  // The imports list leaves a video out once nothing is left to check.
  routes[`GET ${BASE}/imports/${IMPORT_OLD}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_OLD, {
        createdAt: "2026-11-01T09:00:00.000Z",
      }),
      products: [
        detailProduct(P2, "Кружка Web UMN", "published"),
        detailProduct(P1, "Кукла Лол", "published"),
      ],
    });
  serveShelf([
    record(P1, "Кукла Лол", { importId: IMPORT_OLD }),
    record(P2, "Кружка Web UMN", { importId: IMPORT_OLD }),
    record(P4, "Петух", { imageUrl: null }),
  ]);
  const { container } = renderPage();
  await waitFor(() =>
    expect(
      Array.from(
        container.querySelectorAll(`[data-row="${IMPORT_OLD}"] [data-product]`)
      ).map(button => button.getAttribute("data-product"))
    ).toEqual([P2, P1])
  );
  expect(
    container.querySelector(`[data-row="${IMPORT_OLD}"] figure img`)
  ).toHaveAttribute("src", `https://storage.test/${P2}-filmed.jpg`);
  // Named by when it was sent, on the owner's clock.
  expect(
    container.querySelector(`[data-row="${IMPORT_OLD}"]`)
  ).toHaveAccessibleName(/^Products from your video of 1 Nov, \d\d:00$/);
});

test("names each product by its name, its price and its pick", async () => {
  serveShelf([
    record(P1, "Кукла Лол"),
    record(P2, "Петух", { price: null, currency: null }),
    record(P3, "Phone stand", { price: 10, currency: "USD" }),
  ]);
  await ready();
  // The page picks the first 3 for the owner.
  expect(bay("Кукла Лол")).toHaveAccessibleName(
    `Кукла Лол, ${"5 000 ₸"}, pick 1`
  );
  expect(bay("Петух")).toHaveAccessibleName("Петух, No price yet, pick 2");
  expect(bay("Phone stand")).toHaveAccessibleName(
    `Phone stand, ${"10 USD"}, pick 3`
  );
});

test("picks the newest video's first 3 for the owner, and keeps the picks in the address", async () => {
  await ready();
  expect(pressed()).toEqual([P1, P2, P3]);
  await waitFor(() =>
    expect(window.location.search).toBe(`?picks=${P1},${P2},${P3}`)
  );
  expect(screen.getByText("3 picked")).toBeInTheDocument();
});

test("a tap picks in place, numbered in tap order; another tap lets it go", async () => {
  await ready();
  fireEvent.click(bay("Кружка Web UMN"));
  expect(pressed()).toEqual([P1, P3]);
  fireEvent.click(bay("Петух"));
  fireEvent.click(bay("Кружка Web UMN"));
  expect(pressed()).toEqual([P1, P3, P4, P2]);
  expect(bay("Петух")).toHaveAccessibleName(/, pick 3$/);
  expect(bay("Кружка Web UMN")).toHaveAccessibleName(/, pick 4$/);
  await waitFor(() =>
    expect(window.location.search).toBe(`?picks=${P1},${P3},${P4},${P2}`)
  );
  expect(screen.getByText("4 picked")).toBeInTheDocument();
});

test("a reload keeps the picks in their order; the owner's empty picks stay empty", async () => {
  visit(`picks=${P3},${P1}`);
  await ready();
  expect(bay("Шежіре")).toHaveAccessibleName(/, pick 1$/);
  expect(bay("Кукла Лол")).toHaveAccessibleName(/, pick 2$/);
  fireEvent.click(bay("Шежіре"));
  fireEvent.click(bay("Кукла Лол"));
  expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
  await waitFor(() => expect(window.location.search).toBe(""));
  // Nothing picked: the tiles say to pick first.
  expect(tile("reel_shelf")).toHaveTextContent(PRODUCTS_COPY.gallery.pickFirst);
});

test("v2's addresses open the one page with their products picked", () => {
  expect(addressPicks(new URLSearchParams(`make=${P2},${P1}`))).toEqual([
    P2,
    P1,
  ]);
  expect(addressPicks(new URLSearchParams(`ad=new&products=${P3}`))).toEqual([
    P3,
  ]);
  expect(addressPicks(new URLSearchParams(`picks=${P1}&make=${P2}`))).toEqual([
    P1,
  ]);
  expect(productsViewIn(new URLSearchParams(`make=${P1}`))).toEqual({
    kind: "page",
  });
});

test("v2's make address becomes ?picks=", async () => {
  visit(`make=${P4},${P2}`);
  await ready();
  expect(pressed()).toEqual([P4, P2]);
  await waitFor(() =>
    expect(window.location.search).toBe(`?picks=${P4},${P2}`)
  );
});

test("the '+' bay ends the newest row and chooses a video", async () => {
  await ready();
  const add = screen.getByRole("button", { name: "Upload a video" });
  const input = screen.getByLabelText("Upload a video", {
    selector: "input",
  }) as HTMLInputElement;
  const click = jest.spyOn(input, "click").mockImplementation(() => {});
  fireEvent.click(add);
  expect(click).toHaveBeenCalled();
});

// ------------------------------------------------------------------ make

async function serveMake() {
  routes[`GET ${BASE}/ads/brief`] = () =>
    respond(200, {
      brief: {
        products: [P1, P2, P3].map(id => ({
          productId: id,
          name: id,
          englishName: null,
          priceText: "5 000 ₸",
          imageUrl: null,
          problem: null,
          hasVoice: id === P2,
        })),
        missing: 0,
        language: "Kazakh",
        wordsCode: "kk",
        presenter: null,
        ending: { phone: null, shopName: "Shop" },
        blocked: null,
      },
    });
  routes[`POST ${BASE}/ads`] = () =>
    respond(202, { ad: adRecord({ status: "making", motion: "filmed_sold" }) });
  routes[`GET ${BASE}/ads/${AD_ID}`] = () =>
    respond(200, { ad: adRecord({ status: "making", motion: "filmed_sold" }) });
}

test("a tap on a tile makes the ad of the first 3 picks and opens its workbench under the tile", async () => {
  await serveMake();
  await ready();
  // The first-visit hint sits under the tiles until the first make.
  expect(screen.getByText(PRODUCTS_COPY.gallery.hint)).toBeInTheDocument();
  fireEvent.click(bay("Петух"));
  fireEvent.click(tile("reel_filmed_sold"));

  const bench = await workbench(`reel_filmed_sold: ad ${AD_ID}`);
  expect(sent("POST", `${BASE}/ads`)[0]!.body).toMatchObject({
    productIds: [P1, P2, P3],
    motion: "filmed_sold",
    idea: { kind: "new" },
    // The owner's own recording, as the video has them saying a price.
    voice: "own",
    presenter: { use: false, consent: false },
  });
  // Under the tile's group, labelled by the tile, with the focus in it.
  expect(bench).toHaveAttribute("aria-labelledby", tile("reel_filmed_sold").id);
  expect(tile("reel_filmed_sold")).toHaveAttribute("aria-expanded", "true");
  await waitFor(() => expect(bench).toHaveFocus());
  expect(
    screen.queryByText(PRODUCTS_COPY.gallery.hint)
  ).not.toBeInTheDocument();
  expect(window.localStorage.getItem("airi.products.v3.hint")).toBe("done");
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("ad")).toBe(AD_ID)
  );
});

test("Escape closes the workbench and gives the focus back to its tile", async () => {
  await serveMake();
  await ready();
  fireEvent.click(tile("story_video"));
  const bench = await workbench(/^story_video: /);
  await waitFor(() => expect(bench).toHaveFocus());
  fireEvent.keyDown(bench, { key: "Escape" });
  await waitFor(() => expect(bench).not.toBeInTheDocument());
  await waitFor(() => expect(tile("story_video")).toHaveFocus());
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("ad")).toBeNull()
  );
});

test("the ad these picks made is used again without auto-regenerating when switching motion tiles", async () => {
  await serveMake();
  // v2's one feed picture stands for In a room.
  const stills = { statusUrl: null, feedUrl: "https://signed.test/feed.jpg" };
  routes[`GET ${BASE}/made`] = () =>
    respond(200, {
      kits: [],
      ads: [adRecord({ motion: "shelf", stills })],
      whatsapp: { connected: false, displayPhone: null },
    });
  routes[`GET ${BASE}/ads/${AD_ID}`] = () =>
    respond(200, { ad: adRecord({ motion: "shelf", stills }) });
  await ready();

  fireEvent.click(tile("post_room"));
  expect(await screen.findByText(`post_room: ad ${AD_ID}`)).toBeInTheDocument();
  expect(sent("POST", `${BASE}/ads`)).toHaveLength(0);
  expect(sent("PATCH", `${BASE}/ads/${AD_ID}`)).toHaveLength(0);

  fireEvent.click(tile("reel_filmed_sold"));
  expect(
    await screen.findByText(`reel_filmed_sold: ad ${AD_ID}`)
  ).toBeInTheDocument();
  expect(sent("PATCH", `${BASE}/ads/${AD_ID}`)).toHaveLength(0);
});

test("drafts among the picks go on the shelf before the make, as the owner's swipe right", async () => {
  await serveMake();
  routes[`GET ${BASE}/imports`] = () =>
    respond(200, { imports: [importRecord(IMPORT_NEW, { draftsLeft: true })] });
  routes[`GET ${BASE}/imports/${IMPORT_NEW}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_NEW, { draftsLeft: true }),
      products: [
        detailProduct(D1, "Динозавр", "draft"),
        detailProduct(P1, "Кукла Лол", "published"),
      ],
    });
  routes[`POST ${BASE}/imports/${IMPORT_NEW}/review`] = () =>
    respond(200, { changed: 1 });
  serveShelf([record(P1, "Кукла Лол", { importId: IMPORT_NEW })]);
  await ready();
  await waitFor(() => expect(pressed()).toEqual([D1, P1]));
  // A pick alone puts nothing on the shelf.
  expect(sent("POST", `${BASE}/imports/${IMPORT_NEW}/review`)).toHaveLength(0);

  fireEvent.click(tile("reel_shelf"));
  await waitFor(() => expect(sent("POST", `${BASE}/ads`)).toHaveLength(1));
  expect(sent("POST", `${BASE}/imports/${IMPORT_NEW}/review`)[0]!.body).toEqual(
    { productIds: [D1], status: "published" }
  );
  const review = calls.findIndex(call => call.url.endsWith("/review"));
  const create = calls.findIndex(
    call => call.method === "POST" && call.url === `${BASE}/ads`
  );
  expect(review).toBeLessThan(create);
});

test.each(["reel_shelf", "chat_kit"])(
  "a pick with a price to check makes nothing through %s",
  async templateId => {
    await serveMake();
    routes[`GET ${BASE}/imports`] = () =>
      respond(200, {
        imports: [importRecord(IMPORT_NEW, { draftsLeft: true })],
      });
    routes[`GET ${BASE}/imports/${IMPORT_NEW}`] = () =>
      respond(200, {
        import: importRecord(IMPORT_NEW, { draftsLeft: true }),
        products: [
          detailProduct(D2, "Checked price", "draft"),
          detailProduct(D1, "Динозавр", "draft", {
            doubts: [{ about: "price", text: "300 or 3000?" }],
          }),
        ],
      });
    serveShelf([]);
    await ready();
    await waitFor(() => expect(pressed()).toEqual([D2, D1]));
    expect(bay("Динозавр")).toHaveAccessibleName(/Check this price/);
    fireEvent.click(tile(templateId));
    const bench = await workbench(`${templateId}: pending price_to_check`);
    expect(bench).toHaveTextContent("price to check");
    expect(sent("POST", `${BASE}/ads`)).toHaveLength(0);
    expect(sent("POST", `${BASE}/imports/${IMPORT_NEW}/review`)).toHaveLength(
      0
    );
    // Both the red tag and the refusal's action open the flagged draft,
    // even though another product is first in the video's review queue.
    fireEvent.click(
      screen.getByRole("button", {
        name:
          templateId === "chat_kit"
            ? "Fix the flagged price"
            : "Check the price of Динозавр",
      })
    );
    expect(await screen.findByText(`review ${IMPORT_NEW}`)).toBeInTheDocument();
    expect(screen.getByText(`first ${D1}`)).toBeInTheDocument();
    expect(
      new URLSearchParams(window.location.search).get("reviewProduct")
    ).toBe(D1);
  }
);

test("a refused make keeps the workbench with the refusal, and Try again sends the same press", async () => {
  await serveMake();
  let fail = true;
  routes[`POST ${BASE}/ads`] = () =>
    fail
      ? respond(503, { code: "ad_unavailable", error: "x" })
      : respond(202, { ad: adRecord({ status: "making" }) });
  await ready();
  fireEvent.click(tile("reel_shelf"));
  expect(
    await screen.findByText("reel_shelf: pending ad_unavailable")
  ).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try the make again" }));
  expect(
    await screen.findByText(`reel_shelf: ad ${AD_ID}`)
  ).toBeInTheDocument();
  const [first, second] = sent("POST", `${BASE}/ads`);
  expect((second!.body as { requestId: string }).requestId).toBe(
    (first!.body as { requestId: string }).requestId
  );
});

test("AI off for the company: the brief's stop is the workbench's answer, and the tiles lock", async () => {
  await serveMake();
  routes[`GET ${BASE}/meta`] = () =>
    respond(200, {
      meta: {
        instagram: {},
        ads: {},
        whatsapp: { connected: true },
        ai: { blocked: "ai_disabled" },
      },
    });
  await ready();
  await waitFor(() =>
    expect(tile("reel_shelf")).toHaveTextContent(PRODUCTS_COPY.gallery.aiOff)
  );
  fireEvent.click(tile("reel_shelf"));
  expect(screen.queryByText(/^reel_shelf: /)).not.toBeInTheDocument();
  // The chat needs no new ad.
  expect(tile("chat_kit")).not.toHaveAttribute("aria-disabled");
});

test("the chat tile opens the kit of every pick, up to 10, from their video", async () => {
  routes[`GET ${BASE}/imports`] = () =>
    respond(200, { imports: [importRecord(IMPORT_NEW)] });
  routes[`GET ${BASE}/imports/${IMPORT_NEW}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_NEW),
      products: [
        detailProduct(P1, "Кукла Лол", "published"),
        detailProduct(P2, "Кружка Web UMN", "published"),
      ],
    });
  serveShelf([
    record(P1, "Кукла Лол", { importId: IMPORT_NEW }),
    record(P2, "Кружка Web UMN", { importId: IMPORT_NEW }),
    record(P4, "Петух", { imageUrl: null }),
  ]);
  await ready();
  await waitFor(() => expect(pressed()).toEqual([P1, P2]));
  fireEvent.click(tile("chat_kit"));
  expect(
    await screen.findByText(`chat_kit: kit ${P1},${P2} from ${IMPORT_NEW}`)
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close the workbench" }));
  fireEvent.click(bay("Петух"));
  fireEvent.click(tile("chat_kit"));
  expect(
    await screen.findByText(`chat_kit: kit ${P1},${P2},${P4} from null`)
  ).toBeInTheDocument();
});

// ------------------------------------------------------------------ links

test("?ad=<id> opens that ad's workbench on its last tile, with its products picked", async () => {
  routes[`GET ${BASE}/ads/${AD_ID}`] = () =>
    respond(200, {
      ad: adRecord({
        products: [P3, P1].map(id => ({
          productId: id,
          name: id,
          englishName: null,
          priceText: "5 000 ₸",
          imageUrl: null,
        })),
        meta: {
          posts: [
            {
              id: "post-1",
              destination: "post",
              still: { kind: "studio", productId: P3, colourway: null },
              slides: null,
              renderNo: 1,
              motion: null,
              state: "published",
              permalink: "https://instagram.test/p/1",
              errorCode: null,
              errorMessage: null,
              requestedAt: "2026-11-03T10:00:00.000Z",
              publishedAt: "2026-11-03T10:00:09.000Z",
            },
          ],
          ctwa: null,
        },
      }),
    });
  visit(`ad=${AD_ID}`);
  renderPage();
  expect(
    await screen.findByText(`post_studio: ad ${AD_ID}`)
  ).toBeInTheDocument();
  expect(pressed()).toEqual([P3, P1]);
});

test("an ad from Out on Meta opens its workbench; its products become the picks", async () => {
  routes[`GET ${BASE}/made`] = () =>
    respond(200, {
      kits: [],
      ads: [adRecord({ motion: "filmed_sold" })],
      whatsapp: { connected: false, displayPhone: null },
    });
  routes[`GET ${BASE}/ads/${AD_ID}`] = () =>
    respond(200, { ad: adRecord({ motion: "filmed_sold" }) });
  await ready();
  fireEvent.click(bay("Кукла Лол"));
  fireEvent.click(screen.getByRole("button", { name: "Open the ad" }));
  expect(
    await screen.findByText(`reel_filmed_sold: ad ${AD_ID}`)
  ).toBeInTheDocument();
  expect(pressed()).toEqual([P1, P2, P3]);
});

test("a receipt opens its ad on the tile it went out from; a kit receipt opens the chat tile", async () => {
  routes[`GET ${BASE}/made`] = () =>
    respond(200, {
      kits: [],
      ads: [adRecord({ motion: "filmed_sold" })],
      whatsapp: { connected: false, displayPhone: null },
    });
  routes[`GET ${BASE}/ads/${AD_ID}`] = () =>
    respond(200, { ad: adRecord({ motion: "filmed_sold" }) });
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Open the WhatsApp ad" }));
  expect(
    await screen.findByText(`ctwa_video: ad ${AD_ID}`)
  ).toBeInTheDocument();
  expect(pressed()).toEqual([P1, P2, P3]);

  fireEvent.click(screen.getByRole("button", { name: "Open the kit" }));
  expect(
    await screen.findByText(`chat_kit: kit ${P2},${P1} from null`)
  ).toBeInTheDocument();
  expect(pressed()).toEqual([P2, P1]);
});

test("the print's ⋯ opens the check one by one in place; Back closes it", async () => {
  routes[`GET ${BASE}/imports`] = () =>
    respond(200, { imports: [importRecord(IMPORT_NEW, { draftsLeft: true })] });
  routes[`GET ${BASE}/imports/${IMPORT_NEW}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_NEW, { draftsLeft: true }),
      products: [detailProduct(D1, "Динозавр", "draft")],
    });
  serveShelf([]);
  renderPage();
  const more = await screen.findByRole("button", {
    name: "More for this video",
  });
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  fireEvent.keyDown(more, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Check one by one" })
  );
  expect(await screen.findByText(`review ${IMPORT_NEW}`)).toBeInTheDocument();
  expect(window.location.search).toBe(`?picks=${D1}&review=${IMPORT_NEW}`);
  act(() => window.history.back());
  await waitFor(() =>
    expect(screen.queryByText(/^review /)).not.toBeInTheDocument()
  );
  expect(bay("Динозавр")).toBeInTheDocument();
});

test("the review hands its products on as the picks", async () => {
  visit(`review=${IMPORT_NEW}`);
  renderPage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Back with these picked" })
  );
  await screen.findByRole("region", { name: "Templates" });
  expect(pressed()).toEqual([P3, P2]);
  expect(window.location.search).toBe(`?picks=${P3},${P2}`);
});

test("picks handed on by a review opened from the page reach the page's own address", async () => {
  routes[`GET ${BASE}/imports`] = () =>
    respond(200, { imports: [importRecord(IMPORT_NEW, { draftsLeft: true })] });
  routes[`GET ${BASE}/imports/${IMPORT_NEW}`] = () =>
    respond(200, {
      import: importRecord(IMPORT_NEW, { draftsLeft: true }),
      products: [detailProduct(D1, "Динозавр", "draft")],
    });
  renderPage();
  const more = await screen.findByRole("button", {
    name: "More for this video",
  });
  fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
  fireEvent.keyDown(more, { key: "Enter" });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Check one by one" })
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Back with these picked" })
  );
  await screen.findByRole("region", { name: "Templates" });
  await waitFor(() =>
    expect(window.location.search).toBe(`?picks=${P3},${P2}`)
  );
  expect(pressed()).toEqual([P3, P2]);
});

// ------------------------------------------------------------------ helpers

test("finds the ad these picks made, in their order, never a failed one", () => {
  const ads = [
    adRecord({ id: "a-failed", status: "failed" }),
    adRecord({ id: "a-ok" }),
  ] as never[];
  expect(adForPicks(ads, [P1, P2, P3])?.id).toBe("a-ok");
  expect(adForPicks(ads, [P2, P1, P3])).toBeNull();
  expect(adForPicks(ads, [])).toBeNull();
});

test("stamps the tiles from what went out on Meta", () => {
  const stamps = templateStamps(
    adRecord({
      meta: {
        posts: [
          {
            destination: "reel",
            still: null,
            motion: "filmed_sold",
            state: "published",
          },
          {
            destination: "story",
            still: null,
            motion: "shelf",
            state: "failed",
          },
        ],
        ctwa: {
          asset: "video",
          state: "running",
          effectiveStatus: "PENDING_REVIEW",
        },
      },
    }) as never,
    {
      parts: {
        carousel: { state: "submitted", metaStatus: "APPROVED" },
      },
    } as never
  );
  expect(Object.fromEntries(stamps)).toEqual({
    reel_filmed_sold: "live",
    story_video: "failed",
    ctwa_video: "in_review",
    chat_kit: "approved",
  });
});

test("an unconfirmed Run is not stamped as live or in review", () => {
  const stamps = templateStamps(
    adRecord({
      meta: {
        posts: [],
        ctwa: { asset: "video", state: "running", effectiveStatus: null },
      },
    }) as never,
    null
  );
  expect(stamps.has("ctwa_video")).toBe(false);
});

test("an ad opens on its latest post's tile, else its WhatsApp ad, else its Reel", () => {
  expect(templateOfAd(adRecord({ motion: "filmed_sold" }) as never).id).toBe(
    "reel_filmed_sold"
  );
  expect(templateOfAd(adRecord({ motion: "float" }) as never).id).toBe(
    "reel_float"
  );
  // A motion this page doesn't know opens the shelf Reel.
  expect(templateOfAd(adRecord({ motion: "turntable" }) as never).id).toBe(
    "reel_shelf"
  );
  expect(
    templateOfAd(
      adRecord({ meta: { posts: [], ctwa: { asset: "video" } } }) as never
    ).id
  ).toBe("ctwa_video");
});

// ------------------------------------------------------------ v2's shelf

test("letters a long price smaller, so its label fits a phone's bay, and breaks it only after a lighter 'from'", () => {
  const unbroken = (text: string) => text.replace(/ /g, " ");
  const product = (id: string, price: number, currency: string) =>
    record(id, `Product ${id}`, { price, currency, priceIsFrom: true });
  render(
    <ProductShelf
      products={[
        product("p1", 15500, "KZT"),
        product("p2", 1_250_000_000, "IRR"),
        product("p3", 1e12, "IRR"),
      ]}
    />
  );
  const price = (text: string) =>
    screen.getByText(unbroken(text), { normalizer: words => words });
  const tags = [
    "from 15 500 ₸",
    "from 1 250 000 000 IRR",
    "from 1 000 000 000 000 IRR",
  ].map(text => price(text).parentElement!);
  expect(tags[0]).toHaveClass("text-[13px]");
  expect(tags[1]).toHaveClass("text-[11px]");
  expect(tags[2]).toHaveClass("text-[10px]");
});

test("a found product's tent card says its photo is being made, or next in line", () => {
  const drafts = new Map([
    [P1, { photo: "making", prompt: null, priceDoubt: false }],
    [P2, { photo: "waiting", prompt: null, priceDoubt: true }],
  ] as const);
  render(
    <ProductShelf
      products={[
        record(P1, "Кукла Лол", { imageUrl: null }),
        record(P2, "Ойыншық доллар", {
          imageUrl: null,
          price: 1,
          currency: "USD",
        }),
      ]}
      drafts={drafts as never}
    />
  );
  const items = screen.getAllByRole("listitem");
  expect(within(items[0]!).getByText("Making photo…")).toBeInTheDocument();
  expect(within(items[1]!).getByText("Next in line")).toBeInTheDocument();
  expect(within(items[1]!).getByText("Check this price")).toBeInTheDocument();
});
