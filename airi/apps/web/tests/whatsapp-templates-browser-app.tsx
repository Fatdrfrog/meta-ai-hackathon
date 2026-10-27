import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { Toaster } from "sonner";
import { WhatsAppTemplatesManager } from "../src/components/whatsapp-templates/templates-manager";
import { PageHeader } from "../src/components/ui/page-header";
import { WhatsAppTemplatesBrowserScenario } from "./whatsapp-templates-browser-scenario";
import commonMessages from "../messages/en.json";
import en from "../messages/templates/en/page.json";
import ru from "../messages/templates/ru/page.json";
import kz from "../messages/templates/kz/page.json";
import enScenarios from "../messages/scenarios/en/page.json";
import ruScenarios from "../messages/scenarios/ru/page.json";
import kzScenarios from "../messages/scenarios/kz/page.json";
import "../src/app/globals.css";

const requestedLocale = new URLSearchParams(window.location.search).get(
  "locale"
);
const locale =
  requestedLocale === "ru" || requestedLocale === "kz" ? requestedLocale : "en";
const messages = { en, ru, kz }[locale];
const scenarioMessages = { en: enScenarios, ru: ruScenarios, kz: kzScenarios }[
  locale
];
document.documentElement.lang = locale;
createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider
    locale={locale}
    timeZone="UTC"
    messages={{ ...commonMessages, ...scenarioMessages, ...messages }}
  >
    <main className="mx-auto max-w-7xl space-y-4 p-4 sm:p-8">
      <PageHeader
        title={messages.templates.title}
        description={messages.templates.description}
      />
      {new URLSearchParams(window.location.search).get("surface") ===
      "scenario" ? (
        <WhatsAppTemplatesBrowserScenario />
      ) : (
        <WhatsAppTemplatesManager workspaceId="browser-workspace" />
      )}
    </main>
    <Toaster />
  </NextIntlClientProvider>
);
