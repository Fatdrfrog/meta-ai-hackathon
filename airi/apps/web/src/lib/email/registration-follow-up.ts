import {
  DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE,
  renderMarkdownEmailTemplate,
  type EmailAutomationTemplate,
} from "@/lib/email/email-template-rendering";
import {
  getWorkspaceEmailSource,
  resolveEmailProviderForWorkspaceSource,
} from "@/lib/email/email-source";
import {
  getWorkspaceEmailProviderConfig,
  isManagedEmailProviderPending,
} from "@/lib/email/provider-config";
import { panelConnectWhatsAppOnboardingHref } from "@/features/panel/shared/routing/hrefs";
import { postmarkSendEmail } from "@/lib/postmark";
import { readTrimmedString as cleanString } from "@icecore/shared/lib/value-utils";

export type RegistrationFollowUpEmailParams = {
  userId: string;
  userEmail: string | null | undefined;
  userName: string | null | undefined;
  companyId: string;
  workspaceId: string;
  senderWorkspaceId?: string;
  workspaceName: string;
  template?: EmailAutomationTemplate;
};

export type RegistrationFollowUpEmailResult =
  | { ok: true; providerMessageId: string }
  | {
      ok: false;
      reason: "not_configured" | "missing_recipient" | "send_failed";
      error?: string;
    };

type RegistrationFollowUpEmailConfig = {
  serverToken: string;
  fromEmail: string;
  messageStream: string;
  appUrl: string;
};

function cleanEmail(value: string | null | undefined): string {
  return cleanString(value).toLowerCase();
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeBaseUrl(value: string | null | undefined): string {
  return (cleanString(value) || "https://www.airi.chat").replace(/\/+$/, "");
}

async function getRegistrationFollowUpEmailConfig(
  workspaceId: string
): Promise<RegistrationFollowUpEmailConfig | null> {
  const emailSource = await getWorkspaceEmailSource(workspaceId);
  const workspaceProvider =
    (await resolveEmailProviderForWorkspaceSource(emailSource)) ||
    (await getWorkspaceEmailProviderConfig(workspaceId, true));
  if (
    workspaceProvider &&
    workspaceProvider.status === "active" &&
    !isManagedEmailProviderPending(workspaceProvider)
  ) {
    return {
      serverToken: workspaceProvider.postmarkServerToken,
      fromEmail: workspaceProvider.defaultFromAddress,
      messageStream: workspaceProvider.transactionalStream,
      appUrl: normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL),
    };
  }

  const serverToken =
    cleanString(process.env.POSTMARK_LIFECYCLE_SERVER_TOKEN) ||
    cleanString(process.env.POSTMARK_SERVER_TOKEN) ||
    cleanString(process.env.POSTMARK_API_KEY);
  const fromEmail =
    cleanString(process.env.POSTMARK_LIFECYCLE_FROM_EMAIL) ||
    cleanString(process.env.POSTMARK_FROM_EMAIL);

  if (!serverToken || !fromEmail) {
    return null;
  }

  return {
    serverToken,
    fromEmail,
    messageStream:
      cleanString(process.env.POSTMARK_LIFECYCLE_STREAM) || "outbound",
    appUrl: normalizeBaseUrl(process.env.NEXT_PUBLIC_APP_URL),
  };
}

export async function sendRegistrationFollowUpEmail(
  params: RegistrationFollowUpEmailParams
): Promise<RegistrationFollowUpEmailResult> {
  const senderWorkspaceId =
    cleanString(params.senderWorkspaceId) || params.workspaceId;
  const config = await getRegistrationFollowUpEmailConfig(senderWorkspaceId);
  if (!config) {
    return { ok: false, reason: "not_configured" };
  }

  const recipient = cleanEmail(params.userEmail);
  if (!isEmailLike(recipient)) {
    return { ok: false, reason: "missing_recipient" };
  }

  const setupUrl = `${config.appUrl}${panelConnectWhatsAppOnboardingHref(
    params.workspaceId
  )}`;
  const template = params.template || DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE;
  const rendered = renderMarkdownEmailTemplate({
    subject: template.subject,
    markdown: template.markdown,
    variables: {
      userName: cleanString(params.userName) || "there",
      workspaceName: cleanString(params.workspaceName) || "your workspace",
      setupUrl,
    },
  });

  try {
    const headers: Record<string, string> = {
      "X-Airi-Email-Type": "registration_followup",
      "X-Airi-User-Id": params.userId,
      "X-Airi-Company-Id": params.companyId,
      "X-Airi-Workspace-Id": params.workspaceId,
    };
    if (senderWorkspaceId !== params.workspaceId) {
      headers["X-Airi-Sender-Workspace-Id"] = senderWorkspaceId;
    }

    const response = await postmarkSendEmail({
      serverToken: config.serverToken,
      from: config.fromEmail,
      to: [recipient],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      messageStream: config.messageStream,
      headers,
    });

    return { ok: true, providerMessageId: response.MessageID };
  } catch (error) {
    return {
      ok: false,
      reason: "send_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
