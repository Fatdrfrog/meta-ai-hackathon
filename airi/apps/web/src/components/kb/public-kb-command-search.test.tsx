/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PublicKBCommandSearch } from "./public-kb-command-search";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";

const push = jest.fn();
const swrKeys: Array<string | null> = [];

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    swrKeys.push(key);
    return {
      data: key
        ? {
            items: [
              {
                id: "article-1",
                title: "Refund policy",
                excerpt: "Refund windows and order cancellation terms",
                href: "/airichat/kb/article-1?locale=en",
                updatedAt: "2026-07-02T00:00:00.000Z",
              },
            ],
          }
        : undefined,
      isLoading: false,
      isValidating: false,
      mutate: jest.fn(),
      error: undefined,
    };
  },
}));

describe("PublicKBCommandSearch", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    push.mockClear();
    swrKeys.length = 0;
    window.innerWidth = 1024;
    installMatchMedia();
    Element.prototype.scrollIntoView = jest.fn();
    installResizeObserver();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens with Ctrl+K and searches the public company endpoint", async () => {
    render(
      <PublicKBCommandSearch
        companySlug="airichat"
        locale="en"
        labels={{
          placeholder: "Search articles...",
          searching: "Searching...",
          startTyping: "Start typing",
          noResults: "No articles found",
        }}
      />
    );

    expect(
      screen.getByRole("button", { name: "Search articles..." })
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = await screen.findByPlaceholderText("Search articles...");
    fireEvent.change(input, { target: { value: "refund" } });

    await act(async () => {
      jest.advanceTimersByTime(130);
    });

    await waitFor(() => {
      expect(
        swrKeys.some(key =>
          key?.includes(
            "/api/public-kb/airichat/search?q=refund&limit=8&locale=en"
          )
        )
      ).toBe(true);
    });

    const resultTitle = screen.getByText(
      (_content, element) => element?.textContent === "Refund policy"
    );
    expect(resultTitle).toBeInTheDocument();
    fireEvent.click(resultTitle.closest("[cmdk-item]") ?? resultTitle);
    expect(push).toHaveBeenCalledWith("/airichat/kb/article-1?locale=en");
  });

  it("opens search from the secondary trigger button", async () => {
    render(
      <PublicKBCommandSearch
        companySlug="airichat"
        locale="en"
        labels={{
          placeholder: "Search articles...",
          searching: "Searching...",
          startTyping: "Start typing",
          noResults: "No articles found",
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search articles..." }));

    expect(
      await screen.findByPlaceholderText("Search articles...")
    ).toBeInTheDocument();
  });
});
