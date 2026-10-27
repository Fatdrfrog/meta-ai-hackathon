"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatKeyMomentLabel,
  isUsefulLeadChurn,
  isUsefulLeadPriority,
  isUsefulLeadSentiment,
  isVisibleCrmFunnelStage,
  pickKeyMomentTypes,
  pickProductEntities,
  resolveNamedCrmStageKey,
} from "@/lib/crm/conversation-preview";
import { formatRelativeTime } from "@/lib/date-utils";
import { useTranslations } from "next-intl";
import {
  BrainCircuit,
  Calendar,
  ExternalLink,
  Eye,
  Mail,
  MessageSquare,
  Phone,
  User,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";

type LinkedConversation = {
  _id: string;
  channel?: string | null;
  rename?: string | null;
  page_url?: string | null;
  lastMessageAt?: string | Date | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  preferred_language?: string | null;
  sourceId?: string | null;
  visitor_id?: string | null;
  status?: string | null;
  message_count?: number | null;
  classification?: {
    category?: string | null;
    priority?: string | null;
    sentiment?: string | null;
    summary?: string | null;
    action?: string | null;
    tags?: string[] | null;
  } | null;
  internal_labels?: string[] | null;
  churn_risk_level?: string | null;
  estimated_customer_ltv?: number | null;
  history_summary?: string | null;
  last_inbound_at?: string | Date | null;
  last_outbound_at?: string | Date | null;
  key_moments?: Array<{ type?: string | null } | null> | null;
  extracted_entities?: Array<{
    type?: string | null;
    value?: string | null;
  } | null> | null;
  airi_context_memory?: {
    summary?: string | null;
    currentGoal?: string | null;
    unresolvedNeeds?: string[] | null;
  } | null;
};

type CustomerDetailFlags = {
  customer_behavioral_profile?: boolean;
  customer_timeline?: boolean;
};

type TimelineEntry = {
  id: string;
  kind: "message" | "event";
  occurredAt: string;
  conversationId?: string | null;
  channel?: string | null;
  direction?: string | null;
  text?: string | null;
  author?: { name?: string | null; isBot?: boolean } | null;
  eventType?: string | null;
  payload?: Record<string, unknown>;
};

type CustomerPayload = {
  customer: {
    _id: string;
    displayName?: string | null;
    status?: string;
    currentFunnelStage?: string | null;
    ownerUserId?: string | null;
    ownerLabel?: string | null;
    lastInteractionAt?: string | Date | null;
    profileSummary?: {
      channels?: string[];
      languages?: string[];
      tags?: string[];
      contactPoints?: {
        emails?: string[];
        phones?: string[];
        usernames?: string[];
        visitorIds?: string[];
        whatsappUserIds?: string[];
        whatsappParentUserIds?: string[];
      };
      lastSentiment?: string | null;
      churnRiskLevel?: string | null;
      estimatedCustomerLtv?: number | null;
      conversationCount?: number;
    } | null;
    behavioralProfile?: {
      status?: string;
      summary?: string | null;
      communicationStyle?: string | null;
      decisionStyle?: string | null;
      motivations?: string[];
      objections?: string[];
      trustSignals?: string[];
      urgency?: string | null;
      channelAffinity?: string[];
      responseCadence?: string | null;
      recommendedApproach?: string[];
      confidence?: number | null;
      error?: string | null;
    } | null;
  };
  linkedConversations: LinkedConversation[];
  linkedConversationsTotal?: number;
  flags?: CustomerDetailFlags;
  members?: Array<{ userId: string; label: string }>;
  viewerUserId?: string;
};

function fetcher<T>(url: string): Promise<T> {
  return fetch(url).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as T;
  });
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function OverviewCard({
  label,
  value,
  className,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border p-3 ${className || ""}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 p-1">
      <div className="flex items-center gap-4">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <Separator />
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-20 rounded-lg" />
      </div>
    </div>
  );
}

const NAMED_MOMENT_TYPES = new Set([
  "price_inquiry",
  "upsell_attempt",
  "positive_feedback",
  "objection",
  "negative_feedback",
  "product_inquiry",
  "feature_request",
  "purchase_intent",
]);

type LeadsCopy = {
  (key: string, values?: Record<string, string | number>): string;
};

function conversationTitle(conv: LinkedConversation, t: LeadsCopy): string {
  if (conv.rename?.trim()) return conv.rename.trim();
  const ch = conv.channel || t("unnamedChat");
  return `${ch} · ${String(conv._id).slice(-6)}`;
}

function namedStageLabel(t: LeadsCopy, value: string | null | undefined) {
  const named = resolveNamedCrmStageKey(value);
  return named ? t(`stages.${named}`) : value;
}

function momentLabel(t: LeadsCopy, type: string) {
  if (NAMED_MOMENT_TYPES.has(type)) {
    return t(`moments.${type}`);
  }
  return formatKeyMomentLabel(type);
}

function topicLabel(t: LeadsCopy, topic: string) {
  return topic.trim().toLowerCase() === "sales" ? t("sales") : topic;
}

function leadStatusLabel(t: LeadsCopy, status: string | undefined) {
  if (status === "archived") return t("statusArchived");
  if (status === "active") return t("statusActive");
  return status || t("statusActive");
}

function profileStatusLabel(t: LeadsCopy, status: string) {
  if (status === "ready") return t("sheet.statusReady");
  if (status === "failed") return t("sheet.statusFailed");
  if (status === "pending") return t("sheet.statusPending");
  if (status === "insufficient_data") return t("sheet.statusInsufficient");
  return status.replace(/_/g, " ");
}

function directionLabel(t: LeadsCopy, direction: string | null | undefined) {
  const key = direction?.trim().toLowerCase();
  if (key === "inbound") return t("sheet.directionInbound");
  if (key === "outbound") return t("sheet.directionOutbound");
  return t("sheet.directionMsg");
}

export function CustomerDetailSheet({
  workspaceId,
  customerId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  customerId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("LeadsPage");
  const detailUrl = customerId ? `/api/customers/${customerId}` : null;
  const { mutate: mutateCache } = useSWRConfig();
  const { data, isLoading, error, mutate } = useSWR<CustomerPayload>(
    open && detailUrl ? detailUrl : null,
    fetcher
  );
  const [ownerSaving, setOwnerSaving] = useState(false);
  // Radix returns focus to a Dialog trigger, and this sheet opens without one
  // (board cards, list rows), so closing dropped focus to <body>. Remember the
  // opener before the sheet takes focus and return focus to it.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, [open]);

  const flags = data?.flags;
  const timelineUrl =
    open &&
    customerId &&
    flags?.customer_timeline &&
    `/api/customers/${customerId}/timeline?limit=60`;

  const { data: timelineData, isLoading: timelineLoading } = useSWR<{
    timeline: TimelineEntry[];
  }>(timelineUrl || null, fetcher, { revalidateOnFocus: false });

  const customer = data?.customer;
  const profile = customer?.profileSummary;
  const contacts = profile?.contactPoints;
  const behavioral = customer?.behavioralProfile;
  const linked = data?.linkedConversations ?? [];
  const linkedTotal = data?.linkedConversationsTotal ?? linked.length ?? 0;

  const conversationRollup = useMemo(() => {
    const entities: NonNullable<LinkedConversation["extracted_entities"]> = [];
    const moments: NonNullable<LinkedConversation["key_moments"]> = [];
    const topics: string[] = [];
    const seenTopics = new Set<string>();
    for (const conversation of linked) {
      if (conversation.extracted_entities) {
        for (const entity of conversation.extracted_entities) {
          entities.push(entity);
        }
      }
      if (conversation.key_moments) {
        for (const moment of conversation.key_moments) {
          moments.push(moment);
        }
      }
      const topic = conversation.classification?.category?.trim();
      if (!topic) continue;
      const topicKey = topic.toLowerCase();
      if (
        topicKey === "support" ||
        topicKey === "spam" ||
        seenTopics.has(topicKey)
      ) {
        continue;
      }
      seenTopics.add(topicKey);
      topics.push(topic);
    }
    return {
      products: pickProductEntities(entities),
      momentTypes: pickKeyMomentTypes(moments),
      topics,
    };
  }, [linked]);

  const timelineItems = [...(timelineData?.timeline ?? [])].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt)
  );
  const recentTimeline = timelineItems.slice(-40);
  const members = data?.members ?? [];
  const viewerUserId = data?.viewerUserId ?? null;
  const ownerSelectValue = customer?.ownerUserId || "unassigned";
  const ownerOptions = members.some(
    member => member.userId === customer?.ownerUserId
  )
    ? members
    : customer?.ownerUserId
      ? [
          {
            userId: customer.ownerUserId,
            label: customer.ownerLabel || t("sheet.currentOwner"),
          },
          ...members,
        ]
      : members;

  const handleOwnerChange = async (value: string) => {
    if (!customerId || !workspaceId) return;
    const nextOwnerUserId = value === "unassigned" ? null : value;
    if ((customer?.ownerUserId || null) === nextOwnerUserId) return;
    setOwnerSaving(true);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(
          workspaceId
        )}/crm/customers/${encodeURIComponent(customerId)}/owner`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerUserId: nextOwnerUserId }),
        }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      await Promise.all([
        mutate(),
        mutateCache(
          (key: unknown) =>
            typeof key === "string" &&
            (key.includes("/crm/board") || key.includes("/api/customers"))
        ),
      ]);
    } catch (ownerError) {
      toast.error(
        ownerError instanceof Error
          ? ownerError.message
          : t("sheet.ownerUpdateFailed")
      );
    } finally {
      setOwnerSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full sm:max-w-lg p-0"
        aria-describedby={undefined}
        onCloseAutoFocus={event => {
          const opener = openerRef.current;
          if (!opener?.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <SheetHeader className="px-6 pt-6 pb-4">
          <SheetTitle>
            {customer?.displayName || t("sheet.titleFallback")}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 pb-6">
          {isLoading && !customer ? (
            <DetailSkeleton />
          ) : error ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : t("sheet.loadFailed")}
            </p>
          ) : !customer ? (
            <p className="text-sm text-muted-foreground">{t("sheet.noData")}</p>
          ) : (
            <div className="space-y-6 pb-8">
              <div className="flex items-center gap-4">
                <Avatar className="h-14 w-14">
                  <AvatarFallback className="text-lg font-semibold">
                    {getInitials(customer.displayName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold truncate">
                    {customer.displayName || t("unknown")}
                  </h2>
                  <div className="flex flex-wrap gap-2 mt-1">
                    <Badge
                      variant={
                        customer.status === "archived" ? "secondary" : "outline"
                      }
                      className="text-xs"
                    >
                      {leadStatusLabel(t, customer.status)}
                    </Badge>
                    {isVisibleCrmFunnelStage(customer.currentFunnelStage) && (
                      <Badge variant="secondary" className="text-xs">
                        {namedStageLabel(t, customer.currentFunnelStage)}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Select
                      value={ownerSelectValue}
                      onValueChange={value => {
                        void handleOwnerChange(value);
                      }}
                      disabled={ownerSaving}
                    >
                      <SelectTrigger
                        className="h-8 w-[200px]"
                        aria-label={t("sheet.ownerAria")}
                      >
                        <SelectValue placeholder={t("unassigned")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unassigned">
                          {t("unassigned")}
                        </SelectItem>
                        {ownerOptions.map(member => (
                          <SelectItem key={member.userId} value={member.userId}>
                            {member.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {viewerUserId && customer.ownerUserId !== viewerUserId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={ownerSaving}
                        onClick={() => {
                          void handleOwnerChange(viewerUserId);
                        }}
                      >
                        {t("sheet.assignToMe")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              {!!(
                contacts?.emails?.length ||
                contacts?.phones?.length ||
                contacts?.usernames?.length ||
                contacts?.whatsappUserIds?.length ||
                contacts?.visitorIds?.length
              ) && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      {t("sheet.contactPoints")}
                    </p>
                    <div className="space-y-2">
                      {contacts?.emails?.map(email => (
                        <div
                          key={email}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate">{email}</span>
                        </div>
                      ))}
                      {contacts?.phones?.map(phone => (
                        <div
                          key={phone}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span>{phone}</span>
                        </div>
                      ))}
                      {contacts?.usernames?.map(username => (
                        <div
                          key={username}
                          className="flex items-center gap-2 text-sm"
                        >
                          <User className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span>@{username}</span>
                        </div>
                      ))}
                      {contacts?.whatsappUserIds?.map(waId => (
                        <div
                          key={waId}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Image
                            src="/whatsapp.svg"
                            alt=""
                            width={16}
                            height={16}
                            className="h-4 w-4 shrink-0 object-contain"
                          />
                          <span className="truncate">{waId}</span>
                        </div>
                      ))}
                      {contacts?.visitorIds?.map(vid => (
                        <div
                          key={vid}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Eye className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="truncate font-mono text-xs">
                            {vid}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <Separator />
              <div className="space-y-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                  {t("sheet.overview")}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <OverviewCard
                    label={t("sheet.lastInteraction")}
                    value={
                      customer.lastInteractionAt
                        ? formatRelativeTime(customer.lastInteractionAt)
                        : t("unknown")
                    }
                  />
                  {profile?.languages?.length ? (
                    <OverviewCard
                      label={t("sheet.languages")}
                      value={profile.languages.join(", ")}
                    />
                  ) : null}
                  {profile?.channels?.length ? (
                    <OverviewCard
                      label={t("sheet.channels")}
                      value={
                        <div className="flex flex-wrap gap-1">
                          {profile.channels.map(ch => (
                            <Badge
                              key={ch}
                              variant="outline"
                              className="text-xs"
                            >
                              {ch}
                            </Badge>
                          ))}
                        </div>
                      }
                    />
                  ) : null}
                  <OverviewCard
                    label={t("sheet.conversations")}
                    value={profile?.conversationCount ?? linkedTotal}
                  />
                  {isUsefulLeadSentiment(profile?.lastSentiment) ? (
                    <OverviewCard
                      label={t("sheet.sentiment")}
                      value={
                        <span>
                          {t(
                            `sentiment.${profile?.lastSentiment?.toLowerCase()}` as never
                          )}
                        </span>
                      }
                    />
                  ) : null}
                  {isUsefulLeadChurn(profile?.churnRiskLevel) ? (
                    <OverviewCard
                      label={t("sheet.churnRisk")}
                      value={
                        <Badge
                          variant={
                            profile?.churnRiskLevel?.toLowerCase() === "high"
                              ? "destructive"
                              : "secondary"
                          }
                          className="text-xs"
                        >
                          {t(
                            `churn.${profile?.churnRiskLevel?.toLowerCase()}` as never
                          )}
                        </Badge>
                      }
                    />
                  ) : null}
                  {profile?.estimatedCustomerLtv != null && (
                    <OverviewCard
                      label={t("sheet.estimatedLtv")}
                      value={formatCurrency(profile.estimatedCustomerLtv)}
                      className="col-span-2"
                    />
                  )}
                </div>
              </div>

              {(conversationRollup.products.length > 0 ||
                conversationRollup.momentTypes.length > 0 ||
                conversationRollup.topics.length > 0) && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      {t("sheet.fromConversations")}
                    </p>
                    {conversationRollup.products.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">
                          {t("sheet.products")}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {conversationRollup.products.map(entity => (
                            <Badge
                              key={`${entity.type}:${entity.value}`}
                              variant="secondary"
                              className="text-xs"
                            >
                              {entity.value}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {conversationRollup.momentTypes.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">
                          {t("sheet.keyMoments")}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {conversationRollup.momentTypes.map(type => (
                            <Badge
                              key={type}
                              variant="outline"
                              className="text-xs"
                            >
                              {momentLabel(t, type)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {conversationRollup.topics.length > 0 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1.5">
                          {t("sheet.topic")}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {conversationRollup.topics.map(topic => (
                            <Badge
                              key={topic}
                              variant="outline"
                              className="text-xs"
                            >
                              {topicLabel(t, topic)}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {profile?.tags && profile.tags.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                      {t("sheet.tagsProfile")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {profile.tags.map(tag => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="text-xs"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {linked.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
                        {t("sheet.linkedConversations")}
                      </p>
                      {linkedTotal > linked.length && (
                        <span className="text-xs text-muted-foreground">
                          {t("sheet.showingOf", {
                            shown: linked.length,
                            total: linkedTotal,
                          })}
                        </span>
                      )}
                    </div>
                    <div className="space-y-3">
                      {linked.map(conv => {
                        const href = `/panel/w/${workspaceId}/requests?conversation=${conv._id}`;
                        const cls = conv.classification;
                        const pageUrl = conv.page_url?.trim();
                        const products = pickProductEntities(
                          conv.extracted_entities || []
                        );
                        const momentTypes = pickKeyMomentTypes(
                          conv.key_moments
                        );
                        const topic = cls?.category?.trim() || "";
                        const topicKey = topic.toLowerCase();
                        const showTopic =
                          Boolean(topic) &&
                          topicKey !== "support" &&
                          topicKey !== "spam";
                        return (
                          <div
                            key={conv._id}
                            className="rounded-lg border p-3 space-y-2"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <Link
                                  href={href}
                                  className="text-sm font-medium hover:underline"
                                >
                                  {conversationTitle(conv, t)}
                                </Link>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {conv.channel || "—"}
                                  {conv.message_count != null
                                    ? ` · ${t("sheet.messageCount", { count: conv.message_count })}`
                                    : ""}
                                  {conv.lastMessageAt
                                    ? ` · ${formatRelativeTime(conv.lastMessageAt)}`
                                    : ""}
                                </p>
                              </div>
                              {conv.status && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] shrink-0 capitalize"
                                >
                                  {conv.status}
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {showTopic ? (
                                <Badge
                                  variant="secondary"
                                  className="text-[10px]"
                                >
                                  {topicLabel(t, topic)}
                                </Badge>
                              ) : null}
                              {isUsefulLeadSentiment(cls?.sentiment) ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {t(
                                    `sentiment.${cls?.sentiment?.toLowerCase()}` as never
                                  )}
                                </Badge>
                              ) : null}
                              {isUsefulLeadPriority(cls?.priority) ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {t(
                                    `priority.${cls?.priority?.toLowerCase()}` as never
                                  )}
                                </Badge>
                              ) : null}
                              {isUsefulLeadChurn(conv.churn_risk_level) ? (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {t("churnWithLevel", {
                                    level: t(
                                      `churn.${conv.churn_risk_level?.toLowerCase()}` as never
                                    ),
                                  })}
                                </Badge>
                              ) : null}
                              {momentTypes.map(type => (
                                <Badge
                                  key={type}
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  {momentLabel(t, type)}
                                </Badge>
                              ))}
                            </div>
                            {products.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {products.map(entity => (
                                  <Badge
                                    key={`${entity.type}:${entity.value}`}
                                    variant="secondary"
                                    className="text-[10px]"
                                  >
                                    {entity.value}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                            {cls?.summary ? (
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                {truncate(cls.summary, 220)}
                              </p>
                            ) : null}
                            {cls?.action ? (
                              <p className="text-xs">
                                <span className="text-muted-foreground">
                                  {t("sheet.suggestedAction")}{" "}
                                </span>
                                {truncate(cls.action, 160)}
                              </p>
                            ) : null}
                            {conv.estimated_customer_ltv != null && (
                              <p className="text-xs text-muted-foreground">
                                {t("sheet.estLtv", {
                                  value: formatCurrency(
                                    conv.estimated_customer_ltv
                                  ),
                                })}
                              </p>
                            )}
                            {conv.history_summary?.trim() && (
                              <p className="text-xs text-muted-foreground leading-relaxed border-t pt-2">
                                <span className="font-medium text-foreground">
                                  {t("sheet.history")}{" "}
                                </span>
                                {truncate(conv.history_summary, 200)}
                              </p>
                            )}
                            {(conv.airi_context_memory?.summary ||
                              conv.airi_context_memory?.currentGoal ||
                              (conv.airi_context_memory?.unresolvedNeeds &&
                                conv.airi_context_memory.unresolvedNeeds
                                  .length > 0)) && (
                              <div className="text-xs border-t pt-2 space-y-1 text-muted-foreground">
                                <span className="font-medium text-foreground">
                                  {t("sheet.airiContext")}
                                </span>
                                {conv.airi_context_memory?.summary && (
                                  <p>
                                    {truncate(
                                      conv.airi_context_memory.summary,
                                      180
                                    )}
                                  </p>
                                )}
                                {conv.airi_context_memory?.currentGoal && (
                                  <p>
                                    {t("sheet.goal", {
                                      value: truncate(
                                        conv.airi_context_memory.currentGoal,
                                        120
                                      ),
                                    })}
                                  </p>
                                )}
                                {conv.airi_context_memory?.unresolvedNeeds &&
                                  conv.airi_context_memory.unresolvedNeeds
                                    .length > 0 && (
                                    <p>
                                      {t("sheet.openNeeds", {
                                        value:
                                          conv.airi_context_memory.unresolvedNeeds
                                            .slice(0, 4)
                                            .join(", "),
                                      })}
                                    </p>
                                  )}
                              </div>
                            )}
                            {pageUrl &&
                              (pageUrl.startsWith("http://") ||
                              pageUrl.startsWith("https://") ? (
                                <a
                                  href={pageUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  {t("sheet.page")}
                                </a>
                              ) : (
                                <span className="text-xs text-muted-foreground truncate block">
                                  {t("sheet.pageLabel", {
                                    url: truncate(pageUrl, 80),
                                  })}
                                </span>
                              ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {flags?.customer_timeline && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm font-medium">
                        {t("sheet.recentActivity")}
                      </p>
                    </div>
                    {timelineLoading ? (
                      <Skeleton className="h-24 w-full rounded-lg" />
                    ) : recentTimeline.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("sheet.noTimeline")}
                      </p>
                    ) : (
                      <ul className="space-y-2 border rounded-lg p-2 max-h-64 overflow-y-auto">
                        {recentTimeline.map(item => (
                          <li
                            key={item.id}
                            className="text-xs border-b border-border/60 pb-2 last:border-0 last:pb-0"
                          >
                            <div className="flex justify-between gap-2 text-muted-foreground">
                              <span>{formatRelativeTime(item.occurredAt)}</span>
                              {item.channel && (
                                <span className="truncate">{item.channel}</span>
                              )}
                            </div>
                            {item.kind === "message" ? (
                              <div className="mt-1 flex gap-1.5">
                                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                                <div>
                                  <span className="text-muted-foreground">
                                    {directionLabel(t, item.direction)}
                                    {item.author?.name
                                      ? ` · ${item.author.name}`
                                      : ""}
                                  </span>
                                  {item.text && (
                                    <p className="text-foreground mt-0.5">
                                      {truncate(item.text, 140)}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <p className="mt-1 font-medium capitalize">
                                {item.eventType?.replace(/_/g, " ") ||
                                  t("sheet.event")}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}

              {flags?.customer_behavioral_profile && behavioral && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <BrainCircuit className="h-4 w-4 text-muted-foreground" />
                      <p className="text-sm font-medium">
                        {t("sheet.behavioralProfile")}
                      </p>
                      {behavioral.status && (
                        <Badge variant="outline" className="text-xs">
                          {profileStatusLabel(t, behavioral.status)}
                        </Badge>
                      )}
                    </div>

                    {behavioral.status === "ready" ? (
                      <div className="rounded-lg border p-4 space-y-4">
                        {behavioral.summary && (
                          <p className="text-sm leading-relaxed">
                            {behavioral.summary}
                          </p>
                        )}
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          {behavioral.communicationStyle && (
                            <div>
                              <p className="text-xs text-muted-foreground">
                                {t("sheet.communication")}
                              </p>
                              <p className="font-medium">
                                {behavioral.communicationStyle}
                              </p>
                            </div>
                          )}
                          {behavioral.decisionStyle && (
                            <div>
                              <p className="text-xs text-muted-foreground">
                                {t("sheet.decisionStyle")}
                              </p>
                              <p className="font-medium">
                                {behavioral.decisionStyle}
                              </p>
                            </div>
                          )}
                          {behavioral.urgency && (
                            <div>
                              <p className="text-xs text-muted-foreground">
                                {t("sheet.urgency")}
                              </p>
                              <p className="font-medium">
                                {behavioral.urgency}
                              </p>
                            </div>
                          )}
                          {behavioral.responseCadence && (
                            <div>
                              <p className="text-xs text-muted-foreground">
                                {t("sheet.responseCadence")}
                              </p>
                              <p className="font-medium">
                                {behavioral.responseCadence}
                              </p>
                            </div>
                          )}
                        </div>

                        {[
                          [t("sheet.motivations"), behavioral.motivations || []],
                          [t("sheet.objections"), behavioral.objections || []],
                          [
                            t("sheet.trustSignals"),
                            behavioral.trustSignals || [],
                          ],
                          [
                            t("sheet.recommendedApproach"),
                            behavioral.recommendedApproach || [],
                          ],
                        ].map(([label, values]) =>
                          Array.isArray(values) && values.length > 0 ? (
                            <div key={String(label)}>
                              <p className="text-xs text-muted-foreground mb-1">
                                {label as string}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                {(values as string[])
                                  .slice(0, 5)
                                  .map((v: string) => (
                                    <Badge key={v} variant="outline">
                                      {v}
                                    </Badge>
                                  ))}
                              </div>
                            </div>
                          ) : null
                        )}

                        {behavioral.confidence != null && (
                          <p className="text-xs text-muted-foreground">
                            {t("sheet.confidence", {
                              value: Math.round(behavioral.confidence * 100),
                            })}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed p-4 space-y-2 text-sm text-muted-foreground">
                        {behavioral.status === "failed" && (
                          <p>
                            {behavioral.error || t("sheet.profileFailed")}
                          </p>
                        )}
                        {behavioral.status === "insufficient_data" && (
                          <p>
                            {t("sheet.profileInsufficient")}
                          </p>
                        )}
                        {behavioral.status === "pending" && (
                          <p>
                            {t("sheet.profilePending")}
                          </p>
                        )}
                        {behavioral.summary && (
                          <p className="text-foreground leading-relaxed">
                            {behavioral.summary}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
