/**
 * Our two copies of a Meta template: the Mongo `whatsapptemplates` cache that
 * sends read first, and the `message_templates` row the templates page keeps
 * for header media and Telegram content. Meta owns status and content, so a
 * change re-reads the template from Graph and refreshes both copies.
 *
 * Worker-safe: no request cookies, the caller passes the Supabase client.
 */
import { isDeepStrictEqual } from "node:util";

import { connectDB } from "@/lib/mongoose";
import {
  formatGraphApiError,
  parseGraphResponse,
} from "@/lib/whatsapp/templates/graph-response";
import {
  getTemplateHeaderMedia,
  isWhatsAppCdnUrl,
} from "@/lib/whatsapp/templates/header-media-utils";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import { buildGraphApiUrl } from "@icecore/shared/lib/meta/graph-version";
import {
  MetaGraphRequestError,
  parseMetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";
import type { WhatsAppTemplateData } from "@icecore/shared/types/templates";
import type {
  GraphApiErrorBody,
  WhatsAppComponent,
  WhatsAppTemplate,
} from "@icecore/shared/types/whatsapp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asNullableRecord } from "@icecore/shared/lib/value-utils";

/** Lifecycle updates also keep the verified shared catalog snapshot current. */
export { patchWhatsAppTemplateCatalogState } from "@/lib/whatsapp/templates/catalog-cache";

const READ_TEMPLATE_OPTIMIZATION_SPEC =
  process.env.WHATSAPP_TEMPLATE_OPTIMIZATION_SPEC_READ_ENABLED === "true";
const TEMPLATE_READ_TIMEOUT_MS = 10_000;
/** Up to this many templates, rows are looked up by Meta id, not all read. */
const MAX_ROW_LOOKUP_IDS = 50;

/** The template fields every Graph read asks for. */
export const WHATSAPP_TEMPLATE_GRAPH_FIELDS = [
  "name",
  "language",
  "status",
  "category",
  "components",
  "id",
  "previous_category",
  "rejected_reason",
  ...(READ_TEMPLATE_OPTIMIZATION_SPEC ? ["optimization_spec"] : []),
].join(",");

/** A template read back from Meta. Without a status, the stored one stays. */
export type MirroredWhatsAppTemplate = Omit<WhatsAppTemplate, "status"> & {
  status?: WhatsAppTemplate["status"];
};

export function readWhatsAppTemplateSnapshotId(
  template: Pick<WhatsAppTemplate, "id" | "name" | "language">
): string {
  return template.id || `${template.name}_${template.language}`;
}

function buildWhatsAppTemplateSnapshot(
  workspaceId: string,
  template: MirroredWhatsAppTemplate
) {
  return {
    workspaceId,
    templateId: readWhatsAppTemplateSnapshotId(template),
    name: template.name,
    language: template.language,
    status: template.status,
    category: template.category,
    previous_category: template.previous_category,
    quality_rating: template.quality_rating,
    optimization_spec: template.optimization_spec,
    components: template.components,
    rejected_reason: template.rejected_reason,
    lastSyncedAt: new Date(),
  };
}

/**
 * Upsert a single template snapshot to MongoDB
 */
export async function upsertTemplateSnapshot(
  workspaceId: string,
  template: WhatsAppTemplate
): Promise<void> {
  await connectDB();

  await WhatsAppTemplateModel.findOneAndUpdate(
    {
      workspaceId,
      templateId: readWhatsAppTemplateSnapshotId(template),
    },
    buildWhatsAppTemplateSnapshot(workspaceId, template),
    { upsert: true, new: true }
  );
}

/**
 * Refreshes the cached snapshot of this template, if the cache has one.
 * Only Sync adds snapshots: sends treat the cached languages of a name as
 * all of them, so one template must not start a partial set.
 */
async function refreshCachedTemplateSnapshot(
  workspaceId: string,
  template: MirroredWhatsAppTemplate
): Promise<boolean> {
  await connectDB();

  const snapshot = Object.fromEntries(
    Object.entries(buildWhatsAppTemplateSnapshot(workspaceId, template)).filter(
      ([, value]) => value !== undefined
    )
  );
  const result = await WhatsAppTemplateModel.updateOne(
    { workspaceId, templateId: snapshot.templateId },
    { $set: snapshot }
  );
  return result.matchedCount > 0;
}

/**
 * Removes a deleted template from the cache, so sends stop picking it: one
 * language by Meta id, or every language of the name.
 */
export async function deleteTemplateSnapshots(params: {
  workspaceId: string;
  templateId?: string;
  name: string;
}): Promise<void> {
  await connectDB();

  await WhatsAppTemplateModel.deleteMany(
    params.templateId
      ? { workspaceId: params.workspaceId, templateId: params.templateId }
      : { workspaceId: params.workspaceId, name: params.name.trim() }
  );
}

/** One template as Meta has it now, read with the given account token. */
export async function fetchWhatsAppTemplateById(params: {
  templateId: string;
  accessToken: string;
}): Promise<WhatsAppTemplate> {
  const query = new URLSearchParams({
    fields: WHATSAPP_TEMPLATE_GRAPH_FIELDS,
  });
  const res = await fetch(
    buildGraphApiUrl(
      `${encodeURIComponent(params.templateId)}?${query.toString()}`
    ),
    {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TEMPLATE_READ_TIMEOUT_MS),
    }
  );
  const response = await parseGraphResponse<
    Partial<WhatsAppTemplate> & { error?: GraphApiErrorBody }
  >(res);
  if (!res.ok || response?.error) {
    const parsedError = parseMetaGraphAPIError(response);
    throw new MetaGraphRequestError({
      message: formatGraphApiError(
        response?.error,
        `Failed to fetch template: ${res.status}`
      ),
      status: res.status,
      statusText: res.statusText,
      url: buildGraphApiUrl(
        `${encodeURIComponent(params.templateId)}?${query.toString()}`
      ),
      details: response,
      metaError: parsedError
        ? {
            ...parsedError,
            message: parsedError.message ?? "Failed to fetch template",
            type: parsedError.type ?? "GraphAPIError",
            code: Number.isFinite(Number(parsedError.code))
              ? Number(parsedError.code)
              : 0,
          }
        : undefined,
    });
  }
  if (!response.id || !response.name) {
    throw new Error("Meta template response missing id or name");
  }
  return response as WhatsAppTemplate;
}

/**
 * Meta's header, carrying our stored sample link when that link is ours:
 * Meta answers with CDN links that expire, and re-submitting a template to
 * another account downloads the sample again.
 */
function keepOwnHeaderSample<T extends WhatsAppComponent>(
  metaComponents: T[],
  storedComponents: readonly WhatsAppComponent[] | undefined
): T[] {
  const storedMedia = getTemplateHeaderMedia([...(storedComponents ?? [])]);
  const storedHeader = storedComponents?.find(
    component => component.type === "HEADER"
  );
  if (
    !storedMedia?.url ||
    isWhatsAppCdnUrl(storedMedia.url) ||
    storedHeader?.type !== "HEADER"
  ) {
    return metaComponents;
  }
  return metaComponents.map(component => {
    const header = component as WhatsAppComponent;
    return header.type === "HEADER" && header.format === storedMedia.format
      ? ({ ...component, example: storedHeader.example } as T)
      : component;
  });
}

function mirrorTemplateComponents(
  metaComponents: WhatsAppComponent[],
  storedComponents: WhatsAppComponent[] | undefined
): WhatsAppComponent[] {
  const storedCarousel = storedComponents?.find(
    component => component.type === "CAROUSEL"
  );
  return keepOwnHeaderSample(metaComponents, storedComponents).map(component =>
    component.type === "CAROUSEL" && storedCarousel?.type === "CAROUSEL"
      ? {
          ...component,
          cards: component.cards.map((card, index) => ({
            ...card,
            components: keepOwnHeaderSample(
              card.components,
              storedCarousel.cards[index]?.components
            ),
          })),
        }
      : component
  );
}

/** A stored row's WhatsApp data with Meta's status, category and content. */
export function mergeMetaTemplateIntoUnifiedData(
  stored: WhatsAppTemplateData,
  template: MirroredWhatsAppTemplate
): WhatsAppTemplateData {
  return {
    ...stored,
    ...(template.status ? { status: template.status } : {}),
    ...(template.category ? { category: template.category } : {}),
    ...(Array.isArray(template.components)
      ? {
          components: mirrorTemplateComponents(
            template.components,
            stored.components
          ),
        }
      : {}),
    ...(template.optimization_spec !== undefined
      ? { optimization_spec: template.optimization_spec }
      : {}),
  };
}

/**
 * Writes Meta's version into the workspace's `message_templates` rows that
 * point at these templates. Returns how many rows changed.
 */
export async function mirrorWhatsAppTemplatesToUnifiedRows(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  templates: readonly MirroredWhatsAppTemplate[];
}): Promise<number> {
  const templatesById = new Map(
    params.templates
      .filter(template => template.id)
      .map(template => [String(template.id), template])
  );
  if (templatesById.size === 0) return 0;

  let query = params.supabase
    .from("message_templates")
    .select("id, whatsapp_data")
    .eq("workspace_id", params.workspaceId)
    .in("channel", ["whatsapp", "both"]);
  if (templatesById.size <= MAX_ROW_LOOKUP_IDS) {
    query = query.in("whatsapp_data->>metaTemplateId", [
      ...templatesById.keys(),
    ]);
  }
  const { data: rows, error } = await query;
  if (error) {
    throw new Error(`Failed to read stored templates: ${error.message}`);
  }

  let updated = 0;
  const failures: string[] = [];
  for (const row of rows ?? []) {
    const stored = asNullableRecord(
      row.whatsapp_data
    ) as WhatsAppTemplateData | null;
    const template = stored?.metaTemplateId
      ? templatesById.get(String(stored.metaTemplateId))
      : undefined;
    if (!stored || !template) continue;

    const next = mergeMetaTemplateIntoUnifiedData(stored, template);
    if (isDeepStrictEqual(next, stored)) continue;

    const { error: updateError } = await params.supabase
      .from("message_templates")
      .update({ whatsapp_data: next })
      .eq("id", row.id)
      .eq("workspace_id", params.workspaceId);
    if (updateError) {
      failures.push(`${row.id}: ${updateError.message}`);
      continue;
    }
    updated += 1;
  }
  if (failures.length > 0) {
    throw new Error(`Failed to update stored templates ${failures.join("; ")}`);
  }
  return updated;
}

export type WhatsAppTemplateMirrorResult = {
  /** Whether the cache held this template and now holds Meta's version. */
  snapshotUpdated: boolean;
  unifiedRows: number;
  /** One message per copy that could not be written. */
  errors: string[];
};

/**
 * Writes Meta's version of one template into both copies. Each copy is
 * written on its own, so one failing store never holds back the other.
 */
export async function mirrorWhatsAppTemplate(params: {
  supabase: SupabaseClient;
  workspaceId: string;
  template: MirroredWhatsAppTemplate;
}): Promise<WhatsAppTemplateMirrorResult> {
  const [snapshot, rows] = await Promise.allSettled([
    refreshCachedTemplateSnapshot(params.workspaceId, params.template),
    mirrorWhatsAppTemplatesToUnifiedRows({
      supabase: params.supabase,
      workspaceId: params.workspaceId,
      templates: [params.template],
    }),
  ]);
  const errors = [snapshot, rows].flatMap(result =>
    result.status === "rejected"
      ? [
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        ]
      : []
  );
  return {
    snapshotUpdated: snapshot.status === "fulfilled" && snapshot.value,
    unifiedRows: rows.status === "fulfilled" ? rows.value : 0,
    errors,
  };
}
