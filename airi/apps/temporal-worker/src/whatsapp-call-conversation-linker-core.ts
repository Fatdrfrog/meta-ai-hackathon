import {
  buildNormalizedWhatsAppContact,
  buildWhatsAppCanonicalId,
  type WhatsAppNormalizedContact,
} from "@icecore/shared/lib/whatsapp/contact-identities";
import type { WhatsAppCallWebhookEvent } from "@icecore/shared/lib/whatsapp/webhook-call-events";
import { resolveWhatsAppConversationIdentityCandidates } from "@icecore/airi-runtime/whatsapp-conversation-ownership";

export type WhatsAppCallConversationLinkResult = {
  conversationId: string;
  customerId: string | null;
  createdConversation: boolean;
};

type ExecQuery<T> = {
  exec: () => Promise<T>;
};

type LeanQuery<TDefault> = {
  lean: <T = TDefault>() => ExecQuery<T>;
};

type SelectLeanQuery<TDefault> = {
  select: (fields: string) => LeanQuery<TDefault>;
};

export type WhatsAppCallLinkedConversation = {
  _id?: unknown;
  customerId?: unknown;
};

export type WhatsAppCallSessionLink = {
  _id?: unknown;
  conversationId?: unknown;
  customerId?: unknown;
};

export type WhatsAppCallConversationLinkerDependencies<TSupabase = unknown> = {
  buildWhatsAppIdentitySnapshot: (
    contact: WhatsAppNormalizedContact,
  ) => Record<string, unknown>;
  chatModel: {
    findOneAndUpdate: (
      query: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => ExecQuery<WhatsAppCallLinkedConversation | null>;
  };
  conversationModel: {
    create: (
      doc: Record<string, unknown>,
    ) => Promise<WhatsAppCallLinkedConversation>;
  };
  getOrCreateConversation: (params: {
    workspaceId: string;
    sourceId: string | null;
    chatId: string;
    candidateIds: string[];
    create: (
      ownershipKey: string,
      identityKeys: string[],
    ) => Promise<WhatsAppCallLinkedConversation | null>;
  }) => Promise<{
    conversation: WhatsAppCallLinkedConversation;
    created: boolean;
  } | null>;
  ensureCompanyConversationCapacity: (
    supabaseAdmin: TSupabase,
    workspaceId: string,
  ) => Promise<{ allowed: boolean }>;
  getWorkspaceBotDefault: (workspaceId: string) => Promise<boolean>;
  getWorkspaceCoachDefault: (workspaceId: string) => Promise<boolean>;
  getWorkspaceScenariosDefault: (workspaceId: string) => Promise<boolean>;
  supabaseAdmin: TSupabase;
  userModel: {
    findOneAndUpdate: (
      query: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => ExecQuery<WhatsAppCallLinkedConversation | null>;
  };
  whatsAppCallSessionModel: {
    findOne: (
      query: Record<string, unknown>,
    ) => SelectLeanQuery<WhatsAppCallSessionLink | null>;
    updateOne: (
      query: Record<string, unknown>,
      update: Record<string, unknown>,
    ) => ExecQuery<unknown>;
  };
};

function stringifyId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value || null;
  if (
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const id = value.toString();
    return id && id !== "[object Object]" ? id : null;
  }
  return String(value);
}

function buildCallContact(event: WhatsAppCallWebhookEvent) {
  const businessInitiated = /^business/i.test(event.direction || "");
  const directionalWaId = businessInitiated ? event.to : event.from;
  const directionalUserId = businessInitiated
    ? event.toUserId
    : event.fromUserId;
  const directionalParentUserId = businessInitiated
    ? event.toParentUserId
    : event.fromParentUserId;

  return buildNormalizedWhatsAppContact({
    waId: event.contactWaId || directionalWaId || event.recipientId,
    userId:
      event.contactUserId ||
      event.recipientUserId ||
      directionalUserId ||
      event.fromUserId ||
      event.toUserId,
    parentUserId:
      event.contactParentUserId ||
      event.recipientParentUserId ||
      directionalParentUserId ||
      event.fromParentUserId ||
      event.toParentUserId,
    profileName: event.contactName || "Customer",
    username: event.contactUsername,
  });
}

export function createWhatsAppCallConversationLinker<TSupabase = unknown>(
  deps: WhatsAppCallConversationLinkerDependencies<TSupabase>,
) {
  return async function linkWhatsAppCallSessionToConversation(params: {
    workspaceId: string;
    sourceId?: string | null;
    event: WhatsAppCallWebhookEvent;
  }): Promise<WhatsAppCallConversationLinkResult | null> {
    const callId = params.event.callId;
    if (!callId) return null;

    const sourceId = params.sourceId || null;
    const existingSession = await deps.whatsAppCallSessionModel
      .findOne({
        workspaceId: params.workspaceId,
        sourceId,
        callId,
        conversationId: { $ne: null },
      })
      .select("_id conversationId customerId")
      .lean<WhatsAppCallSessionLink | null>()
      .exec();
    const existingConversationId = stringifyId(existingSession?.conversationId);
    if (existingConversationId) {
      return {
        conversationId: existingConversationId,
        customerId: stringifyId(existingSession?.customerId),
        createdConversation: false,
      };
    }

    const contact = buildCallContact(params.event);
    const canonicalId = contact ? buildWhatsAppCanonicalId(contact) : null;
    if (!contact || !canonicalId) return null;

    const identitySnapshot = deps.buildWhatsAppIdentitySnapshot(contact);
    const firstName = contact.profile.name || "Customer";

    const [customerUser, chat] = await Promise.all([
      deps.userModel
        .findOneAndUpdate(
          { _id: canonicalId },
          {
            $set: {
              workspaceId: params.workspaceId,
              isBot: false,
              whatsapp: identitySnapshot,
              ...(contact.profile.username
                ? { username: contact.profile.username }
                : {}),
            },
            $setOnInsert: {
              firstName,
            },
          },
          { upsert: true, new: true },
        )
        .exec(),
      deps.chatModel
        .findOneAndUpdate(
          { _id: canonicalId },
          {
            $set: {
              type: "whatsapp",
              workspaceId: params.workspaceId,
              ...(sourceId ? { sourceId } : {}),
              whatsapp: identitySnapshot,
              title: firstName,
              ...(contact.profile.username
                ? { username: contact.profile.username }
                : {}),
            },
          },
          { upsert: true, new: true },
        )
        .exec(),
    ]);

    const chatId = stringifyId(chat?._id) || canonicalId;
    const userId = stringifyId(customerUser?._id) || canonicalId;
    const owner = await deps.getOrCreateConversation({
      workspaceId: params.workspaceId,
      sourceId,
      chatId,
      candidateIds: Array.from(
        new Set([
          chatId,
          userId,
          ...[contact.waId, contact.userId, contact.parentUserId].flatMap(
            (identity) =>
              identity
                ? resolveWhatsAppConversationIdentityCandidates(identity)
                : [],
          ),
        ]),
      ),
      create: async (ownershipKey, identityKeys) => {
        const capacity = await deps.ensureCompanyConversationCapacity(
          deps.supabaseAdmin,
          params.workspaceId,
        );
        if (!capacity.allowed) return null;

        const [
          botDefaultEnabled,
          scenariosDefaultEnabled,
          coachDefaultEnabled,
        ] = await Promise.all([
          deps.getWorkspaceBotDefault(params.workspaceId),
          deps.getWorkspaceScenariosDefault(params.workspaceId),
          deps.getWorkspaceCoachDefault(params.workspaceId),
        ]);

        return deps.conversationModel.create({
          whatsappConversationIdentityKey: ownershipKey,
          whatsappConversationIdentityKeys: identityKeys,
          chat: chatId,
          user: userId,
          messages: [],
          is_classified: false,
          workspaceId: params.workspaceId,
          ...(sourceId ? { sourceId } : {}),
          channel: "whatsapp",
          status: "open",
          airi_bot_enabled: botDefaultEnabled,
          airi_scenarios_enabled: scenariosDefaultEnabled,
          airi_coach_enabled: coachDefaultEnabled,
        });
      },
    });
    if (!owner) return null;
    const conversation = owner.conversation;
    const createdConversation = owner.created;

    const conversationId = stringifyId(conversation?._id);
    if (!conversationId) return null;

    const customerId = stringifyId(conversation?.customerId);
    await deps.whatsAppCallSessionModel
      .updateOne(
        {
          workspaceId: params.workspaceId,
          sourceId,
          callId,
        },
        {
          $set: {
            conversationId,
            customerId,
          },
        },
      )
      .exec();

    return {
      conversationId,
      customerId,
      createdConversation,
    };
  };
}
