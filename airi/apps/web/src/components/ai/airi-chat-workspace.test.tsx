/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ReadableStream } from "stream/web";
import { TextEncoder } from "util";
import type React from "react";
import {
  AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS,
  AiriChatWorkspace,
  useAiriChatSourceOptions,
  type AiriDesktopColumnsProps,
} from "./airi-chat-workspace";
import {
  completedMessageStream,
  deferred,
  expectAnyBuilderTemplateName,
  installAiriChatWorkspaceTestGlobals,
  jsonResponse,
  sseFrame,
  streamingResponse,
  whatsappTemplateArtifact,
} from "./airi-chat-workspace-test-utils";

jest.mock("next-intl", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriChatNextIntlMock()
);

// The drawer loads this module too; only the /airi page module may bring in
// react-resizable-panels (airi-page-workspace.tsx).
jest.mock("@/components/ui/resizable", () => {
  throw new Error("airi-chat-workspace must not load the resizable columns");
});

jest.mock("@/components/ai/airi-builder-side-panel", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriBuilderSidePanelMock()
);

const mockConversationScrollToBottom = jest.fn();

// use-stick-to-bottom ships ESM only; stand in for its sticky scroller.
jest.mock("@/components/ui/conversation", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Conversation: ({
      children,
      contextRef,
      "aria-label": ariaLabel,
    }: {
      children: React.ReactNode;
      contextRef?: React.Ref<{ scrollToBottom: () => void }>;
      "aria-label"?: string;
    }) => {
      React.useImperativeHandle(contextRef, () => ({
        scrollToBottom: mockConversationScrollToBottom,
      }));
      return React.createElement(
        "div",
        { role: "log", "aria-label": ariaLabel },
        children
      );
    },
    ConversationContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    ConversationScrollButton: () => null,
  };
});

// Set by a test to stand in for a failed builder-catalog download.
let mockBuilderCatalogsFailed = false;
const mockRetryBuilderCatalogs = jest.fn();

jest.mock("@/components/ai/airi-builder-intl-provider", () => ({
  AiriBuilderIntlProvider: ({
    children,
    renderFailure,
  }: {
    children: React.ReactNode;
    renderFailure?: (retry: () => void) => React.ReactNode;
  }) =>
    mockBuilderCatalogsFailed
      ? (renderFailure?.(mockRetryBuilderCatalogs) ?? (
          <div role="alert">The builder could not load.</div>
        ))
      : children,
  AiriPreviewLoadFailure: jest.requireActual(
    "@/components/ai/airi-builder-intl-provider"
  ).AiriPreviewLoadFailure,
}));

jest.mock("@/components/whatsapp-templates/template-phone-preview", () => ({
  TemplatePhonePreview: ({
    template,
  }: {
    template: { name: string; language: string };
  }) => (
    <div data-testid="template-phone-preview">
      {template.name} [{template.language}]
    </div>
  ),
}));

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  installAiriChatWorkspaceTestGlobals(mockFetch);
});

describe("AiriChatWorkspace", () => {
  it.each([
    {
      disabled: true,
      canRead: false,
      canWrite: false,
      retryable: false,
      visible: false,
    },
    {
      disabled: false,
      canRead: false,
      canWrite: false,
      retryable: false,
      visible: false,
    },
    {
      disabled: false,
      canRead: true,
      canWrite: false,
      retryable: false,
      visible: true,
    },
    {
      disabled: false,
      canRead: false,
      canWrite: false,
      retryable: true,
      visible: true,
    },
  ])(
    "gates live Meta start action by skill readiness: $visible",
    async fixture => {
      mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/assets/generate/wan"))
          return jsonResponse({ configured: false, temporalConfigured: false });
        if (url.includes("/airi-chats/sources"))
          return jsonResponse({
            sources: [
              {
                id: "source:meta-1",
                group: "Sources",
                label: "Meta Ads",
                description: "Campaign planning",
                ref: {
                  kind: "workspace_source",
                  sourceId: "meta-1",
                  sourceType: "meta_ads",
                  label: "Meta Ads",
                },
              },
              {
                id: "skill:meta",
                group: "Skills",
                label: "meta",
                description: "Live Meta tools",
                disabled: fixture.disabled,
                ref: { kind: "skill", skillId: "meta", label: "meta" },
                metaAdsMcp: {
                  canRead: fixture.canRead,
                  canWrite: fixture.canWrite,
                  retryable: fixture.retryable,
                  recovery: fixture.disabled ? "rollout" : null,
                  descriptionKey: "reporting",
                },
              },
            ],
          });
        if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
        throw new Error(`Unexpected fetch: ${url}`);
      });
      render(<AiriChatWorkspace workspaceId="workspace-1" />);
      await screen.findAllByRole("button", {
        name: /Plan Meta Ads angle|starter.plan.title/,
      });
      const cards = screen.queryAllByRole("button", {
        name: /Meta Ads \(@meta\)|starter.title/,
      });
      expect(cards.length > 0).toBe(fixture.visible);
      if (fixture.visible)
        expect(cards[0]).toHaveTextContent(
          fixture.retryable
            ? "Airi will verify Meta Ads access"
            : "Campaign changes require management access."
        );
    }
  );

  it("does not probe the Wan avatar endpoint when the drawer opens", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    expect(await screen.findByText("Try Airi for...")).toBeInTheDocument();
    expect(
      mockFetch.mock.calls.filter(([url]) =>
        String(url).includes("/assets/generate/wan")
      )
    ).toHaveLength(0);
  });

  it("keeps the first draft and attachment in the same composer after a failed send", async () => {
    const pendingResponse = deferred<Response>();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/messages/stream")) return pendingResponse.promise;
      return jsonResponse({ artifacts: [], configured: false });
    });
    const { container } = render(
      <AiriChatWorkspace workspaceId="workspace-1" compact />
    );
    const input = await screen.findByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, {
      target: { value: "Please inspect the attached design" },
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["design"], "medal.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages/stream"),
        expect.anything()
      )
    );
    expect(screen.getByRole("combobox", { name: "Ask Airi" })).toBe(input);
    await act(async () => {
      pendingResponse.resolve({
        ok: false,
        status: 503,
        headers: new Headers(),
        json: async () => ({ error: "Temporarily unavailable" }),
      } as Response);
    });
    expect(
      await screen.findByText("Temporarily unavailable")
    ).toBeInTheDocument();
    expect(input).toHaveValue("Please inspect the attached design");
    expect(
      screen.getByRole("button", { name: "Remove medal.png" })
    ).toBeInTheDocument();
    expect(input).toBeEnabled();
  });

  it("locks chat navigation during a pending turn and keeps the composer mounted", async () => {
    const completion = deferred<void>();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/messages/stream"))
        return completedMessageStream({ wait: completion.promise });
      return jsonResponse({ messages: [], artifacts: [], configured: false });
    });
    render(<AiriChatWorkspace workspaceId="workspace-1" compact />);
    const input = await screen.findByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "Update the builder" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const back = await screen.findByRole("button", {
      name: "Back to Airi start",
    });
    expect(back).toBeDisabled();
    fireEvent.click(back);
    expect(
      screen.queryByText("What should we work on?")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Ask Airi" })).toBe(input);
    await act(async () => completion.resolve());
    expect(await screen.findByText("Updated.")).toBeInTheDocument();
    await waitFor(() => expect(back).toBeEnabled());
  });

  it.each(["error", "early EOF"])(
    "clears an accepted draft after stream %s without sending it again",
    async termination => {
      const at = new Date().toISOString();
      const expectedError =
        termination === "error"
          ? "The answer failed"
          : "Airi response did not finish";
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/airi-chats/sources"))
          return jsonResponse({ sources: [] });
        if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
        if (url.endsWith("/messages/stream"))
          return streamingResponse({
            wait: Promise.resolve(),
            beforeWait: [
              {
                type: "thread",
                thread: {
                  id: "thread-1",
                  title: "Saved chat",
                  source: "manual",
                  pinnedAt: null,
                  updatedAt: at,
                },
                at,
              },
              {
                type: "user_message",
                message: {
                  id: "saved-message",
                  threadId: "thread-1",
                  role: "user",
                  content: "Accepted question",
                  metadata: null,
                  createdAt: at,
                },
                at,
              },
            ],
            afterWait:
              termination === "error"
                ? [
                    {
                      type: "error",
                      message: expectedError,
                      persisted: false,
                      at,
                    },
                  ]
                : [],
          });
        return jsonResponse({ messages: [], artifacts: [], configured: false });
      });
      const { container } = render(
        <AiriChatWorkspace workspaceId="workspace-1" compact />
      );
      const input = await screen.findByRole("combobox", { name: "Ask Airi" });
      fireEvent.change(input, { target: { value: "Accepted question" } });
      fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: {
          files: [new File(["design"], "medal.png", { type: "image/png" })],
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(
        (await screen.findAllByText(expectedError))[0]
      ).toBeInTheDocument();
      await waitFor(() => expect(input).toHaveValue(""));
      expect(
        screen.queryByRole("button", { name: "Remove medal.png" })
      ).not.toBeInTheDocument();
      expect(screen.getByText("Accepted question")).toBeInTheDocument();
      expect(
        mockFetch.mock.calls.filter(([url]) =>
          String(url).endsWith("/messages")
        )
      ).toHaveLength(0);
      expect(
        mockFetch.mock.calls.filter(([url]) =>
          String(url).endsWith("/messages/stream")
        )
      ).toHaveLength(1);
    }
  );

  it("submits a start action only once when clicked twice before React commits", async () => {
    const completion = deferred<void>();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/messages/stream"))
        return completedMessageStream({ wait: completion.promise });
      return jsonResponse({ messages: [], artifacts: [], configured: false });
    });
    render(<AiriChatWorkspace workspaceId="workspace-1" compact />);
    const action = await screen.findByRole("button", {
      name: "See what Airi can do",
    });
    act(() => {
      action.click();
      action.click();
    });
    await screen.findByRole("button", { name: "Back to Airi start" });
    expect(
      mockFetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/messages/stream")
      )
    ).toHaveLength(1);
    await act(async () => completion.resolve());
    expect(await screen.findByText("Updated.")).toBeInTheDocument();
  });

  it("aborts an old workspace turn and ignores its late events after returning to that workspace", async () => {
    const completion = deferred<void>();
    let requestSignal: AbortSignal | null | undefined;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/messages/stream")) {
        requestSignal = init?.signal;
        return completedMessageStream({ wait: completion.promise });
      }
      return jsonResponse({ messages: [], artifacts: [], configured: false });
    });
    const { rerender } = render(
      <AiriChatWorkspace workspaceId="workspace-a" compact />
    );
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Ask Airi" }),
      {
        target: { value: "Update the builder" },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Back to Airi start" });
    rerender(<AiriChatWorkspace workspaceId="workspace-b" compact />);
    expect(requestSignal?.aborted).toBe(true);
    rerender(<AiriChatWorkspace workspaceId="workspace-a" compact />);
    await act(async () => completion.resolve());
    expect(screen.queryByText("Updated.")).not.toBeInTheDocument();
    expect(screen.getByText("What should we work on?")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Ask Airi" })).toBeEnabled();
    expect(
      mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/messages"))
    ).toHaveLength(0);
  });

  it("does not resurrect stale source options after an A to B to A workspace transition", async () => {
    const firstWorkspaceA = deferred<Response>();
    const workspaceB = deferred<Response>();
    const secondWorkspaceA = deferred<Response>();
    let workspaceARequestCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/workspace-a/airi-chats/sources")) {
        workspaceARequestCount += 1;
        return workspaceARequestCount === 1
          ? firstWorkspaceA.promise
          : secondWorkspaceA.promise;
      }
      if (url.includes("/workspace-b/airi-chats/sources")) {
        return workspaceB.promise;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { result, rerender } = renderHook(
      ({ workspaceId }) => useAiriChatSourceOptions(workspaceId),
      { initialProps: { workspaceId: "workspace-a" } }
    );

    await act(async () => {
      firstWorkspaceA.resolve(
        jsonResponse({ sources: [{ id: "old-a", label: "Old A" }] })
      );
      await firstWorkspaceA.promise;
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([
      expect.objectContaining({ id: "old-a" }),
    ]);

    rerender({ workspaceId: "workspace-b" });
    expect(result.current.options).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    rerender({ workspaceId: "workspace-a" });
    expect(result.current.options).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      secondWorkspaceA.resolve(
        jsonResponse({ sources: [{ id: "new-a", label: "New A" }] })
      );
      await secondWorkspaceA.promise;
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.options).toEqual([
      expect.objectContaining({ id: "new-a" }),
    ]);
  });

  it("shows useful workspace data cards in the centered empty chat start screen", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({
          sources: [
            {
              id: "context:conversation_timeline",
              ref: {
                kind: "context",
                optionId: "conversation_timeline",
                label: "Customer conversations",
              },
              group: "Workspace context",
              label: "Customer conversations",
              description: "Recent customer chats",
              count: 12,
            },
            {
              id: "context:knowledge_base_articles",
              ref: {
                kind: "context",
                optionId: "knowledge_base_articles",
                label: "Knowledge base",
              },
              group: "Workspace context",
              label: "Knowledge base",
              description: "Indexed docs",
              count: 7,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Campaign ideas",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
            {
              id: "thread-2",
              title: "Support review",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const customerChatsCard = (
      await screen.findAllByRole("button", {
        name: /Customer chats ready/i,
      })
    )[0];
    expect(customerChatsCard).toHaveTextContent("12");
    expect(customerChatsCard).toHaveTextContent("chats");
    expect(
      screen.getAllByRole("button", { name: /Knowledge connected/i })[0]
    ).toHaveTextContent("7");
    expect(
      screen.getAllByRole("button", { name: /Previous Airi work/i })[0]
    ).toHaveTextContent("2");

    fireEvent.click(customerChatsCard);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.content).toContain("customer conversations");
  });

  it("renders compact sidebar start actions as buttons with recent chats at the bottom", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({
          sources: [
            {
              id: "context:conversation_timeline",
              ref: {
                kind: "context",
                optionId: "conversation_timeline",
                label: "Customer conversations",
              },
              group: "Workspace context",
              label: "Customer conversations",
              description: "Recent customer chats",
              count: 12,
            },
            {
              id: "context:knowledge_base_articles",
              ref: {
                kind: "context",
                optionId: "knowledge_base_articles",
                label: "Knowledge articles",
              },
              group: "Workspace context",
              label: "Knowledge articles",
              description: "Connected knowledge",
              count: 7,
            },
            {
              id: "context:quick_replies",
              ref: {
                kind: "context",
                optionId: "quick_replies",
                label: "Quick replies",
              },
              group: "Workspace context",
              label: "Quick replies",
              description: "Saved replies",
              count: 4,
            },
            {
              id: "connector:whatsapp:wa-1",
              ref: {
                kind: "connector",
                connector: "whatsapp",
                sourceId: "wa-1",
                label: "WhatsApp",
                capabilities: ["docs", "templates", "flows"],
              },
              group: "Sources",
              label: "WhatsApp",
              description: "WhatsApp channel",
            },
            {
              id: "source:canva-1",
              ref: {
                kind: "workspace_source",
                sourceId: "canva-1",
                sourceType: "canva",
                label: "Canva",
              },
              group: "Sources",
              label: "Canva",
              description: "Canva designs",
            },
            {
              id: "source:meta-ads-1",
              ref: {
                kind: "workspace_source",
                sourceId: "meta-ads-1",
                sourceType: "meta_ads",
                label: "Meta Ads",
              },
              group: "Sources",
              label: "Meta Ads",
              description: "Meta Ads account",
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Campaign ideas",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
            {
              id: "thread-2",
              title: "Support review",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    expect(await screen.findByText("Try Airi for...")).toBeInTheDocument();
    expect(screen.getByTestId("airi-compact-header")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Close Airi sidebar" })
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Close Airi chat" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Analyze customer chats/i })
    ).toHaveClass("h-7");
    expect(
      screen.getByLabelText("Suggested Airi actions").querySelectorAll("button")
    ).toHaveLength(6);
    expect(screen.getByTestId("airi-chat-composer")).toHaveAttribute(
      "data-airi-composer-variant",
      "compact"
    );
    expect(
      screen.queryByRole("button", { name: /Customer chats ready/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Recent chats")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Campaign ideas/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Support review/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/airi"
    );
    expect(screen.queryByText("Loading chats")).not.toBeInTheDocument();
  });

  it("returns from a compact recent chat to the Airi start screen", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Campaign ideas",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        return jsonResponse({
          messages: [
            {
              id: "assistant-message-1",
              threadId: "thread-1",
              role: "assistant",
              content: "Recent campaign answer",
              metadata: null,
              createdAt: at,
            },
          ],
        });
      }
      if (url.includes("/airi-artifacts?")) {
        return jsonResponse({ artifacts: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Campaign ideas/i })
    );
    expect(
      await screen.findByText("Recent campaign answer")
    ).toBeInTheDocument();
    const backButton = screen.getByRole("button", {
      name: "Back to Airi start",
    });
    expect(screen.getByTestId("airi-compact-header")).toContainElement(
      backButton
    );

    fireEvent.click(backButton);

    expect(await screen.findByText("Try Airi for...")).toBeInTheDocument();
    expect(
      screen.queryByText("Recent campaign answer")
    ).not.toBeInTheDocument();
  });

  it("keeps the compact shell stable while a recent chat loads", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    let resolveMessages!: (response: Response) => void;
    const messagesResponse = new Promise<Response>(resolve => {
      resolveMessages = resolve;
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-loading",
              title: "Loading campaign",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-loading/messages")) {
        return messagesResponse;
      }
      if (url.includes("/airi-artifacts?")) {
        return jsonResponse({ artifacts: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Loading campaign/i })
    );

    expect(
      await screen.findByTestId("airi-thread-loading-skeleton")
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading messages...")).not.toBeInTheDocument();
    expect(screen.getByTestId("airi-compact-header")).toBeInTheDocument();

    await act(async () => {
      resolveMessages(jsonResponse({ messages: [] }));
      await messagesResponse;
    });
  });

  it("reconciles an interrupted Meta Ads action without offering another execution", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    let reconciled = false;
    const resultMessage = {
      id: "assistant-result-1",
      threadId: "thread-1",
      role: "assistant",
      content:
        "Recorded as completed after manual review. Airi did not re-run the action.",
      metadata: null,
      createdAt: at,
    };
    mockFetch.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.includes("/airi-chats/sources")) {
          return jsonResponse({ sources: [] });
        }
        if (url.endsWith("/airi-chats")) {
          return jsonResponse({
            threads: [
              {
                id: "thread-1",
                title: "Meta campaign",
                source: "manual",
                pinnedAt: null,
                updatedAt: at,
              },
            ],
          });
        }
        if (url.endsWith("/airi-chats/thread-1/messages")) {
          return jsonResponse({
            messages: [
              {
                id: "assistant-message-1",
                threadId: "thread-1",
                role: "assistant",
                content: "I prepared the campaign action.",
                metadata: {
                  airiMetaAdsMcpExecutions: [
                    {
                      id: "mutation-1",
                      toolName: "ads_create_campaign",
                      summary: "Create the launch campaign",
                      status: reconciled ? "succeeded" : "executing",
                      claimedAt: "2026-06-11T23:50:00.000Z",
                    },
                  ],
                },
                createdAt: at,
              },
              ...(reconciled ? [resultMessage] : []),
            ],
          });
        }
        if (url.includes("/airi-artifacts?")) {
          return jsonResponse({ artifacts: [] });
        }
        if (url.endsWith("/meta-mcp/confirm")) {
          expect(init?.method).toBe("PATCH");
          expect(JSON.parse(String(init?.body))).toEqual({
            messageId: "assistant-message-1",
            mutationId: "mutation-1",
            resolution: "succeeded",
            note: "Verified the campaign in Meta Ads Manager.",
          });
          reconciled = true;
          return jsonResponse({
            assistantMessage: resultMessage,
            executionStatus: "succeeded",
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    );

    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Meta campaign/i })
    );
    expect(
      await screen.findByText("Review Meta Ads outcome")
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Record reviewed outcome" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Completed" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Evidence note" }), {
      target: { value: "Verified the campaign in Meta Ads Manager." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record outcome" }));

    expect(
      await screen.findByText(/Recorded as completed after manual review/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Review Meta Ads outcome")
    ).not.toBeInTheDocument();
  });

  it("gates start cards by connected workspace tools", async () => {
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/assets/generate/wan")) {
        return jsonResponse({
          configured: false,
          temporalConfigured: false,
        });
      }
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({
          sources: [
            {
              id: "connector:whatsapp:source-whatsapp",
              ref: {
                kind: "connector",
                connector: "whatsapp",
                sourceId: "source-whatsapp",
                label: "WhatsApp",
                capabilities: ["docs", "templates", "flows"],
              },
              group: "Sources",
              label: "WhatsApp",
              description: "Templates, flows, docs, and customer context",
            },
            {
              id: "source:source-canva",
              ref: {
                kind: "workspace_source",
                sourceId: "source-canva",
                sourceType: "canva",
                label: "Canva",
              },
              group: "Sources",
              label: "Canva",
              description: "Canva design and campaign planning",
            },
            {
              id: "source:source-meta-ads",
              ref: {
                kind: "workspace_source",
                sourceId: "source-meta-ads",
                sourceType: "meta_ads",
                label: "Meta Ads",
              },
              group: "Sources",
              label: "Meta Ads",
              description: "Ad campaign planning",
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    await screen.findAllByText(/Customer channels connected/i);
    // One role query for the whole start screen: a name-filtered role query
    // per card recomputed every accessible name and pushed this test past
    // the 5 s limit under parallel load.
    const buttons = screen.getAllByRole("button");
    const cards = (name: RegExp) =>
      buttons.filter(button => name.test(button.textContent ?? ""));
    expect(cards(/Customer channels connected/i)[0]).toHaveTextContent("1");
    expect(cards(/Creative stack connected/i)[0]).toHaveTextContent("1");
    const canvaWhatsAppCard = cards(/Canva WhatsApp campaign/i)[0];
    expect(canvaWhatsAppCard).toBeInTheDocument();
    expect(cards(/Click-to-WhatsApp funnel/i)[0]).toBeInTheDocument();
    expect(
      screen.queryByText(/Avatar video campaign/i)
    ).not.toBeInTheDocument();
    expect(cards(/Meta Ads creative pack/i)[0]).toBeInTheDocument();
    expect(cards(/Create WhatsApp template/i)[0]).toBeInTheDocument();
    expect(cards(/Create avatar video/i)).toHaveLength(0);
    expect(cards(/Plan Meta Ads angle/i)[0]).toBeInTheDocument();

    fireEvent.click(canvaWhatsAppCard);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.content).toContain("Canva and WhatsApp together");
    // The fullest start screen this file renders: about 1.2 s alone, and it
    // has crossed Jest's 5 s default under a loaded --maxWorkers=2 sweep.
  }, 15_000);

  it("runs the customer channels card as an opportunity scan with channel sources", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({
          sources: [
            {
              id: "connector:whatsapp:source-whatsapp",
              ref: {
                kind: "connector",
                connector: "whatsapp",
                sourceId: "source-whatsapp",
                label: "WhatsApp",
                capabilities: ["docs", "templates", "flows"],
              },
              group: "Sources",
              label: "WhatsApp",
              description: "Templates, flows, docs, and customer context",
            },
            {
              id: "source:source-telegram",
              ref: {
                kind: "workspace_source",
                sourceId: "source-telegram",
                sourceType: "telegram",
                label: "Telegram",
              },
              group: "Sources",
              label: "Telegram",
              description: "Customer messages",
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const customerChannelsCard = (
      await screen.findAllByRole("button", {
        name: /Customer channels connected/i,
      })
    )[0];
    fireEvent.click(customerChannelsCard);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.content).toContain("ranked opportunity plan");
    expect(body.selectedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connector: "whatsapp" }),
        expect.objectContaining({ sourceType: "telegram" }),
      ])
    );
  });

  it("runs the booking reminder card with calendar and messaging sources attached", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({
          sources: [
            {
              id: "connector:whatsapp:source-whatsapp",
              ref: {
                kind: "connector",
                connector: "whatsapp",
                sourceId: "source-whatsapp",
                label: "WhatsApp",
                capabilities: ["docs", "templates", "flows"],
              },
              group: "Sources",
              label: "WhatsApp",
              description: "Templates, flows, docs, and customer context",
            },
            {
              id: "source:source-calendar",
              ref: {
                kind: "workspace_source",
                sourceId: "source-calendar",
                sourceType: "google_calendar",
                label: "Google Calendar",
              },
              group: "Sources",
              label: "Google Calendar",
              description: "Calendar availability and booking context",
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const bookingCard = (
      await screen.findAllByRole("button", {
        name: /Booking reminder flow/i,
      })
    )[0];
    fireEvent.click(bookingCard);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.content).toContain("booking reminder and no-show recovery");
    expect(body.selectedSources).toEqual([
      {
        kind: "workspace_source",
        sourceId: "source-calendar",
        sourceType: "google_calendar",
        label: "Google Calendar",
      },
      {
        kind: "connector",
        connector: "whatsapp",
        sourceId: "source-whatsapp",
        label: "WhatsApp",
        capabilities: ["docs", "templates", "flows"],
      },
    ]);
  });

  it("runs the manager triage card with customer channel sources attached", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({
          sources: [
            {
              id: "connector:whatsapp:source-whatsapp",
              ref: {
                kind: "connector",
                connector: "whatsapp",
                sourceId: "source-whatsapp",
                label: "WhatsApp",
                capabilities: ["docs", "templates", "flows"],
              },
              group: "Sources",
              label: "WhatsApp",
              description: "Templates, flows, docs, and customer context",
            },
            {
              id: "source:source-instagram",
              ref: {
                kind: "workspace_source",
                sourceId: "source-instagram",
                sourceType: "instagram",
                label: "Instagram",
              },
              group: "Sources",
              label: "Instagram",
              description: "Instagram conversations",
            },
            {
              id: "source:source-email",
              ref: {
                kind: "workspace_source",
                sourceId: "source-email",
                sourceType: "email",
                label: "Postmark",
              },
              group: "Sources",
              label: "Postmark",
              description: "Email conversations",
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const triageCard = (
      await screen.findAllByRole("button", {
        name: /Manager triage workflow/i,
      })
    )[0];
    fireEvent.click(triageCard);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.content).toContain("WhatsApp triage and follow-up workflow");
    expect(body.selectedSources).toEqual([
      {
        kind: "connector",
        connector: "whatsapp",
        sourceId: "source-whatsapp",
        label: "WhatsApp",
        capabilities: ["docs", "templates", "flows"],
      },
      {
        kind: "workspace_source",
        sourceId: "source-instagram",
        sourceType: "instagram",
        label: "Instagram",
      },
      {
        kind: "workspace_source",
        sourceId: "source-email",
        sourceType: "email",
        label: "Postmark",
      },
    ]);
  });

  it("renders live thinking trace from SSE and keeps a collapsed receipt", async () => {
    let releaseStream!: () => void;
    const wait = new Promise<void>(resolve => {
      releaseStream = resolve;
    });
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    const messageReloads: string[] = [];

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        messageReloads.push(url);
        return jsonResponse({ messages: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return streamingResponse({
          wait,
          beforeWait: [
            {
              type: "thread",
              thread: {
                id: "thread-1",
                title: "New chat",
                source: "manual",
                pinnedAt: null,
                updatedAt: at,
              },
              at,
            },
            {
              type: "user_message",
              message: {
                id: "user-message-1",
                threadId: "thread-1",
                role: "user",
                content: "What should I improve?",
                metadata: null,
                createdAt: at,
              },
              at,
            },
            {
              type: "stage",
              id: "generation",
              label: "Generating answer",
              status: "running",
              at,
            },
            {
              type: "resources",
              id: "retrieved_resources",
              label: "Resources used",
              status: "complete",
              resources: [
                {
                  id: "knowledge-base",
                  label: "Knowledge base",
                  kind: "knowledge_base",
                  count: 2,
                  status: "complete",
                },
                {
                  id: "customer-chats",
                  label: "Customer chats",
                  kind: "customer_chat",
                  count: 3,
                  status: "complete",
                },
              ],
              at,
            },
          ],
          afterWait: [
            {
              type: "assistant_message",
              message: {
                id: "assistant-message-1",
                threadId: "thread-1",
                role: "assistant",
                content:
                  "**Improve response speed** first.\n\n1. Check slow channels",
                metadata: {
                  whatsappTemplateDraft: {
                    kind: "whatsapp_template",
                    name: "customer_reengagement",
                    language: "en",
                    category: "MARKETING",
                    components: [
                      {
                        type: "BODY",
                        text: "Hi {{1}}, would you like help choosing a plan?",
                      },
                    ],
                  },
                  resourceReceipt: {
                    selectedSources: [],
                    selectedSourceLabels: [],
                    resources: [
                      {
                        id: "knowledge-base",
                        label: "Knowledge base",
                        kind: "knowledge_base",
                        count: 2,
                        status: "complete",
                      },
                      {
                        id: "customer-chats",
                        label: "Customer chats",
                        kind: "customer_chat",
                        count: 3,
                        status: "complete",
                      },
                    ],
                    sourceIds: ["kb:1", "conversation:1"],
                    retrievalPath: "blended",
                    provider: "vertex",
                    model: "gemini",
                    durationMs: 1200,
                  },
                },
                createdAt: at,
              },
              at,
            },
            {
              type: "done",
              thread: {
                id: "thread-1",
                title: "Support improvements",
                source: "manual",
                pinnedAt: null,
                updatedAt: at,
              },
              at,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { container } = render(
      <AiriChatWorkspace workspaceId="workspace-1" />
    );

    const input = (
      await screen.findAllByRole("combobox", {
        name: "Ask Airi",
      })
    )[0];
    fireEvent.change(input, { target: { value: "What should I improve?" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    expect(
      (await screen.findAllByText("Writing your answer"))[0]
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Activity details" })[0]
    );
    expect(screen.getAllByText("Generating answer")[0]).toBeInTheDocument();
    expect(
      (await screen.findAllByText("Knowledge base"))[0]
    ).toBeInTheDocument();
    expect(messageReloads).toHaveLength(0);

    await act(async () => {
      releaseStream();
    });

    await waitFor(() =>
      expect(container.querySelector("strong")?.textContent).toBe(
        "Improve response speed"
      )
    );
    expect(container.textContent).not.toContain("**Improve response speed**");
    expect(
      (await screen.findAllByText("Check slow channels"))[0]
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText("Used 2 KB articles and 3 chats"))[0]
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByTestId("template-phone-preview"))[0]
    ).toHaveTextContent("customer_reengagement [en]");
    expect(
      screen.queryByRole("button", { name: "Submit to WhatsApp" })
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Open in builder" })[0]
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText("Answer ready")[0]).toBeInTheDocument()
    );
    expect(screen.queryByText("Writing your answer")).not.toBeInTheDocument();
  });

  it("opens the Airi page tools panel without a selected chat artifact", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    expect(screen.queryByTestId("airi-compact-header")).not.toBeInTheDocument();

    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Toggle side panel",
        })
      )[0]
    );
    expect(screen.getByTestId("airi-page-side-panel")).toBeInTheDocument();
    expect(
      screen.queryByTestId("airi-builder-side-panel")
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(
        screen.queryByTestId("airi-page-side-panel")
      ).not.toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("airi-builder-side-panel")
    ).not.toBeInTheDocument();
  });

  it("lays out the page's chat list and thread on the first render, with no download to wait on", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const view = render(<AiriChatWorkspace workspaceId="workspace-1" />);

    // Synchronous: the desktop columns are part of this render, not a
    // lazily downloaded chunk that could leave the page blank or fail it.
    expect(
      screen.getByRole("button", { name: "New Airi chat" })
    ).toBeInTheDocument();
    await screen.findAllByRole("button", { name: "Toggle side panel" });
    view.unmount();

    const columns: Array<{ sidePanel: boolean; size: number }> = [];
    function PageColumns(props: AiriDesktopColumnsProps) {
      columns.push({
        sidePanel: props.sidePanel !== null,
        size: props.sidePanelSize,
      });
      return (
        <div data-testid="page-columns">
          <div data-testid="page-thread-list">{props.threadList}</div>
          <div data-testid="page-thread">{props.thread}</div>
          {props.sidePanel ? (
            <div data-testid="page-side-panel">{props.sidePanel}</div>
          ) : null}
        </div>
      );
    }
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        desktopColumns={PageColumns}
      />
    );

    expect(
      within(screen.getByTestId("page-thread-list")).getByRole("button", {
        name: "New Airi chat",
      })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("page-side-panel")).not.toBeInTheDocument();
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Toggle side panel" }))[0]
    );
    expect(
      within(screen.getByTestId("page-side-panel")).getByTestId(
        "airi-page-side-panel"
      )
    ).toBeInTheDocument();
    expect(columns.at(-1)).toEqual({
      sidePanel: true,
      size: expect.any(Number),
    });
  });

  it("uses the modal top-right control to close the side panel before the modal", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Existing chat",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/airi-artifacts?")) {
        return jsonResponse({
          artifacts: [
            whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 2,
            }),
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const onClose = jest.fn();

    render(<AiriChatWorkspace workspaceId="workspace-1" onClose={onClose} />);

    fireEvent.click((await screen.findAllByText("Existing chat"))[0]);
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/thread-1/messages"),
        expect.objectContaining({ cache: "no-store" })
      )
    );

    expect(
      screen.queryByRole("button", { name: "Toggle side panel" })
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Close Airi sidebar" })[0]
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });

    expect(
      (await screen.findAllByTestId("airi-builder-side-panel"))[0]
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close Airi sidebar" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close builder" })
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Toggle side panel" }).at(-1)!
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("airi-builder-side-panel")
      ).not.toBeInTheDocument()
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Close Airi sidebar" })[0]
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the compact draft and attachments while the builder is open", async () => {
    const at = new Date().toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Existing chat",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({ messages: [] });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [whatsappTemplateArtifact()] });
      return jsonResponse({ configured: false });
    });
    const { container } = render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Existing chat/ })
    );
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-artifacts?"),
        expect.anything()
      )
    );
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: {
        files: [new File(["design"], "medal.png", { type: "image/png" })],
      },
    });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(
      await screen.findByTestId("airi-builder-side-panel")
    ).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("combobox", { name: "Ask Airi" })
    ).not.toBeInTheDocument();
    fireEvent.keyUp(input, { key: "b", ctrlKey: true, altKey: true });
    fireEvent.keyUp(input, { key: "Alt", ctrlKey: true });
    fireEvent.keyUp(input, { key: "Control" });
    const closeBuilder = screen.getByRole("button", {
      name: "Toggle side panel",
    });
    act(() => closeBuilder.focus());
    fireEvent.click(closeBuilder);
    const restored = await screen.findByRole("combobox", { name: "Ask Airi" });
    expect(restored).toBe(input);
    expect(restored).toHaveValue("@");
    expect(restored).toBeEnabled();
    expect(restored).toHaveAttribute("aria-expanded", "false");
    expect(restored).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Remove medal.png" })
    ).toBeInTheDocument();
  });

  it("does not include activeBuilder for a draft chat with no selected thread", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Toggle side panel",
        })
      )[0]
    );
    const input = (
      await screen.findAllByRole("combobox", {
        name: "Ask Airi",
      })
    )[0];
    fireEvent.change(input, { target: { value: "Update the builder" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.activeBuilder).toBeUndefined();
  });

  it("includes activeBuilder in selected-chat requests when the side panel is open", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Existing chat",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/airi-artifacts?")) {
        return jsonResponse({
          artifacts: [
            whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 2,
            }),
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-1/messages/stream")) {
        return completedMessageStream();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    fireEvent.click((await screen.findAllByText("Existing chat"))[0]);
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/thread-1/messages"),
        expect.objectContaining({ cache: "no-store" })
      )
    );
    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Toggle side panel",
        })
      )[0]
    );
    expect(
      (await screen.findAllByTestId("airi-builder-side-panel"))[0]
    ).toHaveAttribute("data-has-active-thread", "true");

    const input = (
      await screen.findAllByRole("combobox", {
        name: "Ask Airi",
      })
    )[0];
    fireEvent.change(input, { target: { value: "Update the builder" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/thread-1/messages/stream"),
        expect.objectContaining({ method: "POST" })
      )
    );
    const streamCall = mockFetch.mock.calls.find(([url]) =>
      String(url).endsWith("/airi-chats/thread-1/messages/stream")
    );
    const body = JSON.parse(String(streamCall?.[1]?.body));
    expect(body.activeBuilder).toEqual(
      expect.objectContaining({
        kind: "whatsapp_template",
        artifactId: "artifact-1",
        revision: 2,
        templateDraft: expect.objectContaining({
          name: "airi_whatsapp_template",
        }),
      })
    );
  });

  it("applies matching Airi builder patches to the open builder", async () => {
    let releaseStream!: () => void;
    const wait = new Promise<void>(resolve => {
      releaseStream = resolve;
    });
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.includes("/airi-artifacts?")) {
        return jsonResponse({
          artifacts: [
            whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 0,
              name: "patched_template",
            }),
          ],
        });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream({
          wait,
          metadata: {
            airiArtifact: whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 0,
              name: "patched_template",
            }),
            airiBuilderPatch: {
              kind: "whatsapp_template",
              baseRevision: 0,
              nextRevision: 1,
              summary: "Updated template",
              snapshot: {
                templateDraft: {
                  kind: "whatsapp_template",
                  name: "patched_template",
                  language: "en",
                  category: "MARKETING",
                  components: [
                    {
                      type: "BODY",
                      text: "Patched body",
                    },
                  ],
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Toggle side panel",
        })
      )[0]
    );
    const input = (
      await screen.findAllByRole("combobox", {
        name: "Ask Airi",
      })
    )[0];
    fireEvent.change(input, { target: { value: "Update the builder" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    await act(async () => {
      releaseStream();
    });

    await waitFor(() => expectAnyBuilderTemplateName("patched_template"));
  });

  it("keeps local edits when an Airi builder patch is stale", async () => {
    let releaseStream!: () => void;
    const wait = new Promise<void>(resolve => {
      releaseStream = resolve;
    });
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Existing chat",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/airi-artifacts/artifact-1")) {
        return jsonResponse({
          artifact: whatsappTemplateArtifact({
            id: "artifact-1",
            revision: 2,
            name: "local_template",
          }),
        });
      }
      if (url.includes("/airi-artifacts?")) {
        return jsonResponse({
          artifacts: [
            whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 1,
              name: "loaded_template",
            }),
          ],
        });
      }
      if (url.endsWith("/airi-chats/thread-1/messages/stream")) {
        return completedMessageStream({
          wait,
          metadata: {
            airiArtifact: whatsappTemplateArtifact({
              id: "artifact-1",
              revision: 1,
              name: "stale_template",
            }),
            airiBuilderPatch: {
              kind: "whatsapp_template",
              baseRevision: 0,
              nextRevision: 1,
              summary: "Stale template update",
              snapshot: {
                templateDraft: {
                  kind: "whatsapp_template",
                  name: "stale_template",
                  language: "en",
                  category: "MARKETING",
                  components: [
                    {
                      type: "BODY",
                      text: "Stale body",
                    },
                  ],
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    fireEvent.click((await screen.findAllByText("Existing chat"))[0]);
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/airi-chats/thread-1/messages"),
        expect.objectContaining({ cache: "no-store" })
      )
    );

    fireEvent.click(
      (
        await screen.findAllByRole("button", {
          name: "Toggle side panel",
        })
      )[0]
    );
    const input = (
      await screen.findAllByRole("combobox", {
        name: "Ask Airi",
      })
    )[0];
    fireEvent.change(input, { target: { value: "Update the builder" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    await waitFor(() =>
      expect(
        screen.getAllByTestId("airi-builder-side-panel")[0]
      ).toHaveAttribute("data-has-active-thread", "true")
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Edit local template" })[0]
    );
    await waitFor(() => expectAnyBuilderTemplateName("local_template"));

    await act(async () => {
      releaseStream();
    });

    await waitFor(() => expectAnyBuilderTemplateName("local_template"));
    expect(
      screen.getAllByRole("button", {
        name: "Apply update: Stale template update",
      })[0]
    ).toBeInTheDocument();
  });

  it("renders Airi campaign package metadata with blocked tool actions", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) {
        return jsonResponse({ sources: [] });
      }
      if (url.endsWith("/airi-chats")) {
        return jsonResponse({ threads: [] });
      }
      if (url.endsWith("/airi-chats/messages/stream")) {
        return completedMessageStream({
          metadata: {
            airiCampaignPackage: {
              title: "Pricing lead win-back",
              goal: "Recover warm leads who asked about pricing.",
              audience: "Warm WhatsApp leads",
              angle: "Helpful follow-up with one clear reply",
              evidence: ["Recent conversations mention pricing."],
              tools: {
                whatsapp: {
                  available: true,
                  label: "WhatsApp",
                  source: "workspace_source",
                  actionHref:
                    "/panel/w/workspace-1/messengers/whatsapp-templates",
                },
                scenarios: {
                  available: true,
                  label: "Scenarios",
                  source: "built_in",
                  actionHref: "/panel/w/workspace-1/scenarios",
                },
                bulkCampaigns: {
                  available: true,
                  label: "Bulk campaigns",
                  source: "built_in",
                  actionHref: "/panel/w/workspace-1/bulk-campaigns",
                },
                canva: {
                  available: false,
                  label: "Canva",
                  source: "not_configured",
                  reason: "Connect Canva to use approved brand templates.",
                  actionHref:
                    "/panel/w/workspace-1/settings/integrations?integration=canva",
                },
                visualGeneration: {
                  available: false,
                  label: "Visual generation",
                  source: "not_configured",
                  reason:
                    "Connect Higgsfield or use configured Google creative generation.",
                  actionHref:
                    "/panel/w/workspace-1/settings/integrations?integration=higgsfield",
                },
                audioGeneration: {
                  available: false,
                  label: "Audio generation",
                  source: "not_configured",
                  reason:
                    "Connect ElevenLabs in Settings > Integrations to generate voiceovers for this workspace.",
                  actionHref:
                    "/panel/w/workspace-1/settings/integrations?integration=elevenlabs",
                },
                metaAds: {
                  available: false,
                  label: "Meta Ads",
                  source: "not_configured",
                  reason: "Connect Meta Ads before ad planning.",
                  actionHref:
                    "/panel/w/workspace-1/settings/integrations?integration=meta_ads",
                },
              },
              steps: [
                {
                  id: "template",
                  kind: "whatsapp_template",
                  title: "Draft WhatsApp template",
                  description: "Create a compliant re-engagement template.",
                  status: "ready",
                  tool: "whatsapp",
                  actionHref:
                    "/panel/w/workspace-1/messengers/whatsapp-templates",
                },
                {
                  id: "voiceover",
                  kind: "audio_asset",
                  title: "Generate voiceover",
                  description: "Create a short voiceover.",
                  status: "blocked",
                  tool: "audioGeneration",
                  blockers: ["Connect ElevenLabs first."],
                  actionHref:
                    "/panel/w/workspace-1/settings/integrations?integration=elevenlabs",
                },
              ],
              checks: [{ label: "Human approval", status: "pending" }],
              nextAction: "Review the WhatsApp template.",
            },
            airiCampaignArtifact: {
              id: "campaign-artifact-1",
              kind: "marketing_campaign",
              revision: 0,
              status: "draft",
              validation: { status: "valid", issues: [] },
            },
            airiScenarioGeneratorDraft: {
              id: "airi-campaign:pricing-lead-win-back",
              workspaceId: "workspace-1",
              title: "Pricing lead win-back",
              summary: "Recover warm leads with a helpful follow-up.",
              prompt:
                "@WhatsApp Build a follow-up workflow for warm leads.\nGoal: Recover pricing leads.",
              workflowKind: "follow_up_workflow",
              sendMode: "trigger",
              channels: ["whatsapp"],
              triggerStrategy: "customer_intent_or_classification",
              recipientSourceSummary: "Warm WhatsApp leads",
              sourceIds: ["wa-1"],
            },
            airiBulkCampaignDraft: {
              id: "airi-bulk:pricing-lead-win-back",
              workspaceId: "workspace-1",
              title: "Pricing lead win-back",
              channel: "whatsapp",
              campaignName: "Pricing lead win-back",
              goal: "Recover warm leads who asked about pricing.",
              angle: "Helpful follow-up with one clear reply",
              recipientSourceSummary: "Warm WhatsApp leads",
              templateSelection: {
                name: "pricing_lead_win_back",
                language: "en",
                category: "MARKETING",
              },
              templateReadiness: "needs_template_approval",
              sourceIds: ["wa-1"],
            },
            airiCreativeAssetDrafts: [
              {
                id: "airi-creative:pricing-lead-win-back:voiceover",
                workspaceId: "workspace-1",
                kind: "audio_asset",
                title: "Generate voiceover",
                summary: "Create a short voiceover.",
                prompt: "Read a warm WhatsApp follow-up.",
                provider: "elevenlabs",
                providerSource: "workspace_source",
                mode: "text_to_speech",
                sourceIds: ["elevenlabs-1"],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const input = (
      await screen.findAllByRole("combobox", {
        name: "Ask Airi",
      })
    )[0];
    fireEvent.change(input, {
      target: { value: "Create a campaign with voiceover" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    expect(
      (await screen.findAllByTestId("airi-campaign-package-card"))[0]
    ).toBeInTheDocument();
    expect(
      screen.getAllByTestId("airi-campaign-artifact-badge")[0]
    ).toHaveTextContent("Saved work plan - rev 0 - draft");
    expect(screen.getAllByText("Pricing lead win-back")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Generate voiceover")[0]).toBeInTheDocument();
    expect(
      screen.getAllByText("Connect ElevenLabs first.")[0]
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /Connect tool/i })[0]
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/settings/integrations?integration=elevenlabs"
    );
    const openAiriCreateLink = screen.getAllByRole("link", {
      name: /Open in Airi Create/i,
    })[0];
    expect(openAiriCreateLink).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/scenarios?airiCreate=1"
    );

    fireEvent.click(openAiriCreateLink);

    expect(
      JSON.parse(
        window.localStorage.getItem(
          "airi:scenario-generator-draft:v1:workspace-1"
        ) || "{}"
      )
    ).toEqual(
      expect.objectContaining({
        title: "Pricing lead win-back",
        prompt: expect.stringContaining("@WhatsApp"),
        channels: ["whatsapp"],
      })
    );

    const openBulkCampaignLink = screen.getAllByRole("link", {
      name: /Open bulk campaign draft/i,
    })[0];
    expect(openBulkCampaignLink).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/bulk-campaigns?airiBulkDraft=1"
    );

    fireEvent.click(openBulkCampaignLink);

    expect(
      JSON.parse(
        window.localStorage.getItem(
          "airi:bulk-campaign-draft:v1:workspace-1"
        ) || "{}"
      )
    ).toEqual(
      expect.objectContaining({
        title: "Pricing lead win-back",
        channel: "whatsapp",
        campaignName: "Pricing lead win-back",
        templateSelection: expect.objectContaining({
          name: "pricing_lead_win_back",
        }),
      })
    );

    const openCreativeAssetsLink = screen.getAllByRole("link", {
      name: /Open creative asset drafts/i,
    })[0];
    expect(openCreativeAssetsLink).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/assets?airiAssetDraft=1"
    );

    fireEvent.click(openCreativeAssetsLink);

    expect(
      JSON.parse(
        window.localStorage.getItem(
          "airi:creative-asset-drafts:v1:workspace-1"
        ) || "[]"
      )
    ).toEqual([
      expect.objectContaining({
        title: "Generate voiceover",
        provider: "elevenlabs",
        mode: "text_to_speech",
      }),
    ]);
  });
});

describe("AiriChatWorkspace thread message ownership", () => {
  const at = new Date("2026-06-12T00:00:00.000Z").toISOString();

  function thread(id: string, title: string) {
    return { id, title, source: "manual", pinnedAt: null, updatedAt: at };
  }

  function assistantMessage(threadId: string, content: string) {
    return {
      id: `${threadId}-answer`,
      threadId,
      role: "assistant",
      content,
      metadata: null,
      createdAt: at,
    };
  }

  function messageLoads(threadId: string) {
    return mockFetch.mock.calls.filter(([url]) =>
      String(url).endsWith(`/airi-chats/${threadId}/messages`)
    ).length;
  }

  it("shows a chat's history again after Back and reopening it in the drawer", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: [thread("thread-1", "Campaign ideas")],
        });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [assistantMessage("thread-1", "Recent campaign answer")],
        });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Campaign ideas/ })
    );
    expect(
      await screen.findByText("Recent campaign answer")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to Airi start" }));
    expect(await screen.findByText("Try Airi for...")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Campaign ideas/ }));

    expect(
      await screen.findByText("Recent campaign answer")
    ).toBeInTheDocument();
    expect(screen.queryByText("Try Airi for...")).not.toBeInTheDocument();
    // The cached history shows at once and is then read again.
    await waitFor(() => expect(messageLoads("thread-1")).toBe(2));
  });

  it("shows a thread's history again after New chat and reselecting it on the page", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({ threads: [thread("thread-1", "Existing chat")] });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [assistantMessage("thread-1", "Existing answer")],
        });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    fireEvent.click((await screen.findAllByText("Existing chat"))[0]);
    expect(
      (await screen.findAllByText("Existing answer"))[0]
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New Airi chat" }));
    await waitFor(() =>
      expect(screen.queryByText("Existing answer")).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getAllByText("Existing chat")[0]);

    expect(
      (await screen.findAllByText("Existing answer"))[0]
    ).toBeInTheDocument();
    // The cached history shows at once and is then read again.
    await waitFor(() => expect(messageLoads("thread-1")).toBe(2));
  });

  it("offers a working Retry after a chat's history fails to load and holds sends meanwhile", async () => {
    let failLoad = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: [thread("thread-1", "Campaign ideas")],
        });
      if (url.endsWith("/airi-chats/thread-1/messages")) {
        if (failLoad) {
          return {
            ok: false,
            status: 503,
            headers: new Headers(),
            json: async () => ({ error: "Messages are unavailable" }),
          } as Response;
        }
        return jsonResponse({
          messages: [assistantMessage("thread-1", "Recovered answer")],
        });
      }
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Campaign ideas/ })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Messages are unavailable"
    );
    expect(screen.queryByText("Try Airi for...")).not.toBeInTheDocument();
    const input = screen.getByRole("combobox", { name: "Ask Airi" });
    fireEvent.change(input, { target: { value: "Follow up" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });

    failLoad = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Recovered answer")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("Follow up");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(
      mockFetch.mock.calls.filter(([url]) =>
        String(url).includes("/messages/stream")
      )
    ).toHaveLength(0);
  });

  it("retries a failed chat list load from the error banner", async () => {
    let failThreads = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) {
        if (failThreads) {
          return {
            ok: false,
            status: 500,
            headers: new Headers(),
            json: async () => ({ error: "Chats are unavailable" }),
          } as Response;
        }
        return jsonResponse({
          threads: [thread("thread-1", "Campaign ideas")],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chats are unavailable"
    );
    failThreads = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("button", { name: /Campaign ideas/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers the chat-list Retry only next to the chat-list failure, not a later send error", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return {
          ok: false,
          status: 500,
          headers: new Headers(),
          json: async () => ({ error: "Chats are unavailable" }),
        } as Response;
      if (url.endsWith("/airi-chats/messages/stream"))
        return {
          ok: false,
          status: 429,
          headers: new Headers(),
          json: async () => ({ error: "Airi has reached its limit" }),
        } as Response;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chats are unavailable"
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "Plan a campaign" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Airi has reached its limit"
      )
    );
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
  });

  it("shows a failed chat list as an error with Retry in the page lists, not as no chats", async () => {
    let failThreads = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) {
        if (failThreads) {
          return {
            ok: false,
            status: 500,
            headers: new Headers(),
            json: async () => ({ error: "Chats are unavailable" }),
          } as Response;
        }
        return jsonResponse({
          threads: [thread("thread-1", "Campaign ideas")],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const notices = await screen.findAllByTestId("airi-threads-load-error");
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice).toHaveTextContent("Chats are unavailable");
    }
    expect(screen.queryByText("No chats yet.")).not.toBeInTheDocument();

    failThreads = false;
    fireEvent.click(
      within(notices[notices.length - 1]).getByRole("button", {
        name: "Retry",
      })
    );

    expect(
      (await screen.findAllByText("Campaign ideas"))[0]
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("airi-threads-load-error")
    ).not.toBeInTheDocument();
  });

  it("holds a send while the newly selected thread loads and never mixes threads", async () => {
    const secondThreadMessages = deferred<Response>();
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: [
            thread("thread-1", "First chat"),
            thread("thread-2", "Second chat"),
          ],
        });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [assistantMessage("thread-1", "First thread answer")],
        });
      if (url.endsWith("/airi-chats/thread-2/messages"))
        return secondThreadMessages.promise;
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats/thread-2/messages/stream")) {
        const body = JSON.parse(String(init?.body));
        return streamingResponse({
          wait: Promise.resolve(),
          beforeWait: [
            {
              type: "user_message",
              message: {
                id: "thread-2-user",
                threadId: "thread-2",
                role: "user",
                content: body.content,
                metadata: null,
                createdAt: at,
              },
              at,
            },
            {
              type: "assistant_message",
              message: {
                ...assistantMessage("thread-2", "Second thread reply"),
                id: "thread-2-reply",
              },
              at,
            },
            { type: "done", thread: thread("thread-2", "Second chat"), at },
          ],
          afterWait: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    fireEvent.click((await screen.findAllByText("First chat"))[0]);
    expect(
      (await screen.findAllByText("First thread answer"))[0]
    ).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Second chat")[0]);
    await waitFor(() =>
      expect(screen.queryByText("First thread answer")).not.toBeInTheDocument()
    );
    const input = screen.getAllByRole("combobox", { name: "Ask Airi" })[0];
    fireEvent.change(input, { target: { value: "Question for second" } });
    expect(
      screen.getAllByRole("button", { name: "Send message" })[0]
    ).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      mockFetch.mock.calls.filter(([url]) =>
        String(url).includes("/messages/stream")
      )
    ).toHaveLength(0);

    await act(async () => {
      secondThreadMessages.resolve(
        jsonResponse({
          messages: [assistantMessage("thread-2", "Second thread history")],
        })
      );
    });
    expect(
      (await screen.findAllByText("Second thread history"))[0]
    ).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);

    expect(
      (await screen.findAllByText("Second thread reply"))[0]
    ).toBeInTheDocument();
    expect(screen.getAllByText("Second thread history")[0]).toBeInTheDocument();
    expect(screen.queryByText("First thread answer")).not.toBeInTheDocument();
  });
});

describe("AiriChatWorkspace template draft previews", () => {
  afterEach(() => {
    mockBuilderCatalogsFailed = false;
  });

  it("shows a compact preview failure in a chat template card, not the builder's", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    mockBuilderCatalogsFailed = true;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats"))
        return jsonResponse({
          threads: [
            {
              id: "thread-1",
              title: "Template ideas",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
          ],
        });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({
          messages: [
            {
              id: "answer-1",
              threadId: "thread-1",
              role: "assistant",
              content: "Here is a draft.",
              metadata: {
                whatsappTemplateDraft: {
                  kind: "whatsapp_template",
                  name: "spring_offer",
                  language: "en",
                  category: "MARKETING",
                  components: [{ type: "BODY", text: "Hi {{1}}" }],
                },
              },
              createdAt: at,
            },
          ],
        });
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Template ideas/ })
    );

    const failure = await screen.findByTestId("airi-preview-load-failure");
    expect(failure).toHaveTextContent("The preview could not load.");
    expect(screen.queryByText(/The builder could not load/)).toBeNull();
    expect(screen.queryByTestId("template-phone-preview")).toBeNull();
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(mockRetryBuilderCatalogs).toHaveBeenCalledTimes(1);
  });
});

describe("AiriChatWorkspace streamed answers", () => {
  const at = new Date("2026-06-12T00:00:00.000Z").toISOString();

  /** An SSE response whose events are written as each step is reached. */
  function steppedStream(steps: Array<unknown | Promise<void>>) {
    const encoder = new TextEncoder();
    return {
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "text/event-stream; charset=utf-8"
            : null,
      },
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const step of steps) {
            if (step instanceof Promise) {
              await step;
              continue;
            }
            controller.enqueue(
              encoder.encode(sseFrame((step as { type: string }).type, step))
            );
          }
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  function delta(text: string) {
    return { type: "assistant_delta", threadId: "thread-1", text };
  }

  it("shows the latest streamed text, follows a fallback, and yields to the final message", async () => {
    const fallback = deferred<void>();
    const finish = deferred<void>();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/messages/stream"))
        return steppedStream([
          {
            type: "thread",
            thread: {
              id: "thread-1",
              title: "New chat",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
            at,
          },
          {
            type: "user_message",
            message: {
              id: "user-message-1",
              threadId: "thread-1",
              role: "user",
              content: "Stream please",
              metadata: null,
              createdAt: at,
            },
            at,
          },
          delta("Hel"),
          delta("Hello **wor"),
          fallback.promise,
          delta("Fallback"),
          finish.promise,
          {
            type: "assistant_message",
            message: {
              id: "assistant-message-1",
              threadId: "thread-1",
              role: "assistant",
              content: "Final **answer**.",
              metadata: null,
              createdAt: at,
            },
            at,
          },
          {
            type: "done",
            thread: {
              id: "thread-1",
              title: "Streamed",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
            at,
          },
        ]);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.change(
      await screen.findByRole("combobox", { name: "Ask Airi" }),
      { target: { value: "Stream please" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(screen.getByTestId("airi-streaming-answer")).toHaveTextContent(
        "Hello **wor"
      )
    );
    expect(screen.getByTestId("airi-streaming-answer")).not.toHaveTextContent(
      "HelHello"
    );
    // The streamed text changes inside the role="log" conversation; it must
    // not be a live region of its own (aria-busy alone is not honoured by
    // every screen reader), so only the final message is announced.
    expect(screen.getByTestId("airi-streaming-answer")).toHaveAttribute(
      "aria-live",
      "off"
    );
    expect(
      screen
        .getByRole("log", { name: "Airi conversation" })
        .contains(screen.getByTestId("airi-streaming-answer"))
    ).toBe(true);

    await act(async () => fallback.resolve());
    await waitFor(() =>
      expect(screen.getByTestId("airi-streaming-answer")).toHaveTextContent(
        /^Fallback$/
      )
    );

    await act(async () => finish.resolve());
    await waitFor(() =>
      expect(
        screen.queryByTestId("airi-streaming-answer")
      ).not.toBeInTheDocument()
    );
    expect(screen.getByText("answer")).toBeInTheDocument();
    expect(screen.queryByText("Fallback")).not.toBeInTheDocument();
  });

  it("drops the streamed text when the answer fails", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/messages/stream"))
        return steppedStream([
          {
            type: "thread",
            thread: {
              id: "thread-1",
              title: "New chat",
              source: "manual",
              pinnedAt: null,
              updatedAt: at,
            },
            at,
          },
          {
            type: "user_message",
            message: {
              id: "user-message-1",
              threadId: "thread-1",
              role: "user",
              content: "Stream please",
              metadata: null,
              createdAt: at,
            },
            at,
          },
          delta("Partial answer"),
          { type: "error", message: "The answer failed", at },
        ]);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.change(
      await screen.findByRole("combobox", { name: "Ask Airi" }),
      { target: { value: "Stream please" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      (await screen.findAllByText("The answer failed"))[0]
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("airi-streaming-answer")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Partial answer")).not.toBeInTheDocument();
  });
});

describe("AiriChatWorkspace new chat titles", () => {
  const at = new Date("2026-06-12T00:00:00.000Z").toISOString();

  function chat(title: string) {
    return {
      id: "thread-1",
      title,
      source: "manual",
      pinnedAt: null,
      updatedAt: at,
    };
  }

  // The generated title is written after the stream closes, so "done"
  // still carries the first-message fallback title.
  function mockNewChatTurn() {
    let listLoads = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) {
        listLoads += 1;
        return jsonResponse({
          threads: listLoads === 1 ? [] : [chat("Campaign plan")],
        });
      }
      if (url.includes("/airi-artifacts?"))
        return jsonResponse({ artifacts: [] });
      if (url.endsWith("/airi-chats/thread-1/messages"))
        return jsonResponse({ messages: [] });
      if (url.endsWith("/airi-chats/messages/stream"))
        return streamingResponse({
          wait: Promise.resolve(),
          beforeWait: [
            { type: "thread", thread: chat("Plan a campaign"), at },
            {
              type: "user_message",
              message: {
                id: "user-message-1",
                threadId: "thread-1",
                role: "user",
                content: "Plan a campaign",
                metadata: null,
                createdAt: at,
              },
              at,
            },
          ],
          afterWait: [
            {
              type: "assistant_message",
              message: {
                id: "assistant-message-1",
                threadId: "thread-1",
                role: "assistant",
                content: "Here is a plan.",
                metadata: null,
                createdAt: at,
              },
              at,
            },
            { type: "done", thread: chat("Plan a campaign"), at },
          ],
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    return () => listLoads;
  }

  async function advance(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  async function sendFirstMessage() {
    render(<AiriChatWorkspace workspaceId="workspace-1" />);
    const input = (
      await screen.findAllByRole("combobox", { name: "Ask Airi" })
    )[0];
    fireEvent.change(input, { target: { value: "Plan a campaign" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send message" })[0]);
    expect(
      (await screen.findAllByText("Here is a plan."))[0]
    ).toBeInTheDocument();
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it("reads the chat list once more after a new chat's turn to show its generated title", async () => {
    const listLoads = mockNewChatTurn();

    await sendFirstMessage();
    expect(listLoads()).toBe(1);
    expect(screen.getAllByText("Plan a campaign").length).toBeGreaterThan(0);

    await advance(AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS - 1000);
    expect(listLoads()).toBe(1);

    await advance(1000);
    expect(listLoads()).toBe(2);
    expect(
      (await screen.findAllByText("Campaign plan"))[0]
    ).toBeInTheDocument();
    // The open chat stays open and nothing reports a load.
    expect(screen.getAllByText("Here is a plan.")[0]).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // One refresh, not a polling loop.
    await advance(AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS * 5);
    expect(listLoads()).toBe(2);
  });

  it("drops the pending title refresh when the user leaves the new chat", async () => {
    const listLoads = mockNewChatTurn();

    await sendFirstMessage();
    fireEvent.click(screen.getByRole("button", { name: "New Airi chat" }));

    await advance(AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS * 2);
    expect(listLoads()).toBe(1);
  });

  it("drops the pending title refresh when the workspace closes", async () => {
    const listLoads = mockNewChatTurn();

    await sendFirstMessage();
    cleanup();

    await advance(AIRI_NEW_THREAD_TITLE_REFRESH_DELAY_MS * 2);
    expect(listLoads()).toBe(1);
  });
});

describe("AiriChatWorkspace conversation scrolling", () => {
  it("leaves scrolling to the sticky conversation and only jumps down on send", async () => {
    const at = new Date("2026-06-12T00:00:00.000Z").toISOString();
    const release = deferred<void>();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources"))
        return jsonResponse({ sources: [] });
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/thread-1/messages/stream"))
        return completedMessageStream();
      if (url.endsWith("/airi-chats/messages/stream"))
        return streamingResponse({
          wait: release.promise,
          beforeWait: [
            {
              type: "thread",
              thread: {
                id: "thread-1",
                title: "New chat",
                source: "manual",
                pinnedAt: null,
                updatedAt: at,
              },
              at,
            },
            {
              type: "user_message",
              message: {
                // The second turn (completedMessageStream) uses the "-1" ids.
                id: "scroll-user-message",
                threadId: "thread-1",
                role: "user",
                content: "Scroll question",
                metadata: null,
                createdAt: at,
              },
              at,
            },
            ...["intent", "retrieval", "generation"].map(id => ({
              type: "stage",
              id,
              label: id,
              status: "running",
              at,
            })),
          ],
          afterWait: [
            {
              type: "assistant_message",
              message: {
                id: "scroll-assistant-message",
                threadId: "thread-1",
                role: "assistant",
                content: "Scroll answer",
                metadata: null,
                createdAt: at,
              },
              at,
            },
          ],
        });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    render(
      <AiriChatWorkspace
        workspaceId="workspace-1"
        compact
        onClose={jest.fn()}
      />
    );

    fireEvent.change(
      await screen.findByRole("combobox", { name: "Ask Airi" }),
      { target: { value: "Scroll question" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/messages/stream"),
        expect.anything()
      )
    );
    await act(async () => release.resolve());
    expect(await screen.findByText("Scroll answer")).toBeInTheDocument();

    expect(
      screen.getByRole("log", { name: "Airi conversation" })
    ).toBeInTheDocument();
    expect(mockConversationScrollToBottom).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Ask Airi" }), {
      target: { value: "Update the builder" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Updated.")).toBeInTheDocument();
    expect(mockConversationScrollToBottom).toHaveBeenCalledTimes(1);
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });
});
