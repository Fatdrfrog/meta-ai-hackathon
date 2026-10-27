import { createLogger } from "@icecore/shared/lib/logger";
import { isMongoDuplicateKeyError } from "@icecore/shared/lib/mongo-errors";
import {
  buildWhatsAppCanonicalIdFromBsuid,
  listWhatsAppPhoneIdentityVariants,
  normalizeWhatsAppPhone,
  parseWhatsAppRecipientTarget,
} from "@icecore/shared/lib/whatsapp/contact-identities";

export const CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC = {
  keys: { whatsappConversationIdentityKey: 1 },
  options: {
    name: "conversations_whatsapp_identity_owner_v1",
    unique: true,
    partialFilterExpression: {
      channel: "whatsapp",
      whatsappConversationIdentityKey: { $type: "string" },
    },
  },
} as const;
export const CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC = {
  keys: { whatsappConversationIdentityKeys: 1 },
  options: {
    name: "conversations_whatsapp_identity_aliases_v1",
    unique: true,
    partialFilterExpression: {
      channel: "whatsapp",
      whatsappConversationIdentityKeys: { $type: "array" },
      "whatsappConversationIdentityKeys.0": { $exists: true },
    },
  },
} as const;
const ownershipLog = createLogger("whatsapp-conversation-ownership");
export const OWNER_FIRST_SORT = {
  whatsappConversationIdentityKey: -1,
  lastMessageAt: -1,
  updatedAt: -1,
  _id: -1,
} as const;

type OwnershipConversation = {
  _id: unknown;
  whatsappConversationIdentityKey?: string | null;
  whatsappConversationIdentityKeys?: string[];
};
export type WhatsAppConversationOwnershipModel = {
  collection: {
    createIndex: (
      keys: Record<string, 1 | -1>,
      options: {
        name: string;
        unique: true;
        partialFilterExpression: Record<string, unknown>;
      },
    ) => Promise<string>;
  };
  findOne: (
    filter: Record<string, unknown>,
  ) => PromiseLike<OwnershipConversation | null>;
  find: (filter: Record<string, unknown>) => {
    select: (fields: string) => {
      sort: (sort: typeof OWNER_FIRST_SORT) => {
        limit: (limit: number) => PromiseLike<OwnershipConversation[]>;
      };
    };
  };
  findOneAndUpdate: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { new: true; timestamps: false },
  ) => PromiseLike<OwnershipConversation | null>;
};

export function buildWhatsAppConversationIdentityKey(params: {
  workspaceId: string;
  sourceId?: string | null;
  chatId: string;
}): string {
  const workspaceId = params.workspaceId.trim();
  const chatId = params.chatId.trim();
  if (!workspaceId || !chatId)
    throw new Error("WhatsApp conversation identity is required");
  const phone = normalizeWhatsAppPhone(chatId);
  const target = parseWhatsAppRecipientTarget(chatId);
  const canonicalId = phone
    ? `wa_${phone}`
    : !chatId.startsWith("wa_group_") && target && target.kind !== "phone"
      ? buildWhatsAppCanonicalIdFromBsuid(target.value)
      : chatId;
  return JSON.stringify([
    "whatsapp:v1",
    workspaceId,
    params.sourceId?.trim() || null,
    canonicalId,
  ]);
}

export type GetOrCreateWhatsAppConversationParams<T = OwnershipConversation> = {
  workspaceId: string;
  sourceId?: string | null;
  chatId: string;
  candidateIds: string[];
  create: (ownershipKey: string, identityKeys: string[]) => Promise<T | null>;
};

export function buildWhatsAppConversationSourceScopes(
  sourceId: string | null | undefined,
): Array<string | null> {
  const normalizedSourceId = String(sourceId || "").trim();
  return normalizedSourceId ? [normalizedSourceId, null] : [null];
}

export function normalizeWhatsAppConversationPhoneCandidate(
  phone: string | null | undefined,
): string {
  return normalizeWhatsAppPhone(phone) || "";
}

export function resolveWhatsAppConversationIdentityCandidates(
  recipient: string,
): string[] {
  const raw = String(recipient || "").trim();
  const target = parseWhatsAppRecipientTarget(raw);
  const parsedPhone =
    target?.kind === "phone"
      ? target.value
      : normalizeWhatsAppPhone(raw.replace(/^wa_/i, "")) ||
        normalizeWhatsAppPhone(raw) ||
        "";
  const phone = normalizeWhatsAppConversationPhoneCandidate(parsedPhone);
  const phoneVariants = listWhatsAppPhoneIdentityVariants(
    parsedPhone || raw.replace(/^wa_/i, "") || raw,
  );

  return Array.from(
    new Set(
      [
        raw,
        phone,
        phone ? `wa_${phone}` : "",
        target?.value || "",
        target?.kind === "phone" && target.value ? `wa_${target.value}` : "",
        target && target.kind !== "phone"
          ? buildWhatsAppCanonicalIdFromBsuid(target.value)
          : "",
        ...phoneVariants,
        ...phoneVariants.map((variant) => `wa_${variant}`),
      ].filter(Boolean),
    ),
  );
}

function rescopeOwnedIdentityKeys(params: {
  owner: OwnershipConversation;
  workspaceId: string;
  fromSourceId: string | null;
  sourceId: string | null;
}): string[] {
  return [
    params.owner.whatsappConversationIdentityKey,
    ...(params.owner.whatsappConversationIdentityKeys || []),
  ].flatMap((key) => {
    if (typeof key !== "string") return [];
    try {
      const decoded: unknown = JSON.parse(key);
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 4 ||
        decoded[0] !== "whatsapp:v1" ||
        decoded[1] !== params.workspaceId ||
        decoded[2] !== params.fromSourceId ||
        typeof decoded[3] !== "string" ||
        !decoded[3].trim()
      )
        return [];
      return [
        buildWhatsAppConversationIdentityKey({
          workspaceId: params.workspaceId,
          sourceId: params.sourceId,
          chatId: decoded[3],
        }),
      ];
    } catch {
      return [];
    }
  });
}

export function createWhatsAppConversationOwnership(
  Conversation: WhatsAppConversationOwnershipModel,
) {
  let ownershipIndexPromise: Promise<unknown> | null = null;
  async function ensureWhatsAppConversationOwnershipIndex(): Promise<void> {
    if (!ownershipIndexPromise) {
      ownershipIndexPromise = Promise.all(
        [
          CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC,
          CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC,
        ].map((spec) =>
          Conversation.collection.createIndex(spec.keys, spec.options),
        ),
      ).catch((error: unknown) => {
        ownershipIndexPromise = null;
        throw error;
      });
    }
    // A failed/conflicting index must stop the writer; proceeding would recreate
    // the find-then-insert race across web and worker processes.
    await ownershipIndexPromise;
  }

  function buildOwnerQuery(
    params: Omit<GetOrCreateWhatsAppConversationParams, "create">,
  ) {
    // Only aliases supplied by this identity resolver are enrolled. Do not infer
    // a relationship between disjoint phone-only and BSUID-only observations.
    const identityKeys = Array.from(
      new Set(
        [params.chatId, ...params.candidateIds]
          .filter(Boolean)
          .map((chatId) =>
            buildWhatsAppConversationIdentityKey({ ...params, chatId }),
          ),
      ),
    );
    const sourceId = params.sourceId?.trim() || null;
    const scope = {
      workspaceId: params.workspaceId.trim(),
      channel: "whatsapp",
    };
    const ownerScope = { ...scope, sourceId };
    // Scope each branch so MongoDB can subplan both partial identity indexes.
    const ownerFilter = {
      $or: [
        {
          ...ownerScope,
          whatsappConversationIdentityKey: {
            $in: identityKeys,
            $type: "string",
          },
        },
        {
          ...ownerScope,
          whatsappConversationIdentityKeys: {
            $in: identityKeys,
            $type: "array",
          },
          "whatsappConversationIdentityKeys.0": { $exists: true },
        },
      ],
    };
    return { identityKeys, sourceId, scope, ownerFilter };
  }

  async function readOwnerFilter(
    ownerFilter: Record<string, unknown>,
  ): Promise<OwnershipConversation | null> {
    const owners = await Conversation.find(ownerFilter)
      .select(
        "+whatsappConversationIdentityKey +whatsappConversationIdentityKeys",
      )
      .sort(OWNER_FIRST_SORT)
      .limit(2);
    if (owners.length > 1) {
      throw new Error(
        "WhatsApp conversation aliases have conflicting enrolled owners",
      );
    }
    return owners[0] || null;
  }

  async function findOwnedWhatsAppConversation<T = OwnershipConversation>(
    params: Omit<GetOrCreateWhatsAppConversationParams<T>, "create">,
  ): Promise<T | null> {
    return (await readOwnerFilter(
      buildOwnerQuery(params).ownerFilter,
    )) as T | null;
  }

  async function findLegacyOwners(params: {
    workspaceId: string;
    sourceId: string | null;
    candidateIds: string[];
    field: "chat" | "user";
  }) {
    const base = {
      workspaceId: params.workspaceId,
      channel: "whatsapp",
      sourceId: params.sourceId,
      [params.field]: { $in: params.candidateIds },
    };
    // Use indexed identity equality to bound each category. Actual message activity
    // outranks an empty newer sibling and a stale scenario lock is not priority.
    for (const category of [
      { whatsappConversationIdentityKey: { $type: "string" } },
      {
        $or: [
          { "messages.0": { $exists: true } },
          { lastMessageAt: { $type: "date" } },
          { first_inbound_at: { $type: "date" } },
        ],
      },
      { "airi_scenario_state.lockedScenarioId": { $type: "string", $ne: "" } },
      {},
    ]) {
      const rows = await Conversation.find({ ...base, ...category })
        .select(
          "+whatsappConversationIdentityKey +whatsappConversationIdentityKeys",
        )
        .sort(OWNER_FIRST_SORT)
        .limit(2);
      if (rows.length) return rows;
    }
    return [];
  }

  async function findLegacyWhatsAppConversation<
    T = OwnershipConversation,
  >(params: {
    workspaceId: string;
    sourceId: string | null;
    candidateIds: string[];
    field: "chat" | "user";
  }): Promise<T | null> {
    return ((await findLegacyOwners(params))[0] as T) || null;
  }

  /**
   * Durable counterpart to the read-only lookup. New rows use normal save
   * hooks; the partial unique key chooses the cross-process winner before any
   * message/scenario can be attached. Legacy duplicates are pinned, never merged.
   */
  async function getOrCreateWhatsAppConversation<T = OwnershipConversation>(
    params: GetOrCreateWhatsAppConversationParams<T>,
  ): Promise<{ conversation: T; created: boolean } | null> {
    await ensureWhatsAppConversationOwnershipIndex();
    const key = buildWhatsAppConversationIdentityKey(params);
    const { identityKeys, sourceId, scope, ownerFilter } =
      buildOwnerQuery(params);
    const candidates = Array.from(
      new Set(
        [params.chatId, ...params.candidateIds].flatMap(
          resolveWhatsAppConversationIdentityCandidates,
        ),
      ),
    );

    async function readOwner(): Promise<OwnershipConversation | null> {
      const owner = await readOwnerFilter(ownerFilter);
      if (!owner) return null;
      if (
        identityKeys.every((identityKey) =>
          owner.whatsappConversationIdentityKeys?.includes(identityKey),
        )
      )
        return owner;
      // Persist newly proven aliases before returning ownership. A collision
      // with a distinct existing owner fails closed; it is not a safe merge.
      return Conversation.findOneAndUpdate(
        { _id: owner._id, ...scope, sourceId },
        {
          $addToSet: {
            whatsappConversationIdentityKeys: { $each: identityKeys },
          },
        },
        { new: true, timestamps: false },
      );
    }
    retry: for (let attempt = 0; attempt < 3; attempt++) {
      const owner = await readOwner();
      if (owner) return { conversation: owner as T, created: false };
      try {
        for (const legacySource of buildWhatsAppConversationSourceScopes(
          sourceId,
        )) {
          const scopedOwner =
            legacySource !== sourceId
              ? await readOwnerFilter(
                  buildOwnerQuery({ ...params, sourceId: legacySource })
                    .ownerFilter,
                )
              : null;
          for (const field of [null, "chat", "user"] as const) {
            const legacy =
              field === null
                ? scopedOwner
                  ? [scopedOwner]
                  : []
                : await findLegacyOwners({
                    workspaceId: scope.workspaceId,
                    sourceId: legacySource,
                    candidateIds: candidates,
                    field,
                  });
            const selected = legacy[0];
            if (!selected) continue;
            if (legacy.length > 1) {
              ownershipLog.warn("whatsapp.conversation.legacy_owners", {
                workspace_id: params.workspaceId,
                source_id: sourceId,
                selected_conversation_id: String(selected._id),
                conflicting_conversation_ids: legacy
                  .slice(1)
                  .map((row) => String(row._id)),
                repair_required: true,
              });
            }
            // Source-less rows are adopted with a CAS so two sources cannot
            // both claim one. Preserve established source-scoped identity keys.
            const claimed = await Conversation.findOneAndUpdate(
              {
                _id: selected._id,
                ...scope,
                sourceId: legacySource,
                whatsappConversationIdentityKey:
                  selected.whatsappConversationIdentityKey ?? null,
                ...(legacySource !== sourceId
                  ? {
                      whatsappConversationIdentityKeys:
                        selected.whatsappConversationIdentityKeys ?? null,
                    }
                  : {}),
              },
              {
                $set: {
                  whatsappConversationIdentityKey:
                    legacySource === sourceId
                      ? selected.whatsappConversationIdentityKey || key
                      : key,
                  ...(legacySource === sourceId
                    ? {}
                    : {
                        whatsappConversationIdentityKeys: Array.from(
                          new Set([
                            ...rescopeOwnedIdentityKeys({
                              owner: selected,
                              workspaceId: scope.workspaceId,
                              fromSourceId: legacySource,
                              sourceId,
                            }),
                            ...identityKeys,
                          ]),
                        ),
                      }),
                  sourceId,
                },
                ...(legacySource === sourceId
                  ? {
                      $addToSet: {
                        whatsappConversationIdentityKeys: {
                          $each: identityKeys,
                        },
                      },
                    }
                  : {}),
              },
              { new: true, timestamps: false },
            );
            if (claimed) return { conversation: claimed as T, created: false };
            // Another source or alias claimed this row. Restart from the durable
            // owner rather than creating from a stale negative lookup.
            continue retry;
          }
          const racedOwner = await readOwner();
          if (racedOwner)
            return { conversation: racedOwner as T, created: false };
        }
        const conversation = await params.create(key, identityKeys);
        return conversation ? { conversation, created: true } : null;
      } catch (error) {
        if (!isMongoDuplicateKeyError(error)) throw error;
        const winner = await readOwner();
        if (winner) return { conversation: winner as T, created: false };
        throw error;
      }
    }
    throw new Error("WhatsApp conversation ownership changed repeatedly");
  }

  return {
    ensureWhatsAppConversationOwnershipIndex,
    findOwnedWhatsAppConversation,
    findLegacyWhatsAppConversation,
    getOrCreateWhatsAppConversation,
  };
}
