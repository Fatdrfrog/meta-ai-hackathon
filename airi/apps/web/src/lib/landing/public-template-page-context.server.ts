import "server-only";
import { cache } from "react";
import { createTranslator } from "next-intl";
import { loadRootClientMessages } from "@/i18n/message-loader";
import type { PublicTemplateLocale } from "./template-request";
import type enMessages from "../../../messages/en.json";

type PublicPageMessages = Pick<typeof enMessages, "LandingDemo">;

/**
 * The app-wide next-intl request config intentionally follows the locale cookie.
 * Public canonical URLs need explicit messages for server metadata and HTML as
 * well as the scoped client provider; getTranslations({ locale }) still delegates
 * message loading to that cookie-based request config.
 */
export const getPublicTemplatePageContext = cache(
  async (locale: PublicTemplateLocale) => {
    const messages = await loadRootClientMessages(locale);
    // All three checked-in LandingDemo catalogs share this tested key shape.
    const publicMessages = messages as PublicPageMessages;
    const translator = createTranslator({ locale, messages: publicMessages });
    return {
      messages,
      translate: (key: string): string => {
        // Canonical catalog helpers select tested message keys dynamically.
        return translator(key as Parameters<typeof translator>[0]);
      },
    };
  }
);
