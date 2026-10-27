import {
  BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID,
  MAX_SCENARIO_NAME_LENGTH,
  SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  buildScenarioActionOutcomeHandleId,
  buildWhatsAppTemplateButtonSourceHandleId,
  createClientMessageTriggerData,
  type FunnelSegmentKey,
  type ScenarioNodeData,
  type ScenarioWhatsAppTemplate,
} from "@icecore/scenario-contracts";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { extractTemplateVariablesInOrder } from "@icecore/shared/types/whatsapp";
import { normalizeScenarioGraphLayout } from "@/lib/scenarios/graph-layout";
import { extractWhatsAppTemplateQuickReplyBranchOptions } from "@/lib/scenarios/whatsapp-template-button-branches";
import { DEFAULT_SCENARIO_EDGE_STYLE } from "../graph/config";
import { createScenarioGraphId } from "../graph/id";
import { resolveScenarioFlowNodeType } from "../graph/node-type";
import type { ScenarioFlowEdge, ScenarioFlowNode } from "../types";

export type RevenuePlaybookGoal =
  | "ad_consultation"
  | "unpaid_recovery"
  | "repeat_purchase"
  | "service_reactivation";

export type RevenuePlaybookConfig = {
  goal: RevenuePlaybookGoal;
  name: string;
  openingText: string;
  qualificationQuestion?: string;
  bookingUrl?: string;
  bookingButtonLabel?: string;
  reminderText: string;
  reminderMinutes: number;
  successText: string;
  handoffText: string;
  triggerKeyword?: string;
  template?: ScenarioWhatsAppTemplate;
  templateReplyButtonIndex?: number;
  sourceId?: string;
  recipients?: string[];
};

export class RevenuePlaybookValidationError extends Error {
  constructor(
    public readonly field: keyof RevenuePlaybookConfig,
    public readonly code: "required" | "invalid" | "too_long" | "not_supported"
  ) {
    super(`Revenue playbook ${field}: ${code}`);
    this.name = "RevenuePlaybookValidationError";
  }
}

const PLAYBOOKS = {
  ad_consultation: {
    segmentKey: "lead_generation",
    description:
      "WhatsApp ad consultation, booking link and merchant-confirmed payment.",
  },
  unpaid_recovery: {
    segmentKey: "sales_qualified",
    description:
      "Keyword-started payment follow-up with one reminder and merchant confirmation.",
  },
  repeat_purchase: {
    segmentKey: "retention",
    description:
      "Repeat purchase campaign for selected recipients. The selected template reply button opens the offer.",
  },
  service_reactivation: {
    segmentKey: "churn_risk",
    description:
      "Service reactivation campaign for selected recipients. The selected template reply button opens the booking link.",
  },
} as const satisfies Record<
  RevenuePlaybookGoal,
  { segmentKey: FunnelSegmentKey; description: string }
>;

function presetId(goal: RevenuePlaybookGoal): string {
  return `revenue-playbook-${goal}`;
}

export function isRevenuePlaybookPresetId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Object.keys(PLAYBOOKS).some(
      goal => presetId(goal as RevenuePlaybookGoal) === value
    )
  );
}

/** The quick setup has no media or variable mapping step; richer templates stay in the full editor. */
export function isRevenuePlaybookTemplateSupported(
  template: ScenarioWhatsAppTemplate
): boolean {
  if (
    template.status?.trim().toUpperCase() !== "APPROVED" ||
    !template.name?.trim() ||
    !template.language?.trim()
  )
    return false;
  const components = template.components;
  if (
    !Array.isArray(components) ||
    components.filter(component => component.type === "BODY").length !== 1
  )
    return false;
  const staticText = (value: unknown): value is string =>
    typeof value === "string" &&
    Boolean(value.trim()) &&
    extractTemplateVariablesInOrder(value).length === 0;
  if (
    !components.every(component => {
      switch (component.type) {
        case "HEADER":
          return component.format === "TEXT" && staticText(component.text);
        case "BODY":
        case "FOOTER":
          return staticText(component.text);
        case "BUTTONS":
          return component.buttons.every(button => {
            switch (button.type) {
              case "QUICK_REPLY":
                return staticText(button.text);
              case "URL":
                return staticText(button.text) && staticText(button.url);
              case "PHONE_NUMBER":
                return (
                  staticText(button.text) && staticText(button.phone_number)
                );
              default:
                return false;
            }
          });
        default:
          return false;
      }
    })
  )
    return false;
  return (
    extractWhatsAppTemplateQuickReplyBranchOptions({
      actionNodeId: "revenue-template",
      nodeData: { actionWhatsAppTemplateComponents: components },
    }).length > 0
  );
}

function requiredText(
  value: unknown,
  field: keyof RevenuePlaybookConfig,
  limit: number = WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text
): string {
  if (typeof value !== "string" || !value.trim())
    throw new RevenuePlaybookValidationError(field, "required");
  const text = value.trim();
  if (text.length > limit)
    throw new RevenuePlaybookValidationError(field, "too_long");
  return text;
}

function bookingUrl(value: unknown): string {
  const text = requiredText(value, "bookingUrl", 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RevenuePlaybookValidationError("bookingUrl", "invalid");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new RevenuePlaybookValidationError("bookingUrl", "invalid");
  return url.toString();
}

/** Creates ordinary draft graph data; sending and activation remain with the existing scenario owners. */
export function buildRevenuePlaybookSeed(config: RevenuePlaybookConfig) {
  if (!Object.prototype.hasOwnProperty.call(PLAYBOOKS, config.goal))
    throw new RevenuePlaybookValidationError("goal", "invalid");
  const playbook = PLAYBOOKS[config.goal];
  const isBulk =
    config.goal === "repeat_purchase" || config.goal === "service_reactivation";
  const usesBooking =
    config.goal === "ad_consultation" || config.goal === "service_reactivation";
  const name = requiredText(config.name, "name", MAX_SCENARIO_NAME_LENGTH);
  const openingText = requiredText(
    config.openingText,
    "openingText",
    usesBooking
      ? WHATSAPP_SERVICE_MESSAGE_LIMITS.body.interactive
      : WHATSAPP_SERVICE_MESSAGE_LIMITS.body.text
  );
  const reminderText = requiredText(config.reminderText, "reminderText");
  const successText = requiredText(config.successText, "successText");
  const handoffText = requiredText(config.handoffText, "handoffText");
  if (
    !Number.isInteger(config.reminderMinutes) ||
    config.reminderMinutes < 1 ||
    config.reminderMinutes > 1440
  )
    throw new RevenuePlaybookValidationError("reminderMinutes", "invalid");
  if (!isBulk && config.sourceId?.trim())
    throw new RevenuePlaybookValidationError("sourceId", "not_supported");
  const url = usesBooking ? bookingUrl(config.bookingUrl) : undefined;
  const buttonLabel = usesBooking
    ? requiredText(
        config.bookingButtonLabel,
        "bookingButtonLabel",
        WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label
      )
    : undefined;
  const nodes: ScenarioFlowNode[] = [];
  const edges: ScenarioFlowEdge[] = [];
  const addNode = (id: string, data: ScenarioNodeData) => {
    const node: ScenarioFlowNode = {
      id,
      type: resolveScenarioFlowNodeType(data.kind),
      position: { x: 80, y: 120 },
      data,
    };
    nodes.push(node);
    return node;
  };
  const addEdge = (
    source: string,
    target: string,
    sourceHandle = "right-source"
  ) =>
    edges.push({
      id: `edge-${source}-${sourceHandle}-${target}`,
      source,
      sourceHandle,
      target,
      targetHandle: "left-target",
      ...DEFAULT_SCENARIO_EDGE_STYLE,
    });
  const addMessage = (id: string, text: string) =>
    addNode(id, {
      kind: "action",
      actionType: "reply",
      actionReplyChannel: "whatsapp",
      actionWhatsAppServiceMessage: {
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text },
          previewUrl: true,
        },
      },
    });

  if (isBulk) {
    const sourceId = requiredText(config.sourceId, "sourceId", 256);
    if (!Array.isArray(config.recipients) || !config.recipients.length)
      throw new RevenuePlaybookValidationError("recipients", "required");
    const phones = config.recipients.map(raw => {
      const phone = normalizeWhatsAppPhone(raw);
      if (
        typeof raw !== "string" ||
        !/^\+?[\d\s().-]+$/.test(raw.trim()) ||
        !phone ||
        !/^[1-9]\d{6,14}$/.test(phone)
      )
        throw new RevenuePlaybookValidationError("recipients", "invalid");
      return phone;
    });
    const recipients = [...new Set(phones)].map(phone => ({ phone, sourceId }));
    const template = config.template;
    if (!template)
      throw new RevenuePlaybookValidationError("template", "required");
    if (!isRevenuePlaybookTemplateSupported(template))
      throw new RevenuePlaybookValidationError("template", "invalid");
    const options = extractWhatsAppTemplateQuickReplyBranchOptions({
      actionNodeId: "revenue-template",
      nodeData: { actionWhatsAppTemplateComponents: template.components },
    });
    if (
      !Number.isInteger(config.templateReplyButtonIndex) ||
      !options.some(option => option.index === config.templateReplyButtonIndex)
    )
      throw new RevenuePlaybookValidationError(
        "templateReplyButtonIndex",
        "invalid"
      );
    addNode("revenue-audience", {
      kind: "bulk",
      bulkRootConfig: {
        workflowKind: "bulk_campaign",
        sendMode: "immediate",
        channels: ["whatsapp"],
        sourceIds: [sourceId],
        campaignName: name,
        recipientSourceSummary: `${recipients.length} selected recipients`,
        recipientAudienceSource: SCENARIO_BULK_UPLOADED_AUDIENCE_SOURCE,
        uploadedRecipients: recipients,
        generationStatus: "idle",
        cohorts: [],
      },
    });
    addNode("revenue-template", {
      kind: "action",
      actionType: "whatsapp_template",
      actionWhatsAppTemplateId: template.id,
      actionWhatsAppTemplateName: template.name.trim(),
      actionWhatsAppTemplateLanguage: template.language.trim(),
      actionWhatsAppTemplateCategory: template.category,
      actionWhatsAppTemplateComponents: structuredClone(template.components),
    });
    addEdge(
      "revenue-audience",
      "revenue-template",
      BULK_CAMPAIGN_FOLLOW_UP_SOURCE_HANDLE_ID
    );
    for (const option of options)
      addEdge(
        "revenue-template",
        option.index === config.templateReplyButtonIndex
          ? "revenue-offer"
          : "revenue-handoff",
        buildWhatsAppTemplateButtonSourceHandleId(option.buttonId)
      );
  } else {
    addNode(
      "revenue-trigger",
      createClientMessageTriggerData({
        triggerConfig: {
          enabled: true,
          channelFilter: ["whatsapp"],
          onlyNewCustomers: false,
          ...(config.goal === "ad_consultation"
            ? { messageMatchMode: "any", whatsappReferralSourceTypes: ["ad"] }
            : {
                messageMatchMode: "exact",
                keywordPattern: requiredText(
                  config.triggerKeyword,
                  "triggerKeyword",
                  240
                ),
                keywordMatchMode: "contains",
              }),
        },
      })
    );
    if (config.goal === "ad_consultation") {
      const qualification = addMessage(
        "revenue-qualification",
        requiredText(config.qualificationQuestion, "qualificationQuestion")
      );
      qualification.data.actionOutcomes = {
        version: 1,
        anyReply: { enabled: true },
      };
      addEdge("revenue-trigger", qualification.id);
      addEdge(
        qualification.id,
        "revenue-offer",
        buildScenarioActionOutcomeHandleId("any_reply")
      );
    } else {
      addEdge("revenue-trigger", "revenue-offer");
    }
  }

  const offer = addMessage("revenue-offer", openingText);
  if (url && buttonLabel)
    offer.data.actionWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "cta_url",
        body: { mode: "fixed", text: openingText },
        buttonLabel,
        urlSource: { kind: "fixed", url },
      },
    };
  offer.data.actionOutcomes = {
    version: 1,
    anyReply: { enabled: true },
    noReply: { enabled: true, timeoutMinutes: config.reminderMinutes },
    paymentDetected: { enabled: true },
  };
  const reminder = addMessage("revenue-reminder", reminderText);
  reminder.data.actionOutcomes = {
    version: 1,
    anyReply: { enabled: true },
    paymentDetected: { enabled: true },
  };
  addMessage("revenue-success", successText);
  addNode("revenue-handoff", {
    kind: "action",
    actionType: "assign_human",
    actionInstruction: handoffText,
  });
  for (const action of [offer, reminder]) {
    addEdge(
      action.id,
      "revenue-success",
      buildScenarioActionOutcomeHandleId("payment_detected")
    );
    addEdge(
      action.id,
      "revenue-handoff",
      buildScenarioActionOutcomeHandleId("any_reply")
    );
  }
  addEdge(
    offer.id,
    reminder.id,
    buildScenarioActionOutcomeHandleId("no_reply")
  );
  // Reply payloads identify action nodes, including when a conversation lock
  // has cleared. Every created draft therefore needs its own graph identities.
  const nodeIds = new Map(
    nodes.map(node => [node.id, `${createScenarioGraphId("node")}-${node.id}`])
  );
  return {
    name,
    description: playbook.description,
    presetId: presetId(config.goal),
    presetVersion: "1",
    segmentKey: playbook.segmentKey,
    initialFlow: normalizeScenarioGraphLayout({
      nodes: nodes.map(node => ({ ...node, id: nodeIds.get(node.id)! })),
      edges: edges.map(edge => ({
        ...edge,
        id: createScenarioGraphId("edge"),
        source: nodeIds.get(edge.source)!,
        target: nodeIds.get(edge.target)!,
      })),
    }),
  };
}
