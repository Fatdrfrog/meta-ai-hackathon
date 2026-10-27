import { validateWhatsAppFlowConfig } from "@/components/scenarios/builders/whatsapp/flow-validation";
import {
  airiBuilderFlowConfigSchema,
  airiBuilderTemplateDraftSchema,
} from "@/lib/airi-chats/builder-state";
import {
  normalizeAiriBulkCampaignDraft,
  type AiriBulkCampaignDraft,
} from "@/lib/airi-chats/bulk-campaign-draft";
import {
  normalizeAiriCreativeAssetDrafts,
  type AiriCreativeAssetDraft,
} from "@/lib/airi-chats/creative-asset-draft";
import { parseAiriCreativeAssetUri } from "@/lib/airi-chats/creative-asset-refs";
import {
  airiCampaignPackageSchema,
  type AiriCampaignPackage,
} from "@/lib/airi-chats/marketing-package";
import {
  airiOpportunityScanSchema,
  type AiriOpportunityScan,
} from "@/lib/airi-chats/opportunity-scan";
import {
  normalizeAiriScenarioGeneratorDraft,
  type AiriScenarioGeneratorDraft,
} from "@/lib/airi-chats/scenario-generator-draft";
import {
  normalizeAiriWhatsAppTemplateDraft,
  type AiriWhatsAppTemplateDraft,
} from "@/lib/airi-chats/whatsapp-template-drafts";
import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import { parseWhatsAppTemplateSubmissionComponents } from "@/lib/whatsapp/templates/component-schemas";
import { createUnifiedTemplateRecord } from "@/lib/whatsapp/templates/unified-service";
import {
  AiriArtifact,
  AiriArtifactVersion,
  type AiriArtifactActor,
  type AiriArtifactKind,
  type AiriArtifactStatus,
  type AiriArtifactValidation,
  type IAiriArtifact,
} from "@/models/airi-artifact";
import {
  resolveCreativeAssetDisplayUrl,
  type LeanCreativeAsset,
} from "@/lib/higgsfield/creative-asset-serialization";
import { CreativeAsset } from "@/models/creative-asset";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Types } from "mongoose";
import { z } from "zod";

export type AiriArtifactSnapshot =
  | { templateDraft: AiriWhatsAppTemplateDraft }
  | { flowConfig: WhatsAppFlowConfig }
  | {
      campaignPackage: AiriCampaignPackage;
      scenarioDraft?: AiriScenarioGeneratorDraft;
      bulkCampaignDraft?: AiriBulkCampaignDraft;
      creativeAssetDrafts?: AiriCreativeAssetDraft[];
    }
  | { opportunityScan: AiriOpportunityScan };

export type SerializedAiriArtifact = {
  id: string;
  workspaceId: string;
  threadId: string;
  createdByUserId: string;
  kind: AiriArtifactKind;
  title: string;
  status: AiriArtifactStatus;
  revision: number;
  snapshot: AiriArtifactSnapshot;
  validation: AiriArtifactValidation;
  source?: Record<string, unknown> | null;
  linkedArtifacts?: Record<string, unknown> | null;
  externalRefs?: Record<string, unknown> | null;
  lastSubmittedAt?: string | null;
  lastPublishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ArtifactDocLike = Partial<IAiriArtifact> & {
  _id: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

type NormalizedSnapshotResult = {
  snapshot: AiriArtifactSnapshot;
  validation: AiriArtifactValidation;
};

export class AiriArtifactValidationError extends Error {
  validation: AiriArtifactValidation;

  constructor(validation: AiriArtifactValidation) {
    super("Invalid Airi artifact snapshot");
    this.name = "AiriArtifactValidationError";
    this.validation = validation;
  }
}

export class AiriArtifactConflictError extends Error {
  current?: SerializedAiriArtifact | null;

  constructor(current?: SerializedAiriArtifact | null) {
    super("Airi artifact revision conflict");
    this.name = "AiriArtifactConflictError";
    this.current = current ?? null;
  }
}

export class AiriArtifactNotFoundError extends Error {
  constructor() {
    super("Airi artifact not found");
    this.name = "AiriArtifactNotFoundError";
  }
}

export class AiriArtifactSubmitError extends Error {
  status: number;
  details?: unknown;

  constructor(
    message: string,
    options?: { status?: number; details?: unknown }
  ) {
    super(message);
    this.name = "AiriArtifactSubmitError";
    this.status = options?.status ?? 400;
    this.details = options?.details;
  }
}

function zodIssuesToValidation(error: z.ZodError): AiriArtifactValidation {
  return {
    status: "invalid",
    issues: error.issues.map(issue => ({
      code: issue.code,
      path: issue.path.join("."),
      message: issue.message,
      severity: "error" as const,
    })),
  };
}

function validValidation(): AiriArtifactValidation {
  return {
    status: "valid",
    issues: [],
    checkedAt: new Date(),
  };
}

function invalidValidation(
  issues: AiriArtifactValidation["issues"]
): AiriArtifactValidation {
  return {
    status: "invalid",
    issues,
    checkedAt: new Date(),
  };
}

function normalizeTemplateSnapshot(
  snapshot: unknown
): NormalizedSnapshotResult {
  const rawDraft =
    snapshot && typeof snapshot === "object" && "templateDraft" in snapshot
      ? (snapshot as { templateDraft?: unknown }).templateDraft
      : snapshot;
  const draft = normalizeAiriWhatsAppTemplateDraft(rawDraft);
  if (!draft) {
    return {
      snapshot: {
        templateDraft: {
          kind: "whatsapp_template",
          name: "airi_whatsapp_template",
          language: "en",
          category: "MARKETING",
          components: [],
        },
      },
      validation: invalidValidation([
        {
          code: "invalid_template_draft",
          path: "templateDraft",
          message: "Template draft is not a valid WhatsApp template draft",
          severity: "error",
        },
      ]),
    };
  }

  const parsed = airiBuilderTemplateDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      snapshot: { templateDraft: draft },
      validation: zodIssuesToValidation(parsed.error),
    };
  }

  return {
    snapshot: {
      templateDraft: {
        ...parsed.data,
        kind: "whatsapp_template",
      },
    },
    validation: validValidation(),
  };
}

function normalizeFlowSnapshot(snapshot: unknown): NormalizedSnapshotResult {
  const rawConfig =
    snapshot && typeof snapshot === "object" && "flowConfig" in snapshot
      ? (snapshot as { flowConfig?: unknown }).flowConfig
      : snapshot;
  const sanitized = sanitizeWhatsAppFlowConfig(rawConfig);
  const parsed = airiBuilderFlowConfigSchema.safeParse(sanitized);
  if (!sanitized || !parsed.success) {
    return {
      snapshot: {
        flowConfig: {
          templateId: "lead_generation",
          ctaText: "Open",
          screens: [],
        } as unknown as WhatsAppFlowConfig,
      },
      validation: parsed.success
        ? invalidValidation([
            {
              code: "invalid_flow_config",
              path: "flowConfig",
              message: "Flow config is not a valid WhatsApp Flow config",
              severity: "error",
            },
          ])
        : zodIssuesToValidation(parsed.error),
    };
  }

  const flowValidation = validateWhatsAppFlowConfig(parsed.data);
  if (!flowValidation.isValid) {
    return {
      snapshot: { flowConfig: parsed.data },
      validation: invalidValidation(
        flowValidation.issues.map(issue => ({
          code: issue.code,
          path: issue.path,
          message: issue.code,
          severity: "error" as const,
        }))
      ),
    };
  }

  return {
    snapshot: { flowConfig: parsed.data },
    validation: validValidation(),
  };
}

function normalizeCampaignSnapshot(
  snapshot: unknown
): NormalizedSnapshotResult {
  const raw =
    snapshot && typeof snapshot === "object" && "campaignPackage" in snapshot
      ? (snapshot as {
          campaignPackage?: unknown;
          scenarioDraft?: unknown;
          bulkCampaignDraft?: unknown;
          creativeAssetDrafts?: unknown;
        })
      : { campaignPackage: snapshot };

  const parsedPackage = airiCampaignPackageSchema.safeParse(
    raw.campaignPackage
  );
  if (!parsedPackage.success) {
    return {
      snapshot: {
        campaignPackage: {
          title: "Campaign work plan",
          goal: "Create an engagement campaign from workspace context.",
          audience: "Workspace audience",
          angle: "Helpful follow-up with one clear next action.",
          evidence: [],
          tools: {
            whatsapp: { available: false, label: "WhatsApp" },
            scenarios: { available: false, label: "Scenarios" },
            bulkCampaigns: { available: false, label: "Bulk campaigns" },
            canva: { available: false, label: "Canva" },
            visualGeneration: {
              available: false,
              label: "Visual generation",
            },
            audioGeneration: {
              available: false,
              label: "Audio generation",
            },
            metaAds: { available: false, label: "Meta Ads" },
          },
          steps: [
            {
              id: "review",
              kind: "measurement",
              title: "Review plan",
              description: "Review and regenerate the campaign plan.",
              status: "needs_input",
              tool: "bulkCampaigns",
            },
          ],
          checks: [],
          nextAction: "Regenerate the campaign plan in Airi chat.",
        },
      },
      validation: zodIssuesToValidation(parsedPackage.error),
    };
  }

  const scenarioDraft = normalizeAiriScenarioGeneratorDraft(raw.scenarioDraft);
  const bulkCampaignDraft = normalizeAiriBulkCampaignDraft(
    raw.bulkCampaignDraft
  );
  const creativeAssetDrafts = normalizeAiriCreativeAssetDrafts(
    raw.creativeAssetDrafts
  );

  return {
    snapshot: {
      campaignPackage: parsedPackage.data,
      ...(scenarioDraft ? { scenarioDraft } : {}),
      ...(bulkCampaignDraft ? { bulkCampaignDraft } : {}),
      ...(creativeAssetDrafts.length > 0 ? { creativeAssetDrafts } : {}),
    },
    validation: validValidation(),
  };
}

function normalizeOpportunityScanSnapshot(
  snapshot: unknown
): NormalizedSnapshotResult {
  const raw =
    snapshot && typeof snapshot === "object" && "opportunityScan" in snapshot
      ? (snapshot as { opportunityScan?: unknown }).opportunityScan
      : snapshot;
  const parsed = airiOpportunityScanSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      snapshot: {
        opportunityScan: {
          title: "Customer opportunity scan",
          summary: "Opportunity scan could not be validated.",
          opportunities: [
            {
              id: "invalid-opportunity-scan",
              title: "Regenerate opportunity scan",
              priority: "low",
              problem:
                "The generated scan did not match the required Airi opportunity contract.",
              customerSignal: "No valid customer signal was provided.",
              recommendedAction:
                "Regenerate the scan with a narrower customer segment or channel.",
              evidence: ["Invalid opportunity scan payload."],
              recommendedArtifacts: ["scenario"],
              missingInputs: ["Valid customer signal and evidence."],
            },
          ],
          nextAction: "Regenerate the opportunity scan.",
        },
      },
      validation: zodIssuesToValidation(parsed.error),
    };
  }

  return {
    snapshot: { opportunityScan: parsed.data },
    validation: validValidation(),
  };
}

function normalizeAndValidateSnapshot(params: {
  kind: AiriArtifactKind;
  snapshot: unknown;
}): NormalizedSnapshotResult {
  if (params.kind === "whatsapp_template") {
    return normalizeTemplateSnapshot(params.snapshot);
  }
  if (params.kind === "marketing_campaign") {
    return normalizeCampaignSnapshot(params.snapshot);
  }
  if (params.kind === "opportunity_scan") {
    return normalizeOpportunityScanSnapshot(params.snapshot);
  }
  return normalizeFlowSnapshot(params.snapshot);
}

function assertValidSnapshot(result: NormalizedSnapshotResult) {
  if (result.validation.status !== "valid") {
    throw new AiriArtifactValidationError(result.validation);
  }
}

function artifactTitle(params: {
  kind: AiriArtifactKind;
  snapshot: AiriArtifactSnapshot;
}): string {
  if (
    params.kind === "whatsapp_template" &&
    "templateDraft" in params.snapshot
  ) {
    return params.snapshot.templateDraft.name || "WhatsApp template";
  }
  if (params.kind === "whatsapp_flow" && "flowConfig" in params.snapshot) {
    return (
      params.snapshot.flowConfig.metaFlowName ||
      params.snapshot.flowConfig.templateId ||
      "WhatsApp Flow"
    );
  }
  if (
    params.kind === "marketing_campaign" &&
    "campaignPackage" in params.snapshot
  ) {
    return params.snapshot.campaignPackage.title || "Campaign work plan";
  }
  if (
    params.kind === "opportunity_scan" &&
    "opportunityScan" in params.snapshot
  ) {
    return params.snapshot.opportunityScan.title || "Customer opportunity scan";
  }
  return "Airi artifact";
}

function toDateIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

function normalizeDoc(doc: unknown): ArtifactDocLike {
  const maybeDoc = doc as { toObject?: () => ArtifactDocLike };
  return typeof maybeDoc?.toObject === "function"
    ? maybeDoc.toObject()
    : (doc as ArtifactDocLike);
}

export function serializeAiriArtifact(doc: unknown): SerializedAiriArtifact {
  const artifact = normalizeDoc(doc);
  const createdAt = toDateIso(artifact.createdAt) || new Date().toISOString();
  const updatedAt = toDateIso(artifact.updatedAt) || createdAt;

  return {
    id: String(artifact._id),
    workspaceId: String(artifact.workspaceId || ""),
    threadId: String(artifact.threadId || ""),
    createdByUserId: String(artifact.createdByUserId || ""),
    kind: artifact.kind as AiriArtifactKind,
    title: String(artifact.title || "WhatsApp artifact"),
    status: (artifact.status || "draft") as AiriArtifactStatus,
    revision: Number(artifact.revision || 0),
    snapshot: artifact.snapshot as AiriArtifactSnapshot,
    validation: artifact.validation || invalidValidation([]),
    source: (artifact.source as Record<string, unknown> | null) ?? null,
    linkedArtifacts:
      (artifact.linkedArtifacts as Record<string, unknown> | null) ?? null,
    externalRefs:
      (artifact.externalRefs as Record<string, unknown> | null) ?? null,
    lastSubmittedAt: toDateIso(artifact.lastSubmittedAt),
    lastPublishedAt: toDateIso(artifact.lastPublishedAt),
    createdAt,
    updatedAt,
  };
}

async function createArtifactVersion(params: {
  artifact: SerializedAiriArtifact;
  actor?: AiriArtifactActor | null;
  changeSummary?: string | null;
  source?: Record<string, unknown> | null;
}) {
  await AiriArtifactVersion.create({
    artifactId: params.artifact.id,
    workspaceId: params.artifact.workspaceId,
    threadId: params.artifact.threadId,
    kind: params.artifact.kind,
    revision: params.artifact.revision,
    snapshot: params.artifact.snapshot,
    validation: params.artifact.validation,
    actor: params.actor ?? null,
    changeSummary: params.changeSummary ?? null,
    source: params.source ?? params.artifact.source ?? null,
  });
}

export async function createAiriArtifact(params: {
  workspaceId: string;
  threadId: string;
  userId: string;
  kind: AiriArtifactKind;
  snapshot: unknown;
  sourceMessageId?: string | null;
  assistantMessageId?: string | null;
  actor?: AiriArtifactActor | null;
  changeSummary?: string | null;
}): Promise<SerializedAiriArtifact> {
  const normalized = normalizeAndValidateSnapshot({
    kind: params.kind,
    snapshot: params.snapshot,
  });
  assertValidSnapshot(normalized);
  const source = {
    ...(params.sourceMessageId ? { messageId: params.sourceMessageId } : {}),
    ...(params.assistantMessageId
      ? { assistantMessageId: params.assistantMessageId }
      : {}),
  };

  const doc = await AiriArtifact.create({
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    createdByUserId: params.userId,
    kind: params.kind,
    title: artifactTitle({ kind: params.kind, snapshot: normalized.snapshot }),
    status: "draft",
    revision: 0,
    snapshot: normalized.snapshot,
    validation: normalized.validation,
    source: Object.keys(source).length > 0 ? source : null,
  });
  const artifact = serializeAiriArtifact(doc);
  await createArtifactVersion({
    artifact,
    actor: params.actor ?? { type: "user", id: params.userId },
    changeSummary: params.changeSummary ?? "Created artifact",
  });
  return artifact;
}

export async function getAiriArtifact(params: {
  workspaceId: string;
  artifactId: string;
}): Promise<SerializedAiriArtifact | null> {
  const doc = await AiriArtifact.findOne({
    _id: params.artifactId,
    workspaceId: params.workspaceId,
    status: { $ne: "archived" },
  }).lean();
  return doc ? serializeAiriArtifact(doc) : null;
}

export async function listAiriArtifacts(params: {
  workspaceId: string;
  threadId?: string | null;
  kind?: AiriArtifactKind | null;
  limit?: number;
}): Promise<SerializedAiriArtifact[]> {
  const query: Record<string, unknown> = {
    workspaceId: params.workspaceId,
    status: { $ne: "archived" },
  };
  if (params.threadId) query.threadId = params.threadId;
  if (params.kind) query.kind = params.kind;

  const docs = await AiriArtifact.find(query)
    .sort({ updatedAt: -1 })
    .limit(Math.min(Math.max(params.limit ?? 50, 1), 100))
    .lean();
  return docs.map(serializeAiriArtifact);
}

export async function updateAiriArtifact(params: {
  workspaceId: string;
  artifactId: string;
  userId?: string | null;
  baseRevision: number;
  snapshot: unknown;
  actor?: AiriArtifactActor | null;
  changeSummary?: string | null;
}): Promise<SerializedAiriArtifact> {
  const existing = await getAiriArtifact({
    workspaceId: params.workspaceId,
    artifactId: params.artifactId,
  });
  if (!existing) throw new AiriArtifactNotFoundError();

  const normalized = normalizeAndValidateSnapshot({
    kind: existing.kind,
    snapshot: params.snapshot,
  });
  assertValidSnapshot(normalized);

  const updatedDoc = await AiriArtifact.findOneAndUpdate(
    {
      _id: params.artifactId,
      workspaceId: params.workspaceId,
      revision: params.baseRevision,
      status: { $ne: "archived" },
    },
    {
      $set: {
        title: artifactTitle({
          kind: existing.kind,
          snapshot: normalized.snapshot,
        }),
        snapshot: normalized.snapshot,
        validation: normalized.validation,
      },
      $inc: { revision: 1 },
    },
    { new: true }
  ).lean();

  if (!updatedDoc) {
    const current = await getAiriArtifact({
      workspaceId: params.workspaceId,
      artifactId: params.artifactId,
    });
    if (current) throw new AiriArtifactConflictError(current);
    throw new AiriArtifactNotFoundError();
  }

  const artifact = serializeAiriArtifact(updatedDoc);
  await createArtifactVersion({
    artifact,
    actor:
      params.actor ??
      (params.userId ? { type: "user", id: params.userId } : null),
    changeSummary: params.changeSummary ?? "Updated artifact",
  });
  return artifact;
}

export async function archiveAiriArtifact(params: {
  workspaceId: string;
  artifactId: string;
  userId?: string | null;
}): Promise<SerializedAiriArtifact> {
  const archived = await AiriArtifact.findOneAndUpdate(
    {
      _id: params.artifactId,
      workspaceId: params.workspaceId,
      status: { $ne: "archived" },
    },
    {
      $set: {
        status: "archived",
        archivedAt: new Date(),
      },
    },
    { new: true }
  ).lean();

  if (!archived) throw new AiriArtifactNotFoundError();
  return serializeAiriArtifact(archived);
}

export async function validateAiriArtifact(params: {
  workspaceId: string;
  artifactId: string;
}): Promise<AiriArtifactValidation> {
  const artifact = await getAiriArtifact(params);
  if (!artifact) throw new AiriArtifactNotFoundError();
  const normalized = normalizeAndValidateSnapshot({
    kind: artifact.kind,
    snapshot: artifact.snapshot,
  });

  await AiriArtifact.findOneAndUpdate(
    {
      _id: params.artifactId,
      workspaceId: params.workspaceId,
      status: { $ne: "archived" },
    },
    {
      $set: {
        snapshot: normalized.snapshot,
        validation: normalized.validation,
      },
    },
    { new: false }
  );

  return normalized.validation;
}

function assertSubmissionReady(result: NormalizedSnapshotResult) {
  assertValidSnapshot(result);
}

async function markArtifactSubmitted(params: {
  workspaceId: string;
  artifactId: string;
  status: AiriArtifactStatus;
  externalRefs: Record<string, unknown>;
  snapshot?: AiriArtifactSnapshot;
  validation?: AiriArtifactValidation;
  published?: boolean;
}) {
  const now = new Date();
  const updated = await AiriArtifact.findOneAndUpdate(
    {
      _id: params.artifactId,
      workspaceId: params.workspaceId,
      status: { $ne: "archived" },
    },
    {
      $set: {
        status: params.status,
        externalRefs: params.externalRefs,
        ...(params.snapshot ? { snapshot: params.snapshot } : {}),
        ...(params.validation ? { validation: params.validation } : {}),
        lastSubmittedAt: now,
        ...(params.published ? { lastPublishedAt: now } : {}),
      },
    },
    { new: true }
  ).lean();

  if (!updated) throw new AiriArtifactNotFoundError();
  return serializeAiriArtifact(updated);
}

const GENERATED_TEMPLATE_HEADER_ASSET_SELECT =
  "_id workspaceId kind status url storageProvider bucket path mimeType fileName error";

async function resolveAiriTemplateCreativeAssetRefs(params: {
  workspaceId: string;
  components: WhatsAppComponent[];
}): Promise<WhatsAppComponent[]> {
  const resolvedComponents: WhatsAppComponent[] = [];

  for (const component of params.components) {
    if (component.type !== "HEADER" || component.format !== "IMAGE") {
      resolvedComponents.push(component);
      continue;
    }

    const assetId = parseAiriCreativeAssetUri(
      component.example?.header_handle?.[0]
    );
    if (!assetId) {
      resolvedComponents.push(component);
      continue;
    }

    if (!Types.ObjectId.isValid(assetId)) {
      throw new AiriArtifactSubmitError(
        "Generated template header image reference is invalid",
        { status: 400 }
      );
    }

    const asset = (await CreativeAsset.findOne({
      _id: assetId,
      workspaceId: params.workspaceId,
      kind: "image",
    })
      .select(GENERATED_TEMPLATE_HEADER_ASSET_SELECT)
      .lean()) as LeanCreativeAsset | null;

    if (!asset) {
      throw new AiriArtifactSubmitError(
        "Generated template header image was not found",
        { status: 404 }
      );
    }
    if (asset.status !== "complete") {
      throw new AiriArtifactSubmitError(
        asset.status === "failed" || asset.status === "nsfw"
          ? "Generated template header image failed. Regenerate it before submitting."
          : "Generated template header image is still running. Submit after it completes.",
        { status: 409 }
      );
    }

    const url = await resolveCreativeAssetDisplayUrl(asset);
    if (!url) {
      throw new AiriArtifactSubmitError(
        "Generated template header image is complete but has no readable URL",
        { status: 409 }
      );
    }

    resolvedComponents.push({
      ...component,
      example: {
        ...component.example,
        header_handle: [url],
      },
    });
  }

  return resolvedComponents;
}

async function submitTemplateArtifact(params: {
  supabase: SupabaseClient;
  artifact: SerializedAiriArtifact;
  userId: string;
}) {
  const normalized = normalizeAndValidateSnapshot({
    kind: "whatsapp_template",
    snapshot: params.artifact.snapshot,
  });
  assertSubmissionReady(normalized);
  if (!("templateDraft" in normalized.snapshot)) {
    throw new AiriArtifactSubmitError("Template artifact snapshot missing");
  }

  const draft = normalized.snapshot.templateDraft;
  const submissionComponents = await resolveAiriTemplateCreativeAssetRefs({
    workspaceId: params.artifact.workspaceId,
    components: draft.components,
  });
  const parsedComponents =
    parseWhatsAppTemplateSubmissionComponents(submissionComponents);
  if (!parsedComponents.success) {
    throw new AiriArtifactValidationError(
      zodIssuesToValidation(parsedComponents.error)
    );
  }

  const result = await createUnifiedTemplateRecord({
    supabase: params.supabase,
    workspaceId: params.artifact.workspaceId,
    userId: params.userId,
    name: draft.name,
    channel: "whatsapp",
    whatsappData: {
      language: draft.language,
      category: draft.category,
      components: parsedComponents.data,
    },
    analyticsOrigin: "airi",
  });

  const artifact = await markArtifactSubmitted({
    workspaceId: params.artifact.workspaceId,
    artifactId: params.artifact.id,
    status: "submitted",
    externalRefs: {
      unifiedTemplateId: result.id,
      metaTemplateId: result.metaTemplateId,
      metaTemplateStatus: result.metaTemplateStatus,
    },
    snapshot: normalized.snapshot,
    validation: normalized.validation,
  });

  return {
    artifact,
    result: {
      kind: "whatsapp_template" as const,
      unifiedTemplateId: result.id,
      metaTemplateId: result.metaTemplateId,
      metaTemplateStatus: result.metaTemplateStatus,
      warning: result.warning,
    },
  };
}

export async function submitAiriArtifact(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  artifactId: string;
  userId: string;
}) {
  const artifact = await getAiriArtifact({
    workspaceId: params.workspaceId,
    artifactId: params.artifactId,
  });
  if (!artifact) throw new AiriArtifactNotFoundError();

  if (artifact.kind === "whatsapp_template") {
    return submitTemplateArtifact({
      supabase: params.supabase,
      artifact,
      userId: params.userId,
    });
  }
  if (artifact.kind === "marketing_campaign") {
    throw new AiriArtifactSubmitError(
      "Campaign work plans are not submitted directly. Open the generated steps and submit each artifact from its editor.",
      { status: 409 }
    );
  }
  if (artifact.kind === "opportunity_scan") {
    throw new AiriArtifactSubmitError(
      "Opportunity scans are planning outputs and cannot be submitted directly.",
      { status: 409 }
    );
  }
  if (artifact.kind === "whatsapp_flow") {
    throw new AiriArtifactSubmitError(
      "Flow artifacts publish only through the Flow editor release lifecycle.",
      { status: 409 }
    );
  }

  const exhaustive: never = artifact.kind;
  throw new AiriArtifactSubmitError(
    `Unsupported artifact kind: ${exhaustive}`,
    { status: 409 }
  );
}
