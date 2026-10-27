import { ScopedIntlProvider } from "@/components/i18n/scoped-intl-provider";
import { BulkCampaignsPageClient } from "@/components/campaigns/bulk-campaigns-page-client";
import { requirePanelWorkspaceAccess } from "@/features/panel/shared/workspace";
import {
  getLocaleFromCookie,
  loadAnalyticsClientMessages,
  loadConversationsClientMessages,
} from "@/i18n/message-loader";
import { isWorkspaceEmailSourceEnabled } from "@/lib/email/email-source";
import {
  getRegisteredUsersEmailAudienceSummary,
  isRegisteredUsersEmailAudienceEnabledForWorkspace,
} from "@/lib/email/registered-users-audience";
import { firstSearchParam } from "@/lib/api/query-params";

type BulkCampaignsSearchParams = {
  days?: string | string[];
  tab?: string | string[];
  campaignId?: string | string[];
  airiBulkDraft?: string | string[];
};

const DEFAULT_DAYS_PERIOD = 30;
const MIN_DAYS_PERIOD = 1;
const MAX_DAYS_PERIOD = 365;
const REGISTERED_USERS_EMAIL_PREVIEW_LIMIT = 500;

function parseDaysPeriod(value?: string | string[]): number {
  const parsed = Number.parseInt(firstSearchParam(value) || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS_PERIOD;
  return Math.min(MAX_DAYS_PERIOD, Math.max(MIN_DAYS_PERIOD, parsed));
}

function parseInitialTab(value?: string | string[]): "campaigns" | "analytics" {
  return firstSearchParam(value) === "analytics" ? "analytics" : "campaigns";
}

function parseInitialCampaignIds(value?: string | string[]): string[] {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  return Array.from(
    new Set(
      rawValues
        .flatMap(entry => String(entry || "").split(","))
        .map(entry => entry.trim())
        .filter(Boolean)
    )
  );
}

export default async function BulkCampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<BulkCampaignsSearchParams>;
}) {
  const [{ workspaceId }, resolvedSearchParams, locale] = await Promise.all([
    params,
    searchParams,
    getLocaleFromCookie(),
  ]);
  const { supabase } = await requirePanelWorkspaceAccess(workspaceId);

  const [emailEnabled, analyticsMessages, conversationMessages, registeredUsersEnabled] =
    await Promise.all([
      isWorkspaceEmailSourceEnabled(workspaceId),
      loadAnalyticsClientMessages(locale),
      // Analytics opens ConversationDetailDrawer — needs ChatPanel / detail strings.
      loadConversationsClientMessages(locale),
      isRegisteredUsersEmailAudienceEnabledForWorkspace({
        workspaceId,
      }),
    ]);
  const messages = {
    ...analyticsMessages,
    ...conversationMessages,
  };
  const registeredUsersAudience =
    emailEnabled && registeredUsersEnabled
      ? {
          enabled: true,
          ...(await getRegisteredUsersEmailAudienceSummary({
            workspaceId,
            supabase,
            previewLimit: REGISTERED_USERS_EMAIL_PREVIEW_LIMIT,
          })),
        }
      : null;

  return (
    <ScopedIntlProvider messages={messages}>
      <BulkCampaignsPageClient
        key={workspaceId}
        workspaceId={workspaceId}
        days={parseDaysPeriod(resolvedSearchParams.days)}
        emailEnabled={emailEnabled}
        initialTab={parseInitialTab(resolvedSearchParams.tab)}
        initialCampaignIds={parseInitialCampaignIds(
          resolvedSearchParams.campaignId
        )}
        openAiriBulkDraftOnMount={
          firstSearchParam(resolvedSearchParams.airiBulkDraft) === "1"
        }
        registeredUsersAudience={registeredUsersAudience}
      />
    </ScopedIntlProvider>
  );
}
