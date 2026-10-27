import { createHmac, timingSafeEqual } from "node:crypto";
import { asRecord } from "@icecore/shared/lib/value-utils";

export type PaddleEnvironment = "sandbox" | "production";

export type PaddleTransaction = {
  id: string;
  status?: string | null;
  subscription_id?: string | null;
  customer_id?: string | null;
  currency_code?: string | null;
  custom_data?: Record<string, unknown> | null;
  billing_period?: {
    starts_at?: string | null;
    ends_at?: string | null;
  } | null;
  checkout?: {
    url?: string | null;
  } | null;
  details?: {
    totals?: {
      total?: string | null;
      grand_total?: string | null;
      currency_code?: string | null;
    } | null;
  } | null;
};

export type PaddleSubscription = {
  id: string;
  status?: string | null;
  customer_id?: string | null;
  currency_code?: string | null;
  started_at?: string | null;
  first_billed_at?: string | null;
  next_billed_at?: string | null;
  canceled_at?: string | null;
  current_billing_period?: {
    starts_at?: string | null;
    ends_at?: string | null;
  } | null;
  scheduled_change?: {
    action?: string | null;
    effective_at?: string | null;
  } | null;
  billing_cycle?: {
    interval?: string | null;
    frequency?: number | null;
  } | null;
  management_urls?: {
    update_payment_method?: string | null;
    cancel?: string | null;
  } | null;
  custom_data?: Record<string, unknown> | null;
};

type PaddleApiResponse<T> = {
  data?: T;
  error?: {
    code?: string;
    detail?: string;
    documentation_url?: string;
  };
};

export function getPaddleApiBaseUrl(env: PaddleEnvironment): string {
  return env === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
}

async function paddleRequest<T>(params: {
  apiKey: string;
  env: PaddleEnvironment;
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
}): Promise<T> {
  const response = await fetch(
    `${getPaddleApiBaseUrl(params.env)}${params.path}`,
    {
      method: params.method,
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as
    | PaddleApiResponse<T>
    | Record<string, unknown>;

  if (!response.ok) {
    const error = asRecord((payload as PaddleApiResponse<T>).error);
    throw new Error(
      String(error.detail || error.code || "Paddle API request failed")
    );
  }

  const data = (payload as PaddleApiResponse<T>).data;
  if (!data) throw new Error("Paddle API response did not include data");
  return data;
}

export async function createPaddleTransaction(params: {
  apiKey: string;
  env: PaddleEnvironment;
  priceId: string;
  customData: Record<string, unknown>;
  checkoutUrl?: string | null;
}): Promise<PaddleTransaction> {
  const body: Record<string, unknown> = {
    collection_mode: "automatic",
    items: [{ price_id: params.priceId, quantity: 1 }],
    custom_data: params.customData,
  };
  if (params.checkoutUrl) {
    body.checkout = { url: params.checkoutUrl };
  }

  return paddleRequest<PaddleTransaction>({
    apiKey: params.apiKey,
    env: params.env,
    path: "/transactions",
    method: "POST",
    body,
  });
}

export async function cancelPaddleSubscriptionById(params: {
  apiKey: string;
  env: PaddleEnvironment;
  subscriptionId: string;
}): Promise<PaddleSubscription> {
  return paddleRequest<PaddleSubscription>({
    apiKey: params.apiKey,
    env: params.env,
    path: `/subscriptions/${encodeURIComponent(params.subscriptionId)}/cancel`,
    method: "POST",
    body: { effective_from: "next_billing_period" },
  });
}

export async function clearPaddleScheduledChange(params: {
  apiKey: string;
  env: PaddleEnvironment;
  subscriptionId: string;
}): Promise<PaddleSubscription> {
  return paddleRequest<PaddleSubscription>({
    apiKey: params.apiKey,
    env: params.env,
    path: `/subscriptions/${encodeURIComponent(params.subscriptionId)}`,
    method: "PATCH",
    body: { scheduled_change: null },
  });
}

function parseSignatureHeader(
  signatureHeader: string | null
): Record<string, string> {
  return String(signatureHeader || "")
    .split(/[;,]/)
    .map(part => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) return acc;
      acc[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
      return acc;
    }, {});
}

export function verifyPaddleWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): boolean {
  const signature = parseSignatureHeader(params.signatureHeader);
  const timestamp = Number(signature.ts);
  const expected = signature.h1;

  if (!Number.isFinite(timestamp) || !expected || !params.secret) {
    return false;
  }

  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  const toleranceSeconds = params.toleranceSeconds ?? 300;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }

  const actual = createHmac("sha256", params.secret)
    .update(`${timestamp}:${params.rawBody}`)
    .digest("hex");

  try {
    const expectedBuffer = Buffer.from(expected, "hex");
    const actualBuffer = Buffer.from(actual, "hex");
    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  } catch {
    return false;
  }
}
