import { validateOptionalConversationChannelParam } from "@/lib/api/conversation-channel-query";
import { logger } from "@/lib/logger";
import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  fetchTelegramSubscriberContacts,
  scheduleTelegramSubscriberBackfill,
} from "@/lib/telegram/subscribers";
import "@/models/chat";
import { Conversation } from "@/models/conversation";
import Customer from "@/models/customer";
import "@/models/user";
import { normalizeWhatsAppPhone as normalizeSharedWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { PipelineStage } from "mongoose";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { readStringOrEmpty } from "@icecore/shared/lib/value-utils";
import { requiredFieldResponse } from "@/lib/api/json-body";

type ContactRow = {
  identifier: string | number;
  channel: string;
  name: string;
  sourceId?: string | null;
  categories?: unknown[];
};

type CustomerContactRow = {
  displayName?: string | null;
  identities?: Array<{
    type?: string | null;
    channel?: string | null;
    sourceId?: string | null;
    value?: string | null;
    normalizedValue?: string | null;
  }>;
  profileSummary?: {
    contactPoints?: {
      phones?: string[];
    } | null;
  } | null;
};

const PLACEHOLDER_NAMES = new Set(["unknown", "customer", "contact"]);
const TELEGRAM_BUSINESS_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeContactName(value: unknown): string {
  const name = readStringOrEmpty(value, { trim: true });
  return PLACEHOLDER_NAMES.has(name.toLowerCase()) ? "" : name;
}

function normalizeWhatsAppPhone(value: unknown): string {
  const raw = readStringOrEmpty(value, { trim: true });
  if (!raw) return "";
  const withoutPrefix = raw.replace(/^wa_/i, "");
  if (withoutPrefix.startsWith("wa_bsuid_")) return "";
  if (/[A-Za-z]/.test(withoutPrefix)) return "";
  return normalizeSharedWhatsAppPhone(withoutPrefix) || "";
}

function getContactMergeKey(
  contact: Pick<ContactRow, "channel" | "identifier" | "sourceId">
) {
  const sourceSuffix = contact.sourceId ? `:${contact.sourceId}` : "";
  if (contact.channel === "whatsapp") {
    const phone = normalizeWhatsAppPhone(contact.identifier);
    return phone
      ? `whatsapp:${phone}${sourceSuffix}`
      : `whatsapp:${String(contact.identifier)}${sourceSuffix}`;
  }
  return `${contact.channel}:${String(contact.identifier).trim().toLowerCase()}${sourceSuffix}`;
}

function extractWhatsAppCustomerPhones(
  customer: CustomerContactRow,
  sourceIds: string[]
): Array<{ phone: string; sourceId?: string | null }> {
  const phones = new Map<string, { phone: string; sourceId?: string | null }>();
  const allowedSources = new Set(sourceIds);

  for (const identity of customer.identities || []) {
    if (identity.type !== "phone" || identity.channel !== "whatsapp") continue;
    if (
      allowedSources.size > 0 &&
      !allowedSources.has(identity.sourceId || "")
    ) {
      continue;
    }
    const phone = normalizeWhatsAppPhone(
      identity.normalizedValue || identity.value || ""
    );
    if (phone) {
      const sourceId = identity.sourceId || null;
      phones.set(`${phone}:${sourceId || ""}`, { phone, sourceId });
    }
  }

  return Array.from(phones.values());
}

async function fetchSyncedWhatsAppCustomerContacts(params: {
  workspaceId: string;
  channel?: string | null;
  sourceIds: string[];
  search: string;
  limit: number;
}): Promise<ContactRow[]> {
  if (params.channel && params.channel !== "whatsapp") return [];

  const sourceScopedPhoneIdentity: Record<string, unknown> = {
    type: "phone",
    channel: "whatsapp",
  };
  if (params.sourceIds.length > 0) {
    sourceScopedPhoneIdentity.sourceId = { $in: params.sourceIds };
  }

  const andFilters: Record<string, unknown>[] = [
    { identities: { $elemMatch: sourceScopedPhoneIdentity } },
  ];

  if (params.search) {
    const escapedSearch = params.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = new RegExp(escapedSearch, "i");
    andFilters.push({
      $or: [
        { displayName: { $regex: searchRegex } },
        { "profileSummary.contactPoints.phones": { $regex: searchRegex } },
        { "identities.value": { $regex: searchRegex } },
        { "identities.normalizedValue": { $regex: searchRegex } },
      ],
    });
  }

  const customers = (await Customer.find({
    workspaceId: params.workspaceId,
    status: "active",
    $and: andFilters,
  })
    .select("displayName identities profileSummary")
    .limit(params.limit)
    .lean()) as CustomerContactRow[];

  return customers.flatMap(customer => {
    const name = normalizeContactName(customer.displayName);
    return extractWhatsAppCustomerPhones(customer, params.sourceIds).map(
      ({ phone, sourceId }) => ({
        identifier: `wa_${phone}`,
        channel: "whatsapp",
        sourceId,
        name,
      })
    );
  });
}

async function fetchEligibleTelegramBusinessConnectionIds(params: {
  workspaceId: string;
  sourceIds: string[];
}): Promise<string[]> {
  try {
    const query = supabaseAdmin
      .from("telegram_business_connections")
      .select("business_connection_id")
      .eq("workspace_id", params.workspaceId)
      .eq("is_enabled", true)
      .eq("can_reply", true);

    const { data, error } = params.sourceIds.length
      ? await query.in("source_id", params.sourceIds)
      : await query;

    if (error) {
      logger.warn("Failed to load Telegram Business connections for contacts", {
        workspaceId: params.workspaceId,
        error,
      });
      return [];
    }

    return (data || [])
      .map(row =>
        typeof row?.business_connection_id === "string"
          ? row.business_connection_id.trim()
          : ""
      )
      .filter(Boolean);
  } catch (error) {
    logger.warn("Telegram Business contact eligibility lookup failed", {
      workspaceId: params.workspaceId,
      error,
    });
    return [];
  }
}

function applyTelegramContactEligibilityMatch(
  matchQuery: Record<string, unknown>,
  eligibleBusinessConnectionIds: string[]
) {
  const standardBotSubscriberMatch = {
    $and: [
      {
        $or: [
          { business_connection_id: { $exists: false } },
          { business_connection_id: null },
          { business_connection_id: "" },
        ],
      },
      {
        $or: [
          { first_inbound_at: { $exists: true, $ne: null } },
          { last_inbound_at: { $exists: true, $ne: null } },
        ],
      },
    ],
  };

  const businessReplyWindowCutoff = new Date(
    Date.now() - TELEGRAM_BUSINESS_REPLY_WINDOW_MS
  );
  const eligibilityBranches: Record<string, unknown>[] = [
    standardBotSubscriberMatch,
  ];

  if (eligibleBusinessConnectionIds.length > 0) {
    eligibilityBranches.push({
      business_connection_id: { $in: eligibleBusinessConnectionIds },
      last_inbound_at: { $gte: businessReplyWindowCutoff },
    });
  }

  matchQuery.$or = eligibilityBranches;
  matchQuery.$nor = [{ chat: /^-/ }, { chat: /^tg_-/ }];
}

function mergeContacts(
  contacts: ContactRow[],
  syncedContacts: ContactRow[],
  limit: number
): ContactRow[] {
  const merged = new Map<string, ContactRow>();

  for (const contact of [...contacts, ...syncedContacts]) {
    const key = getContactMergeKey(contact);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, contact);
      continue;
    }

    const existingName = normalizeContactName(existing.name);
    const incomingName = normalizeContactName(contact.name);
    merged.set(key, {
      ...existing,
      ...contact,
      categories: existing.categories || contact.categories,
      name: existingName || incomingName,
    });
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      const leftLabel =
        normalizeContactName(left.name) || String(left.identifier);
      const rightLabel =
        normalizeContactName(right.name) || String(right.identifier);
      return leftLabel.localeCompare(rightLabel, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    })
    .slice(0, limit);
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    const search = searchParams.get("search") || "";
    const sourceIds = [
      searchParams.get("sourceId") || "",
      ...(searchParams.get("sourceIds") || "").split(","),
    ]
      .map(item => item.trim())
      .filter(Boolean);
    const limit = Math.min(
      200,
      Math.max(
        1,
        Number.parseInt(searchParams.get("limit") || "200", 10) || 200
      )
    );
    const channelCheck = validateOptionalConversationChannelParam(
      searchParams.get("channel")
    );
    if (!channelCheck.ok) {
      return channelCheck.response;
    }
    const channel = channelCheck.value;

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    // Verify workspace access
    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await connectDB();

    const matchQuery: Record<string, unknown> = { workspaceId };
    if (channel) {
      matchQuery.channel = channel;
    }
    if (sourceIds.length > 0) {
      matchQuery.sourceId = { $in: Array.from(new Set(sourceIds)) };
    }
    if (channel === "telegram") {
      const eligibleBusinessConnectionIds =
        await fetchEligibleTelegramBusinessConnectionIds({
          workspaceId,
          sourceIds: Array.from(new Set(sourceIds)),
        });
      applyTelegramContactEligibilityMatch(
        matchQuery,
        eligibleBusinessConnectionIds
      );
    }

    // Aggregation pipeline to get unique contacts
    const pipeline: PipelineStage[] = [
      { $match: matchQuery },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      { $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "chats",
          localField: "chat",
          foreignField: "_id",
          as: "chatDetails",
        },
      },
      { $unwind: { path: "$chatDetails", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          channel: 1,
          sourceId: 1,
          identifier: {
            $switch: {
              branches: [
                {
                  case: { $eq: ["$channel", "whatsapp"] },
                  then: { $ifNull: ["$chat", "$user"] },
                },
                {
                  case: { $eq: ["$channel", "telegram"] },
                  then: { $ifNull: ["$chat", "$user"] },
                },
                {
                  case: { $eq: ["$channel", "email"] },
                  then: {
                    $ifNull: [
                      { $arrayElemAt: ["$participants.from", 0] },
                      {
                        $ifNull: [
                          { $arrayElemAt: ["$participants.to", 0] },
                          { $ifNull: ["$user", "$chat"] },
                        ],
                      },
                    ],
                  },
                },
              ],
              default: { $ifNull: ["$user", "$chat"] },
            },
          },
          firstName: {
            $ifNull: ["$userDetails.firstName", "$chatDetails.first_name"],
          },
          lastName: {
            $ifNull: ["$userDetails.lastName", "$chatDetails.last_name"],
          },
          title: "$chatDetails.title",
          username: {
            $ifNull: ["$userDetails.username", "$chatDetails.username"],
          },
          category: "$classification.category",
        },
      },
      {
        $group: {
          _id: {
            identifier: "$identifier",
            channel: "$channel",
            sourceId: "$sourceId",
          },
          firstName: { $first: "$firstName" },
          lastName: { $first: "$lastName" },
          title: { $first: "$title" },
          username: { $first: "$username" },
          categories: { $addToSet: "$category" },
        },
      },
      {
        $project: {
          _id: 0,
          identifier: "$_id.identifier",
          channel: "$_id.channel",
          sourceId: "$_id.sourceId",
          categories: 1,
          name: {
            $trim: {
              input: {
                $cond: [
                  { $gt: [{ $strLenCP: { $ifNull: ["$title", ""] } }, 0] },
                  "$title",
                  {
                    $cond: [
                      {
                        $or: [
                          {
                            $gt: [
                              { $strLenCP: { $ifNull: ["$firstName", ""] } },
                              0,
                            ],
                          },
                          {
                            $gt: [
                              { $strLenCP: { $ifNull: ["$lastName", ""] } },
                              0,
                            ],
                          },
                        ],
                      },
                      {
                        $trim: {
                          input: {
                            $concat: [
                              { $ifNull: ["$firstName", ""] },
                              " ",
                              { $ifNull: ["$lastName", ""] },
                            ],
                          },
                        },
                      },
                      { $ifNull: ["$username", "Unknown"] },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      { $sort: { name: 1 } },
    ];

    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const searchRegex = new RegExp(escapedSearch, "i");
      pipeline.push({
        $match: {
          $or: [
            { name: { $regex: searchRegex } },
            {
              $expr: {
                $regexMatch: {
                  input: { $toString: "$identifier" },
                  regex: searchRegex.source,
                  options: "i",
                },
              },
            },
            { categories: { $elemMatch: { $regex: searchRegex } } },
          ],
        },
      });
    }

    pipeline.push({ $limit: 200 });

    if (channel === "telegram" && sourceIds.length > 0) {
      for (const sourceId of sourceIds) {
        scheduleTelegramSubscriberBackfill({
          workspaceId,
          sourceId,
          reason: "contacts_api",
        });
      }
    }

    const [contacts, syncedCustomerContacts, telegramSubscriberContacts] =
      await Promise.all([
        Conversation.aggregate<ContactRow>(pipeline),
        fetchSyncedWhatsAppCustomerContacts({
          workspaceId,
          channel,
          sourceIds,
          search,
          limit: 200,
        }),
        channel && channel !== "telegram"
          ? Promise.resolve([])
          : fetchTelegramSubscriberContacts({
              workspaceId,
              sourceIds,
              search,
              limit,
            }),
      ]);

    return NextResponse.json({
      data: mergeContacts(
        contacts,
        [...syncedCustomerContacts, ...telegramSubscriberContacts],
        limit
      ),
    });
  } catch (error) {
    logger.error("Contacts fetch error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
