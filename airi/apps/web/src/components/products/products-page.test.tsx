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
import { ProductsPage, productsViewIn } from "./products-page";

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ channel: null, isConnected: false }),
}));

// The page's address, as Next gives it; null outside the app router.
let mockSearch: URLSearchParams | null = null;
jest.mock("next/navigation", () => ({ useSearchParams: () => mockSearch }));

// The parts other streams build are mounted here by their agreed props: each
// stand-in shows what it was given and offers its ways out.
jest.mock("./product-make", () => ({
  MakeOutputs: (props: {
    workspaceId: string;
    productIds: readonly string[];
    importId: string | null;
    onChangeProducts: (ids: string[]) => void;
    onMakeAd: (ids: string[]) => void;
  }) => (
    <section aria-label="Make view">
      <p>{`make ${props.workspaceId} ${props.importId} ${props.productIds.join(",")}`}</p>
      <button
        onClick={() => props.onChangeProducts(props.productIds.slice(0, 1))}
      >
        Change the products
      </button>
      <button onClick={() => props.onMakeAd([...props.productIds])}>
        Make an ad of these
      </button>
    </section>
  ),
}));
jest.mock("./product-ad-studio", () => ({
  AdStudio: (props: {
    workspaceId: string;
    view: { kind: "new"; productIds: string[] } | { kind: "ad"; adId: string };
    onCreated: (adId: string) => void;
    onChangeProducts: (ids: string[]) => void;
    onClose: () => void;
  }) => (
    <section aria-label="Ad studio">
      <p>
        {props.view.kind === "new"
          ? `new ad of ${props.view.productIds.join(",")}`
          : `ad ${props.view.adId}`}
      </p>
      <input aria-label="Your own words" />
      <button onClick={() => props.onCreated(AD_ID)}>Make the ad</button>
      <button
        onClick={() => {
          mockLateCreated = props.onCreated;
        }}
      >
        Make the ad, answered late
      </button>
      <button onClick={props.onClose}>Close the studio</button>
    </section>
  ),
}));
// The page's onCreated, kept by the studio stand-in to answer after a delay.
let mockLateCreated: ((adId: string) => void) | null = null;
jest.mock("./product-made-list", () => ({
  MadeList: (props: {
    workspaceId: string;
    onOpenAd: (adId: string) => void;
    onMakeAd: (ids: string[]) => void;
  }) => (
    <section aria-label="Made from your shelf">
      <p>{`made ${props.workspaceId}`}</p>
      <button onClick={() => props.onOpenAd(AD_ID)}>Open the ad</button>
      <button onClick={() => props.onMakeAd([P1, P2, P3, P4])}>
        Make a video ad with these
      </button>
    </section>
  ),
}));
// The review is its own part; here only how the page opens and closes it.
jest.mock("./product-review", () => ({
  ProductReview: (props: {
    importId: string;
    onClose: () => void;
    onChangeProducts: (ids: string[]) => void;
    onMakeAd: (ids: string[]) => void;
  }) => (
    <section aria-label="Review">
      <p>{`review ${props.importId}`}</p>
      <button onClick={props.onClose}>Leave the review</button>
      <button onClick={() => props.onMakeAd([P2])}>Make an ad of P2</button>
      <button onClick={() => props.onChangeProducts([P2, P3])}>
        Choose them on the shelf
      </button>
    </section>
  ),
}));

const P1 = "651f1f77bcf86cd799439001";
const P2 = "651f1f77bcf86cd799439002";
const P3 = "651f1f77bcf86cd799439003";
const P4 = "651f1f77bcf86cd799439004";
const AD_ID = "651f1f77bcf86cd7994390ad";
const IMPORT_ID = "651f1f77bcf86cd7994390aa";
const PAGE = "/panel/w/workspace-1/products";

// The products list; the page's import list answers empty on its own.
const fetchMock = jest.fn();

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
  importId: "651f1f77bcf86cd7994390a1",
  ...overrides,
});

// A shelf of four from two videos; the fourth has no photo.
const SHELF = [
  record(P1, "Кукла Лол"),
  record(P2, "Кружка Web UMN", { price: 500 }),
  record(P3, "Шежіре", {
    price: 15500,
    priceIsFrom: true,
    importId: "651f1f77bcf86cd7994390a2",
  }),
  record(P4, "Петух", { imageUrl: null }),
];

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
    </SWRConfig>
  );
}

function serveShelf(products: unknown[] = SHELF) {
  fetchMock.mockResolvedValue(respond(200, { products }));
}

// "Made from your shelf": nothing made yet, unless a test answers otherwise.
let madeAnswer: () => Promise<unknown>;
let madeAsked = 0;

beforeEach(() => {
  fetchMock.mockReset();
  mockSearch = null;
  window.history.replaceState(null, "", PAGE);
  madeAsked = 0;
  madeAnswer = async () =>
    respond(200, {
      kits: [],
      ads: [],
      whatsapp: { connected: false, displayPhone: null },
    });
  global.fetch = ((url: string, init?: RequestInit) => {
    if (url.endsWith("/products/imports"))
      return Promise.resolve(respond(200, { imports: [] }));
    if (url.endsWith("/products/made")) {
      madeAsked += 1;
      return madeAnswer();
    }
    return fetchMock(url, init);
  }) as unknown as typeof fetch;
});

/** Prices are written with no-break spaces, which never wrap. */
const unbroken = (text: string) => text.replace(/ /g, "\u00a0");

/** Opens the page straight at an address, as a link would. */
function visit(search: string) {
  mockSearch = new URLSearchParams(search);
  window.history.replaceState(null, "", `${PAGE}?${search}`);
}

test("asks the workspace's Products API", async () => {
  serveShelf([]);
  renderPage();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/products",
      { cache: "no-store" }
    )
  );
});

test("heads the page with its title, what's on the shelf and that it's new", async () => {
  serveShelf();
  renderPage();

  const title = screen.getByRole("heading", { level: 1, name: "Products" });
  // Geologica, the display face, at the page title's size.
  expect(title).toHaveClass("displayXl");
  const count = await screen.findByText("4 on your shelf, from 2 videos");
  const note = screen.getByText("New · built at the Meta AI Hackathon 2026");
  // Under the title, then the line about the hackathon.
  expect(
    title.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(
    count.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  // The page's own button, beside the title.
  expect(
    screen.getByRole("button", { name: "Upload a video" })
  ).toBeInTheDocument();
});

test("asks for what was made with the products, and shows the shelf with it, not before", async () => {
  let answerProducts: () => void = () => {};
  fetchMock.mockImplementation(
    () =>
      new Promise(resolve => {
        answerProducts = () => resolve(respond(200, { products: SHELF }));
      })
  );
  let answerMade: () => void = () => {};
  madeAnswer = () =>
    new Promise(resolve => {
      answerMade = () =>
        resolve(
          respond(200, {
            kits: [],
            ads: [],
            whatsapp: { connected: false, displayPhone: null },
          })
        );
    });
  renderPage();

  // Both asked for at once, not the list after the shelf.
  await waitFor(() => expect(madeAsked).toBe(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // The products are in, the list isn't: the shelf waits, still loading,
  // rather than be pushed down when the list goes in above it.
  await act(async () => answerProducts());
  expect(
    await screen.findByText("4 on your shelf, from 2 videos")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("list", { name: "Your shelf" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("status", { name: "Loading products…" })
  ).toBeInTheDocument();

  await act(async () => answerMade());
  expect(
    await screen.findByRole("list", { name: "Your shelf" })
  ).toBeInTheDocument();
});

test("says how many videos the shelf came from, or nothing about videos it doesn't know", () => {
  expect(PRODUCTS_COPY.page.onShelf(12, 2)).toBe(
    "12 on your shelf, from 2 videos"
  );
  expect(PRODUCTS_COPY.page.onShelf(1, 1)).toBe(
    "1 on your shelf, from 1 video"
  );
  expect(PRODUCTS_COPY.page.onShelf(3, 0)).toBe("3 on your shelf");
});

test("shows a still loading shelf, then the empty shelf with its own way in", async () => {
  serveShelf([]);
  renderPage();
  const loading = screen.getByRole("status", { name: "Loading products…" });
  // Still: nothing on it pulses.
  expect(loading.querySelector(".animate-pulse")).toBeNull();

  expect(
    await screen.findByRole("heading", {
      level: 2,
      name: "Your products will appear here",
    })
  ).toBeInTheDocument();
  expect(screen.getByText(/Film your shelf on your phone/)).toBeInTheDocument();
  // The empty shelf's upload button is the page's one primary action.
  const upload = screen.getByRole("button", { name: "Upload a video" });
  expect(upload).toHaveAttribute("data-variant", "default");
  expect(
    screen.getByText("MP4 or MOV. About a minute is plenty; up to 5 minutes.")
  ).toBeInTheDocument();
  // Nothing on the shelf: no count under the title, and nothing made from it
  // to list or ask for.
  expect(screen.queryByText(/\d+ on your shelf/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Made from your shelf" })
  ).not.toBeInTheDocument();
});

test("lists products with their price, or a note when there is none", async () => {
  serveShelf([
    record(P1, "Кукла Лол"),
    record(P2, "Петух", { price: null, currency: null }),
    record(P3, "Шежіре", { price: 15500, priceIsFrom: true }),
  ]);
  renderPage();

  // The shelf is named by its heading's title, which tells it apart from a
  // video's draft shelf above; the heading also says how many it holds.
  const list = await screen.findByRole("list", { name: "Your shelf" });
  expect(
    screen.getByRole("heading", { name: /^Your shelf\s*3$/ })
  ).toBeInTheDocument();
  // Only products count: the spots that finish the row are hidden from it.
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("Кукла Лол")).toBeInTheDocument();
  // The default normalizer turns the no-break spaces in the page into plain ones.
  expect(
    screen.getByText(unbroken("5 000 ₸"), { normalizer: text => text })
  ).toBeInTheDocument();
  expect(screen.getByText("No price yet")).toBeInTheDocument();
  // A starting price says so, read as one price.
  expect(
    screen.getByText(unbroken("from 15 500 ₸"), { normalizer: text => text })
  ).toBeInTheDocument();
});

test("writes a price in another currency with its code, tenge with ₸, and one whose currency wasn't said bare", async () => {
  serveShelf([
    record(P1, "Phone stand", { price: 10, currency: "USD" }),
    record(P2, "Кукла Лол"),
    record(P3, "Mug", { price: 4.99, currency: null, priceIsFrom: true }),
  ]);
  renderPage();

  await screen.findByText("Phone stand");
  // Never tenge by default.
  expect(
    screen.getByText(unbroken("from 4.99"), { normalizer: text => text })
  ).toBeInTheDocument();
  expect(
    screen.getByText(unbroken("10 USD"), { normalizer: text => text })
  ).toBeInTheDocument();
  expect(
    screen.getByText(unbroken("5 000 ₸"), { normalizer: text => text })
  ).toBeInTheDocument();
});

test("letters a long price smaller, so its label fits a phone's bay, and breaks it only after a lighter 'from'", () => {
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
  // Read as one price; drawn with "from" apart.
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
  // Where it must break, it breaks after "from" and nowhere else.
  const drawn = tags[2].querySelector("[aria-hidden='true']")!;
  const breaks = drawn.querySelectorAll("wbr");
  expect(breaks).toHaveLength(1);
  expect(breaks[0]!.previousSibling?.textContent).toBe(unbroken("from "));
  expect(breaks[0]!.previousSibling).toHaveClass("from");
});

test("finishes the last shelf row with spots that aren't products", () => {
  const products = (count: number) =>
    Array.from({ length: count }, (_, n) =>
      record(`p${n}`, `Product ${n}`, { imageUrl: null })
    );
  const { container, rerender } = render(
    <ProductShelf products={products(1)} />
  );
  const fillers = () =>
    Array.from(container.querySelectorAll('[data-spot="filler"]'));

  // One product: one more spot at 2 columns, two at 3, three at 4.
  expect(fillers()).toHaveLength(3);
  for (const filler of fillers())
    expect(filler).toHaveAttribute("aria-hidden", "true");
  expect(fillers()[0]).toHaveClass("block", "sm:block", "lg:block");
  expect(fillers()[1]).toHaveClass("hidden", "sm:block", "lg:block");
  expect(fillers()[2]).toHaveClass("hidden", "sm:hidden", "lg:block");
  expect(
    within(screen.getByRole("list", { name: "Products" })).getAllByRole(
      "listitem"
    )
  ).toHaveLength(1);

  // Four fill rows of 2 and 4; at 3 columns the second row needs two more.
  rerender(<ProductShelf products={products(4)} />);
  expect(fillers()).toHaveLength(2);
  for (const filler of fillers())
    expect(filler).toHaveClass("hidden", "sm:block", "lg:hidden");
});

test("sets a product down on the shelf only once its photo has decoded", async () => {
  serveShelf([
    record(P1, "Кукла Лол", { imageUrl: "https://storage.test/doll.png" }),
  ]);
  const { container } = renderPage();
  await screen.findByText("Кукла Лол");

  const image = container.querySelector("img");
  expect(image).toHaveAttribute("src", "https://storage.test/doll.png");
  // The name below the shelf already says what it is.
  expect(image).toHaveAttribute("alt", "");
  expect(image?.parentElement).toHaveAttribute("data-state", "loading");

  fireEvent.load(image!);
  await waitFor(() =>
    expect(image?.parentElement).toHaveAttribute("data-state", "loaded")
  );
  // The first products are set down one after another, 40 ms apart.
  expect(image?.parentElement?.style.getPropertyValue("--delay")).toBe("0ms");
});

test("stands a paper tent card with the name's first letter where there is no photo, or it fails", async () => {
  serveShelf([
    record(P1, "шежіре", { imageUrl: null }),
    record(P2, "Broken", { imageUrl: "https://storage.test/expired.png" }),
  ]);
  const { container } = renderPage();
  await screen.findByText("шежіре");

  // A card standing on the shelf says what's missing, not a bare letter.
  const items = within(
    screen.getByRole("list", { name: "Your shelf" })
  ).getAllByRole("listitem");
  expect(within(items[0]!).getByText("Ш")).toBeInTheDocument();
  expect(within(items[0]!).getByText("No photo")).toBeInTheDocument();
  expect(within(items[1]!).queryByText("No photo")).not.toBeInTheDocument();
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(within(items[1]!).getByText("B")).toBeInTheDocument();
  expect(within(items[1]!).getByText("No photo")).toBeInTheDocument();
});

test("a found product's tent card says its photo is being made, or next in line", () => {
  const drafts = new Map([
    [P1, { photo: "making", prompt: null, aura: ["", ""], priceDoubt: false }],
    [P2, { photo: "waiting", prompt: null, aura: ["", ""], priceDoubt: true }],
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
  // A price Airi isn't sure of is marked for the owner to check.
  expect(within(items[1]!).getByText("Check this price")).toBeInTheDocument();
});

test("shows an error on the wall with a retry that loads again", async () => {
  fetchMock.mockResolvedValueOnce(
    respond(503, { error: "x", code: "load_failed" })
  );
  renderPage();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Products couldn't be loaded."
  );

  fetchMock.mockResolvedValueOnce(respond(200, { products: [] }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
});

test("while choosing, each product's bay is its checkbox with a rose check, and the spots that finish the row aren't", () => {
  const onToggle = jest.fn();
  const { container } = render(
    <ProductShelf
      products={[record(P1, "Кукла Лол"), record(P2, "Кружка Web UMN")]}
      choose={{ chosen: new Set([P2]), onToggle }}
    />
  );
  const items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(2);
  const doll = within(items[0]!).getByRole("checkbox", { name: "Кукла Лол" });
  const cup = within(items[1]!).getByRole("checkbox", {
    name: "Кружка Web UMN",
  });
  expect(doll).not.toBeChecked();
  expect(cup).toBeChecked();
  // The check only shows the state; chosen is rose, never black.
  expect(items[1]!.querySelector("[data-checked]")).toBeInTheDocument();
  expect(items[0]!.querySelector("[data-checked]")).toBeNull();
  expect(items[1]).toHaveAttribute("data-chosen", "true");
  fireEvent.click(doll);
  expect(onToggle).toHaveBeenCalledWith(P1);
  for (const filler of container.querySelectorAll('[data-spot="filler"]'))
    expect(filler.querySelector("input")).toBeNull();
});

test("tries a refreshed photo link again after the old one failed", () => {
  const product = (imageUrl: string) => record(P1, "Кукла Лол", { imageUrl });
  const { container, rerender } = render(
    <ProductShelf products={[product("https://storage.test/expired.png")]} />
  );
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).not.toBeInTheDocument();

  rerender(
    <ProductShelf products={[product("https://storage.test/fresh.png")]} />
  );
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "https://storage.test/fresh.png"
  );
});

test("keeps the shelf when a refresh fails", async () => {
  function Refresh() {
    const { mutate } = useSWRConfig();
    return (
      <button
        onClick={() => void mutate("/api/workspaces/workspace-1/products")}
      >
        refresh
      </button>
    );
  }
  fetchMock.mockResolvedValueOnce(
    respond(200, { products: [record(P1, "Кукла Лол")] })
  );
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
      <Refresh />
    </SWRConfig>
  );
  await screen.findByText("Кукла Лол");

  fetchMock.mockResolvedValueOnce(
    respond(503, { error: "x", code: "load_failed" })
  );
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect(screen.getByText("Кукла Лол")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

describe("Choose mode", () => {
  async function startChoosing() {
    serveShelf();
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose products" })
    );
    return screen.getByRole("region", { name: "Chosen products" });
  }

  test("each bay becomes a checkbox; the bar counts them, Clear and Done let go", async () => {
    const bar = await startChoosing();
    // The button that started it now ends it, keeping the keyboard's place.
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeInTheDocument();
    expect(
      screen.getByText("Choose products to make something from them.", {
        selector: "p",
      })
    ).toBeInTheDocument();

    const doll = screen.getByRole("checkbox", { name: "Кукла Лол" });
    expect(doll).not.toBeChecked();
    fireEvent.click(doll);
    fireEvent.click(screen.getByRole("checkbox", { name: "Шежіре" }));
    expect(doll).toBeChecked();
    expect(doll.closest("li")).toHaveAttribute("data-chosen", "true");
    expect(within(bar).getByText("2 chosen")).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: "Clear" }));
    expect(doll).not.toBeChecked();
    expect(
      within(bar).getByText("Choose products to make something from them.")
    ).toBeInTheDocument();

    fireEvent.click(done);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Chosen products" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose products" })
    ).toHaveFocus();
  });

  test("Escape on a bay leaves Choose mode", async () => {
    await startChoosing();
    const doll = screen.getByRole("checkbox", { name: "Кукла Лол" });
    fireEvent.click(doll);
    act(() => doll.focus());
    fireEvent.keyDown(doll, { key: "Escape" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose products" })
    ).toHaveFocus();
  });

  test("a video ad takes 1 to 3 products with photos and prices, and says so", async () => {
    const bar = await startChoosing();
    const makeAd = () =>
      within(bar).getByRole("button", { name: /Make a video ad/ });
    const note = "A video ad takes 1 to 3 products with photos and prices.";
    // Nothing chosen: neither can be made, and nothing to explain yet.
    expect(makeAd()).toBeDisabled();
    expect(
      within(bar).getByRole("button", { name: /Make carousel \+ order form/ })
    ).toBeDisabled();
    expect(within(bar).queryByText(note)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Кукла Лол" }));
    expect(makeAd()).toBeEnabled();

    // The rooster has no photo.
    fireEvent.click(screen.getByRole("checkbox", { name: "Петух" }));
    expect(makeAd()).toBeDisabled();
    expect(makeAd()).toHaveAccessibleDescription(note);
    fireEvent.click(screen.getByRole("checkbox", { name: "Петух" }));

    // Four is one too many.
    fireEvent.click(screen.getByRole("checkbox", { name: "Кружка Web UMN" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Шежіре" }));
    expect(makeAd()).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Петух" }));
    expect(makeAd()).toBeDisabled();
    expect(within(bar).getByText(note)).toBeInTheDocument();
  });

  test("Make carousel + order form opens the make view with the chosen products in shelf order; Back returns to them", async () => {
    const bar = await startChoosing();
    // Chosen out of order; made in the shelf's.
    fireEvent.click(screen.getByRole("checkbox", { name: "Шежіре" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Кукла Лол" }));
    fireEvent.click(
      within(bar).getByRole("button", { name: /Make carousel \+ order form/ })
    );

    const make = screen.getByRole("region", { name: "Make view" });
    expect(make).toHaveTextContent(`make workspace-1 null ${P1},${P3}`);
    expect(window.location.search).toBe(`?make=${P1},${P3}`);
    // The page's head and shelf wait behind the view, which has the focus.
    expect(
      screen.queryByText("New · built at the Meta AI Hackathon 2026")
    ).not.toBeInTheDocument();
    expect(make.parentElement).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Products" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    // Still choosing, with the same products.
    expect(screen.getByRole("checkbox", { name: "Шежіре" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Кукла Лол" })).toBeChecked();
  });

  test("Make a video ad opens the ad's brief, which swaps its address for the ad's once made", async () => {
    const bar = await startChoosing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Кружка Web UMN" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Кукла Лол" }));
    fireEvent.click(
      within(bar).getByRole("button", { name: /Make a video ad/ })
    );

    expect(screen.getByRole("region", { name: "Ad studio" })).toHaveTextContent(
      `new ad of ${P1},${P2}`
    );
    expect(window.location.search).toBe(`?ad=new&products=${P1},${P2}`);

    fireEvent.click(screen.getByRole("button", { name: "Make the ad" }));
    expect(screen.getByRole("region", { name: "Ad studio" })).toHaveTextContent(
      `ad ${AD_ID}`
    );
    expect(window.location.search).toBe(`?ad=${AD_ID}`);
    // In place: the browser's Back from the ad goes to the shelf, not to
    // its brief.
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Products" })
    ).toHaveClass("displayXl");
    expect(
      screen.queryByRole("region", { name: "Ad studio" })
    ).not.toBeInTheDocument();
  });

  test("an ad that finishes starting after the owner left its brief leaves them on the shelf", async () => {
    const bar = await startChoosing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Кукла Лол" }));
    fireEvent.click(
      within(bar).getByRole("button", { name: /Make a video ad/ })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Make the ad, answered late" })
    );
    // "You can leave this page": the owner goes back while it starts.
    fireEvent.click(screen.getByRole("button", { name: "Products" }));
    await waitFor(() => expect(window.location.search).toBe(""));

    act(() => mockLateCreated?.(AD_ID));

    expect(window.location.search).toBe("");
    expect(
      screen.queryByRole("region", { name: "Ad studio" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Products" })
    ).toBeInTheDocument();
  });

  test("the studio's own close goes back to the shelf", async () => {
    const bar = await startChoosing();
    fireEvent.click(screen.getByRole("checkbox", { name: "Кукла Лол" }));
    fireEvent.click(
      within(bar).getByRole("button", { name: /Make a video ad/ })
    );
    fireEvent.click(screen.getByRole("button", { name: "Close the studio" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByRole("checkbox", { name: "Кукла Лол" })).toBeChecked();
  });
});

describe("views", () => {
  test("the made list sits above the shelf and opens an ad, or a new one with up to 3 of its products", async () => {
    serveShelf();
    renderPage();
    const made = await screen.findByRole("region", {
      name: "Made from your shelf",
    });
    expect(made).toHaveTextContent("made workspace-1");
    const shelf = await screen.findByRole("list", { name: "Your shelf" });
    expect(
      made.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(within(made).getByRole("button", { name: "Open the ad" }));
    expect(window.location.search).toBe(`?ad=${AD_ID}`);
    expect(screen.getByRole("region", { name: "Ad studio" })).toHaveTextContent(
      `ad ${AD_ID}`
    );
    // A field keeps its own Escape; elsewhere Escape closes the view.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Your own words" }), {
      key: "Escape",
    });
    expect(
      screen.getByRole("region", { name: "Ad studio" })
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(window.location.search).toBe(""));

    fireEvent.click(
      within(
        await screen.findByRole("region", { name: "Made from your shelf" })
      ).getByRole("button", { name: "Make a video ad with these" })
    );
    expect(window.location.search).toBe(`?ad=new&products=${P1},${P2},${P3}`);
  });

  test("a view opened from another goes back to the shelf in one step, however deep", async () => {
    serveShelf();
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose products" })
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Кукла Лол" }));
    fireEvent.click(
      screen.getByRole("button", { name: /Make carousel \+ order form/ })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Make an ad of these" })
    );
    expect(window.location.search).toBe(`?ad=new&products=${P1}`);

    fireEvent.click(screen.getByRole("button", { name: "Products" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(
      screen.queryByRole("region", { name: "Make view" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Кукла Лол" })).toBeChecked();
  });

  test("a view opens at the top of the page, and back on the shelf the page is where it was", async () => {
    serveShelf();
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {/* The route's column, which scrolls. */}
        <div data-testid="column" style={{ overflowY: "auto" }}>
          <ProductsPage workspaceId="workspace-1" />
        </div>
      </SWRConfig>
    );
    const column = screen.getByTestId("column");
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose products" })
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Петух" }));
    column.scrollTop = 640;

    fireEvent.click(
      screen.getByRole("button", { name: /Make carousel \+ order form/ })
    );
    expect(column.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Products" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByRole("checkbox", { name: "Петух" })).toBeChecked();
    expect(column.scrollTop).toBe(640);
  });

  test("Change in the make view goes back to the shelf, choosing those products", async () => {
    serveShelf();
    visit(`make=${P2},${P3}`);
    renderPage();
    expect(screen.getByRole("region", { name: "Make view" })).toHaveTextContent(
      `make workspace-1 null ${P2},${P3}`
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Change the products" })
    );
    // Opened from its address: closing it stays on this entry.
    expect(window.location.search).toBe("");
    expect(
      await screen.findByRole("checkbox", { name: "Кружка Web UMN" })
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Шежіре" })).not.toBeChecked();
  });

  test("the review hands its products on: an ad of them, or choosing them on the shelf", async () => {
    serveShelf();
    visit(`review=${IMPORT_ID}`);
    renderPage();
    expect(screen.getByRole("region", { name: "Review" })).toHaveTextContent(
      `review ${IMPORT_ID}`
    );
    // Its own back button; the page adds none.
    expect(
      screen.queryByRole("button", { name: "Products" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Make an ad of P2" }));
    expect(window.location.search).toBe(`?ad=new&products=${P2}`);
    // Back to the shelf, not to the review the page was opened at.
    fireEvent.click(screen.getByRole("button", { name: "Products" }));
    await waitFor(() => expect(window.location.search).toBe(""));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(
      screen.queryByRole("region", { name: "Review" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Products" })
    ).toBeInTheDocument();
  });

  test("the review's Change chooses its products on the shelf", async () => {
    serveShelf();
    visit(`review=${IMPORT_ID}`);
    renderPage();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose them on the shelf" })
    );
    expect(window.location.search).toBe("");
    expect(
      await screen.findByRole("checkbox", { name: "Кружка Web UMN" })
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Шежіре" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Кукла Лол" })
    ).not.toBeChecked();
  });
});

test("reads only the views an address can hold", () => {
  const view = (search: string) => productsViewIn(new URLSearchParams(search));
  expect(view("")).toEqual({ kind: "shelf" });
  expect(view(`review=${IMPORT_ID}`)).toEqual({
    kind: "review",
    importId: IMPORT_ID,
  });
  expect(view("review=../../admin")).toEqual({ kind: "shelf" });
  expect(view(`make=${P1},${P2}`)).toEqual({
    kind: "make",
    productIds: [P1, P2],
  });
  expect(view(`make=${P1},nope`)).toEqual({ kind: "shelf" });
  expect(view(`ad=new&products=${P1},${P1},${P2}`)).toEqual({
    kind: "ad-new",
    productIds: [P1, P2],
  });
  // An ad shows 1 to 3 products.
  expect(view(`ad=new&products=${P1},${P2},${P3},${P4}`)).toEqual({
    kind: "shelf",
  });
  expect(view("ad=new")).toEqual({ kind: "shelf" });
  expect(view(`ad=${AD_ID}`)).toEqual({ kind: "ad", adId: AD_ID });
  expect(view("ad=x")).toEqual({ kind: "shelf" });
});
