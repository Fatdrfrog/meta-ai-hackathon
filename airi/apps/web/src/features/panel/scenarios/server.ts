import "server-only";

import {
  getConnectedScenarioActionSources,
  getConnectedScenarioSourceMentions,
  getConnectedScenarioSourceOptions,
  getScenarioSourceCapabilities,
  hasConnectedScenarioSources,
  type ScenarioSourceReadinessRow,
} from "@/components/scenarios/scenario-onboarding";
import { loadInitialScenarioDetail } from "@/features/panel/scenarios/initial-scenario-detail";
import {
  SCENARIO_SOURCE_READINESS_SELECT,
  toScenarioSourceReadinessRows,
} from "@/features/panel/scenarios/source-rows";
import { panelWorkspaceAiriHref } from "@/features/panel/shared/routing/hrefs";
import {
  getReadOnlySupabaseClient,
  requirePanelWorkspaceAccess,
} from "@/features/panel/shared/workspace";
import type { Locale } from "@/i18n/locales";
import { loadScenariosClientMessages } from "@/i18n/message-loader";
import { isRegisteredUsersEmailAudienceEnabledForWorkspace } from "@/lib/email/registered-users-audience";
import { isHiggsfieldWebhookConfigured } from "@/lib/higgsfield/higgsfield-webhook";
import { listAllWorkspaceScenarioSummaries } from "@/lib/scenarios/list-workspace-scenario-summaries";
import { isTemporalConfigured } from "@/lib/temporal/higgsfield-assets";
import { getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { trimmedSearchParam } from "@/lib/api/query-params";

type ReadOnlySupabaseClient = Awaited<
  ReturnType<typeof getReadOnlySupabaseClient>
>;

/**
 * Starts work before the access check settles. A redirect() thrown by that
 * check must not leave a later rejection unhandled; awaiting the returned
 * promise still rethrows it.
 */
function startEarly<T>(work: PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(work);
  promise.catch(() => undefined);
  return promise;
}

function hasWhatsAppSource(sourceRows: ScenarioSourceReadinessRow[]) {
  return getConnectedScenarioSourceMentions(sourceRows).includes("whatsapp");
}

/**
 * The allow-list check the registered-phones audience action runs on mount,
 * which only happens with WhatsApp connected; a failure there leaves the
 * audience empty.
 */
function loadRegisteredAudienceEnabled({
  sources,
  workspaceId,
}: {
  sources: Promise<Awaited<ReturnType<typeof readScenarioSourceRows>>>;
  workspaceId: string;
}): Promise<boolean> {
  return sources
    .then(result =>
      !result.error &&
      hasWhatsAppSource(toScenarioSourceReadinessRows(result.data))
        ? isRegisteredUsersEmailAudienceEnabledForWorkspace({
            workspaceId,
          })
        : false
    )
    .catch(() => false);
}

function readScenarioSourceRows(
  supabase: ReadOnlySupabaseClient,
  workspaceId: string
) {
  return supabase
    .from("sources")
    .select(SCENARIO_SOURCE_READINESS_SELECT)
    .eq("workspace_id", workspaceId);
}

/**
 * None of these reads needs the membership result, and none of it leaves the
 * server unless access passes, so they run alongside the access check. The
 * sources and allow-list reads use the visitor's row-level-security client.
 */
function startScenariosPageReads({
  supabase,
  workspaceId,
  locale,
}: {
  supabase: ReadOnlySupabaseClient;
  workspaceId: string;
  locale: Locale;
}) {
  const sources = startEarly(readScenarioSourceRows(supabase, workspaceId));
  return {
    sources,
    // Never rejects: a failed check leaves the audience off.
    registeredAudienceEnabled: loadRegisteredAudienceEnabled({
      sources,
      workspaceId,
    }),
    messages: startEarly(loadScenariosClientMessages(locale)),
    summaries: startEarly(listAllWorkspaceScenarioSummaries(workspaceId)),
    // An unavailable flag store keeps the default inline editor.
    featureFlags: getWorkspaceFeatureFlags(workspaceId, [
      "scenario_node_settings_panel",
    ]).catch(() => null),
  };
}

type ScenariosPageReads = ReturnType<typeof startScenariosPageReads>;

/**
 * Starts the first scenario's detail as soon as the summaries arrive, so it
 * does not wait for the other reads.
 */
function startInitialScenarioDetail({
  summaries,
  workspaceId,
  requestedScenarioId,
}: {
  summaries: ScenariosPageReads["summaries"];
  workspaceId: string;
  requestedScenarioId: string | null;
}) {
  return summaries.then(
    initialScenarios =>
      loadInitialScenarioDetail({
        workspaceId,
        summaries: initialScenarios,
        requestedScenarioId,
      }),
    // The page itself fails on this rejection.
    () => null
  );
}

function getHiggsfieldUnavailableReason(
  webhookConfigured: boolean,
  temporalConfigured: boolean
) {
  if (!webhookConfigured) {
    return "Higgsfield webhook callback is not configured";
  }
  return temporalConfigured ? "" : "Temporal worker is not configured";
}

function buildScenarioSourceProps(sourceRows: ScenarioSourceReadinessRow[]) {
  const connectedSourceMentions =
    getConnectedScenarioSourceMentions(sourceRows);
  const higgsfieldUnavailableReason = getHiggsfieldUnavailableReason(
    isHiggsfieldWebhookConfigured(),
    isTemporalConfigured()
  );
  if (
    !higgsfieldUnavailableReason &&
    !connectedSourceMentions.includes("higgsfield")
  ) {
    connectedSourceMentions.push("higgsfield");
  }

  return {
    hasWhatsApp: connectedSourceMentions.includes("whatsapp"),
    connectedSourceMentions,
    connectedSourceOptions: getConnectedScenarioSourceOptions(sourceRows),
    higgsfieldUnavailableReason,
    connectedActionSources: getConnectedScenarioActionSources(sourceRows),
    sourceCapabilities: getScenarioSourceCapabilities(sourceRows),
    hasConnectedSources: hasConnectedScenarioSources(sourceRows),
    hasGoogleCalendar: sourceRows.some(
      row => (row.type || "").trim() === "google_calendar"
    ),
  };
}

export async function getScenariosPageData({
  workspaceId,
  locale,
  searchParams,
}: {
  workspaceId: string;
  locale: Locale;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const supabase = await getReadOnlySupabaseClient();
  const reads = startScenariosPageReads({ supabase, workspaceId, locale });
  // Redirects win over read failures, and nothing is built before access.
  await requirePanelWorkspaceAccess(
    workspaceId,
    panelWorkspaceAiriHref(workspaceId)
  );
  const requestedScenarioId =
    trimmedSearchParam(searchParams.scenarioId) || null;
  // Not awaited: the page streams it to the canvas.
  const initialScenarioDetail = startInitialScenarioDetail({
    summaries: reads.summaries,
    workspaceId,
    requestedScenarioId,
  });

  const [
    sourcesResult,
    messages,
    initialScenarios,
    featureFlags,
    registeredAudienceEnabled,
  ] = await Promise.all([
    reads.sources,
    reads.messages,
    reads.summaries,
    reads.featureFlags,
    reads.registeredAudienceEnabled,
  ]);
  if (sourcesResult.error) {
    throw new Error("Failed to load scenario sources", {
      cause: sourcesResult.error,
    });
  }
  const sourceRows = toScenarioSourceReadinessRows(sourcesResult.data);

  return {
    messages,
    editorProps: {
      workspaceId,
      ...buildScenarioSourceProps(sourceRows),
      initialScenarios: initialScenarios ?? undefined,
      requestedScenarioId,
      initialScenarioDetail,
      registeredAudienceEnabled,
      openPreviewOnMount: trimmedSearchParam(searchParams.preview) === "1",
      openAiriCreateOnMount:
        trimmedSearchParam(searchParams.airiCreate) === "1",
      nodeSettingsPanelEnabled:
        featureFlags?.scenario_node_settings_panel === true,
    },
  };
}
