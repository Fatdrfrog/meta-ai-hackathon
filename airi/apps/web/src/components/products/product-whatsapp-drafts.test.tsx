/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { WhatsAppDrafts } from "./product-whatsapp-drafts";

// What the owner makes on WhatsApp after a review: a carousel left for the
// template editor, and an order form saved as a draft Flow.

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const BASE = "/api/workspaces/workspace-1/products/imports/import-1";
const DRAFT_KEY = "airi.templateEditorDraft.v1:workspace-1:new";
let routes: Record<string, () => unknown>;

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const added = (count: number, withPhotos = count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Шежіре ${index + 1}`,
    price: 15500,
    priceIsFrom: false,
    imageUrl: index < withPhotos ? `https://cdn.test/p${index + 1}.webp` : null,
    updatedAt: null,
    status: "published" as const,
    englishName: null,
    nameSource: "spoken" as const,
    priceQuote: null,
    priceSource: "spoken" as const,
    doubts: [],
    options: [],
    featuredOption: 0,
    clipUrl: null,
  }));

const carousel = {
  name: "products_20261028_1432",
  language: "kk",
  bodyText: "Біздің тауарлар. Ұнағанын таңдап, тапсырыс беріңіз.",
  cards: [1, 2].map(index => ({
    productId: `p${index}`,
    imageUrl: `https://cdn.test/business-media/product-p${index}.jpg`,
    bodyText: `Шежіре ${index}\n15 500 ₸`,
    buttonText: "Тапсырыс беру",
  })),
  leftOut: 0,
};

beforeEach(() => {
  mockPush.mockReset();
  window.localStorage.clear();
  routes = {
    [`POST ${BASE}/carousel`]: () => respond(200, { draft: carousel }),
    [`POST ${BASE}/order-form`]: () =>
      respond(201, {
        flow: { id: "flow-1", name: "Order form 2026-10-28 14:32" },
        leftOut: 0,
      }),
  };
  global.fetch = (async (url: string, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${url}`];
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return route();
  }) as unknown as typeof fetch;
});

function renderDrafts(products = added(3)) {
  render(
    <WhatsAppDrafts
      workspaceId="workspace-1"
      importId="import-1"
      added={products}
    />
  );
}

describe("WhatsAppDrafts", () => {
  it("leaves the carousel for the template editor and opens it", async () => {
    renderDrafts();

    fireEvent.click(screen.getByRole("button", { name: "Make a carousel" }));

    expect(
      await screen.findByRole("button", { name: "Opening Templates…" })
    ).toBeDisabled();
    expect(mockPush).toHaveBeenCalledWith(
      "/panel/w/workspace-1/messengers/whatsapp-templates?create=1"
    );
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_KEY)!);
    expect(stored.values).toMatchObject({
      name: "products_20261028_1432",
      targetPlatform: "whatsapp",
      language: "kk",
      category: "MARKETING",
      bodyText: carousel.bodyText,
      hasCarousel: true,
      carouselHeaderFormat: "IMAGE",
    });
    expect(stored.values.carouselCards).toEqual([
      expect.objectContaining({
        headerFormat: "IMAGE",
        headerMediaExample: "https://cdn.test/business-media/product-p1.jpg",
        bodyText: "Шежіре 1\n15 500 ₸",
        buttons: [
          expect.objectContaining({
            type: "QUICK_REPLY",
            text: "Тапсырыс беру",
          }),
        ],
      }),
      expect.objectContaining({
        headerMediaExample: "https://cdn.test/business-media/product-p2.jpg",
      }),
    ]);
    // Each card and button has its own id, as the editor needs.
    const ids = stored.values.carouselCards.flatMap(
      (card: { clientId: string; buttons: Array<{ clientId: string }> }) => [
        card.clientId,
        ...card.buttons.map(button => button.clientId),
      ]
    );
    expect(new Set(ids).size).toBe(4);
  });

  it("asks before replacing a new template the owner hasn't saved", async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        values: { name: "spring_sale", targetPlatform: "whatsapp" },
      })
    );
    renderDrafts();

    fireEvent.click(screen.getByRole("button", { name: "Make a carousel" }));
    expect(
      screen.getByText(
        "You have a new template you haven't saved. Replace it with this carousel?"
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(
      JSON.parse(window.localStorage.getItem(DRAFT_KEY)!).values.name
    ).toBe("spring_sale");

    fireEvent.click(screen.getByRole("button", { name: "Make a carousel" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace it" }));
    await screen.findByRole("button", { name: "Opening Templates…" });
    expect(
      JSON.parse(window.localStorage.getItem(DRAFT_KEY)!).values.name
    ).toBe("products_20261028_1432");
  });

  it("says when WhatsApp isn't connected, with a way to connect it", async () => {
    routes[`POST ${BASE}/carousel`] = () =>
      respond(409, { code: "whatsapp_not_connected" });
    renderDrafts();

    fireEvent.click(screen.getByRole("button", { name: "Make a carousel" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connect your WhatsApp number first."
    );
    expect(
      screen.getByRole("link", { name: "Connect WhatsApp" })
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations?new=true&integration=whatsapp"
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
    // It can be tried again.
    expect(
      screen.getByRole("button", { name: "Make a carousel" })
    ).toBeEnabled();
  });

  it("needs two products with photos for a carousel", () => {
    renderDrafts(added(3, 1));

    expect(
      screen.getByText("A carousel needs at least 2 products with photos.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Make a carousel" })
    ).not.toBeInTheDocument();
  });

  it("says which products fit when there are more than the drafts hold", () => {
    renderDrafts(added(21));

    expect(
      screen.getByText(/The first 10 go on the cards\./)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The form lists the first 20\./)
    ).toBeInTheDocument();
  });

  it("saves the order form as a draft Flow and links to WhatsApp Flows", async () => {
    renderDrafts();

    fireEvent.click(screen.getByRole("button", { name: "Make an order form" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved as a draft: Order form 2026-10-28 14:32."
    );
    expect(
      screen.getByRole("link", { name: "Open WhatsApp Flows" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/messengers/whatsapp-flows");
    expect(
      screen.queryByRole("button", { name: "Make an order form" })
    ).not.toBeInTheDocument();
  });

  it("says when the order form couldn't be saved", async () => {
    routes[`POST ${BASE}/order-form`] = () =>
      respond(502, { code: "draft_failed" });
    renderDrafts();

    fireEvent.click(screen.getByRole("button", { name: "Make an order form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That didn't work. Try again."
    );
    expect(
      screen.getByRole("button", { name: "Make an order form" })
    ).toBeEnabled();
  });
});
