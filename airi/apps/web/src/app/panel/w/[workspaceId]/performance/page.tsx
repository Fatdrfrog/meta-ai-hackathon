import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import PerformancePageClient from "@/features/panel/analytics/performance-route";
import {
  getLocaleFromCookie,
  loadAnalyticsClientMessages,
} from "@/i18n/message-loader";

export default async function PerformancePage() {
  const locale = await getLocaleFromCookie();
  const messages = await loadAnalyticsClientMessages(locale);

  return (
    <ScopedIntlProvider messages={messages}>
      <PerformancePageClient />
    </ScopedIntlProvider>
  );
}
