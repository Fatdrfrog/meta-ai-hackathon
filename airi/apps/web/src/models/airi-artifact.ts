import mongoose from "mongoose";

export type AiriArtifactKind =
  | "whatsapp_template"
  | "whatsapp_flow"
  | "marketing_campaign"
  | "opportunity_scan";

export type AiriArtifactStatus =
  | "draft"
  | "submitted"
  | "published"
  | "failed"
  | "archived";

export type AiriArtifactValidationStatus = "valid" | "invalid";

export type AiriArtifactValidationIssue = {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
};

export type AiriArtifactValidation = {
  status: AiriArtifactValidationStatus;
  issues: AiriArtifactValidationIssue[];
  checkedAt?: Date | null;
};

export type AiriArtifactActor = {
  type: "user" | "assistant" | "system";
  id?: string | null;
};

export interface IAiriArtifact {
  _id: mongoose.Types.ObjectId;
  workspaceId: string;
  threadId: string;
  createdByUserId: string;
  kind: AiriArtifactKind;
  title: string;
  status: AiriArtifactStatus;
  revision: number;
  snapshot: Record<string, unknown>;
  validation: AiriArtifactValidation;
  source?: Record<string, unknown> | null;
  linkedArtifacts?: Record<string, unknown> | null;
  externalRefs?: Record<string, unknown> | null;
  lastSubmittedAt?: Date | null;
  lastPublishedAt?: Date | null;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAiriArtifactVersion {
  _id: mongoose.Types.ObjectId;
  artifactId: string;
  workspaceId: string;
  threadId: string;
  kind: AiriArtifactKind;
  revision: number;
  snapshot: Record<string, unknown>;
  validation: AiriArtifactValidation;
  actor?: AiriArtifactActor | null;
  changeSummary?: string | null;
  source?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

const ValidationIssueSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    code: { type: String, required: true },
    path: { type: String, default: "" },
    message: { type: String, required: true },
    severity: {
      type: String,
      enum: ["error", "warning"],
      default: "error",
      required: true,
    },
  },
  { _id: false }
);

const ValidationSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    status: {
      type: String,
      enum: ["valid", "invalid"],
      required: true,
      default: "invalid",
      index: true,
    },
    issues: { type: [ValidationIssueSchema], default: [] },
    checkedAt: { type: Date, default: null },
  },
  { _id: false }
);

const ActorSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    type: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true,
    },
    id: { type: String, default: null },
  },
  { _id: false }
);

const AiriArtifactSchema = new mongoose.Schema<IAiriArtifact>(
  {
    workspaceId: { type: String, required: true, index: true },
    threadId: { type: String, required: true, index: true },
    createdByUserId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: [
        "whatsapp_template",
        "whatsapp_flow",
        "marketing_campaign",
        "opportunity_scan",
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    status: {
      type: String,
      enum: ["draft", "submitted", "published", "failed", "archived"],
      default: "draft",
      required: true,
      index: true,
    },
    revision: { type: Number, default: 0, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    validation: { type: ValidationSchema, required: true },
    source: { type: mongoose.Schema.Types.Mixed, default: null },
    linkedArtifacts: { type: mongoose.Schema.Types.Mixed, default: null },
    externalRefs: { type: mongoose.Schema.Types.Mixed, default: null },
    lastSubmittedAt: { type: Date, default: null },
    lastPublishedAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

AiriArtifactSchema.index({ workspaceId: 1, threadId: 1, updatedAt: -1 });
AiriArtifactSchema.index({ workspaceId: 1, kind: 1, updatedAt: -1 });
AiriArtifactSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
AiriArtifactSchema.index({ workspaceId: 1, threadId: 1, kind: 1 });

const AiriArtifactVersionSchema = new mongoose.Schema<IAiriArtifactVersion>(
  {
    artifactId: { type: String, required: true, index: true },
    workspaceId: { type: String, required: true, index: true },
    threadId: { type: String, required: true, index: true },
    kind: {
      type: String,
      enum: [
        "whatsapp_template",
        "whatsapp_flow",
        "marketing_campaign",
        "opportunity_scan",
      ],
      required: true,
      index: true,
    },
    revision: { type: Number, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    validation: { type: ValidationSchema, required: true },
    actor: { type: ActorSchema, default: null },
    changeSummary: { type: String, default: null, maxlength: 240 },
    source: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

AiriArtifactVersionSchema.index(
  { artifactId: 1, revision: 1 },
  { unique: true }
);
AiriArtifactVersionSchema.index({
  workspaceId: 1,
  threadId: 1,
  artifactId: 1,
  revision: -1,
});

export const AiriArtifact =
  mongoose.models.AiriArtifact ||
  mongoose.model<IAiriArtifact>("AiriArtifact", AiriArtifactSchema);

export const AiriArtifactVersion =
  mongoose.models.AiriArtifactVersion ||
  mongoose.model<IAiriArtifactVersion>(
    "AiriArtifactVersion",
    AiriArtifactVersionSchema
  );
