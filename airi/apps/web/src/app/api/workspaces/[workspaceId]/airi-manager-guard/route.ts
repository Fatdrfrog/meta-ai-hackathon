import {
  ManagerReplyGuardDefaults,
  getWorkspaceManagerReplyGuardConfig,
} from "@/lib/airi/reply/runtime/manager-reply-guard";
import { buildHistorySettingPersistenceMutation } from "@/lib/airi/workspace-bot-default";
import connectDB from "@/lib/mongoose";
import {
  getMembershipDisplayName,
  getUserProfilesByIds,
  WORKSPACE_ROLES,
  isWorkspaceManagerRole,
} from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import Message from "@/models/message";
import User from "@/models/user";
import WorkspaceAiriSettings, {
  MANAGER_REPLY_GUARD_CHANNELS,
  ManagerUserLink,
} from "@/models/workspace-airi-settings";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readUniqueStringArray } from "@icecore/shared/lib/value-utils";

type Params = Promise<{ workspaceId: string }>;

type ManagerOption = {
  userId: string;
  label: string;
  role: string;
  email: string | null;
};

type MongoUserOption = {
  mongo_user_id: string;
  label: string;
  channels: string[];
  messageCount: number;
  lastMessageAt: string | null;
};

type SourceOption = {
  id: string;
  label: string;
  type: string;
};

type MembershipRow = {
  role: string;
};

const ManagerLinkSchema = z.object({
  id: z.string().trim().min(1).optional(),
  supabase_user_id: z.string().trim().min(1),
  mongo_user_id: z.string().trim().min(1),
  channels: z.array(z.enum(MANAGER_REPLY_GUARD_CHANNELS)).default([]),
  source_ids: z.array(z.string().trim().min(1)).default([]),
});

const UpdateManagerGuardSchema = z.object({
  enabled: z.boolean(),
  skipIfManagerRecentlyReplied: z.boolean(),
  skipIfTaggedManagerMessage: z.boolean(),
  managerRecentReplyWindowSeconds: z.number().int().min(30).max(86_400),
  managerUserLinks: z.array(ManagerLinkSchema).max(500),
});

function normalizeManagerLinks(
  links: z.infer<typeof ManagerLinkSchema>[]
): ManagerUserLink[] {
  const dedupe = new Set<string>();
  const normalized: ManagerUserLink[] = [];

  for (const [index, link] of links.entries()) {
    const supabase_user_id = link.supabase_user_id.trim();
    const mongo_user_id = link.mongo_user_id.trim();
    const channels = Array.from(new Set(link.channels));
    const source_ids = readUniqueStringArray(link.source_ids);

    const dedupeKey = [
      supabase_user_id,
      mongo_user_id,
      [...channels].sort().join(","),
      [...source_ids].sort().join(","),
    ].join("|");

    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    normalized.push({
      id: link.id?.trim() || `manager-link-${Date.now()}-${index}`,
      supabase_user_id,
      mongo_user_id,
      channels,
      source_ids,
    });
  }

  return normalized;
}

async function getMembership(
  workspaceId: string,
  userId: string
): Promise<MembershipRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("company_users")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return null;
  return data as MembershipRow;
}

function formatManagerLabel(row: {
  email?: string | null;
  users?:
    | { full_name?: string | null }[]
    | { full_name?: string | null }
    | null;
}): string {
  return getMembershipDisplayName(row, "Manager");
}

async function getManagerOptions(
  workspaceId: string
): Promise<ManagerOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("company_users")
    .select("user_id, role, email")
    .eq("workspace_id", workspaceId)
    .in("role", [...WORKSPACE_ROLES]);

  if (error || !Array.isArray(data)) return [];

  const userIds = data
    .map(row => String((row as { user_id?: string | null }).user_id || ""))
    .map(userId => userId.trim())
    .filter(Boolean);
  const profilesById = await getUserProfilesByIds(supabase, userIds);
  const options = data
    .map(row => {
      const typedRow = row as {
        user_id?: string;
        role?: string;
        email?: string | null;
      };
      const userId = String(typedRow.user_id || "").trim();
      if (!userId) return null;
      const profile = profilesById.get(userId) ?? null;

      return {
        userId,
        label: formatManagerLabel({
          email: typedRow.email,
          users: profile,
        }),
        role: String(typedRow.role || "manager"),
        email: typedRow.email || null,
      };
    })
    .filter((option): option is ManagerOption => Boolean(option));

  const dedupe = new Set<string>();
  return options.filter(option => {
    if (dedupe.has(option.userId)) return false;
    dedupe.add(option.userId);
    return true;
  });
}

function deriveSourceLabel(source: Record<string, unknown>): string {
  const type = String(source.type || "source");
  const fallback = `${type} - ${String(source.id || "").slice(0, 8)}`;
  const explicitName = String(source.name || "").trim();
  if (explicitName) return explicitName;

  const credentials =
    source.credentials && typeof source.credentials === "object"
      ? (source.credentials as Record<string, unknown>)
      : null;

  if (type === "whatsapp") {
    const phone = String(
      credentials?.display_phone_number || credentials?.phone_number_id || ""
    ).trim();
    if (phone) return `whatsapp - ${phone}`;
  }

  if (type === "telegram") {
    const botUsername = String(credentials?.bot_username || "").trim();
    if (botUsername) return `telegram - @${botUsername.replace(/^@/, "")}`;
  }

  if (type === "instagram") {
    const pageId = String(credentials?.pageId || "").trim();
    if (pageId) return `instagram - ${pageId}`;
  }

  return fallback;
}

async function getSourceOptions(workspaceId: string): Promise<SourceOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sources")
    .select("*")
    .eq("workspace_id", workspaceId);

  if (error || !Array.isArray(data)) return [];

  return data
    .map(source => {
      const raw = source as Record<string, unknown>;
      const id = String(raw.id || "").trim();
      if (!id) return null;

      return {
        id,
        type: String(raw.type || "unknown"),
        label: deriveSourceLabel(raw),
      };
    })
    .filter((source): source is SourceOption => Boolean(source));
}

async function getMongoUserOptions(
  workspaceId: string
): Promise<MongoUserOption[]> {
  const stats = await Message.aggregate<{
    _id: unknown;
    channels: string[];
    messageCount: number;
    lastMessageAt: Date | null;
  }>([
    { $match: { workspaceId, author: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: "$author",
        channels: { $addToSet: "$channel" },
        messageCount: { $sum: 1 },
        lastMessageAt: { $max: "$date" },
      },
    },
    { $sort: { lastMessageAt: -1 } },
    { $limit: 300 },
  ]);

  if (!Array.isArray(stats) || stats.length === 0) return [];

  const ids = stats
    .map(item =>
      item?._id === null || item?._id === undefined ? "" : String(item._id)
    )
    .filter(Boolean);

  const users = await User.find({ _id: { $in: ids } })
    .select("_id firstName lastName username isBot")
    .lean<
      Array<{
        _id: unknown;
        firstName?: string;
        lastName?: string;
        username?: string;
        isBot?: boolean;
      }>
    >();

  const userMap = new Map(
    users.map(user => [
      String(user._id),
      {
        label:
          `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
          user.username ||
          String(user._id),
        isBot: Boolean(user.isBot),
      },
    ])
  );

  return stats
    .map(item => {
      const mongo_user_id =
        item?._id === null || item?._id === undefined ? "" : String(item._id);
      if (!mongo_user_id || mongo_user_id === "0") return null;

      const userMeta = userMap.get(mongo_user_id);
      if (userMeta?.isBot) return null;

      return {
        mongo_user_id,
        label: userMeta?.label || mongo_user_id,
        channels: Array.isArray(item.channels)
          ? readUniqueStringArray(item.channels.map(channel => String(channel)))
          : [],
        messageCount: Number(item.messageCount || 0),
        lastMessageAt: item.lastMessageAt
          ? new Date(item.lastMessageAt).toISOString()
          : null,
      };
    })
    .filter((option): option is MongoUserOption => Boolean(option));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getMembership(workspaceId, user.id);
    if (!membership) {
      return NextResponse.json(
        { error: "Workspace not found or unauthorized" },
        { status: 404 }
      );
    }

    if (!isWorkspaceManagerRole(membership.role)) {
      return NextResponse.json(
        { error: "Forbidden: manager role required" },
        { status: 403 }
      );
    }

    await connectDB();

    const [settings, managerOptions, mongoUserOptions, sourceOptions] =
      await Promise.all([
        getWorkspaceManagerReplyGuardConfig(workspaceId),
        getManagerOptions(workspaceId),
        getMongoUserOptions(workspaceId),
        getSourceOptions(workspaceId),
      ]);

    return NextResponse.json({
      success: true,
      settings: {
        enabled: settings.enabled,
        skipIfManagerRecentlyReplied: settings.skipIfManagerRecentlyReplied,
        skipIfTaggedManagerMessage: settings.skipIfTaggedManagerMessage,
        managerRecentReplyWindowSeconds:
          settings.managerRecentReplyWindowSeconds,
        managerUserLinks: settings.managerUserLinks,
      },
      managerOptions,
      mongoUserOptions,
      sourceOptions,
    });
  } catch (error) {
    console.error("[Workspace Airi Manager Guard GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch manager guard settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getMembership(workspaceId, user.id);
    if (!membership) {
      return NextResponse.json(
        { error: "Workspace not found or unauthorized" },
        { status: 404 }
      );
    }

    if (!isWorkspaceManagerRole(membership.role)) {
      return NextResponse.json(
        { error: "Forbidden: manager role required" },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = UpdateManagerGuardSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const normalizedLinks = normalizeManagerLinks(parsed.data.managerUserLinks);

    await connectDB();
    const historySettingMutation =
      await buildHistorySettingPersistenceMutation(workspaceId);
    await WorkspaceAiriSettings.findOneAndUpdate(
      { workspaceId },
      {
        $set: {
          ...historySettingMutation.setPayload,
          manager_reply_guard_enabled: parsed.data.enabled,
          skip_if_manager_recently_replied:
            parsed.data.skipIfManagerRecentlyReplied,
          skip_if_tagged_manager_message:
            parsed.data.skipIfTaggedManagerMessage,
          manager_recent_reply_window_seconds:
            parsed.data.managerRecentReplyWindowSeconds,
          manager_user_links: normalizedLinks,
          updated_by: user.id,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const saved = await getWorkspaceManagerReplyGuardConfig(workspaceId);

    return NextResponse.json({
      success: true,
      settings: {
        enabled: saved.enabled,
        skipIfManagerRecentlyReplied: saved.skipIfManagerRecentlyReplied,
        skipIfTaggedManagerMessage: saved.skipIfTaggedManagerMessage,
        managerRecentReplyWindowSeconds: saved.managerRecentReplyWindowSeconds,
        managerUserLinks: saved.managerUserLinks,
      },
    });
  } catch (error) {
    console.error("[Workspace Airi Manager Guard PATCH] Error:", error);
    return NextResponse.json(
      {
        error: "Failed to update manager guard settings",
        defaults: ManagerReplyGuardDefaults,
      },
      { status: 500 }
    );
  }
}
