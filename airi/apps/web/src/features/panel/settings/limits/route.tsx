import { WorkspaceTextAiAllowance } from "@/components/ai/workspace-text-ai-allowance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WorkspaceTextAiAllowanceStatus } from "@/hooks/use-company-limits";
import { getWorkspaceTextAiAllowance } from "@/lib/ai/workspace-ai-policy";
import {
  getCompanyLimitSummaries,
  type CompanyLimitSummary,
} from "@/lib/limits/company-limit-summaries";
import { resolveInternalLimitsAccess } from "@/lib/limits/internal-limits-access";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { BarChart3, Search } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { trimmedSearchParam } from "@/lib/api/query-params";

type SearchParams = {
  q?: string | string[];
  plan?: string | string[];
  status?: string | string[];
};
type QuotaProps = {
  used: number;
  limit: number | null;
  remaining: number | null;
  exhausted: boolean;
  unavailable?: boolean;
  labels: {
    unavailable: string;
    unlimited: string;
    remaining: (count: number) => string;
  };
};

function QuotaCell({
  used,
  limit,
  remaining,
  exhausted,
  unavailable,
  labels,
}: QuotaProps) {
  if (unavailable)
    return (
      <span className="text-xs text-muted-foreground">
        {labels.unavailable}
      </span>
    );
  return (
    <div className="tabular-nums">
      <div className={exhausted ? "font-medium text-destructive" : ""}>
        {used} / {limit === null ? "∞" : limit}
      </div>
      <div className="text-xs text-muted-foreground">
        {limit === null ? labels.unlimited : labels.remaining(remaining ?? 0)}
      </div>
    </div>
  );
}

function atKnownLimit(
  summary: CompanyLimitSummary,
  allowance?: WorkspaceTextAiAllowanceStatus
) {
  return (
    summary.limit.trialExpired ||
    summary.limit.workspaceExhausted ||
    (!summary.snapshot.missing && summary.limit.anyLimitExhausted) ||
    (allowance?.status === "available" &&
      allowance.remainingActions === 0 &&
      !allowance.hasCustomerSource)
  );
}

function statusMatches(
  summary: CompanyLimitSummary,
  status: string,
  allowance?: WorkspaceTextAiAllowanceStatus
) {
  if (status === "exhausted") return atKnownLimit(summary, allowance);
  if (status === "trial_expired") return summary.limit.trialExpired;
  if (status === "missing_snapshot") return summary.snapshot.missing;
  if (status === "active_trial") {
    return (
      summary.limit.subscriptionType === "free" &&
      !summary.limit.trialExpired &&
      Boolean(summary.limit.trialEndsAt) &&
      Number.isFinite(Date.parse(summary.limit.trialEndsAt!))
    );
  }
  return true;
}

export default async function LimitsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  const [{ workspaceId }, resolvedSearchParams] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<SearchParams>({}),
  ]);
  const access = await resolveInternalLimitsAccess(workspaceId);
  if (!access.ok) {
    if (access.status === 401) redirect("/login");
    notFound();
  }
  const [report, t, locale] = await Promise.all([
    getCompanyLimitSummaries(supabaseAdmin),
    getTranslations("LimitsSettings"),
    getLocale(),
  ]);
  const companies = report.companies.filter(
    summary => !summary.isInternalCompany
  );
  const query = trimmedSearchParam(resolvedSearchParams.q);
  const planValue = trimmedSearchParam(resolvedSearchParams.plan).toLowerCase();
  const statusValue = trimmedSearchParam(
    resolvedSearchParams.status
  ).toLowerCase();
  const plan = ["free", "pro", "enterprise"].includes(planValue)
    ? planValue
    : "all";
  const status = [
    "exhausted",
    "active_trial",
    "trial_expired",
    "missing_snapshot",
  ].includes(statusValue)
    ? statusValue
    : "all";
  const candidates = companies.filter(summary => {
    if (plan !== "all" && summary.limit.subscriptionType !== plan) return false;
    const haystack = [
      summary.company.name,
      summary.company.slug,
      ...summary.workspaces.map(workspace => workspace.name),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query.toLowerCase());
  });
  const allowances = new Map<string, WorkspaceTextAiAllowanceStatus>();
  // Keep live company reads bounded; one shared allowance replaces four AI quotas.
  const proCompanies = candidates.filter(
    summary => summary.limit.subscriptionType === "pro"
  );
  for (let offset = 0; offset < proCompanies.length; offset += 8) {
    await Promise.all(
      proCompanies.slice(offset, offset + 8).map(async summary => {
        let allowance: WorkspaceTextAiAllowanceStatus = {
          status: "unavailable",
        };
        const companyWorkspaceId = summary.workspaces[0]?.id;
        if (companyWorkspaceId) {
          try {
            const current =
              await getWorkspaceTextAiAllowance(companyWorkspaceId);
            if (
              current.companyId === summary.company.id &&
              current.plan === "pro"
            )
              allowance = { status: "available", ...current };
          } catch {
            /* The unavailable state preserves the rest of the report. */
          }
        }
        allowances.set(summary.company.id, allowance);
      })
    );
  }
  const filtered = candidates.filter(summary =>
    statusMatches(summary, status, allowances.get(summary.company.id))
  );
  const labels = {
    unavailable: t("usageUnavailable"),
    unlimited: t("unlimited"),
    remaining: (count: number) => t("remaining", { count }),
  };
  function dateLabel(value: string | null) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(locale === "kz" ? "kk" : locale, {
          dateStyle: "short",
          timeStyle: "short",
        }).format(date)
      : "—";
  }

  return (
    <div className="@container/limits space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xl font-semibold">
          <BarChart3 className="size-5 text-muted-foreground" />
          {t("title")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t("updated", { date: dateLabel(report.generatedAt) })}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("scope")}</p>
      <form className="grid gap-3 rounded-lg border p-3 @min-[32rem]/limits:grid-cols-2 @min-[48rem]/limits:grid-cols-[minmax(12rem,1fr)_auto_auto_auto] @min-[48rem]/limits:items-end">
        <div className="space-y-1">
          <label
            htmlFor="limits-query"
            className="text-xs text-muted-foreground"
          >
            {t("search")}
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="limits-query"
              name="q"
              defaultValue={query}
              placeholder={t("searchPlaceholder")}
              className="pl-9"
            />
          </div>
        </div>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("plan")}</span>
          <select
            name="plan"
            defaultValue={plan}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">{t("allPlans")}</option>
            {["free", "pro", "enterprise"].map(value => (
              <option key={value} value={value}>
                {t(`plans.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">
            {t("statusLabel")}
          </span>
          <select
            name="status"
            defaultValue={status}
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {[
              "all",
              "exhausted",
              "active_trial",
              "trial_expired",
              "missing_snapshot",
            ].map(value => (
              <option key={value} value={value}>
                {t(`filters.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">{t("apply")}</Button>
      </form>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t("companyCount", { count: companies.length })}</span>
        <span>{t("visibleCount", { count: filtered.length })}</span>
        <span>
          {t("missingCount", {
            count: companies.filter(summary => summary.snapshot.missing).length,
          })}
        </span>
      </div>
      {report.truncated ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t("bounded", { count: report.rowLimit })}
        </p>
      ) : null}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-lg border">
          <Table className="block @min-[48rem]/limits:table">
            <TableHeader className="hidden @min-[48rem]/limits:table-header-group">
              <TableRow>
                <TableHead>{t("company")}</TableHead>
                <TableHead>{t("plan")}</TableHead>
                <TableHead>{t("statusLabel")}</TableHead>
                <TableHead>{t("conversations")}</TableHead>
                <TableHead>{t("usage")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="block @min-[48rem]/limits:table-row-group">
              {filtered.map(summary => {
                const allowance = allowances.get(summary.company.id);
                const limit = summary.limit;
                // WhatsApp numbers have their own row and limit.
                const integrationCount = Math.max(
                  0,
                  ...Object.entries(limit.integrationConnectionCounts)
                    .filter(([type]) => type !== "whatsapp")
                    .map(([, count]) => count ?? 0)
                );
                const quotas: Array<
                  [string, number, number | null, number | null, boolean]
                > = [
                  [
                    "workspaces",
                    limit.workspaceCount,
                    limit.workspaceLimit,
                    limit.workspacesRemaining,
                    limit.workspaceExhausted,
                  ],
                  [
                    "seats",
                    limit.seatCount,
                    limit.seatLimit,
                    limit.seatsRemaining,
                    limit.seatExhausted,
                  ],
                  [
                    "channels",
                    limit.channelCount,
                    limit.channelLimit,
                    limit.channelsRemaining,
                    limit.channelExhausted,
                  ],
                  [
                    "whatsapp",
                    limit.whatsappNumberCount,
                    limit.whatsappNumberLimit,
                    limit.whatsappNumbersRemaining,
                    limit.whatsappNumberExhausted,
                  ],
                  [
                    "integrations",
                    integrationCount,
                    limit.integrationConnectionLimit,
                    limit.integrationConnectionLimit === null
                      ? null
                      : Math.max(
                          0,
                          limit.integrationConnectionLimit - integrationCount
                        ),
                    limit.integrationConnectionExhausted,
                  ],
                  [
                    "scenarios",
                    limit.scenarioCount,
                    limit.scenarioLimit,
                    limit.scenariosRemaining,
                    limit.scenarioExhausted,
                  ],
                  [
                    "bulk",
                    limit.bulkRecipientCount ?? 0,
                    limit.bulkRecipientLimit,
                    limit.bulkRecipientsRemaining,
                    limit.bulkRecipientExhausted,
                  ],
                  ...(limit.subscriptionType === "pro"
                    ? []
                    : ([
                        [
                          "airiReplies",
                          limit.airiAutoReplyCount,
                          limit.airiAutoReplyLimit,
                          limit.airiAutoRepliesRemaining,
                          limit.airiAutoReplyExhausted,
                        ],
                        [
                          "classifications",
                          limit.classificationCount,
                          limit.classificationLimit,
                          limit.classificationsRemaining,
                          limit.classificationExhausted,
                        ],
                        [
                          "coach",
                          limit.coachCount,
                          limit.coachLimit,
                          limit.coachSessionsRemaining,
                          limit.coachExhausted,
                        ],
                        [
                          "studio",
                          limit.studioChatCount,
                          limit.studioChatLimit,
                          limit.studioChatsRemaining,
                          limit.studioChatExhausted,
                        ],
                      ] as Array<
                        [string, number, number | null, number | null, boolean]
                      >)),
                ];
                return (
                  <TableRow
                    key={summary.company.id}
                    className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 @min-[48rem]/limits:table-row @min-[48rem]/limits:p-0"
                  >
                    <TableCell className="col-span-2 block min-w-0 p-0 whitespace-normal @min-[48rem]/limits:table-cell @min-[48rem]/limits:max-w-60 @min-[48rem]/limits:p-2">
                      <p className="break-words font-medium">
                        {summary.company.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {summary.workspaces[0]?.name ?? t("noWorkspace")}
                      </p>
                    </TableCell>
                    <TableCell className="block p-0 @min-[48rem]/limits:table-cell @min-[48rem]/limits:p-2">
                      <Badge variant="secondary">
                        {t(`plans.${limit.subscriptionType}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="block p-0 whitespace-normal @min-[48rem]/limits:table-cell @min-[48rem]/limits:p-2">
                      {atKnownLimit(summary, allowance) ? (
                        <Badge variant="destructive">{t("atLimit")}</Badge>
                      ) : null}
                      {limit.subscriptionType === "free" ? (
                        <p className="text-xs text-muted-foreground">
                          {limit.trialExpired
                            ? t("trialExpired")
                            : !limit.trialEndsAt
                              ? t("noTrial")
                              : summary.trial.fullDaysRemaining !== null &&
                                  Number.isFinite(Date.parse(limit.trialEndsAt))
                                ? t("trialDays", {
                                    count: summary.trial.fullDaysRemaining,
                                  })
                                : t("trialUnknown")}
                        </p>
                      ) : null}
                      {summary.snapshot.missing ? (
                        <p className="text-xs text-muted-foreground">
                          {t("usageUnavailable")}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="col-span-2 block p-0 @min-[48rem]/limits:table-cell @min-[48rem]/limits:p-2">
                      <p className="mb-1 text-xs text-muted-foreground @min-[48rem]/limits:hidden">
                        {t("conversations")}
                      </p>
                      <QuotaCell
                        used={limit.conversationCount}
                        limit={limit.conversationLimit}
                        remaining={limit.conversationsRemaining}
                        exhausted={limit.conversationExhausted}
                        unavailable={summary.snapshot.missing}
                        labels={labels}
                      />
                    </TableCell>
                    <TableCell className="col-span-2 block min-w-0 p-0 whitespace-normal @min-[48rem]/limits:table-cell @min-[48rem]/limits:p-2">
                      <details className="max-w-xl @min-[48rem]/limits:min-w-40">
                        <summary
                          className="cursor-pointer rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={t("detailsFor", {
                            name: summary.company.name,
                          })}
                        >
                          {t("details")}
                        </summary>
                        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                          {quotas.map(
                            ([key, used, capacity, remaining, exhausted]) => (
                              <div key={key}>
                                <dt className="text-xs text-muted-foreground">
                                  {t(key)}
                                </dt>
                                <dd className="mt-1">
                                  <QuotaCell
                                    used={used}
                                    limit={capacity}
                                    remaining={remaining}
                                    exhausted={exhausted}
                                    unavailable={
                                      summary.snapshot.missing &&
                                      key !== "workspaces"
                                    }
                                    labels={labels}
                                  />
                                </dd>
                              </div>
                            )
                          )}
                        </dl>
                        {limit.subscriptionType === "pro" ? (
                          <div className="mt-3">
                            <WorkspaceTextAiAllowance
                              workspaceId={summary.workspaces[0]?.id ?? ""}
                              allowance={allowance}
                              compact
                            />
                          </div>
                        ) : null}
                        <p className="mt-3 text-xs text-muted-foreground">
                          {t("snapshot", {
                            date: summary.snapshot.missing
                              ? t("usageUnavailable")
                              : dateLabel(summary.snapshot.updatedAt),
                          })}
                        </p>
                      </details>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
