import "server-only";

import type { TikTokOAuthConfig } from "@/lib/tiktok-discovery/oauth-config";
import type { TikTokAdminOAuthResult } from "@/lib/tiktok-discovery/oauth-result";
import { exchangeTikTokOAuthCode } from "@/lib/tiktok-discovery/oauth-token";
import {
  replaceTikTokPlatformCredentialAndPublish,
  type TikTokCredentialReplacePublication,
} from "@/lib/tiktok-discovery/platform-credential-coordinate";

export type TikTokPlatformOAuthCompletion = {
  result: TikTokAdminOAuthResult;
  advertiserCount: number | null;
  selectedAdvertiserPresent: boolean;
  providerRequestId: string | null;
};

function selectAdvertiser(
  advertiserIds: string[],
  preferredAdvertiserId: string | null
):
  | { result: "selected"; advertiserId: string }
  | {
      result: "advertiser_selection_required" | "advertiser_not_authorized";
    } {
  if (preferredAdvertiserId) {
    return advertiserIds.includes(preferredAdvertiserId)
      ? { result: "selected", advertiserId: preferredAdvertiserId }
      : { result: "advertiser_not_authorized" };
  }
  if (advertiserIds.length === 1) {
    return { result: "selected", advertiserId: advertiserIds[0] };
  }
  return advertiserIds.length === 0
    ? { result: "advertiser_not_authorized" }
    : { result: "advertiser_selection_required" };
}

export async function completeTikTokPlatformOAuth(input: {
  authCode: string;
  adminUserId: string;
  config: TikTokOAuthConfig;
}): Promise<TikTokPlatformOAuthCompletion> {
  let token: Awaited<ReturnType<typeof exchangeTikTokOAuthCode>>;
  try {
    token = await exchangeTikTokOAuthCode({
      appId: input.config.appId,
      appSecret: input.config.appSecret,
      authCode: input.authCode,
    });
  } catch {
    return {
      result: "token_exchange_failed",
      advertiserCount: null,
      selectedAdvertiserPresent: false,
      providerRequestId: null,
    };
  }

  const selection = selectAdvertiser(
    token.advertiserIds,
    input.config.preferredAdvertiserId
  );
  if (selection.result !== "selected") {
    return {
      result: selection.result,
      advertiserCount: token.advertiserIds.length,
      selectedAdvertiserPresent: false,
      providerRequestId: token.requestId,
    };
  }

  let publication: TikTokCredentialReplacePublication;
  try {
    publication = await replaceTikTokPlatformCredentialAndPublish({
      accessToken: token.accessToken,
      selectedAdvertiserId: selection.advertiserId,
      authorizedAdvertiserCount: token.advertiserIds.length,
      grantedScopes: token.grantedScopes,
      connectedByUserId: input.adminUserId,
    });
  } catch {
    return {
      result: "save_failed",
      advertiserCount: token.advertiserIds.length,
      selectedAdvertiserPresent: true,
      providerRequestId: token.requestId,
    };
  }

  if (publication.status !== "published") {
    return {
      result: "coordination_unavailable",
      advertiserCount: token.advertiserIds.length,
      selectedAdvertiserPresent: true,
      providerRequestId: token.requestId,
    };
  }

  return {
    result: "connected",
    advertiserCount: token.advertiserIds.length,
    selectedAdvertiserPresent: true,
    providerRequestId: token.requestId,
  };
}
