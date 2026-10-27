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
import userEvent from "@testing-library/user-event";
import React from "react";
import { DialogListPanel } from "./dialog-list-panel";
import type { FormattedRequest as RequestItem } from "@/features/panel/requests/formatting";
import conversationsMessages from "../../../messages/conversations/en/page.json";

jest.mock("@icecore/shared/types/requests-realtime", () => {
  global.TextEncoder = jest.requireActual("node:util").TextEncoder;
  return jest.requireActual("@icecore/shared/types/requests-realtime");
});

const mockRealtimeState = {
  patchRow: jest.fn(),
  patchRows: jest.fn(),
  realtimeRows: [] as RequestItem[],
  updatedRowIds: new Set<string>(),
};
const mockUseRequestsRealtime = jest.fn(() => mockRealtimeState);

const mockMessages: Record<string, string> = {
  allCategories: "All categories",
  allChannels: "All channels",
  allLabels: "All labels",
  airiRepliedBadge: "Airi replied",
  "analyticsFilters.slaBreached": "SLA breached",
  "analyticsFilters.csatLow": "Low CSAT",
  "analyticsFilters.bestPractice": "Best practice",
  "statuses.open": "Open",
  "statuses.in_progress": "In progress",
  "statuses.closed": "Closed",
  applyingFilters: "Applying...",
  closeFilters: "Close filters",
  clearFilters: "Clear filters",
  clearInsightFilter: "Clear insight filter",
  connectSourceEmptyAction: "Ask another test question",
  connectSourceEmptyDescription:
    "This inbox is ready. Keep testing Airi with your website context, then connect a live channel when you want real customer chats here.",
  connectSourceEmptySecondaryAction: "Connect a live channel",
  connectSourceEmptyTitle: "Your inbox is ready",
  filterBy: "Filter by",
  filterByCategory: "Filter by category",
  filterByLabel: "Filter by label",
  filterBySource: "Filter by source",
  left: "left",
  loadingConversations: "Loading conversations...",
  loadingMore: "Loading more...",
  noConversationsFound: "No conversations found",
  noMoreConversations: "No more conversations",
  replyOwnerTitle: "Reply owner",
  filterHeader: "Filters",
  filterMoreCategories: "More categories",
  filterMoreLabels: "More labels",
  filterMoreSources: "More sources",
  filterTraySubtitle: "Choose a lane, then narrow the inbox.",
  status: "Status",
  windowClosed: "Window closed",
  planGateTrialEnded: conversationsMessages.DialogListPanel.planGateTrialEnded,
  planGateHiddenConversations:
    conversationsMessages.DialogListPanel.planGateHiddenConversations,
  planGateTrialExpiredIntake:
    conversationsMessages.DialogListPanel.planGateTrialExpiredIntake,
  planGateConversationLimitIntake:
    conversationsMessages.DialogListPanel.planGateConversationLimitIntake,
  planGateUpgrade: conversationsMessages.DialogListPanel.planGateUpgrade,
  renameConversation: conversationsMessages.DialogListPanel.renameConversation,
  saveRename: conversationsMessages.DialogListPanel.saveRename,
  showMoreBadges: conversationsMessages.DialogListPanel.showMoreBadges,
  unreadFilter: conversationsMessages.DialogListPanel.unreadFilter,
  unreadFilterWithCount:
    conversationsMessages.DialogListPanel.unreadFilterWithCount,
  yesterday: conversationsMessages.DialogListPanel.yesterday,
  unnamedCustomer: "Клиент",
  unnamedGroup: "Группа Telegram",
};

const mockRouterReplace = jest.fn();
let mockSearchParams = new URLSearchParams();
const mockSWRMutate = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockPreloadConversationDetail = jest.fn((..._args: unknown[]) =>
  Promise.resolve()
);
const mockPreloadConversationDetailView = jest.fn((..._args: unknown[]) =>
  Promise.resolve()
);

jest.mock("@/lib/conversation/detail-client", () => ({
  preloadConversationDetail: (...args: unknown[]) =>
    mockPreloadConversationDetail(...args),
}));

jest.mock("@/components/conversation/conversation-detail-loader", () => ({
  preloadConversationDetailView: (...args: unknown[]) =>
    mockPreloadConversationDetailView(...args),
}));

// The upgrade dialog has its own suite; the banner tests only need the list.
jest.mock("@/components/billing/plan-upgrade-dialog", () => ({
  PlanUpgradeDialog: () => null,
}));

jest.mock("@/components/tables/requests-realtime-provider", () => ({
  useRequestsRealtime: () => mockUseRequestsRealtime(),
}));

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div className={className} data-slot="scroll-area">
      <div data-slot="scroll-area-viewport">{children}</div>
    </div>
  ),
  ScrollBar: () => null,
}));

jest.mock("framer-motion", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const createMotionComponent = (tag: string) => {
    const MotionComponent = React.forwardRef<
      HTMLElement,
      React.HTMLAttributes<HTMLElement>
    >(({ children, ...props }, ref) => {
      const domProps = {
        ...(props as React.HTMLAttributes<HTMLElement> & {
          animate?: unknown;
          exit?: unknown;
          initial?: unknown;
          layout?: unknown;
          transition?: unknown;
          variants?: unknown;
          whileHover?: unknown;
          whileTap?: unknown;
        }),
      };
      delete domProps.animate;
      delete domProps.exit;
      delete domProps.initial;
      delete domProps.layout;
      delete domProps.transition;
      delete domProps.variants;
      delete domProps.whileHover;
      delete domProps.whileTap;

      return React.createElement(tag, { ...domProps, ref }, children);
    });
    MotionComponent.displayName = `MockMotion(${tag})`;
    return MotionComponent;
  };

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => createMotionComponent(tag),
      }
    ),
  };
});

// Substitutes {name} values and English one/other plurals so a dropped
// interpolation argument shows up.
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      (mockMessages[key] ?? key)
        .replace(
          /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
          (match, name: string, one: string, other: string) =>
            values?.[name] === undefined
              ? match
              : (values[name] === 1 ? one : other).replace(
                  /#/g,
                  String(values[name])
                )
        )
        .replace(/\{(\w+)\}/g, (match, name: string) =>
          values?.[name] === undefined ? match : String(values[name])
        ),
}));

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: mockRouterReplace }),
}));

jest.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { labels: [] },
  }),
  mutate: (...args: unknown[]) => mockSWRMutate(...args),
  useSWRConfig: () => ({ mutate: mockSWRMutate }),
}));

const originalFetch = global.fetch;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("DialogListPanel source onboarding", () => {
  beforeEach(() => {
    mockRealtimeState.realtimeRows = [];
    mockSearchParams = new URLSearchParams();
    mockRouterReplace.mockReset();
    global.fetch = jest.fn(() => new Promise(() => {})) as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it.each([false, true])(
    "revalidates a filtered window after a burst (transient failure: %s)",
    async transientFailure => {
      jest.useFakeTimers();
      mockSearchParams = new URLSearchParams("status=open");
      let filteredReads = 0;
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("status=open")) filteredReads += 1;
        if (
          String(input).includes("status=open") &&
          transientFailure &&
          filteredReads === 2
        )
          return {
            ok: false,
            status: 503,
            text: async () => "temporary",
          } as Response;
        return jsonResponse({
          data:
            filteredReads > 1
              ? [
                  {
                    _id: "new-row",
                    status: "open",
                    channel: "whatsapp",
                    createdAt: "2026-10-13T07:00:00Z",
                    computedLastMessageAt: "2026-10-13T07:00:00Z",
                    user: { _id: "synthetic", firstName: "Recovered customer" },
                    messages: [],
                  },
                ]
              : [],
          pagination: { hasNextPage: false },
        });
      }) as typeof fetch;
      if (transientFailure)
        jest.spyOn(console, "error").mockImplementation(() => {});
      const props = {
        workspaceId: "workspace-1",
        requests: [],
        initialAvailableChannels: ["whatsapp"],
        initialHasMore: false,
        initialRenderNowMs: 1_700_000_000_000,
        activeConversationId: null,
        onSelectConversation: jest.fn(),
      };
      const { rerender } = render(<DialogListPanel {...props} />);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(filteredReads).toBe(1);
      for (let i = 0; i < 3; i++) {
        mockRealtimeState.realtimeRows = [
          { id: `changed-${i}` } as RequestItem,
        ];
        rerender(<DialogListPanel {...props} />);
      }
      await act(async () => {
        await jest.advanceTimersByTimeAsync(4000);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      for (let tick = 0; tick < 10; tick++)
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1000);
        });
      expect(filteredReads).toBe(transientFailure ? 3 : 2);
      expect(screen.getByText(/Recovered customer/)).toBeInTheDocument();
    }
  );

  it("retries a timed-out filtered refresh while preserving the current rows", async () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("status=open");
    jest.spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    let stalledSignal: AbortSignal | undefined;
    const row = {
      _id: "existing-row",
      status: "open",
      channel: "whatsapp",
      createdAt: "2026-10-13T07:00:00Z",
      computedLastMessageAt: "2026-10-13T07:00:00Z",
      user: { _id: "synthetic", firstName: "Existing customer" },
      messages: [],
    };
    global.fetch = jest.fn((url: RequestInfo | URL, options?: RequestInit) => {
      if (String(url).includes("status=open") && ++reads === 2) {
        stalledSignal = options?.signal || undefined;
        return new Promise<Response>((_resolve, reject) => {
          stalledSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      }
      return Promise.resolve(
        jsonResponse({ data: [row], pagination: { hasNextPage: false } })
      );
    }) as typeof fetch;
    const props = {
      workspaceId: "workspace-1",
      requests: [],
      initialAvailableChannels: ["whatsapp"],
      initialHasMore: false,
      initialRenderNowMs: 1_700_000_000_000,
      activeConversationId: null,
      onSelectConversation: jest.fn(),
    };
    const { rerender } = render(<DialogListPanel {...props} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText(/Existing customer/)).toBeInTheDocument();
    mockRealtimeState.realtimeRows = [{ id: "new-row" } as RequestItem];
    rerender(<DialogListPanel {...props} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1001);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(stalledSignal?.aborted).toBe(true);
    expect(screen.getByText(/Existing customer/)).toBeInTheDocument();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(reads).toBe(3);
    expect(screen.getByText(/Existing customer/)).toBeInTheDocument();
  });

  it("does not starve filtered refresh under sustained events and serializes trailing refresh", async () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("status=open");
    const pending = createDeferred<Response>();
    let reads = 0;
    global.fetch = jest.fn((url: RequestInfo | URL) => {
      if (String(url).includes("status=open") && ++reads === 2)
        return pending.promise;
      return Promise.resolve(
        jsonResponse({ data: [], pagination: { hasNextPage: false } })
      );
    }) as typeof fetch;
    const props = {
      workspaceId: "workspace-1",
      requests: [],
      initialAvailableChannels: ["whatsapp"],
      initialHasMore: false,
      initialRenderNowMs: 1_700_000_000_000,
      activeConversationId: null,
      onSelectConversation: jest.fn(),
    };
    const { rerender } = render(<DialogListPanel {...props} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    for (let i = 0; i < 12; i++) {
      mockRealtimeState.realtimeRows = [{ id: `burst-${i}` } as RequestItem];
      rerender(<DialogListPanel {...props} />);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(500);
      });
    }
    expect(reads).toBe(2);
    await act(async () => {
      pending.resolve(
        jsonResponse({ data: [], pagination: { hasNextPage: false } })
      );
      await pending.promise;
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(reads).toBe(3);
  });

  it("defers filtered invalidation while hidden and abandons an old workspace response", async () => {
    jest.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    jest
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    mockSearchParams = new URLSearchParams("status=open");
    const pending = createDeferred<Response>();
    let oldReads = 0;
    global.fetch = jest.fn((url: RequestInfo | URL) => {
      if (
        String(url).includes("status=open") &&
        String(url).includes("workspace-1") &&
        ++oldReads === 2
      )
        return pending.promise;
      return Promise.resolve(
        jsonResponse({ data: [], pagination: { hasNextPage: false } })
      );
    }) as typeof fetch;
    const props = {
      workspaceId: "workspace-1",
      requests: [],
      initialAvailableChannels: ["whatsapp"],
      initialHasMore: false,
      initialRenderNowMs: 1_700_000_000_000,
      activeConversationId: null,
      onSelectConversation: jest.fn(),
    };
    const { rerender, unmount } = render(<DialogListPanel {...props} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    visibility = "hidden";
    mockRealtimeState.realtimeRows = [{ id: "hidden-change" } as RequestItem];
    rerender(<DialogListPanel {...props} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(oldReads).toBe(1);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await jest.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(oldReads).toBe(2);
    const oldRequest = (global.fetch as jest.Mock).mock.calls.findLast(
      ([url]) =>
        String(url).includes("workspace-1") &&
        String(url).includes("status=open")
    );
    rerender(<DialogListPanel {...props} workspaceId="workspace-2" />);
    expect(oldRequest?.[1].signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve(
        jsonResponse({
          data: [
            {
              _id: "old",
              status: "open",
              user: { firstName: "Old workspace" },
            },
          ],
          pagination: {},
        })
      );
      await pending.promise;
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(screen.queryByText(/Old workspace/)).not.toBeInTheDocument();
    unmount();
    const count = (global.fetch as jest.Mock).mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(count);
  });

  it("applies analytics URL filters when fetching requests", async () => {
    mockSearchParams = new URLSearchParams("filter=slaBreached");
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        data: [],
        pagination: {
          page: 1,
          limit: 50,
          totalCount: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      })
    ) as typeof fetch;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={1_700_000_000_000}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    await waitFor(() => {
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([input]) =>
          String(input).includes("filter=slaBreached")
        )
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(
      screen.getByRole("button", { name: "Clear filters: SLA breached" })
    ).toBeInTheDocument();
  });

  it("applies status URL filters when fetching and rendering requests", async () => {
    mockSearchParams = new URLSearchParams("status=in_progress");
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        data: [],
        pagination: {
          page: 1,
          limit: 50,
          totalCount: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
      })
    ) as typeof fetch;

    const requests = [
      {
        id: "open-1",
        dateValue: "2026-01-01T00:00:00.000Z",
        source: "WhatsApp",
        status: "open",
        client: "Open Client",
        rename: null,
        request: "Open chat",
        category: null,
        action: null,
        channel: "whatsapp",
        isReadByManager: true,
      },
      {
        id: "progress-1",
        dateValue: "2026-01-01T00:00:00.000Z",
        source: "WhatsApp",
        status: "in_progress",
        client: "Progress Client",
        rename: null,
        request: "In progress chat",
        category: null,
        action: null,
        channel: "whatsapp",
        isReadByManager: true,
      },
    ] as RequestItem[];

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={requests}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={1_700_000_000_000}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    expect(screen.getByText("Progress Client")).toBeInTheDocument();
    expect(screen.queryByText("Open Client")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([input]) =>
          String(input).includes("status=in_progress")
        )
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(
      screen.getByRole("button", { name: "Clear filters: In progress" })
    ).toBeInTheDocument();
  });

  it("routes source-less users back to Airi testing instead of making Settings the default", () => {
    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={[]}
        initialHasMore={false}
        initialRenderNowMs={1_700_000_000_000}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources={false}
      />
    );

    expect(screen.getByText("Your inbox is ready")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This inbox is ready. Keep testing Airi with your website context, then connect a live channel when you want real customer chats here."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Ask another test question" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/airi?source=onboarding");
    expect(
      screen.getByRole("link", { name: "Connect a live channel" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/settings/integrations");
    expect(
      screen.queryByText("No conversations found")
    ).not.toBeInTheDocument();
  });

  it.each([true, false])(
    "waits for authoritative source readiness before choosing the initial empty state (%s)",
    async hasConfiguredSources => {
      const readiness = createDeferred<boolean>();
      await act(async () => {
        render(
          <DialogListPanel
            workspaceId="workspace-1"
            requests={[]}
            initialAvailableChannels={[]}
            initialHasMore={false}
            initialRenderNowMs={1_700_000_000_000}
            activeConversationId={null}
            onSelectConversation={jest.fn()}
            hasConfiguredSources={readiness.promise}
          />
        );
      });

      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading conversations..."
      );
      expect(screen.queryByText("Your inbox is ready")).not.toBeInTheDocument();
      expect(
        screen.queryByText("No conversations found")
      ).not.toBeInTheDocument();

      await act(async () => readiness.resolve(hasConfiguredSources));

      expect(
        await screen.findByText(
          hasConfiguredSources
            ? "No conversations found"
            : "Your inbox is ready"
        )
      ).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    }
  );

  it.each([true, false])(
    "keeps rows visible while readiness is pending and uses its authoritative %s value when the list becomes empty",
    async hasConfiguredSources => {
      const readiness = createDeferred<boolean>();
      const request = {
        id: "conversation-readiness",
        dateValue: "2026-06-23T08:02:00.000Z",
        status: "open",
        client: "Acme Customer",
        request: "Please invoice me",
        category: null,
        action: null,
        channel: "whatsapp",
        source: "WhatsApp",
      } as RequestItem;
      render(
        <DialogListPanel
          workspaceId="workspace-1"
          requests={[request]}
          initialAvailableChannels={["whatsapp"]}
          initialHasMore={false}
          initialRenderNowMs={1_700_000_000_000}
          activeConversationId={null}
          onSelectConversation={jest.fn()}
          hasConfiguredSources={readiness.promise}
        />
      );

      expect(screen.getByText("Acme Customer")).toBeVisible();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      global.fetch = jest
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: [], pagination: { totalCount: 0 } })
        );
      fireEvent.change(
        screen.getByRole("textbox", { name: "searchPlaceholderMessage" }),
        {
          target: { value: "missing customer" },
        }
      );
      await waitFor(() => {
        expect(screen.queryByText("Acme Customer")).not.toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent(
          "Loading conversations..."
        );
      });

      await act(async () => readiness.resolve(hasConfiguredSources));

      expect(
        await screen.findByText(
          hasConfiguredSources
            ? "No conversations found"
            : "Your inbox is ready"
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText(
          hasConfiguredSources
            ? "Your inbox is ready"
            : "No conversations found"
        )
      ).not.toBeInTheDocument();
    }
  );

  it("clears the unread marker locally after opening a conversation without waiting for realtime hydration", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ totalCount: 0, data: [] }),
    }) as typeof fetch;
    const request = {
      id: "conversation-1",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Acme Customer",
      request: "Please invoice me",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: false,
      lastMessageText: "Please invoice me",
    } as RequestItem;
    const props = {
      workspaceId: "workspace-1",
      requests: [request],
      initialAvailableChannels: ["whatsapp"],
      initialHasMore: false,
      initialRenderNowMs: new Date("2026-06-23T08:03:00.000Z").getTime(),
      hasConfiguredSources: true,
    };
    let rerenderPanel: (activeConversationId: string | null) => void = () => {};
    // Like the master/detail layout, selecting a row opens it.
    const onSelectConversation = jest.fn((id: string) => rerenderPanel(id));
    const { rerender } = render(
      <DialogListPanel
        {...props}
        activeConversationId={null}
        onSelectConversation={onSelectConversation}
      />
    );
    rerenderPanel = activeConversationId =>
      rerender(
        <DialogListPanel
          {...props}
          activeConversationId={activeConversationId}
          onSelectConversation={onSelectConversation}
        />
      );

    expect(screen.getByLabelText("unreadConversation")).toBeInTheDocument();

    const row = screen.getByText("Acme Customer").closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);

    await waitFor(() => {
      expect(onSelectConversation).toHaveBeenCalledWith("conversation-1", {
        messageSearchQuery: null,
        requestPreview: request,
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByLabelText("unreadConversation")
      ).not.toBeInTheDocument();
    });
  });

  it("marks the open conversation read once, not on unrelated realtime updates", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pagination: { totalCount: 0 }, data: [] }),
    }) as typeof fetch;
    const openRow = {
      id: "conversation-open",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Open Customer",
      request: null,
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: false,
    } as RequestItem;
    const props = {
      workspaceId: "workspace-1",
      requests: [openRow],
      initialAvailableChannels: ["whatsapp"],
      initialHasMore: false,
      initialRenderNowMs: new Date("2026-06-23T08:03:00.000Z").getTime(),
      activeConversationId: "conversation-open",
      onSelectConversation: jest.fn(),
      hasConfiguredSources: true,
    };
    const readCalls = () =>
      (global.fetch as jest.Mock).mock.calls.filter(([input]) =>
        String(input).endsWith("/conversation-open/read")
      );

    const { rerender } = render(<DialogListPanel {...props} />);
    await waitFor(() => expect(readCalls()).toHaveLength(1));

    for (let update = 0; update < 3; update++) {
      mockRealtimeState.realtimeRows = [
        { ...openRow, id: `other-${update}`, isReadByManager: true },
      ];
      rerender(<DialogListPanel {...props} />);
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(readCalls()).toHaveLength(1);

    // A message newer than the local read marks the open conversation again.
    mockRealtimeState.realtimeRows = [
      { ...openRow, dateValue: new Date(Date.now() + 60_000).toISOString() },
    ];
    rerender(<DialogListPanel {...props} />);
    await waitFor(() => expect(readCalls()).toHaveLength(2));
  });

  it("warms the shared chat module on hover and focus without fetching conversation data", () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pagination: { totalCount: 0 }, data: [] }),
    }) as typeof fetch;
    const request = {
      id: "conversation-hover",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Hover Customer",
      request: "Please help",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Please help",
    } as RequestItem;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[request]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    const row = screen.getByText("Hover Customer").closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.pointerEnter(row as HTMLElement);
    expect(mockPreloadConversationDetailView).toHaveBeenCalledTimes(1);
    fireEvent.focus(row as HTMLElement);

    const requestedUrls = (global.fetch as jest.Mock).mock.calls.map(
      ([input]) => String(input)
    );
    expect(
      requestedUrls.some(url =>
        url.includes("/api/conversations/conversation-hover")
      )
    ).toBe(false);
    expect(mockPreloadConversationDetail).not.toHaveBeenCalled();
    expect(mockPreloadConversationDetailView).toHaveBeenCalledTimes(2);
  });

  it("preloads the canonical detail request and async chunk on pointer and keyboard intent", async () => {
    const request = {
      id: "conversation-intent",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Intent Customer",
      request: "Please help",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Please help",
    } as RequestItem;
    const onSelectConversation = jest.fn();

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[request]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={onSelectConversation}
        hasConfiguredSources
      />
    );

    const row = screen.getByText("Intent Customer").closest('[role="button"]');
    expect(row).not.toBeNull();

    fireEvent.pointerDown(row as HTMLElement);

    expect(mockPreloadConversationDetailView).toHaveBeenCalledTimes(1);
    expect(mockPreloadConversationDetail).toHaveBeenCalledWith(
      mockSWRMutate,
      "conversation-intent",
      "workspace-1"
    );
    expect(onSelectConversation).not.toHaveBeenCalled();

    fireEvent.click(row as HTMLElement);
    expect(onSelectConversation).toHaveBeenCalledWith("conversation-intent", {
      messageSearchQuery: null,
      requestPreview: request,
    });

    mockPreloadConversationDetail.mockClear();
    mockPreloadConversationDetailView.mockClear();
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });

    expect(mockPreloadConversationDetailView).toHaveBeenCalledTimes(1);
    expect(mockPreloadConversationDetail).toHaveBeenCalledWith(
      mockSWRMutate,
      "conversation-intent",
      "workspace-1"
    );
  });

  it("badges Airi-owned replies and filters them from the tray immediately", async () => {
    const airiRequest = {
      id: "conversation-airi",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Airi Customer",
      request: "Airi handled this",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Airi handled this",
      airiLastReplied: true,
    } as RequestItem;
    const humanRequest = {
      id: "conversation-human",
      dateValue: "2026-06-23T08:01:00.000Z",
      status: "open",
      client: "Human Customer",
      request: "Human followed up",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Human followed up",
      airiLastReplied: false,
    } as RequestItem;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[airiRequest, humanRequest]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    expect(screen.getByText("Airi Customer")).toBeInTheDocument();
    expect(screen.getByText("Human Customer")).toBeInTheDocument();
    expect(screen.getByText("Airi replied")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Airi replied" }));

    await waitFor(() => {
      expect(screen.queryByText("Human Customer")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Airi Customer")).toBeInTheDocument();
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) =>
        String(input).includes("airiReplied=true")
      )
    ).toBe(true);
  });

  it("badges Airi replies only from the server airiLastReplied flag", () => {
    const airiLookingPreview = {
      id: "conversation-airi-looking",
      dateValue: "2026-06-23T08:03:00.000Z",
      status: "open",
      client: "Preview Customer",
      request: "Preview",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Airi: here is your answer",
      airiLastReplied: false,
      lastMessages: [
        {
          direction: "outbound",
          text: "Airi: here is your answer",
          author: { isBot: true },
        },
      ],
    } as RequestItem;
    const templateFollowUp = {
      id: "conversation-template-follow-up",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Template Customer",
      request: "Template follow-up",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Template follow-up",
      lastMessages: [
        {
          direction: "outbound",
          text: "Template follow-up",
          author: { isBot: true },
          whatsappTemplate: { name: "medal_dozhim", languageCode: "ru" },
        },
      ],
    } as RequestItem;
    const flowFollowUp = {
      id: "conversation-flow-follow-up",
      dateValue: "2026-06-23T08:01:00.000Z",
      status: "open",
      client: "Flow Customer",
      request: "Flow follow-up",
      category: null,
      action: null,
      channel: "whatsapp",
      source: "WhatsApp",
      isReadByManager: true,
      lastMessageText: "Open flow",
      lastMessages: [
        {
          direction: "outbound",
          text: "Open flow",
          author: { isBot: true },
          whatsappFlow: { flowId: "flow_1" },
        },
      ],
    } as RequestItem;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[airiLookingPreview, templateFollowUp, flowFollowUp]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    expect(screen.getByText("Preview Customer")).toBeInTheDocument();
    expect(screen.getByText("Template Customer")).toBeInTheDocument();
    expect(screen.getByText("Flow Customer")).toBeInTheDocument();
    expect(screen.queryByText("Airi replied")).not.toBeInTheDocument();
  });

  it("exposes accessible names for filter icon controls", () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pagination: { totalCount: 0 }, data: [] }),
    }) as typeof fetch;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
        isMobile
      />
    );

    const filterButton = screen.getByRole("button", {
      name: "Filters",
    });
    fireEvent.click(filterButton);

    expect(
      screen.getByRole("button", { name: "Close filters" })
    ).toBeInTheDocument();
  });

  it("falls back to message search when storage holds the retired churn-risk mode", async () => {
    window.localStorage.setItem(
      "requests-dialog-search-type",
      JSON.stringify("churn_risk")
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pagination: { totalCount: 0 }, data: [] }),
    }) as typeof fetch;

    try {
      render(
        <DialogListPanel
          workspaceId="workspace-1"
          requests={[]}
          initialAvailableChannels={["whatsapp"]}
          initialHasMore={false}
          initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
          activeConversationId={null}
          onSelectConversation={jest.fn()}
          hasConfiguredSources
        />
      );

      await waitFor(() => {
        expect(
          screen.getByRole("textbox", { name: "searchPlaceholderMessage" })
        ).toBeInTheDocument();
      });
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([input]) =>
          String(input).includes("churnRisk")
        )
      ).toBe(false);
    } finally {
      window.localStorage.removeItem("requests-dialog-search-type");
    }
  });

  it("shows a mobile apply loader while filter results are pending", async () => {
    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
        isMobile
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Airi replied" }));

    const applyButton = await screen.findByRole("button", {
      name: "Applying...",
    });
    expect(applyButton).toHaveAttribute("aria-busy", "true");
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([input]) =>
        String(input).includes("airiReplied=true")
      )
    ).toBe(true);
  });

  it("opens mobile search from the keyboard and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        isMobile
      />
    );

    const searchButton = screen.getByRole("button", {
      name: "searchPlaceholderMessage",
    });
    searchButton.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "searchPlaceholderMessage" })
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "searchTypeMessage" })
    ).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(searchButton).toHaveFocus();
    expect(searchButton).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps mobile filter keyboard focus inside the modal and returns it to its opener", async () => {
    const user = userEvent.setup();
    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        isMobile
      />
    );

    const filterButton = screen.getByRole("button", { name: "Filters" });
    await user.click(filterButton);
    const closeButton = screen.getByRole("button", { name: "Close filters" });
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "applyFilters" })).toHaveFocus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Airi replied" }));
    expect(
      screen.getByRole("button", { name: "Airi replied" })
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(closeButton);
    await waitFor(() => expect(filterButton).toHaveFocus());
  });

  it("does not open the conversation when a nested row control handles Enter", () => {
    const onSelectConversation = jest.fn();
    const request = {
      id: "conversation-keyboard",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Keyboard Customer",
      request: null,
      channel: "whatsapp",
      isReadByManager: true,
      lastMessageText: "Hello",
    } as RequestItem;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[request]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={onSelectConversation}
      />
    );

    fireEvent.keyDown(
      screen.getByRole("button", { name: "Rename conversation" }),
      { key: "Enter" }
    );
    expect(onSelectConversation).not.toHaveBeenCalled();

    const row = screen
      .getByText("Keyboard Customer")
      .closest('[role="button"]');
    fireEvent.keyDown(row!, { key: "Enter" });
    expect(onSelectConversation).toHaveBeenCalledWith(
      "conversation-keyboard",
      expect.any(Object)
    );
  });

  it("names the row status and the badge toggle through the catalog", () => {
    const request = {
      id: "conversation-status",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "in_progress",
      client: "Status Customer",
      request: null,
      category: null,
      action: null,
      channel: "email",
      isReadByManager: true,
      lastMessageText: "Invoice attached",
    } as RequestItem;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[request]}
        initialAvailableChannels={["email"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
      />
    );

    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByText("in progress")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show 1 more badge" })
    ).toBeInTheDocument();
  });

  it("closes mobile filters on desktop resize and focuses the connected desktop search", async () => {
    const user = userEvent.setup();
    const panel = (
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        isMobile
      />
    );
    const view = render(panel);
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();

    view.rerender(React.cloneElement(panel, { isMobile: false }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "searchPlaceholderMessage" })
      ).toHaveFocus()
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    view.rerender(React.cloneElement(panel));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("closes portaled mobile filters when history selects a conversation without restoring hidden-list focus", async () => {
    const user = userEvent.setup();
    const panel = (
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        isMobile
      />
    );
    const view = render(panel);
    const filterButton = screen.getByRole("button", { name: "Filters" });
    await user.click(filterButton);
    const restoreFocus = jest.spyOn(filterButton, "focus");

    // The master/detail history handler passes the new active conversation.
    view.rerender(
      React.cloneElement(panel, { activeConversationId: "conversation-1" })
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(restoreFocus).not.toHaveBeenCalled();

    view.rerender(React.cloneElement(panel));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(filterButton).toHaveAttribute("aria-expanded", "false");
    restoreFocus.mockRestore();
  });

  it("reloads the unfiltered first page after clearing the unread filter", async () => {
    const unreadConversation = {
      _id: "conversation-unread",
      createdAt: "2026-06-23T08:02:00.000Z",
      computedLastMessageAt: "2026-06-23T08:02:00.000Z",
      status: "open",
      channel: "whatsapp",
      user: { _id: "user-1", firstName: "Unread Customer" },
      messages: [
        {
          text: "Need help",
          date: "2026-06-23T08:02:00.000Z",
          direction: "inbound",
        },
      ],
      classification: {},
      is_read_by_manager: false,
    };
    const readConversation = {
      _id: "conversation-read",
      createdAt: "2026-06-23T08:01:00.000Z",
      computedLastMessageAt: "2026-06-23T08:01:00.000Z",
      status: "open",
      channel: "whatsapp",
      user: { _id: "user-2", firstName: "Read Customer" },
      messages: [
        {
          text: "Already handled",
          date: "2026-06-23T08:01:00.000Z",
          direction: "inbound",
        },
      ],
      classification: {},
      is_read_by_manager: true,
    };
    global.fetch = jest.fn(async input => {
      const url = String(input);
      const parsed = new URL(url, "http://localhost");
      const isCountOnly = parsed.searchParams.get("countOnly") === "true";
      const isUnreadOnly = parsed.searchParams.get("unread") === "true";

      return {
        ok: true,
        json: async () =>
          isCountOnly
            ? { pagination: { totalCount: 1 }, data: [] }
            : {
                data: isUnreadOnly
                  ? [unreadConversation]
                  : [unreadConversation, readConversation],
                pagination: { hasNextPage: false },
              },
      } as Response;
    }) as typeof fetch;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    fireEvent.click(screen.getAllByRole("button", { name: /Unread/i })[0]);

    await waitFor(() => {
      expect(screen.getByText(/Unread Customer/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Read Customer/)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /Unread/i })[0]);

    await waitFor(() => {
      expect(screen.getByText(/Read Customer/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Unread Customer/)).toBeInTheDocument();
  });

  it("hydrates the first page on mount when the SSR read failed", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({
        data: [
          {
            _id: "hydrated-row",
            createdAt: "2026-06-23T08:02:00.000Z",
            computedLastMessageAt: "2026-06-23T08:02:00.000Z",
            status: "open",
            channel: "whatsapp",
            user: { _id: "user-1", firstName: "Hydrated Customer" },
            messages: [],
          },
        ],
        pagination: { hasNextPage: false, totalCount: 1 },
      })
    ) as typeof fetch;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        shouldHydrateFromApiOnMount
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    // The motion mock remounts rows on every render, so re-query each time.
    await waitFor(() => {
      expect(screen.getByText(/Hydrated Customer/)).toBeInTheDocument();
    });
  });

  it("shows the end-of-list footer from the loaded page, not the SSR hasMore flag", async () => {
    // The SSR page claimed more rows, so the load-more sentinel is observed.
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    const row = {
      _id: "only-row",
      createdAt: "2026-06-23T08:02:00.000Z",
      computedLastMessageAt: "2026-06-23T08:02:00.000Z",
      status: "open",
      channel: "whatsapp",
      user: { _id: "user-1", firstName: "Only Customer" },
      messages: [],
      is_read_by_manager: false,
    };
    global.fetch = jest.fn(async () =>
      jsonResponse({
        data: [row],
        pagination: { hasNextPage: false, totalCount: 1 },
      })
    ) as typeof fetch;

    try {
      render(
        <DialogListPanel
          workspaceId="workspace-1"
          requests={[]}
          initialAvailableChannels={["whatsapp"]}
          initialHasMore
          initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
          activeConversationId={null}
          onSelectConversation={jest.fn()}
          hasConfiguredSources
        />
      );

      // Toggle a filter on and off: the unfiltered reload reports no next page.
      fireEvent.click(screen.getAllByRole("button", { name: /Unread/i })[0]);
      await screen.findByText(/Only Customer/);
      fireEvent.click(screen.getAllByRole("button", { name: /Unread/i })[0]);

      await waitFor(() => {
        expect(screen.getByText("No more conversations")).toBeInTheDocument();
      });
    } finally {
      globalThis.IntersectionObserver = originalIntersectionObserver;
    }
  });

  it("shows unread filter loading state and syncs the badge from unread results", async () => {
    const unreadResults = createDeferred<Response>();
    global.fetch = jest.fn(input => {
      const parsed = new URL(String(input), "http://localhost");
      const isCountOnly = parsed.searchParams.get("countOnly") === "true";
      const isUnreadOnly = parsed.searchParams.get("unread") === "true";

      if (isCountOnly) {
        return Promise.resolve(
          jsonResponse({ pagination: { totalCount: 2 }, data: [] })
        );
      }

      if (isUnreadOnly) {
        return unreadResults.promise;
      }

      return Promise.resolve(
        jsonResponse({ data: [], pagination: { hasNextPage: false } })
      );
    }) as typeof fetch;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
        hasConfiguredSources
      />
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /Unread\s*2/i }).length
      ).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: /Unread/i })[0]);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading conversations..."
    );
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(
      screen.queryByText("No conversations found")
    ).not.toBeInTheDocument();

    unreadResults.resolve(
      jsonResponse({
        data: [],
        pagination: { hasNextPage: false, totalCount: 0 },
      })
    );

    await waitFor(() => {
      expect(screen.getByText("No conversations found")).toBeInTheDocument();
    });
    expect(screen.queryAllByText("2")).toHaveLength(0);
  });
});

describe("DialogListPanel plan gate banner", () => {
  beforeEach(() => {
    mockRealtimeState.realtimeRows = [];
    mockSearchParams = new URLSearchParams();
    global.fetch = jest.fn(() => new Promise(() => {})) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it.each([
    [
      "trial_expired" as const,
      "Your 14-day Free trial has ended.",
      "New WhatsApp messages and new chats aren't saved until you upgrade.",
    ],
    [
      "conversation_limit" as const,
      "12 conversations are hidden by your plan.",
      "New chats aren't saved until you upgrade.",
    ],
  ])(
    "tells %s workspaces which new data is not saved",
    (reason, title, intakeLine) => {
      render(
        <DialogListPanel
          workspaceId="workspace-1"
          requests={[]}
          initialAvailableChannels={["whatsapp"]}
          initialHasMore={false}
          initialPlanGate={{
            reason,
            hiddenCount: 12,
            limit: { subscriptionType: "free" } as never,
          }}
          initialRenderNowMs={1_700_000_000_000}
          activeConversationId={null}
          onSelectConversation={jest.fn()}
        />
      );

      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(intakeLine)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Upgrade" })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/New inbound data is still being collected/)
      ).not.toBeInTheDocument();
    }
  );

  it("uses the singular for one hidden conversation", () => {
    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialPlanGate={{
          reason: "conversation_limit",
          hiddenCount: 1,
          limit: { subscriptionType: "free" } as never,
        }}
        initialRenderNowMs={1_700_000_000_000}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
      />
    );

    expect(
      screen.getByText("1 conversation is hidden by your plan.")
    ).toBeInTheDocument();
  });

  it("still explains refused new chats at the cap when nothing is hidden yet", () => {
    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialPlanGate={{
          reason: "conversation_limit",
          hiddenCount: 0,
          limit: { subscriptionType: "free" } as never,
        }}
        initialRenderNowMs={1_700_000_000_000}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
      />
    );

    expect(
      screen.getByText("New chats aren't saved until you upgrade.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/conversations are hidden/)
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
  });
});

describe("DialogListPanel unnamed rows", () => {
  it("names rows nothing identifies with the translated placeholders", () => {
    const rows = [
      {
        id: "conversation-widget",
        dateValue: "2026-06-23T08:02:00.000Z",
        status: "open",
        client: "",
        channel: "web_widget",
        isReadByManager: true,
        lastMessageText: "Hi",
      },
      {
        id: "conversation-group",
        dateValue: "2026-06-23T08:01:00.000Z",
        status: "open",
        client: "",
        channel: "telegram",
        chatType: "supergroup",
        isReadByManager: true,
        lastMessageText: "Hello team",
      },
    ] as unknown as RequestItem[];

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={rows}
        initialAvailableChannels={["web_widget", "telegram"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
      />
    );

    expect(screen.getByText("Клиент")).toBeInTheDocument();
    expect(screen.getByText("Группа Telegram")).toBeInTheDocument();
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });
});

describe("DialogListPanel row avatar", () => {
  it("shows the same initials as the conversation header", () => {
    const request = {
      id: "conversation-initials",
      dateValue: "2026-06-23T08:02:00.000Z",
      status: "open",
      client: "Айгерим Нурланова",
      channel: "whatsapp",
      isReadByManager: true,
      lastMessageText: "Hello",
    } as unknown as RequestItem;

    render(
      <DialogListPanel
        workspaceId="workspace-1"
        requests={[request]}
        initialAvailableChannels={["whatsapp"]}
        initialHasMore={false}
        initialRenderNowMs={new Date("2026-06-23T08:03:00.000Z").getTime()}
        activeConversationId={null}
        onSelectConversation={jest.fn()}
      />
    );

    expect(screen.getByText("АН")).toBeInTheDocument();
    expect(screen.queryByText("АЙ")).not.toBeInTheDocument();
  });
});
