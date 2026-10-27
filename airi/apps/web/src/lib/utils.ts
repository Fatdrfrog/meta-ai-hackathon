import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import dayjs from "dayjs";
import "dayjs/locale/en";
import "dayjs/locale/ru";
import "dayjs/locale/kk";
import calendar from "dayjs/plugin/calendar";
import type { PopulatedMessage } from "@/types/models";

dayjs.extend(calendar);

// Map our locale codes to dayjs locale codes
const localeMap: Record<string, string> = {
  en: "en",
  ru: "ru",
  kz: "kk", // Kazakh uses 'kk' in dayjs
};

export const groupMessagesByDate = (
  messages: PopulatedMessage[],
  locale: string = "en",
  getTranslation?: (key: string) => string
): { date: string; messages: PopulatedMessage[] }[] => {
  if (!messages) return [];

  const dayjsLocale = localeMap[locale] || "en";
  dayjs.locale(dayjsLocale);

  // Use translations if provided, otherwise fall back to English
  const todayLabel = getTranslation?.("today") || "Today";
  const yesterdayLabel = getTranslation?.("yesterday") || "Yesterday";

  const grouped = messages.reduce(
    (acc, msg) => {
      const msgDate = dayjs(msg.date);
      const now = dayjs();
      const yesterday = now.subtract(1, "day");
      const lastWeek = now.subtract(7, "day");

      let date: string;
      if (msgDate.isSame(now, "day")) {
        date = todayLabel;
      } else if (msgDate.isSame(yesterday, "day")) {
        date = yesterdayLabel;
      } else if (msgDate.isAfter(lastWeek)) {
        // Within last week - show day name and date
        date = msgDate.format("dddd, D MMMM");
      } else {
        // Older - show full date
        date = msgDate.format("D MMMM YYYY");
      }

      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(msg);
      return acc;
    },
    {} as { [key: string]: PopulatedMessage[] }
  );

  return Object.entries(grouped).map(([date, messages]) => ({
    date,
    messages,
  }));
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
