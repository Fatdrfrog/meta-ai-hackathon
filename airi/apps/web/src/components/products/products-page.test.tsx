/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ProductsPage } from "./products-page";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

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
  expect(screen.getByRole("status", { name: "loading" })).toBeInTheDocument();
  expect(await screen.findByText("empty.title")).toBeInTheDocument();
  expect(screen.getByText("empty.description")).toBeInTheDocument();
});

test("lists products with their price, or a note when there is none", async () => {
  fetchMock.mockResolvedValue(
    respond(200, {
      products: [
        { id: "p1", name: "Кукла Лол", price: 5000, updatedAt: null },
        { id: "p2", name: "Петух", price: null, updatedAt: null },
      ],
    })
  );
  renderPage();

  const list = await screen.findByRole("list", { name: "title" });
  expect(list.querySelectorAll("li")).toHaveLength(2);
  expect(screen.getByText("Кукла Лол")).toBeInTheDocument();
  // The default normalizer turns the no-break spaces in the page into plain ones.
  expect(
    screen.getByText("5 000 ₸", { normalizer: text => text })
  ).toBeInTheDocument();
  expect(screen.getByText("noPrice")).toBeInTheDocument();
  expect(screen.getByText('count:{"count":2}')).toBeInTheDocument();
});

test("shows an error with a retry that loads again", async () => {
  fetchMock.mockResolvedValueOnce(
    respond(503, { error: "x", code: "load_failed" })
  );
  renderPage();
  expect(await screen.findByText("loadError")).toBeInTheDocument();

  fetchMock.mockResolvedValueOnce(respond(200, { products: [] }));
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  expect(await screen.findByText("empty.title")).toBeInTheDocument();
});
