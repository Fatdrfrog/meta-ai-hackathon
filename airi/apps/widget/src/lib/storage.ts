/**
 * LocalStorage utilities for widget state persistence
 * Includes fallback handling for WebViews and storage-restricted environments
 */

/**
 * Safe localStorage wrapper that handles errors gracefully
 * Falls back to in-memory storage if localStorage is unavailable
 */
const memoryStorage: Record<string, string> = {};

const LEGACY_STORAGE_KEYS = {
  VISITOR_ID: "icecore_visitor_id",
  CONVERSATION_ID: "icecore_conversation_id",
  CONVERSATION_MAP: "icecore_conversation_map",
  MESSAGE_COUNTS: "icecore_message_counts",
  VISITOR_TOKEN: "icecore_visitor_token",
  WIDGET_OPEN: "icecore_widget_open",
  SESSION: "icecore_session",
} as const;

export const STORAGE_KEYS = {
  VISITOR_ID: "airi_visitor_id",
  CONVERSATION_ID: "airi_conversation_id",
  CONVERSATION_MAP: "airi_conversation_map", // Maps URL -> conversation ID
  MESSAGE_COUNTS: "airi_message_counts", // Maps conversation ID -> last known message count
  VISITOR_TOKEN: "airi_visitor_token",
  WIDGET_OPEN: "airi_widget_open",
  SESSION: "airi_session", // Analytics session data
} as const;

const WIDGET_POSITION_KEY = "airi_widget_position";
const LEGACY_WIDGET_POSITION_KEY = "icecore_widget_position";

const LEGACY_KEY_BY_CURRENT: Record<string, string> = {
  [STORAGE_KEYS.VISITOR_ID]: LEGACY_STORAGE_KEYS.VISITOR_ID,
  [STORAGE_KEYS.CONVERSATION_ID]: LEGACY_STORAGE_KEYS.CONVERSATION_ID,
  [STORAGE_KEYS.CONVERSATION_MAP]: LEGACY_STORAGE_KEYS.CONVERSATION_MAP,
  [STORAGE_KEYS.MESSAGE_COUNTS]: LEGACY_STORAGE_KEYS.MESSAGE_COUNTS,
  [STORAGE_KEYS.VISITOR_TOKEN]: LEGACY_STORAGE_KEYS.VISITOR_TOKEN,
  [STORAGE_KEYS.WIDGET_OPEN]: LEGACY_STORAGE_KEYS.WIDGET_OPEN,
  [STORAGE_KEYS.SESSION]: LEGACY_STORAGE_KEYS.SESSION,
  [WIDGET_POSITION_KEY]: LEGACY_WIDGET_POSITION_KEY,
};

function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      const value = localStorage.getItem(key);
      if (value !== null) return value;

      const legacyKey = LEGACY_KEY_BY_CURRENT[key];
      if (legacyKey) {
        const legacyValue = localStorage.getItem(legacyKey);
        if (legacyValue !== null) {
          localStorage.setItem(key, legacyValue);
          return legacyValue;
        }
      }
    }
  } catch (error) {
    console.warn(
      "Airi.chat Widget: localStorage access denied, using memory fallback",
      error,
    );
  }
  // Fallback to memory storage
  const legacyKey = LEGACY_KEY_BY_CURRENT[key];
  return (
    memoryStorage[key] || (legacyKey ? memoryStorage[legacyKey] : null) || null
  );
}

function safeSetItem(key: string, value: string): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      localStorage.setItem(key, value);
      return true;
    }
  } catch (error) {
    console.warn(
      "Airi.chat Widget: localStorage write failed, using memory fallback",
      error,
    );
    // Fallback to memory storage
    memoryStorage[key] = value;
    return false;
  }
  return true;
}

function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      localStorage.removeItem(key);
      const legacyKey = LEGACY_KEY_BY_CURRENT[key];
      if (legacyKey) {
        localStorage.removeItem(legacyKey);
      }
      return;
    }
  } catch (error) {
    console.warn("Airi.chat Widget: localStorage remove failed", error);
  }
  // Fallback: remove from memory
  delete memoryStorage[key];
  const legacyKey = LEGACY_KEY_BY_CURRENT[key];
  if (legacyKey) {
    delete memoryStorage[legacyKey];
  }
}

/**
 * Get or create visitor ID
 * If user identity is provided, use userId as visitor ID for persistence across sessions
 */
export function getVisitorId(userIdentity?: { userId: string } | null): string {
  // If authenticated user, use their userId as visitor ID
  if (userIdentity?.userId) {
    // Store for future sessions
    safeSetItem(STORAGE_KEYS.VISITOR_ID, userIdentity.userId);
    return userIdentity.userId;
  }

  // Otherwise, use or generate anonymous UUID
  let visitorId = safeGetItem(STORAGE_KEYS.VISITOR_ID);

  if (!visitorId) {
    // Generate UUID v4 for anonymous visitor
    visitorId = generateUUID();
    safeSetItem(STORAGE_KEYS.VISITOR_ID, visitorId);
  }

  return visitorId;
}

/**
 * Generate an identity, including in WebViews without crypto.randomUUID.
 */
export function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Save conversation ID (legacy - for backward compatibility)
 */
export function setConversationId(conversationId: string): void {
  safeSetItem(STORAGE_KEYS.CONVERSATION_ID, conversationId);
}

/**
 * Clear the stored visitor token after the server rejects it.
 */
export function clearVisitorToken(): void {
  safeRemoveItem(STORAGE_KEYS.VISITOR_TOKEN);
}

/**
 * Get conversation ID for a specific URL
 */
export function getConversationIdForUrl(url: string): string | null {
  try {
    const mapJson = safeGetItem(STORAGE_KEYS.CONVERSATION_MAP);
    if (!mapJson) return null;

    const map: Record<string, string> = JSON.parse(mapJson);
    return map[url] || null;
  } catch (error) {
    console.error("Failed to parse conversation map:", error);
    return null;
  }
}

/**
 * Save conversation ID for a specific URL
 */
export function setConversationIdForUrl(
  url: string,
  conversationId: string,
): void {
  try {
    const mapJson = safeGetItem(STORAGE_KEYS.CONVERSATION_MAP);
    const map: Record<string, string> = mapJson ? JSON.parse(mapJson) : {};

    map[url] = conversationId;
    safeSetItem(STORAGE_KEYS.CONVERSATION_MAP, JSON.stringify(map));

    // Also update the legacy single conversation ID to the current URL's conversation
    setConversationId(conversationId);
  } catch (error) {
    console.error("Failed to save conversation map:", error);
  }
}

/**
 * Remove a stale conversation ID from every local mapping.
 */
export function removeConversationIdEverywhere(conversationId: string): void {
  try {
    const mapJson = safeGetItem(STORAGE_KEYS.CONVERSATION_MAP);
    const map: Record<string, string> = mapJson ? JSON.parse(mapJson) : {};
    let changed = false;

    for (const [url, storedConversationId] of Object.entries(map)) {
      if (storedConversationId === conversationId) {
        delete map[url];
        changed = true;
      }
    }

    if (changed) {
      safeSetItem(STORAGE_KEYS.CONVERSATION_MAP, JSON.stringify(map));
    }

    if (safeGetItem(STORAGE_KEYS.CONVERSATION_ID) === conversationId) {
      safeRemoveItem(STORAGE_KEYS.CONVERSATION_ID);
    }

    const countsJson = safeGetItem(STORAGE_KEYS.MESSAGE_COUNTS);
    if (countsJson) {
      const counts: Record<string, number> = JSON.parse(countsJson);
      if (conversationId in counts) {
        delete counts[conversationId];
        safeSetItem(STORAGE_KEYS.MESSAGE_COUNTS, JSON.stringify(counts));
      }
    }
  } catch (error) {
    console.error("Failed to remove stale conversation from storage:", error);
  }
}

/**
 * Get visitor token for authenticated requests
 */
export function getVisitorToken(): string | null {
  return safeGetItem(STORAGE_KEYS.VISITOR_TOKEN);
}

/**
 * Save widget open state
 */
export function setWidgetOpenState(isOpen: boolean): void {
  safeSetItem(STORAGE_KEYS.WIDGET_OPEN, isOpen ? "true" : "false");
}

/**
 * Get last known message count for a conversation
 */
export function getLastSeenMessageCount(conversationId: string): number {
  try {
    const countsJson = safeGetItem(STORAGE_KEYS.MESSAGE_COUNTS);
    if (!countsJson) return 0;

    const counts: Record<string, number> = JSON.parse(countsJson);
    return counts[conversationId] || 0;
  } catch (error) {
    console.error("Failed to parse message counts:", error);
    return 0;
  }
}

/**
 * Update last seen message count for a conversation
 */
export function setLastSeenMessageCount(
  conversationId: string,
  count: number,
): void {
  try {
    const countsJson = safeGetItem(STORAGE_KEYS.MESSAGE_COUNTS);
    const counts: Record<string, number> = countsJson
      ? JSON.parse(countsJson)
      : {};

    counts[conversationId] = count;
    safeSetItem(STORAGE_KEYS.MESSAGE_COUNTS, JSON.stringify(counts));
  } catch (error) {
    console.error("Failed to save message counts:", error);
  }
}

/**
 * Calculate unread count for a conversation
 */
export function getUnreadCount(
  conversationId: string,
  currentCount: number,
): number {
  const lastSeenCount = getLastSeenMessageCount(conversationId);
  return Math.max(0, currentCount - lastSeenCount);
}

/**
 * Widget position for draggable functionality
 */
export interface WidgetPosition {
  bottom: number;
  right: number;
}

const DEFAULT_POSITION: WidgetPosition = {
  bottom: 20,
  right: 20,
};

export function getWidgetPosition(): WidgetPosition {
  try {
    const stored = safeGetItem(WIDGET_POSITION_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore storage errors
  }
  return DEFAULT_POSITION;
}

export function setWidgetPosition(position: WidgetPosition): void {
  try {
    safeSetItem(WIDGET_POSITION_KEY, JSON.stringify(position));
  } catch {
    // Ignore storage errors
  }
}
