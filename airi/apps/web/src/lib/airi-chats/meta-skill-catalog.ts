import {
  META_ADS_SOURCE_TYPE,
  toPublicMetaAdsCredentials,
} from "@/lib/meta-ads/meta-ads-source";
import type { MetaAdsMcpReadiness } from "@icecore/shared/types/sources";
import { canRetryMetaAdsMcpReadiness } from "@/lib/meta-ads/meta-ads-mcp-readiness";
import { asRecord } from "@icecore/shared/lib/value-utils";
import {
  AIRI_CHAT_META_SKILL_LABEL,
  buildAiriChatMetaSkillRef,
  buildAiriChatSourceOptionId,
  type AiriChatSourceOption,
  type AiriMetaAdsMcpSkillCapability,
} from "./source-types";

type CatalogSourceRow = {
  id: string;
  type: string;
  name?: string | null;
  credentials?: unknown;
};

function readPublicMetaAdsMcpReadiness(
  credentials: unknown
): MetaAdsMcpReadiness | null {
  const readiness = asRecord(credentials).mcp_readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return null;
  }
  const candidate = readiness as Partial<MetaAdsMcpReadiness>;
  return typeof candidate.state === "string" &&
    typeof candidate.canRead === "boolean" &&
    typeof candidate.canWrite === "boolean"
    ? (candidate as MetaAdsMcpReadiness)
    : null;
}

function disabledCapability(
  readiness: MetaAdsMcpReadiness | null
): Pick<AiriMetaAdsMcpSkillCapability, "descriptionKey" | "recovery"> {
  if (
    readiness?.state === "asset_unavailable" &&
    readiness.provider?.selectedAccountEnabled === false
  ) {
    return { descriptionKey: "accountNotEnabled", recovery: "rollout" };
  }
  switch (readiness?.state) {
    case "checking":
      return { descriptionKey: "checking", recovery: "settings" };
    case "asset_unavailable":
      return { descriptionKey: "selectAccount", recovery: "settings" };
    case "provider_unreachable":
    case "invalid_catalog":
    case "stale":
      return { descriptionKey: "checkAgain", recovery: "settings" };
    case "identity_unverified":
      return { descriptionKey: "verify", recovery: "settings" };
    case "expired":
    case "missing_scopes":
    case "provider_unauthorized":
      return { descriptionKey: "reconnect", recovery: "reconnect" };
    case "not_connected":
      return { descriptionKey: "connect", recovery: "authorize" };
    case "expiry_unknown":
    case "scope_unverified":
    case "ready":
    default:
      return { descriptionKey: "connect", recovery: "settings" };
  }
}

const DESCRIPTION: Record<
  AiriMetaAdsMcpSkillCapability["descriptionKey"],
  string
> = {
  missingSource: "Connect Meta Ads, then enable Ads MCP to use @meta",
  accountNotEnabled:
    "Meta has not enabled AI ad tools for this account yet. Check again later.",
  checking: "Checking Ads MCP before @meta becomes available",
  selectAccount: "Select an Ads MCP-accessible ad account in Settings",
  checkAgain: "Check Ads MCP again in Settings before using @meta",
  verify: "Check Ads MCP again in Settings to verify this connection",
  reconnect: "Reconnect Ads MCP in Settings before using @meta",
  connect: "Connect and verify Ads MCP in Settings to use @meta",
  retry: "Live Meta Ads access will be checked before running",
  management: "Live Meta Ads MCP: reporting and confirmed campaign changes",
  reporting:
    "Live Meta Ads MCP reporting (read-only until access is reverified)",
};

function matchesQuery(
  fields: { label: string; description: string; meta: string },
  query: string
): boolean {
  if (!query) return true;
  const haystack =
    `${fields.label} ${fields.description} ${fields.meta}`.toLowerCase();
  return haystack.includes(query);
}

export function buildMetaAdsSkillCatalogOption(params: {
  channelSources: CatalogSourceRow[];
  query?: string | null;
}): AiriChatSourceOption | null {
  const query = String(params.query ?? "")
    .trim()
    .toLowerCase();
  if (
    query &&
    !matchesQuery(
      {
        label: AIRI_CHAT_META_SKILL_LABEL,
        description: "Meta Ads MCP skill",
        meta: "meta ads mcp skill @meta",
      },
      query
    )
  ) {
    return null;
  }

  const metaAdsSource = params.channelSources.find(
    source => source.type === META_ADS_SOURCE_TYPE
  );
  const ref = buildAiriChatMetaSkillRef();
  if (!metaAdsSource) {
    return {
      id: buildAiriChatSourceOptionId(ref),
      ref,
      group: "Skills",
      label: AIRI_CHAT_META_SKILL_LABEL,
      description: DESCRIPTION.missingSource,
      disabled: true,
      metaAdsMcp: {
        canRead: false,
        canWrite: false,
        retryable: false,
        recovery: "connect",
        descriptionKey: "missingSource",
      },
    };
  }
  const safeCredentials = toPublicMetaAdsCredentials(metaAdsSource.credentials);
  const readiness = readPublicMetaAdsMcpReadiness(safeCredentials);
  if (readiness && canRetryMetaAdsMcpReadiness(readiness)) {
    return {
      id: buildAiriChatSourceOptionId(ref),
      ref,
      group: "Skills",
      label: AIRI_CHAT_META_SKILL_LABEL,
      description: DESCRIPTION.retry,
      disabled: false,
      metaAdsMcp: {
        canRead: readiness.canRead,
        canWrite: readiness.canWrite,
        retryable: true,
        recovery: null,
        descriptionKey: "retry",
      },
    };
  }
  if (!readiness?.canRead) {
    const capability = disabledCapability(readiness);
    return {
      id: buildAiriChatSourceOptionId(ref),
      ref,
      group: "Skills",
      label: AIRI_CHAT_META_SKILL_LABEL,
      description: DESCRIPTION[capability.descriptionKey],
      disabled: true,
      metaAdsMcp: {
        canRead: false,
        canWrite: false,
        retryable: false,
        ...capability,
      },
    };
  }
  return {
    id: buildAiriChatSourceOptionId(ref),
    ref,
    group: "Skills",
    label: AIRI_CHAT_META_SKILL_LABEL,
    description: DESCRIPTION[readiness.canWrite ? "management" : "reporting"],
    disabled: false,
    metaAdsMcp: {
      canRead: true,
      canWrite: readiness.canWrite,
      retryable: false,
      recovery: null,
      descriptionKey: readiness.canWrite ? "management" : "reporting",
    },
  };
}
