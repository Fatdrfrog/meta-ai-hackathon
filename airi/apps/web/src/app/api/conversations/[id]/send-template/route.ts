import {
  persistManagerOutboundMessage,
  upsertManagerAuthor,
} from "@/lib/conversation-messages";
import { getHiddenConversationPlanGateResponse } from "@/lib/limits/company-limits";
import connectDB from "@/lib/mongoose";
import { getWorkspaceMemberDisplayName } from "@/lib/supabase/company-users";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsappTemplate } from "@/lib/whatsapp";
import { resolveFreshWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import {
  buildWhatsAppTemplateSendComponentsFromTemplate,
  type WhatsAppTemplateSendComponentInput,
} from "@/lib/whatsapp/templates/message-types";
import { mergeComponentsWithUnifiedHeaderMediaUrl } from "@/lib/whatsapp/templates/header-media-utils";
import { buildStoredWhatsAppTemplatePreview } from "@/lib/whatsapp/templates/preview";
import { listApprovedWhatsAppTemplatesForSend } from "@/lib/whatsapp/templates/send-lookup";
import { normalizeWhatsAppTemplateLanguageForSend } from "@icecore/shared/constants/whatsapp-templates";
import { Conversation } from "@/models/conversation";
import { WhatsAppTemplateModel } from "@/models/whatsapp-template";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import { NextRequest, NextResponse } from "next/server";
import {
  asNullableRecord,
  readTrimmedString as asTrimmedString,
} from "@icecore/shared/lib/value-utils";
import { resolveConversationWhatsAppRecipient } from "../reply/whatsapp-recipient";

type Params = Promise<{ id: string }>;

type SendTemplateConversation = {
  _id: string;
  workspaceId: string;
  channel?: string;
  sourceId?: string | null;
  preferred_language?: string | null;
  user?: unknown;
  chat?: unknown;
};

interface SendTemplateRequest {
  templateName: string;
  languageCode?: string;
  components?: WhatsAppTemplateSendComponentInput[];
}

type TemplateDoc = {
  category?: string;
  components?: WhatsAppComponent[];
  language?: string;
};

type IdentitySource = {
  _id?: unknown;
  firstName?: string | null;
  lastName?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  title?: string | null;
  whatsapp?: {
    waId?: string | null;
    userId?: string | null;
    parentUserId?: string | null;
    username?: string | null;
    profileName?: string | null;
  } | null;
};

function languageBase(value: string): string {
  const [base] = normalizeWhatsAppTemplateLanguageForSend(value).split("_");
  return base || "";
}

function pickTemplateDoc(
  docs: TemplateDoc[],
  languageCode: string
): TemplateDoc | null {
  if (docs.length === 0) return null;

  const requested = normalizeWhatsAppTemplateLanguageForSend(languageCode);
  if (!requested) return docs[0] || null;

  const exact = docs.find(
    doc => normalizeWhatsAppTemplateLanguageForSend(doc.language) === requested
  );
  if (exact) return exact;

  const requestedBase = languageBase(requested);
  if (requestedBase) {
    const prefix = docs.find(
      doc => languageBase(doc.language || "") === requestedBase
    );
    if (prefix) return prefix;
  }

  return docs[0] || null;
}

function pickUnifiedWhatsAppComponents(
  rows: unknown,
  languageCode: string
): WhatsAppComponent[] | undefined {
  if (!Array.isArray(rows)) return undefined;

  const requested = normalizeWhatsAppTemplateLanguageForSend(languageCode);
  const matches: WhatsAppComponent[][] = [];

  for (const row of rows) {
    const record = asNullableRecord(row);
    const whatsappData = asNullableRecord(record?.whatsapp_data);
    const components = whatsappData?.components;
    if (!Array.isArray(components)) continue;
    const language = normalizeWhatsAppTemplateLanguageForSend(
      whatsappData?.language
    );
    if (requested && language && language !== requested) continue;
    matches.push(components as WhatsAppComponent[]);
  }

  return matches[0];
}

function getEntityId(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getDisplayName(source: IdentitySource | null): string {
  if (!source) return "";

  const profileName = asTrimmedString(source.whatsapp?.profileName);
  const fullName = [
    asTrimmedString(source.firstName || source.first_name),
    asTrimmedString(source.lastName || source.last_name),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return (
    fullName ||
    profileName ||
    asTrimmedString(source.title) ||
    asTrimmedString(source.username || source.whatsapp?.username)
  );
}

function firstNameFromDisplayName(value: string): string {
  const [first] = value.trim().split(/\s+/).filter(Boolean);
  return first || "";
}

function buildTemplateValueMap(params: {
  conversationId: string;
  conversation: { channel?: string; preferred_language?: string | null };
  recipientTarget: { kind: string; value: string };
  recipientUser: IdentitySource | null;
  chatDocument: IdentitySource | null;
}): Record<string, string> {
  const userName = getDisplayName(params.recipientUser);
  const chatName = getDisplayName(params.chatDocument);
  const fullName = userName || chatName || "Customer";
  const firstName =
    asTrimmedString(params.recipientUser?.firstName) ||
    asTrimmedString(params.chatDocument?.first_name) ||
    firstNameFromDisplayName(fullName) ||
    "Customer";
  const lastName =
    asTrimmedString(params.recipientUser?.lastName) ||
    asTrimmedString(params.chatDocument?.last_name);
  const username =
    asTrimmedString(params.recipientUser?.username) ||
    asTrimmedString(params.chatDocument?.username) ||
    asTrimmedString(params.recipientUser?.whatsapp?.username) ||
    asTrimmedString(params.chatDocument?.whatsapp?.username);
  const waId =
    params.recipientTarget.kind === "phone"
      ? params.recipientTarget.value
      : asTrimmedString(params.recipientUser?.whatsapp?.waId) ||
        asTrimmedString(params.chatDocument?.whatsapp?.waId);
  const whatsappId =
    waId ||
    asTrimmedString(params.recipientUser?.whatsapp?.userId) ||
    asTrimmedString(params.chatDocument?.whatsapp?.userId) ||
    asTrimmedString(params.recipientUser?.whatsapp?.parentUserId) ||
    asTrimmedString(params.chatDocument?.whatsapp?.parentUserId) ||
    params.recipientTarget.value;
  const chatId = getEntityId(params.chatDocument?._id);

  return {
    "1": fullName,
    "2": waId || whatsappId,
    name: fullName,
    full_name: fullName,
    customer_name: fullName,
    first_name: firstName,
    last_name: lastName,
    username,
    title: asTrimmedString(params.chatDocument?.title),
    phone: waId,
    wa_id: waId,
    whatsapp_id: whatsappId,
    whatsapp_user_id:
      asTrimmedString(params.recipientUser?.whatsapp?.userId) ||
      asTrimmedString(params.chatDocument?.whatsapp?.userId),
    whatsapp_parent_user_id:
      asTrimmedString(params.recipientUser?.whatsapp?.parentUserId) ||
      asTrimmedString(params.chatDocument?.whatsapp?.parentUserId),
    chat_id: chatId,
    conversation_id: params.conversationId,
    channel: params.conversation.channel || "whatsapp",
    preferred_language: params.conversation.preferred_language || "",
  };
}

function getComponentKey(
  component: WhatsAppTemplateSendComponentInput
): string {
  if (component.type === "button") {
    return `button:${component.sub_type}:${String(component.index)}`;
  }

  return component.type;
}

function mergeTemplateSendComponents(
  requested?: WhatsAppTemplateSendComponentInput[],
  inferred?: WhatsAppTemplateSendComponentInput[]
): WhatsAppTemplateSendComponentInput[] | undefined {
  const merged: WhatsAppTemplateSendComponentInput[] = [];
  const seen = new Set<string>();

  for (const component of [...(requested || []), ...(inferred || [])]) {
    const key = getComponentKey(component);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(component);
  }

  return merged.length > 0 ? merged : undefined;
}

function hasHeaderMediaParameter(
  components: WhatsAppTemplateSendComponentInput[] | undefined,
  format: "IMAGE" | "VIDEO" | "DOCUMENT"
): boolean {
  return Boolean(
    components?.some(component => {
      if (component.type === "carousel") {
        return (
          component.cards.length > 0 &&
          component.cards.every(card =>
            hasHeaderMediaParameter(card.components, format)
          )
        );
      }
      if (component.type !== "header") return false;
      return component.parameters.some(parameter => {
          if (format === "IMAGE") {
            return (
              parameter.type === "image" &&
              Boolean(
                parameter.image.link?.trim() || parameter.image.id?.trim()
              )
            );
          }
          if (format === "VIDEO") {
            return (
              parameter.type === "video" &&
              Boolean(
                parameter.video.link?.trim() || parameter.video.id?.trim()
              )
            );
          }
          return (
            parameter.type === "document" &&
            Boolean(
              parameter.document.link?.trim() || parameter.document.id?.trim()
            )
          );
        });
    })
  );
}

function summarizeSendComponentParameters(
  components: WhatsAppTemplateSendComponentInput[]
): unknown[] {
  return components.flatMap(component => {
    if (component.type === "carousel") {
      return component.cards.flatMap(card =>
        summarizeSendComponentParameters(card.components)
      );
    }
    return component.parameters.map(parameter =>
      parameter.type === "text"
        ? parameter.text
        : parameter.type === "payload"
          ? parameter.payload
          : parameter.type
    );
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const supabase = await createClient();
    const {
      data: { user: managerUser },
    } = await supabase.auth.getUser();

    if (!managerUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: conversationId } = await params;
    const body = (await request.json()) as SendTemplateRequest;
    const { templateName, languageCode = "en", components } = body;

    if (!templateName) {
      return NextResponse.json(
        { error: "Template name is required" },
        { status: 400 }
      );
    }

    await connectDB();
    const conversation = await Conversation.findById(conversationId)
      .select("workspaceId channel sourceId preferred_language user chat")
      .populate({
        path: "chat",
        select: "_id type title first_name last_name username whatsapp",
      })
      .lean<SendTemplateConversation | null>();

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    if (conversation.channel !== "whatsapp") {
      return NextResponse.json(
        {
          error:
            "Template messages are only supported for WhatsApp conversations",
        },
        { status: 400 }
      );
    }

    const { workspaceId } = conversation;
    if (
      !(await checkUserWorkspaceAccess(supabase, managerUser.id, workspaceId))
    ) {
      return NextResponse.json(
        { error: "Access denied to this conversation" },
        { status: 403 }
      );
    }

    const planGateResponse = await getHiddenConversationPlanGateResponse(
      supabase,
      workspaceId,
      conversationId
    );
    if (planGateResponse) {
      return planGateResponse;
    }

    // Resolved alongside the send; only the stored author needs it.
    const managerNamePromise = getWorkspaceMemberDisplayName(
      supabase,
      managerUser.id,
      workspaceId
    ).catch(() => "Manager");

    // Send from the number this conversation is bound to, never from another
    // workspace source: a workspace can connect several numbers and WABAs.
    const sourceId =
      typeof conversation.sourceId === "string"
        ? conversation.sourceId.trim()
        : "";
    if (!sourceId) {
      return NextResponse.json(
        {
          code: "WHATSAPP_SOURCE_REQUIRED",
          error:
            "The conversation has no WhatsApp source binding. Contact support before sending.",
        },
        { status: 409 }
      );
    }
    const sendContext = await resolveFreshWhatsAppSendContext({
      workspaceId,
      sourceId,
    });
    if (!sendContext) {
      return NextResponse.json(
        {
          code: "WHATSAPP_SOURCE_UNAVAILABLE",
          error: "The conversation's WhatsApp connection is unavailable.",
        },
        { status: 409 }
      );
    }

    const { recipientUser, recipientTarget } =
      await resolveConversationWhatsAppRecipient(conversation);
    if (!recipientTarget) {
      return NextResponse.json(
        { error: "Recipient WhatsApp target not found" },
        { status: 404 }
      );
    }

    const cachedTemplateDocs = await WhatsAppTemplateModel.find({
      workspaceId,
      name: templateName,
      status: "APPROVED",
    })
      .select("category components language")
      .lean<TemplateDoc[]>()
      .catch(() => []);
    let templateDoc = pickTemplateDoc(cachedTemplateDocs, languageCode);

    if (!templateDoc || !Array.isArray(templateDoc.components)) {
      const liveTemplates = await listApprovedWhatsAppTemplatesForSend(
        workspaceId,
        { sourceId }
      ).catch(() => []);
      templateDoc = pickTemplateDoc(
        liveTemplates
          .filter(template => template.name === templateName)
          .map(template => ({
            category: template.category,
            components: template.components,
            language: template.language,
          })),
        languageCode
      );
    }

    const chatDocument = asNullableRecord(
      conversation.chat
    ) as IdentitySource | null;
    const { data: unifiedTemplateRows } = await supabase
      .from("message_templates")
      .select("whatsapp_data")
      .eq("workspace_id", workspaceId)
      .eq("name", templateName);
    const templateComponents =
      mergeComponentsWithUnifiedHeaderMediaUrl({
        metaComponents: templateDoc?.components,
        unifiedComponents: pickUnifiedWhatsAppComponents(
          unifiedTemplateRows,
          languageCode
        ),
      }) ?? templateDoc?.components;
    const inferredComponents = buildWhatsAppTemplateSendComponentsFromTemplate({
      templateComponents,
      values: buildTemplateValueMap({
        conversationId,
        conversation,
        recipientTarget,
        recipientUser,
        chatDocument,
      }),
    });
    const resolvedComponents = mergeTemplateSendComponents(
      components,
      inferredComponents.components
    );
    const missingHeaderMedia = inferredComponents.issues.find(
      issue => issue.type === "missing_header_media"
    );

    if (
      missingHeaderMedia &&
      !hasHeaderMediaParameter(resolvedComponents, missingHeaderMedia.format)
    ) {
      return NextResponse.json(
        {
          error: `Template "${templateName}" requires a ${missingHeaderMedia.format.toLowerCase()} header parameter. Send a header component with a media link/id before sending this template.`,
        },
        { status: 400 }
      );
    }

    const sentMessageData = await sendWhatsappTemplate(
      sendContext.phoneNumberId,
      sendContext.accessToken,
      recipientTarget,
      templateName,
      languageCode,
      resolvedComponents,
      {
        requirePhoneRecipient: templateDoc?.category === "AUTHENTICATION",
        messagingAccountId: sendContext.messagingAccountId,
      }
    );

    const templateMessageText =
      templateDoc?.category === "AUTHENTICATION"
        ? `[Authentication template: ${templateName}]`
        : `[Template: ${templateName}]${
            resolvedComponents
              ? " with variables: " +
                JSON.stringify(
                  summarizeSendComponentParameters(resolvedComponents)
                )
              : ""
          }`;

    const managerAuthor = await upsertManagerAuthor({
      id: managerUser.id,
      name: "Manager",
      namePromise: managerNamePromise,
    });
    await persistManagerOutboundMessage({
      conversation,
      workspaceId,
      channel: "whatsapp",
      managerId: managerUser.id,
      managerUser: managerAuthor,
      message: {
        messageId: sentMessageData.messageId,
        date: new Date(sentMessageData.date * 1000),
        text: templateMessageText,
        fields: {
          whatsappTemplate: buildStoredWhatsAppTemplatePreview({
            name: templateName,
            languageCode,
            components: templateDoc?.components,
          }),
        },
        origin: {
          templateName,
          templateCategory: templateDoc?.category || null,
          sourceId,
        },
      },
      logTag: "SendTemplate",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    const isParamMismatch =
      errorMessage.includes("requires variable parameters") ||
      errorMessage.includes("requires non-empty component parameters") ||
      errorMessage.includes("132000") ||
      errorMessage.includes("132012") ||
      errorMessage.includes("parameters does not match") ||
      errorMessage.includes("component parameter");
    return NextResponse.json(
      { error: errorMessage },
      { status: isParamMismatch ? 400 : 500 }
    );
  }
}
