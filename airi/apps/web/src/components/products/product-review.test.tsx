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

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

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
  currency: "KZT",
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

/**
 * A click or tap into a field as Safari makes it: the field takes the focus,
 * and once the press ends, unless its mouseup's default was prevented, the
 * caret goes where it was pressed, whatever the focus selected.
 */
function safariPress(field: HTMLInputElement, caret: number) {
  fireEvent.pointerDown(field);
  fireEvent.mouseDown(field);
  act(() => field.focus());
  fireEvent.pointerUp(field);
  const placesCaret = fireEvent.mouseUp(field);
  fireEvent.click(field);
  if (placesCaret) field.setSelectionRange(caret, caret);
}

/**
 * Types a key into a field as jsdom tells React of it: jsdom has no
 * textInput event, so React reads what a keypress types from its `which`.
 * False when the field's own handlers prevented it.
 */
function typeKey(field: HTMLInputElement, key: string) {
  const event = new KeyboardEvent("keypress", {
    key,
    charCode: key.charCodeAt(0),
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "which", { value: key.charCodeAt(0) });
  let typed = true;
  act(() => {
    typed = field.dispatchEvent(event);
  });
  return typed;
}

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
    // What was added can go to WhatsApp next.
    expect(screen.getByText("Share them on WhatsApp")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Make a carousel" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Make an order form" })
    ).toBeInTheDocument();
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
    // The price's currency, beside it, to keep or change.
    expect(
      within(card).getByRole("textbox", { name: "Currency code" })
    ).toHaveValue("KZT");
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
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 16900, currency: "KZT" }])
    );
    expect(reviewed()).toEqual([]);
    expect(topCard()).toHaveAccessibleName("Шежіре");
  });

  it("fixes a price said in another currency in that currency, with its cents", async () => {
    const otherCurrency =
      "This price is in USD, but other prices in the video are in KZT.";
    serveImport([
      product("p1", "Phone stand", {
        price: 10,
        currency: "USD",
        doubts: [{ about: "price", text: otherCurrency }],
      }),
    ]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Phone stand" });

    const price = within(card).getByRole("button", {
      name: /^Change the price: 10\sUSD$/,
    });
    expect(price).toHaveClass("text-destructive");
    fireEvent.click(price);
    const input = within(card).getByRole("textbox", { name: "Price in USD" });
    expect(input).toHaveValue("10");
    // On a phone, a keypad with a decimal mark for the amount.
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(
      within(card).getByRole("textbox", { name: "Currency code" })
    ).toHaveValue("USD");
    fireEvent.change(input, { target: { value: "12,50" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      within(card).getByRole("button", {
        name: /^Change the price: 12\.50\sUSD$/,
      })
    ).not.toHaveClass("text-destructive");
    expect(within(card).queryByText(otherCurrency)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 12.5, currency: "USD" }])
    );
  });

  it("asks for a price's currency when none was said, then opens the next price without one in it", async () => {
    const noCurrency = "No currency was said or shown for this price.";
    serveImport([
      product("p1", "Mug", {
        price: 20,
        currency: null,
        doubts: [{ about: "price", text: noCurrency }],
      }),
      product("p2", "Plate", {
        price: 15,
        currency: null,
        doubts: [{ about: "price", text: noCurrency }],
      }),
    ]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Mug" });

    // No currency is assumed: the price stands bare, and in red.
    const price = within(card).getByRole("button", {
      name: /^Change the price: 20$/,
    });
    expect(price).toHaveClass("text-destructive");
    fireEvent.click(price);
    const input = within(card).getByRole("textbox", { name: "Price" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });
    expect(code).toHaveValue("");
    expect(code).toHaveAttribute("autocapitalize", "characters");
    fireEvent.keyDown(input, { key: "Enter" });

    // Not saved: it says why, and the code takes the focus.
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "Type the currency as a 3-letter code, like USD."
    );
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveAccessibleDescription(
      "Type the currency as a 3-letter code, like USD."
    );
    expect(code).toHaveFocus();
    expect(input).toBeInTheDocument();
    expect(patched("p1")).toEqual([]);

    fireEvent.change(code, { target: { value: "usd" } });
    expect(code).toHaveValue("USD");
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.keyDown(code, { key: "Enter" });

    expect(
      within(card).getByRole("button", { name: /^Change the price: 20\sUSD$/ })
    ).not.toHaveClass("text-destructive");
    expect(within(card).queryByText(noCurrency)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 20, currency: "USD" }])
    );

    fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
    const next = screen.getByRole("article", { name: "Plate" });
    fireEvent.click(
      within(next).getByRole("button", { name: /^Change the price: 15$/ })
    );
    expect(
      within(next).getByRole("textbox", { name: "Currency code" })
    ).toHaveValue("USD");
  });

  it("keeps a price it can't read open with why, moves between its fields, and Escape leaves it", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });
    const openPrice = () =>
      fireEvent.click(
        within(card).getByRole("button", { name: /Change the price/ })
      );

    openPrice();
    let input = within(card).getByRole("textbox", { name: "Price in tenge" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });
    fireEvent.change(input, { target: { value: "1.5k" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(within(card).getByRole("alert")).toHaveTextContent(
      "Type the price as a number, like 4.99."
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(code).not.toHaveAttribute("aria-invalid");
    // Tab from the amount to the code: still open.
    fireEvent.blur(input, { relatedTarget: code });
    expect(input).toBeInTheDocument();
    expect(code).toBeInTheDocument();
    fireEvent.keyDown(code, { key: "Escape" });

    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(patched("p1")).toEqual([]);

    // A price typed with its sign is still a number.
    openPrice();
    input = within(card).getByRole("textbox", { name: "Price in tenge" });
    fireEvent.change(input, { target: { value: "16 900 ₸" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 16900, currency: "KZT" }])
    );
  });

  it("a click or tap into a prefilled field selects its text on Safari too, so typing replaces it", async () => {
    serveImport([
      product("p1", "Phone stand", {
        price: 10,
        currency: "USD",
        doubts: [
          {
            about: "price",
            text: "This price is in USD, but other prices in the video are in KZT.",
          },
        ],
      }),
    ]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Phone stand" });
    fireEvent.click(
      within(card).getByRole("button", { name: /Change the price/ })
    );
    const amount = within(card).getByRole<HTMLInputElement>("textbox", {
      name: "Price in USD",
    });
    const code = within(card).getByRole<HTMLInputElement>("textbox", {
      name: "Currency code",
    });

    // Safari, on every iPhone too, put a caret in the full code, which then
    // took no letter.
    safariPress(code, 2);
    expect([code.selectionStart, code.selectionEnd]).toEqual([0, 3]);
    fireEvent.change(code, { target: { value: "kzt" } });
    expect(code).toHaveValue("KZT");

    // Back in the amount, typing replaced "10" rather than adding to it.
    safariPress(amount, 1);
    expect([amount.selectionStart, amount.selectionEnd]).toEqual([0, 2]);
    fireEvent.change(amount, { target: { value: "12.50" } });

    fireEvent.keyDown(amount, { key: "Enter" });
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 12.5, currency: "KZT" }])
    );
  });

  it("a letter typed into a full currency code with a caret in it starts the code anew", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });
    fireEvent.click(
      within(card).getByRole("button", { name: /Change the price/ })
    );
    const code = within(card).getByRole<HTMLInputElement>("textbox", {
      name: "Currency code",
    });
    // A second press on the focused code leaves a caret in it.
    safariPress(code, 1);
    safariPress(code, 1);
    expect([code.selectionStart, code.selectionEnd]).toEqual([1, 1]);

    expect(typeKey(code, "u")).toBe(false);
    expect(code).toHaveValue("U");
    fireEvent.change(code, { target: { value: "Us" } });
    // Not full, it takes letters as typed.
    expect(typeKey(code, "d")).toBe(true);
    fireEvent.change(code, { target: { value: "Usd" } });
    expect(code).toHaveValue("USD");

    fireEvent.keyDown(code, { key: "Enter" });
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 15500, currency: "USD" }])
    );
  });

  it("leaving the name for elsewhere saves it", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.click(
      within(card).getByRole("button", { name: /Change the name/ })
    );
    const input = within(card).getByRole("textbox", {
      name: "Change the name",
    });
    fireEvent.change(input, { target: { value: "Шежіре ағашы" } });
    // A tap outside the card, where nothing takes the focus.
    fireEvent.blur(input, { relatedTarget: null });

    expect(input).not.toBeInTheDocument();
    expect(topCard()).toHaveAccessibleName("Шежіре ағашы");
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ name: "Шежіре ағашы" }])
    );
  });

  it("leaving the price for elsewhere saves it with its currency, or keeps a price it can't read open with why", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });
    const elsewhere = screen.getByRole("button", {
      name: "Play your voice on each card",
    });
    const openPrice = () =>
      fireEvent.click(
        within(card).getByRole("button", { name: /Change the price/ })
      );

    openPrice();
    let input = within(card).getByRole("textbox", { name: "Price in tenge" });
    fireEvent.change(input, { target: { value: "1.5k" } });
    fireEvent.blur(input, { relatedTarget: elsewhere });
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "Type the price as a number, like 4.99."
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveValue("1.5k");
    expect(patched("p1")).toEqual([]);
    // Escape still drops it.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    expect(patched("p1")).toEqual([]);

    openPrice();
    input = within(card).getByRole("textbox", { name: "Price in tenge" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });
    fireEvent.change(input, { target: { value: "17 500" } });
    fireEvent.change(code, { target: { value: "eur" } });
    fireEvent.blur(code, { relatedTarget: elsewhere });

    expect(
      within(card).getByRole("button", {
        name: /^Change the price: from\s17\s500\sEUR$/,
      })
    ).not.toHaveClass("text-destructive");
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 17500, currency: "EUR" }])
    );
  });

  it("leaving a price without its currency keeps it open with why, without taking the focus back", async () => {
    const noCurrency = "No currency was said or shown for this price.";
    serveImport([
      product("p1", "Mug", {
        price: 20,
        currency: null,
        doubts: [{ about: "price", text: noCurrency }],
      }),
    ]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Mug" });
    const elsewhere = screen.getByRole("button", {
      name: "Play your voice on each card",
    });
    fireEvent.click(
      within(card).getByRole("button", { name: /^Change the price: 20$/ })
    );
    const input = within(card).getByRole("textbox", { name: "Price" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });
    expect(input).toHaveFocus();

    // A phone's decimal keypad has no Enter, so the owner taps elsewhere.
    fireEvent.change(input, { target: { value: "25" } });
    act(() => elsewhere.focus());

    expect(within(card).getByRole("alert")).toHaveTextContent(
      "Type the currency as a 3-letter code, like USD."
    );
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveAccessibleDescription(
      "Type the currency as a 3-letter code, like USD."
    );
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).toHaveValue("25");
    // No trap: the focus stays where the owner put it.
    expect(elsewhere).toHaveFocus();
    expect(patched("p1")).toEqual([]);

    // Back in the editor, the code is typed and Enter saves both.
    act(() => code.focus());
    fireEvent.change(code, { target: { value: "usd" } });
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.keyDown(code, { key: "Enter" });

    expect(
      within(card).getByRole("button", { name: /^Change the price: 25\sUSD$/ })
    ).not.toHaveClass("text-destructive");
    expect(within(card).queryByText(noCurrency)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 25, currency: "USD" }])
    );
  });

  it("a refused price left open with the focus elsewhere: Escape drops it, not the review, and undo waits", async () => {
    const noCurrency = "No currency was said or shown for this price.";
    serveImport([
      product("p0", "Cup", { price: 5, currency: "USD" }),
      product("p1", "Mug", {
        price: 20,
        currency: null,
        doubts: [{ about: "price", text: noCurrency }],
      }),
    ]);
    const onClose = renderReview();
    await screen.findByRole("article", { name: "Cup" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const card = screen.getByRole("article", { name: "Mug" });
    await waitFor(() =>
      expect(reviewed()).toEqual([{ productIds: ["p0"], status: "published" }])
    );

    fireEvent.click(
      within(card).getByRole("button", { name: /^Change the price: 20$/ })
    );
    fireEvent.change(within(card).getByRole("textbox", { name: "Price" }), {
      target: { value: "25" },
    });
    // A click on the photo, as on a desktop: the review itself takes the focus.
    const review = document.querySelector<HTMLElement>(
      "[aria-labelledby='product-review-title']"
    )!;
    act(() => review.focus());
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "Type the currency as a 3-letter code, like USD."
    );
    expect(review).toHaveFocus();

    // The review's undo keys wait: Cup stays on the shelf, the edit open.
    fireEvent.keyDown(review, { key: "Backspace" });
    fireEvent.keyDown(review, { key: "z", ctrlKey: true });
    expect(topCard()).toHaveAccessibleName("Mug");
    expect(within(card).getByRole("textbox", { name: "Price" })).toHaveValue(
      "25"
    );

    // Escape drops the edit and leaves the review open, the focus in place.
    fireEvent.keyDown(review, { key: "Escape" });
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /^Change the price: 20$/ })
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(review).toHaveFocus();

    // Also from another control the focus went to.
    fireEvent.click(
      within(card).getByRole("button", { name: /^Change the price: 20$/ })
    );
    const elsewhere = screen.getByRole("button", {
      name: "Play your voice on each card",
    });
    act(() => elsewhere.focus());
    expect(within(card).getByRole("alert")).toBeInTheDocument();
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(patched("p1")).toEqual([]);
    expect(reviewed()).toEqual([{ productIds: ["p0"], status: "published" }]);

    // With no edit open, the review's keys are back.
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says why a price can't be saved the way its currency writes prices", async () => {
    serveImport([product("p1", "Tea set", { price: 1500, currency: "JPY" })]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Tea set" });
    fireEvent.click(
      within(card).getByRole("button", { name: /Change the price/ })
    );
    const input = within(card).getByRole("textbox", { name: "Price in JPY" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });
    const refused = (field: HTMLElement, value: string) => {
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: "Enter" });
      return within(card).getByRole("alert");
    };

    // Yen have no cents, and the example says so, however many decimals
    // were typed.
    for (const amount of [
      "1500.50",
      "4.99",
      "1,5",
      "4.9999",
      "1500.1234",
      "４．９９９９",
    ])
      expect(refused(input, amount)).toHaveTextContent(
        "JPY prices have no cents. Type a whole number, like 1500."
      );
    expect(refused(input, "1.5k")).toHaveTextContent(
      "Type the price as a number, like 1500."
    );
    expect(input).toHaveAttribute("aria-invalid", "true");

    // Three letters, but no code a price may be in.
    fireEvent.change(input, { target: { value: "1500" } });
    for (const letters of ["rur", "ＲＵＲ"])
      expect(refused(code, letters)).toHaveTextContent(
        "RUR isn't a currency code we know. Try one like USD."
      );
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(refused(code, "r")).toHaveTextContent(
      "Type the currency as a 3-letter code, like USD."
    );

    // Dinars have three decimals, and so has their example.
    fireEvent.change(code, { target: { value: "kwd" } });
    expect(refused(input, "1.5k")).toHaveTextContent(
      "Type the price as a number, like 1.250."
    );
    expect(refused(input, "1.2345")).toHaveTextContent(
      "KWD prices have at most 3 decimals. Type one like 1.250."
    );
    // Dollars have two.
    fireEvent.change(code, { target: { value: "usd" } });
    for (const amount of ["1234.567", "12.3456", "1,234.5678", "4,9999 $"])
      expect(refused(input, amount)).toHaveTextContent(
        "USD prices have at most 2 decimals. Type one like 4.99."
      );
    // Its last group isn't decimals when its mark comes twice.
    for (const amount of ["1.5k", "1.234.5678"])
      expect(refused(input, amount)).toHaveTextContent(
        "Type the price as a number, like 4.99."
      );
    expect(patched("p1")).toEqual([]);
  });

  it("keeps the stored price when only its code changes, and refuses it in a code with fewer decimals", async () => {
    serveImport([product("p1", "Dates", { price: 1.255, currency: "KWD" })]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Dates" });
    fireEvent.click(
      within(card).getByRole("button", {
        name: /^Change the price: 1\.255\sKWD$/,
      })
    );
    const input = within(card).getByRole("textbox", { name: "Price in KWD" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });
    expect(input).toHaveValue("1.255");
    const enterCode = (value: string) => {
      fireEvent.change(code, { target: { value } });
      fireEvent.keyDown(code, { key: "Enter" });
    };

    // Read again as typed in dollars, "1.255" would be 1255 of them.
    enterCode("usd");
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "USD prices have at most 2 decimals. Type one like 4.99."
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    enterCode("jpy");
    expect(within(card).getByRole("alert")).toHaveTextContent(
      "JPY prices have no cents. Type a whole number, like 1500."
    );
    expect(patched("p1")).toEqual([]);

    // In its own currency, it's confirmed as stored.
    enterCode("kwd");
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ price: 1.255, currency: "KWD" }])
    );
  });

  it("names the amount by the currency code typed beside it", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });
    fireEvent.click(
      within(card).getByRole("button", { name: /Change the price/ })
    );
    const input = within(card).getByRole("textbox", { name: "Price in tenge" });
    const code = within(card).getByRole("textbox", { name: "Currency code" });

    fireEvent.change(code, { target: { value: "usd" } });
    expect(input).toHaveAccessibleName("Price in USD");
    fireEvent.change(code, { target: { value: "" } });
    expect(input).toHaveAccessibleName("Price");
    fireEvent.change(code, { target: { value: "kzt" } });
    expect(input).toHaveAccessibleName("Price in tenge");
  });

  it("rings the field with the focus more strongly, and the one to fix in red", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });
    fireEvent.click(
      within(card).getByRole("button", { name: /Change the price/ })
    );

    // jsdom paints nothing, so these check the design system's classes that do.
    const fields = within(card).getAllByRole("textbox");
    expect(fields).toHaveLength(2);
    for (const field of fields)
      expect(field).toHaveClass(
        "ring-ring/40",
        "focus-visible:ring-[3px]",
        "focus-visible:ring-ring/70",
        "aria-invalid:ring-destructive"
      );
  });

  it("sets a long price a step smaller, so it fits a phone's card, and breaks it only after 'from'", async () => {
    serveImport([
      product("p1", "Wall clock", {
        price: 1_250_000_000,
        currency: "IRR",
        priceIsFrom: true,
      }),
      product("p2", "Mirror", {
        price: 1e12,
        currency: "IRR",
        priceIsFrom: true,
      }),
    ]);
    renderReview();
    const card = await screen.findByRole("article", { name: "Wall clock" });

    const price = within(card).getByRole("button", {
      name: /^Change the price: from\s1\s250\s000\s000\sIRR$/,
    });
    expect(price).toHaveClass("text-[22px]", "max-w-full");
    expect(price).not.toHaveClass("text-[28px]");
    const breaks = price.querySelectorAll("wbr");
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.previousSibling?.textContent).toBe("from ");
    // The card behind, priced at the cap, is a step smaller still.
    expect(
      screen.getByText("from 1 000 000 000 000 IRR".replace(/ /g, " "), {
        normalizer: text => text,
      })
    ).toHaveClass("text-[18px]");
    // The editor's amount is bare digits, which fit at full size.
    fireEvent.click(price);
    expect(
      within(card).getByRole("textbox", { name: "Price in IRR" })
    ).toHaveClass("text-[28px]");
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

  it("a name written right to left reads in its own direction, on the cards and as it's changed", async () => {
    serveImport([product("p1", "كوب القهوة"), product("p2", "طبق التقديم")]);
    renderReview();
    const card = await screen.findByRole("article", { name: "كوب القهوة" });

    const button = within(card).getByRole("button", {
      name: /Change the name/,
    });
    expect(within(button).getByText("كوب القهوة")).toHaveAttribute(
      "dir",
      "auto"
    );
    // The card waiting behind it.
    expect(screen.getByText("طبق التقديم")).toHaveAttribute("dir", "auto");
    fireEvent.click(button);
    expect(
      within(card).getByRole("textbox", { name: "Change the name" })
    ).toHaveAttribute("dir", "auto");
  });

  it("an Enter that picks an IME candidate keeps the field open", async () => {
    renderReview();
    const card = await screen.findByRole("article", { name: "Шежіре" });

    fireEvent.click(
      within(card).getByRole("button", { name: /Change the name/ })
    );
    const input = within(card).getByRole("textbox", {
      name: "Change the name",
    });
    fireEvent.change(input, { target: { value: "Шежіре ағашы" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(input).toBeInTheDocument();
    expect(patched("p1")).toEqual([]);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(patched("p1")).toEqual([{ name: "Шежіре ағашы" }])
    );
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
