import { createClient } from "@supabase/supabase-js";
import { getWhatsAppGraphClient } from "@icecore/shared/lib/meta/api";

import { decryptString, encryptString, type EncryptedString } from "./crypto";
import { extractOtpWhatsAppCredentials } from "./credentials";
import { enqueueWhatsAppOtpDelivery } from "./enqueue-delivery";
import { CachedAuthTemplateModel } from "./models/cached-auth-template";
import { OtpChallengeModel } from "./models/otp-challenge";
import { OtpTemplateBindingModel } from "./models/otp-template-binding";
import {
  configureOtpRuntime,
  getOtpRuntime,
  type OtpRuntimeDeps,
  type OtpSourceRecord,
  type SendWhatsAppOtpTemplateInput,
  type WhatsAppOtpDeliveryMessage,
} from "./runtime";

async function defaultConnectDB(): Promise<unknown> {
  const { default: connectDB } = await import("@icecore/airi-runtime/mongoose");
  return connectDB();
}

function getSupabaseAdmin() {
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    throw new Error("Supabase admin credentials are not configured");
  }
  return createClient(url, key);
}

async function defaultLoadWhatsAppSource(input: {
  workspaceId: string;
  sourceId?: string | null;
}): Promise<OtpSourceRecord | null> {
  let query = getSupabaseAdmin()
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", input.workspaceId)
    .eq("type", "whatsapp")
    .order("created_at", { ascending: false })
    .limit(1);

  if (input.sourceId) {
    query = query.eq("id", input.sourceId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error("Failed to load WhatsApp source credentials");
  }
  return data as OtpSourceRecord | null;
}

async function defaultFindApprovedAuthTemplate(input: {
  workspaceId: string;
  templateId?: string;
  templateName: string;
  languageCode: string;
}) {
  const filter: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    name: input.templateName,
    language: input.languageCode,
    status: "APPROVED",
    category: "AUTHENTICATION",
  };
  if (input.templateId) {
    filter.templateId = input.templateId;
  }
  const template = await CachedAuthTemplateModel.findOne(filter).lean();
  if (!template || Array.isArray(template)) return null;
  return {
    templateId: template.templateId,
    name: template.name,
    language: template.language,
  };
}

async function defaultSendOtpTemplate(input: SendWhatsAppOtpTemplateInput) {
  const graphClient = getWhatsAppGraphClient();
  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components: input.components,
    },
    biz_opaque_callback_data: `otp:${input.challengeId}`,
    ...(input.messagingAccountId
      ? { messaging_account_id: input.messagingAccountId }
      : {}),
  };
  const response = await graphClient.postJson<{
    messages?: Array<{ id?: string }>;
    error?: { message?: string };
  }>(`${input.phoneNumberId}/messages`, {
    token: input.accessToken,
    body: payload,
  });
  if (response?.error) {
    throw new Error(response.error.message || "WhatsApp Template API error");
  }
  return { messageId: response?.messages?.[0]?.id };
}

async function defaultEnqueueDelivery(message: WhatsAppOtpDeliveryMessage) {
  return enqueueWhatsAppOtpDelivery(message);
}

export function createDefaultOtpRuntime(): OtpRuntimeDeps {
  return {
    connectDB: defaultConnectDB,
    encryptString,
    decryptString: (payload: EncryptedString) => decryptString(payload),
    loadWhatsAppSource: defaultLoadWhatsAppSource,
    extractCredentials: extractOtpWhatsAppCredentials,
    findApprovedAuthTemplate: defaultFindApprovedAuthTemplate,
    sendOtpTemplate: defaultSendOtpTemplate,
    enqueueDelivery: defaultEnqueueDelivery,
    assertRequestAllowed: async (input) => {
      const { assertWhatsAppOtpRequestAllowed } = await import("./otp-rate-limit");
      return assertWhatsAppOtpRequestAllowed(input);
    },
    getActiveBinding: async (input) => {
      const { getActiveOtpTemplateBinding } = await import(
        "./otp-template-binding-service"
      );
      return getActiveOtpTemplateBinding(input);
    },
    OtpChallengeModel: OtpChallengeModel as OtpRuntimeDeps["OtpChallengeModel"],
    OtpTemplateBindingModel:
      OtpTemplateBindingModel as unknown as OtpRuntimeDeps["OtpTemplateBindingModel"],
  };
}

export function installDefaultOtpRuntime(): OtpRuntimeDeps {
  try {
    return getOtpRuntime();
  } catch {
    const deps = createDefaultOtpRuntime();
    configureOtpRuntime(deps);
    return deps;
  }
}

export { buildWhatsAppOtpTemplateComponents } from "./whatsapp-otp-template";
