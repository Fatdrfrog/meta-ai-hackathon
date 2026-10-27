"use client";

import { ErrorState, LoadingState } from "@/components/ui/async-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CUSTOMER_WEBHOOK_EVENTS,
  type CustomerWebhookEvent,
  type WebhookSummary,
} from "@/lib/customer-api/contracts";
import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  customerApiActionError,
  customerApiJson,
  useCustomerApiResource,
} from "./client-api";
import { ConfirmApiAction } from "./confirm-action";
import { SecretDialog } from "./secret-dialog";
import { WebhookDeliveries } from "./webhook-deliveries";

const eventLabel = (event: string) => event.replaceAll(".", "_");

export function WebhooksCard({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("CustomerApiSettings");
  const baseUrl = `/api/workspaces/${workspaceId}/webhooks`;
  const { data, error, isLoading, mutate } = useCustomerApiResource<{
    webhooks: WebhookSummary[];
    supportedEvents: CustomerWebhookEvent[];
  }>(baseUrl);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<CustomerWebhookEvent[]>([
    "message.received",
    "message.status_updated",
  ]);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ReturnType<
    typeof customerApiActionError
  > | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotate, setRotate] = useState<WebhookSummary | null>(null);
  const [deliveries, setDeliveries] = useState<string | null>(null);
  const busy = pending || isLoading || Boolean(error);

  function resetForm() {
    setEditing(null);
    setUrl("");
    setDescription("");
    setEvents(["message.received", "message.status_updated"]);
  }

  async function changeWebhook(id: string | null, body: unknown) {
    setPending(true);
    setActionError(null);
    try {
      const result = await customerApiJson<{
        webhook: WebhookSummary;
        secret?: string;
      }>(id ? `${baseUrl}/${id}` : baseUrl, id ? "PATCH" : "POST", body);
      await mutate(
        current => ({
          supportedEvents: current?.supportedEvents ?? [
            ...CUSTOMER_WEBHOOK_EVENTS,
          ],
          webhooks: id
            ? (current?.webhooks ?? []).map(item =>
                item.id === id ? result.webhook : item
              )
            : [result.webhook, ...(current?.webhooks ?? [])],
        }),
        { revalidate: false }
      );
      if (result.secret) setSecret(result.secret);
      return true;
    } catch (error) {
      setActionError(customerApiActionError(error));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      await changeWebhook(editing, {
        url: url.trim(),
        events,
        description: description.trim() || null,
      })
    )
      resetForm();
  }

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t(editing ? "editWebhook" : "addWebhook")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("webhooksDescription")}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-url">{t("webhookUrl")}</Label>
              <Input
                id="webhook-url"
                type="url"
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder="https://example.com/webhooks/airi"
                maxLength={2048}
                required
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">{t("urlHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="webhook-description">{t("webhookName")}</Label>
              <Input
                id="webhook-description"
                value={description}
                onChange={event => setDescription(event.target.value)}
                maxLength={200}
                disabled={busy}
              />
            </div>
            <fieldset disabled={busy}>
              <legend className="mb-2 text-sm font-medium">
                {t("events")}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {(data?.supportedEvents ?? CUSTOMER_WEBHOOK_EVENTS).map(
                  event => (
                    <div key={event} className="flex items-start gap-2">
                      <Checkbox
                        id={`event-${event}`}
                        checked={events.includes(event)}
                        onCheckedChange={checked =>
                          setEvents(current =>
                            checked === true
                              ? [...current, event]
                              : current.filter(item => item !== event)
                          )
                        }
                      />
                      <Label
                        htmlFor={`event-${event}`}
                        className="block min-w-0 leading-5"
                      >
                        {t(`eventsLabels.${eventLabel(event)}`)}
                        <span className="mt-0.5 block break-all font-mono text-[11px] font-normal text-muted-foreground">
                          {event}
                        </span>
                      </Label>
                    </div>
                  )
                )}
              </div>
            </fieldset>
            {actionError && <ErrorState message={t(actionError)} />}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={busy || !url.trim() || !events.length}
              >
                {pending ? t("saving") : t(editing ? "save" : "addWebhook")}
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={resetForm}
                >
                  {t("cancel")}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
      {isLoading ? (
        <div role="status" aria-label={t("loading")}>
          <LoadingState />
        </div>
      ) : error ? (
        <ErrorState
          message={t("loadError")}
          onRetry={() => void mutate()}
          retryLabel={t("retry")}
        />
      ) : !data?.webhooks.length ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("noWebhooks")}
        </p>
      ) : (
        <div className="space-y-2">
          {data.webhooks.map(item => (
            <Card key={item.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 break-all text-sm font-medium">
                    {item.description || item.url}
                  </p>
                  <Badge variant="outline">
                    {t(item.is_active ? "active" : "disabled")}
                  </Badge>
                </div>
                {item.description && (
                  <p className="break-all text-xs text-muted-foreground">
                    {item.url}
                  </p>
                )}
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {item.events.join(", ")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setEditing(item.id);
                      setUrl(item.url);
                      setEvents(item.events);
                      setDescription(item.description ?? "");
                    }}
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void changeWebhook(item.id, {
                        is_active: !item.is_active,
                      })
                    }
                  >
                    {t(item.is_active ? "disable" : "enable")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setRotate(item)}
                  >
                    {t("rotate")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeliveries(item.id)}
                  >
                    {t("deliveries")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {deliveries && (
        <WebhookDeliveries
          key={deliveries}
          url={`${baseUrl}/${deliveries}/deliveries?limit=20`}
          onClose={() => setDeliveries(null)}
        />
      )}
      <p className="text-xs text-muted-foreground">{t("deliveryHint")}</p>
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmApiAction
        open={Boolean(rotate)}
        title={t("rotateTitle")}
        description={t("rotateDescription")}
        onClose={() => setRotate(null)}
        onConfirm={() => {
          if (rotate) {
            void changeWebhook(rotate.id, { rotate_secret: true });
            setRotate(null);
          }
        }}
      />
    </div>
  );
}
