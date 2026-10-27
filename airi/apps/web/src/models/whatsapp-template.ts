import type {
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
  WhatsAppMarketingMessagesOptimizationSpec,
  WhatsAppTemplateQuality,
  WhatsAppTemplateStatus,
} from "@icecore/shared/types/whatsapp";
import mongoose from "mongoose";

export interface IWhatsAppTemplate {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  templateId: string; // Meta Graph API template ID
  name: string;
  language: string;
  status: WhatsAppTemplateStatus;
  category: WhatsAppTemplateCategory;
  previous_category?: WhatsAppTemplateCategory;
  quality_rating?: WhatsAppTemplateQuality;
  optimization_spec?: WhatsAppMarketingMessagesOptimizationSpec;
  components?: WhatsAppTemplate["components"];
  rejected_reason?: string;
  // Audit fields
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsAppTemplateSchema = new mongoose.Schema<IWhatsAppTemplate>(
  {
    workspaceId: {
      type: String,
      required: true,
      index: true,
    },
    templateId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      index: true,
    },
    language: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["APPROVED", "PENDING", "REJECTED", "PAUSED", "LIMIT_EXCEEDED"],
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
      required: true,
      index: true,
    },
    previous_category: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
    },
    quality_rating: {
      type: String,
      enum: ["GREEN", "YELLOW", "RED"],
    },
    optimization_spec: {
      type: mongoose.Schema.Types.Mixed,
    },
    components: {
      type: mongoose.Schema.Types.Mixed,
    },
    rejected_reason: {
      type: String,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

WhatsAppTemplateSchema.index({ workspaceId: 1, status: 1 });
WhatsAppTemplateSchema.index({ workspaceId: 1, category: 1 });
WhatsAppTemplateSchema.index(
  { workspaceId: 1, name: 1, language: 1 },
  { unique: true }
);
WhatsAppTemplateSchema.index({ templateId: 1 }, { unique: true });

export const WhatsAppTemplateModel =
  mongoose.models.WhatsAppTemplate ||
  mongoose.model<IWhatsAppTemplate>("WhatsAppTemplate", WhatsAppTemplateSchema);

// ============================================================================
// AUDIT LOG MODEL
// ============================================================================

export interface IWhatsAppTemplateAuditLog {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  templateId?: string;
  templateName: string;
  action: "CREATE" | "UPDATE" | "DELETE" | "SYNC";
  userId: string;
  changes?: Record<string, unknown>;
  error?: string;
  createdAt: Date;
}

const WhatsAppTemplateAuditLogSchema =
  new mongoose.Schema<IWhatsAppTemplateAuditLog>(
    {
      workspaceId: {
        type: String,
        required: true,
        index: true,
      },
      templateId: {
        type: String,
        index: true,
      },
      templateName: {
        type: String,
        required: true,
        index: true,
      },
      action: {
        type: String,
        enum: ["CREATE", "UPDATE", "DELETE", "SYNC"],
        required: true,
        index: true,
      },
      userId: {
        type: String,
        required: true,
        index: true,
      },
      changes: {
        type: mongoose.Schema.Types.Mixed,
      },
      error: {
        type: String,
      },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
  );

// Index for audit queries
WhatsAppTemplateAuditLogSchema.index({ workspaceId: 1, createdAt: -1 });
WhatsAppTemplateAuditLogSchema.index({ templateId: 1, createdAt: -1 });

export const WhatsAppTemplateAuditLog =
  mongoose.models.WhatsAppTemplateAuditLog ||
  mongoose.model<IWhatsAppTemplateAuditLog>(
    "WhatsAppTemplateAuditLog",
    WhatsAppTemplateAuditLogSchema
  );
