import { hasStoredTelegramBotToken } from "@/lib/integrations/source-status";
import { normalizeScenarioGraphLayout } from "@/lib/scenarios/graph-layout";
import { DEMO_SCENARIO_PRESET_ID } from "@/lib/scenarios/scenario-presets";
import {
  asNullableRecord,
  coerceBooleanField,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import {
  createClientMessageTriggerData,
  createDefaultScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";
import type {
  ScenarioContextOption,
  ScenarioFlowEdge,
  ScenarioFlowNode,
  ScenarioNodeData,
  ScenarioViewport,
  TranslateFn,
} from "./types";

export type ConnectedScenarioSourceMention =
  | "whatsapp"
  | "telegram"
  | "email"
  | "canva"
  | "higgsfield";

export type ConnectedScenarioActionSource =
  | "whatsapp"
  | "instagram"
  | "telegram"
  | "web_widget"
  | "email";

export type ScenarioSourceReadinessRow = {
  id?: string | null;
  type?: string | null;
  name?: string | null;
  credentials?: Record<string, unknown> | null;
};

/**
 * Every credential key the readiness helpers below read. The Scenarios page
 * selects only these, so a helper that starts reading another key must add
 * it here or that source reads as not connected.
 */
export const SCENARIO_SOURCE_READINESS_CREDENTIAL_KEYS = [
  "bot_token",
  "bot_username",
  "coexistence_mode",
  "display_phone_number",
  "email_address",
  "embedded_signup_flow",
  "is_on_biz_app",
  "phone_number_id",
  "status",
  "verified_name",
] as const;

export type ScenarioSourceInstanceOption = {
  id: string;
  type: "whatsapp" | "telegram" | "email";
  label: string;
};

export type ScenarioSourceCapabilities = {
  hasWhatsApp: boolean;
  hasWhatsAppCoexistence: boolean;
  hasMetaAds: boolean;
};

export type DemoScenarioSeed = {
  name: string;
  presetId: string;
  initialFlow: {
    nodes: ScenarioFlowNode[];
    edges: ScenarioFlowEdge[];
  };
  viewport: ScenarioViewport;
};

const SCENARIO_SOURCE_MENTION_SET = new Set([
  "whatsapp",
  "telegram",
  "email",
  "canva",
  "higgsfield",
]);
const SCENARIO_ACTION_SOURCE_SET = new Set([
  "whatsapp",
  "instagram",
  "telegram",
  "web_widget",
  "email",
]);
const SCENARIO_ACTION_SOURCE_ORDER: ConnectedScenarioActionSource[] = [
  "whatsapp",
  "instagram",
  "telegram",
  "web_widget",
  "email",
];
const SCENARIO_SOURCE_INSTANCE_SET = new Set(["whatsapp", "telegram", "email"]);

function credentialString(
  credentials: ScenarioSourceReadinessRow["credentials"],
  key: string
): string {
  return readStringField(asNullableRecord(credentials), key, { trim: true });
}

function firstCredentialString(
  credentials: ScenarioSourceReadinessRow["credentials"],
  keys: string[]
): string {
  for (const key of keys) {
    const value = credentialString(credentials, key);
    if (value) return value;
  }
  return "";
}

function credentialBoolean(
  credentials: ScenarioSourceReadinessRow["credentials"],
  key: string
): boolean {
  return coerceBooleanField(asNullableRecord(credentials), key) === true;
}

function isConfiguredScenarioSource(row: ScenarioSourceReadinessRow): boolean {
  const type = typeof row.type === "string" ? row.type.trim() : "";
  if (!type) return false;

  if (type === "telegram") {
    return hasStoredTelegramBotToken(row.credentials);
  }

  if (type === "email") {
    const status = credentialString(row.credentials, "status");
    const emailAddress = credentialString(row.credentials, "email_address");
    return status === "active" && emailAddress.length > 0;
  }

  return true;
}

export function hasConnectedScenarioSources(
  sources: ScenarioSourceReadinessRow[] | null | undefined
): boolean {
  return (sources ?? []).some(isConfiguredScenarioSource);
}

export function getConnectedScenarioSourceMentions(
  sources: ScenarioSourceReadinessRow[] | null | undefined
): ConnectedScenarioSourceMention[] {
  const connectedSourceTypes = new Set(
    (sources ?? [])
      .filter(isConfiguredScenarioSource)
      .map(row => (typeof row.type === "string" ? row.type.trim() : ""))
      .filter(type => SCENARIO_SOURCE_MENTION_SET.has(type))
  );

  return [
    ...(connectedSourceTypes.has("whatsapp") ? (["whatsapp"] as const) : []),
    ...(connectedSourceTypes.has("telegram") ? (["telegram"] as const) : []),
    ...(connectedSourceTypes.has("email") ? (["email"] as const) : []),
    ...(connectedSourceTypes.has("canva") ? (["canva"] as const) : []),
    ...(connectedSourceTypes.has("higgsfield")
      ? (["higgsfield"] as const)
      : []),
  ];
}

function buildScenarioSourceOptionLabel(row: ScenarioSourceReadinessRow) {
  const explicitName = typeof row.name === "string" ? row.name.trim() : "";
  if (explicitName) return explicitName;

  const type = typeof row.type === "string" ? row.type.trim() : "";
  if (type === "whatsapp") {
    return (
      firstCredentialString(row.credentials, [
        "verified_name",
        "display_phone_number",
        "phone_number_id",
      ]) || "WhatsApp source"
    );
  }
  if (type === "telegram") {
    const username = credentialString(row.credentials, "bot_username");
    return username ? `@${username.replace(/^@/, "")}` : "Telegram source";
  }
  if (type === "email") {
    return credentialString(row.credentials, "email_address") || "Email source";
  }
  return "Source";
}

export function getConnectedScenarioSourceOptions(
  sources: ScenarioSourceReadinessRow[] | null | undefined
): ScenarioSourceInstanceOption[] {
  return (sources ?? [])
    .filter(isConfiguredScenarioSource)
    .map(row => {
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const type = typeof row.type === "string" ? row.type.trim() : "";
      if (!id || !SCENARIO_SOURCE_INSTANCE_SET.has(type)) {
        return null;
      }
      return {
        id,
        type: type as ScenarioSourceInstanceOption["type"],
        label: buildScenarioSourceOptionLabel(row),
      };
    })
    .filter(
      (option): option is ScenarioSourceInstanceOption => option !== null
    );
}

export function getConnectedScenarioActionSources(
  sources: ScenarioSourceReadinessRow[] | null | undefined
): ConnectedScenarioActionSource[] {
  const connectedSourceTypes = new Set(
    (sources ?? [])
      .filter(isConfiguredScenarioSource)
      .map(row => (typeof row.type === "string" ? row.type.trim() : ""))
      .filter(type => SCENARIO_ACTION_SOURCE_SET.has(type))
  );

  return SCENARIO_ACTION_SOURCE_ORDER.filter(type =>
    connectedSourceTypes.has(type)
  );
}

function isWhatsAppCoexistenceSource(row: ScenarioSourceReadinessRow): boolean {
  if ((row.type || "").trim() !== "whatsapp") return false;
  const flow = credentialString(
    row.credentials,
    "embedded_signup_flow"
  ).toLowerCase();
  return (
    flow === "coexistence" ||
    credentialBoolean(row.credentials, "coexistence_mode") ||
    credentialBoolean(row.credentials, "is_on_biz_app")
  );
}

export function getScenarioSourceCapabilities(
  sources: ScenarioSourceReadinessRow[] | null | undefined
): ScenarioSourceCapabilities {
  const configuredWhatsAppSources = (sources ?? []).filter(
    row =>
      (row.type || "").trim() === "whatsapp" && isConfiguredScenarioSource(row)
  );
  const hasMetaAds = (sources ?? []).some(
    row =>
      (row.type || "").trim() === "meta_ads" && isConfiguredScenarioSource(row)
  );
  const hasWhatsApp = configuredWhatsAppSources.length > 0;
  const hasWhatsAppCoexistence = configuredWhatsAppSources.some(
    isWhatsAppCoexistenceSource
  );

  return {
    hasWhatsApp,
    hasWhatsAppCoexistence,
    hasMetaAds,
  };
}

// The demo is only being created while the auto-create effect can run: no
// source yet, no failed attempt, and scenario creation is not locked by a
// plan limit (the effect never starts then, so the spinner would never end).
export function isDemoScenarioAutoCreatePending(params: {
  hasConnectedSources: boolean;
  demoCreateFailed: boolean;
  scenarioCreateLocked: boolean;
}): boolean {
  return (
    !params.hasConnectedSources &&
    !params.demoCreateFailed &&
    !params.scenarioCreateLocked
  );
}

export function shouldAutoCreateDemoScenario(params: {
  attempted: boolean;
  hasConnectedSources: boolean;
  loadingScenarios: boolean;
  scenarioCount: number;
}): boolean {
  return (
    !params.attempted &&
    !params.hasConnectedSources &&
    !params.loadingScenarios &&
    params.scenarioCount === 0
  );
}

export function buildDemoScenarioSeed({
  t,
}: {
  contextOptions: ScenarioContextOption[];
  t: TranslateFn;
}): DemoScenarioSeed {
  const triggerNode: ScenarioFlowNode = {
    id: "demo-trigger",
    type: "triggerNode",
    position: { x: 80, y: 120 },
    data: createClientMessageTriggerData({
      triggerConfig: {
        enabled: true,
        onlyNewCustomers: false,
      },
    }),
  };
  const contextNode: ScenarioFlowNode = {
    id: "demo-context",
    type: "scenarioNode",
    position: { x: 420, y: 120 },
    data: {
      kind: "context",
      contextSources: [
        {
          optionId: "conversation_timeline",
          selectionMode: "all",
          itemIds: [],
        },
        {
          optionId: "answer_snippets",
          selectionMode: "all",
          itemIds: [],
        },
      ],
    } satisfies ScenarioNodeData,
  };
  const actionNode: ScenarioFlowNode = {
    id: "demo-action",
    type: "actionNode",
    position: { x: 760, y: 120 },
    data: {
      kind: "action",
      actionType: "reply",
      actionWhatsAppServiceMessage: {
        ...createDefaultScenarioWhatsAppServiceMessage("text"),
        message: {
          kind: "text",
          body: {
            mode: "ai",
            instruction: t("scenarioOnboardingDemoReplyInstruction"),
          },
          previewUrl: true,
        },
      },
    },
  };
  const edges: ScenarioFlowEdge[] = [
    {
      id: "demo-edge-trigger-context",
      source: triggerNode.id,
      sourceHandle: "right-source",
      target: contextNode.id,
      targetHandle: "left-target",
    },
    {
      id: "demo-edge-context-action",
      source: contextNode.id,
      sourceHandle: "right-source",
      target: actionNode.id,
      targetHandle: "left-target",
    },
  ];

  const initialFlow = normalizeScenarioGraphLayout({
    nodes: [triggerNode, contextNode, actionNode],
    edges,
  });

  return {
    name: t("scenarioOnboardingDemoName"),
    presetId: DEMO_SCENARIO_PRESET_ID,
    initialFlow,
    viewport: { x: 40, y: 80, zoom: 0.85 },
  };
}
