import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { ScenariosWorkspace } from "@/components/scenarios/workspace/scenarios-workspace";
import { getScenariosPageData } from "@/features/panel/scenarios/server";
import { getLocaleFromCookie } from "@/i18n/message-loader";

export default async function ScenariosPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceId }, locale, resolvedSearchParams] = await Promise.all([
    params,
    getLocaleFromCookie(),
    searchParams,
  ]);
  const { messages, editorProps } = await getScenariosPageData({
    workspaceId,
    locale,
    searchParams: resolvedSearchParams,
  });

  return (
    <ScopedIntlProvider messages={messages}>
      <ScenariosWorkspace {...editorProps} />
    </ScopedIntlProvider>
  );
}
