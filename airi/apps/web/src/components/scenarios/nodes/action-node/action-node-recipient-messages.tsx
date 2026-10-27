"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchScenarioGeneratorRecipientMessages,
  patchScenarioGeneratorRecipientMessage,
  type ScenarioGeneratorRecipientMessage,
} from "@/lib/scenarios/client";
import { UsersRound } from "lucide-react";
import type {
  ScenarioActionSourceId,
  TranslateFn,
} from "@/components/scenarios/types";
import { buildActionSourceOptions } from "../../view/action/selector-utils";
import { ActionSourceIcon } from "./action-node-helpers";
import { showScenarioErrorToast } from "./action-node-utils";

const RECIPIENT_CHANNEL_IDS: ReadonlySet<string> = new Set([
  "whatsapp",
  "instagram",
  "telegram",
  "email",
  "web_widget",
]);

const RECIPIENT_TEXT_STATUS_KEYS: Record<string, string> = {
  sent: "recipientTextStatusSent",
  failed: "recipientTextStatusFailed",
};

function RecipientChannelIcon({
  channel,
  t,
}: {
  channel: string;
  t: TranslateFn;
}) {
  if (!RECIPIENT_CHANNEL_IDS.has(channel)) return null;
  const sourceId = channel as ScenarioActionSourceId;
  const label = buildActionSourceOptions({ selectedSourceId: sourceId, t })[0]
    ?.label;
  return (
    <span
      role="img"
      aria-label={label}
      className="inline-flex shrink-0 items-center"
    >
      <ActionSourceIcon sourceId={sourceId} />
    </span>
  );
}

export function ActionNodeRecipientMessages({
  activeScenarioId,
  branchId,
  recipientCount,
  workspaceId,
}: {
  activeScenarioId?: string | null;
  branchId?: string | null;
  recipientCount?: number | null;
  workspaceId: string;
}) {
  const t = useTranslations("Scenarios");
  const [recipientMessagesOpen, setRecipientMessagesOpen] = useState(false);
  const [recipientMessages, setRecipientMessages] = useState<
    ScenarioGeneratorRecipientMessage[]
  >([]);
  const [recipientMessagesTotal, setRecipientMessagesTotal] = useState(0);
  const [recipientMessagesLoading, setRecipientMessagesLoading] =
    useState(false);

  const loadRecipientMessages = useCallback(async () => {
    if (!activeScenarioId || !branchId) return;
    setRecipientMessagesOpen(true);
    setRecipientMessagesLoading(true);
    try {
      const page = await fetchScenarioGeneratorRecipientMessages({
        workspaceId,
        scenarioId: activeScenarioId,
        branchId,
        limit: 100,
      });
      setRecipientMessages(page.items);
      setRecipientMessagesTotal(page.total);
    } catch (error) {
      showScenarioErrorToast(t("recipientTextsLoadFailed"), error);
    } finally {
      setRecipientMessagesLoading(false);
    }
  }, [activeScenarioId, branchId, t, workspaceId]);

  const updateRecipientMessageText = useCallback(
    (messageId: string, text: string) => {
      setRecipientMessages(current =>
        current.map(item =>
          item.id === messageId
            ? {
                ...item,
                text,
              }
            : item
        )
      );
    },
    []
  );

  const saveRecipientMessageText = useCallback(
    async (message: ScenarioGeneratorRecipientMessage) => {
      if (!activeScenarioId) return;
      const text = message.text.trim();
      if (!text) return;
      try {
        await patchScenarioGeneratorRecipientMessage({
          workspaceId,
          scenarioId: activeScenarioId,
          messageId: message.id,
          text,
        });
      } catch (error) {
        showScenarioErrorToast(t("recipientTextSaveFailed"), error);
      }
    },
    [activeScenarioId, t, workspaceId]
  );

  if (!branchId) {
    return null;
  }

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
          <UsersRound aria-hidden />
          {t("columnSplitPathRecipientCount", { count: recipientCount ?? 0 })}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="nodrag nopan nokey h-6 px-2 text-[11px]"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            void loadRecipientMessages();
          }}
        >
          {t("recipientTextsOpen")}
        </Button>
      </div>
      <Dialog
        open={recipientMessagesOpen}
        onOpenChange={setRecipientMessagesOpen}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("recipientTextsTitle")}</DialogTitle>
            <DialogDescription>
              {t("recipientTextsDescription")}
            </DialogDescription>
          </DialogHeader>
          {recipientMessagesTotal > recipientMessages.length ? (
            <p className="text-xs text-muted-foreground">
              {t("recipientTextsShowing", {
                shown: recipientMessages.length,
                total: recipientMessagesTotal,
              })}
            </p>
          ) : null}
          <ScrollArea className="max-h-[60vh] pr-3">
            <div className="space-y-3" aria-busy={recipientMessagesLoading}>
              {recipientMessagesLoading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <Skeleton
                    key={index}
                    className="h-24 w-full"
                    data-testid="recipient-text-skeleton"
                  />
                ))
              ) : recipientMessages.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  {t("recipientTextsEmpty")}
                </p>
              ) : (
                recipientMessages.map(message => {
                  const name = message.recipientName || message.recipient;
                  const statusKey =
                    RECIPIENT_TEXT_STATUS_KEYS[message.sendStatus ?? ""] ??
                    "recipientTextStatusDraft";
                  return (
                    <div
                      key={message.id}
                      className="space-y-2 rounded-md border p-3"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                        <RecipientChannelIcon channel={message.channel} t={t} />
                        <span className="min-w-0 truncate font-medium">
                          {name}
                        </span>
                        <Badge
                          variant={
                            message.sendStatus === "failed"
                              ? "destructive"
                              : "secondary"
                          }
                          className="h-5 px-1.5 text-[10px]"
                        >
                          {t(statusKey)}
                        </Badge>
                      </div>
                      <Textarea
                        value={message.text}
                        rows={4}
                        aria-label={t("recipientTextFor", { name })}
                        onChange={event =>
                          updateRecipientMessageText(
                            message.id,
                            event.target.value
                          )
                        }
                        onBlur={() => void saveRecipientMessageText(message)}
                      />
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
