"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ScenarioTriggerLogFilterSummary } from "@/lib/scenarios/trigger-log-meta";
import { useTranslations } from "next-intl";
import type { ScenarioTriggerLogEntry } from "@/lib/scenarios/trigger-log-meta";

type ScenarioTriggerLogPanelProps = {
  logs: ScenarioTriggerLogEntry[];
  loading: boolean;
  hasMore?: boolean;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onClose: () => void;
  onOpenPreview?: () => void;
  previewLabel?: string;
  layout?: "side" | "bottom";
};

function formatDate(
  value: string | Date | null | undefined,
  unknownLabel: string
): string {
  if (!value) return unknownLabel;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return unknownLabel;
  return parsed.toLocaleString();
}

function formatProductRouteReason(
  log: ScenarioTriggerLogEntry,
  t: ReturnType<typeof useTranslations>
): string | null {
  const route = log.meta?.productRoute;
  const reason = log.mismatchReason || route?.outcome;
  const labelName = route?.labelNames.filter(Boolean).join(", ");
  const fallbackName = route?.nameFallbacks.filter(Boolean).join(", ");
  switch (reason) {
    case "matched_label":
      return t("triggerLogReasonMatchedLabel", {
        name: labelName || route?.campaignName || "",
      });
    case "matched_name_fallback":
      return t("triggerLogReasonMatchedName", {
        name: fallbackName || route?.campaignName || "",
      });
    case "suppressed_label_precedence":
      return t("triggerLogReasonSuppressedLabelPrecedence");
    case "suppressed_label_conflict":
      return t("triggerLogReasonSuppressedLabelConflict");
    case "suppressed_name_ambiguous":
      return t("triggerLogReasonSuppressedNameAmbiguous");
    case "suppressed_labels_unavailable":
      return t("triggerLogReasonSuppressedLabelsUnavailable");
    case "product_no_match":
      return t("triggerLogReasonProductNoMatch");
    default:
      return null;
  }
}

function formatMismatchReason(
  log: ScenarioTriggerLogEntry,
  t: ReturnType<typeof useTranslations>
): string | null {
  const reason = log.mismatchReason;
  if (
    reason === "already_started_in_conversation" ||
    reason === "blocked_by_once_per_conversation"
  ) {
    return t("triggerLogReasonAlreadyStarted");
  }

  const productReason = formatProductRouteReason(log, t);
  if (productReason) return productReason;
  if (!reason) return null;
  return t("unknown");
}

function formatTokenList(values: Array<string | number>): string {
  return values.join(", ");
}

function buildFilterTokens(
  filters: ScenarioTriggerLogFilterSummary | null | undefined
): string[] {
  if (!filters) return [];

  const tokens: string[] = [];
  if (filters.channelFilter?.length) {
    tokens.push(`channels=${formatTokenList(filters.channelFilter)}`);
  }
  if (filters.messageMatchMode) {
    tokens.push(`messageMatch=${filters.messageMatchMode}`);
  }
  if (filters.keywordPattern) {
    tokens.push(`keyword=${filters.keywordPattern}`);
  }
  if (filters.keywordMatchMode) {
    tokens.push(`keywordMode=${filters.keywordMatchMode}`);
  }
  if (filters.whatsappReferralSourceTypes?.length) {
    tokens.push(
      `waReferralTypes=${formatTokenList(filters.whatsappReferralSourceTypes)}`
    );
  }
  if (filters.whatsappReferralSourcePlatforms?.length) {
    tokens.push(
      `waReferralPlatforms=${formatTokenList(filters.whatsappReferralSourcePlatforms)}`
    );
  }
  if (filters.metaReferralSourceIds?.length) {
    tokens.push(
      `metaReferralIds=${formatTokenList(filters.metaReferralSourceIds)}`
    );
  }
  if (filters.metaReferralCampaignIds?.length) {
    tokens.push(
      `metaCampaignIds=${formatTokenList(filters.metaReferralCampaignIds)}`
    );
  }
  if (filters.metaReferralAdSetIds?.length) {
    tokens.push(
      `metaAdSetIds=${formatTokenList(filters.metaReferralAdSetIds)}`
    );
  }
  if (filters.metaCampaignLabelNames?.length) {
    tokens.push(
      `campaignLabels=${formatTokenList(filters.metaCampaignLabelNames)}`
    );
  } else if (filters.metaCampaignLabelIds?.length) {
    tokens.push(
      `campaignLabels=${formatTokenList(filters.metaCampaignLabelIds)}`
    );
  }
  if (filters.metaCampaignNameFallbacks?.length) {
    tokens.push(
      `campaignNames=${formatTokenList(filters.metaCampaignNameFallbacks)}`
    );
  }
  if (typeof filters.onlyNewCustomers === "boolean") {
    tokens.push(`onlyNewCustomers=${filters.onlyNewCustomers}`);
  }

  return tokens;
}

function buildLogDetailSections(
  log: ScenarioTriggerLogEntry,
  t: ReturnType<typeof useTranslations>
): Array<{ title: string; values: string[] }> {
  const sections: Array<{ title: string; values: string[] }> = [];
  const filterTokens = buildFilterTokens(log.meta?.filters);
  if (filterTokens.length > 0) {
    sections.push({
      title: t("triggerLogDetailsFilters"),
      values: filterTokens,
    });
  }

  const pathTokens: string[] = [];
  if (Array.isArray(log.meta?.selectedPathNodeIds)) {
    for (const nodeId of log.meta.selectedPathNodeIds) {
      pathTokens.push(`node=${nodeId}`);
    }
  }
  if (Array.isArray(log.meta?.selectedSourceHandleIds)) {
    for (const handleId of log.meta.selectedSourceHandleIds) {
      pathTokens.push(`handle=${handleId}`);
    }
  }
  if (log.meta?.selectedSourceHandleUsed) {
    pathTokens.push(`usedHandle=${log.meta.selectedSourceHandleUsed}`);
  }
  if (Array.isArray(log.branchNodeIds)) {
    for (const nodeId of log.branchNodeIds) {
      pathTokens.push(`branch=${nodeId}`);
    }
  }
  if (pathTokens.length > 0) {
    sections.push({
      title: t("triggerLogDetailsPath"),
      values: pathTokens,
    });
  }

  const routingTokens: string[] = [];
  if (log.meta?.triggerNodeId) {
    routingTokens.push(`triggerNode=${log.meta.triggerNodeId}`);
  }
  if (log.selectedActionNodeId) {
    routingTokens.push(`selectedAction=${log.selectedActionNodeId}`);
  }
  if (Array.isArray(log.meta?.candidateActionNodeIds)) {
    for (const nodeId of log.meta.candidateActionNodeIds) {
      routingTokens.push(`candidate=${nodeId}`);
    }
  }
  if (log.meta?.preferredActionNodeId) {
    routingTokens.push(`preferredAction=${log.meta.preferredActionNodeId}`);
  }
  if (log.meta?.lockedByConversationState) {
    routingTokens.push("lockedByConversationState=true");
  }
  if (routingTokens.length > 0) {
    sections.push({
      title: t("triggerLogDetailsRouting"),
      values: routingTokens,
    });
  }

  return sections;
}

function TriggerLogTokenSection(props: { title: string; values: string[] }) {
  if (props.values.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      <div className="text-[11px] font-medium text-foreground/90">
        {props.title}
      </div>
      <div className="flex flex-wrap gap-1">
        {props.values.map(value => (
          <code
            key={`${props.title}-${value}`}
            className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {value}
          </code>
        ))}
      </div>
    </div>
  );
}

export function ScenarioTriggerLogPanel({
  logs,
  loading,
  hasMore = false,
  onRefresh,
  onLoadMore,
  onClose,
  onOpenPreview,
  previewLabel,
  layout = "side",
}: ScenarioTriggerLogPanelProps) {
  const t = useTranslations("Scenarios");

  return (
    <aside
      className={
        layout === "bottom"
          ? "h-full border-t bg-background"
          : "h-full w-[360px] min-w-[340px] border-l bg-background"
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-semibold">{t("triggerLogTitle")}</div>
          <div className="flex items-center gap-2">
            {onOpenPreview && previewLabel ? (
              <Button size="sm" variant="ghost" onClick={onOpenPreview}>
                {previewLabel}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={onRefresh}>
              {t("refresh")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t("close")}
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1 p-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">
              {t("triggerLogLoading")}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {t("triggerLogEmpty")}
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map(log => (
                <div
                  key={String(log._id)}
                  className={`rounded-md border p-2.5 ${
                    log.matched
                      ? "border-emerald-200 dark:border-emerald-800/50"
                      : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={log.matched ? "default" : "secondary"}
                        className={`h-[18px] px-1.5 text-[9px] uppercase ${
                          log.matched
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                            : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400"
                        }`}
                      >
                        {log.matched
                          ? t("triggerLogMatched")
                          : t("triggerLogMissed")}
                      </Badge>
                      {log.scenarioName ? (
                        <span
                          className="max-w-[140px] truncate text-[11px] font-medium"
                          title={log.scenarioName}
                        >
                          {log.scenarioName}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(
                        log.evaluatedAt || log.createdAt,
                        t("triggerLogUnknownTime")
                      )}
                    </div>
                  </div>

                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("triggerLogTriggerEvent", {
                      triggerType: log.triggerType || t("unknown"),
                      eventKind: log.eventKind,
                    })}
                  </div>

                  {log.selectedActionType ? (
                    <div className="mt-1 text-xs">
                      {t("triggerLogAction")}:{" "}
                      <span className="font-medium">
                        {log.selectedActionType}
                      </span>
                    </div>
                  ) : null}

                  {formatMismatchReason(log, t) ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("triggerLogReason")}: {formatMismatchReason(log, t)}
                    </div>
                  ) : null}

                  {buildLogDetailSections(log, t).map(section => (
                    <TriggerLogTokenSection
                      key={`${String(log._id)}-${section.title}`}
                      title={section.title}
                      values={section.values}
                    />
                  ))}
                </div>
              ))}
              {hasMore && onLoadMore ? (
                <div className="pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onLoadMore}
                    disabled={loading}
                  >
                    {t("loadMore")}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </ScrollArea>
      </div>
    </aside>
  );
}
