/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import type {
  ProductAdRecord,
  ProductKitRecord,
  ProductsMadeResponse,
  WorkspaceProductRecord,
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
import { MadeList } from "./product-made-list";
import { madeWhen } from "./use-product-kits";

// "Made from your shelf": every kit and ad, newest first, with each one's
// status and next step.

const WS = "workspace-1";
const MADE = `/api/workspaces/${WS}/products/made`;
const SHELF = `/api/workspaces/${WS}/products`;
const id = (n: number) => `651f1f77bcf86cd7994390${String(n).padStart(2, "0")}`;
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const shelf: WorkspaceProductRecord[] = [
  {
    id: id(1),
    name: "Кукла Лол",
    price: 5000,
    currency: "KZT",
    priceIsFrom: false,
    imageUrl: "https://cdn.test/1.webp",
    hasCutout: true,
    updatedAt: null,
  },
  {
    id: id(2),
    name: "Кружка Web UMN",
    price: 3500,
    currency: "KZT",
    priceIsFrom: false,
    imageUrl: "https://cdn.test/2.webp",
    hasCutout: true,
    updatedAt: null,
  },
  {
    id: id(3),
    name: "Ойыншық доллар",
    price: null,
    currency: null,
    priceIsFrom: false,
    imageUrl: "https://cdn.test/3.webp",
    hasCutout: true,
    updatedAt: null,
  },
];

const kit = (
  n: number,
  overrides: Partial<ProductKitRecord> = {}
): ProductKitRecord => ({
  id: `kit-${n}`,
  createdAt: minutesAgo(n * 10),
  language: "kk",
  productIds: [id(1), id(2), id(3)],
  importId: null,
  parts: {
    orderForm: {
      state: "ready",
      flowId: "flow-1",
      flowName: "Order form · 2 Nov 09:14",
      productCount: 3,
      error: null,
    },
    carousel: {
      state: "submitted",
      templateId: "tpl-1",
      templateName: "products_20261102_041405",
      cardCount: 3,
      metaStatus: "PENDING",
      metaReason: null,
      approvedAt: null,
      error: null,
    },
  },
  status: "waiting_for_meta",
  pricesChanged: false,
  ...overrides,
});

const ad = (
  n: number,
  overrides: Partial<ProductAdRecord> = {}
): ProductAdRecord => ({
  id: `ad-${n}`,
  status: "ready",
  step: null,
  errorCode: null,
  createdAt: minutesAgo(n * 10),
  // Asked for when it was made, unless a test edits or retries it.
  requestedAt: overrides.createdAt ?? minutesAgo(n * 10),
  startedAt: null,
  readyAt: null,
  renderNo: 1,
  language: "Kazakh",
  timings: {},
  idea: { kind: "new", text: null },
  voice: "own",
  ending: { phone: null, shopName: "QazOner Group" },
  products: [
    {
      productId: id(1),
      name: "Кукла Лол",
      englishName: "LOL doll",
      priceText: "5 000 ₸",
      imageUrl: null,
    },
    {
      productId: id(2),
      name: "Кружка Web UMN",
      englishName: "Web UMN mug",
      priceText: "3 500 ₸",
      imageUrl: null,
    },
    {
      productId: id(3),
      name: "Шежіре",
      englishName: null,
      priceText: "15 500 ₸",
      imageUrl: null,
    },
  ],
  script: null,
  scenes: [],
  video: {
    url: "https://cdn.test/ad.mp4",
    bytes: 3_200_000,
    seconds: 15,
    posterUrl: "https://cdn.test/poster.jpg",
  },
  stills: { statusUrl: null, feedUrl: null },
  post: null,
  ctwa: null,
  presenter: null,
  costUsd: 0.05,
  ...overrides,
});

let made: ProductsMadeResponse;
let madeStatus: number;
let posts: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  made = {
    kits: [kit(1)],
    ads: [],
    whatsapp: { connected: true, displayPhone: null },
  };
  madeStatus = 200;
  posts = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // jsdom has no Response: the page only reads these three.
    const json = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    if (method === "GET" && url === MADE)
      return madeStatus === 200
        ? json(200, made)
        : json(madeStatus, { code: "load_failed" });
    if (method === "GET" && url === SHELF)
      return json(200, { products: shelf });
    if (method === "POST") {
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      // The part is made again: the server's list now has it so.
      made = { ...made, kits: [kit(1)] };
      return json(200, { kit: kit(1) });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
});

function renderList() {
  const onOpenAd = jest.fn();
  const onMakeAd = jest.fn();
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MadeList workspaceId={WS} onOpenAd={onOpenAd} onMakeAd={onMakeAd} />
    </SWRConfig>
  );
  return { ...view, onOpenAd, onMakeAd };
}

const rowOf = async (title: string) =>
  (await screen.findAllByText(title, { selector: "p" }))[0]!.closest("li")!;

test("shows nothing while nothing has been made", async () => {
  made = {
    kits: [],
    ads: [],
    whatsapp: { connected: true, displayPhone: null },
  };
  const { container } = renderList();

  await act(() => new Promise(resolve => setTimeout(resolve, 50)));
  expect(container).toBeEmptyDOMElement();
});

test("a kit row: its cards, products and when, a chip per part, and each part's next step", async () => {
  renderList();

  expect(
    await screen.findByRole("heading", { name: "Made from your shelf" })
  ).toBeVisible();
  const row = await rowOf("Carousel + order form");
  // The same words the row builds, so a run just after midnight still matches
  // ("yesterday at 23:52"); madeWhen's own tests pin today and yesterday.
  expect(
    within(row).getByText(
      PRODUCTS_COPY.made.kitMeta(
        3,
        madeWhen(made.kits[0]!.createdAt, new Date(), PRODUCTS_COPY.made)
      )
    )
  ).toBeVisible();
  expect(within(row).getByText("Order form ready")).toBeVisible();
  expect(within(row).getByText("Carousel with Meta")).toBeVisible();
  expect(
    within(row).getByRole("link", { name: "Open WhatsApp Flows" })
  ).toHaveAttribute("href", "/panel/w/workspace-1/messengers/whatsapp-flows");
  expect(
    within(row).getByRole("link", { name: "Open in Templates" })
  ).toHaveAttribute(
    "href",
    "/panel/w/workspace-1/messengers/whatsapp-templates?template=products_20261102_041405"
  );
  // The kit's cards, from the shelf: cut-outs on white.
  await waitFor(() => expect(row.querySelectorAll("img")).toHaveLength(3));
  expect(row.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.test/1.webp"
  );
});

test("a kit's products go to a video ad: those with a photo and a price", async () => {
  const { onMakeAd } = renderList();
  const row = await rowOf("Carousel + order form");

  fireEvent.click(
    await within(row).findByRole("button", {
      name: "Make a video ad with these",
    })
  );

  expect(onMakeAd).toHaveBeenCalledWith([id(1), id(2)]);
});

test("a product whose photo is the whole frame, not a cut-out, isn't offered for a video ad", async () => {
  // With no clear view, the shelf shows the whole frame; the ad's brief
  // would refuse it (no_photo).
  const kept = shelf[1]!;
  shelf[1] = { ...kept, hasCutout: false };
  try {
    const { onMakeAd } = renderList();
    const row = await rowOf("Carousel + order form");
    fireEvent.click(
      await within(row).findByRole("button", {
        name: "Make a video ad with these",
      })
    );
    expect(onMakeAd).toHaveBeenCalledWith([id(1)]);
  } finally {
    shelf[1] = kept;
  }
});

test("a part that wasn't made is made again from its row", async () => {
  made.kits = [
    kit(1, {
      parts: {
        ...kit(1).parts,
        carousel: {
          ...kit(1).parts.carousel!,
          state: "failed",
          templateId: null,
          metaStatus: null,
          error: { code: "meta_refused", message: "Invalid parameter" },
        },
      },
      status: "needs_attention",
    }),
  ];
  renderList();
  const row = await rowOf("Carousel + order form");

  expect(within(row).getByText("Carousel not made")).toBeVisible();
  // A specific chip already says what's wrong.
  expect(within(row).queryByText("Needs attention")).toBeNull();
  const again = within(row).getByRole("button", {
    name: "Make the carousel again",
  });
  act(() => again.focus());
  fireEvent.click(again);

  await screen.findByText("Carousel with Meta");
  expect(posts).toEqual([
    {
      url: `/api/workspaces/${WS}/products/kits/kit-1/retry`,
      body: { part: "carousel" },
    },
  ]);
  // Made, its button went: the row's title has the keyboard's focus.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(row).getByText("Carousel + order form", { selector: "p" })
    )
  );
});

test("a draft order form needs attention, and a single part is named alone", async () => {
  made.kits = [
    kit(1, {
      parts: {
        orderForm: { ...kit(1).parts.orderForm!, state: "draft" },
      },
      status: "needs_attention",
      pricesChanged: true,
    }),
  ];
  renderList();
  const row = await rowOf("Order form");

  expect(within(row).getByText("Order form draft")).toBeVisible();
  expect(within(row).getByText("Needs attention")).toBeVisible();
  expect(within(row).getByText("Prices changed")).toBeVisible();
});

test("ad rows: the poster, the products and length, the status, and Open", async () => {
  made = {
    kits: [],
    ads: [
      ad(1),
      ad(2, { status: "making", video: null, createdAt: minutesAgo(0.5) }),
      ad(3, { status: "failed", video: null, errorCode: "failed" }),
    ],
    whatsapp: { connected: true, displayPhone: null },
  };
  const { onOpenAd } = renderList();

  const rows = (await screen.findAllByText("Video ad", { selector: "p" })).map(
    title => title.closest("li")!
  );
  expect(rows).toHaveLength(3);
  // Newest first: the one being made started half a minute ago.
  const [making, ready, failed] = rows as [
    HTMLLIElement,
    HTMLLIElement,
    HTMLLIElement,
  ];
  expect(within(ready).getByText("Кукла Лол and 2 more · 0:15")).toBeVisible();
  expect(within(ready).getByText("Ready")).toBeVisible();
  expect(ready.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.test/poster.jpg"
  );
  expect(within(making).getByText(/^Making · 0:\d{2}$/)).toBeVisible();
  expect(within(failed).getByText("Couldn't be made")).toBeVisible();

  fireEvent.click(within(ready).getByRole("button", { name: "Open" }));
  expect(onOpenAd).toHaveBeenCalledWith("ad-1");
});

test("an ad made again counts its making time from the latest request", async () => {
  made = {
    kits: [],
    ads: [
      // Made 45 minutes ago, its words edited half a minute ago.
      ad(1, {
        status: "making",
        video: null,
        createdAt: minutesAgo(45),
        requestedAt: minutesAgo(0.5),
      }),
    ],
    whatsapp: { connected: true, displayPhone: null },
  };
  renderList();

  const row = (await screen.findByText("Video ad", { selector: "p" })).closest(
    "li"
  )!;
  expect(within(row).getByText(/^Making · 0:\d{2}$/)).toBeVisible();
});

test("newest first, 3 rows, then Show all", async () => {
  made = {
    kits: [kit(1), kit(3), kit(5)],
    ads: [ad(2), ad(4)],
    whatsapp: { connected: true, displayPhone: null },
  };
  renderList();

  await screen.findByRole("heading", { name: "Made from your shelf" });
  const titles = () =>
    screen
      .getAllByRole("listitem")
      .map(item => item.querySelector("p")!.textContent);
  expect(titles()).toEqual([
    "Carousel + order form",
    "Video ad",
    "Carousel + order form",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Show all 5" }));
  expect(titles()).toHaveLength(5);
  expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
});

test("a failed load says so, with Retry", async () => {
  madeStatus = 503;
  renderList();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "What you made couldn't be loaded."
  );
  madeStatus = 200;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "Made from your shelf" })
  ).toBeVisible();
});
