import {
  isOnboardingTestSource,
  type Source,
} from "@icecore/shared/types/sources";

type WebWidgetSourceCandidate = Pick<
  Source,
  "created_at" | "credentials" | "type"
>;

function getSourceTime(source: WebWidgetSourceCandidate): number {
  const time = Date.parse(source.created_at);
  return Number.isFinite(time) ? time : 0;
}

function getSourceStatusWeight(source: WebWidgetSourceCandidate): number {
  const credentials = source.credentials;
  if (!credentials || typeof credentials !== "object") return 0;

  return (credentials as Record<string, unknown>).status === "active" ? 1 : 0;
}

export function findPrimaryWebWidgetSource<T extends WebWidgetSourceCandidate>(
  sources: T[] | null | undefined
): T | null {
  const candidates = (sources ?? []).filter(
    source => source.type === "web_widget" && !isOnboardingTestSource(source)
  );

  if (candidates.length === 0) return null;

  return [...candidates].sort((a, b) => {
    const statusDelta = getSourceStatusWeight(b) - getSourceStatusWeight(a);
    if (statusDelta !== 0) return statusDelta;

    return getSourceTime(b) - getSourceTime(a);
  })[0];
}
