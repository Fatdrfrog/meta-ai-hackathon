import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility function to merge class names
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Insert or replace an item in a list by `id`
 */
export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const existingIndex = items.findIndex(
    (existingItem) => existingItem.id === item.id,
  );
  if (existingIndex === -1) {
    return [...items, item];
  }

  const nextItems = [...items];
  nextItems[existingIndex] = item;
  return nextItems;
}

/**
 * Remove optimistic item and merge confirmed item by `id`
 */
export function reconcileOptimisticById<T extends { id: string }>(
  items: T[],
  optimisticId: string,
  confirmedItem: T,
): T[] {
  const withoutOptimistic = items.filter((item) => item.id !== optimisticId);
  return upsertById(withoutOptimistic, confirmedItem);
}

/**
 * Format URL to show just the pathname
 */
export function formatUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname || "/";
  } catch {
    return url;
  }
}

/**
 * Format date to relative time (e.g., "2h ago", "Just now")
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
