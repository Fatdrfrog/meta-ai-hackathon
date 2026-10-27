"use client";
import { useState } from "react";
import useSWR from "swr";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchCustomerBehavior,
  saveCustomerBehaviorEvent,
} from "@/lib/scenarios/client/customer-behavior";

export const CONVERSATION_BEHAVIOR_EVENT_TYPES = [
  "checkout_started",
  "checkout_closed",
  "renewal_scheduled",
  "renewal_completed",
  "service_scheduled",
  "service_completed",
] as const;

export type ConversationBehaviorEventType =
  (typeof CONVERSATION_BEHAVIOR_EVENT_TYPES)[number];

export function ConversationBehaviorEvents({
  eventType,
  onOpenChange,
  ...props
}: {
  workspaceId: string;
  conversationId: string;
  eventType: ConversationBehaviorEventType | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("CustomerBehavior");
  return (
    <Dialog open={eventType !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("recordEvent")}</DialogTitle>
          <DialogDescription>{t("eventHint")}</DialogDescription>
        </DialogHeader>
        {eventType && (
          <EventForm
            key={`${props.workspaceId}:${props.conversationId}:${eventType}`}
            initialEventType={eventType}
            {...props}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
function EventForm({
  workspaceId,
  conversationId,
  initialEventType,
}: {
  workspaceId: string;
  conversationId: string;
  initialEventType: ConversationBehaviorEventType;
}) {
  const t = useTranslations("CustomerBehavior");
  const locale = useLocale();
  const { data, error, mutate } = useSWR(
    ["behavior-events", workspaceId, conversationId],
    () => fetchCustomerBehavior(workspaceId, conversationId),
    { errorRetryCount: 1, refreshInterval: 30_000 }
  );
  const [eventType, setEventType] = useState<string>(initialEventType);
  const [referenceId, setReferenceId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [identity, setIdentity] = useState<{
    eventId: string;
    occurredAt: string;
  } | null>(null);
  const needsDueAt = eventType.endsWith("_scheduled");
  const changed = () => {
    setIdentity(null);
    setSaved(false);
  };
  const validDate = !needsDueAt || Number.isFinite(new Date(dueAt).getTime());
  return (
    <form
      className="space-y-3"
      onSubmit={async e => {
        e.preventDefault();
        if (busy || !referenceId.trim() || !validDate) return;
        const attempt = identity || {
          eventId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
        };
        setIdentity(attempt);
        setBusy(true);
        setFailed(false);
        setSaved(false);
        try {
          await saveCustomerBehaviorEvent(workspaceId, {
            ...attempt,
            eventType,
            conversationId,
            referenceId: referenceId.trim(),
            ...(needsDueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
          });
          setSaved(true);
          await mutate();
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Select
        disabled={busy}
        value={eventType}
        onValueChange={v => {
          setEventType(v);
          changed();
        }}
      >
        <SelectTrigger aria-label={t("eventType")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONVERSATION_BEHAVIOR_EVENT_TYPES.map(type => (
            <SelectItem key={type} value={type}>
              {t(`events.${type}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="block text-sm">
        {t("reference")}
        <Input
          aria-label={t("reference")}
          required
          maxLength={200}
          disabled={busy}
          value={referenceId}
          onChange={e => {
            setReferenceId(e.target.value);
            changed();
          }}
        />
      </label>
      {needsDueAt && (
        <label className="block text-sm">
          {t("dueDate")}
          <Input
            aria-label={t("dueDate")}
            type="datetime-local"
            required
            disabled={busy}
            value={dueAt}
            onChange={e => {
              setDueAt(e.target.value);
              changed();
            }}
          />
        </label>
      )}
      <Button
        type="submit"
        disabled={busy || saved || !referenceId.trim() || !validDate}
      >
        {busy ? t("saving") : t("saveEvent")}
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("error")}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm">
          {t("eventSaved")}
        </p>
      )}
      <div className="border-t pt-3">
        <h3 className="text-sm font-medium">{t("recentJourneys")}</h3>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("error")}{" "}
            <Button type="button" variant="ghost" onClick={() => void mutate()}>
              {t("retry")}
            </Button>
          </p>
        ) : !data ? (
          <p role="status" className="text-sm">
            {t("loading")}
          </p>
        ) : !data.runs.length ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {data.runs.map(run => (
              <li
                key={run._id}
                className="break-words rounded-md border p-2 text-xs"
              >
                <p className="font-medium">
                  {t(`presets.${run.config.preset}`)}
                </p>
                <p>
                  {t(`status.${run.status}`)} ·{" "}
                  {new Date(run.dueAt).toLocaleString(locale)}
                </p>
                {run.reason && (
                  <p>
                    {t(
                      `reasons.${t.has(`reasons.${run.reason}`) ? run.reason : "unavailable"}`
                    )}
                  </p>
                )}
                <p className="text-muted-foreground">{run.referenceId}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </form>
  );
}
