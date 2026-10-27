import type { BulkCampaignDispatchExecutionSource } from "@icecore/scenario-contracts";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";
import { Types } from "mongoose";

import { recordBulkDispatchActivityDedupe } from "./bulk-dispatch-activity-dedupe";

type TaskProviderAcceptance = {
  taskId: string;
  workspaceId: string;
  campaignId: string;
  sourceId: string;
  phoneNumberId: string;
  recipient: string;
  messageId: string;
};

type TaskAcceptanceProof = {
  _id: unknown;
  workspaceId?: string;
  campaignId?: string;
  channel?: string;
  provider?: string;
  sourceId?: string | null;
  recipientPhone?: string | null;
  providerAttemptStartedAt?: Date | string | null;
  providerAttemptSourceId?: string | null;
  providerAttemptPhoneNumberId?: string | null;
  providerAttemptRecipient?: string | null;
  scenarioId?: string | null;
  nodeId?: string | null;
  executionSource?: BulkCampaignDispatchExecutionSource;
};

export type CampaignTaskProviderAcceptanceDependencies = {
  taskModel: {
    findOne: (filter: Record<string, string>) => {
      select: (fields: string) => {
        lean: <T>() => Promise<T>;
      };
    };
  };
  persistCampaignMessageSentWithOutbox: (params: {
    campaignId: string;
    messageId: string;
    channel: "whatsapp";
    provider: "meta";
    recipient: string;
    status: "sent";
    attemptedAt: string;
    scenarioId?: string;
    scenarioNodeId?: string;
    executionSource?: BulkCampaignDispatchExecutionSource;
  }) => Promise<{ applied?: boolean; queuedToOutbox?: boolean }>;
};

export function createCampaignTaskProviderAcceptance(
  deps: CampaignTaskProviderAcceptanceDependencies,
) {
  /** Called only for an authenticated provider status and its resolved source. */
  return async function recordCampaignTaskProviderAcceptance(
    params: TaskProviderAcceptance,
  ): Promise<void> {
    const recipient = normalizeWhatsAppPhone(params.recipient);
    if (
      !Types.ObjectId.isValid(params.taskId) ||
      !recipient ||
      !params.workspaceId ||
      !params.campaignId ||
      !params.sourceId ||
      !params.phoneNumberId ||
      !params.messageId.trim()
    )
      return;

    const task = await deps.taskModel
      .findOne({
        _id: params.taskId,
        workspaceId: params.workspaceId,
        campaignId: params.campaignId,
        channel: "whatsapp",
        provider: "meta",
      })
      .select(
        "_id workspaceId campaignId channel provider sourceId recipientPhone providerAttemptStartedAt providerAttemptSourceId providerAttemptPhoneNumberId providerAttemptRecipient scenarioId nodeId executionSource",
      )
      .lean<TaskAcceptanceProof | null>();

    // The callback is a routing hint, never sufficient proof by itself. Bind it
    // to the immutable send-boundary identity, including the actual sender used.
    if (
      !task ||
      String(task._id) !== params.taskId ||
      task.workspaceId !== params.workspaceId ||
      task.campaignId !== params.campaignId ||
      task.channel !== "whatsapp" ||
      task.provider !== "meta" ||
      !task.providerAttemptStartedAt ||
      !Number.isFinite(new Date(task.providerAttemptStartedAt).getTime()) ||
      task.providerAttemptSourceId !== params.sourceId ||
      task.providerAttemptPhoneNumberId !== params.phoneNumberId ||
      (task.sourceId && task.sourceId !== params.sourceId) ||
      normalizeWhatsAppPhone(task.providerAttemptRecipient) !== recipient ||
      (task.recipientPhone &&
        normalizeWhatsAppPhone(task.recipientPhone) !== recipient)
    )
      return;

    const storedRecipient = task.providerAttemptRecipient!;
    await recordBulkDispatchActivityDedupe({
      key: `campaign-task:${params.workspaceId}:${params.taskId}`,
      workspaceId: params.workspaceId,
      channel: "whatsapp",
      messageId: params.messageId,
      recipient: storedRecipient,
    });

    const scenarioId =
      task.scenarioId && Types.ObjectId.isValid(task.scenarioId)
        ? task.scenarioId
        : undefined;
    const result = await deps.persistCampaignMessageSentWithOutbox({
      campaignId: params.campaignId,
      messageId: params.messageId,
      channel: "whatsapp",
      provider: "meta",
      recipient: storedRecipient,
      status: "sent",
      attemptedAt: new Date(task.providerAttemptStartedAt).toISOString(),
      scenarioId,
      scenarioNodeId: scenarioId && task.nodeId ? task.nodeId : undefined,
      executionSource: task.executionSource,
    });
    if (!result.applied && !result.queuedToOutbox) {
      throw new Error(
        "Campaign task acceptance ledger persistence unconfirmed",
      );
    }
  };
}
