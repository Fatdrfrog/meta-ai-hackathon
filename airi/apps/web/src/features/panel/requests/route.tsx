import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { RequestsMasterDetailLayout } from "@/components/requests/requests-master-detail-layout";
import { RequestsRealtime } from "@/components/tables/requests-realtime";
import { RequestsRealtimeProvider } from "@/components/tables/requests-realtime-provider";
import {
  getLocaleFromCookie,
  loadConversationsClientMessages,
} from "@/i18n/message-loader";
import { logger } from "@/lib/logger";
import {
  getRequestsData,
  type RequestsResponse,
} from "@/features/panel/requests/data-projection";
import { parseRequestsListQuery } from "@/features/panel/requests/list-query";
import { getWorkspaceSourceReadiness } from "@/features/panel/shared/workspace/source-readiness";
import { formatConversationToRequest } from "@/features/panel/requests/formatting";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import { redirect } from "next/navigation";
import { firstSearchParam } from "@/lib/api/query-params";

export default async function PageRequests({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ workspaceId }, resolvedSearchParams, locale, { supabase, user }] =
    await Promise.all([
      params,
      searchParams,
      getLocaleFromCookie(),
      getReadOnlySupabaseContext(),
    ]);

  if (!user) {
    redirect("/login");
  }

  const messagesPromise = loadConversationsClientMessages(locale);
  const hasConfiguredSourcesPromise = getWorkspaceSourceReadiness(
    supabase,
    workspaceId
  ).then(readiness => readiness.hasConfiguredSources);
  const listQuery = parseRequestsListQuery(resolvedSearchParams);

  let shouldHydrateFromApiOnMount = false;
  const requestsPromise = getRequestsData(
    workspaceId,
    {
      status: listQuery.status,
      filter: listQuery.filter,
    },
    supabase,
    { includeChannels: true }
  ).catch((error): RequestsResponse => {
    shouldHydrateFromApiOnMount = true;
    logger.error(
      "[panel/requests] Failed to load initial requests data",
      error
    );
    return {
      data: [],
      availableChannels: [],
      availableCategories: [],
      pagination: {
        page: 1,
        limit: 50,
        totalCount: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
      },
    };
  });

  const [messages, requests] = await Promise.all([
    messagesPromise,
    requestsPromise,
  ]);

  const formattedData = requests.data.map(item =>
    formatConversationToRequest(item)
  );
  // eslint-disable-next-line react-hooks/purity -- This Server Component renders once per request; the list ticks its clock forward from this value on the client.
  const initialRenderNowMs = Date.now();

  return (
    <ScopedIntlProvider messages={messages}>
      <div className="flex h-full flex-col overflow-hidden">
        <RequestsRealtimeProvider>
          <div className="relative flex h-full min-h-0 flex-1 flex-col">
            <RequestsRealtime workspaceId={workspaceId} />

            <RequestsMasterDetailLayout
              workspaceId={workspaceId}
              initialRequests={formattedData}
              initialAvailableChannels={requests.availableChannels ?? []}
              initialAvailableCategories={requests.availableCategories}
              initialHasMore={requests.pagination.hasNextPage}
              initialPlanGate={requests.planGate ?? null}
              shouldHydrateFromApiOnMount={shouldHydrateFromApiOnMount}
              initialRenderNowMs={initialRenderNowMs}
              initialConversationId={firstSearchParam(
                resolvedSearchParams.conversation
              )}
              initialHighlightedMessageId={firstSearchParam(
                resolvedSearchParams.message
              )}
              hasConfiguredSources={hasConfiguredSourcesPromise}
            />
          </div>
        </RequestsRealtimeProvider>
      </div>
    </ScopedIntlProvider>
  );
}
