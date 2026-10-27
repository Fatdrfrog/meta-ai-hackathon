import WorkspaceAiriSettings, {
  MANAGER_REPLY_GUARD_CHANNELS,
  ManagerReplyGuardChannel,
  ManagerUserLink,
} from "@/models/workspace-airi-settings";
import { findRecentHumanOutboundAuthor } from "@/lib/airi/reply/runtime/human-outbound";

export type ManagerReplyGuardConfig = {
  enabled: boolean;
  skipIfManagerRecentlyReplied: boolean;
  skipIfTaggedManagerMessage: boolean;
  managerRecentReplyWindowSeconds: number;
  managerUserLinks: ManagerUserLink[];
};

export type ManagerReplyGuardDecisionReason =
  | "tagged_manager_message"
  | "manager_recently_replied";

export type ManagerReplyGuardDecision = {
  skip: boolean;
  reason?: ManagerReplyGuardDecisionReason;
  managerUserId?: string;
};

type EvaluateManagerReplyGuardParams = {
  workspaceId: string;
  conversationId: string;
  inboundAuthorId?: string;
  channel?: string;
  sourceId?: string;
  inboundAt: Date;
};

type LeanWorkspaceSettings = {
  manager_reply_guard_enabled?: boolean;
  skip_if_manager_recently_replied?: boolean;
  skip_if_tagged_manager_message?: boolean;
  manager_recent_reply_window_seconds?: number;
  manager_user_links?: Array<Partial<ManagerUserLink>>;
} | null;

const MANAGER_REPLY_GUARD_CHANNEL_SET = new Set<ManagerReplyGuardChannel>(
  MANAGER_REPLY_GUARD_CHANNELS
);

const DEFAULT_MANAGER_REPLY_GUARD_CONFIG: ManagerReplyGuardConfig = {
  enabled: true,
  skipIfManagerRecentlyReplied: true,
  skipIfTaggedManagerMessage: true,
  managerRecentReplyWindowSeconds: 300,
  managerUserLinks: [],
};
const MANAGER_REPLY_GUARD_CONFIG_CACHE_TTL_MS = 30_000;
const managerReplyGuardConfigCache = new Map<
  string,
  {
    expiresAt: number;
    config: ManagerReplyGuardConfig;
  }
>();

function normalizeChannel(
  channel?: string
): ManagerReplyGuardChannel | undefined {
  if (!channel) return undefined;
  if (
    MANAGER_REPLY_GUARD_CHANNEL_SET.has(channel as ManagerReplyGuardChannel)
  ) {
    return channel as ManagerReplyGuardChannel;
  }
  return undefined;
}

function normalizeChannels(channels: unknown): ManagerReplyGuardChannel[] {
  if (!Array.isArray(channels)) return [];
  const normalized = channels
    .map(channel => normalizeChannel(String(channel)))
    .filter((channel): channel is ManagerReplyGuardChannel => Boolean(channel));

  return Array.from(new Set(normalized));
}

function normalizeSourceIds(sourceIds: unknown): string[] {
  if (!Array.isArray(sourceIds)) return [];
  const normalized = sourceIds
    .map(sourceId => String(sourceId || "").trim())
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

function clampWindowSeconds(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300;
  const floored = Math.floor(parsed);
  if (floored < 30) return 30;
  if (floored > 86_400) return 86_400;
  return floored;
}

function normalizeManagerUserLink(
  link: Partial<ManagerUserLink>,
  index: number
): ManagerUserLink | null {
  const supabase_user_id = String(link.supabase_user_id || "").trim();
  const mongo_user_id = String(link.mongo_user_id || "").trim();

  if (!supabase_user_id || !mongo_user_id) return null;

  return {
    id: String(link.id || `manager-link-${index}`),
    supabase_user_id,
    mongo_user_id,
    channels: normalizeChannels(link.channels),
    source_ids: normalizeSourceIds(link.source_ids),
  };
}

function normalizeManagerUserLinks(
  links: Array<Partial<ManagerUserLink>> | undefined
): ManagerUserLink[] {
  if (!Array.isArray(links)) return [];

  const dedupe = new Set<string>();
  const normalized: ManagerUserLink[] = [];

  links.forEach((link, index) => {
    const parsed = normalizeManagerUserLink(link, index);
    if (!parsed) return;

    const key = [
      parsed.supabase_user_id,
      parsed.mongo_user_id,
      [...parsed.channels].sort().join(","),
      [...parsed.source_ids].sort().join(","),
    ].join("|");

    if (dedupe.has(key)) return;
    dedupe.add(key);
    normalized.push(parsed);
  });

  return normalized;
}

function managerLinkMatchesScope(
  link: ManagerUserLink,
  channel?: ManagerReplyGuardChannel,
  sourceId?: string
): boolean {
  const channelMatch =
    link.channels.length === 0 ||
    (channel ? link.channels.includes(channel) : false);
  const sourceMatch =
    link.source_ids.length === 0 ||
    (sourceId ? link.source_ids.includes(sourceId) : false);

  return channelMatch && sourceMatch;
}

function resolveManagerFromAuthor(
  links: ManagerUserLink[],
  authorId: string,
  channel?: ManagerReplyGuardChannel,
  sourceId?: string
): string | undefined {
  const matched = links.find(link => {
    if (link.mongo_user_id !== authorId && link.supabase_user_id !== authorId) {
      return false;
    }

    return managerLinkMatchesScope(link, channel, sourceId);
  });

  return matched?.supabase_user_id;
}

export async function getWorkspaceManagerReplyGuardConfig(
  workspaceId: string
): Promise<ManagerReplyGuardConfig> {
  if (!workspaceId) {
    return DEFAULT_MANAGER_REPLY_GUARD_CONFIG;
  }

  const cached = managerReplyGuardConfigCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const settings = await WorkspaceAiriSettings.findOne({ workspaceId })
    .select([
      "manager_reply_guard_enabled",
      "skip_if_manager_recently_replied",
      "skip_if_tagged_manager_message",
      "manager_recent_reply_window_seconds",
      "manager_user_links",
    ])
    .lean<LeanWorkspaceSettings>();

  const config = {
    enabled:
      typeof settings?.manager_reply_guard_enabled === "boolean"
        ? settings.manager_reply_guard_enabled
        : DEFAULT_MANAGER_REPLY_GUARD_CONFIG.enabled,
    skipIfManagerRecentlyReplied:
      typeof settings?.skip_if_manager_recently_replied === "boolean"
        ? settings.skip_if_manager_recently_replied
        : DEFAULT_MANAGER_REPLY_GUARD_CONFIG.skipIfManagerRecentlyReplied,
    skipIfTaggedManagerMessage:
      typeof settings?.skip_if_tagged_manager_message === "boolean"
        ? settings.skip_if_tagged_manager_message
        : DEFAULT_MANAGER_REPLY_GUARD_CONFIG.skipIfTaggedManagerMessage,
    managerRecentReplyWindowSeconds: clampWindowSeconds(
      settings?.manager_recent_reply_window_seconds
    ),
    managerUserLinks: normalizeManagerUserLinks(settings?.manager_user_links),
  };

  managerReplyGuardConfigCache.set(workspaceId, {
    expiresAt: Date.now() + MANAGER_REPLY_GUARD_CONFIG_CACHE_TTL_MS,
    config,
  });

  return config;
}

export async function evaluateManagerReplyGuard(
  params: EvaluateManagerReplyGuardParams
): Promise<ManagerReplyGuardDecision> {
  const config = await getWorkspaceManagerReplyGuardConfig(params.workspaceId);

  if (!config.enabled) {
    return { skip: false };
  }

  const normalizedChannel = normalizeChannel(params.channel);
  const sourceId = params.sourceId ? String(params.sourceId) : undefined;
  const inboundAuthorId = params.inboundAuthorId
    ? String(params.inboundAuthorId)
    : undefined;

  if (
    config.skipIfTaggedManagerMessage &&
    inboundAuthorId &&
    config.managerUserLinks.length > 0
  ) {
    const managerUserId = resolveManagerFromAuthor(
      config.managerUserLinks,
      inboundAuthorId,
      normalizedChannel,
      sourceId
    );

    if (managerUserId) {
      return {
        skip: true,
        reason: "tagged_manager_message",
        managerUserId,
      };
    }
  }

  if (config.skipIfManagerRecentlyReplied) {
    const recentAuthorId = await findRecentHumanOutboundAuthor({
      conversationId: params.conversationId,
      since: new Date(
        params.inboundAt.getTime() -
          config.managerRecentReplyWindowSeconds * 1000
      ),
      until: params.inboundAt,
    });

    if (recentAuthorId) {
      const managerUserId =
        resolveManagerFromAuthor(
          config.managerUserLinks,
          recentAuthorId,
          normalizedChannel,
          sourceId
        ) || recentAuthorId;

      return {
        skip: true,
        reason: "manager_recently_replied",
        managerUserId,
      };
    }
  }

  return { skip: false };
}

export const ManagerReplyGuardDefaults = DEFAULT_MANAGER_REPLY_GUARD_CONFIG;
