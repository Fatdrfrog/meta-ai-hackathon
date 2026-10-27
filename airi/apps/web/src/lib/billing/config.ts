import "server-only";

import {
  HalykEpayClient,
  normalizeHalykEnv,
  type HalykEpayEnv,
} from "./halyk-client";
import { type PaddleEnvironment } from "./paddle-client";
import { readNonEmptyString as normalizeOptionalString } from "@icecore/shared/lib/value-utils";

export const PADDLE_BILLING_ENVIRONMENT = "sandbox" satisfies PaddleEnvironment;
export const PADDLE_CHECKOUT_URL: string | null = null;

export function getAppBaseUrl(): string {
  const explicit = normalizeOptionalString(process.env.NEXT_PUBLIC_APP_URL);
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelUrl = normalizeOptionalString(process.env.VERCEL_URL);
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/+$/, "");

  return "http://localhost:3000";
}

export function getHalykBillingConfig():
  | {
      ok: true;
      env: HalykEpayEnv;
      clientId: string;
      clientSecret: string;
      terminalId: string;
    }
  | {
      ok: false;
      missing: string[];
    } {
  const clientId = normalizeOptionalString(process.env.HALYK_EPAY_CLIENT_ID);
  const clientSecret = normalizeOptionalString(
    process.env.HALYK_EPAY_CLIENT_SECRET
  );
  const terminalId = normalizeOptionalString(
    process.env.HALYK_EPAY_TERMINAL_ID
  );
  const missing = [
    { name: "HALYK_EPAY_CLIENT_ID", value: clientId },
    { name: "HALYK_EPAY_CLIENT_SECRET", value: clientSecret },
    { name: "HALYK_EPAY_TERMINAL_ID", value: terminalId },
  ]
    .filter(entry => !entry.value)
    .map(entry => entry.name);

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    env: normalizeHalykEnv(process.env.HALYK_EPAY_ENV),
    clientId: clientId!,
    clientSecret: clientSecret!,
    terminalId: terminalId!,
  };
}

export function createHalykClient(): HalykEpayClient {
  const config = getHalykBillingConfig();
  if (!config.ok) {
    throw new Error(
      `Halyk ePay is not configured. Missing: ${config.missing.join(", ")}`
    );
  }

  return new HalykEpayClient(config);
}

export function getPaddleBillingConfig():
  | {
      ok: true;
      apiKey: string;
      env: PaddleEnvironment;
      clientToken: string;
      webhookSecret: string;
      monthlyPriceId: string;
      annualPriceId: string;
      checkoutUrl: string | null;
    }
  | {
      ok: false;
      missing: string[];
    } {
  const apiKey = normalizeOptionalString(process.env.PADDLE_API_KEY);
  const clientToken = normalizeOptionalString(
    process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN
  );
  const webhookSecret = normalizeOptionalString(
    process.env.PADDLE_WEBHOOK_SECRET
  );
  const monthlyPriceId = normalizeOptionalString(
    process.env.PADDLE_PRO_MONTHLY_PRICE_ID
  );
  const annualPriceId = normalizeOptionalString(
    process.env.PADDLE_PRO_ANNUAL_PRICE_ID
  );

  const missing = [
    { name: "PADDLE_API_KEY", value: apiKey },
    { name: "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN", value: clientToken },
    { name: "PADDLE_WEBHOOK_SECRET", value: webhookSecret },
    { name: "PADDLE_PRO_MONTHLY_PRICE_ID", value: monthlyPriceId },
    { name: "PADDLE_PRO_ANNUAL_PRICE_ID", value: annualPriceId },
  ]
    .filter(entry => !entry.value)
    .map(entry => entry.name);

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    apiKey: apiKey!,
    env: PADDLE_BILLING_ENVIRONMENT,
    clientToken: clientToken!,
    webhookSecret: webhookSecret!,
    monthlyPriceId: monthlyPriceId!,
    annualPriceId: annualPriceId!,
    checkoutUrl: PADDLE_CHECKOUT_URL,
  };
}

export function getPaddleBillingUnavailableMessage(): string | null {
  const config = getPaddleBillingConfig();
  if (config.ok) return null;

  return `Paddle is not configured. Missing: ${config.missing.join(", ")}`;
}
