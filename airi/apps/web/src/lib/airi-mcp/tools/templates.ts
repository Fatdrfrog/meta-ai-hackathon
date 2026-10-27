import { readDate } from "@icecore/shared/lib/value-utils";
import {
  asNullableWhatsAppRecord,
  compactWhatsAppString,
} from "@icecore/shared/lib/whatsapp/value-utils";
import type {
  WhatsAppTemplateCategory,
  WhatsAppTemplateQuality,
  WhatsAppTemplateStatus,
} from "@icecore/shared/types/whatsapp";
import { z } from "zod";
import { boundedMultilineText, boundedText } from "../redaction";
import type { AiriMcpTemplateRecord } from "../types";
import {
  arraySchema,
  BOOLEAN_SCHEMA,
  COUNT_SCHEMA,
  defineAiriMcpTool,
  enumSchema,
  NULLABLE_DATE_TIME_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  nullableObjectSchema,
  objectSchema,
  STRING_SCHEMA,
} from "./define";

export const TEMPLATE_STATUSES = [
  "APPROVED",
  "PENDING",
  "REJECTED",
  "PAUSED",
  "LIMIT_EXCEEDED",
] as const satisfies readonly WhatsAppTemplateStatus[];
const TEMPLATE_CATEGORIES = [
  "MARKETING",
  "UTILITY",
  "AUTHENTICATION",
] as const satisfies readonly WhatsAppTemplateCategory[];
const TEMPLATE_QUALITIES = [
  "GREEN",
  "YELLOW",
  "RED",
] as const satisfies readonly WhatsAppTemplateQuality[];

export const TEMPLATES_MAX_LIMIT = 100;
const TEMPLATES_DEFAULT_LIMIT = 50;
/** WhatsApp allows at most ten buttons per template. */
const MAX_BUTTONS = 10;

export const listWhatsAppTemplatesArgs = z
  .object({
    status: z.enum(TEMPLATE_STATUSES).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(TEMPLATES_MAX_LIMIT)
      .default(TEMPLATES_DEFAULT_LIMIT),
  })
  .strict();

function pickKnown<T extends string>(
  values: readonly T[],
  value: unknown
): T | null {
  return values.find(candidate => candidate === value) ?? null;
}

/**
 * Header format, texts with their {{n}} placeholders, and button types and
 * labels. URLs, phone numbers, Flow ids and media handles are never copied.
 */
export function summarizeTemplateComponents(components: unknown) {
  const summary = {
    header: null as { format: string | null; text: string | null } | null,
    body_text: null as string | null,
    footer_text: null as string | null,
    buttons: [] as Array<{ type: string; text: string | null }>,
    carousel_card_count: 0,
  };
  if (!Array.isArray(components)) return summary;

  for (const entry of components) {
    const component = asNullableWhatsAppRecord(entry);
    const type = compactWhatsAppString(component?.type)?.toUpperCase();
    if (!component || !type) continue;
    if (type === "HEADER") {
      const format =
        compactWhatsAppString(component.format)?.toUpperCase() ?? null;
      summary.header = {
        format,
        text: format === "TEXT" ? boundedText(component.text, 200) : null,
      };
    } else if (type === "BODY") {
      summary.body_text = boundedMultilineText(component.text, 1200);
    } else if (type === "FOOTER") {
      summary.footer_text = boundedText(component.text, 200);
    } else if (type === "BUTTONS" && Array.isArray(component.buttons)) {
      for (const rawButton of component.buttons.slice(0, MAX_BUTTONS)) {
        const button = asNullableWhatsAppRecord(rawButton);
        if (!button) continue;
        summary.buttons.push({
          type: compactWhatsAppString(button.type)?.toUpperCase() ?? "UNKNOWN",
          text: boundedText(button.text, 60),
        });
      }
    } else if (type === "CAROUSEL" && Array.isArray(component.cards)) {
      summary.carousel_card_count = component.cards.length;
    }
  }
  return summary;
}

export function serializeTemplate(template: AiriMcpTemplateRecord) {
  const rejectionReason = boundedText(template.rejected_reason, 200);
  return {
    name: boundedText(template.name, 512) ?? "",
    language: boundedText(template.language, 20),
    category: pickKnown(TEMPLATE_CATEGORIES, template.category),
    status: pickKnown(TEMPLATE_STATUSES, template.status),
    quality_rating: pickKnown(TEMPLATE_QUALITIES, template.quality_rating),
    // Meta reports "NONE" for templates that were never rejected.
    rejection_reason:
      rejectionReason && rejectionReason.toUpperCase() !== "NONE"
        ? rejectionReason
        : null,
    last_synced_at: readDate(template.lastSyncedAt)?.toISOString() ?? null,
    components: summarizeTemplateComponents(template.components),
  };
}

const templateSchema = objectSchema({
  name: STRING_SCHEMA,
  language: NULLABLE_STRING_SCHEMA,
  category: { type: ["string", "null"], enum: [...TEMPLATE_CATEGORIES, null] },
  status: { type: ["string", "null"], enum: [...TEMPLATE_STATUSES, null] },
  quality_rating: {
    type: ["string", "null"],
    enum: [...TEMPLATE_QUALITIES, null],
  },
  rejection_reason: NULLABLE_STRING_SCHEMA,
  last_synced_at: NULLABLE_DATE_TIME_SCHEMA,
  components: objectSchema({
    header: nullableObjectSchema({
      format: NULLABLE_STRING_SCHEMA,
      text: NULLABLE_STRING_SCHEMA,
    }),
    body_text: NULLABLE_STRING_SCHEMA,
    footer_text: NULLABLE_STRING_SCHEMA,
    buttons: arraySchema(
      objectSchema({ type: STRING_SCHEMA, text: NULLABLE_STRING_SCHEMA }),
      MAX_BUTTONS
    ),
    carousel_card_count: COUNT_SCHEMA,
  }),
});

const SNAPSHOT_NOTE =
  "Read from Airi's stored copy of the WhatsApp template catalog, refreshed when the workspace syncs templates with Meta. Templates created or edited in Meta since the last sync can be missing or outdated.";

export const listWhatsAppTemplatesTool = defineAiriMcpTool({
  name: "list_whatsapp_templates",
  title: "List WhatsApp templates",
  description:
    "WhatsApp message templates stored for this workspace: name, language, category, status, quality rating, rejection reason, a component summary (header format, body text with {{n}} placeholders, footer, button types and labels) and when each was last synced. Reads Airi's stored catalog only and never contacts Meta.",
  scope: "catalog",
  inputSchema: objectSchema(
    {
      status: enumSchema(TEMPLATE_STATUSES),
      limit: {
        type: "integer",
        minimum: 1,
        maximum: TEMPLATES_MAX_LIMIT,
        default: TEMPLATES_DEFAULT_LIMIT,
        description: "Maximum templates to return, sorted by name.",
      },
    },
    []
  ),
  outputSchema: objectSchema({
    status_filter: {
      type: ["string", "null"],
      enum: [...TEMPLATE_STATUSES, null],
    },
    limit: COUNT_SCHEMA,
    returned: COUNT_SCHEMA,
    has_more: BOOLEAN_SCHEMA,
    catalog: objectSchema({
      source: { type: "string", const: "stored_snapshot" },
      latest_synced_at: NULLABLE_DATE_TIME_SCHEMA,
      notes: arraySchema(STRING_SCHEMA),
    }),
    templates: arraySchema(templateSchema, TEMPLATES_MAX_LIMIT),
  }),
  args: listWhatsAppTemplatesArgs,
  async run({ status, limit }, { auth, data }) {
    const result = await data.listWhatsAppTemplates({
      workspaceId: auth.workspaceId,
      limit,
      status,
    });
    const templates = result.rows.slice(0, limit).map(serializeTemplate);
    const latestSyncedAt = templates.reduce<string | null>(
      (latest, template) =>
        template.last_synced_at && (!latest || template.last_synced_at > latest)
          ? template.last_synced_at
          : latest,
      null
    );
    const more = result.hasMore
      ? ` More exist; filter by status or raise the limit (up to ${TEMPLATES_MAX_LIMIT}).`
      : "";

    return {
      summary: `Returned ${templates.length} stored WhatsApp template(s).${more}`,
      structured: {
        status_filter: status ?? null,
        limit,
        returned: templates.length,
        has_more: result.hasMore,
        catalog: {
          source: "stored_snapshot",
          latest_synced_at: latestSyncedAt,
          notes: [SNAPSHOT_NOTE],
        },
        templates,
      },
      itemCount: templates.length,
    };
  },
});
