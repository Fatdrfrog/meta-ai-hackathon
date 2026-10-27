export type InstagramHumanAgentCapability = {
  supported: boolean;
  enabled: boolean;
  reason?: string;
  /** ISO time the HUMAN_AGENT tag stops working for this conversation. */
  expiresAt?: string | null;
};

/** Meta accepts the HUMAN_AGENT tag for 7 days after the customer's last message. */
const INSTAGRAM_HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function resolveInstagramHumanAgentWindow(
  lastCustomerMessageAt: Date | string | null | undefined,
  now: number = Date.now()
): { isWithinWindow: boolean; expiresAt: string | null } {
  const lastInboundAt = toTimestamp(lastCustomerMessageAt);
  if (lastInboundAt === null) return { isWithinWindow: false, expiresAt: null };
  const expiresAt = lastInboundAt + INSTAGRAM_HUMAN_AGENT_WINDOW_MS;
  return {
    isWithinWindow: now < expiresAt,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** Narrows an approved capability to the conversation's 7-day tag window. */
export function applyInstagramHumanAgentWindow(
  capability: InstagramHumanAgentCapability,
  lastCustomerMessageAt: Date | string | null | undefined,
  now: number = Date.now()
): InstagramHumanAgentCapability {
  if (!capability.enabled) return capability;
  const window = resolveInstagramHumanAgentWindow(lastCustomerMessageAt, now);
  if (!window.isWithinWindow) {
    return {
      supported: true,
      enabled: false,
      reason: "human_agent_window_expired",
      expiresAt: window.expiresAt,
    };
  }
  return { ...capability, expiresAt: window.expiresAt };
}

const INSTAGRAM_MESSAGE_PERMISSION_SET = new Set([
  "instagram_manage_messages",
  "instagram_business_manage_messages",
]);

export function parseBooleanFlag(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "enabled", "approved"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "disabled", "not_approved"].includes(normalized)) {
    return false;
  }

  return undefined;
}

export function parseGrantedPermissions(raw: unknown): Set<string> {
  if (typeof raw !== "string") return new Set();

  return new Set(
    raw
      .split(/[,\s]+/)
      .map(value => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function resolveInstagramHumanAgentCapability(params: {
  channel: string;
  grantedPermissionsRaw?: unknown;
  humanAgentEnabledRaw?: unknown;
  hasInstagramSource?: boolean;
}): InstagramHumanAgentCapability {
  if (params.channel !== "instagram") {
    return { supported: false, enabled: false };
  }

  if (!params.hasInstagramSource) {
    return {
      supported: true,
      enabled: false,
      reason: "instagram_not_connected",
    };
  }

  const explicitlyEnabled = parseBooleanFlag(params.humanAgentEnabledRaw);
  if (explicitlyEnabled === true) {
    return { supported: true, enabled: true };
  }
  if (explicitlyEnabled === false) {
    return {
      supported: true,
      enabled: false,
      reason: "human_agent_not_approved",
    };
  }

  const grantedPermissions = parseGrantedPermissions(
    params.grantedPermissionsRaw
  );

  if (
    grantedPermissions.size > 0 &&
    !Array.from(grantedPermissions).some(permission =>
      INSTAGRAM_MESSAGE_PERMISSION_SET.has(permission)
    )
  ) {
    return {
      supported: true,
      enabled: false,
      reason: "missing_manage_messages_permission",
    };
  }

  return {
    supported: true,
    enabled: false,
    reason: "human_agent_not_approved",
  };
}
