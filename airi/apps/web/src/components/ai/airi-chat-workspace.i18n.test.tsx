/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { AiriChatWorkspace } from "./airi-chat-workspace";
import {
  completedMessageStream,
  installAiriChatWorkspaceTestGlobals,
  jsonResponse,
} from "./airi-chat-workspace-test-utils";

jest.mock("next-intl", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriChatNextIntlMock("ru")
);

jest.mock("@/components/ai/airi-builder-side-panel", () =>
  jest
    .requireActual("./airi-chat-workspace-test-utils")
    .createAiriBuilderSidePanelMock()
);

// use-stick-to-bottom ships ESM only; stand in for its sticky scroller.
jest.mock("@/components/ui/conversation", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Conversation: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { role: "log" }, children),
    ConversationContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
    ConversationScrollButton: () => null,
  };
});

jest.mock("@/components/ai/airi-builder-intl-provider", () => ({
  AiriBuilderIntlProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  AiriPreviewLoadFailure: () => null,
}));

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  installAiriChatWorkspaceTestGlobals(mockFetch);
});

function conversationSources(count: number) {
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
        count,
      },
    ],
  });
}

describe("AiriChatWorkspace in Russian", () => {
  it("greets a new workspace in Russian", async () => {
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

    expect(
      await screen.findByText("Попробуйте Airi для...")
    ).toBeInTheDocument();
    expect(screen.getByText("Чем займёмся?")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Что умеет Airi" })
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Предложенные действия Airi")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Спросите Airi" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Отправить сообщение" })
    ).toBeInTheDocument();
    expect(screen.queryByText("What should we work on?")).toBeNull();
  });

  it("counts chats with Russian plurals and sends the Russian prompt", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) return conversationSources(3);
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      if (url.endsWith("/airi-chats/messages/stream"))
        return completedMessageStream();
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const card = (
      await screen.findAllByRole("button", {
        name: /Чаты с клиентами готовы/,
      })
    )[0];
    expect(card).toHaveTextContent("Данные пространства");
    expect(card).toHaveTextContent(/3\s*чата/);

    fireEvent.click(card);

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
    expect(body.content).toBe(
      "Изучи мои переписки с клиентами и найди частые вопросы, сигналы к покупке и пробелы в поддержке, которыми стоит заняться в первую очередь."
    );
  });

  it("formats large counts for Russian and agrees the label with the thousand", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/airi-chats/sources")) return conversationSources(1534);
      if (url.endsWith("/airi-chats")) return jsonResponse({ threads: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<AiriChatWorkspace workspaceId="workspace-1" />);

    const card = (
      await screen.findAllByRole("button", {
        name: /Чаты с клиентами готовы/,
      })
    )[0];
    // jest-dom collapses the formatter's no-break space to a plain one.
    const expected = new Intl.NumberFormat("ru", {
      notation: "compact",
      maximumFractionDigits: 1,
    })
      .format(1534)
      .replace(/\s/g, " ");
    expect(card).toHaveTextContent(`${expected}чатов`);
    expect(card).not.toHaveTextContent("1.5K");
    // 1534 alone would take "чата"; after "тыс." it must be "чатов".
    expect(card).not.toHaveTextContent(/тыс.s*чата/);
  });
});
