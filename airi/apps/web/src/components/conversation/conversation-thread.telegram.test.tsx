/**
 * @jest-environment jsdom
 */

const mockLocaleContext = createContext("en");

jest.mock("next-intl", () => ({
  useLocale: () => useContext(mockLocaleContext),
  useTranslations: () => (key: string) => key,
}));

// Keep the real helpers while making the SWC export observable with spyOn.
jest.mock("@/lib/utils", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/utils"),
}));

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

jest.mock("@/components/ui/audio-player", () => ({
  AudioPlayerButton: () => null,
  AudioPlayerDuration: () => null,
  AudioPlayerError: () => null,
  AudioPlayerProgress: () => null,
  AudioPlayerProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AudioPlayerSpeed: () => null,
  AudioPlayerTime: () => null,
}));

jest.mock("@/components/conversation/video-player", () => ({
  VideoPlayer: ({ src }: { src: string }) => (
    <div data-testid="video-player" data-src={src} />
  ),
}));

const captureClientEventMock = jest.fn();
jest.mock("@/lib/posthog/client", () => ({
  captureClientEvent: (...args: unknown[]) => captureClientEventMock(...args),
}));

jest.mock("marked", () => {
  class Renderer {
    parser = {
      parseInline: () => "",
    };
  }

  return {
    marked: {
      Renderer,
      lexer: (input: string) => [
        {
          type: "paragraph",
          text: input,
          tokens: [{ type: "text", text: input }],
        },
      ],
      parse: (input: string) => input,
    },
  };
});

import {
  fireEvent,
  render as renderWithoutProviders,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ConversationThread } from "@/components/conversation/conversation-thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { marked } from "marked";
import { createContext, useContext, useState } from "react";
import * as messageUtils from "@/lib/utils";
import type { PopulatedMessage } from "@/types/models";

type TestAuthor = {
  _id: string;
  avatar_url?: string;
  firstName?: string;
  isBot?: boolean;
  username?: string;
};

type TestMessageInput = Omit<Partial<PopulatedMessage>, "_id" | "author"> & {
  _id: string;
  author?: TestAuthor | null;
  date: string;
  direction: PopulatedMessage["direction"];
  text?: string;
};

// The app root provides tooltips (app/layout.tsx); delivery chips rely on it.
function render(ui: React.ReactElement) {
  return renderWithoutProviders(ui, { wrapper: TooltipProvider });
}

function testMessage({
  author = null,
  text = "",
  ...message
}: TestMessageInput): PopulatedMessage {
  return {
    ...message,
    author: author as unknown as PopulatedMessage["author"],
    text,
  } as unknown as PopulatedMessage;
}

describe("ConversationThread Telegram group rendering", () => {
  it("does not regroup unchanged messages when unrelated parent state changes", () => {
    const groupMessages = jest.spyOn(messageUtils, "groupMessagesByDate");
    const messages = [
      testMessage({
        _id: "unchanged-message",
        text: "Keep this conversation visible",
        date: "2026-01-01T00:00:00.000Z",
        direction: "inbound",
      }),
    ];
    function Parent() {
      const [updates, setUpdates] = useState(0);
      return (
        <>
          <button onClick={() => setUpdates(value => value + 1)}>
            Parent updates: {updates}
          </button>
          <ConversationThread
            conversationId="conv_1"
            highlightedMessageId={null}
            messages={messages}
          />
        </>
      );
    }

    try {
      render(<Parent />);
      expect(screen.getByText("Keep this conversation visible")).not.toBeNull();
      expect(groupMessages).toHaveBeenCalledTimes(1);

      fireEvent.click(
        screen.getByRole("button", { name: "Parent updates: 0" })
      );

      expect(
        screen.getByRole("button", { name: "Parent updates: 1" })
      ).not.toBeNull();
      expect(screen.getByText("Keep this conversation visible")).not.toBeNull();
      expect(groupMessages).toHaveBeenCalledTimes(1);
    } finally {
      groupMessages.mockRestore();
    }
  });

  it("updates date headings when locale context changes with unchanged messages", () => {
    const thread = (
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "localized-message",
            text: "Same conversation",
            date: "2020-01-01T12:00:00.000Z",
            direction: "inbound",
          }),
        ]}
      />
    );
    const view = render(
      <mockLocaleContext.Provider value="en">
        {thread}
      </mockLocaleContext.Provider>
    );
    expect(screen.getByText("1 January 2020")).not.toBeNull();

    view.rerender(
      <mockLocaleContext.Provider value="ru">
        {thread}
      </mockLocaleContext.Provider>
    );

    expect(screen.queryByText("1 January 2020")).toBeNull();
    expect(screen.getByText("1 января 2020")).not.toBeNull();
    expect(screen.getByText("Same conversation")).not.toBeNull();
  });

  it("updates delivery state and search highlights for an existing message", () => {
    const message = testMessage({
      _id: "updated-message",
      text: "Your delivery is ready",
      date: "2026-01-01T12:00:00.000Z",
      direction: "outbound",
      delivery: { status: "delivered" },
    });
    const props = {
      conversationId: "conv_1",
      highlightedMessageId: null,
      channel: "whatsapp",
    };
    const view = render(<ConversationThread {...props} messages={[message]} />);
    expect(screen.getByLabelText("Message delivered")).not.toBeNull();

    view.rerender(
      <ConversationThread
        {...props}
        messages={[{ ...message, delivery: { status: "read" } }]}
        searchQuery="delivery"
      />
    );

    expect(screen.queryByLabelText("Message delivered")).toBeNull();
    expect(screen.getByLabelText("Message read")).not.toBeNull();
    expect(screen.getByText("delivery").tagName).toBe("MARK");
  });

  it("keeps sender avatars for groups without repeating the one-to-one header identity", () => {
    const message = testMessage({
      _id: "mobile-inbound",
      text: "Customer message",
      date: "2026-01-01T00:00:00.000Z",
      direction: "inbound",
      author: { _id: "customer", firstName: "Alice" },
    });
    const props = {
      conversationId: "conv_1",
      highlightedMessageId: null,
      messages: [message],
    };
    const view = render(<ConversationThread {...props} />);

    expect(view.container.querySelector('[data-slot="avatar"]')).toBeNull();

    view.rerender(<ConversationThread {...props} showInboundAuthorNames />);
    expect(view.container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(screen.getByText("Alice")).not.toBeNull();
  });

  it("labels an unnamed group sender with the catalog placeholder", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        showInboundAuthorNames
        messages={[
          testMessage({
            _id: "unnamed-inbound",
            text: "Anyone there?",
            date: "2026-01-01T00:00:00.000Z",
            direction: "inbound",
            author: null,
          }),
        ]}
      />
    );

    expect(screen.getByText("unnamedCustomer")).not.toBeNull();
    expect(screen.queryByText("Customer")).toBeNull();
  });

  it("makes the reply action keyboard accessible inside the message footer", () => {
    const onReplyTargetSelect = jest.fn();
    const message = testMessage({
      _id: "mobile-reply",
      text: "Customer message",
      date: "2026-01-01T00:00:00.000Z",
      direction: "inbound",
    });
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[message]}
        onReplyTargetSelect={onReplyTargetSelect}
      />
    );

    const reply = screen.getByRole("button", { name: "replyToMessage" });
    reply.focus();
    expect(document.activeElement).toBe(reply);
    expect(reply.closest("[data-message-footer]")).not.toBeNull();
    fireEvent.click(reply);
    expect(onReplyTargetSelect).toHaveBeenCalledWith(message);
  });

  it("keeps document timestamps singular when the reply action is shown", () => {
    const date = "2026-01-01T12:34:00.000Z";
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        onReplyTargetSelect={jest.fn()}
        messages={[
          testMessage({
            _id: "document-reply",
            date,
            direction: "inbound",
            mediaType: "document",
            fileName: "contract.pdf",
            imageUrl: "https://example.com/contract.pdf",
          }),
        ]}
      />
    );

    expect(
      screen.getAllByText(
        new Date(date).toLocaleTimeString("en", {
          hour: "2-digit",
          minute: "2-digit",
        })
      )
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "replyToMessage" }).closest("a")
    ).toBeNull();
  });

  it("reuses unchanged Markdown and renders message edits without stale content", () => {
    const lexer = jest.spyOn(marked, "lexer");
    try {
      const message = testMessage({
        _id: "memo-message",
        text: "**Original reply**",
        date: "2026-01-01T00:00:00.000Z",
        direction: "inbound",
      });
      const props = { conversationId: "conv_1", messages: [message] };
      const view = render(
        <ConversationThread {...props} highlightedMessageId={null} />
      );
      expect(lexer).toHaveBeenCalledTimes(1);

      view.rerender(
        <ConversationThread {...props} highlightedMessageId="memo-message" />
      );
      expect(lexer).toHaveBeenCalledTimes(1);

      view.rerender(
        <ConversationThread
          {...props}
          highlightedMessageId={null}
          messages={[{ ...message, text: "**Edited reply**" }]}
        />
      );
      expect(screen.queryByText("**Original reply**")).toBeNull();
      expect(screen.getByText("**Edited reply**")).not.toBeNull();
      expect(lexer).toHaveBeenCalledTimes(2);
    } finally {
      lexer.mockRestore();
    }
  });

  it("skips unused Markdown parsing while displaying search highlights", () => {
    const lexer = jest.spyOn(marked, "lexer");
    try {
      render(
        <ConversationThread
          conversationId="conv_1"
          highlightedMessageId={null}
          searchQuery="delivery"
          messages={[
            testMessage({
              _id: "search-message",
              text: "Confirm **delivery** today",
              date: "2026-01-01T00:00:00.000Z",
              direction: "inbound",
            }),
          ]}
        />
      );
      expect(screen.getByText("delivery").tagName).toBe("MARK");
      expect(lexer).not.toHaveBeenCalled();
    } finally {
      lexer.mockRestore();
    }
  });

  it("formats message times consistently and tolerates a malformed timestamp", () => {
    const date = "2026-01-01T12:34:00.000Z";
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "valid-date",
            text: "First",
            date,
            direction: "inbound",
          }),
          testMessage({
            _id: "invalid-date",
            text: "Second",
            date: "invalid",
            direction: "inbound",
          }),
        ]}
      />
    );
    expect(
      screen.getByText(
        new Date(date).toLocaleTimeString("en", {
          hour: "2-digit",
          minute: "2-digit",
        })
      )
    ).not.toBeNull();
    const invalidRow = screen.getByText("Second").closest("[data-message-id]");
    expect(
      within(invalidRow as HTMLElement).getByText("Invalid Date")
    ).not.toBeNull();
  });

  it("renders request messages through shared chat message primitives", () => {
    const { container } = render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_1",
            text: "Inbound customer message",
            date: "2026-01-01T00:00:00.000Z",
            direction: "inbound",
            author: {
              _id: "user_1",
              firstName: "Alice",
              avatar_url: "https://example.com/alice.png",
              isBot: false,
            },
            reactions: [],
          }),
          testMessage({
            _id: "msg_2",
            text: "Outbound team reply",
            date: "2026-01-01T00:01:00.000Z",
            direction: "outbound",
            author: {
              _id: "user_2",
              firstName: "Airi",
              isBot: true,
            },
            reactions: [],
          }),
        ]}
      />
    );

    const messageRows = container.querySelectorAll('[data-slot="message"]');
    expect(messageRows).toHaveLength(2);
    expect(messageRows[0].getAttribute("data-from")).toBe("assistant");
    expect(messageRows[1].getAttribute("data-from")).toBe("user");
    expect(
      container.querySelectorAll('[data-slot="message-content"]').length
    ).toBeGreaterThanOrEqual(2);
  });

  it("shows the resolved author label and reply preview without rendering topic badges", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        showInboundAuthorNames
        messages={[
          testMessage({
            _id: "msg_1",
            text: "We deployed the fix",
            date: "2026-01-01T00:00:00.000Z",
            direction: "inbound",
            author: {
              _id: "user_1",
              firstName: "Alice",
              username: "alice_ops",
              avatar_url: "https://example.com/alice.png",
              isBot: false,
            },
            telegramMeta: {
              senderDisplayName: "Alice",
              messageThreadId: 42,
              replyToTelegramMessageId: "99",
              replyToTextPreview: "Can someone investigate the outage?",
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("Alice")).not.toBeNull();
    expect(screen.queryByText("Topic #42")).toBeNull();
    expect(
      screen.queryByText("Can someone investigate the outage?")
    ).not.toBeNull();
  });

  it("renders WhatsApp reply quote from whatsappMeta", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_wa_1",
            text: "Вот же",
            date: "2026-07-13T05:47:52.000Z",
            direction: "inbound",
            author: {
              _id: "wa_user_1",
              firstName: "AP-TRADE",
              isBot: false,
            },
            whatsappMeta: {
              replyToWhatsAppMessageId:
                "ws_wamid.HBgLNzc3NzM4NTk4MzAVAgASGBQyQTVGMkMxQUE0NzI3NTQzRjgzQQA=",
              replyToTextPreview: "140560. Один человек. AP TREID",
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("140560. Один человек. AP TREID")).not.toBeNull();
    expect(screen.queryByText("Вот же")).not.toBeNull();
  });

  it("hides the WhatsApp text edit affordance for canonical service messages", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_service"
        channel="whatsapp"
        highlightedMessageId={null}
        onMessageTextUpdated={jest.fn()}
        messages={[
          testMessage({
            _id: "msg_wa_service",
            messageId: "wamid.service-message",
            text: "Service message body",
            date: new Date().toISOString(),
            direction: "outbound",
            whatsappServiceMessage: {
              version: 1,
              kind: "text",
              bodyText: "Service message body",
              command: {
                kind: "text",
                body: "Service message body",
              },
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(
      screen.queryByRole("button", { name: "messageActionsMenuAria" })
    ).toBeNull();
  });

  it("does not render stale contact or location cards beside a canonical service message", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_service_ownership"
        channel="whatsapp"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_wa_service_ownership",
            messageId: "wamid.service-ownership",
            text: "Canonical choice",
            date: new Date().toISOString(),
            direction: "outbound",
            whatsappServiceMessage: {
              version: 1,
              kind: "reply_buttons",
              bodyText: "Canonical choice",
              command: {
                kind: "reply_buttons",
                body: "Canonical choice",
                options: [{ id: "continue", label: "Continue" }],
              },
            },
            whatsappContacts: [
              {
                name: { formatted_name: "Stale contact" },
                phones: [{ phone: "+7 701 000 0000" }],
              },
            ],
            whatsappLocation: {
              latitude: 43.2,
              longitude: 76.9,
              name: "Stale location",
              address: "Stale address",
              url: null,
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("Canonical choice")).not.toBeNull();
    expect(screen.queryByText("Continue")).not.toBeNull();
    expect(screen.queryByText("Stale contact")).toBeNull();
    expect(screen.queryByText("Stale location")).toBeNull();
    expect(screen.queryByText("Stale address")).toBeNull();
  });

  it("resolves WhatsApp reply quote from parent already loaded in thread", () => {
    const parentId =
      "ws_wamid.HBgLNzc3NzM4NTk4MzAVAgASGBQyQTVGMkMxQUE0NzI3NTQzRjgzQQA=";
    render(
      <ConversationThread
        conversationId="conv_wa_2"
        channel="whatsapp"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_parent",
            messageId: parentId,
            text: "140560. Один человек. AP TREID",
            date: "2026-07-13T05:44:43.000Z",
            direction: "inbound",
            reactions: [],
          }),
          testMessage({
            _id: "msg_reply",
            text: "Вот же",
            date: "2026-07-13T05:47:52.000Z",
            direction: "inbound",
            whatsappMeta: {
              replyToWhatsAppMessageId: parentId,
              replyToTextPreview: null,
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("140560. Один человек. AP TREID")).not.toBeNull();
    expect(
      screen.queryByText("Replying to an earlier WhatsApp message")
    ).toBeNull();
  });

  it("hides media for revoked WhatsApp messages", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_revoke"
        channel="whatsapp"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_revoked",
            text: "[Message deleted]",
            date: "2026-07-13T06:00:00.000Z",
            direction: "inbound",
            imageUrl: "https://example.com/secret.jpg",
            mediaType: "image",
            editMeta: {
              kind: "revoke",
              editedAt: "2026-07-13T06:01:00.000Z",
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("This message was deleted")).not.toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows forwarded label and group sender name", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_group"
        channel="whatsapp"
        showInboundAuthorNames
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_fwd",
            text: "Hello group",
            date: "2026-07-13T06:10:00.000Z",
            direction: "inbound",
            whatsappGroup: {
              groupId: "g1",
              senderUsername: "alice_ops",
              senderWaId: "77770001122",
            },
            whatsappMeta: {
              forwarded: true,
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("alice_ops")).not.toBeNull();
    expect(screen.queryByText("Forwarded")).not.toBeNull();
  });

  it("hides template variable dumps and location placeholder text", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_ux"
        channel="whatsapp"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_tpl",
            text: '[Template: 1] with variables: ["stb:node-1782659071569-7-949:0"]',
            date: "2026-07-13T15:22:41.000Z",
            direction: "outbound",
            whatsappTemplate: {
              name: "1",
              languageCode: "ru",
              buttons: [],
            },
            reactions: [],
          }),
          testMessage({
            _id: "msg_loc",
            text: "[Location] 51.106003, 71.396172",
            date: "2026-07-13T15:24:33.000Z",
            direction: "inbound",
            whatsappLocation: {
              latitude: 51.106003,
              longitude: 71.396172,
              name: null,
              address: null,
              url: null,
            },
            whatsappMeta: {
              replyToWhatsAppMessageId: "ws_wamid.parent",
              replyToTextPreview:
                '[Template: 1] with variables: ["stb:node-1"]',
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText(/with variables:/i)).toBeNull();
    expect(screen.queryByText(/stb:node-/i)).toBeNull();
    expect(screen.queryByText(/\[Location\]/i)).toBeNull();
    expect(screen.getByText("Shared location")).toBeTruthy();
  });

  it("renders WhatsApp CTA link and grounded reply chips", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_cta"
        channel="whatsapp"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_cta",
            text: "Pick an option",
            date: "2026-07-13T06:20:00.000Z",
            direction: "outbound",
            whatsappCtaLink: {
              title: "Open catalog",
              url: "https://example.com/catalog",
            },
            groundedReplyOptions: {
              surface: "whatsapp_button",
              options: [
                {
                  id: "opt_1",
                  label: "Pricing",
                  sourceKind: "kb",
                  sourceIds: ["kb_1"],
                },
              ],
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByText("Open catalog")).not.toBeNull();
    expect(screen.queryByText("Pricing")).not.toBeNull();
    expect(
      screen
        .getByRole("link", { name: "https://example.com/catalog" })
        .getAttribute("href")
    ).toBe("https://example.com/catalog");
  });

  it("never links stored CTA or location URLs that are not http(s)", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_unsafe"
        channel="whatsapp"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_unsafe_cta",
            text: "Pick an option",
            date: "2026-07-13T06:20:00.000Z",
            direction: "outbound",
            whatsappCtaLink: {
              title: "Open catalog",
              url: "javascript:alert(1)",
            },
          }),
          testMessage({
            _id: "msg_unsafe_location",
            text: "[Location] Office",
            date: "2026-07-13T06:21:00.000Z",
            direction: "inbound",
            whatsappLocation: {
              latitude: 51.1,
              longitude: 71.4,
              name: "Office",
              url: "javascript:alert(2)",
            },
          }),
        ]}
      />
    );

    expect(screen.queryByText("Open catalog")).toBeNull();
    const hrefs = Array.from(document.querySelectorAll("a")).map(anchor =>
      anchor.getAttribute("href")
    );
    expect(hrefs.some(href => href?.startsWith("javascript:"))).toBe(false);
    expect(hrefs).toContain("https://www.google.com/maps?q=51.1,71.4");
  });

  it("highlights search matches in the displayed text, not the stored template marker", () => {
    render(
      <ConversationThread
        conversationId="conv_wa_search"
        channel="whatsapp"
        highlightedMessageId={null}
        searchQuery="order"
        messages={[
          testMessage({
            _id: "msg_template_search",
            text: "[Template: order_update] Your order ships today",
            date: "2026-07-13T06:20:00.000Z",
            direction: "outbound",
            whatsappTemplate: { name: "order_update" },
          }),
        ]}
      />
    );

    expect(screen.queryByText(/\[Template:/)).toBeNull();
    expect(
      screen.getAllByText("order").every(node => node.tagName === "MARK")
    ).toBe(true);
  });

  it("does not render document-only filenames as a separate text caption", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_1",
            text: "invoice-details.docx",
            date: "2026-01-01T13:36:00.000Z",
            direction: "inbound",
            imageUrl: "https://example.com/invoice-details.docx",
            mediaType: "document",
            fileName: "invoice-details.docx",
            fileSize: 41677,
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.getAllByText("invoice-details.docx")).toHaveLength(1);
    const documentLink = screen.getByRole("link", {
      name: /invoice-details\.docx/i,
    });
    expect(within(documentLink).queryByText("40.7 KB")).not.toBeNull();
  });

  it("shrink-wraps visual media instead of forcing a fixed bubble width", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_1",
            date: "2026-01-01T13:36:00.000Z",
            direction: "inbound",
            imageUrl: "https://example.com/short-image.jpg",
            mediaType: "image",
            mimeType: "image/jpeg",
            reactions: [],
          }),
        ]}
      />
    );

    const image = screen.getByAltText("attachedImageAlt");
    const classNames = image.className.split(/\s+/);
    expect(classNames).toContain("max-w-full");
    expect(classNames).not.toContain("w-full");
  });

  it("shows a retry and an open-in-new-tab link when an inline image fails to load", () => {
    captureClientEventMock.mockClear();
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_1",
            date: "2026-01-01T13:36:00.000Z",
            direction: "inbound",
            imageUrl: "https://example.com/broken-image.jpg",
            mediaType: "image",
            mimeType: "image/jpeg",
            reactions: [],
          }),
        ]}
      />
    );

    const image = screen.getByAltText("attachedImageAlt");
    fireEvent.error(image);

    expect(screen.getByText("Could not load image.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    const openLink = screen.getByRole("link", { name: "Open in new tab" });
    expect(openLink.getAttribute("href")).toBe(
      "https://example.com/broken-image.jpg"
    );

    expect(captureClientEventMock).toHaveBeenCalledWith(
      "conversation_media_load_failed",
      expect.objectContaining({ media_kind: "image", reason: "error" })
    );
  });

  it("shows an error state in the zoom dialog when the image fails to load", () => {
    captureClientEventMock.mockClear();
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_1",
            date: "2026-01-01T13:36:00.000Z",
            direction: "inbound",
            imageUrl: "https://example.com/dialog-image.jpg",
            mediaType: "image",
            mimeType: "image/jpeg",
            reactions: [],
          }),
        ]}
      />
    );

    fireEvent.click(screen.getByAltText("attachedImageAlt"));

    const dialogImage = screen
      .getAllByAltText("attachedImageAlt")
      .find(node => node.className.includes("max-h-[85vh]"));
    expect(dialogImage).not.toBeUndefined();
    fireEvent.error(dialogImage as HTMLElement);

    expect(screen.getByText("Could not load image.")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Open in new tab" })).not.toBeNull();
    expect(captureClientEventMock).toHaveBeenCalledWith(
      "conversation_media_load_failed",
      expect.objectContaining({ media_kind: "image", reason: "error" })
    );
  });

  it("renders visual media without bubble borders or inner padding", () => {
    const { container } = render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_1",
            date: "2026-01-01T13:36:00.000Z",
            direction: "inbound",
            imageUrl: "https://example.com/image.jpg",
            mediaType: "image",
            mimeType: "image/jpeg",
            reactions: [],
          }),
          testMessage({
            _id: "msg_2",
            date: "2026-01-01T13:37:00.000Z",
            direction: "outbound",
            imageUrl: "https://example.com/video.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            reactions: [],
          }),
        ]}
      />
    );

    const contentNodes = Array.from(
      container.querySelectorAll('[data-slot="message-content"]')
    );

    expect(contentNodes).toHaveLength(2);
    for (const node of contentNodes) {
      const classNames = node.className.split(/\s+/);
      expect(classNames).toContain("bg-transparent");
      expect(classNames).toContain("p-0");
      expect(classNames).toContain("shadow-none");
      expect(classNames).not.toContain("border");
      expect(classNames).not.toContain("px-1.5");
      expect(classNames).not.toContain("pt-1.5");
      expect(classNames).not.toContain("pb-1");
    }

    const timestampNodes = contentNodes.map(node =>
      node.querySelector("[data-message-footer]")
    );
    for (const timestampNode of timestampNodes) {
      expect(timestampNode).toBeDefined();
      expect(timestampNode!.className.split(/\s+/)).not.toContain(
        "text-primary-foreground/60"
      );
    }
  });

  it("renders WhatsApp Flow replies with field labels and option titles", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_flow_sent",
            text: "Please complete this flow.",
            date: "2026-01-01T13:36:00.000Z",
            direction: "outbound",
            whatsappFlow: {
              flowId: "meta-flow-1",
              flowToken: "flow_token_1",
              flowCta: "Open flow",
              bodyText: "Please complete this flow.",
              responseFieldMetadata: [
                {
                  id: "911CBF",
                  label: "Product",
                  helperText: "Pick a product",
                  screenTitle: "Choose preferences",
                  options: [{ id: "opt_medal", title: "Медаль ілгіштер" }],
                },
                {
                  id: "DEEA4D",
                  label: "Preferred time",
                  screenTitle: "Choose preferences",
                  options: [{ id: "morning", title: "Таңертең" }],
                },
              ],
            },
            reactions: [],
          }),
          testMessage({
            _id: "msg_between_flow_and_reply",
            text: "I opened it.",
            date: "2026-01-01T13:36:30.000Z",
            direction: "inbound",
            reactions: [],
          }),
          testMessage({
            _id: "msg_flow_reply",
            text: "[Flow response: flow] 911CBF: opt_medal; DEEA4D: morning",
            date: "2026-01-01T13:37:00.000Z",
            direction: "inbound",
            whatsappFlowReply: {
              flowName: "flow",
              flowToken: "flow_token_1",
              body: "911CBF: opt_medal; DEEA4D: morning",
              responseJson: JSON.stringify({
                "911CBF": "opt_medal",
                DEEA4D: "morning",
                flow_token: "flow_token_1",
              }),
            },
            reactions: [],
          }),
        ]}
        channel="whatsapp"
      />
    );

    expect(screen.queryByText("Product")).not.toBeNull();
    expect(screen.queryByText("Pick a product")).not.toBeNull();
    expect(screen.queryByText("Медаль ілгіштер")).not.toBeNull();
    expect(screen.queryByText("Preferred time")).not.toBeNull();
    expect(screen.queryByText("Таңертең")).not.toBeNull();
    expect(screen.queryByText("Choose preferences")).toBeNull();
    expect(screen.queryByText("911CBF")).toBeNull();
    expect(screen.queryByText("DEEA4D")).toBeNull();
  });

  it("shows a template that stores its FLOW button's Flow as the template", () => {
    render(
      <ConversationThread
        conversationId="conv_medal"
        highlightedMessageId={null}
        messages={[
          testMessage({
            _id: "msg_medal_template",
            text: "[Template: medal_pick_1]",
            date: "2026-10-04T10:00:00.000Z",
            direction: "outbound",
            whatsappTemplate: {
              name: "medal_pick_1",
              languageCode: "kk",
              bodyText: "Choose your medal",
              buttons: [
                { type: "flow", text: "Choose", flowId: "2244981489363579" },
              ],
            },
            whatsappFlow: {
              flowId: "2244981489363579",
              flowToken: "flow_medal",
              flowCta: "Choose",
              bodyText: null,
              responseFieldMetadata: [
                {
                  id: "sport",
                  label: "Sport",
                  options: [{ id: "opt_karate", title: "Karate" }],
                },
              ],
            },
            reactions: [],
          }),
          testMessage({
            _id: "msg_medal_reply",
            text: "[Flow response: flow] sport: opt_karate",
            date: "2026-10-04T10:01:00.000Z",
            direction: "inbound",
            whatsappFlowReply: {
              flowName: "flow",
              flowToken: "flow_medal",
              body: "sport: opt_karate",
              responseJson: JSON.stringify({
                sport: "opt_karate",
                flow_token: "flow_medal",
              }),
            },
            reactions: [],
          }),
        ]}
        channel="whatsapp"
      />
    );

    expect(screen.queryByText("WhatsApp template")).not.toBeNull();
    expect(screen.queryByText("medal_pick_1")).not.toBeNull();
    expect(screen.queryByText("Choose your medal")).not.toBeNull();
    expect(screen.queryByText("Open the flow below.")).toBeNull();
    expect(screen.queryByText("[Template: medal_pick_1]")).toBeNull();
    // The stored Flow still labels the answers to it.
    expect(screen.queryByText("Sport")).not.toBeNull();
    expect(screen.queryByText("Karate")).not.toBeNull();
  });

  it("plays an inbound Instagram clip stored as video instead of a file chip", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="instagram"
        messages={[
          testMessage({
            _id: "msg_instagram_clip",
            messageId: "ig_mid_clip",
            text: "[video attachment]",
            date: "2026-01-01T13:37:00.000Z",
            direction: "inbound",
            imageUrl: "https://storage.test/instagram/ig_mid_clip.mp4",
            mediaType: "video",
            mimeType: "video/mp4",
            fileSize: 4_442_851,
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.getByTestId("video-player").dataset.src).toBe(
      "https://storage.test/instagram/ig_mid_clip.mp4"
    );
    expect(screen.queryByText(/attachment/i)).toBeNull();
  });

  it("keeps a video's first signed link when a refetch signs it again", () => {
    const signed = (token: string) =>
      `https://project.supabase.co/storage/v1/object/sign/conversation-images/instagram/clip.mp4?token=${token}`;
    const clip = (imageUrl: string) =>
      testMessage({
        _id: "msg_instagram_clip",
        text: "[video attachment]",
        date: "2026-01-01T13:37:00.000Z",
        direction: "inbound",
        imageUrl,
        mediaType: "video",
        mimeType: "video/mp4",
        reactions: [],
      });
    const { rerender } = render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="instagram"
        messages={[clip(signed("first"))]}
      />
    );

    rerender(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="instagram"
        messages={[clip(signed("second"))]}
      />
    );

    expect(screen.getByTestId("video-player").dataset.src).toBe(
      signed("first")
    );
  });

  it("renders outbound Instagram delivery status beside the timestamp", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="instagram"
        messages={[
          testMessage({
            _id: "msg_instagram_outbound",
            messageId: "ig_mid_1",
            text: "Thanks, I will check this.",
            date: "2026-01-01T13:37:00.000Z",
            direction: "outbound",
            delivery: {
              status: "read",
              readAt: "2026-01-01T13:38:00.000Z",
            },
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByLabelText("Message read")).not.toBeNull();
  });

  it("renders read status with a stronger color than delivered", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="whatsapp"
        messages={[
          testMessage({
            _id: "msg_whatsapp_delivered",
            messageId: "wamid.delivered-1",
            text: "Delivered",
            date: "2026-01-01T13:37:00.000Z",
            direction: "outbound",
            delivery: {
              status: "delivered",
              deliveredAt: "2026-01-01T13:38:00.000Z",
            },
            reactions: [],
          }),
          testMessage({
            _id: "msg_whatsapp_read",
            messageId: "wamid.read-1",
            text: "Read",
            date: "2026-01-01T13:39:00.000Z",
            direction: "outbound",
            delivery: {
              status: "read",
              readAt: "2026-01-01T13:40:00.000Z",
            },
            reactions: [],
          }),
        ]}
      />
    );

    const delivered = screen.getByLabelText("Message delivered");
    const read = screen.getByLabelText("Message read");

    expect(delivered.className).not.toContain("text-sky-500");
    expect(read.className).toContain("text-sky-500");
  });

  it("renders WhatsApp played delivery status without exposing group details inline", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="whatsapp"
        messages={[
          testMessage({
            _id: "msg_whatsapp_voice",
            messageId: "wamid.voice-1",
            text: "[voice message]",
            date: "2026-01-01T13:37:00.000Z",
            direction: "outbound",
            mediaType: "voice",
            delivery: {
              status: "played",
              playedAt: "2026-01-01T13:38:00.000Z",
              recipientId: "120363000000000000@g.us",
              recipientType: "group",
              recipientParticipantId: "15551234567",
            },
            reactions: [],
          }),
        ]}
      />
    );

    const playedIndicator = screen.getByLabelText("Voice message played");
    expect(playedIndicator).not.toBeNull();
    expect(screen.queryByText(/Group recipient:/)).toBeNull();

    expect(
      screen.queryByText("Group recipient: 120363000000000000@g.us")
    ).toBeNull();
    expect(screen.queryByText("Participant: 15551234567")).toBeNull();
  });

  it("does not render an icon for unknown future delivery statuses", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="whatsapp"
        messages={[
          testMessage({
            _id: "msg_whatsapp_unknown_status",
            messageId: "wamid.future-1",
            text: "Future status",
            date: "2026-01-01T13:37:00.000Z",
            direction: "outbound",
            delivery: {
              status: "displayed",
            } as unknown as PopulatedMessage["delivery"],
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.queryByLabelText("Message sent")).toBeNull();
    expect(screen.queryByLabelText("Message delivered")).toBeNull();
    expect(screen.queryByLabelText("Message read")).toBeNull();
    expect(screen.queryByLabelText("Voice message played")).toBeNull();
    expect(screen.queryByLabelText("Message failed")).toBeNull();
  });

  it("renders WhatsApp ad referrals as a compact ad preview inside the message", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="whatsapp"
        messages={[
          testMessage({
            _id: "msg_ctwa",
            text: "Здравствуйте! Хочу узнать об автоматизации продаж подробнее",
            date: "2026-06-21T08:57:00.000Z",
            direction: "inbound",
            whatsappReferral: {
              sourceType: "ad",
              sourceId: "120249144478770472",
              sourceUrl: "https://www.instagram.com/p/example",
              campaignName: '21/06/26 "Вовлеченность WA"',
              adSetName: "21/06/26 Вовлеченность WA",
              headline: "Airi.chat",
              body: "Автоматизация продаж через WABA",
              mediaType: "image",
              thumbnailUrl: "https://example.com/ad-thumb.jpg",
              ctwaClid: "clid-1",
            },
            reactions: [],
          }),
        ]}
      />
    );

    const preview = screen.getByLabelText("WhatsApp ad referral");
    expect(within(preview).getByText("Instagram ad")).not.toBeNull();
    expect(
      within(preview).getByText('21/06/26 "Вовлеченность WA"')
    ).not.toBeNull();
    expect(within(preview).getByText("Airi.chat")).not.toBeNull();
    expect(within(preview).getByAltText("Ad preview")).not.toBeNull();
    expect(
      screen.getByText(
        "Здравствуйте! Хочу узнать об автоматизации продаж подробнее"
      )
    ).not.toBeNull();
  });

  it("renders WhatsApp commerce context without relying on placeholder text", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="whatsapp"
        messages={[
          testMessage({
            _id: "msg_order",
            text: "[WhatsApp order: 2 items, 20.00 USD]",
            date: "2026-06-21T08:57:00.000Z",
            direction: "inbound",
            whatsappOrder: {
              catalogId: "catalog-1",
              text: "Please deliver today",
              productItems: [
                {
                  productRetailerId: "sku-1",
                  quantity: 2,
                  itemPrice: 10,
                  currency: "USD",
                },
              ],
              totalQuantity: 2,
              totalAmount: 20,
              currency: "USD",
            },
            reactions: [],
          }),
          testMessage({
            _id: "msg_product",
            text: "[Product inquiry: sku-2] Is this available?",
            date: "2026-06-21T08:58:00.000Z",
            direction: "inbound",
            whatsappProductInquiry: {
              catalogId: "catalog-2",
              productRetailerId: "sku-2",
              contextMessageId: "wamid.product",
            },
            reactions: [],
          }),
        ]}
      />
    );

    const order = screen.getByLabelText("WhatsApp order");
    expect(within(order).getByText("Order")).not.toBeNull();
    expect(within(order).getByText("2 items")).not.toBeNull();
    expect(within(order).getByText("20.00 USD")).not.toBeNull();
    expect(within(order).getByText("sku-1")).not.toBeNull();
    expect(within(order).getByText("Please deliver today")).not.toBeNull();

    const inquiry = screen.getByLabelText("WhatsApp product inquiry");
    expect(within(inquiry).getByText("Product inquiry")).not.toBeNull();
    expect(within(inquiry).getByText("sku-2")).not.toBeNull();
    expect(within(inquiry).getByText("catalog-2")).not.toBeNull();
  });

  it("renders WhatsApp contact cards without the text fallback and supports contact actions", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    let savedBlob: Blob | null = null;
    const createObjectURL = jest.fn((blob: Blob) => {
      savedBlob = blob;
      return "blob:contact";
    });
    const revokeObjectURL = jest.fn();
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
      render(
        <ConversationThread
          conversationId="conv_1"
          highlightedMessageId={null}
          channel="whatsapp"
          messages={[
            testMessage({
              _id: "msg_contact",
              text: "[Contact] Sabyrzhan Torg 1 (+7 705 130 9419)",
              date: "2026-06-21T08:57:00.000Z",
              direction: "inbound",
              whatsappContacts: [
                {
                  name: { formatted_name: "Sabyrzhan Torg 1" },
                  phones: [{ phone: "+7 705 130 9419", type: "CELL" }],
                  org: { title: "Manager", company: "Torg" },
                },
              ],
              reactions: [],
            }),
          ]}
        />
      );

      expect(screen.getByText("Sabyrzhan Torg 1")).not.toBeNull();
      expect(screen.getByText("Manager · Torg")).not.toBeNull();
      expect(screen.queryByText(/\[Contact\]/)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /\+7 705 130 9419/ }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("+7 705 130 9419")
      );
      expect(await screen.findByText("contactPhoneCopied")).not.toBeNull();

      const callLink = screen.getByRole("link", { name: "contactCall" });
      expect(callLink.getAttribute("href")).toBe("tel:+77051309419");

      fireEvent.click(screen.getByRole("button", { name: "contactSave" }));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(savedBlob).not.toBeNull();
      const savedText = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(savedBlob as Blob);
      });
      expect(savedText).toContain("FN:Sabyrzhan Torg 1");
    } finally {
      clickSpy.mockRestore();
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    }
  });

  it("hides the contact call action for co-existence identity payloads", () => {
    render(
      <ConversationThread
        conversationId="conv_1"
        highlightedMessageId={null}
        channel="whatsapp"
        messages={[
          testMessage({
            _id: "msg_contact",
            text: "[Contact] Private identity",
            date: "2026-06-21T08:57:00.000Z",
            direction: "inbound",
            whatsappContacts: [
              {
                user_id: "US.1349.private",
                name: { formatted_name: "Private identity" },
                phones: [{ phone: "+1 555 0100" }],
              },
            ],
            reactions: [],
          }),
        ]}
      />
    );

    expect(screen.getByText("Private identity")).not.toBeNull();
    expect(screen.queryByText(/\[Contact\]/)).toBeNull();
    expect(screen.queryByRole("link", { name: "contactCall" })).toBeNull();
    expect(screen.getByRole("button", { name: "contactSave" })).not.toBeNull();
  });
});
