import type {
  ScenarioAudienceOptions,
  ScenarioNodeData,
  ScenarioWhatsAppTemplate,
  ScenarioWhatsAppTemplatePreview,
} from "../../types";
import { normalizeEditableTemplateFlowId } from "@/lib/scenarios/whatsapp-template-flow";
import {
  buildScenarioTemplateSampleContext,
  buildScenarioTemplateSlots,
  hasScenarioTemplateTokens,
  isScenarioPromptInputKey,
  renderScenarioTemplate,
  type ScenarioFormAnswerSource,
  type ScenarioTemplateContext,
} from "@icecore/scenario-contracts";
import { resolveScenarioTokenLabel } from "../scenario-template-utils";

export {
  canEditFlowForWhatsAppTemplateComponents,
  getSingleFlowIdFromWhatsAppTemplateComponents,
} from "@/lib/scenarios/whatsapp-template-flow";

export type ScenarioPreviewContext = Record<string, unknown>;

type ScenarioAudienceCustomer = ScenarioAudienceOptions["customers"][number];

export type ScenarioPreviewAudienceFilter = Pick<
  ScenarioNodeData,
  | "audienceMode"
  | "audienceFunnelStage"
  | "audienceLastSeenDays"
  | "classificationCategory"
  | "customerIds"
  | "internalLabel"
>;

export type ScenarioPreviewProfile = {
  channel?: string;
  customerId?: string;
  customerName?: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerUsername?: string;
  preferredLanguage?: string;
  waId?: string;
};

function inferPreviewFirstName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Customer";
  const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const firstToken =
    normalized.split(/[ _-]+/).filter(Boolean)[0] || normalized;
  return firstToken.length > 24 ? firstToken.slice(0, 24) : firstToken;
}

function inferPreviewWaId(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 6) return digits;
  return "77011234567";
}

export function hasConfiguredAudienceFilterInNode(
  nodeData?: Partial<ScenarioNodeData>
): boolean {
  if (!nodeData) return false;
  const mode = nodeData.audienceMode;
  if (!mode || mode === "all") return false;
  if (mode === "classification") {
    return Boolean(nodeData.classificationCategory);
  }
  if (mode === "internalLabel") {
    return Boolean(nodeData.internalLabel);
  }
  if (mode === "specificCustomers") {
    return (
      Array.isArray(nodeData.customerIds) && nodeData.customerIds.length > 0
    );
  }
  if (mode === "has_purchase_history") return true;
  if (mode === "funnel_stage") {
    return Boolean(
      (nodeData.audienceFunnelStage || "").trim() ||
        (nodeData.classificationCategory || "").trim()
    );
  }
  if (mode === "last_seen_greater_than_x_days" || mode === "last_seen_days") {
    return (
      typeof nodeData.audienceLastSeenDays === "number" &&
      Number.isFinite(nodeData.audienceLastSeenDays) &&
      nodeData.audienceLastSeenDays >= 1
    );
  }
  return false;
}

export function pickSampleAudienceCustomer(params: {
  audienceNode?: ScenarioPreviewAudienceFilter;
  customers: ScenarioAudienceCustomer[];
  preferredChannel?: string;
}): ScenarioAudienceCustomer | null {
  const customers = params.customers;
  if (customers.length === 0) return null;

  const preferredChannel = (params.preferredChannel || "").trim();
  const byChannel = preferredChannel
    ? customers.filter(customer => customer.channel === preferredChannel)
    : customers;
  const candidatePool = byChannel.length > 0 ? byChannel : customers;

  const mode = params.audienceNode?.audienceMode;
  if (!mode || mode === "all") {
    return candidatePool[0] || customers[0] || null;
  }

  if (mode === "specificCustomers") {
    const ids = Array.isArray(params.audienceNode?.customerIds)
      ? params.audienceNode.customerIds.filter(Boolean)
      : [];
    for (const id of ids) {
      const match = customers.find(customer => customer.id === id);
      if (match) return match;
    }
    return candidatePool[0] || customers[0] || null;
  }

  if (mode === "classification") {
    const targetCategory = (
      params.audienceNode?.classificationCategory || ""
    ).trim();
    const match = candidatePool.find(
      customer => (customer.category || "").trim() === targetCategory
    );
    return match || candidatePool[0] || customers[0] || null;
  }

  if (mode === "internalLabel") {
    const targetLabel = (params.audienceNode?.internalLabel || "").trim();
    const match = candidatePool.find(customer =>
      (customer.internalLabels || []).includes(targetLabel)
    );
    return match || candidatePool[0] || customers[0] || null;
  }

  if (mode === "has_purchase_history") {
    const match = candidatePool.find(customer => customer.hasPurchaseHistory);
    return match || candidatePool[0] || customers[0] || null;
  }

  if (mode === "funnel_stage") {
    const targetStage = (
      params.audienceNode?.audienceFunnelStage ||
      params.audienceNode?.classificationCategory ||
      ""
    )
      .trim()
      .toLowerCase();
    const match = candidatePool.find(customer => {
      const segment = (customer.segmentKey || "").trim().toLowerCase();
      return Boolean(targetStage) && segment === targetStage;
    });
    return match || candidatePool[0] || customers[0] || null;
  }

  if (mode === "last_seen_greater_than_x_days" || mode === "last_seen_days") {
    const minDays = Math.max(
      1,
      Math.floor(Number(params.audienceNode?.audienceLastSeenDays || 0))
    );
    const now = Date.now();
    const match = candidatePool.find(customer => {
      if (!customer.lastMessageAt) return false;
      const lastSeen = new Date(customer.lastMessageAt).getTime();
      if (!Number.isFinite(lastSeen)) return false;
      const elapsedDays = (now - lastSeen) / (24 * 60 * 60 * 1000);
      return elapsedDays >= minDays;
    });
    return match || candidatePool[0] || customers[0] || null;
  }

  return candidatePool[0] || customers[0] || null;
}

export function buildPreviewProfileFromCustomer(params: {
  customer: ScenarioAudienceCustomer | null;
  preferredChannel?: string;
  fallbackChannel?: string;
  preferredLanguage?: string;
  translate?: (key: string) => string;
}): ScenarioPreviewProfile {
  const customer = params.customer;
  const fallbackName = params.translate?.("customer") ?? "Customer";
  const customerLabel = customer?.label?.trim() || "";
  const customerName = customerLabel || fallbackName;
  const customerFirstName = inferPreviewFirstName(customerName);
  const nameWithoutFirst =
    customerName.startsWith(customerFirstName) &&
    customerName.length > customerFirstName.length
      ? customerName.slice(customerFirstName.length).trim()
      : "";

  return {
    channel:
      params.preferredChannel ||
      customer?.channel ||
      params.fallbackChannel ||
      "whatsapp",
    customerId: customer?.id || customerLabel || "sample_customer",
    customerName,
    customerFirstName,
    customerLastName: nameWithoutFirst,
    customerUsername:
      customerLabel && customerLabel.startsWith("@")
        ? customerLabel
        : undefined,
    preferredLanguage: params.preferredLanguage || "en",
    waId: inferPreviewWaId(customerLabel),
  };
}

const PREVIEW_SAMPLE_LINK = "https://example.com/book";

type ScenarioPreviewTranslate = (key: string) => string;

function freezePreviewSamples<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezePreviewSamples(item);
    Object.freeze(value);
  }
  return value;
}

function buildPreviewSamples(
  translate: ScenarioPreviewTranslate | undefined
): ScenarioTemplateContext {
  return freezePreviewSamples(
    buildScenarioTemplateSampleContext(
      path => `[${resolveScenarioTokenLabel(path, translate)}]`
    )
  );
}

// The samples depend only on the translator, so each one builds them once.
// They are frozen because every preview context shares them.
const previewSamplesByTranslator = new WeakMap<
  ScenarioPreviewTranslate,
  ScenarioTemplateContext
>();
let untranslatedPreviewSamples: ScenarioTemplateContext | null = null;

/** The labelled sample context for `translate`, built once per translator. */
export function readScenarioPreviewSamples(
  translate?: ScenarioPreviewTranslate
): ScenarioTemplateContext {
  if (!translate) {
    untranslatedPreviewSamples ??= buildPreviewSamples(undefined);
    return untranslatedPreviewSamples;
  }
  const known = previewSamplesByTranslator.get(translate);
  if (known) return known;
  const samples = buildPreviewSamples(translate);
  previewSamplesByTranslator.set(translate, samples);
  return samples;
}

function resolvePreviewCustomer(params: {
  channel?: string;
  profile?: ScenarioPreviewProfile;
  translate?: ScenarioPreviewTranslate;
}) {
  const profile = params.profile ?? {};
  const name =
    profile.customerName || (params.translate?.("customer") ?? "Customer");
  const id = profile.customerId || "sample_customer";
  return {
    name,
    firstName: profile.customerFirstName || inferPreviewFirstName(name),
    lastName: profile.customerLastName || "",
    username: profile.customerUsername || "",
    id,
    channel: profile.channel || params.channel || "whatsapp",
    preferredLanguage: profile.preferredLanguage || "en",
    waId: profile.waId || inferPreviewWaId(id),
  };
}

/** `input.<key>` samples: each collected answer as "[Label]". */
function buildPreviewPromptInputs(
  promptInputs: ReadonlyArray<{ key: string; label: string }> | undefined
): Record<string, string> {
  return Object.fromEntries(
    (promptInputs ?? []).flatMap(field =>
      isScenarioPromptInputKey(field.key)
        ? [[field.key, `[${field.label.trim() || field.key}]`]]
        : []
    )
  );
}

function listPreviewValues(values: string[]): string[] {
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

/**
 * The context the runtime builds, from preview data where there is some.
 * Paths the preview cannot know, such as the trigger message, calendar,
 * countdown and ad referral, show a labelled sample like "[Next free slot]".
 */
export function buildScenarioPreviewContext(params: {
  reply: string;
  links: string[];
  images: string[];
  channel?: string;
  profile?: ScenarioPreviewProfile;
  translate?: ScenarioPreviewTranslate;
  /** Answers this step can use; each previews as its label. */
  promptInputs?: ReadonlyArray<{ key: string; label: string }>;
  /** Forms before this step; each answer previews as its question. */
  formAnswers?: readonly ScenarioFormAnswerSource[];
}): ScenarioTemplateContext {
  const links = listPreviewValues(params.links);
  const images = listPreviewValues(params.images);
  const previewLinks = links.length > 0 ? links : [PREVIEW_SAMPLE_LINK];
  const firstLink = previewLinks[0] || PREVIEW_SAMPLE_LINK;
  const firstImage = images[0] || "";
  const customer = resolvePreviewCustomer(params);
  const samples = readScenarioPreviewSamples(params.translate);

  return {
    ...samples,
    reply: params.reply,
    link: firstLink,
    image: firstImage,
    ...buildScenarioTemplateSlots("link", previewLinks),
    ...buildScenarioTemplateSlots("image", images),
    links: { first: firstLink, count: links.length },
    images: { first: firstImage, count: images.length },
    channel: customer.channel,
    customer: {
      name: customer.name,
      firstName: customer.firstName,
      lastName: customer.lastName,
      username: customer.username,
      id: customer.id,
    },
    whatsappclient: {
      ...samples.whatsappclient,
      name: customer.name,
      wa_id: customer.waId,
    },
    chat: {
      first_name: customer.firstName,
      last_name: customer.lastName,
      username: customer.username,
      title: customer.name,
      id: customer.id,
    },
    conversation: {
      ...samples.conversation,
      id: "preview_conversation",
      channel: customer.channel,
      preferred_language: customer.preferredLanguage,
    },
    first_name: customer.firstName,
    last_name: customer.lastName,
    username: customer.username,
    customer_name: customer.name,
    input: buildPreviewPromptInputs(params.promptInputs),
    form: buildPreviewFormAnswers(params.formAnswers),
  } satisfies ScenarioTemplateContext;
}

/** `form.<formKey>.<fieldKey>` samples: each answer as "[Question]". */
function buildPreviewFormAnswers(
  sources: readonly ScenarioFormAnswerSource[] | undefined
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    (sources ?? []).map(source => [
      source.formKey,
      Object.fromEntries(
        source.fields.map(field => [field.key, `[${field.label}]`])
      ),
    ])
  );
}

/** Renders with the runtime grammar; a missing answer previews empty. */
function renderPreviewText(text: string, context: ScenarioPreviewContext) {
  return renderScenarioTemplate(text, context, "empty");
}

export function buildDraftActionPreviewText(params: {
  template?: string;
  reply: string;
  context: ScenarioPreviewContext;
}): string {
  const template = (params.template || "").trim();
  if (!template) {
    if (!hasScenarioTemplateTokens(params.reply)) return params.reply;
    const renderedReply = renderPreviewText(params.reply, params.context);
    return renderedReply.trim() || params.reply;
  }

  const renderedTemplate = renderPreviewText(template, params.context);
  return renderedTemplate.trim() || params.reply;
}

export function buildWhatsAppTemplatePreview(params: {
  components?: ScenarioWhatsAppTemplate["components"];
  context: ScenarioPreviewContext;
  translate?: (key: string) => string;
  preserveUnresolvedVariables?: boolean;
}): ScenarioWhatsAppTemplatePreview | null {
  const components = params.components;
  if (!Array.isArray(components) || components.length === 0) return null;

  const preview: ScenarioWhatsAppTemplatePreview = {
    bodyText: "",
    buttons: [],
  };
  const renderText = (text: string) =>
    params.preserveUnresolvedVariables
      ? text
      : renderPreviewText(text, params.context);

  for (const component of components) {
    if (component.type === "HEADER") {
      if (component.format === "TEXT" && component.text) {
        preview.headerText = renderText(component.text);
      } else if (
        component.format === "IMAGE" ||
        component.format === "VIDEO" ||
        component.format === "DOCUMENT"
      ) {
        preview.headerMediaFormat = component.format;
      }
      continue;
    }

    if (component.type === "BODY") {
      preview.bodyText = renderText(component.text || "");
      continue;
    }

    if (component.type === "FOOTER") {
      preview.footerText = renderText(component.text || "");
      continue;
    }

    if (component.type === "BUTTONS") {
      component.buttons?.forEach(button => {
        const t = params.translate;
        if (button.type === "URL") {
          preview.buttons.push({
            type: "url",
            label: button.text || (t?.("buttonUrl") ?? "URL"),
            value: renderText(button.url || ""),
          });
          return;
        }
        if (button.type === "PHONE_NUMBER") {
          preview.buttons.push({
            type: "phone",
            label: button.text || (t?.("buttonPhone") ?? "Phone"),
            value: button.phone_number || "",
          });
          return;
        }
        if (button.type === "FLOW") {
          preview.buttons.push({
            type: "flow",
            label: button.text || "Flow",
            flowId: normalizeEditableTemplateFlowId(button.flow_id),
            flowName: button.flow_name,
            flowJson: button.flow_json,
            flowAction: button.flow_action,
            navigateScreen: button.navigate_screen,
          });
          return;
        }
        if (button.type === "OTP") {
          preview.buttons.push({
            type: "copy_code",
            label: button.text || "Copy code",
          });
          return;
        }
        if (button.type === "REQUEST_CONTACT_INFO") {
          preview.buttons.push({
            type: "request_contact_info",
            label: t?.("requestContactInfo") ?? "Request contact info",
          });
          return;
        }
        preview.buttons.push({
          type: "quick_reply",
          label: button.text || (t?.("buttonReply") ?? "Reply"),
        });
      });
    }
  }

  const hasAnyContent =
    Boolean(preview.headerText) ||
    Boolean(preview.headerMediaFormat) ||
    Boolean(preview.bodyText) ||
    Boolean(preview.footerText) ||
    preview.buttons.length > 0;
  return hasAnyContent ? preview : null;
}
