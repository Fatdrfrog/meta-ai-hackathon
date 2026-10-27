import type {
  PostmarkManagedState,
  WorkspaceEmailProviderConfig,
} from "@/lib/email/provider-config";
import type { NextRequest } from "next/server";

export function buildEmailProviderWebhookUrl(
  req: NextRequest,
  webhookToken: string
): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  return `${base}/api/email/outbound?token=${encodeURIComponent(webhookToken)}`;
}

function sanitizeManagedState(
  state: PostmarkManagedState | null
): PostmarkManagedState | null {
  if (!state) return null;
  return {
    serverId: state.serverId,
    serverName: state.serverName,
    domainId: state.domainId,
    domain: state.domain,
    dkimVerified: state.dkimVerified,
    returnPathVerified: state.returnPathVerified,
    verificationStatus: state.verificationStatus,
    dns: {
      dkimHost: state.dns.dkimHost,
      dkimValue: state.dns.dkimValue,
      returnPathHost: state.dns.returnPathHost,
      returnPathValue: state.dns.returnPathValue,
      ...(state.dns.spfHost ? { spfHost: state.dns.spfHost } : {}),
      ...(state.dns.spfValue ? { spfValue: state.dns.spfValue } : {}),
    },
    ...(state.webhookId ? { webhookId: state.webhookId } : {}),
    ...(state.lastCheckedAt ? { lastCheckedAt: state.lastCheckedAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

export function sanitizeProviderResponse(params: {
  config: WorkspaceEmailProviderConfig;
  req: NextRequest;
  canManage: boolean;
}) {
  const webhookUrl = buildEmailProviderWebhookUrl(
    params.req,
    params.config.webhookToken
  );

  return {
    id: params.config.id,
    workspaceId: params.config.workspaceId,
    provider: params.config.provider,
    mode: params.config.mode,
    verificationStatus: params.config.verificationStatus,
    status: params.config.status,
    defaultFromAddress: params.config.defaultFromAddress,
    transactionalStream: params.config.transactionalStream,
    broadcastStream: params.config.broadcastStream,
    managedState: sanitizeManagedState(params.config.managedState),
    webhookUrl,
    permissions: {
      canManage: params.canManage,
    },
  };
}
