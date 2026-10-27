import { appendMessageToConversationById } from "@/lib/conversation-messages";
import { ensureIndexes } from "@/lib/mongo";
import connectDB from "@/lib/mongoose";
import {
  getWorkspaceEmailSource,
  resolveEmailProviderForWorkspaceSource,
} from "@/lib/email/email-source";
import {
  getWorkspaceEmailProviderConfig,
  isManagedEmailProviderPending,
  type WorkspaceEmailProviderConfig,
} from "@/lib/email/provider-config";
import { postmarkSendEmail } from "@/lib/postmark";
import Message from "@/models/message";
import findOrCreateEmailConversation from "@/lib/email/threading";

export type SendEmailParams = {
  workspaceId: string;
  fromAddress: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  replyToMessageId?: string;
  /** When provided, the message is linked to this conversation directly. */
  conversationId?: string;
  /** Provider the caller already resolved, so it isn't looked up twice. */
  provider?: ActiveEmailProvider;
};

export type SendEmailResult =
  | { ok: true; messageId: string; providerMessageId: string }
  | { ok: false; error: string };

export type ActiveEmailProvider = {
  providerConfig: WorkspaceEmailProviderConfig;
  sourceId?: string;
};

export type ActiveEmailProviderResult =
  | ({ ok: true } & ActiveEmailProvider)
  | {
      ok: false;
      code:
        | "email_provider_missing"
        | "email_provider_verification_pending"
        | "email_provider_inactive";
      error: string;
    };

/** The workspace's email provider, if it is set up and allowed to send. */
export async function resolveActiveEmailProvider(
  workspaceId: string
): Promise<ActiveEmailProviderResult> {
  const emailSource = await getWorkspaceEmailSource(workspaceId);
  const providerConfig =
    (await resolveEmailProviderForWorkspaceSource(emailSource)) ||
    (await getWorkspaceEmailProviderConfig(workspaceId, true));
  if (!providerConfig) {
    return {
      ok: false,
      code: "email_provider_missing",
      error:
        "Email source is not configured for this workspace. Connect email in Settings > Integrations first.",
    };
  }
  if (isManagedEmailProviderPending(providerConfig)) {
    return {
      ok: false,
      code: "email_provider_verification_pending",
      error:
        "email_provider_verification_pending: Verify DNS in Settings > Integrations > Email before sending email.",
    };
  }
  if (providerConfig.status !== "active") {
    return {
      ok: false,
      code: "email_provider_inactive",
      error: "Email provider is inactive for this workspace.",
    };
  }
  return {
    ok: true,
    providerConfig,
    sourceId: emailSource?.id || undefined,
  };
}

function getReferencesHeader(
  headers?: Record<string, unknown>
): string | undefined {
  const value = headers?.References || headers?.references;
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** In-Reply-To and References for a reply to a stored message. */
export async function buildEmailReplyHeaders(
  replyToMessageId: string | undefined
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (!replyToMessageId) return headers;

  const original = (await Message.findById(replyToMessageId)) as {
    external_ids?: { messageId?: string };
    messageId?: string;
    headers?: Record<string, unknown>;
  } | null;
  const inReplyTo =
    original?.external_ids?.messageId || original?.messageId || "";
  let references = getReferencesHeader(original?.headers);
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    references = references ? `${references} ${inReplyTo}` : inReplyTo;
  }
  if (references) headers.References = references;
  return headers;
}

/**
 * Core email sending logic shared between the standalone `/api/email/send`
 * route and the conversation reply handler.
 *
 * Performs provider validation, header threading, Postmark delivery, and
 * MongoDB record-keeping in a single call — without an internal HTTP round-trip.
 */
export async function sendEmail(
  params: SendEmailParams
): Promise<SendEmailResult> {
  const {
    workspaceId,
    fromAddress,
    to,
    subject,
    text,
    html,
    replyToMessageId,
    conversationId,
  } = params;

  const provider =
    params.provider ?? (await resolveActiveEmailProvider(workspaceId));
  if ("ok" in provider && !provider.ok) {
    return { ok: false, error: provider.error };
  }
  const { providerConfig, sourceId } = provider as ActiveEmailProvider;
  const headers = await buildEmailReplyHeaders(replyToMessageId);

  await connectDB();
  await ensureIndexes();

  // Resolve conversation: use provided ID or find/create via threading
  let resolvedConversationId = conversationId;
  if (!resolvedConversationId) {
    const conversation = await findOrCreateEmailConversation({
      workspaceId,
      to: to.map(a => a.toLowerCase()),
      from: [fromAddress.toLowerCase()],
      subject: subject || null,
      headers,
      sourceId,
    });
    resolvedConversationId = String(conversation._id);
  }

  // Send via Postmark
  const { MessageID } = await postmarkSendEmail({
    from: fromAddress,
    to,
    subject,
    text,
    html,
    headers,
    messageStream: providerConfig.transactionalStream,
    serverToken: providerConfig.postmarkServerToken,
  });

  // Persist outbound message
  const message = await Message.create({
    workspaceId,
    conversation: resolvedConversationId,
    channel: "email",
    direction: "outbound",
    origin: {
      kind: "manager",
      ...(sourceId ? { sourceId } : {}),
    },
    subject: subject || undefined,
    text: text || undefined,
    html: html || undefined,
    headers,
    external_ids: { messageId: MessageID },
    date: new Date(),
  });

  // Update conversation
  await appendMessageToConversationById(resolvedConversationId, message._id, {
    lastMessageAt: message.date as Date,
    direction: "outbound",
  });

  return {
    ok: true,
    messageId: String(message._id),
    providerMessageId: MessageID,
  };
}
