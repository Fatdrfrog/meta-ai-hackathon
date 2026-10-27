type IdentityLookupModel = {
  find: (filter: Record<string, unknown>) => {
    select: (projection: Record<string, number>) => {
      lean: () => Promise<Array<{ _id: unknown }>>;
    };
  };
};

export function buildWhatsAppNumberChangeRecoveryFilter(params: {
  workspaceId: string;
  oldWaId: string;
  newWaId: string;
}): Record<string, unknown> {
  return {
    workspaceId: params.workspaceId,
    $or: [
      { "whatsapp.waId": params.oldWaId },
      {
        "whatsapp.waId": params.newWaId,
        "whatsapp.previousWaIds": params.oldWaId,
      },
    ],
  };
}

export async function findWhatsAppNumberChangeAffectedRecords(params: {
  chatModel: IdentityLookupModel;
  userModel: IdentityLookupModel;
  workspaceId: string;
  oldWaId: string;
  newWaId: string;
}): Promise<{ chatIds: string[]; userIds: string[] }> {
  const filter = buildWhatsAppNumberChangeRecoveryFilter(params);
  const [chats, users] = await Promise.all([
    params.chatModel.find(filter).select({ _id: 1 }).lean(),
    params.userModel.find(filter).select({ _id: 1 }).lean(),
  ]);

  return {
    chatIds: chats.map((record) => String(record._id)),
    userIds: users.map((record) => String(record._id)),
  };
}
