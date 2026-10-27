/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ProductsPage } from "./products-page";

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
  global.fetch = fetchMock as unknown as typeof fetch;
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
          imageUrl: null,
          updatedAt: null,
        },
        {
          id: "p2",
          name: "Петух",
          price: null,
          imageUrl: null,
          updatedAt: null,
        },
      ],
    })
  );
  renderPage();

  const list = await screen.findByRole("list", { name: "Products" });
  expect(list.querySelectorAll("li")).toHaveLength(2);
  expect(screen.getByText("Кукла Лол")).toBeInTheDocument();
  // The default normalizer turns the no-break spaces in the page into plain ones.
  expect(
    screen.getByText("5 000 ₸", { normalizer: text => text })
  ).toBeInTheDocument();
  expect(screen.getByText("No price yet")).toBeInTheDocument();
  expect(screen.queryByText("2 products")).not.toBeInTheDocument();
});

test("sets a product's photo on the shelf only once it has loaded", async () => {
  fetchMock.mockResolvedValue(
    respond(200, {
      products: [
        {
          id: "p1",
          name: "Кукла Лол",
          price: 5000,
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
          imageUrl: null,
          updatedAt: null,
        },
        {
          id: "p2",
          name: "Broken",
          price: 100,
          imageUrl: "https://storage.test/expired.png",
          updatedAt: null,
        },
      ],
    })
  );
  const { container } = renderPage();
  await screen.findByText("шежіре");

  expect(screen.getByText("Ш")).toBeInTheDocument();
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(screen.getByText("B")).toBeInTheDocument();
});

test("shows an error with a retry that loads again", async () => {
  fetchMock.mockResolvedValueOnce(
    respond(503, { error: "x", code: "load_failed" })
  );
  renderPage();
  expect(
    await screen.findByText("Products couldn't be loaded.")
  ).toBeInTheDocument();

  fetchMock.mockResolvedValueOnce(respond(200, { products: [] }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Your products will appear here")
  ).toBeInTheDocument();
});
