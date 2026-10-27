/**
 * Database-derived activation funnel. It counts every workspace, including
 * people who declined tracking cookies, so it is the source of truth for
 * conversion; PostHog funnel events explain behaviour for the rest.
 */

export const ACTIVATION_FUNNEL_STEPS = [
  { key: "any_channel", label: "Any channel connected" },
  { key: "whatsapp", label: "WhatsApp connected" },
  { key: "template_submitted", label: "WhatsApp template submitted" },
  { key: "template_approved", label: "WhatsApp template approved" },
  { key: "campaign_accepted", label: "Campaign accepted by WhatsApp" },
  { key: "scenario_created", label: "Scenario created (not demo)" },
  { key: "scenario_active", label: "Scenario active" },
] as const;

export type ActivationFunnelStepKey =
  (typeof ACTIVATION_FUNNEL_STEPS)[number]["key"];

export type ActivationWorkspaceFacts = {
  workspaceId: string;
  companyId: string;
  createdAt: Date;
  internal: boolean;
  /** First time each step was reached; null when never reached. */
  steps: Partial<Record<ActivationFunnelStepKey, Date | null>>;
};

export type ActivationCohortGranularity = "week" | "month";

export type ActivationStepSummary = {
  count: number;
  share: number;
  medianDays: number | null;
};

export type ActivationCohortRow = {
  cohort: string;
  workspaces: number;
  steps: Record<ActivationFunnelStepKey, ActivationStepSummary>;
};

export type ActivationFunnelReport = {
  granularity: ActivationCohortGranularity;
  excludedInternal: number;
  cohorts: ActivationCohortRow[];
  total: ActivationCohortRow;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sources that put a customer channel in front of the workspace. */
export const ACTIVATION_CHANNEL_SOURCE_TYPES = [
  "whatsapp",
  "telegram",
  "instagram",
  "web_widget",
] as const;

export type ActivationCompanyRow = {
  companyId: string;
  createdAt: Date;
  workspaceIds: string[];
  internal: boolean;
};

export type ActivationStepEvent = {
  workspaceId: string;
  step: ActivationFunnelStepKey;
  at: Date;
};

/**
 * One row per company: the signup creates the company with its first
 * workspace, and later steps count from any of the company's workspaces.
 */
export function assembleActivationWorkspaceFacts(
  companies: ActivationCompanyRow[],
  events: ActivationStepEvent[]
): ActivationWorkspaceFacts[] {
  const companyByWorkspace = new Map<string, ActivationWorkspaceFacts>();
  const facts = companies
    .filter(company => company.workspaceIds.length > 0)
    .map(company => {
      const row: ActivationWorkspaceFacts = {
        workspaceId: company.workspaceIds[0],
        companyId: company.companyId,
        createdAt: company.createdAt,
        internal: company.internal,
        steps: {},
      };
      for (const workspaceId of company.workspaceIds) {
        companyByWorkspace.set(workspaceId, row);
      }
      return row;
    });

  for (const event of events) {
    const row = companyByWorkspace.get(event.workspaceId);
    if (!row || Number.isNaN(event.at.getTime())) continue;
    const current = row.steps[event.step];
    if (!current || event.at < current) row.steps[event.step] = event.at;
  }
  return facts;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO week start (Monday, UTC) or calendar month. */
export function activationCohortKey(
  createdAt: Date,
  granularity: ActivationCohortGranularity
): string {
  if (granularity === "month") {
    return `${createdAt.getUTCFullYear()}-${pad(createdAt.getUTCMonth() + 1)}`;
  }
  const dayOfWeek = (createdAt.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(
      createdAt.getUTCFullYear(),
      createdAt.getUTCMonth(),
      createdAt.getUTCDate() - dayOfWeek
    )
  );
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeCohort(
  cohort: string,
  facts: ActivationWorkspaceFacts[]
): ActivationCohortRow {
  const steps = {} as Record<ActivationFunnelStepKey, ActivationStepSummary>;
  for (const { key } of ACTIVATION_FUNNEL_STEPS) {
    const days: number[] = [];
    for (const workspace of facts) {
      const reachedAt = workspace.steps[key];
      if (!reachedAt) continue;
      // Steps recorded before the workspace (rebinds, imports) count as day 0.
      days.push(
        Math.max(0, reachedAt.getTime() - workspace.createdAt.getTime()) /
          DAY_MS
      );
    }
    const mid = median(days);
    steps[key] = {
      count: days.length,
      share: facts.length ? days.length / facts.length : 0,
      medianDays: mid === null ? null : Math.round(mid * 10) / 10,
    };
  }
  return { cohort, workspaces: facts.length, steps };
}

export function buildActivationFunnelReport(
  facts: ActivationWorkspaceFacts[],
  options: {
    granularity?: ActivationCohortGranularity;
    includeInternal?: boolean;
  } = {}
): ActivationFunnelReport {
  const granularity = options.granularity ?? "week";
  const included = options.includeInternal
    ? facts
    : facts.filter(workspace => !workspace.internal);
  const byCohort = new Map<string, ActivationWorkspaceFacts[]>();
  for (const workspace of included) {
    const key = activationCohortKey(workspace.createdAt, granularity);
    const bucket = byCohort.get(key);
    if (bucket) bucket.push(workspace);
    else byCohort.set(key, [workspace]);
  }
  return {
    granularity,
    excludedInternal: facts.length - included.length,
    cohorts: [...byCohort.keys()]
      .sort()
      .map(key => summarizeCohort(key, byCohort.get(key) ?? [])),
    total: summarizeCohort("total", included),
  };
}

function formatStepCell(step: ActivationStepSummary): string {
  const share = `${Math.round(step.share * 100)}%`;
  const days = step.medianDays === null ? "" : `, ${step.medianDays} d`;
  return `${step.count} (${share}${days})`;
}

/** Markdown table: one row per cohort, each step as "count (share, median days)". */
export function formatActivationFunnelMarkdown(
  report: ActivationFunnelReport
): string {
  const header = [
    report.granularity === "week" ? "Week of" : "Month",
    "Workspaces",
    ...ACTIVATION_FUNNEL_STEPS.map(step => step.label),
  ];
  const rows = [...report.cohorts, report.total].map(row => [
    row.cohort === "total" ? "**Total**" : row.cohort,
    String(row.workspaces),
    ...ACTIVATION_FUNNEL_STEPS.map(step => formatStepCell(row.steps[step.key])),
  ]);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(cells => `| ${cells.join(" | ")} |`),
  ];
  return [
    ...lines,
    "",
    `Cells: workspaces that reached the step (share of cohort, median days from workspace creation).`,
    `Internal workspaces excluded: ${report.excludedInternal}.`,
  ].join("\n");
}
