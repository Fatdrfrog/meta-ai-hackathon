/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import { useManagerTypingIndicator } from "./use-manager-typing-indicator";

describe("useManagerTypingIndicator", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-23T10:00:00.000Z"));
    global.fetch = jest.fn(async () => new Response("{}")) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it("posts a WhatsApp manager typing notification once per throttle window", async () => {
    let text = "Hello";
    const { result } = renderHook(() =>
      useManagerTypingIndicator({
        conversationId: "conversation_1",
        channel: "whatsapp",
        getTextValue: () => text,
        throttleMs: 20_000,
      })
    );

    await act(async () => {
      result.current.onTextChange();
    });
    await act(async () => {
      result.current.onTextChange();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/conversations/conversation_1/typing",
      expect.objectContaining({ method: "POST" })
    );

    text = "Hello again";
    jest.advanceTimersByTime(20_001);
    await act(async () => {
      result.current.onTextChange();
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not post for non-WhatsApp channels or empty drafts", async () => {
    const { result, rerender } = renderHook(
      ({ channel, text }: { channel: string | undefined; text: string }) =>
        useManagerTypingIndicator({
          conversationId: "conversation_1",
          channel,
          getTextValue: () => text,
        }),
      {
        initialProps: {
          channel: "instagram",
          text: "Hello",
        },
      }
    );

    await act(async () => {
      result.current.onTextChange();
    });

    rerender({ channel: "whatsapp", text: "   " });
    await act(async () => {
      result.current.onTextChange();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
