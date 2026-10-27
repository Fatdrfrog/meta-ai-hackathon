interface AnalyticsRouteParams {
  workspaceId: string;
}

interface AnalyticsRouteSearchParams {
  days?: string | string[];
}

const DEFAULT_DAYS_PERIOD = 30;
const MIN_DAYS_PERIOD = 1;
const MAX_DAYS_PERIOD = 365;

function parseDaysPeriod(days?: string | string[]): number {
  const rawDays = Array.isArray(days) ? days[0] : days;
  if (!rawDays) {
    return DEFAULT_DAYS_PERIOD;
  }

  const parsedDays = Number.parseInt(rawDays, 10);
  if (Number.isNaN(parsedDays)) {
    return DEFAULT_DAYS_PERIOD;
  }

  return Math.min(MAX_DAYS_PERIOD, Math.max(MIN_DAYS_PERIOD, parsedDays));
}

export async function resolveAnalyticsPageContext(
  params: Promise<AnalyticsRouteParams>,
  searchParams: Promise<AnalyticsRouteSearchParams>
): Promise<{ workspaceId: string; daysPeriod: number }> {
  const [{ workspaceId }, { days }] = await Promise.all([params, searchParams]);

  return {
    workspaceId,
    daysPeriod: parseDaysPeriod(days),
  };
}
