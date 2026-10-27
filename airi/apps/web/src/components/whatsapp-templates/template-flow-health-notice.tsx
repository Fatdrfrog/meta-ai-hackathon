"use client";

import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  TemplateFlowHealth,
  TemplateFlowIssue,
} from "@/lib/whatsapp/flows/template-flow-health";

type TranslateTemplates = (
  key: string,
  values?: Record<string, string>
) => string;

const ISSUE_MESSAGE_KEYS: Record<TemplateFlowIssue["code"], string> = {
  flow_screen_missing: "flowHealth.screenMissing",
  flow_not_published: "flowHealth.notPublished",
  flow_deprecated: "flowHealth.deprecated",
  flow_blocked: "flowHealth.blocked",
  flow_missing: "flowHealth.missing",
};

/** One sentence per issue, shared by the workbench, editor and builder. */
export function describeTemplateFlowIssue(
  issue: TemplateFlowIssue,
  t: TranslateTemplates
): string {
  return t(ISSUE_MESSAGE_KEYS[issue.code], {
    button: issue.button.text || "Flow",
    flow: issue.flowName || issue.button.flowId,
    screen: issue.button.navigateScreen ?? "",
  });
}

type TemplateFlowHealthNoticeProps = {
  health: TemplateFlowHealth;
  /** "card" sits flush at the bottom of a template card; "panel" is a boxed note. */
  variant: "card" | "panel";
  checking?: boolean;
  onCheckAgain?: () => void;
  className?: string;
};

export function TemplateFlowHealthNotice({
  health,
  variant,
  checking = false,
  onCheckAgain,
  className,
}: TemplateFlowHealthNoticeProps) {
  const t = useTranslations("templates");
  if (health.state !== "issue" && health.state !== "unverified") return null;
  const hasIssues = health.state === "issue";
  // Issue messages are long and name the Flow, so the button goes under them
  // and the text keeps the full width; the short "couldn't check" line has
  // room for it alongside.
  const stacked = hasIssues;
  const checkAgainButton = onCheckAgain ? (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        "h-7 shrink-0 px-2 text-xs",
        stacked ? "-ml-2" : "-my-1",
        hasIssues && "text-destructive hover:text-destructive",
        checking && "cursor-wait opacity-70"
      )}
      // aria-disabled instead of disabled keeps keyboard focus on the button.
      aria-disabled={checking}
      aria-busy={checking}
      onClick={event => {
        event.stopPropagation();
        if (!checking) onCheckAgain();
      }}
      // Template cards open on Enter/Space; keep the key on this button.
      onKeyDown={event => event.stopPropagation()}
    >
      {checking ? (
        <Loader2 aria-hidden className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : (
        <RefreshCw aria-hidden className="mr-1 h-3.5 w-3.5" />
      )}
      {checking ? t("flowHealth.checking") : t("flowHealth.checkAgain")}
    </Button>
  ) : null;

  return (
    <div
      role={hasIssues ? "alert" : "status"}
      data-testid="template-flow-health-notice"
      className={cn(
        "flex items-start gap-2 text-xs",
        variant === "card" ? "border-t px-3 py-2" : "rounded-md border p-2.5",
        hasIssues
          ? variant === "card"
            ? "bg-destructive/5 text-destructive"
            : "border-destructive/40 bg-destructive/5 text-destructive"
          : "text-muted-foreground",
        className
      )}
    >
      {hasIssues ? (
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        {hasIssues ? (
          health.issues.map(issue => (
            <div
              key={`${issue.button.index}:${issue.code}`}
              className="space-y-0.5"
            >
              <p className="break-words">
                {describeTemplateFlowIssue(issue, t as TranslateTemplates)}
              </p>
              {variant === "panel" &&
              issue.code === "flow_screen_missing" &&
              issue.screenIds?.length ? (
                <p className="break-words text-muted-foreground">
                  {t("flowHealth.screensAvailable", {
                    screens: issue.screenIds.join(", "),
                  })}
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <p>{t("flowHealth.unverified")}</p>
        )}
        {stacked ? checkAgainButton : null}
      </div>
      {stacked ? null : checkAgainButton}
    </div>
  );
}
