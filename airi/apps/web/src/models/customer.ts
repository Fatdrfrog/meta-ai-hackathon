import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { buildCustomerStageTransition, decodeCustomerStageEnvelope, CustomerStageWriteConflictError, type CustomerStageSnapshot, type CustomerStageWriteContext } from "@/lib/analytics/customer-stage-transition";

const CustomerIdentitySchema = new mongoose.Schema<Record<string, unknown>>(
  {
    type: {
      type: String,
      enum: [
        "seed_key",
        "channel_user",
        "channel_chat",
        "visitor_id",
        "email",
        "phone",
        "username",
        "whatsapp_user_id",
        "whatsapp_parent_user_id",
      ],
      required: true,
    },
    channel: { type: String, default: null },
    sourceId: { type: String, default: null },
    value: { type: String, required: true },
    normalizedValue: { type: String, required: true },
    label: { type: String, default: null },
    linkedAt: { type: Date, default: Date.now },
    linkedBy: { type: String, default: null },
    linkMethod: {
      type: String,
      enum: ["system", "backfill", "manual", "suggested", "rule"],
      default: "system",
    },
    linkConfidence: { type: Number, default: null },
  },
  { _id: false }
);

const BehavioralProfileSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    status: {
      type: String,
      enum: ["pending", "ready", "failed", "insufficient_data"],
      default: "pending",
    },
    summary: { type: String, default: null },
    communicationStyle: { type: String, default: null },
    decisionStyle: { type: String, default: null },
    motivations: { type: [String], default: [] },
    objections: { type: [String], default: [] },
    trustSignals: { type: [String], default: [] },
    urgency: { type: String, default: null },
    channelAffinity: { type: [String], default: [] },
    responseCadence: { type: String, default: null },
    recommendedApproach: { type: [String], default: [] },
    evidenceMessageIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Message",
      default: [],
    },
    confidence: { type: Number, default: null },
    model: { type: String, default: null },
    updatedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false }
);

export const CUSTOMER_CRM_STAGE_INDEX_NAME =
  "customers_workspace_status_stage_recent";

export const CUSTOMER_CRM_STAGE_INDEX_KEYS = {
  workspaceId: 1,
  status: 1,
  currentFunnelStage: 1,
  lastInteractionAt: -1,
  createdAt: -1,
} as const;

export const CUSTOMER_BIRTHDAY_INDEX_NAME =
  "customers_workspace_status_birthday";

export const CUSTOMER_BIRTHDAY_INDEX_KEYS = {
  workspaceId: 1,
  status: 1,
  "profileDates.birthday.month": 1,
  "profileDates.birthday.day": 1,
} as const;

export const CUSTOMER_OWNER_INDEX_NAME = "customers_workspace_owner_recent";

export const CUSTOMER_CONTACT_PHONE_INDEX_NAME =
  "customers_workspace_status_contact_phone";
export const CUSTOMER_CONTACT_PHONE_INDEX_KEYS = {
  workspaceId: 1,
  status: 1,
  "profileSummary.contactPoints.phones": 1,
} as const;
export const CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS = {
  workspaceId: 1,
  "identities.type": 1,
  "identities.normalizedValue": 1,
} as const;

export const CUSTOMER_OWNER_INDEX_KEYS = {
  workspaceId: 1,
  ownerUserId: 1,
  lastInteractionAt: -1,
} as const;

export const CUSTOMER_OWNER_INDEX_OPTIONS = {
  name: CUSTOMER_OWNER_INDEX_NAME,
  background: true,
  partialFilterExpression: {
    ownerUserId: { $type: "string" as const },
  },
} as const;

const CustomerSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    workspaceId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["active", "archived"],
      default: "active",
      index: true,
    },
    displayName: { type: String, default: null, trim: true },
    primaryConversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      default: null,
    },
    conversationIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Conversation",
      default: [],
    },
    seedKeys: { type: [String], default: [] },
    identities: { type: [CustomerIdentitySchema], default: [] },
    profileSummary: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          channels: { type: [String], default: [] },
          languages: { type: [String], default: [] },
          tags: { type: [String], default: [] },
          contactPoints: {
            emails: { type: [String], default: [] },
            phones: { type: [String], default: [] },
            usernames: { type: [String], default: [] },
            visitorIds: { type: [String], default: [] },
            whatsappUserIds: { type: [String], default: [] },
            whatsappParentUserIds: { type: [String], default: [] },
          },
          lastSentiment: { type: String, default: null },
          churnRiskLevel: { type: String, default: null },
          estimatedCustomerLtv: { type: Number, default: null },
          conversationCount: { type: Number, default: 0 },
        },
        { _id: false }
      ),
      default: null,
    },
    profileDates: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          birthday: {
            month: { type: Number, min: 1, max: 12, default: null },
            day: { type: Number, min: 1, max: 31, default: null },
            year: { type: Number, default: null },
            raw: { type: String, default: null },
            source: {
              type: String,
              enum: ["manual", "csv", "whatsapp_contact", "api"],
              default: "manual",
            },
            updatedAt: { type: Date, default: null },
          },
        },
        { _id: false }
      ),
      default: null,
    },
    behavioralProfile: {
      type: BehavioralProfileSchema,
      default: null,
    },
    currentFunnelStage: { type: String, default: null, index: true },
    crm_stage_revision: { type: Number, default: 0 },
    crm_stage_event: {
      type: String,
      default: null,
      set: (value: unknown) => value == null || typeof value === "string" ? value : JSON.stringify(value),
      get: decodeCustomerStageEnvelope,
    },
    crm_stage_event_key: { type: String, default: null },
    lastInteractionAt: { type: Date, default: null, index: true },
    ownerUserId: { type: String, default: null, trim: true, index: true },
    ownerAssignedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CustomerSchema.index({ workspaceId: 1, status: 1, lastInteractionAt: -1 });
CustomerSchema.index({
  workspaceId: 1,
  status: 1,
  "profileSummary.tags": 1,
  lastInteractionAt: -1,
});
CustomerSchema.index(CUSTOMER_CRM_STAGE_INDEX_KEYS, {
  name: CUSTOMER_CRM_STAGE_INDEX_NAME,
});
CustomerSchema.index(CUSTOMER_BIRTHDAY_INDEX_KEYS, {
  name: CUSTOMER_BIRTHDAY_INDEX_NAME,
});
CustomerSchema.index(CUSTOMER_OWNER_INDEX_KEYS, {
  name: CUSTOMER_OWNER_INDEX_NAME,
  partialFilterExpression: CUSTOMER_OWNER_INDEX_OPTIONS.partialFilterExpression,
});
CustomerSchema.index({ workspaceId: 1, status: 1, displayName: 1 });
CustomerSchema.index({ workspaceId: 1, conversationIds: 1 });
CustomerSchema.index({ workspaceId: 1, seedKeys: 1 });
CustomerSchema.index(CUSTOMER_CONTACT_PHONE_INDEX_KEYS, {
  name: CUSTOMER_CONTACT_PHONE_INDEX_NAME,
});
CustomerSchema.index(CUSTOMER_CONTACT_IDENTITY_INDEX_KEYS);
CustomerSchema.index({ workspaceId: 1, _id: 1 });

const CUSTOMER_STAGE_FIELDS = [
  "_id",
  "workspaceId",
  "primaryConversationId",
  "currentFunnelStage",
  "crm_stage_revision",
];
function customerStageSnapshot(doc: {
  get(path: string): unknown;
}): CustomerStageSnapshot {
  return Object.fromEntries(
    CUSTOMER_STAGE_FIELDS.map(key => [key, doc.get(key)])
  );
}
function customerStageFence(before: CustomerStageSnapshot) {
  const revision = before.crm_stage_revision ?? 0;
  return revision === 0
    ? {
        $or: [
          { crm_stage_revision: 0 },
          { crm_stage_revision: { $exists: false } },
        ],
      }
    : { crm_stage_revision: revision };
}
CustomerSchema.post("init", function captureCustomerStageBaseline(doc) {
  if (CUSTOMER_STAGE_FIELDS.every(key => doc.isSelected(key)))
    doc.$locals.customerStageBefore = customerStageSnapshot(doc);
});
CustomerSchema.pre("save", async function captureCustomerStageTransition() {
  if (!this.isNew && !this.isModified("currentFunnelStage")) return;
  let before = this.isNew
    ? null
    : (this.$locals.customerStageBefore as CustomerStageSnapshot | undefined);
  if (!this.isNew && !before) {
    before = (await mongoose
      .model("Customer")
      .findById(this._id)
      .select(CUSTOMER_STAGE_FIELDS.join(" "))
      .session(this.$session())
      .lean()) as CustomerStageSnapshot | null;
    if (!before) throw new Error("Customer stage source no longer exists");
  }
  const current = Object.fromEntries(
    CUSTOMER_STAGE_FIELDS.filter(
      key => this.isSelected(key) || this.isModified(key)
    ).map(key => [key, this.get(key)])
  );
  const transition = buildCustomerStageTransition({
    before: before ?? null,
    after: { ...before, ...current },
    eventId: randomUUID(),
    now: new Date(),
    context: this.$locals.customerStageContext as
      | CustomerStageWriteContext
      | undefined,
  });
  if (!transition) return;
  if (before) this.$where = { ...this.$where, ...customerStageFence(before) };
  this.set(transition);
});
CustomerSchema.post("save", function advanceCustomerStageBaseline(doc) {
  doc.$locals.customerStageBefore = customerStageSnapshot(doc);
  delete doc.$locals.customerStageContext;
  doc.$where = {};
});
type CustomerStageQuery = mongoose.Query<unknown, unknown> & {
  $locals?: { customerStageFenced?: boolean };
};
CustomerSchema.pre(
  ["updateOne", "findOneAndUpdate"],
  async function captureQueryCustomerStageTransition() {
    const options = this.getOptions() as mongoose.QueryOptions & {
      customerStageContext?: CustomerStageWriteContext;
    };
    const context = options.customerStageContext;
    delete options.customerStageContext;
    const update = this.getUpdate();
    if (!update || Array.isArray(update)) return;
    const values = (update.$set ?? update) as Record<string, unknown>;
    if (!("currentFunnelStage" in values)) return;
    const read = this.model
      .findOne(this.getQuery())
      .select(CUSTOMER_STAGE_FIELDS.join(" "))
      .lean();
    if (options.session) read.session(options.session);
    const before = (await read) as CustomerStageSnapshot | null;
    if (!before) return;
    const transition = buildCustomerStageTransition({
      before,
      after: { ...before, ...values },
      eventId: randomUUID(),
      now: new Date(),
      context,
    });
    if (!transition) return;
    this.setQuery({
      $and: [this.getQuery(), { _id: before._id }, customerStageFence(before)],
    });
    this.setUpdate(
      update.$set
        ? { ...update, $set: { ...values, ...transition } }
        : { ...update, ...transition }
    );
    (this as CustomerStageQuery).$locals = { customerStageFenced: true };
  }
);
CustomerSchema.post(
  ["updateOne", "findOneAndUpdate"],
  function rejectLostCustomerStageTransition(result) {
    if (
      (this as CustomerStageQuery).$locals?.customerStageFenced &&
      (result == null ||
        ("matchedCount" in result && result.matchedCount === 0))
    )
      throw new CustomerStageWriteConflictError();
  }
);

const Customer =
  mongoose.models.Customer || mongoose.model("Customer", CustomerSchema);

let ensureCustomerCrmIndexesPromise: Promise<void> | null = null;
let areCustomerCrmIndexesReady = false;
let ensureCustomerBirthdayIndexesPromise: Promise<void> | null = null;
let areCustomerBirthdayIndexesReady = false;
let ensureCustomerOwnerIndexesPromise: Promise<void> | null = null;
let areCustomerOwnerIndexesReady = false;

export async function ensureCustomerCrmIndexes(): Promise<void> {
  if (areCustomerCrmIndexesReady) return;
  if (ensureCustomerCrmIndexesPromise) return ensureCustomerCrmIndexesPromise;

  ensureCustomerCrmIndexesPromise = Customer.collection
    .createIndex(CUSTOMER_CRM_STAGE_INDEX_KEYS, {
      background: true,
      name: CUSTOMER_CRM_STAGE_INDEX_NAME,
    })
    .then(() => {
      areCustomerCrmIndexesReady = true;
    })
    .finally(() => {
      ensureCustomerCrmIndexesPromise = null;
    });

  return ensureCustomerCrmIndexesPromise;
}

export async function ensureCustomerBirthdayIndexes(): Promise<void> {
  if (areCustomerBirthdayIndexesReady) return;
  if (ensureCustomerBirthdayIndexesPromise) {
    return ensureCustomerBirthdayIndexesPromise;
  }

  ensureCustomerBirthdayIndexesPromise = Customer.collection
    .createIndex(CUSTOMER_BIRTHDAY_INDEX_KEYS, {
      background: true,
      name: CUSTOMER_BIRTHDAY_INDEX_NAME,
    })
    .then(() => {
      areCustomerBirthdayIndexesReady = true;
    })
    .finally(() => {
      ensureCustomerBirthdayIndexesPromise = null;
    });

  return ensureCustomerBirthdayIndexesPromise;
}

export async function ensureCustomerOwnerIndexes(): Promise<void> {
  if (areCustomerOwnerIndexesReady) return;
  if (ensureCustomerOwnerIndexesPromise) {
    return ensureCustomerOwnerIndexesPromise;
  }

  ensureCustomerOwnerIndexesPromise = Customer.collection
    .createIndex(CUSTOMER_OWNER_INDEX_KEYS, {
      background: true,
      name: CUSTOMER_OWNER_INDEX_NAME,
      partialFilterExpression:
        CUSTOMER_OWNER_INDEX_OPTIONS.partialFilterExpression,
    })
    .then(() => {
      areCustomerOwnerIndexesReady = true;
    })
    .finally(() => {
      ensureCustomerOwnerIndexesPromise = null;
    });

  return ensureCustomerOwnerIndexesPromise;
}

export default Customer;
