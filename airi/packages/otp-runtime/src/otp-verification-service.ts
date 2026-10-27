import {
  hashOtpCode,
  isOtpHashMatch,
  normalizeOtpCode,
} from "./otp-code";
import { getOtpRuntime, type OtpChallengeModelLike } from "./runtime";

type OtpChallengeSnapshot = {
  _id: unknown;
  workspaceId: string;
  recipientPhone: string;
  purpose: string;
  expiresAt: Date | string;
  maxAttempts: number;
  attempts: number;
  status: string;
  codeHash: string;
  idempotencyKey?: string | null;
  encryptedCode?: Record<string, string> | null;
};

export type OtpVerificationStatus =
  | "verified"
  | "pending"
  | "expired"
  | "failed"
  | "not_found";

const OTP_CHALLENGE_SNAPSHOT_FIELDS =
  "_id workspaceId recipientPhone purpose expiresAt maxAttempts attempts status codeHash idempotencyKey encryptedCode";

function isInvalidOtpChallengeIdError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "CastError" ||
    name === "BSONError" ||
    /Cast to ObjectId failed|BSONError|24 character hex string/i.test(message)
  );
}

function terminalVerificationStatus(
  challenge: Pick<OtpChallengeSnapshot, "status" | "attempts" | "maxAttempts">
): {
  verified: boolean;
  status: OtpVerificationStatus;
  attemptsRemaining: number;
} {
  return {
    verified: challenge.status === "verified",
    status:
      challenge.status === "verified"
        ? "verified"
        : challenge.status === "failed"
          ? "failed"
          : "expired",
    attemptsRemaining: Math.max(challenge.maxAttempts - challenge.attempts, 0),
  };
}

async function loadOtpChallengeSnapshot(
  OtpChallengeModel: OtpChallengeModelLike,
  filter: unknown
): Promise<OtpChallengeSnapshot | null> {
  try {
    return (await OtpChallengeModel.findOne(filter)
      .select(OTP_CHALLENGE_SNAPSHOT_FIELDS)
      .lean()) as OtpChallengeSnapshot | null;
  } catch (error) {
    if (isInvalidOtpChallengeIdError(error)) return null;
    throw error;
  }
}

export async function verifyOtpChallenge(input: {
  workspaceId: string;
  challengeId: string;
  code: unknown;
}): Promise<{
  verified: boolean;
  status: OtpVerificationStatus;
  attemptsRemaining: number;
}> {
  const code = normalizeOtpCode(input.code);
  if (!code) {
    return { verified: false, status: "pending", attemptsRemaining: 0 };
  }

  const { connectDB, OtpChallengeModel } = getOtpRuntime();
  await connectDB();

  const challenge = await loadOtpChallengeSnapshot(OtpChallengeModel, {
    _id: input.challengeId,
    workspaceId: input.workspaceId,
  });

  if (!challenge) {
    return { verified: false, status: "not_found", attemptsRemaining: 0 };
  }

  if (challenge.status !== "pending") {
    if (challenge.status !== "verified" && challenge.idempotencyKey) {
      await OtpChallengeModel.updateOne(
        {
          _id: input.challengeId,
          workspaceId: input.workspaceId,
          status: challenge.status,
          idempotencyKey: challenge.idempotencyKey,
        },
        {
          $set: {
            idempotencyKey: null,
            encryptedCode: null,
            updatedAt: new Date(),
          },
        }
      );
    }

    return terminalVerificationStatus(challenge);
  }

  const now = new Date();
  const expiresAt =
    challenge.expiresAt instanceof Date
      ? challenge.expiresAt
      : new Date(challenge.expiresAt);

  if (expiresAt.getTime() <= now.getTime()) {
    await OtpChallengeModel.updateOne(
      {
        _id: input.challengeId,
        workspaceId: input.workspaceId,
        status: "pending",
        expiresAt: { $lte: now },
      },
      {
        $set: {
          status: "expired",
          idempotencyKey: null,
          encryptedCode: null,
          updatedAt: now,
        },
      }
    );
    return { verified: false, status: "expired", attemptsRemaining: 0 };
  }

  const actualHash = hashOtpCode({
    code,
    workspaceId: challenge.workspaceId,
    recipientPhone: challenge.recipientPhone,
    purpose: challenge.purpose,
    challengeId: String(challenge._id),
  });

  if (isOtpHashMatch(challenge.codeHash, actualHash)) {
    const verifiedAt = new Date();
    let updated: OtpChallengeSnapshot | null;
    try {
      updated = (await OtpChallengeModel.findOneAndUpdate(
        {
          _id: input.challengeId,
          workspaceId: input.workspaceId,
          status: "pending",
          expiresAt: { $gt: verifiedAt },
        },
        {
          $set: {
            status: "verified",
            verifiedAt,
            encryptedCode: null,
            updatedAt: verifiedAt,
          },
        },
        { new: true }
      ).lean()) as OtpChallengeSnapshot | null;
    } catch (error) {
      if (isInvalidOtpChallengeIdError(error)) {
        return { verified: false, status: "not_found", attemptsRemaining: 0 };
      }
      throw error;
    }
    if (!updated) {
      const current = await loadOtpChallengeSnapshot(OtpChallengeModel, {
        _id: input.challengeId,
        workspaceId: input.workspaceId,
      });
      if (current?.status === "verified" || current?.status === "failed") {
        return terminalVerificationStatus(current);
      }
      return { verified: false, status: "expired", attemptsRemaining: 0 };
    }
    return {
      verified: true,
      status: "verified",
      attemptsRemaining: Math.max(
        challenge.maxAttempts - challenge.attempts,
        0
      ),
    };
  }

  const updated = (await OtpChallengeModel.findOneAndUpdate(
    {
      _id: input.challengeId,
      workspaceId: input.workspaceId,
      status: "pending",
      expiresAt: { $gt: now },
    },
    [
      {
        $set: {
          attempts: { $add: ["$attempts", 1] },
          updatedAt: now,
        },
      },
      {
        $set: {
          status: {
            $cond: [
              { $gte: ["$attempts", "$maxAttempts"] },
              "failed",
              "pending",
            ],
          },
          idempotencyKey: {
            $cond: [
              { $gte: ["$attempts", "$maxAttempts"] },
              null,
              "$idempotencyKey",
            ],
          },
          encryptedCode: {
            $cond: [
              { $gte: ["$attempts", "$maxAttempts"] },
              null,
              "$encryptedCode",
            ],
          },
        },
      },
    ],
    { new: true }
  ).lean()) as OtpChallengeSnapshot | null;
  const attempts = updated?.attempts ?? challenge.attempts + 1;
  const maxAttempts = updated?.maxAttempts ?? challenge.maxAttempts;
  const status =
    updated?.status ?? (attempts >= maxAttempts ? "failed" : "pending");
  const attemptsRemaining = Math.max(maxAttempts - attempts, 0);

  return {
    verified: false,
    status: status === "failed" ? "failed" : "pending",
    attemptsRemaining,
  };
}
