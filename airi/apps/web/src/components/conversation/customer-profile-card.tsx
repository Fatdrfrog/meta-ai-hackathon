"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatConversationDate } from "@/lib/date-utils";
import { cn } from "@/lib/utils";
import { BrainCircuit, GitMerge, Loader2, Split } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import type { ConversationInfoDetails } from "./conversation-info-view-model";

type Customer = NonNullable<ConversationInfoDetails["customer"]>;

type CustomerPayload = {
  customer: Customer;
  linkedConversations: Array<{
    _id: string;
    channel?: string | null;
    rename?: string | null;
    page_url?: string | null;
    lastMessageAt?: string | Date | null;
    createdAt?: string | Date | null;
  }>;
};

type CustomerTimelineItem = {
  id: string;
  kind: "message" | "event";
  occurredAt: string;
  channel?: string | null;
  direction?: string | null;
  text?: string | null;
  eventType?: string | null;
  payload?: Record<string, unknown>;
  author?: { name: string } | null;
};

type SuggestionsPayload = {
  suggestions: Array<{
    conversationId: string;
    displayName: string | null;
    channel: string | null;
    score: number;
    reasons: Array<{ code: string; label: string }>;
  }>;
};

type CardTranslator = ReturnType<typeof useTranslations>;

// Codes produced by scoreCustomerSuggestion (lib/customers/shared); other
// codes keep the server's English label.
const SUGGESTION_REASON_CODES = new Set([
  "exact_visitor",
  "same_channel_user",
  "same_channel_chat",
  "phone",
  "email",
  "username",
  "same_name_source",
  "same_name_recent",
]);

const TIMELINE_EVENT_TYPES = new Set([
  "stage_snapshot",
  "stage_changed",
  "owner_changed",
  "conversion_recorded",
  "conversation_linked",
  "conversation_unlinked",
  "behavioral_profile_updated",
]);

const PROFILE_STATUSES = new Set(["pending", "failed", "insufficient_data"]);

function fetcher<T>(url: string): Promise<T> {
  return fetch(url).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data as T;
  });
}

/** Relative time from the catalog for the last week, then the full date. */
function formatRelativeDate(
  value: string | Date | null | undefined,
  t: CardTranslator,
  locale: string
): string {
  if (!value) return t("customerCard.unknownTime");
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return t("customerCard.unknownTime");
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return t("customerCard.justNow");
  if (minutes < 60) return t("customerCard.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("customerCard.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("customerCard.daysAgo", { count: days });
  return formatConversationDate(date, locale);
}

function formatTimelineLabel(
  item: CustomerTimelineItem,
  t: CardTranslator
): string {
  if (item.kind === "message") {
    return item.direction === "inbound"
      ? t("customerCard.timelineEvents.customerMessage")
      : t("customerCard.timelineEvents.teamReply");
  }
  return item.eventType && TIMELINE_EVENT_TYPES.has(item.eventType)
    ? t(`customerCard.timelineEvents.${item.eventType}`)
    : t("customerCard.timelineEvents.other");
}

/**
 * Customer history behind the info panel's Customer tab: linked conversations,
 * timeline, link suggestions and the behavioral details the tab itself does
 * not show (name, contacts, summary and approach live in the tab).
 */
export function CustomerProfileCard({
  conversationId,
  initialCustomer,
  behavioralProfileEnabled,
}: {
  conversationId: string;
  initialCustomer: Customer;
  behavioralProfileEnabled: boolean;
}) {
  const t = useTranslations("ConversationDetailView");
  const locale = useLocale();
  const [customerId, setCustomerId] = useState(initialCustomer._id);
  const [isMutating, setIsMutating] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "overview" | "timeline" | "suggestions"
  >("overview");

  const customerSWR = useSWR<CustomerPayload>(
    `/api/customers/${customerId}`,
    fetcher
  );
  const timelineSWR = useSWR<{ timeline: CustomerTimelineItem[] }>(
    activeTab === "timeline"
      ? `/api/customers/${customerId}/timeline?limit=30`
      : null,
    fetcher
  );
  const suggestionsSWR = useSWR<SuggestionsPayload>(
    activeTab === "suggestions"
      ? `/api/customers/suggestions?conversationId=${conversationId}`
      : null,
    fetcher
  );

  const customer = customerSWR.data?.customer || initialCustomer;
  const linkedConversations = customerSWR.data?.linkedConversations || [];
  const timeline = timelineSWR.data?.timeline || [];
  const suggestions = suggestionsSWR.data?.suggestions || [];
  const channels = customer.profileSummary?.channels || [];

  const linkedConversationCount =
    customer.profileSummary?.conversationCount ||
    linkedConversations.length ||
    1;
  const visibleLinkedConversations = linkedConversations
    .filter(
      linkedConversation => String(linkedConversation._id) !== conversationId
    )
    .slice(0, 3);
  const hiddenLinkedConversationCount = Math.max(
    linkedConversationCount - 1 - visibleLinkedConversations.length,
    0
  );
  const topTimelineItems = timeline.slice(-6);

  const behavioralProfile = customer.behavioralProfile;
  const profileTraits = (
    [
      ["communicationStyle", behavioralProfile?.communicationStyle],
      ["decisionStyle", behavioralProfile?.decisionStyle],
      ["urgency", behavioralProfile?.urgency],
      ["responseCadence", behavioralProfile?.responseCadence],
    ] as const
  ).filter(([, value]) => Boolean(value));
  const profileLists = (
    [
      ["motivations", behavioralProfile?.motivations || []],
      ["trustSignals", behavioralProfile?.trustSignals || []],
    ] as const
  ).filter(([, values]) => values.length > 0);
  const profileStatus = behavioralProfile?.status;

  const refreshViews = async () => {
    const refreshTasks: Array<Promise<unknown>> = [customerSWR.mutate()];
    if (timelineSWR.data || activeTab === "timeline") {
      refreshTasks.push(timelineSWR.mutate());
    }
    if (suggestionsSWR.data || activeTab === "suggestions") {
      refreshTasks.push(suggestionsSWR.mutate());
    }
    await Promise.all(refreshTasks);
  };

  const submitCustomerAction = async (params: {
    url: string;
    body: Record<string, unknown>;
    successMessage: string;
    fallbackError: string;
  }) => {
    try {
      setIsMutating(true);
      const response = await fetch(params.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params.body),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || params.fallbackError);
      }
      const nextCustomerId =
        data.customer &&
        typeof data.customer === "object" &&
        "_id" in data.customer
          ? String((data.customer as { _id?: unknown })._id || "")
          : customerId;
      setCustomerId(nextCustomerId || customerId);
      await refreshViews();
      toast.success(params.successMessage);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : params.fallbackError
      );
    } finally {
      setIsMutating(false);
    }
  };

  const handleLink = async (targetConversationId: string) => {
    await submitCustomerAction({
      url: "/api/customers/link",
      body: {
        sourceConversationId: conversationId,
        targetConversationId,
        linkMethod: "suggested",
      },
      successMessage: t("customerCard.linkSuccess"),
      fallbackError: t("customerCard.linkFailed"),
    });
  };

  const handleUnlink = async () => {
    await submitCustomerAction({
      url: "/api/customers/unlink",
      body: { conversationId },
      successMessage: t("customerCard.unlinkSuccess"),
      fallbackError: t("customerCard.unlinkFailed"),
    });
  };

  return (
    <Card className="min-w-0 [overflow-wrap:anywhere] [&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:whitespace-normal [&_[data-slot=badge]]:text-left">
      <CardContent className="space-y-4">
        {channels.length > 0 || linkedConversationCount > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {channels.map(channel => (
                <Badge key={channel} variant="outline">
                  {channel}
                </Badge>
              ))}
            </div>
            {linkedConversationCount > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleUnlink}
                disabled={isMutating}
              >
                <Split className="h-3.5 w-3.5 mr-1.5" />
                {t("customerCard.unlink")}
              </Button>
            )}
          </div>
        ) : null}

        <div className="rounded-lg border p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("customerCard.lastInteraction")}
          </p>
          <p className="mt-1 text-sm font-medium">
            {formatRelativeDate(customer.lastInteractionAt, t, locale)}
          </p>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={value =>
            setActiveTab(value as "overview" | "timeline" | "suggestions")
          }
          className="space-y-4"
        >
          <TabsList className="!grid !w-full grid-cols-3 [&>button]:min-w-0 [&>button]:px-1 [&>button]:text-xs">
            <TabsTrigger value="overview">
              {t("customerCard.tabOverview")}
            </TabsTrigger>
            <TabsTrigger value="timeline">
              {t("customerCard.tabTimeline")}
            </TabsTrigger>
            <TabsTrigger value="suggestions">
              {t("customerCard.tabSuggestions")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("customerCard.linkedConversations")}
                </p>
                {customerSWR.isLoading && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
              </div>
              {visibleLinkedConversations.length > 0 ? (
                <div className="space-y-2">
                  {visibleLinkedConversations.map(linkedConversation => (
                    <div
                      key={linkedConversation._id}
                      className="rounded-lg border p-3 text-sm"
                    >
                      <p className="font-medium">
                        {linkedConversation.rename ||
                          linkedConversation.page_url ||
                          linkedConversation.channel ||
                          linkedConversation._id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {linkedConversation.channel ||
                          t("customerCard.unknownChannel")}{" "}
                        ·{" "}
                        {formatRelativeDate(
                          linkedConversation.lastMessageAt ||
                            linkedConversation.createdAt ||
                            null,
                          t,
                          locale
                        )}
                      </p>
                    </div>
                  ))}
                  {hiddenLinkedConversationCount > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("customerCard.moreLinkedConversations", {
                        count: hiddenLinkedConversationCount,
                      })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("customerCard.noLinkedConversations")}
                </p>
              )}
            </div>

            {behavioralProfileEnabled && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <BrainCircuit className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    {t("customerCard.behavioralProfile")}
                  </p>
                </div>
                {profileStatus === "ready" ? (
                  profileTraits.length > 0 || profileLists.length > 0 ? (
                    <div className="space-y-3 rounded-lg border p-3">
                      {profileTraits.length > 0 && (
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-sm">
                          {profileTraits.map(([key, value]) => (
                            <div key={key}>
                              <p className="text-xs text-muted-foreground">
                                {t(`customerCard.traits.${key}`)}
                              </p>
                              <p className="font-medium">{value}</p>
                            </div>
                          ))}
                        </div>
                      )}
                      {profileLists.map(([key, values]) => (
                        <div key={key}>
                          <p className="text-xs text-muted-foreground">
                            {t(`customerCard.traits.${key}`)}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-2">
                            {values.slice(0, 4).map(value => (
                              <Badge key={value} variant="outline">
                                {value}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null
                ) : (
                  <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground space-y-1">
                    <p className="font-medium text-foreground">
                      {t("customerCard.profileStatus", {
                        status: t(
                          `customerCard.profileStatuses.${
                            profileStatus && PROFILE_STATUSES.has(profileStatus)
                              ? profileStatus
                              : "unknown"
                          }`
                        ),
                      })}
                    </p>
                    {profileStatus === "failed" && behavioralProfile?.error && (
                      <p className="text-xs">{behavioralProfile.error}</p>
                    )}
                    {profileStatus === "insufficient_data" && (
                      <p className="text-xs">
                        {t("customerCard.profileInsufficientData")}
                      </p>
                    )}
                    {profileStatus === "pending" && (
                      <p className="text-xs">
                        {t("customerCard.profilePending")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="timeline" className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("customerCard.timelineTitle")}
            </p>
            {timelineSWR.isLoading ? (
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                {t("customerCard.timelineLoading")}
              </div>
            ) : topTimelineItems.length > 0 ? (
              topTimelineItems.map(item => (
                <div
                  key={item.id}
                  className={cn(
                    "rounded-lg border p-3 text-sm",
                    item.kind === "event" ? "bg-muted/20" : "bg-background"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">
                      {formatTimelineLabel(item, t)}
                    </p>
                    <p className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeDate(item.occurredAt, t, locale)}
                    </p>
                  </div>
                  {item.kind === "message" ? (
                    <div className="mt-1 space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {item.channel || t("customerCard.unknownChannel")} ·{" "}
                        {item.author?.name || t("customerCard.unknownAuthor")}
                      </p>
                      <p className="line-clamp-2 text-sm">
                        {item.text || t("customerCard.noMessageText")}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {Object.entries(item.payload || {})
                        .slice(0, 3)
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(" · ") || t("customerCard.noEventDetails")}
                    </p>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                {t("customerCard.timelineEmpty")}
              </div>
            )}
          </TabsContent>

          <TabsContent value="suggestions" className="space-y-2">
            <div className="flex items-center gap-2">
              <GitMerge className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">
                {t("customerCard.suggestionsTitle")}
              </p>
            </div>
            {suggestionsSWR.isLoading ? (
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                {t("customerCard.suggestionsLoading")}
              </div>
            ) : suggestions.length > 0 ? (
              <div className="space-y-2">
                {suggestions.slice(0, 5).map(suggestion => (
                  <div
                    key={suggestion.conversationId}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {suggestion.displayName ||
                            t("unnamedCustomer")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {suggestion.channel ||
                            t("customerCard.unknownChannel")}{" "}
                          ·{" "}
                          {t("customerCard.suggestionScore", {
                            score: suggestion.score,
                          })}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {suggestion.reasons.map(reason => (
                            <Badge key={reason.code} variant="outline">
                              {SUGGESTION_REASON_CODES.has(reason.code)
                                ? t(`customerCard.reasons.${reason.code}`)
                                : reason.label}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleLink(suggestion.conversationId)}
                        disabled={isMutating}
                      >
                        {isMutating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          t("customerCard.link")
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                {t("customerCard.suggestionsEmpty")}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
