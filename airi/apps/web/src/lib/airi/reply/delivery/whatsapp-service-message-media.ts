import "server-only";

import {
  mapScenarioServiceMessageMediaAsync,
  type ScenarioActionAttachment,
  type WhatsAppServiceSendCommand,
} from "@icecore/scenario-contracts";
import { resolveScenarioActionAttachmentHttpsUrl } from "@/lib/scenarios/scenario-asset-resolve";

/**
 * Delivery-edge prep: turn stored `gcs://` (etc.) into short-lived HTTPS for Meta.
 * Runtime port decides how (worker GCS signer vs web Media API).
 * Meta dispatch must not call this — use `sendWhatsAppServiceMessage`.
 */

async function resolveAttachmentForSend<T extends ScenarioActionAttachment>(
  attachment: T,
  workspaceId?: string | null
): Promise<T> {
  const resolved = await resolveScenarioActionAttachmentHttpsUrl({
    workspaceId,
    attachment,
  });
  return {
    ...attachment,
    ...resolved,
    mediaType: attachment.mediaType,
  };
}

export async function resolveWhatsAppServiceCommandMediaForSend(
  command: WhatsAppServiceSendCommand,
  workspaceId?: string | null
): Promise<WhatsAppServiceSendCommand> {
  // Composition root owns the read-URL port (Media API on web, GCS on worker).
  // Do not re-wire adapters here — that overwrites the worker GCS signer and
  // then fails on Cloud Run without Vercel OIDC.
  return mapScenarioServiceMessageMediaAsync(command, attachment =>
    resolveAttachmentForSend(attachment, workspaceId)
  );
}
