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
import { SWRConfig, useSWRConfig } from "swr";
import { ProductsPage } from "./products-page";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";

// Adding products from a video: the upload from this device, then the import
// job's progress and the products it finds.

type Handler = (event: RealtimeEventEnvelope) => void;
const realtimeHandlers = new Set<Handler>();
let mockConnected = false;
jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({
    channel: {
      bind: (_name: string, handler: Handler) => realtimeHandlers.add(handler),
      unbind: (_name: string, handler: Handler) =>
        realtimeHandlers.delete(handler),
    },
    isConnected: mockConnected,
  }),
}));

// The page's address, as Next gives it; null outside the app router.
let mockSearch: URLSearchParams | null = null;
jest.mock("next/navigation", () => ({ useSearchParams: () => mockSearch }));

const mockCheck = jest.fn();
jest.mock("./products-client", () => ({
  ...jest.requireActual("./products-client"),
  checkProductVideo: (...args: unknown[]) => mockCheck(...args),
}));

const BASE = "/api/workspaces/workspace-1";
type Route = (init?: RequestInit) => Promise<unknown> | unknown;
let routes: Record<string, Route>;
const calls: Array<{ url: string; init?: RequestInit }> = [];

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => "",
  };
}

const record = (overrides: Record<string, unknown> = {}) => ({
  id: "import-1",
  status: "processing",
  stage: "cutting",
  productTotal: 2,
  photoTotal: 3,
  photoDone: 1,
  errorCode: null,
  photosStopped: null,
  draftsLeft: true,
  presenter: null,
  createdAt: "2026-10-28T09:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

const draft = (
  id: string,
  name: string,
  photo: { method: string; imageUrl: string | null },
  // The description is the photo's prompt, shown while it's made: by
  // default it never repeats the name.
  {
    description = `${id} as filmed`,
    price = 15500,
    doubts = [] as Array<{ about: string; text: string }>,
  } = {}
) => ({
  id,
  name,
  price,
  priceIsFrom: true,
  imageUrl: photo.imageUrl,
  updatedAt: null,
  status: "draft",
  englishName: null,
  nameSource: "spoken",
  priceQuote: null,
  priceSource: "spoken",
  doubts,
  options: [
    {
      description,
      photoMethod: photo.method,
      imageUrl: photo.imageUrl,
      photoUrl: null,
      originalUrl: null,
      videoMomentSeconds: null,
      straightenedDegrees: 0,
      notes: [],
    },
  ],
  featuredOption: 0,
});

const restored = (name: string) => ({
  method: "restored",
  imageUrl: `https://storage.test/${name}.webp`,
});
const pending = { method: "pending", imageUrl: null };

beforeEach(() => {
  calls.length = 0;
  realtimeHandlers.clear();
  mockConnected = false;
  mockSearch = null;
  window.history.replaceState(null, "", "/panel/workspace-1/products");
  mockCheck.mockReset().mockResolvedValue(null);
  routes = {
    [`GET ${BASE}/products`]: () => respond(200, { products: [] }),
    [`GET ${BASE}/products/imports`]: () => respond(200, { imports: [] }),
    // The made list above a shelf that holds something: nothing made yet.
    [`GET ${BASE}/products/made`]: () =>
      respond(200, {
        kits: [],
        ads: [],
        whatsapp: { connected: false, displayPhone: null },
      }),
  };
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route(init);
  }) as unknown as typeof fetch;
  URL.createObjectURL = jest.fn(() => "blob:shelf");
  URL.revokeObjectURL = jest.fn();
});

function pageTree() {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
      <RefreshList />
    </SWRConfig>
  );
}

/** Asks for the imports list again, and nothing else, as its poll does. */
function RefreshList() {
  const { mutate } = useSWRConfig();
  return (
    <button onClick={() => void mutate(`${BASE}/products/imports`)}>
      Refresh the list
    </button>
  );
}

function renderPage() {
  return render(pageTree());
}

const detailRequests = (importId: string) =>
  calls.filter(call => call.url === `${BASE}/products/imports/${importId}`)
    .length;

const railStep = () =>
  within(
    screen.getByRole("list", {
      name: "How Airi turns your video into products",
    })
  )
    .getAllByRole("listitem")
    .find(item => item.getAttribute("aria-current") === "step");

/** The stage's "What you said" rows, once Muse Spark has listed the products. */
async function heardRows() {
  const ledger = await screen.findByRole("region", { name: "What you said" });
  return within(ledger).getAllByRole("listitem");
}

const shelfVideo = () =>
  new File([new Uint8Array(2048)], "shelf.mov", { type: "video/quicktime" });

function chooseVideo(file: File) {
  fireEvent.change(screen.getByLabelText("Upload a video"), {
    target: { files: [file] },
  });
}

const posted = (url: string) =>
  calls
    .filter(call => call.url === url && call.init?.method === "POST")
    .map(call => JSON.parse(String(call.init?.body)));

/** The upload's own requests, answered as storage and the APIs would. */
function serveUpload(options: { importStatus?: number } = {}) {
  routes[`POST ${BASE}/assets/upload`] = init => {
    const body = JSON.parse(String(init?.body));
    return body.action === "initiate"
      ? respond(200, {
          upload: {
            provider: "gcs",
            assetId: "asset-1",
            bucket: "media",
            path: "workspaces/workspace-1/creative-assets/video/asset-1/shelf.mov",
            uploadUrl: "https://storage.test/session",
            method: "PUT",
            kind: "video",
            mimeType: "video/quicktime",
            fileName: "shelf.mov",
            fileSize: 2048,
          },
        })
      : respond(200, { asset: { id: "asset-1" } });
  };
  routes["PUT https://storage.test/session"] = () => respond(200, {});
  routes[`POST ${BASE}/products/imports`] = () =>
    options.importStatus
      ? respond(options.importStatus, { code: "import_unavailable" })
      : startImport();
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: record({ status: "queued" }), products: [] });
}

/** The import starts, and the list shows it from then on. */
function startImport() {
  const queued = record({ status: "queued", stage: null, productTotal: 0 });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [queued] });
  return respond(201, { importId: "import-1" });
}

test("offers to upload a video on the empty shelf", async () => {
  renderPage();
  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Upload a video" })
  ).toBeInTheDocument();
  expect(
    screen.getByText("MP4 or MOV. About a minute is plenty; up to 5 minutes.")
  ).toBeInTheDocument();
});

test("uploads a chosen video to storage, then shows its import waiting", async () => {
  serveUpload();
  renderPage();
  await screen.findByText("Your products will appear here");

  chooseVideo(shelfVideo());

  expect(
    await screen.findByText("Getting ready to read your video")
  ).toBeInTheDocument();
  expect(posted(`${BASE}/assets/upload`)).toEqual([
    {
      action: "initiate",
      fileName: "shelf.mov",
      mimeType: "video/quicktime",
      fileSize: 2048,
    },
    expect.objectContaining({ action: "complete", assetId: "asset-1" }),
  ]);
  expect(
    calls.some(
      call =>
        call.url === "https://storage.test/session" &&
        call.init?.method === "PUT"
    )
  ).toBe(true);
  expect(posted(`${BASE}/products/imports`)).toEqual([{ assetId: "asset-1" }]);
  // The empty shelf's message goes while the video is read.
  expect(
    screen.queryByText("Your products will appear here")
  ).not.toBeInTheDocument();
  // The import's stage still shows the file this page sent: its first frame,
  // name and size.
  const stage = document.querySelector<HTMLElement>('[data-canvas="import"]')!;
  expect(stage.querySelector("video")).toHaveAttribute(
    "src",
    "blob:shelf#t=0.1"
  );
  expect(within(stage).getByText("shelf.mov")).toBeInTheDocument();
  expect(within(stage).getByText("· 2 KB")).toBeInTheDocument();
  expect(railStep()).toHaveTextContent("Prepare");
});

test("refuses a video that is too long before uploading it", async () => {
  mockCheck.mockResolvedValue("too_long");
  renderPage();
  await screen.findByText("Your products will appear here");

  chooseVideo(shelfVideo());

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The video is longer than 5 minutes."
  );
  expect(posted(`${BASE}/assets/upload`)).toEqual([]);
  // Another try wouldn't help: the page's button chooses another video.
  expect(
    screen.queryByRole("button", { name: "Try again" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Upload a video" })
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
});

test("stops an upload when cancelled", async () => {
  serveUpload();
  routes["PUT https://storage.test/session"] = init =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      )
    );
  renderPage();
  await screen.findByText("Your products will appear here");

  chooseVideo(shelfVideo());
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  // The upload button went with the upload; its Cancel has the focus.
  expect(cancel).toHaveFocus();
  fireEvent.click(cancel);

  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
  expect(posted(`${BASE}/products/imports`)).toEqual([]);
  // And the focus goes back to the upload button.
  expect(screen.getByRole("button", { name: "Upload a video" })).toHaveFocus();
});

test("the shelf's '+' waits while a video is sent, and the upload card says how far it is", async () => {
  serveUpload();
  routes["PUT https://storage.test/session"] = () => new Promise(() => {});
  routes[`GET ${BASE}/products`] = () =>
    respond(200, {
      products: [
        {
          id: "s1",
          name: "Шежіре",
          price: 15500,
          priceIsFrom: true,
          imageUrl: null,
          updatedAt: null,
        },
      ],
    });
  const { container } = renderPage();
  const add = await screen.findByRole("button", { name: "Upload a video" });
  expect(add).toBeEnabled();

  chooseVideo(shelfVideo());
  await screen.findByRole("button", { name: "Cancel" });

  // One video at a time: the "+" waits for this one.
  expect(screen.getByRole("button", { name: "Upload a video" })).toBeDisabled();
  const card = container.querySelector<HTMLElement>('[data-canvas="upload"]')!;
  expect(
    within(card).getByRole("heading", { name: "Uploading your video" })
  ).toBeInTheDocument();
  expect(
    within(card).getByText("Keep this page open until it's uploaded.")
  ).toBeInTheDocument();
  // How much is sent, of the file chosen, beside its first frame.
  expect(
    within(card).getByRole("progressbar", { name: "Uploading your video" })
  ).toHaveAttribute("aria-valuetext", "0% · 0 of 2 KB");
  expect(within(card).getByText("shelf.mov")).toBeInTheDocument();
  expect(card.querySelector("video")).toHaveAttribute(
    "src",
    "blob:shelf#t=0.1"
  );
  // Nothing on it plays: the video stands on its first frame.
  expect(card.querySelector("video")).not.toHaveAttribute("autoplay");
});

test("uploads a dropped video, and keeps a file dropped meanwhile from leaving the page", async () => {
  serveUpload();
  routes["PUT https://storage.test/session"] = () => new Promise(() => {});
  const { container } = renderPage();
  await screen.findByText("Your products will appear here");
  const page = container.querySelector("section")!;
  const dataTransfer = (file: File) => ({
    types: ["Files"],
    files: [file],
    dropEffect: "none",
  });

  fireEvent.dragEnter(page, { dataTransfer: dataTransfer(shelfVideo()) });
  fireEvent.drop(page, { dataTransfer: dataTransfer(shelfVideo()) });
  expect(
    await screen.findByRole("button", { name: "Cancel" })
  ).toBeInTheDocument();

  // Not cancelled, the browser would open the file in place of the page.
  const other = dataTransfer(shelfVideo());
  expect(fireEvent.dragOver(page, { dataTransfer: other })).toBe(false);
  expect(other.dropEffect).toBe("none");
  expect(fireEvent.drop(page, { dataTransfer: other })).toBe(false);
  await waitFor(() =>
    expect(
      posted(`${BASE}/assets/upload`).filter(body => body.action === "initiate")
    ).toHaveLength(1)
  );
});

test("starts the import again without uploading the video again", async () => {
  serveUpload({ importStatus: 503 });
  renderPage();
  await screen.findByText("Your products will appear here");

  chooseVideo(shelfVideo());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The video was uploaded, but reading it couldn't start."
  );

  routes[`POST ${BASE}/products/imports`] = startImport;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(
    await screen.findByText("Getting ready to read your video")
  ).toBeInTheDocument();
  expect(posted(`${BASE}/products/imports`)).toEqual([
    { assetId: "asset-1" },
    { assetId: "asset-1" },
  ]);
  expect(
    posted(`${BASE}/assets/upload`).filter(body => body.action === "initiate")
  ).toHaveLength(1);
});

test("shows a running import's stage, and its products as their photos are made", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [record()] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: record(),
      products: [
        draft("p1", "Шежіре", {
          method: "restored",
          imageUrl: "https://storage.test/shezhire.webp",
        }),
        draft("p2", "Медаль ілгіш", { method: "pending", imageUrl: null }),
      ],
    });
  renderPage();

  expect(
    await screen.findByRole("heading", { name: "Making photos" })
  ).toBeInTheDocument();
  // Said once, on the step: the doing line counts in words.
  expect(screen.getAllByText("1 of 3")).toHaveLength(1);
  expect(screen.getByText("1 of 3 photos are made.")).toBeInTheDocument();
  // The line along the stage's bottom: photos made of all.
  expect(
    screen.getByRole("progressbar", { name: "Making photos" })
  ).toHaveAttribute("aria-valuenow", "33");
  expect(railStep()).toHaveTextContent("Make photos");

  // What the owner said, product by product, with where each photo is.
  const ledger = await heardRows();
  expect(ledger.map(row => row.getAttribute("data-product"))).toEqual([
    "p1",
    "p2",
  ]);
  expect(ledger[0]).toHaveTextContent("Photo made");
  expect(ledger[1]).toHaveTextContent("Making photo");

  const found = await screen.findByRole("list", {
    name: "Found in your video",
  });
  const items = within(found).getAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]!.querySelector("img")).toHaveAttribute(
    "src",
    "https://storage.test/shezhire.webp"
  );
  // The second product's photo is still being made.
  expect(items[1]!.querySelector("img")).toBeNull();
  expect(items[1]).toHaveAttribute("data-photo", "making");
  expect(within(found).getByText("Медаль ілгіш")).toBeInTheDocument();
  // Headed apart from the shelf the owner's customers see, with its count.
  expect(
    screen.getByRole("heading", { name: "Found in your video 2" })
  ).toBeInTheDocument();
  expect(
    screen.getByText("Not on your shelf until you check them.")
  ).toBeInTheDocument();
});

test("the ledger writes a price said in dollars in dollars", async () => {
  const running = record({ productTotal: 1, photoTotal: 1, photoDone: 0 });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [running] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: running,
      products: [
        {
          ...draft("p1", "Phone stand", pending, { price: 10 }),
          currency: "USD",
        },
      ],
    });
  renderPage();

  const [row] = await heardRows();
  expect(within(row!).getByText("Phone stand")).toBeInTheDocument();
  expect(within(row!).getByText("from 10 USD")).toBeInTheDocument();
});

test("names and the owner's words written right to left read in their own direction", async () => {
  const running = record({ productTotal: 1, photoTotal: 1, photoDone: 0 });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [running] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: running,
      products: [
        {
          ...draft("p1", "كوب القهوة", pending, { price: 50 }),
          currency: "SAR",
          priceQuote: "هذا الكوب بخمسين ريالا",
        },
      ],
    });
  renderPage();

  // Each in its own cell, so the price keeps its place after the name.
  const [row] = await heardRows();
  expect(within(row!).getByText("كوب القهوة")).toHaveAttribute("dir", "auto");
  expect(within(row!).getByText("«هذا الكوب بخمسين ريالا»")).toHaveAttribute(
    "dir",
    "auto"
  );
  expect(within(row!).getByText("from 50 SAR")).toBeInTheDocument();
});

test("the ledger lists every product Muse Spark found, and where each photo is", async () => {
  const running = record({ productTotal: 6, photoTotal: 6, photoDone: 1 });
  const said = (id: string, name: string, quote: string, at: number) => {
    const product = draft(id, name, id === "p1" ? restored("one") : pending);
    return {
      ...product,
      currency: "KZT",
      priceQuote: quote,
      options: [{ ...product.options[0]!, videoMomentSeconds: at }],
    };
  };
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [running] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: running,
      products: [
        said("p1", "Кружка Web UMN", "мына кружка бес жүз теңге", 2),
        said("p2", "Телефон ойыншық", "телефон ойыншық екі мың", 9),
        said("p3", "Керамикалық әтеш", "әтеш бес жүз теңге", 17),
        said("p4", "Динозавр", "динозавр үш жүз", 25),
        said("p5", "Кукла Лол", "кукла бес мың", 33),
        said("p6", "Телефон подставка", "подставка екі мың", 52),
      ],
    });
  renderPage();

  const rows = await heardRows();
  expect(rows).toHaveLength(6);
  expect(rows[4]).toHaveTextContent(
    "0:33«кукла бес мың»Кукла Лолfrom 15 500 ₸Making photo"
  );
  // The job makes four at once, in the order filmed; the rest wait.
  expect(
    rows.map(row => row.querySelector("[data-photo]")!.textContent)
  ).toEqual([
    "Photo made",
    "Making photo",
    "Making photo",
    "Making photo",
    "Making photo",
    "Next in line",
  ]);
  expect(
    screen.getByRole("region", { name: "What you said" })
  ).toHaveTextContent("Heard by Scribe, priced by Muse Spark");
  // Past four, a phone shows the first ones until asked for all.
  const more = screen.getByRole("button", { name: "Show all 6" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(more);
  expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
});

test("the ledger waits for Muse Spark's list: listening shows only what it's doing", async () => {
  const listening = record({
    stage: "listening",
    productTotal: 0,
    photoTotal: 0,
    photoDone: 0,
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [listening] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: listening, products: [] });
  renderPage();

  await screen.findByRole("heading", { name: "Listening to what you said" });
  await waitFor(() => expect(detailRequests("import-1")).toBe(1));
  expect(
    screen.queryByRole("region", { name: "What you said" })
  ).not.toBeInTheDocument();
  // Nothing to measure yet: no bar, the words carry it.
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

test("a photo landing shows on the stage's frame and in the ledger", async () => {
  const making = record({ productTotal: 2, photoTotal: 2, photoDone: 0 });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [making] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: making,
      products: [
        draft("p1", "Шежіре", pending),
        draft("p2", "Медаль ілгіш", pending),
      ],
    });
  const { container } = renderPage();
  await heardRows();
  const stage = container.querySelector<HTMLElement>("[data-canvas]")!;
  // Not uploaded from this page and no presenter: paper with a film mark.
  expect(stage.querySelector('[data-film="none"]')).not.toBeNull();

  const landed = record({ productTotal: 2, photoTotal: 2, photoDone: 1 });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [landed] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: landed,
      products: [
        draft("p1", "Шежіре", restored("shezhire")),
        draft("p2", "Медаль ілгіш", pending),
      ],
    });
  for (const handler of realtimeHandlers)
    handler({
      eventId: "e1",
      version: 1,
      name: "products.changed",
      workspaceId: "workspace-1",
      createdAt: "2026-10-28T09:00:05.000Z",
      dedupeKey: "e1",
      payload: { importId: "import-1", reason: "photo", productId: "p1" },
    } as unknown as RealtimeEventEnvelope);

  // The new photo stands on the frame's wall tile, and its row says so.
  await waitFor(() =>
    expect(
      stage.querySelector(
        '[data-film="still"] img[src="https://storage.test/shezhire.webp"]'
      )
    ).not.toBeNull()
  );
  const rows = await heardRows();
  expect(rows[0]).toHaveTextContent("Photo made");
  expect(screen.getByText("1 of 2 photos are made.")).toBeInTheDocument();
  expect(
    screen.getByRole("progressbar", { name: "Making photos" })
  ).toHaveAttribute("aria-valuenow", "50");
});

test("a running import says how long it has been going", async () => {
  const listening = record({
    stage: "listening",
    productTotal: 0,
    photoTotal: 0,
    photoDone: 0,
    createdAt: new Date(Date.now() - 65_000).toISOString(),
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [listening] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: listening, products: [] });
  const { container } = renderPage();

  await screen.findByText("Listening to what you said");
  const stage = container.querySelector<HTMLElement>("[data-canvas]")!;
  expect(await within(stage).findByText(/^1:0\d so far$/)).toBeInTheDocument();
  expect(
    within(stage).getByText("Writing down each name and price you said.")
  ).toBeInTheDocument();
  // It goes on without the page.
  expect(
    within(stage).getByText(
      "You can leave this page; your products keep coming."
    )
  ).toBeInTheDocument();
});

test.each([
  ["preparing", "Prepare"],
  ["listening", "Listen"],
  ["watching", "Watch"],
  ["cutting", "Make photos"],
])("marks the rail's step while %s", async (stage, step) => {
  const running = record({
    stage,
    ...(stage === "cutting" ? {} : { productTotal: 0, photoTotal: 0 }),
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [running] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: running, products: [] });
  renderPage();

  await screen.findByRole("list", {
    name: "How Airi turns your video into products",
  });
  expect(railStep()).toHaveTextContent(step);
  // Each step names who does it.
  expect(railStep()).toHaveTextContent(
    {
      Prepare: "Airi",
      Listen: "ElevenLabs Scribe v2",
      Watch: "Muse Spark 1.3",
      "Make photos": "Muse Spark, SAM 3.1 and Muse Image 1.0",
    }[step]!,
    { normalizeWhitespace: true }
  );
});

test("a ready import collapses into its print: what it found stands on its row, waiting for the owner", async () => {
  const ready = record({
    status: "ready",
    stage: null,
    photoDone: 3,
    presenter: {
      imageUrl: "https://storage.test/presenter.webp",
      photoUrl: null,
      originalUrl: "https://storage.test/presenter-frame.jpg",
    },
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [ready] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: ready,
      products: [
        draft("p1", "Шежіре", restored("shezhire")),
        draft("p2", "Медаль ілгіш", restored("medal")),
      ],
    });
  const { container } = renderPage();

  const row = await waitFor(() => {
    const element = container.querySelector<HTMLElement>(
      '[data-row="import-1"]'
    );
    expect(element).not.toBeNull();
    return element!;
  });
  // No stage: the video is a print at the head of its row, the frame its
  // presenter was cut from.
  expect(container.querySelector("[data-canvas]")).toBeNull();
  expect(row.querySelector("figure img")).toHaveAttribute(
    "src",
    "https://storage.test/presenter-frame.jpg"
  );
  // Its products, in the order filmed, as drafts the owner can pick.
  await waitFor(() =>
    expect(
      [...row.querySelectorAll("[data-product]")].map(button =>
        button.getAttribute("data-product")
      )
    ).toEqual(["p1", "p2"])
  );
  expect(
    within(row).getByRole("button", { name: /^Шежіре,.*not on your shelf yet/ })
  ).toBeInTheDocument();
  // The check one by one is the print's.
  expect(
    within(row).getByRole("button", { name: "More for this video" })
  ).toBeInTheDocument();
});

// The owner's first production run: five products found, two photos made
// before the import failed at the AI spending limit.
const todaysFailure = () =>
  record({
    status: "failed",
    stage: null,
    productTotal: 5,
    photoTotal: 5,
    photoDone: 2,
    errorCode: "spend_limit",
  });
const todaysProducts = () => [
  draft("hl", "Holly Land", restored("holly-land"), {
    description: "black Hollyland charging case",
    price: 40000,
  }),
  draft("ms", "Мышка", pending, {
    description: "worn black wireless mouse",
    price: 20000,
  }),
  draft("pc", "Печать", restored("pechat"), {
    description: "green and black stamp",
    price: 2000,
  }),
  draft("st", "пачка стикеров", pending, {
    description: "yellow sticky notes pack",
    price: 5,
    doubts: [{ about: "price", text: "5 tenge seems low for a pack." }],
  }),
  draft("nk", "наушники", pending, {
    description: "white AirPods case with pink D",
    price: 30000,
  }),
];

test("a failed import keeps what it found, and its unmade photos stop for good", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [todaysFailure()] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: todaysFailure(), products: todaysProducts() });
  renderPage();

  const found = await screen.findByRole("list", {
    name: "Found in your video",
  });
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Airi reached an AI spending limit after 2 of 5 photos."
  );
  expect(alert).toHaveTextContent(
    "The products it found are kept for you to check."
  );
  const items = within(found).getAllByRole("listitem");
  expect(items.map(item => item.getAttribute("data-photo"))).toEqual([
    "photo",
    "unmade",
    "photo",
    "unmade",
    "unmade",
  ]);
  // Nothing is left being made, on the shelf or in the ledger.
  expect(found.querySelector('[data-photo="making"]')).toBeNull();
  const rows = await heardRows();
  expect(
    rows.map(row => row.querySelector("[data-photo]")!.textContent)
  ).toEqual(["Photo made", "No photo", "Photo made", "No photo", "No photo"]);
  // A price in doubt is marked where it's written.
  expect(within(rows[3]!).getByText("Check this price")).toHaveClass("sr-only");
  // Photos stopped; what was found is the owner's to check.
  expect(railStep()).toHaveTextContent("Check");
  const steps = within(
    screen.getByRole("list", {
      name: "How Airi turns your video into products",
    })
  );
  expect(steps.getByText("Stopped here")).toBeInTheDocument();
  expect(steps.getByText("2 of 5")).toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Upload a video" })
  ).toHaveLength(1);
  // No bar: nothing is being made any more.
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

  // Offered quietly: the outline, not the stage's push.
  const check = screen.getByRole("button", { name: "Check what was found" });
  expect(check).toHaveAttribute("data-variant", "outline");
  fireEvent.click(check);
  expect(window.location.search).toBe("?review=import-1");
});

test("a failed import whose products were all checked is a row that says where it stopped", async () => {
  // Today's failure, after the owner checked all five products it found.
  const checked = { ...todaysFailure(), draftsLeft: false };
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [checked] });
  let answerDetail: (answer: unknown) => void = () => undefined;
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    new Promise(resolve => (answerDetail = resolve));
  const { container } = renderPage();

  const alert = await screen.findByRole("alert");
  const saysWhereItStopped = () => {
    expect(container.querySelector('[data-variant="stage"]')).toBeNull();
    expect(container.querySelector('[data-variant="row"]')).toHaveAttribute(
      "data-import",
      "import-1"
    );
    expect(alert).toHaveTextContent(
      "Airi reached an AI spending limit after 2 of 5 photos."
    );
    expect(screen.queryByText(/couldn't be read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Upload it again/)).not.toBeInTheDocument();
    expect(screen.queryByText(/are kept for you/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Check what was found" })
    ).not.toBeInTheDocument();
  };
  // Before its products load, and after.
  saysWhereItStopped();
  await waitFor(() => expect(detailRequests("import-1")).toBe(1));
  await act(async () =>
    answerDetail(
      respond(200, {
        import: checked,
        products: todaysProducts().map((product, index) => ({
          ...product,
          status: index % 2 ? "rejected" : "published",
        })),
      })
    )
  );
  saysWhereItStopped();
});

test("a failed import offers the products it found, whatever stopped it", async () => {
  // A retry found the video gone after the first attempt found products.
  const missing = record({
    status: "failed",
    stage: null,
    errorCode: "video_missing",
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [missing] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: missing,
      products: [
        draft("p1", "Шежіре", restored("shezhire")),
        draft("p2", "Медаль ілгіш", pending),
      ],
    });
  renderPage();

  const check = await screen.findByRole("button", {
    name: "Check what was found",
  });
  const alert = screen.getByRole("alert");
  // What happened as the title; what to do, and what's kept, under it.
  expect(
    within(alert).getByRole("heading", {
      name: "The uploaded video went missing.",
    })
  ).toBeInTheDocument();
  expect(alert).toHaveTextContent(
    "Upload it again. The products it found are kept for you to check."
  );
  fireEvent.click(check);
  expect(window.location.search).toBe("?review=import-1");
});

test("an import that stopped making photos says why, and its row shows which weren't made", async () => {
  const stopped = record({
    status: "ready",
    stage: null,
    photoDone: 1,
    photosStopped: "ai_actions_used",
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [stopped] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: stopped,
      products: [
        draft("p1", "Шежіре", restored("shezhire")),
        draft("p2", "Медаль ілгіш", pending),
      ],
    });
  const { container } = renderPage();

  // Said on its card, above the shelf.
  expect(
    await screen.findByText(
      /2 photos weren't made because your plan's included AI actions are used up\./
    )
  ).toBeInTheDocument();
  const row = await waitFor(() => {
    const element = container.querySelector<HTMLElement>(
      '[data-row="import-1"]'
    );
    expect(element?.querySelectorAll("[data-product]")).toHaveLength(2);
    return element!;
  });
  const medal = within(row).getByRole("button", { name: /^Медаль ілгіш,/ });
  expect(within(medal).getByText("No photo")).toBeInTheDocument();
});

test("asks for an import's products again when the list says it ended, with no event", async () => {
  const running = record({ productTotal: 2, photoTotal: 2, photoDone: 0 });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [running] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: running,
      products: [
        draft("p1", "Шежіре", pending),
        draft("p2", "Медаль ілгіш", pending),
      ],
    });
  renderPage();
  const making = await heardRows();
  expect(
    making.map(row => row.querySelector("[data-photo]")!.textContent)
  ).toEqual(["Making photo", "Making photo"]);
  expect(detailRequests("import-1")).toBe(1);

  // The job failed after one photo; no realtime event reached the page.
  const failed = record({
    status: "failed",
    stage: null,
    productTotal: 2,
    photoTotal: 2,
    photoDone: 1,
    errorCode: "failed",
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [failed] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: failed,
      products: [
        draft("p1", "Шежіре", restored("shezhire")),
        draft("p2", "Медаль ілгіш", pending),
      ],
    });
  fireEvent.click(screen.getByRole("button", { name: "Refresh the list" }));

  await waitFor(() => expect(detailRequests("import-1")).toBe(2));
  const found = screen.getByRole("list", { name: "Found in your video" });
  await waitFor(() =>
    expect(within(found).getAllByRole("listitem")[1]).toHaveAttribute(
      "data-photo",
      "unmade"
    )
  );
  const items = within(found).getAllByRole("listitem");
  expect(items[0]!.querySelector("img")).toHaveAttribute(
    "src",
    "https://storage.test/shezhire.webp"
  );
  expect(found.querySelector('[data-photo="making"]')).toBeNull();
  const rows = await heardRows();
  expect(
    rows.map(row => row.querySelector("[data-photo]")!.textContent)
  ).toEqual(["Photo made", "No photo"]);
});

test("asks for every shown import's products again when the connection returns", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, {
      imports: [
        record(),
        record({ id: "import-2", status: "ready", stage: null }),
      ],
    });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: record(), products: [] });
  routes[`GET ${BASE}/products/imports/import-2`] = () =>
    respond(200, {
      import: record({ id: "import-2", status: "ready", stage: null }),
      products: [],
    });
  const { rerender } = renderPage();
  await waitFor(() => expect(detailRequests("import-2")).toBe(1));
  expect(detailRequests("import-1")).toBe(1);

  mockConnected = true;
  rerender(pageTree());

  await waitFor(() => expect(detailRequests("import-1")).toBe(2));
  await waitFor(() => expect(detailRequests("import-2")).toBe(2));
});

test("plays a running import on the stage; a ready one stands on its row", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, {
      imports: [
        record({
          id: "import-2",
          status: "ready",
          stage: null,
          productTotal: 1,
          createdAt: "2026-10-28T10:00:00.000Z",
        }),
        record(),
      ],
    });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: record(), products: [] });
  routes[`GET ${BASE}/products/imports/import-2`] = () =>
    respond(200, {
      import: record({ id: "import-2", status: "ready", stage: null }),
      products: [draft("p9", "Кукла Лол", restored("doll"))],
    });
  const { container } = renderPage();

  // The running import leads, though the ready one is newer.
  await waitFor(() =>
    expect(container.querySelector('[data-variant="stage"]')).toHaveAttribute(
      "data-import",
      "import-1"
    )
  );
  expect(container.querySelectorAll("[data-canvas]")).toHaveLength(1);
  expect(
    screen.queryByRole("list", { name: "Other videos" })
  ).not.toBeInTheDocument();
  const doll = await screen.findByRole("button", { name: /^Кукла Лол,/ });
  expect(doll.closest("[data-row]")).toHaveAttribute("data-row", "import-2");
  // The running import's stage says what it's making.
  expect(
    within(
      container.querySelector('[data-variant="stage"]') as HTMLElement
    ).getByRole("heading", { name: "Making photos" })
  ).toBeInTheDocument();
});

test("a video being uploaded takes the stage, and a running import becomes a row", async () => {
  serveUpload();
  routes["PUT https://storage.test/session"] = () => new Promise(() => {});
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [record()] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: record(), products: [] });
  const { container } = renderPage();
  await screen.findByText("Making photos");
  expect(container.querySelector('[data-canvas="import"]')).not.toBeNull();

  chooseVideo(shelfVideo());

  expect(
    await screen.findByRole("button", { name: "Cancel" })
  ).toBeInTheDocument();
  expect(container.querySelectorAll("[data-canvas]")).toHaveLength(1);
  expect(container.querySelector('[data-canvas="upload"]')).not.toBeNull();
  const rows = screen.getByRole("list", { name: "Other videos" });
  expect(within(rows).getByText("Making photos")).toBeInTheDocument();
  expect(railStep()).toHaveTextContent("Prepare");
});

test("asks again for an import when its job reports a step", async () => {
  let detailRequests = 0;
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [record()] });
  routes[`GET ${BASE}/products/imports/import-1`] = () => {
    detailRequests++;
    return respond(200, { import: record(), products: [] });
  };
  renderPage();
  await screen.findByText("Making photos");
  await waitFor(() => expect(detailRequests).toBe(1));

  for (const handler of realtimeHandlers)
    handler({
      eventId: "e1",
      version: 1,
      name: "products.changed",
      workspaceId: "workspace-1",
      createdAt: "2026-10-28T09:00:05.000Z",
      dedupeKey: "e1",
      payload: { importId: "import-1", reason: "photo", productId: "p2" },
    } as unknown as RealtimeEventEnvelope);

  await waitFor(() => expect(detailRequests).toBe(2));
});

test("explains a failed import, and offers another video", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, {
      imports: [
        record({
          status: "failed",
          stage: null,
          errorCode: "video_unreadable",
        }),
      ],
    });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: record({ status: "failed" }), products: [] });
  renderPage();

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This video couldn't be read."
  );
  // The page's one upload button, not the empty shelf's.
  expect(
    screen.getAllByRole("button", { name: "Upload a video" })
  ).toHaveLength(1);
  expect(
    screen.queryByText("Your products will appear here")
  ).not.toBeInTheDocument();
});

test("a row whose video gave nothing offers another video, or to put it away", async () => {
  const unread = record({
    id: "import-2",
    status: "failed",
    stage: null,
    errorCode: "video_unreadable",
    productTotal: 0,
    photoTotal: 0,
    photoDone: 0,
    draftsLeft: false,
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [record(), unread] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: record(), products: [] });
  routes[`GET ${BASE}/products/imports/import-2`] = () =>
    respond(200, { import: unread, products: [] });
  renderPage();

  const rows = await screen.findByRole("list", { name: "Other videos" });
  const row = within(rows).getByRole("listitem");
  // Another video, chosen as the page's upload button chooses one.
  const picker = screen.getByLabelText("Upload a video");
  const pick = jest.spyOn(picker, "click").mockImplementation(() => {});
  fireEvent.click(within(row).getByRole("button", { name: "Upload it again" }));
  expect(pick).toHaveBeenCalledTimes(1);

  // Put away, it goes, and the keyboard's focus goes to the upload button.
  const dismiss = within(row).getByRole("button", { name: "Dismiss" });
  dismiss.focus();
  fireEvent.click(dismiss);
  await waitFor(() =>
    expect(
      screen.queryByRole("list", { name: "Other videos" })
    ).not.toBeInTheDocument()
  );
  expect(screen.getByRole("button", { name: "Upload a video" })).toHaveFocus();
  // The running import stays on the stage.
  expect(screen.getByText("Making photos")).toBeInTheDocument();
});

test("putting away the only video, which gave nothing, leaves the empty shelf", async () => {
  const empty = record({
    status: "ready",
    stage: null,
    productTotal: 0,
    photoTotal: 0,
    photoDone: 0,
    draftsLeft: false,
  });
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, { imports: [empty] });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, { import: empty, products: [] });
  renderPage();

  const rows = await screen.findByRole("list", { name: "Other videos" });
  fireEvent.click(within(rows).getByRole("button", { name: "Dismiss" }));

  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
});

test("says that a finished import found nothing; one that found products is their row", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, {
      imports: [
        record({ status: "ready", stage: null, photoDone: 3 }),
        record({
          id: "import-2",
          status: "ready",
          stage: null,
          productTotal: 0,
        }),
      ],
    });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: record({ status: "ready" }),
      products: [
        draft("p1", "Шежіре", { method: "restored", imageUrl: null }),
        draft("p2", "Медаль ілгіш", { method: "restored", imageUrl: null }),
      ],
    });
  routes[`GET ${BASE}/products/imports/import-2`] = () =>
    respond(200, { import: record({ status: "ready" }), products: [] });
  const { container } = renderPage();

  expect(
    await screen.findByText(/No products were found in this video/)
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      container.querySelectorAll('[data-row="import-1"] [data-product]')
    ).toHaveLength(2)
  );
  expect(container.querySelector('[data-row="import-2"]')).toBeNull();
});

test("opens the review straight from its address, and closing leaves the page", async () => {
  const importId = "651f1f77bcf86cd799439061";
  mockSearch = new URLSearchParams(`review=${importId}`);
  window.history.replaceState(
    null,
    "",
    `/panel/workspace-1/products?review=${importId}`
  );
  routes[`GET ${BASE}/products/imports/${importId}`] = () =>
    respond(200, {
      import: record({ id: importId, status: "ready", stage: null }),
      products: [draft("p1", "Шежіре", { method: "restored", imageUrl: null })],
    });
  renderPage();

  expect(
    await screen.findByRole("article", { name: "Шежіре" })
  ).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });

  expect(
    screen.queryByRole("heading", { name: "Check your products" })
  ).not.toBeInTheDocument();
  expect(window.location.search).toBe("");
});

test("the line under the title gives way to the review, and comes back after", async () => {
  const importId = "651f1f77bcf86cd799439061";
  const note = "New · built at the Meta AI Hackathon 2026";
  mockSearch = new URLSearchParams(`review=${importId}`);
  window.history.replaceState(
    null,
    "",
    `/panel/workspace-1/products?review=${importId}`
  );
  routes[`GET ${BASE}/products/imports/${importId}`] = () =>
    respond(200, {
      import: record({ id: importId, status: "ready", stage: null }),
      products: [draft("p1", "Шежіре", { method: "restored", imageUrl: null })],
    });
  renderPage();

  expect(
    await screen.findByRole("article", { name: "Шежіре" })
  ).toBeInTheDocument();
  expect(screen.queryByText(note)).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByText(note)).toBeInTheDocument();
});

test("an address with no import id in it opens no review", async () => {
  mockSearch = new URLSearchParams("review=../../admin");
  renderPage();

  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Check your products" })
  ).not.toBeInTheDocument();
});
