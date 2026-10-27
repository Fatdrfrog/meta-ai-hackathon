import type { SourceType } from "@icecore/shared/types/sources";

export const AIRI_CHAT_CONTEXT_OPTION_IDS = [
  "conversation_timeline",
  "knowledge_base_articles",
  "indexed_public_urls",
  "answer_snippets",
  "quick_replies",
] as const;

export type AiriChatContextOptionId =
  (typeof AIRI_CHAT_CONTEXT_OPTION_IDS)[number];

export const AIRI_CHAT_SKILL_IDS = ["meta"] as const;
export type AiriChatSkillId = (typeof AIRI_CHAT_SKILL_IDS)[number];
export const AIRI_CHAT_META_SKILL_ID: AiriChatSkillId = "meta";
export const AIRI_CHAT_META_SKILL_LABEL = "meta";

const AIRI_CHAT_SKILL_ID_SET = new Set<string>(AIRI_CHAT_SKILL_IDS);

export function isAiriChatSkillId(value: unknown): value is AiriChatSkillId {
  return typeof value === "string" && AIRI_CHAT_SKILL_ID_SET.has(value);
}

export type AiriChatSourceRef =
  | {
      kind: "context";
      optionId: AiriChatContextOptionId;
      label: string;
    }
  | {
      kind: "context_item";
      optionId: AiriChatContextOptionId;
      itemId: string;
      label: string;
    }
  | {
      kind: "channel_source";
      sourceId: string;
      sourceType: SourceType | string;
      label: string;
    }
  | {
      kind: "workspace_source";
      sourceId: string;
      sourceType: SourceType | string;
      label: string;
    }
  | {
      kind: "connector";
      connector: "whatsapp";
      sourceId: string;
      label: string;
      capabilities?: Array<"docs" | "templates" | "flows">;
    }
  | {
      kind: "skill";
      skillId: AiriChatSkillId;
      label: string;
    }
  | {
      kind: "chat_thread";
      threadId: string;
      label: string;
    };

export function buildAiriChatMetaSkillRef(): Extract<
  AiriChatSourceRef,
  { kind: "skill" }
> {
  return {
    kind: "skill",
    skillId: AIRI_CHAT_META_SKILL_ID,
    label: AIRI_CHAT_META_SKILL_LABEL,
  };
}

export function hasAiriChatMetaSkill(
  refs: AiriChatSourceRef[] | null | undefined
): boolean {
  return (refs || []).some(
    ref => ref.kind === "skill" && ref.skillId === AIRI_CHAT_META_SKILL_ID
  );
}

/** "@meta" in the message text asks for the Meta Ads skill. */
export function mentionsAiriChatMetaSkill(userMessage: string): boolean {
  return /(^|\s)@meta\b/i.test(userMessage.trim());
}

/**
 * The request names Meta Ads itself (the skill is attached or "@meta" is
 * typed), so the classifier routes it to meta_ads_mcp without a model call
 * and the turn knows that before classifying.
 */
export function isExplicitAiriChatMetaAdsRequest(params: {
  selectedSources: AiriChatSourceRef[] | null | undefined;
  userMessage: string;
}): boolean {
  if (!params.userMessage.trim()) return false;
  return (
    hasAiriChatMetaSkill(params.selectedSources) ||
    mentionsAiriChatMetaSkill(params.userMessage)
  );
}

export type AiriMetaAdsMcpSkillCapability = {
  canRead: boolean;
  canWrite: boolean;
  retryable: boolean;
  recovery:
    | "connect"
    | "authorize"
    | "reconnect"
    | "settings"
    | "rollout"
    | null;
  descriptionKey:
    | "missingSource"
    | "accountNotEnabled"
    | "checking"
    | "selectAccount"
    | "checkAgain"
    | "verify"
    | "reconnect"
    | "connect"
    | "retry"
    | "management"
    | "reporting";
};

export type AiriChatSourceOption =
  | {
      type?: "source";
      id: string;
      ref: AiriChatSourceRef;
      group: string;
      label: string;
      description: string;
      count?: number;
      disabled?: boolean;
      metaAdsMcp?: AiriMetaAdsMcpSkillCapability;
    }
  | {
      type: "action";
      id: string;
      action: "choose_chats";
      group: string;
      label: string;
      description: string;
      count?: number;
      disabled?: boolean;
    };

const AIRI_CHAT_CONTEXT_OPTION_ID_SET = new Set<string>(
  AIRI_CHAT_CONTEXT_OPTION_IDS
);

export function isAiriChatContextOptionId(
  value: unknown
): value is AiriChatContextOptionId {
  return (
    typeof value === "string" && AIRI_CHAT_CONTEXT_OPTION_ID_SET.has(value)
  );
}

function cleanLabel(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildAiriChatSourceOptionId(ref: AiriChatSourceRef): string {
  if (ref.kind === "context") {
    return `context:${ref.optionId}`;
  }
  if (ref.kind === "context_item") {
    return `context_item:${ref.optionId}:${ref.itemId}`;
  }
  if (ref.kind === "channel_source") {
    return `channel_source:${ref.sourceId}`;
  }
  if (ref.kind === "workspace_source") {
    return `source:${ref.sourceId}`;
  }
  if (ref.kind === "connector") {
    return `connector:${ref.connector}:${ref.sourceId}`;
  }
  if (ref.kind === "skill") {
    return `skill:${ref.skillId}`;
  }
  return `chat_thread:${ref.threadId}`;
}

export function normalizeAiriChatSelectedSources(
  refs: unknown
): AiriChatSourceRef[] {
  if (!Array.isArray(refs)) return [];

  const normalized: AiriChatSourceRef[] = [];
  const seen = new Set<string>();

  for (const rawRef of refs) {
    if (!rawRef || typeof rawRef !== "object") continue;
    const record = rawRef as Record<string, unknown>;
    const label = cleanLabel(record.label);
    if (!label) continue;

    let ref: AiriChatSourceRef | null = null;
    if (
      record.kind === "context" &&
      isAiriChatContextOptionId(record.optionId)
    ) {
      ref = {
        kind: "context",
        optionId: record.optionId,
        label,
      };
    } else if (
      record.kind === "context_item" &&
      isAiriChatContextOptionId(record.optionId) &&
      typeof record.itemId === "string" &&
      record.itemId.trim().length > 0
    ) {
      ref = {
        kind: "context_item",
        optionId: record.optionId,
        itemId: record.itemId.trim(),
        label,
      };
    } else if (
      record.kind === "channel_source" &&
      typeof record.sourceId === "string" &&
      record.sourceId.trim().length > 0 &&
      typeof record.sourceType === "string" &&
      record.sourceType.trim().length > 0
    ) {
      ref = {
        kind: "channel_source",
        sourceId: record.sourceId.trim(),
        sourceType: record.sourceType.trim(),
        label,
      };
    } else if (
      record.kind === "workspace_source" &&
      typeof record.sourceId === "string" &&
      record.sourceId.trim().length > 0 &&
      typeof record.sourceType === "string" &&
      record.sourceType.trim().length > 0
    ) {
      ref = {
        kind: "workspace_source",
        sourceId: record.sourceId.trim(),
        sourceType: record.sourceType.trim(),
        label,
      };
    } else if (
      record.kind === "connector" &&
      record.connector === "whatsapp" &&
      typeof record.sourceId === "string" &&
      record.sourceId.trim().length > 0
    ) {
      const capabilities = Array.isArray(record.capabilities)
        ? record.capabilities.filter(
            (value): value is "docs" | "templates" | "flows" =>
              value === "docs" || value === "templates" || value === "flows"
          )
        : undefined;
      ref = {
        kind: "connector",
        connector: "whatsapp",
        sourceId: record.sourceId.trim(),
        label,
        ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      };
    } else if (record.kind === "skill" && isAiriChatSkillId(record.skillId)) {
      ref = {
        kind: "skill",
        skillId: record.skillId,
        label:
          record.skillId === AIRI_CHAT_META_SKILL_ID
            ? AIRI_CHAT_META_SKILL_LABEL
            : label,
      };
    } else if (
      record.kind === "chat_thread" &&
      typeof record.threadId === "string" &&
      record.threadId.trim().length > 0
    ) {
      ref = {
        kind: "chat_thread",
        threadId: record.threadId.trim(),
        label,
      };
    }

    if (!ref) continue;
    const id = buildAiriChatSourceOptionId(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(ref);
  }

  return normalized.slice(0, 12);
}
