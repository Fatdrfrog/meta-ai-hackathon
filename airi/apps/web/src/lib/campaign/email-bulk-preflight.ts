import { normalizeCampaignEmail } from "@/lib/campaign/campaign-recipient-utils";
import type { BulkCampaignRecipient } from "@/lib/campaign/bulk-campaign-contracts";
import {
  getWorkspaceEmailSource,
  getWorkspaceEmailSourceResult,
  resolveEmailProviderForWorkspaceSource,
  resolveEmailProviderForWorkspaceSourceResult,
} from "@/lib/email/email-source";
import {
  type EmailUnsubscribeStoreClient,
  getUnsubscribedEmailSet,
} from "@/lib/email/email-unsubscribes";
import {
  getWorkspaceEmailProviderConfig,
  getWorkspaceEmailProviderConfigResult,
  isManagedEmailProviderPending,
  type WorkspaceEmailProviderConfig,
} from "@/lib/email/provider-config";
import type { EmailSource } from "@icecore/shared/types/sources";

export type EmailBulkSendContext =
  | {
      ok: true;
      sourceId: string | null;
      providerConfig: WorkspaceEmailProviderConfig;
      fromAddress: string;
    }
  | {
      ok: false;
      code:
        | "email_source_not_configured"
        | "email_provider_verification_pending"
        | "email_provider_inactive";
      error: string;
    };

type StrictEmailBulkSendContext =
  | Extract<EmailBulkSendContext, { ok: true }>
  | (Extract<EmailBulkSendContext, { ok: false }> & {
      kind: "unavailable";
    })
  | {
      ok: false;
      kind: "query_error";
      code: "email_source_query_failed" | "email_provider_query_failed";
      error: unknown;
    };

type EmailBulkPreflightSkippedRecipientDetail = {
  reason: "email_unsubscribed";
  detail: string;
};

type EmailBulkPreflightResult = {
  recipients: BulkCampaignRecipient[];
  skippedUnsubscribed: number;
  skippedRecipientDetails: EmailBulkPreflightSkippedRecipientDetail[];
};

export function resolveBulkCampaignAppBaseUrl(requestUrl: string): string {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the request origin.
    }
  }

  try {
    return new URL(requestUrl).origin;
  } catch {
    return "https://app.airi.chat";
  }
}

function classifyEmailBulkSendContext(
  emailSource: EmailSource | null,
  providerConfig: WorkspaceEmailProviderConfig | null
): EmailBulkSendContext {
  if (!providerConfig) {
    return {
      ok: false,
      code: "email_source_not_configured",
      error:
        "Email source is not configured for this workspace. Connect email in Settings > Integrations first.",
    };
  }
  if (isManagedEmailProviderPending(providerConfig)) {
    return {
      ok: false,
      code: "email_provider_verification_pending",
      error:
        "email_provider_verification_pending: Verify DNS in Settings > Integrations > Email before sending campaigns.",
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
    sourceId: emailSource?.id || null,
    providerConfig,
    fromAddress: providerConfig.defaultFromAddress,
  };
}

export async function resolveEmailBulkSendContext(params: {
  workspaceId: string;
}): Promise<EmailBulkSendContext> {
  const emailSource = await getWorkspaceEmailSource(params.workspaceId);
  const providerConfig =
    (await resolveEmailProviderForWorkspaceSource(emailSource)) ||
    (await getWorkspaceEmailProviderConfig(params.workspaceId, true));
  return classifyEmailBulkSendContext(emailSource, providerConfig);
}

export async function resolveEmailBulkSendContextStrict(params: {
  workspaceId: string;
}): Promise<StrictEmailBulkSendContext> {
  const sourceResult = await getWorkspaceEmailSourceResult(params.workspaceId);
  if (!sourceResult.ok) {
    return {
      ok: false,
      kind: "query_error",
      code: "email_source_query_failed",
      error: sourceResult.error,
    };
  }

  const providerResult = sourceResult.source
    ? await resolveEmailProviderForWorkspaceSourceResult(sourceResult.source)
    : await getWorkspaceEmailProviderConfigResult(params.workspaceId, true);
  if (!providerResult.ok) {
    return {
      ok: false,
      kind: "query_error",
      code: "email_provider_query_failed",
      error: providerResult.error,
    };
  }

  const classified = classifyEmailBulkSendContext(
    sourceResult.source,
    providerResult.providerConfig
  );
  return classified.ok
    ? classified
    : {
        ...classified,
        kind: "unavailable",
      };
}

export async function filterEmailUnsubscribedRecipients(params: {
  supabase: EmailUnsubscribeStoreClient;
  workspaceId: string;
  recipients: BulkCampaignRecipient[];
}): Promise<EmailBulkPreflightResult> {
  const unsubscribed = await getUnsubscribedEmailSet({
    supabase: params.supabase,
    workspaceId: params.workspaceId,
    emails: params.recipients.map(recipient => recipient.email || ""),
  });

  if (unsubscribed.size === 0) {
    return {
      recipients: params.recipients,
      skippedUnsubscribed: 0,
      skippedRecipientDetails: [],
    };
  }

  const skippedRecipientDetails: EmailBulkPreflightSkippedRecipientDetail[] =
    [];
  const recipients = params.recipients.filter(recipient => {
    const email = normalizeCampaignEmail(recipient.email || "");
    if (!email || !unsubscribed.has(email)) return true;
    skippedRecipientDetails.push({
      reason: "email_unsubscribed",
      detail: email,
    });
    return false;
  });

  return {
    recipients,
    skippedUnsubscribed: params.recipients.length - recipients.length,
    skippedRecipientDetails,
  };
}
