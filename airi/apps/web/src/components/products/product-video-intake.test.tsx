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
import { SWRConfig } from "swr";
import type { ProductVideoImportRecord } from "@/lib/products/types";
import { ImportProgress, UploadProgress } from "./product-video-intake";

// A video's import as the page shows it, apart from the page: the rows of
// other videos and the upload card. The page's own flows are in
// products-page-import.test.tsx.

// The page's realtime channel; these parts only read the import's address.
jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ channel: null, isConnected: false }),
}));

// The shelf is the page stream's; the stage only puts its products on it.
jest.mock("./product-shelf", () => ({
  ProductShelf: ({ products }: { products: Array<{ id: string }> }) => (
    <ul aria-label="Found shelf">
      {products.map(product => (
        <li key={product.id}>{product.id}</li>
      ))}
    </ul>
  ),
  ShelfHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

const BASE = "/api/workspaces/workspace-1";

const record = (
  overrides: Partial<ProductVideoImportRecord> = {}
): ProductVideoImportRecord => ({
  id: "import-1",
  status: "failed",
  stage: null,
  productTotal: 0,
  photoTotal: 0,
  photoDone: 0,
  errorCode: "video_unreadable",
  photosStopped: null,
  draftsLeft: false,
  presenter: null,
  createdAt: "2026-11-02T09:00:00.000Z",
  finishedAt: "2026-11-02T09:00:40.000Z",
  ...overrides,
});

// A draft the import found, with its photo made.
const found = (id: string) => ({
  id,
  name: id,
  price: 500,
  currency: "KZT",
  priceIsFrom: false,
  imageUrl: `https://storage.test/${id}.webp`,
  updatedAt: null,
  status: "draft",
  englishName: null,
  nameSource: "spoken",
  priceQuote: null,
  priceSource: "spoken",
  doubts: [],
  options: [
    {
      description: id,
      photoMethod: "restored",
      imageUrl: `https://storage.test/${id}.webp`,
      photoUrl: null,
      originalUrl: null,
      videoMomentSeconds: null,
      straightenedDegrees: 0,
      notes: [],
    },
  ],
  featuredOption: 0,
  clipUrl: null,
});

// What the import's own address answers: the row's record, and its products.
let detail: { import: ProductVideoImportRecord; products: unknown[] };
let requests = 0;
beforeEach(() => {
  detail = { import: record(), products: [] };
  requests = 0;
  global.fetch = (async (url: string) => {
    requests++;
    if (url !== `${BASE}/products/imports/import-1`)
      throw new Error(`Unexpected request: ${url}`);
    return {
      ok: true,
      status: 200,
      json: async () => detail,
      text: async () => "",
    };
  }) as unknown as typeof fetch;
});

function renderRow(
  entry: ProductVideoImportRecord,
  handlers: {
    onUploadAgain?: () => void;
    onDismiss?: (importId: string) => void;
  } = {}
) {
  detail = { ...detail, import: entry };
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ImportProgress
        workspaceId="workspace-1"
        record={entry}
        preview={null}
        variant="row"
        onReview={() => undefined}
        {...handlers}
      />
    </SWRConfig>
  );
}

/** Once the row's products have been asked for and answered. */
async function settled() {
  await waitFor(() => expect(requests).toBeGreaterThan(0));
  await act(async () => undefined);
}

test("a video that couldn't be read offers another, and can be put away", async () => {
  const onUploadAgain = jest.fn();
  const onDismiss = jest.fn();
  const { container } = renderRow(record(), { onUploadAgain, onDismiss });
  await settled();

  // What happened, marked in red ink, then what to do, as an alert.
  const alert = screen.getByRole("alert");
  expect(
    within(alert).getByText("This video couldn't be read.")
  ).toBeInTheDocument();
  expect(
    within(alert).getByText(
      "Try an MP4 or MOV straight from your phone's camera."
    )
  ).toBeInTheDocument();
  expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  // Its thumb: paper with a film mark, as it gave no picture.
  expect(container.querySelector('[data-film="none"]')).not.toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Upload it again" }));
  expect(onUploadAgain).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onDismiss).toHaveBeenCalledWith("import-1");
});

test("without the page's handlers, a row offers neither", async () => {
  renderRow(record());
  await settled();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("another video wouldn't help an AI allowance: only Dismiss", async () => {
  renderRow(record({ errorCode: "trial_ended" }), {
    onUploadAgain: jest.fn(),
    onDismiss: jest.fn(),
  });
  await settled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your free trial has ended, so this video couldn't be read."
  );
  expect(
    screen.queryByRole("button", { name: "Upload it again" })
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
});

test("a video with no products in it offers another, filmed again", async () => {
  renderRow(record({ status: "ready", errorCode: null }), {
    onUploadAgain: jest.fn(),
    onDismiss: jest.fn(),
  });
  await settled();
  expect(
    screen.getByText(/No products were found in this video/)
  ).toBeInTheDocument();
  // Nothing went wrong: it's said, not alerted.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Upload it again" })
  ).toBeInTheDocument();
});

test("products left to check: the check, never put away", async () => {
  detail.products = [found("cup"), found("doll")];
  renderRow(
    record({
      status: "ready",
      errorCode: null,
      productTotal: 2,
      photoTotal: 2,
      photoDone: 2,
      draftsLeft: true,
    }),
    { onUploadAgain: jest.fn(), onDismiss: jest.fn() }
  );
  expect(screen.getByText("2 products found")).toBeInTheDocument();
  expect(
    screen.getByText("Check them before they go on your shelf.")
  ).toBeInTheDocument();
  // Quiet in a row: the stage's check is the page's one push.
  expect(
    screen.getByRole("button", { name: "Check products" })
  ).toHaveAttribute("data-variant", "outline");
  expect(
    screen.queryByRole("button", { name: "Dismiss" })
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Upload it again" })
  ).not.toBeInTheDocument();
  // Its thumb: the newest photo made, once its products load.
  await waitFor(() =>
    expect(document.querySelector('[data-film="still"] img')).toHaveAttribute(
      "src",
      "https://storage.test/doll.webp"
    )
  );
  expect(
    screen.getByRole("button", { name: "Check products" })
  ).toBeInTheDocument();
});

test("a running row counts its photos in words, with a quiet line under it", async () => {
  const { container } = renderRow(
    record({
      status: "processing",
      stage: "cutting",
      errorCode: null,
      productTotal: 3,
      photoTotal: 4,
      photoDone: 1,
      finishedAt: null,
    })
  );
  await settled();
  expect(screen.getByText("Making photos")).toBeInTheDocument();
  expect(screen.getByText("1 of 4 photos are made.")).toBeInTheDocument();
  // The words say it; the line under the card only shows it.
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  const line = container.querySelector<HTMLElement>(
    '[data-variant="row"] > [aria-hidden] > span'
  );
  expect(line?.style.width).toBe("25%");
});

test("an upload that failed says why, and keeps its file's name", () => {
  const onRetry = jest.fn();
  const file = new File([new Uint8Array(3 * 1024 * 1024)], "shelf-today.mp4", {
    type: "video/mp4",
  });
  const { container } = render(
    <UploadProgress
      state={{
        phase: "failed",
        file,
        preview: "blob:shelf-today",
        code: "connection",
        assetId: null,
      }}
      onCancel={() => undefined}
      onRetry={onRetry}
    />
  );
  const stage = container.querySelector<HTMLElement>('[data-canvas="upload"]')!;
  // What happened as the stage's title; what to do under it.
  const alert = within(stage).getByRole("alert");
  expect(
    within(alert).getByRole("heading", {
      name: "The upload lost its connection.",
    })
  ).toBeInTheDocument();
  expect(
    within(alert).getByText("Check your internet and try again.")
  ).toBeInTheDocument();
  expect(within(stage).getByText("shelf-today.mp4")).toBeInTheDocument();
  expect(within(stage).getByText("· 3 MB")).toBeInTheDocument();
  // Where it stopped: before Airi could prepare it.
  const step = within(
    screen.getByRole("list", {
      name: "How Airi turns your video into products",
    })
  )
    .getAllByRole("listitem")
    .find(item => item.getAttribute("aria-current") === "step");
  expect(step).toHaveAttribute("data-state", "stopped");
  // Another try comes first, and has the keyboard's focus.
  const retry = screen.getByRole("button", { name: "Try again" });
  expect(retry).toHaveFocus();
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
});
