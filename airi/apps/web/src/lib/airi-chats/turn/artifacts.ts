/** Durable Airi artifacts behind builder drafts, campaigns and scans. */

import { isWorkspaceAiPolicyError } from "@/lib/ai/workspace-ai-errors";
import type {
  ActiveAiriBuilderInput,
  AiriBuilderPatch,
} from "@/lib/airi-chats/builder-state";
import {
  AiriArtifactConflictError,
  AiriArtifactValidationError,
  createAiriArtifact,
  updateAiriArtifact,
  type SerializedAiriArtifact,
} from "@/lib/airi-artifacts/service";
import type { AiriWhatsAppTemplateDraft } from "@/lib/airi-chats/whatsapp-template-drafts";
import type { AiriCampaignPackage } from "@/lib/airi-chats/marketing-package";
import type { AiriOpportunityScan } from "@/lib/airi-chats/opportunity-scan";
import type { AiriScenarioGeneratorDraft } from "@/lib/airi-chats/scenario-generator-draft";
import type { AiriBulkCampaignDraft } from "@/lib/airi-chats/bulk-campaign-draft";
import type { AiriCreativeAssetDraft } from "@/lib/airi-chats/creative-asset-draft";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { AiriChatProgressRecorder } from "./types";
import { stageEvent } from "./progress";

export type AiriArtifactMetadata = {
  id: string;
  kind: SerializedAiriArtifact["kind"];
  revision: number;
  status: SerializedAiriArtifact["status"];
  validation: SerializedAiriArtifact["validation"];
  externalRefs?: Record<string, unknown> | null;
};

export type AiriArtifactConflictMetadata = {
  id?: string;
  kind?: SerializedAiriArtifact["kind"];
  requestedRevision: number;
  currentRevision?: number;
  status: "conflict";
};

export const AIRI_ARTIFACT_INVALID_ISSUE_LIMIT = 20;

/** A finished builder draft the artifact validator refused to save. */
export type AiriArtifactInvalidMetadata = {
  /** The existing artifact the draft was meant to update, if any. */
  id?: string;
  kind: "whatsapp_template" | "whatsapp_flow";
  status: "invalid";
  issues: Array<{ code: string; path: string }>;
};

export type AiriBuilderArtifactPersistResult = {
  artifact?: AiriArtifactMetadata;
  conflict?: AiriArtifactConflictMetadata;
  invalid?: AiriArtifactInvalidMetadata;
};

/** The open builder a new draft of this kind edits, if any. */
export function getAiriBuilderPatchTarget(
  kind: AiriBuilderPatch["kind"],
  activeBuilder: ActiveAiriBuilderInput | null | undefined
): ActiveAiriBuilderInput | null {
  return activeBuilder?.kind === kind ? activeBuilder : null;
}

/**
 * The builder patch as stored on a reply. artifactId names the existing
 * artifact the patch edits, so the client applies it at once only to that
 * artifact; a patch that starts a new artifact carries none.
 */
export function withAiriBuilderPatchTarget(
  patch: AiriBuilderPatch,
  activeBuilder: ActiveAiriBuilderInput | null | undefined
): AiriBuilderPatch & { artifactId?: string } {
  const artifactId = getAiriBuilderPatchTarget(
    patch.kind,
    activeBuilder
  )?.artifactId;
  return artifactId ? { ...patch, artifactId } : patch;
}

export function serializeAiriArtifactMetadata(
  artifact: SerializedAiriArtifact
): AiriArtifactMetadata {
  return {
    id: artifact.id,
    kind: artifact.kind,
    revision: artifact.revision,
    status: artifact.status,
    validation: artifact.validation,
    externalRefs: artifact.externalRefs ?? null,
  };
}

export function serializeAiriArtifactConflictMetadata(params: {
  activeBuilder: ActiveAiriBuilderInput;
  current?: SerializedAiriArtifact | null;
}): AiriArtifactConflictMetadata {
  return {
    id: params.current?.id ?? params.activeBuilder.artifactId,
    kind: params.current?.kind ?? params.activeBuilder.kind,
    requestedRevision: params.activeBuilder.revision,
    currentRevision: params.current?.revision,
    status: "conflict",
  };
}

export async function persistAiriBuilderArtifact(params: {
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId?: string | null;
  activeBuilder?: ActiveAiriBuilderInput | null;
  kind: "whatsapp_template";
  snapshot: { templateDraft: AiriWhatsAppTemplateDraft };
  changeSummary: string;
}): Promise<AiriBuilderArtifactPersistResult>;
export async function persistAiriBuilderArtifact(params: {
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId?: string | null;
  activeBuilder?: ActiveAiriBuilderInput | null;
  kind: "whatsapp_flow";
  snapshot: { flowConfig: WhatsAppFlowConfig };
  changeSummary: string;
}): Promise<AiriBuilderArtifactPersistResult>;
export async function persistAiriBuilderArtifact(params: {
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId?: string | null;
  activeBuilder?: ActiveAiriBuilderInput | null;
  kind: "whatsapp_template" | "whatsapp_flow";
  snapshot:
    | { templateDraft: AiriWhatsAppTemplateDraft }
    | { flowConfig: WhatsAppFlowConfig };
  changeSummary: string;
}): Promise<AiriBuilderArtifactPersistResult> {
  const actor = { type: "assistant" as const, id: "airi" };
  // Only an open builder of the same kind is edited; a template request
  // while a Flow is open creates a new template artifact.
  const target = getAiriBuilderPatchTarget(params.kind, params.activeBuilder);
  try {
    if (target?.artifactId) {
      const updated = await updateAiriArtifact({
        workspaceId: params.workspaceId,
        artifactId: target.artifactId,
        userId: params.userId,
        baseRevision: target.revision,
        snapshot: params.snapshot,
        actor,
        changeSummary: params.changeSummary,
      });
      return { artifact: serializeAiriArtifactMetadata(updated) };
    }

    const created = await createAiriArtifact({
      workspaceId: params.workspaceId,
      threadId: params.threadId,
      userId: params.userId,
      kind: params.kind,
      snapshot: params.snapshot,
      sourceMessageId: params.userMessageId ?? null,
      actor,
      changeSummary: params.changeSummary,
    });
    return { artifact: serializeAiriArtifactMetadata(created) };
  } catch (error) {
    if (isWorkspaceAiPolicyError(error)) throw error;
    if (error instanceof AiriArtifactConflictError && target) {
      return {
        conflict: serializeAiriArtifactConflictMetadata({
          activeBuilder: target,
          current: error.current,
        }),
      };
    }
    if (error instanceof AiriArtifactValidationError) {
      // The draft is finished; only saving it was refused. The turn keeps
      // the draft and reports what needs fixing in the builder.
      return {
        invalid: {
          ...(target?.artifactId ? { id: target.artifactId } : {}),
          kind: params.kind,
          status: "invalid",
          issues: error.validation.issues
            .slice(0, AIRI_ARTIFACT_INVALID_ISSUE_LIMIT)
            .map(issue => ({ code: issue.code, path: issue.path })),
        },
      };
    }
    throw error;
  }
}

export async function reportAiriBuilderArtifactInvalid(
  progress: AiriChatProgressRecorder,
  invalid: AiriArtifactInvalidMetadata | undefined
): Promise<void> {
  if (!invalid) return;
  const count = invalid.issues.length;
  await progress.emit(
    stageEvent(
      "builder_artifact",
      "Saving draft",
      "error",
      `${count} validation issue${count === 1 ? "" : "s"}`
    )
  );
}

export function buildAiriBuilderArtifactInvalidNotice(
  invalid: AiriArtifactInvalidMetadata | undefined,
  airiLanguage: string
): string {
  if (!invalid) return "";
  const count = invalid.issues.length;
  if (airiLanguage === "ru") {
    return `\n\nЧерновик пока не сохранен: исправьте в конструкторе замечания (${count}), после этого его можно сохранить и отправить.`;
  }
  if (airiLanguage === "kz") {
    return `\n\nЖоба әлі сақталмады: конструктордағы ескертулерді (${count}) түзетіңіз, содан кейін оны сақтап, жіберуге болады.`;
  }
  return `\n\nI could not save this draft yet: fix ${count} validation issue${count === 1 ? "" : "s"} in the builder, then it can be saved and submitted.`;
}

export async function persistAiriCampaignArtifact(params: {
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId?: string | null;
  packageDraft: AiriCampaignPackage;
  scenarioGeneratorDraft?: AiriScenarioGeneratorDraft | null;
  bulkCampaignDraft?: AiriBulkCampaignDraft | null;
  creativeAssetDrafts?: AiriCreativeAssetDraft[];
}): Promise<AiriArtifactMetadata> {
  const created = await createAiriArtifact({
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    userId: params.userId,
    kind: "marketing_campaign",
    snapshot: {
      campaignPackage: params.packageDraft,
      ...(params.scenarioGeneratorDraft
        ? { scenarioDraft: params.scenarioGeneratorDraft }
        : {}),
      ...(params.bulkCampaignDraft
        ? { bulkCampaignDraft: params.bulkCampaignDraft }
        : {}),
      ...((params.creativeAssetDrafts?.length ?? 0) > 0
        ? { creativeAssetDrafts: params.creativeAssetDrafts }
        : {}),
    },
    sourceMessageId: params.userMessageId ?? null,
    actor: { type: "assistant", id: "airi" },
    changeSummary: "Created campaign work plan",
  });

  return serializeAiriArtifactMetadata(created);
}

export async function persistAiriOpportunityScanArtifact(params: {
  workspaceId: string;
  threadId: string;
  userId: string;
  userMessageId?: string | null;
  scan: AiriOpportunityScan;
}): Promise<AiriArtifactMetadata> {
  const created = await createAiriArtifact({
    workspaceId: params.workspaceId,
    threadId: params.threadId,
    userId: params.userId,
    kind: "opportunity_scan",
    snapshot: { opportunityScan: params.scan },
    sourceMessageId: params.userMessageId ?? null,
    actor: { type: "assistant", id: "airi" },
    changeSummary: "Created customer opportunity scan",
  });

  return serializeAiriArtifactMetadata(created);
}
