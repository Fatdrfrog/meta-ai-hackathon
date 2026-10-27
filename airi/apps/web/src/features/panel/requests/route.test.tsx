/**
 * @jest-environment jsdom
 */
import { TextDecoder, TextEncoder } from "node:util";

Object.assign(globalThis, { TextDecoder, TextEncoder });

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const mockGetRequestsData = jest.fn();
const mockGetReadOnlySupabaseContext = jest.fn();
const mockGetWorkspaceSourceReadiness = jest.fn();
const mockLoadMessages = jest.fn();
const mockGetLocale = jest.fn();
const mockLoggerError = jest.fn();
const mockRedirect = jest.fn();
const mockMasterDetailProps = jest.fn();

jest.mock("@/features/panel/requests/data-projection", () => ({
  getRequestsData: (...args: unknown[]) => mockGetRequestsData(...args),
}));

jest.mock("@/features/panel/shared/workspace", () => ({
  getReadOnlySupabaseContext: (...args: unknown[]) =>
    mockGetReadOnlySupabaseContext(...args),
}));

jest.mock("@/features/panel/shared/workspace/source-readiness", () => ({
  getWorkspaceSourceReadiness: (...args: unknown[]) =>
    mockGetWorkspaceSourceReadiness(...args),
}));

jest.mock("@/i18n/message-loader", () => ({
  getLocaleFromCookie: (...args: unknown[]) => mockGetLocale(...args),
  loadConversationsClientMessages: (...args: unknown[]) =>
    mockLoadMessages(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

jest.mock("@/components/i18n/scoped-intl-provider", () => ({
  ScopedIntlProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("@/components/tables/requests-realtime-provider", () => ({
  RequestsRealtimeProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock("@/components/tables/requests-realtime", () => ({
  RequestsRealtime: () => null,
}));

jest.mock("@/components/requests/requests-master-detail-layout", () => ({
  RequestsMasterDetailLayout: (props: Record<string, unknown>) => {
    mockMasterDetailProps(props);
    return (
      <div data-testid="requests-layout">
        {Array.isArray(props.initialRequests)
          ? props.initialRequests.length
          : -1}
      </div>
    );
  },
}));

jest.mock("@/features/panel/requests/formatting", () => ({
  formatConversationToRequest: (row: { _id: string }) => ({ id: row._id }),
}));

jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ResizableHandle: () => null,
}));

import PageRequests from "./route";
import RequestsLoading from "./loading";

const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
const userId = "user-1";
const conversationId = "65f000000000000000000001";

function pagination() {
  return {
    page: 1,
    limit: 50,
    totalCount: 1,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  };
}

async function renderRequestsPage() {
  return render(
    await PageRequests({
      params: Promise.resolve({ workspaceId }),
      searchParams: Promise.resolve({}),
    })
  );
}

describe("Requests SSR page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLocale.mockResolvedValue("en");
    mockLoadMessages.mockResolvedValue({});
    mockGetReadOnlySupabaseContext.mockResolvedValue({
      supabase: { kind: "controlled-supabase" },
      user: { id: userId },
    });
    mockGetWorkspaceSourceReadiness.mockResolvedValue({
      hasConfiguredSources: true,
    });
  });

  it("loads the first page with filter options for the workspace", async () => {
    mockGetRequestsData.mockResolvedValue({
      data: [{ _id: conversationId }],
      pagination: pagination(),
      availableChannels: [],
      availableCategories: [],
    });

    await renderRequestsPage();

    expect(mockGetRequestsData).toHaveBeenCalledWith(
      workspaceId,
      { status: null, filter: null },
      expect.anything(),
      { includeChannels: true }
    );
    expect(screen.getByTestId("requests-layout").textContent).toBe("1");
  });

  it("renders populated requests before source readiness resolves and forwards only its boolean", async () => {
    let resolveReadiness!: (value: {
      hasConfiguredSources: boolean;
      configuredSources: unknown[];
    }) => void;
    mockGetWorkspaceSourceReadiness.mockReturnValue(
      new Promise(resolve => {
        resolveReadiness = resolve;
      })
    );
    mockGetRequestsData.mockResolvedValue({
      data: [{ _id: conversationId }],
      pagination: pagination(),
    });

    let page: ReactNode;
    const pendingPage = PageRequests({
      params: Promise.resolve({ workspaceId }),
      searchParams: Promise.resolve({}),
    }).then(result => {
      page = result;
    });

    try {
      await waitFor(() => expect(page).toBeDefined());
      render(page);
      expect(screen.getByTestId("requests-layout").textContent).toBe("1");
    } finally {
      resolveReadiness({
        hasConfiguredSources: false,
        configuredSources: [{ credentials: "server-only-secret" }],
      });
      await pendingPage;
    }

    const props = mockMasterDetailProps.mock.calls[0]?.[0];
    await expect(props.hasConfiguredSources).resolves.toBe(false);
    expect(JSON.stringify(props)).not.toContain("server-only-secret");
  });

  it("preserves browser pinch zoom in both loading and loaded inboxes", async () => {
    const loading = render(<RequestsLoading />);
    expect(
      loading.container.querySelector(".touch-pan-y, .touch-none")
    ).toBeNull();
    loading.unmount();

    mockGetRequestsData.mockResolvedValue({
      data: [],
      pagination: pagination(),
    });
    const loaded = await renderRequestsPage();
    expect(
      loaded.container.querySelector(".touch-pan-y, .touch-none")
    ).toBeNull();
  });

  it("falls back to client hydration without logging the raw workspace", async () => {
    mockGetRequestsData.mockRejectedValue(new Error("list_load_failed"));

    await renderRequestsPage();

    expect(screen.getByTestId("requests-layout").textContent).toBe("0");
    expect(mockMasterDetailProps.mock.calls[0]?.[0]).toMatchObject({
      initialRequests: [],
      shouldHydrateFromApiOnMount: true,
    });
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(
      workspaceId
    );
  });
});
