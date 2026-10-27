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
import { WhatsAppTemplatesManager } from "./templates-manager";
import { invalidateWhatsAppTemplateCatalog } from "@/lib/whatsapp/templates/catalog-client";

const mockGetUnifiedTemplatesAction = jest.fn();
const mockSyncTemplatesAction = jest.fn();
const mockRouterReplace = jest.fn();
let mockSearchParams = new URLSearchParams();
const mockMessages: Record<string, string> = {
  "alerts.fetchFailed": "Failed to fetch templates",
  "alerts.loadFailed": "Failed to load templates",
  "alerts.savedTemplates":
    "Showing saved templates. Meta refresh is temporarily unavailable; approval status may have changed.",
  "alerts.refreshCooldown":
    "Meta is limiting refreshes. Try again after {time}.",
  connectRequiredAction: "Connect WhatsApp",
  connectRequiredCreateDisabled: "Connect WhatsApp before creating templates.",
  connectRequiredDescription:
    "Connect a WhatsApp Business account before creating or syncing message templates.",
  connectRequiredTitle: "Connect WhatsApp first",
  create: "Create",
  filterByStatus: "Filter by status",
  search: "Search for templates...",
  "statuses.all": "All Statuses",
  "statuses.approved": "Approved",
  "statuses.paused": "Paused",
  "statuses.pending": "Pending",
  "statuses.rejected": "Rejected",
  sync: "Sync from Meta",
  "tabs.all": "All",
  "tabs.both": "Both",
  "tabs.telegram": "Telegram",
  "tabs.whatsapp": "WhatsApp",
};
const mockTranslate = (key: string, values?: Record<string, unknown>) => {
  const template = mockMessages[key] ?? key;
  if (!values) return template;
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template
  );
};

jest.mock("@/features/panel/messengers/whatsapp-templates/actions", () => ({
  getUnifiedTemplatesAction: (...args: unknown[]) =>
    mockGetUnifiedTemplatesAction(...args),
  syncTemplatesAction: (...args: unknown[]) => mockSyncTemplatesAction(...args),
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/panel/w/workspace-1/messengers/whatsapp/templates",
  useRouter: () => ({
    replace: mockRouterReplace,
  }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("./templates-table", () => ({
  TemplatesTable: (props: {
    canCreateTemplates?: boolean;
    createIntentToken?: number;
    createDisabledReason?: string;
    onRefresh?: () => void;
    templates?: Array<{
      name: string;
      components?: Array<{ text?: string }>;
      isOnCurrentWaba?: boolean;
      canSwitchToCurrentWaba?: boolean;
    }>;
  }) => (
    <div
      data-testid="templates-table"
      data-can-create={String(props.canCreateTemplates)}
      data-create-intent={String(props.createIntentToken ?? 0)}
      data-template-count={String(props.templates?.length ?? 0)}
    >
      {props.createDisabledReason}
      {props.templates?.map(template => (
        <span
          key={template.name}
          data-body={template.components?.[0]?.text}
          data-current-waba={String(template.isOnCurrentWaba)}
          data-can-switch={String(template.canSwitchToCurrentWaba)}
        >
          {template.name}
        </span>
      ))}
      <button onClick={props.onRefresh}>Refresh template list</button>
    </div>
  ),
}));

const originalFetch = global.fetch;

describe("WhatsAppTemplatesManager connection readiness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateWhatsAppTemplateCatalog();
    window.history.replaceState(null, "", "/");
    mockSearchParams = new URLSearchParams();
    mockGetUnifiedTemplatesAction.mockResolvedValue({
      success: true,
      data: { templates: [] },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("shows a connect prompt and disables template creation when WhatsApp is not connected", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        code: "whatsapp_not_connected",
        requiresWhatsAppConnection: true,
        templates: [],
      }),
    }) as typeof fetch;

    render(<WhatsAppTemplatesManager workspaceId="workspace-1" />);

    expect(
      await screen.findByText("Connect WhatsApp first")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect a WhatsApp Business account before creating or syncing message templates."
      )
    ).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Sync from Meta" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect WhatsApp" })
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations?integration=whatsapp"
    );
    expect(screen.queryByTestId("templates-table")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(mockGetUnifiedTemplatesAction).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByText("Failed to load templates")
    ).not.toBeInTheDocument();
  });

  it("does not refetch Meta templates when only the local status filter changes", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        templates: [
          {
            id: "approved-template",
            name: "approved_template",
            language: "en",
            category: "MARKETING",
            status: "APPROVED",
            components: [{ type: "BODY", text: "Approved" }],
          },
          {
            id: "pending-template",
            name: "pending_template",
            language: "en",
            category: "MARKETING",
            status: "PENDING",
            components: [{ type: "BODY", text: "Pending" }],
          },
        ],
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    render(<WhatsAppTemplatesManager workspaceId="workspace-1" />);

    expect(await screen.findByTestId("templates-table")).toHaveAttribute(
      "data-template-count",
      "2"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/whatsapp/templates?workspaceId=workspace-1",
      { cache: "no-store" }
    );

    act(() => {
      window.history.replaceState(
        null,
        "",
        "/panel/w/workspace-1/messengers/whatsapp/templates?status=APPROVED"
      );
      window.dispatchEvent(new Event("popstate"));
    });

    expect(await screen.findByTestId("templates-table")).toHaveAttribute(
      "data-template-count",
      "1"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent initial template loads for the same workspace", async () => {
    let resolveFetch: (value: {
      ok: true;
      json: () => Promise<{ templates: [] }>;
    }) => void = () => undefined;
    const fetchMock = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        })
    );
    global.fetch = fetchMock as typeof fetch;

    render(
      <>
        <WhatsAppTemplatesManager workspaceId="workspace-1" />
        <WhatsAppTemplatesManager workspaceId="workspace-1" />
      </>
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    resolveFetch({
      ok: true,
      json: async () => ({ templates: [] }),
    });

    await waitFor(() => {
      expect(mockGetUnifiedTemplatesAction).toHaveBeenCalledTimes(1);
    });
  });

  it("does not replace the URL when the search query already matches local state", async () => {
    mockSearchParams = new URLSearchParams("search=ready");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [] }),
    }) as typeof fetch;

    render(<WhatsAppTemplatesManager workspaceId="workspace-1" />);

    expect(await screen.findByTestId("templates-table")).toBeInTheDocument();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it("opens the create drawer once from ?create=1 and clears the param", async () => {
    window.history.replaceState(
      null,
      "",
      "/panel/w/workspace-1/messengers/whatsapp/templates?create=1&status=approved"
    );
    mockSearchParams = new URLSearchParams("create=1&status=approved");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [] }),
    }) as typeof fetch;

    render(<WhatsAppTemplatesManager workspaceId="workspace-1" />);

    const table = await screen.findByTestId("templates-table");
    expect(table).toHaveAttribute("data-create-intent", "1");
    await waitFor(() => {
      expect(window.location.search).toBe("?status=approved");
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it("updates the search URL without routing when clearing search", async () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("search=ready");
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ templates: [] }),
    }) as typeof fetch;

    render(<WhatsAppTemplatesManager workspaceId="workspace-1" />);

    const searchInput = await screen.findByPlaceholderText(
      "Search for templates..."
    );
    fireEvent.change(searchInput, { target: { value: "" } });

    act(() => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(window.location.href).toBe(
        "http://localhost/panel/w/workspace-1/messengers/whatsapp/templates"
      );
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("starts Meta and unified template loads concurrently", async () => {
    let unifiedStarted = false;
    let resolveFetch: (value: {
      ok: true;
      json: () => Promise<{ templates: [] }>;
    }) => void = () => undefined;
    const fetchMock = jest.fn(
      () =>
        new Promise(resolve => {
          resolveFetch = resolve;
        })
    );
    global.fetch = fetchMock as typeof fetch;
    mockGetUnifiedTemplatesAction.mockImplementation(() => {
      unifiedStarted = true;
      return Promise.resolve({
        success: true,
        data: { templates: [] },
      });
    });

    render(<WhatsAppTemplatesManager workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(unifiedStarted).toBe(true);

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ templates: [] }),
      });
    });
  });

  it("shows saved templates and an honest warning when Meta is rate limited", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: "Meta is throttled",
        code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
        providerCode: 80008,
        retryAt: "2099-10-06T13:00:00.000Z",
      }),
    }) as typeof fetch;
    mockGetUnifiedTemplatesAction.mockResolvedValue({
      success: true,
      data: {
        templates: [
          {
            id: "local-1",
            name: "saved_offer",
            channel: "whatsapp",
            whatsapp_data: {
              language: "en",
              status: "APPROVED",
              components: [{ type: "BODY", text: "Saved" }],
            },
          },
        ],
      },
    });
    render(<WhatsAppTemplatesManager workspaceId="fallback-manager" />);
    expect(await screen.findByText("saved_offer")).toBeInTheDocument();
    expect(
      screen.getByText(mockMessages["alerts.savedTemplates"])
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sync from Meta" })
    ).toBeDisabled();
  });

  it.each([false, true])(
    "retains prior Meta rows during failed refresh with partial local rows: %s",
    async hasLocalRow => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            templates: [
              {
                id: "meta-only",
                name: "meta_only",
                language: "en",
                status: "APPROVED",
                components: [{ type: "BODY", text: "Meta-only copy" }],
              },
              {
                id: "shared",
                name: "shared_offer",
                language: "en",
                status: "APPROVED",
                components: [{ type: "BODY", text: "Old copy" }],
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          json: async () => ({
            code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
            providerCode: 80008,
            retryAt: "2099-10-06T13:00:00.000Z",
          }),
        }) as typeof fetch;
      mockGetUnifiedTemplatesAction
        .mockResolvedValueOnce({ success: true, data: { templates: [] } })
        .mockResolvedValueOnce({
          success: true,
          data: {
            templates: hasLocalRow
              ? [
                  {
                    id: "local-shared",
                    name: "shared_offer",
                    channel: "whatsapp",
                    whatsapp_data: {
                      language: "en",
                      status: "PENDING",
                      components: [
                        { type: "BODY", text: "Current saved copy" },
                      ],
                    },
                  },
                ]
              : [],
          },
        });
      render(<WhatsAppTemplatesManager workspaceId="retain-meta-rows" />);
      await screen.findByText("meta_only");
      fireEvent.click(
        screen.getByRole("button", { name: "Refresh template list" })
      );
      await screen.findByText(mockMessages["alerts.savedTemplates"]);
      expect(screen.getByTestId("templates-table")).toHaveAttribute(
        "data-template-count",
        "2"
      );
      expect(screen.getByText("meta_only")).toHaveAttribute(
        "data-current-waba",
        "undefined"
      );
      expect(screen.getByText("meta_only")).toHaveAttribute(
        "data-can-switch",
        "false"
      );
      expect(screen.getByText("shared_offer")).toHaveAttribute(
        "data-body",
        hasLocalRow ? "Current saved copy" : "Old copy"
      );
    }
  );

  it("adopts a successful Sync response without listing Meta again", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        templates: [
          {
            id: "old",
            name: "old_offer",
            language: "en",
            status: "APPROVED",
            components: [],
          },
        ],
      }),
    });
    global.fetch = fetchMock as typeof fetch;
    mockSyncTemplatesAction.mockResolvedValue({
      success: true,
      data: {
        synced: 1,
        errors: 0,
        templates: [
          {
            id: "new",
            name: "new_offer",
            language: "en",
            status: "APPROVED",
            components: [],
          },
        ],
        catalog: {
          source: "live",
          stale: false,
          fetchedAt: "2026-10-06T12:00:00.000Z",
          wabaId: "waba",
          refreshOutcome: "succeeded",
          retryAt: null,
        },
      },
    });
    render(<WhatsAppTemplatesManager workspaceId="sync-manager" />);
    await screen.findByText("old_offer");
    fireEvent.click(screen.getByRole("button", { name: "Sync from Meta" }));
    expect(await screen.findByText("new_offer")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a previous workspace failure after the new workspace loaded", async () => {
    let rejectOld!: (error: Error) => void;
    const oldRequest = new Promise<Response>((_, reject) => {
      rejectOld = reject;
    });
    global.fetch = jest.fn().mockImplementation((url: string) =>
      url.includes("workspace-old")
        ? oldRequest
        : Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              templates: [
                {
                  id: "current",
                  name: "current_offer",
                  language: "en",
                  status: "APPROVED",
                  components: [],
                },
              ],
            }),
          })
    ) as typeof fetch;
    const { rerender } = render(
      <WhatsAppTemplatesManager workspaceId="workspace-old" />
    );
    rerender(<WhatsAppTemplatesManager workspaceId="workspace-new" />);
    await screen.findByText("current_offer");
    await act(async () => rejectOld(new Error("Late old workspace error")));
    expect(
      screen.queryByText("Late old workspace error")
    ).not.toBeInTheDocument();
    expect(screen.getByText("current_offer")).toBeInTheDocument();
  });

  it("preserves shown templates and disables repeated Sync after a rate-limit response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        templates: [
          {
            id: "saved",
            name: "shown_offer",
            language: "en",
            status: "APPROVED",
            components: [],
          },
        ],
      }),
    }) as typeof fetch;
    mockSyncTemplatesAction.mockResolvedValue({
      success: false,
      error: "Throttled",
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      retryAt: "2099-10-06T13:00:00.000Z",
    });
    render(<WhatsAppTemplatesManager workspaceId="sync-limit" />);
    await screen.findByText("shown_offer");
    fireEvent.click(screen.getByRole("button", { name: "Sync from Meta" }));
    await screen.findByText(mockMessages["alerts.savedTemplates"]);
    expect(
      screen.getByRole("button", { name: "Sync from Meta" })
    ).toBeDisabled();
    expect(screen.getByText("shown_offer")).toBeInTheDocument();
    expect(
      screen.getByText(mockMessages["alerts.savedTemplates"])
    ).toBeInTheDocument();
  });
});
