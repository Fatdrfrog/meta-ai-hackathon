import "server-only";

import { randomUUID } from "node:crypto";

import AiriTurnContext from "@/models/airi-turn-context";

const AIRI_INGRESS_LEASE_MS = 5 * 60_000;
const AIRI_INGRESS_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000];

export type AiriIngressLeaseDocument = {
  _id?: unknown;
  ingressKey: string;
  ingressLeaseToken?: string | null;
  ingressAttempts: number;
};

export type ClaimedAiriIngress<
  T extends AiriIngressLeaseDocument = AiriIngressLeaseDocument,
> = T & { _id: unknown; ingressLeaseToken: string };

export async function claimAiriIngress<
  T extends AiriIngressLeaseDocument = AiriIngressLeaseDocument,
>(params: {
  filter: Record<string, unknown>;
  now: Date;
  sort?: Record<string, 1 | -1>;
  hint?: string;
}): Promise<ClaimedAiriIngress<T> | null> {
  const leaseToken = randomUUID();
  const availableLease = {
    $or: [
      { ingressLeaseExpiresAt: { $exists: false } },
      { ingressLeaseExpiresAt: null },
      { ingressLeaseExpiresAt: { $lte: params.now } },
    ],
  };
  const claimed = await AiriTurnContext.findOneAndUpdate(
    "$or" in params.filter
      ? { $and: [params.filter, availableLease] }
      : { ...params.filter, ...availableLease },
    {
      $set: {
        ingressLeaseToken: leaseToken,
        ingressLeaseExpiresAt: new Date(
          params.now.getTime() + AIRI_INGRESS_LEASE_MS
        ),
        ingressAttemptedAt: params.now,
      },
      $inc: { ingressAttempts: 1 },
    },
    {
      new: true,
      ...(params.sort ? { sort: params.sort } : {}),
      ...(params.hint ? { hint: params.hint } : {}),
    }
  );
  if (!claimed || typeof claimed !== "object") return null;
  const plain =
    typeof claimed.toObject === "function" ? claimed.toObject() : claimed;
  if (!plain?._id || plain.ingressLeaseToken !== leaseToken) return null;
  return plain as ClaimedAiriIngress<T>;
}

export async function finishAiriIngressClaim(params: {
  claimed: { _id: unknown; ingressLeaseToken: string };
  update: Record<string, unknown>;
}): Promise<boolean> {
  const result = await AiriTurnContext.updateOne(
    {
      _id: params.claimed._id,
      ingressStatus: "pending",
      ingressLeaseToken: params.claimed.ingressLeaseToken,
    },
    params.update
  );
  return result?.matchedCount === 1 && result?.modifiedCount === 1;
}

export function getAiriIngressRetryDate(now: Date, attempt: number): Date {
  const delayIndex = Math.max(
    0,
    Math.min(AIRI_INGRESS_RETRY_DELAYS_MS.length - 1, attempt - 1)
  );
  return new Date(now.getTime() + AIRI_INGRESS_RETRY_DELAYS_MS[delayIndex]);
}
