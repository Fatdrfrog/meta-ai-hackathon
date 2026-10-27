import { normalizeWhatsAppTemplateLanguageForSend } from "@icecore/shared/constants/whatsapp-templates";
import type {
  WhatsAppTemplate,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";

import connectDB from "@/lib/mongoose";
import type { WhatsAppSourceReader } from "@/lib/whatsapp/account/resolution";
import type {
  WhatsAppTemplateCatalogMetadata,
  WhatsAppTemplateCatalogResult,
} from "@/lib/whatsapp/templates/catalog-contracts";
import { listTemplates } from "@/lib/whatsapp/templates/service";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import { WhatsAppTemplateCatalogError } from "./catalog-contracts";
import { getTemplateHeaderMedia, isWhatsAppCdnUrl } from "./header-media-utils";
import type { WhatsAppTemplateSendComponentInput } from "./message-types";

type ListApprovedTemplatesForSendOptions = {
  limit?: number;
  sourceId?: string;
  force?: boolean;
  /** Server-only source reader for callers without a user session. */
  supabase?: WhatsAppSourceReader;
};

type FindApprovedTemplateForSendOptions =
  ListApprovedTemplatesForSendOptions & {
    workspaceId: string;
    templateName: string;
    languageCode: string;
    templates?: WhatsAppTemplate[];
    /** When true (default), fall back to live Graph if Mongo cache misses. */
    allowLiveFetch?: boolean;
  };

export type ResolveApprovedWhatsAppTemplateForSendResult = {
  template: WhatsAppTemplate | null;
  sameNameLanguages: string[];
  source: "cache" | "live" | "client" | "none";
  /** The live catalog's freshness, when this lookup read it. */
  catalog?: WhatsAppTemplateCatalogMetadata;
};

type ResolveApprovedTemplateForSendOptions =
  FindApprovedTemplateForSendOptions & {
    fallbackCategory?: string | null;
    fallbackComponents?: WhatsAppTemplate["components"] | null;
  };

function isApprovedWhatsAppTemplateCategory(
  value: unknown
): value is WhatsAppTemplateCategory {
  return (
    value === "MARKETING" || value === "UTILITY" || value === "AUTHENTICATION"
  );
}

function pickApprovedTemplateByNameAndLanguage(
  templates: WhatsAppTemplate[],
  templateName: string,
  languageCode: string
): WhatsAppTemplate | null {
  const requestedLanguage =
    normalizeWhatsAppTemplateLanguageForSend(languageCode);

  return (
    templates.find(
      template =>
        template.name === templateName &&
        template.status === "APPROVED" &&
        normalizeWhatsAppTemplateLanguageForSend(template.language) ===
          requestedLanguage
    ) ?? null
  );
}

function collectSameNameLanguages(
  templates: WhatsAppTemplate[],
  templateName: string
): string[] {
  return templates
    .filter(
      template =>
        template.name === templateName && template.status === "APPROVED"
    )
    .map(template => template.language);
}

function mapCachedTemplateDoc(doc: {
  templateId?: string;
  name: string;
  language: string;
  status: WhatsAppTemplate["status"];
  category: WhatsAppTemplateCategory;
  previous_category?: WhatsAppTemplateCategory;
  quality_rating?: WhatsAppTemplate["quality_rating"];
  optimization_spec?: WhatsAppTemplate["optimization_spec"];
  components?: WhatsAppTemplate["components"];
  rejected_reason?: string;
}): WhatsAppTemplate {
  return {
    id: doc.templateId || `${doc.name}_${doc.language}`,
    name: doc.name,
    language: doc.language,
    status: doc.status,
    category: doc.category,
    previous_category: doc.previous_category,
    quality_rating: doc.quality_rating,
    optimization_spec: doc.optimization_spec,
    components: doc.components,
    rejected_reason: doc.rejected_reason,
  };
}

async function listCachedApprovedWhatsAppTemplatesForSend(params: {
  workspaceId: string;
  templateName?: string;
}): Promise<WhatsAppTemplate[]> {
  await connectDB();

  const query: {
    workspaceId: string;
    status: "APPROVED";
    name?: string;
  } = {
    workspaceId: params.workspaceId,
    status: "APPROVED",
  };
  if (params.templateName) {
    query.name = params.templateName;
  }

  const docs = await WhatsAppTemplateModel.find(query)
    .select(
      "templateId name language status category previous_category quality_rating optimization_spec components rejected_reason"
    )
    .lean<
      Array<{
        templateId?: string;
        name: string;
        language: string;
        status: WhatsAppTemplate["status"];
        category: WhatsAppTemplateCategory;
        previous_category?: WhatsAppTemplateCategory;
        quality_rating?: WhatsAppTemplate["quality_rating"];
        optimization_spec?: WhatsAppTemplate["optimization_spec"];
        components?: WhatsAppTemplate["components"];
        rejected_reason?: string;
      }>
    >()
    .catch(() => []);

  return docs.map(mapCachedTemplateDoc);
}

/**
 * Live APPROVED templates and the catalog's freshness. A stale catalog can
 * miss a template that exists in Meta; see
 * staleWhatsAppTemplateCatalogMissError.
 */
export async function readApprovedWhatsAppTemplatesForSend(
  workspaceId: string,
  options: ListApprovedTemplatesForSendOptions = {}
): Promise<WhatsAppTemplateCatalogResult> {
  const { templates, catalog } = await listTemplates(workspaceId, {
    status: "APPROVED",
    ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
    ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
    ...(options.supabase ? { supabase: options.supabase } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
  });

  return {
    templates: templates.filter(template => template.status === "APPROVED"),
    catalog,
  };
}

export async function listApprovedWhatsAppTemplatesForSend(
  workspaceId: string,
  options: ListApprovedTemplatesForSendOptions = {}
): Promise<WhatsAppTemplate[]> {
  const { templates } = await readApprovedWhatsAppTemplatesForSend(
    workspaceId,
    options
  );
  return templates;
}

/**
 * Prefer Mongo APPROVED snapshots, then optional client payload, then live Graph.
 * Avoids a WABA management `message_templates` call on every bulk send when cache hits.
 */
export async function resolveApprovedWhatsAppTemplateForSend(
  options: ResolveApprovedTemplateForSendOptions
): Promise<ResolveApprovedWhatsAppTemplateForSendResult> {
  const {
    workspaceId,
    templateName,
    languageCode,
    templates,
    limit,
    sourceId,
    supabase,
    allowLiveFetch = true,
    fallbackCategory,
    fallbackComponents,
  } = options;

  if (templates) {
    const template = pickApprovedTemplateByNameAndLanguage(
      templates,
      templateName,
      languageCode
    );
    return {
      template,
      sameNameLanguages: collectSameNameLanguages(templates, templateName),
      source: template ? "live" : "none",
    };
  }

  const cachedTemplates = await listCachedApprovedWhatsAppTemplatesForSend({
    workspaceId,
    templateName,
  });
  const cachedTemplate = pickApprovedTemplateByNameAndLanguage(
    cachedTemplates,
    templateName,
    languageCode
  );
  if (cachedTemplate) {
    return {
      template: cachedTemplate,
      sameNameLanguages: collectSameNameLanguages(
        cachedTemplates,
        templateName
      ),
      source: "cache",
    };
  }

  const hasClientFallback =
    isApprovedWhatsAppTemplateCategory(fallbackCategory) &&
    Array.isArray(fallbackComponents);
  if (hasClientFallback) {
    return {
      template: {
        id: `${templateName}_${languageCode}`,
        name: templateName,
        language: languageCode,
        status: "APPROVED",
        category: fallbackCategory,
        components: fallbackComponents,
      },
      sameNameLanguages: collectSameNameLanguages(
        cachedTemplates,
        templateName
      ),
      source: "client",
    };
  }

  if (!allowLiveFetch) {
    return {
      template: null,
      sameNameLanguages: collectSameNameLanguages(
        cachedTemplates,
        templateName
      ),
      source: "none",
    };
  }

  const { templates: liveTemplates, catalog } =
    await readApprovedWhatsAppTemplatesForSend(workspaceId, {
      limit,
      sourceId,
      supabase,
    });
  const liveTemplate = pickApprovedTemplateByNameAndLanguage(
    liveTemplates,
    templateName,
    languageCode
  );

  return {
    template: liveTemplate,
    sameNameLanguages: collectSameNameLanguages(liveTemplates, templateName),
    source: liveTemplate ? "live" : "none",
    ...(catalog ? { catalog } : {}),
  };
}

export async function findApprovedWhatsAppTemplateForSend(
  options: FindApprovedTemplateForSendOptions
): Promise<WhatsAppTemplate | null> {
  const resolved = await resolveApprovedWhatsAppTemplateForSend(options);
  return resolved.template;
}

function hasProviderMedia(
  components?: WhatsAppTemplateSendComponentInput[]
): boolean {
  return !!components?.some(component => {
    if (component.type === "carousel")
      return component.cards.some(card => hasProviderMedia(card.components));
    return (
      component.type === "header" &&
      component.parameters.some(parameter => {
        const media =
          parameter.type === "image"
            ? parameter.image
            : parameter.type === "video"
              ? parameter.video
              : parameter.type === "document"
                ? parameter.document
                : undefined;
        return !!media?.link && !media.id && isWhatsAppCdnUrl(media.link);
      })
    );
  });
}

/** Refresh the signature only for the same sample asset; never replace a custom binding. */
function sameProviderAsset(left: string, right: string): boolean {
  if (!isWhatsAppCdnUrl(left) || !isWhatsAppCdnUrl(right)) return false;
  const a = new URL(left);
  const b = new URL(right);
  return (
    a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
  );
}

function refreshSampleLinks<T extends WhatsAppTemplateSendComponentInput>(
  components: T[],
  definitions: WhatsAppTemplate["components"],
  policy: { useTemplateMedia?: boolean; requireMatchingSample?: boolean }
): T[] {
  return components.map(component => {
    if (component.type === "carousel") {
      const definition = definitions?.find(item => item.type === "CAROUSEL");
      if (definition?.type !== "CAROUSEL") {
        if (
          (policy.useTemplateMedia || policy.requireMatchingSample) &&
          hasProviderMedia([component])
        )
          throw new Error(
            "The current template has no matching media carousel. The message has not been sent."
          );
        return component;
      }
      return {
        ...component,
        cards: component.cards.map(card => ({
          ...card,
          components: refreshSampleLinks(
            card.components,
            definition.cards[card.card_index]?.components,
            policy
          ),
        })),
      };
    }
    if (component.type !== "header") return component;
    const sample = getTemplateHeaderMedia(definitions);
    return {
      ...component,
      parameters: component.parameters.map(parameter => {
        const media =
          parameter.type === "image"
            ? parameter.image
            : parameter.type === "video"
              ? parameter.video
              : parameter.type === "document"
                ? parameter.document
                : undefined;
        if (!media?.link || media.id || !isWhatsAppCdnUrl(media.link))
          return parameter;
        if (!sample?.url || sample.format.toLowerCase() !== parameter.type) {
          if (policy.useTemplateMedia || policy.requireMatchingSample)
            throw new Error(
              "The current template header no longer matches the prepared media. The message has not been sent."
            );
          return parameter;
        }
        const link = sample.url;
        if (!policy.useTemplateMedia && !sameProviderAsset(media.link, link)) {
          if (policy.requireMatchingSample)
            throw new Error(
              "The prepared template media could not be matched to the sending account. The message has not been sent."
            );
          return parameter;
        }
        if (parameter.type === "image")
          return { ...parameter, image: { ...parameter.image, link } };
        if (parameter.type === "video")
          return { ...parameter, video: { ...parameter.video, link } };
        if (parameter.type === "document")
          return { ...parameter, document: { ...parameter.document, link } };
        return parameter;
      }),
    };
  }) as T[];
}

/**
 * Required media preparation belongs at delivery, after the durable send intent
 * exists and before the provider boundary. Language selection is best-effort;
 * this read must never turn a failed refresh into use of an expired snapshot.
 * Compose the account-authorized catalog and its shared lock/cooldown instead
 * of adding a second Graph reader or an independent timeout race.
 */
export async function refreshWhatsAppTemplateMediaForSend(params: {
  workspaceId: string;
  sourceId?: string;
  expectedWabaId?: string;
  templateName: string;
  languageCode: string;
  components?: WhatsAppTemplateSendComponentInput[];
  supabase: WhatsAppSourceReader;
  force?: boolean;
  /** Set only when the canonical template builder supplied the media default. */
  useTemplateMedia?: boolean;
  /** Legacy scenario intents lack provenance and must prove the same sample. */
  requireMatchingSample?: boolean;
}): Promise<WhatsAppTemplateSendComponentInput[] | undefined> {
  if (!hasProviderMedia(params.components)) return params.components;
  const { templates, catalog } = await readApprovedWhatsAppTemplatesForSend(
    params.workspaceId,
    {
      sourceId: params.sourceId,
      supabase: params.supabase,
      ...(params.force !== undefined ? { force: params.force } : {}),
    }
  );
  if (
    !catalog ||
    catalog.stale ||
    !params.expectedWabaId ||
    catalog.wabaId !== params.expectedWabaId
  ) {
    throw new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      message:
        "Template media could not be verified for the sending WhatsApp account. The message has not been sent.",
      retryAt: catalog?.retryAt,
    });
  }
  const template = pickApprovedTemplateByNameAndLanguage(
    templates,
    params.templateName,
    params.languageCode
  );
  if (!template) {
    throw new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      message:
        "The media template is no longer available in the sending WhatsApp account. The message has not been sent.",
    });
  }
  return refreshSampleLinks(params.components!, template.components, params);
}
