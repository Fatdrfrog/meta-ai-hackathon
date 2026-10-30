/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig, useSWRConfig } from "swr";
import { ProductShelf } from "./product-shelf";
import { ProductsPage } from "./products-page";

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ channel: null, isConnected: false }),
}));

// The products list; the page's import list answers empty on its own.
const fetchMock = jest.fn();

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProductsPage workspaceId="workspace-1" />
    </SWRConfig>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = ((url: string, init?: RequestInit) =>
    url.endsWith("/products/imports")
      ? Promise.resolve(respond(200, { imports: [] }))
      : fetchMock(url, init)) as unknown as typeof fetch;
});

test("asks the workspace's Products API", async () => {
  fetchMock.mockResolvedValue(respond(200, { products: [] }));
  renderPage();
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/products",
      { cache: "no-store" }
    )
  );
});

test("shows the loading state, then the empty state", async () => {
  fetchMock.mockResolvedValue(respond(200, { products: [] }));
  renderPage();
  expect(
    screen.getByRole("status", { name: "Loading products…" })
  ).toBeInTheDocument();
  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
  expect(screen.getByText(/Film your shelf on your phone/)).toBeInTheDocument();
});

test("lists products with their price, or a note when there is none", async () => {
  fetchMock.mockResolvedValue(
    respond(200, {
      products: [
        {
          id: "p1",
          name: "Кукла Лол",
          price: 5000,
          priceIsFrom: false,
          imageUrl: null,
          updatedAt: null,
        },
        {
          id: "p2",
          name: "Петух",
          price: null,
          priceIsFrom: false,
          imageUrl: null,
          updatedAt: null,
        },
        {
          id: "p3",
          name: "Шежіре",
          price: 15500,
          priceIsFrom: true,
          imageUrl: null,
          updatedAt: null,
        },
      ],
    })
  );
  renderPage();

  // The shelf is named by the heading over it, which tells it apart from a
  // video's draft shelf above.
  const list = await screen.findByRole("list", { name: "Your shelf" });
  expect(
    screen.getByRole("heading", { name: "Your shelf" })
  ).toBeInTheDocument();
  // Only products count: the spots that finish the row are hidden from it.
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("Кукла Лол")).toBeInTheDocument();
  // The default normalizer turns the no-break spaces in the page into plain ones.
  expect(
    screen.getByText("5 000 ₸", { normalizer: text => text })
  ).toBeInTheDocument();
  expect(screen.getByText("No price yet")).toBeInTheDocument();
  // A starting price says so.
  expect(
    screen.getByText("from 15 500 ₸", { normalizer: text => text })
  ).toBeInTheDocument();
  expect(screen.queryByText("2 products")).not.toBeInTheDocument();
});

test("finishes the last shelf row with spots that aren't products", () => {
  const products = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      id: `p${n}`,
      name: `Product ${n}`,
      price: 100,
      priceIsFrom: false,
      imageUrl: null,
      updatedAt: null,
    }));
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

test("sets a product's photo on the shelf only once it has loaded", async () => {
  fetchMock.mockResolvedValue(
    respond(200, {
      products: [
        {
          id: "p1",
          name: "Кукла Лол",
          price: 5000,
          priceIsFrom: false,
          imageUrl: "https://storage.test/doll.png",
          updatedAt: null,
        },
      ],
    })
  );
  const { container } = renderPage();
  await screen.findByText("Кукла Лол");

  const image = container.querySelector("img");
  expect(image).toHaveAttribute("src", "https://storage.test/doll.png");
  // The name below the shelf already says what it is.
  expect(image).toHaveAttribute("alt", "");
  expect(image?.parentElement).toHaveClass("opacity-0");

  fireEvent.load(image!);
  await waitFor(() =>
    expect(image?.parentElement).not.toHaveClass("opacity-0")
  );
  expect(image?.parentElement).toHaveClass("motion-safe:animate-in");
});

test("shows the name's first letter when there is no photo or it fails", async () => {
  fetchMock.mockResolvedValue(
    respond(200, {
      products: [
        {
          id: "p1",
          name: "шежіре",
          price: 18000,
          priceIsFrom: false,
          imageUrl: null,
          updatedAt: null,
        },
        {
          id: "p2",
          name: "Broken",
          price: 100,
          priceIsFrom: false,
          imageUrl: "https://storage.test/expired.png",
          updatedAt: null,
        },
      ],
    })
  );
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

test("shows an error with a retry that loads again", async () => {
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

test("tries a refreshed photo link again after the old one failed", () => {
  const product = (imageUrl: string) => ({
    id: "p1",
    name: "Кукла Лол",
    price: 5000,
    priceIsFrom: false,
    imageUrl,
    updatedAt: null,
  });
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
    respond(200, {
      products: [
        {
          id: "p1",
          name: "Кукла Лол",
          price: 5000,
          priceIsFrom: false,
          imageUrl: null,
          updatedAt: null,
        },
      ],
    })
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
