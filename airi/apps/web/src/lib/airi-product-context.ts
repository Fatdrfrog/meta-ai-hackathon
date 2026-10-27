export const AIRI_PRODUCT_CONTEXT_VERSION = "2026-10-21";

export const PUBLIC_BRAND_NAME = "airi.chat";
export const PUBLIC_LEGAL_NAME = "Ais.ii TOO";
export const PUBLIC_LEGAL_ENTITY_TYPE =
  "limited liability partnership registered in the Republic of Kazakhstan";
export const PUBLIC_LEGAL_REGISTRATION_LABEL =
  "Business Identification Number (BIN)";
export const PUBLIC_LEGAL_REGISTRATION_NUMBER = "250640028180";
export const PUBLIC_LEGAL_REGISTERED_ADDRESS =
  "Turan 57G, 2 entrance, 11 floor, apartment 98, Serdtse Stolicy 5, Astana, 010000, Kazakhstan";
export const PUBLIC_SUPPORT_EMAIL = "support@airi.chat";
// Company slug of airi.chat's own published help center (product docs).
export const AIRI_PRODUCT_KB_COMPANY_SLUG = "airichat";

export const PUBLIC_SOCIAL_URLS = [
  "https://www.linkedin.com/company/icecore-ai",
  "https://www.instagram.com/airi.chat__/",
  "https://t.me/airi_chat1",
];

type AiriProductPublicRoute = {
  path: string;
  title: string;
  description: string;
};

type AiriProductContext = {
  version: string;
  brandName: string;
  description: string;
  legalName: string;
  supportEmail: string;
  website: string;
  category: string[];
  audience: string[];
  channels: string[];
  capabilities: string[];
  integrations: string[];
  boundaries: string[];
  entitySignals: string[];
};

type AiriProductContextMetadata = {
  version: string;
  sourceIds: string[];
};

type WorkspaceReadinessItem = {
  available: boolean;
  label: string;
  source?: string;
  sourceId?: string;
  reason?: string;
  actionHref?: string;
};

type WorkspaceReadiness = Partial<
  Record<
    | "whatsapp"
    | "scenarios"
    | "bulkCampaigns"
    | "canva"
    | "visualGeneration"
    | "audioGeneration"
    | "metaAds",
    WorkspaceReadinessItem
  >
>;

const WORKSPACE_READINESS_LABELS: Array<{
  key: keyof WorkspaceReadiness;
  label: string;
}> = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "scenarios", label: "Scenarios" },
  { key: "bulkCampaigns", label: "Bulk campaigns" },
  { key: "canva", label: "Canva" },
  { key: "visualGeneration", label: "Visual generation" },
  { key: "audioGeneration", label: "Audio generation" },
  { key: "metaAds", label: "Meta Ads" },
];

export const AIRI_PRODUCT_CONTEXT: AiriProductContext = {
  version: AIRI_PRODUCT_CONTEXT_VERSION,
  brandName: PUBLIC_BRAND_NAME,
  description:
    "airi.chat is an AI engagement assistant that helps teams build useful bulk campaigns and follow-ups from customer chats and knowledge base context.",
  legalName: PUBLIC_LEGAL_NAME,
  supportEmail: PUBLIC_SUPPORT_EMAIL,
  website: "https://www.airi.chat",
  category: [
    "WhatsApp marketing campaign platform",
    "WhatsApp marketing automation",
    "customer engagement platform",
    "AI follow-up automation",
  ],
  audience: [
    "marketing teams",
    "sales teams",
    "e-commerce and retail teams",
    "service businesses such as clinics, schools, and studios",
    "growth teams running high-volume customer conversations",
  ],
  channels: [
    "WhatsApp Business Platform",
    "Instagram",
    "Telegram",
    "email",
    "website chat",
  ],
  capabilities: [
    "Keeps WhatsApp Business Platform, Instagram, Telegram, email, and website chat conversations in one shared team workspace.",
    "Helps teams draft and review WhatsApp templates with names, languages, categories, bodies, examples, and compliant buttons.",
    "Helps teams draft and review WhatsApp Flows for lead capture, booking, surveys, quizzes, and structured customer journeys.",
    "Helps teams plan official WhatsApp bulk campaigns, approved-template sends, reply-aware follow-ups, and audience journeys.",
    "Sends marketing templates through Meta's Marketing Messages API when the WhatsApp Business Account is onboarded, and checks sending readiness, opt-outs, contact frequency, and recipients who failed before each campaign.",
    "Builds scenarios for customer follow-ups, handoffs, reminders, and engagement workflows from workspace context.",
    "Answers customer questions in chats from a team's knowledge base, FAQs, product docs, indexed URLs, answer snippets, and quick replies, and hands the chat to the team when a person should take over.",
    "Reports campaign delivery, replies, follow-ups, and the sales recorded after campaigns, and compares Meta ad spend with the qualified chats and paid sales that followed.",
    "Supports engagement content planning with Canva, Higgsfield or Google visual generation, ElevenLabs audio, and Meta Ads context when the workspace has the required tools available.",
  ],
  integrations: [
    "WhatsApp Business Platform for templates, Flows, customer conversations, and campaigns.",
    "Canva for design planning and brand-approved creative workflows when connected.",
    "Higgsfield or Google creative generation for visual assets when workspace access and generation infrastructure are available.",
    "ElevenLabs for voiceovers and audio assets when a workspace source is connected.",
    "Meta Ads for ad planning and campaign context when connected.",
    "Meta Ads MCP via the @meta skill for live reporting and confirmed campaign mutations when Ads MCP is enabled.",
    "Airi.chat MCP server (beta, read-only) at https://www.airi.chat/api/mcp: Claude Code, OpenAI Codex, Cursor and other MCP clients read workspace analytics and conversation metadata with a workspace API key. Template and scenario tools are enabled per key on request.",
  ],
  boundaries: [
    "Do not claim that an external asset, ad, WhatsApp template, WhatsApp Flow, bulk campaign, or scenario was created, sent, published, connected, or approved unless the existing backend action actually completed it.",
    "For @meta / Meta Ads MCP write tools, wait for explicit user confirmation before claiming a mutation ran.",
    "The Airi.chat MCP server is read-only: do not claim it can send messages, start campaigns, or edit templates or scenarios.",
    "Distinguish product support from current workspace readiness: airi.chat may support a capability while a specific workspace still needs an integration, approval, template, or configuration.",
    "Do not expose or rely on data from an internal Airi company workspace when answering product capability questions for another workspace.",
    "Ground platform how-to answers in published airi.chat knowledge-base articles. Do not invent missing setup steps and do not refuse because this tenant's knowledge base is empty.",
    "Do not use unpublished Airi conversations or internal Airi workspace chats as product documentation.",
    "For regulated WhatsApp actions, ask the user to review and confirm before publishing, sending, or mutating live resources.",
  ],
  entitySignals: [
    "Brand names: airi.chat, Airi.chat, Airi",
    `Legal company: ${PUBLIC_LEGAL_NAME}`,
    `Legal entity type: ${PUBLIC_LEGAL_ENTITY_TYPE}`,
    `Legal identifier: ${PUBLIC_LEGAL_REGISTRATION_LABEL} ${PUBLIC_LEGAL_REGISTRATION_NUMBER}`,
    `Registered address: ${PUBLIC_LEGAL_REGISTERED_ADDRESS}`,
    "Founders: Aisulu Kalshabekova, Samat Kalshabekov",
    `Public support email: ${PUBLIC_SUPPORT_EMAIL}`,
    `Public social profiles: ${PUBLIC_SOCIAL_URLS.join(", ")}`,
  ],
};

const AIRI_PRODUCT_SOURCE_IDS = [
  `airi_product:${AIRI_PRODUCT_CONTEXT_VERSION}:capabilities`,
  `airi_product:${AIRI_PRODUCT_CONTEXT_VERSION}:integrations`,
  `airi_product:${AIRI_PRODUCT_CONTEXT_VERSION}:boundaries`,
] as const;

function listSection(title: string, items: string[]): string {
  return [`## ${title}`, ...items.map(item => `- ${item}`)].join("\n");
}

export function getAiriProductContextMetadata(): AiriProductContextMetadata {
  return {
    version: AIRI_PRODUCT_CONTEXT_VERSION,
    sourceIds: [...AIRI_PRODUCT_SOURCE_IDS],
  };
}

export function buildAiriProductCapabilityPromptContext(
  context: AiriProductContext = AIRI_PRODUCT_CONTEXT
): string {
  return [
    "AIRI.CHAT PRODUCT CAPABILITIES",
    `Version: ${context.version}`,
    `Brand: ${context.brandName}`,
    `Description: ${context.description}`,
    `Website: ${context.website}`,
    `Category: ${context.category.join("; ")}`,
    `Primary audience: ${context.audience.join(", ")}`,
    `Channels: ${context.channels.join(", ")}`,
    listSection("Supported Work", context.capabilities),
    listSection("Integrations", context.integrations),
    listSection("Boundaries", context.boundaries),
  ].join("\n\n");
}

export function buildAiriProductWorkspaceReadinessContext(
  readiness: WorkspaceReadiness | null | undefined
): string {
  if (!readiness) {
    return [
      "CURRENT WORKSPACE READINESS",
      "- Workspace tool readiness is unavailable. Explain product capabilities, then say what should be connected or checked before using live actions.",
    ].join("\n");
  }

  const lines = WORKSPACE_READINESS_LABELS.map(({ key, label }) => {
    const item = readiness[key];
    if (!item) return `- ${label}: unknown.`;
    const source = item.source ? ` (${item.source})` : "";
    if (item.available) {
      const sourceId = item.sourceId ? `, source ${item.sourceId}` : "";
      return `- ${label}: ready as ${item.label}${source}${sourceId}.`;
    }
    const reason = item.reason ? ` ${item.reason}` : "";
    const action = item.actionHref ? ` Action: ${item.actionHref}` : "";
    return `- ${label}: not ready.${reason}${action}`;
  });

  return ["CURRENT WORKSPACE READINESS", ...lines].join("\n");
}

export function buildAiriProductLlmsTxt(params: {
  baseUrl: string;
  routes: AiriProductPublicRoute[];
  context?: AiriProductContext;
}): string {
  const context = params.context ?? AIRI_PRODUCT_CONTEXT;
  const baseUrl = params.baseUrl.replace(/\/$/, "");
  const pages = params.routes
    .filter(route => route.path !== "/")
    .map(route => {
      const normalizedPath = route.path.startsWith("/")
        ? route.path
        : `/${route.path}`;
      const url = `${baseUrl}${normalizedPath === "/" ? "" : normalizedPath}`;
      return `- ${route.title}: ${url} - ${route.description}`;
    })
    .join("\n");

  return `# ${context.brandName}

> ${context.description}

Version: ${context.version}
Website: ${baseUrl}
Company: ${context.legalName}
Contact: ${context.supportEmail}
Category: ${context.category.join("; ")}
Primary audience: ${context.audience.join(", ")}

## What airi.chat does

${context.capabilities.map(item => `- ${item}`).join("\n")}

## Integrations and readiness

${context.integrations.map(item => `- ${item}`).join("\n")}

## Important boundaries

${context.boundaries.map(item => `- ${item}`).join("\n")}

## Important public URLs

${pages}

## Entity signals

${context.entitySignals.map(item => `- ${item}`).join("\n")}
`;
}
