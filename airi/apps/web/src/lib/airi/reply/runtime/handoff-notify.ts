import type { AiriScenarioRuntimeConfig } from "@icecore/airi-runtime/scenario-runtime-types";
import { buildHandoffPanelUrl } from "@/lib/airi/handoff-panel-url";
import { formatClientName } from "@/lib/date-utils";
import {
  getWorkspaceEmailSource,
  resolveEmailProviderForWorkspaceSource,
} from "@/lib/email/email-source";
import {
  getWorkspaceEmailProviderConfig,
  isManagedEmailProviderPending,
} from "@/lib/email/provider-config";
import { postmarkSendEmail } from "@/lib/postmark";
import type { Channel, ConversationDocument } from "@/types/models";
import { sendWhatsappMessage } from "@/lib/whatsapp";
import { resolveWhatsAppSendContext } from "@/lib/whatsapp/send-context";
import { airiOrchestrationLogger } from "@/lib/airi/reply/runtime/reply-logging";
import { escapeHtml } from "@icecore/shared/lib/html-utils";

type HandoffAlertFacts = {
  scenarioName: string;
  handoffReason: string;
  channelLabel: string;
  customerLabel: string;
  panelUrl: string;
};

function buildHandoffAlertBodies(facts: HandoffAlertFacts): {
  text: string;
  html: string;
} {
  const { scenarioName, handoffReason, channelLabel, customerLabel, panelUrl } =
    facts;
  const text = [
    "Human handoff",
    `Scenario: ${scenarioName}`,
    `Reason: ${handoffReason}`,
    `Channel: ${channelLabel}`,
    `Chat: ${customerLabel}`,
    "",
    `Open in inbox: ${panelUrl}`,
  ].join("\n");
  const html = [
    "<p><strong>Human handoff</strong></p>",
    "<ul>",
    `<li><strong>Scenario:</strong> ${escapeHtml(scenarioName)}</li>`,
    `<li><strong>Reason:</strong> ${escapeHtml(handoffReason)}</li>`,
    `<li><strong>Channel:</strong> ${escapeHtml(channelLabel)}</li>`,
    `<li><strong>Chat:</strong> ${escapeHtml(customerLabel)}</li>`,
    "</ul>",
    `<p><a href="${escapeHtml(panelUrl)}">Open in inbox</a></p>`,
  ].join("");
  return { text, html };
}

function truncateForWhatsAppSession(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function buildHandoffCustomerLabel(
  channel: Channel,
  conversation: ConversationDocument,
  chatDocument: {
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  } | null
): string {
  const user = conversation.user as Parameters<typeof formatClientName>[1];
  const chat =
    (conversation.chat as Parameters<typeof formatClientName>[3]) ||
    (chatDocument as Parameters<typeof formatClientName>[3]) ||
    undefined;
  return formatClientName(channel, user, undefined, chat) || "Customer";
}

export type SendHandoffNotificationsParams = {
  workspaceId: string;
  conversationId: string;
  channel: Channel;
  conversation: ConversationDocument;
  chatDocument: {
    title?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  } | null;
  scenarioRuntime: Pick<
    AiriScenarioRuntimeConfig,
    "scenarioName" | "actionHandoffNotifyEmail" | "actionHandoffNotifyWhatsapp"
  >;
  handoffReason: string;
};

/**
 * Fire-and-forget handoff alerts (email + WhatsApp session message). Errors are logged, never thrown.
 */
export function sendHandoffNotifications(
  params: SendHandoffNotificationsParams
): void {
  void sendHandoffNotificationsInner(params).catch(err => {
    airiOrchestrationLogger.warn("airi.orchestration.handoff_notify", {
      workspaceId: params.workspaceId,
      conversationId: params.conversationId,
      note: "notify_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  });
}

async function sendHandoffNotificationsInner(
  params: SendHandoffNotificationsParams
): Promise<void> {
  const {
    workspaceId,
    conversationId,
    channel,
    conversation,
    chatDocument,
    scenarioRuntime,
    handoffReason,
  } = params;

  const notifyEmail = (scenarioRuntime.actionHandoffNotifyEmail || "").trim();
  const notifyWa = (scenarioRuntime.actionHandoffNotifyWhatsapp || "").trim();
  if (!notifyEmail && !notifyWa) return;

  const panelUrl = buildHandoffPanelUrl(workspaceId, conversationId);
  const customerLabel = buildHandoffCustomerLabel(
    channel,
    conversation,
    chatDocument
  );
  const scenarioName = scenarioRuntime.scenarioName || "Scenario";
  const channelLabel = String(channel || "unknown");

  const { text: textBody, html: htmlBody } = buildHandoffAlertBodies({
    scenarioName,
    handoffReason,
    channelLabel,
    customerLabel,
    panelUrl,
  });

  if (notifyEmail) {
    try {
      const emailSource = await getWorkspaceEmailSource(workspaceId);
      const provider =
        (await resolveEmailProviderForWorkspaceSource(emailSource)) ||
        (await getWorkspaceEmailProviderConfig(workspaceId, true));
      if (!provider || provider.status !== "active") {
        airiOrchestrationLogger.warn("airi.orchestration.handoff_notify", {
          workspaceId,
          conversationId,
          note: "email_skipped_no_provider",
        });
      } else if (isManagedEmailProviderPending(provider)) {
        airiOrchestrationLogger.warn("airi.orchestration.handoff_notify", {
          workspaceId,
          conversationId,
          note: "email_skipped_provider_pending",
        });
      } else {
        await postmarkSendEmail({
          from: provider.defaultFromAddress,
          to: notifyEmail,
          subject: `[airi.chat] Human handoff: ${scenarioName}`,
          text: textBody,
          html: htmlBody,
          messageStream: provider.transactionalStream,
          serverToken: provider.postmarkServerToken,
        });
      }
    } catch (err) {
      airiOrchestrationLogger.warn("airi.orchestration.handoff_notify", {
        workspaceId,
        conversationId,
        note: "email_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (notifyWa) {
    try {
      const sourceId =
        channel === "whatsapp"
          ? String(conversation.sourceId || "").trim() || undefined
          : undefined;
      const ctx = await resolveWhatsAppSendContext({
        workspaceId,
        sourceId: sourceId || null,
      });
      if (!ctx) {
        airiOrchestrationLogger.warn("airi.orchestration.handoff_notify", {
          workspaceId,
          conversationId,
          note: "whatsapp_skipped_no_context",
        });
      } else {
        const waText = truncateForWhatsAppSession(textBody, 4096);
        await sendWhatsappMessage(
          ctx.phoneNumberId,
          ctx.accessToken,
          notifyWa,
          waText
        );
      }
    } catch (err) {
      airiOrchestrationLogger.warn("airi.orchestration.handoff_notify", {
        workspaceId,
        conversationId,
        note: "whatsapp_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
