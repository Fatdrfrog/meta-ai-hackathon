/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import fs from "fs";
import path from "path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { POLL_BACKOFF_MS } from "./use-product-context-controller";
import { ProductContextStep } from "./product-context-step";

const translations: Record<string, string> = {
  websitesLabel: "Your websites",
  websitesHelp:
    "We'll crawl these pages to learn about your product and build Airi's knowledge.",
  websiteInputLabel: "Website {number}",
  websiteInvalid: "Enter a valid public website, like https://example.com.",
  websitePlaceholder: "https://example.com",
  addWebsite: "Add another website",
  removeWebsiteLabel: "Remove website {number}",
  instagramLabel: "Instagram",
  instagramConnected: "Connected",
  instagramInclude:
    "Include my Instagram bio and recent posts in Airi's knowledge.",
  whatsappLabel: "WhatsApp",
  whatsappHelp:
    "Connect via Cloud API or Business App coexistence. Coexistence can import recent chat history to teach Airi.",
  whatsappConnected: "Connected",
  whatsappIncludeHistory: "Import recent WhatsApp chat history to teach Airi.",
  whatsappIncludeCloud:
    "Use this WhatsApp channel as a connected source for Airi.",
  whatsappHistoryRequested:
    "History import started - Airi will learn from your recent conversations.",
  whatsappHistoryError:
    "Could not start WhatsApp history import. Try again from Settings.",
  trainingProgressWhatsapp:
    "Importing WhatsApp history and preparing context...",
  trainingNeedsSource:
    "Add a website or select a connected channel. Training is optional — you can connect sources later in Integrations.",
  trainingOptional:
    "Training is optional. You can continue and connect sources in Integrations.",
  trainingLoading: "Loading training status...",
  trainingLoadError: "We couldn't load training status.",
  tryAgain: "Try again",
  trainingError: "We couldn't start training. Please try again.",
  trainingLimitError:
    "You've reached the website and Instagram source limit. Remove a source in Integrations, then try again.",
  trainingStart: "Start training Airi",
  trainingRestart: "Re-train Airi",
  trainingProgressTitle: "Indexing progress",
  trainingProgressPending: "Indexing your sources...",
  trainingBackgroundTitle: "Training continues in the background",
  trainingBackgroundDescription:
    "You can continue to Integrations and check progress here later.",
  checkAgain: "Check again",
  statusIndexed: "Indexed",
  statusFailed: "Failed",
  statusPending: "Indexing...",
  statusFailedNoContent: "No readable content was found.",
  statusFailedTimeout: "Indexing timed out.",
  statusFailedGeneric: "Indexing failed. Try again.",
  retrySource: "Retry {source}",
  testChatLocked: "Add a source and start training to test Airi",
  testChatLockedHelp:
    "Add a website, then click Start training before testing.",
  testChatHeading: "Test what Airi learned",
  testChatHelp:
    "Ask Airi about your product to check it understood your context.",
  testChatTitle: "Test chat with Airi",
  openAiriChat: "Open Airi chat",
  learningReadyTitle: "Airi has context now",
  learningReadyDescription:
    "Ask one real customer question below. The first useful answer is your setup activation.",
};

jest.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, string | number>): string => {
      const template = translations[key] ?? key;
      return Object.entries(values ?? {}).reduce(
        (value, [name, replacement]) =>
          value.replace(`{${name}}`, String(replacement)),
        template
      );
    },
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

type CrawlSource = {
  id: string;
  url: string;
  title: string | null;
  index_status: "pending" | "indexed" | "failed";
  failure_code: "no_content" | "timeout" | "generic" | null;
  error_message: string | null;
};

type CrawlPayload = {
  sources: CrawlSource[];
  pending: number;
  indexed: number;
  failed: number;
  total: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function response(
  status: number,
  payload: unknown
): Pick<Response, "ok" | "status" | "json"> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function crawlPayload(sources: CrawlSource[] = []): CrawlPayload {
  return {
    sources,
    pending: sources.filter(source => source.index_status === "pending").length,
    indexed: sources.filter(source => source.index_status === "indexed").length,
    failed: sources.filter(source => source.index_status === "failed").length,
    total: sources.length,
  };
}

const indexedSource: CrawlSource = {
  id: "indexed-source",
  url: "https://example.com/",
  title: "Example",
  index_status: "indexed",
  failure_code: null,
  error_message: null,
};

type FetchHarnessOptions = {
  crawlGets?: Array<Pick<Response, "ok" | "status" | "json">>;
  crawlPost?:
    | Pick<Response, "ok" | "status" | "json">
    | Promise<Pick<Response, "ok" | "status" | "json">>;
  integrations?: Array<{ type: string }>;
  whatsappStatus?: Pick<Response, "ok" | "status" | "json">;
};

function installFetchHarness(options: FetchHarnessOptions = {}) {
  const crawlGets = options.crawlGets ?? [response(200, crawlPayload())];
  let crawlGetIndex = 0;
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (
        url === "/api/workspaces/workspace-1/onboarding/crawl" &&
        method === "GET"
      ) {
        const next =
          crawlGets[Math.min(crawlGetIndex, crawlGets.length - 1)] ??
          response(200, crawlPayload());
        crawlGetIndex += 1;
        return next as Response;
      }

      if (
        url === "/api/workspaces/workspace-1/onboarding/crawl" &&
        method === "POST"
      ) {
        return (await (options.crawlPost ??
          response(202, { accepted: true }))) as Response;
      }

      if (url === "/api/workspaces/workspace-1/integrations") {
        return response(200, {
          sources: options.integrations ?? [],
        }) as Response;
      }

      if (url === "/api/whatsapp/smb-app-data?workspaceId=workspace-1") {
        return (options.whatsappStatus ?? response(404, {})) as Response;
      }

      if (url === "/api/whatsapp/smb-app-data" && method === "POST") {
        return response(200, {}) as Response;
      }

      if (
        url === "/api/workspaces/workspace-1/onboarding/analytics" &&
        method === "POST"
      ) {
        return response(202, { accepted: true }) as Response;
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }
  );
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

async function waitForInitialReads(fetchMock: jest.Mock) {
  await waitFor(() => {
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/workspaces/workspace-1/onboarding/crawl" &&
          ((init as RequestInit | undefined)?.method ?? "GET") === "GET"
      )
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          String(input) === "/api/workspaces/workspace-1/integrations"
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          String(input) === "/api/whatsapp/smb-app-data?workspaceId=workspace-1"
      )
    ).toBe(true);
  });
}

describe("ProductContextStep", () => {
  it("uses callback refs for one-shot website focus ownership", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "product-website-fields.tsx"),
      "utf8"
    );

    expect(source).not.toContain("useEffect");
    expect(source).not.toContain("useRef(new Map");
    expect(source).toContain("handledFocusVersionRef");
  });

  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("uses a website fieldset, stable row identity, and deterministic focus recovery", async () => {
    const fetchMock = installFetchHarness();
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    expect(
      screen.getByRole("group", { name: "Your websites" })
    ).toBeInTheDocument();
    const first = screen.getByRole("textbox", { name: "Website 1" });
    fireEvent.change(first, { target: { value: "first.example" } });

    fireEvent.click(
      screen.getByRole("button", { name: "Add another website" })
    );
    const second = screen.getByRole("textbox", { name: "Website 2" });
    expect(second).toHaveFocus();
    fireEvent.change(second, { target: { value: "second.example" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove website 1" }));
    const remaining = screen.getByRole("textbox", { name: "Website 1" });
    expect(remaining).toHaveValue("second.example");
    expect(remaining).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Remove website 1" }));
    expect(
      screen.getByRole("button", { name: "Add another website" })
    ).toHaveFocus();
  });

  it("never submits a wrapping form when Enter is pressed in website rows", async () => {
    const fetchMock = installFetchHarness();
    const onSubmit = jest.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <ProductContextStep workspaceId="workspace-1" />
      </form>
    );
    await waitForInitialReads(fetchMock);

    fireEvent.click(
      screen.getByRole("button", { name: "Add another website" })
    );
    const first = screen.getByRole("textbox", { name: "Website 1" });
    const second = screen.getByRole("textbox", { name: "Website 2" });

    expect(fireEvent.keyDown(first, { key: "Enter", code: "Enter" })).toBe(
      false
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByRole("textbox", { name: /Website/ })).toHaveLength(2);

    expect(fireEvent.keyDown(second, { key: "Enter", code: "Enter" })).toBe(
      false
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByRole("textbox", { name: /Website/ })).toHaveLength(3);
    expect(screen.getByRole("textbox", { name: "Website 3" })).toHaveFocus();
  });

  it("normalizes bare domains and blocks invalid websites", async () => {
    const fetchMock = installFetchHarness();
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    const input = screen.getByRole("textbox", { name: "Website 1" });
    fireEvent.change(input, { target: { value: "example.com/docs" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("https://example.com/docs");

    fireEvent.change(input, { target: { value: "localhost:3000" } });
    expect(
      screen.getByText(
        "Enter a valid public website, like https://example.com."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start training Airi" })
    ).toBeDisabled();
  });

  it("announces progress once, marks only active work busy, and unlocks restart after acceptance", async () => {
    const post = deferred<Pick<Response, "ok" | "status" | "json">>();
    const fetchMock = installFetchHarness({ crawlPost: post.promise });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    fireEvent.change(screen.getByRole("textbox", { name: "Website 1" }), {
      target: { value: "example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start training Airi" })
    );

    await waitFor(() => {
      expect(screen.getByTestId("training-region")).toHaveAttribute(
        "aria-busy",
        "true"
      );
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("status")).toHaveClass("sr-only");
      expect(
        screen.getByRole("button", { name: "Start training Airi" })
      ).toBeDisabled();
    });

    post.resolve(response(202, { accepted: true }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Re-train Airi" })
      ).toBeEnabled();
      expect(screen.getByTestId("training-region")).toHaveAttribute(
        "aria-busy",
        "true"
      );
    });
  });

  it("keeps connected Instagram locked until indexed knowledge appears", async () => {
    const fetchMock = installFetchHarness({
      integrations: [{ type: "instagram" }],
      crawlPost: response(202, { accepted: true }),
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    expect(screen.queryByRole("link", { name: "Open Airi chat" })).toBeNull();
    expect(
      screen.getAllByText(
        "Add a website, then click Start training before testing."
      )
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Start training Airi" })
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/onboarding/crawl",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ websites: [], includeInstagram: true }),
        })
      );
      expect(
        screen.getByRole("button", { name: "Re-train Airi" })
      ).toBeEnabled();
    });

    expect(screen.queryByRole("link", { name: "Open Airi chat" })).toBeNull();
  });

  it("renders enabled test-chat help once and preserves its onboarding route", async () => {
    const fetchMock = installFetchHarness({
      crawlGets: [response(200, crawlPayload([indexedSource]))],
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "Open Airi chat" })
      ).toHaveAttribute("href", "/panel/w/workspace-1/airi?source=onboarding");
    });
    expect(
      screen.getAllByText(
        "Ask Airi about your product to check it understood your context."
      )
    ).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps pending work active while usable knowledge unlocks Airi", async () => {
    const pendingSource: CrawlSource = {
      ...indexedSource,
      id: "pending-alongside-ready",
      url: "https://pending.example/",
      title: "Pending",
      index_status: "pending",
    };
    const fetchMock = installFetchHarness({
      crawlGets: [response(200, crawlPayload([indexedSource, pendingSource]))],
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    await screen.findByRole("link", { name: "Open Airi chat" });
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(
      screen.getByTestId("training-region").querySelector(".animate-spin")
    ).not.toBeNull();
  });

  it("retains usable Airi readiness and static pending badges through a re-train failure", async () => {
    const pendingSource: CrawlSource = {
      ...indexedSource,
      id: "pending-through-error",
      url: "https://pending.example/",
      title: "Pending",
      index_status: "pending",
    };
    const fetchMock = installFetchHarness({
      crawlGets: [response(200, crawlPayload([indexedSource, pendingSource]))],
      crawlPost: response(403, {
        code: "authorization_failed",
        error: "internal crawl failure",
      }),
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: "Open Airi chat" })
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-train Airi" }));
    expect(
      await screen.findByText("We couldn't start training. Please try again.")
    ).toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: "Open Airi chat" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/airi?source=onboarding");
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "false"
    );
    expect(
      screen.getByRole("status").querySelector(".animate-spin")
    ).toBeNull();
  });

  it("maps start failures to safe copy and never renders raw backend text", async () => {
    const raw = "permission denied for table kb_indexed_urls";
    const fetchMock = installFetchHarness({
      crawlPost: response(403, {
        code: "authorization_failed",
        error: raw,
      }),
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    fireEvent.change(screen.getByRole("textbox", { name: "Website 1" }), {
      target: { value: "example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start training Airi" })
    );

    const safeError = await screen.findByText(
      "We couldn't start training. Please try again."
    );
    expect(safeError).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("tabindex", "-1");
    expect(alert).toHaveFocus();
    expect(screen.queryByText(raw)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start training Airi" })
    ).toBeEnabled();
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "false"
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);

    const websiteInput = screen.getByRole("textbox", { name: "Website 1" });
    websiteInput.focus();
    expect(websiteInput).toHaveFocus();
    fireEvent.change(websiteInput, { target: { value: "example.org" } });
    expect(websiteInput).toHaveFocus();
  });

  it("shows the localized source limit without marking accepted WhatsApp history ready", async () => {
    const raw = "company_id=secret has too many kb_indexed_urls rows";
    const fetchMock = installFetchHarness({
      integrations: [{ type: "whatsapp" }],
      whatsappStatus: response(200, {
        data: {
          history_sync_eligible: true,
          history_sync_can_request: true,
          history_sync: {
            session_id: "new-session",
            session_started_at: new Date().toISOString(),
          },
        },
      }),
      crawlPost: response(400, {
        code: "indexed_url_limit_exceeded",
        error: raw,
      }),
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    fireEvent.change(screen.getByRole("textbox", { name: "Website 1" }), {
      target: { value: "example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start training Airi" })
    );

    expect(
      await screen.findByText(
        "You've reached the website and Instagram source limit. Remove a source in Integrations, then try again."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(raw)).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open Airi chat" })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "false"
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input) === "/api/workspaces/workspace-1/onboarding/crawl" &&
          ((init as RequestInit | undefined)?.method ?? "GET") === "GET"
      )
    ).toHaveLength(1);
  });

  it("shows safe row-level failure reasons with retries using the current configuration", async () => {
    const failedSources: CrawlSource[] = [
      {
        id: "no-content",
        url: "https://empty.example/",
        title: "No content",
        index_status: "failed",
        failure_code: "no_content",
        error_message: "raw provider diagnostic",
      },
      {
        id: "timeout",
        url: "https://slow.example/",
        title: "Slow",
        index_status: "failed",
        failure_code: "timeout",
        error_message: "activity timed out internally",
      },
      {
        id: "generic",
        url: "https://broken.example/",
        title: "Broken",
        index_status: "failed",
        failure_code: "generic",
        error_message: "permission denied for table kb_indexed_urls",
      },
    ];
    const post = deferred<Pick<Response, "ok" | "status" | "json">>();
    const fetchMock = installFetchHarness({
      crawlGets: [response(200, crawlPayload(failedSources))],
      crawlPost: post.promise,
    });
    render(<ProductContextStep workspaceId="workspace-1" />);
    await waitForInitialReads(fetchMock);

    const noContentRow = screen.getByText("No content").closest("li");
    const timeoutRow = screen.getByText("Slow").closest("li");
    const genericRow = screen.getByText("Broken").closest("li");
    expect(noContentRow).not.toBeNull();
    expect(timeoutRow).not.toBeNull();
    expect(genericRow).not.toBeNull();
    expect(
      within(noContentRow!).getByText("No readable content was found.")
    ).toBeInTheDocument();
    expect(
      within(timeoutRow!).getByText("Indexing timed out.")
    ).toBeInTheDocument();
    expect(
      within(genericRow!).getByText("Indexing failed. Try again.")
    ).toBeInTheDocument();
    expect(screen.queryByText("raw provider diagnostic")).toBeNull();
    expect(
      screen.queryByText("permission denied for table kb_indexed_urls")
    ).toBeNull();

    fireEvent.click(
      within(noContentRow!).getByRole("button", { name: "Retry No content" })
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/workspaces/workspace-1/onboarding/crawl",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            websites: [
              "https://empty.example/",
              "https://slow.example/",
              "https://broken.example/",
            ],
            includeInstagram: false,
          }),
        })
      );
    });
  });

  it("replaces foreground progress with background copy and check-again control", async () => {
    jest.useFakeTimers();
    const pendingSource: CrawlSource = {
      ...indexedSource,
      id: "pending-source",
      index_status: "pending",
    };
    installFetchHarness({
      crawlGets: [response(200, crawlPayload([pendingSource]))],
    });
    render(<ProductContextStep workspaceId="workspace-1" />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "true"
    );

    for (const delay of POLL_BACKOFF_MS) {
      await act(async () => {
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(
      screen.getByText("Training continues in the background", {
        selector: "p",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You can continue to Integrations and check progress here later."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByTestId("training-region")).toHaveAttribute(
      "aria-busy",
      "false"
    );
    expect(
      screen.getByRole("status").querySelector(".animate-spin")
    ).toBeNull();
  });
});
