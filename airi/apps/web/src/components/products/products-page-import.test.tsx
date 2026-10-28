/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { ProductsPage } from "./products-page";
import type { RealtimeEventEnvelope } from "@icecore/shared/types/realtime";

// Adding products from a video: the upload from this device, then the import
// job's progress and the products it finds.

type Handler = (event: RealtimeEventEnvelope) => void;
const realtimeHandlers = new Set<Handler>();
jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({
    channel: {
      bind: (_name: string, handler: Handler) => realtimeHandlers.add(handler),
      unbind: (_name: string, handler: Handler) =>
        realtimeHandlers.delete(handler),
    },
    isConnected: false,
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
  presenter: null,
  createdAt: "2026-10-28T09:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

const draft = (
  id: string,
  name: string,
  photo: { method: string; imageUrl: string | null }
) => ({
  id,
  name,
  price: 15500,
  priceIsFrom: true,
  imageUrl: photo.imageUrl,
  updatedAt: null,
  status: "draft",
  englishName: null,
  nameSource: "spoken",
  priceQuote: null,
  priceSource: "spoken",
  doubts: [],
  options: [
    {
      description: name,
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

beforeEach(() => {
  calls.length = 0;
  realtimeHandlers.clear();
  mockSearch = null;
  window.history.replaceState(null, "", "/panel/workspace-1/products");
  mockCheck.mockReset().mockResolvedValue(null);
  routes = {
    [`GET ${BASE}/products`]: () => respond(200, { products: [] }),
    [`GET ${BASE}/products/imports`]: () => respond(200, { imports: [] }),
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

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
    </SWRConfig>
  );
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
  expect(screen.getByText("MP4 or MOV, up to 5 minutes")).toBeInTheDocument();
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

  expect(await screen.findByText("Making photos")).toBeInTheDocument();
  expect(screen.getByText("1 of 3")).toBeInTheDocument();
  // Cutting runs from 22% to 100%: one photo of three is 48%.
  expect(
    screen.getByRole("progressbar", { name: "Making photos" })
  ).toHaveAttribute("aria-valuenow", "48");

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
  expect(items[1]!.querySelector(".animate-pulse")).not.toBeNull();
  expect(within(found).getByText("Медаль ілгіш")).toBeInTheDocument();
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

test("says what a finished import found, or that it found nothing", async () => {
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
  renderPage();

  expect(
    await screen.findByText(
      "2 products found. Check them before they go on your shelf."
    )
  ).toBeInTheDocument();
  expect(
    screen.getByText(/No products were found in this video/)
  ).toBeInTheDocument();
});

test("a finished import offers its check, which opens in place and Back closes", async () => {
  routes[`GET ${BASE}/products/imports`] = () =>
    respond(200, {
      imports: [
        record({ status: "ready", stage: null, photoDone: 3, photoTotal: 3 }),
      ],
    });
  routes[`GET ${BASE}/products/imports/import-1`] = () =>
    respond(200, {
      import: record({ status: "ready", stage: null }),
      products: [
        draft("p1", "Шежіре", { method: "restored", imageUrl: null }),
        draft("p2", "Медаль ілгіш", { method: "restored", imageUrl: null }),
      ],
    });
  renderPage();

  fireEvent.click(
    await screen.findByRole("button", { name: "Check products" })
  );

  expect(
    screen.getByRole("heading", { name: "Check your products" })
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("article", { name: "Шежіре" })
  ).toBeInTheDocument();
  expect(window.location.search).toBe("?review=import-1");
  // The page's own controls wait behind the review.
  expect(
    screen.queryByRole("button", { name: "Upload a video" })
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Products" }));
  expect(
    screen.queryByRole("heading", { name: "Check your products" })
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Check products" })
  ).toBeInTheDocument();
  await waitFor(() => expect(window.location.search).toBe(""));
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
