export const FOLLOW_UP_AUDIENCE_STATUSES = [
  "excluded_purchased",
  "already_in_follow_up",
  "waiting_timeout",
  "ready_now",
  "unmapped_bucket",
] as const;

export type FollowUpAudienceStatus =
  (typeof FOLLOW_UP_AUDIENCE_STATUSES)[number];

export function isFollowUpAudienceStatus(
  value: unknown
): value is FollowUpAudienceStatus {
  return (
    typeof value === "string" &&
    FOLLOW_UP_AUDIENCE_STATUSES.includes(value as FollowUpAudienceStatus)
  );
}
