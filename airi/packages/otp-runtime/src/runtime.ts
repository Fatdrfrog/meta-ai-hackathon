import type { EncryptedString } from "./crypto";
import type {
  OtpChallengeDocument,
  OtpChallengeStatus,
} from "./models/otp-challenge";
import type { OtpTemplateBindingDocument } from "./models/otp-template-binding";
import type { WhatsAppOtpTemplateSendComponent } from "./whatsapp-otp-template";

export type OtpSourceRecord = {
  id?: string;
  credentials?: unknown;
};

export type OtpWhatsAppCredentials = {
  phoneNumberId?: string;
  accessToken?: string;
  messagingAccountId?: string;
};

export type ApprovedAuthTemplate = {
  templateId: string;
  name: string;
  language: string;
};

export type WhatsAppOtpDeliveryMessage = {
  workspaceId: string;
  challengeId: string;
  correlationId: string;
  queuedAt: string;
};

export type WhatsAppOtpEnqueueResult = {
  ok: boolean;
  messageId?: string | null;
  errorMessage?: string | null;
};

export type SendWhatsAppOtpTemplateInput = {
  phoneNumberId: string;
  accessToken: string;
  recipientPhone: string;
  templateName: string;
  languageCode: string;
  components: WhatsAppOtpTemplateSendComponent[];
  challengeId: string;
  messagingAccountId?: string | null;
};

export type SendWhatsAppOtpTemplateResult = {
  messageId?: string;
};

export type OtpChallengeModelLike = {
  new (data: Record<string, unknown>): OtpChallengeDocument & {
    save(): Promise<unknown>;
  };
  findOne(filter: unknown): {
    lean(): Promise<unknown>;
    select(fields: string): { lean(): Promise<unknown> };
  } & Promise<unknown>;
  findOneAndUpdate(
    filter: unknown,
    update: unknown,
    options?: unknown
  ): Promise<unknown> & { lean(): Promise<unknown> };
  updateOne(filter: unknown, update: unknown): Promise<unknown>;
  updateMany(filter: unknown, update: unknown): Promise<unknown>;
};

export type OtpTemplateBindingModelLike = {
  find(filter: unknown): {
    sort(spec: unknown): {
      select(fields: string): { lean(): Promise<unknown[]> };
    };
  };
  findOne(filter: unknown): Promise<OtpTemplateBindingDocument | null>;
  findOneAndUpdate(
    filter: unknown,
    update: unknown,
    options?: unknown
  ): Promise<OtpTemplateBindingDocument | null>;
  deleteOne(filter: unknown): Promise<{ deletedCount: number }>;
};

export type OtpRuntimeDeps = {
  connectDB: () => Promise<unknown>;
  encryptString: (plaintext: string) => EncryptedString;
  decryptString: (payload: EncryptedString) => string;
  loadWhatsAppSource: (input: {
    workspaceId: string;
    sourceId?: string | null;
  }) => Promise<OtpSourceRecord | null>;
  extractCredentials: (credentials: unknown) => OtpWhatsAppCredentials;
  findApprovedAuthTemplate: (input: {
    workspaceId: string;
    templateId?: string;
    templateName: string;
    languageCode: string;
  }) => Promise<ApprovedAuthTemplate | null>;
  sendOtpTemplate: (
    input: SendWhatsAppOtpTemplateInput
  ) => Promise<SendWhatsAppOtpTemplateResult>;
  enqueueDelivery: (
    message: WhatsAppOtpDeliveryMessage
  ) => Promise<WhatsAppOtpEnqueueResult>;
  assertRequestAllowed: (input: {
    workspaceId: string;
    recipientPhone: string;
    purpose: string;
  }) => Promise<void>;
  getActiveBinding: (input: {
    workspaceId: string;
    purpose: unknown;
  }) => Promise<{
    _id?: unknown;
    templateId: string;
    templateName: string;
    languageCode: string;
    sourceId?: string | null;
    phoneNumberId?: string | null;
    ttlSeconds: number;
    maxAttempts: number;
  } | null>;
  OtpChallengeModel: OtpChallengeModelLike;
  OtpTemplateBindingModel: OtpTemplateBindingModelLike;
};

let configured: OtpRuntimeDeps | null = null;

export function configureOtpRuntime(deps: OtpRuntimeDeps): void {
  configured = deps;
}

export function resetOtpRuntimeForTests(): void {
  configured = null;
}

export function getOtpRuntime(): OtpRuntimeDeps {
  if (configured) return configured;
  throw new Error(
    "OTP runtime is not configured. Call configureOtpRuntime() or installDefaultOtpRuntime()."
  );
}

export type { EncryptedString, OtpChallengeStatus };
