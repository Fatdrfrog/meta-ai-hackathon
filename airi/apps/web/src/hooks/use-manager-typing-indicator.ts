import { useCallback, useEffect, useRef } from "react";

const DEFAULT_MANAGER_TYPING_THROTTLE_MS = 20_000;

type UseManagerTypingIndicatorOptions = {
  conversationId: string;
  channel?: string | null;
  getTextValue: () => string;
  disabled?: boolean;
  throttleMs?: number;
};

export function useManagerTypingIndicator({
  conversationId,
  channel,
  getTextValue,
  disabled = false,
  throttleMs = DEFAULT_MANAGER_TYPING_THROTTLE_MS,
}: UseManagerTypingIndicatorOptions) {
  const lastSentAtRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    lastSentAtRef.current = 0;
    inFlightRef.current = false;
  }, [conversationId, channel]);

  const onTextChange = useCallback(() => {
    if (disabled || channel !== "whatsapp") return;
    if (!getTextValue().trim()) return;

    const now = Date.now();
    if (inFlightRef.current) return;
    if (now - lastSentAtRef.current < throttleMs) return;

    lastSentAtRef.current = now;
    inFlightRef.current = true;

    void fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/typing`,
      {
        method: "POST",
      }
    )
      .catch(() => undefined)
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [channel, conversationId, disabled, getTextValue, throttleMs]);

  return { onTextChange };
}
