const MAX_PENDING_ACTIONS = 12;
const MAX_PENDING_ACTION_ID_LENGTH = 160;
const MAX_PENDING_ACTION_LABEL_LENGTH = 120;
const MAX_PENDING_ACTION_DESCRIPTION_LENGTH = 500;
const MAX_PENDING_ACTION_HREF_LENGTH = 2_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

type AiriChatWhatsAppTemplatePendingAction = {
  id: string;
  kind: "whatsapp_template_draft";
  label: string;
  description: string;
  href: string;
};

type AiriChatWhatsAppFlowPendingAction = {
  id: string;
  kind: "whatsapp_flow_draft";
  label: string;
  description: string;
  href: string;
};

export type AiriChatMetaAdsMcpPendingActionV2 = {
  confirmationVersion: 2;
  id: string;
  kind: "meta_ads_mcp_mutation";
  label: "Review changes";
  description: string;
  href: string;
  mutationId: string;
  transactionDigest: string;
};

export type AiriChatLegacyMetaAdsMcpPendingAction = {
  confirmationVersion: 1;
  legacyExpired: true;
  id: string;
  kind: "meta_ads_mcp_mutation";
  label: string;
  description: string;
  href: string;
  mutationId: string;
};

export type AiriChatMetaAdsMcpPendingAction =
  | AiriChatMetaAdsMcpPendingActionV2
  | AiriChatLegacyMetaAdsMcpPendingAction;

export type AiriChatPendingAction =
  | AiriChatWhatsAppTemplatePendingAction
  | AiriChatWhatsAppFlowPendingAction
  | AiriChatMetaAdsMcpPendingAction;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function normalizePendingAction(value: unknown): AiriChatPendingAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (
    !isBoundedString(action.id, MAX_PENDING_ACTION_ID_LENGTH) ||
    !isBoundedString(
      action.description,
      MAX_PENDING_ACTION_DESCRIPTION_LENGTH
    ) ||
    !isBoundedString(action.href, MAX_PENDING_ACTION_HREF_LENGTH)
  ) {
    return null;
  }

  if (
    action.kind === "whatsapp_template_draft" ||
    action.kind === "whatsapp_flow_draft"
  ) {
    if (!isBoundedString(action.label, MAX_PENDING_ACTION_LABEL_LENGTH)) {
      return null;
    }
    return {
      id: action.id,
      kind: action.kind,
      label: action.label,
      description: action.description,
      href: action.href,
    };
  }

  if (action.kind !== "meta_ads_mcp_mutation") {
    return null;
  }
  if (
    !isBoundedString(action.label, MAX_PENDING_ACTION_LABEL_LENGTH) ||
    !isBoundedString(action.mutationId, MAX_PENDING_ACTION_ID_LENGTH)
  ) {
    return null;
  }

  if (action.confirmationVersion === 2) {
    if (
      action.label !== "Review changes" ||
      typeof action.transactionDigest !== "string" ||
      !SHA256_HEX_PATTERN.test(action.transactionDigest)
    ) {
      return null;
    }
    return {
      confirmationVersion: 2,
      id: action.id,
      kind: "meta_ads_mcp_mutation",
      label: "Review changes",
      description: action.description,
      href: action.href,
      mutationId: action.mutationId,
      transactionDigest: action.transactionDigest,
    };
  }

  const isHistoricalAction =
    action.transactionDigest === undefined &&
    ((action.confirmationVersion === undefined &&
      action.legacyExpired === undefined) ||
      (action.confirmationVersion === 1 && action.legacyExpired === true));
  if (!isHistoricalAction) return null;

  return {
    confirmationVersion: 1,
    legacyExpired: true,
    id: action.id,
    kind: "meta_ads_mcp_mutation",
    label: action.label,
    description: action.description,
    href: action.href,
    mutationId: action.mutationId,
  };
}

export function normalizeAiriChatPendingActions(
  metadata: Record<string, unknown> | null | undefined
): AiriChatPendingAction[] {
  const values = metadata?.pendingActions;
  if (!Array.isArray(values)) return [];

  const actions: AiriChatPendingAction[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, MAX_PENDING_ACTIONS)) {
    const action = normalizePendingAction(value);
    if (!action) continue;
    const key = `${action.kind}:${action.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }
  return actions;
}
