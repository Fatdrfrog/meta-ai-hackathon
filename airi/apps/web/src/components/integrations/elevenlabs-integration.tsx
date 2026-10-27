"use client";

import { upsertElevenLabsSource } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Source } from "@/types/supabase";
import { CheckCircle2, KeyRound, Loader2, Mic2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { readNonEmptyString } from "@icecore/shared/lib/value-utils";

interface ElevenLabsIntegrationProps {
  source?: Source;
  workspaceId: string;
  onSourceChanged?: () => Promise<unknown>;
  connectionActionsDisabled?: boolean;
}

export function ElevenLabsIntegration({
  source,
  workspaceId,
  onSourceChanged,
  connectionActionsDisabled = false,
}: ElevenLabsIntegrationProps) {
  const t = useTranslations("ElevenLabsIntegration");
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const connected = Boolean(source);
  const credentials = readCredentials(source);
  const keyLabel =
    readNonEmptyString(credentials?.key_label) ||
    maskCredential(credentials?.api_key);
  const defaultVoiceId =
    readNonEmptyString(credentials?.default_voice_id) ||
    readNonEmptyString(credentials?.defaultVoiceId);
  const connectedAt = readNonEmptyString(credentials?.connected_at);
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const connectedAtLabel = useMemo(() => {
    if (!connectedAt) return null;
    return new Date(connectedAt).toLocaleString();
  }, [connectedAt]);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      toast.error(t("toast.missingCredentials"));
      return;
    }

    setIsSaving(true);
    try {
      const result = await upsertElevenLabsSource(workspaceId, {
        api_key: apiKey.trim(),
        default_voice_id: voiceId.trim() || undefined,
      });

      if (result.error) {
        toast.error(result.error);
        return;
      }

      toast.success(t("toast.saved"));
      setApiKey("");
      setVoiceId("");
      await mutate(`/api/workspaces/${workspaceId}/integrations`);
      await onSourceChanged?.();
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("toast.failed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border bg-background p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
          {connected ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <Mic2 className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">
              {connected ? t("connectedTitle") : t("disconnectedTitle")}
            </h3>
            {connected ? (
              <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
                <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                {t("connectedBadge")}
              </Badge>
            ) : null}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {connected
              ? t("connectedDescription")
              : t("disconnectedDescription")}
          </p>
        </div>
      </div>

      {connected ? (
        <dl className="grid gap-3 rounded-xl bg-muted/30 p-3 text-sm sm:grid-cols-3">
          {keyLabel ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("keyLabel")}
              </dt>
              <dd className="font-mono text-foreground">{keyLabel}</dd>
            </div>
          ) : null}
          {defaultVoiceId ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("voiceLabel")}
              </dt>
              <dd className="truncate font-mono text-foreground">
                {defaultVoiceId}
              </dd>
            </div>
          ) : null}
          {connectedAtLabel ? (
            <div className="space-y-1">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("connectedAtLabel")}
              </dt>
              <dd className="text-foreground">{connectedAtLabel}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            {connected ? t("replaceTitle") : t("formTitle")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("formDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="elevenlabs-api-key">{t("apiKeyLabel")}</Label>
              <Input
                id="elevenlabs-api-key"
                type="password"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder={t("apiKeyPlaceholder")}
                disabled={isSaving || connectionActionsDisabled}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="elevenlabs-voice-id">{t("voiceIdLabel")}</Label>
              <Input
                id="elevenlabs-voice-id"
                value={voiceId}
                onChange={event => setVoiceId(event.target.value)}
                placeholder={t("voiceIdPlaceholder")}
                disabled={isSaving || connectionActionsDisabled}
                className="font-mono text-sm"
              />
            </div>
          </div>

          <Button
            type="button"
            onClick={handleSave}
            disabled={isSaving || connectionActionsDisabled}
          >
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            {connected ? t("replaceButton") : t("connectButton")}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

function readCredentials(source?: Source): Record<string, unknown> | null {
  if (!source?.credentials || typeof source.credentials !== "object") {
    return null;
  }

  return source.credentials as Record<string, unknown>;
}

function maskCredential(value: unknown): string | null {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  return `****${raw.slice(-4)}`;
}
