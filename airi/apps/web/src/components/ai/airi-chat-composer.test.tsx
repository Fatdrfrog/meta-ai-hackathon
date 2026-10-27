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
import { afterNextPaint } from "@/lib/composer/mention";
import { AiriChatComposer } from "./airi-chat-composer";
import type { MetaAdsMcpReadiness } from "@icecore/shared/types/sources";

const mockConnectMetaAdsMcp = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastWarning = jest.fn();
const mockToastError = jest.fn();

jest.mock("@/lib/meta-ads/connect-meta-ads-mcp-client", () => ({
  connectMetaAdsMcpViaFacebookSdk: (...args: unknown[]) =>
    mockConnectMetaAdsMcp(...args),
}));

jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mcpReadiness: MetaAdsMcpReadiness = {
  state: "ready",
  grantedScopes: ["ads_mcp_management", "ads_read", "ads_management"],
  requiredScopes: ["ads_mcp_management", "ads_read"],
  missingScopes: [],
  missingReadScopes: [],
  missingWriteScopes: [],
  accessibleAdAccountIds: ["act_123"],
  accessibleAdAccountsTruncated: false,
  canRead: true,
  canWrite: true,
  reconnectRequired: false,
};

const mockCreativeAsset = {
  id: "507f1f77bcf86cd799439011",
  workspaceId: "workspace-1",
  kind: "image" as const,
  source: "uploaded" as const,
  status: "complete" as const,
  url: "https://assets.example/launch.jpg",
  mimeType: "image/jpeg",
  fileName: "launch.jpg",
  fileSize: 1200,
};

jest.mock("@/components/assets/creative-asset-picker-dialog", () => ({
  CreativeAssetPickerDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (asset: typeof mockCreativeAsset) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onSelect(mockCreativeAsset)}>
        Pick launch asset
      </button>
    ) : null,
}));

jest.mock("next-intl", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriChatNextIntlMock()
);

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
  global.fetch = mockFetch;
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      sources: [
        {
          id: "connector:whatsapp:wa-1",
          group: "Sources",
          label: "Main WhatsApp",
          description: "WhatsApp docs, templates, flows, and channel context",
          ref: {
            kind: "connector",
            connector: "whatsapp",
            sourceId: "wa-1",
            label: "Main WhatsApp",
            capabilities: ["docs", "templates", "flows"],
          },
        },
      ],
    }),
  } as Response);
});

describe("AiriChatComposer", () => {
  it.each(["rollout", "settings"] as const)(
    "opens integration recovery instead of authorization for %s",
    recovery => {
      render(
        <AiriChatComposer
          workspaceId="workspace-1"
          prefetchedSourceOptions={[
            {
              id: "skill:meta",
              group: "Skills",
              label: "meta",
              description: "Meta account unavailable",
              disabled: true,
              ref: { kind: "skill", skillId: "meta", label: "meta" },
              metaAdsMcp: {
                canRead: false,
                canWrite: false,
                retryable: false,
                recovery,
                descriptionKey:
                  recovery === "rollout" ? "accountNotEnabled" : "checkAgain",
              },
            },
          ]}
          onSend={jest.fn()}
        />
      );
      expect(
        screen.getByRole("link", { name: /Check Meta Ads/ })
      ).toHaveAttribute(
        "href",
        "/panel/w/workspace-1/settings/integrations?integration=meta_ads"
      );
      expect(
        screen.queryByRole("button", {
          name: /Enable AI ad management|skill.recovery.authorize/,
        })
      ).not.toBeInTheDocument();
      expect(mockConnectMetaAdsMcp).not.toHaveBeenCalled();
    }
  );

  const keyboardSources = [
    {
      id: "skill:meta",
      group: "Skills",
      label: "meta",
      description: "Read campaign performance",
      ref: { kind: "skill" as const, skillId: "meta" as const, label: "meta" },
    },
    {
      id: "source:canva-1",
      group: "Sources",
      label: "Canva",
      description: "Use your designs",
      ref: {
        kind: "workspace_source" as const,
        sourceId: "canva-1",
        sourceType: "canva",
        label: "Canva",
      },
    },
  ];

  it("selects mentions with arrows and Enter without sending an unfinished prompt", async () => {
    const onSend = jest.fn();
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={keyboardSources}
        onSend={onSend}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@" } });
    await screen.findByRole("option", { name: /meta/ });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyUp(input, { key: "ArrowDown" });
    const canva = screen.getByRole("option", { name: /Canva/ });
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", canva.id)
    );
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyUp(input, { key: "Enter" });
    await act(async () => {
      await new Promise<void>(resolve => afterNextPaint(resolve));
    });
    expect(input).toHaveValue("@Canva ");
    expect(document.activeElement).toBe(input);
    expect(input).toHaveProperty("selectionStart", "@Canva ".length);
    expect(input).toHaveProperty("selectionEnd", "@Canva ".length);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps Escape dismissed and closes stale suggestions when the mention ends", async () => {
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={keyboardSources}
        onSend={jest.fn()}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyUp(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "@m" } });
    await screen.findByRole("listbox");
    fireEvent.change(input, { target: { value: "@m " } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("does not submit empty mentions or intercept Enter during IME composition", () => {
    const onSend = jest.fn();
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={[]}
        onSend={onSend}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.submit(screen.getByTestId("airi-chat-composer"));
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Сәлем" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("submits a plain message with Enter when no mention picker is open", async () => {
    const onSend = jest.fn(async () => true);
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={keyboardSources}
        onSend={onSend}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "Summarize campaigns" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyUp(input, { key: "Enter" });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Summarize campaigns", [], [])
    );
  });

  it("sends a nonempty draft with Enter when the mention picker has no selectable result", async () => {
    const onSend = jest.fn(async () => true);
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={keyboardSources}
        onSend={onSend}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@nomatch" } });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyUp(input, { key: "Enter" });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("@nomatch", [], [])
    );
  });

  it("locks duplicate submissions and restores the draft after a rejected send", async () => {
    let rejectSend!: (error: Error) => void;
    const onSend = jest.fn(
      () =>
        new Promise<boolean>((_, reject) => {
          rejectSend = reject;
        })
    );
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={keyboardSources}
        onSend={onSend}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "Summarize campaigns" } });
    const form = screen.getByTestId("airi-chat-composer");
    fireEvent.change(form.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["brief"], "brief.txt", { type: "text/plain" })],
      },
    });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove brief.txt" })
    ).toBeDisabled();
    await act(async () => rejectSend(new Error("offline")));
    expect(input).toHaveValue("Summarize campaigns");
    expect(input).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Remove brief.txt" })
    ).toBeEnabled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not send your message. Your draft is saved. Try again."
    );
  });

  it("swaps Send for a keyboard-reachable Stop while an answer runs", () => {
    const onStop = jest.fn();
    const { rerender } = render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled
        running
        prefetchedSourceOptions={[]}
        onSend={jest.fn()}
        onStop={onStop}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Send message" })
    ).not.toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop answer" });
    // The composer is locked while the answer runs; Stop is not.
    expect(screen.getByRole("combobox", { name: "Ask Airi" })).toBeDisabled();
    expect(stop).toBeEnabled();
    expect(stop).toHaveAttribute("type", "button");
    stop.focus();
    expect(stop).toHaveFocus();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled
        running
        stopping
        prefetchedSourceOptions={[]}
        onSend={jest.fn()}
        onStop={onStop}
      />
    );
    expect(
      screen.getByRole("button", { name: "Stopping the answer" })
    ).toBeDisabled();

    rerender(
      <AiriChatComposer
        workspaceId="workspace-1"
        prefetchedSourceOptions={[]}
        onSend={jest.fn()}
        onStop={onStop}
      />
    );
    expect(
      screen.getByRole("button", { name: "Send message" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop answer" })
    ).not.toBeInTheDocument();
  });

  it("renders a dense compact composer without changing text alignment", () => {
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        variant="compact"
        prefetchedSourceOptions={[]}
        onSend={jest.fn()}
      />
    );

    const composer = screen.getByTestId("airi-chat-composer");
    expect(composer).toHaveAttribute("data-airi-composer-variant", "compact");
    expect(
      screen.getByRole("button", { name: "Open message tools" })
    ).toHaveClass("size-8");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveClass(
      "size-8"
    );
    expect(screen.getByRole("combobox", { name: "Ask Airi" })).toHaveClass(
      "min-h-8",
      "max-h-24",
      "text-left"
    );
  });

  it("reserves icon dimensions for image-backed integration sources", async () => {
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        prefetchedSourceOptions={[
          {
            id: "source:canva-1",
            group: "Sources",
            label: "Canva",
            description: "Canva designs",
            ref: {
              kind: "workspace_source",
              sourceId: "canva-1",
              sourceType: "canva",
              label: "Canva",
            },
          },
        ]}
        onSend={jest.fn()}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "@" },
    });
    expect(await screen.findByText("Canva")).toBeInTheDocument();

    const icon = document.querySelector('img[src="/canva-icon.svg"]');
    expect(icon).toHaveAttribute("width", "24");
    expect(icon).toHaveAttribute("height", "24");
  });

  it("keeps hero composer input text left aligned inside centered parents", () => {
    render(
      <div className="text-center">
        <AiriChatComposer
          workspaceId="workspace-1"
          disabled={false}
          variant="hero"
          prefetchedSourceOptions={[]}
          onSend={jest.fn()}
        />
      </div>
    );

    expect(screen.getByRole("combobox", { name: "Ask Airi" })).toHaveClass(
      "text-left"
    );
  });

  it("shows a connect badge below the input when @meta is not ready", () => {
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        prefetchedSourceOptions={[
          {
            id: "skill:meta",
            group: "Skills",
            label: "meta",
            description: "Connect Meta Ads, then enable Ads MCP to use @meta",
            metaAdsMcp: {
              canRead: false,
              canWrite: false,
              retryable: false,
              recovery: "connect",
              descriptionKey: "missingSource",
            },
            disabled: true,
            ref: {
              kind: "skill",
              skillId: "meta",
              label: "meta",
            },
          },
        ]}
        onSend={jest.fn()}
      />
    );

    expect(
      screen.getByRole("button", {
        name: /Connect Meta Ads for @meta/i,
      })
    ).toBeInTheDocument();
  });

  it("hides the @meta connect badge when Ads MCP is ready", () => {
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        prefetchedSourceOptions={[
          {
            id: "skill:meta",
            group: "Skills",
            label: "meta",
            description: "Live Meta Ads MCP",
            disabled: false,
            ref: {
              kind: "skill",
              skillId: "meta",
              label: "meta",
            },
          },
        ]}
        onSend={jest.fn()}
      />
    );

    expect(
      screen.queryByRole("link", { name: /@meta/i })
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "confirms management only when reads and writes are available",
      readiness: mcpReadiness,
      toastType: "success",
      message: "mcp.toast.ready",
    },
    {
      name: "reports read-only access even when the connection state is ready",
      readiness: {
        ...mcpReadiness,
        canWrite: false,
        grantedScopes: ["ads_mcp_management", "ads_read"],
        missingWriteScopes: ["ads_management"],
      },
      toastType: "success",
      message: "mcp.toast.readOnly",
    },
    {
      name: "warns about remaining setup when authorization saved an unusable connection",
      readiness: {
        ...mcpReadiness,
        state: "missing_scopes" as const,
        canRead: false,
        canWrite: false,
        grantedScopes: ["ads_read"],
        missingScopes: ["ads_mcp_management"],
        missingReadScopes: ["ads_mcp_management"],
        missingWriteScopes: ["ads_mcp_management", "ads_management"],
        reconnectRequired: true,
      },
      toastType: "warning",
      message: "mcp.toast.connectedNeedsAction",
    },
  ])("$name", async ({ readiness, toastType, message }) => {
    mockConnectMetaAdsMcp.mockResolvedValue({
      ok: true,
      createdSource: false,
      reportingReady: true,
      readiness,
    });
    const onSourcesRefresh = jest.fn();
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        prefetchedSourceOptions={[
          {
            id: "skill:meta",
            group: "Skills",
            label: "meta",
            description: "Enable Ads MCP to use @meta",
            metaAdsMcp: {
              canRead: false,
              canWrite: false,
              retryable: false,
              recovery: "authorize",
              descriptionKey: "connect",
            },
            disabled: true,
            ref: { kind: "skill", skillId: "meta", label: "meta" },
          },
        ]}
        onSourcesRefresh={onSourcesRefresh}
        onSend={jest.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Enable AI ad management for @meta" })
    );

    await waitFor(() =>
      expect(
        toastType === "warning" ? mockToastWarning : mockToastSuccess
      ).toHaveBeenCalledWith(message)
    );
    expect(mockConnectMetaAdsMcp).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      allowCreateGraphSource: false,
      intent: "ai_ads",
    });
    expect(onSourcesRefresh).toHaveBeenCalledTimes(1);
    expect(
      toastType === "warning" ? mockToastSuccess : mockToastWarning
    ).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Enable AI ad management for @meta" })
    ).toBeEnabled();
  });

  it("opens @ source picker, creates a chip, sends selected sources, and clears chips on success", async () => {
    const onSend = jest.fn(async () => true);
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={onSend}
      />
    );

    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@ma" } });

    expect(await screen.findByText("Main WhatsApp")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Main WhatsApp"));

    expect(screen.getByText("Main WhatsApp")).toBeInTheDocument();
    expect(input).toHaveValue("@Main WhatsApp ");

    fireEvent.change(input, {
      target: { value: "@Main WhatsApp Check pricing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        "@Main WhatsApp Check pricing",
        [
          {
            kind: "connector",
            connector: "whatsapp",
            sourceId: "wa-1",
            label: "Main WhatsApp",
            capabilities: ["docs", "templates", "flows"],
          },
        ],
        []
      )
    );
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps inline selected source tokens when sending fails", async () => {
    const onSend = jest.fn(async () => false);
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={onSend}
      />
    );

    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.click(await screen.findByText("Main WhatsApp"));
    fireEvent.change(input, {
      target: { value: "@Main WhatsApp Check pricing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(input).toHaveValue("@Main WhatsApp Check pricing");
  });

  it("filters prefetched source options locally while typing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sources: [
          {
            id: "source:canva-1",
            group: "Sources",
            label: "Canva",
            description: "Canva design and campaign planning",
            ref: {
              kind: "workspace_source",
              sourceId: "canva-1",
              sourceType: "canva",
              label: "Canva",
            },
          },
          {
            id: "source:email-1",
            group: "Sources",
            label: "Email",
            description: "Email support and campaign context",
            ref: {
              kind: "workspace_source",
              sourceId: "email-1",
              sourceType: "email",
              label: "Email",
            },
          },
        ],
      }),
    } as Response);

    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={jest.fn()}
      />
    );

    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@ca" } });

    expect(await screen.findByText("Canva")).toBeInTheDocument();
    expect(screen.queryByText("Email")).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("switches the @ picker into chat selection mode", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const requestUrl = new URL(url, "http://localhost");
      if (requestUrl.searchParams.get("mode") === "chats") {
        return {
          ok: true,
          json: async () => ({
            sources: [
              {
                id: "chat_thread:thread-1",
                group: "Chats",
                label: "Pricing answers",
                description: "Airi chat history",
                ref: {
                  kind: "chat_thread",
                  threadId: "thread-1",
                  label: "Pricing answers",
                },
              },
            ],
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          sources: [
            {
              id: "action:choose_chats",
              type: "action",
              action: "choose_chats",
              group: "Chats",
              label: "Choose from chats",
              description: "Use a previous Airi chat as context",
            },
          ],
        }),
      } as Response;
    });

    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={jest.fn()}
      />
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "@" },
    });
    fireEvent.click(await screen.findByText("Choose from chats"));

    expect(await screen.findByText("Pricing answers")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "@Pricing" },
    });
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("q=Pricing&limit=50&mode=chats"),
        expect.objectContaining({ cache: "no-store" })
      )
    );
    expect(
      screen.getByRole("button", { name: "Back to sources" })
    ).toBeInTheDocument();
  });

  it("debounces and aborts the chat search, and Enter waits for its results", async () => {
    const chatRequests = new Map<
      string,
      { signal?: AbortSignal | null; resolve: (response: Response) => void }
    >();
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      const requestUrl = new URL(url, "http://localhost");
      if (requestUrl.searchParams.get("mode") === "chats") {
        return new Promise<Response>(resolve => {
          chatRequests.set(requestUrl.searchParams.get("q") ?? "", {
            signal: init?.signal,
            resolve,
          });
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          sources: [
            {
              id: "action:choose_chats",
              type: "action",
              action: "choose_chats",
              group: "Chats",
              label: "Choose from chats",
              description: "Use a previous Airi chat as context",
            },
          ],
        }),
      } as Response);
    });
    const onSend = jest.fn(async () => true);
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={onSend}
      />
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });

    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.click(await screen.findByText("Choose from chats"));
    await waitFor(() => expect(chatRequests.has("")).toBe(true));

    fireEvent.change(input, { target: { value: "@P" } });
    fireEvent.change(input, { target: { value: "@Pr" } });
    fireEvent.change(input, { target: { value: "@Pri" } });
    expect(chatRequests.get("")?.signal?.aborted).toBe(true);
    await waitFor(() => expect(chatRequests.has("Pri")).toBe(true));
    expect(chatRequests.has("P")).toBe(false);
    expect(chatRequests.has("Pr")).toBe(false);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("@Pri");

    await act(async () => {
      chatRequests.get("")?.resolve({
        ok: true,
        json: async () => ({
          sources: [
            {
              id: "chat_thread:stale",
              group: "Chats",
              label: "Stale chat",
              description: "Airi chat history",
              ref: { kind: "chat_thread", threadId: "stale", label: "Stale" },
            },
          ],
        }),
      } as Response);
      chatRequests.get("Pri")?.resolve({
        ok: true,
        json: async () => ({
          sources: [
            {
              id: "chat_thread:thread-1",
              group: "Chats",
              label: "Pricing answers",
              description: "Airi chat history",
              ref: {
                kind: "chat_thread",
                threadId: "thread-1",
                label: "Pricing answers",
              },
            },
          ],
        }),
      } as Response);
    });

    expect(await screen.findByText("Pricing answers")).toBeInTheDocument();
    expect(screen.queryByText("Stale chat")).not.toBeInTheDocument();
  });

  it("passes selected File objects through on send", async () => {
    const onSend = jest.fn(async () => true);
    const { container } = render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={onSend}
      />
    );

    const file = new File(["menu"], "menu.pdf", {
      type: "application/pdf",
    });
    const fileInput = container.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [file] },
    });

    expect(screen.getByText("menu.pdf")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "Use this menu" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Use this menu", [], [file])
    );
  });

  it("attaches an existing Creative Asset without downloading it into the browser", async () => {
    const onSend = jest.fn(async () => true);
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled={false}
        onSend={onSend}
      />
    );

    fireEvent.keyDown(
      screen.getByRole("button", { name: "Open message tools" }),
      { key: "Enter" }
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Choose creative asset" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick launch asset" }));

    expect(screen.getByText("launch.jpg")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "@meta use this launch image" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        "@meta use this launch image",
        [],
        [],
        [mockCreativeAsset]
      )
    );
  });

  it("disables message tools while a message is sending", () => {
    render(
      <AiriChatComposer
        workspaceId="workspace-1"
        disabled
        prefetchedSourceOptions={[]}
        onSend={jest.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: "Open message tools" })
    ).toBeDisabled();
  });

  it.each(["sources", "tools", "creative assets"])(
    "dismisses %s when disabled without discarding the draft or reopening on return",
    async overlay => {
      const onSend = jest.fn();
      const composer = (disabled: boolean) => (
        <AiriChatComposer
          workspaceId="workspace-1"
          disabled={disabled}
          prefetchedSourceOptions={keyboardSources}
          onSend={onSend}
        />
      );
      const { container, rerender } = render(composer(false));
      const input = screen.getByRole("combobox", { name: "Ask Airi" });
      const draft = overlay === "sources" ? "@" : "Keep this draft";
      fireEvent.change(input, { target: { value: draft } });
      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: {
          files: [new File(["design"], "medal.png", { type: "image/png" })],
        },
      });
      if (overlay === "sources") {
        await screen.findByRole("option", { name: /meta/ });
      } else {
        fireEvent.keyDown(
          screen.getByRole("button", { name: "Open message tools" }),
          { key: "Enter" }
        );
        const assetAction = await screen.findByRole("menuitem", {
          name: "Choose creative asset",
        });
        if (overlay === "creative assets") {
          fireEvent.click(assetAction);
          expect(
            screen.getByRole("button", { name: "Pick launch asset" })
          ).toBeInTheDocument();
        }
      }
      rerender(composer(true));
      expect(input).toBeDisabled();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Pick launch asset" })
      ).not.toBeInTheDocument();
      rerender(composer(false));
      expect(input).toBeEnabled();
      expect(input).toHaveValue(draft);
      expect(input).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Pick launch asset" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Remove medal.png" })
      ).toBeInTheDocument();
      expect(onSend).not.toHaveBeenCalled();
    }
  );
});
