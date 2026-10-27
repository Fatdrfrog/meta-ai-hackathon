import { randomUUID } from "crypto";
import { normalizeWhatsAppPhone } from "@icecore/shared/lib/whatsapp/contact-identities";

import {
  generateOtpCode,
  hashOtpCode,
  redactOtpLikeValues,
} from "./otp-code";
import {
  normalizeOtpIdempotencyKey,
  normalizeOtpPurpose,
} from "./otp-normalization";
import { getOtpRuntime } from "./runtime";
import {
  ACTIVE_IDEMPOTENT_OTP_STATUSES,
  REUSABLE_TERMINAL_OTP_STATUSES,
} from "./models/otp-challenge";

function serializeQueuedChallenge(challenge: {
  _id: unknown;
  expiresAt: Date | string;
  deliveryStatus?: string | null;
  providerMessageId?: string | null;
}): {
  challengeId: string;
  expiresAt: string;
  deliveryStatus: string;
  providerMessageId?: string;
} {
  const expiresAt =
    challenge.expiresAt instanceof Date
      ? challenge.expiresAt.toISOString()
      : new Date(challenge.expiresAt).toISOString();
  return {
    challengeId: String(challenge._id),
    expiresAt,
    deliveryStatus: challenge.deliveryStatus || "queued",
    ...(challenge.providerMessageId
      ? { providerMessageId: challenge.providerMessageId }
      : {}),
  };
}

function isMongoDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

async function releaseReusableIdempotencyKey(input: {
  workspaceId: string;
  recipientPhone: string;
  purpose: string;
  idempotencyKey: string;
  now: Date;
}) {
  const { OtpChallengeModel } = getOtpRuntime();
  const baseFilter = {
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    recipientPhone: input.recipientPhone,
    purpose: input.purpose,
    idempotencyKey: input.idempotencyKey,
  };
  const clearSensitiveFields = {
    idempotencyKey: null,
    encryptedCode: null,
    updatedAt: input.now,
  };
  const clearDeliveryLease = {
    deliveryLeaseId: "",
    deliveryLeaseExpiresAt: "",
  };

  await OtpChallengeModel.updateMany(
    {
      ...baseFilter,
      expiresAt: { $lte: input.now },
      status: "pending",
      $or: [
        { deliveryStatus: { $ne: "sending" } },
        { deliveryLeaseExpiresAt: { $lte: input.now } },
        { deliveryLeaseExpiresAt: null },
        { deliveryLeaseExpiresAt: { $exists: false } },
      ],
    },
    {
      $set: {
        ...clearSensitiveFields,
        status: "expired",
        lastError: "OTP challenge expired before idempotent retry",
      },
      $unset: clearDeliveryLease,
    }
  );

  await OtpChallengeModel.updateMany(
    {
      ...baseFilter,
      $or: [
        { status: "verified", expiresAt: { $lte: input.now } },
        { status: { $in: [...REUSABLE_TERMINAL_OTP_STATUSES] } },
      ],
    },
    {
      $set: clearSensitiveFields,
      $unset: clearDeliveryLease,
    }
  );
}

async function findActiveIdempotentChallenge(input: {
  workspaceId: string;
  recipientPhone: string;
  purpose: string;
  idempotencyKey: string;
  now: Date;
}) {
  const { OtpChallengeModel } = getOtpRuntime();
  return OtpChallengeModel.findOne({
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    recipientPhone: input.recipientPhone,
    purpose: input.purpose,
    idempotencyKey: input.idempotencyKey,
    expiresAt: { $gt: input.now },
    status: { $in: [...ACTIVE_IDEMPOTENT_OTP_STATUSES] },
  }).lean();
}

export async function requestWhatsAppOtp(input: {
  workspaceId: string;
  recipientPhone: unknown;
  purpose?: unknown;
  idempotencyKey?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<{
  challengeId: string;
  expiresAt: string;
  deliveryStatus: string;
  providerMessageId?: string;
}> {
  const recipientPhone = normalizeWhatsAppPhone(input.recipientPhone);
  if (!recipientPhone) {
    throw new Error("A valid WhatsApp phone number is required");
  }

  const purpose = normalizeOtpPurpose(input.purpose);
  const idempotencyKey =
    normalizeOtpIdempotencyKey(input.idempotencyKey) ?? null;
  const runtime = getOtpRuntime();

  await runtime.connectDB();

  const now = new Date();
  if (idempotencyKey) {
    await releaseReusableIdempotencyKey({
      workspaceId: input.workspaceId,
      recipientPhone,
      purpose,
      idempotencyKey,
      now,
    });

    const existingChallenge = (await findActiveIdempotentChallenge({
      workspaceId: input.workspaceId,
      recipientPhone,
      purpose,
      idempotencyKey,
      now,
    })) as {
      _id: unknown;
      expiresAt: Date | string;
      deliveryStatus?: string | null;
      providerMessageId?: string | null;
    } | null;

    if (existingChallenge) {
      return serializeQueuedChallenge(existingChallenge);
    }
  }

  await runtime.assertRequestAllowed({
    workspaceId: input.workspaceId,
    recipientPhone,
    purpose,
  });

  const binding = await runtime.getActiveBinding({
    workspaceId: input.workspaceId,
    purpose,
  });

  if (!binding) {
    throw new Error("No active WhatsApp OTP template binding found");
  }

  const template = await runtime.findApprovedAuthTemplate({
    workspaceId: input.workspaceId,
    templateId: binding.templateId,
    templateName: binding.templateName,
    languageCode: binding.languageCode,
  });

  if (!template) {
    throw new Error(
      "Connected WhatsApp authentication template is no longer approved"
    );
  }

  const source = await runtime.loadWhatsAppSource({
    workspaceId: input.workspaceId,
    sourceId: binding.sourceId,
  });
  const credentials = runtime.extractCredentials(source?.credentials);
  const phoneNumberId = credentials.phoneNumberId;
  const accessToken = credentials.accessToken;

  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials are incomplete");
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + binding.ttlSeconds * 1000);
  const correlationId = randomUUID();
  const challenge = new runtime.OtpChallengeModel({
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    recipientPhone,
    purpose,
    templateBindingId: binding._id,
    templateId: binding.templateId,
    templateName: binding.templateName,
    languageCode: binding.languageCode,
    sourceId: binding.sourceId ?? source?.id ?? null,
    phoneNumberId: binding.phoneNumberId ?? phoneNumberId ?? null,
    codeHash: "pending",
    encryptedCode: runtime.encryptString(code),
    expiresAt,
    maxAttempts: binding.maxAttempts,
    attempts: 0,
    status: "pending",
    deliveryStatus: "queued",
    deliveryAttempts: 0,
    deliveryQueuedAt: now,
    correlationId,
    idempotencyKey,
    metadata: input.metadata,
  });
  challenge.codeHash = hashOtpCode({
    code,
    workspaceId: input.workspaceId,
    recipientPhone,
    purpose,
    challengeId: String(challenge._id),
  });
  try {
    await challenge.save();
  } catch (error) {
    if (idempotencyKey && isMongoDuplicateKeyError(error)) {
      const existingChallenge = (await findActiveIdempotentChallenge({
        workspaceId: input.workspaceId,
        recipientPhone,
        purpose,
        idempotencyKey,
        now: new Date(),
      })) as {
        _id: unknown;
        expiresAt: Date | string;
        deliveryStatus?: string | null;
        providerMessageId?: string | null;
      } | null;
      if (existingChallenge) {
        return serializeQueuedChallenge(existingChallenge);
      }
    }
    throw error;
  }

  try {
    const publishResult = await runtime.enqueueDelivery({
      workspaceId: input.workspaceId,
      challengeId: String(challenge._id),
      correlationId,
      queuedAt: now.toISOString(),
    });

    if (!publishResult.ok) {
      throw new Error(
        publishResult.errorMessage || "Failed to enqueue WhatsApp OTP delivery"
      );
    }

    return {
      challengeId: String(challenge._id),
      expiresAt: expiresAt.toISOString(),
      deliveryStatus: "queued",
    };
  } catch (error) {
    challenge.status = "failed";
    challenge.deliveryStatus = "failed";
    challenge.idempotencyKey = null;
    challenge.encryptedCode = null;
    challenge.lastError = redactOtpLikeValues(
      error instanceof Error ? error.message : "WhatsApp OTP enqueue failed"
    );
    await challenge.save();
    throw error;
  }
}
