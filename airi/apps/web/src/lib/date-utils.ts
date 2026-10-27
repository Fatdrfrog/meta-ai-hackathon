import { toIntlLocale } from "@/i18n/locales";

export function formatConversationDate(
  dateString: string | Date,
  locale: string = "en"
): string {
  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;

  // Browsers ship no Kazakh month names, so Kazakh dates are numeric.
  if (locale === "kz") {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find(item => item.type === type)?.value;
    return `${part("day")}.${part("month")}.${part("year")}`;
  }

  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatRelativeTime(
  dateString: string | Date,
  locale: string = "en"
): string {
  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;

  return formatConversationDate(date, locale);
}

export function formatCompactRelativeTime(
  dateString: string | Date,
  referenceDate: string | Date | number = Date.now()
): string {
  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;
  const time = date.getTime();
  if (!Number.isFinite(time)) return "";

  const reference =
    typeof referenceDate === "number"
      ? new Date(referenceDate)
      : new Date(referenceDate);
  const referenceTime = Number.isFinite(reference.getTime())
    ? reference.getTime()
    : Date.now();
  const diffMs = Math.max(0, referenceTime - time);
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 14) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;

  return `${Math.floor(days / 365)}y`;
}

export function formatDateSafe(
  dateString: string | Date | null | undefined,
  fallback: string = "Unknown date",
  locale: string = "en"
): string {
  if (!dateString) return fallback;

  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;

  if (isNaN(date.getTime())) {
    return fallback;
  }

  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatChannelName(
  channel?: string,
  businessConnectionId?: string,
  chatTitle?: string,
  chatType?: string,
  sourceInfo?: { display_phone_number?: string; phone_number_id?: string }
): string {
  if (channel === "email") return "Email";
  if (channel === "whatsapp") {
    if (sourceInfo?.display_phone_number) {
      return `WhatsApp (${sourceInfo.display_phone_number})`;
    }
    if (sourceInfo?.phone_number_id) {
      return `WhatsApp (${sourceInfo.phone_number_id})`;
    }
    return "WhatsApp";
  }
  if (channel === "telegram") {
    if (businessConnectionId) return "Telegram Business";
    return chatTitle || chatType || "Telegram";
  }
  return channel || "Unknown";
}

export function formatWhatsAppDisplayId(value?: string): string | undefined {
  if (!value) return value;
  if (value.startsWith("wa_bsuid_")) {
    return value.substring("wa_bsuid_".length);
  }
  if (value.startsWith("wa_")) {
    return value.substring(3);
  }
  return value;
}

/**
 * The customer's name, phone or handle for a conversation, or "" when none is
 * known. Callers show their own translated placeholder for "".
 */
export function formatClientName(
  channel?: string,
  user?: {
    username?: string;
    firstName?: string;
    lastName?: string;
    _id?: number | string;
  },
  participants?: { from?: string[]; to?: string[] },
  chat?: {
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  }
): string {
  const isEmail = channel === "email";

  if (isEmail && participants) {
    const from = participants.from?.[0] || "unknown";
    const to = participants.to?.[0] || "";
    return `${from} → ${to}`;
  }

  if (channel === "whatsapp" && user) {
    const phoneNumber = user._id ? String(user._id) : undefined;
    const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    const name = fullName || user.username;

    let displayId = phoneNumber;
    displayId = formatWhatsAppDisplayId(displayId);

    if (displayId) {
      if (name && name !== "Customer") {
        return `${name} (${displayId})`;
      }
      return displayId;
    }
    return name || "";
  }

  if (user) {
    const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
    if (fullName) {
      return fullName;
    }

    if (user.username) {
      return user.username;
    }
  }

  if (chat) {
    const chatName = chat.first_name || chat.username;
    if (chatName) {
      const fullName = chat.first_name
        ? `${chat.first_name}${chat.last_name ? " " + chat.last_name : ""}`
        : chatName;
      return fullName;
    }

    if (chat.title) {
      if (chat.title.startsWith("Customer")) {
        const idMatch = chat.title.match(/\(([^)]+)\)/);
        if (idMatch && idMatch[1]) {
          return formatWhatsAppDisplayId(idMatch[1]) || idMatch[1];
        }
      } else {
        return chat.title;
      }
    }
  }

  if (user?._id) {
    return formatWhatsAppDisplayId(String(user._id)) || String(user._id);
  }

  return "";
}

function getLocalCalendarKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function getCalendarKey(date: Date, timeZone?: string): string {
  if (!timeZone) return getLocalCalendarKey(date);

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find(part => part.type === "year")?.value;
    const month = parts.find(part => part.type === "month")?.value;
    const day = parts.find(part => part.type === "day")?.value;

    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    return getLocalCalendarKey(date);
  }

  return getLocalCalendarKey(date);
}

export function formatDateOrTime(
  dateString: string | Date | null | undefined,
  locale: string = "en",
  referenceDate?: string | Date | number | null,
  timeZone?: string,
  yesterdayLabel = "Yesterday"
): string {
  if (!dateString) return "";

  const date =
    typeof dateString === "string" ? new Date(dateString) : dateString;
  if (isNaN(date.getTime()))
    return typeof dateString === "string" ? dateString : "";

  const now =
    referenceDate === undefined || referenceDate === null
      ? new Date()
      : new Date(referenceDate);
  const safeNow = isNaN(now.getTime()) ? new Date() : now;
  const dateKey = getCalendarKey(date, timeZone);
  const todayKey = getCalendarKey(safeNow, timeZone);
  const yesterday = new Date(safeNow.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = getCalendarKey(yesterday, timeZone);
  const isToday = dateKey === todayKey;
  const isYesterday = dateKey === yesterdayKey;

  if (isToday) {
    const timeOptions: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
    };
    if (timeZone) timeOptions.timeZone = timeZone;

    return date.toLocaleTimeString(toIntlLocale(locale), {
      ...timeOptions,
    });
  }

  if (isYesterday) {
    return yesterdayLabel;
  }

  // Browsers ship no Kazakh month names (Chromium answers "M10 19" for "kk"),
  // so the Kazakh UI writes the numeric day.month instead.
  if (locale === "kz") {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find(item => item.type === type)?.value;
    return `${part("day")}.${part("month")}`;
  }

  const dateOptions: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
  };
  if (timeZone) dateOptions.timeZone = timeZone;

  return date.toLocaleDateString(locale, dateOptions);
}
