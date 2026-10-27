import { createHash } from "node:crypto";
import { requireNonEmptyString } from "@icecore/shared/lib/value-utils";

const GENERATED_RECIPIENT_AUDIENCE_VERSION = 1 as const;
export const GENERATED_RECIPIENT_AUDIENCE_MAX_PAGE_SIZE = 1000;

const EMPTY_GENERATED_RECIPIENT_AUDIENCE_DIGEST = createHash("sha256")
  .update("airi.generated-recipient-audience.v1", "utf8")
  .digest("hex");

export type GeneratedRecipientAudience = {
  version: typeof GENERATED_RECIPIENT_AUDIENCE_VERSION;
  count: number;
  digest: string;
};

export function normalizeGeneratedRecipientAudience(
  value: GeneratedRecipientAudience
): GeneratedRecipientAudience {
  if (
    value.version !== GENERATED_RECIPIENT_AUDIENCE_VERSION ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  ) {
    throw new Error("Generated recipient audience evidence is invalid");
  }
  return {
    version: GENERATED_RECIPIENT_AUDIENCE_VERSION,
    count: value.count,
    digest: value.digest,
  };
}

export function createGeneratedRecipientAudience(): GeneratedRecipientAudience {
  return {
    version: GENERATED_RECIPIENT_AUDIENCE_VERSION,
    count: 0,
    digest: EMPTY_GENERATED_RECIPIENT_AUDIENCE_DIGEST,
  };
}

export function advanceGeneratedRecipientAudience(
  current: GeneratedRecipientAudience,
  messageIds: readonly string[]
): GeneratedRecipientAudience {
  const normalizedCurrent = normalizeGeneratedRecipientAudience(current);
  if (messageIds.length > GENERATED_RECIPIENT_AUDIENCE_MAX_PAGE_SIZE) {
    throw new Error(
      `Generated recipient audience append accepts at most ${GENERATED_RECIPIENT_AUDIENCE_MAX_PAGE_SIZE} IDs`
    );
  }

  let digest = normalizedCurrent.digest;
  let count = normalizedCurrent.count;
  for (const value of messageIds) {
    const messageId = requireNonEmptyString(
      value,
      "Generated recipient audience message ID"
    );
    digest = createHash("sha256")
      .update("airi.generated-recipient-audience.row.v1\0", "utf8")
      .update(digest, "hex")
      .update("\0", "utf8")
      .update(String(Buffer.byteLength(messageId, "utf8")), "utf8")
      .update(":", "utf8")
      .update(messageId, "utf8")
      .digest("hex");
    count += 1;
    if (!Number.isSafeInteger(count)) {
      throw new Error("Generated recipient audience count is unsafe");
    }
  }
  return {
    version: GENERATED_RECIPIENT_AUDIENCE_VERSION,
    count,
    digest,
  };
}

export function generatedRecipientAudiencesEqual(
  left: GeneratedRecipientAudience,
  right: GeneratedRecipientAudience
): boolean {
  const normalizedLeft = normalizeGeneratedRecipientAudience(left);
  const normalizedRight = normalizeGeneratedRecipientAudience(right);
  return (
    normalizedLeft.version === normalizedRight.version &&
    normalizedLeft.count === normalizedRight.count &&
    normalizedLeft.digest === normalizedRight.digest
  );
}
