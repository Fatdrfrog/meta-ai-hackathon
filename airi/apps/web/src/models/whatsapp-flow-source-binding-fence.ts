import mongoose, { Schema, type Model } from "mongoose";

export const WHATSAPP_FLOW_SOURCE_BINDING_FENCE_KINDS = [
  "PROVISIONING",
  "REBIND",
] as const;

export type WhatsAppFlowSourceBindingFenceRecord = {
  _id: string;
  workspaceId: string;
  kind?: (typeof WHATSAPP_FLOW_SOURCE_BINDING_FENCE_KINDS)[number];
  semanticOperationId?: string;
  ownerToken?: string;
  fence: number;
  leaseExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

const boundedRequiredString = {
  type: String,
  required: true,
  trim: true,
  maxlength: 256,
} as const;
const boundedOptionalString = {
  type: String,
  trim: true,
  maxlength: 256,
} as const;

export const WHATSAPP_FLOW_SOURCE_BINDING_FENCE_INDEXES = [
  {
    key: { workspaceId: 1, updatedAt: -1 },
    options: {
      background: true,
      name: "whatsapp_flow_source_binding_fence_workspace_updated",
    },
  },
  {
    key: { leaseExpiresAt: 1 },
    options: {
      background: true,
      name: "whatsapp_flow_source_binding_fence_lease_expiry",
    },
  },
] as const;

const WhatsAppFlowSourceBindingFenceSchema =
  new Schema<WhatsAppFlowSourceBindingFenceRecord>(
    {
      _id: boundedRequiredString,
      workspaceId: boundedRequiredString,
      kind: {
        type: String,
        enum: WHATSAPP_FLOW_SOURCE_BINDING_FENCE_KINDS,
      },
      semanticOperationId: boundedOptionalString,
      ownerToken: boundedOptionalString,
      fence: {
        type: Number,
        required: true,
        min: 0,
        default: 0,
        validate: Number.isSafeInteger,
      },
      leaseExpiresAt: { type: Date },
    },
    {
      collection: "whatsapp_flow_source_binding_fences",
      timestamps: true,
      versionKey: false,
      strict: "throw",
    }
  );

for (const index of WHATSAPP_FLOW_SOURCE_BINDING_FENCE_INDEXES) {
  WhatsAppFlowSourceBindingFenceSchema.index(index.key, index.options);
}

export const WhatsAppFlowSourceBindingFence =
  (mongoose.models
    .WhatsAppFlowSourceBindingFence as Model<WhatsAppFlowSourceBindingFenceRecord>) ||
  mongoose.model<WhatsAppFlowSourceBindingFenceRecord>(
    "WhatsAppFlowSourceBindingFence",
    WhatsAppFlowSourceBindingFenceSchema
  );
