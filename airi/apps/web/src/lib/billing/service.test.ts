jest.mock("@/lib/crypto", () => ({
  decryptString: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn() },
}));
jest.mock("@/lib/temporal/billing-subscription", () => ({
  startBillingSubscriptionWorkflow: jest.fn(),
}));

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    schema: jest.fn(),
    rpc: jest.fn(),
  },
}));

jest.mock("./config", () => ({
  createHalykClient: jest.fn(),
  getAppBaseUrl: () => "https://airi.chat",
  getHalykBillingConfig: () => ({
    ok: true,
    terminalId: "terminal-1",
  }),
  getPaddleBillingConfig: () => ({ ok: true }),
}));

jest.mock("./halyk-client", () => ({
  ...jest.requireActual("./halyk-client"),
  getHalykPayloadInvoiceId: jest.fn(),
  isValidHalykInvoiceId: jest.fn(),
  normalizeHalykPaymentStatus: jest.fn(),
}));

jest.mock("./halyk-security", () => ({
  createHalykEventKey: jest.fn(),
  createHalykSecretHash: jest.fn(),
  hashHalykCardId: jest.fn(),
  verifyHalykSecretHash: jest.fn(),
}));

import {
  chargeHalykSubscriptionRenewal,
  getActiveHalykProPrice,
  getActivePaddleProPrice,
  getBillingSummary,
  processHalykPostLink,
  processPaddleWebhook,
} from "./service";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  normalizeHalykPaymentStatus,
  getHalykPayloadInvoiceId,
} from "./halyk-client";
import { hashHalykCardId, verifyHalykSecretHash } from "./halyk-security";
import { createHalykClient } from "./config";
import { startBillingSubscriptionWorkflow } from "@/lib/temporal/billing-subscription";
import { createSupabaseQueryMock } from "@/test-support/supabase-query-test-utils";

const createPriceQuery = (data: unknown) =>
  createSupabaseQueryMock({ data, error: null });

describe("Halyk billing price selection", () => {
  it("selects the active monthly Pro price by provider, interval, and metadata", async () => {
    const price = { id: "price_monthly", unit_amount: 59000 };
    const query = createPriceQuery(price);
    const supabase = { from: jest.fn(() => query) };

    await expect(
      getActiveHalykProPrice(supabase as never, "monthly")
    ).resolves.toBe(price);

    expect(supabase.from).toHaveBeenCalledWith("prices");
    expect(query.eq).toHaveBeenCalledWith("provider", "halyk_epay");
    expect(query.eq).toHaveBeenCalledWith("active", true);
    expect(query.eq).toHaveBeenCalledWith("currency", "KZT");
    expect(query.eq).toHaveBeenCalledWith("interval", "month");
    expect(query.contains).toHaveBeenCalledWith("metadata", {
      plan: "pro",
      billing_cycle: "monthly",
    });
  });

  it("selects the annual Pro price when annual billing is requested", async () => {
    const price = { id: "price_annual", unit_amount: 480000 };
    const query = createPriceQuery(price);
    const supabase = { from: jest.fn(() => query) };

    await expect(
      getActiveHalykProPrice(supabase as never, "annual")
    ).resolves.toBe(price);

    expect(query.eq).toHaveBeenCalledWith("interval", "year");
    expect(query.contains).toHaveBeenCalledWith("metadata", {
      plan: "pro",
      billing_cycle: "annual",
    });
  });
});

describe("Paddle billing price selection", () => {
  it("selects the active monthly Pro price by Paddle provider, interval, and metadata", async () => {
    const price = { id: "price_paddle_monthly", unit_amount: 10600 };
    const query = createPriceQuery(price);
    const supabase = { from: jest.fn(() => query) };

    await expect(
      getActivePaddleProPrice(supabase as never, "monthly")
    ).resolves.toBe(price);

    expect(supabase.from).toHaveBeenCalledWith("prices");
    expect(query.eq).toHaveBeenCalledWith("provider", "paddle");
    expect(query.eq).toHaveBeenCalledWith("active", true);
    expect(query.eq).toHaveBeenCalledWith("currency", "USD");
    expect(query.eq).toHaveBeenCalledWith("interval", "month");
    expect(query.contains).toHaveBeenCalledWith("metadata", {
      plan: "pro",
      billing_cycle: "monthly",
    });
  });

  it("selects the annual Pro price when annual Paddle billing is requested", async () => {
    const price = { id: "price_paddle_annual", unit_amount: 86400 };
    const query = createPriceQuery(price);
    const supabase = { from: jest.fn(() => query) };

    await expect(
      getActivePaddleProPrice(supabase as never, "annual")
    ).resolves.toBe(price);

    expect(query.eq).toHaveBeenCalledWith("interval", "year");
    expect(query.contains).toHaveBeenCalledWith("metadata", {
      plan: "pro",
      billing_cycle: "annual",
    });
  });
});

describe("billing summary read failures", () => {
  it.each(["subscriptions", "billing_invoices"])(
    "does not report empty billing after a failed %s read",
    async failedTable => {
      const supabase = {
        from: jest.fn((table: string) => {
          const result = {
            data: null,
            error:
              table === failedTable ? { message: "read unavailable" } : null,
          };
          const query: Record<string, unknown> = {
            select: jest.fn(() => query),
            eq: jest.fn(() => query),
            contains: jest.fn(() => query),
            order: jest.fn(() => query),
            limit: jest.fn(() => query),
            maybeSingle: jest.fn(async () => result),
            then: (resolve: (value: typeof result) => void) =>
              Promise.resolve(result).then(resolve),
          };
          return query;
        }),
      };
      await expect(
        getBillingSummary(supabase as never, "company-1")
      ).rejects.toThrow("read unavailable");
    }
  );
});

type BillingFixtureRow = Record<string, unknown>;

function createBillingLedger(
  initial: Record<string, BillingFixtureRow[]> = {}
) {
  const rows: Record<string, BillingFixtureRow[]> = {
    companies: [
      { id: "company-owner", subscription_type: "free" },
      { id: "company-foreign", subscription_type: "pro" },
    ],
    prices: [
      {
        id: "price-owner",
        unit_amount: 10600,
        currency: "USD",
        interval: "month",
      },
    ],
    subscriptions: [],
    ...initial,
  };
  const writes: Array<{ table: string; values: BillingFixtureRow }> = [];
  const errors: Record<string, { message: string }> = {};
  const from = (table: string) => {
    const filters = new Map<string, unknown>();
    let operation: "read" | "update" | "upsert" = "read";
    let values: BillingFixtureRow = {};
    const execute = (single = true) => {
      if (errors[table]) return { data: null, error: errors[table] };
      const matches = (row: BillingFixtureRow) =>
        [...filters].every(([key, value]) =>
          Array.isArray(value)
            ? value.includes(row[key])
            : (row[key] ?? null) === value
        );
      const tableRows = (rows[table] ??= []);
      const matchedBefore = tableRows.filter(matches);
      if (operation !== "read") {
        writes.push({ table, values: { ...values } });
        if (operation === "update") {
          tableRows.filter(matches).forEach(row => Object.assign(row, values));
        } else {
          const identity = values.id ?? values.event_id ?? values.event_key;
          const existing = tableRows.find(
            row =>
              identity !== undefined &&
              (row.id ?? row.event_id ?? row.event_key) === identity
          );
          if (existing) Object.assign(existing, values);
          else
            tableRows.push({
              id:
                table === "billing_private.halyk_payment_methods"
                  ? "method-new"
                  : table === "billing_invoices"
                    ? "inv-new"
                    : undefined,
              ...(table === "billing_invoices"
                ? {
                    provider_invoice_id: "654321",
                    status: "open",
                    attempt_count: 0,
                    charge_state: "ready",
                  }
                : {}),
              ...values,
            });
        }
      }
      return {
        data: single
          ? ((operation === "update"
              ? matchedBefore[0]
              : tableRows.find(matches)) ?? null)
          : tableRows.filter(matches),
        error: null,
      };
    };
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: jest.fn(() => query),
      order: jest.fn(() => query),
      limit: jest.fn(() => query),
      in: jest.fn((key: string, value: unknown[]) => {
        filters.set(key, value);
        return query;
      }),
      is: jest.fn((key: string, value: unknown) => {
        filters.set(key, value);
        return query;
      }),
      eq: jest.fn((key: string, value: unknown) => {
        filters.set(key, value);
        return query;
      }),
      update: jest.fn((payload: BillingFixtureRow) => {
        operation = "update";
        values = payload;
        return query;
      }),
      insert: jest.fn((payload: BillingFixtureRow) => {
        operation = "upsert";
        values = payload;
        return query;
      }),
      upsert: jest.fn((payload: BillingFixtureRow) => {
        operation = "upsert";
        values = payload;
        return query;
      }),
      maybeSingle: jest.fn(async () => execute()),
      single: jest.fn(async () => execute()),
      then: (
        resolve: (value: ReturnType<typeof execute>) => unknown,
        reject: (error: unknown) => unknown
      ) => Promise.resolve(execute(false)).then(resolve, reject),
    });
    return query;
  };
  (supabaseAdmin.from as jest.Mock).mockImplementation(from);
  (supabaseAdmin.schema as jest.Mock).mockImplementation((schema: string) => ({
    from: (table: string) => from(`${schema}.${table}`),
  }));
  (supabaseAdmin.rpc as jest.Mock).mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      if (name === "settle_halyk_renewal")
        return { data: { status: "unpaid" }, error: null };
      if (name === "apply_billing_subscription") {
        const value = args.p_subscription as BillingFixtureRow;
        const existing = rows.subscriptions.find(row => row.id === value.id);
        if (existing) Object.assign(existing, value);
        else rows.subscriptions.push({ ...value });
        const company = rows.companies.find(row => row.id === value.company_id);
        if (company)
          company.subscription_type = [
            "active",
            "trialing",
            "past_due",
          ].includes(String(value.status))
            ? "pro"
            : "free";
        return { data: null, error: null };
      }
      throw new Error(`Unexpected billing RPC ${name}`);
    }
  );
  return { rows, writes, errors };
}

const paddleCheckout = {
  id: "checkout-owner",
  provider_transaction_id: "txn-owner",
  company_id: "company-owner",
  workspace_id: "workspace-owner",
  user_id: "user-owner",
  price_id: "price-owner",
  metadata: { billing_cycle: "monthly" },
};
const paddleSubscription = {
  id: "sub-owner",
  provider: "paddle",
  company_id: "company-owner",
  user_id: "user-owner",
  price_id: "price-owner",
  status: "active",
  metadata: { workspace_id: "workspace-owner", billing_cycle: "monthly" },
};
const foreignPaddleCustomData = {
  company_id: "company-foreign",
  workspace_id: "workspace-foreign",
  user_id: "user-foreign",
  price_id: "price-foreign",
  checkout_session_id: "checkout-owner",
};

describe("renewal entitlement boundaries", () => {
  const subscription = {
    id: "sub-owner",
    company_id: "company-owner",
    user_id: "user-owner",
    status: "active",
    provider: "halyk_epay",
    price_id: "price-owner",
    payment_method_id: "missing-method",
    current_period_start: "2026-01-01T00:00:00Z",
    current_period_end: "2026-02-01T00:00:00Z",
    metadata: {},
  };
  const input = {
    subscriptionId: "sub-owner",
    companyId: "company-owner",
    attempt: 0,
    finalAttempt: false,
  };

  it("persists missing billing source and expires the paid entitlement", async () => {
    const ledger = createBillingLedger({
      subscriptions: [{ ...subscription }],
      companies: [{ id: "company-owner", subscription_type: "pro" }],
    });
    await expect(chargeHalykSubscriptionRenewal(input)).resolves.toMatchObject({
      status: "unpaid",
    });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_renewal",
      expect.objectContaining({
        p_subscription_id: "sub-owner",
        p_company_id: "company-owner",
        p_outcome: "billing_source_missing",
      })
    );
    expect(ledger.writes).toEqual([]);
  });

  it("does not treat a payment-method read failure as an unpaid subscription", async () => {
    const ledger = createBillingLedger({
      subscriptions: [{ ...subscription }],
    });
    ledger.errors["billing_private.halyk_payment_methods"] = {
      message: "database unavailable",
    };
    await expect(chargeHalykSubscriptionRenewal(input)).rejects.toThrow(
      "database unavailable"
    );
    expect(ledger.writes).toEqual([]);
  });

  it("keeps already paid time when renewal is called early", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ledger = createBillingLedger({
      subscriptions: [{ ...subscription, current_period_end: future }],
      companies: [{ id: "company-owner", subscription_type: "pro" }],
    });
    await expect(chargeHalykSubscriptionRenewal(input)).resolves.toMatchObject({
      status: "skipped",
      nextChargeAt: future,
    });
    expect(ledger.writes).toEqual([]);
  });
});

describe("durable renewal charge recovery", () => {
  const sub = {
    id: "sub-owner",
    provider: "halyk_epay",
    company_id: "company-owner",
    user_id: "user-owner",
    status: "past_due",
    price_id: "price-owner",
    payment_method_id: "method-owner",
    current_period_start: "2026-09-09T00:00:00Z",
    current_period_end: "2026-10-09T00:00:00Z",
  };
  const invoice = {
    id: "inv-owner",
    subscription_id: "sub-owner",
    provider: "halyk_epay",
    company_id: "company-owner",
    provider_invoice_id: "123456",
    amount: 10600,
    currency: "USD",
    period_start: sub.current_period_end,
    period_end: "2026-11-09T00:00:00Z",
    attempt_count: 1,
    charge_state: "pending",
    status: "open",
  };
  const input = {
    subscriptionId: sub.id,
    companyId: sub.company_id,
    attempt: 0,
    finalAttempt: false,
  };
  const charge = jest.fn();
  const lookup = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-10T00:00:00Z"));
    jest.clearAllMocks();
    createBillingLedger({
      subscriptions: [{ ...sub }],
      billing_invoices: [{ ...invoice }],
      "billing_private.halyk_payment_methods": [
        {
          id: "method-owner",
          company_id: "company-owner",
          status: "active",
          card_id_encrypted: {},
        },
      ],
    });
    (createHalykClient as jest.Mock).mockReturnValue({
      chargeSavedCard: charge,
      checkTransactionStatus: lookup,
    });
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: { status: "requires_action", nextChargeAt: "2026-10-10T01:00:00Z" },
      error: null,
    });
  });
  afterEach(() => jest.useRealTimers());
  it("reconciles an uncertain attempt without submitting another charge", async () => {
    lookup.mockResolvedValue({ resultCode: "102", transaction: null });
    await expect(chargeHalykSubscriptionRenewal(input)).resolves.toMatchObject({
      status: "requires_action",
    });
    expect(lookup).toHaveBeenCalledWith("123456");
    expect(charge).not.toHaveBeenCalled();
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_renewal",
      expect.objectContaining({ p_outcome: "pending", p_expected_attempt: 1 })
    );
  });
  it("restores a captured invoice atomically from owned lookup evidence", async () => {
    lookup.mockResolvedValue({
      resultCode: "100",
      transaction: {
        invoiceID: "123456",
        amount: 10600,
        currency: "USD",
        terminalID: "terminal-1",
        statusName: "CHARGE",
      },
    });
    await chargeHalykSubscriptionRenewal(input);
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_renewal",
      expect.objectContaining({ p_outcome: "paid" })
    );
    expect(charge).not.toHaveBeenCalled();
  });
  it("keeps mismatched capture evidence uncertain and cannot repeat the charge", async () => {
    lookup.mockResolvedValue({
      resultCode: "100",
      transaction: {
        invoiceID: "999999",
        amount: 10600,
        currency: "USD",
        terminalID: "terminal-1",
        statusName: "CHARGE",
      },
    });
    await chargeHalykSubscriptionRenewal(input);
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_renewal",
      expect.objectContaining({ p_outcome: "pending" })
    );
    expect(charge).not.toHaveBeenCalled();
  });
  it("does not call the provider when an atomic attempt claim loses", async () => {
    createBillingLedger({
      subscriptions: [{ ...sub }],
      billing_invoices: [
        { ...invoice, charge_state: "ready", attempt_count: 0 },
      ],
      "billing_private.halyk_payment_methods": [
        {
          id: "method-owner",
          company_id: "company-owner",
          status: "active",
          card_id_encrypted: {},
        },
      ],
    });
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: { claimed: false, invoice },
      error: null,
    });
    await chargeHalykSubscriptionRenewal(input);
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "claim_halyk_renewal_charge",
      expect.objectContaining({ p_expected_attempt: 0 })
    );
    expect(charge).not.toHaveBeenCalled();
  });
  it("does not persist provider card tokens or personal fields in public invoice metadata", async () => {
    lookup.mockResolvedValue({
      resultCode: "100",
      transaction: {
        invoiceID: "123456",
        amount: 10600,
        currency: "USD",
        terminalID: "terminal-1",
        statusName: "CHARGE",
        cardID: "secret-card-token",
        email: "private@example.com",
      },
    });
    await chargeHalykSubscriptionRenewal(input);
    const args = (supabaseAdmin.rpc as jest.Mock).mock.calls.find(
      ([name]) => name === "settle_halyk_renewal"
    )[1];
    expect(JSON.stringify(args)).not.toContain("secret-card-token");
    expect(JSON.stringify(args)).not.toContain("private@example.com");
  });
  it("holds a durably claimed attempt when the provider response is lost", async () => {
    createBillingLedger({
      subscriptions: [{ ...sub }],
      billing_invoices: [
        { ...invoice, charge_state: "ready", attempt_count: 0 },
      ],
      "billing_private.halyk_payment_methods": [
        {
          id: "method-owner",
          company_id: "company-owner",
          status: "active",
          card_id_encrypted: {},
        },
      ],
    });
    (supabaseAdmin.rpc as jest.Mock).mockImplementation(async name => ({
      data:
        name === "claim_halyk_renewal_charge"
          ? { claimed: true, invoice }
          : { status: "requires_action", nextChargeAt: "2026-10-10T01:00:00Z" },
      error: null,
    }));
    charge.mockImplementation(async () => {
      expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
        "claim_halyk_renewal_charge",
        expect.anything()
      );
      throw new Error("response lost");
    });
    await expect(chargeHalykSubscriptionRenewal(input)).resolves.toMatchObject({
      status: "requires_action",
    });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(supabaseAdmin.rpc).toHaveBeenLastCalledWith(
      "settle_halyk_renewal",
      expect.objectContaining({ p_outcome: "pending", p_expected_attempt: 1 })
    );
  });
  it("surfaces a failed atomic settlement instead of reporting payment success", async () => {
    lookup.mockResolvedValue({ resultCode: "102" });
    (supabaseAdmin.rpc as jest.Mock).mockResolvedValue({
      data: null,
      error: { message: "transaction unavailable" },
    });
    await expect(chargeHalykSubscriptionRenewal(input)).rejects.toThrow(
      "transaction unavailable"
    );
    expect(charge).not.toHaveBeenCalled();
  });
});

describe("billing callback authorization", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(["created", "paid"])(
    "leaves an existing %s Halyk checkout unchanged when its secret is invalid",
    async status => {
      const session = {
        id: "checkout-owner",
        provider_invoice_id: "invoice-owner",
        company_id: "company-owner",
        status,
      };
      const ledger = createBillingLedger({
        "billing_private.halyk_checkout_sessions": [{ ...session }],
      });
      (getHalykPayloadInvoiceId as jest.Mock).mockReturnValue("invoice-owner");
      (verifyHalykSecretHash as jest.Mock).mockReturnValue(false);

      await expect(
        processHalykPostLink({ secret_hash: "invalid" })
      ).resolves.toEqual({
        ok: false,
        status: 401,
        error: "Invalid Halyk secret hash",
      });
      expect(ledger.rows["billing_private.halyk_checkout_sessions"]).toEqual([
        session,
      ]);
      expect(ledger.writes).toEqual([]);
    }
  );

  it("retains an authenticated Halyk checkout's paid outcome", async () => {
    const ledger = createBillingLedger({
      "billing_private.halyk_checkout_sessions": [
        {
          id: "checkout-owner",
          provider_invoice_id: "invoice-owner",
          company_id: "company-owner",
          status: "paid",
          billing_invoice_id: "invoice-row",
          subscription_id: "sub-owner",
        },
      ],
    });
    (getHalykPayloadInvoiceId as jest.Mock).mockReturnValue("invoice-owner");
    (verifyHalykSecretHash as jest.Mock).mockReturnValue(true);
    await expect(
      processHalykPostLink({ secret_hash: "valid" })
    ).resolves.toMatchObject({ ok: true, status: "paid" });
    expect(ledger.writes.map(write => write.table)).toEqual([
      "billing_private.halyk_events",
    ]);
    expect(startBillingSubscriptionWorkflow).toHaveBeenCalledWith({
      subscriptionId: "sub-owner",
      companyId: "company-owner",
    });
  });

  it("retries workflow scheduling after an already completed card update", async () => {
    createBillingLedger({
      "billing_private.halyk_checkout_sessions": [
        {
          id: "checkout-owner",
          provider_invoice_id: "invoice-owner",
          company_id: "company-owner",
          status: "paid",
          subscription_id: "sub-owner",
        },
      ],
    });
    (getHalykPayloadInvoiceId as jest.Mock).mockReturnValue("invoice-owner");
    (verifyHalykSecretHash as jest.Mock).mockReturnValue(true);
    (startBillingSubscriptionWorkflow as jest.Mock)
      .mockRejectedValueOnce(new Error("Temporal unavailable"))
      .mockResolvedValueOnce({});
    await expect(
      processHalykPostLink({ secret_hash: "valid" })
    ).rejects.toThrow("Temporal unavailable");
    await expect(
      processHalykPostLink({ secret_hash: "valid" })
    ).resolves.toMatchObject({ status: "card_updated" });
    expect(startBillingSubscriptionWorkflow).toHaveBeenCalledTimes(2);
  });

  it("uses the persisted transaction binding instead of editable Paddle custom data", async () => {
    const ledger = createBillingLedger({
      "billing_private.paddle_checkout_sessions": [{ ...paddleCheckout }],
    });
    await processPaddleWebhook({
      event_id: "event-paid",
      event_type: "transaction.completed",
      data: {
        id: "txn-owner",
        subscription_id: "sub-owner",
        status: "completed",
        custom_data: foreignPaddleCustomData,
      },
    });
    expect(ledger.rows.subscriptions[0]).toMatchObject({
      id: "sub-owner",
      company_id: "company-owner",
      user_id: "user-owner",
      price_id: "price-owner",
    });
    expect(ledger.rows.companies).toEqual([
      { id: "company-owner", subscription_type: "pro" },
      { id: "company-foreign", subscription_type: "pro" },
    ]);
    expect(ledger.rows.billing_invoices[0]).toMatchObject({
      company_id: "company-owner",
      user_id: "user-owner",
      price_id: "price-owner",
    });
  });

  it.each([null, foreignPaddleCustomData])(
    "retries an unbound paid transaction without authorizing custom data %p",
    async custom_data => {
      const ledger = createBillingLedger();
      await expect(
        processPaddleWebhook({
          event_id: "event-unbound",
          event_type: "transaction.completed",
          data: {
            id: "txn-unbound",
            subscription_id: "sub-unbound",
            status: "completed",
            custom_data,
          },
        })
      ).rejects.toThrow(/binding/i);
      expect(ledger.writes).toEqual([]);
    }
  );

  it("uses the persisted Paddle subscription for a renewal with no new checkout row", async () => {
    const ledger = createBillingLedger({
      subscriptions: [{ ...paddleSubscription }],
    });
    await processPaddleWebhook({
      event_id: "event-renewal",
      event_type: "transaction.completed",
      data: {
        id: "txn-renewal",
        subscription_id: "sub-owner",
        status: "completed",
        custom_data: foreignPaddleCustomData,
      },
    });
    expect(ledger.rows.subscriptions[0]).toMatchObject({
      company_id: "company-owner",
      user_id: "user-owner",
      price_id: "price-owner",
    });
    expect(ledger.rows.billing_invoices[0]).toMatchObject({
      company_id: "company-owner",
      user_id: "user-owner",
    });
  });

  it("renews a bound company after its payer user is deleted without trusting a custom user_id", async () => {
    const ledger = createBillingLedger({
      subscriptions: [{ ...paddleSubscription, user_id: null }],
    });
    await expect(
      processPaddleWebhook({
        event_id: "event-deleted-payer",
        event_type: "transaction.completed",
        data: {
          id: "txn-renewal",
          subscription_id: "sub-owner",
          status: "completed",
          custom_data: foreignPaddleCustomData,
        },
      })
    ).resolves.toMatchObject({ ok: true, result: { status: "paid" } });
    expect(ledger.rows.subscriptions[0]).toMatchObject({
      company_id: "company-owner",
      user_id: null,
      price_id: "price-owner",
    });
    expect(ledger.rows.billing_invoices[0]).toMatchObject({
      company_id: "company-owner",
      user_id: null,
    });
  });

  it("cancels only the persisted subscription's company and keeps its trusted workspace metadata", async () => {
    const ledger = createBillingLedger({
      subscriptions: [{ ...paddleSubscription }],
    });
    await processPaddleWebhook({
      event_id: "event-cancel",
      event_type: "subscription.canceled",
      data: {
        id: "sub-owner",
        status: "canceled",
        custom_data: foreignPaddleCustomData,
      },
    });
    expect(ledger.rows.subscriptions[0]).toMatchObject({
      company_id: "company-owner",
      user_id: "user-owner",
      price_id: "price-owner",
      metadata: { workspace_id: "workspace-owner" },
    });
    expect(ledger.rows.companies).toEqual([
      { id: "company-owner", subscription_type: "free" },
      { id: "company-foreign", subscription_type: "pro" },
    ]);
  });

  it("binds an initial subscription through Paddle's authentic transaction_id before the paid transaction event", async () => {
    const ledger = createBillingLedger({
      "billing_private.paddle_checkout_sessions": [{ ...paddleCheckout }],
    });
    await processPaddleWebhook({
      event_id: "event-created",
      event_type: "subscription.created",
      data: {
        id: "sub-owner",
        transaction_id: "txn-owner",
        status: "active",
        custom_data: foreignPaddleCustomData,
      },
    });
    expect(ledger.rows.subscriptions[0]).toMatchObject({
      company_id: "company-owner",
      user_id: "user-owner",
      price_id: "price-owner",
      metadata: { workspace_id: "workspace-owner" },
    });
  });

  it("does not authorize an unbound subscription through a custom checkout_session_id", async () => {
    const ledger = createBillingLedger({
      "billing_private.paddle_checkout_sessions": [{ ...paddleCheckout }],
    });
    await expect(
      processPaddleWebhook({
        event_id: "event-forged",
        event_type: "subscription.created",
        data: {
          id: "sub-unbound",
          status: "active",
          custom_data: foreignPaddleCustomData,
        },
      })
    ).rejects.toThrow(/binding/i);
    expect(ledger.writes).toEqual([]);
  });

  it("retries a cancellation delivered before binding and then applies it after the paid event", async () => {
    const ledger = createBillingLedger({
      "billing_private.paddle_checkout_sessions": [{ ...paddleCheckout }],
    });
    const cancellation = {
      event_id: "event-early-cancel",
      event_type: "subscription.canceled",
      data: {
        id: "sub-owner",
        status: "canceled",
        custom_data: foreignPaddleCustomData,
      },
    };
    await expect(processPaddleWebhook(cancellation)).rejects.toThrow(
      /binding/i
    );
    expect(ledger.writes).toEqual([]);
    await processPaddleWebhook({
      event_id: "event-paid",
      event_type: "transaction.completed",
      data: {
        id: "txn-owner",
        subscription_id: "sub-owner",
        status: "completed",
      },
    });
    await expect(processPaddleWebhook(cancellation)).resolves.toMatchObject({
      ok: true,
    });
    expect(ledger.rows.subscriptions[0]).toMatchObject({
      company_id: "company-owner",
      status: "canceled",
    });
    expect(ledger.rows.companies[0]).toMatchObject({
      id: "company-owner",
      subscription_type: "free",
    });
    expect(ledger.rows.companies[1]).toMatchObject({
      id: "company-foreign",
      subscription_type: "pro",
    });
  });

  it("does not use another billing provider's subscription as a Paddle renewal binding", async () => {
    const ledger = createBillingLedger({
      subscriptions: [{ ...paddleSubscription, provider: "halyk_epay" }],
    });
    await expect(
      processPaddleWebhook({
        event_id: "event-other-provider",
        event_type: "transaction.completed",
        data: {
          id: "txn-renewal",
          subscription_id: "sub-owner",
          status: "completed",
          custom_data: foreignPaddleCustomData,
        },
      })
    ).rejects.toThrow(/binding/i);
    expect(ledger.writes).toEqual([]);
  });

  it("fails closed when reading the canonical checkout binding fails", async () => {
    const ledger = createBillingLedger();
    ledger.errors["billing_private.paddle_checkout_sessions"] = {
      message: "binding read unavailable",
    };
    await expect(
      processPaddleWebhook({
        event_id: "event-read-error",
        event_type: "transaction.completed",
        data: {
          id: "txn-owner",
          status: "completed",
          custom_data: foreignPaddleCustomData,
        },
      })
    ).rejects.toThrow("binding read unavailable");
    expect(ledger.writes).toEqual([]);
  });
});

describe("initial Halyk capture boundaries", () => {
  const session = {
    id: "checkout-owner",
    company_id: "company-owner",
    workspace_id: "workspace-owner",
    user_id: "user-owner",
    price_id: "price-owner",
    provider_invoice_id: "123456",
    status: "created",
    billing_invoice_id: null,
  };
  let ledger: ReturnType<typeof createBillingLedger>;
  const charge = jest.fn();
  const lookup = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    ledger = createBillingLedger({
      "billing_private.halyk_checkout_sessions": [{ ...session }],
    });
    (getHalykPayloadInvoiceId as jest.Mock).mockReturnValue("123456");
    (verifyHalykSecretHash as jest.Mock).mockReturnValue(true);
    (hashHalykCardId as jest.Mock).mockReturnValue({
      encryptedCardId: {},
      cardFingerprint: "card",
    });
    (normalizeHalykPaymentStatus as jest.Mock).mockImplementation(
      jest.requireActual("./halyk-client").normalizeHalykPaymentStatus
    );
    (createHalykClient as jest.Mock).mockReturnValue({
      chargeSavedCard: charge,
      checkTransactionStatus: lookup,
    });
    charge.mockImplementation(async () => {
      expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
        "claim_halyk_checkout_charge",
        { p_session_id: "checkout-owner", p_invoice_id: expect.any(String) }
      );
      return { code: 0, status: "AUTH" };
    });
    lookup.mockResolvedValue({
      resultCode: "100",
      transaction: {
        invoiceID: "654321",
        amount: 10600,
        currency: "USD",
        terminalID: "terminal-1",
        statusName: "AUTH",
      },
    });
    (supabaseAdmin.rpc as jest.Mock).mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "claim_halyk_checkout_charge")
          return {
            data: {
              claimed: true,
              invoice: {
                ...ledger.rows.billing_invoices[0],
                attempt_count: 1,
                charge_state: "pending",
              },
            },
            error: null,
          };
        if (name === "settle_halyk_checkout")
          return {
            data: {
              status: args.p_outcome === "paid" ? "paid" : "charging",
              invoiceId: args.p_invoice_id,
            },
            error: null,
          };
        throw new Error(`Unexpected RPC ${name}`);
      }
    );
  });
  it("claims once and keeps AUTH pending without granting a subscription", async () => {
    await expect(
      processHalykPostLink({ secret_hash: "valid", code: "ok", cardId: "card" })
    ).resolves.toMatchObject({ status: "charging" });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_checkout",
      expect.objectContaining({ p_outcome: "pending" })
    );
    expect(ledger.rows.subscriptions).toEqual([]);
  });
  it("requires matching capture evidence even after a direct CHARGE response", async () => {
    charge.mockResolvedValue({ code: 0, status: "CHARGE" });
    lookup.mockResolvedValue({
      resultCode: "100",
      transaction: {
        invoiceID: "foreign",
        amount: 10600,
        currency: "USD",
        terminalID: "terminal-1",
        statusName: "CHARGE",
      },
    });
    await expect(
      processHalykPostLink({ secret_hash: "valid", code: "ok", cardId: "card" })
    ).resolves.toMatchObject({ status: "charging" });
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_checkout",
      expect.objectContaining({ p_outcome: "pending" })
    );
  });
  it("reconciles an interrupted initial charge without submitting it again", async () => {
    Object.assign(ledger.rows["billing_private.halyk_checkout_sessions"][0], {
      status: "charging",
      billing_invoice_id: "inv-pending",
    });
    ledger.rows.billing_invoices = [
      {
        id: "inv-pending",
        checkout_session_id: session.id,
        company_id: session.company_id,
        provider_invoice_id: "654321",
        amount: 10600,
        currency: "USD",
        attempt_count: 1,
      },
    ];
    lookup.mockResolvedValue({
      resultCode: "100",
      transaction: {
        invoiceID: "654321",
        amount: 10600,
        currency: "USD",
        terminalID: "terminal-1",
        statusName: "CHARGE",
      },
    });
    await expect(
      processHalykPostLink({ secret_hash: "valid" })
    ).resolves.toMatchObject({ status: "paid" });
    expect(charge).not.toHaveBeenCalled();
    expect(supabaseAdmin.rpc).toHaveBeenCalledWith(
      "settle_halyk_checkout",
      expect.objectContaining({ p_outcome: "paid" })
    );
  });
  it("starts a fresh checkout after an exhausted renewal instead of replacing its card forever", async () => {
    ledger.rows.subscriptions = [
      {
        id: "old-sub",
        company_id: session.company_id,
        provider: "halyk_epay",
        status: "unpaid",
        dunning_status: "attempts_exhausted",
      },
    ];
    await processHalykPostLink({
      secret_hash: "valid",
      code: "ok",
      cardId: "card",
    });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(startBillingSubscriptionWorkflow).not.toHaveBeenCalled();
    expect(ledger.rows.subscriptions[0].payment_method_id).toBeUndefined();
  });
});
