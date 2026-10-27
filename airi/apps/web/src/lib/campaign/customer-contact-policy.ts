import { createHash } from "node:crypto";
import {
  DEFAULT_CONTACT_POLICY,
  isCustomerContactPolicy,
  type CustomerContactPolicy,
} from "@icecore/scenario-contracts";
import connectDB from "@/lib/mongoose";
import CustomerContactPolicyModel from "@/models/customer-contact-policy";
import CustomerContactReservation from "@/models/customer-contact-reservation";
import Customer from "@/models/customer";
import { Conversation } from "@/models/conversation";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import {
  buildCampaignContactDeliveryKey,
  buildCampaignTaskContactDeliveryKey,
} from "@icecore/shared/lib/whatsapp/campaign-contact-key";
import { normalizeCampaignPhone } from "./campaign-recipient-utils";
import { filterKnownMarketingOptOutRecipients } from "./marketing-opt-in";

type Contact = { key: string; at: Date };
const CONTACT_ELIGIBILITY_BATCH_SIZE = 100;
const CONTACT_ELIGIBILITY_CONCURRENCY = 4;
type ContactRecipient = { phone: string; conversationId?: string };
class ContactReservationConflict extends Error {}

export function evaluateContactWindow(
  contacts: Contact[],
  key: string | null,
  policy: CustomerContactPolicy,
  now: Date
) {
  if (
    !isCustomerContactPolicy(policy) ||
    !Number.isFinite(now.getTime()) ||
    contacts.some(contact => !Number.isFinite(new Date(contact.at).getTime()))
  ) {
    return { allowed: false, duplicate: false, contacts, nextEligibleAt: null };
  }
  const window = Math.max(7 * 86_400_000, policy.minIntervalHours * 3_600_000);
  const retained = contacts.filter(
    contact => new Date(contact.at).getTime() > now.getTime() - window
  );
  if (key !== null && retained.some(contact => contact.key === key))
    return {
      allowed: true,
      duplicate: true,
      contacts: retained,
      nextEligibleAt: null,
    };
  const latest = Math.max(
    0,
    ...retained.map(contact => new Date(contact.at).getTime())
  );
  const weekly = retained
    .map(contact => new Date(contact.at).getTime())
    .filter(at => at > now.getTime() - 7 * 86_400_000)
    .sort((a, b) => a - b);
  const nextEligibleTime = Math.max(
    now.getTime(),
    retained.length ? latest + policy.minIntervalHours * 3_600_000 : 0,
    weekly.length >= policy.maxPerWeek
      ? weekly[weekly.length - policy.maxPerWeek]! + 7 * 86_400_000
      : 0
  );
  const allowed = nextEligibleTime <= now.getTime();
  return {
    allowed,
    duplicate: false,
    contacts: retained,
    nextEligibleAt: allowed ? null : new Date(nextEligibleTime),
  };
}

/** The send-time reservation and read-only retry admission share identity ownership. */
async function resolveCustomerContactIdentities(
  workspaceId: string,
  recipients: ContactRecipient[]
): Promise<string[][]> {
  const phones = recipients.map(recipient =>
    normalizeCampaignPhone(recipient.phone)
  );
  if (phones.some(phone => !phone))
    throw new Error("Contact identity unavailable");
  const conversationIds = [
    ...new Set(
      recipients.flatMap(recipient =>
        recipient.conversationId ? [recipient.conversationId] : []
      )
    ),
  ];
  const conversations = conversationIds.length
    ? await Conversation.find({ workspaceId, _id: { $in: conversationIds } })
        .select("_id customerId")
        .lean<Array<{ _id: unknown; customerId?: unknown }>>()
    : [];
  const conversationCustomers = new Map(
    conversations
      .filter(row => row.customerId)
      .map(row => [String(row._id), String(row.customerId)])
  );
  const unresolvedPhones = [
    ...new Set(
      phones.filter(
        (_phone, index) =>
          !conversationCustomers.has(recipients[index]!.conversationId || "")
      )
    ),
  ];
  const aliases = unresolvedPhones.flatMap(phone => [phone, `+${phone}`]);
  // Match the existing active-customer phone predicates, then keep the smallest
  // customer _id for each alias. Grouping bounds the result to 2 x batch size.
  const customers = aliases.length
    ? await Customer.aggregate<{ _id: string; customerId: unknown }>([
        {
          $match: {
            workspaceId,
            status: "active",
            $or: [
              { "profileSummary.contactPoints.phones": { $in: aliases } },
              {
                identities: {
                  $elemMatch: {
                    type: "phone",
                    normalizedValue: { $in: aliases },
                  },
                },
              },
            ],
          },
        },
        { $sort: { _id: 1 } },
        {
          $project: {
            matchingPhones: {
              $setIntersection: [
                {
                  $concatArrays: [
                    { $ifNull: ["$profileSummary.contactPoints.phones", []] },
                    {
                      $map: {
                        input: {
                          $filter: {
                            input: { $ifNull: ["$identities", []] },
                            as: "identity",
                            cond: { $eq: ["$$identity.type", "phone"] },
                          },
                        },
                        as: "identity",
                        in: "$$identity.normalizedValue",
                      },
                    },
                  ],
                },
                aliases,
              ],
            },
          },
        },
        { $unwind: "$matchingPhones" },
        { $group: { _id: "$matchingPhones", customerId: { $first: "$_id" } } },
      ])
    : [];
  const phoneCustomers = new Map<string, string>();
  for (const row of customers) {
    const phone = normalizeCampaignPhone(row._id);
    const customerId = String(row.customerId);
    const existing = phoneCustomers.get(phone);
    if (!existing || customerId < existing)
      phoneCustomers.set(phone, customerId);
  }
  return recipients.map((recipient, index) => {
    const phone = phones[index]!;
    const customerId =
      conversationCustomers.get(recipient.conversationId || "") ||
      phoneCustomers.get(phone);
    return [
      `whatsapp:${phone}`,
      ...(customerId ? [`customer:${customerId}`] : []),
    ].map(identity => createHash("sha256").update(identity).digest("hex"));
  });
}

export type CustomerMarketingContactWindow = {
  /** Local contact policy refuses a marketing send to this recipient now. */
  blocked: boolean;
  /** When it may next send; null when blocked without a known time. */
  nextEligibleAt: Date | null;
};

/**
 * One result per recipient, in input order. This never reserves contacts;
 * the transport still makes the authoritative CAS reservation.
 */
export async function evaluateCustomerMarketingContactWindows(input: {
  workspaceId: string;
  recipients: ContactRecipient[];
  now?: Date;
}): Promise<CustomerMarketingContactWindow[]> {
  const policy = await loadCustomerContactPolicy(input.workspaceId);
  const now = input.now || new Date();
  const windows: CustomerMarketingContactWindow[] = [];
  for (
    let offset = 0;
    offset < input.recipients.length;
    offset += CONTACT_ELIGIBILITY_BATCH_SIZE * CONTACT_ELIGIBILITY_CONCURRENCY
  ) {
    // Match the bounded waves used by prior-failed-recipient-filter: a failed
    // read prevents later waves from starting and never queues the full audience.
    const summaries = await Promise.all(
      Array.from(
        {
          length: Math.min(
            CONTACT_ELIGIBILITY_CONCURRENCY,
            Math.ceil(
              (input.recipients.length - offset) / CONTACT_ELIGIBILITY_BATCH_SIZE
            )
          ),
        },
        async (_, index) => {
          const start = offset + index * CONTACT_ELIGIBILITY_BATCH_SIZE;
          const identities = await resolveCustomerContactIdentities(
            input.workspaceId,
            input.recipients.slice(start, start + CONTACT_ELIGIBILITY_BATCH_SIZE)
          );
          const rows = await CustomerContactReservation.find({
            workspaceId: input.workspaceId,
            identity: { $in: [...new Set(identities.flat())] },
          })
            .select("identity contacts")
            .lean<Array<{ identity: string; contacts: Contact[] }>>();
          const contactsByIdentity = new Map(
            rows.map(row => [row.identity, row.contacts])
          );
          return identities.map(recipientIdentities => {
            let blocked = false;
            let nextEligibleTime = now.getTime();
            let unknownEligibility = false;
            for (const identity of recipientIdentities) {
              const decision = evaluateContactWindow(
                contactsByIdentity.get(identity) || [],
                null,
                policy,
                now
              );
              if (decision.allowed) continue;
              blocked = true;
              if (
                decision.nextEligibleAt &&
                Number.isFinite(decision.nextEligibleAt.getTime())
              ) {
                nextEligibleTime = Math.max(
                  nextEligibleTime,
                  decision.nextEligibleAt.getTime()
                );
              } else {
                unknownEligibility = true;
              }
            }
            return {
              blocked,
              nextEligibleAt:
                blocked && !unknownEligibility
                  ? new Date(nextEligibleTime)
                  : null,
            };
          });
        }
      )
    );
    for (const batch of summaries) windows.push(...batch);
  }
  return windows;
}

/**
 * Splits recipients into those local contact policy allows now and those
 * contacted too recently, keeping input order. This never reserves contacts;
 * the transport still makes the authoritative CAS reservation.
 */
export async function partitionRecentlyContactedRecipients<
  T extends ContactRecipient,
>(input: {
  workspaceId: string;
  recipients: readonly T[];
  now?: Date;
}): Promise<{
  allowed: T[];
  recentlyContacted: T[];
  /** When every skipped recipient may be contacted again, if known. */
  nextEligibleAt: string | null;
}> {
  if (input.recipients.length === 0) {
    return { allowed: [], recentlyContacted: [], nextEligibleAt: null };
  }
  const now = input.now || new Date();
  const windows = await evaluateCustomerMarketingContactWindows({
    workspaceId: input.workspaceId,
    recipients: [...input.recipients],
    now,
  });
  const allowed: T[] = [];
  const recentlyContacted: T[] = [];
  let nextEligibleTime = now.getTime();
  let unknownEligibility = false;
  input.recipients.forEach((recipient, index) => {
    const window = windows[index];
    if (!window?.blocked) {
      allowed.push(recipient);
      return;
    }
    recentlyContacted.push(recipient);
    if (window.nextEligibleAt) {
      nextEligibleTime = Math.max(
        nextEligibleTime,
        window.nextEligibleAt.getTime()
      );
    } else {
      unknownEligibility = true;
    }
  });
  return {
    allowed,
    recentlyContacted,
    nextEligibleAt:
      recentlyContacted.length && !unknownEligibility
        ? new Date(nextEligibleTime).toISOString()
        : null,
  };
}

export async function loadCustomerContactPolicy(
  workspaceId: string
): Promise<CustomerContactPolicy> {
  await connectDB();
  const row = await CustomerContactPolicyModel.findOne({ workspaceId }).lean();
  return isCustomerContactPolicy(row)
    ? { minIntervalHours: row.minIntervalHours, maxPerWeek: row.maxPerWeek }
    : { ...DEFAULT_CONTACT_POLICY };
}

/** One reservation owner for all campaign IDs. Provider uncertainty retains the slot. */
export async function reserveCustomerMarketingContact(input: {
  workspaceId: string;
  phone: string;
  deliveryKey: string;
  conversationId?: string;
  requireConsent?: boolean;
  now?: Date;
}): Promise<string | null> {
  await connectDB();
  const phone = normalizeCampaignPhone(input.phone);
  if (!phone || !input.deliveryKey) return "contact_identity_missing";
  const consent = await filterKnownMarketingOptOutRecipients({
    workspaceId: input.workspaceId,
    recipients: [{ phone }],
  });
  if (consent.skippedOptIn > 0) return "marketing_opt_out";
  if (input.requireConsent && consent.marketingOptInWarningCount > 0)
    return "marketing_consent_required";
  const [[identities], policy] = await Promise.all([
    resolveCustomerContactIdentities(input.workspaceId, [input]),
    loadCustomerContactPolicy(input.workspaceId),
  ]);
  const now = input.now || new Date();
  const session = await CustomerContactReservation.startSession();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await session.withTransaction(
          async () => {
            const pending = [];
            // Read every identity before reserving any. Mongo transaction operations
            // must be sequential, and every read/write must use this session.
            for (const identity of identities!) {
              const scope = { workspaceId: input.workspaceId, identity };
              const row = await CustomerContactReservation.findOne(scope)
                .session(session)
                .lean<{ version: number; contacts: Contact[] }>();
              const decision = evaluateContactWindow(
                row?.contacts || [],
                input.deliveryKey,
                policy,
                now
              );
              if (!decision.allowed) return "contact_frequency_limit";
              if (!decision.duplicate) pending.push({ scope, row, decision });
            }
            for (const { scope, row, decision } of pending) {
              const contacts = [
                ...decision.contacts,
                { key: input.deliveryKey, at: now },
              ];
              const saved = row
                ? await CustomerContactReservation.updateOne(
                    { ...scope, version: row.version },
                    { $set: { contacts }, $inc: { version: 1 } },
                    { session }
                  )
                : await CustomerContactReservation.updateOne(
                    scope,
                    { $setOnInsert: { version: 1, contacts } },
                    { upsert: true, session }
                  );
              if ((row ? saved.modifiedCount : saved.upsertedCount) !== 1)
                throw new ContactReservationConflict();
            }
            return null;
          },
          {
            readPreference: "primary",
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
          }
        );
        if (result !== null && result !== "contact_frequency_limit")
          throw new Error("Contact reservation outcome unavailable");
        return result;
      } catch (error) {
        // Retry only after Mongo has aborted the entire transaction. A duplicate
        // initial insert or CAS conflict must never leave a phone-only slot.
        if (
          !(error instanceof ContactReservationConflict) &&
          !isMongoDuplicateKeyError(error)
        ) {
          throw error;
        }
      }
    }
    return "contact_reservation_busy";
  } finally {
    await session.endSession();
  }
}

/**
 * Meta definitely did not deliver this send: it rejected the request, or it
 * reported the accepted message as failed. That contact never happened, so its
 * slot stops counting toward the policy. Only this delivery key is removed; an
 * unknown outcome must keep the slot, so callers release on Meta's answer only.
 */
export async function releaseCustomerMarketingContact(input: {
  workspaceId: string;
  phone: string;
  deliveryKey: string;
  conversationId?: string;
}): Promise<number> {
  const phone = normalizeCampaignPhone(input.phone);
  if (!input.workspaceId || !phone || !input.deliveryKey) return 0;
  await connectDB();
  const [identities] = await resolveCustomerContactIdentities(
    input.workspaceId,
    [{ phone, conversationId: input.conversationId }]
  );
  // The version bump fails any reservation that read the slot before this
  // write, so its compare-and-swap retries against the released window.
  const released = await CustomerContactReservation.updateMany(
    {
      workspaceId: input.workspaceId,
      identity: { $in: identities },
      "contacts.key": input.deliveryKey,
    },
    {
      $pull: { contacts: { key: input.deliveryKey } },
      $inc: { version: 1 },
    }
  );
  return released.modifiedCount;
}

/** Releases the slot of a campaign send that Meta reported as failed. */
export async function releaseCampaignContactSlot(input: {
  workspaceId: string;
  campaignId: string;
  taskId?: string | null;
  phone: string;
}): Promise<number> {
  const deliveryKey = input.taskId
    ? buildCampaignTaskContactDeliveryKey(input.taskId)
    : buildCampaignContactDeliveryKey(input.campaignId, input.phone);
  if (!deliveryKey) return 0;
  return releaseCustomerMarketingContact({
    workspaceId: input.workspaceId,
    phone: input.phone,
    deliveryKey,
  });
}
