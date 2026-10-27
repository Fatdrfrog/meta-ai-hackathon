import type { BulkCampaignDispatchItem } from "@icecore/temporal";
import {
  isBulkCampaignReadiness,
  type BulkCampaignReadiness,
} from "@icecore/scenario-contracts";

type WhatsAppDispatchItem = Extract<
  BulkCampaignDispatchItem,
  { channel: "whatsapp" }
>;

type BulkCampaignWhatsAppSendContext = {
  sourceId?: string;
  workspaceId?: string;
  phoneNumberId: string;
  accessToken: string;
  wabaId?: string;
  messagingAccountId?: string;
  marketingMessagesEnabled?: boolean;
};

export type ResolveBulkCampaignWhatsAppSendContext = (params: {
  workspaceId?: string | null;
  sourceId?: string | null;
}) => Promise<BulkCampaignWhatsAppSendContext | null>;

export type ResolveBulkCampaignWhatsAppSendingReadiness = (
  context: BulkCampaignWhatsAppSendContext,
) => Promise<BulkCampaignReadiness>;

/** Health is shared by WABA, and refreshed for every activity batch. */
export function createBatchScopedWhatsAppSendingReadinessResolver(
  resolveReadiness: ResolveBulkCampaignWhatsAppSendingReadiness,
): ResolveBulkCampaignWhatsAppSendingReadiness {
  const resolutions = new Map<string, Promise<BulkCampaignReadiness>>();
  return (context) => {
    const key = JSON.stringify([
      context.workspaceId?.trim() || "",
      context.wabaId?.trim() || "",
    ]);
    const existing = resolutions.get(key);
    if (existing) return existing;

    const resolution = Promise.resolve()
      .then(() => resolveReadiness(context))
      .then((readiness) => {
        if (!isBulkCampaignReadiness(readiness)) {
          throw new Error("Malformed WhatsApp sending readiness");
        }
        return readiness;
      })
      .catch((): BulkCampaignReadiness => ({
        state: "unavailable",
        checkedAt: new Date().toISOString(),
        remainingCapacity: null,
        reasons: [{ code: "meta_check_unavailable" }],
      }));
    resolutions.set(key, resolution);
    return resolution;
  };
}

export function createBatchScopedWhatsAppSendContextResolver(
  resolveSendContext: ResolveBulkCampaignWhatsAppSendContext,
): ResolveBulkCampaignWhatsAppSendContext {
  const resolutions = new Map<
    string,
    ReturnType<ResolveBulkCampaignWhatsAppSendContext>
  >();
  return (params) => {
    const key = JSON.stringify([
      params.workspaceId?.trim() || "",
      params.sourceId?.trim() || "",
    ]);
    const existing = resolutions.get(key);
    if (existing) return existing;

    const resolution = Promise.resolve().then(() => resolveSendContext(params));
    resolutions.set(key, resolution);
    return resolution;
  };
}

export async function resolveBulkCampaignWhatsAppSendContext(params: {
  item: WhatsAppDispatchItem;
  resolveSendContext: ResolveBulkCampaignWhatsAppSendContext;
}): Promise<BulkCampaignWhatsAppSendContext> {
  const context = await params.resolveSendContext({
    workspaceId: params.item.workspaceId,
    sourceId: params.item.sourceId,
  });
  if (!context?.phoneNumberId || !context.accessToken) {
    throw new Error(
      "WhatsApp send context is unavailable for this campaign item",
    );
  }
  const expectedSourceId = params.item.sourceId?.trim();
  if (expectedSourceId && context.sourceId?.trim() !== expectedSourceId) {
    throw new Error(
      `WhatsApp source changed before dispatch (expected ${expectedSourceId}, resolved ${context.sourceId || "missing"})`,
    );
  }
  if (context.workspaceId?.trim() !== params.item.workspaceId.trim()) {
    throw new Error(
      `WhatsApp workspace changed before dispatch (expected ${params.item.workspaceId}, resolved ${context.workspaceId || "missing"})`,
    );
  }
  if (context.phoneNumberId !== params.item.phoneNumberId) {
    throw new Error(
      `WhatsApp phone number changed before dispatch (expected ${params.item.phoneNumberId}, resolved ${context.phoneNumberId})`,
    );
  }
  return context;
}
