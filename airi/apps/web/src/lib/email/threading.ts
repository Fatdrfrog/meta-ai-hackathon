import mongoose from "mongoose";
import {
  getWorkspaceBotDefault,
  getWorkspaceCoachDefault,
  getWorkspaceScenariosDefault,
} from "@/lib/airi/workspace-bot-default";
import { assertCompanyConversationCapacity } from "@/lib/limits/company-limits";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { Conversation } from "@/models/conversation";
import Message from "@/models/message";

type HeadersMap = Record<string, string | string[]>;

function buildSubjectCandidates(subject: string | null | undefined) {
  const original = String(subject || "").trim();
  if (!original) return [null];

  const withoutReplyPrefix = original.replace(/^(re:\s*)+/i, "").trim();
  return Array.from(
    new Set(
      [original, withoutReplyPrefix].filter(candidate => candidate.length > 0)
    )
  );
}

export async function findOrCreateEmailConversation(params: {
  workspaceId: string;
  to: string[];
  from: string[];
  subject?: string | null;
  headers?: HeadersMap | null;
  sourceId?: string;
}): Promise<mongoose.Document & { _id: mongoose.Types.ObjectId }> {
  const { workspaceId, to, from, subject, headers, sourceId } = params;

  // 1) Try strict threading by Message-ID / In-Reply-To / References
  const inReplyTo = getHeader(headers, "In-Reply-To");
  const referencesRaw = getHeader(headers, "References");
  const referenceIds = splitReferences(referencesRaw);

  if (inReplyTo || referenceIds.length > 0) {
    const idsToSearch = [inReplyTo, ...referenceIds].filter(
      Boolean
    ) as string[];
    const priorMessage = await Message.findOne({
      workspaceId,
      "external_ids.messageId": { $in: idsToSearch },
    }).populate("conversation");

    if (priorMessage?.conversation) {
      const conversation =
        priorMessage.conversation as unknown as mongoose.Document & {
          _id: mongoose.Types.ObjectId;
          sourceId?: string;
        };
      if (sourceId && !conversation.sourceId) {
        await Conversation.updateOne(
          { _id: conversation._id },
          { $set: { sourceId } }
        );
        conversation.sourceId = sourceId;
      }
      return conversation;
    }
  }

  // 2) Fallback: recent conversation same participants + subject within 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const subjectCandidates = buildSubjectCandidates(subject);
  const participantFilter =
    from.length > 0 && to.length > 0
      ? {
          $or: [
            {
              "participants.from": { $in: from },
              "participants.to": { $in: to },
            },
            {
              "participants.from": { $in: to },
              "participants.to": { $in: from },
            },
          ],
        }
      : {
          "participants.from": { $in: from },
          "participants.to": { $in: to },
        };
  const recent = await Conversation.findOne({
    workspaceId,
    channel: "email",
    subject:
      subjectCandidates.length === 1
        ? subjectCandidates[0]
        : { $in: subjectCandidates },
    ...participantFilter,
    createdAt: { $gte: thirtyDaysAgo },
  });
  if (recent) {
    if (sourceId && !recent.sourceId) {
      await Conversation.updateOne({ _id: recent._id }, { $set: { sourceId } });
      recent.sourceId = sourceId;
    }
    return recent as unknown as mongoose.Document & {
      _id: mongoose.Types.ObjectId;
    };
  }

  // 3) Create new
  await assertCompanyConversationCapacity(supabaseAdmin, workspaceId);

  const [botDefaultEnabled, scenariosDefaultEnabled, coachDefaultEnabled] =
    await Promise.all([
      getWorkspaceBotDefault(workspaceId),
      getWorkspaceScenariosDefault(workspaceId),
      getWorkspaceCoachDefault(workspaceId),
    ]);
  const conversation = await Conversation.create({
    workspaceId,
    channel: "email",
    ...(sourceId ? { sourceId } : {}),
    subject: subject ?? null,
    participants: { from, to },
    status: "open",
    airi_bot_enabled: botDefaultEnabled,
    airi_scenarios_enabled: scenariosDefaultEnabled,
    airi_coach_enabled: coachDefaultEnabled,
  });
  return conversation as unknown as mongoose.Document & {
    _id: mongoose.Types.ObjectId;
  };
}

function getHeader(
  headers: HeadersMap | null | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find(
    k => k.toLowerCase() === name.toLowerCase()
  );
  const value = key ? headers[key] : undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function splitReferences(raw: string | undefined): string[] {
  if (!raw) return [];
  // References can be multiple Message-IDs separated by spaces
  // <id1@domain> <id2@domain>
  const matches = raw.match(/<[^>]+>/g);
  return matches ? matches : [];
}

export default findOrCreateEmailConversation;
