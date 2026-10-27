import { AnalyticsLayout } from "@/components/analytics/analytics-layout";
import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import {
  getLocaleFromCookie,
  loadAnalyticsClientMessages,
  loadConversationsClientMessages,
} from "@/i18n/message-loader";

interface AnalyticsSectionLayoutProps {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}

export default async function AnalyticsSectionLayout({
  children,
  params,
}: AnalyticsSectionLayoutProps) {
  const [{ workspaceId }, locale] = await Promise.all([
    params,
    getLocaleFromCookie(),
  ]);
  const [analyticsMessages, conversationMessages] = await Promise.all([
    loadAnalyticsClientMessages(locale),
    loadConversationsClientMessages(locale),
  ]);
  const messages = {
    ...analyticsMessages,
    ...conversationMessages,
  };

  return (
    <ScopedIntlProvider messages={messages}>
      <AnalyticsLayout workspaceId={workspaceId}>{children}</AnalyticsLayout>
    </ScopedIntlProvider>
  );
}
