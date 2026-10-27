"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Filter, Tags, Trash2, UsersRound, Zap } from "lucide-react";
import { useTranslations } from "next-intl";
import { projectActiveClientMessageFilters } from "@/lib/scenarios/client-message-trigger-criteria";
import {
  buildClientMessageTriggerPresentation,
  type ClientMessageSummaryItem,
} from "../../view/client-message-trigger-presentation";
import type { TranslateFn } from "../../types";
import type { ScenarioTriggerEditorNodeProps } from "../../view/node-enrichment/types";
import {
  buildScenarioTriggerSummaryChips,
  buildWhatsAppQrCompactChips,
} from "../../view/scenario-builder-summary-labels";
import { ScenarioNodeCard } from "../node-card";
import { NodeHandles } from "../node-handlers";
import { ScenarioNodeSettingsButton } from "../node-settings-button";
import { WhatsAppQrTriggerPicker } from "./whatsapp-qr-trigger-picker";

const FILTER_PRIORITY: readonly ClientMessageSummaryItem["kind"][] = [
  "labels",
  "campaign",
  "ad-set",
  "ad",
  "name-fallback",
  "customers",
  "referral-platforms",
  "referral-types",
];

function TriggerNodeHeaderChrome({
  onRemove,
  t,
}: {
  onRemove?: () => void;
  t: TranslateFn;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Zap className="h-4 w-4 shrink-0 text-amber-500" />
        <Badge variant="secondary" className="h-5 px-1.5 text-[11px] uppercase">
          {t("badgeTrigger")}
        </Badge>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onRemove}
          aria-label={t("removeBlock")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function CompactTriggerNode({
  id,
  data,
  selected,
}: ScenarioTriggerEditorNodeProps) {
  const t = useTranslations("Scenarios");
  const behaviorT = useTranslations("CustomerBehavior");
  const triggerConfig = data.uiTriggerConfig;
  const isLinkedEntry = Boolean(data.linkedConditionId);
  const isWhatsAppQr = triggerConfig.entryPointType === "whatsapp_qr";
  const isBusinessEvent = triggerConfig.entryPointType === "business_event";
  const isMessage =
    !isLinkedEntry &&
    !isWhatsAppQr &&
    !isBusinessEvent &&
    triggerConfig.entryPointType !== "customer_behavior";
  const messageCriteria = isMessage
    ? projectActiveClientMessageFilters(triggerConfig)
    : null;
  const messageSummary = messageCriteria
    ? buildClientMessageTriggerPresentation(
        messageCriteria,
        t,
        data.uiAudienceOptions
      )
    : null;
  const messageFilters =
    messageSummary?.summaryItems
      .filter(item => item.kind !== "message" && item.kind !== "channels")
      .sort(
        (left, right) =>
          FILTER_PRIORITY.indexOf(left.kind) -
          FILTER_PRIORITY.indexOf(right.kind)
      ) ?? [];
  const hasAdFilter =
    messageFilters.some(item =>
      ["labels", "campaign", "ad-set", "ad", "name-fallback"].includes(
        item.kind
      )
    ) ||
    (messageCriteria?.whatsappReferralSourceTypes.length === 1 &&
      messageCriteria.whatsappReferralSourceTypes[0] === "ad");
  const triggerLabel = isLinkedEntry
    ? t("triggerLinkedEntryTitle")
    : isBusinessEvent
      ? t("presetTriggerBusinessEvent")
      : hasAdFilter
        ? t("triggerAdMessage")
        : data.uiNodeLabel;
  const whatsAppQrSummary = data.uiWhatsAppQrPicker?.selected;
  const summaryChips = isLinkedEntry
    ? [t("triggerLinkedEntryDescription")]
    : triggerConfig.entryPointType === "customer_behavior" &&
        triggerConfig.behavior
      ? [
          behaviorT(`presets.${triggerConfig.behavior.preset}`),
          behaviorT("stopsOnPurchase"),
        ]
      : isWhatsAppQr
        ? buildWhatsAppQrCompactChips(whatsAppQrSummary, t)
        : buildScenarioTriggerSummaryChips(triggerConfig, t);
  const primarySummary = summaryChips[0] || triggerLabel;
  const secondaryChips = summaryChips.slice(1);
  const channelSummary =
    messageSummary?.summaryItems.find(item => item.kind === "channels")?.text ||
    t("triggerAllChannels");
  const visibleFilters = messageFilters.slice(0, 3);
  const remainingFilterCount = messageFilters.length - visibleFilters.length;

  return (
    <div
      className="relative w-max min-w-0"
      data-testid="scenario-trigger-node-compact"
      data-entry-point-type={
        isWhatsAppQr ? "whatsapp_qr" : triggerConfig.entryPointType || "message"
      }
    >
      <ScenarioNodeCard
        selected={selected}
        interactive
        className="w-[300px] max-w-[300px] gap-3 overflow-visible border-amber-300/70 py-3"
      >
        <NodeHandles
          kind="trigger"
          compact
          onCreateNodeFromSourceHandle={(sourceHandleId, point) =>
            data.uiOnCreateNodeFromSourceHandle?.(
              sourceHandleId,
              point.clientX,
              point.clientY
            )
          }
        />
        <CardHeader className="gap-1.5 px-3 pb-0">
          <TriggerNodeHeaderChrome onRemove={data.uiOnRemove} t={t} />
          <div className="min-w-0">
            <div
              className="truncate text-sm font-semibold leading-tight"
              title={triggerLabel}
            >
              {triggerLabel}
            </div>
            <div
              className="line-clamp-2 break-words text-[11px] leading-snug text-muted-foreground"
              title={primarySummary}
            >
              {primarySummary}
            </div>
          </div>
          {isMessage ? (
            <Badge
              variant="secondary"
              className="max-w-full whitespace-normal text-[11px]"
            >
              {channelSummary}
            </Badge>
          ) : null}
          {isBusinessEvent && !isLinkedEntry ? (
            <Badge variant="secondary" className="self-start">
              {t("businessEventDraftBadge")}
            </Badge>
          ) : null}
        </CardHeader>
        {isWhatsAppQr && data.uiWhatsAppQrPicker ? (
          <CardContent className="min-w-0 p-3 pt-1.5">
            <WhatsAppQrTriggerPicker {...data.uiWhatsAppQrPicker} />
          </CardContent>
        ) : isMessage ? (
          visibleFilters.length > 0 ? (
            <CardContent className="flex min-w-0 flex-col gap-2 px-3 py-0">
              {visibleFilters.map(item => {
                const Icon =
                  item.kind === "labels"
                    ? Tags
                    : item.kind === "customers"
                      ? UsersRound
                      : Filter;
                return (
                  <div
                    key={item.kind}
                    className="flex min-w-0 items-start gap-2 text-xs"
                  >
                    <Icon
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span
                      className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]"
                      title={item.text}
                    >
                      {item.text}
                    </span>
                  </div>
                );
              })}
              {remainingFilterCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="nodrag h-7 self-start px-0 text-xs"
                  onClick={event => {
                    event.stopPropagation();
                    data.uiOnSelect();
                  }}
                >
                  {t("triggerMoreFilters", { count: remainingFilterCount })}
                </Button>
              ) : null}
            </CardContent>
          ) : null
        ) : secondaryChips.length > 0 ? (
          <CardContent className="flex min-w-0 flex-wrap gap-1.5 p-3 pt-0">
            {secondaryChips.map((chip, index) => (
              <Badge
                key={`${chip}-${index}`}
                variant="outline"
                className="h-5 max-w-full truncate px-1.5 text-[10px]"
                title={chip}
              >
                {chip}
              </Badge>
            ))}
          </CardContent>
        ) : null}
        {!isWhatsAppQr && !isLinkedEntry ? (
          <CardFooter className="px-3 py-0">
            {data.uiUsesSettingsPanel && data.uiOnOpenSettings ? (
              <ScenarioNodeSettingsButton
                nodeId={id}
                label={t("settings")}
                accessibleLabel={t("nodeSettingsOpenFor", {
                  label: triggerLabel,
                })}
                expanded={data.uiIsEditorExpanded}
                onOpen={data.uiOnOpenSettings}
                testId="scenario-trigger-node-settings"
              />
            ) : (
              <ScenarioNodeSettingsButton
                nodeId={id}
                label={t("triggerEditorTitle")}
                onOpen={() => data.uiOnSelect()}
                testId="scenario-trigger-node-settings"
              />
            )}
          </CardFooter>
        ) : null}
      </ScenarioNodeCard>
    </div>
  );
}
