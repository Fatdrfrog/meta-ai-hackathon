import type { PostmarkManagedState } from "@/lib/email/provider-config";
import { readEnvFlag } from "@icecore/shared/lib/env";

const POSTMARK_BASE = "https://api.postmarkapp.com";
const DEFAULT_BROADCAST_STREAM_ID = "broadcast";
const DEFAULT_TRANSACTIONAL_STREAM_ID = "outbound";

type PostmarkServerResponse = {
  ID: number;
  Name: string;
  ApiTokens?: string[];
};

type PostmarkServersListResponse = {
  TotalCount: number;
  Servers: PostmarkServerResponse[];
};

type PostmarkMessageStream = {
  ID: string;
  Name?: string;
  MessageStreamType?: string;
  ArchivedAt?: string | null;
};

type PostmarkMessageStreamsResponse = {
  MessageStreams: PostmarkMessageStream[];
};

type PostmarkWebhook = {
  ID: number;
  Url: string;
  MessageStream?: string;
};

type PostmarkWebhooksResponse = {
  Webhooks: PostmarkWebhook[];
};

type PostmarkDomainResponse = {
  ID: number;
  Name: string;
  SPFHost?: string;
  SPFTextValue?: string;
  DKIMVerified?: boolean;
  DKIMHost?: string;
  DKIMTextValue?: string;
  DKIMPendingHost?: string;
  DKIMPendingTextValue?: string;
  ReturnPathDomain?: string;
  ReturnPathDomainVerified?: boolean;
  ReturnPathDomainCNAMEValue?: string;
};

type PostmarkDomainsListResponse = {
  TotalCount: number;
  Domains: Array<{
    ID: number;
    Name: string;
    DKIMVerified?: boolean;
    ReturnPathDomainVerified?: boolean;
  }>;
};

type SetupManagedPostmarkParams = {
  workspaceId: string;
  defaultFromAddress: string;
  webhookUrl: string;
  existingServerToken?: string;
  existingManagedState?: PostmarkManagedState | null;
};

type SetupManagedPostmarkResult = {
  serverToken: string;
  transactionalStream: string;
  broadcastStream: string;
  managedState: PostmarkManagedState;
};

type VerifyManagedDomainParams = {
  managedState: PostmarkManagedState;
};

function normalizePostmarkError(
  status: number,
  rawBody: string
): { message: string; code?: number } {
  let message: string | undefined;
  let code: number | undefined;

  try {
    const parsed = JSON.parse(rawBody) as {
      Message?: string;
      ErrorCode?: number;
    };
    message = parsed.Message;
    code = parsed.ErrorCode;
  } catch {
    // ignore parse failures
  }

  return {
    message: `Postmark request failed: ${status} ${message || rawBody || "Unknown error"}${typeof code === "number" ? ` (code ${code})` : ""}`,
    ...(typeof code === "number" ? { code } : {}),
  };
}

export function isPostmarkPlatformManagedEnabled(): boolean {
  const hasAccountToken = Boolean(
    String(process.env.POSTMARK_ACCOUNT_TOKEN || "").trim()
  );
  if (!hasAccountToken) return false;
  return readEnvFlag("POSTMARK_PLATFORM_MANAGED_ENABLED", true);
}

function getPostmarkAccountToken(): string {
  const token = String(process.env.POSTMARK_ACCOUNT_TOKEN || "").trim();
  if (!token) {
    throw new Error("POSTMARK_ACCOUNT_TOKEN is not configured");
  }
  return token;
}

function extractDomainFromEmail(email: string): string {
  const raw = String(email || "")
    .trim()
    .toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error("defaultFromAddress must include a valid domain");
  }
  const domain = raw.slice(at + 1).trim();
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    throw new Error("defaultFromAddress must include a valid domain");
  }
  return domain;
}

function buildWorkspaceServerName(workspaceId: string): string {
  return `Airi Workspace ${workspaceId}`;
}

function buildReturnPathDomain(domain: string): string {
  return `pm-bounces.${domain}`;
}

async function postmarkAccountRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = getPostmarkAccountToken();
  const response = await fetch(`${POSTMARK_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      "X-Postmark-Account-Token": token,
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    const normalized = normalizePostmarkError(response.status, raw);
    throw new Error(normalized.message);
  }

  if (response.status === 204) {
    return {} as T;
  }
  return (await response.json()) as T;
}

async function postmarkServerRequest<T>(params: {
  serverToken: string;
  path: string;
  init?: RequestInit;
}): Promise<T> {
  const response = await fetch(`${POSTMARK_BASE}${params.path}`, {
    ...(params.init || {}),
    headers: {
      Accept: "application/json",
      ...(params.init?.body ? { "Content-Type": "application/json" } : {}),
      "X-Postmark-Server-Token": params.serverToken,
      ...(params.init?.headers || {}),
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    const normalized = normalizePostmarkError(response.status, raw);
    throw new Error(normalized.message);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

async function findServerByName(
  serverName: string
): Promise<PostmarkServerResponse | null> {
  const query = `?count=100&offset=0&name=${encodeURIComponent(serverName)}`;
  const list = await postmarkAccountRequest<PostmarkServersListResponse>(
    `/servers${query}`
  );
  const target = list.Servers.find(
    server =>
      String(server.Name || "")
        .trim()
        .toLowerCase() === serverName.toLowerCase()
  );
  return target || null;
}

async function ensureWorkspaceServer(params: {
  workspaceId: string;
  existingServerToken?: string;
  existingManagedState?: PostmarkManagedState | null;
}): Promise<{ serverId: number; serverName: string; serverToken: string }> {
  const state = params.existingManagedState || null;
  const existingToken = String(params.existingServerToken || "").trim();
  if (state?.serverId && existingToken) {
    return {
      serverId: state.serverId,
      serverName: state.serverName,
      serverToken: existingToken,
    };
  }

  const serverName = buildWorkspaceServerName(params.workspaceId);
  const existingServer = await findServerByName(serverName);
  if (existingServer) {
    const token = String(existingServer.ApiTokens?.[0] || "").trim();
    if (!token) {
      throw new Error(
        "Found existing Postmark server, but no API token is available for sending"
      );
    }
    return {
      serverId: existingServer.ID,
      serverName: existingServer.Name,
      serverToken: token,
    };
  }

  const created = await postmarkAccountRequest<PostmarkServerResponse>(
    "/servers",
    {
      method: "POST",
      body: JSON.stringify({
        Name: serverName,
        Color: "Blue",
      }),
    }
  );

  const createdToken = String(created.ApiTokens?.[0] || "").trim();
  if (!createdToken) {
    throw new Error(
      "Postmark server was created, but no server token was returned"
    );
  }

  return {
    serverId: created.ID,
    serverName: created.Name,
    serverToken: createdToken,
  };
}

async function ensureBroadcastStream(params: {
  serverToken: string;
  streamId?: string;
}): Promise<string> {
  const streamId = String(
    params.streamId || DEFAULT_BROADCAST_STREAM_ID
  ).trim();
  const list = await postmarkServerRequest<PostmarkMessageStreamsResponse>({
    serverToken: params.serverToken,
    path: "/message-streams?MessageStreamType=all&IncludeArchivedStreams=true",
  });

  const existing = list.MessageStreams.find(
    stream => String(stream.ID || "").trim() === streamId
  );

  if (existing) {
    if (existing.ArchivedAt) {
      await postmarkServerRequest({
        serverToken: params.serverToken,
        path: `/message-streams/${encodeURIComponent(streamId)}/unarchive`,
        init: {
          method: "POST",
          headers: { "Content-Length": "0" },
        },
      });
    }
    return streamId;
  }

  await postmarkServerRequest({
    serverToken: params.serverToken,
    path: "/message-streams",
    init: {
      method: "POST",
      body: JSON.stringify({
        ID: streamId,
        Name: "Broadcast",
        Description: "Broadcast campaign stream",
        MessageStreamType: "Broadcasts",
        SubscriptionManagementConfiguration: {
          UnsubscribeHandlingType: "Postmark",
        },
      }),
    },
  });

  return streamId;
}

async function ensureOutboundWebhook(params: {
  serverToken: string;
  webhookUrl: string;
  messageStream: string;
}): Promise<number> {
  const webhooks = await postmarkServerRequest<PostmarkWebhooksResponse>({
    serverToken: params.serverToken,
    path: `/webhooks?MessageStream=${encodeURIComponent(params.messageStream)}`,
  });

  const existing = webhooks.Webhooks.find(
    webhook =>
      String(webhook.Url || "").trim() === params.webhookUrl &&
      String(webhook.MessageStream || "").trim() === params.messageStream
  );

  if (existing) {
    return existing.ID;
  }

  const created = await postmarkServerRequest<PostmarkWebhook>({
    serverToken: params.serverToken,
    path: "/webhooks",
    init: {
      method: "POST",
      body: JSON.stringify({
        Url: params.webhookUrl,
        MessageStream: params.messageStream,
        Triggers: {
          Open: { Enabled: true, PostFirstOpenOnly: false },
          Click: { Enabled: true },
          Delivery: { Enabled: true },
          SubscriptionChange: { Enabled: true },
        },
      }),
    },
  });

  return created.ID;
}

async function listAllDomains(): Promise<
  PostmarkDomainsListResponse["Domains"]
> {
  const domains: PostmarkDomainsListResponse["Domains"] = [];
  const count = 100;
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;

  while (offset < totalCount) {
    const page = await postmarkAccountRequest<PostmarkDomainsListResponse>(
      `/domains?count=${count}&offset=${offset}`
    );

    totalCount = Number(page.TotalCount || 0);
    domains.push(...(Array.isArray(page.Domains) ? page.Domains : []));
    offset += count;

    if (!page.Domains || page.Domains.length === 0) break;
  }

  return domains;
}

async function findDomainByName(domain: string): Promise<number | null> {
  const domains = await listAllDomains();
  const match = domains.find(
    item =>
      String(item.Name || "")
        .trim()
        .toLowerCase() === domain.toLowerCase()
  );
  return match ? Number(match.ID) : null;
}

async function getDomainDetails(
  domainId: number
): Promise<PostmarkDomainResponse> {
  return postmarkAccountRequest<PostmarkDomainResponse>(`/domains/${domainId}`);
}

async function ensureDomain(params: {
  domain: string;
  existingDomainId?: number;
}): Promise<PostmarkDomainResponse> {
  if (params.existingDomainId) {
    try {
      const byId = await getDomainDetails(params.existingDomainId);
      if (
        String(byId.Name || "")
          .trim()
          .toLowerCase() === params.domain.toLowerCase()
      ) {
        return byId;
      }
    } catch {
      // fallback to lookup/create flow below
    }
  }

  const foundDomainId = await findDomainByName(params.domain);
  if (foundDomainId) {
    return getDomainDetails(foundDomainId);
  }

  return postmarkAccountRequest<PostmarkDomainResponse>("/domains", {
    method: "POST",
    body: JSON.stringify({
      Name: params.domain,
      ReturnPathDomain: buildReturnPathDomain(params.domain),
    }),
  });
}

async function verifyDomain(domainId: number): Promise<PostmarkDomainResponse> {
  await postmarkAccountRequest(`/domains/${domainId}/verifyDkim`, {
    method: "PUT",
    body: "",
  });

  await postmarkAccountRequest(`/domains/${domainId}/verifyReturnPath`, {
    method: "PUT",
    body: "",
  });

  return getDomainDetails(domainId);
}

function buildManagedStateFromDomain(params: {
  serverId: number;
  serverName: string;
  domain: PostmarkDomainResponse;
  webhookId?: number;
  previous?: PostmarkManagedState | null;
  verificationStatusOverride?: "pending_dns" | "verified" | "error";
  lastError?: string;
}): PostmarkManagedState {
  const dkimHost = String(
    params.domain.DKIMPendingHost || params.domain.DKIMHost || ""
  ).trim();
  const dkimValue = String(
    params.domain.DKIMPendingTextValue || params.domain.DKIMTextValue || ""
  ).trim();
  const returnPathHost = String(params.domain.ReturnPathDomain || "").trim();
  const returnPathValue = String(
    params.domain.ReturnPathDomainCNAMEValue || ""
  ).trim();

  if (!dkimHost || !dkimValue || !returnPathHost || !returnPathValue) {
    throw new Error(
      "Postmark domain DNS values are incomplete. Verify domain configuration in Postmark."
    );
  }

  const dkimVerified = Boolean(params.domain.DKIMVerified);
  const returnPathVerified = Boolean(params.domain.ReturnPathDomainVerified);
  const inferredStatus: "pending_dns" | "verified" =
    dkimVerified && returnPathVerified ? "verified" : "pending_dns";
  const verificationStatus =
    params.verificationStatusOverride || inferredStatus;

  return {
    serverId: params.serverId,
    serverName: params.serverName,
    domainId: Number(params.domain.ID),
    domain: String(params.domain.Name || "")
      .trim()
      .toLowerCase(),
    dkimVerified,
    returnPathVerified,
    verificationStatus,
    dns: {
      dkimHost,
      dkimValue,
      returnPathHost,
      returnPathValue,
      ...(params.domain.SPFHost
        ? { spfHost: String(params.domain.SPFHost).trim() }
        : {}),
      ...(params.domain.SPFTextValue
        ? { spfValue: String(params.domain.SPFTextValue).trim() }
        : {}),
    },
    ...(params.webhookId ? { webhookId: params.webhookId } : {}),
    lastCheckedAt: new Date().toISOString(),
    ...(params.lastError ? { lastError: params.lastError } : {}),
  };
}

function inferVerificationStatusFromDomain(
  domain: PostmarkDomainResponse
): "pending_dns" | "verified" {
  return Boolean(domain.DKIMVerified) &&
    Boolean(domain.ReturnPathDomainVerified)
    ? "verified"
    : "pending_dns";
}

export async function setupManagedWorkspacePostmark(
  params: SetupManagedPostmarkParams
): Promise<SetupManagedPostmarkResult> {
  const domainName = extractDomainFromEmail(params.defaultFromAddress);
  const existingManagedState = params.existingManagedState || null;

  const server = await ensureWorkspaceServer({
    workspaceId: params.workspaceId,
    existingServerToken: params.existingServerToken,
    existingManagedState,
  });

  const broadcastStream = await ensureBroadcastStream({
    serverToken: server.serverToken,
    streamId: DEFAULT_BROADCAST_STREAM_ID,
  });

  const webhookId = await ensureOutboundWebhook({
    serverToken: server.serverToken,
    webhookUrl: params.webhookUrl,
    messageStream: broadcastStream,
  });

  const ensuredDomain = await ensureDomain({
    domain: domainName,
    existingDomainId:
      existingManagedState?.domain === domainName
        ? existingManagedState.domainId
        : undefined,
  });

  let managedState: PostmarkManagedState;
  try {
    const verifiedDomain = await verifyDomain(ensuredDomain.ID);
    managedState = buildManagedStateFromDomain({
      serverId: server.serverId,
      serverName: server.serverName,
      domain: verifiedDomain,
      webhookId,
      previous: existingManagedState,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to verify Postmark domain";

    const latestDomain = await getDomainDetails(ensuredDomain.ID).catch(
      () => ensuredDomain
    );

    managedState = buildManagedStateFromDomain({
      serverId: server.serverId,
      serverName: server.serverName,
      domain: latestDomain,
      webhookId,
      previous: existingManagedState,
      verificationStatusOverride:
        inferVerificationStatusFromDomain(latestDomain),
      lastError: errorMessage,
    });
  }

  return {
    serverToken: server.serverToken,
    transactionalStream: DEFAULT_TRANSACTIONAL_STREAM_ID,
    broadcastStream,
    managedState,
  };
}

export async function verifyManagedWorkspaceDomain(
  params: VerifyManagedDomainParams
): Promise<PostmarkManagedState> {
  const state = params.managedState;

  try {
    const verifiedDomain = await verifyDomain(state.domainId);
    return buildManagedStateFromDomain({
      serverId: state.serverId,
      serverName: state.serverName,
      domain: verifiedDomain,
      webhookId: state.webhookId,
      previous: state,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Failed to verify Postmark domain";
    const latestDomain = await getDomainDetails(state.domainId).catch(
      () => null
    );
    if (!latestDomain) {
      return {
        ...state,
        verificationStatus: "error",
        lastCheckedAt: new Date().toISOString(),
        lastError: errorMessage,
      };
    }

    return buildManagedStateFromDomain({
      serverId: state.serverId,
      serverName: state.serverName,
      domain: latestDomain,
      webhookId: state.webhookId,
      previous: state,
      verificationStatusOverride:
        inferVerificationStatusFromDomain(latestDomain),
      lastError: errorMessage,
    });
  }
}
