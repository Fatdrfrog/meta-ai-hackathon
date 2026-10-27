import { useCallback, useEffect, useRef } from "react";

type CoachTip = {
  title: string;
  suggestion: string;
  type: string;
  confidence: number;
  reasoning?: string;
};

export type CoachingPayload = {
  suggestionId: string;
  messageId: string;
  tips: CoachTip[];
  enhancedTips?: unknown[];
  suggestedEdit?: string;
  suggestedEditInCustomerLanguage?: string;
  sources?: {
    snippet?: {
      question: string;
      score?: number;
    };
    kbArticles?: Array<{
      id: string;
      title: string;
      similarity?: number;
      url?: string;
    }>;
    quickReplies?: Array<{
      text: string;
      category?: string;
      channel?: string;
    }>;
  };
  risk?: { maxSeverity: number; categories: string[] };
  skipReason?: string;
  conversationContext?: { stage: string; priority: string };
  agentProfile?: { skillLevel: string };
  languages?: { customer: string; manager: string };
  createdAt?: string | Date;
};

interface UseCoachTypingOptions {
  conversationId: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  airiCoachEnabled: boolean;
  setCoachTips: (tips: CoachingPayload | null) => void;
  setShowTypingIndicator: (show: boolean) => void;
  suggestionApplied: boolean;
  getTextValue?: () => string; // Optional fallback to get text from form
}

const SETTLE_DEBOUNCE_MS = 1400;
const SENTENCE_BOUNDARY = /[.!?\n]$/;

/**
 * Custom hook for handling coach typing logic with ref-based debouncing.
 * Prevents re-renders during typing by using refs internally.
 * Fires only after settle pause or sentence boundary — not mid-draft churn.
 */
export function useCoachTyping({
  conversationId,
  textareaRef,
  airiCoachEnabled,
  setCoachTips,
  setShowTypingIndicator,
  suggestionApplied,
  getTextValue,
}: UseCoachTypingOptions) {
  // Internal refs - these don't cause re-renders
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastProcessedTextRef = useRef<string>("");
  const lastProcessedLengthRef = useRef<number>(0);
  const lastRequestedNormalizedRef = useRef<string>("");
  const lastRequestedAtRef = useRef<number>(0);
  const inFlightRef = useRef<boolean>(false);
  const showTypingIndicatorRef = useRef(false);

  const setTypingIndicator = useCallback(
    (show: boolean) => {
      if (showTypingIndicatorRef.current === show) {
        return;
      }

      showTypingIndicatorRef.current = show;
      setShowTypingIndicator(show);
    },
    [setShowTypingIndicator]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Handle text change - called from textarea onChange
  // This schedules debounce but doesn't cause re-renders
  const onTextChange = useCallback(() => {
    // Clear existing timeout
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
      debounceTimeoutRef.current = null;
    }

    // Schedule settle debounce
    debounceTimeoutRef.current = setTimeout(() => {
      // Get fresh text value from ref (might have changed during typing)
      const text = textareaRef.current?.value || getTextValue?.() || "";
      const trimmed = text.trim();

      // Early exit if no text or too short
      if (!trimmed || trimmed.length < 3) {
        lastProcessedTextRef.current = "";
        lastProcessedLengthRef.current = 0;
        lastRequestedNormalizedRef.current = "";
        lastRequestedAtRef.current = 0;
        inFlightRef.current = false;
        setTypingIndicator(false);
        return;
      }

      // Skip if same as last processed text
      if (lastProcessedTextRef.current === text) {
        return;
      }

      // Early exit if coach is disabled
      if (!airiCoachEnabled) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        lastRequestedNormalizedRef.current = "";
        lastRequestedAtRef.current = 0;
        inFlightRef.current = false;
        setTypingIndicator(false);
        return;
      }

      // Normalize text for comparison
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const normalizedText = norm(text);
      const endsWithBoundary = SENTENCE_BOUNDARY.test(text);
      const now = Date.now();

      // Check if we should skip based on suggestion applied state
      if (suggestionApplied && lastProcessedLengthRef.current) {
        const lastLen = lastProcessedLengthRef.current;
        const currentLen = normalizedText.length;
        const diff = Math.abs(currentLen - lastLen);
        const threshold = Math.max(10, Math.floor(currentLen * 0.1));

        if (diff < threshold && !endsWithBoundary) {
          setTypingIndicator(false);
          return;
        }
      }

      // Skip if no boundary change and no significant diff vs last successful tips
      if (!endsWithBoundary && lastProcessedLengthRef.current) {
        const lastLen = lastProcessedLengthRef.current;
        const currentLen = normalizedText.length;
        const diff = Math.abs(currentLen - lastLen);
        const threshold = Math.max(10, Math.floor(currentLen * 0.1));

        if (diff < threshold) {
          return;
        }
      }

      const lastRequested = lastRequestedNormalizedRef.current;
      if (lastRequested && normalizedText === lastRequested) {
        return;
      }

      const lastRequestedLen = lastRequested.length;
      const diffFromLastRequest = Math.abs(
        normalizedText.length - lastRequestedLen
      );
      const diffRatio = lastRequestedLen
        ? diffFromLastRequest /
          Math.max(normalizedText.length, lastRequestedLen)
        : 1;
      const minorChange =
        !!lastRequested && diffFromLastRequest < 12 && diffRatio < 0.1;

      const minIntervalMs = 1200;
      if (
        !endsWithBoundary &&
        minorChange &&
        now - lastRequestedAtRef.current < minIntervalMs
      ) {
        return;
      }

      if (inFlightRef.current && !endsWithBoundary && minorChange) {
        return;
      }

      // Make API call (async, non-blocking)
      (async () => {
        try {
          setTypingIndicator(true);
          inFlightRef.current = true;
          lastRequestedNormalizedRef.current = normalizedText;
          lastRequestedAtRef.current = now;

          // Abort any in-flight request only if we have a meaningful change
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
          }

          // Create new abort controller for this request
          const controller = new AbortController();
          abortControllerRef.current = controller;

          const res = await fetch("/api/airi/coach", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversationId, text }),
            signal: controller.signal,
          });

          if (!res.ok) {
            if (res.status === 429) {
              setTypingIndicator(false);
              return;
            }
            throw new Error(`Coaching failed: ${res.status}`);
          }

          const payload = (await res.json()) as CoachingPayload;

          if (!payload?.tips || payload.tips.length === 0) {
            setCoachTips(null);
            setTypingIndicator(false);
            return;
          }

          // Update parent state only after successful API call.
          // Parent owns open/unread — hook never force-opens the panel.
          setCoachTips(payload);
          setTypingIndicator(false);

          // Update signature and last processed text only after successful API call
          lastProcessedLengthRef.current = normalizedText.length;
          lastProcessedTextRef.current = text;

          // Fire and forget event tracking
          fetch("/api/airi/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "suggestion_shown",
              conversationId,
              suggestionId: payload?.suggestionId,
            }),
          }).catch(() => {});
        } catch (err) {
          // Only handle if not aborted
          if (err instanceof Error && err.name !== "AbortError") {
            // Silent fail - don't show errors to user
          }
        } finally {
          inFlightRef.current = false;
          setTypingIndicator(false);
          abortControllerRef.current = null;
        }
      })();
    }, SETTLE_DEBOUNCE_MS);
  }, [
    conversationId,
    textareaRef,
    airiCoachEnabled,
    setCoachTips,
    setTypingIndicator,
    suggestionApplied,
    getTextValue,
  ]);

  // Handle disabled state change - abort requests if coach is disabled
  useEffect(() => {
    if (!airiCoachEnabled) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      lastRequestedNormalizedRef.current = "";
      lastRequestedAtRef.current = 0;
      inFlightRef.current = false;
      setTypingIndicator(false);
      // Clear debounce timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
        debounceTimeoutRef.current = null;
      }
    }
  }, [airiCoachEnabled, setTypingIndicator]);

  return { onTextChange };
}
