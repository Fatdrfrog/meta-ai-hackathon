// Client-safe rule for "may this company connect another channel of this
// type?". The server (ensureCompanyChannelCapacity) and the integrations UI
// both call it, so the WhatsApp panel can explain a plan limit before Meta's
// signup opens instead of failing after it.

// Fields are optional so a partial or older limits payload reads as "no
// limit" rather than crashing the integrations page.
export type ChannelCapacityInput = {
  trialExpired?: boolean;
  whatsappNumberLimit?: number | null;
  whatsappNumberCount?: number;
  integrationConnectionLimit?: number | null;
  integrationConnectionCounts?: Record<string, number> | null;
  channelTypes?: readonly string[] | null;
  channelExhausted?: boolean;
};

export type ChannelCapacityBlockReason =
  | "trial_expired"
  | "whatsapp_number_limit"
  | "integration_connection_limit"
  | "channel_limit";

export type ChannelCapacityVerdict =
  | { allowed: true }
  | { allowed: false; reason: ChannelCapacityBlockReason };

function isLimitReached(
  limit: number | null | undefined,
  count: number | undefined
): boolean {
  return typeof limit === "number" && (count ?? 0) >= limit;
}

/**
 * `channelType` must already be a limited channel type (or null for one that
 * is not limited); the caller normalizes it.
 */
export function evaluateChannelCapacity(
  input: ChannelCapacityInput,
  channelType: string | null
): ChannelCapacityVerdict {
  if (input.trialExpired === true) {
    return { allowed: false, reason: "trial_expired" };
  }

  if (!channelType) {
    return { allowed: true };
  }

  if (
    channelType === "whatsapp" &&
    isLimitReached(input.whatsappNumberLimit, input.whatsappNumberCount)
  ) {
    return { allowed: false, reason: "whatsapp_number_limit" };
  }

  // WhatsApp numbers are counted by the WhatsApp number limit above instead.
  if (
    channelType !== "whatsapp" &&
    isLimitReached(
      input.integrationConnectionLimit,
      input.integrationConnectionCounts?.[channelType] ?? 0
    )
  ) {
    return { allowed: false, reason: "integration_connection_limit" };
  }

  if (
    input.channelExhausted === true &&
    !(input.channelTypes ?? []).includes(channelType)
  ) {
    return { allowed: false, reason: "channel_limit" };
  }

  return { allowed: true };
}
