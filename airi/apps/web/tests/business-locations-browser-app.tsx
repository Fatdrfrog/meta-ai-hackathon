import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ScopedIntlProvider } from "../src/components/i18n/scoped-intl-provider";
import { BusinessLocationsManager } from "../src/components/settings/business-locations/business-locations-manager";
import { Toaster } from "../src/components/ui/sonner";
import enRootMessages from "../messages/en.json";
import ruRootMessages from "../messages/ru.json";
import kzRootMessages from "../messages/kz.json";
import enLayoutMessages from "../messages/settings/layout/en/page.json";
import ruLayoutMessages from "../messages/settings/layout/ru/page.json";
import kzLayoutMessages from "../messages/settings/layout/kz/page.json";
import enOfficesMessages from "../messages/settings/business-locations/en/page.json";
import ruOfficesMessages from "../messages/settings/business-locations/ru/page.json";
import kzOfficesMessages from "../messages/settings/business-locations/kz/page.json";
import "../src/app/globals.css";

const params = new URLSearchParams(window.location.search);
const requestedLocale = params.get("locale");
const locale =
  requestedLocale === "ru" || requestedLocale === "kz" ? requestedLocale : "en";
if (params.get("theme") === "dark") {
  document.documentElement.classList.add("dark");
}
document.documentElement.lang = locale;

const rootMessages = {
  en: enRootMessages,
  ru: ruRootMessages,
  kz: kzRootMessages,
}[locale];
// The settings layout scopes its page catalogs around every settings page.
const settingsMessages = {
  en: { ...enLayoutMessages, ...enOfficesMessages },
  ru: { ...ruLayoutMessages, ...ruOfficesMessages },
  kz: { ...kzLayoutMessages, ...kzOfficesMessages },
}[locale];

// The real manager, translations, styles, HTTP client and toaster inside the
// settings layout's content column. The empty aside stands in for the
// settings sidebar (lg and up) so the page gets its real width; the sidebar's
// navigation needs Next routing and is not part of this harness. Playwright
// answers the Offices API; this page never contacts a server.
createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider
    locale={locale}
    timeZone="UTC"
    messages={rootMessages}
  >
    <ScopedIntlProvider messages={settingsMessages}>
      <div className="flex h-full min-h-0">
        <aside
          aria-hidden="true"
          className="hidden w-56 shrink-0 border-r lg:block"
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main
            className="min-h-0 flex-1 overflow-auto"
            data-testid="settings-main"
          >
            <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
              <BusinessLocationsManager workspaceId="browser-workspace" />
            </div>
          </main>
        </div>
      </div>
    </ScopedIntlProvider>
    <Toaster />
  </NextIntlClientProvider>
);
