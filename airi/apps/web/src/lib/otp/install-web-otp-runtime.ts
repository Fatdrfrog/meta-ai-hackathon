import { decryptString, encryptString } from "@/lib/crypto";
import { OtpChallengeModel } from "@/models/otp-challenge";
import { OtpTemplateBindingModel } from "@/models/otp-template-binding";
import type { WhatsAppTemplateSendComponentInput } from "@/lib/whatsapp/templates/message-types";
import {
  configureOtpRuntime,
  enqueueWhatsAppOtpDelivery,
  extractOtpWhatsAppCredentials,
  type OtpRuntimeDeps,
  type WhatsAppOtpDeliveryMessage,
  type WhatsAppOtpTemplateSendComponent,
} from "@icecore/otp-runtime";

type ApprovedAuthTemplateLean = {
  templateId: string;
  name: string;
  language: string;
};

function toWhatsAppTemplateSendComponents(
  components: WhatsAppOtpTemplateSendComponent[]
): WhatsAppTemplateSendComponentInput[] {
  return components.map((component) => {
    switch (component.type) {
      case "body":
        return {
          type: "body" as const,
          parameters: component.parameters,
        };
      case "button":
        return {
          type: "button" as const,
          sub_type: "url" as const,
          index: component.index ?? "0",
          parameters: component.parameters,
        };
      default: {
        const exhaustive: never = component.type;
        throw new Error(`Unsupported OTP template component: ${exhaustive}`);
      }
    }
  });
}

async function enqueueDelivery(message: WhatsAppOtpDeliveryMessage) {
  return enqueueWhatsAppOtpDelivery(message, {
    publishToPubSub: async (payload) => {
      const { publishWhatsAppOtpDeliveryToPubSub } = await import(
        "./whatsapp-otp-delivery-pubsub"
      );
      return publishWhatsAppOtpDeliveryToPubSub(payload);
    },
  });
}

configureOtpRuntime({
  connectDB: async () => {
    const { default: connectDB } = await import("@/lib/mongoose");
    return connectDB();
  },
  encryptString,
  decryptString,
  loadWhatsAppSource: async (input) => {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    let query = supabaseAdmin
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
    return data as { id?: string; credentials?: unknown } | null;
  },
  extractCredentials: extractOtpWhatsAppCredentials,
  findApprovedAuthTemplate: async (input) => {
    const { WhatsAppTemplateModel } = await import(
      "@/models/whatsapp-template"
    );
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
    const template = (await WhatsAppTemplateModel.findOne(
      filter
    ).lean()) as ApprovedAuthTemplateLean | ApprovedAuthTemplateLean[] | null;
    if (!template || Array.isArray(template)) return null;
    return {
      templateId: template.templateId,
      name: template.name,
      language: template.language,
    };
  },
  sendOtpTemplate: async (input) => {
    const { sendWhatsappTemplate } = await import("@/lib/whatsapp");
    const result = await sendWhatsappTemplate(
      input.phoneNumberId,
      input.accessToken,
      { kind: "phone", value: input.recipientPhone },
      input.templateName,
      input.languageCode,
      toWhatsAppTemplateSendComponents(input.components),
      {
        requirePhoneRecipient: true,
        deliveryProduct: "cloud_api",
        bizOpaqueCallbackData: `otp:${input.challengeId}`,
        redactTemplatePayloadInLogs: true,
        messagingAccountId: input.messagingAccountId,
      }
    );
    return { messageId: result.messageId };
  },
  enqueueDelivery,
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
});
