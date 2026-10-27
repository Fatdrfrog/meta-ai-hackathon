export type ManagedFlowReleasePolicy =
  | {
      state: "dark";
      activatedAt: null;
      legacyCutoffAt: null;
    }
  | {
      state: "active";
      activatedAt: string;
      legacyCutoffAt: string;
    };

export type ManagedFlowReleaseDecision = {
  valid: boolean;
  managedFlowEnabled: boolean;
  legacyFlowAllowed: boolean;
};

const LEGACY_COMPATIBILITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const ABSOLUTE_ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(?:Z|[+-]\d{2}:\d{2})$/;

export const MANAGED_FLOW_RELEASE_POLICY = Object.freeze({
  state: "dark",
  activatedAt: null,
  legacyCutoffAt: null,
} as const satisfies ManagedFlowReleasePolicy);

const INVALID_RELEASE_DECISION: ManagedFlowReleaseDecision = Object.freeze({
  valid: false,
  managedFlowEnabled: false,
  legacyFlowAllowed: false,
});

function parseAbsoluteInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = ABSOLUTE_ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond = "000"] = match;
  const parts = [year, month, day, hour, minute, second, millisecond].map(
    part => Number(part)
  );
  const localInstant = new Date(
    Date.UTC(
      parts[0]!,
      parts[1]! - 1,
      parts[2]!,
      parts[3]!,
      parts[4]!,
      parts[5]!,
      parts[6]!
    )
  );
  if (
    localInstant.getUTCFullYear() !== parts[0] ||
    localInstant.getUTCMonth() !== parts[1]! - 1 ||
    localInstant.getUTCDate() !== parts[2] ||
    localInstant.getUTCHours() !== parts[3] ||
    localInstant.getUTCMinutes() !== parts[4] ||
    localInstant.getUTCSeconds() !== parts[5] ||
    localInstant.getUTCMilliseconds() !== parts[6]
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function evaluateManagedFlowReleasePolicy(
  now: Date,
  policy: ManagedFlowReleasePolicy = MANAGED_FLOW_RELEASE_POLICY
): ManagedFlowReleaseDecision {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return INVALID_RELEASE_DECISION;
  }
  if (!policy || typeof policy !== "object") {
    return INVALID_RELEASE_DECISION;
  }

  if (policy.state === "dark") {
    return policy.activatedAt === null && policy.legacyCutoffAt === null
      ? {
          valid: true,
          managedFlowEnabled: false,
          legacyFlowAllowed: true,
        }
      : INVALID_RELEASE_DECISION;
  }
  if (policy.state !== "active") return INVALID_RELEASE_DECISION;

  const activatedAt = parseAbsoluteInstant(policy.activatedAt);
  const legacyCutoffAt = parseAbsoluteInstant(policy.legacyCutoffAt);
  if (
    activatedAt === null ||
    legacyCutoffAt === null ||
    legacyCutoffAt - activatedAt !== LEGACY_COMPATIBILITY_WINDOW_MS
  ) {
    return INVALID_RELEASE_DECISION;
  }

  const timestamp = now.getTime();
  return {
    valid: true,
    managedFlowEnabled: timestamp >= activatedAt,
    legacyFlowAllowed: timestamp < legacyCutoffAt,
  };
}
