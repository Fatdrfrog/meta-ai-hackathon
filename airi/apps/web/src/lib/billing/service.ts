import "server-only";

import { randomUUID } from "node:crypto";

import { readNonEmptyString, asRecord } from "@icecore/shared/lib/value-utils";

import { decryptString, type EncryptedString } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startBillingSubscriptionWorkflow } from "@/lib/temporal/billing-subscription";
import {
  getHalykPayloadInvoiceId,
  normalizeHalykPaymentStatus,
  verifyHalykTransactionStatus,
  type HalykPostLinkPayload,
  type HalykSavedCardChargeResponse,
} from "./halyk-client";
import {
  createHalykClient,
  getAppBaseUrl,
  getHalykBillingConfig,
  getPaddleBillingConfig,
} from "./config";
import {
  createHalykEventKey,
  hashHalykCardId,
  verifyHalykSecretHash,
} from "./halyk-security";
import {
  cancelPaddleSubscriptionById,
  clearPaddleScheduledChange,
  createPaddleTransaction,
  type PaddleSubscription,
  type PaddleTransaction,
} from "./paddle-client";

export const HALYK_BILLING_PROVIDER = "halyk_epay";
export const PADDLE_BILLING_PROVIDER = "paddle";
export type BillingCycle = "monthly" | "annual";

type BillingPublicClient = Pick<typeof supabaseAdmin, "from">;

type PriceRow = {
  id: string;
  unit_amount: number | null;
  currency: string | null;
  interval: string | null;
  display_amount?: number | null;
  display_currency?: string | null;
  provider?: string | null;
  active?: boolean | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
};

type CheckoutSessionRow = {
  id: string;
  company_id: string;
  workspace_id: string;
  user_id: string;
  price_id: string;
  provider_invoice_id: string;
  secret_hash_hash: string;
  status: string;
  payment_method_id?: string | null;
  billing_invoice_id?: string | null;
  subscription_id?: string | null;
};

type PaymentMethodRow = {
  id: string;
  company_id: string;
  card_id_encrypted: EncryptedString;
  card_mask?: string | null;
  card_type?: string | null;
  issuer?: string | null;
  status: string;
};

type SubscriptionRow = {
  id: string;
  company_id: string;
  user_id: string;
  status: string | null;
  price_id: string | null;
  payment_method_id?: string | null;
  current_period_start: string;
  current_period_end: string;
  next_charge_at?: string | null;
  cancel_at_period_end?: boolean | null;
  failed_payment_count?: number | null;
  metadata?: Record<string, unknown> | null;
};

type ChargeInvoiceRow = {
  id: string;
  status: string;
  attempt_count: number;
  charge_state: "ready" | "pending" | "failed" | "paid";
  charge_payment_method_id?: string | null;
  provider_invoice_id: string;
  amount: number;
  currency: string;
  period_start: string;
  period_end: string;
};

type PaymentMethodSummary = {
  id: string;
  card_mask?: string | null;
  card_type?: string | null;
  issuer?: string | null;
  status?: string | null;
};

function addPlanInterval(
  date: Date,
  interval: string | null | undefined
): Date {
  const next = new Date(date);
  if (interval === "year") {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next;
  }

  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

function normalizeAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? Math.trunc(amount) : 0;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function getHalykPostLink(): string {
  return `${getAppBaseUrl()}/api/billing/halyk/postlink`;
}

function normalizeBillingCycle(value: unknown): BillingCycle {
  return value === "annual" ? "annual" : "monthly";
}

function getBillingCycleInterval(billingCycle: BillingCycle): "month" | "year" {
  return billingCycle === "annual" ? "year" : "month";
}

function getBillingReturnUrl(workspaceId: string, sessionId?: string): string {
  const url = new URL(
    `${getAppBaseUrl()}/panel/w/${workspaceId}/settings/billing`
  );
  if (sessionId) url.searchParams.set("checkout", sessionId);
  return url.toString();
}

export async function getActiveHalykProPrice(
  supabase: BillingPublicClient = supabaseAdmin,
  billingCycle: BillingCycle = "monthly"
): Promise<PriceRow | null> {
  const { data, error } = await supabase
    .from("prices")
    .select(
      "id, unit_amount, currency, interval, display_amount, display_currency, provider, active, description, metadata"
    )
    .eq("provider", HALYK_BILLING_PROVIDER)
    .eq("active", true)
    .eq("currency", "KZT")
    .eq("interval", getBillingCycleInterval(billingCycle))
    .contains("metadata", {
      plan: "pro",
      billing_cycle: billingCycle,
    })
    .order("unit_amount", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as PriceRow | null) ?? null;
}

export async function getActivePaddleProPrice(
  supabase: BillingPublicClient = supabaseAdmin,
  billingCycle: BillingCycle = "monthly"
): Promise<PriceRow | null> {
  const { data, error } = await supabase
    .from("prices")
    .select(
      "id, unit_amount, currency, interval, display_amount, display_currency, provider, active, description, metadata"
    )
    .eq("provider", PADDLE_BILLING_PROVIDER)
    .eq("active", true)
    .eq("currency", "USD")
    .eq("interval", getBillingCycleInterval(billingCycle))
    .contains("metadata", {
      plan: "pro",
      billing_cycle: billingCycle,
    })
    .order("unit_amount", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as PriceRow | null) ?? null;
}

function getPaymentMethodSummary(
  paymentMethod: PaymentMethodRow | PaymentMethodSummary
): PaymentMethodSummary {
  return {
    id: paymentMethod.id,
    card_mask: paymentMethod.card_mask || null,
    card_type: paymentMethod.card_type || null,
    issuer: paymentMethod.issuer || null,
    status: paymentMethod.status || null,
  };
}

export async function getBillingSummary(
  supabase: BillingPublicClient,
  companyId: string
) {
  const [config, price] = await Promise.all([
    Promise.resolve(getPaddleBillingConfig()),
    getActivePaddleProPrice(supabase).catch(() => null),
  ]);
  const { data: subscription, error: subscriptionError } = await supabase
    .from("subscriptions")
    .select(
      "id, status, price_id, current_period_start, current_period_end, cancel_at_period_end, next_charge_at, failed_payment_count, dunning_status, metadata"
    )
    .eq("company_id", companyId)
    .eq("provider", PADDLE_BILLING_PROVIDER)
    .order("created", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subscriptionError) throw new Error(subscriptionError.message);
  const { data: invoices, error: invoicesError } = await supabase
    .from("billing_invoices")
    .select(
      "id, status, amount, currency, provider_invoice_id, period_start, period_end, paid_at, failed_at, created_at"
    )
    .eq("company_id", companyId)
    .eq("provider", PADDLE_BILLING_PROVIDER)
    .order("created_at", { ascending: false })
    .limit(12);
  if (invoicesError) throw new Error(invoicesError.message);
  return {
    provider: PADDLE_BILLING_PROVIDER,
    billingConfigured: config.ok && Boolean(price),
    missingConfiguration: config.ok
      ? price
        ? []
        : ["active_paddle_usd_price"]
      : config.missing,
    price,
    subscription,
    invoices: invoices ?? [],
    paymentMethod: subscription?.id
      ? {
          id: String(subscription.id),
          card_mask: "Managed by Paddle",
          card_type: "Paddle Checkout",
          issuer: "Paddle",
          status: subscription.status,
        }
      : null,
  };
}

function getPaddlePriceIdForCycle(
  config: Extract<ReturnType<typeof getPaddleBillingConfig>, { ok: true }>,
  billingCycle: BillingCycle
): string {
  return billingCycle === "annual"
    ? config.annualPriceId
    : config.monthlyPriceId;
}

export async function createPaddleCheckoutSession(params: {
  workspaceId: string;
  companyId: string;
  userId: string;
  billingCycle?: BillingCycle;
}) {
  const config = getPaddleBillingConfig();
  if (!config.ok) {
    return {
      ok: false as const,
      status: 503,
      error: `Paddle is not configured. Missing: ${config.missing.join(", ")}`,
    };
  }

  const billingCycle = normalizeBillingCycle(params.billingCycle);
  const price = await getActivePaddleProPrice(supabaseAdmin, billingCycle);
  if (!price?.id) {
    return {
      ok: false as const,
      status: 409,
      error: `No active Paddle USD Pro ${billingCycle} price is configured.`,
    };
  }

  const paddlePriceId = getPaddlePriceIdForCycle(config, billingCycle);
  const transaction = await createPaddleTransaction({
    apiKey: config.apiKey,
    env: config.env,
    priceId: paddlePriceId,
    checkoutUrl: config.checkoutUrl,
    customData: {
      provider: PADDLE_BILLING_PROVIDER,
      company_id: params.companyId,
      workspace_id: params.workspaceId,
      user_id: params.userId,
      price_id: price.id,
      billing_cycle: billingCycle,
    },
  });

  if (!transaction.id) {
    throw new Error("Paddle did not return a transaction id");
  }

  const { error } = await supabaseAdmin
    .schema("billing_private")
    .from("paddle_checkout_sessions")
    .insert({
      company_id: params.companyId,
      workspace_id: params.workspaceId,
      user_id: params.userId,
      price_id: price.id,
      provider_transaction_id: transaction.id,
      checkout_url: transaction.checkout?.url || null,
      status: transaction.status || "created",
      metadata: {
        provider: PADDLE_BILLING_PROVIDER,
        billing_cycle: billingCycle,
        paddle_price_id: paddlePriceId,
      },
    });

  if (error) {
    throw new Error(error.message);
  }

  return {
    ok: true as const,
    provider: PADDLE_BILLING_PROVIDER,
    transactionId: transaction.id,
    clientToken: config.clientToken,
    environment: config.env,
    checkoutUrl: transaction.checkout?.url || null,
  };
}

async function storeHalykEvent(params: {
  eventType: string;
  invoiceId: string;
  companyId?: string | null;
  checkoutSessionId?: string | null;
  invoiceRowId?: string | null;
  payload: Record<string, unknown>;
}) {
  const payload = params.payload as HalykPostLinkPayload;
  await supabaseAdmin
    .schema("billing_private")
    .from("halyk_events")
    .upsert(
      {
        event_key: createHalykEventKey({
          invoiceId: params.invoiceId,
          providerEventId: payload.id || null,
          reference: payload.reference || payload.intReference || null,
          code: payload.code ?? null,
          reasonCode: payload.reasonCode ?? null,
        }),
        event_type: params.eventType,
        company_id: params.companyId || null,
        checkout_session_id: params.checkoutSessionId || null,
        billing_invoice_id: params.invoiceRowId || null,
        provider_invoice_id: params.invoiceId,
        payload,
      },
      { onConflict: "event_key", ignoreDuplicates: true }
    );
}

async function createOrUpdatePaymentMethod(params: {
  session: CheckoutSessionRow;
  payload: HalykPostLinkPayload;
}): Promise<PaymentMethodRow> {
  const config = getHalykBillingConfig();
  if (!config.ok) throw new Error("Halyk ePay is not configured");

  const cardId = String(
    params.payload.cardId || params.payload.cardID || ""
  ).trim();
  const { encryptedCardId, cardFingerprint } = hashHalykCardId({
    cardId,
    terminalId: config.terminalId,
  });

  const { data, error } = await supabaseAdmin
    .schema("billing_private")
    .from("halyk_payment_methods")
    .upsert(
      {
        company_id: params.session.company_id,
        user_id: params.session.user_id,
        provider: HALYK_BILLING_PROVIDER,
        card_id_encrypted: encryptedCardId,
        card_fingerprint: cardFingerprint,
        card_mask: params.payload.cardMask || null,
        card_type: params.payload.cardType || null,
        issuer: params.payload.issuer || null,
        status: "active",
        deactivated_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "card_fingerprint" }
    )
    .select(
      "id, company_id, card_id_encrypted, card_mask, card_type, issuer, status"
    )
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to store Halyk payment method");
  }

  return data as PaymentMethodRow;
}

async function createChargeInvoice(params: {
  subscriptionId?: string | null;
  checkoutSessionId?: string | null;
  companyId: string;
  userId: string;
  price: PriceRow;
  periodStart: Date;
  periodEnd: Date;
}): Promise<ChargeInvoiceRow> {
  const periodStart = toIso(params.periodStart);
  const periodEnd = toIso(params.periodEnd);

  async function findExistingSubscriptionInvoice() {
    if (!params.subscriptionId) return null;

    const { data, error } = await supabaseAdmin
      .from("billing_invoices")
      .select(
        "id, provider_invoice_id, amount, currency, period_start, period_end, status, attempt_count, charge_state, charge_payment_method_id"
      )
      .eq("subscription_id", params.subscriptionId)
      .eq("period_start", periodStart)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data as ChargeInvoiceRow | null;
  }

  async function findExistingCheckoutInvoice() {
    if (!params.checkoutSessionId) return null;

    const { data, error } = await supabaseAdmin
      .from("billing_invoices")
      .select(
        "id, provider_invoice_id, amount, currency, period_start, period_end, status, attempt_count, charge_state, charge_payment_method_id"
      )
      .eq("checkout_session_id", params.checkoutSessionId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data as ChargeInvoiceRow | null;
  }

  const existingCheckoutInvoice = await findExistingCheckoutInvoice();
  if (existingCheckoutInvoice?.provider_invoice_id) {
    return existingCheckoutInvoice;
  }

  const existing = await findExistingSubscriptionInvoice();
  if (existing?.provider_invoice_id) {
    return existing;
  }

  const { data, error } = await supabaseAdmin
    .from("billing_invoices")
    .insert({
      id: `inv_${randomUUID()}`,
      subscription_id: params.subscriptionId || null,
      checkout_session_id: params.checkoutSessionId || null,
      company_id: params.companyId,
      user_id: params.userId,
      price_id: params.price.id,
      provider: HALYK_BILLING_PROVIDER,
      status: "open",
      amount: normalizeAmount(params.price.unit_amount),
      currency: params.price.currency || "KZT",
      period_start: periodStart,
      period_end: periodEnd,
      attempt_count: 0,
      metadata: {},
    })
    .select(
      "id, provider_invoice_id, amount, currency, period_start, period_end, status, attempt_count, charge_state, charge_payment_method_id"
    )
    .single();

  if (error && (params.subscriptionId || params.checkoutSessionId)) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      const checkoutInvoice = await findExistingCheckoutInvoice();
      if (checkoutInvoice?.provider_invoice_id) return checkoutInvoice;

      const conflicted = await findExistingSubscriptionInvoice();
      if (conflicted?.provider_invoice_id) return conflicted;
    }
  }

  if (error || !data?.provider_invoice_id) {
    throw new Error(error?.message || "Failed to create billing invoice");
  }

  return data as ChargeInvoiceRow;
}

function getExistingCheckoutOutcome(session: CheckoutSessionRow) {
  if (
    session.status === "paid" ||
    session.status === "charging" ||
    session.status === "requires_action" ||
    session.billing_invoice_id ||
    session.subscription_id
  ) {
    return {
      status:
        session.status === "paid" && !session.billing_invoice_id
          ? ("card_updated" as const)
          : (session.status as
              | "paid"
              | "charging"
              | "requires_action"
              | "card_updated"),
      invoiceId: session.billing_invoice_id || null,
      subscriptionId: session.subscription_id || null,
    };
  }

  return null;
}

async function transitionCheckoutSessionToCharging(params: {
  sessionId: string;
  paymentMethodId: string;
}): Promise<CheckoutSessionRow | null> {
  const { data, error } = await supabaseAdmin
    .schema("billing_private")
    .from("halyk_checkout_sessions")
    .update({
      status: "charging",
      payment_method_id: params.paymentMethodId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.sessionId)
    .in("status", ["created", "card_saved"])
    .is("billing_invoice_id", null)
    .select(
      "id, company_id, workspace_id, user_id, price_id, provider_invoice_id, secret_hash_hash, status, payment_method_id, billing_invoice_id, subscription_id"
    )
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as CheckoutSessionRow | null;
}

async function getCheckoutSessionById(
  sessionId: string
): Promise<CheckoutSessionRow | null> {
  const { data, error } = await supabaseAdmin
    .schema("billing_private")
    .from("halyk_checkout_sessions")
    .select(
      "id, company_id, workspace_id, user_id, price_id, provider_invoice_id, secret_hash_hash, status, payment_method_id, billing_invoice_id, subscription_id"
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as CheckoutSessionRow | null;
}

async function updateExistingSubscriptionPaymentMethod(params: {
  session: CheckoutSessionRow;
  paymentMethod: PaymentMethodRow;
}) {
  const { data: subscription, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, metadata, dunning_status, current_period_end")
    .eq("company_id", params.session.company_id)
    .eq("provider", HALYK_BILLING_PROVIDER)
    .in("status", ["active", "past_due", "requires_action", "unpaid"])
    .order("current_period_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (
    !subscription?.id ||
    ["checkout_required", "attempts_exhausted"].includes(
      subscription.dunning_status
    )
  )
    return null;
  const { data: renewal, error: renewalError } = await supabaseAdmin
    .from("billing_invoices")
    .select("attempt_count, charge_state")
    .eq("subscription_id", subscription.id)
    .eq("period_start", subscription.current_period_end)
    .maybeSingle();
  if (renewalError) throw new Error(renewalError.message);
  // A new card cannot reset an exhausted cycle. Unknown attempts stay pinned
  // to the existing subscription for status reconciliation, never a new charge.
  if (renewal?.charge_state === "failed" && renewal.attempt_count >= 4)
    return null;

  const now = new Date().toISOString();
  const metadata = {
    ...asRecord((subscription as { metadata?: unknown }).metadata),
    checkout_session_id: params.session.id,
    payment_method_id: params.paymentMethod.id,
    payment_method: getPaymentMethodSummary(params.paymentMethod),
  };

  const { error: updateError } = await supabaseAdmin
    .from("subscriptions")
    .update({
      payment_method_id: params.paymentMethod.id,
      metadata,
      updated_at: now,
    })
    .eq("id", subscription.id);

  if (updateError) throw new Error(updateError.message);

  const { error: sessionError } = await supabaseAdmin
    .schema("billing_private")
    .from("halyk_checkout_sessions")
    .update({
      status: "paid",
      subscription_id: subscription.id,
      payment_method_id: params.paymentMethod.id,
      updated_at: now,
    })
    .eq("id", params.session.id);

  if (sessionError) throw new Error(sessionError.message);
  await startBillingSubscriptionWorkflow({
    subscriptionId: subscription.id,
    companyId: params.session.company_id,
  });
  return { id: subscription.id as string };
}

type HalykCheckoutOutcome = {
  status: "paid" | "charging" | "requires_action" | "failed";
  invoiceId: string;
  subscriptionId?: string;
  nextChargeAt?: string;
};

async function settleHalykCheckout(
  session: CheckoutSessionRow,
  invoice: ChargeInvoiceRow,
  outcome: string,
  response: Record<string, unknown> = {}
): Promise<HalykCheckoutOutcome> {
  const transaction = asRecord(response.transaction);
  const { data, error } = await supabaseAdmin.rpc("settle_halyk_checkout", {
    p_session_id: session.id,
    p_invoice_id: invoice.id,
    p_outcome: outcome,
    p_response: {
      status: outcome,
      provider_invoice_id: invoice.provider_invoice_id,
      payment_id: readNonEmptyString(transaction.id || response.id),
    },
  });
  if (error) throw new Error(error.message);
  if (
    !data ||
    !["paid", "charging", "requires_action", "failed"].includes(data.status)
  )
    throw new Error("Invalid checkout settlement response");
  const result = data as HalykCheckoutOutcome;
  if (result.status === "paid" && result.subscriptionId)
    await startBillingSubscriptionWorkflow({
      subscriptionId: result.subscriptionId,
      companyId: session.company_id,
      startedAt: result.nextChargeAt,
    });
  return result;
}

async function reconcileHalykCheckoutPayment(
  session: CheckoutSessionRow,
  invoice: ChargeInvoiceRow
): Promise<HalykCheckoutOutcome> {
  const config = getHalykBillingConfig();
  if (!config.ok) return { status: "charging", invoiceId: invoice.id };
  let response: Record<string, unknown> = {};
  let outcome = "pending";
  try {
    response = asRecord(
      await createHalykClient().checkTransactionStatus(
        invoice.provider_invoice_id
      )
    );
    outcome = verifyHalykTransactionStatus(response, {
      invoiceId: invoice.provider_invoice_id,
      amount: invoice.amount,
      currency: invoice.currency,
      terminalId: config.terminalId,
    });
  } catch (error) {
    logger.error("billing.checkout.reconciliation_failed", error, {
      invoiceId: invoice.id,
      companyId: session.company_id,
    });
  }
  return settleHalykCheckout(session, invoice, outcome, response);
}

/** Bounded status lookup only: uncertain first charges are never automatically resubmitted. */
export async function reconcileHalykCheckoutPayments(
  params: { limit?: number; companyId?: string } = {}
): Promise<{ reconciled: number }> {
  const limit = Math.min(100, Math.max(1, Math.floor(params.limit ?? 25)));
  let query = supabaseAdmin
    .schema("billing_private")
    .from("halyk_checkout_sessions")
    .select(
      "id, company_id, status, payment_method_id, billing_invoice_id, subscription_id"
    )
    .in("status", ["charging", "requires_action"])
    .not("billing_invoice_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (params.companyId) query = query.eq("company_id", params.companyId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  let reconciled = 0;
  const deadline = Date.now() + 35_000;
  for (const session of (data ?? []) as CheckoutSessionRow[]) {
    if (Date.now() >= deadline) break;
    const { data: invoice, error: invoiceError } = await supabaseAdmin
      .from("billing_invoices")
      .select(
        "id, company_id, provider_invoice_id, amount, currency, period_start, period_end, status, attempt_count, charge_state"
      )
      .eq("id", session.billing_invoice_id)
      .eq("checkout_session_id", session.id)
      .eq("company_id", session.company_id)
      .eq("provider", HALYK_BILLING_PROVIDER)
      .maybeSingle();
    if (invoiceError) throw new Error(invoiceError.message);
    if (!invoice || invoice.attempt_count < 1) continue;
    await reconcileHalykCheckoutPayment(session, invoice as ChargeInvoiceRow);
    reconciled += 1;
  }
  return { reconciled };
}

async function chargeFirstPeriod(params: {
  session: CheckoutSessionRow;
  paymentMethod: PaymentMethodRow;
  price: PriceRow;
}) {
  const now = new Date();
  let invoice = await createChargeInvoice({
    checkoutSessionId: params.session.id,
    companyId: params.session.company_id,
    userId: params.session.user_id,
    price: params.price,
    periodStart: now,
    periodEnd: addPlanInterval(now, params.price.interval),
  });
  const { data: claim, error } = await supabaseAdmin.rpc(
    "claim_halyk_checkout_charge",
    { p_session_id: params.session.id, p_invoice_id: invoice.id }
  );
  if (error) throw new Error(error.message);
  if (!claim || typeof claim.claimed !== "boolean")
    throw new Error("Invalid checkout charge claim");
  if (claim.blocked)
    return { status: "failed" as const, invoiceId: invoice.id };
  invoice = claim.invoice as ChargeInvoiceRow;
  if (!claim.claimed)
    return reconcileHalykCheckoutPayment(params.session, invoice);
  let response: HalykSavedCardChargeResponse;
  try {
    response = await createHalykClient().chargeSavedCard({
      invoiceId: invoice.provider_invoice_id,
      amount: invoice.amount,
      currency: invoice.currency,
      description: "airi.chat Pro subscription",
      accountId: params.session.company_id,
      cardId: decryptString(params.paymentMethod.card_id_encrypted),
      postLink: getHalykPostLink(),
      failurePostLink: getHalykPostLink(),
      backLink: getBillingReturnUrl(
        params.session.workspace_id,
        params.session.id
      ),
      failureBackLink: getBillingReturnUrl(
        params.session.workspace_id,
        params.session.id
      ),
    });
  } catch {
    return settleHalykCheckout(params.session, invoice, "pending");
  }
  if (normalizeHalykPaymentStatus(response) === "requires_action")
    return settleHalykCheckout(params.session, invoice, "requires_action");
  // AUTH is only a hold. Even a direct CHARGE response must match an owned status lookup.
  return reconcileHalykCheckoutPayment(params.session, invoice);
}

export async function processHalykPostLink(payload: HalykPostLinkPayload) {
  const invoiceId = getHalykPayloadInvoiceId(payload);
  if (!invoiceId) {
    return { ok: false, status: 400, error: "Invalid Halyk invoice id" };
  }

  const { data: session } = await supabaseAdmin
    .schema("billing_private")
    .from("halyk_checkout_sessions")
    .select(
      "id, company_id, workspace_id, user_id, price_id, provider_invoice_id, secret_hash_hash, status, payment_method_id, billing_invoice_id, subscription_id"
    )
    .eq("provider_invoice_id", invoiceId)
    .maybeSingle();

  if (!session) {
    return { ok: false, status: 404, error: "Checkout session not found" };
  }

  const checkoutSession = session as CheckoutSessionRow;
  if (
    !verifyHalykSecretHash(
      payload.secret_hash,
      checkoutSession.secret_hash_hash
    )
  ) {
    return { ok: false, status: 401, error: "Invalid Halyk secret hash" };
  }

  await storeHalykEvent({
    eventType: "postlink",
    invoiceId,
    companyId: checkoutSession.company_id,
    checkoutSessionId: checkoutSession.id,
    payload,
  });

  const existingOutcome = getExistingCheckoutOutcome(checkoutSession);
  if (existingOutcome) {
    if (
      ["charging", "requires_action"].includes(checkoutSession.status) &&
      checkoutSession.billing_invoice_id
    ) {
      const { data: invoice, error: invoiceError } = await supabaseAdmin
        .from("billing_invoices")
        .select(
          "id, provider_invoice_id, amount, currency, period_start, period_end, status, attempt_count, charge_state"
        )
        .eq("id", checkoutSession.billing_invoice_id)
        .eq("checkout_session_id", checkoutSession.id)
        .eq("company_id", checkoutSession.company_id)
        .maybeSingle();
      if (invoiceError) throw new Error(invoiceError.message);
      if (invoice && invoice.attempt_count > 0)
        return {
          ok: true,
          ...(await reconcileHalykCheckoutPayment(
            checkoutSession,
            invoice as ChargeInvoiceRow
          )),
        };
    }
    if (existingOutcome.subscriptionId)
      await startBillingSubscriptionWorkflow({
        subscriptionId: existingOutcome.subscriptionId,
        companyId: checkoutSession.company_id,
      });
    return { ok: true, ...existingOutcome };
  }

  const status = normalizeHalykPaymentStatus(payload);
  // Zero-amount card verification can authorize saving a card, never Pro itself.
  const verifiedCard =
    (payload.code === 0 || payload.code === "0" || payload.code === "ok") &&
    ["AUTH", "VERIFIED"].includes(String(payload.status).toUpperCase()) &&
    Boolean(payload.cardId || payload.cardID);
  if (status !== "paid" && !verifiedCard) {
    await supabaseAdmin
      .schema("billing_private")
      .from("halyk_checkout_sessions")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("id", checkoutSession.id);
    return { ok: true, status: "failed" };
  }

  const paymentMethod = await createOrUpdatePaymentMethod({
    session: checkoutSession,
    payload,
  });
  const chargingSession = await transitionCheckoutSessionToCharging({
    sessionId: checkoutSession.id,
    paymentMethodId: paymentMethod.id,
  });
  if (!chargingSession) {
    const latest = await getCheckoutSessionById(checkoutSession.id);
    const latestOutcome = latest ? getExistingCheckoutOutcome(latest) : null;
    return {
      ok: true,
      ...(latestOutcome || { status: "charging" as const }),
    };
  }

  const updatedSubscription = await updateExistingSubscriptionPaymentMethod({
    session: chargingSession,
    paymentMethod,
  });
  if (updatedSubscription) {
    return {
      ok: true,
      status: "card_updated" as const,
      subscriptionId: updatedSubscription.id,
    };
  }

  const { data: price, error } = await supabaseAdmin
    .from("prices")
    .select(
      "id, unit_amount, currency, interval, display_amount, display_currency, provider, active, description"
    )
    .eq("id", checkoutSession.price_id)
    .single();
  if (error || !price) {
    throw new Error(error?.message || "Checkout price not found");
  }

  const result = await chargeFirstPeriod({
    session: chargingSession,
    paymentMethod,
    price: price as PriceRow,
  });
  return { ok: true, ...result };
}

type RenewalResult = {
  status: "paid" | "requires_action" | "unpaid" | "canceled" | "skipped";
  invoiceId?: string | null;
  nextChargeAt?: string | null;
  reason?: string | null;
};

export async function chargeHalykSubscriptionRenewal(params: {
  subscriptionId: string;
  companyId: string;
  attempt: number;
  finalAttempt: boolean;
  retryDelayMs?: number | null;
}): Promise<RenewalResult> {
  const { data: subscription, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, company_id, user_id, status, price_id, payment_method_id, current_period_start, current_period_end, next_charge_at, cancel_at_period_end, failed_payment_count, metadata, grace_ends_at"
    )
    .eq("id", params.subscriptionId)
    .eq("company_id", params.companyId)
    .eq("provider", HALYK_BILLING_PROVIDER)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!subscription)
    return { status: "canceled", reason: "subscription_not_found" };
  const sub = subscription as SubscriptionRow;
  const now = new Date();
  if (sub.status === "canceled")
    return { status: "canceled", reason: "subscription_inactive" };
  if (new Date(sub.current_period_end) > now) {
    return {
      status: "skipped",
      nextChargeAt: sub.current_period_end,
      reason: "paid_period_active",
    };
  }
  async function settle(
    outcome: string,
    invoice: ChargeInvoiceRow | null,
    response: Record<string, unknown> = {}
  ): Promise<RenewalResult> {
    const transaction = asRecord(response.transaction);
    const { data, error: settleError } = await supabaseAdmin.rpc(
      "settle_halyk_renewal",
      {
        p_subscription_id: sub.id,
        p_company_id: sub.company_id,
        p_invoice_id: invoice?.id ?? null,
        p_outcome: outcome,
        p_response: {
          status: outcome,
          payment_id: readNonEmptyString(transaction.id || response.id),
          reference: readNonEmptyString(
            transaction.reference || response.reference
          ),
          provider_invoice_id: invoice?.provider_invoice_id ?? null,
        },
        p_final_attempt: (invoice?.attempt_count ?? 0) >= 4,
        p_expected_attempt: invoice?.attempt_count ?? null,
      }
    );
    if (settleError) throw new Error(settleError.message);
    if (
      !data ||
      !["paid", "requires_action", "unpaid", "canceled", "skipped"].includes(
        data.status
      )
    )
      throw new Error("Invalid renewal settlement response");
    return data as RenewalResult;
  }
  if (sub.cancel_at_period_end) return settle("canceled", null);

  const { data: existingInvoice, error: invoiceError } = await supabaseAdmin
    .from("billing_invoices")
    .select(
      "id, provider_invoice_id, amount, currency, period_start, period_end, status, attempt_count, charge_state, charge_payment_method_id"
    )
    .eq("subscription_id", sub.id)
    .eq("period_start", sub.current_period_end)
    .maybeSingle();
  if (invoiceError) throw new Error(invoiceError.message);
  let invoice = existingInvoice as ChargeInvoiceRow | null;
  if (invoice?.status === "paid") return settle("paid", invoice);
  const config = getHalykBillingConfig();
  if (!config.ok)
    return settle("pending", invoice, {
      reason: "billing_provider_unavailable",
    });
  const terminalId = config.terminalId;
  const client = createHalykClient();
  async function reconcile(current: ChargeInvoiceRow) {
    try {
      const response = await client.checkTransactionStatus(
        current.provider_invoice_id
      );
      const status = verifyHalykTransactionStatus(response, {
        invoiceId: current.provider_invoice_id,
        amount: current.amount,
        currency: current.currency,
        terminalId,
      });
      return { status, response: asRecord(response) };
    } catch (lookupError) {
      logger.error("billing.renewal.reconciliation_failed", lookupError, {
        subscriptionId: sub.id,
        invoiceId: current.id,
      });
      return { status: "pending", response: {} };
    }
  }
  if (
    invoice &&
    (invoice.attempt_count > 0 || invoice.charge_state !== "ready")
  ) {
    const checked = await reconcile(invoice);
    const result = await settle(checked.status, invoice, checked.response);
    const sourceReplaced = Boolean(
      sub.payment_method_id &&
        sub.payment_method_id !== invoice.charge_payment_method_id
    );
    if (
      checked.status !== "failed" ||
      invoice.charge_state !== "failed" ||
      invoice.attempt_count >= 4 ||
      (result.status === "unpaid" && !sourceReplaced)
    )
      return result;
    if (sub.next_charge_at && new Date(sub.next_charge_at) > now) return result;
  }
  const { data: price, error: priceError } = await supabaseAdmin
    .from("prices")
    .select("id, unit_amount, currency, interval, provider")
    .eq("id", sub.price_id)
    .maybeSingle();
  if (priceError) throw new Error(priceError.message);
  const { data: method, error: methodError } = await supabaseAdmin
    .schema("billing_private")
    .from("halyk_payment_methods")
    .select("id, company_id, card_id_encrypted, status")
    .eq("id", sub.payment_method_id)
    .eq("company_id", sub.company_id)
    .eq("status", "active")
    .maybeSingle();
  if (methodError) throw new Error(methodError.message);
  if (!price || !method) return settle("billing_source_missing", null);
  invoice ??= await createChargeInvoice({
    subscriptionId: sub.id,
    companyId: sub.company_id,
    userId: sub.user_id,
    price: price as PriceRow,
    periodStart: new Date(sub.current_period_end),
    periodEnd: addPlanInterval(
      new Date(sub.current_period_end),
      (price as PriceRow).interval
    ),
  });
  if (new Date(invoice.period_end) <= now)
    return settle("checkout_required", null);
  const { data: claim, error: claimError } = await supabaseAdmin.rpc(
    "claim_halyk_renewal_charge",
    {
      p_subscription_id: sub.id,
      p_company_id: sub.company_id,
      p_invoice_id: invoice.id,
      p_payment_method_id: method.id,
      p_expected_attempt: invoice.attempt_count,
    }
  );
  if (claimError) throw new Error(claimError.message);
  if (!claim || typeof claim.claimed !== "boolean")
    throw new Error("Invalid renewal claim response");
  if (!claim.claimed)
    return {
      status: "requires_action",
      nextChargeAt: new Date(now.getTime() + 3_600_000).toISOString(),
      reason: "charge_already_claimed",
    };
  invoice = claim.invoice as ChargeInvoiceRow;
  if (
    !invoice?.id ||
    !invoice.provider_invoice_id ||
    !Number.isInteger(invoice.attempt_count)
  )
    throw new Error("Invalid claimed invoice");
  let response: HalykSavedCardChargeResponse = {};
  let outcome = "pending";
  try {
    response = await client.chargeSavedCard({
      invoiceId: invoice.provider_invoice_id,
      amount: invoice.amount,
      currency: invoice.currency,
      description: "airi.chat Pro subscription renewal",
      accountId: sub.company_id,
      cardId: decryptString((method as PaymentMethodRow).card_id_encrypted),
      postLink: getHalykPostLink(),
      failurePostLink: getHalykPostLink(),
      backLink: getAppBaseUrl(),
      failureBackLink: getAppBaseUrl(),
    });
    const directStatus = normalizeHalykPaymentStatus(response);
    if (directStatus === "requires_action") outcome = "requires_action";
    else {
      const checked = await reconcile(invoice);
      outcome = checked.status;
      response = checked.response;
    }
  } catch (chargeError) {
    logger.error("billing.renewal.charge_outcome_unknown", chargeError, {
      subscriptionId: sub.id,
      invoiceId: invoice.id,
    });
  }
  return settle(outcome, invoice, response);
}

async function getPaddleCheckoutSession(transactionId: string) {
  const { data, error } = await supabaseAdmin
    .schema("billing_private")
    .from("paddle_checkout_sessions")
    .select("company_id, workspace_id, user_id, price_id, metadata")
    .eq("provider_transaction_id", transactionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as {
    company_id: string;
    workspace_id: string;
    user_id: string;
    price_id: string;
    metadata?: Record<string, unknown> | null;
  } | null;
}

async function resolvePaddleTransactionContext(transaction: PaddleTransaction) {
  const transactionId = readNonEmptyString(transaction.id);
  const session = transactionId
    ? await getPaddleCheckoutSession(transactionId)
    : null;
  if (session) {
    return {
      companyId: session.company_id,
      workspaceId: session.workspace_id,
      userId: session.user_id,
      priceId: session.price_id,
      billingCycle: normalizeBillingCycle(
        asRecord(session.metadata).billing_cycle
      ),
    };
  }

  // Renewal transactions use the provider subscription's existing server binding.
  // Paddle custom_data can be edited at checkout and never authorizes a company.
  const subscriptionId = readNonEmptyString(transaction.subscription_id);
  const subscription = subscriptionId
    ? await getPaddleSubscriptionBinding(subscriptionId)
    : null;
  if (!subscription?.company_id) {
    throw new Error("Paddle transaction binding unavailable");
  }
  const metadata = asRecord(subscription.metadata);
  return {
    companyId: subscription.company_id,
    workspaceId: readNonEmptyString(metadata.workspace_id),
    userId: subscription.user_id ?? null,
    priceId: subscription.price_id ?? null,
    billingCycle: normalizeBillingCycle(metadata.billing_cycle),
  };
}

async function getPaddleSubscriptionCompanyId(
  subscription: PaddleSubscription
) {
  const binding = await getPaddleSubscriptionBinding(subscription.id);
  return binding?.company_id || null;
}

async function getPaddleSubscriptionBinding(subscriptionId: string) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("company_id, user_id, price_id, metadata")
    .eq("id", subscriptionId)
    .eq("provider", PADDLE_BILLING_PROVIDER)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (
    (data as {
      company_id: string;
      user_id?: string | null;
      price_id?: string | null;
      metadata?: unknown;
    } | null) ?? null
  );
}

function getPaddlePeriodFromTransaction(
  transaction: PaddleTransaction,
  price: PriceRow | null,
  billingCycle: BillingCycle
) {
  const now = new Date();
  const periodStart =
    readNonEmptyString(transaction.billing_period?.starts_at) ||
    now.toISOString();
  const periodEnd =
    readNonEmptyString(transaction.billing_period?.ends_at) ||
    addPlanInterval(
      new Date(periodStart),
      price?.interval || getBillingCycleInterval(billingCycle)
    ).toISOString();

  return { periodStart, periodEnd };
}

function getPaddlePeriodFromSubscription(subscription: PaddleSubscription) {
  const now = new Date();
  const periodStart =
    readNonEmptyString(subscription.current_billing_period?.starts_at) ||
    readNonEmptyString(subscription.started_at) ||
    now.toISOString();
  const periodEnd =
    readNonEmptyString(subscription.current_billing_period?.ends_at) ||
    readNonEmptyString(subscription.next_billed_at) ||
    addPlanInterval(
      new Date(periodStart),
      subscription.billing_cycle?.interval || "month"
    ).toISOString();

  return { periodStart, periodEnd };
}

function getPaddleTransactionAmount(transaction: PaddleTransaction): number {
  return normalizeAmount(
    transaction.details?.totals?.grand_total ||
      transaction.details?.totals?.total
  );
}

function getPaddleCurrency(
  transaction: PaddleTransaction,
  price?: PriceRow | null
): string {
  return (
    readNonEmptyString(transaction.details?.totals?.currency_code) ||
    readNonEmptyString(transaction.currency_code) ||
    price?.currency ||
    "USD"
  );
}

async function storePaddleEvent(params: {
  eventId: string;
  eventType: string;
  companyId?: string | null;
  subscriptionId?: string | null;
  transactionId?: string | null;
  payload: Record<string, unknown>;
}) {
  await supabaseAdmin
    .schema("billing_private")
    .from("paddle_events")
    .upsert(
      {
        event_id: params.eventId,
        event_type: params.eventType,
        company_id: params.companyId || null,
        subscription_id: params.subscriptionId || null,
        provider_transaction_id: params.transactionId || null,
        payload: params.payload,
      },
      { onConflict: "event_id" }
    );
}

async function upsertPaddleSubscription(params: {
  subscriptionId: string;
  companyId: string;
  userId: string | null;
  priceId: string | null;
  status: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  customerId?: string | null;
  scheduledChange?: unknown;
  managementUrls?: unknown;
  eventAt?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const cancelAtPeriodEnd =
    asRecord(params.scheduledChange).action === "cancel";

  const { error } = await supabaseAdmin.rpc("apply_billing_subscription", {
    p_subscription: {
      id: params.subscriptionId,
      user_id: params.userId,
      company_id: params.companyId,
      status: params.status,
      price_id: params.priceId,
      quantity: 1,
      cancel_at_period_end: cancelAtPeriodEnd,
      cancel_at: cancelAtPeriodEnd
        ? readNonEmptyString(asRecord(params.scheduledChange).effective_at)
        : null,
      canceled_at: params.status === "canceled" ? now : null,
      created: now,
      current_period_start: params.periodStart,
      current_period_end: params.periodEnd,
      provider: PADDLE_BILLING_PROVIDER,
      provider_event_at: params.eventAt || null,
      payment_method_id: null,
      next_charge_at: params.status === "canceled" ? null : params.periodEnd,
      last_charge_at: now,
      failed_payment_count: 0,
      dunning_status: params.status === "past_due" ? "paddle_past_due" : null,
      metadata: {
        ...(params.metadata || {}),
        paddle_customer_id: params.customerId || null,
        scheduled_change: params.scheduledChange || null,
        management_urls: params.managementUrls || null,
        currency: params.currency,
      },
      updated_at: now,
    },
  });

  if (error) throw new Error(error.message);
}

async function syncPaddleTransaction(
  transaction: PaddleTransaction,
  eventAt?: string | null
) {
  const transactionId = readNonEmptyString(transaction.id);
  if (!transactionId) {
    return { status: "skipped" as const, reason: "missing_transaction_id" };
  }

  if (
    transaction.status &&
    transaction.status !== "completed" &&
    transaction.status !== "paid"
  ) {
    await supabaseAdmin
      .schema("billing_private")
      .from("paddle_checkout_sessions")
      .update({
        status: transaction.status,
        updated_at: new Date().toISOString(),
      })
      .eq("provider_transaction_id", transactionId);
    return { status: "skipped" as const, reason: "transaction_not_paid" };
  }

  const context = await resolvePaddleTransactionContext(transaction);
  if (!context.companyId) {
    return { status: "skipped" as const, reason: "missing_context" };
  }

  const price = context.priceId
    ? await supabaseAdmin
        .from("prices")
        .select(
          "id, unit_amount, currency, interval, display_amount, display_currency, provider, active, description, metadata"
        )
        .eq("id", context.priceId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          return (data as PriceRow | null) ?? null;
        })
    : null;
  const { periodStart, periodEnd } = getPaddlePeriodFromTransaction(
    transaction,
    price,
    context.billingCycle
  );
  const subscriptionId =
    readNonEmptyString(transaction.subscription_id) ||
    `paddle_${transactionId}`;
  const currency = getPaddleCurrency(transaction, price);
  const invoiceId = `inv_paddle_${transactionId}`;
  const now = new Date().toISOString();

  await upsertPaddleSubscription({
    eventAt,
    subscriptionId,
    companyId: context.companyId,
    userId: context.userId,
    priceId: price?.id || context.priceId,
    status: "active",
    periodStart,
    periodEnd,
    currency,
    customerId: transaction.customer_id || null,
    metadata: {
      latest_transaction_id: transactionId,
      workspace_id: context.workspaceId || null,
      billing_cycle: context.billingCycle,
    },
  });

  await supabaseAdmin.from("billing_invoices").upsert(
    {
      id: invoiceId,
      subscription_id: subscriptionId,
      company_id: context.companyId,
      user_id: context.userId,
      price_id: price?.id || null,
      provider: PADDLE_BILLING_PROVIDER,
      status: "paid",
      amount:
        getPaddleTransactionAmount(transaction) || price?.unit_amount || 0,
      currency,
      period_start: periodStart,
      period_end: periodEnd,
      attempt_count: 1,
      provider_invoice_id: transactionId,
      provider_payment_id: transactionId,
      provider_reference: readNonEmptyString(transaction.customer_id),
      paid_at: now,
      metadata: transaction,
      updated_at: now,
    },
    { onConflict: "id" }
  );

  await supabaseAdmin
    .schema("billing_private")
    .from("paddle_checkout_sessions")
    .update({
      status: "paid",
      subscription_id: subscriptionId,
      billing_invoice_id: invoiceId,
      updated_at: now,
    })
    .eq("provider_transaction_id", transactionId);

  return { status: "paid" as const, subscriptionId, invoiceId };
}

async function syncPaddleSubscription(
  subscription: PaddleSubscription,
  eventAt?: string | null
) {
  const subscriptionId = readNonEmptyString(subscription.id);
  if (!subscriptionId) {
    return { status: "skipped" as const, reason: "missing_subscription_id" };
  }

  let binding = await getPaddleSubscriptionBinding(subscriptionId);
  if (!binding) {
    // subscription.created includes this signed provider relation, allowing it
    // to arrive before transaction.completed without trusting editable custom_data.
    const transactionId = readNonEmptyString(
      asRecord(subscription).transaction_id
    );
    const session = transactionId
      ? await getPaddleCheckoutSession(transactionId)
      : null;
    if (session) {
      binding = {
        company_id: session.company_id,
        user_id: session.user_id,
        price_id: session.price_id,
        metadata: {
          ...asRecord(session.metadata),
          workspace_id: session.workspace_id,
        },
      };
    }
  }
  if (!binding?.company_id) {
    // The existing webhook route returns 500 so Paddle retries a binding race.
    throw new Error("Paddle subscription binding unavailable");
  }
  const { periodStart, periodEnd } =
    getPaddlePeriodFromSubscription(subscription);
  const status = readNonEmptyString(subscription.status) || "active";

  await upsertPaddleSubscription({
    eventAt,
    subscriptionId,
    companyId: binding.company_id,
    userId: binding.user_id || null,
    priceId: binding.price_id || null,
    status,
    periodStart,
    periodEnd,
    currency: readNonEmptyString(subscription.currency_code) || "USD",
    customerId: subscription.customer_id || null,
    scheduledChange: subscription.scheduled_change || null,
    managementUrls: subscription.management_urls || null,
    metadata: {
      ...asRecord(binding.metadata),
      paddle_subscription: subscription,
      billing_cycle: subscription.billing_cycle || null,
    },
  });

  return { status: "synced" as const, subscriptionId };
}

export async function processPaddleWebhook(event: Record<string, unknown>) {
  const eventId = readNonEmptyString(event.event_id || event.id);
  const eventType = readNonEmptyString(event.event_type || event.type);
  const data = asRecord(event.data);

  if (!eventId || !eventType) {
    return { ok: false as const, status: 400, error: "Invalid Paddle event" };
  }

  const transactionId = readNonEmptyString(data.id);
  const subscriptionId = readNonEmptyString(data.subscription_id || data.id);
  let result: {
    status: string;
    reason?: string;
    subscriptionId?: string;
    invoiceId?: string;
  } | null = null;

  if (eventType.startsWith("transaction.")) {
    result = await syncPaddleTransaction(
      data as PaddleTransaction,
      readNonEmptyString(event.occurred_at || data.updated_at)
    );
  } else if (eventType.startsWith("subscription.")) {
    result = await syncPaddleSubscription(
      data as PaddleSubscription,
      readNonEmptyString(event.occurred_at || data.updated_at)
    );
  } else {
    result = { status: "ignored", reason: "unsupported_event_type" };
  }

  const companyId =
    eventType.startsWith("subscription.") && data.id
      ? await getPaddleSubscriptionCompanyId(data as PaddleSubscription).catch(
          () => null
        )
      : null;
  await storePaddleEvent({
    eventId,
    eventType,
    companyId,
    subscriptionId:
      readNonEmptyString(result?.subscriptionId) ||
      (eventType.startsWith("subscription.")
        ? readNonEmptyString(data.id)
        : subscriptionId),
    transactionId: eventType.startsWith("transaction.") ? transactionId : null,
    payload: event,
  });

  return { ok: true as const, result };
}

export async function cancelPaddleSubscription(companyId: string) {
  const config = getPaddleBillingConfig();
  if (!config.ok) {
    throw new Error(
      `Paddle is not configured. Missing: ${config.missing.join(", ")}`
    );
  }

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("company_id", companyId)
    .eq("provider", PADDLE_BILLING_PROVIDER)
    .in("status", ["active", "trialing", "past_due"])
    .order("current_period_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const subscriptionId = (data as { id?: string } | null)?.id;
  if (!subscriptionId) return null;

  const subscription = await cancelPaddleSubscriptionById({
    apiKey: config.apiKey,
    env: config.env,
    subscriptionId,
  });
  await syncPaddleSubscription(subscription, new Date().toISOString());
  return { id: subscription.id, status: subscription.status };
}

export async function reactivatePaddleSubscription(companyId: string) {
  const config = getPaddleBillingConfig();
  if (!config.ok) {
    throw new Error(
      `Paddle is not configured. Missing: ${config.missing.join(", ")}`
    );
  }

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, metadata")
    .eq("company_id", companyId)
    .eq("provider", PADDLE_BILLING_PROVIDER)
    .in("status", ["active", "trialing", "past_due"])
    .order("current_period_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { id?: string; metadata?: unknown } | null;
  const subscriptionId = row?.id;
  if (!subscriptionId) return null;

  const scheduledChange = asRecord(asRecord(row?.metadata).scheduled_change);
  if (scheduledChange.action !== "cancel") return { id: subscriptionId };

  const subscription = await clearPaddleScheduledChange({
    apiKey: config.apiKey,
    env: config.env,
    subscriptionId,
  });
  await syncPaddleSubscription(subscription, new Date().toISOString());
  return { id: subscription.id, status: subscription.status };
}
