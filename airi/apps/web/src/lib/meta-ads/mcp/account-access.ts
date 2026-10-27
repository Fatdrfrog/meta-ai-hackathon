import "server-only";
import {
  callMetaAdsMcpTool,
  type MetaAdsMcpCatalog,
  type MetaAdsMcpSession,
} from "./client";
import {
  createMetaAdsMcpConversationId,
  withMetaAdsMcpConversationId,
} from "./conversation-id";
import { MetaAdsMcpResultLedger } from "./result-ledger";
import { validateMetaAdsMcpToolArguments } from "./tool-argument-validation";

const ACCOUNT_TOOL = "ads_get_ad_accounts";
const MAX_ACCOUNT_PAGES = 10;
const ACCOUNT_ACCESS_DEADLINE_MS = 20_000;

export type MetaAdsMcpAccountAccess = {
  inventory: unknown;
  complete: boolean;
  reason?: string;
};

/** A bounded provider inventory, independent of Graph access and granted scopes.
 * Reuses the harness ledger's normalization, byte budget and cursor checks. */
export async function readMetaAdsMcpAccountAccess(params: {
  session: MetaAdsMcpSession;
  catalog: MetaAdsMcpCatalog;
  signal?: AbortSignal;
  clientConversationId?: string;
}): Promise<MetaAdsMcpAccountAccess> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(ACCOUNT_ACCESS_DEADLINE_MS),
    ...(params.signal ? [params.signal] : []),
  ]);
  signal.throwIfAborted();
  const tool = params.catalog.tools.find(item => item.name === ACCOUNT_TOOL);
  if (!tool)
    return {
      inventory: [],
      complete: false,
      reason: "account_tool_unavailable",
    };
  const ledger = new MetaAdsMcpResultLedger([tool]);
  const clientConversationId =
    params.clientConversationId ?? createMetaAdsMcpConversationId();
  let args = withMetaAdsMcpConversationId(tool, {}, clientConversationId);
  for (let page = 0; page < MAX_ACCOUNT_PAGES; page += 1) {
    signal.throwIfAborted();
    if (!validateMetaAdsMcpToolArguments({ tool, arguments: args }).success) {
      ledger.markIncomplete("account_schema_changed");
      break;
    }
    const result = await callMetaAdsMcpTool({
      session: params.session,
      tool,
      arguments: args,
      sideEffect: "read",
      signal,
    });
    signal.throwIfAborted();
    ledger.record({ name: ACCOUNT_TOOL, arguments: args, result });
    if (ledger.coverage().reasons.length) break;
    const nextPage = ledger.nextPage();
    if (!nextPage) break;
    args = nextPage.arguments;
    if (page === MAX_ACCOUNT_PAGES - 1)
      ledger.markIncomplete("account_page_limit");
  }
  const evidence = JSON.parse(ledger.toPrompt()) as {
    results: Array<{ data?: unknown }>;
  };
  const coverage = ledger.coverage();
  const reason = coverage.reasons[0];
  return {
    inventory: {
      parts: evidence.results.flatMap(item =>
        item.data === undefined ? [] : [item.data]
      ),
    },
    // Provider suggestions are unrelated to completing the account inventory.
    complete:
      coverage.successfulReads > 0 && !reason && coverage.pendingPages === 0,
    ...(reason ? { reason } : {}),
  };
}
