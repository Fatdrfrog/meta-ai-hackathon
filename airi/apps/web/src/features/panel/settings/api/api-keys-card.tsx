"use client";

import { ErrorState, LoadingState } from "@/components/ui/async-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiKeySummary } from "@/lib/customer-api/contracts";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import {
  customerApiActionError,
  customerApiJson,
  useCustomerApiResource,
} from "./client-api";
import { ConfirmApiAction } from "./confirm-action";
import { SecretDialog } from "./secret-dialog";

export function ApiKeysCard({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("CustomerApiSettings");
  const format = useFormatter();
  const url = `/api/workspaces/${workspaceId}/api-keys`;
  const { data, error, isLoading, mutate } = useCustomerApiResource<{
    apiKeys: ApiKeySummary[];
  }>(url);
  const [name, setName] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [expires, setExpires] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<ReturnType<
    typeof customerApiActionError
  > | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiKeySummary | null>(null);
  const busy = pending || isLoading || Boolean(error);

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setActionError(null);
    try {
      const result = await customerApiJson<{
        apiKey: ApiKeySummary;
        secret: string;
      }>(url, "POST", {
        name: name.trim(),
        permissions: { read, write, conversations: read, analytics: read },
        expires_at: expires
          ? new Date(`${expires}T23:59:59.999`).toISOString()
          : null,
      });
      setSecret(result.secret);
      setName("");
      await mutate(
        current => ({ apiKeys: [result.apiKey, ...(current?.apiKeys ?? [])] }),
        { revalidate: false }
      );
    } catch (error) {
      setActionError(customerApiActionError(error));
    } finally {
      setPending(false);
    }
  }

  async function revokeKey(key: ApiKeySummary) {
    setRevoke(null);
    setPending(true);
    setActionError(null);
    try {
      const result = await customerApiJson<{ apiKey: ApiKeySummary }>(
        `${url}/${key.id}`,
        "DELETE"
      );
      await mutate(
        current => ({
          apiKeys: (current?.apiKeys ?? []).map(item =>
            item.id === key.id ? result.apiKey : item
          ),
        }),
        { revalidate: false }
      );
    } catch (error) {
      setActionError(customerApiActionError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("createKey")}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("keysDescription")}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={createKey} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="api-key-name">{t("name")}</Label>
                <Input
                  id="api-key-name"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={busy}
                  placeholder={t("namePlaceholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="api-key-expiry">{t("expiry")}</Label>
                <Input
                  id="api-key-expiry"
                  type="date"
                  value={expires}
                  onChange={event => setExpires(event.target.value)}
                  disabled={busy}
                />
                <p className="text-xs text-muted-foreground">
                  {t("expiryHint")}
                </p>
              </div>
            </div>
            <fieldset disabled={busy} className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                {t("permissions")}
              </legend>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="api-key-read"
                  checked={read}
                  onCheckedChange={checked => setRead(checked === true)}
                />
                <Label htmlFor="api-key-read">{t("permissionRead")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="api-key-write"
                  checked={write}
                  onCheckedChange={checked => setWrite(checked === true)}
                />
                <Label htmlFor="api-key-write">{t("permissionWrite")}</Label>
              </div>
            </fieldset>
            {actionError && <ErrorState message={t(actionError)} />}
            <Button
              type="submit"
              disabled={busy || !name.trim() || (!read && !write)}
            >
              {pending ? t("saving") : t("createKey")}
            </Button>
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
      ) : data?.apiKeys.length ? (
        <div className="space-y-2">
          {data.apiKeys.map(key => {
            const expired = Boolean(
              key.expires_at && Date.parse(key.expires_at) <= Date.now()
            );
            return (
              <Card key={key.id}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-medium">{key.name}</span>
                      <Badge variant="outline">
                        {t(
                          !key.is_active
                            ? "revoked"
                            : expired
                              ? "expired"
                              : "active"
                        )}
                      </Badge>
                    </div>
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {key.key_prefix}…
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        key.permissions.read &&
                        key.permissions.conversations !== false
                          ? t("readConversations")
                          : null,
                        key.permissions.read &&
                        key.permissions.analytics !== false
                          ? t("readAnalytics")
                          : null,
                        key.permissions.write ? t("permissionWrite") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("lastUsed")}:{" "}
                      {key.last_used_at
                        ? format.dateTime(new Date(key.last_used_at), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })
                        : t("never")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !key.is_active}
                    onClick={() => setRevoke(key)}
                  >
                    {t("revoke")}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("noKeys")}
        </p>
      )}
      <Card>
        <CardContent className="space-y-2 p-4">
          <p className="text-sm font-medium">{t("quickStart")}</p>
          <p className="text-sm text-muted-foreground">
            {t("quickStartDescription")}
          </p>
          <pre className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs">
            {[
              "curl https://www.airi.chat/api/v1/messages/send",
              '  -H "Authorization: Bearer YOUR_API_KEY"',
              '  -H "Idempotency-Key: order-42-reply-1"',
              '  -H "Content-Type: application/json"',
              `  -d '{"conversationId":"CONVERSATION_ID","text":"Hello"}'`,
            ].join(" \\" + "\n")}
          </pre>
        </CardContent>
      </Card>
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmApiAction
        open={Boolean(revoke)}
        title={t("revokeTitle")}
        description={t("revokeDescription")}
        onClose={() => setRevoke(null)}
        onConfirm={() => {
          if (revoke) void revokeKey(revoke);
        }}
      />
    </div>
  );
}
