import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";

import { normalizeOtpPurpose } from "./otp-normalization";
import type { OtpTemplateBindingDocument } from "./models/otp-template-binding";
import { getOtpRuntime } from "./runtime";

export const DEFAULT_OTP_TTL_SECONDS = 300;
export const MIN_OTP_TTL_SECONDS = 60;
export const MAX_OTP_TTL_SECONDS = 600;
export const DEFAULT_MAX_OTP_ATTEMPTS = 5;
export const MIN_OTP_ATTEMPTS = 1;
export const MAX_OTP_ATTEMPTS = 10;

export type SerializedOtpTemplateBinding = {
  id: string;
  workspaceId: string;
  channel: "whatsapp";
  purpose: string;
  templateId: string;
  templateName: string;
  languageCode: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  mode: "copy_code";
  ttlSeconds: number;
  maxAttempts: number;
  enabled: boolean;
  lastValidatedAt: string;
  createdAt?: string;
  updatedAt?: string;
};

type OtpTemplateBindingRecord = Pick<
  OtpTemplateBindingDocument,
  | "workspaceId"
  | "channel"
  | "purpose"
  | "templateId"
  | "templateName"
  | "languageCode"
  | "sourceId"
  | "phoneNumberId"
  | "mode"
  | "ttlSeconds"
  | "maxAttempts"
  | "enabled"
  | "lastValidatedAt"
  | "createdAt"
  | "updatedAt"
> & {
  _id?: unknown;
  id?: string;
};

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export { normalizeOtpPurpose } from "./otp-normalization";

export function normalizeOtpTtlSeconds(value: unknown): number {
  return clampInteger(
    value,
    DEFAULT_OTP_TTL_SECONDS,
    MIN_OTP_TTL_SECONDS,
    MAX_OTP_TTL_SECONDS
  );
}

export function normalizeOtpMaxAttempts(value: unknown): number {
  return clampInteger(
    value,
    DEFAULT_MAX_OTP_ATTEMPTS,
    MIN_OTP_ATTEMPTS,
    MAX_OTP_ATTEMPTS
  );
}

function serializeDate(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return undefined;
}

function serializeRequiredDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function serializeOtpTemplateBinding(
  binding: OtpTemplateBindingRecord
): SerializedOtpTemplateBinding {
  const objectId = binding._id ? String(binding._id) : String(binding.id);
  return {
    id: objectId,
    workspaceId: binding.workspaceId,
    channel: binding.channel,
    purpose: binding.purpose,
    templateId: binding.templateId,
    templateName: binding.templateName,
    languageCode: binding.languageCode,
    sourceId: binding.sourceId,
    phoneNumberId: binding.phoneNumberId,
    mode: binding.mode,
    ttlSeconds: binding.ttlSeconds,
    maxAttempts: binding.maxAttempts,
    enabled: binding.enabled,
    lastValidatedAt: serializeRequiredDate(binding.lastValidatedAt),
    createdAt: serializeDate(binding.createdAt),
    updatedAt: serializeDate(binding.updatedAt),
  };
}

function isApprovedAuthenticationTemplate(
  template: Pick<WhatsAppTemplate, "status" | "category">
): boolean {
  return (
    template.status === "APPROVED" && template.category === "AUTHENTICATION"
  );
}

export function assertSupportedOtpTemplate(template: WhatsAppTemplate): void {
  if (!isApprovedAuthenticationTemplate(template)) {
    throw new Error(
      "Only approved WhatsApp authentication templates can be connected to OTP"
    );
  }
}

export async function listOtpTemplateBindings(
  workspaceId: string
): Promise<SerializedOtpTemplateBinding[]> {
  const { connectDB, OtpTemplateBindingModel } = getOtpRuntime();
  await connectDB();
  const bindings = (await OtpTemplateBindingModel.find({
    workspaceId,
    channel: "whatsapp",
  })
    .sort({ purpose: 1 })
    .select(
      "_id workspaceId channel purpose templateId templateName languageCode sourceId phoneNumberId mode ttlSeconds maxAttempts enabled lastValidatedAt createdAt updatedAt"
    )
    .lean()) as OtpTemplateBindingRecord[];
  return bindings.map(serializeOtpTemplateBinding);
}

export async function upsertOtpTemplateBinding(input: {
  workspaceId: string;
  purpose: unknown;
  templateName: string;
  languageCode: string;
  sourceId?: string | null;
  phoneNumberId?: string | null;
  ttlSeconds?: unknown;
  maxAttempts?: unknown;
  enabled?: boolean;
  userId: string;
}): Promise<SerializedOtpTemplateBinding> {
  const runtime = getOtpRuntime();
  await runtime.connectDB();

  const purpose = normalizeOtpPurpose(input.purpose);
  const template = await runtime.findApprovedAuthTemplate({
    workspaceId: input.workspaceId,
    templateName: input.templateName,
    languageCode: input.languageCode,
  });

  if (!template) {
    throw new Error("Approved WhatsApp authentication template not found");
  }

  const now = new Date();
  const existing = await runtime.OtpTemplateBindingModel.findOne({
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    purpose,
  });

  const update = {
    workspaceId: input.workspaceId,
    channel: "whatsapp" as const,
    purpose,
    templateId: template.templateId,
    templateName: template.name,
    languageCode: template.language,
    sourceId: input.sourceId ?? null,
    phoneNumberId: input.phoneNumberId ?? null,
    mode: "copy_code" as const,
    ttlSeconds: normalizeOtpTtlSeconds(input.ttlSeconds),
    maxAttempts: normalizeOtpMaxAttempts(input.maxAttempts),
    enabled: input.enabled !== false,
    updatedByUserId: input.userId,
    lastValidatedAt: now,
  };

  const binding = await runtime.OtpTemplateBindingModel.findOneAndUpdate(
    {
      workspaceId: input.workspaceId,
      channel: "whatsapp",
      purpose,
    },
    {
      ...update,
      createdByUserId: existing?.createdByUserId || input.userId,
    },
    { upsert: true, new: true }
  );

  if (!binding) {
    throw new Error("Failed to upsert WhatsApp OTP template binding");
  }

  return serializeOtpTemplateBinding(binding);
}

export async function deleteOtpTemplateBinding(input: {
  workspaceId: string;
  purpose: unknown;
}): Promise<{ deleted: boolean }> {
  const { connectDB, OtpTemplateBindingModel } = getOtpRuntime();
  await connectDB();
  const result = await OtpTemplateBindingModel.deleteOne({
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    purpose: normalizeOtpPurpose(input.purpose),
  });
  return { deleted: result.deletedCount > 0 };
}

export async function getActiveOtpTemplateBinding(input: {
  workspaceId: string;
  purpose: unknown;
}): Promise<OtpTemplateBindingDocument | null> {
  const { connectDB, OtpTemplateBindingModel } = getOtpRuntime();
  await connectDB();
  return OtpTemplateBindingModel.findOne({
    workspaceId: input.workspaceId,
    channel: "whatsapp",
    purpose: normalizeOtpPurpose(input.purpose),
    enabled: true,
  });
}
