/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { act, render, waitFor } from "@testing-library/react";
import { useRealtime } from "@/hooks/use-realtime";
import type {
  RealtimeEventEnvelope,
  RealtimeEventName,
} from "@icecore/shared/types/realtime";
import { RequestsRealtime } from "./requests-realtime";

const mockUpdateRow = jest.fn();
const mockPlayConversationNotificationSound = jest.fn();

jest.mock("@icecore/shared/types/requests-realtime", () => {
  global.TextEncoder = jest.requireActual("node:util").TextEncoder;
  return jest.requireActual("@icecore/shared/types/requests-realtime");
});

jest.mock("next-intl", () => ({
  useLocale: () => "en",
}));

jest.mock("@/hooks/use-realtime", () => ({
  useRealtime: jest.fn(),
}));

jest.mock("./requests-realtime-provider", () => ({
  useRequestsRealtime: () => ({
    updateRow: mockUpdateRow,
  }),
}));

jest.mock("@/lib/notifications/conversation-sound", () => ({
  playConversationNotificationSound: () =>
    mockPlayConversationNotificationSound(),
}));

type BoundHandler = (event: RealtimeEventEnvelope) => void;

function makeRealtimeEvent(conversationId: string): RealtimeEventEnvelope {
  return {
    eventId: `evt-${conversationId}`,
    version: 1,
    name: "conversation.row.changed",
    workspaceId: "workspace_1",
    conversationId,
    createdAt: "2026-06-21T12:00:00.000Z",
    dedupeKey: `conversation.row.changed:workspace_1:${conversationId}`,
    payload: {
      conversationId,
    },
  };
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: "conv_1",
    createdAt: "2026-06-21T11:00:00.000Z",
    computedLastMessageAt: "2026-06-21T12:00:00.000Z",
    status: "open",
    channel: "whatsapp",
    is_read_by_manager: false,
    classification: {},
    user: {
      _id: "user_1",
      firstName: "Alice",
    },
    messages: [
      {
        _id: "msg_1",
        text: "Hello",
        date: "2026-06-21T12:00:00.000Z",
        direction: "inbound",
      },
    ],
    ...overrides,
  };
}

describe("RequestsRealtime notification sound", () => {
  const useRealtimeMock = useRealtime as jest.MockedFunction<
    typeof useRealtime
  >;
  const boundHandlers = new Map<string, BoundHandler>();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    boundHandlers.clear();

    useRealtimeMock.mockReturnValue({
      channel: {
        bind: jest.fn((event: RealtimeEventName, handler: BoundHandler) => {
          boundHandlers.set(event, handler);
        }),
        unbind: jest.fn((event: RealtimeEventName) => {
          boundHandlers.delete(event);
        }),
      },
      isConnected: false,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("retries a failed reconnect catch-up without another socket event", async () => {
    useRealtimeMock.mockReturnValue({
      ...useRealtimeMock({ kind: "workspace", workspaceId: "workspace_1" }),
      isConnected: true,
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: [makeConversation()] }),
      });
    render(<RequestsRealtime workspaceId="workspace_1" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4000);
    });
    expect(mockUpdateRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv_1" }),
      { highlight: false }
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled catch-up and retries it without another socket event", async () => {
    useRealtimeMock.mockReturnValue({
      ...useRealtimeMock({ kind: "workspace", workspaceId: "workspace_1" }),
      isConnected: true,
    });
    let signal: AbortSignal | undefined;
    global.fetch = jest
      .fn()
      .mockImplementationOnce((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: [makeConversation()] }),
      });
    render(<RequestsRealtime workspaceId="workspace_1" />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(18_000);
    });
    expect(signal?.aborted).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockUpdateRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv_1" }),
      { highlight: false }
    );
  });

  it("pauses catch-up retries while hidden and cancels old workspace work", async () => {
    let visibility: DocumentVisibilityState = "visible";
    jest
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    useRealtimeMock.mockReturnValue({
      ...useRealtimeMock({ kind: "workspace", workspaceId: "workspace_1" }),
      isConnected: true,
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const { rerender, unmount } = render(
      <RequestsRealtime workspaceId="workspace_1" />
    );
    await act(async () => {
      await Promise.resolve();
    });
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    rerender(<RequestsRealtime workspaceId="workspace_2" />);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(
      String((global.fetch as jest.Mock).mock.calls.at(-1)?.[0])
    ).toContain("workspaceId=workspace_2");
    const count = (global.fetch as jest.Mock).mock.calls.length;
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(count);
  });

  it("keeps the Requests list on the workspace channel", () => {
    global.fetch = jest.fn() as jest.Mock;

    render(<RequestsRealtime workspaceId="workspace_1" />);

    expect(useRealtimeMock.mock.calls).toEqual([
      [{ kind: "workspace", workspaceId: "workspace_1" }],
    ]);
    expect([...boundHandlers.keys()]).toEqual(["conversation.row.changed"]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("catches up on mount when the shared socket is already connected", async () => {
    useRealtimeMock.mockReturnValue({
      ...useRealtimeMock({ kind: "workspace", workspaceId: "workspace_1" }),
      isConnected: true,
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [makeConversation()] }),
    });
    render(<RequestsRealtime workspaceId="workspace_1" />);
    await waitFor(() =>
      expect(mockUpdateRow).toHaveBeenCalledWith(
        expect.objectContaining({ id: "conv_1" }),
        { highlight: false }
      )
    );
    expect(mockPlayConversationNotificationSound).not.toHaveBeenCalled();
  });

  it("retries failed hydration without needing another websocket event", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: [makeConversation()] }),
      });
    render(<RequestsRealtime workspaceId="workspace_1" />);
    await act(async () => {
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_1")
      );
      await jest.advanceTimersByTimeAsync(1200);
    });
    expect(mockUpdateRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conv_1" }),
      { highlight: true }
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not let a late hydration response overwrite a newer row", async () => {
    let completeFirst!: (response: unknown) => void;
    global.fetch = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            completeFirst = resolve;
          })
      )
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [makeConversation({ projectionGeneration: "20" })],
        }),
      });
    render(<RequestsRealtime workspaceId="workspace_1" />);
    await act(async () => {
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_1")
      );
      await jest.advanceTimersByTimeAsync(100);
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_1")
      );
      await jest.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      completeFirst({
        ok: true,
        json: async () => ({
          data: [makeConversation({ projectionGeneration: "10" })],
        }),
      });
    });
    expect(mockUpdateRow).toHaveBeenCalledTimes(1);
    expect(mockUpdateRow.mock.calls[0][0].projectionGeneration).toBe("20");
  });

  it("discards in-flight responses after changing workspace", async () => {
    let complete!: (response: unknown) => void;
    global.fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          complete = value => resolve(value as Response);
        })
    );
    const { rerender } = render(<RequestsRealtime workspaceId="workspace_1" />);
    await act(async () => {
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_1")
      );
      await jest.advanceTimersByTimeAsync(100);
    });
    rerender(<RequestsRealtime workspaceId="workspace_2" />);
    await act(async () => {
      complete({
        ok: true,
        json: async () => ({ data: [makeConversation()] }),
      });
    });
    expect(mockUpdateRow).not.toHaveBeenCalled();
  });

  it("plays once for a realtime batch with an unread inbound latest message", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [makeConversation()] }),
    }) as jest.Mock;

    render(<RequestsRealtime workspaceId="workspace_1" />);

    act(() => {
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_1")
      );
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(mockUpdateRow).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "conv_1",
          lastMessageDirection: "inbound",
          isReadByManager: false,
        }),
        { highlight: true }
      );
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/requests?"),
      expect.objectContaining({
        cache: "no-store",
        headers: {
          "x-airi-realtime-hydration": "1",
        },
      })
    );
    for (const [url] of (global.fetch as jest.Mock).mock.calls) {
      expect(String(url)).toContain("/api/requests?");
    }
    expect(mockPlayConversationNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("hydrates recent rows when realtime reconnects without replaying notification sounds", async () => {
    jest.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));

    let isConnected = false;
    useRealtimeMock.mockImplementation(() => ({
      channel: {
        bind: jest.fn((event: RealtimeEventName, handler: BoundHandler) => {
          boundHandlers.set(event, handler);
        }),
        unbind: jest.fn((event: RealtimeEventName) => {
          boundHandlers.delete(event);
        }),
      },
      isConnected,
    }));

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [makeConversation({ _id: "conv_recent" })] }),
    }) as jest.Mock;

    const { rerender } = render(<RequestsRealtime workspaceId="workspace_1" />);

    expect(global.fetch).not.toHaveBeenCalled();

    isConnected = true;
    rerender(<RequestsRealtime workspaceId="workspace_1" />);

    await waitFor(() => {
      expect(mockUpdateRow).toHaveBeenCalledWith(
        expect.objectContaining({ id: "conv_recent" }),
        { highlight: false }
      );
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("page=1&limit=50&includeChannels=false"),
      expect.objectContaining({
        cache: "no-store",
        headers: {
          "x-airi-realtime-hydration": "1",
        },
      })
    );
    expect(mockPlayConversationNotificationSound).not.toHaveBeenCalled();
  });

  it("does not play for outbound, read, or duplicate latest messages", async () => {
    const rows = [
      makeConversation({
        _id: "conv_outbound",
        messages: [
          {
            _id: "msg_outbound",
            text: "Manager reply",
            date: "2026-06-21T12:00:00.000Z",
            direction: "outbound",
          },
        ],
      }),
      makeConversation({
        _id: "conv_read",
        is_read_by_manager: true,
      }),
      makeConversation({
        _id: "conv_duplicate",
        messages: [
          {
            _id: "msg_duplicate",
            text: "Already notified",
            date: "2026-06-21T12:00:00.000Z",
            direction: "inbound",
          },
        ],
      }),
    ];
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [rows[2]] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: rows }),
      }) as jest.Mock;

    render(<RequestsRealtime workspaceId="workspace_1" />);

    act(() => {
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_duplicate")
      );
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(mockPlayConversationNotificationSound).toHaveBeenCalledTimes(1);
    });

    act(() => {
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_outbound")
      );
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_read")
      );
      boundHandlers.get("conversation.row.changed")?.(
        makeRealtimeEvent("conv_duplicate")
      );
      jest.advanceTimersByTime(100);
    });

    await waitFor(() => {
      expect(mockUpdateRow).toHaveBeenCalledWith(
        expect.objectContaining({ id: "conv_outbound" }),
        { highlight: true }
      );
    });
    expect(mockPlayConversationNotificationSound).toHaveBeenCalledTimes(1);
  });
});
