/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { SWRConfig } from "swr";
import { CustomersPage } from "./customers-page";

const mockReplace = jest.fn();
let mockSearchParams = new URLSearchParams();

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: (
    loader: () => Promise<unknown>,
    options?: { loading?: () => unknown }
  ) => {
    function DynamicMock(props: Record<string, unknown>) {
      const [Component, setComponent] = React.useState<unknown>(null);

      React.useEffect(() => {
        let mounted = true;
        void loader().then(loaded => {
          const resolved =
            loaded && typeof loaded === "object" && "default" in loaded
              ? (loaded as { default?: unknown }).default
              : loaded;
          if (mounted) setComponent(() => resolved);
        });
        return () => {
          mounted = false;
        };
      }, []);

      if (Component) {
        return React.createElement(Component as never, props);
      }

      return options?.loading
        ? React.createElement(React.Fragment, null, options.loading() as never)
        : null;
    }

    return DynamicMock;
  },
}));

jest.mock("./customer-detail-sheet", () => ({
  CustomerDetailSheet: () => null,
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("next-intl", () =>
  jest.requireActual("./leads-i18n.test-mock").mockLeadsTranslations()
);

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock("./crm-workspace-realtime", () => ({
  CrmWorkspaceRealtime: () => null,
}));

// Radix menus need real pointer events; render the filters menu inline with
// its item roles so tests can toggle options directly.
jest.mock("@/components/ui/dropdown-menu", () => {
  const ReactActual = jest.requireActual("react") as typeof React;
  const RadioContext = ReactActual.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  }>({});
  const passthrough = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div role="menu">{children}</div>
    ),
    DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      onSelect?: (event: Event) => void;
    }) => (
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => onSelect?.(new Event("select"))}
      >
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({
      children,
      checked,
      disabled,
      onCheckedChange,
    }: {
      children: React.ReactNode;
      checked?: boolean;
      disabled?: boolean;
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={Boolean(checked)}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {children}
      </button>
    ),
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
    }) => (
      <RadioContext.Provider value={{ value, onValueChange }}>
        <div role="group">{children}</div>
      </RadioContext.Provider>
    ),
    DropdownMenuRadioItem: function MockRadioItem({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) {
      const radio = ReactActual.useContext(RadioContext);
      return (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={radio.value === value}
          onClick={() => radio.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

function renderLeadsPage() {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        revalidateOnFocus: false,
        shouldRetryOnError: false,
      }}
    >
      <CustomersPage workspaceId="workspace-1" />
    </SWRConfig>
  );
}

describe("CustomersPage leads copy", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    mockReplace.mockClear();
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/crm/board")) {
        return {
          ok: true,
          json: async () => ({
            stages: [
              {
                id: "system-unassigned",
                key: "unassigned",
                name: "Unassigned",
                color: null,
                sortOrder: -1,
                isActive: true,
              },
              {
                id: "stage-qualified",
                key: "qualified",
                name: "Qualified",
                color: "#7c3aed",
                sortOrder: 1,
                isActive: true,
              },
            ],
            columns: [
              {
                stageKey: "unassigned",
                totalCount: 0,
                nextCursor: null,
                cards: [],
              },
              {
                stageKey: "qualified",
                totalCount: 1,
                nextCursor: null,
                cards: [
                  {
                    id: "customer-1",
                    displayName: "Acme buyer",
                    status: "active",
                    stageKey: "qualified",
                    primaryConversationId: "conversation-1",
                    lastInteractionAt: "2026-06-20T08:00:00.000Z",
                    createdAt: "2026-06-18T08:00:00.000Z",
                    channels: ["whatsapp"],
                    contactPoints: {
                      emails: ["buyer@example.com"],
                      phones: [],
                      usernames: [],
                    },
            conversationCount: 2,
            estimatedCustomerLtv: 1200,
            sentiment: "positive",
            churnRiskLevel: null,
            lastInboundAt: "2026-06-20T08:00:00.000Z",
            slaDueAt: null,
            category: "Sales",
            nextAction: null,
            attention: ["needs_reply"],
          },
                ],
              },
            ],
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({
          customers: [],
          pagination: {
            page: 1,
            limit: 50,
            totalCount: 0,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false,
          },
          availableFunnelStages: [],
        }),
      } as Response;
    }) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the section as Leads with Kanban Board first and default", async () => {
    renderLeadsPage();

    await waitFor(() => {
      expect(screen.getByText("Leads")).toBeTruthy();
    });
    expect(screen.getByLabelText("Search leads")).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].textContent).toContain("Kanban Board");
    expect(tabs[1].textContent).toContain("List");
    expect(tabs[0].getAttribute("data-state")).toBe("active");
    expect(await screen.findByText("Qualified")).toBeTruthy();
    expect(screen.getByText("Acme buyer")).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/workspace-1/crm/board")
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("attention=attention")
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/customers?")
    );
    expect(screen.getByRole("radio", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Needs reply" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ghosted" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Stalled" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All" })).toBeTruthy();
    // Secondary filters live in one Filters menu, Trello-style.
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Sales only" })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Show support" })
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "My leads" })
    ).toBeTruthy();
    // The board reports its total to the one-row toolbar next to the title.
    expect(await screen.findByText("1 lead needs attention")).toBeTruthy();
  });

  it("renders the list view from URL state", async () => {
    mockSearchParams = new URLSearchParams("view=list");

    renderLeadsPage();

    await waitFor(() => {
      expect(screen.getByText("No leads found")).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: /Kanban Board/i })).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/customers?")
    );
    expect(screen.queryByRole("radio", { name: "Needs attention" })).toBeNull();
  });

  it("scrolls the list inside its own box with the footer always visible", async () => {
    mockSearchParams = new URLSearchParams("view=list");
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        customers: [
          {
            _id: "customer-1",
            displayName: null,
            status: "active",
            currentFunnelStage: null,
            lastInteractionAt: null,
            createdAt: null,
            profileSummary: {
              channels: ["whatsapp"],
              contactPoints: { emails: [], phones: ["+77011234567"] },
            },
            behavioralProfile: null,
          },
        ],
        pagination: {
          page: 1,
          limit: 50,
          totalCount: 1,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: false,
        },
        availableFunnelStages: [],
      }),
    })) as jest.Mock;

    renderLeadsPage();

    // WhatsApp leads usually have only a phone; the board already shows it.
    expect(await screen.findByText("+77011234567")).toBeTruthy();
    expect(screen.getByText("Unknown lead")).toBeTruthy();
    expect(screen.getByText("1 lead")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();

    // A block tab panel let the table grow past the clipped panel, so rows,
    // pagination and the table's x-scrollbar were unreachable.
    expect(
      screen.getByTestId("leads-list-panel").className.split(/\s+/)
    ).toEqual(
      expect.arrayContaining(["flex", "flex-col", "min-h-0", "flex-1"])
    );
    const scroller = screen.getByTestId("leads-list-scroller").className;
    expect(scroller).toContain("overflow-auto");
    expect(scroller).toContain(
      "[&>[data-slot=table-container]]:overflow-visible"
    );
  });

  it("keeps the toolbar to one row and moves queues below on narrow screens", async () => {
    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    // No page description or separate count row above the board.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Leads");
    expect(screen.queryByText(/Work the chats that go cold/)).toBeNull();
    const searchRow =
      screen.getByLabelText("Search leads").parentElement?.parentElement
        ?.className ?? "";
    expect(searchRow).toContain("ml-auto");
    expect(searchRow).toContain("max-sm:w-full");
    const attentionClasses = screen
      .getByRole("group", { name: "Filter leads by attention" })
      .className.split(/\s+/);
    expect(attentionClasses).not.toContain("flex-wrap");
    expect(attentionClasses).toEqual(
      expect.arrayContaining([
        "order-last",
        "md:order-none",
        "max-md:overflow-x-auto",
      ])
    );
  });

  it("focuses search on / unless the user is typing", async () => {
    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    const search = screen.getByLabelText("Search leads");
    expect(search.getAttribute("aria-keyshortcuts")).toBe("/");

    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
    other.remove();

    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(search);
  });

  it("counts active filters on the Filters button and clears them", async () => {
    mockSearchParams = new URLSearchParams("owner=me&salesOnly=1");

    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filters (2)" })).toBeTruthy();
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "My leads" })
        .getAttribute("aria-checked")
    ).toBe("true");
    // Show support is meaningless while only sales chats are shown.
    expect(
      (
        screen.getByRole("menuitemcheckbox", {
          name: "Show support",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "Clear filters" }));
    const cleared = mockReplace.mock.calls.at(-1)?.[0] as string;
    expect(cleared).not.toContain("owner=");
    expect(cleared).not.toContain("salesOnly=");
  });

  it("renders the CRM kanban board from URL state", async () => {
    mockSearchParams = new URLSearchParams("view=board");

    renderLeadsPage();

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Kanban Board/i })).toBeTruthy();
    });
    expect(await screen.findByText("Qualified")).toBeTruthy();
    expect(screen.getByText("Acme buyer")).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/workspaces/workspace-1/crm/board")
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("limitPerStage=10")
    );
    expect(screen.getByTestId("crm-pipeline-board").className).toContain(
      "overflow-hidden"
    );
    expect(screen.getByTestId("crm-pipeline-columns").className).toContain(
      "overflow-y-hidden"
    );
    expect(
      screen.getByTestId("crm-pipeline-column-cards-qualified").className
    ).toContain("overflow-y-auto");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("attention=attention")
    );
  });

  it("writes attention and salesOnly into the board URL", async () => {
    mockSearchParams = new URLSearchParams("attention=ghosted&salesOnly=1");

    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("attention=ghosted")
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("salesOnly=1")
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("support=1")
    );
  });

  it("includes Support chats when Show support is in the URL", async () => {
    mockSearchParams = new URLSearchParams("support=1");

    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("support=1")
    );
  });

  it("writes All and Sales only into the page URL", async () => {
    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("attention=all"));

    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Sales only" })
    );
    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringContaining("salesOnly=1")
    );
  });

  it("writes My leads into the board URL", async () => {
    renderLeadsPage();

    expect(await screen.findByText("Acme buyer")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "My leads" }));
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("owner=me"));
  });
});
