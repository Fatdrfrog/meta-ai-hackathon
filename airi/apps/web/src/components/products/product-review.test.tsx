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
import { ProductReview } from "./product-review";

// Checking what a video found, one card at a time: deciding, undoing,
// accepting the rest, and fixing a product on its card.

const BASE = "/api/workspaces/workspace-1";
const IMPORT_URL = `${BASE}/products/imports/import-1`;
type Route = (init?: RequestInit) => Promise<unknown> | unknown;
let routes: Record<string, Route>;
const calls: Array<{ url: string; init?: RequestInit }> = [];

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const option = (description: string, file: string) => ({
  description,
  photoMethod: "restored",
  imageUrl: `https://cdn.test/${file}.webp`,
  photoUrl: `https://cdn.test/${file}.png`,
  originalUrl: `https://cdn.test/${file}.jpg`,
  videoMomentSeconds: 4.2,
  straightenedDegrees: 0,
  notes: [] as string[],
});

const product = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {}
) => ({
  id,
  name,
  price: 15500,
  priceIsFrom: false,
  imageUrl: `https://cdn.test/${id}.webp`,
  updatedAt: null,
  status: "draft",
  englishName: null,
  nameSource: "spoken",
  priceQuote: null,
  priceSource: "spoken",
  doubts: [] as Array<{ about: string; text: string }>,
  options: [option(name, id)],
  featuredOption: 0,
  clipUrl: null as string | null,
  ...overrides,
});

const PRODUCTS = [
  product("p1", "Шежіре", {
    priceIsFrom: true,
    doubts: [
      {
        about: "price",
        text: "This price was read from text in the video, not said aloud.",
      },
      { about: "product", text: "The name said doesn't match the box." },
    ],
    options: [
      option("round panel", "p1-round"),
      option("star plaque", "p1-star"),
    ],
    clipUrl: "https://cdn.test/p1-clip.mp4",
  }),
  product("p2", "Медаль ілгіш", { price: 16900 }),
  product("p3", "Этно сағат", { price: null }),
];

function serveImport(products: unknown[] = PRODUCTS) {
  routes[`GET ${IMPORT_URL}`] = () =>
    respond(200, {
      import: {
        id: "import-1",
        status: "ready",
        stage: null,
        productTotal: products.length,
        photoTotal: products.length,
        photoDone: products.length,
        errorCode: null,
        presenter: null,
        createdAt: null,
        finishedAt: null,
      },
      products,
    });
}

const reviewed = () =>
  calls
    .filter(call => call.url === `${IMPORT_URL}/review`)
    .map(call => JSON.parse(String(call.init?.body)));

const patched = (productId: string) =>
  calls
    .filter(
      call =>
        call.url === `${BASE}/products/${productId}` &&
        call.init?.method === "PATCH"
    )
    .map(call => JSON.parse(String(call.init?.body)));

// jsdom has no PointerEvent; a mouse event with a pointer id does.
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

beforeAll(() => {
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: jest.fn(() => Promise.resolve()),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: jest.fn(),
  });
});

beforeEach(() => {
  calls.length = 0;
  routes = {
    [`POST ${IMPORT_URL}/review`]: init =>
      respond(200, {
        changed: JSON.parse(String(init?.body)).productIds.length,
      }),
    [`PATCH ${BASE}/products/p1`]: init =>
      respond(200, {
        product: { ...PRODUCTS[0], ...JSON.parse(String(init?.body)) },
      }),
  };
  serveImport();
  global.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route(init);
  }) as unknown as typeof fetch;
});

function renderReview(onClose = jest.fn()) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductReview
        workspaceId="workspace-1"
        importId="import-1"
        onClose={onClose}
      />
    </SWRConfig>
  );
  return onClose;
}

/** The card on top of the stack, the one being checked. */
const topCard = () => screen.getByRole("article");

describe("ProductReview", () => {
  it("shows the first product with its voice clip, and what is unsure in red with why", async () => {
    renderReview();

    const card = await screen.findByRole("article", { name: "Шежіре" });
    // Prices are spaced with no-break spaces.
    const price = within(card).getByRole("button", {
      name: /^Change the price: from\s15\s500\s₸$/,
    });
    expect(price).toHaveClass("text-destructive");
    const reason = within(card).getByText(
      "This price was read from text in the video, not said aloud."
    );
    expect(reason).toHaveClass("text-destructive");
    expect(
      within(card).getByText("The name said doesn't match the box.")
    ).toHaveClass("text-destructive");
    // The clip plays as the card comes up.
    expect(
      within(card).getByRole("button", { name: /Hear what you said|Pause/ })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
    );
    expect(
      screen.getByRole("button", { name: "Accept all (3)" })
    ).toBeInTheDocument();
  });

  it("→ adds the top product and ← skips the next, saved in that order", async () => {
    renderReview();
    await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(topCard()).toHaveAccessibleName("Медаль ілгіш");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(topCard()).toHaveAccessibleName("Этно сағат");
    expect(
      screen.getByRole("button", { name: "Accept all (1)" })
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(reviewed()).toEqual([
        { productIds: ["p1"], status: "published" },
        { productIds: ["p2"], status: "rejected" },
      ])
    );
  });

  it("the buttons decide too, and undo brings the last product back", async () => {
    renderReview();
    await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
    expect(topCard()).toHaveAccessibleName("Медаль ілгіш");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(topCard()).toHaveAccessibleName("Шежіре");

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(topCard()).toHaveAccessibleName("Медаль ілгіш");
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(topCard()).toHaveAccessibleName("Шежіре");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    await waitFor(() =>
      expect(reviewed()).toEqual([
        { productIds: ["p1"], status: "published" },
        { productIds: ["p1"], status: "draft" },
        { productIds: ["p1"], status: "rejected" },
        { productIds: ["p1"], status: "draft" },
      ])
    );
  });

  it("Accept all adds the rest at once and says what is on the shelf", async () => {
    const onClose = renderReview();
    await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept all (2)" }));

    expect(
      await screen.findByText("2 products are on your shelf.")
    ).toBeInTheDocument();
    expect(screen.getByText("1 skipped.")).toBeInTheDocument();
    await waitFor(() =>
      expect(reviewed()).toEqual([
        { productIds: ["p1"], status: "rejected" },
        { productIds: ["p2", "p3"], status: "published" },
      ])
    );
    const back = screen.getByRole("button", { name: "Back to products" });
    expect(back).toHaveFocus();
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
  });

  it("a decision that can't be saved comes back, and says so", async () => {
    routes[`POST ${IMPORT_URL}/review`] = () => respond(503, {});
    renderReview();
    await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That change couldn't be saved, so it was undone. Try again."
    );
    expect(topCard()).toHaveAccessibleName("Шежіре");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("tapping the price fixes it, which settles the doubts about it", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.click(
      within(card).getByRole("button", { name: /Change the price/ })
    );
    const input = within(card).getByRole("textbox", { name: "Price in tenge" });
    // Typing in the field doesn't decide the card.
    fireEvent.keyDown(input, { key: "ArrowRight" });
    fireEvent.change(input, { target: { value: "16 900" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const price = within(card).getByRole("button", {
      name: /^Change the price: from\s16\s900\s₸$/,
    });
    expect(price).not.toHaveClass("text-destructive");
    expect(price).toHaveFocus();
    expect(
      within(card).queryByText(
        "This price was read from text in the video, not said aloud."
      )
    ).not.toBeInTheDocument();
    // Not about the price, so it stays.
    expect(
      within(card).getByText("The name said doesn't match the box.")
    ).toBeInTheDocument();
    await waitFor(() => expect(patched("p1")).toEqual([{ price: 16900 }]));
    expect(reviewed()).toEqual([]);
    expect(topCard()).toHaveAccessibleName("Шежіре");
  });

  it("Escape leaves a field unchanged without closing the review", async () => {
    const onClose = renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.click(
      within(card).getByRole("button", { name: /Change the name/ })
    );
    const input = within(card).getByRole("textbox", {
      name: "Change the name",
    });
    fireEvent.change(input, { target: { value: "Шежіре ағашы" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(topCard()).toHaveAccessibleName("Шежіре");
    expect(onClose).not.toHaveBeenCalled();
    expect(patched("p1")).toEqual([]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the photo as filmed, and lets the owner choose the option the shelf shows", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });
    const photo = () => card.querySelector("img") as HTMLImageElement;
    expect(photo().src).toBe("https://cdn.test/p1-round.png");

    fireEvent.click(within(card).getByRole("button", { name: "Original" }));
    expect(photo().src).toBe("https://cdn.test/p1-round.jpg");
    fireEvent.click(within(card).getByRole("button", { name: "Polished" }));

    fireEvent.click(
      within(card).getByRole("button", {
        name: "Show star plaque on your shelf",
      })
    );
    expect(photo().src).toBe("https://cdn.test/p1-star.png");
    expect(
      within(card).getByRole("button", {
        name: "Show star plaque on your shelf",
      })
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(patched("p1")).toEqual([{ featuredOption: 1 }]));
  });

  it("a card dragged far enough leaves; let go sooner, it stays", async () => {
    renderReview();
    await screen.findByRole("article", { name: "Шежіре" });
    // A drag of `to` px over a second: too slow to count as a flick.
    const drag = (to: number) => {
      const card = topCard();
      const pointer = (type: string, x: number, at: number) => {
        const event = new TestPointerEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: 200,
          button: 0,
        });
        Object.defineProperty(event, "timeStamp", { value: at });
        card.dispatchEvent(event);
      };
      act(() => {
        pointer("pointerdown", 100, 1);
        pointer("pointermove", 100 + to / 2, 500);
        pointer("pointerup", 100 + to, 1001);
      });
    };

    // 60 px is under a third of the card: it settles back.
    drag(60);
    expect(topCard()).toHaveAccessibleName("Шежіре");

    drag(-200);
    expect(topCard()).toHaveAccessibleName("Медаль ілгіш");
    await waitFor(() =>
      expect(reviewed()).toEqual([{ productIds: ["p1"], status: "rejected" }])
    );
  });

  it("says so when every product was already checked", async () => {
    serveImport([
      product("p1", "Шежіре", { status: "published" }),
      product("p2", "Медаль ілгіш", { status: "rejected" }),
    ]);
    renderReview();

    expect(
      await screen.findByText("1 product is on your shelf.")
    ).toBeInTheDocument();
    expect(screen.getByText("1 skipped.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Accept all/ })
    ).not.toBeInTheDocument();
  });

  it("offers to try again when the products can't be loaded", async () => {
    routes[`GET ${IMPORT_URL}`] = () => respond(503, {});
    renderReview();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "These products couldn't be loaded."
    );
    serveImport();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("article", { name: "Шежіре" })
    ).toBeInTheDocument();
  });
});
