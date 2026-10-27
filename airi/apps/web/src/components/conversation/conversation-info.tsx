"use client";

import { KeyMomentsNavigator } from "@/components/dashboard/key-moments-navigator";
import { QaScorecard } from "@/components/dashboard/qa-scorecard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getNameInitials } from "@/lib/conversation/display-name";
import { cn } from "@/lib/utils";
import type { PopulatedMessage } from "@/types/models";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Frown,
  Meh,
  Smile,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type React from "react";
import { CustomerProfileCard } from "./customer-profile-card";
import { ExtractedEntitiesSection } from "./extracted-entities";
import { InteractionMetricsSection } from "./interaction-metrics";
import {
  buildConversationInfoViewModel,
  toDate,
  type ConversationInfoDetails,
  type ConversationInfoViewModel,
} from "./conversation-info-view-model";
import { WebWidgetConversationView } from "./web-widget-conversation-view";

function formatDateTime(value: unknown, locale: string): string {
  const date = toDate(value);
  return date
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : "";
}

function DetailSection({
  title,
  children,
  collapsible = false,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
}) {
  if (collapsible) {
    return (
      <Collapsible className="min-w-0 border-t">
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center justify-between gap-3 rounded-sm text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {title}
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pb-3">
          {children}
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function KeyValueRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  if (value == null || value === "") return null;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-3 border-b py-2 text-xs last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  );
}

function PillList({ values }: { values: string[] }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {Array.from(new Set(values.filter(Boolean))).map(value => (
        <Badge
          key={value}
          variant="secondary"
          className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere]"
        >
          {value}
        </Badge>
      ))}
    </div>
  );
}

function InfoTile({
  label,
  value,
  max,
}: {
  label: string;
  value: number | null | undefined;
  max?: number;
}) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (max && value > max)
  )
    return null;
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">
        {value}
        <span className="text-xs font-normal text-muted-foreground">
          {max ? ` / ${max}` : ""}
        </span>
      </p>
      {max ? (
        <div
          role="meter"
          aria-label={label}
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${(value / max) * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function SourceLink({
  url,
  children,
}: {
  url?: string | null;
  children?: React.ReactNode;
}) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 break-all text-sm text-primary underline-offset-4 hover:underline"
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {children || url}
      </span>
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

type TimelineEvent = { label: string; at: unknown };
function TimelineEventList({
  events,
  locale,
  label,
}: {
  events: TimelineEvent[];
  locale: string;
  label: string;
}) {
  const datedEvents = events
    .flatMap(event => {
      const date = toDate(event.at);
      return date ? [{ ...event, date }] : [];
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (!datedEvents.length) return null;
  return (
    <ol aria-label={label} className="space-y-0">
      {datedEvents.map((event, index) => (
        <li
          key={`${event.label}-${event.date.toISOString()}`}
          className="grid min-w-0 grid-cols-[12px_minmax(0,1fr)] gap-3"
        >
          <div className="relative flex justify-center">
            <span className="z-10 mt-1.5 size-2 rounded-full bg-primary" />
            {index < datedEvents.length - 1 ? (
              <span className="absolute bottom-0 top-3 w-px bg-border" />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 pb-3 text-xs">
            <span className="[overflow-wrap:anywhere]">{event.label}</span>
            <time
              dateTime={event.date.toISOString()}
              className="text-muted-foreground"
            >
              {formatDateTime(event.date, locale)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function StatusBadges({
  summary,
}: {
  summary: ConversationInfoViewModel["summary"];
}) {
  const t = useTranslations("ConversationDetailView");
  const priority = summary.priority?.toLowerCase();
  const sentiment = summary.sentiment?.toLowerCase();
  const priorityKeys = {
    low: "priorityLow",
    medium: "priorityMedium",
    high: "priorityHigh",
    urgent: "priorityUrgent",
  } as const;
  const sentimentKeys = {
    positive: "sentimentPositive",
    negative: "sentimentNegative",
    neutral: "sentimentNeutral",
  } as const;
  const SentimentIcon =
    sentiment === "positive" ? Smile : sentiment === "negative" ? Frown : Meh;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {priority && priority in priorityKeys ? (
        <Badge
          variant={
            priority === "urgent" || priority === "high"
              ? "destructive"
              : "secondary"
          }
        >
          {t(priorityKeys[priority as keyof typeof priorityKeys])}
        </Badge>
      ) : null}
      {sentiment && sentiment in sentimentKeys ? (
        <Badge variant="outline" className="gap-1">
          <SentimentIcon className="size-3.5" aria-hidden />
          {t(sentimentKeys[sentiment as keyof typeof sentimentKeys])}
        </Badge>
      ) : null}
    </div>
  );
}

function SummaryTab({
  vm,
  actions,
  onMomentClick,
}: {
  vm: ConversationInfoViewModel;
  actions?: React.ReactNode;
  onMomentClick: (id: string) => void;
}) {
  const t = useTranslations("ConversationDetailView");
  const locale = useLocale();
  const customer = vm.customer.enabled ? vm.customer.customer : null;
  const memory = vm.summary.airiMemory;
  const name = vm.overview.displayName;
  const contact =
    customer?.profileSummary?.contactPoints?.phones?.[0] ||
    customer?.profileSummary?.contactPoints?.emails?.[0] ||
    vm.source.chat?.whatsapp?.waId;
  const channels: Record<string, string> = {
    whatsapp: t("channelWhatsapp"),
    telegram: t("channelTelegram"),
    instagram: t("channelInstagram"),
    email: t("channelEmail"),
    web_widget: t("channelWebWidget"),
  };
  const languages: Record<string, string> = {
    en: t("langEn"),
    ru: t("langRu"),
    kz: t("langKz"),
    kk: t("langKz"),
    uz: t("langUz"),
  };
  const waiting = {
    agent: t("info.waitingOnTeam"),
    customer: t("info.waitingOnCustomer"),
    closed: t("statusClosed"),
    unknown: null,
  };
  const summary = vm.summary.summaryText || memory?.summary;
  const selection = memory?.activeSelection;
  const tags = [...vm.ai.tags, ...vm.summary.internalLabels];
  return (
    <div className="space-y-5 [overflow-wrap:anywhere]">
      <div className="space-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-11 shrink-0">
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {getNameInitials(name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-snug">{name}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {[
                contact,
                channels[vm.overview.channel || ""],
                languages[vm.overview.language || ""],
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {waiting[vm.overview.waitingOn] ? (
            <Badge variant="secondary" className="gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  vm.overview.waitingOn === "agent"
                    ? "bg-amber-500"
                    : "bg-muted-foreground"
                )}
              />
              {waiting[vm.overview.waitingOn]}
            </Badge>
          ) : null}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Avatar className="size-5 shrink-0">
              <AvatarImage
                src={vm.overview.ownerAvatarUrl ?? undefined}
                alt=""
              />
              <AvatarFallback className="text-[10px]">
                {vm.overview.ownerName?.slice(0, 1) || "—"}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              {vm.overview.ownerName || t("unassigned")}
            </span>
          </div>
        </div>
      </div>

      {vm.summary.nextAction ? (
        <section
          className="rounded-lg border border-primary/20 bg-primary/5 p-3"
          aria-label={t("nextAction")}
        >
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
            <ArrowRight className="size-3.5" aria-hidden />
            {t("nextAction")}
          </h3>
          <p className="text-sm font-medium leading-relaxed">
            {vm.summary.nextAction}
          </p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t("info.aiSuggested")}
          </p>
        </section>
      ) : null}

      <DetailSection title={t("info.context")}>
        {summary ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("info.emptySummary")}
          </p>
        )}
        {vm.summary.classificationError ? (
          <p role="status" className="text-xs text-destructive">
            {t("info.analysisUnavailable")}
          </p>
        ) : null}
        <StatusBadges summary={vm.summary} />
      </DetailSection>

      {memory?.currentGoal ||
      memory?.unresolvedNeeds?.length ||
      selection?.label ? (
        <div className="space-y-3 border-l-2 border-primary/25 pl-3">
          {memory?.currentGoal ? (
            <DetailSection title={t("memoryGoalLabel")}>
              <p className="text-sm font-medium">{memory.currentGoal}</p>
            </DetailSection>
          ) : null}
          {selection?.label ? (
            <DetailSection title={t("memorySelectionLabel")}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{selection.label}</p>
                {selection.quotedPriceText ? (
                  <span className="text-xs text-muted-foreground">
                    {selection.quotedPriceText}
                  </span>
                ) : null}
              </div>
            </DetailSection>
          ) : null}
          {memory?.unresolvedNeeds?.length ? (
            <DetailSection title={t("memoryOpenNeedsLabel")}>
              <ul className="space-y-1.5">
                {Array.from(new Set(memory.unresolvedNeeds)).map(need => (
                  <li key={need} className="flex items-start gap-2 text-sm">
                    <span
                      className="mt-1.5 size-2 shrink-0 rounded-sm border border-muted-foreground/50"
                      aria-hidden
                    />
                    <span>{need}</span>
                  </li>
                ))}
              </ul>
            </DetailSection>
          ) : null}
        </div>
      ) : null}

      {actions ? (
        <div className="space-y-3 border-y py-3">{actions}</div>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        {vm.overview.totalMessages > 0 ? (
          <InfoTile
            label={t("totalMessages")}
            value={vm.overview.totalMessages}
          />
        ) : null}
        <InfoTile
          label={t("csatScoreLabel")}
          value={vm.source.csat.score}
          max={5}
        />
      </div>
      {vm.source.csat.comment ? (
        <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground">
          {vm.source.csat.comment}
        </blockquote>
      ) : null}
      {toDate(vm.overview.lastActivityAt) ? (
        <p className="text-xs text-muted-foreground">
          {t("lastActivity")} ·{" "}
          {formatDateTime(vm.overview.lastActivityAt, locale)}
        </p>
      ) : null}
      {tags.length ? <PillList values={tags} /> : null}
      {vm.ai.keyMoments.length ? (
        <DetailSection title={t("keyMomentsTitle")}>
          <KeyMomentsNavigator
            moments={vm.ai.keyMoments}
            onMomentClick={onMomentClick}
          />
        </DetailSection>
      ) : null}
    </div>
  );
}

function CustomerTab({
  vm,
  conversationId,
}: {
  vm: ConversationInfoViewModel;
  conversationId: string;
}) {
  const t = useTranslations("ConversationDetailView");
  const locale = useLocale();
  const customer = vm.customer.customer;
  if (!vm.customer.enabled || !customer)
    return (
      <p className="py-2 text-sm text-muted-foreground">
        {t(
          vm.customer.enabled ? "noCustomerProfile" : "customerIdentityDisabled"
        )}
      </p>
    );
  const profile = customer.profileSummary;
  const behavior = vm.customer.behavioralProfileEnabled
    ? customer.behavioralProfile
    : null;
  return (
    <div className="space-y-5 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">
          {customer.displayName || t("infoTabCustomer")}
        </h3>
        {customer.currentFunnelStage ? (
          <Badge variant="secondary">{customer.currentFunnelStage}</Badge>
        ) : null}
      </div>
      <PillList
        values={[
          ...(profile?.contactPoints?.phones || []),
          ...(profile?.contactPoints?.emails || []),
          ...(profile?.contactPoints?.usernames || []).map(name => `@${name}`),
        ]}
      />
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        {profile?.conversationCount ? (
          <span>
            {t("info.conversationCount", { count: profile.conversationCount })}
          </span>
        ) : null}
        {profile?.languages?.length ? (
          <span>· {profile.languages.join(", ")}</span>
        ) : null}
      </div>
      {behavior?.summary ? (
        <DetailSection title={t("info.customerContext")}>
          <p className="text-sm leading-relaxed">{behavior.summary}</p>
          <p className="text-[11px] text-muted-foreground">
            {t("info.aiSuggested")}
          </p>
        </DetailSection>
      ) : null}
      {behavior?.recommendedApproach?.length ? (
        <DetailSection title={t("recommendedApproachLabel")}>
          <ul className="space-y-2">
            {behavior.recommendedApproach.map(approach => (
              <li key={approach} className="flex gap-2 text-sm">
                <Check
                  className="mt-0.5 size-3.5 shrink-0 text-primary"
                  aria-hidden
                />
                <span>{approach}</span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
      {behavior?.objections?.length ? (
        <DetailSection title={t("info.objections")}>
          <PillList values={behavior.objections} />
        </DetailSection>
      ) : null}
      {profile?.tags?.length ? <PillList values={profile.tags} /> : null}
      <DetailSection title={t("info.customerHistory")} collapsible>
        <CustomerProfileCard
          conversationId={conversationId}
          initialCustomer={customer}
          behavioralProfileEnabled={vm.customer.behavioralProfileEnabled}
        />
      </DetailSection>
      <DetailSection title={t("info.technicalDetails")} collapsible>
        <KeyValueRow
          label={t("customerIdLabel")}
          value={vm.customer.link.customerId}
        />
        <KeyValueRow
          label={t("linkMethodLabel")}
          value={vm.customer.link.method}
        />
        <KeyValueRow
          label={t("linkedAtLabel")}
          value={formatDateTime(vm.customer.link.linkedAt, locale)}
        />
        <KeyValueRow
          label={t("linkedByLabel")}
          value={vm.customer.link.linkedBy}
        />
      </DetailSection>
    </div>
  );
}

function AiSignalsTab({ vm }: { vm: ConversationInfoViewModel }) {
  const t = useTranslations("ConversationDetailView");
  const tQa = useTranslations("QaScorecard");
  const locale = useLocale();
  const automation = vm.ai.automation;
  const engagement = vm.ai.engagementMetrics;
  const hasCounts =
    typeof engagement?.inboundCount === "number" &&
    typeof engagement?.outboundCount === "number" &&
    engagement.inboundCount >= 0 &&
    engagement.outboundCount >= 0 &&
    engagement.inboundCount + engagement.outboundCount > 0;
  const statusKeys = {
    active: "info.automationActive",
    pending: "info.automationPending",
    completed: "info.automationCompleted",
    idle: "info.automationIdle",
  } as const;
  const hasDiagnostics = Boolean(
    automation.currentActionNodeId ||
      automation.pendingConditionNodeId ||
      toDate(automation.lastMatchedAt) ||
      vm.ai.handoff.reason ||
      vm.ai.suppression.reason ||
      toDate(vm.ai.suppression.suppressedAt)
  );
  return (
    <div className="space-y-5 [overflow-wrap:anywhere]">
      {vm.ai.handoff.active ? (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm">
          {t("handoffBannerTitle")}
        </p>
      ) : null}
      <DetailSection title={t("automationLabel")}>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full",
              automation.status === "active"
                ? "bg-primary"
                : automation.status === "pending"
                  ? "bg-amber-500"
                  : "bg-muted-foreground"
            )}
          />
          <span className="text-sm font-medium">
            {t(statusKeys[automation.status])}
          </span>
        </div>
        {automation.scenarioName ? (
          <p className="text-sm">{automation.scenarioName}</p>
        ) : null}
        {toDate(automation.pendingStartedAt) ? (
          <p className="text-xs text-muted-foreground">
            {t("pendingStartedAtLabel")} ·{" "}
            {formatDateTime(automation.pendingStartedAt, locale)}
          </p>
        ) : null}
        {automation.startedCount ? (
          <div className="grid grid-cols-2 gap-4 pt-2">
            <InfoTile
              label={t("startedRunsLabel")}
              value={automation.startedCount}
            />
            <InfoTile
              label={t("completedRunsLabel")}
              value={automation.completedCount}
            />
          </div>
        ) : null}
      </DetailSection>
      {hasCounts && engagement ? (
        <DetailSection title={t("info.messageBalance")}>
          <div
            className="flex h-2 overflow-hidden rounded-full bg-muted"
            aria-hidden
          >
            <div
              className="bg-primary"
              style={{
                width: `${(engagement.inboundCount! / (engagement.inboundCount! + engagement.outboundCount!)) * 100}%`,
              }}
            />
            <div className="flex-1 bg-primary/25" />
          </div>
          <div className="flex justify-between gap-3 text-xs">
            <span>
              {t("info.customerMessages")} · {engagement.inboundCount}
            </span>
            <span className="text-muted-foreground">
              {t("info.teamMessages")} · {engagement.outboundCount}
            </span>
          </div>
        </DetailSection>
      ) : null}
      {vm.ai.agentPerformanceScorecard ? (
        <DetailSection title={tQa("title")} collapsible>
          <QaScorecard scorecard={vm.ai.agentPerformanceScorecard} />
        </DetailSection>
      ) : null}
      {vm.ai.interactionMetrics ? (
        <DetailSection title={t("interactionMetrics")} collapsible>
          <InteractionMetricsSection metrics={vm.ai.interactionMetrics} />
        </DetailSection>
      ) : null}
      {vm.ai.extractedEntities.length ? (
        <DetailSection title={t("extractedEntities")} collapsible>
          <ExtractedEntitiesSection entities={vm.ai.extractedEntities} />
        </DetailSection>
      ) : null}
      {hasDiagnostics ? (
        <DetailSection title={t("info.technicalDetails")} collapsible>
          <KeyValueRow
            label={t("currentActionNodeLabel")}
            value={automation.currentActionNodeId}
          />
          <KeyValueRow
            label={t("pendingConditionLabel")}
            value={automation.pendingConditionNodeId}
          />
          <KeyValueRow
            label={t("lastUpdateLabel")}
            value={formatDateTime(automation.lastMatchedAt, locale)}
          />
          <KeyValueRow
            label={t("handoffReasonLabel")}
            value={vm.ai.handoff.reason}
          />
          <KeyValueRow
            label={t("suppressionReasonLabel")}
            value={vm.ai.suppression.reason}
          />
          <KeyValueRow
            label={t("suppressedAtLabel")}
            value={formatDateTime(vm.ai.suppression.suppressedAt, locale)}
          />
        </DetailSection>
      ) : null}
    </div>
  );
}

function SourceTab({
  vm,
  conversationId,
}: {
  vm: ConversationInfoViewModel;
  conversationId: string;
}) {
  const t = useTranslations("ConversationDetailView");
  const locale = useLocale();
  const channel = vm.overview.channel;
  const referral = vm.source.whatsappReferral;
  const instagram = vm.source.instagramThread;
  const timelineTitle = t("journeyTimelineTitle");
  const events = [
    { label: t("startedAt"), at: vm.overview.createdAt },
    { label: t("firstInboundLabel"), at: vm.source.firstInboundAt },
    { label: t("lastInboundLabel"), at: vm.source.lastInboundAt },
    { label: t("lastOutboundLabel"), at: vm.source.lastOutboundAt },
    { label: t("lastBulkSentLabel"), at: vm.source.lastBulkSentAt },
    { label: t("capturedAtLabel"), at: referral?.capturedAt },
    { label: t("lastActivity"), at: vm.overview.lastActivityAt },
  ];
  const optIn = vm.source.whatsappOptIn;
  const hasDiagnostics = Boolean(
    vm.source.sourceId ||
      vm.source.businessConnectionId ||
      vm.source.chat?._id != null ||
      vm.source.chat?.type ||
      vm.source.participants?.from?.length ||
      vm.source.participants?.to?.length ||
      vm.source.visitorId ||
      vm.source.chat?.whatsapp?.waId ||
      vm.source.chat?.whatsapp?.previousWaIds?.length ||
      referral?.ctwaClid ||
      referral?.ref ||
      instagram?.threadId ||
      instagram?.comment?.id
  );
  const hasContext = Boolean(
    referral ||
      vm.source.subject ||
      vm.source.pageUrl ||
      vm.source.visitorId ||
      instagram?.provider === "instagram" ||
      channel === "whatsapp" ||
      events.some(event => toDate(event.at)) ||
      vm.source.followUpAudience?.currentFollowUpScenarioName ||
      vm.source.followUpAudience?.recommendedRootScenarioName
  );
  return (
    <div className="space-y-5 [overflow-wrap:anywhere]">
      {!hasContext ? (
        <p className="text-sm text-muted-foreground">
          {t("info.noSourceContext")}
        </p>
      ) : null}
      {referral ? (
        <DetailSection title={t("whatsappReferralTitle")}>
          <div className="space-y-2 rounded-lg bg-muted/50 p-3">
            {referral.headline ? (
              <p className="text-sm font-semibold">{referral.headline}</p>
            ) : null}
            {referral.body ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {referral.body}
              </p>
            ) : null}
            <KeyValueRow
              label={t("campaignLabel")}
              value={referral.campaignName || referral.campaignId}
            />
            <KeyValueRow
              label={t("adSetLabel")}
              value={referral.adSetName || referral.adSetId}
            />
            <SourceLink url={referral.sourceUrl}>
              {t("info.openSource")}
            </SourceLink>
          </div>
        </DetailSection>
      ) : null}
      {vm.source.subject ? (
        <p className="text-sm font-medium">{vm.source.subject}</p>
      ) : null}
      {vm.source.pageUrl || vm.source.visitorId ? (
        <DetailSection title={t("visitorInfoTitle")}>
          <SourceLink url={vm.source.pageUrl} />
          {channel === "web_widget" ? (
            <WebWidgetConversationView conversationId={conversationId} />
          ) : null}
        </DetailSection>
      ) : null}
      {instagram?.provider === "instagram" ? (
        <DetailSection title={t("instagramThreadTitle")}>
          <SourceLink url={instagram.permalink}>
            {t("info.openSource")}
          </SourceLink>
          <KeyValueRow
            label={t("mediaAuthorLabel")}
            value={instagram.media?.username}
          />
          <KeyValueRow
            label={t("likeCountLabel")}
            value={instagram.comment?.likeCount}
          />
        </DetailSection>
      ) : null}
      {channel === "whatsapp" ? (
        <DetailSection title={t("optInLabel")}>
          <Badge variant={optIn?.status === false ? "outline" : "secondary"}>
            {t(
              optIn?.status === true
                ? "info.optedIn"
                : optIn?.status === false
                  ? "info.optedOut"
                  : "info.consentUnknown"
            )}
          </Badge>
          {optIn?.source ? (
            <p className="text-xs text-muted-foreground">
              {optIn.source}
              {toDate(optIn.updatedAt)
                ? ` · ${formatDateTime(optIn.updatedAt, locale)}`
                : ""}
            </p>
          ) : null}
        </DetailSection>
      ) : null}
      {events.some(event => toDate(event.at)) ? (
        <DetailSection title={timelineTitle}>
          <TimelineEventList
            events={events}
            locale={locale}
            label={timelineTitle}
          />
        </DetailSection>
      ) : null}
      {vm.source.followUpAudience?.currentFollowUpScenarioName ||
      vm.source.followUpAudience?.recommendedRootScenarioName ? (
        <DetailSection title={t("followUpAudienceTitle")}>
          <KeyValueRow
            label={t("currentFollowUpLabel")}
            value={vm.source.followUpAudience.currentFollowUpScenarioName}
          />
          <KeyValueRow
            label={t("recommendedScenarioLabel")}
            value={vm.source.followUpAudience.recommendedRootScenarioName}
          />
        </DetailSection>
      ) : null}
      {hasDiagnostics ? (
        <DetailSection title={t("info.technicalDetails")} collapsible>
          <KeyValueRow label={t("sourceIdLabel")} value={vm.source.sourceId} />
          <KeyValueRow
            label={t("businessConnectionLabel")}
            value={vm.source.businessConnectionId}
          />
          <KeyValueRow
            label={t("chatIdLabel")}
            value={
              vm.source.chat?._id != null ? String(vm.source.chat._id) : null
            }
          />
          <KeyValueRow
            label={t("chatTypeLabel")}
            value={vm.source.chat?.type}
          />
          <KeyValueRow
            label={t("participantsFromLabel")}
            value={vm.source.participants?.from?.join(", ")}
          />
          <KeyValueRow
            label={t("participantsToLabel")}
            value={vm.source.participants?.to?.join(", ")}
          />
          <KeyValueRow
            label={t("visitorIdLabel")}
            value={vm.source.visitorId}
          />
          <KeyValueRow
            label={t("currentWaIdLabel")}
            value={vm.source.chat?.whatsapp?.waId}
          />
          <KeyValueRow
            label={t("previousWaIdsLabel")}
            value={vm.source.chat?.whatsapp?.previousWaIds?.join(", ")}
          />
          <KeyValueRow label={t("ctwaClidLabel")} value={referral?.ctwaClid} />
          <KeyValueRow label={t("ctwaRefLabel")} value={referral?.ref} />
          <KeyValueRow label={t("threadIdLabel")} value={instagram?.threadId} />
          <KeyValueRow
            label={t("commentIdLabel")}
            value={instagram?.comment?.id}
          />
        </DetailSection>
      ) : null}
    </div>
  );
}

export function ConversationInfo({
  details,
  conversationId,
  onMomentClick,
  messages,
  messageTotal,
  actions,
}: {
  details: ConversationInfoDetails;
  conversationId: string;
  onMomentClick: (id: string) => void;
  messages?: PopulatedMessage[];
  messageTotal?: number;
  actions?: React.ReactNode;
}) {
  const t = useTranslations("ConversationDetailView");
  const vm = buildConversationInfoViewModel({
    details,
    messages,
    messageTotal,
    unnamed: { customer: t("unnamedCustomer"), group: t("unnamedGroup") },
  });
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <Tabs defaultValue="summary" className="min-h-0 min-w-0 flex-1 gap-0">
        <div className="shrink-0 border-b bg-background px-3 py-2 sm:px-4">
          <TabsList className="!grid h-auto !w-full grid-cols-4 gap-0.5">
            {(
              [
                ["summary", "infoTabSummary"],
                ["customer", "infoTabCustomer"],
                ["ai", "infoTabAi"],
                ["source", "infoTabSource"],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-10 w-full min-w-0 !flex-none px-1 text-xs"
              >
                <span className="min-w-0 truncate">{t(label)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-x-hidden [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="min-w-0 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-5">
            <TabsContent value="summary" className="mt-0">
              <SummaryTab
                vm={vm}
                actions={actions}
                onMomentClick={onMomentClick}
              />
            </TabsContent>
            <TabsContent value="customer" className="mt-0">
              <CustomerTab vm={vm} conversationId={conversationId} />
            </TabsContent>
            <TabsContent value="ai" className="mt-0">
              <AiSignalsTab vm={vm} />
            </TabsContent>
            <TabsContent value="source" className="mt-0">
              <SourceTab vm={vm} conversationId={conversationId} />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  );
}
