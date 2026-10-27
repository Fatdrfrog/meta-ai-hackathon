import "server-only";

import { isDisallowedLocalHostname } from "@icecore/shared/lib/network-safety";

import {
  parseCanonicalAppUrl,
  readConfiguredEnvValue,
} from "@/lib/config/app-url";

export const TIKTOK_CALLBACK_PATH = "/api/internal/tiktok/callback";

const PRODUCTION_REDIRECT_URI = `https://www.airi.chat${TIKTOK_CALLBACK_PATH}`;
const TIKTOK_AUTHORIZATION_URL = "https://ads.tiktok.com/marketing_api/auth";
const ADVERTISER_ID_PATTERN = /^[0-9]{1,128}$/;

export type TikTokOAuthConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  canonicalOrigin: string;
  preferredAdvertiserId: string | null;
};

type TikTokOAuthConfigReason =
  | "missing_app_id"
  | "missing_app_secret"
  | "missing_redirect"
  | "invalid_redirect"
  | "invalid_advertiser_id";

function isAllowedRedirect(
  url: URL,
  input: {
    nodeEnv: string;
    wasExplicit: boolean;
  }
): boolean {
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== TIKTOK_CALLBACK_PATH
  ) {
    return false;
  }

  if (input.nodeEnv === "production") {
    return (
      url.href === PRODUCTION_REDIRECT_URI &&
      url.protocol === "https:" &&
      !isDisallowedLocalHostname(url.hostname)
    );
  }

  if (url.protocol === "https:") {
    return !isDisallowedLocalHostname(url.hostname);
  }

  return (
    input.wasExplicit &&
    url.protocol === "http:" &&
    url.hostname === "localhost"
  );
}

function resolveRedirect(
  env: NodeJS.ProcessEnv
): { redirectUri: string; canonicalOrigin: string } | null | "missing" {
  const explicitRedirect = readConfiguredEnvValue(
    env.TIKTOK_BUSINESS_REDIRECT_URI
  );
  const configuredAppUrlValue = readConfiguredEnvValue(env.NEXT_PUBLIC_APP_URL);
  const configuredAppUrl = configuredAppUrlValue
    ? parseCanonicalAppUrl(configuredAppUrlValue)
    : null;
  if (configuredAppUrlValue && !configuredAppUrl) return null;

  if (!explicitRedirect && !configuredAppUrl) return "missing";

  let redirect: URL;
  try {
    redirect = explicitRedirect
      ? new URL(explicitRedirect)
      : new URL(TIKTOK_CALLBACK_PATH, configuredAppUrl!);
  } catch {
    return null;
  }

  if (
    !isAllowedRedirect(redirect, {
      nodeEnv: readConfiguredEnvValue(env.NODE_ENV) || "production",
      wasExplicit: Boolean(explicitRedirect),
    })
  ) {
    return null;
  }

  return {
    redirectUri: redirect.href,
    canonicalOrigin: redirect.origin,
  };
}

export function resolveTikTokOAuthConfig(
  env: NodeJS.ProcessEnv = process.env
):
  | { status: "configured"; config: TikTokOAuthConfig }
  | { status: "server_unconfigured"; reason: TikTokOAuthConfigReason } {
  const appId = readConfiguredEnvValue(env.TIKTOK_BUSINESS_APP_ID);
  if (!appId) {
    return { status: "server_unconfigured", reason: "missing_app_id" };
  }

  const appSecret = readConfiguredEnvValue(env.TIKTOK_BUSINESS_APP_SECRET);
  if (!appSecret) {
    return { status: "server_unconfigured", reason: "missing_app_secret" };
  }

  const redirect = resolveRedirect(env);
  if (redirect === "missing") {
    return { status: "server_unconfigured", reason: "missing_redirect" };
  }
  if (!redirect) {
    return { status: "server_unconfigured", reason: "invalid_redirect" };
  }

  const preferredAdvertiserId = readConfiguredEnvValue(
    env.TIKTOK_DISCOVERY_ADVERTISER_ID
  );
  if (
    preferredAdvertiserId &&
    !ADVERTISER_ID_PATTERN.test(preferredAdvertiserId)
  ) {
    return {
      status: "server_unconfigured",
      reason: "invalid_advertiser_id",
    };
  }

  return {
    status: "configured",
    config: {
      appId,
      appSecret,
      redirectUri: redirect.redirectUri,
      canonicalOrigin: redirect.canonicalOrigin,
      preferredAdvertiserId: preferredAdvertiserId || null,
    },
  };
}

export function resolveTikTokDiscoveryAppIdentity(
  env: NodeJS.ProcessEnv = process.env
): { status: "configured"; appId: string } | { status: "server_unconfigured" } {
  const appId = readConfiguredEnvValue(env.TIKTOK_BUSINESS_APP_ID);
  return appId
    ? { status: "configured", appId }
    : { status: "server_unconfigured" };
}

export function buildTikTokAuthorizationUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
}): URL {
  const url = new URL(TIKTOK_AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    app_id: input.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
  }).toString();
  return url;
}
