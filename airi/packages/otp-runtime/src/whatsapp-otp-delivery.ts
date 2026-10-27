import { randomUUID } from "crypto";

import type { EncryptedString } from "./crypto";
import { redactOtpLikeValues } from "./otp-code";
import { getOtpRuntime } from "./runtime";
import { buildWhatsAppOtpTemplateComponents } from "./whatsapp-otp-template";

export const OTP_DELIVERY_LEASE_HELD_ERROR = "OTP delivery lease is still held";

type DeliveryResult =
  | {
      status: "sent";
      challengeId: string;
      providerMessageId?: string;
    }
  | {
      status: "already_sent";
      challengeId: string;
      providerMessageId?: string;
    }
  | {
      status: "expired" | "not_found" | "skipped";
      challengeId: string;
    };

type ChallengeRecord = {
  _id: unknown;
  workspaceId: string;
  recipientPhone: string;
  templateId?: string | null;
  templateName: string;
  languageCode: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  encryptedCode?: EncryptedString | null;
  expiresAt: Date;
  createdAt?: Date;
  deliveryQueuedAt?: Date | null;
  deliveryStatus?: string | null;
  providerMessageId?: string | null;
};

type WriteResult = {
  acknowledged?: boolean;
  matchedCount?: number;
  modifiedCount?: number;
};

function writeTouched(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as WriteResult;
  if (typeof record.matchedCount === "number") return record.matchedCount > 0;
  if (typeof record.modifiedCount === "number") return record.modifiedCount > 0;
  return record.acknowledged === true;
}

function alreadySentResult(
  challengeId: string,
  providerMessageId?: string | null
): DeliveryResult {
  return {
    status: "already_sent",
    challengeId,
    ...(providerMessageId ? { providerMessageId } : {}),
  };
}

function sentResult(
  challengeId: string,
  providerMessageId?: string | null
): DeliveryResult {
  return {
    status: "sent",
    challengeId,
    ...(providerMessageId ? { providerMessageId } : {}),
  };
}

async function loadChallenge(
  workspaceId: string,
  challengeId: string
): Promise<ChallengeRecord | null> {
  const { OtpChallengeModel } = getOtpRuntime();
  return (await OtpChallengeModel.findOne({
    _id: challengeId,
    workspaceId,
  })) as ChallengeRecord | null;
}

async function persistSentStatus(input: {
  workspaceId: string;
  challengeId: string;
  leaseId: string;
  providerMessageId?: string;
  salvageWithoutLease: boolean;
}): Promise<boolean> {
  const { OtpChallengeModel } = getOtpRuntime();
  const update = {
    $set: {
      deliveryStatus: "sent",
      providerMessageId: input.providerMessageId || null,
      deliverySentAt: new Date(),
      lastError: null,
    },
    $unset: {
      encryptedCode: "",
      deliveryLeaseId: "",
      deliveryLeaseExpiresAt: "",
    },
  };

  const leased = await OtpChallengeModel.updateOne(
    {
      _id: input.challengeId,
      workspaceId: input.workspaceId,
      deliveryLeaseId: input.leaseId,
    },
    update
  );
  if (writeTouched(leased)) return true;
  if (!input.salvageWithoutLease) return false;

  const salvaged = await OtpChallengeModel.updateOne(
    {
      _id: input.challengeId,
      workspaceId: input.workspaceId,
      status: "pending",
      deliveryStatus: { $ne: "sent" },
    },
    update
  );
  return writeTouched(salvaged);
}

async function markExpired(input: {
  workspaceId: string;
  challengeId: string;
}): Promise<DeliveryResult> {
  const { OtpChallengeModel } = getOtpRuntime();
  const result = await OtpChallengeModel.updateOne(
    {
      _id: input.challengeId,
      workspaceId: input.workspaceId,
      status: "pending",
      deliveryStatus: { $ne: "sent" },
    },
    {
      $set: {
        status: "expired",
        deliveryStatus: "failed",
        idempotencyKey: null,
        lastError: "OTP challenge expired before delivery",
      },
      $unset: {
        encryptedCode: "",
        deliveryLeaseId: "",
        deliveryLeaseExpiresAt: "",
      },
    }
  );
  if (!writeTouched(result)) {
    const existing = await loadChallenge(input.workspaceId, input.challengeId);
    if (existing?.deliveryStatus === "sent") {
      return alreadySentResult(input.challengeId, existing.providerMessageId);
    }
  }
  return { status: "expired", challengeId: input.challengeId };
}

export async function deliverWhatsAppOtpChallenge(input: {
  workspaceId: string;
  challengeId: string;
}): Promise<DeliveryResult> {
  const runtime = getOtpRuntime();
  await runtime.connectDB();

  const now = new Date();
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const challenge = (await runtime.OtpChallengeModel.findOneAndUpdate(
    {
      _id: input.challengeId,
      workspaceId: input.workspaceId,
      status: "pending",
      expiresAt: { $gt: now },
      $or: [
        { deliveryStatus: { $in: ["queued", "retrying"] } },
        {
          deliveryStatus: "sending",
          deliveryLeaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        deliveryStatus: "sending",
        deliveryLeaseId: leaseId,
        deliveryLeaseExpiresAt: leaseExpiresAt,
        deliveryLastAttemptAt: now,
      },
      $inc: { deliveryAttempts: 1 },
    },
    { new: true }
  )) as ChallengeRecord | null;

  if (!challenge) {
    const existing = await loadChallenge(input.workspaceId, input.challengeId);
    if (!existing) {
      return { status: "not_found", challengeId: input.challengeId };
    }
    if (existing.deliveryStatus === "sent") {
      return alreadySentResult(input.challengeId, existing.providerMessageId);
    }
    if (existing.expiresAt.getTime() <= Date.now()) {
      return markExpired(input);
    }
    if (existing.deliveryStatus === "sending") {
      throw new Error(OTP_DELIVERY_LEASE_HELD_ERROR);
    }
    return { status: "skipped", challengeId: input.challengeId };
  }

  let sendCompleted = false;
  let providerMessageId: string | undefined;

  try {
    if (!challenge.encryptedCode) {
      throw new Error("OTP challenge is missing encrypted delivery code");
    }

    const approvedTemplate = await runtime.findApprovedAuthTemplate({
      workspaceId: challenge.workspaceId,
      templateId: challenge.templateId || undefined,
      templateName: challenge.templateName,
      languageCode: challenge.languageCode,
    });
    if (!approvedTemplate) {
      throw new Error("WhatsApp OTP template is no longer approved");
    }

    const source = await runtime.loadWhatsAppSource({
      workspaceId: challenge.workspaceId,
      sourceId: challenge.sourceId,
    });
    const credentials = runtime.extractCredentials(source?.credentials);
    const phoneNumberId = challenge.phoneNumberId || credentials.phoneNumberId;
    const accessToken = credentials.accessToken;

    if (!phoneNumberId || !accessToken) {
      throw new Error("WhatsApp credentials are incomplete");
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
      return markExpired(input);
    }

    const code = runtime.decryptString(challenge.encryptedCode);
    const result = await runtime.sendOtpTemplate({
      phoneNumberId,
      accessToken,
      recipientPhone: challenge.recipientPhone,
      templateName: challenge.templateName,
      languageCode: challenge.languageCode,
      components: buildWhatsAppOtpTemplateComponents(code),
      challengeId: String(challenge._id),
      messagingAccountId: credentials.messagingAccountId,
    });
    sendCompleted = true;
    providerMessageId = result.messageId;

    await persistSentStatus({
      workspaceId: input.workspaceId,
      challengeId: input.challengeId,
      leaseId,
      providerMessageId,
      salvageWithoutLease: true,
    });

    return sentResult(input.challengeId, providerMessageId);
  } catch (error) {
    if (sendCompleted) {
      try {
        await persistSentStatus({
          workspaceId: input.workspaceId,
          challengeId: input.challengeId,
          leaseId,
          providerMessageId,
          salvageWithoutLease: true,
        });
      } catch {
        // WhatsApp already accepted the template send; never retry it.
      }
      return sentResult(input.challengeId, providerMessageId);
    }

    const lastError = redactOtpLikeValues(
      error instanceof Error ? error.message : "WhatsApp OTP send failed"
    );
    await runtime.OtpChallengeModel.updateOne(
      {
        _id: input.challengeId,
        workspaceId: input.workspaceId,
        deliveryLeaseId: leaseId,
      },
      {
        $set: {
          deliveryStatus: isPermanentOtpDeliveryError(error)
            ? "failed"
            : "retrying",
          lastError,
        },
        $unset: {
          deliveryLeaseId: "",
          deliveryLeaseExpiresAt: "",
        },
      }
    );
    throw error;
  }
}

function isPermanentOtpDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /missing encrypted delivery code/i.test(message) ||
    /template is no longer approved/i.test(message) ||
    /credentials are incomplete/i.test(message)
  );
}
