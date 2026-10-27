"use client";

import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/date-utils";
import type { WidgetConversationSummary } from "@icecore/shared/types/widget-config";
import { ArrowRight, Loader2, MessageCircle } from "lucide-react";
import useSWR from "swr";

interface WebWidgetConversationViewProps {
  conversationId: string;
}

type VisitorJourney = {
  conversations: WidgetConversationSummary[];
  visitorId: string | null;
};

async function fetchVisitorJourney(url: string): Promise<VisitorJourney> {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Failed to load visitor journey");
  }

  return {
    conversations: [...(data.conversations || [])].sort(
      (a: WidgetConversationSummary, b: WidgetConversationSummary) =>
        new Date(a.createdAt || 0).getTime() -
        new Date(b.createdAt || 0).getTime()
    ),
    visitorId: data.visitorId || null,
  };
}

function formatUrl(url: string) {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname || "/";
  } catch {
    return url;
  }
}

export function WebWidgetConversationView({
  conversationId,
}: WebWidgetConversationViewProps) {
  const { data, error, isLoading } = useSWR(
    `/api/conversations/${conversationId}/widget-urls`,
    fetchVisitorJourney,
    { revalidateOnFocus: false }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed py-4 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading visitor journey...
      </div>
    );
  }

  if (error) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        Visitor journey is temporarily unavailable.
      </p>
    );
  }

  const conversations = data?.conversations ?? [];
  if (conversations.length === 0) {
    return null;
  }

  const visitorId = data?.visitorId;
  const totalMessages = conversations.reduce(
    (sum, conv) => sum + conv.messageCount,
    0
  );

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <div className="min-w-0">
          <p className="font-medium">Visitor journey</p>
          <p className="text-xs text-muted-foreground">
            {conversations.length} pages - {totalMessages} messages
          </p>
        </div>
        {visitorId ? (
          <code className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs">
            {visitorId.slice(-8)}
          </code>
        ) : null}
      </div>

      <div className="space-y-3">
        {conversations.map((conv, index) => (
          <div key={conv.id} className="flex items-start gap-2 text-xs">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <div className="h-2 w-2 rounded-full bg-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">
                  {formatUrl(conv.pageUrl)}
                </span>
                {conv.id === conversationId ? (
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    Current
                  </Badge>
                ) : null}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                <MessageCircle className="h-3 w-3" />
                <span>{conv.messageCount} msgs</span>
                {conv.createdAt ? (
                  <span>{formatRelativeTime(conv.createdAt)}</span>
                ) : null}
                {index < conversations.length - 1 ? (
                  <ArrowRight className="h-3 w-3" />
                ) : null}
              </div>
              {conv.lastMessagePreview ? (
                <p className="mt-1 line-clamp-2 text-muted-foreground">
                  &quot;{conv.lastMessagePreview}&quot;
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
