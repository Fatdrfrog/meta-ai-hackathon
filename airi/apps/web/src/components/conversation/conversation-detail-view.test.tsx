/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import useSWR from "swr";
import { useRealtime } from "@/hooks/use-realtime";
import { ConversationPlanGateError } from "@/lib/conversation/detail-client";
import type { ClassificationResult } from "@/lib/classifier/conversation-analysis-types";
import type { OutboundAttachment } from "@/types/outbound-attachment";
import type { PopulatedMessage } from "@/types/models";
import type { FormattedRequest } from "@/features/panel/requests/formatting";
import type {
  RealtimeEventEnvelope,
  RealtimeEventName,
} from "@icecore/shared/types/realtime";

const mockSetAtom = jest.fn();
let mockCoachOpen = false;
let mockIsMobile = false;
const mockSetCoachOpen = jest.fn();
const mockJoinWhatsAppCallMedia = jest.fn();
const mockUploadAttachment = jest.fn();
const mockReplyFormProps: Array<{
  onAddAttachments: (
    files: File[],
    options?: { isRetry?: boolean }
  ) => Promise<void>;
  isUploadingAttachments: boolean;
  attachments: OutboundAttachment[];
  onSubmitReply: (data: { reply: string }) => Promise<void>;
  onRemoveAttachment: (index: number) => void;
}> = [];
const mockThreadMessages: PopulatedMessage[][] = [];

jest.mock("@/lib/conversation/attachment-upload", () => ({
  AttachmentUploadTimeoutError: class extends Error {},
  AttachmentUploadError: class extends Error {
    status: number;
    reason?: string;
    constructor(params: { message: string; status: number; reason?: string }) {
      super(params.message);
      this.status = params.status;
      this.reason = params.reason;
    }
  },
  AttachmentUploadBatchError: class extends Error {
    failedFiles: File[];
    constructor(message: string, failedFiles: File[]) {
      super(message);
      this.failedFiles = failedFiles;
    }
  },
  uploadAttachmentDirectly: (...args: unknown[]) =>
    mockUploadAttachment(...args),
  uploadAttachmentThroughApi: (...args: unknown[]) =>
    mockUploadAttachment(...args),
}));

jest.mock("jotai", () => ({
  atom: (initialValue: unknown) => ({
    init: initialValue,
  }),
  useAtom: () => [mockCoachOpen, mockSetCoachOpen],
  useSetAtom: () => mockSetAtom,
}));

jest.mock("swr", () => jest.fn());
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockIsMobile }));

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: jest.fn(),
}));

jest.mock("@/lib/calling/browser-call-media", () => ({
  joinWhatsAppCallMedia: (...args: unknown[]) =>
    mockJoinWhatsAppCallMedia(...args),
}));

jest.mock("@/hooks/use-coach-typing", () => ({
  useCoachTyping: () => ({
    onTextChange: jest.fn(),
  }),
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}));

const mockConversationProps: Array<{ initial?: unknown; resize?: unknown }> =
  [];
const mockScrollOwner = {
  isAtBottom: true,
  state: { isAtBottom: true },
  scrollRef: { current: null as HTMLDivElement | null },
  scrollToBottom: jest.fn(),
  stopScroll: jest.fn(),
};

jest.mock("@/components/ui/conversation", () => ({
  Conversation: ({
    children,
    contextRef,
    ...props
  }: {
    children: React.ReactNode;
    initial?: unknown;
    resize?: unknown;
    contextRef?: React.Ref<typeof mockScrollOwner>;
  }) => {
    React.useImperativeHandle(contextRef, () => mockScrollOwner);
    mockConversationProps.push(props);

    return <div>{children}</div>;
  },
  ConversationContent: ({
    children,
    scrollClassName,
  }: {
    children: React.ReactNode;
    scrollClassName?: string;
  }) => (
    <div>
      <div
        className={scrollClassName}
        data-testid="viewport"
        ref={element => {
          mockScrollOwner.scrollRef.current = element;
        }}
      >
        {children}
      </div>
    </div>
  ),
  ConversationScrollButton: () => null,
}));

jest.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>loading</div>,
}));

jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("./conversation-thread", () => ({
  ConversationThread: ({ messages }: { messages: PopulatedMessage[] }) => {
    mockThreadMessages.push(messages);
    return (
      <div data-testid="messages">
        {messages.map((message, index) => {
          const status = message.delivery?.status
            ? `[${message.delivery.status}]`
            : "";
          return (
            <React.Fragment key={String(message._id || index)}>
              {index > 0 ? "|" : null}
              <span data-message-id={String(message._id)}>
                {`${message.text || ""}${status}`}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    );
  },
}));

jest.mock("./conversation-sales", () => ({
  ConversationSales: ({ conversationId }: { conversationId: string }) => {
    const [draftConversationId] = React.useState(conversationId);
    return (
      <div data-testid="conversation-sales">
        {conversationId}/{draftConversationId}
      </div>
    );
  },
}));

jest.mock("./conversation-header", () => ({
  ConversationHeader: ({
    onOpenInfo,
    quickNote,
    actions,
    renderInfo,
  }: {
    onOpenInfo?: () => void;
    quickNote?: string | null;
    actions?: React.ReactNode;
    renderInfo?: (controls: React.ReactNode) => React.ReactNode;
  }) => (
    <div>
      <button type="button" onClick={onOpenInfo}>
        open-info
      </button>
      <span data-testid="quick-note-prop">{quickNote || ""}</span>
      {actions}
      {renderInfo?.(<div>conversation-controls</div>)}
    </div>
  ),
}));

jest.mock("./reply-form", () => ({
  ReplyForm: (props: (typeof mockReplyFormProps)[number]) => {
    mockReplyFormProps.push(props);
    return (
      <div
        data-testid="reply-form"
        data-uploading={props.isUploadingAttachments}
        data-attachments={props.attachments
          .map(file => file.fileName)
          .join(",")}
      >
        reply-form
      </div>
    );
  },
}));

jest.mock("./airi-coach-panel", () => ({
  AiriCoachPanel: () => null,
}));

jest.mock("./conversation-info-sheet", () => ({
  ConversationInfoSheet: ({
    open,
    onOpenChange,
    actions,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    actions?: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="info-drawer">
        <button type="button" onClick={() => onOpenChange(false)}>
          close-info
        </button>
        conversation-info
        {actions}
      </div>
    ) : null,
}));

jest.mock("./meta-window-status", () => ({
  MetaWindowStatus: () => null,
}));

jest.mock("@/lib/messaging-window-utils", () => ({
  requiresMessagingWindow: () => false,
}));

jest.mock("@/lib/date-utils", () => ({
  formatClientName: () => "Client Name",
}));

jest.mock("@/lib/telegram/message-identity", () => ({
  formatTelegramTopicLabel: () => null,
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
  },
}));

import { ConversationDetailView } from "./conversation-detail-view";

type BoundHandler = (payload: RealtimeEventEnvelope) => void;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("ConversationDetailView", () => {
  const swrMock = useSWR as unknown as jest.Mock;
  const useRealtimeMock = useRealtime as jest.MockedFunction<
    typeof useRealtime
  >;
  const boundHandlers = new Map<string, BoundHandler>();
  const mutateConversation = jest.fn().mockResolvedValue(undefined);

  const conversationDetail = {
    _id: "conv_1",
    classification: {} as ClassificationResult,
    is_best_practice: false,
    messages: [
      {
        _id: "msg_initial",
        text: "Initial message",
        date: "2026-01-02T00:00:00.000Z",
        direction: "inbound",
      },
    ],
    message_pagination: {
      page: 1,
      has_more: true,
      total: 3,
      limit: 30,
    },
    user: {
      _id: "user_1",
      firstName: "Alice",
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mutateConversation.mockReset().mockResolvedValue(undefined);
    mockCoachOpen = false;
    mockIsMobile = false;
    mockSetAtom.mockClear();
    mockSetCoachOpen.mockClear();
    mockConversationProps.length = 0;
    mockScrollOwner.isAtBottom = true;
    mockScrollOwner.state.isAtBottom = true;
    mockScrollOwner.scrollRef.current = null;
    mockScrollOwner.scrollToBottom.mockImplementation(() => {
      mockScrollOwner.isAtBottom = true;
      mockScrollOwner.state.isAtBottom = true;
      return Promise.resolve(true);
    });
    mockScrollOwner.stopScroll.mockImplementation(() => {
      mockScrollOwner.isAtBottom = false;
      mockScrollOwner.state.isAtBottom = false;
    });
    mockReplyFormProps.length = 0;
    mockThreadMessages.length = 0;
    mockUploadAttachment.mockResolvedValue({
      mediaType: "audio",
      mimeType: "audio/webm",
    });
    boundHandlers.clear();

    HTMLElement.prototype.scrollIntoView = jest.fn();
    HTMLElement.prototype.scrollTo = jest.fn();

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationDetail,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    const channel = {
      bind: jest.fn((event: RealtimeEventName, handler: BoundHandler) => {
        boundHandlers.set(event, handler);
      }),
      unbind: jest.fn((event: RealtimeEventName) => {
        boundHandlers.delete(event);
      }),
    };

    useRealtimeMock.mockReturnValue({
      channel,
      isConnected: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("reconciles a visible active thread after a missed event without overlapping requests", async () => {
    jest.useFakeTimers();
    const pending = createDeferred<Response>();
    const page = {
      messages: [
        {
          _id: "missed",
          text: "Recovered missed message",
          date: "2026-01-03T00:00:00Z",
          direction: "inbound",
        },
      ],
    };
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ok: true, json: async () => page });
    const { unmount } = render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      "messagesOnly=1"
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ok: true, json: async () => page } as Response);
      await pending.promise;
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("messages")).toHaveTextContent(
      "Initial message|Recovered missed message"
    );
    expect(mutateConversation).not.toHaveBeenCalled();
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("releases a stalled focus refresh so the next lightweight reconciliation can run", async () => {
    jest.useFakeTimers();
    const pending = createDeferred<undefined>();
    mutateConversation.mockReturnValue(pending.promise);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(mutateConversation).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain(
      "messagesOnly=1"
    );
    await act(async () => {
      pending.resolve(undefined);
    });
  });

  it("pauses reconciliation while hidden and scopes it to the conversation and workspace the host mounts", async () => {
    jest.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    jest
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const nextMutate = jest.fn().mockResolvedValue(undefined);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
    const nextData = { ...conversationDetail, _id: "conv_2" };
    const original = swrMock.getMockImplementation()!;
    swrMock.mockImplementation((key: string | null) =>
      key?.includes("conv_2")
        ? { data: nextData, mutate: nextMutate }
        : original(key)
    );
    const { unmount } = render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mutateConversation).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mutateConversation).toHaveBeenCalledTimes(1);
    // The host keys the view by conversation, so a switch is a remount.
    unmount();
    render(
      <ConversationDetailView
        conversationId="conv_2"
        workspaceId="workspace_2"
      />
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(nextMutate).not.toHaveBeenCalled();
    expect(
      String((global.fetch as jest.Mock).mock.calls.at(-1)?.[0])
    ).toContain("/conv_2?");
    expect(
      String((global.fetch as jest.Mock).mock.calls.at(-1)?.[0])
    ).toContain("workspaceId=workspace_2");
    expect(mutateConversation).toHaveBeenCalledTimes(1);
  });

  it("discards a late reconciliation response after switching conversations", async () => {
    jest.useFakeTimers();
    const pending = createDeferred<Response>();
    global.fetch = jest.fn().mockReturnValue(pending.promise);
    const nextData = { ...conversationDetail, _id: "conv_2" };
    const original = swrMock.getMockImplementation()!;
    swrMock.mockImplementation((key: string | null) =>
      key?.includes("conv_2")
        ? { data: nextData, mutate: jest.fn() }
        : original(key)
    );
    const { unmount } = render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    const signal = (global.fetch as jest.Mock).mock.calls[0][1]
      .signal as AbortSignal;
    unmount();
    render(
      <ConversationDetailView
        conversationId="conv_2"
        workspaceId="workspace_2"
      />
    );
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve({
        ok: true,
        json: async () => ({
          messages: [
            {
              _id: "old",
              text: "Wrong conversation",
              date: "2026-01-03T00:00:00Z",
              direction: "inbound",
            },
          ],
        }),
      } as Response);
      await pending.promise;
    });
    expect(screen.getByTestId("messages")).not.toHaveTextContent(
      "Wrong conversation"
    );
  });

  it.each(["loading", "error", "empty"] as const)(
    "keeps mobile Back available in the %s state",
    state => {
      const onBack = jest.fn();
      mockIsMobile = true;
      swrMock.mockReturnValue({
        data: undefined,
        error: state === "error" ? new Error("Network unavailable") : undefined,
        isLoading: state === "loading",
        isValidating: state === "loading",
        mutate: jest.fn(),
      });

      render(
        <ConversationDetailView
          conversationId="conv_1"
          workspaceId="workspace-1"
          onBack={onBack}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "backToConversations" })
      );
      expect(onBack).toHaveBeenCalledTimes(1);
      if (state === "error") {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Network unavailable"
        );
      }
    }
  );

  it("keeps mobile sales and controls in Info even when the host has no Back callback", async () => {
    mockIsMobile = true;
    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace-1"
      />
    );
    expect(screen.queryByTestId("conversation-sales")).not.toBeInTheDocument();
    expect(screen.queryByText("conversation-controls")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "open-info" }));
    expect(screen.getByTestId("conversation-sales")).toBeInTheDocument();
    expect(screen.getByText("conversation-controls")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "close-info" }));
    expect(screen.queryByTestId("conversation-sales")).not.toBeInTheDocument();
  });

  it("keeps the desktop coach layout when a drawer supplies a Back callback", async () => {
    mockCoachOpen = true;
    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace-1"
        onBack={jest.fn()}
      />
    );
    expect(await screen.findByTestId("conversation-sales")).toBeInTheDocument();
    expect(screen.getByTestId("resizable-handle")).toBeInTheDocument();
  });

  it("uses one exact conversation scope when the owner supplies workspace", () => {
    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(screen.getByTestId("conversation-sales")).toHaveTextContent(
      "conv_1"
    );

    const nonNullCalls = useRealtimeMock.mock.calls.filter(
      ([scope]) => scope !== null
    );
    expect(nonNullCalls).not.toHaveLength(0);
    for (const call of nonNullCalls) {
      expect(call).toEqual([
        {
          kind: "conversation",
          workspaceId: "workspace_1",
          conversationId: "conv_1",
        },
      ]);
    }
  });

  it("warns and gates the composer when the WhatsApp account cannot send", async () => {
    const whatsappDetail = {
      ...conversationDetail,
      channel: "whatsapp",
      workspaceId: "workspace_1",
    };
    swrMock.mockImplementation((key: string | null) => {
      if (key && key.includes("/api/conversations/conv_1")) {
        return {
          data: whatsappDetail,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }
      if (key && key.includes("/api/whatsapp/onboarding")) {
        return {
          data: {
            status: {
              waba_health_state: "warning",
              waba_health_reasons: [
                {
                  code: "phone_not_registered",
                  title: "Phone registration incomplete",
                  message: "Complete phone number registration to send.",
                  source: "phone_registration",
                },
              ],
            },
          },
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: jest.fn(),
        };
      }
      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(
      await screen.findByText("Phone registration incomplete")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Complete phone number registration to send.")
    ).toBeInTheDocument();

    const replyFormProps = mockReplyFormProps.at(-1) as unknown as {
      disabled?: boolean;
    };
    expect(replyFormProps.disabled).toBe(true);
  });

  it("discards the previous sale draft when switching conversations", async () => {
    const firstDetail = { ...conversationDetail, workspaceId: "workspace_1" };
    const secondDetail = { ...firstDetail, _id: "conv_2" };
    swrMock.mockImplementation((key: string | null) => ({
      data: key?.includes("/api/conversations/conv_1")
        ? firstDetail
        : key?.includes("/api/conversations/conv_2")
          ? secondDetail
          : undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: mutateConversation,
    }));
    const first = render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );
    expect(screen.getByTestId("conversation-sales")).toHaveTextContent(
      "conv_1/conv_1"
    );
    first.unmount();
    render(
      <ConversationDetailView
        conversationId="conv_2"
        workspaceId="workspace_1"
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("conversation-sales")).toHaveTextContent(
        "conv_2/conv_2"
      )
    );
  });

  it.each([false, true])(
    "ignores a previous composer's upload callback after switching (return to original: %s)",
    async returnToOriginal => {
      const firstDetail = { ...conversationDetail, channel: "whatsapp" };
      const secondDetail = { ...firstDetail, _id: "conv_2" };
      swrMock.mockImplementation((key: string | null) => ({
        data: key?.includes("/api/conversations/conv_1")
          ? firstDetail
          : key?.includes("/api/conversations/conv_2")
            ? secondDetail
            : undefined,
        isLoading: false,
        mutate: mutateConversation,
      }));
      const first = render(
        <ConversationDetailView
          conversationId="conv_1"
          workspaceId="workspace_1"
        />
      );
      const staleUpload = mockReplyFormProps.at(-1)!.onAddAttachments;
      first.unmount();
      const second = render(
        <ConversationDetailView
          conversationId="conv_2"
          workspaceId="workspace_1"
        />
      );
      if (returnToOriginal) {
        second.unmount();
        render(
          <ConversationDetailView
            conversationId="conv_1"
            workspaceId="workspace_1"
          />
        );
      }
      mockReplyFormProps.length = 0;

      await act(async () => {
        await staleUpload([
          new File(["voice"], "voice.webm", { type: "audio/webm" }),
        ]);
      });

      expect(mockUploadAttachment).not.toHaveBeenCalled();
      expect(
        mockReplyFormProps.some(props => props.isUploadingAttachments)
      ).toBe(false);
    }
  );

  it("does not attach an old upload or clear a new upload's busy state after returning to a conversation", async () => {
    const firstDetail = { ...conversationDetail, channel: "whatsapp" };
    const secondDetail = { ...firstDetail, _id: "conv_2" };
    swrMock.mockImplementation((key: string | null) => ({
      data: key?.includes("/api/conversations/conv_1")
        ? firstDetail
        : key?.includes("/api/conversations/conv_2")
          ? secondDetail
          : undefined,
      isLoading: false,
      mutate: mutateConversation,
    }));
    const oldResult = createDeferred<OutboundAttachment>();
    const newResult = createDeferred<OutboundAttachment>();
    mockUploadAttachment
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => newResult.promise);
    const first = render(<ConversationDetailView conversationId="conv_1" />);
    const oldUpload = mockReplyFormProps.at(-1)!.onAddAttachments;
    let oldUploadPromise!: Promise<void>;
    act(() => {
      oldUploadPromise = oldUpload([
        new File(["old"], "old.webm", { type: "audio/webm" }),
      ]);
    });
    expect(mockReplyFormProps.at(-1)!.isUploadingAttachments).toBe(true);

    first.unmount();
    render(<ConversationDetailView conversationId="conv_2" />).unmount();
    render(<ConversationDetailView conversationId="conv_1" />);
    expect(mockReplyFormProps.at(-1)!.isUploadingAttachments).toBe(false);
    const newUpload = mockReplyFormProps.at(-1)!.onAddAttachments;
    let newUploadPromise!: Promise<void>;
    act(() => {
      newUploadPromise = newUpload([
        new File(["new"], "new.webm", { type: "audio/webm" }),
      ]);
    });

    await act(async () => {
      oldResult.resolve({ mediaType: "audio", fileName: "old.webm" });
      await oldUploadPromise;
    });
    expect(mockReplyFormProps.at(-1)!.attachments).toEqual([]);
    expect(mockReplyFormProps.at(-1)!.isUploadingAttachments).toBe(true);

    const newAttachment: OutboundAttachment = {
      mediaType: "audio",
      fileName: "new.webm",
    };
    await act(async () => {
      newResult.resolve(newAttachment);
      await newUploadPromise;
    });
    expect(mockReplyFormProps.at(-1)!.attachments).toEqual([newAttachment]);
    expect(mockReplyFormProps.at(-1)!.isUploadingAttachments).toBe(false);
  });

  it("keeps the committed conversation's upload valid when a switch render suspends", async () => {
    const firstDetail = { ...conversationDetail, channel: "whatsapp" };
    const secondDetail = { ...firstDetail, _id: "conv_2" };
    swrMock.mockImplementation((key: string | null) => ({
      data: key?.includes("/api/conversations/conv_1")
        ? firstDetail
        : key?.includes("/api/conversations/conv_2")
          ? secondDetail
          : undefined,
      isLoading: false,
      mutate: mutateConversation,
    }));
    const uploadResult = createDeferred<OutboundAttachment>();
    mockUploadAttachment.mockImplementationOnce(() => uploadResult.promise);
    const suspendedSwitch = createDeferred<void>();
    function SuspendSwitch({ conversationId }: { conversationId: string }) {
      if (conversationId === "conv_2") throw suspendedSwitch.promise;
      return null;
    }
    function ConversationSwitch() {
      const [conversationId, setConversationId] = React.useState("conv_1");
      return (
        <>
          <button
            onClick={() =>
              React.startTransition(() => setConversationId("conv_2"))
            }
          >
            switch conversation
          </button>
          <React.Suspense fallback="switch pending">
            {/* Like ChatPanel, the host remounts the view per conversation. */}
            <ConversationDetailView
              key={conversationId}
              conversationId={conversationId}
            />
            <SuspendSwitch conversationId={conversationId} />
          </React.Suspense>
        </>
      );
    }
    render(<ConversationSwitch />);
    const upload = mockReplyFormProps.at(-1)!.onAddAttachments;
    let uploadPromise!: Promise<void>;
    act(() => {
      uploadPromise = upload([
        new File(["voice"], "voice.webm", { type: "audio/webm" }),
      ]);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "switch conversation" })
    );
    expect(screen.queryByText("switch pending")).not.toBeInTheDocument();
    expect(screen.getByTestId("reply-form")).toHaveAttribute(
      "data-uploading",
      "true"
    );

    await act(async () => {
      uploadResult.resolve({ mediaType: "audio", fileName: "voice.webm" });
      await uploadPromise;
    });
    expect(screen.getByTestId("reply-form")).toHaveAttribute(
      "data-attachments",
      "voice.webm"
    );
    expect(screen.getByTestId("reply-form")).toHaveAttribute(
      "data-uploading",
      "false"
    );
  });

  it.each([
    { outcome: "shows", when: "while the view is open", unmountFirst: false },
    {
      outcome: "does not show",
      when: "after the operator opened another conversation",
      unmountFirst: true,
    },
  ])("$outcome a send failure that settles $when", async ({ unmountFirst }) => {
    const response = createDeferred<Response>();
    global.fetch = jest.fn().mockReturnValue(response.promise);
    const { unmount } = render(
      <ConversationDetailView conversationId="conv_1" />
    );
    let send!: Promise<void>;
    act(() => {
      send = mockReplyFormProps.at(-1)!.onSubmitReply({ reply: "Hello" });
    });
    if (unmountFirst) {
      unmount();
      render(<ConversationDetailView conversationId="conv_2" />);
    }

    await act(async () => {
      response.resolve({
        ok: false,
        json: async () => ({ error: "Provider rejected the message" }),
      } as Response);
      await send;
    });

    expect(toast.error).toHaveBeenCalledTimes(unmountFirst ? 0 : 1);
  });

  it("does not toast a dropped file's late upload failure after the view unmounts", async () => {
    const detail = { ...conversationDetail, channel: "telegram" };
    swrMock.mockImplementation((key: string | null) => ({
      data: key?.includes("/api/conversations/conv_1") ? detail : undefined,
      isLoading: false,
      mutate: mutateConversation,
    }));
    const upload = createDeferred<OutboundAttachment>();
    mockUploadAttachment.mockImplementationOnce(() => upload.promise);
    const { unmount } = render(
      <ConversationDetailView conversationId="conv_1" />
    );
    const file = new File(["doc"], "contract.pdf", {
      type: "application/pdf",
    });
    fireEvent.drop(screen.getByTestId("conversation-chat-surface"), {
      dataTransfer: { types: ["Files"], files: [file], items: [] },
    });
    expect(mockUploadAttachment).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      upload.reject(new Error("HTTP 500"));
      await upload.promise.catch(() => undefined);
    });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("previews uploads from the local file and never sends the preview URL", async () => {
    const storedUrl =
      "https://project.supabase.co/storage/v1/object/public/conversation-attachments/outbound/telegram/ws/conv/1-a-photo.png";
    const createObjectURL = jest.fn(() => "blob:local-preview");
    const revokeObjectURL = jest.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    try {
      mockUploadAttachment.mockResolvedValueOnce({
        mediaType: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        url: storedUrl,
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
      render(<ConversationDetailView conversationId="conv_1" />);

      const picked = new File(["png"], "photo.png", { type: "image/png" });
      await act(async () => {
        await mockReplyFormProps.at(-1)!.onAddAttachments([picked]);
      });
      expect(createObjectURL).toHaveBeenCalledWith(picked);
      expect(mockReplyFormProps.at(-1)!.attachments).toEqual([
        expect.objectContaining({
          url: storedUrl,
          previewUrl: "blob:local-preview",
        }),
      ]);

      await act(async () => {
        await mockReplyFormProps.at(-1)!.onSubmitReply({ reply: "" });
      });
      const replyCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
        String(url).endsWith("/api/conversations/conv_1/reply")
      );
      expect(JSON.parse(String(replyCall?.[1]?.body)).attachments).toEqual([
        {
          mediaType: "image",
          mimeType: "image/png",
          fileName: "photo.png",
          url: storedUrl,
        },
      ]);
    } finally {
      Object.assign(URL, {
        createObjectURL: originalCreate,
        revokeObjectURL: originalRevoke,
      });
    }
  });

  it("releases a local preview when its attachment is removed", async () => {
    const revokeObjectURL = jest.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.assign(URL, {
      createObjectURL: jest.fn(() => "blob:removed-preview"),
      revokeObjectURL,
    });
    try {
      mockUploadAttachment.mockResolvedValueOnce({
        mediaType: "image",
        fileName: "photo.png",
      });
      render(<ConversationDetailView conversationId="conv_1" />);
      await act(async () => {
        await mockReplyFormProps
          .at(-1)!
          .onAddAttachments([
            new File(["png"], "photo.png", { type: "image/png" }),
          ]);
      });
      act(() => {
        mockReplyFormProps.at(-1)!.onRemoveAttachment(0);
      });

      expect(mockReplyFormProps.at(-1)!.attachments).toEqual([]);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:removed-preview");
    } finally {
      Object.assign(URL, {
        createObjectURL: originalCreate,
        revokeObjectURL: originalRevoke,
      });
    }
  });

  it("throws a batch error that keeps the failed file so the composer can retry it", async () => {
    const detail = { ...conversationDetail, channel: "whatsapp" };
    swrMock.mockImplementation((key: string | null) => ({
      data: key?.includes("/api/conversations/conv_1") ? detail : undefined,
      isLoading: false,
      mutate: mutateConversation,
    }));
    mockUploadAttachment.mockRejectedValueOnce(new Error("HTTP 500"));
    render(<ConversationDetailView conversationId="conv_1" />);

    const upload = mockReplyFormProps.at(-1)!.onAddAttachments;
    const failedFile = new File(["doc"], "contract.pdf", {
      type: "application/pdf",
    });
    let thrown: unknown;
    await act(async () => {
      thrown = await upload([failedFile])
        .then(() => null)
        .catch((error: unknown) => error);
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { failedFiles?: File[] }).failedFiles).toEqual([
      failedFile,
    ]);
    expect(mockReplyFormProps.at(-1)!.attachments).toEqual([]);
  });

  it("derives one exact conversation scope from the authorized detail", () => {
    const derivedConversationDetail = {
      ...conversationDetail,
      workspaceId: "workspace_derived",
    };
    const unrelatedSWRResult = {
      data: undefined,
      error: undefined,
      isLoading: false,
      isValidating: false,
      mutate: jest.fn(),
    };
    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: derivedConversationDetail,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }
      return unrelatedSWRResult;
    });

    render(<ConversationDetailView conversationId="conv_1" />);

    expect(useRealtimeMock.mock.calls).toContainEqual([
      {
        kind: "conversation",
        workspaceId: "workspace_derived",
        conversationId: "conv_1",
      },
    ]);
    expect(
      useRealtimeMock.mock.calls.some(([scope]) => scope?.kind === "workspace")
    ).toBe(false);
    expect(useRealtimeMock.mock.calls.every(call => call.length === 1)).toBe(
      true
    );
  });

  it("keeps realtime messages that arrive while older pages are loading", async () => {
    jest.useFakeTimers();

    const loadMore = createDeferred<{
      ok: boolean;
      json: () => Promise<unknown>;
      text: () => Promise<string>;
    }>();

    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("messagesOnly=1")) {
        return loadMore.promise as Promise<Response>;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as jest.Mock;

    render(<ConversationDetailView conversationId="conv_1" />);

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(screen.getByTestId("messages")).toHaveTextContent("Initial message");

    fireEvent.click(screen.getByRole("button", { name: "loadPrevious" }));

    act(() => {
      boundHandlers.get("conversation.message.created")?.({
        eventId: "evt_realtime",
        version: 1,
        name: "conversation.message.created",
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        createdAt: "2026-01-03T00:00:00.000Z",
        dedupeKey:
          "conversation.message.created:workspace_1:conv_1:msg_realtime",
        payload: {
          data: {
            _id: "msg_realtime",
            text: "Realtime message",
            date: "2026-01-03T00:00:00.000Z",
            direction: "inbound",
          },
        },
      });
    });

    expect(screen.getByTestId("messages")).toHaveTextContent(
      "Initial message|Realtime message"
    );

    await act(async () => {
      loadMore.resolve({
        ok: true,
        json: async () => ({
          messages: [
            {
              _id: "msg_older",
              text: "Older message",
              date: "2026-01-01T00:00:00.000Z",
              direction: "inbound",
            },
          ],
          message_pagination: {
            page: 2,
            has_more: false,
            total: 3,
            limit: 30,
          },
        }),
        text: async () => "",
      });
      await Promise.resolve();
    });

    act(() => {
      jest.advanceTimersByTime(150);
    });

    await waitFor(() => {
      expect(screen.getByTestId("messages")).toHaveTextContent(
        "Older message|Initial message|Realtime message"
      );
    });
  });

  it("revalidates the chat when realtime reconnects", async () => {
    let isConnected = false;
    const channel = {
      bind: jest.fn((event: RealtimeEventName, handler: BoundHandler) => {
        boundHandlers.set(event, handler);
      }),
      unbind: jest.fn((event: RealtimeEventName) => {
        boundHandlers.delete(event);
      }),
    };
    useRealtimeMock.mockImplementation(() => ({
      channel,
      isConnected,
    }));

    const { rerender } = render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(mutateConversation).not.toHaveBeenCalled();

    isConnected = true;
    rerender(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    await waitFor(() => {
      expect(mutateConversation).toHaveBeenCalled();
    });
  });

  it("opens and closes the conversation info drawer from the header", () => {
    render(<ConversationDetailView conversationId="conv_1" />);

    expect(screen.queryByTestId("info-drawer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open-info" }));

    expect(screen.getByTestId("info-drawer")).toBeInTheDocument();
    expect(screen.getByText("conversation-info")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "close-info" }));

    expect(screen.queryByTestId("info-drawer")).not.toBeInTheDocument();
  });

  it("uses a one-message full fetch when opening conversation info", () => {
    render(<ConversationDetailView conversationId="conv_1" />);

    fireEvent.click(screen.getByRole("button", { name: "open-info" }));

    expect(swrMock).toHaveBeenCalledWith(
      "/api/conversations/conv_1?page=1&limit=1&view=full",
      expect.any(Function),
      expect.objectContaining({
        revalidateOnFocus: false,
        dedupingInterval: 15000,
        errorRetryCount: 1,
      })
    );
  });

  it("uses instant initial stick-to-bottom positioning for deep-linked conversations", () => {
    render(<ConversationDetailView conversationId="conv_1" />);

    expect(mockConversationProps[0]?.initial).toBe("instant");
  });

  it("replaces cold loading with the complete recent page and its message semantics", () => {
    const recentMessages = Array.from({ length: 30 }, (_, index) => ({
      _id: `recent-${index}`,
      text: `Recent message ${index}`,
      date: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
      direction: index % 2 === 0 ? "inbound" : "outbound",
      delivery: index % 2 === 0 ? null : { status: "delivered" },
      ...(index === 28
        ? {
            mediaType: "image",
            imageUrl: "/recent-image.png",
            mimeType: "image/png",
          }
        : index === 29
          ? {
              mediaType: "document",
              fileName: "invoice.pdf",
              attachments: [
                {
                  filename: "invoice.pdf",
                  url: "/recent-invoice.pdf",
                  contentType: "application/pdf",
                  sizeBytes: 1200,
                },
              ],
            }
          : {}),
    })) as unknown as PopulatedMessage[];
    const recentPage = {
      ...conversationDetail,
      messages: [...recentMessages].reverse(),
      message_pagination: { page: 1, limit: 30, has_more: true, total: 80 },
    };
    let pageReady = false;
    swrMock.mockImplementation((key: string | null) => ({
      data:
        key?.includes("limit=30&view=chat") && pageReady
          ? recentPage
          : undefined,
      error: undefined,
      isLoading: !pageReady,
      isValidating: !pageReady,
      mutate: mutateConversation,
    }));
    const props = {
      conversationId: "conv_1",
      workspaceId: "workspace_1",
      requestPreview: {
        id: "conv_1",
        client: "Selected customer",
        request: "Classification summary",
        lastMessageText: "List-only outbound summary",
        lastMessageDirection: "outbound",
      } as FormattedRequest,
    };
    const view = render(<ConversationDetailView {...props} />);
    expect(
      screen.queryByText("List-only outbound summary")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "loadingRecentMessages" })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("messages")).not.toBeInTheDocument();

    pageReady = true;
    view.rerender(<ConversationDetailView {...props} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(mockThreadMessages.at(-1)).toEqual(recentMessages);
    expect(
      screen.getByText("Recent message 29[delivered]")
    ).toBeInTheDocument();
  });

  it("starts at the latest messages and lets the reader scroll upward immediately", () => {
    jest.useFakeTimers();
    const height = jest
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(1200);
    const visibleHeight = jest
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(300);

    try {
      render(<ConversationDetailView conversationId="conv_1" />);
      const viewport = screen.getByTestId("viewport");
      expect(viewport.scrollTop).toBe(1200);

      viewport.scrollTop = 250;
      fireEvent.scroll(viewport);
      act(() => jest.advanceTimersByTime(600));

      expect(viewport.scrollTop).toBe(250);
      expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
    } finally {
      height.mockRestore();
      visibleHeight.mockRestore();
    }
  });

  it("positions a message deep link before paint without animating from the beginning", () => {
    jest.useFakeTimers();
    render(
      <ConversationDetailView
        conversationId="conv_1"
        initialHighlightedMessageId="msg_initial"
      />
    );

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "instant",
      block: "center",
    });
  });

  it("opens stale message links at the latest message without waiting for a timer", () => {
    jest.useFakeTimers();
    const height = jest
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(1200);
    try {
      render(
        <ConversationDetailView
          conversationId="conv_1"
          initialHighlightedMessageId={'missing"message'}
        />
      );
      expect(screen.getByTestId("viewport").scrollTop).toBe(1200);
      expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    } finally {
      height.mockRestore();
    }
  });

  it("keeps the latest message visible when the panel shrinks and preserves history readers", () => {
    const originalObserver = global.ResizeObserver;
    const callbacks: ResizeObserverCallback[] = [];
    global.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    let visibleHeight = 300;
    const height = jest
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(1200);
    const clientHeight = jest
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(() => visibleHeight);

    try {
      render(<ConversationDetailView conversationId="conv_1" />);
      const viewport = screen.getByTestId("viewport");
      viewport.scrollTop = 900;
      act(() => {
        visibleHeight = 200;
        callbacks.at(-1)?.([], {} as ResizeObserver);
      });
      expect(viewport.scrollTop).toBe(1200);

      mockScrollOwner.isAtBottom = false;
      mockScrollOwner.state.isAtBottom = false;
      viewport.scrollTop = 250;
      act(() => {
        visibleHeight = 100;
        callbacks.at(-1)?.([], {} as ResizeObserver);
      });
      expect(viewport.scrollTop).toBe(250);

      // The library's display flag also includes readers merely near bottom.
      mockScrollOwner.isAtBottom = true;
      act(() => {
        visibleHeight = 50;
        callbacks.at(-1)?.([], {} as ResizeObserver);
      });
      expect(viewport.scrollTop).toBe(250);
    } finally {
      height.mockRestore();
      clientHeight.mockRestore();
      global.ResizeObserver = originalObserver;
    }
  });

  it("keeps the chat surface height bounded inside the split panel", () => {
    render(<ConversationDetailView conversationId="conv_1" />);

    expect(screen.getByTestId("conversation-chat-surface")).toHaveClass(
      "h-full",
      "min-h-0",
      "overflow-hidden"
    );
    expect(screen.getByText("reply-form")).toBeInTheDocument();
  });

  it("does not duplicate the coach panel toggle while the coach panel is open", () => {
    mockCoachOpen = true;

    render(<ConversationDetailView conversationId="conv_1" />);

    expect(screen.queryByLabelText("Open coach panel")).not.toBeInTheDocument();
  });

  it("patches the displayed quick note from realtime without a full reload", () => {
    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(screen.getByTestId("quick-note-prop")).toHaveTextContent("");

    act(() => {
      boundHandlers.get("conversation.note.changed")?.({
        eventId: "evt_note",
        version: 1,
        name: "conversation.note.changed",
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        createdAt: "2026-06-21T12:00:00.000Z",
        dedupeKey: "conversation.note.changed:workspace_1:conv_1",
        payload: {
          data: {
            conversationId: "conv_1",
            note: "Pinned detail",
            updatedAt: "2026-06-21T12:00:00.000Z",
            updatedBy: "manager-1",
          },
        },
      });
    });

    expect(screen.getByTestId("quick-note-prop")).toHaveTextContent(
      "Pinned detail"
    );
    expect(mutateConversation).not.toHaveBeenCalled();
  });

  it("renders a blocked-conversation plan state instead of the raw limit error", () => {
    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: undefined,
          error: new ConversationPlanGateError(
            "Company conversation limit exceeded. Upgrade to Pro to create more conversations, scenarios, or bulk campaigns.",
            { hiddenCount: 378, reason: "conversation_limit" }
          ),
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    render(<ConversationDetailView conversationId="conv_1" />);

    expect(
      screen.getByText("conversationPlanBlockedTitle")
    ).toBeInTheDocument();
    expect(
      screen.getByText("conversationPlanBlockedDescription")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Company conversation limit exceeded/)
    ).not.toBeInTheDocument();
  });

  it("applies realtime delivery updates by provider message id", async () => {
    const conversationWithOutbound = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "instagram",
      messages: [
        {
          _id: "msg_outbound",
          messageId: "ig_mid_1",
          text: "Outbound reply",
          date: "2026-01-02T00:00:00.000Z",
          direction: "outbound",
          delivery: {
            status: "sent",
            sentAt: "2026-01-02T00:00:00.000Z",
          },
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithOutbound,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(screen.getByTestId("messages")).toHaveTextContent(
      "Outbound reply[sent]"
    );

    act(() => {
      boundHandlers.get("conversation.message.updated")?.({
        eventId: "evt_delivery",
        version: 1,
        name: "conversation.message.updated",
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        createdAt: "2026-01-02T00:01:00.000Z",
        dedupeKey:
          "conversation.message.updated:workspace_1:conv_1:ig_mid_1:message-delivery",
        payload: {
          legacyEvent: "message-delivery",
          messageId: "ig_mid_1",
          data: {
            messageId: "ig_mid_1",
            delivery: {
              status: "read",
              readAt: "2026-01-02T00:01:00.000Z",
            },
          },
        },
      });
    });

    expect(screen.getByTestId("messages")).toHaveTextContent(
      "Outbound reply[read]"
    );
  });

  it("applies realtime played delivery updates by provider message id", async () => {
    const localMutateConversation = jest.fn();
    const conversationWithOutbound = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      messages: [
        {
          _id: "msg_voice_1",
          messageId: "wamid.voice-1",
          text: "Voice note",
          date: "2026-01-02T00:00:00.000Z",
          direction: "outbound",
          delivery: {
            status: "sent",
            sentAt: "2026-01-02T00:00:00.000Z",
          },
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithOutbound,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: localMutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(screen.getByTestId("messages")).toHaveTextContent(
      "Voice note[sent]"
    );

    act(() => {
      boundHandlers.get("conversation.message.updated")?.({
        eventId: "evt_delivery_played",
        version: 1,
        name: "conversation.message.updated",
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        createdAt: "2026-01-02T00:01:00.000Z",
        dedupeKey:
          "conversation.message.updated:workspace_1:conv_1:wamid.voice-1:message-delivery",
        payload: {
          legacyEvent: "message-delivery",
          messageId: "wamid.voice-1",
          data: {
            messageId: "wamid.voice-1",
            delivery: {
              status: "played",
              playedAt: "2026-01-02T00:01:00.000Z",
              readAt: "2026-01-02T00:01:00.000Z",
              recipientType: "group",
              recipientParticipantId: "15551234567",
            },
          },
        },
      });
    });

    expect(screen.getByTestId("messages")).toHaveTextContent(
      "Voice note[played]"
    );
    expect(localMutateConversation).not.toHaveBeenCalled();
  });

  it("shows an incoming WhatsApp call banner without exposing provider ids", () => {
    const conversationWithCall = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      whatsapp_call_sessions: [
        {
          _id: "call_session_1",
          callId: "wacid.1",
          state: "incoming",
          direction: "USER_INITIATED",
          contactName: "Alice",
          lastProviderUpdateAt: "2026-02-02T02:40:00.000Z",
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithCall,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(screen.getByText("callIncomingTitle")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "callAcceptAction" })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "callRejectAction" })
    ).toBeEnabled();
    expect(screen.queryByText("wacid.1")).not.toBeInTheDocument();
  });

  it("sends a WhatsApp call reject command from the call banner", async () => {
    const conversationWithCall = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      whatsapp_call_sessions: [
        {
          _id: "call_session_1",
          callId: "wacid.1",
          state: "incoming",
          direction: "USER_INITIATED",
          contactName: "Alice",
          lastProviderUpdateAt: "2026-02-02T02:40:00.000Z",
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithCall,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as jest.Mock;

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "callRejectAction" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace_1/whatsapp/calls/call_session_1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "reject" }),
        })
      );
    });
    await waitFor(() => {
      expect(mutateConversation).toHaveBeenCalled();
    });
  });

  it("connects browser media when an operator joins an active WhatsApp call", async () => {
    const conversationWithActiveCall = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      whatsapp_call_sessions: [
        {
          _id: "call_session_1",
          callId: "wacid.1",
          state: "active",
          direction: "USER_INITIATED",
          contactName: "Alice",
          durationSeconds: 42,
          lastProviderUpdateAt: "2026-02-02T02:40:00.000Z",
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithActiveCall,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    const disconnect = jest.fn(async () => undefined);
    const setMicrophoneMuted = jest.fn(async () => undefined);
    mockJoinWhatsAppCallMedia.mockImplementation(async input => {
      input.onConnectionStateChange?.("connected");
      input.onMicrophoneMutedChange?.(false);
      return {
        ok: true,
        connection: {
          roomName: "wa-call-room",
          identity: "wa-participant-1",
          expiresAt: "2026-02-02T02:45:00.000Z",
          isMicrophoneMuted: () => false,
          setMicrophoneMuted,
          disconnect,
        },
      };
    });
    global.fetch = jest.fn() as jest.Mock;

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "callJoinMediaAction" })
    );

    await waitFor(() => {
      expect(mockJoinWhatsAppCallMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace_1",
          callSessionId: "call_session_1",
          audioElementHost: expect.any(HTMLElement),
          onConnectionStateChange: expect.any(Function),
          onMicrophoneMutedChange: expect.any(Function),
        })
      );
    });
    expect(await screen.findByText("callMediaConnected")).toBeInTheDocument();
    expect(
      screen.queryByText("callMediaClientUnavailable")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "callMuteAction" }));
    await waitFor(() => {
      expect(setMicrophoneMuted).toHaveBeenCalledWith(true);
    });
    expect(
      screen.getByRole("button", { name: "callUnmuteAction" })
    ).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "callUnmuteAction" }));
    await waitFor(() => {
      expect(setMicrophoneMuted).toHaveBeenCalledWith(false);
    });
    expect(
      screen.getByRole("button", { name: "callMuteAction" })
    ).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", { name: "callLeaveMediaAction" })
    );
    await waitFor(() => {
      expect(disconnect).toHaveBeenCalledTimes(1);
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "callJoinMediaAction" })
    ).toBeEnabled();
  });

  it("disconnects local media before terminating an active WhatsApp call", async () => {
    const conversationWithActiveCall = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      whatsapp_call_sessions: [
        {
          _id: "call_session_1",
          callId: "wacid.1",
          state: "active",
          direction: "USER_INITIATED",
          contactName: "Alice",
          durationSeconds: 42,
          lastProviderUpdateAt: "2026-02-02T02:40:00.000Z",
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithActiveCall,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    const disconnect = jest.fn(async () => undefined);
    mockJoinWhatsAppCallMedia.mockResolvedValue({
      ok: true,
      connection: {
        roomName: "wa-call-room",
        identity: "wa-participant-1",
        expiresAt: "2026-02-02T02:45:00.000Z",
        isMicrophoneMuted: () => false,
        setMicrophoneMuted: jest.fn(async () => undefined),
        disconnect,
      },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as jest.Mock;

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "callJoinMediaAction" })
    );
    expect(await screen.findByText("callMediaConnected")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "callTerminateAction" })
    );

    await waitFor(() => {
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/workspaces/workspace_1/whatsapp/calls/call_session_1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "terminate" }),
        })
      );
    });
    await waitFor(() => {
      expect(mutateConversation).toHaveBeenCalled();
    });
  });

  it("shows pending WhatsApp call command status and blocks duplicate actions", () => {
    const conversationWithPendingCallCommand = {
      ...conversationDetail,
      workspaceId: "workspace_1",
      channel: "whatsapp",
      whatsapp_call_sessions: [
        {
          _id: "call_session_1",
          callId: "wacid.1",
          state: "incoming",
          direction: "USER_INITIATED",
          contactName: "Alice",
          latestCommand: {
            id: "call_command_1",
            callSessionId: "call_session_1",
            action: "accept",
            status: "pending",
          },
          lastProviderUpdateAt: "2026-02-02T02:40:00.000Z",
        },
      ],
    };

    swrMock.mockImplementation((key: string | null) => {
      if (
        key &&
        key.includes("/api/conversations/conv_1?page=1&limit=30&view=chat")
      ) {
        return {
          data: conversationWithPendingCallCommand,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: mutateConversation,
        };
      }

      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        isValidating: false,
        mutate: jest.fn(),
      };
    });

    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    expect(screen.getByText("callCommandPendingLabel")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "callAcceptAction" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "callRejectAction" })
    ).toBeDisabled();
  });

  it("refetches chat details when a WhatsApp call realtime update arrives", () => {
    render(
      <ConversationDetailView
        conversationId="conv_1"
        workspaceId="workspace_1"
      />
    );

    act(() => {
      boundHandlers.get("conversation.call.updated")?.({
        eventId: "evt_call",
        version: 1,
        name: "conversation.call.updated",
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        createdAt: "2026-02-02T02:41:00.000Z",
        dedupeKey:
          "conversation.call.updated:workspace_1:conv_1:call_session_1:incoming",
        payload: {
          callSessionId: "call_session_1",
          state: "incoming",
        },
      });
    });

    expect(mutateConversation).toHaveBeenCalled();
  });
});
