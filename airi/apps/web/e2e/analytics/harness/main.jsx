import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { Provider } from "jotai";
import { SWRConfig } from "swr";
import { AnalyticsLayout } from "@/components/analytics/analytics-layout";
import { JourneyAnalytics } from "@/components/analytics/journey-analytics";
import { DashboardPageClient } from "@/components/dashboard/dashboard-page-client";
import { BulkAnalytics } from "@/components/analytics/bulk-analytics";
import enBase from "../../../messages/en.json";
import enPanel from "../../../messages/panel/en/page.json";
import enAnalytics from "../../../messages/analytics/en/page.json";
import ruBase from "../../../messages/ru.json";
import ruPanel from "../../../messages/panel/ru/page.json";
import ruAnalytics from "../../../messages/analytics/ru/page.json";
import kzBase from "../../../messages/kz.json";
import kzPanel from "../../../messages/panel/kz/page.json";
import kzAnalytics from "../../../messages/analytics/kz/page.json";
import "@/app/globals.css";

const catalogs = {
  en: { ...enBase, ...enPanel, ...enAnalytics },
  ru: { ...ruBase, ...ruPanel, ...ruAnalytics },
  kz: { ...kzBase, ...kzPanel, ...kzAnalytics },
};
const search = new URLSearchParams(location.search);
const requestedLocale = search.get("locale");
// Mount real report components with a controlled fixture transport and no backend.
const isBulk = search.get("view") === "bulk";
const view =
  isBulk ? (
    <BulkAnalytics
      workspaceId="qa-workspace"
      initialCampaignIds={["00000000-0000-4000-8000-000000000001"]}
    />
  ) : search.get("view") === "dashboards" ? (
    <DashboardPageClient
      workspaceId="qa-workspace"
      customizable
      memberId="qa-member"
    />
  ) : (
    <JourneyAnalytics workspaceId="qa-workspace" memberId="qa-member" />
  );
const locale = Object.hasOwn(catalogs, requestedLocale)
  ? requestedLocale
  : "en";
document.documentElement.lang = locale;

createRoot(document.getElementById("root")).render(
  <NextIntlClientProvider
    locale={locale}
    messages={catalogs[locale]}
    timeZone="Asia/Qyzylorda"
  >
    <Provider>
      <SWRConfig value={{ provider: () => new Map(), errorRetryCount: 0 }}>
        <div className="h-screen bg-background text-foreground">
          {isBulk ? (
            <main className="mx-auto min-w-0 max-w-[1600px] p-4 md:p-6">
              {view}
            </main>
          ) : (
            <AnalyticsLayout workspaceId="qa-workspace">{view}</AnalyticsLayout>
          )}
        </div>
      </SWRConfig>
    </Provider>
  </NextIntlClientProvider>
);
