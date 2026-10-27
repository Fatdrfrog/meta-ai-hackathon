"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmailContentEditor } from "@/components/email/email-content-editor";
import { cn } from "@/lib/utils";
import { MailCheck, RefreshCw, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";

type EmailAutomationSettingsResponse = {
  connected: boolean;
  providerStatus: "disconnected" | "pending_dns" | "connected";
  activeAddressCount: number;
  settings: {
    workspaceId: string;
    registrationFollowUpEnabled: boolean;
    registrationFollowUpTemplate: {
      subject: string;
      markdown: string;
    };
    updatedAt: string | null;
    updatedBy: string | null;
  };
  permissions: {
    canManage: boolean;
  };
};

const fetcher = async (
  url: string
): Promise<EmailAutomationSettingsResponse> => {
  const response = await fetch(url, { cache: "no-store" });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || "Failed to load email automation settings");
  }
  return json;
};

export function EmailAutomationSettings({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { data, error, isLoading, mutate } =
    useSWR<EmailAutomationSettingsResponse>(
      `/api/workspaces/${workspaceId}/email-automation`,
      fetcher,
      { revalidateOnFocus: false }
    );
  const [saving, setSaving] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [subject, setSubject] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [testEmail, setTestEmail] = useState("");

  useEffect(() => {
    if (!data) return;
    setSubject(data.settings.registrationFollowUpTemplate.subject);
    setMarkdown(data.settings.registrationFollowUpTemplate.markdown);
  }, [data]);

  const canManage = Boolean(data?.permissions.canManage);
  const connected = Boolean(data?.connected);
  const enabled = Boolean(data?.settings.registrationFollowUpEnabled);
  const disabled = saving || isLoading || !canManage || !connected;
  const templateDirty =
    Boolean(data) &&
    (subject !== data?.settings.registrationFollowUpTemplate.subject ||
      markdown !== data?.settings.registrationFollowUpTemplate.markdown);

  const updateRegistrationFollowUp = async (nextEnabled: boolean) => {
    if (!data) return;

    const previous = data;
    setSaving(true);
    await mutate(
      {
        ...data,
        settings: {
          ...data.settings,
          registrationFollowUpEnabled: nextEnabled,
        },
      },
      { revalidate: false }
    );

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/email-automation`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registrationFollowUpEnabled: nextEnabled,
          }),
        }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to save email automation");
      }

      await mutate({ ...data, settings: json.settings }, { revalidate: false });
      toast.success("Email automation updated");
    } catch (err) {
      await mutate(previous, { revalidate: false });
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const saveTemplate = async (): Promise<boolean> => {
    if (!data) return false;

    const previous = data;
    setSaving(true);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/email-automation`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registrationFollowUpEnabled: enabled,
            registrationFollowUpTemplate: {
              subject,
              markdown,
            },
          }),
        }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to save email template");
      }

      await mutate({ ...data, settings: json.settings }, { revalidate: false });
      toast.success("Email template saved");
      return true;
    } catch (err) {
      await mutate(previous, { revalidate: false });
      toast.error(err instanceof Error ? err.message : "Save failed");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const sendTestEmail = async () => {
    if (!data) return;
    setTestSending(true);
    try {
      if (templateDirty) {
        const saved = await saveTemplate();
        if (!saved) return;
      }

      const response = await fetch(
        `/api/workspaces/${workspaceId}/email-automation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            testEmail: testEmail.trim() || undefined,
          }),
        }
      );
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(json.error || "Failed to send test email");
      }

      toast.success("Test email sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test send failed");
    } finally {
      setTestSending(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-muted/20">
      <div className="mx-auto flex min-h-full w-full max-w-[1480px] flex-col gap-5 px-5 py-5 lg:px-8 lg:py-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Email</h1>
            <p className="text-sm text-muted-foreground">
              Registration follow-up and workspace email content.
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "w-fit border-transparent bg-background px-3 py-1 shadow-sm",
              connected && "bg-emerald-50 text-emerald-700"
            )}
          >
            {connected ? "Email connected" : "Email not connected"}
          </Badge>
        </div>

        {error ? (
          <div className="rounded-lg bg-background p-4 shadow-sm ring-1 ring-destructive/20">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Unable to load settings</p>
                <p className="text-sm text-muted-foreground">{error.message}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void mutate()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          </div>
        ) : null}

        <section className="overflow-hidden rounded-xl bg-background shadow-sm ring-1 ring-border/50">
          <div className="grid min-h-[calc(100svh-150px)] lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="bg-muted/30 p-5 lg:border-r lg:border-border/60">
              <div className="flex items-start justify-between gap-4 lg:block lg:space-y-5">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <MailCheck className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-base font-semibold">
                      Registration follow-up
                    </h2>
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Send the first product email after a workspace is
                    registered.
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  disabled={disabled}
                  aria-label="Toggle registration follow-up email"
                  onCheckedChange={value =>
                    void updateRegistrationFollowUp(value)
                  }
                />
              </div>

              <div className="mt-6 grid gap-4 text-sm sm:grid-cols-3 lg:grid-cols-1">
                <Metric
                  label="Status"
                  value={enabled ? "Enabled" : "Disabled"}
                />
                <Metric
                  label="Active addresses"
                  value={String(data?.activeAddressCount ?? 0)}
                />
                <Metric
                  label="Last updated"
                  value={
                    data?.settings.updatedAt
                      ? new Date(data.settings.updatedAt).toLocaleDateString()
                      : "Default"
                  }
                />
              </div>

              <div className="mt-6 space-y-2 text-sm text-muted-foreground">
                {!canManage && !isLoading ? (
                  <p>
                    Only workspace admins can edit email automation.
                  </p>
                ) : null}
                {!connected && !isLoading ? (
                  <p>
                    Connect an active email source before editing automation.
                  </p>
                ) : null}
              </div>
            </aside>

            <div className="flex min-w-0 flex-col">
              <div className="flex flex-col gap-2 px-5 py-5 sm:flex-row sm:items-start sm:justify-between lg:px-6">
                <div>
                  <h2 className="text-base font-semibold">
                    Registration email content
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Customize the first follow-up email.
                  </p>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-4 px-5 pb-5 lg:px-6">
                <EmailContentEditor
                  idPrefix="registration-follow-up"
                  workspaceId={workspaceId}
                  value={{ subject, markdown }}
                  disabled={disabled}
                  variables={["userName", "workspaceName", "setupUrl"]}
                  previewVariables={{
                    userName: "Alex",
                    workspaceName: "Acme Support",
                    setupUrl: "https://app.airi.chat/panel/w/workspace/email",
                  }}
                  onChange={next => {
                    setSubject(next.subject);
                    setMarkdown(next.markdown);
                  }}
                  actions={
                    <>
                      <Button
                        type="button"
                        size="sm"
                        disabled={
                          disabled || !subject.trim() || !markdown.trim()
                        }
                        onClick={() => void saveTemplate()}
                      >
                        {saving ? "Saving..." : "Save template"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          disabled ||
                          testSending ||
                          !subject.trim() ||
                          !markdown.trim()
                        }
                        onClick={() => void sendTestEmail()}
                      >
                        <Send className="mr-2 h-4 w-4" />
                        {testSending ? "Sending..." : "Send test"}
                      </Button>
                    </>
                  }
                />

                <div className="max-w-md space-y-2">
                  <Label htmlFor="registration-follow-up-test-email">
                    Test recipient
                  </Label>
                  <Input
                    id="registration-follow-up-test-email"
                    type="email"
                    value={testEmail}
                    disabled={disabled || testSending}
                    onChange={event => setTestEmail(event.target.value)}
                    placeholder="Leave empty to send to yourself"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-foreground">
        {value}
      </p>
    </div>
  );
}
