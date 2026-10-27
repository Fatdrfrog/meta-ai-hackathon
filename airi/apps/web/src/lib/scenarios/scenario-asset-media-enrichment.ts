import "server-only";

import { after } from "next/server";
import {
  mapScenarioNodeMediaAsync,
  mapScenarioServiceMessageMedia,
  mapScenarioServiceMessageMediaAsync,
  readScenarioActionAttachment,
  type ScenarioMediaAsyncVisitor,
  type ScenarioMediaLocation,
} from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";
import { withCreativeAssetDisplayReadUrlCache } from "@/lib/google/creative-asset-read-url-cache";
import { ensureMediaApiCreativeAssetReadUrlPort } from "@/lib/google/creative-asset-read-url-media-api-adapter";
import {
  resolveScenarioActionAttachmentHttpsUrl,
  resolveScenarioAssetHttpsUrl,
} from "@/lib/scenarios/scenario-asset-resolve";

async function enrichAttachment(
  value: unknown,
  workspaceId: string
): Promise<unknown> {
  const attachment = readScenarioActionAttachment(value);
  if (!attachment) return value;
  try {
    return await resolveScenarioActionAttachmentHttpsUrl({
      workspaceId,
      attachment,
    });
  } catch {
    return attachment;
  }
}

async function enrichMediaLocation(
  value: unknown,
  location: ScenarioMediaLocation,
  workspaceId: string
): Promise<unknown> {
  switch (location.kind) {
    case "action_image_url": {
      if (typeof value !== "string") return value;
      try {
        return (
          (await resolveScenarioAssetHttpsUrl({
            workspaceId,
            url: value,
          })) || value
        );
      } catch {
        return value;
      }
    }
    case "action_media_asset": {
      if (!isRecord(value)) return value;
      try {
        const httpsUrl = await resolveScenarioAssetHttpsUrl({
          workspaceId,
          url: typeof value.url === "string" ? value.url : null,
          bucket: typeof value.bucket === "string" ? value.bucket : null,
          path: typeof value.path === "string" ? value.path : null,
        });
        return httpsUrl ? { ...value, url: httpsUrl } : value;
      } catch {
        return value;
      }
    }
    default:
      return enrichAttachment(value, workspaceId);
  }
}

/**
 * Scenario details are shown only in the editor, so their signed URLs may
 * come from the read-URL cache.
 */
function mapNodesMediaAsync(
  nodes: unknown[],
  visit: ScenarioMediaAsyncVisitor<unknown, ScenarioMediaLocation>
): Promise<unknown[]> {
  return withCreativeAssetDisplayReadUrlCache(() =>
    Promise.all(
      nodes.map(async node => {
        if (!isRecord(node)) return node;
        return {
          ...node,
          data: await mapScenarioNodeMediaAsync(node.data, visit),
        };
      })
    )
  );
}

/**
 * Replace durable `gcs://` media refs with signed HTTPS for editor preview.
 * Call only on API responses — not before persistence.
 */
export async function enrichScenarioNodesMediaDisplayUrls(params: {
  workspaceId: string;
  nodes: unknown;
}): Promise<unknown> {
  ensureMediaApiCreativeAssetReadUrlPort();
  if (!Array.isArray(params.nodes)) return params.nodes;
  return mapNodesMediaAsync(params.nodes, (value, location) =>
    enrichMediaLocation(value, location, params.workspaceId)
  );
}

const SIGNING_DEADLINE = Symbol("media-signing-deadline");

function startSigningDeadline(budgetMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reached = new Promise<typeof SIGNING_DEADLINE>(resolve => {
    timer = setTimeout(() => resolve(SIGNING_DEADLINE), budgetMs);
  });
  return { reached, cancel: () => clearTimeout(timer) };
}

/**
 * Keeps the function alive until signing that outlived the response settles,
 * so it still fills the read-URL cache for the next open.
 */
function keepSigningAfterResponse(signing: Promise<unknown>[]): void {
  const settled = Promise.allSettled(signing);
  try {
    after(settled);
  } catch {
    // Outside a request scope the signing still settles on its own.
  }
}

/**
 * Like `enrichScenarioNodesMediaDisplayUrls`, but waits at most `budgetMs`
 * for signing. A location not signed in time keeps its durable value and
 * `pending` is true; its signing continues after the response.
 */
export async function enrichScenarioNodesMediaDisplayUrlsWithinBudget(params: {
  workspaceId: string;
  nodes: unknown;
  budgetMs: number;
}): Promise<{ nodes: unknown; pending: boolean }> {
  ensureMediaApiCreativeAssetReadUrlPort();
  if (!Array.isArray(params.nodes)) {
    return { nodes: params.nodes, pending: false };
  }
  const deadline = startSigningDeadline(params.budgetMs);
  const unfinished: Promise<unknown>[] = [];
  try {
    const nodes = await mapNodesMediaAsync(
      params.nodes,
      async (value, location) => {
        const signing = enrichMediaLocation(
          value,
          location,
          params.workspaceId
        );
        const settled = await Promise.race([signing, deadline.reached]);
        if (settled !== SIGNING_DEADLINE) return settled;
        unfinished.push(signing);
        return value;
      }
    );
    return { nodes, pending: unfinished.length > 0 };
  } finally {
    deadline.cancel();
    if (unfinished.length > 0) keepSigningAfterResponse(unfinished);
  }
}

/**
 * Conversation thread display: signed HTTPS for service-message media
 * (carousel cards, interactive headers). Persist stays on durable gcs://.
 * A media message's own attachment is shown from the message, not the card.
 */
export async function enrichStoredWhatsAppServiceMessagePreviewMedia(params: {
  workspaceId: string;
  preview: unknown;
  /** Conversation message projection also refreshes the primary media URL. */
  includePrimaryAttachment?: boolean;
}): Promise<unknown> {
  if (!isRecord(params.preview) || !isRecord(params.preview.command)) {
    return params.preview;
  }

  const command = params.preview.command;
  let hasCardMedia = false;
  mapScenarioServiceMessageMedia(command, (value, location) => {
    if (
      params.includePrimaryAttachment ||
      location.kind !== "service_attachment"
    )
      hasCardMedia = true;
    return value;
  });
  if (!hasCardMedia) {
    return params.preview;
  }

  ensureMediaApiCreativeAssetReadUrlPort();
  return {
    ...params.preview,
    command: await mapScenarioServiceMessageMediaAsync(
      command,
      async (value, location) =>
        location.kind === "service_attachment" &&
        !params.includePrimaryAttachment
          ? value
          : enrichAttachment(value, params.workspaceId)
    ),
  };
}

/** Use a newly signed primary attachment for playback, keeping persisted refs durable. */
export function resolveStoredWhatsAppServiceMessagePrimaryMediaUrl(params: {
  preview: unknown;
  imageUrl?: string | null;
}): string | null | undefined {
  if (
    !isRecord(params.preview) ||
    !isRecord(params.preview.command) ||
    params.preview.command.kind !== "media"
  )
    return params.imageUrl;
  const attachment = readScenarioActionAttachment(
    params.preview.command.attachment
  );
  return attachment?.url && /^https:\/\//i.test(attachment.url)
    ? attachment.url
    : params.imageUrl;
}
