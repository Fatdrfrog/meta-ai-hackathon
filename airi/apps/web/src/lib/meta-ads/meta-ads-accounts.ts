import { normalizeMetaAdsAdAccounts } from "@/lib/meta-ads/meta-ads-source";
import { normalizeMetaAdsMcpScopes } from "@/lib/meta-ads/meta-ads-mcp-readiness";
import {
  getWhatsAppGraphClient,
  isMetaGraphAuthorizationError,
  MetaGraphPaginationError,
  MetaGraphRequestError,
  normalizeMetaGraphPagingNextUrl,
} from "@icecore/shared/lib/meta/api";
import {
  readNonEmptyStringOrUndefined as normalizeOptionalString,
  asRecord,
} from "@icecore/shared/lib/value-utils";
import type { MetaAdsAdAccount } from "@icecore/shared/types/sources";

const META_AD_ACCOUNT_FIELDS =
  "id,account_id,name,account_status,currency,timezone_name";

function accountFields(grantedScopes?: readonly string[]): string {
  // Business metadata is optional; reporting setup only needs ad-account access.
  return !grantedScopes || grantedScopes.includes("business_management")
    ? `${META_AD_ACCOUNT_FIELDS},business{id,name}`
    : META_AD_ACCOUNT_FIELDS;
}
const DEFAULT_MAX_META_AD_ACCOUNTS = 5;
const DEFAULT_INVENTORY_MAX_PAGES = 10;
const DEFAULT_INVENTORY_MAX_ACCOUNTS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const GRAPH_PAGE_SIZE = 200;

const graphClient = getWhatsAppGraphClient();

export type MetaAdAccountFetchError = {
  phase?: "inventory" | "selected_account";
  status?: number;
  statusText?: string;
  metaError?: string | null;
  authorizationFailure?: boolean;
  error?: Error | unknown;
};

export type MetaAdsAdAccountInventory = {
  accounts: MetaAdsAdAccount[];
  accessibleAdAccountIds: string[];
  truncated: boolean;
  selectedAccount?: MetaAdsAdAccount;
};

function readMetaError(value: unknown): string | undefined {
  const error = asRecord(value).error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, 250) : undefined;
}

function toFetchError(error: unknown): MetaAdAccountFetchError {
  if (error instanceof MetaGraphRequestError) {
    return {
      status: error.status,
      statusText: error.statusText,
      metaError: readMetaError(error.details) || null,
      authorizationFailure: isMetaGraphAuthorizationError(error),
    };
  }
  return { error };
}

function positiveBoundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function normalizeAccountId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAccountPage(payload: unknown): {
  data: readonly MetaAdsAdAccount[];
  next?: string;
} {
  const raw = asRecord(payload);
  const paging = asRecord(raw.paging);
  return {
    data: normalizeMetaAdsAdAccounts(raw.data),
    ...(typeof paging.next === "string" ? { next: paging.next } : {}),
  };
}

export function getSelectedMetaAdsAccountId(
  credentials: Record<string, unknown>
): string | undefined {
  return normalizeOptionalString(credentials.selected_ad_account_id);
}

export function orderMetaAdsAccounts(
  accounts: MetaAdsAdAccount[],
  selectedAccountId: string | undefined,
  maxAccounts = DEFAULT_MAX_META_AD_ACCOUNTS
): MetaAdsAdAccount[] {
  const byId = new Map<string, MetaAdsAdAccount>();
  for (const account of accounts) {
    const id = normalizeOptionalString(account.id);
    if (id) byId.set(id.toLowerCase(), { ...account, id });
  }

  if (selectedAccountId && !byId.has(selectedAccountId.toLowerCase())) {
    byId.set(selectedAccountId.toLowerCase(), { id: selectedAccountId });
  }

  const ordered: MetaAdsAdAccount[] = [];
  if (selectedAccountId) {
    const selected = byId.get(selectedAccountId.toLowerCase());
    if (selected) {
      ordered.push(selected);
      byId.delete(selectedAccountId.toLowerCase());
    }
  }
  ordered.push(...byId.values());
  return ordered.slice(0, maxAccounts);
}

export async function fetchMetaAdsAdAccountById(params: {
  accessToken: string;
  adAccountId: string;
  grantedScopes?: readonly string[];
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<MetaAdsAdAccount | null> {
  params.signal?.throwIfAborted();
  const accessToken = normalizeOptionalString(params.accessToken);
  const adAccountId = normalizeOptionalString(params.adAccountId);
  if (!accessToken || !adAccountId) return null;

  const requestTimeoutMs = positiveBoundedInteger(
    params.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  try {
    const payload = await graphClient.getJson<unknown>(
      encodeURIComponent(adAccountId),
      {
        token: accessToken,
        query: { fields: accountFields(params.grantedScopes) },
        signal: params.signal
          ? AbortSignal.any([
              params.signal,
              AbortSignal.timeout(requestTimeoutMs),
            ])
          : AbortSignal.timeout(requestTimeoutMs),
      }
    );
    params.signal?.throwIfAborted();
    return normalizeMetaAdsAdAccounts([payload])[0] || null;
  } catch (error) {
    params.signal?.throwIfAborted();
    if (
      error instanceof MetaGraphRequestError &&
      !isMetaGraphAuthorizationError(error) &&
      [400, 404].includes(error.status)
    ) {
      return null;
    }
    throw error;
  }
}

export async function fetchMetaAdsAdAccountInventory(params: {
  accessToken: string;
  grantedScopes?: readonly string[];
  selectedAdAccountId?: string | null;
  maxPages?: number;
  maxAccounts?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  onError?: (error: MetaAdAccountFetchError) => void;
}): Promise<MetaAdsAdAccountInventory> {
  params.signal?.throwIfAborted();
  const accessToken = normalizeOptionalString(params.accessToken);
  if (!accessToken) {
    return { accounts: [], accessibleAdAccountIds: [], truncated: false };
  }

  const maxPages = positiveBoundedInteger(
    params.maxPages,
    DEFAULT_INVENTORY_MAX_PAGES,
    DEFAULT_INVENTORY_MAX_PAGES
  );
  const maxAccounts = positiveBoundedInteger(
    params.maxAccounts,
    DEFAULT_INVENTORY_MAX_ACCOUNTS,
    DEFAULT_INVENTORY_MAX_ACCOUNTS
  );
  const requestTimeoutMs = positiveBoundedInteger(
    params.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  const selectedAdAccountId = normalizeOptionalString(
    params.selectedAdAccountId
  );

  const collected: MetaAdsAdAccount[] = [];
  const seenNextUrls = new Set<string>();
  let nextPath = "me/adaccounts";
  let pageCount = 0;
  let firstPage = true;
  let truncated = false;
  let inventoryAuthorizationFailed = false;
  try {
    while (pageCount < maxPages && collected.length < maxAccounts) {
      params.signal?.throwIfAborted();
      pageCount += 1;
      const remaining = maxAccounts - collected.length;
      const payload = await graphClient.getJson<unknown>(
        nextPath,
        firstPage
          ? {
              token: accessToken,
              query: {
                fields: accountFields(params.grantedScopes),
                // The extra item is a bounded sentinel when the final page
                // can prove the durable inventory has more than maxAccounts.
                limit: Math.min(GRAPH_PAGE_SIZE, remaining + 1),
              },
              signal: params.signal
                ? AbortSignal.any([
                    params.signal,
                    AbortSignal.timeout(requestTimeoutMs),
                  ])
                : AbortSignal.timeout(requestTimeoutMs),
            }
          : {
              token: accessToken,
              signal: params.signal
                ? AbortSignal.any([
                    params.signal,
                    AbortSignal.timeout(requestTimeoutMs),
                  ])
                : AbortSignal.timeout(requestTimeoutMs),
            }
      );
      params.signal?.throwIfAborted();
      const page = normalizeAccountPage(payload);
      if (page.data.length > remaining) {
        collected.push(...page.data.slice(0, remaining));
        truncated = true;
        break;
      }
      collected.push(...page.data);

      const rawNext = page.next?.trim();
      if (!rawNext) break;
      if (collected.length >= maxAccounts || pageCount >= maxPages) {
        truncated = true;
        break;
      }

      let safeNext: string;
      try {
        safeNext = normalizeMetaGraphPagingNextUrl(rawNext);
      } catch (error) {
        truncated = true;
        throw error;
      }
      if (seenNextUrls.has(safeNext)) {
        truncated = true;
        throw new MetaGraphPaginationError("cycle");
      }
      seenNextUrls.add(safeNext);
      nextPath = safeNext;
      firstPage = false;
    }
  } catch (error) {
    params.signal?.throwIfAborted();
    inventoryAuthorizationFailed = isMetaGraphAuthorizationError(error);
    params.onError?.({ ...toFetchError(error), phase: "inventory" });
  }

  const accounts = collected;
  let selectedAccount = selectedAdAccountId
    ? accounts.find(
        account =>
          normalizeAccountId(account.id) ===
          normalizeAccountId(selectedAdAccountId)
      )
    : undefined;

  if (
    selectedAdAccountId &&
    !selectedAccount &&
    !inventoryAuthorizationFailed
  ) {
    try {
      selectedAccount =
        (await fetchMetaAdsAdAccountById({
          accessToken,
          adAccountId: selectedAdAccountId,
          grantedScopes: params.grantedScopes,
          requestTimeoutMs,
          signal: params.signal,
        })) || undefined;
    } catch (error) {
      params.signal?.throwIfAborted();
      params.onError?.({ ...toFetchError(error), phase: "selected_account" });
    }
  }

  const accessibleAdAccountIds = Array.from(
    new Set(accounts.map(account => account.id))
  );
  if (
    selectedAccount &&
    !accessibleAdAccountIds.some(
      id => normalizeAccountId(id) === normalizeAccountId(selectedAccount.id)
    )
  ) {
    if (accessibleAdAccountIds.length >= maxAccounts) {
      accessibleAdAccountIds.pop();
      truncated = true;
    }
    accessibleAdAccountIds.push(selectedAccount.id);
  }

  return {
    accounts,
    accessibleAdAccountIds,
    truncated,
    ...(selectedAccount ? { selectedAccount } : {}),
  };
}

export async function resolveMetaAdsReportingAccounts(params: {
  rawCredentials: Record<string, unknown>;
  accessToken: string;
  maxAccounts?: number;
  onAccountFetchError?: (error: MetaAdAccountFetchError) => void;
  onTruncated?: () => void;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<MetaAdsAdAccount[]> {
  params.signal?.throwIfAborted();
  const selectedAccountId = getSelectedMetaAdsAccountId(params.rawCredentials);
  const storedAccounts = normalizeMetaAdsAdAccounts(
    params.rawCredentials.ad_accounts
  );
  const orderedStoredAccounts = orderMetaAdsAccounts(
    storedAccounts,
    selectedAccountId,
    params.maxAccounts
  );
  if (orderedStoredAccounts.length > 0) {
    if (
      orderMetaAdsAccounts(
        storedAccounts,
        selectedAccountId,
        Number.MAX_SAFE_INTEGER
      ).length > orderedStoredAccounts.length
    )
      params.onTruncated?.();
    return orderedStoredAccounts;
  }

  const inventory = await fetchMetaAdsAdAccountInventory({
    accessToken: params.accessToken,
    grantedScopes: normalizeMetaAdsMcpScopes(params.rawCredentials.scope),
    selectedAdAccountId: selectedAccountId,
    maxAccounts: params.maxAccounts,
    onError: params.onAccountFetchError,
    requestTimeoutMs: params.requestTimeoutMs,
    signal: params.signal,
  });
  if (inventory.truncated) params.onTruncated?.();
  return orderMetaAdsAccounts(
    inventory.accounts,
    selectedAccountId,
    params.maxAccounts
  );
}
