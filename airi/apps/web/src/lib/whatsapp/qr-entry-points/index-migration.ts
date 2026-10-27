import connectDB from "@/lib/mongoose";

import {
  createMissingWhatsAppQrEntryPointIndexes,
  dropLegacyWhatsAppQrEntryPointAssignmentIndex,
  inspectWhatsAppQrEntryPointIndexes,
  WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME,
} from "./indexes";

export type WhatsAppQrEntryPointIndexMigrationResult = {
  apply: boolean;
  ready: boolean;
  create: string[];
  verify: string[];
  drop: string[];
};

function isIndexNotFound(error: unknown): boolean {
  const indexError = error as { code?: unknown; codeName?: unknown };
  return indexError.code === 27 || indexError.codeName === "IndexNotFound";
}

export async function runWhatsAppQrEntryPointIndexMigration(params: {
  apply: boolean;
}): Promise<WhatsAppQrEntryPointIndexMigrationResult> {
  await connectDB();
  const before = await inspectWhatsAppQrEntryPointIndexes();
  const result: WhatsAppQrEntryPointIndexMigrationResult = {
    apply: params.apply,
    ready: before.desiredIndexesVerified && !before.legacyIndexPresent,
    create: [...before.missingOrInvalidIndexNames],
    verify: [...before.missingOrInvalidIndexNames],
    drop: before.legacyIndexPresent
      ? [WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME]
      : [],
  };
  if (!params.apply || result.ready) return result;

  if (result.create.length > 0) {
    await createMissingWhatsAppQrEntryPointIndexes(result.create);
  }
  const verified = await inspectWhatsAppQrEntryPointIndexes();
  if (!verified.desiredIndexesVerified) {
    throw new Error(
      `WhatsApp QR desired indexes were not verified: ${verified.missingOrInvalidIndexNames.join(", ")}`
    );
  }

  if (verified.legacyIndexPresent) {
    try {
      await dropLegacyWhatsAppQrEntryPointAssignmentIndex(
        WHATSAPP_QR_ENTRY_POINT_LEGACY_ASSIGNMENT_INDEX_NAME
      );
    } catch (error) {
      if (!isIndexNotFound(error)) throw error;
    }
  }

  const after = await inspectWhatsAppQrEntryPointIndexes();
  if (!after.desiredIndexesVerified || after.legacyIndexPresent) {
    throw new Error("WhatsApp QR index migration did not reach readiness");
  }
  return { ...result, ready: true };
}
