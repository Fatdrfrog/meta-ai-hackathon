/**
 * Convert timestamp to relative format
 * Examples: "just now", "2 min ago", "3 hours ago", "Yesterday", "Jan 15"
 *
 * Similar to Notion's timestamp display
 */

export function getRelativeTime(date: Date | string): string {
  const now = new Date();
  const timestamp = typeof date === "string" ? new Date(date) : date;
  const diffMs = now.getTime() - timestamp.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  // Just now (< 1 minute)
  if (diffSec < 60) {
    return "just now";
  }

  // Minutes ago (1-59 minutes)
  if (diffMin < 60) {
    return `${diffMin} min ago`;
  }

  // Hours ago (1-23 hours)
  if (diffHour < 24) {
    return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  }

  // Yesterday
  if (diffDay === 1) {
    return "Yesterday";
  }

  // This week (2-6 days ago)
  if (diffDay < 7) {
    return `${diffDay} days ago`;
  }

  // This year (show month + day)
  if (timestamp.getFullYear() === now.getFullYear()) {
    return timestamp.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  // Last year or older (show full date)
  return timestamp.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Get absolute time for tooltip/hover
 */
export function getAbsoluteTime(date: Date | string): string {
  const timestamp = typeof date === "string" ? new Date(date) : date;
  return timestamp.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
