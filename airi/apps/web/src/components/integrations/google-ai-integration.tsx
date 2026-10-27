"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WorkspaceTextAiAllowance } from "@/components/ai/workspace-text-ai-allowance";
import { useCompanyLimits } from "@/hooks/use-company-limits";
import type { Source } from "@/types/supabase";
import {
  asNullableRecord,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Unplug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { useSWRConfig } from "swr";

interface GoogleAIIntegrationProps {
  source?: Source;
  workspaceId: string;
  onSourceChanged?: () => Promise<unknown>;
  connectionActionsDisabled?: boolean;
}

const ERROR_KEYS: Record<string, string> = {
  INVALID_API_KEY: "errors.invalidKey",
  GOOGLE_AI_ACCESS_DENIED: "errors.accessDenied",
  GOOGLE_AI_RATE_LIMITED: "errors.rateLimited",
  GOOGLE_AI_UNAVAILABLE: "errors.unavailable",
  GOOGLE_AI_INVALID_RESPONSE: "errors.unavailable",
  UNAUTHORIZED: "errors.unauthorized",
  FORBIDDEN: "errors.forbidden",
  SOURCE_SAVE_FAILED: "errors.saveFailed",
  SOURCE_SAVE_CONFLICT: "errors.connectionChanged",
  SOURCE_DELETE_FAILED: "errors.deleteFailed",
  ENCRYPTION_UNAVAILABLE: "errors.saveFailed",
};

export function GoogleAIIntegration({
  source,
  workspaceId,
  onSourceChanged,
  connectionActionsDisabled = false,
}: GoogleAIIntegrationProps) {
  const t = useTranslations("GoogleAIIntegration");
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const {
    data: limits,
    error: limitsError,
    isLoading: limitsLoading,
  } = useCompanyLimits(connectionActionsDisabled ? null : workspaceId);
  const credentials = asNullableRecord(source?.credentials);
  const connected = credentials?.has_api_key === true;
  const keyLabel = readStringField(credentials, "key_label", { trim: true });
  const validatedAt = readStringField(credentials, "validated_at", {
    trim: true,
  });
  const validatedDate = validatedAt ? new Date(validatedAt) : null;
  const [apiKey, setApiKey] = useState("");
  const [operation, setOperation] = useState<"save" | "disconnect" | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const inFlight = useRef(false);
  const busy = operation !== null;
  const disabled = busy || connectionActionsDisabled;
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/google-ai`;

  const refreshSources = async () => {
    try {
      if (onSourceChanged) await onSourceChanged();
      else await mutate(`/api/workspaces/${workspaceId}/integrations`);
      await mutate(`/api/workspaces/${workspaceId}/limits`);
      router.refresh();
    } catch {
      setError(t("errors.refreshFailed"));
    }
  };

  const changeConnection = async (nextOperation: "save" | "disconnect") => {
    if (connectionActionsDisabled || inFlight.current) return;
    const trimmedKey = apiKey.trim();
    if (nextOperation === "save" && (!trimmedKey || trimmedKey.length > 4096)) {
      setError(t("errors.invalidKey"));
      return;
    }
    inFlight.current = true;
    setOperation(nextOperation);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        endpoint,
        nextOperation === "save"
          ? {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ apiKey: trimmedKey }),
            }
          : { method: "DELETE" }
      );
      const payload = asNullableRecord(await response.json().catch(() => null));
      if (!response.ok || payload?.success !== true) {
        const code = readStringField(payload, "code");
        setError(
          t(
            ERROR_KEYS[code] ??
              (response.status === 401
                ? "errors.unauthorized"
                : response.status === 403
                  ? "errors.forbidden"
                  : "errors.failed")
          )
        );
        return;
      }
      setApiKey("");
      setDisconnectOpen(false);
      setSuccess(t(nextOperation === "save" ? "saved" : "disconnected"));
      await refreshSources();
    } catch {
      setError(t("errors.failed"));
    } finally {
      inFlight.current = false;
      setOperation(null);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void changeConnection("save");
  };

  return (
    <section className="space-y-5 rounded-2xl border bg-background p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <h3 className="text-base font-semibold">
            {connected ? t("connectedTitle") : t("disconnectedTitle")}
          </h3>
          {connected ? (
            <Badge className="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
              {t("connectedBadge")}
            </Badge>
          ) : null}
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        {source ? (
          <AlertDialog
            open={disconnectOpen}
            onOpenChange={open => {
              if (inFlight.current) return;
              setError(null);
              setDisconnectOpen(open);
            }}
          >
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                className="shrink-0 self-start"
              >
                <Unplug className="mr-2 h-4 w-4" />
                {t("disconnect")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("disconnectTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("disconnectDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={disabled}>
                  {t("cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={disabled}
                  onClick={event => {
                    event.preventDefault();
                    void changeConnection("disconnect");
                  }}
                >
                  {operation === "disconnect" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {t("disconnect")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>

      {connected ? (
        <dl className="grid gap-3 rounded-xl bg-muted/30 p-3 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("keyLabel")}</dt>
            <dd className="break-all font-mono">{keyLabel || t("keySaved")}</dd>
          </div>
          {validatedDate && !Number.isNaN(validatedDate.getTime()) ? (
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">
                {t("validatedAtLabel")}
              </dt>
              <dd>{validatedDate.toLocaleString()}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t("capabilitiesDescription")}</p>
        <p>{t("billingDescription")}</p>
      </div>

      {!connectionActionsDisabled &&
      (limits?.subscriptionType === "pro" || limitsLoading || limitsError) ? (
        <WorkspaceTextAiAllowance
          workspaceId={workspaceId}
          allowance={
            limitsError ? { status: "unavailable" } : limits?.textAiAllowance
          }
          loading={limitsLoading && !limitsError}
        />
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4" aria-busy={busy}>
        <div className="space-y-2">
          <Label htmlFor="google-ai-api-key">{t("apiKeyLabel")}</Label>
          <Input
            id="google-ai-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            maxLength={4096}
            disabled={disabled}
            onChange={event => {
              setApiKey(event.target.value);
              setError(null);
              setSuccess(null);
            }}
            placeholder={t("apiKeyPlaceholder")}
            className="font-mono text-sm"
            aria-describedby={`google-ai-key-help${error && !disconnectOpen ? " google-ai-error" : ""}`}
            aria-invalid={error && !disconnectOpen ? true : undefined}
          />
          <p id="google-ai-key-help" className="text-xs text-muted-foreground">
            {t("keyHelp")}
          </p>
        </div>
        {error && !disconnectOpen ? (
          <p
            id="google-ai-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {success ? (
          <p
            role="status"
            className="text-sm text-emerald-700 dark:text-emerald-300"
          >
            {success}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={disabled}>
            {operation === "save" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="mr-2 h-4 w-4" />
            )}
            {operation === "save"
              ? t("validating")
              : connected
                ? t("replaceButton")
                : t("connectButton")}
          </Button>
          <a
            href="https://aistudio.google.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("studioLink")}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </form>
    </section>
  );
}
