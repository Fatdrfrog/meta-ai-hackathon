"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import type {
  WhatsAppConversionsSettings as Settings,
  WhatsAppConversionsSettingsAction,
} from "@/lib/conversions/source-config";

type Props = { workspaceId: string; sourceId: string; disabled?: boolean };
const fetchSettings = async (url: string): Promise<Settings> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("load_failed");
  return response.json();
};

export function WhatsAppConversionsSettings(props: Props) {
  return (
    <SourceSettings key={`${props.workspaceId}:${props.sourceId}`} {...props} />
  );
}

function SourceSettings({ workspaceId, sourceId, disabled = false }: Props) {
  const t = useTranslations("WhatsAppConversionsSettings");
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}/conversions`;
  const { data, error, isLoading, mutate } = useSWR<Settings>(
    disabled ? null : url,
    fetchSettings
  );
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const canChange = !disabled && Boolean(data) && !pending;

  const save = async (action: WhatsAppConversionsSettingsAction) => {
    if (!canChange) return;
    setPending(true);
    setActionError(null);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await response.json();
      if (!response.ok) {
        const messages: Record<string, string> = {
          meta_setup_failed: t("metaSetupFailed"),
          reconnect_required: t("reconnectRequired"),
          source_changed: t("sourceChanged"),
        };
        setActionError(messages[body.code] || t("saveFailed"));
        return;
      }
      const { webhookSecret, ...settings } = body;
      if (typeof webhookSecret === "string") {
        setSecret(webhookSecret);
        setCopied(null);
      } else if (
        action === "rotate_webhook_secret" ||
        action === "disable_webhook"
      ) {
        setSecret(null);
        setCopied(null);
      }
      // The one-time secret belongs only to this component, never the SWR cache.
      await mutate(settings, { revalidate: false });
    } catch {
      setActionError(t("saveFailed"));
    } finally {
      setPending(false);
    }
  };

  const copy = async (name: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(name);
    } catch {
      setActionError(t("copyFailed"));
    }
  };

  return (
    <section
      aria-label={t("title")}
      className="min-w-0 space-y-4"
      aria-busy={pending}
    >
      <div className="space-y-1">
        <h3 className="font-medium">{t("title")}</h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {!disabled && isLoading ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("loading")}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {t("loadFailed")}
            <Button size="sm" variant="outline" onClick={() => void mutate()}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription className="break-words">
            {actionError}
          </AlertDescription>
        </Alert>
      ) : null}
      {data || disabled ? (
        <>
          <Item variant="outline" className="min-w-0">
            <ItemContent className="min-w-0 gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <ItemTitle>{t("metaTitle")}</ItemTitle>
                <Badge variant="outline">
                  {t(data?.enabled ? "enabled" : "disabled")}
                </Badge>
              </div>
              <ItemDescription className="line-clamp-none">
                {t("metaDescription")}
              </ItemDescription>
              {data?.datasetId ? (
                <p className="break-all text-xs text-muted-foreground">
                  {t("dataset")}: {data.datasetId}
                </p>
              ) : null}
              <Button
                className="w-fit max-w-full whitespace-normal"
                variant="outline"
                disabled={!canChange}
                onClick={() =>
                  void save(data?.enabled ? "disable_meta" : "enable_meta")
                }
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {t(data?.enabled ? "disableMeta" : "enableMeta")}
              </Button>
            </ItemContent>
          </Item>
          <Item variant="outline" className="min-w-0">
            <ItemContent className="min-w-0 gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <ItemTitle>{t("webhookTitle")}</ItemTitle>
                <Badge variant="outline">
                  {t(data?.webhookEnabled ? "enabled" : "disabled")}
                </Badge>
              </div>
              <ItemDescription className="line-clamp-none">
                {t("webhookDescription")}
              </ItemDescription>
              {data?.webhookUrl ? (
                <div className="space-y-2">
                  <Label htmlFor={`webhook-url-${sourceId}`}>
                    {t("webhookUrl")}
                  </Label>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={`webhook-url-${sourceId}`}
                      className="min-w-0 font-mono text-xs"
                      value={data.webhookUrl}
                      readOnly
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copy("url", data.webhookUrl)}
                    >
                      {t(copied === "url" ? "copied" : "copy")}
                    </Button>
                  </div>
                </div>
              ) : null}
              {secret ? (
                <div className="space-y-2">
                  <Label htmlFor={`webhook-secret-${sourceId}`}>
                    {t("webhookSecret")}
                  </Label>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={`webhook-secret-${sourceId}`}
                      className="min-w-0 font-mono text-xs"
                      value={secret}
                      readOnly
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copy("secret", secret)}
                    >
                      {t(copied === "secret" ? "copied" : "copy")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("secretOnce")}
                  </p>
                </div>
              ) : null}
              {data?.hasWebhookSecret ? (
                <p className="text-xs text-muted-foreground">
                  {t("rotateWarning")}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  className="max-w-full whitespace-normal"
                  variant="outline"
                  disabled={!canChange}
                  onClick={() => void save("rotate_webhook_secret")}
                >
                  {t(data?.hasWebhookSecret ? "rotateSecret" : "createSecret")}
                </Button>
                {data?.webhookEnabled ? (
                  <Button
                    className="max-w-full whitespace-normal"
                    variant="outline"
                    disabled={!canChange}
                    onClick={() => void save("disable_webhook")}
                  >
                    {t("disableWebhook")}
                  </Button>
                ) : null}
              </div>
            </ItemContent>
          </Item>
        </>
      ) : null}
    </section>
  );
}
