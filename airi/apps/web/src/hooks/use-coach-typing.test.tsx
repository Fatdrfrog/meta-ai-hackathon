/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useCoachTyping } from "./use-coach-typing";

const SETTLE_MS = 1400;

function CoachTypingHarness({
  setCoachTips = jest.fn(),
  setShowTypingIndicator,
}: {
  setCoachTips?: (tips: unknown) => void;
  setShowTypingIndicator: (show: boolean) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { onTextChange } = useCoachTyping({
    conversationId: "conversation_1",
    textareaRef,
    airiCoachEnabled: true,
    setCoachTips,
    setShowTypingIndicator,
    suggestionApplied: false,
  });

  return (
    <textarea aria-label="reply" ref={textareaRef} onChange={onTextChange} />
  );
}

describe("useCoachTyping", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it("does not emit a redundant hidden typing state for short drafts", () => {
    const setShowTypingIndicator = jest.fn();

    render(
      <CoachTypingHarness setShowTypingIndicator={setShowTypingIndicator} />
    );

    fireEvent.change(screen.getByLabelText("reply"), {
      target: { value: "ok" },
    });
    jest.advanceTimersByTime(SETTLE_MS + 1);

    expect(setShowTypingIndicator).not.toHaveBeenCalled();
  });

  it("does not force-open the coach panel while coaching is loading", async () => {
    const setShowTypingIndicator = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tips: [] }),
    }) as unknown as typeof fetch;

    render(
      <CoachTypingHarness setShowTypingIndicator={setShowTypingIndicator} />
    );

    fireEvent.change(screen.getByLabelText("reply"), {
      target: { value: "Please help me answer this customer." },
    });

    await act(async () => {
      jest.advanceTimersByTime(SETTLE_MS + 1);
      await Promise.resolve();
    });

    expect(setShowTypingIndicator).toHaveBeenCalledWith(true);
  });

  it("waits for settle debounce before requesting coach tips", async () => {
    const setShowTypingIndicator = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tips: [] }),
    }) as unknown as typeof fetch;

    render(
      <CoachTypingHarness setShowTypingIndicator={setShowTypingIndicator} />
    );

    fireEvent.change(screen.getByLabelText("reply"), {
      target: { value: "Please help me answer this customer" },
    });

    await act(async () => {
      jest.advanceTimersByTime(400);
      await Promise.resolve();
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(setShowTypingIndicator).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(SETTLE_MS);
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/airi/coach",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("requests coach tips after settle when draft ends with a sentence boundary", async () => {
    const setCoachTips = jest.fn();
    const setShowTypingIndicator = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        suggestionId: "s1",
        tips: [
          {
            title: "Tone",
            suggestion: "Be warmer",
            type: "tone",
            confidence: 0.9,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    render(
      <CoachTypingHarness
        setCoachTips={setCoachTips}
        setShowTypingIndicator={setShowTypingIndicator}
      />
    );

    fireEvent.change(screen.getByLabelText("reply"), {
      target: { value: "Thanks for waiting." },
    });

    await act(async () => {
      jest.advanceTimersByTime(SETTLE_MS + 1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(setCoachTips).toHaveBeenCalledWith(
      expect.objectContaining({ suggestionId: "s1" })
    );
  });
});
