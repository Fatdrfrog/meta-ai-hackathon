import { AiriPageWorkspace } from "@/components/ai/airi-page-workspace";
import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import {
  getLocaleFromCookie,
  loadScenariosClientMessages,
} from "@/i18n/message-loader";
import { firstSearchParam } from "@/lib/api/query-params";

type AiriPageProps = {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AiriPage({
  params,
  searchParams,
}: AiriPageProps) {
  const [{ workspaceId }, resolvedSearchParams, locale] = await Promise.all([
    params,
    searchParams,
    getLocaleFromCookie(),
  ]);
  const source = firstSearchParam(resolvedSearchParams?.source);
  const messages = await loadScenariosClientMessages(locale);

  return (
    <ScopedIntlProvider messages={messages}>
      <AiriPageWorkspace
        workspaceId={workspaceId}
        initialSource={source === "onboarding" ? "onboarding" : "manual"}
      />
    </ScopedIntlProvider>
  );
}
