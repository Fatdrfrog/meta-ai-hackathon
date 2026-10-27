import "server-only";

import { debugConfiguredMetaAccessToken } from "@/lib/meta/debug-token";
import { evaluateMetaAccessToken } from "@icecore/shared/lib/meta/debug-token";
import { getMissingMetaAdsMcpReadScopes } from "../meta-ads-mcp-readiness";
import {
  callMetaAdsMcpTool,
  closeMetaAdsMcpSession,
  createMetaAdsMcpSession,
  initializeMetaAdsMcpSession,
  listMetaAdsMcpTools,
  MetaAdsMcpClientError,
  MetaAdsMcpToolResultError,
  type MetaAdsMcpSession,
} from "./client";
import { validateMetaAdsMcpToolArguments } from "./tool-argument-validation";

const TEST_TOOL = "ads_get_ad_accounts";
type Stage = "token" | "initialize" | "catalog" | "call";

export type MetaAdsMcpReadTestResult = {
  success: boolean;
  checkedAt: string;
  stage: Stage;
  tool: typeof TEST_TOOL;
  tokenType?: "USER" | "SYSTEM_USER";
  code?: string;
  missingScopes?: string[];
  httpStatus?: number;
  teardownFailed?: boolean;
};

/**
 * Explicit operator test, separate from ambient readiness probes. Makes one
 * reviewed read call; never selects a fallback tool, persists readiness, or
 * returns advertiser data. Success is not proof of Meta App Review approval.
 */
export async function runMetaAdsMcpReadTest(params: {
  accessToken: string;
  appConfig: { appId: string; appSecret: string };
  expectedUserId: string;
}): Promise<MetaAdsMcpReadTestResult> {
  const result: MetaAdsMcpReadTestResult = {
    success: false,
    checkedAt: new Date().toISOString(),
    stage: "token",
    tool: TEST_TOOL,
  };
  let session: MetaAdsMcpSession | undefined;
  const signal = AbortSignal.timeout(60_000);
  try {
    const debug = await debugConfiguredMetaAccessToken(params.accessToken, {
      appConfig: params.appConfig,
      signal,
    });
    if (debug.type === "USER" || debug.type === "SYSTEM_USER") {
      result.tokenType = debug.type;
    }
    if (
      !evaluateMetaAccessToken(debug, { appId: params.appConfig.appId }).valid
    ) {
      return { ...result, code: "invalid_token" };
    }
    const identity = debug.user_id || debug.profile_id;
    const introspectedUserId =
      typeof identity === "string" ? identity.trim().slice(0, 100) : undefined;
    if (
      !params.expectedUserId ||
      introspectedUserId !== params.expectedUserId
    ) {
      return { ...result, code: "identity_mismatch" };
    }
    const missingScopes = getMissingMetaAdsMcpReadScopes(debug.scopes ?? []);
    if (missingScopes.length) {
      return { ...result, code: "missing_permissions", missingScopes };
    }
    result.stage = "initialize";
    session = createMetaAdsMcpSession(params.accessToken);
    await initializeMetaAdsMcpSession(session, { signal });
    result.stage = "catalog";
    const catalog = await listMetaAdsMcpTools(session, { signal });
    const tool = catalog.tools.find(candidate => candidate.name === TEST_TOOL);
    if (!tool) {
      result.code = "read_tool_unavailable";
      return result;
    }
    const args = {};
    if (!validateMetaAdsMcpToolArguments({ tool, arguments: args }).success) {
      result.code = "unsupported_read_schema";
      return result;
    }
    result.stage = "call";
    await callMetaAdsMcpTool({
      session,
      tool,
      arguments: args,
      sideEffect: "read",
      signal,
    });
    result.success = true;
    return result;
  } catch (error) {
    // Never serialize provider messages, tool content, credentials or URLs.
    result.code =
      error instanceof MetaAdsMcpToolResultError
        ? "provider_tool_error"
        : error instanceof MetaAdsMcpClientError
          ? error.code
          : "request_failed";
    if (error instanceof MetaAdsMcpClientError && error.status) {
      result.httpStatus = error.status;
    }
    return result;
  } finally {
    if (session) {
      try {
        await closeMetaAdsMcpSession(session);
      } catch {
        result.teardownFailed = true;
      }
    }
  }
}
